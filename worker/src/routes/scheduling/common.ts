import type { Ctx } from '../../router'
import { HttpError, badRequest, isUUID } from '../../http'

/* Helpers shared by the scheduling block: the timetable desks
   (timetable_ops.go, master_timetable.go), the mid-day meal register
   (mdm.go) and the transport office's tracker screens (bus_tracker*.go,
   bus_tracking_views.go, transport_live_map.go).

   Error bodies follow the Worker's convention ({"error": message, "code"})
   for the session routes; the handset routes in bus_device.ts write Go's
   {"error": {"code", "message"}} themselves because a shipped Android app
   reads that shape. */

/** A side effect that leaves the database (messaging, push, R2). Named in the report. */
export function notImplemented(what: string): never {
  throw new HttpError(501, `not implemented in the Worker: ${what}`)
}

/**
 * A side effect the Go handler treated as best effort (it logged and
 * swallowed the failure). The stub is still called, so it is visible, and
 * its 501 is swallowed exactly as Go swallowed a queue failure.
 */
export function bestEffortStub(what: string): void {
  try { notImplemented(what) } catch (e) { console.warn(e instanceof Error ? e.message : String(e)) }
}

/** httpx.Error with a code, in the Worker's error shape. */
export const coded = (status: number, code: string, msg: string) => new HttpError(status, msg, { code })
/** httpx.Denied: a rule rather than a missing permission. */
export const denied = (msg: string) => new HttpError(403, msg, { code: 'forbidden' })
/** httpx.Forbidden for a named permission. */
export const missingPerm = (perm: string) => new HttpError(403, `missing permission: ${perm}`, { code: 'forbidden' })

export const has = (c: Ctx, perm: string): boolean => (c.id.platformAdmin && !c.id.restricted) || c.id.permissions.has(perm)

export const instId = (c: Ctx): string => {
  const inst = c.id.institution
  if (!inst) throw badRequest("this screen belongs to a school. Sign in against one, or pick a school first - a platform operator's account is not attached to any.")
  return inst.id
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
export const trimStr = (v: unknown): string => str(v).trim()
/** Go's nullString: empty after trimming is NULL. */
export const nullStr = (v: unknown): string | null => { const s = trimStr(v); return s === '' ? null : s }
/** A JSON number the Go struct declared as int, or null when absent. */
export function optInt(v: unknown): number | null {
  if (v === undefined || v === null) return null
  const n = Number(v)
  if (!Number.isFinite(n)) throw badRequest('malformed JSON body')
  return Math.trunc(n)
}
export const intOr = (v: unknown, d = 0): number => optInt(v) ?? d
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v))
export const isUniqueViolation = (e: unknown): boolean => e instanceof Error && /UNIQUE constraint failed/i.test(e.message)

/** `col IN (...)` over a JSON array bound as one parameter, so no list outgrows D1's 100-parameter cap. */
export const inJSON = (col: string) => `${col} IN (SELECT value FROM json_each(?))`

/** Rows D1 returns, typed. */
export async function all<T>(stmt: D1PreparedStatement): Promise<T[]> {
  return (await stmt.all<T>()).results
}

/* --- time in the school's zone ------------------------------------------- */

export const IST_MS = 330 * 60_000
export const nowISO = (): string => new Date().toISOString()
/** A Date whose UTC fields read as Indian wall-clock time. */
export const indiaWall = (t = Date.now()): Date => new Date(t + IST_MS)
export const todayIST = (): string => indiaWall().toISOString().slice(0, 10)
export const istDateOf = (iso: string): string => indiaWall(Date.parse(iso)).toISOString().slice(0, 10)
export const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
export const addDays = (d: string, n: number): string => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10)
/** ISO weekday (1 = Monday) of a YYYY-MM-DD date. */
export const isoDow = (d: string): number => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w === 0 ? 7 : w }
/** to_char(ts AT TIME ZONE 'Asia/Kolkata', fmt) for the formats these screens use. */
export function istFormat(iso: string | null | undefined, fmt: 'datetime' | 'datetime_s' | 'hm' | 'dmon_hm'): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const s = indiaWall(t).toISOString()
  switch (fmt) {
    case 'datetime': return s.slice(0, 16)
    case 'datetime_s': return s.slice(0, 19)
    case 'hm': return s.slice(11, 16)
    case 'dmon_hm': {
      const d = indiaWall(t)
      const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
      return `${String(d.getUTCDate()).padStart(2, '0')} ${mon} ${s.slice(11, 16)}`
    }
  }
}
/** to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'. */
export const utcSeconds = (iso: string | null | undefined): string | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 19) + 'Z'
}
/** RFC 3339 with the offset Go writes for nowInIndia().Format(time.RFC3339). */
export const rfc3339IST = (t = Date.now()): string => indiaWall(t).toISOString().slice(0, 19) + '+05:30'
/** Go time.Parse(time.RFC3339, s): an offset or Z is required. Returns ms or NaN. */
export function parseRFC3339(s: unknown): number {
  if (typeof s !== 'string') return NaN
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.test(s.trim())) return NaN
  return Date.parse(s.trim())
}
/** A Go time.Time formatted with RFC3339 in UTC, as the handset gets its echoes back. */
export const rfc3339UTC = (ms: number): string => new Date(ms).toISOString().slice(0, 19) + 'Z'

/* --- scope ------------------------------------------------------------------ */

/** campusReach (mdm.go): the caller's campus boundary from internal/scope. */
export interface CampusReach { all: boolean; ids: string[] }
export async function campusReach(c: Ctx): Promise<CampusReach> {
  if (c.id.platformAdmin) return { all: true, ids: [] }
  const rows = await all<{ campus_id: string | null }>(c.db.prepare(`SELECT campus_id FROM user_roles WHERE user_id = ?`).bind(c.id.userId))
  const out: CampusReach = { all: false, ids: [] }
  for (const r of rows) {
    if (r.campus_id === null) out.all = true
    else out.ids.push(r.campus_id)
  }
  return out
}
/** allows: a NULL campus is the institution-wide row and needs institution-wide reach. */
export const reachAllows = (re: CampusReach, campus: string | null): boolean => re.all || (campus !== null && re.ids.includes(campus))
/** filter: TRUE, FALSE for an empty reach, or an IN over the campuses. */
export function reachFilter(re: CampusReach, col: string): { sql: string; args: unknown[] } {
  if (re.all) return { sql: '1', args: [] }
  if (re.ids.length === 0) return { sql: '0', args: [] }
  return { sql: inJSON(col), args: [JSON.stringify(re.ids)] }
}

/** resolveRollupScope (admin_rollups.go): everything, or the departments the caller heads. */
export interface Rollup { all: boolean; depts: string[] }
export async function rollupScope(c: Ctx): Promise<Rollup> {
  const everything = c.id.platformAdmin || has(c, 'students.read.all') || has(c, 'academics.attendance.read.all')
  if (everything) return { all: true, depts: [] }
  const rows = await all<{ id: string }>(c.db.prepare(`SELECT id FROM departments WHERE head_user_id = ?`).bind(c.id.userId))
  return { all: false, depts: rows.map((r) => r.id) }
}

export const uuidOr400 = (v: string | undefined, name = 'id'): string => {
  if (!isUUID(v)) throw badRequest(`${name} must be a uuid`)
  return v
}

/** A Go route mounted under a group gate (r.Use) as well as its own: the handler also needs `perm`. */
export const alsoNeeds = (perm: string, h: (c: Ctx) => Promise<Response>) => (c: Ctx): Promise<Response> => {
  if (!has(c, perm)) throw missingPerm(perm)
  return h(c)
}
