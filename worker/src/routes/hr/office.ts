import type { Router } from '../../router'
import { HttpError, badRequest, bool, created, now, ok, readJSON, uuid } from '../../http'
import { addDays, fullName, isUUIDish, isUniqueViolation, istMinuteT, nz, resolveRange, str, todayIST } from '../admissions/util'
import { school } from '../school'

/* Port of front_office.go and front_desk_directory.go: who came in, who
   rang, what arrived in the post, who is booked to see the principal, and
   the host list the desk points at. */

const READ = 'office.front_desk.read', WRITE = 'office.front_desk.write'
const omitNull = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}
const bad = (e: unknown): never => { if (e instanceof HttpError) throw e; throw badRequest(e instanceof Error ? e.message : String(e)) }
const optUUID = (v: unknown, name: string) => { const s = nz(v); if (s !== null && !isUUIDish(s)) throw badRequest(`${name} must be a uuid`); return s }

export function registerOffice(r: Router) {
  r.get('/office/visitors', READ, async (c) => {
    const q = c.url.searchParams
    const onDate = nz(q.get('on_date')) ?? todayIST()
    const rows = await c.db.prepare(`
      SELECT v.id, v.pass_no, v.full_name, v.phone, v.id_type, v.id_last4, v.purpose,
             NULLIF(${fullName('e.first_name', 'e.last_name')}, '') AS host, NULLIF(${fullName('st.first_name', 'st.last_name')}, '') AS student, v.vehicle_no,
             ${istMinuteT('v.in_at')} AS in_at, ${istMinuteT('v.out_at')} AS out_at, u.full_name AS issued_by,
             CAST((julianday(COALESCE(v.out_at, ?)) - julianday(v.in_at)) * 1440 AS INTEGER) AS minutes_on_site, (v.out_at IS NULL) AS inside
        FROM visitors v LEFT JOIN employees e ON e.id = v.host_employee_id LEFT JOIN students st ON st.id = v.student_id LEFT JOIN users u ON u.id = v.issued_by
       WHERE v.on_date = ? AND (? IS NOT 1 OR v.out_at IS NULL)
       ORDER BY (v.out_at IS NULL) DESC, v.in_at LIMIT 300`).bind(now(), onDate, q.get('inside') === 'true' ? 1 : 0).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, inside: bool(v.inside) })) })
  })

  r.post('/office/visitors', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const name = str(req.full_name), purpose = str(req.purpose), phone = str(req.phone)
    if (name.trim() === '' || purpose.trim() === '') throw badRequest('a pass needs a name and why they are here')
    const today = todayIST(), inst = school(c).id
    const block = await c.db.prepare(`SELECT COALESCE(max(reason), '') AS reason FROM visitor_blocklist WHERE lower(full_name) = lower(?) AND (phone IS NULL OR ? = '' OR phone = ?)
        AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)`).bind(name, phone, phone, today, today).first<{ reason: string }>()
    if (block && block.reason !== '') throw new HttpError(409, 'this person is on the block list: ' + block.reason, { code: 'blocked' })
    const host = optUUID(req.host_employee_id, 'host_employee_id'), student = optUUID(req.student_id, 'student_id')
    // The day's next pass number, from the numeric passes issued today.
    const last = await c.db.prepare(`SELECT COALESCE(max(CAST(pass_no AS INTEGER)), 0) AS n FROM visitors WHERE institution_id = ? AND on_date = ? AND pass_no GLOB '[0-9]*' AND pass_no NOT GLOB '*[^0-9]*'`)
      .bind(inst, today).first<{ n: number }>()
    const pass = String((last?.n ?? 0) + 1).padStart(3, '0')
    const id = uuid()
    try {
      await c.db.prepare(`INSERT INTO visitors (id, institution_id, pass_no, full_name, phone, id_type, id_last4, purpose, host_employee_id, student_id, vehicle_no, remarks, issued_by, on_date, in_at)
        VALUES (?,?,?,?,NULLIF(?,''),NULLIF(?,''),NULLIF(?,''),?,?,?,NULLIF(?,''),NULLIF(?,''),?,?,?)`)
        .bind(id, inst, pass, name, phone, str(req.id_type), str(req.id_last4), purpose, host, student, str(req.vehicle_no), str(req.remarks), c.id.userId, today, now()).run()
    } catch (e) { bad(e) }
    return created({ id, pass_no: pass })
  })

  r.post('/office/visitors/{id}/out', WRITE, async (c) => {
    if (!isUUIDish(c.params.id)) throw badRequest('invalid visitor id')
    const t = now()
    const row = await c.db.prepare(`UPDATE visitors SET out_at = ?, closed_by = ? WHERE id = ? AND out_at IS NULL RETURNING CAST((julianday(?) - julianday(in_at)) * 1440 AS INTEGER) AS minutes`)
      .bind(t, c.id.userId, c.params.id, t).first<{ minutes: number }>()
    if (!row) throw new HttpError(409, 'that pass has already been closed', { code: 'already_out' })
    return ok({ minutes_on_site: row.minutes })
  })

  r.get('/office/blocklist', READ, async (c) => {
    const today = todayIST()
    const rows = await c.db.prepare(`
      SELECT b.id, b.full_name, b.phone, b.reason, b.effective_from, b.effective_to, u.full_name AS added_by,
             (b.effective_from <= ? AND (b.effective_to IS NULL OR b.effective_to >= ?)) AS in_force
        FROM visitor_blocklist b LEFT JOIN users u ON u.id = b.added_by ORDER BY b.created_at DESC LIMIT 200`).bind(today, today).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, in_force: bool(v.in_force) })) })
  })

  r.post('/office/blocklist', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const name = str(req.full_name), reason = str(req.reason)
    if (name.trim() === '' || reason.trim() === '') throw badRequest('a block needs a name and a reason. A list nobody can defend is worse than none')
    const id = uuid()
    try {
      await c.db.prepare(`INSERT INTO visitor_blocklist (id, institution_id, full_name, phone, id_last4, reason, effective_from, effective_to, added_by, created_at) VALUES (?,?,?,NULLIF(?,''),NULLIF(?,''),?,COALESCE(NULLIF(?,''), ?),NULLIF(?,''),?,?)`)
        .bind(id, school(c).id, name, str(req.phone), str(req.id_last4), reason, str(req.effective_from), todayIST(), str(req.effective_to), c.id.userId, now()).run()
    } catch (e) { bad(e) }
    return created({ id })
  })

  r.get('/office/staff', READ, async (c) => {
    const rows = await c.db.prepare(`SELECT u.id, u.full_name, e.employee_code, dg.name AS designation FROM employees e JOIN users u ON u.id = e.user_id LEFT JOIN designations dg ON dg.id = e.designation_id
        WHERE e.status IN ('active','on_leave') ORDER BY u.full_name`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(omitNull) })
  })

  r.get('/office/appointments', READ, async (c) => {
    const q = c.url.searchParams
    let rng = resolveRange(q)
    if (!q.get('period') && !q.get('from') && !q.get('to')) {
      const today = todayIST()
      rng = { from: today, to: addDays(today, 30), label: 'Next 30 days', period: rng.period }
    }
    const rows = await c.db.prepare(`
      SELECT a.id, NULLIF(${fullName('e.first_name', 'e.last_name')}, '') AS "with", NULLIF(${fullName('st.first_name', 'st.last_name')}, '') AS student,
             a.visitor_name, a.phone, a.on_date, substr(a.starts_at, 1, 5) AS starts_at, a.minutes, a.purpose, a.status, a.outcome
        FROM appointments a LEFT JOIN employees e ON e.id = a.with_employee_id LEFT JOIN students st ON st.id = a.student_id
       WHERE a.on_date BETWEEN ? AND ? ORDER BY a.on_date, a.starts_at LIMIT 300`).bind(rng.from, rng.to).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(omitNull) })
  })

  r.post('/office/appointments', WRITE, async (c) => {
    const req = await readJSON(c.req)
    if (str(req.id) !== '') {
      if (str(req.status) === 'met' && str(req.outcome).trim() === '') throw badRequest('say what was agreed. A meeting recorded with nothing said is a record that somebody clicked a button')
      if (!isUUIDish(str(req.id))) throw badRequest('id must be a uuid')
      try { await c.db.prepare(`UPDATE appointments SET status = COALESCE(NULLIF(?,''), status), outcome = COALESCE(NULLIF(?,''), outcome) WHERE id = ?`).bind(str(req.status), str(req.outcome), str(req.id)).run() } catch (e) { bad(e) }
      return ok({ id: str(req.id) })
    }
    const visitor = str(req.visitor_name), onDate = str(req.on_date), startsAt = str(req.starts_at)
    if (visitor.trim() === '' || onDate === '' || startsAt === '') throw badRequest('a booking needs a name, a date and a time')
    if (str(req.purpose).trim() === '') throw badRequest('say what the meeting is about')
    let minutes = typeof req.minutes === 'number' ? req.minutes : 0
    if (minutes === 0) minutes = 15
    const withID = optUUID(req.with_employee_id, 'with_employee_id'), student = optUUID(req.student_id, 'student_id')
    if (withID) {
      const clash = await c.db.prepare(`SELECT 1 FROM appointments WHERE with_employee_id = ? AND on_date = ? AND starts_at = ? AND status <> 'cancelled'`).bind(withID, onDate, startsAt).first()
      if (clash) throw new HttpError(409, 'that person is already booked at that time', { code: 'slot_taken' })
    }
    const id = uuid()
    try {
      await c.db.prepare(`INSERT INTO appointments (id, institution_id, with_employee_id, student_id, requested_by, visitor_name, phone, on_date, starts_at, minutes, purpose, created_at) VALUES (?,?,?,?,?,?,NULLIF(?,''),?,?,?,?,?)`)
        .bind(id, school(c).id, withID, student, c.id.userId, visitor, str(req.phone), onDate, startsAt, minutes, str(req.purpose), now()).run()
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'that person is already booked at that time', { code: 'slot_taken' })
      bad(e)
    }
    return created({ id })
  })

  r.get('/office/calls', READ, async (c) => {
    const rng = resolveRange(c.url.searchParams)
    const rows = await c.db.prepare(`
      SELECT c.id, c.direction, c.caller_name, c.phone, NULLIF(${fullName('st.first_name', 'st.last_name')}, '') AS student, c.about,
             NULLIF(${fullName('e.first_name', 'e.last_name')}, '') AS "for", ${istMinuteT('c.passed_on_at')} AS passed_on_at, c.action_taken, u.full_name AS taken_by,
             ${istMinuteT('c.at_time')} AS at_time, (c.for_employee_id IS NOT NULL AND c.passed_on_at IS NULL) AS pending
        FROM call_log c LEFT JOIN students st ON st.id = c.student_id LEFT JOIN employees e ON e.id = c.for_employee_id LEFT JOIN users u ON u.id = c.taken_by
       WHERE date(c.at_time, '+330 minutes') BETWEEN ? AND ?
       ORDER BY (c.for_employee_id IS NOT NULL AND c.passed_on_at IS NULL) DESC, c.at_time DESC LIMIT 300`).bind(rng.from, rng.to).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, pending: bool(v.pending) })) })
  })

  r.post('/office/calls', WRITE, async (c) => {
    const req = await readJSON(c.req)
    if (str(req.id) !== '') {
      if (!isUUIDish(str(req.id))) throw badRequest('id must be a uuid')
      try {
        await c.db.prepare(`UPDATE call_log SET passed_on_at = CASE WHEN ? THEN ? ELSE passed_on_at END, action_taken = COALESCE(NULLIF(?,''), action_taken) WHERE id = ?`)
          .bind(req.passed_on ? 1 : 0, now(), str(req.action_taken), str(req.id)).run()
      } catch (e) { bad(e) }
      return ok({ id: str(req.id) })
    }
    const caller = str(req.caller_name), about = str(req.about)
    if (caller.trim() === '' || about.trim() === '') throw badRequest('log who rang and what about')
    let direction = str(req.direction)
    if (direction === '') direction = 'in'
    const id = uuid()
    try {
      await c.db.prepare(`INSERT INTO call_log (id, institution_id, direction, caller_name, phone, student_id, about, for_employee_id, action_taken, taken_by, at_time) VALUES (?,?,?,?,NULLIF(?,''),?,?,?,NULLIF(?,''),?,?)`)
        .bind(id, school(c).id, direction, caller, str(req.phone), optUUID(req.student_id, 'student_id'), about, optUUID(req.for_employee_id, 'for_employee_id'), str(req.action_taken), c.id.userId, now()).run()
    } catch (e) { bad(e) }
    return created({ id })
  })

  r.get('/office/courier', READ, async (c) => {
    const rng = resolveRange(c.url.searchParams)
    const rows = await c.db.prepare(`
      SELECT id, direction, on_date, courier, tracking_no, from_party, to_party, description, received_by, ${istMinuteT('handed_over_at')} AS handed_over_at, charges_paise,
             (direction = 'in' AND handed_over_at IS NULL) AS undelivered
        FROM courier_log WHERE on_date BETWEEN ? AND ? ORDER BY (direction = 'in' AND handed_over_at IS NULL) DESC, on_date DESC LIMIT 300`).bind(rng.from, rng.to).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ ...v, undelivered: bool(v.undelivered) })) })
  })

  r.post('/office/courier', WRITE, async (c) => {
    const req = await readJSON(c.req)
    if (str(req.id) !== '') {
      if (req.hand_over === true && str(req.received_by).trim() === '') throw badRequest('say who took it. An envelope signed for by nobody is the one that goes missing')
      if (!isUUIDish(str(req.id))) throw badRequest('id must be a uuid')
      try {
        await c.db.prepare(`UPDATE courier_log SET handed_over_at = CASE WHEN ? THEN ? ELSE handed_over_at END, received_by = COALESCE(NULLIF(?,''), received_by) WHERE id = ?`)
          .bind(req.hand_over ? 1 : 0, now(), str(req.received_by), str(req.id)).run()
      } catch (e) { bad(e) }
      return ok({ id: str(req.id) })
    }
    const description = str(req.description)
    if (description.trim() === '') throw badRequest('say what it is')
    let direction = str(req.direction)
    if (direction === '') direction = 'in'
    const id = uuid()
    try {
      await c.db.prepare(`INSERT INTO courier_log (id, institution_id, direction, on_date, courier, tracking_no, from_party, to_party, description, charges_paise, recorded_by, created_at)
        VALUES (?,?,?,COALESCE(NULLIF(?,''), ?),NULLIF(?,''),NULLIF(?,''),NULLIF(?,''),NULLIF(?,''),?,?,?,?)`)
        .bind(id, school(c).id, direction, str(req.on_date), todayIST(), str(req.courier), str(req.tracking_no), str(req.from_party), str(req.to_party), description,
          typeof req.charges_paise === 'number' ? req.charges_paise : null, c.id.userId, now()).run()
    } catch (e) { bad(e) }
    return created({ id })
  })
}
