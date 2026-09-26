import type { Ctx, Router } from '../router'
import { Messenger, enqueueMessageSends, scopeOf, type SendRequest } from '../services/messaging'
import { can } from '../identity'
import {
  HttpError, badRequest, bool, forbidden, notFound, ok, created, readJSON, uuid, uuidParam, uuidQuery, isUUID, now,
} from '../http'
import { json } from '../env'
import { school } from './school'
import { enqueue, queueOf, QUEUES } from '../services/jobs'

/* Port of the /timetable, /attendance, /class, /me, /jobs, /workflow and
   /homework route groups (internal/api/api.go 409-521). Handlers live in
   timetable.go, attendance.go, attendance_export.go, absence_followup.go,
   nudge_register.go, class360.go, my_pay.go, push_tokens.go, day_code.go,
   acting.go, jobs.go and mod_workflow.go. Query params, bodies and JSON
   shapes follow those files field for field. */

// ---------------------------------------------------------------- helpers

/** Side effects that leave the database are not ported: 501 with the name. */
const notImplemented = (what: string) => new HttpError(501, `not implemented in the Worker: ${what}`)

const DATE = /^\d{4}-\d{2}-\d{2}$/
function isDate(s: string): boolean {
  if (!DATE.test(s)) return false
  const d = new Date(s + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}
const today = () => now().slice(0, 10)
/** Postgres wrote "2026-09-26T09:15:00.123Z"; the Go structs sent "YYYY-MM-DDTHH:MM:SSZ". */
const isoSec = (v: string | null): string => (v ? new Date(v).toISOString().replace(/\.\d{3}Z$/, 'Z') : '')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** to_char(date, 'DD Mon'). */
const ddMon = (d: string) => `${d.slice(8, 10)} ${MONTHS[Number(d.slice(5, 7)) - 1] ?? ''}`
const round1 = (v: number) => Math.round(v * 10) / 10
const trim = (s: unknown) => (typeof s === 'string' ? s.trim() : '')
const nul = (s: string): string | null => (s === '' ? null : s)
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))

/** `alias.first_name [middle] [last]`, the concat_ws(' ', ...) of the Go queries. */
const fullName3 = (a: string) => `trim(COALESCE(${a}.first_name,'') || COALESCE(' ' || ${a}.middle_name,'') || COALESCE(' ' || ${a}.last_name,''))`
const fullName2 = (a: string) => `trim(COALESCE(${a}.first_name,'') || COALESCE(' ' || ${a}.last_name,''))`

/** `col IN (?,?,?)` with its args, or FALSE for an empty set (see nothing, never everything). */
function inList(col: string, ids: string[]): { sql: string; args: string[] } {
  if (ids.length === 0) return { sql: 'FALSE', args: [] }
  return { sql: `${col} IN (SELECT value FROM json_each(?))`, args: [JSON.stringify(ids)] }
}

/** The guardians who may be told about a child; internal/api/privacy.go guardianAlertFilter. */
const guardianAlertFilter = `
       AND NOT sg.portal_blocked
       AND (sg.access_until IS NULL OR sg.access_until >= ?)
       AND (sg.is_primary
            OR NOT (SELECT i.alerts_primary_only FROM institutions i WHERE i.id = sg.institution_id)
            OR NOT EXISTS (SELECT 1 FROM student_guardians p
                            WHERE p.student_id = sg.student_id AND p.is_primary
                              AND NOT p.portal_blocked
                              AND (p.access_until IS NULL OR p.access_until >= ?)))`

const NIL_UUID = '00000000-0000-0000-0000-000000000000'
/**
 * One notification row, deduplicated the way the Postgres partial unique index
 * (user_id, kind, source_id, student_id) WHERE source_kind IS NOT NULL did:
 * a second alert about the same fact is dropped. Returned as a statement so
 * the caller can put it in the same batch as the write it announces.
 */
function notifyStmt(c: Ctx, user: string, student: string | null, kind: string, title: string, body: string, link: string,
  sourceKind: string | null, sourceId: string | null): D1PreparedStatement {
  const inst = c.id.institution!.id
  if (sourceKind === null) {
    return c.db.prepare(`INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, created_at)
                         VALUES (?,?,?,?,?,?,?,?,?)`).bind(uuid(), inst, user, student, kind, title, body, link, now())
  }
  return c.db.prepare(`INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, source_kind, source_id, created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?
     WHERE NOT EXISTS (SELECT 1 FROM notifications n
                        WHERE n.user_id = ? AND n.kind = ? AND n.source_kind IS NOT NULL
                          AND COALESCE(n.source_id, ?) = COALESCE(?, ?)
                          AND COALESCE(n.student_id, ?) = COALESCE(?, ?))`)
    .bind(uuid(), inst, user, student, kind, title, body, link, sourceKind, sourceId, now(),
      user, kind, NIL_UUID, sourceId, NIL_UUID, NIL_UUID, student, NIL_UUID)
}

/** internal/api/period_close.go requireOpenPeriod, kind "month": 409 period_closed. */
async function requireOpenMonth(c: Ctx, on: string): Promise<void> {
  const inst = c.id.institution!.id
  const row = await c.db.prepare(`
    SELECT EXISTS (SELECT 1 FROM period_closes
                    WHERE institution_id = ? AND kind = 'month' AND period_key = ? AND reopened_at IS NULL) AS month_closed,
           (SELECT name FROM academic_years
             WHERE institution_id = ? AND closed_at IS NOT NULL AND ? BETWEEN starts_on AND ends_on
             ORDER BY starts_on DESC LIMIT 1) AS year_name`)
    .bind(inst, on.slice(0, 7), inst, on).first<{ month_closed: number; year_name: string | null }>()
  if (row?.month_closed) {
    throw new HttpError(409, `${MONTHS_LONG[Number(on.slice(5, 7)) - 1]} ${on.slice(0, 4)} is closed; ask the principal to reopen it`, { code: 'period_closed' })
  }
  if (row?.year_name) throw new HttpError(409, `The year ${row.year_name} is closed; ask the principal to reopen it`, { code: 'period_closed' })
}

/** internal/api/setup.go ensureCampus: the first campus, created when there is none. */
async function ensureCampus(c: Ctx): Promise<string> {
  const row = await c.db.prepare('SELECT id FROM campuses ORDER BY created_at LIMIT 1').first<{ id: string }>()
  if (row) return row.id
  const id = uuid()
  await c.db.prepare(`INSERT INTO campuses (id, institution_id, name, code, created_at, updated_at) VALUES (?,?,'Main Campus','MAIN',?,?)`)
    .bind(id, c.id.institution!.id, now(), now()).run()
  return id
}

/** Wall-clock parts of an instant in a timezone. */
function partsIn(tz: string, d: Date): { y: number; m: number; d: number; hh: number; mm: number; ss: number } {
  let f: Intl.DateTimeFormat
  try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'Asia/Kolkata', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
  catch { f = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
  const p: Record<string, number> = {}
  for (const x of f.formatToParts(d)) if (x.type !== 'literal') p[x.type] = Number(x.value)
  return { y: p.year, m: p.month, d: p.day, hh: p.hour === 24 ? 0 : p.hour, mm: p.minute, ss: p.second }
}
/** The UTC instant of a wall-clock time in a timezone (`date + time AT TIME ZONE tz`). */
function localToUtc(tz: string, date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm, ss] = (time.length === 5 ? time + ':00' : time).split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss || 0)
  const p = partsIn(tz, new Date(guess))
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss)
  return new Date(guess - (asUtc - guess)).toISOString()
}
/** HH:MM of an ISO instant in a timezone. */
function hhmmIn(tz: string, iso: string | null): string | null {
  if (!iso) return null
  const p = partsIn(tz, new Date(iso))
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`
}

// ------------------------------------------------------------------ scope
// Port of internal/scope resolveUncached and the predicates this block uses.

interface Resolved {
  sectionIds: string[]
  classTeacherOf: string[]
  studentIds: string[]
  allStudents: boolean
  allAttendance: boolean
  anySection: boolean
  platformAdmin: boolean
}

async function resolveScope(c: Ctx): Promise<Resolved> {
  const r: Resolved = {
    sectionIds: [], classTeacherOf: [], studentIds: [],
    allStudents: can(c.id, 'students.read.all'),
    allAttendance: can(c.id, 'academics.attendance.read.all'),
    anySection: can(c.id, 'academics.attendance.write.any'),
    platformAdmin: c.id.platformAdmin,
  }
  if (c.id.platformAdmin) { r.allStudents = r.allAttendance = r.anySection = true; return r }
  const u = c.id.userId
  const [sections, classTeacher, students] = await Promise.all([
    c.db.prepare(`
      SELECT section_id AS id FROM section_subject_teachers WHERE teacher_user_id = ?
      UNION SELECT section_id FROM timetable_entries WHERE teacher_user_id = ?
      UNION SELECT id FROM sections WHERE class_teacher_id = ?
      UNION SELECT DISTINCT te.section_id FROM timetable_entries te
              JOIN employees emp ON emp.user_id = te.teacher_user_id
             WHERE emp.department_id IN (SELECT id FROM departments WHERE head_user_id = ?)`).bind(u, u, u, u).all<{ id: string }>(),
    c.db.prepare('SELECT id FROM sections WHERE class_teacher_id = ?').bind(u).all<{ id: string }>(),
    c.db.prepare(`
      SELECT id FROM students WHERE user_id = ?
      UNION SELECT sg.student_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
             WHERE g.user_id = ? AND NOT sg.portal_blocked AND (sg.access_until IS NULL OR sg.access_until >= ?)`).bind(u, u, today()).all<{ id: string }>(),
  ])
  r.sectionIds = sections.results.map((x) => x.id)
  r.classTeacherOf = classTeacher.results.map((x) => x.id)
  r.studentIds = students.results.map((x) => x.id)
  return r
}

/** Resolved.AttendancePredicate: rows in a section I reach or about a student who is mine. */
function attendancePred(r: Resolved, alias: string): { sql: string; args: string[] } {
  if (r.allAttendance) return { sql: 'TRUE', args: [] }
  const parts: string[] = []
  const args: string[] = []
  if (r.sectionIds.length) { const x = inList(`${alias}.section_id`, r.sectionIds); parts.push(x.sql); args.push(...x.args) }
  if (r.studentIds.length) { const x = inList(`${alias}.student_id`, r.studentIds); parts.push(x.sql); args.push(...x.args) }
  if (!parts.length) return { sql: 'FALSE', args: [] }
  return { sql: `(${parts.join(' OR ')})`, args }
}
/** Resolved.TimetablePredicate. */
function timetablePred(r: Resolved, col: string): { sql: string; args: string[] } {
  if (r.allAttendance || r.anySection) return { sql: 'TRUE', args: [] }
  if (r.sectionIds.length === 0 && r.studentIds.length > 0) {
    const x = inList('e.student_id', r.studentIds)
    return { sql: `${col} IN (SELECT e.section_id FROM enrollments e WHERE ${x.sql} AND e.status = 'active')`, args: x.args }
  }
  return inList(col, r.sectionIds)
}
/** Resolved.CanMarkSection / IsClassTeacherOf: the register belongs to the class teacher. */
const canMarkSection = (r: Resolved, sectionId: string) => r.anySection || r.platformAdmin || r.classTeacherOf.includes(sectionId)
const ownsStudent = (r: Resolved, studentId: string) => r.studentIds.includes(studentId)

// ================================================================= register
export function registerDaily(r: Router): void {
  registerTimetable(r)
  registerAttendance(r)
  registerClass360(r)
  registerMeGroup(r)
  registerJobs(r)
  registerWorkflow(r)
  registerHomework(r)
}

// ================================================================ timetable
function registerTimetable(r: Router) {
  r.get('/timetable/entries', 'academics.timetable.read', async (c) => {
    const q = c.url.searchParams
    const res = await resolveScope(c)
    const mine = timetablePred(res, 'te.section_id')
    let teacher = q.get('teacher_id') ?? ''
    if (teacher === 'me') teacher = c.id.userId
    const section = nul(q.get('section_id') ?? ''), year = nul(q.get('academic_year_id') ?? ''), t = nul(teacher)
    const rows = await c.db.prepare(`
      SELECT te.id, te.section_id, sec.name AS section_name, c.name AS class_name,
             te.period_id, p.name AS period_name, te.weekday,
             sub.name AS subject_name, sub.code AS subject_code,
             te.teacher_user_id AS teacher_id, u.full_name AS teacher_name, te.room
        FROM timetable_entries te
        JOIN sections sec ON sec.id = te.section_id
        JOIN classes c ON c.id = sec.class_id
        JOIN periods p ON p.id = te.period_id
        JOIN class_subjects cs ON cs.id = te.class_subject_id
        JOIN subjects sub ON sub.id = cs.subject_id
        LEFT JOIN users u ON u.id = te.teacher_user_id
       WHERE (? IS NULL OR te.section_id = ?)
         AND (? IS NULL OR te.academic_year_id = ?)
         AND (? IS NULL OR te.teacher_user_id = ?)
         AND ${mine.sql}
       ORDER BY te.weekday, p.sequence`).bind(section, section, year, year, t, t, ...mine.args).all()
    return ok({ items: rows.results.map((v) => ({
      id: v.id, section_id: v.section_id, section_name: v.section_name, class_name: v.class_name,
      period_id: v.period_id, period_name: v.period_name, weekday: v.weekday,
      subject_name: v.subject_name, subject_code: v.subject_code,
      teacher_id: v.teacher_id ?? undefined, teacher_name: v.teacher_name ?? undefined, room: v.room ?? undefined,
    })) })
  })

  r.get('/timetable/periods', 'academics.timetable.read', async (c) => {
    const q = c.url.searchParams
    const sec = uuidQuery(q.get('section_id')), cls = uuidQuery(q.get('class_id'))
    const rows = await c.db.prepare(`
      WITH want AS (
        SELECT COALESCE(
          (SELECT sec.bell_schedule_id FROM sections sec WHERE sec.id = ?),
          (SELECT cl.bell_schedule_id FROM classes cl
            WHERE cl.id = COALESCE(?, (SELECT class_id FROM sections WHERE id = ?))),
          (SELECT b.id FROM bell_schedules b WHERE b.is_default ORDER BY b.created_at LIMIT 1)
        ) AS id
      )
      SELECT p.id, p.name, p.sequence, substr(p.starts_at,1,5) AS starts_at, substr(p.ends_at,1,5) AS ends_at,
             p.is_break, p.bell_schedule_id
        FROM periods p, want
       WHERE p.bell_schedule_id = want.id
          OR (want.id IS NULL AND p.bell_schedule_id IS NULL)
          OR NOT EXISTS (SELECT 1 FROM periods q2, want w2 WHERE q2.bell_schedule_id = w2.id)
       ORDER BY p.sequence`).bind(sec, cls, sec).all()
    return ok({ items: rows.results.map((v) => ({
      id: v.id, name: v.name, sequence: v.sequence, starts_at: v.starts_at, ends_at: v.ends_at,
      is_break: bool(v.is_break), bell_schedule_id: v.bell_schedule_id ?? null,
    })) })
  })

  r.get('/timetable/bell-schedules', 'academics.timetable.read', async (c) => {
    const rows = await c.db.prepare(`
      SELECT b.id, b.name, b.is_default,
             (SELECT count(*) FROM periods p WHERE p.bell_schedule_id = b.id) AS periods,
             COALESCE((SELECT substr(min(p.starts_at),1,5) FROM periods p WHERE p.bell_schedule_id = b.id), '') AS starts_at,
             COALESCE((SELECT substr(max(p.ends_at),1,5) FROM periods p WHERE p.bell_schedule_id = b.id), '') AS ends_at,
             COALESCE((SELECT group_concat(name, ', ') FROM (SELECT c.name FROM classes c WHERE c.bell_schedule_id = b.id ORDER BY c.level)), '') AS classes
        FROM bell_schedules b
       ORDER BY b.is_default DESC, b.name`).all()
    return ok({ items: rows.results.map((v) => ({
      id: v.id, name: v.name, is_default: bool(v.is_default), periods: num(v.periods),
      starts_at: v.starts_at || undefined, ends_at: v.ends_at || undefined, classes: v.classes,
    })) })
  })

  r.get('/timetable/teachers', 'academics.timetable.read', async (c) => {
    const q = c.url.searchParams
    const mayPlan = can(c.id, 'academics.write')
    const subject = uuidQuery(q.get('subject_id'))
    const freeCT = q.get('free_class_teacher') === 'true' ? 1 : 0
    const except = uuidQuery(q.get('except_section'))
    const former = q.get('include_former') === 'true' ? 1 : 0
    const rows = await c.db.prepare(`
      SELECT COALESCE(u.id, '') AS user_id,
             COALESCE(u.full_name, ${fullName2('e')}) AS full_name,
             e.employee_code, e.id AS employee_id, e.status,
             COALESCE(u.username, u.email, u.phone, '') AS sign_in_as,
             (u.password_hash IS NOT NULL AND u.status <> 'invited') AS can_sign_in,
             COALESCE((SELECT group_concat(key, ', ') FROM (SELECT ro.key FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
                        WHERE ur.user_id = u.id ORDER BY ro.key)), '') AS roles,
             (SELECT count(*) FROM timetable_entries te WHERE te.teacher_user_id = u.id) AS periods,
             COALESCE((SELECT group_concat(name, ', ') FROM (SELECT sub.name FROM teacher_subjects ts JOIN subjects sub ON sub.id = ts.subject_id
                        WHERE ts.user_id = u.id ORDER BY sub.name)), '') AS subjects,
             COALESCE((SELECT c.name || '-' || sec.name FROM sections sec JOIN classes c ON c.id = sec.class_id
                        WHERE sec.class_teacher_id = u.id LIMIT 1), '') AS class_teacher_of
        FROM employees e
        LEFT JOIN users u ON u.id = e.user_id
       WHERE (? = 1 OR e.status = 'active')
         AND (? IS NULL
              OR NOT EXISTS (SELECT 1 FROM teacher_subjects ts WHERE ts.subject_id = ?)
              OR EXISTS (SELECT 1 FROM teacher_subjects ts WHERE ts.subject_id = ? AND ts.user_id = u.id))
         AND (? <> 1
              OR NOT EXISTS (SELECT 1 FROM sections sec WHERE sec.class_teacher_id = u.id AND (? IS NULL OR sec.id <> ?)))
       ORDER BY COALESCE(u.full_name, ${fullName2('e')})`)
      .bind(former, subject, subject, subject, freeCT, except, except).all()
    return ok({ items: rows.results.map((v) => ({
      user_id: v.user_id, full_name: v.full_name, employee_code: v.employee_code, status: v.status,
      weekly_periods: mayPlan ? num(v.periods) : undefined,
      employee_id: v.employee_id, sign_in_as: v.sign_in_as, can_sign_in: bool(v.can_sign_in),
      roles: v.roles, subjects: v.subjects, class_teacher_of: (v.class_teacher_of as string) || undefined,
    })) })
  })

  const weekdayName: Record<number, string> = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' }

  r.put('/timetable/entries/cell', 'academics.timetable.write', async (c) => {
    const inst = c.id.institution?.id
    if (!inst) throw forbidden("no school in scope")
    const req = await readJSON<{ section_id?: string; weekday?: number; period_name?: string; subject_code?: string; teacher_user_id?: string; room?: string }>(c.req)
    const sec = trim(req.section_id)
    if (!isUUID(sec)) throw badRequest('section_id must be a uuid')
    const day = weekdayName[Number(req.weekday)]
    if (!day) throw badRequest('weekday must be 1 (Monday) to 7 (Sunday)')
    const periodName = trim(req.period_name), subjectCode = trim(req.subject_code)
    if (!periodName || !subjectCode) throw badRequest('period_name and subject_code are required')
    const teacher = nul(trim(req.teacher_user_id)), room = nul(trim(req.room))
    const rejected = (msg: string) => new HttpError(409, msg, { code: 'cell_rejected' })

    const year = await c.db.prepare('SELECT id FROM academic_years WHERE institution_id = ? AND is_current').bind(inst).first<{ id: string }>()
    if (!year) throw rejected('no current academic year set')
    const period = await c.db.prepare(`
      SELECT p.id FROM periods p JOIN bell_schedules bs ON bs.id = p.bell_schedule_id
       WHERE p.institution_id = ? AND bs.name = ? AND p.name = ? LIMIT 1`).bind(inst, day, periodName).first<{ id: string }>()
    if (!period) throw rejected(`no period "${periodName}" on ${day}`)
    const cs = await c.db.prepare(`
      SELECT cs.id FROM class_subjects cs
        JOIN sections sec ON sec.class_id = cs.class_id
        JOIN subjects sub ON sub.id = cs.subject_id
       WHERE sec.id = ? AND cs.institution_id = ? AND (upper(sub.code) = upper(?) OR lower(sub.name) = lower(?))`)
      .bind(sec, inst, subjectCode, subjectCode).first<{ id: string }>()
    if (!cs) throw rejected(`this class does not study "${subjectCode}"`)
    // The teacher-slot unique index (timetable_teacher_slot) is not in the
    // SQLite schema, so the clash it raised is checked here.
    if (teacher) {
      const clash = await c.db.prepare(`SELECT 1 AS x FROM timetable_entries
        WHERE teacher_user_id = ? AND weekday = ? AND period_id = ? AND academic_year_id = ? AND section_id <> ?`)
        .bind(teacher, Number(req.weekday), period.id, year.id, sec).first()
      if (clash) throw rejected('that teacher is already taking another class this period')
    }
    const existing = await c.db.prepare('SELECT id FROM timetable_entries WHERE section_id = ? AND weekday = ? AND period_id = ?')
      .bind(sec, Number(req.weekday), period.id).first<{ id: string }>()
    if (existing) {
      await c.db.prepare('UPDATE timetable_entries SET class_subject_id = ?, teacher_user_id = ?, room = ? WHERE id = ?')
        .bind(cs.id, teacher, room, existing.id).run()
    } else {
      await c.db.prepare(`INSERT INTO timetable_entries (id, institution_id, academic_year_id, section_id, period_id, weekday, class_subject_id, teacher_user_id, room, created_at)
                          VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(uuid(), inst, year.id, sec, period.id, Number(req.weekday), cs.id, teacher, room, now()).run()
    }
    return ok({ ok: true })
  })

  r.del('/timetable/entries/{id}', 'academics.timetable.write', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid entry id')
    const res = await c.db.prepare('DELETE FROM timetable_entries WHERE id = ?').bind(c.params.id).run()
    if (!res.meta.changes) throw notFound('resource not found')
    return ok({ ok: true })
  })
}

// =============================================================== attendance
const attendanceStatuses = new Set(['present', 'absent', 'late', 'half_day', 'leave', 'holiday'])
const callStatuses = new Set(['not_called', 'called', 'no_answer', 'reached'])

function registerAttendance(r: Router) {
  r.post('/attendance/nudge', 'academics.attendance.read.all', async (c) => {
    const inst = c.id.institution?.id
    if (!inst) throw forbidden("no school in scope")
    const rows = await c.db.prepare(`
      SELECT c.name || '-' || s.name AS label, s.class_teacher_id AS teacher
        FROM sections s JOIN classes c ON c.id = s.class_id
       WHERE NOT EXISTS (SELECT 1 FROM student_attendance sa WHERE sa.section_id = s.id AND sa.on_date = ?)
         AND EXISTS (SELECT 1 FROM enrollments e WHERE e.section_id = s.id AND e.status = 'active')
       ORDER BY c.level, s.name`).bind(today()).all<{ label: string; teacher: string | null }>()
    const unowned: string[] = []
    const byTeacher = new Map<string, string[]>()
    for (const u of rows.results) {
      if (!u.teacher) { unowned.push(u.label); continue }
      byTeacher.set(u.teacher, [...(byTeacher.get(u.teacher) ?? []), u.label])
    }
    const stmts: D1PreparedStatement[] = []
    for (const [teacher, sections] of byTeacher) {
      const body = `Today's register is not marked for ${joinAnd(sections)}. Please mark it before the day closes.`
      stmts.push(c.db.prepare(`INSERT INTO notifications (id, institution_id, user_id, kind, title, body, link, created_at)
                               VALUES (?,?,?,'attendance_reminder',?,?,'/go/attendance/take_attendance',?)`)
        .bind(uuid(), inst, teacher, 'Register not marked', body, now()))
    }
    if (stmts.length) await c.db.batch(stmts)
    return ok({ sections: rows.results.length, notified: byTeacher.size, sections_without_a_class_teacher: unowned })
  })

  r.get('/attendance', 'academics.attendance.read', async (c) => {
    const q = c.url.searchParams
    const on = q.get('on_date') || today()
    const res = await resolveScope(c)
    const pred = attendancePred(res, 'sa')
    const section = nul(q.get('section_id') ?? ''), student = nul(q.get('student_id') ?? '')
    const rows = await c.db.prepare(`
      SELECT sa.id, sa.student_id, ${fullName3('st')} AS student_name, st.admission_no, sa.section_id,
             sa.on_date, sa.status, sa.minutes_late, sa.remarks
        FROM student_attendance sa JOIN students st ON st.id = sa.student_id
       WHERE sa.on_date = ? AND (? IS NULL OR sa.section_id = ?) AND (? IS NULL OR sa.student_id = ?)
         AND ${pred.sql}
       ORDER BY st.admission_no`).bind(on, section, section, student, student, ...pred.args).all()
    return ok({ items: rows.results.map((v) => ({
      id: v.id, student_id: v.student_id, student_name: v.student_name, admission_no: v.admission_no,
      section_id: v.section_id, on_date: v.on_date, status: v.status,
      minutes_late: v.minutes_late ?? undefined, remarks: v.remarks ?? undefined,
    })) })
  })

  r.get('/attendance/day.csv', 'academics.attendance.read', async (c) => {
    const on = trim(c.url.searchParams.get('on_date')) || today()
    if (!isDate(on)) throw badRequest('on_date must be YYYY-MM-DD')
    const res = await resolveScope(c)
    const pred = attendancePred(res, 'e')
    const rows = await c.db.prepare(`
      SELECT COALESCE(c.name,'') AS class, COALESCE(sec.name,'') AS section, COALESCE(CAST(e.roll_no AS TEXT),'') AS roll,
             st.admission_no, ${fullName3('st')} AS name, COALESCE(sa.status, 'not marked') AS status,
             COALESCE(CAST(sa.minutes_late AS TEXT), '') AS late, COALESCE(sa.remarks, '') AS remarks
        FROM enrollments e
        JOIN students st ON st.id = e.student_id
        JOIN sections sec ON sec.id = e.section_id
        LEFT JOIN classes c ON c.id = sec.class_id
        LEFT JOIN student_attendance sa ON sa.student_id = e.student_id AND sa.section_id = e.section_id
             AND sa.on_date = ? AND sa.period_id IS NULL
       WHERE e.status = 'active' AND st.status = 'active' AND ${pred.sql}
       ORDER BY c.level IS NULL, c.level, sec.name, e.roll_no IS NULL, e.roll_no, st.admission_no`).bind(on, ...pred.args).all()
    const csv = (f: unknown) => { const s = String(f ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const lines = [['Date', 'Class', 'Section', 'Roll no', 'Admission no', 'Student', 'Status', 'Minutes late', 'Remarks'].join(',')]
    for (const v of rows.results) lines.push([on, v.class, v.section, v.roll, v.admission_no, v.name, v.status, v.late, v.remarks].map(csv).join(','))
    return new Response('﻿' + lines.join('\n') + '\n', {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="attendance-${on}-all-sections.csv"` },
    })
  })

  r.post('/attendance', 'academics.attendance.write', async (c) => {
    interface Entry { student_id: string; status: string; minutes_late?: number | null; remarks?: string | null }
    const req = await readJSON<{ section_id?: string; on_date?: string; period_id?: string; entries?: Entry[]; notify_channels?: string[]; silent?: boolean }>(c.req)
    const sectionId = req.section_id ?? ''
    if (!isUUID(sectionId)) throw badRequest('section_id must be a uuid')
    const onDate = req.on_date || today()
    if (!isDate(onDate)) throw badRequest('on_date must be YYYY-MM-DD')
    const entries = req.entries ?? []
    if (!entries.length) throw badRequest('entries must not be empty')
    for (const e of entries) if (!attendanceStatuses.has(e.status)) throw badRequest('invalid status: ' + e.status)
    const res = await resolveScope(c)
    if (!canMarkSection(res, sectionId)) throw forbidden('missing permission: academics.attendance.write for this section')
    let periodId: string | null = null
    if (req.period_id) { if (!isUUID(req.period_id)) throw badRequest('period_id must be a uuid'); periodId = req.period_id }
    for (const e of entries) if (!isUUID(e.student_id)) throw badRequest('student_id must be a uuid')

    const sec = await c.db.prepare('SELECT institution_id FROM sections WHERE id = ?').bind(sectionId).first<{ institution_id: string }>()
    if (!sec) throw notFound('resource not found')
    const instId = sec.institution_id
    await requireOpenMonth(c, onDate)

    // The two partial unique indexes (daily / per-period) are not in the
    // SQLite schema, so the upsert is an explicit read-then-write. Only a
    // changed status is written, as the Go `WHERE status IS DISTINCT FROM`.
    const ids = entries.map((e) => e.student_id)
    const idl = inList('student_id', ids)
    const existing = await c.db.prepare(`SELECT id, student_id, status FROM student_attendance
        WHERE on_date = ? AND ${idl.sql} AND ${periodId ? 'period_id = ?' : 'period_id IS NULL'}`)
      .bind(onDate, ...idl.args, ...(periodId ? [periodId] : [])).all<{ id: string; student_id: string; status: string }>()
    const have = new Map(existing.results.map((x) => [x.student_id, x]))
    const stmts: D1PreparedStatement[] = []
    const nowAbsent: string[] = []
    const ts = now()
    for (const e of entries) {
      const cur = have.get(e.student_id)
      if (cur) {
        if (cur.status === e.status) continue
        stmts.push(c.db.prepare(`UPDATE student_attendance SET status = ?, minutes_late = ?, remarks = ?, corrected_from = ?, corrected_by = ?, corrected_at = ? WHERE id = ?`)
          .bind(e.status, e.minutes_late ?? null, e.remarks ?? null, cur.status, c.id.userId, ts, cur.id))
      } else {
        stmts.push(c.db.prepare(`INSERT INTO student_attendance (id, institution_id, student_id, section_id, on_date, period_id, status, minutes_late, remarks, marked_by, marked_at)
                                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(uuid(), instId, e.student_id, sectionId, onDate, periodId, e.status, e.minutes_late ?? null, e.remarks ?? null, c.id.userId, ts))
      }
      if (e.status === 'absent') nowAbsent.push(e.student_id)
    }
    const written = stmts.length
    const channels = cleanChannels(req.notify_channels ?? [])
    let told = 0
    let queued = 0
    const absenceSends: SendRequest[] = []
    if (!req.silent && nowAbsent.length) {
      // announceAbsences: the whole household plus the child's own account.
      const al = inList('st.id', nowAbsent)
      const t = today()
      const people = await c.db.prepare(`
        SELECT st.id AS student, ${fullName2('st')} AS name, p.user_id, p.phone, p.email
          FROM students st
          JOIN (SELECT sg.student_id, g.user_id, g.phone, g.email FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
                 WHERE 1=1 ${guardianAlertFilter}
                UNION ALL
                SELECT st2.id, u.id, u.phone, u.email FROM students st2 JOIN users u ON u.id = st2.user_id) p ON p.student_id = st.id
         WHERE ${al.sql}`).bind(t, t, ...al.args).all<{ student: string; name: string; user_id: string | null; phone: string | null; email: string | null }>()
      const date = ddMon(onDate)
      for (const m of people.results) {
        const title = `${m.name} was marked absent`
        const body = `${m.name} was marked absent on ${date}. If this is wrong, please tell the class teacher.`
        if (m.user_id) {
          stmts.push(notifyStmt(c, m.user_id, m.student, 'attendance', title, body, '/portal/attendance', 'student', m.student))
          told++
        }
        for (const ch of channels) {
          const to = (ch === 'email' ? m.email : m.phone)?.trim() ?? ''
          if (to !== '') absenceSends.push({ channel: ch, template_code: 'messaging.direct', vars: { text: body, subject: title }, recipient: to })
        }
      }
    }
    if (stmts.length) await c.db.batch(stmts)
    // announceAbsences' QueueMessage leg, after the register is written. A
    // gateway the school has not configured is skipped, never a failed register.
    if (absenceSends.length) {
      const ms = new Messenger(scopeOf(c))
      for (const s of absenceSends) { try { await ms.queue(s); queued++ } catch { /* as Go: continue */ } }
      await ms.kick()
    }
    return ok({ section_id: sectionId, on_date: onDate, submitted: entries.length, written, newly_absent: nowAbsent.length,
      parents_told: told, messages_queued: queued, channels })
  })

  // RequireAnyPermission(AttendanceRead, AttendanceReadAll): either grant
  // opens these, so they are registered as 'auth' and anyAttendanceRead gates.
  r.get('/attendance/absentees', 'auth', listAbsentees)
  r.post('/attendance/absentees/followup', 'auth', recordAbsenceFollowup)
  r.post('/attendance/absentees/section-done', 'auth', finishAbsenceSection)
}

function cleanChannels(input: string[]): string[] {
  const out: string[] = []
  for (const raw of input) {
    const ch = String(raw).trim().toLowerCase()
    if ((ch === 'sms' || ch === 'whatsapp' || ch === 'email') && !out.includes(ch)) out.push(ch)
  }
  return out
}

function joinAnd(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]
}

/* RequireAnyPermission(AttendanceRead, AttendanceReadAll): the router takes one
   key, so the routes are registered as 'auth' and either grant is accepted here. */
function anyAttendanceRead(c: Ctx) {
  if (!can(c.id, 'academics.attendance.read') && !can(c.id, 'academics.attendance.read.all')) throw forbidden()
}

const contactsAgg = `COALESCE((SELECT json_group_array(json_object('name', name, 'phone', phone, 'relation', relation))
    FROM (SELECT g.full_name AS name, g.phone, g.relation
            FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
           WHERE sg.student_id = st.id AND g.phone IS NOT NULL AND trim(g.phone) <> ''
           ORDER BY (g.relation = 'father') DESC, (g.relation = 'mother') DESC, sg.is_primary DESC, g.full_name)), '[]')`

async function listAbsentees(c: Ctx): Promise<Response> {
  anyAttendanceRead(c)
  const q = c.url.searchParams
  const on = q.get('on_date') || today()
  if (!isDate(on)) throw badRequest('on_date must be YYYY-MM-DD')
  const res = await resolveScope(c)
  const pred = attendancePred(res, 'sa')
  const section = nul(q.get('section_id') ?? '')
  const [rows, present] = await Promise.all([
    c.db.prepare(`
      SELECT sa.section_id, sec.name AS section_name, c.name AS class_name, du.full_name AS done_by, d.done_at,
             sa.student_id, ${fullName3('st')} AS name, st.admission_no, sa.status AS mark,
             ${contactsAgg} AS contacts,
             COALESCE(f.call_status, 'not_called') AS call_status, COALESCE(f.parent_response, '') AS parent_response,
             COALESCE(fu.full_name, '') AS called_by, f.updated_at AS called_at
        FROM student_attendance sa
        JOIN students st ON st.id = sa.student_id
        JOIN sections sec ON sec.id = sa.section_id
        JOIN classes c ON c.id = sec.class_id
        LEFT JOIN student_absence_followup f ON f.student_id = sa.student_id AND f.on_date = sa.on_date
        LEFT JOIN users fu ON fu.id = f.updated_by
        LEFT JOIN absence_followup_section_done d ON d.section_id = sa.section_id AND d.on_date = sa.on_date
        LEFT JOIN users du ON du.id = d.done_by
       WHERE sa.on_date = ? AND (? IS NULL OR sa.section_id = ?)
         AND sa.status IS NOT NULL AND sa.status <> 'present' AND sa.status <> 'holiday' AND sa.status <> 'leave'
         AND ${pred.sql}
       ORDER BY sec.name, st.admission_no`).bind(on, section, section, ...pred.args).all(),
    c.db.prepare(`
      SELECT sa.student_id, ${fullName3('st')} AS name, st.admission_no, sa.section_id, sec.name AS section_name, c.name AS class_name
        FROM student_attendance sa
        JOIN students st ON st.id = sa.student_id
        JOIN sections sec ON sec.id = sa.section_id
        JOIN classes c ON c.id = sec.class_id
       WHERE sa.on_date = ? AND (? IS NULL OR sa.section_id = ?) AND sa.status = 'present' AND st.status = 'active'
         AND ${pred.sql}
       ORDER BY sec.name, st.admission_no`).bind(on, section, section, ...pred.args).all(),
  ])
  const sections: Array<Record<string, unknown> & { students: unknown[] }> = []
  const idx = new Map<string, number>()
  for (const it of rows.results) {
    const sid = it.section_id as string
    let i = idx.get(sid)
    if (i === undefined) {
      i = sections.length
      idx.set(sid, i)
      sections.push({ section_id: sid, section_name: it.section_name, class_name: it.class_name, students: [],
        done: it.done_at !== null, done_by: it.done_by ?? null, done_at: it.done_at ?? null })
    }
    let contacts: unknown[] = []
    try { contacts = JSON.parse(it.contacts as string) } catch { /* a bad aggregate leaves no numbers rather than no row */ }
    sections[i].students.push({ student_id: it.student_id, name: it.name, admission_no: it.admission_no, mark: it.mark,
      contacts, call_status: it.call_status, parent_response: it.parent_response, called_by: it.called_by, called_at: it.called_at ?? null })
  }
  return ok({ date: on, sections, present: present.results })
}

/** upsertAbsenceFollowup: the scope check and the statement, shared by the two writers. */
async function absenceFollowupStmt(c: Ctx, res: Resolved, studentId: string, onDate: string, callStatus: string, parentResponse: string): Promise<D1PreparedStatement> {
  if (!res.allAttendance) {
    const sl = inList('e.section_id', res.sectionIds)
    const visible = await c.db.prepare(`SELECT (EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = ? AND ${sl.sql}) OR ?) AS v`)
      .bind(studentId, ...sl.args, ownsStudent(res, studentId) ? 1 : 0).first<{ v: number }>()
    if (!visible?.v) throw forbidden('missing permission: academics.attendance.read for this student')
  }
  const st = await c.db.prepare('SELECT institution_id FROM students WHERE id = ?').bind(studentId).first<{ institution_id: string }>()
  if (!st) throw notFound('resource not found')
  return c.db.prepare(`INSERT INTO student_absence_followup (institution_id, student_id, on_date, call_status, parent_response, updated_by, updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT (student_id, on_date) DO UPDATE SET call_status = excluded.call_status, parent_response = excluded.parent_response,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(st.institution_id, studentId, onDate, callStatus, parentResponse, c.id.userId, now())
}

async function recordAbsenceFollowup(c: Ctx): Promise<Response> {
  anyAttendanceRead(c)
  const req = await readJSON<{ student_id?: string; on_date?: string; call_status?: string; parent_response?: string }>(c.req)
  if (!isUUID(req.student_id)) throw badRequest('student_id must be a uuid')
  const onDate = req.on_date || today()
  if (!isDate(onDate)) throw badRequest('on_date must be YYYY-MM-DD')
  if (!callStatuses.has(req.call_status ?? '')) throw badRequest('invalid call_status: ' + (req.call_status ?? ''))
  const res = await resolveScope(c)
  const stmt = await absenceFollowupStmt(c, res, req.student_id, onDate, req.call_status!, req.parent_response ?? '')
  await stmt.run()
  return ok({ ok: true })
}

async function finishAbsenceSection(c: Ctx): Promise<Response> {
  anyAttendanceRead(c)
  const req = await readJSON<{ section_id?: string; on_date?: string; entries?: Array<{ student_id: string; call_status: string; parent_response?: string }> }>(c.req)
  const sectionId = req.section_id ?? ''
  if (!isUUID(sectionId)) throw badRequest('section_id must be a uuid')
  const onDate = req.on_date || today()
  if (!isDate(onDate)) throw badRequest('on_date must be YYYY-MM-DD')
  const entries = req.entries ?? []
  for (const e of entries) {
    if (!isUUID(e.student_id)) throw badRequest('student_id must be a uuid')
    if (!callStatuses.has(e.call_status)) throw badRequest('invalid call_status: ' + e.call_status)
  }
  const res = await resolveScope(c)
  if (!res.allAttendance && !res.sectionIds.includes(sectionId)) throw forbidden('missing permission: academics.attendance.read for this section')
  const stmts: D1PreparedStatement[] = []
  for (const e of entries) stmts.push(await absenceFollowupStmt(c, res, e.student_id, onDate, e.call_status, e.parent_response ?? ''))
  const sec = await c.db.prepare('SELECT institution_id FROM sections WHERE id = ?').bind(sectionId).first<{ institution_id: string }>()
  if (!sec) throw notFound('resource not found')
  stmts.push(c.db.prepare(`INSERT INTO absence_followup_section_done (institution_id, section_id, on_date, done_by, done_at) VALUES (?,?,?,?,?)
    ON CONFLICT (section_id, on_date) DO UPDATE SET done_by = excluded.done_by, done_at = excluded.done_at`)
    .bind(sec.institution_id, sectionId, onDate, c.id.userId, now()))
  await c.db.batch(stmts)
  return ok({ ok: true })
}

// ================================================================= class 360
function registerClass360(r: Router) {
  r.get('/class/sections', 'academics.class360.view', async (c) => {
    const res = await resolveScope(c)
    const sl = inList('sec.id', res.sectionIds)
    const rows = await c.db.prepare(`
      SELECT sec.id AS section_id, c.name AS class, sec.name AS section,
             (SELECT count(*) FROM enrollments e WHERE e.section_id = sec.id AND e.status = 'active') AS students_count,
             COALESCE((SELECT full_name FROM users WHERE id = sec.class_teacher_id), '') AS class_teacher
        FROM sections sec JOIN classes c ON c.id = sec.class_id
       WHERE (? OR ${sl.sql})
         AND EXISTS (SELECT 1 FROM enrollments e WHERE e.section_id = sec.id AND e.status = 'active')
       ORDER BY c.name, sec.name`).bind(res.allStudents ? 1 : 0, ...sl.args).all()
    return ok({ items: rows.results })
  })

  r.get('/class/{sectionId}/overview', 'academics.class360.view', async (c) => {
    const sectionId = c.params.sectionId
    if (!isUUID(sectionId)) throw badRequest('invalid section id')
    const res = await resolveScope(c)
    if (!res.allStudents && !res.sectionIds.includes(sectionId)) throw notFound('resource not found')

    const head = await c.db.prepare(`
      SELECT sec.id, c.name AS class, sec.name AS section, sec.class_id,
             COALESCE((SELECT full_name FROM users WHERE id = sec.class_teacher_id), '') AS class_teacher,
             COALESCE((SELECT COALESCE(NULLIF(trim(u.phone), ''), emp.phone) FROM users u LEFT JOIN employees emp ON emp.user_id = u.id WHERE u.id = sec.class_teacher_id), '') AS class_teacher_phone,
             COALESCE((SELECT COALESCE(NULLIF(trim(u.email), ''), emp.email) FROM users u LEFT JOIN employees emp ON emp.user_id = u.id WHERE u.id = sec.class_teacher_id), '') AS class_teacher_email,
             (SELECT count(*) FROM enrollments e WHERE e.section_id = sec.id AND e.status = 'active') AS students_count
        FROM sections sec JOIN classes c ON c.id = sec.class_id WHERE sec.id = ?`).bind(sectionId)
      .first<{ id: string; class: string; section: string; class_id: string; class_teacher: string; class_teacher_phone: string; class_teacher_email: string; students_count: number }>()
    if (!head) throw notFound('resource not found')
    const t = today()
    const [teachers, students, todayRow, trend, marks, timetable] = await Promise.all([
      c.db.prepare(`
        SELECT sub.name AS subject, COALESCE(u.full_name, '') AS teacher,
               COALESCE(NULLIF(trim(u.phone), ''), emp.phone, '') AS phone, COALESCE(NULLIF(trim(u.email), ''), emp.email, '') AS email
          FROM section_subject_teachers sst
          JOIN class_subjects cs ON cs.id = sst.class_subject_id
          JOIN subjects sub ON sub.id = cs.subject_id
          LEFT JOIN users u ON u.id = sst.teacher_user_id
          LEFT JOIN employees emp ON emp.user_id = u.id
         WHERE sst.section_id = ? ORDER BY sub.name`).bind(sectionId).all(),
      c.db.prepare(`
        SELECT st.id AS student_id, ${fullName3('st')} AS name, st.admission_no, COALESCE(e.roll_no, 0) AS roll, ${contactsAgg} AS contacts
          FROM enrollments e JOIN students st ON st.id = e.student_id
         WHERE e.section_id = ? AND e.status = 'active'
         ORDER BY e.roll_no IS NULL, e.roll_no, st.admission_no`).bind(sectionId).all(),
      c.db.prepare(`SELECT count(*) AS marked, SUM(status = 'present') AS present FROM student_attendance
                     WHERE section_id = ? AND on_date = ? AND status <> 'holiday'`).bind(sectionId, t).first<{ marked: number; present: number | null }>(),
      c.db.prepare(`SELECT on_date, count(*) AS marked, SUM(status = 'present') AS presents FROM student_attendance
                     WHERE section_id = ? AND status <> 'holiday' GROUP BY on_date ORDER BY on_date DESC LIMIT 14`).bind(sectionId)
        .all<{ on_date: string; marked: number; presents: number | null }>(),
      c.db.prepare(`
        SELECT sub.name AS subject, avg(CAST(m.marks_obtained AS REAL) / CAST(es.max_marks AS REAL) * 100) AS avg_pct
          FROM enrollments e
          JOIN marks m ON m.student_id = e.student_id AND NOT m.is_absent
          JOIN exam_subjects es ON es.id = m.exam_subject_id AND CAST(es.max_marks AS REAL) > 0
          JOIN exams ex ON ex.id = es.exam_id AND ex.is_published
          JOIN class_subjects cs ON cs.id = es.class_subject_id AND cs.class_id = ?
          JOIN subjects sub ON sub.id = cs.subject_id
         WHERE e.section_id = ? AND e.status = 'active'
         GROUP BY sub.name ORDER BY sub.name`).bind(head.class_id, sectionId).all<{ subject: string; avg_pct: number }>(),
      c.db.prepare(`
        SELECT te.weekday, p.name AS period, p.sequence, substr(p.starts_at,1,5) AS starts, substr(p.ends_at,1,5) AS ends,
               sub.name AS subject, COALESCE(u.full_name, '') AS teacher
          FROM timetable_entries te
          JOIN periods p ON p.id = te.period_id
          JOIN class_subjects cs ON cs.id = te.class_subject_id
          JOIN subjects sub ON sub.id = cs.subject_id
          LEFT JOIN users u ON u.id = te.teacher_user_id
         WHERE te.section_id = ? ORDER BY te.weekday, p.sequence`).bind(sectionId).all(),
    ])
    const marked = num(todayRow?.marked)
    const fees = { visible: false, collected_paise: 0, outstanding_paise: 0 }
    if (can(c.id, 'finance.fees.read')) {
      fees.visible = true
      const f = await c.db.prepare(`
        SELECT COALESCE((SELECT sum(p.amount_paise) FROM payments p JOIN enrollments e ON e.student_id = p.student_id
                          WHERE e.section_id = ? AND e.status = 'active' AND p.status = 'success'), 0) AS collected,
               COALESCE((SELECT sum(i.net_paise) FROM invoices i JOIN enrollments e ON e.student_id = i.student_id
                          WHERE e.section_id = ? AND e.status = 'active' AND i.status <> 'cancelled'), 0) AS charged`)
        .bind(sectionId, sectionId).first<{ collected: number; charged: number }>()
      fees.collected_paise = num(f?.collected)
      fees.outstanding_paise = Math.max(0, num(f?.charged) - fees.collected_paise)
    }
    return ok({
      section: { id: head.id, class: head.class, section: head.section, students_count: num(head.students_count) },
      class_teacher: head.class_teacher, class_teacher_phone: head.class_teacher_phone, class_teacher_email: head.class_teacher_email,
      subject_teachers: teachers.results,
      students: students.results.map((s) => {
        let contacts: unknown[] = []
        try { contacts = JSON.parse(s.contacts as string) } catch { /* no numbers rather than no row */ }
        return { student_id: s.student_id, name: s.name, admission_no: s.admission_no, roll: num(s.roll), contacts }
      }),
      attendance: {
        present_pct_today: marked > 0 ? round1(num(todayRow?.present) / marked * 100) : 0,
        marked_today: marked,
        trend: [...trend.results].reverse().map((tr) => ({ date: tr.on_date, present_pct: tr.marked > 0 ? round1(num(tr.presents) / tr.marked * 100) : 0 })),
      },
      marks: { has_marks: marks.results.length > 0, by_subject: marks.results.map((m) => ({ subject: m.subject, avg_pct: round1(num(m.avg_pct)) })) },
      timetable: timetable.results,
      fees,
    })
  })
}

// ======================================================================= /me
function registerMeGroup(r: Router) {
  r.get('/me/student', 'self.attendance.read', async (c) => {
    const st = await c.db.prepare(`
      SELECT st.id, st.admission_no, ${fullName3('st')} AS full_name, c.name AS class_name, sec.name AS section_name
        FROM students st
        LEFT JOIN classes c ON c.id = (SELECT e.class_id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
        LEFT JOIN sections sec ON sec.id = (SELECT e.section_id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
       WHERE st.user_id = ?`).bind(c.id.userId)
      .first<{ id: string; admission_no: string; full_name: string; class_name: string | null; section_name: string | null }>()
    if (!st) throw notFound('resource not found')
    const m = await c.db.prepare(`SELECT SUM(status IN ('present','late')) AS present, count(*) AS total FROM student_attendance
                                   WHERE student_id = ? AND on_date >= ?`).bind(st.id, today().slice(0, 8) + '01').first<{ present: number | null; total: number }>()
    return ok({ id: st.id, admission_no: st.admission_no, full_name: st.full_name, class_name: st.class_name, section_name: st.section_name,
      attendance_this_month: { present: num(m?.present), total: num(m?.total) } })
  })

  r.get('/me/pay', 'auth', async (c) => {
    const emp = await c.db.prepare(`SELECT id, employee_code FROM employees WHERE user_id = ? AND status = 'active'`).bind(c.id.userId)
      .first<{ id: string; employee_code: string }>()
    const out: Record<string, unknown> = { payslips: [], attendance: { present: 0, absent: 0, late: 0, on_leave: 0, days_marked: 0 }, leave_balances: [], late_this_month: 0, deduction_reasons: [] }
    if (!emp) {
      out.note = 'You are not on the staff roll, so there is no pay record here.'
      return ok(out)
    }
    out.employee_code = emp.employee_code
    const [slips, att, bals, late] = await Promise.all([
      c.db.prepare(`
        SELECT pr.period_month, pr.period_year, ps.paid_days, ps.lop_days, ps.gross_paise, ps.deduction_paise, ps.net_paise, ps.breakup,
               pr.locked_at IS NOT NULL AS locked
          FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
         WHERE ps.employee_id = ? ORDER BY pr.period_year DESC, pr.period_month DESC LIMIT 24`).bind(emp.id).all(),
      c.db.prepare(`
        SELECT SUM(status IN ('present','half_day')) AS present, SUM(status = 'absent') AS absent, SUM(status = 'late') AS late,
               SUM(status = 'leave') AS on_leave, SUM(status NOT IN ('holiday','week_off')) AS marked
          FROM staff_attendance WHERE user_id = ?`).bind(c.id.userId).first<Record<string, number | null>>(),
      c.db.prepare(`
        SELECT lt.name AS leave_type, lb.entitled, lb.taken, CAST(CAST(lb.entitled AS REAL) - CAST(lb.taken AS REAL) AS TEXT) AS remaining
          FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id
         WHERE lb.employee_id = ? ORDER BY lt.name`).bind(emp.id).all(),
      c.db.prepare(`SELECT count(*) AS n FROM staff_attendance WHERE user_id = ? AND status = 'late' AND substr(on_date,1,7) = ?`)
        .bind(c.id.userId, today().slice(0, 7)).first<{ n: number }>(),
    ])
    const payslips = slips.results.map((v) => {
      let breakup: unknown = {}
      try { breakup = JSON.parse((v.breakup as string) || '{}') } catch { breakup = {} }
      return { period_month: v.period_month, period_year: v.period_year, paid_days: String(v.paid_days), lop_days: String(v.lop_days),
        gross_paise: num(v.gross_paise), deduction_paise: num(v.deduction_paise), net_paise: num(v.net_paise), breakup, locked: bool(v.locked) }
    })
    out.payslips = payslips
    out.attendance = { present: num(att?.present), absent: num(att?.absent), late: num(att?.late), on_leave: num(att?.on_leave), days_marked: num(att?.marked) }
    out.leave_balances = bals.results.map((b) => ({ leave_type: b.leave_type, entitled: String(b.entitled), used: String(b.taken), remaining: String(b.remaining) }))
    const lateN = num(late?.n)
    out.late_this_month = lateN
    const reasons: Array<{ text: string }> = []
    if (payslips.length) {
      const p = payslips[0]
      const lop = Number(p.lop_days)
      if (Number.isFinite(lop) && lop > 0) {
        reasons.push({ text: `${lop} unpaid ${lop === 1 ? 'day' : 'days'} in ${MONTHS_LONG[Number(p.period_month) - 1] ?? ''}. Leave taken beyond what you had left, or days not covered by an approved leave.` })
      }
    }
    if (lateN > 0) reasons.push({ text: `${lateN} late arrivals recorded this month. Your school's policy sets how many make one unpaid day. It is on the leave and attendance policy.` })
    out.deduction_reasons = reasons
    if (!payslips.length) out.note = 'No payroll has been run for you yet. Payslips appear here the month after the office runs one.'
    return ok(out)
  })

  r.put('/me/push-token', 'auth', async (c) => {
    if (!c.id.institution) throw badRequest('push tokens belong to a school account')
    let req: { token?: string; platform?: string; app_version?: string }
    try { req = await readJSON(c.req) } catch { throw badRequest('could not read the token') }
    const token = trim(req.token)
    if (!token || token.length > 4096) throw badRequest('token is required')
    const platform = req.platform || 'android'
    await c.db.prepare(`INSERT INTO push_tokens (token, user_id, institution_id, platform, app_version, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, institution_id = excluded.institution_id,
        platform = excluded.platform, app_version = excluded.app_version, updated_at = excluded.updated_at`)
      .bind(token, c.id.userId, c.id.institution.id, platform, nul(trim(req.app_version)), now()).run()
    return ok({ ok: true })
  })

  r.del('/me/push-token', 'auth', async (c) => {
    let token = ''
    try { const req = await c.req.json<{ token?: string }>(); token = trim(req?.token) } catch { /* no body: forget every token of this user */ }
    if (!token) await c.db.prepare('DELETE FROM push_tokens WHERE user_id = ?').bind(c.id.userId).run()
    else await c.db.prepare('DELETE FROM push_tokens WHERE token = ? AND user_id = ?').bind(token, c.id.userId).run()
    return ok({ ok: true })
  })

  r.get('/me/day-code', 'auth', async (c) => {
    if (c.id.platformAdmin) throw notFound('resource not found')
    const row = await c.db.prepare(`
      SELECT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.key IN ('faculty','hod')) AS teacher,
             i.teacher_day_code_secret AS secret, i.timezone
        FROM institutions i WHERE i.id = ?`).bind(c.id.userId, c.id.institution!.id)
      .first<{ teacher: number; secret: ArrayBuffer | null; timezone: string }>()
    if (!row?.teacher) throw notFound('resource not found')
    return ok(await dayCodeState(row.secret, row.timezone))
  })

  r.get('/me/institutions', 'auth', async (c) => {
    // The Go handler gathers every school where the user holds a user_roles
    // row, across tenants. Each school is its own D1 database here and the
    // control database keeps no membership table, so only home is listed.
    const items = c.id.institution ? [{ id: c.id.institution.id, name: c.id.institution.name, is_home: true }] : []
    return ok({ items })
  })
}

/** internal/auth/daycode.go: HMAC-SHA256 of the school-local date, six digits. */
async function dayCodeState(secret: ArrayBuffer | null, tz: string): Promise<Record<string, unknown>> {
  if (!secret || secret.byteLength === 0) return { enabled: false }
  const nowD = new Date()
  const p = partsIn(tz, nowD)
  const day = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sum = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(day)))
  const n = (((sum[0] << 24) | (sum[1] << 16) | (sum[2] << 8) | sum[3]) >>> 0) % 1_000_000
  // End of the school-local day as a UTC instant.
  const localMidnightAsUtc = Date.UTC(p.y, p.m - 1, p.d + 1, 0, 0, 0)
  const nowAsLocalUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss)
  const expires = new Date(nowD.getTime() + (localMidnightAsUtc - nowAsLocalUtc))
  return { enabled: true, code: String(n).padStart(6, '0'), date: day, expires_at: expires.toISOString().replace(/\.\d{3}Z$/, 'Z') }
}

// ===================================================================== jobs
function registerJobs(r: Router) {
  /* jobs.go enqueueJob: each type mapped explicitly so a caller cannot invent
     a type or smuggle in another school's id. Type names are the Go wire
     names ('export:build', ...), which is what web/src sends. 202 + poll_url. */
  r.post('/jobs', 'admin.jobs.enqueue', async (c) => {
    const req = await readJSON<{ type?: string; payload?: Record<string, unknown> }>(c.req)
    const p = req.payload ?? {}
    const u = (k: string) => (isUUID(p[k]) ? (p[k] as string) : null)
    const s = (k: string, def: string) => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : def)
    const inst = c.id.institution?.id
    if (!inst) throw forbidden("no school in scope")
    const env = { institution_id: inst, actor_user_id: c.id.userId, job_id: uuid() }
    let payload: Record<string, unknown>
    switch (req.type) {
      case 'reportcard:generate':
        if (!u('exam_id') || !u('section_id')) throw badRequest('exam_id and section_id are required')
        payload = { ...env, exam_id: u('exam_id'), section_id: u('section_id') }; break
      case 'invoice:generate':
        if (!u('fee_structure_id') || !u('academic_year_id')) throw badRequest('fee_structure_id and academic_year_id are required')
        payload = { ...env, fee_structure_id: u('fee_structure_id'), academic_year_id: u('academic_year_id'),
          due_on: new Date(Date.now() + 14 * 86400_000).toISOString() }; break
      case 'fee:reminder_fanout':
        payload = { ...env, overdue_since: now(), template_key: s('template_key', 'fee.overdue') }; break
      case 'bulk:import':
        if (!s('kind', '') || !s('file_key', '')) throw badRequest('kind and file_key are required')
        payload = { ...env, kind: s('kind', ''), file_key: s('file_key', '') }; break
      case 'export:build':
        if (!s('kind', '')) throw badRequest('kind is required')
        payload = { ...env, kind: s('kind', ''), format: s('format', 'csv') }; break
      default:
        throw badRequest('unknown or non-enqueueable job type: ' + (req.type ?? ''))
    }
    const taskId = await enqueue(c.env, req.type, payload, { institution_id: inst })
    return json({
      job_id: env.job_id, task_id: taskId, type: req.type, queue: queueOf(req.type),
      accepted_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), poll_url: '/api/v1/jobs/' + taskId,
    }, 202)
  })
  // inspect.go Stats: counts per queue in the screens' vocabulary.
  r.get('/jobs/queues', 'admin.jobs.read', async (c) => {
    const priority: Record<string, number> = { critical: 6, default: 3, bulk: 2, low: 1 }
    const out: Record<string, Record<string, unknown>> = {}
    const blank = (q: string) => ({ queue: q, size: 0, pending: 0, active: 0, scheduled: 0, retry: 0, archived: 0,
      completed: 0, processed: 0, failed: 0, paused: false, priority: priority[q] ?? 0 })
    for (const q of QUEUES) out[q] = blank(q)
    const rows = (await c.env.CONTROL.prepare('SELECT queue, state, count(*) AS n FROM jobs GROUP BY queue, state')
      .all<{ queue: string; state: string; n: number }>()).results ?? []
    for (const row of rows) {
      const st = (out[row.queue] ??= blank(row.queue)) as Record<string, number>
      if (row.state in st) st[row.state] += row.n
      if (row.state === 'archived') st.failed += row.n
    }
    for (const st of Object.values(out) as Record<string, number>[]) {
      st.size = st.pending + st.active + st.scheduled + st.retry + st.archived
      st.processed = st.completed + st.archived
    }
    return ok({ queues: out })
  })
  // inspect.go Find.
  r.get('/jobs/{id}', 'admin.jobs.read', async (c) => {
    const j = await c.env.CONTROL.prepare('SELECT id, type, state, queue, attempts, max_attempts, last_error FROM jobs WHERE id = ?')
      .bind(c.params.id).first<{ id: string; type: string; state: string; queue: string; attempts: number; max_attempts: number; last_error: string | null }>()
    if (!j) throw new HttpError(404, 'job is unknown or older than the 24h retention window', { code: 'job_not_found' })
    return ok({ id: j.id, type: j.type, state: j.state, queue: j.queue, retried: Math.max(j.attempts - 1, 0),
      max_retry: Math.max(j.max_attempts - 1, 0), ...(j.last_error ? { last_error: j.last_error } : {}) })
  })
}

// ================================================================= workflow
function registerWorkflow(r: Router) {
  r.get('/workflow/approvals', 'auth', getApprovals)
  r.post('/workflow/leave', 'auth', applyForLeave)
  r.post('/workflow/leave/{id}/decide', 'auth', decideLeave)
  r.post('/workflow/concessions/{id}/decide', 'finance.fees.write', decideConcession)
  r.get('/workflow/staff-register', 'hr.attendance.write', async (c) => {
    const on = c.url.searchParams.get('on_date') || today()
    const tz = school(c).timezone
    const rows = await c.db.prepare(`
      SELECT u.id AS user_id, e.employee_code, ${fullName2('e')} AS full_name, sa.status, sa.check_in
        FROM employees e JOIN users u ON u.id = e.user_id
        LEFT JOIN staff_attendance sa ON sa.user_id = u.id AND sa.on_date = ?
       WHERE e.status = 'active' ORDER BY e.employee_code`).bind(on).all()
    return ok({ items: rows.results.map((v) => ({
      user_id: v.user_id, employee_code: v.employee_code, full_name: v.full_name,
      status: v.status ?? undefined, check_in: hhmmIn(tz, v.check_in as string | null) ?? undefined,
    })) })
  })
  r.post('/workflow/staff-attendance', 'hr.attendance.write', markStaffAttendance)
}

const leaveSpan = (from: string, to: string, days: unknown) => {
  const d = Number(days)
  return `${ddMon(from)} to ${ddMon(to)} (${d} day${d === 1 ? '' : 's'})`
}

async function getApprovals(c: Ctx): Promise<Response> {
  const out: Array<Record<string, unknown>> = []
  const canLeave = can(c.id, 'hr.leave.approve')
  if (canLeave || can(c.id, 'access.users.write')) {
    const schoolWide = can(c.id, 'hr.employees.write') || can(c.id, 'access.users.write')
    const rows = await c.db.prepare(`
      SELECT lr.id, COALESCE(NULLIF(${fullName2('e')}, ''), NULLIF(${fullName2('st')}, ''), 'Someone') AS who,
             COALESCE(lt.name, 'Leave') AS kind, lr.from_date, lr.to_date, lr.days, lr.reason, u.full_name AS by, lr.created_at
        FROM leave_requests lr
        LEFT JOIN employees e ON e.id = lr.employee_id
        LEFT JOIN students st ON st.id = lr.student_id
        LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
        LEFT JOIN users u ON u.id = lr.applied_by
       WHERE lr.status = 'pending'
         AND (? OR lr.subject_kind <> 'staff' OR e.department_id IS NULL
              OR EXISTS (SELECT 1 FROM departments d WHERE d.id = e.department_id AND d.head_user_id = ?))
       ORDER BY CAST(lr.days AS REAL) DESC, lr.created_at`).bind(schoolWide ? 1 : 0, c.id.userId).all()
    for (const v of rows.results) {
      out.push({ id: v.id, kind: 'leave', title: `${v.who} - ${v.kind}`, detail: `${leaveSpan(v.from_date as string, v.to_date as string, v.days)}. ${v.reason}`,
        requested_by: v.by ?? undefined, raised_at: isoSec(v.created_at as string), decide_url: `/api/v1/workflow/leave/${v.id}/decide` })
    }
  }
  if (!canLeave) {
    const rows = await c.db.prepare(`
      SELECT lr.id, ${fullName2('st')} AS who, COALESCE(lt.name, 'Leave') AS kind, lr.from_date, lr.to_date, lr.days, lr.reason, u.full_name AS by, lr.created_at
        FROM leave_requests lr
        JOIN students st ON st.id = lr.student_id
        JOIN sections sec ON sec.id = (SELECT e.section_id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
             AND sec.class_teacher_id = ?
        LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
        LEFT JOIN users u ON u.id = lr.applied_by
       WHERE lr.status = 'pending' AND lr.subject_kind = 'student'
       ORDER BY lr.created_at`).bind(c.id.userId).all()
    for (const v of rows.results) {
      out.push({ id: v.id, kind: 'leave', title: `${v.who} - ${v.kind}`, detail: `${leaveSpan(v.from_date as string, v.to_date as string, v.days)}. ${v.reason}`,
        requested_by: v.by ?? undefined, raised_at: isoSec(v.created_at as string), decide_url: `/api/v1/workflow/leave/${v.id}/decide` })
    }
  }
  if (can(c.id, 'academics.attendance.read.all') || canLeave) {
    const rows = await c.db.prepare(`
      SELECT ac.id, ${fullName2('st')} AS who, sa.on_date, ac.from_status, ac.to_status, ac.reason, u.full_name AS by, ac.created_at
        FROM attendance_corrections ac
        JOIN student_attendance sa ON sa.id = ac.attendance_id
        JOIN students st ON st.id = sa.student_id
        LEFT JOIN users u ON u.id = ac.requested_by
       WHERE ac.status = 'pending' ORDER BY ac.created_at`).all()
    for (const v of rows.results) {
      out.push({ id: v.id, kind: 'attendance_correction', title: `${v.who}, attendance on ${ddMon(v.on_date as string)}`,
        detail: `${v.from_status} to ${v.to_status}. ${v.reason}`, requested_by: v.by ?? undefined, raised_at: isoSec(v.created_at as string),
        decide_url: `/api/v1/attendance-workflow/corrections/${v.id}/decide` })
    }
  }
  if (can(c.id, 'admissions.approve')) {
    const rows = await c.db.prepare(`
      SELECT a.id, ${fullName2('a')} AS who, COALESCE(c.name, '') AS class, COALESCE(a.parent_name, '') AS parent,
             COALESCE((SELECT sum(i.amount_paise) FROM fee_structure_items i
                        WHERE i.fee_structure_id = (SELECT fs.id FROM fee_structures fs
                                                     WHERE fs.is_active AND (fs.class_id = a.class_sought OR fs.class_id IS NULL)
                                                     ORDER BY (fs.class_id = a.class_sought) DESC, fs.created_at DESC LIMIT 1)), 0) AS fee,
             COALESCE((SELECT fc.kind FROM fee_concessions fc WHERE fc.application_id = a.id AND fc.status = 'approved'
                        ORDER BY fc.created_at DESC LIMIT 1), '') AS waiver,
             COALESCE(a.decided_at, a.created_at) AS raised
        FROM applications a LEFT JOIN classes c ON c.id = a.class_sought
       WHERE a.status = 'offered' AND a.student_id IS NULL AND a.enrolment_approved_at IS NULL
       ORDER BY a.decided_at IS NULL, a.decided_at`).all()
    for (const v of rows.results) {
      let detail = v.class as string
      if (v.parent) detail += `, parent ${v.parent}`
      const fee = num(v.fee)
      if (fee > 0) detail += `. Fee ${Math.trunc(fee / 100)}`
      if (v.waiver) detail += `, with an approved ${String(v.waiver).replace(/_/g, ' ')} concession`
      out.push({ id: v.id, kind: 'admission', title: `${v.who} joining ${v.class}`, detail, raised_at: isoSec(v.raised as string),
        decide_url: `/api/v1/admissions/workflow/pending-admissions/${v.id}/decide` })
    }
  }
  if (can(c.id, 'finance.fees.write')) {
    const rows = await c.db.prepare(`
      SELECT fc.id, COALESCE(NULLIF(${fullName2('st')}, ''), ${fullName2('ap')}) AS who, fc.kind, COALESCE(fc.reason, '') AS reason,
             fc.amount_paise, fc.created_at
        FROM fee_concessions fc
        LEFT JOIN students st ON st.id = fc.student_id
        LEFT JOIN applications ap ON ap.id = fc.application_id
       WHERE fc.status = 'pending' AND (st.id IS NOT NULL OR ap.id IS NOT NULL)
       ORDER BY fc.created_at`).all()
    for (const v of rows.results) {
      out.push({ id: v.id, kind: 'fee_concession', title: `${v.who} - ${v.kind} concession`, detail: v.reason, raised_at: isoSec(v.created_at as string),
        amount_paise: v.amount_paise ?? undefined, decide_url: `/api/v1/workflow/concessions/${v.id}/decide` })
    }
  }
  const byKind: Record<string, number> = {}
  for (const a of out) byKind[a.kind as string] = (byKind[a.kind as string] ?? 0) + 1
  return ok({ items: out, total: out.length, by_kind: byKind })
}

async function applyForLeave(c: Ctx): Promise<Response> {
  const inst = c.id.institution!.id
  const req = await readJSON<{ leave_type_id?: string; from_date?: string; to_date?: string; is_half_day?: boolean; reason?: string; student_id?: string; employee_id?: string }>(c.req)
  const from = req.from_date ?? '', to = req.to_date ?? ''
  if (!isDate(from)) throw badRequest('from_date must be YYYY-MM-DD')
  if (!isDate(to)) throw badRequest('to_date must be YYYY-MM-DD')
  if (to < from) throw badRequest('the leave ends before it starts')
  const reason = req.reason ?? ''
  if (!reason.trim()) throw badRequest('a reason is required')
  let days = (Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / 86_400_000 + 1
  if (req.is_half_day) days = 0.5
  const res = await resolveScope(c)

  const haveTypes = await c.db.prepare('SELECT EXISTS (SELECT 1 FROM leave_types) AS x').first<{ x: number }>()
  const leaveType = nul(trim(req.leave_type_id))
  if (haveTypes?.x && !leaveType) {
    throw badRequest('choose the kind of leave. Casual, sick, or whichever it is. It decides what the days are counted against.')
  }
  let employeeId: string | null = null, studentId: string | null = null
  if (req.student_id) {
    if (!isUUID(req.student_id) || !ownsStudent(res, req.student_id)) throw notFound('resource not found')
    studentId = req.student_id
  } else if (trim(req.employee_id)) {
    if (!can(c.id, 'hr.leave.approve') && !can(c.id, 'hr.employees.write')) {
      throw forbidden('filing leave for somebody else is the same authority as approving it, and this account does not have it')
    }
    const eid = trim(req.employee_id)
    const row = isUUID(eid) ? await c.db.prepare(`SELECT id FROM employees WHERE id = ? AND status = 'active'`).bind(eid).first<{ id: string }>() : null
    if (!row) throw badRequest('no member of staff on the roll with that id')
    employeeId = row.id
  } else {
    const row = await c.db.prepare('SELECT id FROM employees WHERE user_id = ?').bind(c.id.userId).first<{ id: string }>()
    if (!row) throw badRequest('your account is not linked to an employee record, so it cannot apply for staff leave')
    employeeId = row.id
  }
  const kind = studentId ? 'student' : 'staff'

  // Trigger leave_requests_obey_policy (migrations/00031_hr_lifecycle.sql).
  if (kind === 'staff' && leaveType) {
    const rule = await c.db.prepare('SELECT allow_half_day, max_consecutive_days, notice_days, applies_to_gender FROM leave_policy_rules WHERE leave_type_id = ?')
      .bind(leaveType).first<{ allow_half_day: number; max_consecutive_days: string | null; notice_days: number; applies_to_gender: string | null }>()
    if (rule) {
      const policy = (m: string) => new HttpError(400, m, { code: 'check_violation' })
      if (req.is_half_day && !bool(rule.allow_half_day)) throw policy('this leave type cannot be taken as a half day')
      if (rule.max_consecutive_days !== null && days > Number(rule.max_consecutive_days)) throw policy(`at most ${Number(rule.max_consecutive_days)} consecutive day(s) of this leave may be taken`)
      if (rule.notice_days > 0) {
        const t = new Date(today() + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + rule.notice_days)
        if (from < t.toISOString().slice(0, 10)) throw policy(`this leave needs ${rule.notice_days} day(s) notice`)
      }
      if (rule.applies_to_gender !== null) {
        const g = await c.db.prepare('SELECT gender FROM employees WHERE id = ?').bind(employeeId).first<{ gender: string | null }>()
        if ((g?.gender ?? null) !== rule.applies_to_gender) throw policy(`this leave type is available to ${rule.applies_to_gender} staff only`)
      }
    }
  }

  const newId = uuid()
  const stmts: D1PreparedStatement[] = [
    c.db.prepare(`INSERT INTO leave_requests (id, institution_id, leave_type_id, subject_kind, employee_id, student_id, from_date, to_date,
                    is_half_day, days, reason, status, applied_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
      .bind(newId, inst, leaveType, kind, employeeId, studentId, from, to, req.is_half_day ? 1 : 0, String(days), reason, c.id.userId, now()),
  ]
  if (kind === 'staff') {
    const who = await c.db.prepare('SELECT full_name FROM users WHERE id = ?').bind(c.id.userId).first<{ full_name: string }>()
    const approvers = await c.db.prepare(`
      SELECT DISTINCT u.id FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE u.institution_id = ? AND u.status = 'active' AND u.id <> ? AND rp.permission_key = 'hr.leave.approve'`).bind(inst, c.id.userId).all<{ id: string }>()
    const span = to !== from ? `${from} to ${to}` : from
    for (const a of approvers.results) {
      stmts.push(notifyStmt(c, a.id, null, 'leave_request', `${who?.full_name ?? c.id.fullName} has applied for leave`,
        `${span} - ${reason}. Approve or reject it from Approvals.`, '/go/approvals/approvals', 'leave_request', newId))
    }
  }
  await c.db.batch(stmts)
  return created({ id: newId, days, status: 'pending' })
}

async function decideLeave(c: Ctx): Promise<Response> {
  const lid = c.params.id
  if (!isUUID(lid)) throw badRequest('invalid leave request id')
  const req = await readJSON<{ decision?: string; note?: string }>(c.req)
  if (req.decision !== 'approved' && req.decision !== 'rejected') throw badRequest('decision must be approved or rejected')
  const note = req.note ?? ''

  // The guard is part of the read: HR answers anything, a class teacher only
  // their own students' requests.
  const row = await c.db.prepare(`
    SELECT lr.employee_id, lr.leave_type_id, lr.days, lr.applied_by FROM leave_requests lr
     WHERE lr.id = ? AND lr.status = 'pending'
       AND (? OR EXISTS (SELECT 1 FROM students st
                          JOIN sections sec ON sec.id = (SELECT e.section_id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
                         WHERE st.id = lr.student_id AND sec.class_teacher_id = ?))`)
    .bind(lid, can(c.id, 'hr.leave.approve') ? 1 : 0, c.id.userId)
    .first<{ employee_id: string | null; leave_type_id: string | null; days: string; applied_by: string | null }>()
  if (!row) {
    const cur = await c.db.prepare(`SELECT lr.status, COALESCE(u.full_name, '') AS decider, lr.decided_at
                                     FROM leave_requests lr LEFT JOIN users u ON u.id = lr.decided_by WHERE lr.id = ?`).bind(lid)
      .first<{ status: string; decider: string; decided_at: string | null }>()
    if (!cur) throw new HttpError(404, 'no leave request with that id', { code: 'not_found' })
    if (cur.status !== 'pending') {
      const answer = cur.status === 'approved' ? 'approved' : cur.status === 'rejected' ? 'rejected' : 'answered'
      let msg = `this request was already ${answer}`
      if (cur.decider) msg += ` by ${cur.decider}`
      if (cur.decided_at) {
        const p = partsIn(c.id.institution!.timezone, new Date(cur.decided_at))
        const h12 = p.hh % 12 === 0 ? 12 : p.hh % 12
        msg += ` at ${h12}:${String(p.mm).padStart(2, '0')} ${p.hh < 12 ? 'am' : 'pm'} on ${p.d} ${MONTHS[p.m - 1]}`
      }
      throw new HttpError(409, msg + '. Nothing was changed.', { code: 'already_decided' })
    }
    throw new HttpError(403, "this request is not yours to answer. It belongs to that student's class teacher.", { code: 'not_your_request' })
  }
  const stmts: D1PreparedStatement[] = [
    c.db.prepare(`UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = COALESCE(?, decision_note) WHERE id = ? AND status = 'pending'`)
      .bind(req.decision, c.id.userId, now(), nul(note), lid),
  ]
  if (row.applied_by) {
    let title = 'Your leave was approved', body = `Approved by ${c.id.fullName}.`
    if (req.decision !== 'approved') { title = 'Your leave was not approved'; body = `Rejected by ${c.id.fullName}.` }
    if (note.trim()) body += ' ' + note.trim()
    stmts.push(notifyStmt(c, row.applied_by, null, 'leave_decided', title, body, '/go/my_profile/leave_self_service', 'leave_request', lid))
  }
  if (req.decision === 'approved' && row.employee_id && row.leave_type_id) {
    stmts.push(c.db.prepare(`UPDATE leave_balances SET taken = CAST(CAST(taken AS REAL) + ? AS TEXT) WHERE employee_id = ? AND leave_type_id = ?`)
      .bind(Number(row.days), row.employee_id, row.leave_type_id))
  }
  await c.db.batch(stmts)
  return ok({ id: lid, status: req.decision })
}

async function decideConcession(c: Ctx): Promise<Response> {
  const cid = c.params.id
  if (!isUUID(cid)) throw badRequest('invalid concession id')
  const req = await readJSON<{ decision?: string; note?: string }>(c.req)
  const note = trim(req.note)
  if (req.decision === 'rejected' && !note) throw badRequest('say why it was refused, it goes on the record and the family is told')
  const status = req.decision === 'rejected' ? 'rejected' : 'approved'
  const row = await c.db.prepare(`SELECT student_id, application_id, kind, requested_by FROM fee_concessions WHERE id = ? AND status = 'pending'`).bind(cid)
    .first<{ student_id: string | null; application_id: string | null; kind: string; requested_by: string | null }>()
  if (!row) throw new HttpError(404, 'no pending concession with that id', { code: 'not_found' })
  let studentName = 'This request'
  if (row.student_id) {
    const s = await c.db.prepare(`SELECT ${fullName2('students')} AS n FROM students WHERE id = ?`).bind(row.student_id).first<{ n: string }>()
    if (!s) throw notFound('resource not found')
    studentName = s.n
  } else if (row.application_id) {
    const a = await c.db.prepare(`SELECT ${fullName2('applications')} AS n FROM applications WHERE id = ?`).bind(row.application_id).first<{ n: string }>()
    if (!a) throw notFound('resource not found')
    studentName = a.n
  }
  const ts = now()
  const stmts: D1PreparedStatement[] = [
    c.db.prepare(`UPDATE fee_concessions SET status = ?, approved_by = ?, approved_at = ?, decided_at = ?, decision_note = NULLIF(?, '') WHERE id = ? AND status = 'pending'`)
      .bind(status, c.id.userId, status === 'rejected' ? null : ts, ts, note, cid),
  ]
  const word = status === 'rejected' ? 'not approved' : 'approved'
  let body = `${studentName} · ${row.kind} concession ${word}.`
  if (note) body += ' ' + note
  if (row.requested_by && row.requested_by !== c.id.userId) {
    stmts.push(notifyStmt(c, row.requested_by, row.student_id, 'fee_concession', `Concession ${word}`, body, '/go/concessions', 'concession', cid))
  }
  await c.db.batch(stmts)
  return ok({ id: cid, status: req.decision })
}

const staffStatuses = new Set(['present', 'absent', 'late', 'half_day', 'leave', 'holiday', 'week_off'])

async function markStaffAttendance(c: Ctx): Promise<Response> {
  const inst = c.id.institution!.id
  const req = await readJSON<{ on_date?: string; entries?: Array<{ user_id: string; status: string; check_in?: string; check_out?: string }> }>(c.req)
  const onDate = req.on_date || today()
  if (!isDate(onDate)) throw badRequest('on_date must be YYYY-MM-DD')
  const entries = req.entries ?? []
  if (!entries.length) throw badRequest('entries must not be empty')
  for (const e of entries) {
    if (!staffStatuses.has(e.status)) throw badRequest('invalid status: ' + e.status)
    if (!isUUID(e.user_id)) throw badRequest('user_id must be a uuid')
  }
  const campus = await ensureCampus(c)
  await requireOpenMonth(c, onDate)
  const tz = c.id.institution!.timezone
  const stmts = entries.map((e) => c.db.prepare(`
    INSERT INTO staff_attendance (id, institution_id, campus_id, user_id, on_date, status, check_in, check_out, source, marked_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,'manual',?,?)
    ON CONFLICT (user_id, on_date) DO UPDATE SET status = excluded.status, check_in = excluded.check_in,
      check_out = excluded.check_out, marked_by = excluded.marked_by`)
    .bind(uuid(), inst, campus, e.user_id, onDate, e.status,
      e.check_in ? localToUtc(tz, onDate, e.check_in) : null, e.check_out ? localToUtc(tz, onDate, e.check_out) : null, c.id.userId, now()))
  await c.db.batch(stmts)
  return ok({ on_date: onDate, written: entries.length })
}

// ================================================================= homework
function registerHomework(r: Router) {
  r.get('/homework', 'auth', listHomework)
  r.post('/homework', 'academics.homework.write', publishHomework)
  r.post('/homework/{id}/submit', 'auth', submitHomework)
  r.get('/homework/{id}/submissions', 'auth', listHomeworkSubmissions)
}

async function publishHomework(c: Ctx): Promise<Response> {
  const inst = c.id.institution!.id
  const req = await readJSON<{ section_id?: string; class_subject_id?: string; subject_id?: string; kind?: string; title?: string; instructions?: string;
    due_on?: string; max_marks?: number | null; allow_submission?: boolean | null; file_ids?: string[] }>(c.req)
  const sectionId = req.section_id ?? ''
  if (!isUUID(sectionId)) throw badRequest('section_id must be a uuid')
  const title = req.title ?? ''
  if (!title.trim()) throw badRequest('a title is required')
  const kind = req.kind || 'homework'
  const res = await resolveScope(c)
  if (!canMarkSection(res, sectionId)) throw forbidden('missing permission: homework for this section')
  const allow = req.allow_submission ?? true

  let classSubject: string | null = nul(req.class_subject_id ?? '')
  if (!req.class_subject_id && req.subject_id) {
    const cs = await c.db.prepare(`SELECT cs.id FROM class_subjects cs JOIN sections sec ON sec.class_id = cs.class_id
                                    WHERE sec.id = ? AND cs.subject_id = ? LIMIT 1`).bind(sectionId, req.subject_id).first<{ id: string }>()
    if (!cs) throw badRequest("that subject is not on this class's timetable")
    classSubject = cs.id
  }
  const newId = uuid()
  const ts = now()
  const stmts: D1PreparedStatement[] = [
    c.db.prepare(`INSERT INTO homework (id, institution_id, section_id, class_subject_id, kind, title, instructions, assigned_on, due_on, max_marks,
                    is_published, allow_submission, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`)
      .bind(newId, inst, sectionId, classSubject, kind, title, nul(req.instructions ?? ''), today(), nul(req.due_on ?? ''),
        req.max_marks === null || req.max_marks === undefined ? null : String(req.max_marks), allow ? 1 : 0, c.id.userId, ts, ts),
  ]
  for (const fid of req.file_ids ?? []) {
    if (!trim(fid) || !isUUID(fid)) continue
    stmts.push(c.db.prepare(`INSERT INTO homework_attachments (id, institution_id, homework_id, file_id)
      SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM files WHERE id = ? AND deleted_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM homework_attachments WHERE homework_id = ? AND file_id = ?)`).bind(uuid(), inst, newId, fid, fid, newId, fid))
  }
  const due = trim(req.due_on) || 'no date given'
  const targets = await c.db.prepare(`
    SELECT DISTINCT g.user_id AS uid, st.id AS student, ${fullName2('st')} AS name
      FROM enrollments e
      JOIN students st ON st.id = e.student_id AND st.status = 'active'
      JOIN student_guardians sg ON sg.student_id = st.id
      JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL
     WHERE e.section_id = ? AND e.status = 'active'`).bind(sectionId).all<{ uid: string; student: string; name: string }>()
  const label = kind === 'classwork' ? 'Classwork' : 'Homework'
  for (const t of targets.results) {
    stmts.push(notifyStmt(c, t.uid, t.student, 'homework', `${label} set for ${t.name}`, `${title}, due ${due}`, '/go/homework', 'homework', newId))
  }
  await c.db.batch(stmts)
  // The homework.set email (Go: TypeMessageSend); a failed enqueue is logged, nothing fails.
  if (targets.results.length) {
    const subject = classSubject ? (await c.db.prepare(`SELECT sub.name FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id WHERE cs.id = ?`)
      .bind(classSubject).first<{ name: string }>())?.name ?? '' : ''
    try {
      await enqueueMessageSends(c.env, inst, targets.results.map((t) => ({ channel: 'email', template_key: 'homework.set', to_user_id: t.uid,
        vars: { student_name: t.name, subject, title: req.title, due_on: due } })))
    } catch (e) { console.warn('homework email not queued', e) }
  }
  return created({ id: newId, title })
}

async function listHomework(c: Ctx): Promise<Response> {
  const res = await resolveScope(c)
  const mine = res.studentIds
  const ml = inList('hs.student_id', mine)
  const mineSub = mine.length ? ml.sql : 'FALSE'
  const mineArgs = () => [...ml.args]

  let where: string
  const args: unknown[] = []
  if (mine.length) {
    const x = inList('e.student_id', mine)
    where = `h.section_id IN (SELECT e.section_id FROM enrollments e WHERE ${x.sql} AND e.status = 'active')`
    args.push(...x.args)
  } else if (res.allAttendance) where = 'TRUE'
  else if (res.sectionIds.length) { const x = inList('h.section_id', res.sectionIds); where = x.sql; args.push(...x.args) }
  else where = 'FALSE'

  const q = c.url.searchParams
  const filter = (clause: string, value: string | null) => { if (!trim(value)) return; args.push(value); where += ' AND ' + clause }
  filter('h.section_id = ?', q.get('section_id'))
  filter('sec.class_id = ?', q.get('class_id'))
  filter('cs.subject_id = ?', q.get('subject_id'))
  filter('h.kind = ?', q.get('kind'))
  filter('h.assigned_on >= ?', q.get('from'))
  filter('h.assigned_on <= ?', q.get('to'))
  const forcedMine = res.classTeacherOf.length === 0 && !res.anySection && !res.platformAdmin
  if (q.get('mine') === '1' || (forcedMine && mine.length === 0)) { args.push(c.id.userId); where += ' AND h.created_by = ?' }

  const rows = await c.db.prepare(`
    SELECT h.id, h.title, h.kind, sub.name AS subject, c.name AS class_name, sec.name AS section_name,
           h.assigned_on, h.due_on, h.instructions,
           (h.due_on IS NOT NULL AND h.due_on < ?) AS overdue,
           (SELECT count(*) FROM homework_submissions hs WHERE hs.homework_id = h.id) AS submissions,
           (SELECT count(*) FROM enrollments e WHERE e.section_id = h.section_id AND e.status = 'active') AS strength,
           EXISTS (SELECT 1 FROM homework_submissions hs WHERE hs.homework_id = h.id AND ${mineSub}) AS submitted,
           u.full_name AS teacher,
           COALESCE((SELECT json_group_array(json_object('file_id', id, 'name', name, 'content_type', content_type, 'size_bytes', size_bytes))
                       FROM (SELECT f.id, f.original_name AS name, f.content_type, f.size_bytes
                               FROM homework_attachments ha JOIN files f ON f.id = ha.file_id AND f.deleted_at IS NULL
                              WHERE ha.homework_id = h.id ORDER BY f.created_at)), '[]') AS files,
           (SELECT hs.text_answer FROM homework_submissions hs WHERE hs.homework_id = h.id AND ${mineSub}
             ORDER BY hs.submitted_at IS NULL, hs.submitted_at DESC LIMIT 1) AS my_answer,
           (SELECT hs.file_id FROM homework_submissions hs WHERE hs.homework_id = h.id AND ${mineSub}
             ORDER BY hs.submitted_at IS NULL, hs.submitted_at DESC LIMIT 1) AS my_file_id,
           (SELECT f2.original_name FROM homework_submissions hs JOIN files f2 ON f2.id = hs.file_id AND f2.deleted_at IS NULL
             WHERE hs.homework_id = h.id AND ${mineSub} ORDER BY hs.submitted_at IS NULL, hs.submitted_at DESC LIMIT 1) AS my_file_name
      FROM homework h
      JOIN sections sec ON sec.id = h.section_id
      JOIN classes c ON c.id = sec.class_id
      LEFT JOIN class_subjects cs ON cs.id = h.class_subject_id
      LEFT JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN users u ON u.id = h.created_by
     WHERE h.is_published AND ${where}
     ORDER BY h.assigned_on DESC, h.due_on IS NULL, h.due_on
     LIMIT 100`).bind(today(), ...mineArgs(), ...mineArgs(), ...mineArgs(), ...mineArgs(), ...args).all()
  return ok({ items: rows.results.map((v) => {
    let files: unknown[] = []
    try { files = JSON.parse(v.files as string) } catch { files = [] }
    return {
      id: v.id, title: v.title, kind: v.kind, subject: v.subject ?? undefined, class_name: v.class_name ?? undefined,
      section_name: v.section_name ?? undefined, assigned_on: v.assigned_on, due_on: v.due_on ?? undefined,
      instructions: v.instructions ?? undefined, overdue: bool(v.overdue), submissions: num(v.submissions), strength: num(v.strength),
      files: files.length ? files : undefined, my_answer: v.my_answer ?? undefined, my_file_id: v.my_file_id ?? undefined,
      my_file_name: v.my_file_name ?? undefined, submitted: bool(v.submitted), teacher: v.teacher ?? undefined,
    }
  }) })
}

async function submitHomework(c: Ctx): Promise<Response> {
  const hid = uuidParam(c.params.id)
  let req: { student_id?: string; text_answer?: string; file_id?: string } = {}
  if (c.req.headers.get('content-length') !== '0' && c.req.body) {
    const text = await c.req.text()
    if (text.length) { try { req = JSON.parse(text) } catch { throw badRequest('malformed JSON body') } }
  }
  const res = await resolveScope(c)
  if (res.studentIds.length === 0) throw forbidden('only a student or their guardian can turn homework in.')
  let target = res.studentIds[0]
  if (req.student_id) {
    if (!isUUID(req.student_id) || !ownsStudent(res, req.student_id)) throw notFound('resource not found')
    target = req.student_id
  }
  const fileId = req.file_id && isUUID(req.file_id) ? req.file_id : null
  const stmts: D1PreparedStatement[] = [
    c.db.prepare(`INSERT INTO homework_submissions (id, institution_id, homework_id, student_id, submitted_at, text_answer, file_id, status, submitted_by)
      VALUES (?,?,?,?,?,?,?,'submitted',?)
      ON CONFLICT (homework_id, student_id) DO UPDATE SET submitted_at = excluded.submitted_at, submitted_by = excluded.submitted_by,
        text_answer = excluded.text_answer, file_id = COALESCE(excluded.file_id, homework_submissions.file_id), status = 'submitted'`)
      .bind(uuid(), c.id.institution!.id, hid, target, now(), nul(req.text_answer ?? ''), fileId, c.id.userId),
  ]
  const hw = await c.db.prepare(`SELECT h.created_by AS teacher, h.title, ${fullName2('st')} AS child FROM homework h, students st WHERE h.id = ? AND st.id = ?`)
    .bind(hid, target).first<{ teacher: string | null; title: string; child: string }>()
  if (!hw) throw notFound('resource not found')
  if (hw.teacher && hw.teacher !== c.id.userId) {
    const d = new Date()
    stmts.push(notifyStmt(c, hw.teacher, target, 'homework_submitted', `${hw.child} turned in ${hw.title}`,
      `Submitted ${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]}. Open the diary to mark it.`, '/faculty/teaching/homework_classwork', 'homework', hid))
  }
  await c.db.batch(stmts)
  return ok({ submitted: true })
}

async function listHomeworkSubmissions(c: Ctx): Promise<Response> {
  const hid = c.params.id
  if (!isUUID(hid)) throw badRequest('invalid homework id')
  const res = await resolveScope(c)
  const hw = await c.db.prepare('SELECT section_id FROM homework WHERE id = ?').bind(hid).first<{ section_id: string }>()
  if (!hw) throw notFound('resource not found')
  if (!res.allAttendance && !canMarkSection(res, hw.section_id)) throw forbidden('missing permission: the submission register for this section')
  const rows = await c.db.prepare(`
    SELECT st.id AS student_id, CAST(e.roll_no AS TEXT) AS roll_no, ${fullName2('st')} AS full_name, COALESCE(hs.status, 'pending') AS status,
           substr(hs.submitted_at, 1, 16) AS submitted_at, hs.text_answer, hs.file_id, f.original_name AS file_name,
           CASE WHEN hs.submitted_by IS NOT NULL AND hs.submitted_by <> st.user_id THEN sub.full_name END AS submitted_by
      FROM enrollments e
      JOIN students st ON st.id = e.student_id
      LEFT JOIN homework_submissions hs ON hs.homework_id = ? AND hs.student_id = st.id
      LEFT JOIN files f ON f.id = hs.file_id AND f.deleted_at IS NULL
      LEFT JOIN users sub ON sub.id = hs.submitted_by
     WHERE e.section_id = ? AND e.status = 'active'
     ORDER BY e.roll_no IS NULL, e.roll_no, st.first_name`).bind(hid, hw.section_id).all()
  return ok({ items: rows.results.map((v) => ({
    student_id: v.student_id, roll_no: v.roll_no ?? undefined, full_name: v.full_name, status: v.status,
    submitted_at: v.submitted_at ?? undefined, text_answer: v.text_answer ?? undefined, file_id: v.file_id ?? undefined,
    file_name: v.file_name ?? undefined, submitted_by: v.submitted_by ?? undefined,
  })) })
}
