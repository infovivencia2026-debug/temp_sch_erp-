import type { Router } from '../../router'
import { HttpError, badRequest, created, isUUID, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { hashPassword } from '../../auth/password'
import { institutionById, tenantDb, type Institution } from '../../tenant'
import type { Env } from '../../env'
import { notImplemented, requirePlatformAdmin } from './common'

/* Port of internal/api/seller.go, plans_write.go, tenant_limits.go,
   support_accounts.go and board_members.go: the vendor's back office.

   Postgres held every school in one database, so "count the students of each
   institution" was a subquery. Here institutions, plans and subscriptions live
   in CONTROL and everything per school lives in that school's own D1, so the
   cross-tenant screens open each school's database in turn and merge. A school
   whose binding is not deployed yet is listed from CONTROL alone with zeros
   rather than making the whole directory fail. */

const PERM = 'platform.tenants.write'

// --- shared vocabulary (internal/entitlement) -------------------------------

const ALL_MODULES = ['students', 'academics', 'attendance', 'fees', 'communication',
  'exams', 'hr', 'transport', 'library', 'hostel', 'inventory']

const MODULE_LABELS: Record<string, string> = {
  students: 'Student records',
  academics: 'Classes, sections and timetable',
  attendance: 'Attendance',
  fees: 'Fee collection and receipts',
  communication: 'SMS, email and circulars',
  exams: 'Examinations and report cards',
  hr: 'Staff records and payroll',
  transport: 'Transport and routes',
  library: 'Library',
  hostel: 'Hostel',
  inventory: 'Stores and inventory',
}

const PRESETS = [
  { key: 'office', name: 'Office essentials',
    blurb: 'The register, the money and telling parents. What a small low-fee school will pay for in its first year, before it trusts software with marks.',
    modules: ['students', 'fees', 'communication'] },
  { key: 'academic', name: 'Full academics',
    blurb: 'Adds the timetable, attendance and the exam and report-card run. The ordinary CBSE or state-board day school that owns no buses and no hostel.',
    modules: ['students', 'academics', 'attendance', 'fees', 'communication', 'exams'] },
  { key: 'campus', name: 'Residential campus',
    blurb: 'Everything, including transport, hostel, library, stores and payroll. The boarding school, and the large day school that runs its own fleet.',
    modules: [...ALL_MODULES] },
]

const SUBSCRIPTION_STATUSES = ['trial', 'active', 'past_due', 'suspended', 'cancelled']

/** plans.modules is TEXT: a JSON array here, or a Postgres `{a,b}` literal left by the migration. */
function parseModules(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s === '' || s === '{}' || s === '[]') return []
  if (s.startsWith('[')) { try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : [] } catch { return [] } }
  if (s.startsWith('{')) return s.slice(1, -1).split(',').map((m) => m.trim().replace(/^"|"$/g, '')).filter(Boolean)
  return []
}

// --- small helpers -------------------------------------------------------------

/** Mirrors api.temporaryPassword: readable aloud, no I/O/0/1, XXXX-XXXX-XXXX. */
function temporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const b = crypto.getRandomValues(new Uint8Array(12))
  const out = Array.from(b, (v) => alphabet[v % alphabet.length]).join('')
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`
}

const nullStr = (s: string | undefined | null) => (s === undefined || s === null || s === '' ? null : s)
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null)
const stamp = (iso: string | null | undefined) => (iso ? iso.slice(0, 19).replace(' ', 'T') + 'Z' : null)
const today = () => now().slice(0, 10)
function addDays(d: string, n: number): string {
  const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10)
}
function addYear(d: string): string {
  const t = new Date(d + 'T00:00:00Z'); t.setUTCFullYear(t.getUTCFullYear() + 1); return t.toISOString().slice(0, 10)
}

/** The school's D1, or null when its binding is not deployed on this Worker. */
function openTenant(env: Env, inst: Institution): D1Database | null {
  try { return tenantDb(env, inst) } catch { return null }
}

async function allInstitutions(env: Env): Promise<Institution[]> {
  const r = await env.CONTROL.prepare('SELECT * FROM institutions ORDER BY name').all<Institution>()
  return r.results
}

/** Mirrors api.recordPlatformEvent: the vendor's own log, and a log that can fail the thing it logs is worse than none. */
async function recordPlatformEvent(env: Env, kind: string, okFlag: boolean, inst: string | null,
  subject: string, detail: string, actor: string): Promise<void> {
  try {
    await env.CONTROL.prepare(`INSERT INTO platform_events (id, kind, ok, institution_id, subject, detail, actor_id, at)
        VALUES (?,?,?,?,?,?,?,?)`).bind(uuid(), kind, okFlag ? 1 : 0, inst, subject, detail, actor, now()).run()
  } catch (e) { console.error('platform_events', e) }
}

/** Every sign-in identifier of a user, written to CONTROL so login.ts can find the school. */
function loginIndexRows(env: Env, instId: string | null, userId: string,
  ids: { email?: string | null; phone?: string | null; username?: string | null }): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = []
  const t = now()
  for (const [kind, value] of Object.entries(ids)) {
    if (!value) continue
    out.push(env.CONTROL.prepare(`INSERT OR IGNORE INTO login_index (kind, value, institution_id, user_id, created_at) VALUES (?,?,?,?,?)`)
      .bind(kind, value, instId, userId, t))
  }
  return out
}

const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message)

/** Mirrors entitlement.ApplyPlan: module_settings in the school's database says exactly what the plan includes. */
async function applyPlan(env: Env, inst: Institution, planCode: string): Promise<void> {
  const plan = await env.CONTROL.prepare('SELECT modules FROM plans WHERE code = ?').bind(planCode).first<{ modules: string }>()
  if (!plan) return
  const db = openTenant(env, inst)
  if (!db) return
  const mods = parseModules(plan.modules)
  const everything = mods.length === 0
  await db.batch(ALL_MODULES.map((m) => db.prepare(`INSERT INTO module_settings (institution_id, module, enabled) VALUES (?,?,?)
      ON CONFLICT (institution_id, module) DO UPDATE SET enabled = excluded.enabled`)
    .bind(inst.id, m, everything || mods.includes(m) ? 1 : 0)))
}

/** Mirrors api.slugify: URL-safe, plus eight hex characters against collisions. */
function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'school'
  return base + '-' + uuid().slice(0, 8)
}

/** Mirrors api.deriveShortName: initials, at most six. */
function deriveShortName(name: string): string {
  const s = name.split(/[ ,.-]+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('').slice(0, 6)
  return s || 'SCHOOL'
}

/** What the vendor promised, by plan and by urgency (seller.go promisedHours). */
function promisedHours(planCode: string, priority: string): number {
  let tier = 3
  switch (planCode.toLowerCase()) {
    case 'enterprise': case 'ent': tier = 0; break
    case 'pro': case 'campus_pro': case 'premium': tier = 1; break
    case 'basic': case 'standard': case 'starter': tier = 2; break
  }
  const promise = [[1, 4, 8, 24], [4, 8, 24, 48], [8, 24, 48, 72], [24, 48, 72, 120]]
  let col = 2
  switch (priority.toLowerCase()) { case 'urgent': col = 0; break; case 'high': col = 1; break; case 'low': col = 3; break }
  return promise[tier][col]
}

interface SubRow { institution_id: string; plan_code: string | null; plan_name: string | null; status: string | null; renews_on: string | null; licensed_students: number | null; storage_gb: number | null; max_students: number | null; max_storage_gb: number | null }

async function subscriptionsByInstitution(env: Env, where = ''): Promise<Map<string, SubRow>> {
  const r = await env.CONTROL.prepare(`SELECT sub.institution_id, sub.plan_code, p.name AS plan_name, sub.status, sub.renews_on,
      sub.licensed_students, sub.storage_gb, p.max_students, p.max_storage_gb
      FROM subscriptions sub LEFT JOIN plans p ON p.code = sub.plan_code ${where}`).all<SubRow>()
  return new Map(r.results.map((s) => [s.institution_id, s]))
}

// --- routes -------------------------------------------------------------------------

export function registerSellerTenants(r: Router): void {
  // --- the customer list ---
  r.get('/seller/tenants', PERM, async (c) => {
    requirePlatformAdmin(c)
    const insts = await allInstitutions(c.env)
    const subs = await subscriptionsByInstitution(c.env, `WHERE sub.status <> 'cancelled'`)
    const items = await Promise.all(insts.map(async (i) => {
      const sub = subs.get(i.id)
      let students = 0, staff = 0, setup = 0
      let district: string | null = null, lastSignIn: string | null = null
      const db = openTenant(c.env, i)
      if (db) {
        const row = await db.prepare(`SELECT
            (SELECT count(*) FROM students st WHERE st.status = 'active') AS students,
            (SELECT count(*) FROM employees e WHERE e.status = 'active') AS staff,
            (SELECT district FROM institutions WHERE id = ?) AS district,
            (SELECT max(u.last_login_at) FROM users u) AS last_sign_in,
            (
              (SELECT district IS NOT NULL AND affiliation_board IS NOT NULL FROM institutions WHERE id = ?) +
              EXISTS (SELECT 1 FROM campuses) + EXISTS (SELECT 1 FROM academic_years) + EXISTS (SELECT 1 FROM classes) +
              EXISTS (SELECT 1 FROM sections) + EXISTS (SELECT 1 FROM subjects) + EXISTS (SELECT 1 FROM employees) +
              EXISTS (SELECT 1 FROM students) + EXISTS (SELECT 1 FROM fee_heads) + EXISTS (SELECT 1 FROM exams)
            ) * 10 AS setup`).bind(i.id, i.id)
          .first<{ students: number; staff: number; district: string | null; last_sign_in: string | null; setup: number | null }>()
        if (row) { students = row.students; staff = row.staff; district = row.district; lastSignIn = day(row.last_sign_in); setup = row.setup ?? 0 }
      }
      const licensed = sub?.licensed_students ?? null
      const out: Record<string, unknown> = {
        id: i.id, name: i.name, short_name: i.short_name, status: i.status, students, staff,
        over_by: licensed !== null && students > licensed ? students - licensed : 0,
        setup_percent: setup, created_on: day((i as unknown as { created_at: string }).created_at) ?? '',
      }
      if (district !== null) out.district = district
      if (sub?.plan_code) out.plan = sub.plan_code
      if (sub?.plan_name) out.plan_name = sub.plan_name
      if (sub?.status) out.subscription_status = sub.status
      if (sub?.renews_on) out.renews_on = day(sub.renews_on)
      if (licensed !== null) out.licensed_students = licensed
      if (lastSignIn) out.last_sign_in = lastSignIn
      return out
    }))
    return ok({ items })
  })

  // --- provisioning ---
  r.post('/seller/tenants', PERM, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const str = (k: string) => (typeof req[k] === 'string' ? (req[k] as string) : '')
    const p = {
      schoolName: str('school_name').trim(), shortName: str('short_name').trim(),
      district: str('district'), state: str('state'), board: str('affiliation_board'), planCode: str('plan_code'),
      adminName: str('admin_name').trim(), adminEmail: str('admin_email'), adminPhone: str('admin_phone'),
      adminUsername: str('admin_username').trim().toLowerCase(),
      trialDays: typeof req.trial_days === 'number' ? req.trial_days : 0,
      d1DatabaseId: str('d1_database_id'), d1Binding: str('d1_binding'),
    }
    const fail = async (msg: string) => { await recordPlatformEvent(c.env, 'provision', false, null, p.schoolName, msg, c.id.userId) }

    if (!p.schoolName) { await fail('the school needs a name'); throw badRequest('the school needs a name') }
    if (!p.adminName) { await fail('the first administrator needs a name'); throw badRequest('the first administrator needs a name') }
    if (!p.adminEmail && !p.adminPhone && !p.adminUsername) {
      const m = 'give the administrator an email, a phone number or a username - without one of the three they cannot sign in'
      await fail(m); throw badRequest(m)
    }
    if (p.planCode) {
      const plan = await c.env.CONTROL.prepare('SELECT max_students FROM plans WHERE code = ?').bind(p.planCode).first<{ max_students: number | null }>()
      if (!plan) { await fail('unknown plan'); throw badRequest('that plan does not exist') }
    }
    /* Postgres made the school's tables by inserting rows; here a school is a
       D1 database that only wrangler can create. The seller passes the database
       provision-school.sh made, or the request stops before writing anything. */
    if (!p.d1DatabaseId || !p.d1Binding) notImplemented('provision tenant database')
    const raw = c.env[p.d1Binding]
    if (!raw || typeof raw !== 'object' || !('prepare' in raw)) notImplemented('provision tenant database')
    const tdb = raw as D1Database
    const adminRole = await tdb.prepare(`SELECT id FROM roles WHERE key = 'institution_admin' LIMIT 1`).first<{ id: string }>()
    if (!adminRole) notImplemented('provision tenant seed')

    const taken = await c.env.CONTROL.prepare('SELECT 1 FROM institutions WHERE name = ?').bind(p.schoolName).first()
    if (taken) { await fail('a school with that name already exists'); throw new HttpError(409, 'a school with that name already exists', { code: 'name_taken' }) }

    const instId = uuid(), userId = uuid(), t = now(), slug = slugify(p.schoolName)
    const short = p.shortName || deriveShortName(p.schoolName)
    const password = temporaryPassword()
    const hash = await hashPassword(c.env.PASSWORD_PEPPER, password)

    const control: D1PreparedStatement[] = [
      c.env.CONTROL.prepare(`INSERT INTO institutions (id, name, short_name, slug, status, d1_database_id, d1_binding, created_at, updated_at)
          VALUES (?,?,?,?,'active',?,?,?,?)`).bind(instId, p.schoolName, short, slug, p.d1DatabaseId, p.d1Binding, t, t),
    ]
    if (p.planCode) {
      const plan = await c.env.CONTROL.prepare('SELECT max_students FROM plans WHERE code = ?').bind(p.planCode).first<{ max_students: number | null }>()
      const trial = p.trialDays > 0 ? p.trialDays : 30
      control.push(c.env.CONTROL.prepare(`INSERT INTO subscriptions (institution_id, plan_code, status, started_on, trial_ends_on, renews_on, licensed_students, updated_at)
          VALUES (?,?,'trial',?,?,?,?,?)`).bind(instId, p.planCode, today(), addDays(today(), trial), addYear(today()), plan?.max_students ?? null, t))
    }
    control.push(...loginIndexRows(c.env, instId, userId, { email: nullStr(p.adminEmail), phone: nullStr(p.adminPhone), username: nullStr(p.adminUsername) }))

    const tenant: D1PreparedStatement[] = [
      tdb.prepare(`INSERT INTO institutions (id, name, short_name, slug, status, affiliation_board, state, district, created_at, updated_at)
          VALUES (?,?,?,?,'active',?,?,?,?,?)`).bind(instId, p.schoolName, short, slug, nullStr(p.board), nullStr(p.state), nullStr(p.district), t, t),
      tdb.prepare(`INSERT INTO campuses (id, institution_id, name, code, created_at, updated_at) VALUES (?,?,'Main Campus','MAIN',?,?)`).bind(uuid(), instId, t, t),
      tdb.prepare(`INSERT INTO users (id, institution_id, email, phone, username, full_name, password_hash, status, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,'active',?,?)`).bind(userId, instId, nullStr(p.adminEmail), nullStr(p.adminPhone), nullStr(p.adminUsername), p.adminName, hash, t, t),
      tdb.prepare(`INSERT OR IGNORE INTO user_roles (id, institution_id, user_id, role_id, created_at) VALUES (?,?,?,?,?)`).bind(uuid(), instId, userId, adminRole.id, t),
      ...['library', 'lab', 'it', 'stores', 'hostel', 'transport', 'finance', 'hr'].map((code, i) =>
        tdb.prepare(`INSERT OR IGNORE INTO clearance_departments (id, institution_id, code, name, sequence) VALUES (?,?,?,?,?)`)
          .bind(uuid(), instId, code, ['Library', 'Science laboratories', 'IT and devices', 'Stores and stationery', 'Hostel', 'Transport', 'Accounts', 'HR and records'][i], (i + 1) * 10)),
    ]
    try {
      await tdb.batch(tenant)
    } catch (e) {
      const m = isUniqueViolation(e) ? 'that email, phone or username is already in use' : String(e)
      await fail(m)
      if (isUniqueViolation(e)) throw badRequest(m)
      throw e
    }
    await c.env.CONTROL.batch(control)
    if (p.planCode) {
      const inst = await institutionById(c.env, instId)
      if (inst) await applyPlan(c.env, inst, p.planCode)
    }
    await recordPlatformEvent(c.env, 'provision', true, instId, p.schoolName, `plan ${p.planCode}, administrator ${p.adminName}`, c.id.userId)
    return created({
      institution_id: instId, user_id: userId, school: p.schoolName, admin_name: p.adminName,
      sign_in_as: p.adminUsername || p.adminEmail || p.adminPhone, password,
      note: 'Hand these to the school. The password is shown once and is not stored. If it is lost, reset it rather than looking it up. They are asked to change it on first sign-in.',
    })
  })

  // --- subscription changes ---
  r.put('/seller/tenants/{id}/subscription', PERM, async (c) => {
    requirePlatformAdmin(c)
    if (!isUUID(c.params.id)) throw badRequest('invalid institution id')
    const instId = c.params.id
    const req = await readJSON<{ plan_code?: string; status?: string; renews_on?: string; licensed_students?: number | null; notes?: string }>(c.req)
    const status = req.status ?? ''
    if (status && !SUBSCRIPTION_STATUSES.includes(status)) throw badRequest(`status must be one of ${SUBSCRIPTION_STATUSES.join(', ')}`)
    const licensed = typeof req.licensed_students === 'number' ? req.licensed_students : null
    // Both are foreign keys: say which one is wrong instead of failing the batch with a 500.
    if (!(await c.env.CONTROL.prepare('SELECT 1 FROM institutions WHERE id = ?').bind(instId).first())) throw notFound('resource not found')
    if (req.plan_code && !(await c.env.CONTROL.prepare('SELECT 1 FROM plans WHERE code = ?').bind(req.plan_code).first())) {
      throw badRequest('unknown plan: ' + req.plan_code)
    }
    const t = now()
    const stmts: D1PreparedStatement[] = [
      c.env.CONTROL.prepare(`INSERT INTO subscriptions (institution_id, plan_code, status, started_on, renews_on, licensed_students, notes, updated_at)
          VALUES (?, COALESCE(NULLIF(?,''), 'starter'), COALESCE(NULLIF(?,''), 'trial'), ?, NULLIF(?,''), ?, NULLIF(?,''), ?)
          ON CONFLICT (institution_id) DO UPDATE SET
            plan_code = COALESCE(NULLIF(?,''), subscriptions.plan_code),
            status = COALESCE(NULLIF(?,''), subscriptions.status),
            renews_on = COALESCE(NULLIF(?,''), subscriptions.renews_on),
            licensed_students = COALESCE(?, subscriptions.licensed_students),
            notes = COALESCE(NULLIF(?,''), subscriptions.notes),
            updated_at = ?`)
        .bind(instId, req.plan_code ?? '', status, today(), req.renews_on ?? '', licensed, req.notes ?? '', t,
          req.plan_code ?? '', status, req.renews_on ?? '', licensed, req.notes ?? '', t),
    ]
    // A suspended subscription must actually lock the door.
    let instStatus: string | null = null
    if (status === 'suspended' || status === 'cancelled') instStatus = 'suspended'
    else if (status === 'trial' || status === 'active') instStatus = 'active'
    if (instStatus) stmts.push(c.env.CONTROL.prepare('UPDATE institutions SET status = ?, updated_at = ? WHERE id = ?').bind(instStatus, t, instId))
    await c.env.CONTROL.batch(stmts)

    const inst = await institutionById(c.env, instId)
    if (inst) {
      const sub = await c.env.CONTROL.prepare(`SELECT plan_code FROM subscriptions WHERE institution_id = ? AND status <> 'cancelled'`).bind(instId).first<{ plan_code: string }>()
      if (sub) await applyPlan(c.env, inst, sub.plan_code)
      const db = openTenant(c.env, inst)
      if (db && instStatus) await db.prepare('UPDATE institutions SET status = ?, updated_at = ? WHERE id = ?').bind(instStatus, t, instId).run()
    }
    return ok({ institution_id: instId })
  })

  r.post('/seller/tenants/{id}/reset-admin', PERM, async (c) => {
    requirePlatformAdmin(c)
    if (!isUUID(c.params.id)) throw badRequest('invalid institution id')
    const inst = await institutionById(c.env, c.params.id)
    if (!inst) throw badRequest('that school has no administrator to reset')
    const db = openTenant(c.env, inst)
    if (!db) throw badRequest('that school has no administrator to reset')
    const admin = await db.prepare(`SELECT u.id, u.full_name, COALESCE(u.username, u.email, u.phone, '') AS sign_in
        FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
        WHERE r.key = 'institution_admin' ORDER BY u.created_at LIMIT 1`).first<{ id: string; full_name: string; sign_in: string }>()
    if (!admin) throw badRequest('that school has no administrator to reset')
    const password = temporaryPassword()
    const hash = await hashPassword(c.env.PASSWORD_PEPPER, password)
    const t = now()
    await db.prepare(`UPDATE users SET password_hash = ?, status = 'active', updated_at = ? WHERE id = ?`).bind(hash, t, admin.id).run()
    // "The previous password no longer works" must hold for the cookie already signed in on it (Go: forgetUser).
    await c.env.CONTROL.prepare(`UPDATE sessions SET revoked_at = ?, ended_reason = 'password_reset' WHERE user_id = ? AND institution_id = ? AND revoked_at IS NULL`)
      .bind(t, admin.id, inst.id).run()
    return ok({ admin_name: admin.full_name, sign_in_as: admin.sign_in, password, note: 'Shown once. The previous password no longer works.' })
  })

  // --- plans ---
  r.get('/seller/plans', PERM, async (c) => {
    requirePlatformAdmin(c)
    const rows = await c.env.CONTROL.prepare(`SELECT p.code, p.name, p.price_paise, p.max_students, p.max_campuses, p.modules,
        (SELECT count(*) FROM subscriptions sub WHERE sub.plan_code = p.code AND sub.status <> 'cancelled') AS schools
        FROM plans p ORDER BY p.sequence, p.price_paise`).all<{ code: string; name: string; price_paise: number; max_students: number | null; max_campuses: number | null; modules: string; schools: number }>()
    const items = rows.results.map((p) => {
      const o: Record<string, unknown> = { code: p.code, name: p.name, price_paise: p.price_paise, modules: parseModules(p.modules), schools: p.schools }
      if (p.max_students !== null) o.max_students = p.max_students
      if (p.max_campuses !== null) o.max_campuses = p.max_campuses
      return o
    })
    return ok({ items, modules: ALL_MODULES.map((m) => ({ key: m, label: MODULE_LABELS[m] ?? m })), presets: PRESETS })
  })

  interface PlanWrite { code?: string; name?: string; price_paise?: number; max_students?: number | null; max_campuses?: number | null; modules?: string[] | null; sequence?: number }
  function validatePlan(p: PlanWrite): void {
    if (!(p.name ?? '').trim()) throw badRequest('a plan needs a name. It is what a school sees on its invoice')
    if ((p.price_paise ?? 0) < 0) throw badRequest('a price cannot be negative')
    if (typeof p.max_students === 'number' && p.max_students < 0) throw badRequest('a student cap cannot be negative')
    if (typeof p.max_campuses === 'number' && p.max_campuses < 0) throw badRequest('a campus cap cannot be negative')
    for (const m of p.modules ?? []) if (!ALL_MODULES.includes(m)) throw badRequest('there is no module called ' + m)
  }

  r.post('/seller/plans', PERM, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<PlanWrite>(c.req)
    const code = (req.code ?? '').trim().toLowerCase()
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(code)) throw badRequest('the code is the plan\'s permanent name: lower case letters, numbers and underscores, starting with a letter')
    validatePlan(req)
    const exists = await c.env.CONTROL.prepare('SELECT 1 FROM plans WHERE code = ?').bind(code).first()
    if (exists) throw new HttpError(409, 'a plan with that code already exists. The code is permanent. Pick another, or edit the existing plan.', { code: 'code_taken' })
    await c.env.CONTROL.prepare(`INSERT INTO plans (code, name, price_paise, max_students, max_campuses, modules, sequence) VALUES (?,?,?,?,?,?,?)`)
      .bind(code, (req.name ?? '').trim(), req.price_paise ?? 0, req.max_students ?? null, req.max_campuses ?? null, JSON.stringify(req.modules ?? []), req.sequence ?? 0).run()
    return created({ code })
  })

  r.put('/seller/plans/{code}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const code = c.params.code.trim().toLowerCase()
    const req = await readJSON<PlanWrite>(c.req)
    if (req.code && req.code.toLowerCase() !== code) throw badRequest('a plan\'s code cannot be changed. Every subscription points at it. Create a new plan and move the schools across.')
    validatePlan(req)
    const res = await c.env.CONTROL.prepare(`UPDATE plans SET name = ?, price_paise = ?, max_students = ?, max_campuses = ?, modules = ?, sequence = ? WHERE code = ?`)
      .bind((req.name ?? '').trim(), req.price_paise ?? 0, req.max_students ?? null, req.max_campuses ?? null, JSON.stringify(req.modules ?? []), req.sequence ?? 0, code).run()
    if (!res.meta.changes) throw notFound()
    const onIt = await c.env.CONTROL.prepare(`SELECT count(*) AS n FROM subscriptions WHERE plan_code = ? AND status IN ('active','trial')`).bind(code).first<{ n: number }>()
    return ok({ code, schools_keeping_their_price: onIt?.n ?? 0 })
  })

  r.del('/seller/plans/{code}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const code = c.params.code.trim().toLowerCase()
    const restore = c.url.searchParams.get('restore') === '1'
    const res = await c.env.CONTROL.prepare('UPDATE plans SET retired_at = ? WHERE code = ?').bind(restore ? null : now(), code).run()
    if (!res.meta.changes) throw notFound()
    return ok({ code, retired: !restore })
  })

  // --- per-school limits ---
  r.get('/seller/limits', PERM, async (c) => {
    requirePlatformAdmin(c)
    const insts = await allInstitutions(c.env)
    const subs = await subscriptionsByInstitution(c.env)
    const items = await Promise.all(insts.map(async (i) => {
      const sub = subs.get(i.id)
      let students = 0, stored = 0
      const db = openTenant(c.env, i)
      if (db) {
        const row = await db.prepare(`SELECT (SELECT count(*) FROM students WHERE status = 'active') AS students,
            COALESCE((SELECT sum(size_bytes) FROM files WHERE deleted_at IS NULL), 0) AS stored`).first<{ students: number; stored: number }>()
        if (row) { students = row.students; stored = Number(row.stored) }
      }
      const o: Record<string, unknown> = { institution_id: i.id, school: i.name, students, stored_bytes: stored }
      if (sub?.plan_code) o.plan_code = sub.plan_code
      if (sub?.plan_name) o.plan_name = sub.plan_name
      if (sub && sub.max_students !== null) o.plan_students = sub.max_students
      if (sub && sub.max_storage_gb !== null) o.plan_storage_gb = sub.max_storage_gb
      if (sub && sub.licensed_students !== null) o.override_students = sub.licensed_students
      if (sub && sub.storage_gb !== null) o.override_storage_gb = sub.storage_gb
      return o
    }))
    return ok({ items })
  })

  r.put('/seller/limits', PERM, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<{ institution_id?: string; licensed_students?: number | null; storage_gb?: number | null }>(c.req)
    const iid = (req.institution_id ?? '').trim()
    if (!isUUID(iid)) throw badRequest('institution_id must be a uuid')
    for (const v of [req.licensed_students, req.storage_gb]) {
      if (typeof v === 'number' && v < 0) throw badRequest('a limit cannot be negative. Leave it blank for the plan\'s own')
    }
    const res = await c.env.CONTROL.prepare('UPDATE subscriptions SET licensed_students = ?, storage_gb = ?, updated_at = ? WHERE institution_id = ?')
      .bind(req.licensed_students ?? null, req.storage_gb ?? null, now(), iid).run()
    if (!res.meta.changes) throw new HttpError(409, 'that school is not on a plan yet, so there is nothing to vary. Put it on a plan first.', { code: 'no_subscription' })
    return ok({ saved: true })
  })

  // --- support queue ---
  r.get('/seller/tickets', PERM, async (c) => {
    requirePlatformAdmin(c)
    const insts = await allInstitutions(c.env)
    const subs = await subscriptionsByInstitution(c.env, `WHERE sub.status IN ('active','trial')`)
    const nowMs = Date.now()
    const items: Record<string, unknown>[] = []
    await Promise.all(insts.map(async (i) => {
      const db = openTenant(c.env, i)
      if (!db) return
      const rows = await db.prepare(`SELECT t.id, t.subject, t.category, t.priority, t.status, t.created_at, u.full_name AS raised_by
          FROM support_tickets t LEFT JOIN users u ON u.id = t.raised_by
          WHERE t.status <> 'closed' AND t.audience = 'vendor'`)
        .all<{ id: string; subject: string; category: string; priority: string; status: string; created_at: string; raised_by: string | null }>()
      const sub = subs.get(i.id)
      for (const t of rows.results) {
        const hours = Math.trunc((nowMs - Date.parse(t.created_at)) / 3_600_000)
        const promised = promisedHours(sub?.plan_code ?? '', t.priority)
        const o: Record<string, unknown> = {
          id: t.id, school: i.name, subject: t.subject, category: t.category, priority: t.priority, status: t.status,
          created_at: day(t.created_at), open_days: Math.trunc(hours / 24), open_hours: hours,
          promised_hours: promised, breached: hours > promised, _created: t.created_at,
        }
        if (t.raised_by) o.raised_by = t.raised_by
        if (sub?.plan_code) o.plan_code = sub.plan_code
        if (sub?.plan_name) o.plan_name = sub.plan_name
        items.push(o)
      }
    }))
    const rank = (p: string) => ({ urgent: 0, high: 1, normal: 2 } as Record<string, number>)[p] ?? 3
    items.sort((a, b) => rank(a.priority as string) - rank(b.priority as string) || String(a._created).localeCompare(String(b._created)))
    for (const o of items) delete o._created
    return ok({ items })
  })

  // --- support-team accounts (platform users holding support_admin) ---
  r.get('/seller/support-accounts', PERM, async (c) => {
    requirePlatformAdmin(c)
    const rows = await c.env.CONTROL.prepare(`SELECT u.id, u.full_name, u.email, u.phone, u.status, u.created_at,
        (SELECT max(le.at) FROM login_events le WHERE le.user_id = u.id AND le.institution_id IS NULL AND le.outcome = 'ok') AS last_login_at
        FROM platform_users u
        WHERE EXISTS (SELECT 1 FROM platform_user_roles pr WHERE pr.user_id = u.id AND pr.role_key = 'support_admin')
        ORDER BY u.created_at DESC`)
      .all<{ id: string; full_name: string; email: string | null; phone: string | null; status: string; last_login_at: string | null; created_at: string }>()
    const items = rows.results.map((u) => {
      const o: Record<string, unknown> = { id: u.id, full_name: u.full_name, status: u.status, created_at: stamp(u.created_at) }
      if (u.email) o.email = u.email
      if (u.phone) o.phone = u.phone
      if (u.last_login_at) o.last_login_at = stamp(u.last_login_at)
      return o
    })
    return ok({ items })
  })

  r.post('/seller/support-accounts', PERM, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<{ full_name?: string; email?: string; phone?: string }>(c.req)
    const fullName = (req.full_name ?? '').trim()
    const email = (req.email ?? '').trim().toLowerCase()
    const phone = (req.phone ?? '').trim()
    if (!fullName) throw badRequest('the support account needs a name')
    if (!email && !phone) throw badRequest('an email or a phone number is required to sign in')
    const subject = email ? `${fullName} <${email}>` : fullName
    const password = temporaryPassword()
    const hash = await hashPassword(c.env.PASSWORD_PEPPER, password)
    const t = now()

    // Postgres upserted on (email) for platform users; SQLite cannot target a partial index, so find first.
    const existing = email
      ? await c.env.CONTROL.prepare('SELECT id FROM platform_users WHERE email = ?').bind(email).first<{ id: string }>()
      : null
    const userId = existing?.id ?? uuid()
    const stmts: D1PreparedStatement[] = []
    if (existing) {
      stmts.push(c.env.CONTROL.prepare(`UPDATE platform_users SET full_name = ?, phone = COALESCE(?, phone), password_hash = ?, status = 'active', updated_at = ? WHERE id = ?`)
        .bind(fullName, nullStr(phone), hash, t, userId))
    } else {
      stmts.push(c.env.CONTROL.prepare(`INSERT INTO platform_users (id, email, phone, full_name, password_hash, status, created_at, updated_at) VALUES (?,?,?,?,?,'active',?,?)`)
        .bind(userId, nullStr(email), nullStr(phone), fullName, hash, t, t))
    }
    stmts.push(c.env.CONTROL.prepare(`INSERT OR IGNORE INTO platform_user_roles (user_id, role_key, created_at) VALUES (?, 'support_admin', ?)`).bind(userId, t))
    stmts.push(...loginIndexRows(c.env, null, userId, { email: nullStr(email), phone: nullStr(phone) }))
    try {
      await c.env.CONTROL.batch(stmts)
    } catch (e) {
      await recordPlatformEvent(c.env, 'support_account', false, null, subject, String(e), c.id.userId)
      if (isUniqueViolation(e)) throw new HttpError(409, 'a platform account already uses that email', { code: 'email_in_use' })
      throw e
    }
    await recordPlatformEvent(c.env, 'support_account', true, null, subject, 'support_admin created', c.id.userId)
    return created({
      user_id: userId, full_name: fullName, sign_in_as: email || phone, role: 'support_admin', temporary_password: password,
      note: 'Shown once and not stored. Hand it over; they are asked to set their own password the first time they sign in.',
    })
  })

  // --- board members (one user, a board_member row in every school they oversee) ---
  r.get('/seller/board-members', PERM, async (c) => {
    requirePlatformAdmin(c)
    const insts = await allInstitutions(c.env)
    interface Member { id: string; full_name: string; email?: string; phone?: string; status: string; schools: { id: string; name: string }[] }
    const byId = new Map<string, Member>()
    for (const i of insts) {
      const db = openTenant(c.env, i)
      if (!db) continue
      const rows = await db.prepare(`SELECT u.id, u.full_name, u.email, u.phone, u.status FROM users u
          JOIN user_roles ur ON ur.user_id = u.id JOIN roles ro ON ro.id = ur.role_id AND ro.key = 'board_member'
          ORDER BY u.full_name, u.id`).all<{ id: string; full_name: string; email: string | null; phone: string | null; status: string }>()
      for (const u of rows.results) {
        let m = byId.get(u.id)
        if (!m) {
          m = { id: u.id, full_name: u.full_name, status: u.status, schools: [] }
          if (u.email) m.email = u.email
          if (u.phone) m.phone = u.phone
          byId.set(u.id, m)
        }
        if (!m.schools.some((s) => s.id === i.id)) m.schools.push({ id: i.id, name: i.name })
      }
    }
    const items = [...byId.values()].sort((a, b) => a.full_name.localeCompare(b.full_name) || a.id.localeCompare(b.id))
    for (const m of items) m.schools.sort((a, b) => a.name.localeCompare(b.name))
    return ok({ items })
  })

  r.post('/seller/board-members', PERM, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<{ full_name?: string; email?: string; phone?: string; institution_ids?: string[] }>(c.req)
    const fullName = (req.full_name ?? '').trim()
    const email = (req.email ?? '').trim().toLowerCase()
    const phone = (req.phone ?? '').trim()
    if (!fullName) throw badRequest('the board member needs a name')
    if (!email && !phone) throw badRequest('an email or a phone number is required to sign in')
    const raw = req.institution_ids ?? []
    if (raw.length === 0) throw badRequest('name at least one school this board member oversees')
    const instIds: string[] = []
    for (const v of raw) {
      const s = String(v).trim()
      if (!isUUID(s)) throw badRequest('each institution_id must be a uuid')
      if (!instIds.includes(s)) instIds.push(s)
    }
    const subject = email ? `${fullName} <${email}>` : fullName
    const failed = async (m: string) => recordPlatformEvent(c.env, 'board_member', false, null, subject, m, c.id.userId)

    const insts: Institution[] = []
    for (const id of instIds) {
      const i = await institutionById(c.env, id)
      if (!i) { await failed('one of the named institutions does not exist'); throw badRequest('one of those schools does not exist') }
      insts.push(i)
    }
    const home = insts[0]
    const homeDb = openTenant(c.env, home)
    if (!homeDb) notImplemented('provision tenant database')

    const password = temporaryPassword()
    const hash = await hashPassword(c.env.PASSWORD_PEPPER, password)
    const t = now()
    const found = email
      ? await homeDb.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>()
      : await homeDb.prepare('SELECT id FROM users WHERE phone = ?').bind(phone).first<{ id: string }>()
    const createdNow = !found
    const userId = found?.id ?? uuid()

    try {
      for (const inst of insts) {
        const db = openTenant(c.env, inst)
        if (!db) throw new Error(`no database for ${inst.slug}`)
        let role = await db.prepare(`SELECT id FROM roles WHERE key = 'board_member' LIMIT 1`).first<{ id: string }>()
        const stmts: D1PreparedStatement[] = []
        if (!role) {
          // rbac.InstallRole seeds the optional role on demand; the grants come from the catalog seed, not here.
          role = { id: uuid() }
          stmts.push(db.prepare(`INSERT INTO roles (id, institution_id, key, name, is_system, is_default, created_at) VALUES (?,?,'board_member','Board member',1,0,?)`).bind(role.id, inst.id, t))
        }
        /* One user, several databases: the row that Postgres held once is
           mirrored into every school the member oversees, same id, so the
           user_roles foreign key holds and each school reads its own copy. */
        if (inst.id === home.id && createdNow) {
          stmts.push(db.prepare(`INSERT INTO users (id, institution_id, email, phone, full_name, password_hash, status, must_change_password, created_at, updated_at)
              VALUES (?,?,?,?,?,?,'active',1,?,?)`).bind(userId, inst.id, nullStr(email), nullStr(phone), fullName, hash, t, t))
        } else if (inst.id !== home.id) {
          stmts.push(db.prepare(`INSERT OR IGNORE INTO users (id, institution_id, email, phone, full_name, password_hash, status, must_change_password, created_at, updated_at)
              VALUES (?,?,?,?,?,?,'active',1,?,?)`).bind(userId, inst.id, nullStr(email), nullStr(phone), fullName, hash, t, t))
        }
        stmts.push(db.prepare(`INSERT OR IGNORE INTO user_roles (id, institution_id, user_id, role_id, created_at) VALUES (?,?,?,?,?)`).bind(uuid(), inst.id, userId, role.id, t))
        await db.batch(stmts)
      }
      if (createdNow) await c.env.CONTROL.batch(loginIndexRows(c.env, home.id, userId, { email: nullStr(email), phone: nullStr(phone) }))
    } catch (e) {
      await failed(String(e))
      if (isUniqueViolation(e)) throw new HttpError(409, 'an account at that school already uses that email or phone', { code: 'account_in_use' })
      throw e
    }
    await recordPlatformEvent(c.env, 'board_member', true, home.id, subject, `board_member granted in ${insts.length} ${insts.length === 1 ? 'school' : 'schools'}`, c.id.userId)
    const resp: Record<string, unknown> = { user_id: userId, full_name: fullName, schools: insts.length, created: createdNow, home_school: home.id }
    if (createdNow) {
      resp.sign_in_as = email || phone
      resp.temporary_password = password
      resp.note = 'Shown once and not stored. Hand it over; they set their own password the first time they sign in.'
    } else {
      resp.note = 'This person already had an account; their sign-in and password are unchanged. They now oversee the named schools.'
    }
    return created(resp)
  })

  r.del('/seller/board-members/{userID}/institutions/{instID}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const userId = uuidParam(c.params.userID, 'userID')
    if (!isUUID(c.params.instID)) throw badRequest('institution id must be a uuid')
    const inst = await institutionById(c.env, c.params.instID)
    const db = inst ? openTenant(c.env, inst) : null
    let removed = 0
    if (inst && db) {
      const res = await db.prepare(`DELETE FROM user_roles WHERE user_id = ? AND institution_id = ?
          AND role_id IN (SELECT id FROM roles WHERE key = 'board_member')`).bind(userId, inst.id).run()
      removed = res.meta.changes
    }
    if (!removed) throw new HttpError(404, 'that person does not oversee that school', { code: 'no_such_membership' })
    await recordPlatformEvent(c.env, 'board_member', true, inst!.id, userId, 'board_member membership removed', c.id.userId)
    return ok({ removed: true })
  })
}
