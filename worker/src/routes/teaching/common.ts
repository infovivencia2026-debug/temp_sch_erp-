import type { Ctx } from '../../router'
import { HttpError, forbidden, isUUID, notFound, now, uuid } from '../../http'
import { can } from '../../identity'
import { school } from '../school'

/* Shared by every teaching and portal route: the caller's data boundary
   (port of internal/scope), permission checks the single-perm Router cannot
   express, the Indian-time date helpers of daterange.go, and the 501 stub
   for side effects that leave the database. */

/** Throws 501 for a side effect the Worker does not perform (email, SMS, push, R2, PDF, AI). */
export function notImplemented(what: string): never {
  throw new HttpError(501, `not implemented: ${what}`)
}

/** Second gate for routes whose Go group had a nested RequirePermission. */
export function requirePerm(c: Ctx, perm: string): void {
  if (!can(c.id, perm)) throw forbidden()
}
/** Port of httpx.RequireAnyPermission. */
export function requireAny(c: Ctx, ...perms: string[]): void {
  if (!perms.some((p) => can(c.id, p))) throw forbidden()
}

export const institutionId = (c: Ctx): string => school(c).id

// ---------------------------------------------------------------------------
// scope

export interface Scope {
  userId: string
  institutionId: string
  platformAdmin: boolean
  campusIds: string[]
  departmentIds: string[]
  /** Taught, class-teacher-of, or the department's sections (a HOD). */
  sectionIds: string[]
  classTeacherOf: string[]
  /** Own student record plus linked children (portal links honoured). */
  studentIds: string[]
  teaches: boolean
  allStudents: boolean
  allAttendance: boolean
  anySection: boolean
  allCampuses: boolean
}

const cacheKey = Symbol('scope')

/** Port of scope.Resolve, memoised on the request context. */
export async function resolveScope(c: Ctx): Promise<Scope> {
  const holder = c as unknown as Record<symbol, Promise<Scope> | undefined>
  if (!holder[cacheKey]) holder[cacheKey] = resolveUncached(c)
  return holder[cacheKey]!
}

async function resolveUncached(c: Ctx): Promise<Scope> {
  const id = c.id
  const s: Scope = {
    userId: id.userId, institutionId: institutionId(c), platformAdmin: id.platformAdmin,
    campusIds: [], departmentIds: [], sectionIds: [], classTeacherOf: [], studentIds: [], teaches: false,
    allStudents: can(id, 'students.read.all'), allAttendance: can(id, 'academics.attendance.read.all'),
    anySection: can(id, 'academics.attendance.write.any'), allCampuses: false,
  }
  if (id.platformAdmin) {
    s.allCampuses = s.allStudents = s.allAttendance = s.anySection = true
    return s
  }
  const u = id.userId
  const [campuses, depts, own, ct, teaches, students] = await c.db.batch([
    c.db.prepare(`SELECT campus_id FROM user_roles WHERE user_id = ?`).bind(u),
    c.db.prepare(`SELECT id FROM departments WHERE head_user_id = ?`).bind(u),
    c.db.prepare(`SELECT section_id AS id FROM section_subject_teachers WHERE teacher_user_id = ?
                  UNION SELECT section_id FROM timetable_entries WHERE teacher_user_id = ?
                  UNION SELECT id FROM sections WHERE class_teacher_id = ?`).bind(u, u, u),
    c.db.prepare(`SELECT id FROM sections WHERE class_teacher_id = ?`).bind(u),
    c.db.prepare(`SELECT (EXISTS (SELECT 1 FROM section_subject_teachers WHERE teacher_user_id = ?)
                       OR EXISTS (SELECT 1 FROM sections WHERE class_teacher_id = ?)) AS t`).bind(u, u),
    c.db.prepare(`SELECT id FROM students WHERE user_id = ?
                  UNION SELECT sg.student_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
                   WHERE g.user_id = ? AND sg.portal_blocked = 0
                     AND (sg.access_until IS NULL OR sg.access_until >= date('now'))`).bind(u, u),
  ])
  for (const r of campuses.results as { campus_id: string | null }[]) {
    if (r.campus_id === null) s.allCampuses = true
    else s.campusIds.push(r.campus_id)
  }
  s.departmentIds = (depts.results as { id: string }[]).map((r) => r.id)
  s.sectionIds = (own.results as { id: string }[]).map((r) => r.id)
  s.classTeacherOf = (ct.results as { id: string }[]).map((r) => r.id)
  s.teaches = !!(teaches.results[0] as { t: number } | undefined)?.t
  s.studentIds = (students.results as { id: string }[]).map((r) => r.id)
  if (s.departmentIds.length) {
    const ds = await c.db.prepare(`SELECT DISTINCT te.section_id AS id FROM timetable_entries te
        JOIN employees emp ON emp.user_id = te.teacher_user_id WHERE emp.department_id IN (${marks(s.departmentIds)})`)
      .bind(js(s.departmentIds)).all<{ id: string }>()
    for (const r of ds.results) if (!s.sectionIds.includes(r.id)) s.sectionIds.push(r.id)
  }
  return s
}

/** `SELECT value FROM json_each(?)` for `IN (${marks(ids)})`: ONE parameter, bind js(ids). D1 caps a
 *  statement at 100 parameters, so an id list is never spread. */
export const marks = (_ids?: readonly unknown[]): string => 'SELECT value FROM json_each(?)'
/** The single parameter a marks() list binds. */
export const js = (ids: readonly unknown[]): string => JSON.stringify(ids)

/** Port of scope.anyOf: `col IN (?,?)` with args, or a false predicate for an empty set. */
export function inList(column: string, ids: readonly string[]): { sql: string; args: string[] } {
  if (ids.length === 0) return { sql: '0', args: [] }
  return { sql: `${column} IN (SELECT value FROM json_each(?))`, args: [JSON.stringify(ids)] }
}

/** Port of Resolved.Filter for the scopes handlers actually pass. */
export function scopeFilter(s: Scope, kind: 'campus' | 'department' | 'assigned_classes' | 'self' | 'children' | 'institution', column: string) {
  switch (kind) {
    case 'institution': return { sql: '1', args: [] as string[] }
    case 'campus': return s.allCampuses ? { sql: '1', args: [] as string[] } : inList(column, s.campusIds)
    case 'department': return inList(column, s.departmentIds)
    case 'assigned_classes': return inList(column, s.sectionIds)
    default: return inList(column, s.studentIds)
  }
}

/** Port of Resolved.StudentPredicate; `alias` is the students table alias. */
export function studentPredicate(s: Scope, alias: string): { sql: string; args: string[] } {
  if (s.allStudents) return { sql: '1', args: [] }
  const clauses: string[] = []; const args: string[] = []
  if (s.sectionIds.length) {
    clauses.push(`EXISTS (SELECT 1 FROM enrollments se WHERE se.student_id = ${alias}.id AND se.section_id IN (${marks(s.sectionIds)}))`)
    args.push(js(s.sectionIds))
  }
  if (s.studentIds.length) { clauses.push(`${alias}.id IN (${marks(s.studentIds)})`); args.push(js(s.studentIds)) }
  if (!clauses.length) return { sql: '0', args: [] }
  return { sql: '(' + clauses.join(' OR ') + ')', args }
}

/** Port of Resolved.AttendancePredicate; `alias` is the attendance table alias. */
export function attendancePredicate(s: Scope, alias: string): { sql: string; args: string[] } {
  if (s.allAttendance) return { sql: '1', args: [] }
  const clauses: string[] = []; const args: string[] = []
  if (s.sectionIds.length) { clauses.push(`${alias}.section_id IN (${marks(s.sectionIds)})`); args.push(js(s.sectionIds)) }
  if (s.studentIds.length) { clauses.push(`${alias}.student_id IN (${marks(s.studentIds)})`); args.push(js(s.studentIds)) }
  if (!clauses.length) return { sql: '0', args: [] }
  return { sql: '(' + clauses.join(' OR ') + ')', args }
}

/** Port of Resolved.TimetablePredicate. */
export function timetablePredicate(s: Scope, sectionColumn: string): { sql: string; args: string[] } {
  if (s.allAttendance || s.anySection) return { sql: '1', args: [] }
  if (s.sectionIds.length === 0 && s.studentIds.length > 0) {
    return { sql: `${sectionColumn} IN (SELECT e.section_id FROM enrollments e WHERE e.student_id IN (${marks(s.studentIds)}) AND e.status = 'active')`, args: [js(s.studentIds)] }
  }
  return inList(sectionColumn, s.sectionIds)
}

export const isClassTeacherOf = (s: Scope, sectionId: string): boolean =>
  s.anySection || s.platformAdmin || s.classTeacherOf.includes(sectionId)
export const canMarkSection = isClassTeacherOf
export const ownsStudent = (s: Scope, studentId: string): boolean => s.studentIds.includes(studentId)
export const inSections = (s: Scope, sectionId: string): boolean => s.sectionIds.includes(sectionId)

// ---------------------------------------------------------------------------
// portal child resolution (portal_requests.go portalChild, portal_school_life.go familyChildren)

/** The one refusal every ownership failure gets: a 404, never a 403. */
export const notYourChild = () => notFound('not found')

/** Which one child a write is about. Empty picks the only child; anything else must be owned. */
export async function portalChild(c: Ctx, raw: string | null | undefined): Promise<{ scope: Scope; studentId: string }> {
  const scope = await resolveScope(c)
  const v = (raw ?? '').trim()
  if (v === '') {
    if (scope.studentIds.length === 1) return { scope, studentId: scope.studentIds[0] }
    throw notYourChild()
  }
  if (!isUUID(v) || !ownsStudent(scope, v)) throw notYourChild()
  return { scope, studentId: v }
}

/** Which children a read covers: all of them when none is named. */
export async function familyChildren(c: Ctx, raw: string | null | undefined): Promise<{ scope: Scope; studentIds: string[] }> {
  const scope = await resolveScope(c)
  const v = (raw ?? '').trim()
  if (v === '') return { scope, studentIds: scope.studentIds }
  if (!isUUID(v) || !ownsStudent(scope, v)) throw notYourChild()
  return { scope, studentIds: [v] }
}

// ---------------------------------------------------------------------------
// dates, resolved in Asia/Kolkata (daterange.go)

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000

/** A Date whose UTC fields read as Indian wall-clock time. Use getUTC* on it. */
export function nowInIndia(): Date { return new Date(Date.now() + IST_OFFSET_MS) }
const pad = (n: number) => String(n).padStart(2, '0')
/** YYYY-MM-DD of a wall-clock date (see nowInIndia). */
export const ymd = (d: Date): string => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
export const todayIST = (): string => ymd(nowInIndia())
export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000)
export const parseYMD = (s: string | null | undefined): Date | null => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(s + 'T00:00:00Z')
  return Number.isNaN(d.getTime()) ? null : d
}
/** Go's weekday: Sunday 0 .. Saturday 6, in Indian time. */
export const weekdayIST = (): number => nowInIndia().getUTCDay()
/** Go's `2 Jan 2006`. */
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const MONTHS_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December']
export const fmtDMY = (d: Date): string => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`

export interface DateRange { from: Date; to: Date; label: string; period: string; fromS: string; toS: string }
export const rangeJSON = (r: DateRange) => ({ label: r.label, period: r.period, from: r.fromS, to: r.toS })

export function academicYearStart(now: Date): Date {
  let y = now.getUTCFullYear(); if (now.getUTCMonth() + 1 < 6) y--
  return new Date(Date.UTC(y, 5, 1))
}
export function financialYearStart(now: Date): Date {
  let y = now.getUTCFullYear(); if (now.getUTCMonth() + 1 < 4) y--
  return new Date(Date.UTC(y, 3, 1))
}

/** Port of resolveRange: ?period= or ?from=&to=. */
export function resolveRange(c: Ctx): DateRange {
  const now = nowInIndia()
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const q = c.url.searchParams
  let period = q.get('period') ?? ''
  const f = q.get('from'), t = q.get('to')
  if (f && t) {
    let from = parseYMD(f), to = parseYMD(t)
    if (from && to) {
      if (to < from) [from, to] = [to, from]
      return { from, to, period: 'custom', label: fmtDMY(from) + ' to ' + fmtDMY(to), fromS: ymd(from), toS: ymd(to) }
    }
  }
  const mk = (from: Date, to: Date, label: string, p: string): DateRange => ({ from, to, label, period: p, fromS: ymd(from), toS: ymd(to) })
  const yy = (d: Date) => String(d.getUTCFullYear() + 1).slice(2)
  switch (period) {
    case 'today': return mk(today, today, 'Today', 'today')
    case 'yesterday': { const y = addDays(today, -1); return mk(y, y, 'Yesterday', period) }
    case 'last_7': return mk(addDays(today, -6), today, 'Last 7 days', period)
    case 'last_30': return mk(addDays(today, -29), today, 'Last 30 days', period)
    case 'this_week': { const off = (today.getUTCDay() + 6) % 7; return mk(addDays(today, -off), today, 'This week', period) }
    case 'last_month': {
      const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0))
      return mk(first, last, 'Last month - ' + MONTHS_LONG[first.getUTCMonth()] + ' ' + first.getUTCFullYear(), period)
    }
    case 'this_quarter': { const qn = Math.floor(now.getUTCMonth() / 3); return mk(new Date(Date.UTC(now.getUTCFullYear(), qn * 3, 1)), today, 'This quarter', period) }
    case 'this_term': return mk(academicYearStart(now), today, 'This term', period)
    case 'this_year': { const s = academicYearStart(now); return mk(s, today, `This academic year - ${s.getUTCFullYear()}-${yy(s)}`, period) }
    case 'last_year': {
      const s = new Date(Date.UTC(academicYearStart(now).getUTCFullYear() - 1, 5, 1))
      const e = new Date(Date.UTC(s.getUTCFullYear() + 1, 5, 0))
      return mk(s, e, `Last academic year - ${s.getUTCFullYear()}-${yy(s)}`, period)
    }
    case 'fin_year': { const s = financialYearStart(now); return mk(s, today, `Financial year ${s.getUTCFullYear()}-${yy(s)}`, period) }
  }
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  return mk(first, today, 'This month - ' + MONTHS_LONG[first.getUTCMonth()] + ' ' + first.getUTCFullYear(), 'this_month')
}

/** Reads a string field of a JSON body, trimmed; '' when absent. */
export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
export const numOr = (v: unknown, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : def)

// ---------------------------------------------------------------------------
// names and notifications shared by the teaching and portal files

/** Postgres concat_ws(' ', first, middle, last) for a students/employees alias. */
export const fullName = (a: string): string =>
  `trim(${a}.first_name || COALESCE(' ' || ${a}.middle_name, '') || COALESCE(' ' || ${a}.last_name, ''))`
/** Go's trim(first_name || ' ' || COALESCE(last_name,'')). */
export const shortName = (a: string): string => `trim(${a}.first_name || ' ' || COALESCE(${a}.last_name, ''))`

/** Port of notify() in portal_school_life.go: one in-app alert, deduplicated on
    (user, kind, source, student) when it names a source. Returns a statement for a batch. */
export function notifyStmt(c: Ctx, userId: string, studentId: string | null, kind: string, title: string,
  body: string | null, link: string | null, sourceKind: string | null, sourceId: string | null): D1PreparedStatement {
  return c.db.prepare(`INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, source_kind, source_id, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ? IS NULL OR NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = ? AND n.kind = ? AND n.source_kind IS NOT NULL
               AND COALESCE(n.source_id, '') = COALESCE(?, '') AND COALESCE(n.student_id, '') = COALESCE(?, ''))`)
    .bind(uuid(), institutionId(c), userId, studentId, kind, title, body, link, sourceKind, sourceId, now(),
      sourceKind, userId, kind, sourceId, studentId)
}
