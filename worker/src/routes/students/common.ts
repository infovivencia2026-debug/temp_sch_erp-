import type { Ctx } from '../../router'
import { HttpError, badRequest, uuid, now } from '../../http'
import { school } from '../school'

/* Helpers shared by the /students, /syllabus and /academics ports.

   Everything here mirrors a Go helper the handlers leaned on: the scope
   resolver (internal/scope), workingYear, notify, fees.NextNumber,
   ensureCampus, the India-time date helpers and the error shapes. */

// --- errors -------------------------------------------------------------------

/** httpx.Error with a machine code: {"error": msg, "code": code}. */
export const coded = (status: number, code: string, msg: string) => new HttpError(status, msg, { code })
export const forbiddenMsg = (msg: string) => new HttpError(403, msg, { code: 'forbidden' })
/** A side effect that leaves the database and is not ported. */
export const notImplemented = (what: string) => new HttpError(501, `not implemented in the worker: ${what}`, { code: 'not_implemented' })

export const isUniqueViolation = (err: unknown) => err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
export const isForeignKeyViolation = (err: unknown) => err instanceof Error && /FOREIGN KEY constraint failed/i.test(err.message)

// --- dates (India time, like nowInIndia / indiaToday in Go) -------------------

const IST_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
/** Today's date in Asia/Kolkata as YYYY-MM-DD. */
export const indiaToday = () => IST_FMT.format(new Date())
export const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
/** Adds days to a YYYY-MM-DD date. */
export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
/** Whole days from a to b (b - a). */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000)
/** 0 = Sunday .. 6 = Saturday, like Go's time.Weekday. */
export const weekdayOf = (date: string) => new Date(date + 'T00:00:00Z').getUTCDay()
/** ISO weekday, 1 = Monday .. 7 = Sunday, like extract(isodow). */
export const isodow = (date: string) => { const w = weekdayOf(date); return w === 0 ? 7 : w }
/** 1 June of the academic year containing `date` (academicYearStart in Go). */
export function academicYearStart(date: string): string {
  let y = Number(date.slice(0, 4))
  if (Number(date.slice(5, 7)) < 6) y--
  return `${y}-06-01`
}
/** "2026-27" for a date, like fees.FinancialYear. */
export function financialYear(date: string): string {
  let y = Number(date.slice(0, 4))
  if (Number(date.slice(5, 7)) < 4) y--
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`
}
/** The date range an admin screen defaults to: the academic year (adminWindow in Go). */
export function adminWindow(c: Ctx): [string, string] {
  const q = c.url.searchParams
  let from = (q.get('from') ?? '').trim(), to = (q.get('to') ?? '').trim()
  if (from && to) { if (to < from) [from, to] = [to, from]; return [from, to] }
  const start = academicYearStart(indiaToday())
  return [start, `${Number(start.slice(0, 4)) + 1}-05-31`]
}

// --- small SQL helpers --------------------------------------------------------

export const nullStr = (s: string | null | undefined): string | null => (s === undefined || s === null || s === '' ? null : s)
export const trimOrNull = (s: string | null | undefined) => nullStr((s ?? '').trim())
/** concat_ws(' ', first, middle, last) on a students alias. */
export const fullNameSQL = (a: string) =>
  `trim(replace(${a}.first_name || ' ' || COALESCE(${a}.middle_name,'') || ' ' || COALESCE(${a}.last_name,''), '  ', ' '))`
/** concat_ws(' ', first, last). */
export const shortNameSQL = (a: string) => `trim(${a}.first_name || ' ' || COALESCE(${a}.last_name,''))`
/** The caller's institution id, required on every INSERT. */
export const inst = (c: Ctx) => school(c).id
export const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
export const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
/** Client IP for the audit log. */
export const clientIP = (c: Ctx) => c.req.headers.get('cf-connecting-ip') ?? c.req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null

// --- scope (port of internal/scope) --------------------------------------------

export interface Scope {
  userId: string
  platformAdmin: boolean
  campusIds: string[]
  allCampuses: boolean
  departmentIds: string[]
  sectionIds: string[]
  classTeacherOf: string[]
  studentIds: string[]
  teaches: boolean
  allStudents: boolean
  allAttendance: boolean
  anySection: boolean
}

/** The sections a user reaches: taught, timetabled, class teacher of, or headed department. One `?` = user id, bound 4 times. */
export const SECTION_SET_SQL = `
  SELECT section_id FROM section_subject_teachers WHERE teacher_user_id = ?
  UNION SELECT section_id FROM timetable_entries WHERE teacher_user_id = ?
  UNION SELECT id FROM sections WHERE class_teacher_id = ?
  UNION SELECT DISTINCT te.section_id FROM timetable_entries te
          JOIN employees emp ON emp.user_id = te.teacher_user_id
         WHERE emp.department_id IN (SELECT id FROM departments WHERE head_user_id = ?)`
/** Own student record plus linked children. Two `?` = user id, then today's date. */
export const STUDENT_SET_SQL = `
  SELECT id FROM students WHERE user_id = ?
  UNION SELECT sg.student_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
         WHERE g.user_id = ? AND sg.portal_blocked = 0 AND (sg.access_until IS NULL OR sg.access_until >= ?)`

const scopeMemo = new WeakMap<Ctx, Promise<Scope>>()

export function resolveScope(c: Ctx): Promise<Scope> {
  let p = scopeMemo.get(c)
  if (!p) { p = resolveUncached(c); scopeMemo.set(c, p) }
  return p
}

async function resolveUncached(c: Ctx): Promise<Scope> {
  const u = c.id.userId
  const r: Scope = {
    userId: u, platformAdmin: c.id.platformAdmin, campusIds: [], allCampuses: false, departmentIds: [],
    sectionIds: [], classTeacherOf: [], studentIds: [], teaches: false,
    allStudents: can(c, 'students.read.all'), allAttendance: can(c, 'academics.attendance.read.all'),
    anySection: can(c, 'academics.attendance.write.any'),
  }
  if (c.id.platformAdmin) {
    r.allCampuses = true; r.allStudents = r.allAttendance = r.anySection = true
    return r
  }
  const [campuses, depts, sections, ct, teaches, students] = await c.db.batch([
    c.db.prepare(`SELECT campus_id FROM user_roles WHERE user_id = ?`).bind(u),
    c.db.prepare(`SELECT id FROM departments WHERE head_user_id = ?`).bind(u),
    c.db.prepare(SECTION_SET_SQL).bind(u, u, u, u),
    c.db.prepare(`SELECT id FROM sections WHERE class_teacher_id = ?`).bind(u),
    c.db.prepare(`SELECT (EXISTS (SELECT 1 FROM section_subject_teachers t WHERE t.teacher_user_id = ?)
                       OR EXISTS (SELECT 1 FROM sections s WHERE s.class_teacher_id = ?)) AS t`).bind(u, u),
    c.db.prepare(STUDENT_SET_SQL).bind(u, u, indiaToday()),
  ])
  for (const row of campuses.results as { campus_id: string | null }[]) {
    if (row.campus_id === null) r.allCampuses = true; else r.campusIds.push(row.campus_id)
  }
  r.departmentIds = (depts.results as { id: string }[]).map((x) => x.id)
  r.sectionIds = (sections.results as { section_id: string }[]).map((x) => x.section_id)
  r.classTeacherOf = (ct.results as { id: string }[]).map((x) => x.id)
  r.teaches = !!(teaches.results[0] as { t: number } | undefined)?.t
  r.studentIds = (students.results as { id: string }[]).map((x) => x.id)
  return r
}

export const can = (c: Ctx, perm: string) => (c.id.platformAdmin && !c.id.restricted) || c.id.permissions.has(perm)

/** A SQL predicate with the arguments it binds, appended positionally. */
export interface Pred { sql: string; args: unknown[] }

/**
 * scope.StudentPredicate: TRUE for students.read.all, else "enrolled in a
 * section I reach OR is me / my child", FALSE when neither set has anything.
 * The sets are re-derived in SQL rather than bound as lists, so a large scope
 * never trips D1's bound-parameter limit.
 */
export function studentPredicate(s: Scope, alias: string): Pred {
  if (s.allStudents) return { sql: '1', args: [] }
  const clauses: string[] = []
  const args: unknown[] = []
  if (s.sectionIds.length > 0) {
    clauses.push(`EXISTS (SELECT 1 FROM enrollments se WHERE se.student_id = ${alias}.id AND se.section_id IN (${SECTION_SET_SQL}))`)
    args.push(s.userId, s.userId, s.userId, s.userId)
  }
  if (s.studentIds.length > 0) {
    clauses.push(`${alias}.id IN (${STUDENT_SET_SQL})`)
    args.push(s.userId, s.userId, indiaToday())
  }
  if (clauses.length === 0) return { sql: '0', args: [] }
  return { sql: '(' + clauses.join(' OR ') + ')', args }
}

export const isClassTeacherOf = (s: Scope, sectionId: string) => s.anySection || s.platformAdmin || s.classTeacherOf.includes(sectionId)
export const ownsStudent = (s: Scope, studentId: string) => s.studentIds.includes(studentId)

/** reachesStudent: may the caller touch this child's record. */
export async function reachesStudent(c: Ctx, s: Scope, studentId: string): Promise<boolean> {
  if (s.allStudents || ownsStudent(s, studentId)) return true
  const p = studentPredicate(s, 'st')
  if (p.sql === '0') return false
  const row = await c.db.prepare(`SELECT 1 AS ok FROM students st WHERE st.id = ? AND ${p.sql}`).bind(studentId, ...p.args).first()
  return !!row
}

/** Throws 404 unless the student is inside the caller's scope. */
export async function studentInScope(c: Ctx, studentId: string): Promise<Pred> {
  const p = studentPredicate(await resolveScope(c), 'st')
  const row = await c.db.prepare(`SELECT 1 AS ok FROM students st WHERE st.id = ? AND ${p.sql}`).bind(studentId, ...p.args).first()
  if (!row) throw new HttpError(404, 'resource not found', { code: 'not_found' })
  return p
}

// --- the working year (internal/api/working_year.go) -----------------------------

export const errUnknownYear = () => badRequest('academic_year_id names no academic year of this school')
export const errNoAcademicYear = () => badRequest('no academic year')

/** SQL for the caller's working year; binds one `?` = user id. */
export const workingYearSQL = () => `COALESCE(
  (SELECT y.id FROM user_working_years w JOIN academic_years y ON y.id = w.academic_year_id WHERE w.user_id = ?),
  (SELECT id FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1))`

/** workingYearOr: an explicit year (body, then ?academic_year_id), else the user's chosen year, else the latest. */
export async function workingYear(c: Ctx, explicit = ''): Promise<string> {
  explicit = explicit.trim()
  if (!explicit) explicit = (c.url.searchParams.get('academic_year_id') ?? '').trim()
  return workingYearIn(c, explicit)
}

export async function workingYearIn(c: Ctx, explicit: string): Promise<string> {
  explicit = explicit.trim()
  if (explicit) {
    const row = await c.db.prepare(`SELECT id FROM academic_years WHERE id = ?`).bind(explicit).first<{ id: string }>()
    if (!row) throw errUnknownYear()
    return row.id
  }
  const mine = await c.db.prepare(`SELECT y.id FROM user_working_years w JOIN academic_years y ON y.id = w.academic_year_id WHERE w.user_id = ?`)
    .bind(c.id.userId).first<{ id: string }>()
  if (mine) return mine.id
  const latest = await c.db.prepare(`SELECT id FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1`).first<{ id: string }>()
  if (!latest) throw errNoAcademicYear()
  return latest.id
}

// --- notifications (notify in portal_school_life.go) ------------------------------

/** One in-app notification, deduplicated on (user, kind, source, student) as the Postgres partial index did. */
export function notifyStmt(c: Ctx, userId: string, studentId: string | null, kind: string, title: string, body: string,
  link: string, sourceKind: string, sourceId: string | null): D1PreparedStatement {
  return c.db.prepare(`
    INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, source_kind, source_id, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM notifications n
                        WHERE n.user_id = ? AND n.kind = ? AND n.source_kind IS NOT NULL
                          AND COALESCE(n.source_id,'') = COALESCE(?,'') AND COALESCE(n.student_id,'') = COALESCE(?,''))`)
    .bind(uuid(), inst(c), userId, studentId, kind, title, body, link, sourceKind, sourceId, now(),
      userId, kind, sourceId, studentId)
}

// --- numbering (fees.NextNumber) ---------------------------------------------------

const NUMBER_DEFAULTS: Record<string, string> = { receipt: 'RCPT/', invoice: 'INV/' }

function renderNumber(format: string, prefix: string, fy: string, seq: number, padding: number, suffix: string): string {
  if (!format) format = '{prefix}{fy}/{seq}{suffix}'
  if (!fy) for (const d of ['{fy}/', '{fy}-', '/{fy}', '-{fy}']) format = format.split(d).join('')
  return format.split('{prefix}').join(prefix).split('{fy}').join(fy)
    .split('{seq}').join(String(seq).padStart(padding, '0')).split('{suffix}').join(suffix)
}

/**
 * Allocates the next number in a series. Postgres serialised cashiers with
 * FOR UPDATE inside the caller's transaction; D1 has no interactive
 * transactions, so the counter is advanced in its own batch before the
 * caller writes. A caller that then fails leaves a gap in the series.
 */
export async function nextNumber(c: Ctx, kind: string, on = indiaToday()): Promise<{ text: string; seq: number; fy: string }> {
  const instId = inst(c)
  await c.db.prepare(`INSERT INTO numbering_schemes (id, institution_id, kind, prefix, padding, next_value, reset_yearly, updated_at)
    SELECT ?, ?, ?, ?, 5, 1, 1, ? WHERE NOT EXISTS (SELECT 1 FROM numbering_schemes WHERE institution_id = ? AND kind = ? AND campus_id IS NULL)`)
    .bind(uuid(), instId, kind, NUMBER_DEFAULTS[kind] ?? '', now(), instId, kind).run()
  const s = await c.db.prepare(`SELECT prefix, suffix, padding, next_value, reset_yearly, current_fy, format FROM numbering_schemes
    WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`).bind(instId, kind)
    .first<{ prefix: string; suffix: string; padding: number; next_value: number; reset_yearly: number; current_fy: string | null; format: string }>()
  if (!s) throw new Error(`numbering scheme ${kind} missing`)

  let seq = s.next_value
  let fy = ''
  const stmts: D1PreparedStatement[] = []
  if (s.reset_yearly) {
    fy = financialYear(on)
    let seed = 1
    if (!s.current_fy || s.current_fy === fy) seed = s.next_value
    else if (kind === 'receipt') {
      const last = await c.db.prepare(`SELECT max(receipt_seq) AS m FROM payments WHERE institution_id = ? AND receipt_fy = ?`).bind(instId, fy).first<{ m: number | null }>()
      if (last?.m !== null && last?.m !== undefined) seed = last.m + 1
    }
    await c.db.prepare(`INSERT INTO numbering_fy_counters (institution_id, kind, fy, next_value) SELECT ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM numbering_fy_counters WHERE institution_id = ? AND kind = ? AND fy = ?)`)
      .bind(instId, kind, fy, seed, instId, kind, fy).run()
    const ctr = await c.db.prepare(`SELECT next_value FROM numbering_fy_counters WHERE institution_id = ? AND kind = ? AND fy = ?`)
      .bind(instId, kind, fy).first<{ next_value: number }>()
    seq = ctr!.next_value
    stmts.push(c.db.prepare(`UPDATE numbering_fy_counters SET next_value = ? WHERE institution_id = ? AND kind = ? AND fy = ?`).bind(seq + 1, instId, kind, fy))
  }
  const text = renderNumber(s.format, s.prefix, fy, seq, s.padding, s.suffix)
  if (!s.reset_yearly || !s.current_fy || s.current_fy <= fy) {
    stmts.push(c.db.prepare(`UPDATE numbering_schemes SET next_value = ?, current_fy = ?, last_number = ?, last_issued_at = ?, updated_at = ?
      WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`).bind(seq + 1, nullStr(fy), text, now(), now(), instId, kind))
  } else {
    stmts.push(c.db.prepare(`UPDATE numbering_schemes SET last_number = ?, last_issued_at = ?, updated_at = ? WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`)
      .bind(text, now(), now(), instId, kind))
  }
  await c.db.batch(stmts)
  return { text, seq, fy }
}

// --- campuses and years -------------------------------------------------------------

/** The school's first campus, created if there is none (ensureCampus in setup.go). */
export async function ensureCampus(c: Ctx): Promise<string> {
  const row = await c.db.prepare(`SELECT id FROM campuses ORDER BY created_at LIMIT 1`).first<{ id: string }>()
  if (row) return row.id
  const id = uuid()
  await c.db.prepare(`INSERT INTO campuses (id, institution_id, name, code, created_at, updated_at) VALUES (?, ?, 'Main Campus', 'MAIN', ?, ?)`)
    .bind(id, inst(c), now(), now()).run()
  return id
}

/** A past academic year by name, created around its leading number (ensurePastYear in bulk_import.go). */
export async function ensurePastYear(c: Ctx, campus: string, name: string): Promise<string> {
  const key = name.trim().toLowerCase().replace(/ /g, '')
  const row = await c.db.prepare(`SELECT id FROM academic_years WHERE institution_id = ? AND replace(lower(name),' ','') = ?`)
    .bind(inst(c), key).first<{ id: string }>()
  if (row) return row.id
  const start = key.length >= 4 ? parseInt(key.slice(0, 4), 10) || 0 : 0
  if (start === 0) throw badRequest(`cannot read a year from "${name}". Write it as 2025-26`)
  const id = uuid()
  await c.db.prepare(`INSERT INTO academic_years (id, institution_id, campus_id, name, starts_on, ends_on, is_current, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)`).bind(id, inst(c), campus, name.trim(), `${start}-06-01`, `${start + 1}-03-31`, now()).run()
  return id
}

// --- leaver access (leaver_access.go) -------------------------------------------------

/** Archives a user in the school's database and revokes their sessions in CONTROL. */
export async function endAccess(c: Ctx, userId: string): Promise<void> {
  await c.db.prepare(`UPDATE users SET status = 'archived', updated_at = ? WHERE id = ? AND status <> 'archived'`).bind(now(), userId).run()
  await c.env.CONTROL.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).bind(now(), userId).run()
}

/** endFamilyAccess: the child's login, and each guardian's when this was their last child on the roll. Returns how many. */
export async function endFamilyAccess(c: Ctx, studentId: string): Promise<number> {
  let ended = 0
  const child = await c.db.prepare(`SELECT user_id FROM students WHERE id = ?`).bind(studentId).first<{ user_id: string | null }>()
  if (child?.user_id) { await endAccess(c, child.user_id); ended++ }
  const rows = await c.db.prepare(`
    SELECT DISTINCT g.user_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
     WHERE sg.student_id = ? AND g.user_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM student_guardians sg2 JOIN students st2 ON st2.id = sg2.student_id
                        WHERE sg2.guardian_id = g.id AND sg2.student_id <> ? AND st2.status IN ('active','suspended'))`)
    .bind(studentId, studentId).all<{ user_id: string }>()
  for (const r of rows.results) { await endAccess(c, r.user_id); ended++ }
  return ended
}

// --- custom options (allowsValue in custom_options.go) --------------------------------

const BUILT_IN_OPTIONS: Record<string, string[] | null> = {
  medium: ['telugu', 'english', 'urdu', 'hindi', 'other'],
  blood_group: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'],
  religion: null, mother_tongue: null,
}
export const kindLabels: Record<string, string> = {
  medium: 'Media of instruction', religion: 'Religions', mother_tongue: 'Mother tongues', blood_group: 'Blood groups',
}
export async function allowsValue(c: Ctx, kind: string, value: string): Promise<boolean> {
  if (value === '') return true
  if ((BUILT_IN_OPTIONS[kind] ?? []).includes(value)) return true
  const row = await c.db.prepare(`SELECT 1 AS ok FROM custom_options WHERE kind = ? AND active = 1 AND value = ?`).bind(kind, value).first()
  return !!row
}

// --- misc ---------------------------------------------------------------------------------

export const sameName = (typed: string, actual: string) => {
  const norm = (v: string) => v.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ')
  const t = norm(typed)
  return t !== '' && t === norm(actual)
}

/** Parses a JSON text column into an object, tolerating junk. */
export function parseJSON<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || v === '') return fallback
  try { return JSON.parse(v) as T } catch { return fallback }
}

/** Runs statements atomically and returns the per-statement results. */
export const batch = (c: Ctx, stmts: D1PreparedStatement[]) => c.db.batch(stmts)
