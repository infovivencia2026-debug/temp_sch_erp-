import type { Ctx, Router } from '../../router'
import { HttpError, badRequest, bool, created, isUUID, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { coded } from '../exams/common'
import { istMinuteT, todayIST } from '../admissions/util'
import { PhoneInUse, appointEmployee, ensureCampus } from '../setup/common'
import { changes, need, nullString, num0, numOrNull, omitNull, pgArray, run, s, strList } from './common'
import { school } from '../school'

/* Port of the recruitment half of hr_growth.go (mountHRGrowth):
   hr.hiring_growth.recruitment. */

export const READ = 'hr.employees.read', WRITE = 'hr.employees.write', SELF = 'self.profile.read'

/** A write route: the group's hr.employees.read plus the route's hr.employees.write. */
export const w = (h: (c: Ctx) => Promise<Response>) => async (c: Ctx) => { need(c, READ); return h(c) }

export const pathID = (c: Ctx) => uuidParam(c.params.id, 'id')

/** Failures hr_growth.go reported through httpx.Internal as a 500. They are
    the caller's mistake, not the server's: a missing row is a 404 and a
    record in the wrong state a 409, so the client shows the message. */
export class Internal extends HttpError {
  constructor(m: string) {
    const missing = m === 'no rows in result set'
    super(missing ? 404 : 409, missing ? 'resource not found' : m)
  }
}

const LIVE_STAGES = `('applied','screened','shortlisted','interviewed','demo_lesson','offered')`
const CLOSED_STAGES = `('joined','rejected','withdrawn')`

/** logCandidateEvent: one line of the candidate's history. */
function candidateEvent(c: Ctx, candidate: string, from: string, to: string, note: string): D1PreparedStatement {
  return c.db.prepare(`INSERT INTO job_candidate_events (id, institution_id, candidate_id, from_stage, to_stage, note, actor_user_id, occurred_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(uuid(), school(c).id, candidate, nullString(from), to, nullString(note), c.id.userId, now())
}

/** A naive "YYYY-MM-DDTHH:MM" is the school's clock (IST); stored as UTC ISO. */
function tsFromClient(v: string): string | null {
  if (v === '') return null
  const t = v.trim().replace(' ', 'T')
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(t)
  const d = new Date(hasZone ? t : t + (t.length <= 10 ? 'T00:00:00' : '') + '+05:30')
  if (Number.isNaN(d.getTime())) throw badRequest('scheduled_at is not a timestamp')
  return d.toISOString()
}

async function requireUnique(db: D1Database, sql: string, ...args: unknown[]): Promise<void> {
  if (await db.prepare(sql).bind(...args).first()) throw coded(409, 'duplicate', 'that record already exists')
}

function splitPersonName(full: string): [string, string] {
  const parts = full.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return [full, '']
  if (parts.length === 1) return [parts[0], '']
  return [parts.slice(0, -1).join(' '), parts[parts.length - 1]]
}

export function registerRecruitment(r: Router) {
  // The role vocabulary: designations with how many active staff hold each.
  r.get('/hr-growth/designations', READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT g.id, g.name, g.category, count(CASE WHEN e.status = 'active' THEN e.id END) AS staff
        FROM designations g LEFT JOIN employees e ON e.designation_id = g.id
       GROUP BY g.id ORDER BY g.category IS NULL, g.category, g.name`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ id: v.id, name: v.name, category: v.category, staff: num0(v.staff) })) })
  })

  // ---------------------------------------------------------------- vacancies
  r.get('/hr-growth/vacancies', READ, async (c) => {
    const status = nullString(c.url.searchParams.get('status'))
    const rows = await c.db.prepare(`
      SELECT v.id, v.code, v.title, d.name AS department, g.name AS designation, sub.name AS subject,
             v.employment_type, v.positions, v.salary_min_paise, v.salary_max_paise,
             v.min_qualification, v.min_experience_years, v.justification,
             v.status, ru.full_name AS raised_by, SUBSTR(v.raised_on,1,10) AS raised_on,
             au.full_name AS approved_by, SUBSTR(v.approved_at,1,10) AS approved_on,
             v.decision_note, SUBSTR(v.closes_on,1,10) AS closes_on,
             count(c.id) AS applicants,
             count(CASE WHEN c.stage IN ${LIVE_STAGES} THEN 1 END) AS in_process,
             count(CASE WHEN c.stage = 'joined' THEN 1 END) AS joined,
             MAX(v.positions - count(CASE WHEN c.stage = 'joined' THEN 1 END), 0) AS remaining
        FROM job_vacancies v
        LEFT JOIN departments  d   ON d.id   = v.department_id
        LEFT JOIN designations g   ON g.id   = v.designation_id
        LEFT JOIN subjects     sub ON sub.id = v.subject_id
        LEFT JOIN users        ru  ON ru.id  = v.raised_by
        LEFT JOIN users        au  ON au.id  = v.approved_by
        LEFT JOIN job_candidates c ON c.vacancy_id = v.id
       WHERE (?1 IS NULL OR v.status = ?1)
       GROUP BY v.id
       ORDER BY (v.status IN ('approved','pending_approval')) DESC, v.raised_on DESC
       LIMIT 300`).bind(status).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, positions: num0(v.positions),
      salary_min_paise: numOrNull(v.salary_min_paise), salary_max_paise: numOrNull(v.salary_max_paise),
      min_experience_years: numOrNull(v.min_experience_years), applicants: num0(v.applicants), in_process: num0(v.in_process),
      joined: num0(v.joined), remaining: num0(v.remaining) })) })
  })

  r.post('/hr-growth/vacancies', WRITE, w(async (c) => {
    const req = await readJSON(c.req)
    const code = s(req.code).trim(), title = s(req.title).trim()
    if (code === '' || title === '') throw badRequest('code and title are required')
    let positions = typeof req.positions === 'number' ? Math.trunc(req.positions) : 0
    if (positions <= 0) positions = 1
    const min = numOrNull(req.salary_min_paise), max = numOrNull(req.salary_max_paise)
    if (min !== null && max !== null && max < min) throw badRequest('the top of the band cannot be below the bottom of it')
    const status = req.submit === true ? 'pending_approval' : 'draft'
    const vals = [nullString(req.department_id), nullString(req.designation_id), nullString(req.subject_id), nullString(req.academic_year_id),
      nullString(req.employment_type), positions, min, max, nullString(req.min_qualification), numOrNull(req.min_experience_years),
      nullString(req.justification), nullString(req.closes_on), status]
    const t = now()
    const id = s(req.id)
    if (id !== '') {
      const [res] = await run(c.db, [c.db.prepare(`
        UPDATE job_vacancies SET title = ?, department_id = ?, designation_id = ?, subject_id = ?, academic_year_id = ?,
               employment_type = ?, positions = ?, salary_min_paise = ?, salary_max_paise = ?, min_qualification = ?,
               min_experience_years = ?, justification = ?, closes_on = ?, status = ?, updated_at = ?
         WHERE id = ? AND status IN ('draft','pending_approval')`).bind(s(req.title), ...vals, t, id)])
      if (changes(res) === 0) throw new Internal('an approved vacancy cannot be edited; withdraw it and raise another')
      return created({ id, status })
    }
    await requireUnique(c.db, `SELECT 1 FROM job_vacancies WHERE institution_id = ? AND lower(code) = lower(?)`, school(c).id, code)
    const out = uuid()
    await run(c.db, [c.db.prepare(`
      INSERT INTO job_vacancies (id, institution_id, code, title, department_id, designation_id, subject_id, academic_year_id,
             employment_type, positions, salary_min_paise, salary_max_paise, min_qualification, min_experience_years,
             justification, closes_on, status, raised_by, raised_on, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(out, school(c).id, code, title, ...vals, c.id.userId, todayIST(), t, t)])
    return created({ id: out, status })
  }))

  r.post('/hr-growth/vacancies/{id}/decide', WRITE, w(async (c) => {
    const vac = pathID(c)
    const req = await readJSON(c.req)
    const next = ({ approve: 'approved', reject: 'rejected', hold: 'on_hold', close: 'closed', withdraw: 'draft' } as Record<string, string>)[s(req.action)]
    if (!next) throw badRequest('action must be approve, reject, hold, close or withdraw')
    const approving = req.action === 'approve' ? 1 : 0
    const t = now()
    const [res] = await run(c.db, [c.db.prepare(`
      UPDATE job_vacancies
         SET status = ?2, decision_note = COALESCE(?3, decision_note),
             approved_by = CASE WHEN ?4 THEN ?5 ELSE approved_by END,
             approved_at = CASE WHEN ?4 THEN ?6 ELSE approved_at END,
             closed_at   = CASE WHEN ?2 IN ('closed','rejected') THEN ?6 ELSE closed_at END,
             updated_at = ?6
       WHERE id = ?1`).bind(vac, next, nullString(req.note), approving, c.id.userId, t)])
    if (changes(res) === 0) throw notFound('resource not found')
    return ok({ id: vac, status: next })
  }))

  // ---------------------------------------------------------------- candidates
  r.get('/hr-growth/candidates', READ, async (c) => {
    const q = c.url.searchParams
    const rows = await c.db.prepare(`
      SELECT c.id, c.vacancy_id, v.code AS vacancy_code, v.title AS vacancy_title,
             c.full_name, c.email, c.phone, c.qualification, c.experience_years, c.current_employer,
             c.expected_salary_paise, c.notice_period_days, c.source, c.resume_file_id, c.stage,
             SUBSTR(c.applied_on,1,10) AS applied_on, c.rating, c.notes, c.outcome_reason,
             c.employee_id, e.employee_code,
             CAST(julianday('now') - julianday(c.stage_changed_at) AS INTEGER) AS days_since_move,
             (SELECT count(*) FROM job_interviews i WHERE i.candidate_id = c.id) AS interviews,
             EXISTS (SELECT 1 FROM job_offers o WHERE o.candidate_id = c.id AND o.status IN ('draft','sent','accepted')) AS has_live_offer
        FROM job_candidates c
        JOIN job_vacancies v ON v.id = c.vacancy_id
        LEFT JOIN employees e ON e.id = c.employee_id
       WHERE (?1 IS NULL OR c.vacancy_id = ?1)
         AND (?2 IS NULL OR c.stage = ?2)
         AND (?3 = 0 OR c.stage NOT IN ${CLOSED_STAGES})
       ORDER BY (c.stage NOT IN ${CLOSED_STAGES}) DESC, c.stage_changed_at
       LIMIT 500`).bind(nullString(q.get('vacancy_id')), nullString(q.get('stage')), q.get('open') === 'true' ? 1 : 0).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, experience_years: numOrNull(v.experience_years),
      expected_salary_paise: numOrNull(v.expected_salary_paise), notice_period_days: numOrNull(v.notice_period_days),
      rating: numOrNull(v.rating), days_since_move: num0(v.days_since_move), interviews: num0(v.interviews),
      has_live_offer: bool(v.has_live_offer) })) })
  })

  r.post('/hr-growth/candidates', WRITE, w(async (c) => {
    const req = await readJSON(c.req)
    const vacancy = s(req.vacancy_id), fullName = s(req.full_name).trim()
    if (vacancy === '' || fullName === '') throw badRequest('vacancy_id and full_name are required')
    if (s(req.email).trim() === '' && s(req.phone).trim() === '') throw badRequest('an email or a phone number is required')
    const source = s(req.source) || 'direct'
    const inst = school(c).id
    const vals = [nullString(req.email), nullString(req.phone), nullString(req.gender), nullString(req.date_of_birth),
      nullString(req.qualification), numOrNull(req.experience_years), nullString(req.current_employer), numOrNull(req.expected_salary_paise),
      numOrNull(req.notice_period_days), source, nullString(req.resume_file_id), numOrNull(req.rating), nullString(req.notes)]
    const id = s(req.id)
    // job_candidates_one_per_vacancy: one candidacy per contact per post.
    const dupe = `SELECT 1 FROM job_candidates WHERE institution_id = ? AND vacancy_id = ?
        AND lower(COALESCE(TRIM(email),'')) = lower(COALESCE(TRIM(?),'')) AND COALESCE(TRIM(phone),'') = COALESCE(TRIM(?),'') AND id <> ?`
    const t = now()
    if (id !== '') {
      const cur = await c.db.prepare(`SELECT vacancy_id FROM job_candidates WHERE id = ?`).bind(id).first<{ vacancy_id: string }>()
      if (!cur) throw new Internal('no rows in result set')
      await requireUnique(c.db, dupe, inst, cur.vacancy_id, nullString(req.email), nullString(req.phone), id)
      await run(c.db, [c.db.prepare(`
        UPDATE job_candidates SET full_name = ?, email = ?, phone = ?, gender = ?, date_of_birth = ?, qualification = ?,
               experience_years = ?, current_employer = ?, expected_salary_paise = ?, notice_period_days = ?,
               source = ?, resume_file_id = ?, rating = ?, notes = ?, updated_at = ? WHERE id = ?`).bind(fullName, ...vals, t, id)])
      return created({ id })
    }
    await requireUnique(c.db, dupe, inst, vacancy, nullString(req.email), nullString(req.phone), '')
    const out = uuid()
    await run(c.db, [
      c.db.prepare(`INSERT INTO job_candidates (id, institution_id, vacancy_id, full_name, email, phone, gender, date_of_birth, qualification,
          experience_years, current_employer, expected_salary_paise, notice_period_days, source, resume_file_id, rating, notes,
          stage, stage_changed_at, applied_on, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'applied',?,?,?,?)`).bind(out, inst, vacancy, fullName, ...vals, t, todayIST(), t, t),
      candidateEvent(c, out, '', 'applied', ''),
    ])
    return created({ id: out })
  }))

  r.post('/hr-growth/candidates/{id}/stage', WRITE, w(async (c) => {
    const cand = pathID(c)
    const req = await readJSON(c.req)
    const stage = s(req.stage)
    if (stage === 'joined') throw coded(409, 'use_hire', 'a candidate joins by being hired, which creates their employee record; POST .../hire')
    if (!['applied', 'screened', 'shortlisted', 'interviewed', 'demo_lesson', 'offered', 'rejected', 'withdrawn'].includes(stage)) throw badRequest('unknown stage')
    const was = await c.db.prepare(`SELECT stage FROM job_candidates WHERE id = ? AND stage <> 'joined'`).bind(cand).first<{ stage: string }>()
    if (!was) throw new Internal('no rows in result set')
    const t = now()
    await run(c.db, [
      c.db.prepare(`UPDATE job_candidates SET stage = ?, stage_changed_at = ?, outcome_reason = COALESCE(?, outcome_reason), updated_at = ?
          WHERE id = ? AND stage <> 'joined'`).bind(stage, t, nullString(req.outcome_reason), t, cand),
      candidateEvent(c, cand, was.stage, stage, s(req.note)),
    ])
    return ok({ id: cand, stage })
  }))

  /* hireCandidate: the candidate becomes an employee through appointEmployee
     (the staff screen's own path), is marked joined, and the vacancy closes
     when the last position is filled. */
  r.post('/hr-growth/candidates/{id}/hire', WRITE, w(async (c) => {
    const cand = pathID(c)
    const req = await readJSON(c.req)
    const code = s(req.employee_code).trim()
    if (code === '') throw badRequest('employee_code is required')
    const row = await c.db.prepare(`
      SELECT c.full_name, COALESCE(c.email,'') AS email, COALESCE(c.phone,'') AS phone, c.employee_id, c.vacancy_id,
             COALESCE(o.designation_id, v.designation_id) AS designation_id, COALESCE(o.department_id, v.department_id) AS department_id
        FROM job_candidates c JOIN job_vacancies v ON v.id = c.vacancy_id
        LEFT JOIN job_offers o ON o.candidate_id = c.id AND o.status = 'accepted'
       WHERE c.id = ?`).bind(cand)
      .first<{ full_name: string; email: string; phone: string; employee_id: string | null; vacancy_id: string; designation_id: string | null; department_id: string | null }>()
    if (!row) throw notFound('resource not found')
    if (row.employee_id) throw coded(409, 'already_hired', 'this candidate has already been appointed')
    let first = s(req.first_name), last = s(req.last_name)
    if (first === '') [first, last] = splitPersonName(row.full_name)
    const createLogin = req.create_login === true
    if (first === '') throw badRequest('first_name is required')
    if (createLogin && row.email === '' && row.phone === '') throw badRequest('an email or a phone number is required to create a login')
    const campus = await ensureCampus(c)
    const appointed = await appointEmployee(c, campus, {
      employee_code: code, first_name: first, last_name: last, email: row.email, phone: row.phone,
      department_id: s(req.department_id) || (row.department_id ?? ''), designation_id: s(req.designation_id) || (row.designation_id ?? ''),
      joined_on: s(req.joined_on), employment_type: s(req.employment_type), create_login: createLogin, role_key: s(req.role_key),
    }).catch((e) => { throw e instanceof PhoneInUse ? new HttpError(409, e.message) : e })
    const t = now()
    await run(c.db, [
      c.db.prepare(`UPDATE job_candidates SET stage = 'joined', stage_changed_at = ?, employee_id = ?, hired_at = ?, updated_at = ? WHERE id = ?`)
        .bind(t, appointed.empId, t, t, cand),
      candidateEvent(c, cand, 'offered', 'joined', s(req.note)),
      c.db.prepare(`UPDATE job_vacancies SET status = CASE WHEN (SELECT count(*) FROM job_candidates c WHERE c.vacancy_id = job_vacancies.id AND c.stage = 'joined') >= positions
             THEN 'filled' ELSE status END, updated_at = ? WHERE id = ?`).bind(t, row.vacancy_id),
    ])
    const v = await c.db.prepare(`SELECT status FROM job_vacancies WHERE id = ?`).bind(row.vacancy_id).first<{ status: string }>()
    return created({ employee_id: appointed.empId, user_id: appointed.userId || null, candidate_id: cand, vacancy_filled: v?.status === 'filled' })
  }))

  // ---------------------------------------------------------------- interviews
  r.get('/hr-growth/interviews', READ, async (c) => {
    const q = c.url.searchParams
    const rows = await c.db.prepare(`
      SELECT i.id, i.candidate_id, c.full_name AS candidate, v.code AS vacancy_code, i.round,
             ${istMinuteT('i.scheduled_at')} AS scheduled_at, i.mode,
             TRIM(COALESCE(cl.name,'') || ' ' || COALESCE(sec.name,'')) AS section, sub.name AS subject, i.venue,
             i.panel_user_ids, i.result, i.score, i.remarks
        FROM job_interviews i
        JOIN job_candidates c ON c.id = i.candidate_id
        JOIN job_vacancies  v ON v.id = c.vacancy_id
        LEFT JOIN sections sec ON sec.id = i.section_id
        LEFT JOIN classes  cl  ON cl.id  = sec.class_id
        LEFT JOIN subjects sub ON sub.id = i.subject_id
       WHERE (?1 IS NULL OR i.candidate_id = ?1) AND (?2 = 0 OR i.result = 'scheduled')
       ORDER BY i.scheduled_at IS NULL, i.scheduled_at
       LIMIT 300`).bind(nullString(q.get('candidate_id')), q.get('upcoming') === 'true' ? 1 : 0).all<Record<string, unknown>>()
    const ids = [...new Set(rows.results.flatMap((v) => pgArray(v.panel_user_ids)))]
    const names = new Map<string, string>()
    if (ids.length) {
      const us = await c.db.prepare(`SELECT id, full_name FROM users WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<{ id: string; full_name: string }>()
      for (const u of us.results) names.set(u.id, u.full_name)
    }
    return ok({ items: rows.results.map((v) => {
      const panel = pgArray(v.panel_user_ids).map((p) => names.get(p)).filter((x): x is string => x !== undefined).sort()
      const out = omitNull({ ...v, score: numOrNull(v.score), panel })
      delete (out as Record<string, unknown>).panel_user_ids
      return out
    }) })
  })

  r.post('/hr-growth/interviews', WRITE, w(async (c) => {
    const req = await readJSON(c.req)
    const candidate = s(req.candidate_id), round = s(req.round)
    if (candidate === '' || round === '') throw badRequest('candidate_id and round are required')
    const panel = strList(req.panel_user_ids)
    if (panel.some((p) => !isUUID(p))) throw badRequest('panel_user_ids must be uuids')
    const out = uuid(), t = now()
    await run(c.db, [c.db.prepare(`INSERT INTO job_interviews (id, institution_id, candidate_id, round, scheduled_at, mode, section_id, subject_id, venue,
        panel_user_ids, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(out, school(c).id, candidate, round, tsFromClient(s(req.scheduled_at)), s(req.mode) || 'in_person',
        nullString(req.section_id), nullString(req.subject_id), nullString(req.venue), JSON.stringify(panel), t, t)])
    return created({ id: out })
  }))

  r.post('/hr-growth/interviews/{id}/result', WRITE, w(async (c) => {
    const iv = pathID(c)
    const req = await readJSON(c.req)
    const result = s(req.result)
    if (!['pass', 'fail', 'hold', 'no_show', 'cancelled'].includes(result)) throw badRequest('result must be pass, fail, hold, no_show or cancelled')
    const advance = s(req.advance_to)
    if (advance === 'joined') throw coded(409, 'use_hire', 'a candidate joins by being hired; POST .../hire')
    const cur = await c.db.prepare(`SELECT i.candidate_id, c.stage FROM job_interviews i LEFT JOIN job_candidates c ON c.id = i.candidate_id WHERE i.id = ?`)
      .bind(iv).first<{ candidate_id: string; stage: string | null }>()
    if (!cur) throw new Internal('no rows in result set')
    const t = now()
    const stmts = [c.db.prepare(`UPDATE job_interviews SET result = ?, score = ?, remarks = ?, recorded_by = ?, recorded_at = ?, updated_at = ? WHERE id = ?`)
      .bind(result, numOrNull(req.score), nullString(req.remarks), c.id.userId, t, t, iv)]
    if (advance !== '') {
      stmts.push(c.db.prepare(`UPDATE job_candidates SET stage = ?, stage_changed_at = ?, updated_at = ? WHERE id = ? AND stage <> 'joined'`)
        .bind(advance, t, t, cur.candidate_id))
      stmts.push(candidateEvent(c, cur.candidate_id, cur.stage ?? '', advance, s(req.remarks)))
    }
    await run(c.db, stmts)
    return ok({ id: iv, result })
  }))

  // ---------------------------------------------------------------- offers
  r.get('/hr-growth/offers', READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT o.id, o.candidate_id, c.full_name AS candidate, v.code AS vacancy_code,
             SUBSTR(o.offered_on,1,10) AS offered_on, g.name AS designation, d.name AS department,
             o.gross_monthly_paise, SUBSTR(o.joining_on,1,10) AS joining_on, SUBSTR(o.valid_until,1,10) AS valid_until, o.status,
             SUBSTR(o.responded_on,1,10) AS responded_on, o.response_note, o.offer_file_id,
             (o.status = 'sent' AND o.valid_until IS NOT NULL AND o.valid_until < ?2) AS lapsed
        FROM job_offers o
        JOIN job_candidates c ON c.id = o.candidate_id
        JOIN job_vacancies  v ON v.id = c.vacancy_id
        LEFT JOIN designations g ON g.id = o.designation_id
        LEFT JOIN departments  d ON d.id = o.department_id
       WHERE (?1 IS NULL OR o.candidate_id = ?1)
       ORDER BY o.offered_on DESC LIMIT 300`).bind(nullString(c.url.searchParams.get('candidate_id')), todayIST()).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, gross_monthly_paise: num0(v.gross_monthly_paise), lapsed: bool(v.lapsed) })) })
  })

  r.post('/hr-growth/offers', WRITE, w(async (c) => {
    const req = await readJSON(c.req)
    const candidate = s(req.candidate_id)
    if (candidate === '') throw badRequest('candidate_id is required')
    const gross = typeof req.gross_monthly_paise === 'number' ? Math.trunc(req.gross_monthly_paise) : 0
    if (gross <= 0) throw badRequest('gross_monthly_paise must be a positive number of paise')
    const send = req.send === true
    const status = send ? 'sent' : 'draft'
    // job_offers_one_live: one live offer per candidate.
    await requireUnique(c.db, `SELECT 1 FROM job_offers WHERE candidate_id = ? AND status IN ('draft','sent','accepted')`, candidate)
    const out = uuid(), t = now()
    const stmts = [c.db.prepare(`INSERT INTO job_offers (id, institution_id, candidate_id, offered_on, designation_id, department_id, employment_type,
        gross_monthly_paise, joining_on, valid_until, offer_file_id, status, issued_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(out, school(c).id, candidate, todayIST(), nullString(req.designation_id), nullString(req.department_id), nullString(req.employment_type),
        gross, nullString(req.joining_on), nullString(req.valid_until), nullString(req.offer_file_id), status, c.id.userId, t, t)]
    if (send) {
      stmts.push(c.db.prepare(`UPDATE job_candidates SET stage = 'offered', stage_changed_at = ?, updated_at = ? WHERE id = ? AND stage <> 'joined'`).bind(t, t, candidate))
      stmts.push(candidateEvent(c, candidate, '', 'offered', 'offer issued'))
    }
    await run(c.db, stmts)
    return created({ id: out, status })
  }))

  r.post('/hr-growth/offers/{id}/respond', WRITE, w(async (c) => {
    const off = pathID(c)
    const req = await readJSON(c.req)
    const status = s(req.status)
    if (!['accepted', 'declined', 'withdrawn', 'expired'].includes(status)) throw badRequest('status must be accepted, declined, withdrawn or expired')
    const cur = await c.db.prepare(`SELECT candidate_id FROM job_offers WHERE id = ?`).bind(off).first<{ candidate_id: string }>()
    if (!cur) throw new Internal('no rows in result set')
    const t = now()
    const stmts = [c.db.prepare(`UPDATE job_offers SET status = ?, responded_on = ?, response_note = ?, updated_at = ? WHERE id = ?`)
      .bind(status, todayIST(), nullString(req.note), t, off)]
    if (status === 'declined' || status === 'expired') {
      stmts.push(c.db.prepare(`UPDATE job_candidates SET stage = 'withdrawn', stage_changed_at = ?, outcome_reason = COALESCE(outcome_reason, 'offer ' || ?),
          updated_at = ? WHERE id = ? AND stage = 'offered'`).bind(t, status, t, cur.candidate_id))
    }
    stmts.push(candidateEvent(c, cur.candidate_id, 'offered', 'offer_' + status, s(req.note)))
    await run(c.db, stmts)
    return ok({ id: off, status })
  }))

  // The pipeline, with the median days a candidate has sat at each stage (percentile_cont(0.5)).
  r.get('/hr-growth/recruitment/funnel', READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT c.stage, CAST(julianday('now') - julianday(c.stage_changed_at) AS INTEGER) AS days
        FROM job_candidates c JOIN job_vacancies v ON v.id = c.vacancy_id
       WHERE (?1 IS NULL OR c.vacancy_id = ?1)`).bind(nullString(c.url.searchParams.get('vacancy_id'))).all<{ stage: string; days: number | null }>()
    const order = ['applied', 'screened', 'shortlisted', 'interviewed', 'demo_lesson', 'offered', 'joined', 'rejected', 'withdrawn']
    const by = new Map<string, number[]>()
    for (const r0 of rows.results) {
      if (!by.has(r0.stage)) by.set(r0.stage, [])
      if (r0.days !== null) by.get(r0.stage)!.push(Number(r0.days))
    }
    const counts = new Map<string, number>()
    for (const r0 of rows.results) counts.set(r0.stage, (counts.get(r0.stage) ?? 0) + 1)
    const stages = [...by.keys()].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
    return ok({ items: stages.map((stage) => {
      const d = by.get(stage)!.sort((a, b) => a - b)
      let median: number | null = null
      if (d.length) { const pos = (d.length - 1) / 2, lo = Math.floor(pos); median = d[lo] + (d[Math.ceil(pos)] - d[lo]) * (pos - lo) }
      return omitNull({ stage, count: counts.get(stage) ?? 0, median_days_waiting: median })
    }) })
  })
}
