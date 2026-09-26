import type { Ctx } from '../../router'
import { HttpError, badRequest, forbidden, now, uuid } from '../../http'
import { can } from '../../identity'

/* Helpers shared by the /admin and misc ports. Nothing here is a route. */

/** Rule 7 of PORTING.md: a side effect that leaves the database is a 501, never a silent no-op. */
export const notImplemented = (what: string) => new HttpError(501, `not implemented on Workers: ${what}`)

/** httpx.RequireAnyPermission: the route is registered with 'auth' and checks here. */
export function requireAny(c: Ctx, ...perms: string[]): void {
  for (const p of perms) if (can(c.id, p)) return
  throw forbidden(perms.join(' or '))
}

/** platformOnly in platform_config.go: a caller who is not platform staff cannot read across schools. */
export function platformOnly(c: Ctx): void {
  if (!c.id.platformAdmin) throw forbidden('only platform staff can read across schools')
}

/** requireInstitution in setup_profile.go, and the school id every INSERT fills. */
export function institutionId(c: Ctx): string {
  if (!c.id.institution) {
    throw badRequest('this screen belongs to a school. Sign in against one, or pick a school first - ' +
      "a platform operator's account is not attached to any.")
  }
  return c.id.institution.id
}

/** The caller's IP, as the Go server read it. */
export const clientIP = (c: Ctx): string | null => c.req.headers.get('cf-connecting-ip')

/**
 * One audit_log row. The Go server wrote most of these from AuditMiddleware
 * on every mutating request; here each handler that changed something
 * appends this statement to its batch.
 */
export function auditStmt(c: Ctx, action: string, entityType: string, entityId: string | null,
  before: unknown = null, after: unknown = null): D1PreparedStatement {
  return c.db.prepare(`INSERT INTO audit_log (institution_id, campus_id, actor_user_id, session_id, action, entity_type, entity_id, before, after, ip, created_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(c.id.institution?.id ?? null, c.id.platformAdmin ? null : c.id.userId, c.id.sessionId, action, entityType, entityId,
      before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), clientIP(c), now())
}

/** `?limit=&offset=` the way most Go list handlers clamp them. */
export function paging(c: Ctx, defLimit = 50, maxLimit = 200): { limit: number; offset: number } {
  const q = c.url.searchParams
  const limit = Math.min(maxLimit, Math.max(1, Number(q.get('limit')) || defLimit))
  const offset = Math.max(0, Number(q.get('offset')) || 0)
  return { limit, offset }
}

/** SQL `IN (?,?,?)` for a list; an empty list yields a predicate that matches nothing. */
export function inList(ids: readonly string[]): { sql: string; args: string[] } {
  if (ids.length === 0) return { sql: '(NULL)', args: [] }
  return { sql: '(SELECT value FROM json_each(?))', args: [JSON.stringify(ids)] }
}

/** Reads a TEXT column that holds JSON; a NULL or broken value is the fallback. */
export function parseJSON<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || s === '') return fallback
  try { return JSON.parse(s) as T } catch { return fallback }
}

/** Today's date in the school's timezone (IST unless the school says otherwise), as YYYY-MM-DD. */
export function today(c: Ctx): string {
  const tz = c.id.institution?.timezone || 'Asia/Kolkata'
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

/** Port of internal/scope.Resolved: the caller's narrow data boundary, loaded once per request. */
export interface Scope {
  userId: string
  platformAdmin: boolean
  campusIds: string[]
  departmentIds: string[]
  sectionIds: string[]
  classTeacherOf: string[]
  studentIds: string[]
  teaches: boolean
  allStudents: boolean
  allAttendance: boolean
  anySection: boolean
  allCampuses: boolean
}

const scopeMemo = new WeakMap<Request, Promise<Scope>>()

/** resolveScope in api.go. Memoised per request like scopeMemo was. */
export function resolveScope(c: Ctx): Promise<Scope> {
  let p = scopeMemo.get(c.req)
  if (!p) { p = resolveUncached(c); scopeMemo.set(c.req, p) }
  return p
}

async function resolveUncached(c: Ctx): Promise<Scope> {
  const r: Scope = {
    userId: c.id.userId, platformAdmin: c.id.platformAdmin,
    campusIds: [], departmentIds: [], sectionIds: [], classTeacherOf: [], studentIds: [], teaches: false,
    allStudents: can(c.id, 'students.read.all'), allAttendance: can(c.id, 'academics.attendance.read.all'),
    anySection: can(c.id, 'academics.attendance.write.any'), allCampuses: false,
  }
  if (c.id.platformAdmin) {
    r.allCampuses = true; r.allStudents = r.allAttendance = r.anySection = true
    return r
  }
  const u = c.id.userId
  const [campuses, depts, sections, ct, students, teaches] = await c.db.batch<Record<string, string | number | null>>([
    c.db.prepare(`SELECT campus_id FROM user_roles WHERE user_id = ?`).bind(u),
    c.db.prepare(`SELECT id FROM departments WHERE head_user_id = ?`).bind(u),
    c.db.prepare(`SELECT section_id AS id FROM section_subject_teachers WHERE teacher_user_id = ?
      UNION SELECT section_id FROM timetable_entries WHERE teacher_user_id = ?
      UNION SELECT id FROM sections WHERE class_teacher_id = ?
      UNION SELECT DISTINCT te.section_id FROM timetable_entries te JOIN employees emp ON emp.user_id = te.teacher_user_id
        WHERE emp.department_id IN (SELECT id FROM departments WHERE head_user_id = ?)`).bind(u, u, u, u),
    c.db.prepare(`SELECT id FROM sections WHERE class_teacher_id = ?`).bind(u),
    c.db.prepare(`SELECT id FROM students WHERE user_id = ?
      UNION SELECT sg.student_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
       WHERE g.user_id = ? AND NOT sg.portal_blocked AND (sg.access_until IS NULL OR sg.access_until >= date('now'))`).bind(u, u),
    c.db.prepare(`SELECT (EXISTS (SELECT 1 FROM section_subject_teachers WHERE teacher_user_id = ?)
      OR EXISTS (SELECT 1 FROM sections WHERE class_teacher_id = ?)) AS t`).bind(u, u),
  ])
  for (const row of campuses.results) {
    if (row.campus_id === null) r.allCampuses = true
    else r.campusIds.push(String(row.campus_id))
  }
  r.departmentIds = depts.results.map((x) => String(x.id))
  r.sectionIds = sections.results.map((x) => String(x.id))
  r.classTeacherOf = ct.results.map((x) => String(x.id))
  r.studentIds = students.results.map((x) => String(x.id))
  r.teaches = !!Number(teaches.results[0]?.t ?? 0)
  return r
}

/** A fresh uuid plus the timestamp most INSERTs need together. */
export const stamp = () => ({ id: uuid(), at: now() })
