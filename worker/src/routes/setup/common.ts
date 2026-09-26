import type { Ctx } from '../../router'
import { HttpError, badRequest, uuid, now } from '../../http'
import { hashPassword } from '../../auth/password'
import { school } from '../school'

/* Helpers shared by every handler of the /setup block. They mirror the
   free functions of internal/api (ensureCampus, workingYear, appointEmployee,
   uniqueUsername, ...) on D1: uuids are minted here, timestamps are ISO UTC,
   and "did the INSERT insert" is answered by a SELECT first because SQLite
   has no xmax. */

/** A side effect that leaves the database. Named in the report. */
export function notImplemented(what: string): never {
  throw new HttpError(501, `${what} is not implemented in the Worker yet`)
}

export const instId = (c: Ctx): string => school(c).id

/** Go's nullString: empty after trimming is NULL. */
export const nullStr = (s: string | null | undefined): string | null => {
  const v = (s ?? '').trim()
  return v === '' ? null : v
}
export const trim = (s: unknown): string => (typeof s === 'string' ? s.trim() : '')
export const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

/** Setup is a school's screen; a platform operator outside one is refused as Go does. */
export function requireInstitution(c: Ctx): void {
  if (!c.id.institution) {
    throw badRequest('this screen belongs to a school. Sign in against one, or pick a school first - ' +
      "a platform operator's account is not attached to any.")
  }
}

export const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Error && /UNIQUE constraint failed/i.test(e.message)
export const uniqueViolationOn = (e: unknown, column: string): boolean =>
  isUniqueViolation(e) && (e as Error).message.includes(column)

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}
export const oneOfStr = (v: string, ...allowed: string[]): boolean => allowed.includes(v)

/* --- time in the school's zone ------------------------------------------- */

const IST_OFFSET_MS = 330 * 60_000

/** A Date whose UTC fields read as Indian wall-clock time. */
export const indiaNow = (): Date => new Date(Date.now() + IST_OFFSET_MS)
export const todayIndia = (): string => indiaNow().toISOString().slice(0, 10)
export const monthIndia = (): string => indiaNow().toISOString().slice(0, 7)

/** HH:MM in Asia/Kolkata for a stored UTC instant, or null. */
export function istClock(iso: string | null | undefined): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const d = new Date(t + IST_OFFSET_MS)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
/** YYYY-MM-DD in Asia/Kolkata for a stored UTC instant. */
export function istDate(iso: string): string {
  return new Date(Date.parse(iso) + IST_OFFSET_MS).toISOString().slice(0, 10)
}
/** A local wall-clock date+time in India, as the UTC instant it names. */
export function istToUTC(date: string, clock: string): string {
  const [h, m, s] = clock.split(':').map((x) => Number(x))
  const base = Date.parse(date + 'T00:00:00Z')
  return new Date(base + ((h * 60 + m) * 60 + (s || 0)) * 1000 - IST_OFFSET_MS).toISOString()
}
/** Minutes since midnight for "HH:MM" or "HH:MM:SS". */
export function clockMinutes(clock: string): number {
  const [h, m] = clock.split(':').map((x) => Number(x))
  return h * 60 + (m || 0)
}
export const isDateOnly = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
export const isClock = (s: string): boolean => /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s)

/* --- campus and year ------------------------------------------------------ */

/** The caller's campus, creating "Main Campus" when the school has none. */
export async function ensureCampus(c: Ctx): Promise<string> {
  const row = await c.db.prepare(`SELECT id FROM campuses ORDER BY created_at LIMIT 1`).first<{ id: string }>()
  if (row) return row.id
  const id = uuid()
  const t = now()
  await c.db.prepare(`INSERT INTO campuses (id, institution_id, name, code, created_at, updated_at) VALUES (?, ?, 'Main Campus', 'MAIN', ?, ?)`)
    .bind(id, instId(c), t, t).run()
  return id
}

/**
 * The year a request works in (internal/api/working_year.go): the one it
 * names (body field, else ?academic_year_id), then the caller's chosen year
 * (user_working_years), then the current/latest one. Null when there is
 * none, or when the named one is not this school's.
 */
export async function workingYearId(c: Ctx, explicit = ''): Promise<string | null> {
  let want = explicit.trim()
  if (want === '') want = (c.url.searchParams.get('academic_year_id') ?? '').trim()
  if (want !== '') {
    const row = await c.db.prepare(`SELECT id FROM academic_years WHERE id = ?`).bind(want).first<{ id: string }>()
    return row?.id ?? null
  }
  const chosen = await c.db.prepare(`SELECT y.id FROM user_working_years w JOIN academic_years y ON y.id = w.academic_year_id WHERE w.user_id = ?`)
    .bind(c.id.userId).first<{ id: string }>()
  if (chosen) return chosen.id
  const latest = await c.db.prepare(`SELECT id FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1`).first<{ id: string }>()
  return latest?.id ?? null
}

/* --- names and codes ------------------------------------------------------ */

export const CLASS_LEVEL_FLOOR = -4
export const CLASS_LEVEL_CEILING = 15

/** The year read out of what the school calls the class (setup.go classLevelFromName). */
export function classLevelFromName(name: string): number {
  const n = name.trim().toLowerCase()
  const pre: Array<[string[], number]> = [
    [['pre-nursery', 'pre nursery', 'playgroup', 'play group'], -4],
    [['nursery', 'pre-kg', 'pre kg', 'prekg'], -3],
    [['lkg', 'l.k.g', 'junior kg', 'jr kg'], -2],
    [['ukg', 'u.k.g', 'senior kg', 'sr kg'], -1],
  ]
  for (const [words, level] of pre) if (words.some((w) => n.includes(w))) return level
  const m = n.match(/\d+/)
  if (!m) return 0
  const v = Number(m[0])
  if (!Number.isInteger(v) || v <= 0 || v > CLASS_LEVEL_CEILING) return 0
  return v
}

/** Initials of a long school name, which is what a receipt has room for. */
export function deriveShortName(name: string): string {
  let out = ''
  for (const word of name.split(/[ ,.\-]+/)) {
    if (!word) continue
    if (out.length >= 6) break
    out += word.toUpperCase()[0]
  }
  return out || 'SCHOOL'
}

export const isDigits = (s: string, n: number): boolean => s.length === n && /^\d+$/.test(s)

export function normalisePhone(s: string): string {
  let digits = s.replace(/\D/g, '')
  if (digits.length > 10) digits = digits.slice(-10)
  return digits
}

/** Six letters and digits, upper-cased, made unique with a counter (uniqueSubjectCode). */
export async function uniqueSubjectCode(c: Ctx, campus: string, name: string): Promise<string> {
  let base = ''
  for (const ch of name.toUpperCase()) {
    if (/[A-Z0-9]/.test(ch)) base += ch
    if (base.length === 6) break
  }
  if (base === '') base = 'SUBJ'
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? base : `${base}${n + 1}`
    const taken = await c.db.prepare(`SELECT 1 AS x FROM subjects WHERE institution_id = ? AND campus_id = ? AND code = ?`)
      .bind(instId(c), campus, candidate).first()
    if (!taken) return candidate
  }
  return base + uuid().slice(0, 4)
}

/* --- accounts -------------------------------------------------------------- */

/** A free username inside this school, a counter appended on collision. */
export async function uniqueUsername(c: Ctx, base: string): Promise<string> {
  let b = base.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')
  if (b === '') b = 'user'
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? b : `${b}${n + 1}`
    const taken = await c.db.prepare(`SELECT 1 AS x FROM users WHERE institution_id = ? AND username = ?`)
      .bind(instId(c), candidate).first()
    if (!taken) return candidate
  }
  throw new Error('could not find a free username. Try setting one by hand')
}

export function temporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const b = new Uint8Array(12)
  crypto.getRandomValues(b)
  const s = [...b].map((v) => alphabet[v % alphabet.length]).join('')
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`
}

export function temporaryPIN(): string {
  const b = new Uint8Array(6)
  crypto.getRandomValues(b)
  return [...b].map((v) => String(v % 10)).join('')
}

/** The first password is the person's own number or address (bulk_logins.go issuedPassword). */
export function issuedPassword(phone: string, email: string): { password: string; known: boolean } {
  if (phone.trim() !== '') return { password: phone.trim(), known: true }
  if (email.trim() !== '') return { password: email.trim(), known: true }
  return { password: temporaryPassword(), known: false }
}

export const hash = (c: Ctx, password: string): Promise<string> => hashPassword(c.env.PASSWORD_PEPPER, password)

/** users.sign_in_as as Go computes it: email, then phone, then username. */
export async function signInAs(c: Ctx, userId: string, order: 'email' | 'username' = 'email'): Promise<string> {
  const expr = order === 'email' ? `COALESCE(email, phone, username, '')` : `COALESCE(username, email, phone, '')`
  const row = await c.db.prepare(`SELECT ${expr} AS v FROM users WHERE id = ?`).bind(userId).first<{ v: string }>()
  return row?.v ?? ''
}

/** Puts an account in a role, failing loudly if the school lacks the role. */
export async function grantRole(c: Ctx, userId: string, roleKey: string): Promise<void> {
  const role = await c.db.prepare(`SELECT id FROM roles WHERE institution_id = ? AND key = ?`).bind(instId(c), roleKey).first<{ id: string }>()
  if (!role) throw new Error(`the ${roleKey} role does not exist in this school`)
  await c.db.prepare(`INSERT INTO user_roles (id, institution_id, user_id, role_id, created_at)
      SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ? AND campus_id IS NULL)`)
    .bind(uuid(), instId(c), userId, role.id, now(), userId, role.id).run()
}

/** Archives an account and revokes its live sessions (leaver_access.go endAccess). */
export async function endAccess(c: Ctx, userId: string): Promise<void> {
  const t = now()
  await c.db.prepare(`UPDATE users SET status = 'archived', updated_at = ? WHERE id = ? AND status <> 'archived'`).bind(t, userId).run()
  await revokeSessions(c, userId)
}

/** Sessions live in CONTROL on the Worker, so revocation is a second database. */
export async function revokeSessions(c: Ctx, userId: string): Promise<void> {
  await c.env.CONTROL.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).bind(now(), userId).run()
}

/** Ends a child's access and the guardians' where no other child is on the roll. */
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

/* --- roles ------------------------------------------------------------------ */

export const PLATFORM_ONLY_ROLES = new Set(['super_admin', 'seller_admin'])
const PLATFORM_ROLES = new Set(['super_admin', 'seller_admin', 'support_admin'])
const OPTIONAL_ROLES = new Set(['board_member', 'support_admin', 'vice_principal', 'it_admin', 'exam_controller',
  'front_office', 'operations', 'librarian', 'transport_manager', 'hostel_warden', 'driver', 'counsellor', 'nurse',
  'discipline_officer', 'activity_coord'])

const SELF = ['self.profile.read', 'self.profile.write']

/** internal/rbac SystemRoles: the capability grants each built-in role carries. */
export const SYSTEM_ROLES: Record<string, { name: string; permissions: string[] | 'all' }> = {
  institution_admin: { name: 'Institution Admin / Principal', permissions: 'all' },
  vice_principal: { name: 'Vice Principal / Academic Coordinator', permissions: [
    'admissions.read', 'admissions.approve', 'students.read', 'students.read.all', 'academics.read', 'academics.write',
    'academics.timetable.read', 'academics.timetable.write', 'academics.attendance.read', 'academics.attendance.read.all',
    'academics.attendance.write', 'academics.attendance.write.any', 'academics.exams.read', 'academics.exams.write',
    'academics.exams.approve', 'academics.marks.write', 'academics.reportcards.generate', 'academics.homework.write',
    'welfare.discipline.write', 'hr.employees.read', 'admin.reports.read', 'comms.announcements.write',
    'academics.class360.view', ...SELF] },
  it_admin: { name: 'IT Administrator', permissions: ['access.users.read', 'access.users.write', 'access.roles.read',
    'access.roles.write', 'access.sessions.revoke', 'admin.audit.read', 'admin.jobs.read', 'admin.jobs.enqueue',
    'institution.integrations.write', 'institution.settings.write', 'institution.read', ...SELF] },
  hod: { name: 'HOD / Department Head', permissions: ['students.read', 'academics.read', 'academics.write',
    'academics.timetable.read', 'academics.timetable.write', 'academics.attendance.read', 'academics.attendance.write',
    'academics.homework.write', 'academics.exams.read', 'academics.exams.approve', 'academics.marks.write',
    'admin.reports.read', 'hr.employees.read', 'hr.leave.approve', 'comms.announcements.write', 'academics.class360.view',
    'comms.messages.read.all', ...SELF] },
  operations: { name: 'Operations Staff', permissions: ['academics.read', 'students.read', 'students.read.all',
    'operations.library.read', 'operations.library.write', 'operations.transport.read', 'operations.transport.write',
    'operations.hostel.read', 'operations.hostel.write', 'operations.inventory.read', 'operations.inventory.write',
    'operations.assets.write', 'welfare.health.read', ...SELF] },
  faculty: { name: 'Faculty / Teacher', permissions: ['students.read', 'academics.read', 'academics.timetable.read',
    'academics.attendance.read', 'academics.attendance.write', 'academics.exams.read', 'academics.marks.write',
    'academics.homework.write', 'comms.announcements.write', 'welfare.discipline.write', 'academics.class360.view',
    'academics.reportcards.generate', ...SELF] },
  class_teacher: { name: 'Class Teacher', permissions: ['students.read', 'students.write', 'academics.read',
    'academics.timetable.read', 'academics.attendance.read', 'academics.attendance.write', 'academics.exams.read',
    'academics.marks.write', 'academics.reportcards.generate', 'academics.homework.write', 'welfare.discipline.write',
    'academics.class360.view', ...SELF] },
  exam_controller: { name: 'Examination Controller', permissions: ['students.read', 'students.read.all',
    'academics.attendance.read', 'academics.attendance.read.all', 'academics.read', 'academics.exams.read',
    'academics.exams.write', 'academics.marks.write', 'academics.reportcards.generate', 'admin.reports.read',
    'academics.class360.view', ...SELF] },
  finance: { name: 'Accounts & Finance', permissions: ['academics.read', 'students.read', 'students.read.all',
    'finance.fees.read', 'finance.fees.write', 'finance.invoices.read', 'finance.invoices.write', 'finance.payments.read',
    'finance.payments.write', 'finance.refunds.write', 'finance.export', 'finance.wallet.read', 'finance.wallet.manage',
    'admin.reports.read', ...SELF] },
  admissions: { name: 'Admissions & Front Office', permissions: ['office.front_desk.read', 'office.front_desk.write',
    'academics.read', 'admissions.read', 'admissions.write', 'students.read', 'students.write', 'students.read.all',
    'operations.transport.read', ...SELF] },
  front_office: { name: 'Receptionist / Front Office', permissions: ['academics.read', 'admissions.read', 'students.read',
    'office.front_desk.read', 'office.front_desk.write', ...SELF] },
  board_member: { name: 'Board / Trustee', permissions: ['institution.read', 'academics.read', 'finance.fees.read',
    'finance.invoices.read', 'finance.payments.read', 'finance.wallet.read', 'hr.payroll.read', 'operations.inventory.read',
    'admin.reports.read', 'admin.audit.read', 'admin.jobs.read', ...SELF] },
  hr: { name: 'HR & Payroll', permissions: ['academics.read', 'hr.employees.read', 'hr.employees.write', 'hr.payroll.read',
    'hr.payroll.write', 'hr.attendance.write', 'admin.reports.read', ...SELF] },
  librarian: { name: 'Librarian', permissions: ['academics.read', 'students.read', 'students.read.all',
    'operations.library.read', 'operations.library.write', ...SELF] },
  hostel_warden: { name: 'Hostel Warden', permissions: ['academics.read', 'students.read', 'students.read.all',
    'operations.hostel.read', 'operations.hostel.write', 'welfare.discipline.write', ...SELF] },
  transport_manager: { name: 'Transport Manager', permissions: ['academics.read', 'students.read', 'students.read.all',
    'operations.transport.read', 'operations.transport.write', ...SELF] },
  driver: { name: 'Driver / Bus Attendant', permissions: ['operations.transport.read', ...SELF] },
  counsellor: { name: 'Counsellor', permissions: ['academics.read', 'students.read', 'students.read.all',
    'welfare.counseling.read', 'welfare.health.read', ...SELF] },
  nurse: { name: 'Nurse / Clinic', permissions: ['academics.read', 'students.read', 'students.read.all',
    'welfare.health.read', 'welfare.health.write', ...SELF] },
  discipline_officer: { name: 'Discipline Officer', permissions: ['academics.read', 'students.read', 'students.read.all',
    'welfare.discipline.write', ...SELF] },
  activity_coord: { name: 'Activity / Sports Coordinator', permissions: ['academics.read', 'students.read',
    'students.read.all', 'comms.announcements.write', ...SELF] },
  student: { name: 'Student', permissions: [...SELF, 'self.attendance.read', 'self.fees.read', 'self.wallet.read',
    'academics.timetable.read'] },
  parent: { name: 'Parent / Guardian', permissions: [...SELF, 'self.children.read', 'self.attendance.read',
    'self.fees.read', 'self.wallet.read', 'academics.timetable.read'] },
}

/**
 * Installs a built-in role the school has not got yet (role_install.go).
 * Grants are the rbac capability keys plus every catalogue feature key of
 * the persona (`<role>.<section>.<feature>`), both restricted to keys the
 * permissions table holds, because role_permissions has a foreign key on it.
 */
export async function installOptionalRole(c: Ctx, key: string): Promise<string> {
  if (PLATFORM_ROLES.has(key)) throw new Error(`${key} is a platform role and belongs to no school`)
  const existing = await c.db.prepare(`SELECT id FROM roles WHERE institution_id = ? AND key = ?`).bind(instId(c), key).first<{ id: string }>()
  if (existing) return existing.id
  const role = SYSTEM_ROLES[key]
  if (!role) throw new Error(`unknown role "${key}"`)
  const id = uuid()
  const stmts: D1PreparedStatement[] = [
    c.db.prepare(`INSERT INTO roles (id, institution_id, key, name, is_system, created_at, is_default) VALUES (?, ?, ?, ?, 1, ?, ?)`)
      .bind(id, instId(c), key, role.name, now(), OPTIONAL_ROLES.has(key) ? 0 : 1),
  ]
  if (role.permissions === 'all') {
    stmts.push(c.db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
        SELECT ?, key FROM permissions WHERE key NOT IN ('platform.tenants.write','platform.plans.write')`).bind(id))
  } else {
    for (const p of role.permissions) {
      stmts.push(c.db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT ?, key FROM permissions WHERE key = ?`).bind(id, p))
    }
  }
  stmts.push(c.db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT ?, key FROM permissions WHERE key LIKE ?`).bind(id, key + '.%'))
  await c.db.batch(stmts)
  return id
}

/* --- appointing staff ------------------------------------------------------- */

export interface EmployeeRequest {
  employee_code?: string
  first_name: string
  last_name?: string
  email?: string
  phone?: string
  department_id?: string
  designation_id?: string
  joined_on?: string
  employment_type?: string
  create_login?: boolean
  role_key?: string
  role_keys?: string[]
}

export function employeeRoles(req: EmployeeRequest): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of [req.role_key ?? '', ...(req.role_keys ?? [])]) {
    const k = raw.trim()
    if (k === '' || seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

export class PhoneInUse extends Error {}

/** The person_code trigger (migration 00203): E + six digits, unique per school. */
export async function freshPersonCode(c: Ctx, table: 'students' | 'employees'): Promise<string> {
  const prefix = table === 'students' ? 'S' : 'E'
  for (;;) {
    const candidate = prefix + String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
    const taken = await c.db.prepare(`SELECT 1 AS x FROM ${table} WHERE institution_id = ? AND person_code = ?`).bind(instId(c), candidate).first()
    if (!taken) return candidate
  }
}

/** The next free four-digit staff number, floored at 1000, NULL past 9999. */
async function nextStaffNumber(c: Ctx): Promise<number | null> {
  const row = await c.db.prepare(`SELECT COALESCE(MAX(staff_number), 999) AS m FROM employees WHERE institution_id = ?`).bind(instId(c)).first<{ m: number }>()
  const m = row?.m ?? 999
  return m < 9999 ? Math.max(m + 1, 1000) : null
}

/**
 * appointEmployee (setup.go): the one way a person becomes a member of
 * staff. Upserts on (institution_id, employee_code) and says whether it
 * inserted. Not one transaction on D1; the reads come first and the writes
 * are as close together as the reads allow.
 */
export async function appointEmployee(c: Ctx, campus: string, req: EmployeeRequest):
  Promise<{ empId: string; userId: string; created: boolean }> {
  const inst = instId(c)
  const t = now()
  let userId = ''
  const email = nullStr(req.email)
  const phone = nullStr(req.phone)
  const fullName = `${req.first_name} ${req.last_name ?? ''}`.trim()

  if (req.create_login) {
    const byEmail = email
      ? await c.db.prepare(`SELECT id FROM users WHERE institution_id = ? AND email = ?`).bind(inst, email).first<{ id: string }>()
      : null
    if (byEmail) {
      userId = byEmail.id
      await c.db.prepare(`UPDATE users SET full_name = ?, updated_at = ? WHERE id = ?`).bind(fullName, t, userId).run()
    } else {
      if (phone) {
        const byPhone = await c.db.prepare(`SELECT 1 AS x FROM users WHERE institution_id = ? AND phone = ?`).bind(inst, phone).first()
        if (byPhone) throw new PhoneInUse('that phone number already belongs to somebody at this school')
      }
      userId = uuid()
      await c.db.prepare(`INSERT INTO users (id, institution_id, email, phone, full_name, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'invited', ?, ?)`).bind(userId, inst, email, phone, fullName, t, t).run()
    }
    for (const roleKey of employeeRoles(req)) {
      await installOptionalRole(c, roleKey)
      await c.db.prepare(`INSERT INTO user_roles (id, institution_id, user_id, role_id, created_at)
          SELECT ?, ?, ?, r.id, ? FROM roles r
           WHERE r.key = ? AND (r.institution_id = ? OR r.institution_id IS NULL)
             AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = ? AND ur.role_id = r.id AND ur.campus_id IS NULL)`)
        .bind(uuid(), inst, userId, t, roleKey, inst, userId).run()
    }
  }

  let code = (req.employee_code ?? '').trim()
  if (code === '') {
    const n = await nextStaffNumber(c)
    code = 'EMP' + String(n ?? 1000).padStart(4, '0')
  }

  const existing = await c.db.prepare(`SELECT id FROM employees WHERE institution_id = ? AND employee_code = ?`).bind(inst, code).first<{ id: string }>()
  if (existing) {
    await c.db.prepare(`UPDATE employees SET first_name = ?, last_name = ?, email = ?, phone = ?, department_id = ?, designation_id = ?,
        employment_type = COALESCE(?, employment_type), user_id = COALESCE(?, user_id), updated_at = ? WHERE id = ?`)
      .bind(req.first_name, nullStr(req.last_name), email, phone, nullStr(req.department_id), nullStr(req.designation_id),
        nullStr(req.employment_type), nullStr(userId), t, existing.id).run()
    return { empId: existing.id, userId, created: false }
  }
  const empId = uuid()
  const staffNo = await nextStaffNumber(c)
  await c.db.prepare(`INSERT INTO employees (id, institution_id, campus_id, user_id, employee_code, first_name, last_name, email, phone,
      department_id, designation_id, joined_on, employment_type, status, staff_number, person_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, ?), ?, 'active', ?, ?, ?, ?)`)
    .bind(empId, inst, campus, nullStr(userId), code, req.first_name, nullStr(req.last_name), email, phone,
      nullStr(req.department_id), nullStr(req.designation_id), nullStr(req.joined_on), todayIndia(), nullStr(req.employment_type),
      staffNo, await freshPersonCode(c, 'employees'), t, t).run()
  return { empId, userId, created: true }
}

/** Runs statements atomically when there are several, plainly when one. */
export async function batch(c: Ctx, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  if (stmts.length === 0) return []
  if (stmts.length === 1) return [await stmts[0].run()]
  return c.db.batch(stmts)
}

export const changes = (r: D1Result | undefined): number => Number(r?.meta?.changes ?? 0)
