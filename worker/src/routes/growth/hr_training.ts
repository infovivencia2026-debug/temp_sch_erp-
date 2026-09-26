import type { Ctx, Router } from '../../router'
import { HttpError, badRequest, bool, created, isUUID, now, ok, readJSON, uuid } from '../../http'
import { coded } from '../exams/common'
import { todayIST } from '../admissions/util'
import { employeeFilter, growthReach } from '../hr/reach'
import { n, nullString, num0, numOrNull, omitNull, pgArray, run, s, strList, changes } from './common'
import { Internal, READ, SELF, WRITE, pathID, w } from './hr_recruit'
import { ownEmployee } from './hr_appraisal'
import { school } from '../school'

/* Port of the training and rostering halves of hr_growth.go:
   hr.hiring_growth.staff_training_workshop_logs and
   hr.attendance.staff_shift_rostering. */

const empName = (a: string) => `TRIM(COALESCE(${a}.first_name,'') || ' ' || COALESCE(${a}.last_name,''))`

const recordSelect = `
  SELECT t.id, t.programme_id, p.title AS programme, p.provider, SUBSTR(p.starts_on,1,10) AS starts_on, t.employee_id, e.employee_code,
         ${empName('e')} AS full_name, d.name AS department, t.status, SUBSTR(t.attended_on,1,10) AS attended_on, t.hours_completed,
         t.score, t.certificate_file_id, t.certificate_no, SUBSTR(t.certificate_issued_on,1,10) AS certificate_issued_on,
         p.counts_towards_requirement
    FROM staff_training_records t
    JOIN training_programmes p ON p.id = t.programme_id
    JOIN employees e ON e.id = t.employee_id
    LEFT JOIN departments d ON d.id = e.department_id`

const recordRow = (v: Record<string, unknown>) => omitNull({ ...v, hours_completed: numOrNull(v.hours_completed), score: numOrNull(v.score),
  counts_towards_requirement: bool(v.counts_towards_requirement) })

/** ISO weekday (1 Monday .. 7 Sunday) of a date column. */
const isodow = (col: string) => `(CASE strftime('%w', ${col}) WHEN '0' THEN 7 ELSE CAST(strftime('%w', ${col}) AS INTEGER) END)`
/** to_char(d, 'DD Mon'). */
const ddMon = (col: string) => `strftime('%d', ${col}) || ' ' || substr('JanFebMarAprMayJunJulAugSepOctNovDec', 3 * CAST(strftime('%m', ${col}) AS INTEGER) - 2, 3)`
const hhmm = (col: string) => `SUBSTR(time(${col}),1,5)`

/* duty_roster_conflicts(institution, from, to): every live duty that lands on
   a timetabled period, a declared unavailability or approved leave. */
const conflictsSQL = `
  SELECT d.id AS assignment_id, d.user_id, d.on_date, 'teaching' AS kind,
         'timetabled to teach ' || p.name || ' (' || ${hhmm('p.starts_at')} || '-' || ${hhmm('p.ends_at')} || ')' AS detail
    FROM duty_assignments d
    JOIN timetable_entries te ON te.teacher_user_id = d.user_id AND te.weekday = ${isodow('d.on_date')}
    JOIN periods p ON p.id = te.period_id AND time(p.starts_at) < time(d.ends_at) AND time(p.ends_at) > time(d.starts_at)
   WHERE d.on_date BETWEEN ?1 AND ?2 AND d.status <> 'cancelled'
  UNION ALL
  SELECT d.id, d.user_id, d.on_date, 'unavailable', COALESCE(tu.reason, 'declared unavailable')
    FROM duty_assignments d
    JOIN teacher_unavailability tu ON tu.teacher_user_id = d.user_id AND tu.weekday = ${isodow('d.on_date')}
    LEFT JOIN periods p ON p.id = tu.period_id
   WHERE d.on_date BETWEEN ?1 AND ?2 AND d.status <> 'cancelled'
     AND (tu.period_id IS NULL OR (time(p.starts_at) < time(d.ends_at) AND time(p.ends_at) > time(d.starts_at)))
  UNION ALL
  SELECT d.id, d.user_id, d.on_date, 'leave', 'approved leave ' || ${ddMon('l.from_date')} || ' to ' || ${ddMon('l.to_date')}
    FROM duty_assignments d
    JOIN employees e ON e.id = COALESCE(d.employee_id, (SELECT e2.id FROM employees e2 WHERE e2.user_id = d.user_id LIMIT 1))
    JOIN leave_requests l ON l.employee_id = e.id AND l.subject_kind = 'staff' AND l.status = 'approved' AND d.on_date BETWEEN l.from_date AND l.to_date
   WHERE d.on_date BETWEEN ?1 AND ?2 AND d.status <> 'cancelled'`

/** growthRange: ?from=&to=, defaulting to the month around today in India. */
function growthRange(c: Ctx): [string, string] {
  const q = c.url.searchParams
  const from = q.get('from') ?? '', to = q.get('to') ?? ''
  if (from !== '' && to !== '') return [from, to]
  const today = todayIST()
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7))
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return [today.slice(0, 8) + '01', today.slice(0, 8) + String(last).padStart(2, '0')]
}

/** An HH:MM or HH:MM:SS clock, as HH:MM:SS (the Postgres time columns). */
function clock(v: string, name: string): string {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(v.trim())
  if (!m) throw badRequest(`${name} must be HH:MM`)
  return `${m[1].padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}`
}

const DUTY_KINDS = ['gate', 'ground', 'exam_invigilation', 'transport_escort', 'library', 'lab', 'reception', 'assembly', 'dispersal', 'hostel_night', 'canteen', 'other']

const SEED_SHIFTS: [string, string, string, string, string, number, number][] = [
  ['GATE_AM', 'Morning gate duty', 'gate', '07:15:00', '08:15:00', 1, 2],
  ['ASSEMBLY', 'Assembly duty', 'assembly', '08:15:00', '08:45:00', 0, 2],
  ['GROUND_PM', 'Ground and games', 'ground', '13:30:00', '14:30:00', 1, 2],
  ['DISPERSAL', 'Dispersal duty', 'dispersal', '15:00:00', '15:45:00', 1, 3],
  ['BUS_ESC', 'Transport escort', 'transport_escort', '15:15:00', '16:30:00', 1, 1],
  ['LIB_DESK', 'Library desk', 'library', '10:00:00', '11:00:00', 0, 1],
  ['LAB_DUTY', 'Laboratory duty', 'lab', '11:00:00', '12:00:00', 0, 1],
  ['INVIG', 'Exam invigilation', 'exam_invigilation', '09:00:00', '12:00:00', 0, 1],
]

const rosterSelect = `
  SELECT a.id, a.shift_id, sh.code AS shift_code, sh.name AS shift_name, sh.duty_kind, sh.is_onerous, a.user_id, u.full_name,
         e.employee_code, d.name AS department, SUBSTR(a.on_date,1,10) AS on_date, ${hhmm('a.starts_at')} AS starts_at,
         ${hhmm('a.ends_at')} AS ends_at, a.status, a.override_reason, a.notes
    FROM duty_assignments a
    JOIN duty_shifts sh ON sh.id = a.shift_id
    JOIN users u ON u.id = a.user_id
    LEFT JOIN employees e ON e.id = a.employee_id
    LEFT JOIN departments d ON d.id = e.department_id`
const rosterRow = (v: Record<string, unknown>) => omitNull({ ...v, is_onerous: bool(v.is_onerous) })

export function registerTraining(r: Router) {
  // ---------------------------------------------------------------- the employee's own
  r.get('/hr-growth/me/training/requirement', SELF, async (c) => {
    const emp = await ownEmployee(c)
    const [done, rule] = await c.db.batch([
      c.db.prepare(`SELECT COALESCE(SUM(${n('t.hours_completed')}), 0) AS h FROM staff_training_records t JOIN training_programmes p ON p.id = t.programme_id
          WHERE t.employee_id = ? AND t.status = 'completed' AND p.counts_towards_requirement = 1`).bind(emp),
      c.db.prepare(`SELECT q.required_hours, q.authority, q.note FROM training_requirements q
          JOIN employees e ON e.id = ?1 LEFT JOIN designations g ON g.id = e.designation_id
         WHERE (q.designation_id = e.designation_id
                OR (q.designation_id IS NULL AND q.designation_category = g.category)
                OR (q.designation_id IS NULL AND q.designation_category IS NULL))
           AND (q.academic_year_id IS NULL OR q.academic_year_id = (SELECT y.id FROM academic_years y WHERE y.is_current = 1 LIMIT 1))
         ORDER BY (q.designation_id IS NULL), (q.designation_category IS NULL), (q.academic_year_id IS NULL) LIMIT 1`).bind(emp),
    ])
    const q = (rule.results[0] ?? null) as Record<string, unknown> | null
    return ok(omitNull({ required_hours: q ? numOrNull(q.required_hours) : null, completed_hours: num0((done.results[0] as { h: unknown })?.h),
      authority: q?.authority ?? null, note: q?.note ?? null }))
  })

  r.get('/hr-growth/me/training', SELF, async (c) => {
    const emp = await ownEmployee(c)
    const rows = await c.db.prepare(recordSelect + ` WHERE t.employee_id = ? ORDER BY p.starts_on DESC`).bind(emp).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(recordRow) })
  })

  r.get('/hr-growth/me/duties', SELF, async (c) => {
    const [from, to] = growthRange(c)
    const rows = await c.db.prepare(rosterSelect + ` WHERE a.user_id = ? AND a.on_date BETWEEN ? AND ? AND a.status <> 'cancelled'
        ORDER BY a.on_date, time(a.starts_at)`).bind(c.id.userId, from, to).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(rosterRow) })
  })

  // ---------------------------------------------------------------- programmes
  r.get('/hr-growth/training/programmes', READ, async (c) => {
    const q = c.url.searchParams
    const rows = await c.db.prepare(`
      SELECT p.id, p.code, p.title, p.category, p.provider, p.provider_kind, p.mode, p.venue, SUBSTR(p.starts_on,1,10) AS starts_on,
             SUBSTR(p.ends_on,1,10) AS ends_on, p.hours, p.is_mandatory, p.counts_towards_requirement, p.cost_paise,
             count(t.id) AS nominated, count(CASE WHEN t.status = 'completed' THEN 1 END) AS completed, sum(${n('t.hours_completed')}) AS hours_logged
        FROM training_programmes p LEFT JOIN staff_training_records t ON t.programme_id = p.id
       WHERE (?1 IS NULL OR p.academic_year_id = ?1) AND (?2 IS NULL OR p.ends_on >= ?2) AND (?3 IS NULL OR p.starts_on <= ?3)
       GROUP BY p.id ORDER BY p.starts_on DESC LIMIT 300`)
      .bind(nullString(q.get('academic_year_id')), nullString(q.get('from')), nullString(q.get('to'))).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, hours: num0(v.hours), is_mandatory: bool(v.is_mandatory),
      counts_towards_requirement: bool(v.counts_towards_requirement), cost_paise: numOrNull(v.cost_paise), nominated: num0(v.nominated),
      completed: num0(v.completed), hours_logged: numOrNull(v.hours_logged) })) })
  })

  r.post('/hr-growth/training/programmes', WRITE, w(async (c) => {
    const req = await readJSON(c.req)
    const code = s(req.code).trim(), title = s(req.title).trim()
    if (code === '' || title === '') throw badRequest('code and title are required')
    const starts = s(req.starts_on)
    if (starts === '') throw badRequest('starts_on is required')
    const ends = s(req.ends_on) || starts
    const hours = typeof req.hours === 'number' ? req.hours : 0
    if (hours <= 0) throw badRequest('hours must be greater than zero')
    const counts = typeof req.counts_towards_requirement === 'boolean' ? req.counts_towards_requirement : true
    const vals = [nullString(req.category), nullString(req.provider), s(req.provider_kind) || 'internal', s(req.mode) || 'in_person', nullString(req.venue),
      nullString(req.academic_year_id), starts, ends, hours, req.is_mandatory === true ? 1 : 0, counts ? 1 : 0,
      typeof req.cost_paise === 'number' ? Math.trunc(req.cost_paise) : null]
    const inst = school(c).id, t = now()
    let id = s(req.id)
    const stmts: D1PreparedStatement[] = []
    if (id !== '') {
      stmts.push(c.db.prepare(`UPDATE training_programmes SET title = ?, category = ?, provider = ?, provider_kind = ?, mode = ?, venue = ?, academic_year_id = ?,
          starts_on = ?, ends_on = ?, hours = ?, is_mandatory = ?, counts_towards_requirement = ?, cost_paise = ?, updated_at = ? WHERE id = ?`)
        .bind(s(req.title), ...vals, t, id))
    } else {
      if (await c.db.prepare(`SELECT 1 FROM training_programmes WHERE institution_id = ? AND lower(code) = lower(?)`).bind(inst, code).first()) {
        throw coded(409, 'duplicate', 'that record already exists')
      }
      id = uuid()
      stmts.push(c.db.prepare(`INSERT INTO training_programmes (id, institution_id, code, title, category, provider, provider_kind, mode, venue, academic_year_id,
          starts_on, ends_on, hours, is_mandatory, counts_towards_requirement, cost_paise, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, inst, code, title, ...vals, c.id.userId, t, t))
    }
    for (const emp of strList(req.employee_ids)) {
      stmts.push(c.db.prepare(`INSERT INTO staff_training_records (id, institution_id, programme_id, employee_id, status, nominated_by, created_at, updated_at)
          SELECT ?, ?, ?, e.id, 'nominated', ?, ?, ? FROM employees e WHERE e.id = ?
          ON CONFLICT (programme_id, employee_id) DO NOTHING`).bind(uuid(), inst, id, c.id.userId, t, t, emp))
    }
    await run(c.db, stmts)
    return created({ id })
  }))

  // ---------------------------------------------------------------- records
  r.get('/hr-growth/training/records', READ, async (c) => {
    const re = await growthReach(c.db, c.id)
    const q = c.url.searchParams
    const f = employeeFilter(re, 'e')
    const prog = nullString(q.get('programme_id')), emp = nullString(q.get('employee_id'))
    const rows = await c.db.prepare(recordSelect + ` WHERE (? IS NULL OR t.programme_id = ?) AND (? IS NULL OR t.employee_id = ?) AND ${f.sql}
        ORDER BY p.starts_on DESC, e.employee_code LIMIT 500`).bind(prog, prog, emp, emp, ...f.args).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(recordRow) })
  })

  r.post('/hr-growth/training/records', WRITE, w(async (c) => {
    const req = await readJSON(c.req)
    const prog = s(req.programme_id), emps = strList(req.employee_ids)
    if (prog === '' || emps.length === 0) throw badRequest('programme_id and at least one employee_id are required')
    const status = s(req.status) || 'nominated'
    if (!['nominated', 'attended', 'completed', 'absent', 'withdrawn'].includes(status)) throw badRequest('unknown status')
    const inst = school(c).id, t = now()
    const hours = typeof req.hours_completed === 'number' ? req.hours_completed : null
    const stmts = emps.map((emp) => c.db.prepare(`
      INSERT INTO staff_training_records (id, institution_id, programme_id, employee_id, status, attended_on, hours_completed, score,
             certificate_file_id, certificate_no, certificate_issued_on, feedback, nominated_by, created_at, updated_at)
      SELECT ?1, ?2, p.id, e.id, ?4,
             CASE WHEN ?4 IN ('attended','completed') THEN COALESCE(?5, p.starts_on) END,
             CASE WHEN ?4 = 'completed' THEN COALESCE(?6, p.hours) ELSE ?6 END,
             ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13
        FROM training_programmes p, employees e
       WHERE p.id = ?3 AND e.id = ?14
      ON CONFLICT (programme_id, employee_id) DO UPDATE SET
             status = excluded.status,
             attended_on = COALESCE(excluded.attended_on, staff_training_records.attended_on),
             hours_completed = COALESCE(excluded.hours_completed, staff_training_records.hours_completed),
             score = COALESCE(excluded.score, staff_training_records.score),
             certificate_file_id = COALESCE(excluded.certificate_file_id, staff_training_records.certificate_file_id),
             certificate_no = COALESCE(excluded.certificate_no, staff_training_records.certificate_no),
             certificate_issued_on = COALESCE(excluded.certificate_issued_on, staff_training_records.certificate_issued_on),
             feedback = COALESCE(excluded.feedback, staff_training_records.feedback),
             updated_at = excluded.updated_at`)
      .bind(uuid(), inst, prog, status, nullString(req.attended_on), hours, typeof req.score === 'number' ? req.score : null,
        nullString(req.certificate_file_id), nullString(req.certificate_no), nullString(req.certificate_issued_on), nullString(req.feedback),
        c.id.userId, t, emp))
    await run(c.db, stmts)
    return ok({ saved: emps.length })
  }))

  // ---------------------------------------------------------------- requirements
  r.get('/hr-growth/training/requirements', READ, async (c) => {
    const inst = school(c).id, t = now()
    // Seeded on first read with the statutory default, as getLeavePolicy does.
    await c.db.prepare(`INSERT INTO training_requirements (id, institution_id, designation_category, required_hours, authority, note, created_at, updated_at)
        SELECT ?, ?, 'teaching', 50, 'CBSE', 'Annual in-service training hours expected of teaching staff.', ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM training_requirements WHERE institution_id = ?)`).bind(uuid(), inst, t, t, inst).run()
    const rows = await c.db.prepare(`
      SELECT q.id, y.name AS academic_year, g.name AS designation, q.designation_category, q.required_hours, q.authority, q.note
        FROM training_requirements q LEFT JOIN academic_years y ON y.id = q.academic_year_id LEFT JOIN designations g ON g.id = q.designation_id
       ORDER BY y.starts_on IS NULL, y.starts_on DESC, g.name IS NULL, g.name`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, required_hours: num0(v.required_hours) })) })
  })

  // Upsert on training_requirements_one_per_role (institution, year, designation, category).
  r.put('/hr-growth/training/requirements', WRITE, w(async (c) => {
    const req = await readJSON(c.req)
    const hours = typeof req.required_hours === 'number' ? req.required_hours : 0
    if (hours < 0) throw badRequest('required_hours cannot be negative')
    const inst = school(c).id, t = now()
    const year = nullString(req.academic_year_id), desig = nullString(req.designation_id), cat = nullString(req.designation_category)
    const cur = await c.db.prepare(`SELECT id FROM training_requirements WHERE institution_id = ? AND COALESCE(academic_year_id,'') = COALESCE(?,'')
        AND COALESCE(designation_id,'') = COALESCE(?,'') AND COALESCE(designation_category,'') = COALESCE(?,'')`).bind(inst, year, desig, cat).first<{ id: string }>()
    await run(c.db, [cur
      ? c.db.prepare(`UPDATE training_requirements SET required_hours = ?, authority = ?, note = ?, updated_at = ? WHERE id = ?`)
        .bind(hours, nullString(req.authority), nullString(req.note), t, cur.id)
      : c.db.prepare(`INSERT INTO training_requirements (id, institution_id, academic_year_id, designation_id, designation_category, required_hours, authority, note,
          created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(uuid(), inst, year, desig, cat, hours, nullString(req.authority), nullString(req.note), t, t)])
    return ok({ required_hours: hours })
  }))

  /* getTrainingCompliance: hours completed against hours required, per member
     of staff, most specific requirement first; furthest short first. */
  r.get('/hr-growth/training/compliance', READ, async (c) => {
    const re = await growthReach(c.db, c.id)
    const f = employeeFilter(re, 'e')
    const rows = await c.db.prepare(`
      WITH yr AS (
          SELECT id, starts_on, ends_on FROM academic_years WHERE id = ?1
          UNION ALL
          SELECT id, starts_on, ends_on FROM academic_years WHERE ?1 IS NULL AND is_current = 1
          LIMIT 1
      ), base AS (
          SELECT e.id, e.employee_code, ${empName('e')} AS full_name, g.name AS designation, d.name AS department,
                 (SELECT ${n('q.required_hours')} FROM training_requirements q
                   WHERE q.institution_id = e.institution_id
                     AND (q.academic_year_id IS NULL OR q.academic_year_id = (SELECT id FROM yr))
                     AND (q.designation_id IS NULL OR q.designation_id = e.designation_id)
                     AND (q.designation_category IS NULL OR q.designation_category = g.category)
                   ORDER BY (q.designation_id IS NOT NULL) DESC, (q.designation_category IS NOT NULL) DESC, (q.academic_year_id IS NOT NULL) DESC
                   LIMIT 1) AS req
            FROM employees e
            LEFT JOIN designations g ON g.id = e.designation_id
            LEFT JOIN departments  d ON d.id = e.department_id
           WHERE e.status = 'active' AND ${f.sql}
      )
      SELECT b.id AS employee_id, b.employee_code, b.full_name, b.designation, b.department, b.req,
             count(CASE WHEN t.status = 'completed' THEN t.id END) AS programmes_completed,
             COALESCE(sum(CASE WHEN t.status = 'completed' AND p.counts_towards_requirement = 1 THEN ${n('t.hours_completed')} END), 0) AS hours_completed,
             count(t.certificate_file_id) AS certificates_on_file
        FROM base b
        LEFT JOIN staff_training_records t ON t.employee_id = b.id
        LEFT JOIN training_programmes p ON p.id = t.programme_id
               AND (NOT EXISTS (SELECT 1 FROM yr) OR p.starts_on BETWEEN (SELECT starts_on FROM yr) AND (SELECT ends_on FROM yr))
       GROUP BY b.id`).bind(nullString(c.url.searchParams.get('academic_year_id')), ...f.args).all<Record<string, unknown>>()
    const items = rows.results.map((v) => {
      const done = num0(v.hours_completed), need = numOrNull(v.req)
      return { v, done, need }
    })
    items.sort((a, b) => ((b.need !== null ? 1 : 0) - (a.need !== null ? 1 : 0))
      || (((b.need ?? 0) - b.done) - ((a.need ?? 0) - a.done))
      || String(a.v.employee_code).localeCompare(String(b.v.employee_code)))
    return ok({ items: items.slice(0, 800).map(({ v, done, need }) => omitNull({
      employee_id: v.employee_id, employee_code: v.employee_code, full_name: v.full_name, designation: v.designation, department: v.department,
      programmes_completed: num0(v.programmes_completed), hours_completed: done, hours_required: need,
      shortfall: need === null ? null : Math.max(need - done, 0), compliant: need === null ? null : done >= need,
      certificates_on_file: num0(v.certificates_on_file),
    })) })
  })

  // ---------------------------------------------------------------- rostering
  r.get('/hr-growth/roster/shifts', READ, async (c) => {
    const inst = school(c).id
    const has = await c.db.prepare(`SELECT 1 FROM duty_shifts WHERE institution_id = ? LIMIT 1`).bind(inst).first()
    if (!has) {
      const t = now()
      await run(c.db, SEED_SHIFTS.map(([code, name, kind, from, to, onerous, heads]) => c.db.prepare(`INSERT INTO duty_shifts (id, institution_id, code, name, duty_kind,
          starts_at, ends_at, weekdays, is_onerous, headcount, created_at, updated_at) VALUES (?,?,?,?,?,?,?,'[1,2,3,4,5,6]',?,?,?,?)`)
        .bind(uuid(), inst, code, name, kind, from, to, onerous, heads, t, t)))
    }
    const rows = await c.db.prepare(`SELECT id, code, name, duty_kind, ${hhmm('starts_at')} AS starts_at, ${hhmm('ends_at')} AS ends_at, weekdays, headcount,
        is_onerous, location, is_active, notes FROM duty_shifts ORDER BY is_active DESC, time(starts_at), code`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, weekdays: pgArray(v.weekdays).map(Number), headcount: num0(v.headcount),
      is_onerous: bool(v.is_onerous), is_active: bool(v.is_active) })) })
  })

  r.put('/hr-growth/roster/shifts', WRITE, w(async (c) => {
    const req = await readJSON(c.req)
    const code = s(req.code).trim(), name = s(req.name).trim(), kind = s(req.duty_kind)
    if (code === '' || name === '' || kind === '' || s(req.starts_at) === '' || s(req.ends_at) === '') {
      throw badRequest('code, name, duty_kind, starts_at and ends_at are required')
    }
    let headcount = typeof req.headcount === 'number' ? Math.trunc(req.headcount) : 0
    if (headcount <= 0) headcount = 1
    let days = Array.isArray(req.weekdays) ? (req.weekdays as unknown[]).map(Number) : []
    if (days.length === 0) days = [1, 2, 3, 4, 5, 6]
    if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw badRequest('weekdays are 1 (Monday) to 7 (Sunday)')
    const from = clock(s(req.starts_at), 'starts_at'), to = clock(s(req.ends_at), 'ends_at')
    // The duty_shifts CHECK constraints, which D1 does not carry.
    if (!DUTY_KINDS.includes(kind)) throw coded(409, 'refused', 'new row for relation "duty_shifts" violates check constraint "duty_shifts_kind"')
    if (to <= from) throw coded(409, 'refused', 'new row for relation "duty_shifts" violates check constraint "duty_shifts_window"')
    if (headcount > 50) throw coded(409, 'refused', 'new row for relation "duty_shifts" violates check constraint "duty_shifts_headcount"')
    const active = typeof req.is_active === 'boolean' ? req.is_active : true
    const inst = school(c).id, t = now()
    const id = s(req.id)
    if (id !== '') {
      await run(c.db, [c.db.prepare(`UPDATE duty_shifts SET name = ?, duty_kind = ?, starts_at = ?, ends_at = ?, weekdays = ?, headcount = ?, is_onerous = ?,
          location = ?, is_active = ?, notes = ?, updated_at = ? WHERE id = ?`)
        .bind(s(req.name), kind, from, to, JSON.stringify(days), headcount, req.is_onerous === true ? 1 : 0, nullString(req.location), active ? 1 : 0,
          nullString(req.notes), t, id)])
      return created({ id })
    }
    if (await c.db.prepare(`SELECT 1 FROM duty_shifts WHERE institution_id = ? AND lower(code) = lower(?)`).bind(inst, code).first()) {
      throw coded(409, 'duplicate', 'that record already exists')
    }
    const out = uuid()
    await run(c.db, [c.db.prepare(`INSERT INTO duty_shifts (id, institution_id, campus_id, code, name, duty_kind, starts_at, ends_at, weekdays, headcount,
        is_onerous, location, is_active, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(out, inst, nullString(req.campus_id), code, name, kind, from, to, JSON.stringify(days), headcount, req.is_onerous === true ? 1 : 0,
        nullString(req.location), active ? 1 : 0, nullString(req.notes), t, t)])
    return created({ id: out })
  }))

  r.get('/hr-growth/roster/conflicts', READ, async (c) => {
    const [from, to] = growthRange(c)
    const rows = await c.db.prepare(`SELECT SUBSTR(x.on_date,1,10) AS on_date, u.full_name AS user, x.kind, x.detail
        FROM (${conflictsSQL}) x JOIN users u ON u.id = x.user_id ORDER BY x.on_date, u.full_name`).bind(from, to).all<Record<string, unknown>>()
    return ok({ items: rows.results })
  })

  // Who carries the unpopular duties: counts per person, and their onerous share against the average.
  r.get('/hr-growth/roster/fairness', READ, async (c) => {
    const [from, to] = growthRange(c)
    const rows = await c.db.prepare(`
      WITH counted AS (
          SELECT a.user_id, count(*) AS duties, count(CASE WHEN sh.is_onerous = 1 THEN 1 END) AS onerous,
                 sum((strftime('%s', '2000-01-01 ' || time(a.ends_at)) - strftime('%s', '2000-01-01 ' || time(a.starts_at))) / 3600.0) AS hours
            FROM duty_assignments a JOIN duty_shifts sh ON sh.id = a.shift_id
           WHERE a.on_date BETWEEN ?1 AND ?2 AND a.status <> 'cancelled'
           GROUP BY a.user_id
      )
      SELECT c.user_id, u.full_name, e.employee_code, d.name AS department, c.duties, c.onerous, c.hours
        FROM counted c JOIN users u ON u.id = c.user_id
        LEFT JOIN employees e ON e.user_id = c.user_id
        LEFT JOIN departments d ON d.id = e.department_id
       ORDER BY c.onerous DESC, c.duties DESC`).bind(from, to).all<Record<string, unknown>>()
    // avg(onerous) over the per-person rows (before the employee join fans out).
    const per = new Map<string, number>()
    for (const v of rows.results) per.set(String(v.user_id), num0(v.onerous))
    const avg = per.size ? [...per.values()].reduce((a, b) => a + b, 0) / per.size : 0
    return ok({ items: rows.results.map((v) => omitNull({ user_id: v.user_id, full_name: v.full_name, employee_code: v.employee_code,
      department: v.department, duties: num0(v.duties), onerous_duties: num0(v.onerous), hours: num0(v.hours),
      onerous_index: avg > 0 ? num0(v.onerous) / avg : null })) })
  })

  r.get('/hr-growth/roster', READ, async (c) => {
    const [from, to] = growthRange(c)
    const q = c.url.searchParams
    const shift = nullString(q.get('shift_id')), user = nullString(q.get('user_id'))
    const rows = await c.db.prepare(rosterSelect + ` WHERE a.on_date BETWEEN ? AND ? AND (? IS NULL OR a.shift_id = ?) AND (? IS NULL OR a.user_id = ?)
        AND a.status <> 'cancelled' ORDER BY a.on_date, time(a.starts_at), sh.code`).bind(from, to, shift, shift, user, user).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(rosterRow) })
  })

  /* assignDuty: one row per person per matching day. The duty_assignments_are_free
     trigger (no overlapping duty, not on approved leave) is re-implemented
     here and refuses the whole request; a teaching or unavailability clash is
     refused unless override_reason says why. */
  r.post('/hr-growth/roster', WRITE, w(async (c) => {
    const req = await readJSON(c.req)
    const shiftID = s(req.shift_id), users = strList(req.user_ids), fromDate = s(req.from_date)
    if (shiftID === '' || users.length === 0 || fromDate === '') throw badRequest('shift_id, user_ids and from_date are required')
    const toDate = s(req.to_date) || fromDate
    const re = /^\d{4}-\d{2}-\d{2}$/
    const fromMs = Date.parse(fromDate + 'T00:00:00Z'), toMs = Date.parse(toDate + 'T00:00:00Z')
    if (!re.test(fromDate) || !re.test(toDate) || Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs < fromMs) {
      throw badRequest('from_date and to_date must be YYYY-MM-DD, and to_date cannot precede from_date')
    }
    if (toMs - fromMs > 200 * 86400000) throw badRequest('a roster covers at most 200 days at a time')
    if (users.some((u) => !isUUID(u))) throw badRequest('one of the ids in this request does not exist')
    const shift = await c.db.prepare(`SELECT starts_at, ends_at, weekdays, campus_id FROM duty_shifts WHERE id = ? AND is_active = 1`).bind(shiftID)
      .first<{ starts_at: string; ends_at: string; weekdays: string; campus_id: string | null }>()
    if (!shift) throw badRequest('no active shift with that id')
    const starts = s(req.starts_at) !== '' ? clock(s(req.starts_at), 'starts_at') : clock(shift.starts_at, 'starts_at')
    const ends = s(req.ends_at) !== '' ? clock(s(req.ends_at), 'ends_at') : clock(shift.ends_at, 'ends_at')
    if (ends <= starts) throw coded(409, 'refused', 'new row for relation "duty_assignments" violates check constraint "duty_assignments_window"')
    const days = Array.isArray(req.weekdays) && req.weekdays.length ? (req.weekdays as unknown[]).map(Number) : pgArray(shift.weekdays).map(Number)
    const wanted = new Set(days)
    const override = nullString(req.override_reason), notes = nullString(req.notes)

    const [held, emps, leave] = await c.db.batch([
      c.db.prepare(`SELECT user_id, SUBSTR(on_date,1,10) AS on_date, time(starts_at) AS s, time(ends_at) AS e FROM duty_assignments
          WHERE user_id IN (SELECT value FROM json_each(?1)) AND on_date BETWEEN ?2 AND ?3 AND status <> 'cancelled'`).bind(JSON.stringify(users), fromDate, toDate),
      c.db.prepare(`SELECT user_id, id FROM employees WHERE user_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(users)),
      c.db.prepare(`SELECT e.user_id, l.from_date, l.to_date FROM leave_requests l JOIN employees e ON e.id = l.employee_id
          WHERE e.user_id IN (SELECT value FROM json_each(?1)) AND l.subject_kind = 'staff' AND l.status = 'approved'
            AND l.from_date <= ?3 AND l.to_date >= ?2`).bind(JSON.stringify(users), fromDate, toDate),
    ])
    const empOf = new Map<string, string>()
    for (const e of emps.results as { user_id: string; id: string }[]) if (!empOf.has(e.user_id)) empOf.set(e.user_id, e.id)
    const duties = held.results as { user_id: string; on_date: string; s: string; e: string }[]
    const leaves = leave.results as { user_id: string; from_date: string; to_date: string }[]

    const inst = school(c).id, t = now()
    const ids: string[] = []
    const stmts: D1PreparedStatement[] = []
    for (const u of users) {
      for (let ms = fromMs; ms <= toMs; ms += 86400000) {
        const day = new Date(ms)
        const iso = day.getUTCDay() === 0 ? 7 : day.getUTCDay()
        if (!wanted.has(iso)) continue
        const on = day.toISOString().slice(0, 10)
        if (duties.some((d) => d.user_id === u && d.on_date === on && d.s < ends && d.e > starts)) {
          throw coded(409, 'refused', `this person is already on duty at that time on ${on}`)
        }
        if (empOf.has(u) && leaves.some((l) => l.user_id === u && on >= l.from_date.slice(0, 10) && on <= l.to_date.slice(0, 10))) {
          throw coded(409, 'refused', `this person is on approved leave on ${on}`)
        }
        duties.push({ user_id: u, on_date: on, s: starts, e: ends })
        const id = uuid()
        ids.push(id)
        stmts.push(c.db.prepare(`INSERT INTO duty_assignments (id, institution_id, campus_id, shift_id, user_id, employee_id, on_date, starts_at, ends_at,
            status, override_reason, notes, assigned_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,'scheduled',?,?,?,?,?)`)
          .bind(id, inst, shift.campus_id, shiftID, u, empOf.get(u) ?? null, on, starts, ends, override, notes, c.id.userId, t, t))
      }
    }
    for (let i = 0; i < stmts.length; i += 400) await run(c.db, stmts.slice(i, i + 400))

    const [clashRows, untimed] = await c.db.batch([
      c.db.prepare(`SELECT SUBSTR(x.on_date,1,10) AS on_date, u.full_name AS user, x.kind, x.detail
          FROM (${conflictsSQL}) x JOIN users u ON u.id = x.user_id
         WHERE x.kind <> 'leave' AND x.user_id IN (SELECT value FROM json_each(?3)) ORDER BY x.on_date, u.full_name`).bind(fromDate, toDate, JSON.stringify(users)),
      c.db.prepare(`SELECT count(*) AS n FROM json_each(?) u WHERE NOT EXISTS (SELECT 1 FROM timetable_entries te WHERE te.teacher_user_id = u.value)`)
        .bind(JSON.stringify(users)),
    ])
    const clashes = clashRows.results as Record<string, unknown>[]
    if (clashes.length > 0 && s(req.override_reason).trim() === '') {
      // The Go handler rolls the whole batch back; here the rows just written are removed.
      for (let i = 0; i < ids.length; i += 90) {
        const part = ids.slice(i, i + 90)
        await c.db.prepare(`DELETE FROM duty_assignments WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(part)).run()
      }
      throw new HttpError(409, 'one or more of these duties falls in a period the person teaches or has declared unavailable; ' +
        'send override_reason to roster them anyway, or call /hr-growth/roster/conflicts to see which', { code: 'roster_clash', clashes })
    }
    return created({ assigned: ids.length, clashes, unchecked_no_timetable: num0((untimed.results[0] as { n: unknown })?.n) })
  }))

  r.post('/hr-growth/roster/{id}/cancel', WRITE, w(async (c) => {
    const duty = pathID(c)
    const req = await readJSON(c.req)
    const [res] = await run(c.db, [c.db.prepare(`UPDATE duty_assignments SET status = 'cancelled', notes = COALESCE(?, notes), updated_at = ?
        WHERE id = ? AND status <> 'cancelled'`).bind(nullString(req.reason), now(), duty)])
    if (changes(res) === 0) throw new Internal('no rows in result set')
    return ok({ id: duty, status: 'cancelled' })
  }))
}
