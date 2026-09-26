import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, clampInt, created, forbidden, isUUID, like, notFound, now, ok, readJSON, uuid } from '../../http'
import { can } from '../../identity'
import { tenantDb, type Institution } from '../../tenant'
import { hashPassword } from '../../auth/password'
import { inList, institutionId } from './common'
import { CATALOG_ROLES, GROUPS, PERMISSIONS, PERMISSION_KEYS, SYSTEM_ROLES, allCatalogFeatureKeys, catalogRoleByKey, isDefaultRole, isPlatformRole, systemRoleByKey } from './static_data'
import { applyGrid, groupByKey, groupLevels, levelName, parseLevel, readGrid, type GroupState } from './rbac_grid'
import { resolveRange } from '../misc/shell'

/* Port of the account, role and module routes under /admin: admin.go,
   users.go, role_grid.go, role_features.go, generic_account.go,
   role_transfer.go, account.go, mfa.go (adminMFADisable), login_security.go
   (signInDays), acting.go (listInstitutions) and platform_dashboard.go. */

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

// --- shared pieces -----------------------------------------------------------

/** Active sessions per user, from CONTROL, for the school in scope. */
async function sessionCounts(c: Ctx, userIds?: string[]): Promise<Map<string, number>> {
  const inst = c.id.institution?.id ?? null
  const rows = await c.env.CONTROL.prepare(`SELECT user_id, count(*) AS n FROM sessions WHERE institution_id IS ? AND revoked_at IS NULL AND expires_at > ? GROUP BY user_id`)
    .bind(inst, now()).all<{ user_id: string; n: number }>()
  const out = new Map<string, number>()
  for (const r of rows.results) if (!userIds || userIds.includes(r.user_id)) out.set(r.user_id, r.n)
  return out
}

const revokeUserSessions = (c: Ctx, userId: string, reason: string | null = null) =>
  c.env.CONTROL.prepare(`UPDATE sessions SET revoked_at = ?, ended_reason = COALESCE(?, ended_reason) WHERE user_id = ? AND revoked_at IS NULL`).bind(now(), reason, userId)

/** issuedPassword in bulk_logins.go: the person's own number, else a generated value. */
function issuedPassword(phone: string, email: string): { temp: string; known: boolean } {
  if (phone.trim() !== '') return { temp: phone.trim(), known: true }
  if (email.trim() !== '') return { temp: email.trim(), known: true }
  return { temp: temporaryPassword(), known: false }
}
export function temporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const b = new Uint8Array(12)
  crypto.getRandomValues(b)
  const s = [...b].map((v) => alphabet[v % alphabet.length]).join('')
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8)
}

/** platformChannels: the seller's enabled messaging channels (integrations rows with no institution). */
async function platformChannels(c: Ctx): Promise<Set<string>> {
  try {
    const rows = await c.db.prepare(`SELECT provider FROM integrations WHERE institution_id IS NULL AND kind = 'messaging' AND enabled`).all<{ provider: string }>()
    return new Set(rows.results.map((r) => r.provider))
  } catch { return new Set() }
}

function maskContact(v: string): string {
  const at = v.indexOf('@')
  if (at > 0) return v.slice(0, Math.min(2, at)) + '***' + v.slice(at)
  if (v.length > 4) return '*'.repeat(v.length - 4) + v.slice(-4)
  return v
}

/** queueIssuedPassword: the message_log row that carries a generated password; returns [channel, masked contact, stmt]. */
function queueIssuedPassword(c: Ctx, userId: string, email: string | null, phone: string | null, login: string, temp: string, enabled: Set<string>): { by: string; to: string; stmt: D1PreparedStatement | null } {
  const mail = (email ?? '').trim(), mobile = (phone ?? '').trim()
  const routes: [string, string][] = [['email', mail], ['sms', mobile], ['whatsapp', mobile]]
  let to = '', ch = ''
  for (const [k, v] of routes) if (v && enabled.has(k)) { to = v; ch = k; break }
  if (!to) for (const [k, v] of routes) if (v) { to = v; ch = k; break }
  if (!to) return { by: '', to: '', stmt: null }
  const base = new URL(c.req.url).origin
  let body = 'Your login has been reset.\n\nSign in as ' + login + ' with this temporary password:\n' + temp + '\n\n' + base + '/login\n\nYou will be asked to choose your own password the first time.'
  if (ch !== 'email') body = 'Login reset. Sign in as ' + login + ' with temporary password ' + temp + ' at ' + base + '/login and choose your own.'
  const stmt = c.db.prepare(`INSERT INTO message_log (id, institution_id, channel, template_code, recipient, user_id, subject, body, status, queued_at)
      VALUES (?, ?, ?, 'password_reset', ?, ?, 'Your login', ?, 'queued', ?)`).bind(uuid(), institutionId(c), ch, to, userId, body, now())
  return { by: ch, to: maskContact(to), stmt }
}

/** installOptionalRole (role_install.go + rbac.InstallRole): the role row, its grants, and its workspace tiles. */
async function installOptionalRole(c: Ctx, key: string): Promise<{ roleId: string; created: boolean }> {
  if (isPlatformRole(key)) throw badRequest(key + ' is a platform role and belongs to no school')
  const role = systemRoleByKey(key)
  if (!role) throw badRequest(`unknown role "${key}"`)
  const inst = institutionId(c)
  const existing = await c.db.prepare(`SELECT id, customised_at FROM roles WHERE institution_id = ? AND key = ?`).bind(inst, key).first<{ id: string; customised_at: string | null }>()
  const roleId = existing?.id ?? uuid()
  const stmts: D1PreparedStatement[] = []
  if (existing) {
    stmts.push(c.db.prepare(`UPDATE roles SET name = ?, is_default = ? WHERE id = ?`).bind(role.name, role.is_default ? 1 : 0, roleId))
  } else {
    stmts.push(c.db.prepare(`INSERT INTO roles (id, institution_id, key, name, is_system, is_default, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)`)
      .bind(roleId, inst, key, role.name, role.is_default ? 1 : 0, now()))
  }
  if (!existing?.customised_at) {
    stmts.push(c.db.prepare(`DELETE FROM role_permissions WHERE role_id = ?`).bind(roleId))
    for (const k of role.permissions) stmts.push(c.db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)`).bind(roleId, k))
  }
  const persona = catalogRoleByKey(key)
  if (persona) for (const sec of persona.sections) for (const f of sec.features) {
    stmts.push(c.db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)`).bind(roleId, f.key))
  }
  await c.db.batch(stmts)
  return { roleId, created: !existing }
}

/** setUserRoles: replaces (or adds) a user's role rows; returns the keys applied. */
async function setUserRoles(c: Ctx, userId: string, keys: string[], campusIds: string[], replace: boolean): Promise<string[]> {
  const inst = institutionId(c)
  const stmts: D1PreparedStatement[] = []
  if (replace) stmts.push(c.db.prepare(`DELETE FROM user_roles WHERE user_id = ?`).bind(userId))
  const applied: string[] = []
  for (let key of keys) {
    key = key.trim()
    if (key === '') continue
    let role = await c.db.prepare(`SELECT id, institution_id FROM roles WHERE key = ? AND (institution_id = ? OR institution_id IS NULL) ORDER BY (institution_id IS NULL) LIMIT 1`)
      .bind(key, inst).first<{ id: string; institution_id: string | null }>()
    /* A platform role (institution_id NULL) is readable by a school, as RLS allowed, but only
       the vendor may hand one out: in Postgres the user_roles WITH CHECK refused a school's
       attempt. Without this a school administrator could grant seller_admin to a staff account. */
    if (role && role.institution_id === null && (!c.id.platformAdmin || isPlatformRole(key))) continue
    if (!role) {
      if (isDefaultRole(key)) continue
      try { const r = await installOptionalRole(c, key); role = { id: r.roleId, institution_id: inst } } catch { continue }
    }
    const owner = role.institution_id === null ? null : inst
    if (campusIds.length === 0 || role.institution_id === null) {
      stmts.push(c.db.prepare(`INSERT INTO user_roles (id, institution_id, user_id, role_id, campus_id, created_at)
          SELECT ?, ?, ?, ?, NULL, ? WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ? AND campus_id IS NULL)`)
        .bind(uuid(), owner, userId, role.id, now(), userId, role.id))
    } else {
      for (const campus of campusIds) {
        stmts.push(c.db.prepare(`INSERT OR IGNORE INTO user_roles (id, institution_id, user_id, role_id, campus_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(uuid(), owner, userId, role.id, campus, now()))
      }
    }
    applied.push(key)
  }
  if (stmts.length) await c.db.batch(stmts)
  return applied.sort()
}

const PLATFORM_ONLY_ROLES = new Set(['super_admin', 'seller_admin'])
const DERIVED_ROLES: Record<string, string> = {
  student: 'linking the person to a student record',
  parent: 'linking the person to a child as their guardian',
  class_teacher: 'naming them class teacher on the section itself',
}
const OVERLAPPING: [string, string, string][] = [
  ['hod', 'faculty', 'A head of department who teaches gets marks entry, homework and the register from the hod role as soon as somebody allocates them a subject in Faculty allocation.'],
  ['admissions', 'front_office', 'Admissions already contains the four front-desk registers. Give front_office alone to somebody who only works the desk, or admissions alone to somebody who does both.'],
  ['institution_admin', 'hostel_warden', "The principal's workspace already holds the whole hostel section. Give hostel_warden alone to the person who runs the hostel; a principal who also does so already has every register from their own role."],
]
function checkGrantable(keys: string[], platformAdmin: boolean): void {
  const held = new Set(keys)
  for (const [a, b, remedy] of OVERLAPPING) {
    if (held.has(a) && held.has(b)) throw forbidden('a person cannot hold both ' + a + ' and ' + b + '. They draw the same screens. ' + remedy)
  }
  for (const k of keys) {
    if (PLATFORM_ONLY_ROLES.has(k) && !platformAdmin) throw forbidden('only a platform operator can grant the ' + k + ' role')
    if (k in DERIVED_ROLES) throw forbidden('the ' + k + ' role is granted by ' + DERIVED_ROLES[k] + ', not from this screen')
  }
}

async function resolveCampusIDs(c: Ctx, raw: string[] | undefined): Promise<string[]> {
  if (!c.id.institution || !raw || raw.length === 0) return []
  const ids: string[] = []
  for (const s of raw) {
    const u = s.trim()
    if (!isUUID(u)) throw badRequest('each campus_id must be a valid uuid')
    if (!ids.includes(u)) ids.push(u)
  }
  const q = inList(ids)
  const found = await c.db.prepare(`SELECT count(*) AS n FROM campuses WHERE id IN ${q.sql}`).bind(...q.args).first<{ n: number }>()
  if ((found?.n ?? 0) !== ids.length) throw badRequest('one of the campuses is not part of this school')
  return ids
}

const hasStaffRole = (keys: string[]) => keys.some((k) => k !== 'student' && k !== 'parent')
function splitFullName(name: string): [string, string] {
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return [name, '']
  return [parts[0], parts.slice(1).join(' ')]
}

/** ensureCampus + appointEmployee (setup.go), the way createUser calls them: a staff record from the same name and contact. */
async function appointEmployeeStmts(c: Ctx, fullName: string, email: string, phone: string): Promise<D1PreparedStatement[]> {
  const inst = institutionId(c)
  const stmts: D1PreparedStatement[] = []
  let campus = (await c.db.prepare(`SELECT id FROM campuses ORDER BY created_at LIMIT 1`).first<{ id: string }>())?.id
  if (!campus) {
    campus = uuid()
    stmts.push(c.db.prepare(`INSERT INTO campuses (id, institution_id, name, code, created_at, updated_at) VALUES (?, ?, 'Main Campus', 'MAIN', ?, ?)`).bind(campus, inst, now(), now()))
  }
  const mx = await c.db.prepare(`SELECT COALESCE(max(staff_number), 999) AS m FROM employees WHERE institution_id = ?`).bind(inst).first<{ m: number }>()
  const next = Math.max((mx?.m ?? 999) + 1, 1000)
  const code = 'EMP' + String(next).padStart(4, '0')
  const [first, last] = splitFullName(fullName)
  const existing = await c.db.prepare(`SELECT id FROM employees WHERE institution_id = ? AND employee_code = ?`).bind(inst, code).first<{ id: string }>()
  if (existing) {
    stmts.push(c.db.prepare(`UPDATE employees SET first_name = ?, last_name = ?, email = ?, phone = ? WHERE id = ?`).bind(first, last || null, email || null, phone || null, existing.id))
  } else {
    stmts.push(c.db.prepare(`INSERT INTO employees (id, institution_id, campus_id, user_id, employee_code, first_name, last_name, email, phone, joined_on, status, staff_number, created_at, updated_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, date('now'), 'active', ?, ?, ?)`)
      .bind(uuid(), inst, campus, code, first, last || null, email || null, phone || null, next < 9999 ? next : null, now(), now()))
  }
  return stmts
}

function slugKey(name: string): string {
  let out = ''
  let prevDash = true
  for (const ch of name.toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) { out += ch; prevDash = false }
    else if (!prevDash) { out += '_'; prevDash = true }
  }
  return out.replace(/^_+|_+$/g, '')
}

const ROLE_DESCRIPTIONS: Record<string, string> = {
  super_admin: 'Platform operator across every school.',
  institution_admin: 'Runs the school. Sees everything except platform settings.',
  hod: "Heads a department; sees only that department's staff and classes.",
  faculty: 'Teaches; sees only their own classes and students.',
  finance: 'Fee counter, invoices, collections and defaulters.',
  admissions: 'Enquiries through to enrolment, and the front desk.',
  hr: 'Staff records, leave, attendance and payroll.',
  operations: 'Library, transport, hostel and stores.',
  student: "A student's own portal.",
  parent: "A guardian's view of their children.",
}
const OPTIONAL_ROLE_NOTES: Record<string, string> = {
  vice_principal: 'Runs teaching and learning. Timetable, exams and monitoring, but no fees or salaries.',
  hod: 'Only if departments are real in your school.',
  it_admin: 'Accounts, roles and integrations, with no access to fees, marks or health records.',
  exam_controller: 'A dedicated person for the board exam cycle.',
  front_office: 'A reception desk separate from admissions. Most schools use one person for both.',
  operations: 'One account covering library, transport, hostel and stores.',
  librarian: 'Requires the Library module.',
  transport_manager: 'Requires the Transport module.',
  hostel_warden: 'Residential schools only.',
  driver: "A bus driver's route list. Nothing else.",
  counsellor: 'Counselling notes, kept apart from the infirmary record.',
  nurse: 'The only role that writes health records.',
  discipline_officer: 'A dedicated person for conduct records.',
  activity_coord: 'Sports and activities, with the ability to publish notices.',
  support_admin: 'Vendor support desk. Platform-wide; not for schools.',
}
const ALL_OPERATIONAL_ROLES = ['institution_admin', 'it_admin', 'hod', 'finance', 'admissions', 'hr', 'operations', 'exam_controller', 'librarian', 'transport_manager']
const ROLE_PRESETS = [
  { key: 'sole_maintainer', name: 'Everything. One person runs the school', description: 'Every staff role on one account. The person switches workspaces from the left rail; the roles stay separate.', role_keys: ALL_OPERATIONAL_ROLES, recommended: true },
  { key: 'principal', name: 'Principal / Head', description: 'Runs the school and approves everything, but does not operate the fee counter.', role_keys: ['institution_admin'], recommended: false },
  { key: 'office', name: 'Office staff', description: 'Admissions, the front desk and the fee counter. The usual front-office bundle.', role_keys: ['admissions', 'finance'], recommended: false },
  { key: 'accounts', name: 'Accountant', description: 'Fees, invoices, collections and reports only.', role_keys: ['finance'], recommended: false },
  { key: 'teacher', name: 'Teacher', description: 'Their own classes: attendance, marks, homework.', role_keys: ['faculty'], recommended: false },
  { key: 'academic_head', name: 'Head of department', description: "A department's staff, classes and approvals. Allocate them a subject in Faculty allocation and their own teaching screens appear too.", role_keys: ['hod'], recommended: false },
  { key: 'hr_payroll', name: 'HR & payroll', description: 'Staff records, leave, attendance and salaries.', role_keys: ['hr'], recommended: false },
  { key: 'operations', name: 'Operations', description: 'Library, transport, hostel and stores.', role_keys: ['operations', 'librarian', 'transport_manager', 'hostel_warden'], recommended: false },
  { key: 'it', name: 'IT administrator', description: 'Accounts, roles, integrations and the audit trail.', role_keys: ['it_admin'], recommended: false },
  { key: 'teacher_librarian', name: 'Teacher & librarian', description: 'Teaches their own classes and runs the library. Two workspaces on the left rail; nothing is shared between them.', role_keys: ['faculty', 'librarian'], recommended: false },
  { key: 'teacher_transport', name: 'Teacher & transport in-charge', description: 'Teaches, and runs the routes, vehicles and driver roster.', role_keys: ['faculty', 'transport_manager'], recommended: false },
  { key: 'principal_hr', name: 'Principal & payroll', description: 'Runs the school and keeps the staff records and salaries, the small-school arrangement where the head does both.', role_keys: ['institution_admin', 'hr'], recommended: false },
  { key: 'hod_librarian', name: 'Head of department & librarian', description: 'Heads a department and runs the library. Allocate them a subject and their own teaching screens appear too.', role_keys: ['hod', 'librarian'], recommended: false },
]
const FEATURE_UNLOCKS: Record<string, string[]> = {
  take_attendance: ['academics.attendance.write', 'academics.attendance.write.any'],
  absentee_followup: ['academics.attendance.read', 'academics.attendance.read.all'],
  student_absentees: ['academics.attendance.read', 'academics.attendance.read.all'],
  class_360: ['academics.class360.view', 'students.read', 'students.read.all', 'academics.attendance.read', 'academics.attendance.read.all'],
  student_360: ['students.read', 'students.read.all'],
  staff_360: ['hr.employees.read'],
  staff_overview: ['hr.employees.read'],
  marks_entry: ['academics.marks.write'],
  enter_marks: ['academics.marks.write'],
  homework: ['academics.homework.write'],
  homework_assignments: ['academics.homework.write'],
}
const featureSlug = (key: string) => key.slice(key.lastIndexOf('.') + 1)
const SCOPE_LABELS: Record<string, string> = { platform: 'Every school', institution: 'Whole school', campus: 'Their campus', department: 'Their department', assigned_classes: 'Their classes', own: 'Only their own', linked_children: 'Their children' }
const APPROVE_NOTES: Record<string, string> = { students: 'Archive and withdraw a student record.', marks: 'Issue report cards.', fees: 'Issue refunds against a paid invoice.', staff: 'Approve or reject leave requests.' }

const USER_FILTER = `(?1 IS NULL OR u.status = ?1) AND (?2 IS NULL OR u.full_name LIKE ?2 ESCAPE '\\' OR u.email LIKE ?2 ESCAPE '\\' OR u.phone LIKE ?2 ESCAPE '\\')`

async function userExists(c: Ctx, id: string): Promise<void> {
  const u = await c.db.prepare(`SELECT 1 AS x FROM users WHERE id = ?`).bind(id).first()
  if (!u) throw notFound('resource not found')
}

// --- the routes ---------------------------------------------------------------

export function registerAdminUsers(r: Router): void {
  // admin.go -------------------------------------------------------------------
  r.get('/admin/users', 'access.users.read', async (c) => {
    const q = c.url.searchParams
    const search = (q.get('q') ?? '').trim()
    const status = q.get('status') || null
    const pageSize = 200
    const offset = Math.max(0, Number(q.get('offset')) || 0)
    const searchArg = search ? like(search) : null
    const rows = await c.db.prepare(`
      SELECT u.id, u.full_name, u.email, u.phone, u.status, u.mfa_secret IS NOT NULL AS mfa, u.last_login_at,
             CASE WHEN EXISTS (SELECT 1 FROM employees e WHERE e.user_id = u.id) THEN 'staff'
                  WHEN EXISTS (SELECT 1 FROM students st WHERE st.user_id = u.id) THEN 'student'
                  WHEN EXISTS (SELECT 1 FROM guardians g WHERE g.user_id = u.id) THEN 'guardian' ELSE 'none' END AS record
        FROM users u WHERE ${USER_FILTER} ORDER BY u.full_name LIMIT ?3 OFFSET ?4`).bind(status, searchArg, pageSize, offset)
      .all<{ id: string; full_name: string; email: string | null; phone: string | null; status: string; mfa: number; last_login_at: string | null; record: string }>()
    const ids = rows.results.map((u) => u.id)
    const roleRows = ids.length ? await c.db.prepare(`SELECT ur.user_id, ro.name, ro.key FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id WHERE ur.user_id IN ${inList(ids).sql} ORDER BY ro.name`)
      .bind(JSON.stringify(ids)).all<{ user_id: string; name: string; key: string }>() : { results: [] as { user_id: string; name: string; key: string }[] }
    const roles = new Map<string, { names: Set<string>; keys: Set<string> }>()
    for (const rr of roleRows.results) {
      const e = roles.get(rr.user_id) ?? { names: new Set(), keys: new Set() }
      e.names.add(rr.name); e.keys.add(rr.key); roles.set(rr.user_id, e)
    }
    const sessions = await sessionCounts(c, ids)
    const total = await c.db.prepare(`SELECT count(*) AS n FROM users u WHERE ${USER_FILTER}`).bind(status, searchArg).first<{ n: number }>()
    const instName = c.id.institution?.name
    return ok({
      items: rows.results.map((u) => ({
        id: u.id, full_name: u.full_name, email: u.email ?? undefined, phone: u.phone ?? undefined, status: u.status, mfa_enabled: !!u.mfa,
        last_login_at: u.last_login_at ?? undefined, roles: [...(roles.get(u.id)?.names ?? [])].sort(), role_keys: [...(roles.get(u.id)?.keys ?? [])].sort(),
        institution: instName, active_sessions: sessions.get(u.id) ?? 0, record: u.record,
      })),
      total: total?.n ?? offset + rows.results.length,
    })
  })

  r.get('/admin/roles', 'access.roles.read', async (c) => {
    const q = inList(PERMISSION_KEYS)
    const rows = await c.db.prepare(`
      SELECT ro.id, ro.key, ro.name, ro.is_system, ro.is_default, ro.customised_at IS NOT NULL AS customised,
             (SELECT count(*) FROM role_permissions rp WHERE rp.role_id = ro.id) AS permissions,
             (SELECT count(*) FROM role_permissions rp WHERE rp.role_id = ro.id AND rp.permission_key IN ${q.sql}) AS capabilities,
             (SELECT count(*) FROM user_roles ur WHERE ur.role_id = ro.id) AS users, ro.institution_id
        FROM roles ro ORDER BY ro.is_system DESC, ro.name`).bind(...q.args)
      .all<{ id: string; key: string; name: string; is_system: number; is_default: number; customised: number; permissions: number; capabilities: number; users: number; institution_id: string | null }>()
    return ok({ items: rows.results.map((v) => ({ id: v.id, key: v.key, name: v.name, is_system: !!v.is_system, is_default: !!v.is_default, customised: !!v.customised,
      institution: v.institution_id ? c.id.institution?.name : undefined, permissions: v.permissions, capabilities: v.capabilities, users: v.users })) })
  })

  r.get('/admin/modules', 'institution.read', async (c) => {
    const rows = await c.db.prepare(`SELECT module, enabled FROM module_settings ORDER BY module`).all<{ module: string; enabled: number }>()
    return ok({ items: rows.results.map((m) => ({ module: m.module, enabled: !!m.enabled })) })
  })
  r.put('/admin/modules', 'institution.settings.write', async (c) => {
    const req = await readJSON<{ module?: string; enabled?: boolean }>(c.req)
    if (!(req.module ?? '').trim()) throw badRequest('module is required')
    await c.db.prepare(`INSERT INTO module_settings (institution_id, module, enabled) VALUES (?, ?, ?) ON CONFLICT (institution_id, module) DO UPDATE SET enabled = excluded.enabled`)
      .bind(institutionId(c), req.module, req.enabled ? 1 : 0).run()
    return ok({ module: req.module, enabled: !!req.enabled })
  })

  // Literal paths under /admin/users before {id}.
  r.post('/admin/users/roles/transfer', 'access.roles.write', async (c) => {
    const req = await readJSON<{ from_user_id?: string; to_user_id?: string; role_keys?: string[]; leaver_status?: string }>(c.req)
    const from = (req.from_user_id ?? '').trim(), to = (req.to_user_id ?? '').trim()
    if (!isUUID(from)) throw badRequest('from_user_id must be a uuid')
    if (!isUUID(to)) throw badRequest('to_user_id must be a uuid')
    if (from === to) throw badRequest('a role cannot be transferred to the person who already holds it')
    const leaver = (req.leaver_status ?? '').trim()
    if (leaver !== '' && !['active', 'suspended', 'archived'].includes(leaver)) throw badRequest('leaver_status must be one of active, suspended, archived')
    const fromU = await c.db.prepare(`SELECT full_name FROM users WHERE id = ?`).bind(from).first<{ full_name: string }>()
    const toU = await c.db.prepare(`SELECT full_name, status FROM users WHERE id = ?`).bind(to).first<{ full_name: string; status: string }>()
    if (!fromU || !toU) throw badRequest('both accounts must belong to this school')
    const held = (await c.db.prepare(`SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.key`).bind(from).all<{ key: string }>()).results.map((x) => x.key)
    const wanted = new Set((req.role_keys ?? []).map((k) => k.trim()).filter(Boolean))
    const moved = held.filter((k) => wanted.size === 0 || wanted.has(k))
    if (moved.length === 0) throw badRequest('that person holds none of those roles, so there is nothing to hand over')
    if (moved.includes('institution_admin')) {
      const others = await c.db.prepare(`SELECT count(*) AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
          WHERE r.key = 'institution_admin' AND u.status = 'active' AND ur.user_id <> ?`).bind(from).first<{ n: number }>()
      if ((others?.n ?? 0) === 0 && toU.status !== 'active') {
        throw badRequest("this is the school's only administrator, and the account receiving the role cannot sign in · activate it first, or give the role to somebody who can")
      }
    }
    await setUserRoles(c, to, moved, [], false)
    const q = inList(moved)
    const stmts = [c.db.prepare(`DELETE FROM user_roles WHERE user_id = ? AND role_id IN (SELECT id FROM roles WHERE key IN ${q.sql})`).bind(from, ...q.args)]
    if (leaver !== '') stmts.push(c.db.prepare(`UPDATE users SET status = ? WHERE id = ?`).bind(leaver, from))
    await c.db.batch(stmts)
    moved.sort()
    return ok({ from: { id: from, name: fromU.full_name }, to: { id: to, name: toU.full_name }, transferred: moved,
      note: fromU.full_name + ' no longer holds ' + moved.join(', ') + '; ' + toU.full_name + ' does.' })
  })

  r.post('/admin/users/generic', 'access.roles.write', async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ full_name?: string; email?: string; phone?: string; role_name?: string; copy_from?: string }>(c.req)
    const name = (req.full_name ?? '').trim()
    if (name === '') throw badRequest('the account needs a name')
    const email = (req.email ?? '').trim(), phone = (req.phone ?? '').trim()
    if (email === '' && phone === '') throw badRequest('an email or a phone number, the account needs something to sign in with')
    const roleName = (req.role_name ?? '').trim() || name
    const roleKey = slugKey(roleName)
    if (roleKey === '') throw badRequest('the role name needs at least one letter or number')
    const { temp, known } = issuedPassword(phone, email)
    const hash = await hashPassword(c.env.PASSWORD_PEPPER, temp)
    const dup = await c.db.prepare(`SELECT 1 AS x FROM roles WHERE COALESCE(institution_id, ?) = ? AND key = ?`).bind(NIL_UUID, inst, roleKey).first()
    if (dup) throw badRequest('a role called ' + roleName + ' already exists, give this one a different name')
    if (email && await c.db.prepare(`SELECT 1 AS x FROM users WHERE email = ?`).bind(email).first()) {
      throw new HttpError(409, 'another account in this school already uses that email', { code: 'email_in_use' })
    }
    const roleId = uuid(), userId = uuid()
    const stmts = [c.db.prepare(`INSERT INTO roles (id, institution_id, key, name, is_system, is_default, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)`).bind(roleId, inst, roleKey, roleName, now())]
    let copied = 0
    const from = (req.copy_from ?? '').trim()
    if (from) {
      const q = inList(PERMISSION_KEYS)
      const src = await c.db.prepare(`SELECT DISTINCT rp.permission_key FROM role_permissions rp JOIN roles src ON src.id = rp.role_id
          WHERE src.key = ? AND (src.institution_id = ? OR src.institution_id IS NULL) AND rp.permission_key IN ${q.sql} AND rp.permission_key NOT LIKE 'platform.%'`).bind(from, inst, ...q.args).all<{ permission_key: string }>()
      for (const k of src.results) stmts.push(c.db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)`).bind(roleId, k.permission_key))
      copied = src.results.length
    }
    stmts.push(c.db.prepare(`INSERT INTO users (id, institution_id, email, phone, full_name, password_hash, status, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
      .bind(userId, inst, email || null, phone || null, name, hash, known ? 1 : 0, now(), now()))
    stmts.push(c.db.prepare(`INSERT INTO user_roles (id, institution_id, user_id, role_id, campus_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)`).bind(uuid(), inst, userId, roleId, now()))
    await c.db.batch(stmts)
    const idx: D1PreparedStatement[] = []
    if (email) idx.push(c.env.CONTROL.prepare(`INSERT OR IGNORE INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, ?, ?, ?)`).bind(email, inst, userId, now()))
    if (phone) idx.push(c.env.CONTROL.prepare(`INSERT OR IGNORE INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('phone', ?, ?, ?, ?)`).bind(phone, inst, userId, now()))
    if (idx.length) await c.env.CONTROL.batch(idx)
    return created({
      user_id: userId, role_id: roleId, role_key: roleKey, role_name: roleName, copied_permissions: copied, temporary_password: temp,
      note: copied > 0 ? 'Started from ' + from + '. Open its role to change what it can see and edit.' : 'This account can sign in and see nothing. Open its role and grant what it should see and change.',
      password_note: 'Shown once. Hand it over in person; ask them to change it from their profile.',
    })
  })

  r.post('/admin/users', 'access.users.write', async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ full_name?: string; email?: string; phone?: string; role_keys?: string[]; campus_ids?: string[]; set_password?: boolean }>(c.req)
    const fullName = (req.full_name ?? '').trim()
    const email = (req.email ?? '').trim().toLowerCase(), phone = (req.phone ?? '').trim()
    if (fullName === '') throw badRequest('full_name is required')
    if (email === '' && phone === '') throw badRequest('an email or a phone number is required to sign in')
    const roleKeys = req.role_keys ?? []
    checkGrantable(roleKeys, c.id.platformAdmin)
    if (roleKeys.length === 0) throw badRequest('assign at least one role, or the account can see nothing')
    const campusIds = await resolveCampusIDs(c, req.campus_ids)
    let temp = '', known = false
    if (req.set_password) ({ temp, known } = issuedPassword(phone, email))
    const enabled = temp !== '' && !known ? await platformChannels(c) : new Set<string>()
    const status = temp !== '' ? 'active' : 'invited'
    const hash = temp !== '' ? await hashPassword(c.env.PASSWORD_PEPPER, temp) : null
    // ON CONFLICT (institution_id, email) WHERE email IS NOT NULL: absorbed by hand, D1 has no partial unique index.
    const existing = email ? await c.db.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first<{ id: string }>() : null
    if (phone) {
      const dupPhone = await c.db.prepare(`SELECT id FROM users WHERE phone = ? AND id IS NOT ?`).bind(phone, existing?.id ?? null).first()
      if (dupPhone) throw badRequest('that phone number is already on another account at this school, and a number can only belong to one person')
    }
    const userId = existing?.id ?? uuid()
    const stmts: D1PreparedStatement[] = []
    if (existing) {
      stmts.push(c.db.prepare(`UPDATE users SET full_name = ?, phone = COALESCE(?, phone), password_hash = COALESCE(?, password_hash), status = ?, must_change_password = ?, updated_at = ? WHERE id = ?`)
        .bind(fullName, phone || null, hash, status, known ? 1 : 0, now(), userId))
    } else {
      stmts.push(c.db.prepare(`INSERT INTO users (id, institution_id, email, phone, full_name, password_hash, status, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(userId, inst, email || null, phone || null, fullName, hash, status, known ? 1 : 0, now(), now()))
    }
    if (hasStaffRole(roleKeys)) stmts.push(...(await appointEmployeeStmts(c, fullName, email, phone)))
    let sentBy = '', sentTo = ''
    if (temp !== '' && !known) {
      const q = queueIssuedPassword(c, userId, email || null, phone || null, email || phone, temp, enabled)
      sentBy = q.by; sentTo = q.to
      if (q.stmt) stmts.push(q.stmt)
    }
    await c.db.batch(stmts)
    const assigned = await setUserRoles(c, userId, roleKeys, campusIds, false)
    const idx: D1PreparedStatement[] = []
    if (email) idx.push(c.env.CONTROL.prepare(`INSERT OR IGNORE INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, ?, ?, ?)`).bind(email, inst, userId, now()))
    if (phone) idx.push(c.env.CONTROL.prepare(`INSERT OR IGNORE INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('phone', ?, ?, ?, ?)`).bind(phone, inst, userId, now()))
    if (idx.length) await c.env.CONTROL.batch(idx)
    let note = 'The account is invited but has no password yet. Use Reset password to issue one.'
    if (temp !== '') note = known ? 'Their own number is the password. They are asked to set their own the first time they sign in, and can do nothing until they have.'
      : 'Shown once. Hand it over in person; ask them to change it from their profile.'
    return created({ id: userId, full_name: fullName, roles: assigned, status, temporary_password: temp || undefined, sent_by: sentBy || undefined, sent_to: sentTo || undefined, note })
  })

  r.get('/admin/users/{id}', 'access.users.read', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid user id')
    const target = c.params.id
    const u = await c.db.prepare(`SELECT u.id, u.full_name, u.email, u.phone, u.status, u.last_login_at,
        (SELECT count(DISTINCT rp.permission_key) FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = u.id) AS permissions
        FROM users u WHERE u.id = ?`).bind(target)
      .first<{ id: string; full_name: string; email: string | null; phone: string | null; status: string; last_login_at: string | null; permissions: number }>()
    if (!u) throw notFound('resource not found')
    const roles = await c.db.prepare(`SELECT r.key, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.name`).bind(target).all<{ key: string; name: string }>()
    const campuses = await c.db.prepare(`SELECT DISTINCT campus_id FROM user_roles WHERE user_id = ?`).bind(target).all<{ campus_id: string | null }>()
    let all = false
    const ids: string[] = []
    for (const x of campuses.results) { if (x.campus_id === null) all = true; else ids.push(x.campus_id) }
    const sessions = (await sessionCounts(c, [target])).get(target) ?? 0
    return ok({ id: u.id, full_name: u.full_name, email: u.email ?? undefined, phone: u.phone ?? undefined, status: u.status,
      roles: roles.results.map((v) => ({ key: v.key, name: v.name, source: catalogRoleByKey(v.key) ? 'catalog' : 'capability' })),
      permissions: u.permissions, last_login_at: u.last_login_at ?? undefined, active_sessions: sessions, campus_ids: all ? [] : ids, all_campuses: all })
  })

  r.put('/admin/users/{id}/roles', 'access.roles.write', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid user id')
    const target = c.params.id
    const req = await readJSON<{ role_keys?: string[]; campus_ids?: string[] }>(c.req)
    const keys = req.role_keys ?? []
    checkGrantable(keys, c.id.platformAdmin)
    if (keys.length === 0) throw badRequest('a user needs at least one role; suspend the account instead')
    const campusIds = await resolveCampusIDs(c, req.campus_ids)
    if (target === c.id.userId && !keys.some((k) => ['institution_admin', 'super_admin', 'it_admin'].includes(k))) {
      throw badRequest('you cannot remove your own administrator role, ask another administrator')
    }
    await userExists(c, target)
    const applied = await setUserRoles(c, target, keys, campusIds, true)
    const missing = keys.filter((k) => !applied.includes(k))
    return ok({ user_id: target, roles: applied, unknown_roles: missing, note: 'The user will see the new roles the next time they sign in.' })
  })

  r.get('/admin/users/{id}/permissions', 'access.users.read', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid user id')
    await userExists(c, c.params.id)
    const [roleKeys, direct] = await c.db.batch<{ k: string }>([
      c.db.prepare(`SELECT DISTINCT rp.permission_key AS k FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = ? ORDER BY rp.permission_key`).bind(c.params.id),
      c.db.prepare(`SELECT permission_key AS k FROM user_permissions WHERE user_id = ? ORDER BY permission_key`).bind(c.params.id),
    ])
    return ok({ user_id: c.params.id, role_keys: roleKeys.results.map((x) => x.k), direct_keys: direct.results.map((x) => x.k) })
  })

  r.put('/admin/users/{id}/permissions', 'access.users.write', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid user id')
    const target = c.params.id
    const req = await readJSON<{ permission_keys?: string[] }>(c.req)
    const known = new Set(PERMISSION_KEYS)
    const features = allCatalogFeatureKeys()
    const desired: string[] = []
    const add = (k: string) => { if (!desired.includes(k)) desired.push(k) }
    for (const k of req.permission_keys ?? []) {
      if (!known.has(k) && !features.has(k)) continue
      if (!c.id.platformAdmin && (k === 'platform.tenants.write' || k === 'platform.plans.write')) throw forbidden('platform permissions can only be granted by the vendor')
      add(k)
      if (features.has(k)) for (const cap of FEATURE_UNLOCKS[featureSlug(k)] ?? []) add(cap)
    }
    await userExists(c, target)
    const q = inList(desired)
    const stmts = [c.db.prepare(`DELETE FROM user_permissions WHERE user_id = ? AND permission_key NOT IN ${q.sql}`).bind(target, ...q.args)]
    for (const k of desired) stmts.push(c.db.prepare(`INSERT OR IGNORE INTO user_permissions (user_id, institution_id, permission_key, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(target, institutionId(c), k, c.id.userId, now()))
    await c.db.batch(stmts)
    return ok({ user_id: target, direct_keys: desired, note: 'The account gains these the next time it signs in.' })
  })

  r.put('/admin/users/{id}/status', 'access.users.write', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid user id')
    const target = c.params.id
    const req = await readJSON<{ status?: string }>(c.req)
    if (!['active', 'suspended', 'archived', 'invited'].includes(req.status ?? '')) throw badRequest('status must be active, invited, suspended or archived')
    if (target === c.id.userId && req.status !== 'active') throw badRequest('you cannot suspend your own account')
    const res = await c.db.prepare(`UPDATE users SET status = ?, updated_at = ? WHERE id = ?`).bind(req.status, now(), target).run()
    if ((res.meta.changes ?? 0) === 0) throw notFound('resource not found')
    if (req.status !== 'active') await revokeUserSessions(c, target).run()
    return ok({ id: target, status: req.status })
  })

  r.post('/admin/users/{id}/reset-password', 'access.users.write', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid user id')
    const target = c.params.id
    let req: { new_password?: string } = {}
    const cl = Number(c.req.headers.get('content-length') ?? 0)
    if (cl > 0) req = await readJSON(c.req)
    const chosen = (req.new_password ?? '').trim()
    if (chosen !== '') { const n = [...chosen].length; if (n < 12 || n > 200) throw badRequest('new_password must be 12-200 characters') }
    const u = await c.db.prepare(`SELECT email, phone FROM users WHERE id = ?`).bind(target).first<{ email: string | null; phone: string | null }>()
    if (!u) throw notFound('resource not found')
    let temp = chosen, known = false
    if (temp === '') ({ temp, known } = issuedPassword(u.phone ?? '', u.email ?? ''))
    const hash = await hashPassword(c.env.PASSWORD_PEPPER, temp)
    const stmts = [c.db.prepare(`UPDATE users SET password_hash = ?, status = 'active', must_change_password = ?, updated_at = ? WHERE id = ?`).bind(hash, chosen === '' ? 1 : 0, now(), target)]
    let sentBy = '', sentTo = ''
    if (chosen === '' && !known) {
      const q = queueIssuedPassword(c, target, u.email, u.phone, u.email || u.phone || '', temp, await platformChannels(c))
      sentBy = q.by; sentTo = q.to
      if (q.stmt) stmts.push(q.stmt)
    }
    await c.db.batch(stmts)
    await revokeUserSessions(c, target).run()
    let note = 'Shown once. Give it to the user in person and ask them to change it from their profile. All their existing sessions have been signed out.'
    if (known) note = 'Their own number is the password again. They are asked to set their own the first time they sign in. All their existing sessions have been signed out.'
    if (chosen !== '') note = 'The password you set is in effect and is shown here so it can be read out. All their existing sessions have been signed out.'
    return ok({ user_id: target, temporary_password: temp, note, sent_by: sentBy || undefined, sent_to: sentTo || undefined })
  })

  r.post('/admin/users/{id}/mfa/disable', 'access.users.write', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid user id')
    const res = await c.db.prepare(`UPDATE users SET mfa_secret = NULL WHERE id = ?`).bind(c.params.id).run()
    if ((res.meta.changes ?? 0) === 0) throw notFound('resource not found')
    return ok({ mfa_enabled: false })
  })

  r.get('/admin/users/{id}/sign-in-days', 'access.users.read', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid user id')
    const userId = c.params.id
    const days = clampInt(c.url.searchParams.get('days'), 30, 7, 180)
    const u = await c.db.prepare(`SELECT email, phone, username FROM users WHERE id = ?`).bind(userId).first<{ email: string | null; phone: string | null; username: string | null }>()
    const idents = [u?.email, u?.phone, u?.username].filter((x): x is string => !!x)
    const iq = inList(idents.length ? idents : ['\u0000none'])
    const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
    const [okRows, failRows, screenRows] = await Promise.all([
      c.env.CONTROL.prepare(`SELECT substr(at, 1, 10) AS d, count(*) AS n FROM login_events WHERE user_id = ? AND outcome = 'success' AND at >= ? GROUP BY d`).bind(userId, since).all<{ d: string; n: number }>(),
      c.env.CONTROL.prepare(`SELECT substr(at, 1, 10) AS d, count(*) AS n FROM login_events WHERE outcome IN ('wrong_password','locked','mfa_failed')
          AND (user_id = ? OR (user_id IS NULL AND identifier IN ${iq.sql})) AND at >= ? GROUP BY d`).bind(userId, ...iq.args, since).all<{ d: string; n: number }>(),
      c.db.prepare(`SELECT substr(last_at, 1, 10) AS d, COALESCE(sum(hits), 0) AS n FROM session_screens WHERE user_id = ? AND last_at >= ? GROUP BY d`).bind(userId, since).all<{ d: string; n: number }>(),
    ])
    const m = (rows: { d: string; n: number }[]) => new Map(rows.map((x) => [x.d, Number(x.n)]))
    const okM = m(okRows.results), failM = m(failRows.results), scrM = m(screenRows.results)
    const out: unknown[] = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)
      out.push({ day: d, ok: okM.get(d) ?? 0, failed: failM.get(d) ?? 0, screens: scrM.get(d) ?? 0 })
    }
    return ok({ items: out })
  })

  // roles ----------------------------------------------------------------------
  r.get('/admin/roles/templates', 'access.roles.write', async (c) => {
    const present = new Set((await c.db.prepare(`SELECT key FROM roles WHERE institution_id = ?`).bind(institutionId(c)).all<{ key: string }>()).results.map((x) => x.key))
    const items = SYSTEM_ROLES.filter((r) => !r.platform).map((r) => ({ key: r.key, name: r.name, description: OPTIONAL_ROLE_NOTES[r.key] || undefined, permissions: r.permissions.length, installed: present.has(r.key) }))
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return ok({ items })
  })

  r.get('/admin/installable-roles', 'access.roles.read', async (c) => {
    const present = new Set((await c.db.prepare(`SELECT key FROM roles WHERE institution_id = ?`).bind(institutionId(c)).all<{ key: string }>()).results.map((x) => x.key))
    const items = SYSTEM_ROLES.filter((r) => !r.is_default && !r.platform).map((r) => ({ key: r.key, name: r.name, description: OPTIONAL_ROLE_NOTES[r.key] ?? '', installed: present.has(r.key), permissions: r.permissions.length }))
    items.sort((a, b) => (a.installed !== b.installed ? (a.installed ? 1 : -1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return ok({ items })
  })

  r.post('/admin/roles/install', 'access.roles.write', async (c) => {
    const req = await readJSON<{ key?: string }>(c.req)
    const key = req.key ?? ''
    if (isDefaultRole(key)) throw badRequest(key + ' is not an optional role')
    if (!c.id.institution) throw badRequest('choose a school before installing a role')
    const { roleId, created: made } = await installOptionalRole(c, key)
    return ok({ id: roleId, key, installed: made })
  })

  r.post('/admin/roles', 'access.roles.write', async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ name?: string; copy_from?: string }>(c.req)
    const name = (req.name ?? '').trim()
    if (name === '') throw badRequest('a role needs a name')
    const key = slugKey(name)
    if (key === '') throw badRequest('the name needs at least one letter or number')
    const dup = await c.db.prepare(`SELECT 1 AS x FROM roles WHERE COALESCE(institution_id, ?) = ? AND key = ?`).bind(NIL_UUID, inst, key).first()
    if (dup) throw badRequest('a role called ' + name + ' already exists')
    const roleId = uuid()
    const stmts = [c.db.prepare(`INSERT INTO roles (id, institution_id, key, name, is_system, is_default, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)`).bind(roleId, inst, key, name, now())]
    if (req.copy_from) {
      const q = inList(PERMISSION_KEYS)
      stmts.push(c.db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT ?, rp.permission_key FROM role_permissions rp JOIN roles src ON src.id = rp.role_id
          WHERE src.key = ? AND rp.permission_key IN ${q.sql} AND rp.permission_key NOT LIKE 'platform.%'`).bind(roleId, req.copy_from, ...q.args))
    }
    await c.db.batch(stmts)
    return created({ id: roleId, key, name })
  })

  r.get('/admin/roles/{id}/permissions', 'access.roles.read', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid role id')
    const rows = await c.db.prepare(`SELECT p.key, p.module, p.description FROM role_permissions rp JOIN permissions p ON p.key = rp.permission_key WHERE rp.role_id = ? ORDER BY p.module, p.key`)
      .bind(c.params.id).all<{ key: string; module: string; description: string }>()
    return ok({ items: rows.results })
  })

  r.get('/admin/roles/{id}/grid', 'access.roles.read', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid role id')
    const ro = await c.db.prepare(`SELECT ro.id, ro.key, ro.name, ro.is_system, ro.is_default, ro.customised_at IS NOT NULL AS customised,
        (SELECT count(*) FROM user_roles ur WHERE ur.role_id = ro.id) AS users FROM roles ro WHERE ro.id = ?`).bind(c.params.id)
      .first<{ id: string; key: string; name: string; is_system: number; is_default: number; customised: number; users: number }>()
    if (!ro) throw notFound('resource not found')
    const known = new Set(PERMISSION_KEYS)
    const keys = (await c.db.prepare(`SELECT permission_key FROM role_permissions WHERE role_id = ?`).bind(ro.id).all<{ permission_key: string }>()).results.map((x) => x.permission_key)
    const caps = keys.filter((k) => known.has(k))
    const featureGrants = keys.length - caps.length
    let lockNote = ''
    if (ro.is_system && ro.customised) lockNote = 'This is a built-in role that this school has changed. Your version is kept across upgrades. Reset to preset puts the original back.'
    else if (ro.is_system) lockNote = 'This is a built-in preset. You can change it here and your version is kept across upgrades; Reset to preset puts the original back. Or start a copy from it if you want the original kept alongside.'
    const states = new Map(readGrid(caps).map((s) => [s.group, s]))
    const groups = GROUPS.map((g) => {
      const st = states.get(g.key)!
      return { key: g.key, name: g.name, blurb: g.blurb, band: g.band, levels: groupLevels(g).map(levelName), can_approve: g.approve.length > 0,
        approve_note: APPROVE_NOTES[g.key] || undefined, can_export: g.export.length > 0,
        scope_options: g.scopes.map((s) => ({ scope: s.scope, label: SCOPE_LABELS[s.scope] ?? s.scope })), scope_note: g.scope_note || undefined,
        group: st.group, level: st.level, scope: st.scope, approve: st.approve, export: st.export, extra: st.extra }
    })
    return ok({ id: ro.id, key: ro.key, name: ro.name, is_system: !!ro.is_system, is_preset: !!ro.is_system, is_default: !!ro.is_default, editable: true,
      customised: !!ro.customised, lock_note: lockNote || undefined, users: ro.users, groups, feature_grants: featureGrants })
  })

  r.put('/admin/roles/{id}/grid', 'access.roles.write', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid role id')
    const roleId = c.params.id
    const req = await readJSON<{ groups?: GroupState[] }>(c.req)
    const groups = req.groups ?? []
    for (const st of groups) {
      const g = groupByKey(st.group)
      if (!g) throw badRequest('unknown permission group ' + st.group)
      const level = parseLevel(st.level)
      if (level === null) throw badRequest('unknown level ' + st.level + ' for ' + st.group)
      if (!groupLevels(g).includes(level)) throw badRequest(g.name + ' does not offer the ' + st.level + ' level')
      if (st.scope && !g.scopes.some((s) => s.scope === st.scope)) throw badRequest(g.name + ' cannot be scoped to ' + st.scope)
    }
    const desired = applyGrid(groups)
    if (!c.id.platformAdmin && desired.some((k) => k === 'platform.tenants.write' || k === 'platform.plans.write')) throw forbidden('platform permissions can only be granted by the vendor')
    const ro = await c.db.prepare(`SELECT is_system FROM roles WHERE id = ? AND (institution_id IS NOT NULL OR ?)`).bind(roleId, c.id.platformAdmin ? 1 : 0).first<{ is_system: number }>()
    if (!ro) throw notFound('resource not found')
    const known = inList(PERMISSION_KEYS), want = inList(desired)
    const stmts = [
      c.db.prepare(`UPDATE roles SET customised_at = COALESCE(customised_at, ?) WHERE id = ? AND is_system`).bind(now(), roleId),
      c.db.prepare(`DELETE FROM role_permissions WHERE role_id = ? AND permission_key IN ${known.sql} AND permission_key NOT IN ${want.sql}`).bind(roleId, ...known.args, ...want.args),
      ...desired.map((k) => c.db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)`).bind(roleId, k)),
    ]
    await c.db.batch(stmts)
    return ok({ id: roleId, permissions: desired.length })
  })

  r.post('/admin/roles/{id}/reset', 'access.roles.write', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid role id')
    const ro = await c.db.prepare(`SELECT key, is_system FROM roles WHERE id = ? AND (institution_id IS NOT NULL OR ?)`).bind(c.params.id, c.id.platformAdmin ? 1 : 0).first<{ key: string; is_system: number }>()
    if (!ro) throw notFound('resource not found')
    if (!ro.is_system) throw badRequest('only a built-in role has a preset to go back to')
    const def = systemRoleByKey(ro.key)
    if (!def) throw new HttpError(500, ro.key + ' is not a built-in role')
    await c.db.batch([
      c.db.prepare(`UPDATE roles SET customised_at = NULL WHERE id = ?`).bind(c.params.id),
      c.db.prepare(`DELETE FROM role_permissions WHERE role_id = ?`).bind(c.params.id),
      ...def.permissions.map((k) => c.db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)`).bind(c.params.id, k)),
    ])
    return ok({ id: c.params.id, reset: true })
  })

  r.get('/admin/roles/{id}/features', 'access.roles.read', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid role id')
    const ro = await c.db.prepare(`SELECT key FROM roles WHERE id = ?`).bind(c.params.id).first<{ key: string }>()
    if (!ro) throw notFound('resource not found')
    const role = catalogRoleByKey(ro.key)
    if (!role) return ok({ workspace: false, sections: [] })
    const held = new Set((await c.db.prepare(`SELECT permission_key FROM role_permissions WHERE role_id = ?`).bind(c.params.id).all<{ permission_key: string }>()).results.map((x) => x.permission_key))
    return ok(buildRoleFeatures(role, held))
  })

  r.put('/admin/roles/{id}/features', 'access.roles.write', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid role id')
    const roleId = c.params.id
    const req = await readJSON<{ enable?: string[]; disable?: string[] }>(c.req)
    const ro = await c.db.prepare(`SELECT key FROM roles WHERE id = ? AND (institution_id IS NOT NULL OR ?)`).bind(roleId, c.id.platformAdmin ? 1 : 0).first<{ key: string }>()
    if (!ro) throw notFound('resource not found')
    const role = catalogRoleByKey(ro.key)
    if (!role) throw badRequest('this role has no workspace of its own')
    const allowed = new Set<string>()
    for (const sec of role.sections) for (const f of sec.features) allowed.add(f.key)
    const enable = req.enable ?? [], disable = req.disable ?? []
    for (const k of [...enable, ...disable]) if (!allowed.has(k)) throw badRequest(k + " is not a feature of this role's workspace")
    const stmts: D1PreparedStatement[] = []
    if (enable.length + disable.length > 0) stmts.push(c.db.prepare(`UPDATE roles SET customised_at = COALESCE(customised_at, ?) WHERE id = ? AND is_system`).bind(now(), roleId))
    for (const k of enable) stmts.push(c.db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)`).bind(roleId, k))
    if (disable.length) { const q = inList(disable); stmts.push(c.db.prepare(`DELETE FROM role_permissions WHERE role_id = ? AND permission_key IN ${q.sql}`).bind(roleId, ...q.args)) }
    if (stmts.length) await c.db.batch(stmts)
    const held = new Set((await c.db.prepare(`SELECT permission_key FROM role_permissions WHERE role_id = ?`).bind(roleId).all<{ permission_key: string }>()).results.map((x) => x.permission_key))
    return ok(buildRoleFeatures(role, held))
  })

  // users.go: catalogues and presets -----------------------------------------------
  r.get('/admin/assignable-roles', 'auth', async (c) => {
    if (!can(c.id, 'access.roles.read') && !can(c.id, 'hr.employees.write')) throw forbidden('you cannot read the role list')
    const installable = new Map<string, string>()
    for (const sr of SYSTEM_ROLES) {
      if (sr.is_default || sr.platform || sr.key === 'student' || sr.key === 'parent') continue
      installable.set(sr.key, sr.name)
    }
    const platformKeys = [...PLATFORM_ONLY_ROLES].sort()
    const pq = inList(platformKeys)
    const rows = await c.db.prepare(`SELECT r.key, r.name, (SELECT count(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permissions,
        (SELECT count(*) FROM user_roles ur WHERE ur.role_id = r.id) AS users FROM roles r
       WHERE r.key NOT IN ('student','parent') AND (? OR r.key NOT IN ${pq.sql}) ORDER BY r.name`).bind(c.id.platformAdmin ? 1 : 0, ...pq.args)
      .all<{ key: string; name: string; permissions: number; users: number }>()
    const pairs = await c.db.prepare(`SELECT r.key, rp.permission_key FROM roles r JOIN role_permissions rp ON rp.role_id = r.id ORDER BY r.key, rp.permission_key`).all<{ key: string; permission_key: string }>()
    const byRole = new Map<string, string[]>()
    for (const p of pairs.results) byRole.set(p.key, [...(byRole.get(p.key) ?? []), p.permission_key])
    type Item = { key: string; name: string; source: string; permissions: number; users: number; description: string; permission_keys: string[] }
    let items: Item[] = rows.results.map((v) => ({ key: v.key, name: v.name, source: catalogRoleByKey(v.key) ? 'catalog' : 'capability', permissions: v.permissions, users: v.users,
      description: ROLE_DESCRIPTIONS[v.key] ?? '', permission_keys: byRole.get(v.key) ?? [] }))
    for (const it of items) installable.delete(it.key)
    for (const [key, name] of installable) {
      const keys = systemRoleByKey(key)?.permissions ?? []
      items.push({ key, name, description: ROLE_DESCRIPTIONS[key] ?? '', source: 'installable', permissions: keys.length, users: 0, permission_keys: keys })
    }
    items = [...items.filter((i) => i.source === 'catalog'), ...items.filter((i) => i.source !== 'catalog')]
    return ok({ items })
  })

  r.get('/admin/role-presets', 'access.roles.read', async (c) => {
    const existing = new Set((await c.db.prepare(`SELECT key FROM roles`).all<{ key: string }>()).results.map((x) => x.key))
    return ok({ items: ROLE_PRESETS.map((p) => { const missing = p.role_keys.filter((k) => !existing.has(k)); return { ...p, new_to_school: missing.length ? missing : undefined } }) })
  })

  r.get('/admin/permissions', 'access.users.read', (c) => ok({
    items: PERMISSIONS.filter((p) => c.id.platformAdmin || (p.key !== 'platform.tenants.write' && p.key !== 'platform.plans.write')),
  }))

  r.get('/admin/features', 'access.users.read', () => {
    const desc = new Map(PERMISSIONS.map((p) => [p.key, p.description]))
    const skip = new Set(['dashboard', 'home', 'my_day', 'todays_classes', 'my_work', 'my_calendar', 'my_run'])
    type Item = { name: string; summary: string; unlocks: string[]; key: string; keys: string[] }
    const items: Item[] = []
    const idx = new Map<string, Item>()
    for (const role of CATALOG_ROLES) for (const sec of role.sections) for (const f of sec.features) {
      if (skip.has(featureSlug(f.key)) || f.name === '') continue
      let it = idx.get(f.name)
      if (!it) { it = { name: f.name, summary: f.summary, unlocks: [], key: f.key, keys: [] }; idx.set(f.name, it); items.push(it) }
      if (it.summary === '' && f.summary !== '') it.summary = f.summary
      if (!it.keys.includes(f.key)) it.keys.push(f.key)
      for (const cap of FEATURE_UNLOCKS[featureSlug(f.key)] ?? []) { const d = desc.get(cap) || cap; if (!it.unlocks.includes(d)) it.unlocks.push(d) }
    }
    items.sort((a, b) => { const x = a.name.toLowerCase(), y = b.name.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0 })
    return ok({ items })
  })

  // acting.go / platform_dashboard.go: across every school --------------------------
  r.get('/admin/institutions', 'auth', async (c) => {
    if (!c.id.platformAdmin) throw forbidden('only a platform operator can list every school')
    const insts = await c.env.CONTROL.prepare(`SELECT * FROM institutions ORDER BY name`).all<Institution>()
    const items = []
    for (const i of insts.results) {
      let students = 0, district: string | null = null, udise: string | null = null
      try {
        const db = tenantDb(c.env, i)
        const row = await db.prepare(`SELECT (SELECT count(*) FROM students WHERE status = 'active') AS n, (SELECT district FROM institutions WHERE id = ?) AS district, (SELECT udise_code FROM institutions WHERE id = ?) AS udise`)
          .bind(i.id, i.id).first<{ n: number; district: string | null; udise: string | null }>()
        students = row?.n ?? 0; district = row?.district ?? null; udise = row?.udise ?? null
      } catch { /* no binding for this school yet */ }
      items.push({ id: i.id, name: i.name, short_name: i.short_name, slug: i.slug, district: district ?? undefined, udise_code: udise ?? undefined, students, status: i.status })
    }
    return ok({ items })
  })

  r.get('/admin/platform-dashboard', 'auth', async (c) => {
    if (!c.id.platformAdmin) throw forbidden('only platform staff can see across schools')
    const range = resolveRange(c)
    const out = { range, schools: 0, campuses: 0, students: 0, staff: 0, collected_paise: 0, outstanding_paise: 0, billed_paise: 0, enquiries: 0, applications: 0, offered: 0, enrolled: 0,
      campuses_detail: [] as Record<string, unknown>[], alerts: [] as Record<string, unknown>[], attendance_trend: [] as { date: string; percent: number; marked: number }[] }
    const insts = await c.env.CONTROL.prepare(`SELECT * FROM institutions WHERE status = 'active' ORDER BY name`).all<Institution>()
    out.schools = insts.results.length
    const trend = new Map<string, { present: number; total: number }>()
    for (const i of insts.results) {
      let db: D1Database
      try { db = tenantDb(c.env, i) } catch { continue }
      const [tot, cards, att] = await db.batch<Record<string, unknown>>([
        db.prepare(`SELECT (SELECT count(*) FROM campuses) AS campuses, (SELECT count(*) FROM students WHERE status = 'active') AS students,
            (SELECT count(*) FROM employees WHERE status = 'active') AS staff,
            COALESCE((SELECT sum(amount_paise) FROM payments WHERE status = 'success' AND paid_on BETWEEN ?1 AND ?2), 0) AS collected,
            COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices WHERE status IN ('unpaid','partial','overdue')), 0) AS outstanding,
            COALESCE((SELECT sum(net_paise) FROM invoices WHERE status <> 'cancelled'), 0) AS billed,
            (SELECT count(*) FROM enquiries WHERE substr(created_at,1,10) BETWEEN ?1 AND ?2) AS enquiries,
            (SELECT count(*) FROM applications WHERE substr(created_at,1,10) BETWEEN ?1 AND ?2) AS applications,
            (SELECT count(*) FROM applications WHERE status = 'offered' AND substr(created_at,1,10) BETWEEN ?1 AND ?2) AS offered,
            (SELECT count(*) FROM applications WHERE status = 'accepted' AND substr(created_at,1,10) BETWEEN ?1 AND ?2) AS enrolled`).bind(range.from, range.to),
        db.prepare(`SELECT c.name AS campus, (SELECT district FROM institutions WHERE id = c.institution_id) AS district,
            (SELECT count(*) FROM students st WHERE st.campus_id = c.id AND st.status = 'active') AS students,
            (SELECT count(*) FROM employees e WHERE e.campus_id = c.id AND e.status = 'active') AS staff,
            (SELECT CAST(round(100.0 * sum(sa.status IN ('present','late')) / NULLIF(count(*),0)) AS INTEGER) FROM student_attendance sa JOIN students st2 ON st2.id = sa.student_id WHERE st2.campus_id = c.id AND sa.on_date = date('now')) AS attendance_pct,
            (SELECT count(*) FROM student_attendance sa JOIN students st3 ON st3.id = sa.student_id WHERE st3.campus_id = c.id AND sa.on_date = date('now')) AS marked_today,
            COALESCE((SELECT sum(p.amount_paise) FROM payments p WHERE p.campus_id = c.id AND p.status = 'success' AND p.paid_on BETWEEN ?1 AND ?2), 0) AS collected,
            COALESCE((SELECT sum(v.net_paise - v.paid_paise) FROM invoices v WHERE v.campus_id = c.id AND v.status IN ('unpaid','partial','overdue')), 0) AS outstanding,
            (SELECT count(DISTINCT v2.student_id) FROM invoices v2 WHERE v2.campus_id = c.id AND v2.status IN ('unpaid','partial','overdue') AND v2.due_on IS NOT NULL AND v2.due_on < date('now')) AS defaulters
            FROM campuses c ORDER BY c.name`).bind(range.from, range.to),
        db.prepare(`SELECT on_date, sum(status IN ('present','late')) AS present, count(*) AS total FROM student_attendance WHERE on_date BETWEEN ? AND ? GROUP BY on_date`).bind(range.from, range.to),
      ])
      const t = tot.results[0] ?? {}
      out.campuses += Number(t.campuses ?? 0); out.students += Number(t.students ?? 0); out.staff += Number(t.staff ?? 0)
      out.collected_paise += Number(t.collected ?? 0); out.outstanding_paise += Number(t.outstanding ?? 0); out.billed_paise += Number(t.billed ?? 0)
      out.enquiries += Number(t.enquiries ?? 0); out.applications += Number(t.applications ?? 0); out.offered += Number(t.offered ?? 0); out.enrolled += Number(t.enrolled ?? 0)
      for (const k of cards.results) {
        out.campuses_detail.push({ institution_id: i.id, school: i.name, campus: k.campus, district: k.district ?? undefined, students: Number(k.students), staff: Number(k.staff),
          attendance_pct: k.attendance_pct === null ? undefined : Number(k.attendance_pct), marked_today: Number(k.marked_today), collected_paise: Number(k.collected),
          outstanding_paise: Number(k.outstanding), defaulters: Number(k.defaulters) })
      }
      for (const a of att.results) {
        const e = trend.get(String(a.on_date)) ?? { present: 0, total: 0 }
        e.present += Number(a.present); e.total += Number(a.total); trend.set(String(a.on_date), e)
      }
    }
    out.attendance_trend = [...trend.entries()].sort().map(([date, v]) => ({ date, percent: v.total ? Math.round((100 * v.present) / v.total) : 0, marked: v.total }))
    for (const k of out.campuses_detail) {
      const school = k.school + ' · ' + k.campus
      const students = Number(k.students), marked = Number(k.marked_today), pct = k.attendance_pct as number | undefined, def = Number(k.defaulters)
      if (students > 0 && marked === 0) out.alerts.push({ severity: 'high', kind: 'attendance', school, message: 'No register marked today across ' + students + ' students' })
      else if (pct !== undefined && pct < 75) out.alerts.push({ severity: 'medium', kind: 'attendance', school, message: 'Attendance at ' + pct + '% today, below the 75% board threshold' })
      if (def > 0 && students > 0 && Math.floor((def * 100) / students) > 25) out.alerts.push({ severity: 'medium', kind: 'fees', school, message: def + ' of ' + students + ' students are overdue on fees' })
      if (students === 0) out.alerts.push({ severity: 'low', kind: 'setup', school, message: 'No students enrolled. Setup may be unfinished' })
    }
    return ok(out)
  })

}


function buildRoleFeatures(role: { sections: { slug: string; name: string; features: { key: string; name: string; summary: string }[] }[] }, held: Set<string>) {
  return { workspace: true, sections: role.sections.map((sec) => ({ slug: sec.slug, name: sec.name,
    features: sec.features.map((f) => ({ key: f.key, name: f.name, summary: f.summary, held: held.has(f.key) })) })) }
}
