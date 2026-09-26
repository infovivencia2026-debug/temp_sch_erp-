import type { Ctx, Router } from '../../router'
import { badRequest, bool, created, notFound, now, ok, readJSON, uuid } from '../../http'
import { can } from '../../identity'
import { coded } from '../exams/common'
import { todayIST } from '../admissions/util'
import { employeeFilter, growthReach, type Reach } from '../hr/reach'
import { changes, n, nullString, num0, numOrNull, omitNull, run, s, strList } from './common'
import { Internal, READ, SELF, WRITE, pathID, w } from './hr_recruit'
import { school } from '../school'

/* Port of the appraisal half of hr_growth.go:
   hr.hiring_growth.annual_performance_appraisal_kpi, and the employee's own
   appraisals under /hr-growth/me. */

/** appraisalFilter: employeeFilter plus the appraisals the caller was named to review or moderate. */
export function appraisalFilter(re: Reach, emp: string, appr: string): { sql: string; args: unknown[] } {
  const base = employeeFilter(re, emp)
  if (re.all) return base
  const mine = `(${appr}.reviewer_user_id = ? OR ${appr}.moderator_user_id = ?)`
  const args = [...base.args, re.userId, re.userId]
  if (base.sql === '0') return { sql: mine, args: [re.userId, re.userId] }
  return { sql: `(${base.sql} OR ${mine})`, args }
}

/** ownEmployee: the caller's own staff row, or 404 not_staff. */
export async function ownEmployee(c: Ctx): Promise<string> {
  const row = await c.db.prepare(`SELECT id FROM employees WHERE user_id = ? LIMIT 1`).bind(c.id.userId).first<{ id: string }>()
  if (!row) throw coded(404, 'not_staff', 'you have no staff record in this school')
  return row.id
}

const empName = (a: string) => `TRIM(COALESCE(${a}.first_name,'') || ' ' || COALESCE(${a}.last_name,''))`

const appraisalSelect = `
  SELECT a.id, a.cycle_id, cy.name AS cycle, a.employee_id, e.employee_code, ${empName('e')} AS full_name,
         g.name AS designation, d.name AS department, ru.full_name AS reviewer, mu.full_name AS moderator, a.status,
         a.self_score, a.reviewer_score, a.moderated_score, a.final_score, a.final_band, cy.score_scale_max,
         SUBSTR(a.discussion_on,1,10) AS discussion_on, a.increment_percent, SUBSTR(a.published_at,1,10) AS published_at,
         a.acknowledged_at IS NOT NULL AS acknowledged
    FROM appraisals a
    JOIN appraisal_cycles cy ON cy.id = a.cycle_id
    JOIN employees e ON e.id = a.employee_id
    LEFT JOIN designations g ON g.id = a.designation_id
    LEFT JOIN departments  d ON d.id = e.department_id
    LEFT JOIN users ru ON ru.id = a.reviewer_user_id
    LEFT JOIN users mu ON mu.id = a.moderator_user_id`

const appraisalRow = (v: Record<string, unknown>) => omitNull({
  id: v.id, cycle_id: v.cycle_id, cycle: v.cycle, employee_id: v.employee_id, employee_code: v.employee_code, full_name: v.full_name,
  designation: v.designation, department: v.department, reviewer: v.reviewer, moderator: v.moderator, status: v.status,
  self_score: numOrNull(v.self_score), reviewer_score: numOrNull(v.reviewer_score), moderated_score: numOrNull(v.moderated_score),
  final_score: numOrNull(v.final_score), final_band: v.final_band, score_scale_max: num0(v.score_scale_max),
  discussion_on: v.discussion_on, increment_percent: numOrNull(v.increment_percent), published_at: v.published_at,
  acknowledged: bool(v.acknowledged),
})

/** renderAppraisal: one appraisal with its per-KPI ratings, 404 when the caller's scope excludes it. */
async function renderAppraisal(c: Ctx, sql: string, args: unknown[]): Promise<Response> {
  const row = await c.db.prepare(sql).bind(...args).first<Record<string, unknown>>()
  if (!row) throw notFound('resource not found')
  const out: Record<string, unknown> = appraisalRow(row)
  const [extra, ratings] = await c.db.batch([
    c.db.prepare(`SELECT self_comments, reviewer_comments, moderation_note, discussion_note, employee_comments, increment_paise,
        external_360_source, external_360_score FROM appraisals WHERE id = ?`).bind(row.id),
    c.db.prepare(`SELECT rt.id, k.id AS kpi_id, k.code, k.title, k.description, k.source, rt.weight, rt.self_score, rt.self_note,
        rt.reviewer_score, rt.reviewer_note, rt.moderated_score
        FROM appraisal_ratings rt JOIN appraisal_kpis k ON k.id = rt.kpi_id
       WHERE rt.appraisal_id = ? ORDER BY k.sequence, k.code`).bind(row.id),
  ])
  const x = (extra.results[0] ?? {}) as Record<string, unknown>
  Object.assign(out, omitNull({
    self_comments: x.self_comments, reviewer_comments: x.reviewer_comments, moderation_note: x.moderation_note,
    discussion_note: x.discussion_note, employee_comments: x.employee_comments, increment_paise: numOrNull(x.increment_paise),
    external_360_source: x.external_360_source, external_360_score: numOrNull(x.external_360_score),
  }))
  out.ratings = (ratings.results as Record<string, unknown>[]).map((v) => omitNull({
    id: v.id, kpi_id: v.kpi_id, code: v.code, title: v.title, description: v.description, source: v.source, weight: num0(v.weight),
    self_score: numOrNull(v.self_score), self_note: v.self_note, reviewer_score: numOrNull(v.reviewer_score),
    reviewer_note: v.reviewer_note, moderated_score: numOrNull(v.moderated_score),
  }))
  return ok(out)
}

/** weightedScoreSQL: the total recomputed from the stored ratings, as numeric(6,2). */
const weighted = (col: string) => `(SELECT round(sum(${n('rt.' + col)} * ${n('rt.weight')}) / NULLIF(sum(${n('rt.weight')}), 0), 2)
    FROM appraisal_ratings rt WHERE rt.appraisal_id = appraisals.id AND rt.${col} IS NOT NULL)`

interface RatingInput { kpi_id: string; score: number | null; note: string }
function ratingsOf(raw: unknown): RatingInput[] {
  if (!Array.isArray(raw)) return []
  return raw.map((r0) => {
    const o = (r0 ?? {}) as Record<string, unknown>
    return { kpi_id: s(o.kpi_id), score: typeof o.score === 'number' ? o.score : null, note: s(o.note) }
  })
}

const PRE_MODERATION = `('not_started','self_submitted','published','acknowledged')`

export function registerAppraisal(r: Router) {
  // ---------------------------------------------------------------- the employee's own
  r.get('/hr-growth/me/appraisals', SELF, async (c) => {
    const emp = await ownEmployee(c)
    const rows = await c.db.prepare(appraisalSelect + `
       WHERE a.employee_id = ? AND a.status IN ${PRE_MODERATION}
       ORDER BY cy.opens_on IS NULL, cy.opens_on DESC`).bind(emp).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(appraisalRow) })
  })

  r.get('/hr-growth/me/appraisals/{id}', SELF, async (c) => {
    const app = pathID(c)
    const emp = await ownEmployee(c)
    return renderAppraisal(c, appraisalSelect + ` WHERE a.id = ? AND a.employee_id = ? AND a.status IN ${PRE_MODERATION}`, [app, emp])
  })

  r.post('/hr-growth/me/appraisals/{id}/self-assessment', SELF, async (c) => {
    const app = pathID(c)
    const emp = await ownEmployee(c)
    const req = await readJSON(c.req)
    const cur = await c.db.prepare(`SELECT status FROM appraisals WHERE id = ? AND employee_id = ?`).bind(app, emp).first<{ status: string }>()
    if (!cur) throw new Internal('no rows in result set')
    if (cur.status !== 'not_started' && cur.status !== 'self_submitted') throw new Internal('this appraisal is past the stage that can be edited')
    const t = now()
    const stmts = ratingsOf(req.ratings).map((rt) => c.db.prepare(`UPDATE appraisal_ratings SET self_score = ?, self_note = ?, updated_at = ?
        WHERE appraisal_id = ? AND kpi_id = ?`).bind(rt.score, nullString(rt.note), t, app, rt.kpi_id))
    stmts.push(c.db.prepare(`UPDATE appraisals SET status = 'self_submitted', self_submitted_at = ?, self_comments = COALESCE(?, self_comments),
        self_score = ${weighted('self_score')}, updated_at = ? WHERE id = ?`).bind(t, nullString(req.comments), t, app))
    await run(c.db, stmts)
    return ok({ id: app, status: 'self_submitted' })
  })

  r.post('/hr-growth/me/appraisals/{id}/acknowledge', SELF, async (c) => {
    const app = pathID(c)
    const emp = await ownEmployee(c)
    const req = await readJSON(c.req)
    const t = now()
    const [res] = await run(c.db, [c.db.prepare(`UPDATE appraisals SET status = 'acknowledged', acknowledged_at = ?, employee_comments = COALESCE(?, employee_comments),
        updated_at = ? WHERE id = ? AND employee_id = ? AND status = 'published'`).bind(t, nullString(req.comments), t, app, emp)])
    if (changes(res) === 0) throw new Internal('no rows in result set')
    return ok({ id: app, status: 'acknowledged' })
  })

  // ---------------------------------------------------------------- cycles
  r.get('/hr-growth/appraisal/cycles', READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT c.id, c.name, y.name AS academic_year, c.status, SUBSTR(c.opens_on,1,10) AS opens_on, SUBSTR(c.self_due_on,1,10) AS self_due_on,
             SUBSTR(c.review_due_on,1,10) AS review_due_on, SUBSTR(c.closes_on,1,10) AS closes_on, c.score_scale_max, c.allow_360_input,
             (SELECT count(*) FROM appraisals a WHERE a.cycle_id = c.id) AS appraisals,
             (SELECT count(*) FROM appraisals a WHERE a.cycle_id = c.id AND a.status IN ('published','acknowledged')) AS published,
             (SELECT count(*) FROM (SELECT round(sum(${n('k.weight')}), 2) AS total FROM appraisal_kpis k WHERE k.cycle_id = c.id
                GROUP BY k.designation_id) WHERE total <> 100) AS unbalanced_roles
        FROM appraisal_cycles c LEFT JOIN academic_years y ON y.id = c.academic_year_id
       ORDER BY COALESCE(c.opens_on, SUBSTR(c.created_at,1,10)) DESC LIMIT 100`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, score_scale_max: num0(v.score_scale_max), allow_360_input: bool(v.allow_360_input),
      appraisals: num0(v.appraisals), published: num0(v.published), unbalanced_roles: num0(v.unbalanced_roles) })) })
  })

  r.post('/hr-growth/appraisal/cycles', WRITE, w(async (c) => {
    const req = await readJSON(c.req)
    const name = s(req.name)
    if (name.trim() === '') throw badRequest('name is required')
    const status = s(req.status) || 'draft'
    const scale = typeof req.score_scale_max === 'number' && req.score_scale_max > 0 ? req.score_scale_max : 5
    const inst = school(c).id
    const year = nullString(req.academic_year_id)
    const vals = [nullString(req.opens_on), nullString(req.self_due_on), nullString(req.review_due_on), nullString(req.closes_on), scale, req.allow_360_input === true ? 1 : 0]
    const id = s(req.id), t = now()
    // appraisal_cycles_one_per_name: one cycle of a name per year.
    const dupe = await c.db.prepare(`SELECT 1 FROM appraisal_cycles WHERE institution_id = ? AND COALESCE(academic_year_id,'') = COALESCE(?,'')
        AND lower(name) = lower(?) AND id <> ?`).bind(inst, year, name, id).first()
    if (dupe) throw coded(409, 'duplicate', 'that record already exists')
    if (id !== '') {
      await run(c.db, [c.db.prepare(`UPDATE appraisal_cycles SET name = ?, academic_year_id = ?, status = ?, opens_on = ?, self_due_on = ?, review_due_on = ?,
          closes_on = ?, score_scale_max = ?, allow_360_input = ?, updated_at = ? WHERE id = ?`).bind(name, year, status, ...vals, t, id)])
      return created({ id })
    }
    const out = uuid()
    await run(c.db, [c.db.prepare(`INSERT INTO appraisal_cycles (id, institution_id, academic_year_id, name, status, opens_on, self_due_on, review_due_on,
        closes_on, score_scale_max, allow_360_input, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(out, inst, year, name, status, ...vals, c.id.userId, t, t)])
    return created({ id: out })
  }))

  // ---------------------------------------------------------------- KPIs
  r.get('/hr-growth/appraisal/kpis', READ, async (c) => {
    const q = c.url.searchParams
    const cycle = q.get('cycle_id') ?? ''
    if (cycle === '') throw badRequest('cycle_id is required')
    const desig = q.get('designation_id')
    const rows = await c.db.prepare(`
      SELECT k.id, k.cycle_id, k.designation_id, g.name AS designation, k.code, k.title, k.description, k.weight, k.sequence, k.source
        FROM appraisal_kpis k LEFT JOIN designations g ON g.id = k.designation_id
       WHERE k.cycle_id = ?1 AND (?2 IS NULL OR k.designation_id IS NULLIF(?2,''))
       ORDER BY g.name IS NOT NULL, g.name, k.sequence, k.code`).bind(cycle, desig === null || desig === '' ? null : desig).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, weight: num0(v.weight), sequence: num0(v.sequence) })) })
  })

  /* saveAppraisalKPIs: the whole set for one role in one cycle, replaced, and
     only when the weights total 100 (to a hundredth). */
  r.put('/hr-growth/appraisal/kpis', WRITE, w(async (c) => {
    const req = await readJSON(c.req)
    const cycle = s(req.cycle_id), desig = s(req.designation_id)
    const kpis = Array.isArray(req.kpis) ? (req.kpis as Record<string, unknown>[]) : []
    if (cycle === '' || kpis.length === 0) throw badRequest('cycle_id and at least one KPI are required')
    let total = 0
    const seen = new Set<string>()
    for (const k of kpis) {
      const code = s(k.code).trim()
      if (code === '' || s(k.title).trim() === '') throw badRequest('every KPI needs a code and a title')
      const lc = code.toLowerCase()
      if (seen.has(lc)) throw badRequest('duplicate KPI code: ' + s(k.code))
      seen.add(lc)
      const wt = typeof k.weight === 'number' ? k.weight : 0
      if (wt <= 0 || wt > 100) throw badRequest('every weight must be between 0 and 100')
      total += wt
    }
    if (total < 99.99 || total > 100.01) throw badRequest(`the weights total ${total.toFixed(2)}; an appraisal set must total 100`)
    const inst = school(c).id, t = now()
    const stmts = [c.db.prepare(`DELETE FROM appraisal_kpis WHERE cycle_id = ? AND designation_id IS NULLIF(?,'')`).bind(cycle, desig)]
    kpis.forEach((k, i) => stmts.push(c.db.prepare(`INSERT INTO appraisal_kpis (id, institution_id, cycle_id, designation_id, code, title, description, weight,
        sequence, source, created_at, updated_at) VALUES (?,?,?,NULLIF(?,''),?,?,?,?,?,?,?,?)`)
      .bind(uuid(), inst, cycle, desig, s(k.code).trim(), s(k.title).trim(), nullString(k.description), String(k.weight), (i + 1) * 10,
        s(k.source) || 'reviewer', t, t)))
    await run(c.db, stmts)
    return ok({ kpis: kpis.length, weight_total: total })
  }))

  // ---------------------------------------------------------------- appraisals
  r.get('/hr-growth/appraisal/records', READ, async (c) => {
    const re = await growthReach(c.db, c.id)
    const q = c.url.searchParams
    const f = appraisalFilter(re, 'e', 'a')
    const cycle = nullString(q.get('cycle_id')), status = nullString(q.get('status'))
    const rows = await c.db.prepare(appraisalSelect + `
       WHERE (? IS NULL OR a.cycle_id = ?) AND (? IS NULL OR a.status = ?) AND ${f.sql}
       ORDER BY e.employee_code LIMIT 500`).bind(cycle, cycle, status, status, ...f.args)
      .all<Record<string, unknown>>()
    return ok({ items: rows.results.map(appraisalRow) })
  })

  r.get('/hr-growth/appraisal/records/{id}', READ, async (c) => {
    const app = pathID(c)
    const re = await growthReach(c.db, c.id)
    const f = appraisalFilter(re, 'e', 'a')
    return renderAppraisal(c, appraisalSelect + ` WHERE a.id = ? AND ${f.sql}`, [app, ...f.args])
  })

  /* raiseAppraisals: one appraisal per active employee (or the ones named),
     the designation snapshotted, a rating row per KPI with today's weight.
     The appraisals_weights_total_100 trigger is re-implemented here: a role
     whose set does not total 100 (to a hundredth) is skipped and reported. */
  r.post('/hr-growth/appraisal/records', WRITE, w(async (c) => {
    const req = await readJSON(c.req)
    const cycle = s(req.cycle_id)
    if (cycle === '') throw badRequest('cycle_id is required')
    const ids = strList(req.employee_ids)
    const staff = await c.db.prepare(`
      SELECT e.id, e.employee_code, ${empName('e')} AS name, e.designation_id FROM employees e
       WHERE e.status = 'active' AND (?1 IS NULL OR e.id IN (SELECT value FROM json_each(?1))) AND (?2 IS NULL OR e.department_id = ?2)
       ORDER BY e.employee_code`).bind(ids.length ? JSON.stringify(ids) : null, nullString(req.department_id))
      .all<{ id: string; employee_code: string; name: string; designation_id: string | null }>()
    const [kpiRows, existing] = await c.db.batch([
      c.db.prepare(`SELECT id, designation_id, weight FROM appraisal_kpis WHERE cycle_id = ?`).bind(cycle),
      c.db.prepare(`SELECT employee_id FROM appraisals WHERE cycle_id = ?`).bind(cycle),
    ])
    const kpis = kpiRows.results as { id: string; designation_id: string | null; weight: string }[]
    const raisedAlready = new Set((existing.results as { employee_id: string }[]).map((x) => x.employee_id))
    // appraisal_kpi_set: the designation's own rows, or the default set when it has none.
    const kpiSet = (desig: string | null) => {
      const own = kpis.filter((k) => k.designation_id === desig)
      if (desig !== null && own.length === 0) return kpis.filter((k) => k.designation_id === null)
      return own
    }
    const inst = school(c).id, t = now()
    const reviewer = nullString(req.reviewer_user_id), moderator = nullString(req.moderator_user_id)
    let raised = 0
    const skipped: { employee: string; reason: string }[] = []
    let stmts: D1PreparedStatement[] = []
    for (const p of staff.results) {
      if (raisedAlready.has(p.id)) continue
      const set = kpiSet(p.designation_id)
      const total = set.reduce((a, k) => a + Number(k.weight), 0)
      if (Math.abs(total - 100) > 0.01 + 1e-9) {
        skipped.push({ employee: p.employee_code + ' ' + p.name, reason: `the KPI weights for this role total ${total.toFixed(2)}, not 100; fix the cycle before raising appraisals` })
        continue
      }
      const appID = uuid()
      stmts.push(c.db.prepare(`INSERT INTO appraisals (id, institution_id, cycle_id, employee_id, designation_id, reviewer_user_id, moderator_user_id, status, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,'not_started',?,?)`).bind(appID, inst, cycle, p.id, p.designation_id, reviewer, moderator, t, t))
      for (const k of set) stmts.push(c.db.prepare(`INSERT OR IGNORE INTO appraisal_ratings (id, institution_id, appraisal_id, kpi_id, weight, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?)`).bind(uuid(), inst, appID, k.id, k.weight, t, t))
      raised++
      if (stmts.length >= 400) { await run(c.db, stmts); stmts = [] }
    }
    await run(c.db, stmts)
    return created({ raised, skipped })
  }))

  // Reviewable with hr.employees.read: the named reviewer, or the back office.
  r.post('/hr-growth/appraisal/records/{id}/review', READ, async (c) => {
    const app = pathID(c)
    const req = await readJSON(c.req)
    const backOffice = can(c.id, WRITE)
    const cur = await c.db.prepare(`SELECT reviewer_user_id, status FROM appraisals WHERE id = ?`).bind(app).first<{ reviewer_user_id: string | null; status: string }>()
    if (!cur) throw new Internal('no rows in result set')
    if (!backOffice && cur.reviewer_user_id !== c.id.userId) throw coded(403, 'forbidden', 'you are not the reviewer named on this appraisal')
    if (cur.status === 'published' || cur.status === 'acknowledged') throw new Internal('this appraisal is past the stage that can be edited')
    const t = now()
    const stmts = ratingsOf(req.ratings).map((rt) => c.db.prepare(`UPDATE appraisal_ratings SET reviewer_score = ?, reviewer_note = ?, updated_at = ?
        WHERE appraisal_id = ? AND kpi_id = ?`).bind(rt.score, nullString(rt.note), t, app, rt.kpi_id))
    stmts.push(c.db.prepare(`UPDATE appraisals SET status = 'reviewed', reviewed_at = ?, reviewer_comments = COALESCE(?, reviewer_comments),
        reviewer_score = ${weighted('reviewer_score')}, external_360_source = COALESCE(?, external_360_source),
        external_360_ref = COALESCE(?, external_360_ref), external_360_score = COALESCE(?, external_360_score), updated_at = ? WHERE id = ?`)
      .bind(t, nullString(req.comments), nullString(req.external_360_source), nullString(req.external_360_ref),
        typeof req.external_360_score === 'number' ? req.external_360_score : null, t, app))
    await run(c.db, stmts)
    return ok({ id: app, status: 'reviewed' })
  })

  r.post('/hr-growth/appraisal/records/{id}/moderate', WRITE, w(async (c) => {
    const app = pathID(c)
    const req = await readJSON(c.req)
    const t = now()
    const stmts = ratingsOf(req.ratings).map((rt) => c.db.prepare(`UPDATE appraisal_ratings SET moderated_score = ?, updated_at = ? WHERE appraisal_id = ? AND kpi_id = ?`)
      .bind(rt.score, t, app, rt.kpi_id))
    stmts.push(c.db.prepare(`UPDATE appraisals SET status = 'moderated', moderated_at = ?, moderator_user_id = COALESCE(moderator_user_id, ?),
        moderation_note = COALESCE(?, moderation_note), moderated_score = COALESCE(${weighted('moderated_score')}, reviewer_score), updated_at = ?
        WHERE id = ? AND status NOT IN ('published','acknowledged')`).bind(t, c.id.userId, nullString(req.note), t, app))
    const res = await run(c.db, stmts)
    if (changes(res[res.length - 1]) === 0) throw new Internal('this appraisal is past the stage that can be edited')
    return ok({ id: app, status: 'moderated' })
  }))

  r.post('/hr-growth/appraisal/records/{id}/publish', WRITE, w(async (c) => {
    const app = pathID(c)
    const req = await readJSON(c.req)
    const t = now()
    const [res] = await run(c.db, [c.db.prepare(`UPDATE appraisals SET final_score = COALESCE(moderated_score, reviewer_score), final_band = COALESCE(?, final_band),
        increment_percent = COALESCE(?, increment_percent), increment_paise = COALESCE(?, increment_paise), status = 'published', published_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('reviewed','moderated') AND COALESCE(moderated_score, reviewer_score) IS NOT NULL`)
      .bind(nullString(req.final_band), typeof req.increment_percent === 'number' ? req.increment_percent : null,
        typeof req.increment_paise === 'number' ? Math.trunc(req.increment_paise) : null, t, t, app)])
    if (changes(res) === 0) throw new Internal('an appraisal can only be published once it has been reviewed and has a score')
    const row = await c.db.prepare(`SELECT final_score FROM appraisals WHERE id = ?`).bind(app).first<{ final_score: string | null }>()
    return ok({ id: app, status: 'published', final_score: numOrNull(row?.final_score) })
  }))

  r.post('/hr-growth/appraisal/records/{id}/discussion', WRITE, w(async (c) => {
    const app = pathID(c)
    const req = await readJSON(c.req)
    const note = s(req.note)
    if (note.trim() === '') throw badRequest('a note of what was discussed is required')
    await run(c.db, [c.db.prepare(`UPDATE appraisals SET discussion_on = COALESCE(?, ?), discussion_note = ?, updated_at = ? WHERE id = ?`)
      .bind(nullString(req.discussion_on), todayIST(), note, now(), app)])
    return ok({ id: app })
  }))
}
