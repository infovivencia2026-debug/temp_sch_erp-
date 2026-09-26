import type { Ctx, Router } from '../../router'
import { HttpError, badRequest, created, isUUID, notFound, ok, readJSON, uuid } from '../../http'
import { notifyStmt } from '../fees/common'
import {
  all, alsoNeeds, coded, denied, inJSON, instId, intOr, nowISO, nullStr, rfc3339IST, rollupScope, str, trimStr, uuidOr400,
} from './common'
import { generate, SEVERITY_BLOCKING, type Requirement, type Teacher } from './solver'
import {
  DRAFT_ENTRY_SELECT, DRAFT_SELECT, TEACHING_WEEKDAYS, UUID_SQL, draftEntryJSON, draftJSON, guardStmt, isGuardFailure, jsonInsert,
  loadDraftIssues, loadPeriods, resolveYear, teachingCount, type DraftDbRow, type DraftEntryDb,
} from './tt_shared'

/* Port of timetable_ops.go sections 1 and 2: /timetable-optimizer/* and
   /department-timetable. Cover requests (section 3) are in cover.ts.

   The generator runs in the request, as it does in Go: internal/timetable is
   greedy placement with a repair budget of two moves per period, a few
   milliseconds of work for a school. Its placements are written with one
   JSON-parameter INSERT per 400 rows so a whole-school draft stays a handful
   of statements inside one batch. */

const READ = 'academics.timetable.read'
const WRITE = 'academics.timetable.write'

// --- inputs ---------------------------------------------------------------------

async function loadOptimizerTeachers(c: Ctx, year: string, campus: string | null) {
  const rows = await all<{ user_id: string; full_name: string; employee_code: string; department: string; max_day: number; max_week: number
    demand: number; scheduled: number }>(c.db.prepare(`
    SELECT u.id AS user_id, u.full_name, e.employee_code, COALESCE(d.name, '') AS department,
           COALESCE(lr.max_periods_per_day, 6) AS max_day, COALESCE(lr.max_periods_per_week, 35) AS max_week,
           COALESCE((SELECT sum(cs.periods_per_week) FROM section_subject_teachers sst
                       JOIN class_subjects cs ON cs.id = sst.class_subject_id
                       JOIN sections sec ON sec.id = sst.section_id
                      WHERE sst.teacher_user_id = u.id AND sec.academic_year_id = ?1), 0) AS demand,
           COALESCE((SELECT count(*) FROM timetable_entries te WHERE te.teacher_user_id = u.id AND te.academic_year_id = ?1), 0) AS scheduled
      FROM employees e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN teacher_load_rules lr ON lr.teacher_user_id = u.id
     WHERE e.status IN ('active','on_leave') AND (?2 IS NULL OR e.campus_id = ?2)
     ORDER BY u.full_name`).bind(year, campus))
  const out = rows.map((t) => {
    const o: Record<string, unknown> & { unavailable: unknown[]; demand_periods: number; max_periods_per_week: number } = {
      user_id: t.user_id, full_name: t.full_name, employee_code: t.employee_code ?? '',
      max_periods_per_day: t.max_day, max_periods_per_week: t.max_week, demand_periods: Number(t.demand), scheduled_periods: Number(t.scheduled),
      unavailable: [],
    }
    if (t.department !== '') o.department = t.department
    return o
  })
  const byID = new Map(out.map((t, i) => [t.user_id as string, i]))
  const un = await all<{ id: string; teacher_user_id: string; weekday: number; period_id: string | null; reason: string | null }>(
    c.db.prepare(`SELECT id, teacher_user_id, weekday, period_id, reason FROM teacher_unavailability ORDER BY weekday`))
  for (const u of un) {
    const i = byID.get(u.teacher_user_id)
    if (i === undefined) continue
    const sr: Record<string, unknown> = { id: u.id, weekday: u.weekday }
    if (u.period_id !== null) sr.period_id = u.period_id
    if (u.reason !== null) sr.reason = u.reason
    out[i].unavailable.push(sr)
  }
  return out
}

async function getOptimizerInputs(c: Ctx): Promise<Response> {
  const q = c.url.searchParams
  const year = await resolveYear(c, q.get('academic_year_id') ?? '')
  const periods = await loadPeriods(c)
  const campus = nullStr(q.get('campus_id'))
  const rows = await all<{ sec_id: string; sec_name: string; class_name: string; level: number; cs_id: string | null; sub_name: string | null
    sub_code: string | null; per_week: number | null; morning: number | null; teacher_id: string | null; teacher_name: string | null }>(c.db.prepare(`
    SELECT sec.id AS sec_id, sec.name AS sec_name, c.name AS class_name, c.level,
           cs.id AS cs_id, sub.name AS sub_name, sub.code AS sub_code, cs.periods_per_week AS per_week, cs.prefers_morning AS morning,
           sst.teacher_user_id AS teacher_id, u.full_name AS teacher_name
      FROM sections sec
      JOIN classes c ON c.id = sec.class_id
      LEFT JOIN class_subjects cs ON cs.class_id = sec.class_id
      LEFT JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN section_subject_teachers sst ON sst.section_id = sec.id AND sst.class_subject_id = cs.id
      LEFT JOIN users u ON u.id = sst.teacher_user_id
     WHERE sec.academic_year_id = ?1 AND (?2 IS NULL OR sec.campus_id = ?2)
     ORDER BY c.level, sec.name, sub.name`).bind(year, campus))

  type Req = Record<string, unknown> & { periods_per_week: number; teacher_id?: string }
  const sections: { id: string; name: string; class_name: string; level: number; requirements: Req[]; required_periods: number }[] = []
  const bySection = new Map<string, number>()
  for (const r of rows) {
    let idx = bySection.get(r.sec_id)
    if (idx === undefined) {
      idx = sections.length
      bySection.set(r.sec_id, idx)
      sections.push({ id: r.sec_id, name: r.sec_name, class_name: r.class_name, level: r.level, requirements: [], required_periods: 0 })
    }
    if (r.cs_id === null) continue
    const req: Req = { class_subject_id: r.cs_id, subject_name: r.sub_name ?? '', subject_code: r.sub_code ?? '',
      periods_per_week: r.per_week ?? 0, prefers_morning: !!r.morning }
    if (r.teacher_id !== null) req.teacher_id = r.teacher_id
    if (r.teacher_name !== null) req.teacher_name = r.teacher_name
    sections[idx].requirements.push(req)
    sections[idx].required_periods += req.periods_per_week
  }
  const teachers = await loadOptimizerTeachers(c, year, campus)

  const cells = teachingCount(periods) * TEACHING_WEEKDAYS.length
  let required = 0, noPeriods = 0, noTeacher = 0, noSubjects = 0
  for (const sec of sections) {
    required += sec.required_periods
    if (sec.requirements.length === 0) noSubjects++
    for (const rq of sec.requirements) {
      if (rq.periods_per_week === 0) noPeriods++
      if (rq.teacher_id === undefined && rq.periods_per_week > 0) noTeacher++
    }
  }
  const overCap = teachers.filter((t) => t.demand_periods > t.max_periods_per_week).length
  return ok({
    academic_year_id: year, weekdays: TEACHING_WEEKDAYS, periods, sections, teachers,
    summary: {
      sections: sections.length, teaching_slots_a_week: cells, required_periods: required,
      subjects_without_requirement: noPeriods, sections_without_subjects: noSubjects,
      subjects_without_teacher: noTeacher, teachers_over_cap: overCap,
    },
  })
}

// --- generating ------------------------------------------------------------------

/** nowInIndia().Format("2 Jan 2006, 15:04") */
function madeName(): string {
  const d = new Date(Date.now() + 330 * 60_000)
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
  const hh = String(d.getUTCHours()).padStart(2, '0'), mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `Made ${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}, ${hh}:${mm}`
}

async function generateTimetableDraft(c: Ctx): Promise<Response> {
  const inst = instId(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const sectionFilter: string[] = []
  for (const raw of Array.isArray(req.section_ids) ? req.section_ids : []) {
    const sid = trimStr(raw)
    if (!isUUID(sid)) throw badRequest('section_ids must be uuids')
    sectionFilter.push(sid)
  }
  let year: string
  try {
    year = await resolveYear(c, str(req.academic_year_id))
  } catch (e) {
    if (e instanceof HttpError && e.status === 400) throw badRequest('no academic year. Create one before generating a timetable')
    throw e
  }
  const periods = await loadPeriods(c)
  const gridPeriods = periods.filter((p) => !p.is_break).map((p) => ({ id: p.id, name: p.name, sequence: p.sequence }))
  if (gridPeriods.length === 0) throw badRequest("no teaching periods are configured; set the day's periods first")

  const campus = nullStr(req.campus_id)
  const reqRows = await all<{ section_id: string; section_name: string; cs_id: string; subject_name: string; per_week: number; morning: number; teacher_id: string }>(
    c.db.prepare(`
    SELECT sec.id AS section_id, c.name || '-' || sec.name AS section_name, cs.id AS cs_id, sub.name AS subject_name,
           cs.periods_per_week AS per_week, cs.prefers_morning AS morning, COALESCE(sst.teacher_user_id, '') AS teacher_id
      FROM sections sec
      JOIN classes c ON c.id = sec.class_id
      JOIN class_subjects cs ON cs.class_id = sec.class_id
      JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN section_subject_teachers sst ON sst.section_id = sec.id AND sst.class_subject_id = cs.id
     WHERE sec.academic_year_id = ?1 AND cs.periods_per_week > 0
       AND (?2 IS NULL OR sec.campus_id = ?2)
       AND (?3 IS NULL OR sec.id IN (SELECT value FROM json_each(?3)))
     ORDER BY c.level, sec.name, sub.name`).bind(year, campus, sectionFilter.length ? JSON.stringify(sectionFilter) : null))
  if (reqRows.length === 0) throw badRequest('no subject has a weekly period requirement yet. Set periods per week before generating')
  const reqs: Requirement[] = reqRows.map((r) => ({ sectionId: r.section_id, sectionName: r.section_name, classSubjectId: r.cs_id,
    subjectName: r.subject_name, teacherId: r.teacher_id, periodsPerWeek: r.per_week, maxPerDay: 0, difficult: !!r.morning }))
  const inScope = [...new Set(reqRows.map((r) => r.section_id))]

  // loadSolverTeachers: caps, recurring unavailability, and the load held in sections this run does not replace.
  const tRows = await all<{ user_id: string; name: string; max_day: number; max_week: number }>(c.db.prepare(`
    SELECT u.id AS user_id, u.full_name AS name, COALESCE(lr.max_periods_per_day, 6) AS max_day, COALESCE(lr.max_periods_per_week, 35) AS max_week
      FROM employees e JOIN users u ON u.id = e.user_id
      LEFT JOIN teacher_load_rules lr ON lr.teacher_user_id = u.id
     WHERE e.status IN ('active','on_leave') ORDER BY u.id`))
  const teachers: Teacher[] = tRows.map((t) => ({ userId: t.user_id, name: t.name, maxPerDay: t.max_day, maxPerWeek: t.max_week, unavailable: [], committed: [] }))
  const at = new Map(teachers.map((t, i) => [t.userId, i]))
  const un = await all<{ owner: string; weekday: number; period_id: string }>(c.db.prepare(`
    SELECT tu.teacher_user_id AS owner, tu.weekday, p.id AS period_id
      FROM teacher_unavailability tu JOIN periods p ON (tu.period_id IS NULL OR p.id = tu.period_id)
     WHERE NOT p.is_break`))
  for (const u of un) { const i = at.get(u.owner); if (i !== undefined) teachers[i].unavailable.push({ weekday: u.weekday, periodId: u.period_id }) }
  const committed = await all<{ owner: string; weekday: number; period_id: string }>(c.db.prepare(`
    SELECT te.teacher_user_id AS owner, te.weekday, te.period_id FROM timetable_entries te
     WHERE te.teacher_user_id IS NOT NULL AND te.academic_year_id = ? AND NOT (${inJSON('te.section_id')})`).bind(year, JSON.stringify(inScope)))
  for (const u of committed) { const i = at.get(u.owner); if (i !== undefined) teachers[i].committed.push({ weekday: u.weekday, periodId: u.period_id }) }

  const seed = intOr(req.seed)
  const res = generate({ grid: { weekdays: TEACHING_WEEKDAYS, periods: gridPeriods }, requirements: reqs, teachers, seed, retryBudget: intOr(req.retry_budget) })
  let blocking = 0, warnings = 0
  for (const is of res.issues) is.severity === SEVERITY_BLOCKING ? blocking++ : warnings++
  const name = trimStr(req.name) || madeName()

  const draftID = uuid()
  const ts = nowISO()
  const stmts: D1PreparedStatement[] = [
    c.db.prepare(`INSERT INTO timetable_drafts (id, institution_id, campus_id, academic_year_id, name, seed, status, periods_required, periods_placed,
        blocking_issues, warning_issues, generated_by, generated_at, hand_edits)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, 0)`)
      .bind(draftID, inst, campus, year, name, seed, res.required, res.placed, blocking, warnings, c.id.platformAdmin ? null : c.id.userId, ts),
    ...jsonInsert(c, `INSERT INTO timetable_draft_entries (id, institution_id, draft_id, section_id, period_id, weekday, class_subject_id, teacher_user_id)
      SELECT json_extract(value, '$.id'), ?, ?, json_extract(value, '$.s'), json_extract(value, '$.p'), json_extract(value, '$.w'),
             json_extract(value, '$.c'), json_extract(value, '$.t') FROM json_each(?)`,
      res.placements.map((p) => ({ id: uuid(), s: p.sectionId, p: p.periodId, w: p.weekday, c: p.classSubjectId, t: p.teacherId || null })), [inst, draftID]),
    ...jsonInsert(c, `INSERT INTO timetable_draft_issues (id, institution_id, draft_id, kind, severity, section_id, class_subject_id, teacher_user_id,
        periods_required, periods_placed, detail)
      SELECT json_extract(value, '$.id'), ?, ?, json_extract(value, '$.k'), json_extract(value, '$.v'), json_extract(value, '$.s'),
             json_extract(value, '$.c'), json_extract(value, '$.t'), json_extract(value, '$.r'), json_extract(value, '$.p'), json_extract(value, '$.d')
        FROM json_each(?)`,
      res.issues.map((is) => ({ id: uuid(), k: is.kind, v: is.severity, s: is.sectionId || null, c: is.classSubjectId || null,
        t: is.teacherId || null, r: is.required, p: is.placed, d: is.detail })), [inst, draftID]),
  ]
  await c.db.batch(stmts)
  return created({
    id: draftID, name, status: 'draft', seed, academic_year_id: year, academic_year: '',
    periods_required: res.required, periods_placed: res.placed, blocking_issues: blocking, warning_issues: warnings,
    generated_at: rfc3339IST(), sections: inScope.length,
  })
}

// --- reading drafts ------------------------------------------------------------------

async function listTimetableDrafts(c: Ctx): Promise<Response> {
  const year = nullStr(c.url.searchParams.get('academic_year_id'))
  const rows = await all<DraftDbRow>(c.db.prepare(`${DRAFT_SELECT} WHERE (?1 IS NULL OR d.academic_year_id = ?1) ORDER BY d.generated_at DESC LIMIT 100`).bind(year))
  return ok({ items: rows.map(draftJSON) })
}

async function getTimetableDraft(c: Ctx): Promise<Response> {
  const draftID = uuidOr400(c.params.id)
  const head = await c.db.prepare(`${DRAFT_SELECT} WHERE d.id = ?`).bind(draftID).first<DraftDbRow>()
  if (!head) throw notFound()
  const periods = await loadPeriods(c)
  const entries = await all<DraftEntryDb>(c.db.prepare(`${DRAFT_ENTRY_SELECT} WHERE de.draft_id = ? ORDER BY c.level, sec.name, de.weekday, p.sequence`).bind(draftID))
  const issues = await loadDraftIssues(c, draftID)
  return ok({ draft: draftJSON(head), entries: entries.map(draftEntryJSON), issues, periods, weekdays: TEACHING_WEEKDAYS })
}

// --- publish and discard ---------------------------------------------------------------

/** announceTimetable (timetable_announce.go): the staff and families of the sections a publish touched. */
async function announceStatements(c: Ctx, draftID: string): Promise<{ stmts: D1PreparedStatement[]; told: number }> {
  const sections = await all<{ id: string; name: string }>(c.db.prepare(`
    SELECT DISTINCT sec.id, c.name || '-' || sec.name AS name
      FROM timetable_draft_entries de JOIN sections sec ON sec.id = de.section_id JOIN classes c ON c.id = sec.class_id
     WHERE de.draft_id = ?`).bind(draftID))
  if (sections.length === 0) return { stmts: [], told: 0 }
  const ids = JSON.stringify(sections.map((s) => s.id))
  let names = sections.slice(0, 4).map((s) => s.name).join(', ')
  if (sections.length > 4) names += ' and others'

  const staff = await all<{ id: string }>(c.db.prepare(`
    SELECT DISTINCT de.teacher_user_id AS id FROM timetable_draft_entries de WHERE de.draft_id = ? AND de.teacher_user_id IS NOT NULL
    UNION
    SELECT sec.class_teacher_id FROM sections sec WHERE ${inJSON('sec.id')} AND sec.class_teacher_id IS NOT NULL`).bind(draftID, ids))
  const people = await all<{ student: string; name: string; user_id: string; is_student: number }>(c.db.prepare(`
    SELECT st.id AS student, TRIM(COALESCE(st.first_name, '') || ' ' || COALESCE(st.last_name, '')) AS name, u.id AS user_id, 1 AS is_student
      FROM enrollments en JOIN students st ON st.id = en.student_id JOIN users u ON u.id = st.user_id
     WHERE ${inJSON('en.section_id')} AND en.status = 'active'
    UNION ALL
    SELECT st.id, TRIM(COALESCE(st.first_name, '') || ' ' || COALESCE(st.last_name, '')), g.user_id, 0
      FROM enrollments en JOIN students st ON st.id = en.student_id
      JOIN student_guardians sg ON sg.student_id = st.id JOIN guardians g ON g.id = sg.guardian_id
     WHERE ${inJSON('en.section_id')} AND en.status = 'active' AND g.user_id IS NOT NULL`).bind(ids, ids))

  const stmts: D1PreparedStatement[] = []
  for (const s of staff) {
    stmts.push(notifyStmt(c, s.id, null, 'timetable', 'The timetable has changed',
      'A new timetable is in use for ' + names + '. Check your week before Monday.', '/go/my_timetable', 'timetable', draftID))
  }
  for (const p of people) {
    const body = p.is_student ? 'Your class has a new timetable. Check Monday before you come in.'
      : p.name + "'s class has a new timetable. The school day may start or end at a different time."
    stmts.push(notifyStmt(c, p.user_id, p.student, 'timetable', 'The timetable has changed', body, '/portal/timetable', 'timetable', draftID))
  }
  return { stmts, told: staff.length + people.length }
}

async function publishTimetableDraft(c: Ctx): Promise<Response> {
  instId(c)
  const draftID = uuidOr400(c.params.id)
  const text = await c.req.text()
  let acknowledged = false
  if (text.trim() !== '') {
    try { acknowledged = !!(JSON.parse(text) as Record<string, unknown>).acknowledge_unmet } catch { throw badRequest('malformed JSON body') }
  }
  const d = await c.db.prepare(`SELECT status, academic_year_id, blocking_issues FROM timetable_drafts WHERE id = ?`).bind(draftID)
    .first<{ status: string; academic_year_id: string; blocking_issues: number }>()
  if (!d) throw notFound()
  if (d.status !== 'draft') throw coded(409, 'draft_closed', 'this draft has already been published or discarded')
  if (d.blocking_issues > 0 && !acknowledged) {
    throw coded(409, 'unmet_requirements', 'this draft leaves requirements unmet; re-send with acknowledge_unmet to publish it anyway')
  }
  const counts = await c.db.prepare(`
    SELECT (SELECT count(*) FROM timetable_entries WHERE academic_year_id = ?1
              AND section_id IN (SELECT section_id FROM timetable_draft_entries WHERE draft_id = ?2)) AS replaced,
           (SELECT count(*) FROM timetable_draft_entries WHERE draft_id = ?2) AS inserted`).bind(d.academic_year_id, draftID)
    .first<{ replaced: number; inserted: number }>()
  const announce = await announceStatements(c, draftID)
  const ts = nowISO()
  try {
    await c.db.batch([
      // Still open at write time: the FOR UPDATE of the Go transaction.
      guardStmt(c, `(SELECT status FROM timetable_drafts WHERE id = ?) = 'draft'`, [draftID]),
      c.db.prepare(`DELETE FROM timetable_entries WHERE academic_year_id = ?1
          AND section_id IN (SELECT DISTINCT section_id FROM timetable_draft_entries WHERE draft_id = ?2)`).bind(d.academic_year_id, draftID),
      c.db.prepare(`INSERT INTO timetable_entries (id, institution_id, academic_year_id, section_id, period_id, weekday, class_subject_id, teacher_user_id, room, created_at)
          SELECT ${UUID_SQL}, de.institution_id, ?2, de.section_id, de.period_id, de.weekday, de.class_subject_id, de.teacher_user_id, de.room, ?3
            FROM timetable_draft_entries de WHERE de.draft_id = ?1`).bind(draftID, d.academic_year_id, ts),
      c.db.prepare(`UPDATE timetable_drafts SET status = 'published', published_by = ?2, published_at = ?3 WHERE id = ?1`)
        .bind(draftID, c.id.platformAdmin ? null : c.id.userId, ts),
      ...announce.stmts,
    ])
  } catch (e) {
    if (isGuardFailure(e)) throw coded(409, 'draft_closed', 'this draft has already been published or discarded')
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      throw coded(409, 'grid_moved', 'the live timetable has changed since this draft was generated; generate a fresh one')
    }
    throw e
  }
  return ok({ published: true, periods_replaced: counts?.replaced ?? 0, periods_written: counts?.inserted ?? 0, people_notified: announce.told })
}

async function discardTimetableDraft(c: Ctx): Promise<Response> {
  const draftID = uuidOr400(c.params.id)
  const r = await c.db.prepare(`UPDATE timetable_drafts SET status = 'discarded' WHERE id = ? AND status = 'draft'`).bind(draftID).run()
  if (!r.meta.changes) throw coded(409, 'draft_closed', 'this draft has already been published or discarded')
  return ok({ discarded: true })
}

// --- the generator's own input ------------------------------------------------------------

async function saveSubjectRequirement(c: Ctx): Promise<Response> {
  const req = await readJSON<Record<string, unknown>>(c.req)
  const csID = trimStr(req.class_subject_id)
  if (!isUUID(csID)) throw badRequest('class_subject_id must be a uuid')
  const per = intOr(req.periods_per_week)
  if (per < 0 || per > 60) throw badRequest('periods_per_week must be between 0 and 60')
  const r = await c.db.prepare(`UPDATE class_subjects SET periods_per_week = ?, prefers_morning = ? WHERE id = ?`)
    .bind(per, req.prefers_morning ? 1 : 0, csID).run()
  if (!r.meta.changes) throw notFound()
  return ok({ saved: true })
}

async function saveTeacherLoadRule(c: Ctx): Promise<Response> {
  const inst = instId(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const userID = trimStr(req.teacher_user_id)
  if (!isUUID(userID)) throw badRequest('teacher_user_id must be a uuid')
  const perDay = intOr(req.max_periods_per_day), perWeek = intOr(req.max_periods_per_week)
  if (perDay < 1 || perDay > 20) throw badRequest('max_periods_per_day must be between 1 and 20')
  if (perWeek < perDay || perWeek > 80) throw badRequest('max_periods_per_week must be at least the daily cap and no more than 80')
  const ts = nowISO()
  // ON CONFLICT (institution_id, teacher_user_id): teacher_load_rules_one_per_teacher is a plain unique index.
  await c.db.prepare(`INSERT INTO teacher_load_rules (id, institution_id, teacher_user_id, max_periods_per_day, max_periods_per_week, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (institution_id, teacher_user_id) DO UPDATE
         SET max_periods_per_day = excluded.max_periods_per_day, max_periods_per_week = excluded.max_periods_per_week,
             notes = excluded.notes, updated_at = excluded.updated_at`)
    .bind(uuid(), inst, userID, perDay, perWeek, nullStr(req.notes), ts, ts).run()
  return ok({ saved: true })
}

async function saveTeacherUnavailability(c: Ctx): Promise<Response> {
  const inst = instId(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const userID = trimStr(req.teacher_user_id)
  if (!isUUID(userID)) throw badRequest('teacher_user_id must be a uuid')
  const weekday = intOr(req.weekday)
  if (weekday < 1 || weekday > 7) throw badRequest('weekday must be 1 (Monday) to 7')
  const period = nullStr(req.period_id)
  const reason = nullStr(req.reason)
  // teacher_unavailability_one_per_slot is an expression index (COALESCE(period_id, nil uuid)); the upsert is a lookup, then one write.
  const existing = await c.db.prepare(`SELECT id FROM teacher_unavailability WHERE institution_id = ? AND teacher_user_id = ? AND weekday = ?
      AND COALESCE(period_id, '00000000-0000-0000-0000-000000000000') = COALESCE(?, '00000000-0000-0000-0000-000000000000')`)
    .bind(inst, userID, weekday, period).first<{ id: string }>()
  if (existing) {
    await c.db.prepare(`UPDATE teacher_unavailability SET reason = ? WHERE id = ?`).bind(reason, existing.id).run()
  } else {
    await c.db.prepare(`INSERT INTO teacher_unavailability (id, institution_id, teacher_user_id, weekday, period_id, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst, userID, weekday, period, reason, nowISO()).run()
  }
  return created({ saved: true })
}

async function deleteTeacherUnavailability(c: Ctx): Promise<Response> {
  const id = uuidOr400(c.params.id)
  await c.db.prepare(`DELETE FROM teacher_unavailability WHERE id = ?`).bind(id).run()
  return ok({ deleted: true })
}

// --- the department timetable -------------------------------------------------------------------

async function getDepartmentTimetable(c: Ctx): Promise<Response> {
  const b = await rollupScope(c)
  const q = c.url.searchParams
  let wanted: string | null = null
  const raw = trimStr(q.get('department_id'))
  if (raw !== '') {
    if (!isUUID(raw)) throw badRequest('department_id must be a uuid')
    if (!b.all && !b.depts.includes(raw)) throw denied('that department is not yours')
    wanted = raw
  }
  const year = await resolveYear(c, q.get('academic_year_id') ?? '', 'no academic year')
  const periods = await loadPeriods(c)

  const dpred = b.all ? '1' : b.depts.length === 0 ? '0' : inJSON('d.id')
  const depts = await all<{ id: string; name: string }>(c.db.prepare(`SELECT d.id, d.name FROM departments d WHERE ${dpred} ORDER BY d.name`)
    .bind(...(b.all || b.depts.length === 0 ? [] : [JSON.stringify(b.depts)])))

  // ?1 year, ?2 1 when every department, ?3 the department set, ?4 the one department on screen.
  const deptScope = `(?2 = 1 OR e.department_id IN (SELECT value FROM json_each(?3)))`
  const args = [year, b.all ? 1 : 0, JSON.stringify(b.depts), wanted]

  const teachers = await all<{ user_id: string; full_name: string; employee_code: string; department: string; periods: number; max_week: number; max_day: number }>(
    c.db.prepare(`
    SELECT u.id AS user_id, u.full_name, e.employee_code, COALESCE(d.name, '-') AS department,
           COALESCE((SELECT count(*) FROM timetable_entries te WHERE te.teacher_user_id = u.id AND te.academic_year_id = ?1), 0) AS periods,
           COALESCE(lr.max_periods_per_week, 35) AS max_week, COALESCE(lr.max_periods_per_day, 6) AS max_day
      FROM employees e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN teacher_load_rules lr ON lr.teacher_user_id = u.id
     WHERE e.status IN ('active','on_leave') AND ${deptScope} AND (?4 IS NULL OR e.department_id = ?4)
     ORDER BY u.full_name`).bind(...args))
  const entries = await all<{ teacher_id: string; teacher_name: string; weekday: number; period_id: string; section_name: string; class_name: string
    subject_name: string; room: string | null }>(c.db.prepare(`
    SELECT te.teacher_user_id AS teacher_id, u.full_name AS teacher_name, te.weekday, te.period_id,
           sec.name AS section_name, c.name AS class_name, sub.name AS subject_name, te.room
      FROM timetable_entries te
      JOIN users u ON u.id = te.teacher_user_id
      JOIN employees e ON e.user_id = u.id
      JOIN sections sec ON sec.id = te.section_id
      JOIN classes c ON c.id = sec.class_id
      JOIN class_subjects cs ON cs.id = te.class_subject_id
      JOIN subjects sub ON sub.id = cs.subject_id
     WHERE te.academic_year_id = ?1 AND ${deptScope} AND (?4 IS NULL OR e.department_id = ?4)
     ORDER BY u.full_name, te.weekday`).bind(...args))
  const reqs = await all<{ section_name: string; class_name: string; subject_name: string; teacher_name: string | null; required: number; scheduled: number }>(
    c.db.prepare(`
    SELECT sec.name AS section_name, c.name AS class_name, sub.name AS subject_name, u.full_name AS teacher_name,
           cs.periods_per_week AS required,
           (SELECT count(*) FROM timetable_entries te WHERE te.section_id = sec.id AND te.class_subject_id = cs.id AND te.academic_year_id = ?1) AS scheduled
      FROM section_subject_teachers sst
      JOIN sections sec ON sec.id = sst.section_id
      JOIN classes c ON c.id = sec.class_id
      JOIN class_subjects cs ON cs.id = sst.class_subject_id
      JOIN subjects sub ON sub.id = cs.subject_id
      JOIN users u ON u.id = sst.teacher_user_id
      JOIN employees e ON e.user_id = u.id
     WHERE sec.academic_year_id = ?1 AND cs.periods_per_week > 0 AND ${deptScope} AND (?4 IS NULL OR e.department_id = ?4)
       AND cs.periods_per_week <> (SELECT count(*) FROM timetable_entries te
                                    WHERE te.section_id = sec.id AND te.class_subject_id = cs.id AND te.academic_year_id = ?1)
     ORDER BY c.level, sec.name, sub.name`).bind(...args))

  const cells = teachingCount(periods) * TEACHING_WEEKDAYS.length
  let over = 0, under = 0, assigned = 0, free = 0
  const teacherRows = teachers.map((t) => {
    const freeSlots = Math.max(0, cells - t.periods)
    assigned += t.periods
    free += freeSlots
    let load = 'ok'
    if (t.periods > t.max_week) { load = 'over'; over++ } else if (t.periods * 3 < t.max_week * 2) { load = 'under'; under++ }
    return { user_id: t.user_id, full_name: t.full_name, employee_code: t.employee_code ?? '', department: t.department, periods: t.periods,
      max_periods_per_week: t.max_week, max_periods_per_day: t.max_day, free_slots: freeSlots, load }
  })
  return ok({
    academic_year_id: year, departments: depts, department_id: wanted, weekdays: TEACHING_WEEKDAYS, periods,
    teachers: teacherRows,
    entries: entries.map((v) => {
      const o: Record<string, unknown> = { teacher_id: v.teacher_id, teacher_name: v.teacher_name, weekday: v.weekday, period_id: v.period_id,
        section_name: v.section_name, class_name: v.class_name, subject_name: v.subject_name }
      if (v.room !== null) o.room = v.room
      return o
    }),
    requirements: reqs.map((v) => {
      const o: Record<string, unknown> = { section_name: v.section_name, class_name: v.class_name, subject_name: v.subject_name }
      if (v.teacher_name !== null) o.teacher_name = v.teacher_name
      o.periods_required = v.required
      o.periods_scheduled = v.scheduled
      return o
    }),
    summary: { teachers: teacherRows.length, periods_assigned: assigned, free_slots: free, teaching_slots_a_week: cells,
      over_loaded: over, under_loaded: under, unmet_requirements: reqs.length },
  })
}

/** Go mounts every write under the tree's timetable.read gate as well as timetable.write. */
const alsoRead = (h: (c: Ctx) => Promise<Response>) => alsoNeeds(READ, h)

export function registerOptimizer(r: Router): void {
  r.get('/timetable-optimizer/inputs', READ, getOptimizerInputs)
  r.get('/timetable-optimizer/drafts', READ, listTimetableDrafts)
  r.post('/timetable-optimizer/drafts', WRITE, alsoRead(generateTimetableDraft))
  r.put('/timetable-optimizer/requirements', WRITE, alsoRead(saveSubjectRequirement))
  r.put('/timetable-optimizer/load-rules', WRITE, alsoRead(saveTeacherLoadRule))
  r.post('/timetable-optimizer/unavailability', WRITE, alsoRead(saveTeacherUnavailability))
  r.del('/timetable-optimizer/unavailability/{id}', WRITE, alsoRead(deleteTeacherUnavailability))
  r.get('/timetable-optimizer/drafts/{id}', READ, getTimetableDraft)
  r.post('/timetable-optimizer/drafts/{id}/publish', WRITE, alsoRead(publishTimetableDraft))
  r.post('/timetable-optimizer/drafts/{id}/discard', WRITE, alsoRead(discardTimetableDraft))
  r.get('/department-timetable', READ, getDepartmentTimetable)
}
