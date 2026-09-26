import type { Router, Ctx } from '../../router'
import { badRequest, notFound, now, ok, readJSON, uuid, bool } from '../../http'
import { institutionId, requirePerm, resolveScope } from '../teaching/common'
import { bodyUUID, bodyUUIDPtr, firstLast, isDate, isoZ, omitNull, optBool, optInt, optStr, queryUUID, trim, ymdOf } from './common'
import { denied, inJSON, pathUUID, reachesSection } from './classroom_common'

/* Port of classroom.go part 4: the offline register replay, its conflicts,
   and the class diary it shares with the online screen.

   Two Postgres unique indexes had no D1 counterpart and are enforced here
   with NOT EXISTS: class_diary_entries_no_duplicates (section, day, kind,
   subject, md5(trim(body))) and the ON CONFLICT DO NOTHING targets of the
   capture batch, the conflict row and the daily register row. */

const OPEN = 'academics.timetable.read'
const MARK_STATUSES = new Set(['present', 'absent', 'late', 'half_day', 'leave', 'holiday'])
const DIARY_KINDS = new Set(['note', 'classwork', 'homework', 'reminder'])
const NIL = '00000000-0000-0000-0000-000000000000'

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i

interface Mark { student_id: string; status: string; minutes_late: number | null; remarks: string | null }
interface DiaryLine { class_subject_id: string | null; kind: string; body: string; visible: boolean }

/** The diary insert, skipped when the same line is already there (the dropped unique index). */
function diaryInsert(c: Ctx, section: string, subject: string | null, onDate: string, kind: string, body: string,
  visible: boolean, offline: { at: string; batch: string } | null, id = uuid()): D1PreparedStatement {
  const t = now()
  return c.db.prepare(`INSERT INTO class_diary_entries (id, institution_id, section_id, class_subject_id, on_date, kind, body,
        captured_offline, captured_at, capture_batch_id, is_visible_to_family, written_by, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM class_diary_entries d WHERE d.section_id = ? AND d.on_date = ? AND d.kind = ?
               AND COALESCE(d.class_subject_id, '${NIL}') = COALESCE(?, '${NIL}') AND trim(d.body) = trim(?))`)
    .bind(id, institutionId(c), section, subject, onDate, kind, body, offline ? 1 : 0, offline?.at ?? null, offline?.batch ?? null,
      visible ? 1 : 0, c.id.userId, t, t, section, onDate, kind, subject, body)
}

const conflictColumns = `c.id, st.id AS student_id, ${firstLast('st')} AS student_name, st.admission_no,
  ${ymdOf('c.on_date')} AS on_date, c.offline_status, c.server_status, u.full_name AS server_marked_by,
  ${isoZ('c.server_marked_at')} AS server_marked_at, c.resolution`

async function syncCapturedRegister(c: Ctx): Promise<Response> {
  requirePerm(c, 'academics.attendance.write')
  const req = await readJSON<Record<string, unknown>>(c.req)
  const sectionId = bodyUUID(req.section_id)
  const marksIn = Array.isArray(req.marks) ? (req.marks as Record<string, unknown>[]) : []
  const diaryIn = Array.isArray(req.diary) ? (req.diary as Record<string, unknown>[]) : []
  const marks: Mark[] = marksIn.map((m) => ({ student_id: bodyUUID(m?.student_id), status: typeof m?.status === 'string' ? m.status : '',
    minutes_late: optInt(m?.minutes_late), remarks: optStr(m?.remarks) }))
  const diary: DiaryLine[] = diaryIn.map((d) => ({ class_subject_id: bodyUUIDPtr(d?.class_subject_id), kind: typeof d?.kind === 'string' ? d.kind : '',
    body: typeof d?.body === 'string' ? d.body : '', visible: optBool(d?.is_visible_to_family) ?? true }))
  if (sectionId === '') throw badRequest('a capture needs a section')
  const ref = trim(req.client_batch_ref)
  if (ref === '') throw badRequest('client_batch_ref is required. It is what makes a replay safe')
  const onDate = trim(req.on_date)
  if (!isDate(onDate)) throw badRequest('on_date must be YYYY-MM-DD')
  let capturedAt = now()
  const ca = trim(req.captured_at)
  if (ca !== '') {
    const d = new Date(ca)
    if (!RFC3339.test(ca) || Number.isNaN(d.getTime())) throw badRequest('captured_at must be an RFC3339 timestamp')
    capturedAt = d.toISOString()
  }
  for (const m of marks) if (!MARK_STATUSES.has(m.status)) throw badRequest('unknown attendance status: ' + m.status)
  for (const d of diary) {
    if (d.kind !== '' && !DIARY_KINDS.has(d.kind)) throw badRequest('unknown diary kind: ' + d.kind)
    if (d.body.trim() === '') throw badRequest('a diary line needs text')
  }

  const s = await resolveScope(c)
  if (!s.anySection && !reachesSection(s, sectionId)) throw denied()

  const inst = institutionId(c)
  const out = { batch_id: '', replayed: false, accepted: 0, conflicted: 0, diary_lines: 0, conflicts: [] as Record<string, unknown>[] }
  const prior = await c.db.prepare(`SELECT id, rows_accepted, rows_conflicted FROM attendance_capture_batches WHERE client_batch_ref = ?`)
    .bind(ref).first<{ id: string; rows_accepted: number; rows_conflicted: number }>()
  if (prior) {
    // A replay: the stored outcome, nothing applied again.
    out.batch_id = prior.id; out.replayed = true
    out.accepted = Number(prior.rows_accepted); out.conflicted = Number(prior.rows_conflicted)
  } else {
    const batchId = uuid()
    out.batch_id = batchId
    const t = now()
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`INSERT INTO attendance_capture_batches (id, institution_id, section_id, on_date, client_batch_ref, captured_at, synced_at,
            device_note, submitted_by, rows_accepted, rows_conflicted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`)
        .bind(batchId, inst, sectionId, onDate, ref, capturedAt, t, optStr(req.device_note), c.id.userId),
    ]
    // Rows this batch has written, so a second mark for the same child in the
    // same request updates its own row as Go's sequential transaction did.
    const ours = new Set<string>()
    const conflictedOnce = new Set<string>()
    for (const m of marks) {
      const enrolled = await c.db.prepare(`SELECT 1 AS x FROM enrollments e WHERE e.student_id = ? AND e.status = 'active' AND e.section_id = ? LIMIT 1`)
        .bind(m.student_id, sectionId).first()
      if (!enrolled) continue
      if (ours.has(m.student_id)) {
        stmts.push(c.db.prepare(`UPDATE student_attendance SET status = ?, minutes_late = ?, remarks = ?, captured_at = ?, marked_at = ?
            WHERE student_id = ? AND on_date = ? AND period_id IS NULL AND capture_batch_id = ?`)
          .bind(m.status, m.minutes_late, m.remarks, capturedAt, now(), m.student_id, onDate, batchId))
        out.accepted++
        continue
      }
      const ex = await c.db.prepare(`SELECT id, status, capture_batch_id, marked_by, marked_at FROM student_attendance
          WHERE student_id = ? AND on_date = ? AND period_id IS NULL`).bind(m.student_id, onDate)
        .first<{ id: string; status: string; capture_batch_id: string | null; marked_by: string | null; marked_at: string }>()
      if (!ex) {
        stmts.push(c.db.prepare(`INSERT INTO student_attendance (id, institution_id, student_id, section_id, on_date, status, minutes_late, remarks,
              marked_by, marked_at, captured_offline, captured_at, capture_batch_id)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM student_attendance WHERE student_id = ? AND on_date = ? AND period_id IS NULL)`)
          .bind(uuid(), inst, m.student_id, sectionId, onDate, m.status, m.minutes_late, m.remarks, c.id.userId, now(), capturedAt, batchId,
            m.student_id, onDate))
        ours.add(m.student_id)
        out.accepted++
        continue
      }
      // Somebody else's row: kept, and the disagreement handed back.
      if (!conflictedOnce.has(m.student_id)) {
        stmts.push(c.db.prepare(`INSERT INTO attendance_capture_conflicts (id, institution_id, batch_id, student_id, on_date, offline_status,
              offline_remarks, server_status, server_marked_by, server_marked_at, resolution, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
          .bind(uuid(), inst, batchId, m.student_id, onDate, m.status, m.remarks, ex.status, ex.marked_by, ex.marked_at, now()))
        conflictedOnce.add(m.student_id)
      }
      out.conflicted++
    }
    const diaryAt = stmts.length
    for (const d of diary) {
      stmts.push(diaryInsert(c, sectionId, d.class_subject_id, onDate, d.kind === '' ? 'note' : d.kind, d.body.trim(), d.visible,
        { at: capturedAt, batch: batchId }))
    }
    stmts.push(c.db.prepare(`UPDATE attendance_capture_batches SET rows_accepted = ?, rows_conflicted = ? WHERE id = ?`)
      .bind(out.accepted, out.conflicted, batchId))
    const res = await c.db.batch(stmts)
    for (let i = diaryAt; i < diaryAt + diary.length; i++) out.diary_lines += res[i].meta.changes ?? 0
  }
  const rows = await c.db.prepare(`SELECT ${conflictColumns}
      FROM attendance_capture_conflicts c
      JOIN students st ON st.id = c.student_id
      LEFT JOIN users u ON u.id = c.server_marked_by
      WHERE c.batch_id = ? ORDER BY st.admission_no`).bind(out.batch_id).all<Record<string, unknown>>()
  out.conflicts = rows.results.map((v) => omitNull({ ...v }))
  return ok(out)
}

async function listCaptureBatches(c: Ctx): Promise<Response> {
  const s = await resolveScope(c)
  let where = '1'
  const args: unknown[] = []
  if (!(s.allAttendance || s.anySection)) {
    if (!s.sectionIds.length) return ok({ items: [] })
    const q = inJSON('b.section_id', s.sectionIds)
    where = q.sql; args.push(q.arg)
  }
  const rows = await c.db.prepare(`SELECT b.id, b.section_id, COALESCE(sec.name, '-') AS section_name, ${ymdOf('b.on_date')} AS on_date,
        ${isoZ('b.captured_at')} AS captured_at, ${isoZ('b.synced_at')} AS synced_at, b.device_note,
        b.rows_accepted, b.rows_conflicted
      FROM attendance_capture_batches b LEFT JOIN sections sec ON sec.id = b.section_id
      WHERE ${where} ORDER BY b.synced_at DESC LIMIT 200`).bind(...args).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({ ...v, rows_accepted: Number(v.rows_accepted ?? 0), rows_conflicted: Number(v.rows_conflicted ?? 0) })) })
}

async function listCaptureConflicts(c: Ctx): Promise<Response> {
  const openOnly = c.url.searchParams.get('resolution') !== 'all'
  const s = await resolveScope(c)
  const where = ['1']
  const args: unknown[] = []
  if (openOnly) where.push(`c.resolution = 'pending'`)
  if (!(s.allAttendance || s.anySection)) {
    if (!s.sectionIds.length) return ok({ items: [] })
    const q = inJSON('b.section_id', s.sectionIds)
    where.push(q.sql); args.push(q.arg)
  }
  const rows = await c.db.prepare(`SELECT ${conflictColumns}
      FROM attendance_capture_conflicts c
      JOIN attendance_capture_batches b ON b.id = c.batch_id
      JOIN students st ON st.id = c.student_id
      LEFT JOIN users u ON u.id = c.server_marked_by
      WHERE ${where.join(' AND ')}
      ORDER BY c.on_date DESC, st.admission_no LIMIT 500`).bind(...args).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({ ...v })) })
}

async function resolveCaptureConflict(c: Ctx): Promise<Response> {
  requirePerm(c, 'academics.attendance.write')
  const id = pathUUID(c, 'id')
  const req = await readJSON<Record<string, unknown>>(c.req)
  const resolution = req.resolution
  if (resolution !== 'kept' && resolution !== 'applied') throw badRequest('resolution must be kept or applied')
  const s = await resolveScope(c)
  const row = await c.db.prepare(`SELECT c.student_id, b.section_id, c.on_date, c.offline_status, c.offline_remarks, c.resolution
      FROM attendance_capture_conflicts c JOIN attendance_capture_batches b ON b.id = c.batch_id WHERE c.id = ?`).bind(id)
    .first<{ student_id: string; section_id: string; on_date: string; offline_status: string; offline_remarks: string | null; resolution: string }>()
  if (!row) throw notFound()
  if (!s.anySection && !reachesSection(s, row.section_id)) throw denied()
  if (row.resolution !== 'pending') throw badRequest('that conflict has already been resolved')
  const t = now()
  const stmts: D1PreparedStatement[] = []
  if (resolution === 'applied') {
    stmts.push(c.db.prepare(`UPDATE student_attendance SET corrected_from = status, status = ?, remarks = COALESCE(?, remarks),
        corrected_by = ?, corrected_at = ? WHERE student_id = ? AND on_date = ? AND period_id IS NULL`)
      .bind(row.offline_status, row.offline_remarks, c.id.userId, t, row.student_id, row.on_date))
  }
  stmts.push(c.db.prepare(`UPDATE attendance_capture_conflicts SET resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`)
    .bind(resolution, c.id.userId, t, id))
  await c.db.batch(stmts)
  return ok({ ok: true })
}

async function listDiaryEntries(c: Ctx): Promise<Response> {
  const sectionId = queryUUID(c, 'section_id')
  const s = await resolveScope(c)
  const where = ['1']
  const args: unknown[] = []
  if (sectionId) {
    if (!reachesSection(s, sectionId)) throw denied()
    where.push('d.section_id = ?'); args.push(sectionId)
  } else if (!(s.allAttendance || s.allStudents)) {
    if (!s.sectionIds.length) return ok({ items: [] })
    const q = inJSON('d.section_id', s.sectionIds)
    where.push(q.sql); args.push(q.arg)
  }
  const rows = await c.db.prepare(`SELECT d.id, d.section_id, COALESCE(sec.name, '-') AS section_name, sub.name AS subject_name,
        ${ymdOf('d.on_date')} AS on_date, d.kind, d.body, d.captured_offline, d.is_visible_to_family, u.full_name AS written_by
      FROM class_diary_entries d
      LEFT JOIN sections sec ON sec.id = d.section_id
      LEFT JOIN class_subjects cs ON cs.id = d.class_subject_id
      LEFT JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN users u ON u.id = d.written_by
      WHERE ${where.join(' AND ')}
      ORDER BY d.on_date DESC, d.created_at DESC LIMIT 300`).bind(...args).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({ ...v, captured_offline: bool(v.captured_offline), is_visible_to_family: bool(v.is_visible_to_family) })) })
}

async function saveDiaryEntry(c: Ctx): Promise<Response> {
  requirePerm(c, 'academics.homework.write')
  const req = await readJSON<Record<string, unknown>>(c.req)
  const sectionId = bodyUUID(req.section_id)
  const subject = bodyUUIDPtr(req.class_subject_id)
  const body = typeof req.body === 'string' ? req.body : ''
  if (sectionId === '' || body.trim() === '') throw badRequest('a diary line needs a section and some text')
  let kind = typeof req.kind === 'string' ? req.kind : ''
  if (kind === '') kind = 'note'
  if (!DIARY_KINDS.has(kind)) throw badRequest('unknown diary kind')
  let onDate = now().slice(0, 10)
  const raw = optStr(req.on_date)
  if (raw !== null && raw.trim() !== '') {
    if (!isDate(raw.trim())) throw badRequest('on_date must be YYYY-MM-DD')
    onDate = raw.trim()
  }
  const visible = optBool(req.is_visible_to_family) ?? true
  const s = await resolveScope(c)
  if (!reachesSection(s, sectionId)) throw denied()
  const id = uuid()
  const res = await diaryInsert(c, sectionId, subject, onDate, kind, body.trim(), visible, null, id).run()
  if (!res.meta.changes) throw badRequest('that line is already in the diary for this day')
  return ok({ id })
}

export function registerClassroomCapture(r: Router): void {
  r.get('/classroom/attendance/batches', OPEN, listCaptureBatches)
  r.get('/classroom/attendance/conflicts', OPEN, listCaptureConflicts)
  r.post('/classroom/attendance/capture', OPEN, syncCapturedRegister)
  r.post('/classroom/attendance/conflicts/{id}/resolve', OPEN, resolveCaptureConflict)
  r.get('/classroom/diary', OPEN, listDiaryEntries)
  r.post('/classroom/diary', OPEN, saveDiaryEntry)
}
