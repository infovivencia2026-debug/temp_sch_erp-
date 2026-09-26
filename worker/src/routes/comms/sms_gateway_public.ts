import type { Env } from '../../env'
import { json } from '../../env'
import { now, uuid } from '../../http'
import { verifyPassword } from '../../auth/password'
import { institutionById, tenantDb } from '../../tenant'
import { truncate } from './common'
import { allTenants, callerAddress, decodeStrict, goError, goInternal, randomSecret, rateLimited, sealSecretEnv, type Tenant } from './public_common'

/* Port of claimSMSGatewayPairCode (sms_gateway.go) and enrolSMSGateway
   (device_login.go): the two unauthenticated routes that turn a handset into
   an SMS gateway device. The token minted here, sgw1.<device-uuid>.<secret>,
   is the one sms_gateway.ts's authenticate() opens and compares. */

const TOKEN_PREFIX = 'sgw1'            // smsGatewayTokenPrefix, as in sms_gateway.ts
const SESSION_PREFIX = 'sess'          // staffSessionTokenPrefix
const CODE_LENGTH = 6                  // smsGatewayCodeLength
const DEFAULT_POLL = 20                // smsGatewayDefaultPoll
const DEFAULT_CAP = 6                  // smsGatewayDefaultCap
const CLAIM_WINDOW_S = 10 * 60, CLAIM_BURST = 6 // pairCodePolicy
const STAFF_SESSION_TTL_MS = 30 * 24 * 3600 * 1000
const PIN_MAX_FAILURES = 5, PIN_LOCK_MS = 15 * 60 * 1000, PIN_MIN = 4, PIN_MAX = 8

const claimRefused = () => goError(401, 'pair_code_invalid', 'that pairing code is not usable. Ask the school office for a new one')

/** nullIfBlank (sms_gateway.go). */
const nullIfBlank = (s: string | undefined): string | null => {
  const t = (s ?? '').trim()
  return t === '' ? null : truncate(t, 80)
}

/** The INSERT's name: "Redmi Note 12", or "Redmi Note 12 (2)" when a live one already has it. */
const NAME_EXPR = `? || (SELECT CASE WHEN count(*) > 0 THEN ' (' || (count(*) + 1) || ')' ELSE '' END
    FROM sms_gateway_devices d WHERE d.institution_id = ? AND d.revoked_at IS NULL AND lower(d.name) = lower(?))`

// ---------------------------------------------------------------- claim

interface ClaimRequest { pair_code?: string; device_name?: string; android_version?: string; sim_operator?: string; app_version?: string }

async function claim(env: Env, req: Request): Promise<Response> {
  const limited = await rateLimited(env, 'sms_gateway_pair', CLAIM_WINDOW_S, CLAIM_BURST, callerAddress(req),
    'too many pairing attempts from this network. Wait a few minutes and try again')
  if (limited) return limited
  const body = await decodeStrict<ClaimRequest>(req, { pair_code: 'string', device_name: 'string', android_version: 'string', sim_operator: 'string', app_version: 'string' })
  if (body instanceof Response) return body
  const code = (body.pair_code ?? '').trim().toUpperCase()
  let name = (body.device_name ?? '').trim()
  if (name === '') name = 'Office phone'
  // len(code) in Go counts bytes.
  if (new TextEncoder().encode(code).length !== CODE_LENGTH) return claimRefused()

  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  const tenants = await allTenants(env)
  const hits = await Promise.all(tenants.map(async (t) => {
    const row = await t.db.prepare(`SELECT id, institution_id, created_by FROM sms_gateway_pair_codes
        WHERE code_hash = ? AND claimed_at IS NULL AND julianday(expires_at) > julianday('now')`)
      .bind(hash).first<{ id: string; institution_id: string; created_by: string | null }>()
    return row ? { t, row } : null
  }))
  const hit = hits.find((h) => h !== null)
  if (!hit) return claimRefused()
  const { t: { inst, db }, row } = hit

  const device = uuid()
  const secret = randomSecret()
  const token = `${TOKEN_PREFIX}.${device}.${secret}`
  const sealed = await sealSecretEnv(env, secret)
  const ts = now(), dname = truncate(name, 80)
  /* FOR UPDATE, in D1: the device is inserted only while the code is still
     unclaimed, and the code is claimed only if it still is. A batch is one
     transaction, so of two handsets racing on one code, the second finds
     claimed_at set and inserts nothing. Approved on arrival, by the person
     who generated the code. */
  const [ins] = await db.batch([
    db.prepare(`INSERT INTO sms_gateway_devices
        (id, institution_id, name, android_version, sim_operator, app_version, token_sealed, pair_code_id, paired_by,
         approved_at, approved_by, poll_seconds, per_minute_cap, paired_at, created_at, updated_at)
        SELECT ?, ?, ${NAME_EXPR}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM sms_gateway_pair_codes WHERE id = ? AND claimed_at IS NULL)`)
      .bind(device, row.institution_id, dname, row.institution_id, dname,
        nullIfBlank(body.android_version), nullIfBlank(body.sim_operator), nullIfBlank(body.app_version), sealed, row.id, row.created_by,
        ts, row.created_by, DEFAULT_POLL, DEFAULT_CAP, ts, ts, ts, row.id),
    db.prepare(`UPDATE sms_gateway_pair_codes SET claimed_at = ?, claimed_device_id = ?
        WHERE id = ? AND claimed_at IS NULL AND EXISTS (SELECT 1 FROM sms_gateway_devices WHERE id = ?)`)
      .bind(ts, device, row.id, device),
  ])
  if (!ins.meta.changes) return claimRefused()

  return json({ device_id: device, device_token: token, institution: inst.name, poll_seconds: DEFAULT_POLL, per_minute_cap: DEFAULT_CAP })
}

// ---------------------------------------------------------------- enrol

interface StaffIdentity { userId: string; tenant: Tenant; name: string; approver: boolean }
type AuthFail = 'bad_pin' | 'pin_locked' | 'no_login_yet'

function deviceLoginRejected(err: AuthFail): Response {
  if (err === 'pin_locked') return goError(429, 'pin_locked', 'too many wrong PINs. Wait fifteen minutes, or ask the office to reset it.')
  if (err === 'no_login_yet') return goError(401, 'no_login_yet', 'no PIN or password has been issued for this number yet. Ask the office to issue one.')
  return goError(401, 'bad_pin', 'that number and password do not match. Ask the office to check the number on your record.')
}

const normalisePhone = (s: string) => { const d = s.replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d }
const validPIN = (pin: string) => pin.length >= PIN_MIN && pin.length <= PIN_MAX && /^\d+$/.test(pin)

/** The last ten digits of a stored phone, for the common ways people write one. */
const PHONE_DIGITS = `substr(replace(replace(replace(replace(replace(replace(value, ' ', ''), '-', ''), '+', ''), '(', ''), ')', ''), '.', ''), -10)`

/** login_index rows whose value is the identifier, or a phone whose last ten digits are `digits`. */
async function indexed(env: Env, identifier: string, digits: string): Promise<{ institution_id: string | null; user_id: string }[]> {
  const r = await env.CONTROL.prepare(`SELECT DISTINCT institution_id, user_id FROM login_index
      WHERE value = ? OR (kind = 'phone' AND ? <> '' AND ${PHONE_DIGITS} = ?) LIMIT 20`)
    .bind(identifier, digits, digits).all<{ institution_id: string | null; user_id: string }>()
  return r.results
}

async function tenantFor(env: Env, instId: string): Promise<Tenant | null> {
  const inst = await institutionById(env, instId)
  if (!inst) return null
  try { return { inst, db: tenantDb(env, inst) } } catch { return null }
}

/** authenticateStaffLogin (bus_driver_signin.go): the password first, then a PIN if it is shaped like one. */
async function authenticateStaffLogin(env: Env, identifier: string, secret: string): Promise<StaffIdentity | AuthFail> {
  if (identifier.trim() === '' || secret === '') return 'bad_pin'
  // Go matched right(digits(phone), 10) against the identifier as typed.
  const rows = await indexed(env, identifier, /^\d{10}$/.test(identifier) ? identifier : '')
  const matches: { userId: string; tenant: Tenant | null; name: string; hash: string | null; hasPIN: boolean }[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (seen.has(r.user_id)) continue
    seen.add(r.user_id)
    if (r.institution_id === null) {
      const u = await env.CONTROL.prepare(`SELECT id FROM platform_users WHERE id = ? AND status = 'active'`).bind(r.user_id).first()
      if (u) matches.push({ userId: r.user_id, tenant: null, name: '', hash: null, hasPIN: false })
      continue
    }
    const t = await tenantFor(env, r.institution_id)
    if (!t || t.inst.status !== 'active') continue
    const u = await t.db.prepare(`SELECT id, COALESCE(full_name, '') AS name, password_hash, pin_hash IS NOT NULL AS has_pin
        FROM users WHERE id = ? AND status = 'active'`).bind(r.user_id).first<{ id: string; name: string; password_hash: string | null; has_pin: number }>()
    if (u) matches.push({ userId: u.id, tenant: t, name: u.name, hash: u.password_hash, hasPIN: !!u.has_pin })
  }
  if (matches.length === 1) {
    const m = matches[0]
    if (m.hash !== null && await verifyPassword(env.PASSWORD_PEPPER, m.hash, secret)) {
      // A platform user has no school to sign a handset into.
      if (!m.tenant) return 'bad_pin'
      // Go's password path never set Approver: a gateway enrolled on a password waits for approval.
      return { userId: m.userId, tenant: m.tenant, name: m.name, approver: false }
    }
    if (m.hash === null && !m.hasPIN) return 'no_login_yet'
  }
  if (!validPIN(secret)) return 'bad_pin'
  return authenticatePIN(env, identifier, secret)
}

/** authenticatePIN (device_login.go), with its lockout counter. */
async function authenticatePIN(env: Env, phone: string, pin: string): Promise<StaffIdentity | AuthFail> {
  const digits = normalisePhone(phone)
  if (digits.length !== 10 || !validPIN(pin)) return 'bad_pin'
  let found: { t: Tenant; u: { id: string; name: string; pin_hash: string; pin_failed: number; pin_locked_until: string | null; status: string } } | null = null
  for (const r of await indexed(env, '', digits)) {
    if (r.institution_id === null) continue
    const t = await tenantFor(env, r.institution_id)
    if (!t) continue
    const u = await t.db.prepare(`SELECT id, COALESCE(full_name, '') AS name, pin_hash, pin_failed, pin_locked_until, status
        FROM users WHERE id = ? AND pin_hash IS NOT NULL`).bind(r.user_id)
      .first<{ id: string; name: string; pin_hash: string; pin_failed: number; pin_locked_until: string | null; status: string }>()
    if (u) { found = { t, u }; break }
  }
  if (!found) return 'bad_pin'
  const { t, u } = found
  const countFailure = async () => {
    try {
      await t.db.prepare(`UPDATE users SET pin_failed = pin_failed + 1,
          pin_locked_until = CASE WHEN pin_failed + 1 >= ? THEN ? ELSE pin_locked_until END WHERE id = ?`)
        .bind(PIN_MAX_FAILURES, new Date(Date.now() + PIN_LOCK_MS).toISOString(), u.id).run()
    } catch (e) { console.error(e) }
  }
  if (u.status !== 'active') { await countFailure(); return 'bad_pin' }
  if (u.pin_locked_until !== null && Date.parse(u.pin_locked_until) > Date.now()) return 'pin_locked'
  if (!await verifyPassword(env.PASSWORD_PEPPER, u.pin_hash, pin)) { await countFailure(); return 'bad_pin' }
  if (u.pin_failed !== 0 || u.pin_locked_until !== null) {
    await t.db.prepare(`UPDATE users SET pin_failed = 0, pin_locked_until = NULL WHERE id = ?`).bind(u.id).run()
  }
  // The literal Go used; see the report.
  const a = await t.db.prepare(`SELECT EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND rp.permission_key = 'integrations.write') AS a`).bind(u.id).first<{ a: number }>()
  return { userId: u.id, tenant: t, name: u.name, approver: !!a?.a }
}

interface EnrolRequest { phone?: string; password?: string; pin?: string; device_name?: string; android_version?: string; sim_operator?: string; app_version?: string }

async function enrol(env: Env, req: Request): Promise<Response> {
  const limited = await rateLimited(env, 'sms_gateway_pair', CLAIM_WINDOW_S, CLAIM_BURST, callerAddress(req),
    'too many attempts from this network. Wait a few minutes and try again')
  if (limited) return limited
  const body = await decodeStrict<EnrolRequest>(req, { phone: 'string', password: 'string', pin: 'string', device_name: 'string',
    android_version: 'string', sim_operator: 'string', app_version: 'string' })
  if (body instanceof Response) return body
  const secretIn = body.password ? body.password : (body.pin ?? '')
  const who = await authenticateStaffLogin(env, body.phone ?? '', secretIn)
  if (typeof who === 'string') return deviceLoginRejected(who)

  let name = (body.device_name ?? '').trim()
  if (name === '') name = 'Office phone'
  const dname = truncate(name, 80)
  const { db, inst } = who.tenant
  const instId = inst.id
  const device = uuid(), session = uuid()
  const secret = randomSecret(), sessSecret = randomSecret()
  const token = `${TOKEN_PREFIX}.${device}.${secret}`
  const sessionToken = `${SESSION_PREFIX}.${session}.${sessSecret}`
  const [sealed, sessSealed] = await Promise.all([sealSecretEnv(env, secret), sealSecretEnv(env, sessSecret)])
  const ts = now(), expires = new Date(Date.now() + STAFF_SESSION_TTL_MS).toISOString()
  const approvedAt = who.approver ? ts : null, approvedBy = who.approver ? who.userId : null

  await db.batch([
    // The same handset enrolled again: the old row, and its "(n)" siblings, are revoked.
    db.prepare(`UPDATE sms_gateway_devices SET revoked_at = ?, revoked_reason = 'replaced when the same handset enrolled again', updated_at = ?
        WHERE institution_id = ? AND revoked_at IS NULL AND (lower(name) = lower(?) OR lower(name) LIKE lower(?) || ' (%')`)
      .bind(ts, ts, instId, dname, dname),
    db.prepare(`INSERT INTO sms_gateway_devices
        (id, institution_id, name, android_version, sim_operator, app_version, token_sealed, enrolled_by,
         approved_at, approved_by, poll_seconds, per_minute_cap, paired_at, created_at, updated_at)
        VALUES (?, ?, ${NAME_EXPR}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(device, instId, dname, instId, dname, nullIfBlank(body.android_version), nullIfBlank(body.sim_operator), nullIfBlank(body.app_version),
        sealed, who.userId, approvedAt, approvedBy, DEFAULT_POLL, DEFAULT_CAP, ts, ts, ts),
    // openStaffSession: supersede, then the new shift with its sealed secret.
    db.prepare(`UPDATE device_staff_sessions SET ended_at = ?, ended_reason = 'superseded' WHERE app = 'sms_gateway' AND device_id = ? AND ended_at IS NULL`)
      .bind(ts, device),
    db.prepare(`INSERT INTO device_staff_sessions (id, institution_id, user_id, app, device_id, token_sealed, started_at, last_seen_at, expires_at)
        VALUES (?, ?, ?, 'sms_gateway', ?, ?, ?, ?, ?)`)
      .bind(session, instId, who.userId, device, sessSealed, ts, ts, expires),
  ])

  return json({ device_id: device, device_token: token, session_token: sessionToken, institution: inst.name, name: who.name,
    poll_seconds: DEFAULT_POLL, per_minute_cap: DEFAULT_CAP, approved: who.approver })
}

/** POST /api/v1/public/sms-gateway/claim and /enrol; null for anything else. */
export async function handleSMSGatewayPublic(env: Env, req: Request, path: string): Promise<Response | null> {
  if (req.method !== 'POST') return null
  const route = path === '/api/v1/public/sms-gateway/claim' ? claim : path === '/api/v1/public/sms-gateway/enrol' ? enrol : null
  if (!route) return null
  try {
    return await route(env, req)
  } catch (err) {
    console.error(err)
    return goInternal()
  }
}
