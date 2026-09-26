import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, conflict, created, forbidden, isUUID, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { has, instId } from './common'
import { isDate, nameSQL, ownStudentIds, resolveRange, today } from '../fees/common'

/* Port of the hostel routes: beds (internal/api/mod_ops.go) and the warden's
   day (internal/api/hostel_life.go): outpasses, complaints, the mess board.

   The outpass reads and consent are open to any signed-in user on purpose;
   the handlers narrow to the caller's own children (scope.StudentIDs) exactly
   as the Go ones did. Notifying a family of a pass was never a side effect of
   these handlers in Go, so nothing is stubbed. */

const HOSTEL_READ = 'operations.hostel.read'
const HOSTEL_WRITE = 'operations.hostel.write'

const optStr = (v: unknown): string | null => { const s = typeof v === 'string' ? v.trim() : ''; return s === '' ? null : s }
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A client timestamp (the Go handler cast it ::timestamptz) normalised to ISO UTC so string order is time order. */
function isoStamp(v: unknown, name: string): string {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  if (Number.isNaN(t)) throw badRequest(`${name} is not a timestamp`)
  return new Date(t).toISOString()
}
/** to_char(ts,'YYYY-MM-DD"T"HH24:MI') on a stored ISO string. */
const hm = (v: unknown): string | null => (typeof v === 'string' && v.length >= 16 ? v.slice(0, 16) : null)

/** The caller's own boundary: `all` for hostel staff, otherwise own record + linked children. */
async function scopeOf(c: Ctx, perm: string): Promise<{ all: boolean; studentIds: string[] }> {
  if (has(c, perm)) return { all: true, studentIds: [] }
  return { all: false, studentIds: await ownStudentIds(c) }
}

export function registerHostel(r: Router): void {
  /* --- beds ---------------------------------------------------------------- */

  r.get('/ops/hostel/occupancy', HOSTEL_READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT hr.id AS room_id, hb.name AS block, hr.room_no, hr.floor, hr.beds,
             (SELECT COUNT(*) FROM hostel_allocations ha WHERE ha.room_id = hr.id AND ha.vacated_on IS NULL) AS occupied,
             hb.gender
        FROM hostel_rooms hr JOIN hostel_blocks hb ON hb.id = hr.block_id
       ORDER BY hb.name, hr.room_no`).all<{ room_id: string; block: string; room_no: string; floor: number | null; beds: number; occupied: number; gender: string | null }>()
    return ok(rows.results.map((v) => ({
      room_id: v.room_id, block: v.block, room_no: v.room_no, floor: v.floor ?? undefined,
      beds: v.beds, occupied: v.occupied, free: v.beds - v.occupied, gender: v.gender ?? undefined,
    })))
  })

  r.get('/ops/hostel/rooms/{id}/boarders', HOSTEL_READ, async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid room id')
    const rows = await c.db.prepare(`
      SELECT ha.id AS allocation_id, st.id AS student_id,
             TRIM(st.first_name || COALESCE(' ' || st.last_name, '')) AS name, st.admission_no,
             ha.bed_no, substr(ha.allocated_on, 1, 10) AS allocated_on,
             COALESCE((SELECT k.name || '-' || sec.name FROM enrollments e
                         JOIN classes k ON k.id = e.class_id JOIN sections sec ON sec.id = e.section_id
                        WHERE e.student_id = st.id AND e.status = 'active' LIMIT 1), '') AS class_name
        FROM hostel_allocations ha JOIN students st ON st.id = ha.student_id
       WHERE ha.room_id = ? AND ha.vacated_on IS NULL
       ORDER BY ha.bed_no`).bind(c.params.id).all<{ allocation_id: string; student_id: string; name: string; admission_no: string; bed_no: number; allocated_on: string; class_name: string }>()
    return ok(rows.results.map((v) => ({ ...v, class_name: v.class_name || undefined })))
  })

  r.post('/ops/hostel/allocate', HOSTEL_WRITE, async (c) => {
    const req = await readJSON<{ room_id?: string; student_id?: string; bed_no?: number }>(c.req)
    const roomId = uuidParam(req.room_id, 'room_id')
    const studentId = uuidParam(req.student_id, 'student_id')
    let bedNo = Number(req.bed_no ?? 0)
    if (!Number.isInteger(bedNo) || bedNo <= 0) bedNo = 1
    const room = await c.db.prepare(`SELECT beds FROM hostel_rooms WHERE id = ?`).bind(roomId).first<{ beds: number }>()
    if (!room) throw notFound('room not found')
    if (bedNo > room.beds) throw new HttpError(500, `room has only ${room.beds} beds`)
    // Postgres had two partial unique indexes (one live allocation per bed and
    // per student); SQLite has neither here, so the insert carries the checks.
    const res = await c.db.prepare(`
      INSERT INTO hostel_allocations (id, institution_id, room_id, student_id, bed_no, allocated_on)
      SELECT ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM hostel_allocations WHERE room_id = ?3 AND bed_no = ?5 AND vacated_on IS NULL)
         AND NOT EXISTS (SELECT 1 FROM hostel_allocations WHERE student_id = ?4 AND vacated_on IS NULL)`)
      .bind(uuid(), instId(c), roomId, studentId, bedNo, today()).run()
    if (!res.meta.changes) {
      const bed = await c.db.prepare(`SELECT 1 AS x FROM hostel_allocations WHERE room_id = ? AND bed_no = ? AND vacated_on IS NULL`).bind(roomId, bedNo).first()
      if (bed) throw conflict('that bed is already allocated')
      throw conflict('that student already occupies a bed; vacate it first')
    }
    return created({ allocated: true })
  })

  /* --- outpasses ----------------------------------------------------------- */

  r.get('/ops/hostel/outpasses', 'auth', async (c) => {
    const scope = await scopeOf(c, HOSTEL_READ)
    const status = optStr(c.url.searchParams.get('status'))
    const args: unknown[] = [status, status]
    let mine = 'TRUE'
    if (!scope.all) {
      if (scope.studentIds.length === 0) return ok([])
      mine = `o.student_id IN (SELECT value FROM json_each(?))`
      args.push(JSON.stringify(scope.studentIds))
    }
    const at = now()
    const rows = await c.db.prepare(`
      SELECT o.id, ${nameSQL('st')} AS student_name, st.admission_no, hr.room_no AS room,
             o.reason, o.destination, o.escort_name, o.escort_phone, o.expected_out, o.expected_in,
             o.status, ua.full_name AS approved_by, ug.full_name AS consent_by,
             o.actual_out, o.actual_in, o.decision_note
        FROM hostel_outpasses o
        JOIN students st ON st.id = o.student_id
        LEFT JOIN hostel_allocations ha ON ha.student_id = o.student_id AND ha.vacated_on IS NULL
        LEFT JOIN hostel_rooms hr ON hr.id = ha.room_id
        LEFT JOIN users ua ON ua.id = o.approved_by
        LEFT JOIN users ug ON ug.id = o.guardian_consent_by
       WHERE (? IS NULL OR o.status = ?) AND ${mine}
       ORDER BY (o.status = 'out' AND o.expected_in < ?) DESC, (o.status = 'out') DESC, o.expected_out DESC
       LIMIT 200`).bind(...args, at).all<Record<string, string | null>>()
    const nowMs = Date.parse(at)
    return ok(rows.results.map((v) => {
      const inMs = Date.parse(v.expected_in ?? '')
      const late = Number.isNaN(inMs) ? 0 : Math.max(0, Math.floor((nowMs - inMs) / 60_000))
      return {
        id: v.id, student_name: v.student_name, admission_no: v.admission_no, room: v.room ?? undefined,
        reason: v.reason, destination: v.destination ?? undefined, escort_name: v.escort_name ?? undefined,
        escort_phone: v.escort_phone ?? undefined, expected_out: hm(v.expected_out) ?? '', expected_in: hm(v.expected_in) ?? '',
        status: v.status, approved_by: v.approved_by ?? undefined, guardian_consent_by: v.consent_by ?? undefined,
        actual_out: hm(v.actual_out) ?? undefined, actual_in: hm(v.actual_in) ?? undefined,
        decision_note: v.decision_note ?? undefined,
        overdue: v.status === 'out' && !Number.isNaN(inMs) && inMs < nowMs,
        overdue_minutes: late,
      }
    }))
  })

  r.post('/ops/hostel/outpasses', 'auth', async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    if (!optStr(req.reason)) throw badRequest('say why the boarder is leaving')
    if (!str(req.expected_out) || !str(req.expected_in)) throw badRequest('expected_out and expected_in are required')
    // Go's scope: students.read.all (or platform admin) means AllStudents.
    const all = has(c, 'students.read.all')
    const own = all ? [] : await ownStudentIds(c)
    let student = str(req.student_id)
    if (!isUUID(student)) {
      if (own.length === 0) throw badRequest('student_id must be a uuid')
      student = own[0]
    }
    if (!all && !own.includes(student) && !has(c, HOSTEL_WRITE)) throw notFound()
    const expectedOut = isoStamp(req.expected_out, 'expected_out')
    const expectedIn = isoStamp(req.expected_in, 'expected_in')
    const id = uuid(); const at = now()
    await c.db.prepare(`
      INSERT INTO hostel_outpasses (id, institution_id, student_id, requested_by, reason, destination, escort_name, escort_phone,
                                    expected_out, expected_in, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'requested',?,?)`)
      .bind(id, instId(c), student, c.id.userId, str(req.reason), optStr(req.destination), optStr(req.escort_name),
        optStr(req.escort_phone), expectedOut, expectedIn, at, at).run()
    return created({ id, status: 'requested' })
  })

  r.post('/ops/hostel/outpasses/{id}/decide', 'auth', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid outpass id')
    const passId = c.params.id
    const req = await readJSON<{ action?: string; note?: string }>(c.req)
    const action = str(req.action); const note = str(req.note)
    if (action === 'reject' && note.trim() === '') {
      throw badRequest('say why it is being refused. A rejection with no reason is an argument the warden has to have twice')
    }
    const staff = has(c, HOSTEL_WRITE)
    const own = has(c, 'students.read.all') ? [] : await ownStudentIds(c)
    switch (action) {
      case 'approve': case 'reject': case 'out': case 'in':
        if (!staff) throw forbidden("only the hostel can permit or record a boarder's movement")
        break
      case 'consent':
        if (own.length === 0 && !staff) throw forbidden('only a guardian can consent to their child leaving')
        break
      case 'cancel': break
      default: throw badRequest('action must be approve, reject, consent, out, in or cancel')
    }
    const pass = await c.db.prepare(`SELECT student_id, approved_at, guardian_consent_at FROM hostel_outpasses WHERE id = ?`)
      .bind(passId).first<{ student_id: string; approved_at: string | null; guardian_consent_at: string | null }>()
    if (!pass) throw notFound()
    if (action === 'consent' && own.length > 0 && !own.includes(pass.student_id)) throw notFound()
    if (action === 'out' && (!pass.approved_at || !pass.guardian_consent_at)) {
      throw conflict("the guardian has not consented yet; a warden's permission alone is not enough to let a boarder off campus")
    }
    const at = now(); const u = c.id.userId
    const sql: Record<string, string> = {
      approve: `UPDATE hostel_outpasses SET status='approved', approved_by=?2, approved_at=?4,
                  decision_note=COALESCE(NULLIF(?3,''), decision_note), updated_at=?4 WHERE id=?1`,
      reject: `UPDATE hostel_outpasses SET status='rejected', approved_by=?2, approved_at=?4,
                  decision_note=?3, updated_at=?4 WHERE id=?1`,
      consent: `UPDATE hostel_outpasses SET guardian_consent_by=?2, guardian_consent_at=?4,
                  decision_note=COALESCE(NULLIF(?3,''), decision_note), updated_at=?4 WHERE id=?1`,
      out: `UPDATE hostel_outpasses SET status='out', actual_out=?4, gate_by=?2,
                  gate_note=COALESCE(NULLIF(?3,''), gate_note), updated_at=?4 WHERE id=?1`,
      in: `UPDATE hostel_outpasses SET status='returned', actual_in=?4, gate_by=?2,
                  gate_note=COALESCE(NULLIF(?3,''), gate_note), updated_at=?4 WHERE id=?1`,
      cancel: `UPDATE hostel_outpasses SET status='cancelled', approved_by=?2,
                  decision_note=COALESCE(NULLIF(?3,''), decision_note), updated_at=?4 WHERE id=?1`,
    }
    const res = await c.db.prepare(sql[action]).bind(passId, u, note, at).run()
    if (!res.meta.changes) throw notFound()
    return ok({ id: passId, action })
  })

  /* --- complaints ---------------------------------------------------------- */

  r.get('/ops/hostel/complaints', HOSTEL_READ, async (c) => {
    const status = optStr(c.url.searchParams.get('status'))
    const rows = await c.db.prepare(`
      SELECT hc.id, CASE WHEN st.id IS NULL THEN NULL ELSE TRIM(st.first_name || COALESCE(' ' || st.last_name, '')) END AS student_name,
             hr.room_no AS room, hc.category, hc.subject, hc.detail, hc.priority, hc.status, hc.resolution, hc.created_at
        FROM hostel_complaints hc
        LEFT JOIN students st ON st.id = hc.student_id
        LEFT JOIN hostel_rooms hr ON hr.id = hc.room_id
       WHERE (? IS NULL OR hc.status = ?)
       ORDER BY CASE hc.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, hc.created_at
       LIMIT 200`).bind(status, status).all<Record<string, string | null>>()
    const nowMs = Date.now()
    return ok(rows.results.map((v) => {
      const cMs = Date.parse(v.created_at ?? '')
      return {
        id: v.id, student_name: v.student_name ?? undefined, room: v.room ?? undefined, category: v.category,
        subject: v.subject, detail: v.detail ?? undefined, priority: v.priority, status: v.status,
        resolution: v.resolution ?? undefined, created_at: (v.created_at ?? '').slice(0, 10),
        open_days: Number.isNaN(cMs) ? 0 : Math.max(0, Math.floor((nowMs - cMs) / 86_400_000)),
      }
    }))
  })

  r.post('/ops/hostel/complaints', 'auth', async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    if (!optStr(req.subject)) throw badRequest('the complaint needs a subject')
    const studentId = optStr(req.student_id); const roomId = optStr(req.room_id)
    if (studentId && !isUUID(studentId)) throw badRequest('student_id must be a uuid')
    if (roomId && !isUUID(roomId)) throw badRequest('room_id must be a uuid')
    const id = uuid(); const at = now()
    await c.db.prepare(`
      INSERT INTO hostel_complaints (id, institution_id, student_id, room_id, raised_by, category, subject, detail, priority, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'open',?,?)`)
      .bind(id, instId(c), studentId, roomId, c.id.userId, str(req.category) || 'other', str(req.subject),
        optStr(req.detail), str(req.priority) || 'normal', at, at).run()
    return created({ id, status: 'open' })
  })

  r.post('/ops/hostel/complaints/{id}/resolve', HOSTEL_WRITE, async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid complaint id')
    const req = await readJSON<{ status?: string; resolution?: string }>(c.req)
    const status = str(req.status) || 'resolved'
    const resolution = str(req.resolution)
    if ((status === 'resolved' || status === 'closed') && resolution.trim() === '') {
      throw badRequest('say what was done. A complaint closed silently is one raised again next week')
    }
    const at = now()
    const res = await c.db.prepare(`
      UPDATE hostel_complaints SET status = ?2, resolution = NULLIF(?3,''),
             resolved_at = CASE WHEN ?2 IN ('resolved','closed') THEN ?4 END, updated_at = ?4
       WHERE id = ?1`).bind(c.params.id, status, resolution, at).run()
    if (!res.meta.changes) throw notFound()
    return ok({ id: c.params.id, status })
  })

  /* --- mess ---------------------------------------------------------------- */

  r.get('/ops/hostel/mess', 'auth', async (c) => {
    const rng = resolveRange(c)
    const rows = await c.db.prepare(`
      SELECT id, substr(on_date, 1, 10) AS on_date, meal, items, served_count, notes
        FROM mess_menus WHERE on_date BETWEEN ? AND ?
       ORDER BY on_date, CASE meal WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 WHEN 'snacks' THEN 2 ELSE 3 END`)
      .bind(rng.from, rng.to).all<{ id: string; on_date: string; meal: string; items: string; served_count: number | null; notes: string | null }>()
    return ok(rows.results.map((v) => ({
      id: v.id, on_date: v.on_date, meal: v.meal, items: v.items,
      served_count: v.served_count ?? undefined, notes: v.notes ?? undefined,
    })))
  })

  const MEALS = ['breakfast', 'lunch', 'snacks', 'dinner']
  r.put('/ops/hostel/mess', HOSTEL_WRITE, async (c) => {
    const req = await readJSON<{ on_date?: string; meals?: { meal?: string; items?: string; served_count?: number | null; notes?: string }[] }>(c.req)
    const onDate = str(req.on_date)
    if (!onDate) throw badRequest('on_date is required')
    if (!isDate(onDate)) throw badRequest('on_date is not a date')
    const meals = Array.isArray(req.meals) ? req.meals : []
    for (const m of meals) if (!MEALS.includes(str(m.meal))) throw badRequest('unknown meal ' + str(m.meal))
    const inst = instId(c); const at = now()
    const stmts = meals.map((m) => {
      const meal = str(m.meal)
      // An emptied box means the meal is not served: the row goes, not an empty menu.
      if (str(m.items).trim() === '') {
        return c.db.prepare(`DELETE FROM mess_menus WHERE institution_id = ? AND on_date = ? AND meal = ?`).bind(inst, onDate, meal)
      }
      const served = typeof m.served_count === 'number' && Number.isInteger(m.served_count) ? m.served_count : null
      return c.db.prepare(`
        INSERT INTO mess_menus (id, institution_id, on_date, meal, items, served_count, notes, created_at)
        VALUES (?,?,?,?,?,?,NULLIF(?,''),?)
        ON CONFLICT (institution_id, on_date, meal)
        DO UPDATE SET items = excluded.items, served_count = excluded.served_count, notes = excluded.notes`)
        .bind(uuid(), inst, onDate, meal, str(m.items), served, str(m.notes), at)
    })
    if (stmts.length) await c.db.batch(stmts)
    return ok({ on_date: onDate, meals: meals.length })
  })
}
