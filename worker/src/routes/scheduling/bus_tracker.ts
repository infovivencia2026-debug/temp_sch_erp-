import type { Env } from '../../env'
import { notifyApproaching as notifyApproachingNotice, notifyArrived, notifyTripStarted } from '../../services/transport_notices'
import { json } from '../../env'
import { getObject, serveObject } from '../../services/files'
import { isUUID, uuid } from '../../http'
import { tenantDb, type Institution } from '../../tenant'
import { verifyPassword } from '../../auth/password'
import { firstLast, toBytes, truncate } from '../comms/common'
import { istDateOf, istFormat, parseRFC3339, rfc3339UTC, todayIST, IST_MS } from './common'
import {
  clampTripTimeoutMins, constantTimeEqual, hashPairCode, metresBetween, normaliseBusCode, openSecret,
  randomSecret, sealSecret, trackingPolicyIn, legFor, type TrackingPolicy,
} from './tracking'

/* Port of the handset half of the bus tracker: bus_tracker.go
   (mountBusTrackerDevice), bus_driver_signin.go, the bus-tracker parts of
   device_login.go (enrolment, the driver's shift session), bus_tracker_check.go,
   bus_tracker_roll.go, bus_tracker_roster.go and bus_tracker_routes.go.

   The Android app calls these with a device token (Authorization: Bearer
   bustrk.<id>.<secret>) and, for the driver, X-Staff-Session: sess.<id>.<secret>.
   Neither is a session cookie, so the routes cannot go through the Router;
   handleBusTrackerDevice is called from index.ts before router.match. The
   three /public/bus-tracker/* routes carry no credential at all.

   Bodies, status codes and the Go error envelope {"error":{"code","message"}}
   are kept exactly, because the shipped app parses them. */

const P = '/api/v1'
const TOKEN_PREFIX = 'bustrk'
const SESSION_PREFIX = 'sess'
const SESSION_TTL_MS = 20 * 3600 * 1000
const MAX_FIXES = 200
const MAX_SKEW_MS = 24 * 3600 * 1000
const PIN_MAX_FAILURES = 5
const PIN_LOCK_MS = 15 * 60 * 1000
const NIGHT_HEARTBEAT = 900, IDLE_HEARTBEAT = 300, NIGHT_START = 21 * 60, NIGHT_END = 5 * 60 + 30, WINDOW_SLACK = 30
const DEFAULT_APPROACH_M = 800
const PAIR_WINDOW_MS = 10 * 60 * 1000, PAIR_BURST = 6

// ------------------------------------------------------------------ plumbing

/** A Go httpx.Error, thrown and turned into the envelope by the dispatcher. */
class GoErr {
  constructor(public status: number, public code: string, public message: string, public body?: Record<string, unknown>) {}
}
const goError = (status: number, code: string, message: string) => json({ error: { code, message } }, status)
const malformed = () => new GoErr(400, 'bad_request', 'malformed JSON body')
const notFoundGo = () => new GoErr(404, 'not_found', 'resource not found')
const unauthorizedTracker = () => new GoErr(401, 'unauthorized',
  'this tracker is not paired, or its pairing has been revoked; pair the phone again from the transport screen')

type Body = Record<string, unknown>
async function decode(req: Request): Promise<Body> {
  let v: unknown
  try { v = await req.json() } catch { throw malformed() }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw malformed()
  return v as Body
}
const fStr = (b: Body, k: string): string => {
  const v = b[k]
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw malformed()
  return v
}
const fBool = (b: Body, k: string): boolean => {
  const v = b[k]
  if (v === undefined || v === null) return false
  if (typeof v !== 'boolean') throw malformed()
  return v
}
const fOptBool = (b: Body, k: string): boolean | null => {
  const v = b[k]
  if (v === undefined || v === null) return null
  if (typeof v !== 'boolean') throw malformed()
  return v
}
const fOptNum = (b: Body, k: string): number | null => {
  const v = b[k]
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v)) throw malformed()
  return v
}
const fOptInt = (b: Body, k: string): number | null => {
  const v = fOptNum(b, k)
  if (v !== null && !Number.isInteger(v)) throw malformed()
  return v
}
const fOptStr = (b: Body, k: string): string | null => {
  const v = b[k]
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw malformed()
  return v
}
const nullIfBlank = (s: string): string | null => (s.trim() === '' ? null : s.trim())
const nowISO = () => new Date().toISOString()
const b01 = (v: boolean | null) => (v === null ? null : v ? 1 : 0)
/** uuidParam in hr_lifecycle.go. */
function idParam(v: string): string {
  if (!isUUID(v)) throw new GoErr(400, 'bad_request', 'id must be a uuid')
  return v
}

/** SQL for regexp_replace(col,'[^A-Za-z0-9]','','g') over the punctuation plates and stickers actually carry. */
const normSQL = (col: string) =>
  `upper(replace(replace(replace(replace(replace(replace(replace(COALESCE(${col},''),' ',''),'-',''),'.',''),'/',''),'_',''),',',''),'#',''))`
/** right(regexp_replace(phone,'\D','','g'),10). */
const phoneDigitsSQL = (col: string) =>
  `substr(replace(replace(replace(replace(replace(replace(COALESCE(${col},''),' ',''),'-',''),'+',''),'(',''),')',''),'.',''), -10)`

/** RFC 3339 as Go formats a time parsed from s: the offset it arrived with, whole seconds. */
function formatLike(ms: number, raw: string): string {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(raw.trim())
  if (!m) return rfc3339UTC(ms)
  const off = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
  if (off === 0) return rfc3339UTC(ms)
  return new Date(ms + off * 60000).toISOString().slice(0, 19) + `${m[1]}${m[2]}:${m[3]}`
}

async function tenants(env: Env, activeOnly: boolean): Promise<{ inst: Institution; db: D1Database }[]> {
  const rows = await env.CONTROL.prepare(`SELECT * FROM institutions`).all<Institution>()
  const out: { inst: Institution; db: D1Database }[] = []
  for (const inst of rows.results) {
    if (activeOnly && inst.status !== 'active') continue
    try { out.push({ inst, db: tenantDb(env, inst) }) } catch { /* not provisioned here */ }
  }
  return out
}

/** Rate limit on the pairing bucket (6 per network per 10 minutes), kept in CONTROL's login_throttle. */
async function rateLimited(env: Env, req: Request, scope: string, msg: string): Promise<void> {
  const key = `rl:${scope}:${req.headers.get('cf-connecting-ip') ?? 'unknown'}`
  try {
    const row = await env.CONTROL.prepare('SELECT failures, window_started_at FROM login_throttle WHERE key = ?')
      .bind(key).first<{ failures: number; window_started_at: string }>()
    const fresh = !row || Date.now() - Date.parse(row.window_started_at) > PAIR_WINDOW_MS
    const count = fresh ? 0 : Number(row!.failures)
    if (count >= PAIR_BURST) throw new GoErr(429, 'rate_limited', msg)
    await env.CONTROL.prepare(`INSERT INTO login_throttle (key, failures, window_started_at, locked_until) VALUES (?, ?, ?, NULL)
        ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, window_started_at = excluded.window_started_at`)
      .bind(key, count + 1, fresh ? nowISO() : row!.window_started_at).run()
  } catch (e) {
    if (e instanceof GoErr) throw e
    console.error('rate limiter unavailable; allowing', e) // Go allows when the limiter fails
  }
}

// ------------------------------------------------------------------ device and driver

interface Dev { id: string; inst: string; vehicle: string | null; name: string; pingSeconds: number; paused: boolean; db: D1Database; env: Env }
interface Sess { id: string; userId: string; inst: string; name: string }

function splitToken(token: string, prefix: string): [string, string] | null {
  const parts = token.trim().split('.')
  if (parts.length !== 3 || parts[0] !== prefix || !isUUID(parts[1]) || parts[2] === '') return null
  return [parts[1], parts[2]]
}

/** requireBusTracker. */
async function authenticate(env: Env, req: Request): Promise<Dev> {
  const h = req.headers.get('authorization') ?? ''
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : ''
  const split = splitToken(token, TOKEN_PREFIX)
  if (!split) throw unauthorizedTracker()
  const [id, secret] = split
  const hits = await Promise.all((await tenants(env, false)).map(async ({ db }) => {
    const row = await db.prepare(`SELECT id, institution_id, vehicle_id, name, token_sealed, revoked_at, approved_at, ping_seconds, paused
        FROM vehicle_trackers WHERE id = ?`).bind(id).first<Record<string, unknown>>()
    return row ? { db, row } : null
  }))
  const hit = hits.find((x) => x !== null)
  if (!hit) throw unauthorizedTracker()
  const row = hit.row
  if (row.revoked_at !== null && row.revoked_at !== undefined) throw unauthorizedTracker()
  if (row.approved_at === null || row.approved_at === undefined) {
    throw new GoErr(403, 'awaiting_approval', 'this phone is registered but not yet approved, ask the principal to approve it on the transport screen')
  }
  let want: string
  try { want = await openSecret(env.CREDENTIAL_KEY, toBytes(row.token_sealed)) } catch { throw unauthorizedTracker() }
  if (!constantTimeEqual(want, secret)) throw unauthorizedTracker()
  return { id: String(row.id), inst: String(row.institution_id), vehicle: (row.vehicle_id as string | null) ?? null, name: String(row.name),
    pingSeconds: Number(row.ping_seconds), paused: !!row.paused, db: hit.db, env }
}

/** readStaffSession: null for anything wrong. */
async function readStaffSession(dev: Dev, req: Request): Promise<Sess | null> {
  const split = splitToken(req.headers.get('x-staff-session') ?? '', SESSION_PREFIX)
  if (!split) return null
  try {
    const row = await dev.db.prepare(`SELECT d.id, d.user_id, d.institution_id, u.full_name, d.token_sealed, d.expires_at, d.ended_at, d.app, d.device_id
        FROM device_staff_sessions d JOIN users u ON u.id = d.user_id WHERE d.id = ?`).bind(split[0]).first<Record<string, unknown>>()
    if (!row) return null
    if (row.app !== 'bus_tracker' || row.device_id !== dev.id || row.ended_at !== null || !(Date.parse(String(row.expires_at)) > Date.now())) return null
    const plain = await openSecret(dev.env.CREDENTIAL_KEY, toBytes(row.token_sealed))
    if (!constantTimeEqual(plain, split[1])) return null
    try { await dev.db.prepare(`UPDATE device_staff_sessions SET last_seen_at = ? WHERE id = ?`).bind(nowISO(), row.id).run() } catch { /* best effort */ }
    return { id: String(row.id), userId: String(row.user_id), inst: String(row.institution_id), name: String(row.full_name) }
  } catch { return null }
}

async function requireDriver(dev: Dev, req: Request): Promise<Sess> {
  const s = await readStaffSession(dev, req)
  if (!s) throw new GoErr(401, 'not_signed_in', 'sign in with your phone number and PIN before starting a run')
  return s
}

/** openStaffSession: the statements (supersede the old shift, insert the new) and the token. */
async function openStaffSession(env: Env, db: D1Database, who: { userId: string; inst: string }, device: string):
  Promise<{ stmts: D1PreparedStatement[]; token: string; expires: number }> {
  const id = uuid(), secret = randomSecret(), t = nowISO()
  const expires = Date.now() + SESSION_TTL_MS
  const sealed = await sealSecret(env.CREDENTIAL_KEY, secret)
  return {
    token: `${SESSION_PREFIX}.${id}.${secret}`, expires,
    stmts: [
      db.prepare(`UPDATE device_staff_sessions SET ended_at = ?, ended_reason = 'superseded' WHERE app = 'bus_tracker' AND device_id = ? AND ended_at IS NULL`)
        .bind(t, device),
      db.prepare(`INSERT INTO device_staff_sessions (id, institution_id, user_id, app, device_id, token_sealed, started_at, last_seen_at, expires_at)
          VALUES (?, ?, ?, 'bus_tracker', ?, ?, ?, ?, ?)`).bind(id, who.inst, who.userId, device, sealed, t, t, new Date(expires).toISOString()),
    ],
  }
}

// ------------------------------------------------------------------ staff login

interface Who { userId: string; inst: string; name: string; db: D1Database; instName: string }
const BAD_PIN = 'bad_pin', PIN_LOCKED = 'pin_locked', NO_LOGIN = 'no_login_yet'
class LoginErr { constructor(public kind: string) {} }

function rejected(kind: string): GoErr {
  if (kind === PIN_LOCKED) return new GoErr(429, 'pin_locked', 'too many wrong PINs. Wait fifteen minutes, or ask the office to reset it.')
  if (kind === NO_LOGIN) return new GoErr(401, 'no_login_yet', 'no PIN or password has been issued for this number yet. Ask the office to issue one.')
  return new GoErr(401, 'bad_pin', 'that number and password do not match. Ask the office to check the number on your record.')
}

const validPIN = (pin: string) => pin.length >= 4 && pin.length <= 8 && /^\d+$/.test(pin)
const normalisePhone = (s: string) => { const d = s.replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d }

/** authenticateStaffLogin: password first, then the PIN. Every school's users are asked, as Go's platform query did. */
async function authenticateStaffLogin(env: Env, identifier: string, secret: string): Promise<Who> {
  if (identifier.trim() === '' || secret === '') throw new LoginErr(BAD_PIN)
  const all = await tenants(env, true)
  const found = (await Promise.all(all.map(async ({ inst, db }) => {
    const r = await db.prepare(`SELECT id, COALESCE(full_name, '') AS name, password_hash, pin_hash IS NOT NULL AS has_pin FROM users
        WHERE status = 'active' AND (email = ? OR phone = ? OR username = ? OR ${phoneDigitsSQL('phone')} = ?)`)
      .bind(identifier, identifier, identifier, identifier).all<{ id: string; name: string; password_hash: string | null; has_pin: number }>()
    return r.results.map((u) => ({ u, inst, db }))
  }))).flat()
  if (found.length === 1) {
    const { u, inst, db } = found[0]
    if (u.password_hash && await verifyPassword(env.PASSWORD_PEPPER, u.password_hash, secret)) {
      return { userId: u.id, inst: inst.id, name: u.name, db, instName: inst.name }
    }
    if (!u.password_hash && !u.has_pin) throw new LoginErr(NO_LOGIN)
  }
  if (!validPIN(secret)) throw new LoginErr(BAD_PIN)
  return authenticatePIN(env, all, identifier, secret)
}

async function authenticatePIN(env: Env, all: { inst: Institution; db: D1Database }[], phone: string, pin: string): Promise<Who> {
  const digits = normalisePhone(phone)
  if (digits.length !== 10 || !validPIN(pin)) throw new LoginErr(BAD_PIN)
  let hit: { inst: Institution; db: D1Database; u: Record<string, unknown> } | null = null
  for (const { inst, db } of all) {
    const u = await db.prepare(`SELECT id, full_name, pin_hash, pin_failed, pin_locked_until, status FROM users
        WHERE pin_hash IS NOT NULL AND ${phoneDigitsSQL('phone')} = ? LIMIT 1`).bind(digits).first<Record<string, unknown>>()
    if (u) { hit = { inst, db, u }; break }
  }
  if (!hit) throw new LoginErr(BAD_PIN)
  const { inst, db, u } = hit
  const fail = async () => {
    try {
      await db.prepare(`UPDATE users SET pin_failed = pin_failed + 1,
            pin_locked_until = CASE WHEN pin_failed + 1 >= ? THEN ? ELSE pin_locked_until END, updated_at = ?
          WHERE pin_hash IS NOT NULL AND ${phoneDigitsSQL('phone')} = ?`)
        .bind(PIN_MAX_FAILURES, new Date(Date.now() + PIN_LOCK_MS).toISOString(), nowISO(), digits).run()
    } catch { /* best effort */ }
    return new LoginErr(BAD_PIN)
  }
  if (u.status !== 'active') throw await fail()
  if (u.pin_locked_until && Date.parse(String(u.pin_locked_until)) > Date.now()) throw new LoginErr(PIN_LOCKED)
  if (!await verifyPassword(env.PASSWORD_PEPPER, String(u.pin_hash), pin)) throw await fail()
  if (Number(u.pin_failed) !== 0 || u.pin_locked_until) {
    await db.prepare(`UPDATE users SET pin_failed = 0, pin_locked_until = NULL, updated_at = ? WHERE id = ?`).bind(nowISO(), u.id).run()
  }
  return { userId: String(u.id), inst: inst.id, name: String(u.full_name ?? ''), db, instName: inst.name }
}

async function staffLogin(env: Env, b: Body): Promise<Who> {
  const password = fStr(b, 'password'), pin = fStr(b, 'pin')
  try { return await authenticateStaffLogin(env, fStr(b, 'phone'), password !== '' ? password : pin) } catch (e) {
    if (e instanceof LoginErr) throw rejected(e.kind)
    throw e
  }
}

/** requireTransportDriver: false when the login is not a driver's. */
async function isTransportDriver(db: D1Database, userId: string, inst: string): Promise<boolean> {
  const r = await db.prepare(`SELECT (
        EXISTS (SELECT 1 FROM vehicles v JOIN employees e ON e.id = v.driver_employee_id WHERE e.user_id = ?1 AND v.institution_id = ?2)
     OR EXISTS (SELECT 1 FROM employees e JOIN designations d ON d.id = e.designation_id
                 WHERE e.user_id = ?1 AND e.institution_id = ?2 AND d.name LIKE '%driver%')
     OR EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                 WHERE ur.user_id = ?1 AND rp.permission_key = 'transport.write')
     OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?1 AND r.key = 'driver')) AS ok`)
    .bind(userId, inst).first<{ ok: number }>()
  return !!r?.ok
}
const notADriver = () => new GoErr(409, 'not_a_driver',
  'this login is not a driver\'s. Ask the office to put you against a vehicle in Transport, then sign in again')

// ------------------------------------------------------------------ public: claim, driver sign-in, enrol

async function claimPairCode(env: Env, req: Request): Promise<Response> {
  await rateLimited(env, req, 'bus_tracker_pair', 'too many pairing attempts from this network. Wait a few minutes and try again')
  const b = await decode(req)
  const refuse = () => new GoErr(401, 'bad_pair_code', 'that pairing code is not valid; generate a new one from the transport screen')
  const code = fStr(b, 'pair_code')
  if (code.trim() === '') throw refuse()
  let name = fStr(b, 'device_name').trim()
  if (name === '') name = fStr(b, 'device_model').trim()
  if (name === '') name = "Driver's phone"
  const hash = await hashPairCode(code)

  // The code names no school, so every school is asked; the hash is unique within each.
  let hit: { inst: Institution; db: D1Database } | null = null
  for (const t of await tenants(env, false)) {
    const r = await t.db.prepare(`SELECT id FROM vehicle_tracker_pair_codes WHERE code_hash = ? AND claimed_at IS NULL AND julianday(expires_at) > julianday('now')`)
      .bind(hash).first()
    if (r) { hit = t; break }
  }
  if (!hit) throw refuse()
  const { inst, db } = hit
  const t = nowISO()
  const pc = await db.prepare(`UPDATE vehicle_tracker_pair_codes SET claimed_at = ?
      WHERE code_hash = ? AND claimed_at IS NULL AND julianday(expires_at) > julianday('now')
      RETURNING id, institution_id, vehicle_id, created_by`).bind(t, hash)
    .first<{ id: string; institution_id: string; vehicle_id: string | null; created_by: string | null }>()
  if (!pc) throw refuse()
  let registration = ''
  if (pc.vehicle_id) {
    const v = await db.prepare(`SELECT registration_no FROM vehicles WHERE id = ?`).bind(pc.vehicle_id).first<{ registration_no: string }>()
    if (!v) throw refuse()
    registration = v.registration_no
  }
  const policy = await trackingPolicyIn(db, pc.institution_id)
  const deviceId = uuid(), secret = randomSecret()
  const sealed = await sealSecret(env.CREDENTIAL_KEY, secret)
  const stmts: D1PreparedStatement[] = []
  if (pc.vehicle_id) {
    stmts.push(db.prepare(`UPDATE vehicle_trackers SET revoked_at = ?, revoked_reason = 'replaced by a newly paired phone', updated_at = ?
        WHERE vehicle_id = ? AND revoked_at IS NULL`).bind(t, t, pc.vehicle_id))
  }
  stmts.push(db.prepare(`INSERT INTO vehicle_trackers (id, institution_id, vehicle_id, name, device_model, android_version, app_version, token_sealed,
        pair_code_id, paired_at, paired_by, ping_seconds, approved_at, approved_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(deviceId, pc.institution_id, pc.vehicle_id, name, nullIfBlank(fStr(b, 'device_model')), nullIfBlank(fStr(b, 'android_version')),
      nullIfBlank(fStr(b, 'app_version')), sealed, pc.id, t, pc.created_by, policy.pingSeconds, t, pc.created_by, t, t))
  await db.batch(stmts)
  return json({
    device_id: deviceId,
    device_token: `${TOKEN_PREFIX}.${deviceId}.${secret}`,
    institution: { id: pc.institution_id, name: inst.name },
    vehicle: { id: pc.vehicle_id ?? '', registration_no: registration },
    ping_seconds: policy.pingSeconds,
  })
}

/** Revoke the bus's live tracker, drop revoked ones no trip points at, then insert the new one. */
function replaceTrackerStmts(db: D1Database, vehicle: string, reason: string, dropDead: boolean): D1PreparedStatement[] {
  const t = nowISO()
  const out = [db.prepare(`UPDATE vehicle_trackers SET revoked_at = ?, revoked_reason = ?, updated_at = ? WHERE vehicle_id = ? AND revoked_at IS NULL`)
    .bind(t, reason, t, vehicle)]
  if (dropDead) {
    const dead = `SELECT t.id FROM vehicle_trackers t WHERE t.vehicle_id = ? AND t.revoked_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM vehicle_trips p WHERE p.tracker_id = t.id)`
    out.push(db.prepare(`DELETE FROM device_staff_sessions WHERE app = 'bus_tracker' AND device_id IN (${dead})`).bind(vehicle))
    out.push(db.prepare(`DELETE FROM vehicle_trackers WHERE id IN (${dead})`).bind(vehicle))
  }
  return out
}

async function signInBusDriver(env: Env, req: Request): Promise<Response> {
  const b = await decode(req)
  const who = await staffLogin(env, b)
  const db = who.db
  if (!await isTransportDriver(db, who.userId, who.inst)) throw notADriver()
  const noSuchBus = () => new GoErr(404, 'no_such_bus', 'no bus in this school has that code. Check the sticker in the cab, or ask the office which bus you are on')
  type V = { id: string; registration_no: string; model: string }
  let v: V | null
  const busCode = fStr(b, 'bus_code').trim(), picked = fStr(b, 'vehicle_id').trim()
  if (busCode !== '') {
    v = await db.prepare(`SELECT id, registration_no, COALESCE(model, '') AS model FROM vehicles WHERE institution_id = ? AND bus_code = ? AND status = 'active'`)
      .bind(who.inst, busCode).first<V>()
    if (!v) throw noSuchBus()
  } else if (picked !== '') {
    if (!isUUID(picked)) throw new Error('invalid input syntax for type uuid') // Go's ::uuid cast: a 500
    v = await db.prepare(`SELECT id, registration_no, COALESCE(model, '') AS model FROM vehicles WHERE institution_id = ? AND id = ? AND status = 'active'`)
      .bind(who.inst, picked).first<V>()
    if (!v) throw noSuchBus()
  } else {
    v = await db.prepare(`SELECT v.id, v.registration_no, COALESCE(v.model, '') AS model FROM vehicles v JOIN employees e ON e.id = v.driver_employee_id
        WHERE e.user_id = ? AND v.institution_id = ? AND v.status = 'active' ORDER BY v.registration_no LIMIT 1`).bind(who.userId, who.inst).first<V>()
    if (!v) {
      const buses = await db.prepare(`SELECT id, registration_no, COALESCE(bus_code, '') AS bus_code, COALESCE(model, '') AS model FROM vehicles
          WHERE institution_id = ? AND status = 'active' ORDER BY registration_no`).bind(who.inst)
        .all<{ id: string; registration_no: string; bus_code: string; model: string }>()
      return json({
        needs_bus: true, institution: who.inst, driver: who.name,
        buses: buses.results.map((x) => {
          const o: Record<string, unknown> = { id: x.id, registration_no: x.registration_no }
          if (x.bus_code !== '') o.bus_code = x.bus_code
          if (x.model !== '') o.model = x.model
          return o
        }),
      })
    }
  }
  const deviceId = uuid(), secret = randomSecret(), t = nowISO()
  const sealed = await sealSecret(env.CREDENTIAL_KEY, secret)
  const sess = await openStaffSession(env, db, who, deviceId)
  await db.batch([
    ...replaceTrackerStmts(db, v.id, 'replaced when the driver signed in on another phone', true),
    db.prepare(`INSERT INTO vehicle_trackers (id, institution_id, vehicle_id, name, device_model, android_version, app_version, token_sealed,
          enrolled_by, paired_at, approved_at, approved_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(deviceId, who.inst, v.id, who.name + "'s phone", nullIfBlank(fStr(b, 'device_model')), nullIfBlank(fStr(b, 'android_version')),
        nullIfBlank(fStr(b, 'app_version')), sealed, who.userId, t, t, who.userId, t, t),
    ...sess.stmts,
  ])
  const routes = await db.prepare(`SELECT id, name, COALESCE(code, '') AS code FROM routes WHERE institution_id = ? AND vehicle_id = ? ORDER BY name`)
    .bind(who.inst, v.id).all<{ id: string; name: string; code: string }>()
  return json({
    device_id: deviceId,
    device_token: `${TOKEN_PREFIX}.${deviceId}.${secret}`,
    session_token: sess.token,
    institution: who.inst,
    vehicle: { id: v.id, registration_no: v.registration_no, model: v.model },
    driver: who.name,
    routes: routeRows(routes.results),
  })
}

const routeRows = (rows: { id: string; name: string; code: string }[]) =>
  rows.map((r) => (r.code === '' ? { id: r.id, name: r.name } : { id: r.id, name: r.name, code: r.code }))

async function enrolBusTracker(env: Env, req: Request): Promise<Response> {
  await rateLimited(env, req, 'sms_gateway_pair', 'too many attempts from this network. Wait a few minutes and try again')
  const b = await decode(req)
  const reg = fStr(b, 'registration_no').toUpperCase().trim().replace(/[^A-Z0-9]/g, '')
  if (reg === '') throw new GoErr(400, 'no_registration', 'type the number painted on the bus you are driving')
  const who = await staffLogin(env, b)
  const db = who.db
  if (!await isTransportDriver(db, who.userId, who.inst)) throw notADriver()
  const v = await db.prepare(`SELECT id, registration_no FROM vehicles WHERE institution_id = ?
      AND (${normSQL('registration_no')} = ? OR upper(bus_code) = ?) AND status <> 'retired' LIMIT 1`)
    .bind(who.inst, reg, reg).first<{ id: string; registration_no: string }>()
  if (!v) throw new GoErr(404, 'no_such_vehicle', 'no bus with that number at your school. Check the plate and type it again')
  const policy = await trackingPolicyIn(db, who.inst)
  const deviceId = uuid(), secret = randomSecret(), t = nowISO()
  const sealed = await sealSecret(env.CREDENTIAL_KEY, secret)
  const sess = await openStaffSession(env, db, who, deviceId)
  await db.batch([
    ...replaceTrackerStmts(db, v.id, 'replaced by a newly enrolled phone', false),
    db.prepare(`INSERT INTO vehicle_trackers (id, institution_id, vehicle_id, name, device_model, android_version, app_version, token_sealed,
          enrolled_by, ping_seconds, paired_at, approved_at, approved_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(deviceId, who.inst, v.id, truncate(who.name + ' - ' + v.registration_no, 80), nullIfBlank(fStr(b, 'device_model')),
        nullIfBlank(fStr(b, 'android_version')), nullIfBlank(fStr(b, 'app_version')), sealed, who.userId, policy.pingSeconds, t, t, who.userId, t, t),
    ...sess.stmts,
  ])
  return json({
    device_id: deviceId, device_token: `${TOKEN_PREFIX}.${deviceId}.${secret}`, session_token: sess.token,
    institution: who.instName, vehicle: v.registration_no, name: who.name, ping_seconds: policy.pingSeconds, approved: true,
  })
}

// ------------------------------------------------------------------ the driver's shift

async function busTrackerSignIn(dev: Dev, req: Request): Promise<Response> {
  const b = await decode(req)
  const who = await staffLogin(dev.env, b)
  if (who.inst !== dev.inst) throw rejected(BAD_PIN)
  if (!await isTransportDriver(dev.db, who.userId, who.inst)) throw notADriver()
  const sess = await openStaffSession(dev.env, dev.db, who, dev.id)
  await dev.db.batch(sess.stmts)
  const routes = await dev.db.prepare(`SELECT id, name, COALESCE(code, '') AS code FROM routes
      WHERE is_active = 1 AND (?1 IS NULL OR vehicle_id = ?1) ORDER BY name`).bind(dev.vehicle).all<{ id: string; name: string; code: string }>()
  return json({ session_token: sess.token, name: who.name, expires_at: rfc3339UTC(sess.expires), routes: routeRows(routes.results) })
}

async function busTrackerSignOut(dev: Dev): Promise<Response> {
  await dev.db.prepare(`UPDATE device_staff_sessions SET ended_at = ?, ended_reason = 'signed_out' WHERE app = 'bus_tracker' AND device_id = ? AND ended_at IS NULL`)
    .bind(nowISO(), dev.id).run()
  return json({ signed_out: true })
}

// ------------------------------------------------------------------ trips

const ERR_BUS_NOT_FOUND = 'bus_not_found', ERR_NO_BUS = 'no_bus_for_trip'
class TripErr { constructor(public kind: string) {} }

/** resolveTripVehicle: the scanned code wins over the pairing. */
async function resolveTripVehicle(dev: Dev, busCode: string): Promise<string> {
  const code = normaliseBusCode(busCode)
  if (code === '') {
    if (dev.vehicle === null) throw new TripErr(ERR_NO_BUS)
    return dev.vehicle
  }
  const r = await dev.db.prepare(`SELECT id FROM vehicles WHERE institution_id = ?
      AND (${normSQL('bus_code')} = ? OR ${normSQL('registration_no')} = ?) AND status <> 'retired' LIMIT 1`)
    .bind(dev.inst, code, code).first<{ id: string }>()
  if (!r) throw new TripErr(ERR_BUS_NOT_FOUND)
  return r.id
}

/** closeTimedOutTrips: one vehicle's silent runs, ended at the moment they were last heard. */
async function closeTimedOutTrips(db: D1Database, vehicle: string, timeoutMins: number): Promise<void> {
  const rows = await db.prepare(`SELECT o.id, o.started_at, (SELECT max(p.recorded_at) FROM vehicle_positions p WHERE p.trip_id = o.id) AS last_fix
      FROM vehicle_trips o WHERE o.vehicle_id = ? AND o.ended_at IS NULL`).bind(vehicle)
    .all<{ id: string; started_at: string; last_fix: string | null }>()
  const mins = clampTripTimeoutMins(timeoutMins)
  const stmts: D1PreparedStatement[] = []
  for (const r of rows.results) {
    const started = Date.parse(r.started_at), fix = r.last_fix ? Date.parse(r.last_fix) : started
    const last = Math.max(started, fix)
    if (last + mins * 60000 >= Date.now()) continue
    const at = new Date(last).toISOString()
    stmts.push(db.prepare(`UPDATE vehicle_trips SET ended_at = ?, ended_reason = 'timeout' WHERE id = ? AND ended_at IS NULL`).bind(at, r.id))
    stmts.push(db.prepare(`UPDATE transport_safety_events SET ended_at = CASE WHEN julianday(started_at) > julianday(?1) THEN started_at ELSE ?1 END
        WHERE trip_id = ?2 AND ended_at IS NULL`).bind(at, r.id))
  }
  if (stmts.length) await db.batch(stmts)
}

async function startTrip(dev: Dev, req: Request): Promise<Response> {
  const driver = await requireDriver(dev, req)
  const b = await decode(req)
  const route = fStr(b, 'route_id')
  if (!isUUID(route)) throw new GoErr(400, 'bad_route_id', 'route_id must be a uuid')
  const direction = fStr(b, 'direction')
  if (direction !== 'pickup' && direction !== 'drop') throw new GoErr(400, 'bad_direction', 'direction must be pickup or drop')
  let started = Date.now()
  const sa = fStr(b, 'started_at')
  if (sa !== '') { const t = parseRFC3339(sa); if (!Number.isNaN(t)) started = t }
  const supersede = fBool(b, 'supersede')
  const busCode = fStr(b, 'bus_code')
  const db = dev.db

  const rt = await db.prepare(`SELECT vehicle_id FROM routes WHERE id = ? AND institution_id = ?`).bind(route, dev.inst).first<{ vehicle_id: string | null }>()
  if (!rt) throw new GoErr(404, 'no_such_route', 'that route does not belong to this school')
  let vehicle: string
  try { vehicle = await resolveTripVehicle(dev, busCode) } catch (e) {
    if (e instanceof TripErr && e.kind === ERR_NO_BUS) throw new GoErr(400, 'no_bus_scanned', 'scan the bus you are in before starting a run')
    if (e instanceof TripErr) throw new GoErr(404, 'bus_not_found', 'that sticker is not a bus at this school. Check it is the right vehicle, or ask the office')
    throw e
  }
  if (rt.vehicle_id !== null && rt.vehicle_id !== vehicle) {
    throw new GoErr(409, 'route_not_this_bus', 'that route is assigned to a different bus; pick the route this bus runs, or ask the office to reassign it')
  }
  const policy = await trackingPolicyIn(db, dev.inst)
  await closeTimedOutTrips(db, vehicle, policy.tripTimeoutMins)

  const open = await db.prepare(`SELECT id FROM vehicle_trips WHERE vehicle_id = ? AND ended_at IS NULL`).bind(vehicle).first<{ id: string }>()
  if (open && !supersede) throw new GoErr(409, 'trip_already_open', 'this bus already has a run in progress; end it, or send supersede to replace it')
  const t = nowISO(), tripId = uuid()
  const stmts: D1PreparedStatement[] = []
  if (open) stmts.push(db.prepare(`UPDATE vehicle_trips SET ended_at = ?, ended_reason = 'superseded' WHERE id = ?`).bind(t, open.id))
  stmts.push(db.prepare(`INSERT INTO vehicle_trips (id, institution_id, vehicle_id, route_id, tracker_id, direction, started_at, started_by, driver_session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(tripId, dev.inst, vehicle, route, dev.id, direction, new Date(started).toISOString(), driver.userId, driver.id, t))
  await db.batch(stmts)
  await notifyTripStarted(dev.env, db, dev.inst, tripId, route, direction)

  const rows = await db.prepare(`SELECT id, name, sequence, latitude, longitude, COALESCE(geofence_m, ?) AS geofence_m,
        substr(CASE WHEN ? = 'drop' THEN drop_time ELSE pickup_time END, 1, 5) AS scheduled_at
      FROM route_stops WHERE route_id = ? ORDER BY sequence ${direction === 'drop' ? 'DESC' : ''}`)
    .bind(policy.defaultGeofenceM, direction, route).all<Record<string, unknown>>()
  const stops = rows.results.map((s) => {
    const o: Record<string, unknown> = { id: s.id, name: s.name, sequence: Number(s.sequence) }
    if (s.latitude !== null) o.latitude = Number(s.latitude)
    if (s.longitude !== null) o.longitude = Number(s.longitude)
    o.geofence_m = Number(s.geofence_m)
    if (s.scheduled_at !== null) o.scheduled_at = s.scheduled_at
    return o
  })
  return json({ trip_id: tripId, stops }, 201)
}

async function endTrip(dev: Dev, req: Request, id: string): Promise<Response> {
  await requireDriver(dev, req)
  const tripId = idParam(id)
  const b = await decode(req)
  let ended = Date.now()
  const ea = fStr(b, 'ended_at')
  if (ea !== '') { const t = parseRFC3339(ea); if (!Number.isNaN(t)) ended = t }
  const at = new Date(ended).toISOString()
  const res = await dev.db.prepare(`UPDATE vehicle_trips SET ended_at = CASE WHEN julianday(?1) > julianday(started_at) THEN ?1 ELSE started_at END,
        ended_reason = 'driver' WHERE id = ?2 AND tracker_id = ?3 AND ended_at IS NULL`).bind(at, tripId, dev.id).run()
  if (!res.meta.changes) throw new GoErr(404, 'no_such_trip', "that run is not this bus's, or it has already ended")
  await dev.db.prepare(`UPDATE transport_safety_events SET ended_at = CASE WHEN julianday(?1) > julianday(started_at) THEN ?1 ELSE started_at END
      WHERE trip_id = ?2 AND ended_at IS NULL`).bind(at, tripId).run()
  return json({ ended: true })
}

// ------------------------------------------------------------------ positions

interface Fix { at: number; raw: string; lat: number; lon: number; speed: number | null; heading: number | null; accuracy: number | null }

async function ingestPositions(dev: Dev, req: Request): Promise<Response> {
  const b = await decode(req)
  const tripId = fStr(b, 'trip_id')
  if (!isUUID(tripId)) throw new GoErr(400, 'bad_trip_id', 'trip_id must be a uuid')
  const raw = b.fixes
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) throw malformed()
  const list = (raw ?? []) as unknown[]
  if (list.length === 0) throw new GoErr(400, 'no_fixes', 'send at least one fix')
  if (list.length > MAX_FIXES) throw new GoErr(400, 'too_many_fixes', `send at most ${MAX_FIXES} fixes in one push`)
  const now = Date.now()
  const fixes: Fix[] = []
  list.forEach((f, i) => {
    if (f === null || typeof f !== 'object' || Array.isArray(f)) throw malformed()
    const o = f as Body
    const rec = fStr(o, 'recorded_at')
    const at = parseRFC3339(rec)
    const lat = fOptNum(o, 'latitude') ?? 0, lon = fOptNum(o, 'longitude') ?? 0
    const fix: Fix = { at, raw: rec, lat, lon, speed: fOptNum(o, 'speed_kmph'), heading: fOptInt(o, 'heading_deg'), accuracy: fOptNum(o, 'accuracy_m') }
    if (Number.isNaN(at)) throw new GoErr(400, 'bad_recorded_at', `fix ${i + 1}: recorded_at must be RFC 3339 with an offset`)
    if (Math.abs(at - now) > MAX_SKEW_MS) {
      throw new GoErr(422, 'skewed_clock', "this phone's clock is more than a day from the server's; correct it before reporting, or the history cannot be trusted",
        { server_time: rfc3339UTC(now) })
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new GoErr(400, 'bad_coordinates', `fix ${i + 1}: latitude or longitude is out of range`)
    fixes.push(fix)
  })
  // Stable: Array.prototype.sort is, and equal times keep their order as Go's insertion sort does.
  fixes.sort((a, c) => a.at - c.at)

  const db = dev.db
  const trip = await db.prepare(`SELECT route_id, direction, ended_at IS NULL AS open, vehicle_id FROM vehicle_trips WHERE id = ? AND tracker_id = ?`)
    .bind(tripId, dev.id).first<{ route_id: string; direction: string; open: number; vehicle_id: string }>()
  if (!trip) throw new GoErr(404, 'no_such_trip', "that run is not this bus's")
  const policy = await trackingPolicyIn(db, dev.inst)
  const accepted: string[] = []
  const tripOpen = !!trip.open
  if (tripOpen) {
    const t = nowISO()
    const stmts = fixes.map((p) => db.prepare(`INSERT OR IGNORE INTO vehicle_positions (institution_id, trip_id, vehicle_id, recorded_at, received_at,
          latitude, longitude, speed_kmph, heading_deg, accuracy_m) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(dev.inst, tripId, trip.vehicle_id, new Date(p.at).toISOString(), t, p.lat, p.lon, p.speed, p.heading, p.accuracy))
    const last = fixes[fixes.length - 1]
    stmts.push(db.prepare(`INSERT INTO vehicle_last_position (vehicle_id, institution_id, trip_id, recorded_at, received_at, latitude, longitude,
          speed_kmph, heading_deg, accuracy_m, tracker_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (vehicle_id) DO UPDATE SET trip_id = excluded.trip_id, recorded_at = excluded.recorded_at, received_at = excluded.received_at,
          latitude = excluded.latitude, longitude = excluded.longitude, speed_kmph = excluded.speed_kmph, heading_deg = excluded.heading_deg,
          accuracy_m = excluded.accuracy_m, tracker_id = excluded.tracker_id
        WHERE julianday(excluded.recorded_at) > julianday(vehicle_last_position.recorded_at)`)
      .bind(trip.vehicle_id, dev.inst, tripId, new Date(last.at).toISOString(), t, last.lat, last.lon, last.speed, last.heading, last.accuracy, dev.id))
    await db.batch(stmts)
    for (const p of fixes) accepted.push(formatLike(p.at, p.raw))
    await walkGeofences(dev, tripId, trip.route_id, trip.direction, policy, fixes)
    await trackSpeeding(dev, trip.vehicle_id, tripId, policy, fixes)
    try { await notifyApproaching(dev, tripId, trip.route_id, trip.direction, fixes) } catch (e) { console.warn('approach notice', e) }
  }
  return json({ accepted, ping_seconds: policy.pingSeconds, paused: dev.paused, trip_open: tripOpen })
}

/** walkGeofences: one arrival and one departure per stop per run, the unique index deciding. */
async function walkGeofences(dev: Dev, trip: string, route: string, direction: string, policy: TrackingPolicy, points: Fix[]): Promise<void> {
  const db = dev.db
  const rows = await db.prepare(`SELECT rs.id, rs.latitude, rs.longitude, COALESCE(rs.geofence_m, ?1) AS radius,
        CASE WHEN ?2 = 'drop' THEN rs.drop_time ELSE rs.pickup_time END AS scheduled,
        EXISTS (SELECT 1 FROM transport_stop_events e WHERE e.trip_id = ?3 AND e.stop_id = rs.id AND e.kind = 'arrived') AS arrived,
        EXISTS (SELECT 1 FROM transport_stop_events e WHERE e.trip_id = ?3 AND e.stop_id = rs.id AND e.kind = 'departed') AS departed,
        rs.is_school
      FROM route_stops rs WHERE rs.route_id = ?4 AND rs.latitude IS NOT NULL AND rs.longitude IS NOT NULL`)
    .bind(policy.defaultGeofenceM, direction, trip, route).all<Record<string, unknown>>()
  const stops = rows.results.map((s) => ({ id: String(s.id), lat: Number(s.latitude), lon: Number(s.longitude), radius: Number(s.radius),
    scheduled: (s.scheduled as string | null) ?? null, arrived: !!s.arrived, departed: !!s.departed, school: !!s.is_school }))
  if (!stops.length) return
  for (const p of points) {
    for (const st of stops) {
      const inside = metresBetween(p.lat, p.lon, st.lat, st.lon) <= st.radius
      if (inside && !st.arrived) {
        let deviation: number | null = null
        const m = st.scheduled ? /^(\d{1,2}):(\d{2})/.exec(st.scheduled) : null
        if (m) {
          const local = p.at + IST_MS
          const day = Math.floor(local / 86400000) * 86400000
          const want = day + (Number(m[1]) * 60 + Number(m[2])) * 60000
          const d = (local - want) / 60000
          deviation = Math.sign(d) * Math.round(Math.abs(d))
        }
        const res = await db.prepare(`INSERT OR IGNORE INTO transport_stop_events (id, institution_id, trip_id, stop_id, kind, occurred_at, latitude, longitude,
              deviation_mins, created_at) VALUES (?, ?, ?, ?, 'arrived', ?, ?, ?, ?, ?)`)
          .bind(uuid(), dev.inst, trip, st.id, new Date(p.at).toISOString(), p.lat, p.lon, deviation, nowISO()).run()
        st.arrived = true
        if (res.meta.changes && ((st.school && direction !== 'drop') || (!st.school && direction === 'drop'))) {
          await notifyArrived(dev.env, db, dev.inst, trip, route, st.id, direction, st.school)
        }
      } else if (!inside && st.arrived && !st.departed) {
        await db.prepare(`INSERT OR IGNORE INTO transport_stop_events (id, institution_id, trip_id, stop_id, kind, occurred_at, latitude, longitude, created_at)
            VALUES (?, ?, ?, ?, 'departed', ?, ?, ?, ?)`).bind(uuid(), dev.inst, trip, st.id, new Date(p.at).toISOString(), p.lat, p.lon, nowISO()).run()
        st.departed = true
      }
    }
  }
}

/** trackSpeeding: one sustained episode per run, deleted when shorter than the hold. */
async function trackSpeeding(dev: Dev, vehicle: string, trip: string, policy: TrackingPolicy, points: Fix[]): Promise<void> {
  const db = dev.db
  const limit = policy.speedLimitKmph, hold = policy.speedingHoldSecs * 1000
  for (const p of points) {
    if (p.speed === null) continue
    const over = p.speed > limit
    const ev = await db.prepare(`SELECT id, started_at, COALESCE(peak_kmph, 0) AS peak FROM transport_safety_events
        WHERE trip_id = ? AND kind = 'speeding' AND ended_at IS NULL`).bind(trip).first<{ id: string; started_at: string; peak: unknown }>()
    if (over && !ev) {
      await db.prepare(`INSERT OR IGNORE INTO transport_safety_events (id, institution_id, trip_id, vehicle_id, kind, started_at, peak_kmph, limit_kmph,
            latitude, longitude, created_at) VALUES (?, ?, ?, ?, 'speeding', ?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), dev.inst, trip, vehicle, new Date(p.at).toISOString(), p.speed, limit, p.lat, p.lon, nowISO()).run()
    } else if (over && ev) {
      if (p.speed > Number(ev.peak)) {
        await db.prepare(`UPDATE transport_safety_events SET peak_kmph = ?, latitude = ?, longitude = ? WHERE id = ?`).bind(p.speed, p.lat, p.lon, ev.id).run()
      }
    } else if (!over && ev) {
      if (p.at - Date.parse(ev.started_at) < hold) {
        await db.prepare(`DELETE FROM transport_safety_events WHERE id = ?`).bind(ev.id).run()
        continue
      }
      await db.prepare(`UPDATE transport_safety_events SET ended_at = ? WHERE id = ?`).bind(new Date(p.at).toISOString(), ev.id).run()
    }
  }
}

/** notifyApproaching: the guardians who asked, within their distance of their stop, on the last fix (services/transport_notices.ts). */
async function notifyApproaching(dev: Dev, trip: string, route: string, direction: string, points: Fix[]): Promise<void> {
  if (!points.length) return
  const p = points[points.length - 1]
  await notifyApproachingNotice(dev.env, dev.db, dev.inst, trip, route, direction, { lat: p.lat, lon: p.lon }, metresBetween)
}

// ------------------------------------------------------------------ heartbeat and notices

async function heartbeatSeconds(db: D1Database, inst: string, running: boolean): Promise<number> {
  if (running) return 0
  const local = new Date(Date.now() + IST_MS)
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes()
  if (minutes >= NIGHT_START || minutes < NIGHT_END) return NIGHT_HEARTBEAT
  const mins = (c: string) => `CAST(substr(${c}, 1, 2) AS INTEGER) * 60 + CAST(substr(${c}, 4, 2) AS INTEGER)`
  const r = await db.prepare(`SELECT MIN(m) AS first, MAX(m) AS last FROM (
        SELECT ${mins('pickup_time')} AS m FROM route_stops WHERE institution_id = ?1 AND pickup_time IS NOT NULL
        UNION ALL SELECT ${mins('drop_time')} FROM route_stops WHERE institution_id = ?1 AND drop_time IS NOT NULL)`)
    .bind(inst).first<{ first: number | null; last: number | null }>()
  if (!r || r.first === null || r.last === null) return 0
  if (minutes >= r.first - WINDOW_SLACK && minutes <= r.last + WINDOW_SLACK) return 0
  return IDLE_HEARTBEAT
}

/** vehicleForTracker: the paired bus, or the bus of this phone's open or recent run. */
async function vehicleForTracker(dev: Dev): Promise<string | null> {
  if (dev.vehicle !== null) return dev.vehicle
  const r = await dev.db.prepare(`SELECT vehicle_id FROM vehicle_trips WHERE tracker_id = ? AND institution_id = ?
      AND (ended_at IS NULL OR julianday(ended_at) > julianday('now') - 0.5)
      ORDER BY (ended_at IS NULL) DESC, started_at DESC LIMIT 1`).bind(dev.id, dev.inst).first<{ vehicle_id: string }>()
  return r?.vehicle_id ?? null
}

async function heartbeat(dev: Dev, req: Request): Promise<Response> {
  const b = await decode(req)
  const battery = fOptInt(b, 'battery_pct'), charging = fOptBool(b, 'charging'), locOK = fOptBool(b, 'location_ok'), app = fOptStr(b, 'app_version')
  const db = dev.db
  const t = nowISO()
  const row = await db.prepare(`UPDATE vehicle_trackers SET last_seen_at = ?, battery_pct = COALESCE(?, battery_pct), charging = COALESCE(?, charging),
        location_ok = COALESCE(?, location_ok), app_version = COALESCE(?, app_version), updated_at = ?
      WHERE id = ? RETURNING ping_seconds, paused`).bind(t, battery, b01(charging), b01(locOK), app, t, dev.id)
    .first<{ ping_seconds: number; paused: number }>()
  if (!row) throw new Error('tracker row vanished')
  const vehicle = await vehicleForTracker(dev)
  let notices: { id: string; body: string; sent_at: string }[] = []
  if (vehicle !== null) {
    notices = (await db.prepare(`SELECT id, body, strftime('%Y-%m-%dT%H:%M:%SZ', sent_at) AS sent_at FROM driver_notices
        WHERE vehicle_id = ? AND institution_id = ? AND acknowledged_at IS NULL AND julianday(expires_at) > julianday('now')
        ORDER BY sent_at LIMIT 10`).bind(vehicle, dev.inst).all<{ id: string; body: string; sent_at: string }>()).results
  }
  const running = await db.prepare(`SELECT EXISTS (SELECT 1 FROM vehicle_trips WHERE institution_id = ? AND ended_at IS NULL) AS r`)
    .bind(dev.inst).first<{ r: number }>()
  const hb = await heartbeatSeconds(db, dev.inst, !!running?.r)
  const out: Record<string, unknown> = { ping_seconds: Number(row.ping_seconds), paused: !!row.paused, notices }
  if (hb > 0) out.heartbeat_seconds = hb
  return json(out)
}

async function acknowledgeNotice(dev: Dev, req: Request, id: string): Promise<Response> {
  const sess = await readStaffSession(dev, req)
  const noticeId = idParam(id)
  const gone = () => new GoErr(404, 'no_such_notice', "that notice is not this bus's")
  const vehicle = await vehicleForTracker(dev)
  if (vehicle === null) throw gone()
  const res = await dev.db.prepare(`UPDATE driver_notices SET acknowledged_at = COALESCE(acknowledged_at, ?), acknowledged_by = COALESCE(acknowledged_by, ?)
      WHERE id = ? AND vehicle_id = ? AND institution_id = ?`).bind(nowISO(), sess?.userId ?? null, noticeId, vehicle, dev.inst).run()
  if (!res.meta.changes) throw gone()
  return json({ acknowledged: true })
}

// ------------------------------------------------------------------ routes, checks, roll, roster, photo

async function routesForBus(dev: Dev, url: URL): Promise<Response> {
  const code = normaliseBusCode(url.searchParams.get('bus') ?? '')
  if (code === '') throw new GoErr(400, 'bad_bus_code', 'bus is required')
  const v = await dev.db.prepare(`SELECT id, registration_no FROM vehicles WHERE institution_id = ?
      AND (${normSQL('bus_code')} = ? OR ${normSQL('registration_no')} = ?) AND status <> 'retired' LIMIT 1`)
    .bind(dev.inst, code, code).first<{ id: string; registration_no: string }>()
  if (!v) throw new GoErr(404, 'bus_not_found', 'no bus in this school carries that code')
  const routes = await dev.db.prepare(`SELECT id, name, COALESCE(code, '') AS code FROM routes WHERE institution_id = ? AND (vehicle_id = ? OR vehicle_id IS NULL)
      ORDER BY vehicle_id IS NULL, name`).bind(dev.inst, v.id).all<{ id: string; name: string; code: string }>()
  return json({ registration_no: v.registration_no, routes: routeRows(routes.results) })
}

async function recordCheck(dev: Dev, req: Request): Promise<Response> {
  const driver = await requireDriver(dev, req)
  const b = await decode(req)
  const brakes = fBool(b, 'brakes_ok'), tyres = fBool(b, 'tyres_ok'), lights = fBool(b, 'lights_ok'), firstAid = fBool(b, 'first_aid_ok')
  const ext = fBool(b, 'extinguisher_ok'), doors = fBool(b, 'doors_ok'), breath = fOptNum(b, 'breathalyser')
  const routeId = fStr(b, 'route_id'), remarks = fStr(b, 'remarks'), direction = fStr(b, 'direction')
  const cleared = brakes && tyres && lights && firstAid && ext && doors && (breath === null || breath === 0)
  let vehicle: string
  try { vehicle = await resolveTripVehicle(dev, fStr(b, 'bus_code')) } catch (e) {
    if (e instanceof TripErr && e.kind === ERR_NO_BUS) throw new GoErr(400, 'no_bus', 'scan the bus before signing off its check')
    if (e instanceof TripErr) throw new GoErr(404, 'bus_not_found', 'no bus in this school carries that code')
    throw e
  }
  if (routeId.trim() !== '') {
    if (!isUUID(routeId)) throw new Error('invalid input syntax for type uuid') // Go's ::uuid cast: a 500
    const ours = await dev.db.prepare(`SELECT 1 FROM routes WHERE id = ? AND institution_id = ?`).bind(routeId, dev.inst).first()
    if (!ours) throw new GoErr(404, 'no_such_route', "that route is not this school's")
  }
  const t = nowISO()
  await dev.db.prepare(`INSERT INTO trip_checks (id, institution_id, vehicle_id, route_id, on_date, leg, driver_employee_id, brakes_ok, tyres_ok, lights_ok,
        first_aid_ok, extinguisher_ok, doors_ok, breathalyser, cleared, remarks, checked_by, checked_at)
      VALUES (?1, ?2, ?3, NULLIF(?4, ''), ?5, ?6, (SELECT id FROM employees WHERE user_id = ?7 AND institution_id = ?2 LIMIT 1),
        ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, NULLIF(?16, ''), ?7, ?17)
      ON CONFLICT (vehicle_id, on_date, leg) DO UPDATE SET brakes_ok = excluded.brakes_ok, tyres_ok = excluded.tyres_ok, lights_ok = excluded.lights_ok,
        first_aid_ok = excluded.first_aid_ok, extinguisher_ok = excluded.extinguisher_ok, doors_ok = excluded.doors_ok,
        breathalyser = excluded.breathalyser, cleared = excluded.cleared, remarks = excluded.remarks, checked_by = excluded.checked_by,
        checked_at = excluded.checked_at`)
    .bind(uuid(), dev.inst, vehicle, routeId, todayIST(), legFor(direction), driver.userId, +brakes, +tyres, +lights, +firstAid, +ext, +doors,
      breath, +cleared, remarks, t).run()
  return json({ cleared })
}

async function getRoll(dev: Dev, id: string): Promise<Response> {
  const tripId = idParam(id)
  const trip = await dev.db.prepare(`SELECT route_id, direction FROM vehicle_trips WHERE id = ? AND institution_id = ?`).bind(tripId, dev.inst)
    .first<{ route_id: string; direction: string }>()
  if (!trip) throw new GoErr(404, 'no_such_trip', "that run is not this bus's")
  const today = todayIST()
  const rows = await dev.db.prepare(`SELECT st.id AS student_id,
        COALESCE(NULLIF(TRIM(st.first_name || ' ' || COALESCE(st.last_name, '')), ''), 'Unnamed') AS name,
        COALESCE(rs.id, '') AS stop_id, COALESCE(rs.name, '') AS stop_name, COALESCE(rs.sequence, 9999) AS sequence,
        COALESCE(att.status, 'not_marked') AS status
      FROM transport_allocations ta
      JOIN students st ON st.id = ta.student_id
      LEFT JOIN route_stops rs ON rs.id = CASE WHEN ?3 = 'drop' THEN ta.drop_stop_id ELSE ta.pickup_stop_id END
      LEFT JOIN transport_attendance att ON att.student_id = st.id AND att.on_date = ?5 AND att.leg = ?4
      WHERE ta.institution_id = ?1 AND ta.route_id = ?2 AND ta.valid_from <= ?5 AND (ta.valid_to IS NULL OR ta.valid_to >= ?5)
      ORDER BY COALESCE(rs.sequence, 9999), st.first_name LIMIT 200`)
    .bind(dev.inst, trip.route_id, trip.direction, legFor(trip.direction), today).all<Record<string, unknown>>()
  const children = rows.results.map((r) => {
    const o: Record<string, unknown> = { student_id: r.student_id, name: r.name }
    if (r.stop_id !== '') o.stop_id = r.stop_id
    if (r.stop_name !== '') o.stop_name = r.stop_name
    o.sequence = Number(r.sequence)
    o.status = r.status
    return o
  })
  return json({ children })
}

async function markChild(dev: Dev, req: Request, id: string): Promise<Response> {
  const driver = await requireDriver(dev, req)
  const tripId = idParam(id)
  const b = await decode(req)
  const student = fStr(b, 'student_id').trim()
  if (!isUUID(student)) throw new GoErr(400, 'bad_student_id', 'student_id must be a uuid')
  const status = fStr(b, 'status')
  if (!['boarded', 'alighted', 'absent'].includes(status)) throw new GoErr(400, 'bad_status', 'status must be boarded, alighted or absent')
  const notOnRun = () => new GoErr(404, 'not_on_this_run', 'that child is not on this route today')
  const db = dev.db
  const trip = await db.prepare(`SELECT route_id, direction FROM vehicle_trips WHERE id = ? AND institution_id = ? AND ended_at IS NULL`)
    .bind(tripId, dev.inst).first<{ route_id: string; direction: string }>()
  if (!trip) throw notOnRun()
  const today = todayIST()
  const alloc = await db.prepare(`SELECT CASE WHEN ?4 = 'drop' THEN drop_stop_id ELSE pickup_stop_id END AS stop_id FROM transport_allocations
      WHERE institution_id = ?1 AND student_id = ?2 AND route_id = ?3 AND valid_from <= ?5 AND (valid_to IS NULL OR valid_to >= ?5) LIMIT 1`)
    .bind(dev.inst, student, trip.route_id, trip.direction, today).first<{ stop_id: string | null }>()
  if (!alloc) throw notOnRun()
  const t = nowISO()
  await db.prepare(`INSERT INTO transport_attendance (id, institution_id, student_id, route_id, stop_id, on_date, leg, status, source, marked_by, boarded_at, alighted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'driver', ?, ?, ?)
      ON CONFLICT (student_id, on_date, leg) DO UPDATE SET status = excluded.status, source = excluded.source, marked_by = excluded.marked_by,
        boarded_at = COALESCE(transport_attendance.boarded_at, excluded.boarded_at),
        alighted_at = COALESCE(excluded.alighted_at, transport_attendance.alighted_at)`)
    .bind(uuid(), dev.inst, student, trip.route_id, alloc.stop_id, today, legFor(trip.direction), status, driver.userId,
      status === 'boarded' ? t : null, status === 'alighted' ? t : null).run()
  return json({ marked: status })
}

async function tripOfThisBus(dev: Dev, trip: string): Promise<{ route_id: string; vehicle_id: string; direction: string }> {
  const r = await dev.db.prepare(`SELECT route_id, vehicle_id, direction FROM vehicle_trips WHERE id = ? AND institution_id = ? AND (tracker_id = ? OR vehicle_id = ?)`)
    .bind(trip, dev.inst, dev.id, dev.vehicle).first<{ route_id: string; vehicle_id: string; direction: string }>()
  if (!r) throw new GoErr(404, 'no_such_trip', "that run is not this bus's")
  return r
}

async function getRoster(dev: Dev, id: string): Promise<Response> {
  const tripId = idParam(id)
  const trip = await tripOfThisBus(dev, tripId)
  const today = todayIST()
  const rows = await dev.db.prepare(`SELECT st.id, ${firstLast('st')} AS name, COALESCE(st.admission_no, '') AS admission_no,
        TRIM(COALESCE(cl.name, '') || ' ' || COALESCE(sec.name, '')) AS class,
        COALESCE(CASE WHEN ?2 = 'drop' THEN ta.drop_stop_id ELSE ta.pickup_stop_id END, '') AS stop_id,
        st.photo_file_id IS NOT NULL AS has_photo,
        EXISTS (SELECT 1 FROM leave_requests lr WHERE lr.student_id = st.id AND lr.subject_kind = 'student'
                 AND lr.status IN ('pending', 'approved') AND ?5 BETWEEN lr.from_date AND lr.to_date) AS on_leave,
        EXISTS (SELECT 1 FROM student_attendance sa WHERE sa.student_id = st.id AND sa.period_id IS NULL AND sa.on_date = ?5
                 AND sa.status IN ('absent', 'leave')) AS absent_in_class,
        COALESCE(att.status, '') AS status, COALESCE(att.alighted_at, att.boarded_at) AS marked
      FROM transport_allocations ta
      JOIN students st ON st.id = ta.student_id AND st.status = 'active'
      LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
      LEFT JOIN sections sec ON sec.id = en.section_id
      LEFT JOIN classes cl ON cl.id = sec.class_id
      LEFT JOIN transport_attendance att ON att.student_id = st.id AND att.on_date = ?5 AND att.leg = ?3
      WHERE ta.route_id = ?1 AND ta.institution_id = ?4 AND (ta.valid_to IS NULL OR ta.valid_to >= ?5)
      ORDER BY st.first_name, st.last_name LIMIT 400`)
    .bind(trip.route_id, trip.direction, legFor(trip.direction), dev.inst, today).all<Record<string, unknown>>()
  const students = rows.results.map((r) => {
    const o: Record<string, unknown> = { id: r.id, name: r.name, admission_no: r.admission_no, class: r.class, stop_id: r.stop_id, has_photo: !!r.has_photo }
    if (r.on_leave) { o.absent = true; o.absent_reason = 'Parent reported absent' }
    else if (r.absent_in_class) { o.absent = true; o.absent_reason = 'Marked absent in class' }
    else o.absent = false
    o.status = r.status
    const at = istFormat(r.marked as string | null, 'hm')
    if (at) o.marked_at = at
    return o
  })
  return json({ trip_id: tripId, direction: trip.direction, leg: legFor(trip.direction), students })
}

async function markBoarding(dev: Dev, req: Request, id: string): Promise<Response> {
  const sess = await readStaffSession(dev, req)
  const tripId = idParam(id)
  const b = await decode(req)
  const raw = b.marks
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) throw malformed()
  const marks = (raw ?? []) as unknown[]
  for (const m of marks) if (m === null || typeof m !== 'object' || Array.isArray(m)) throw malformed()
  if (marks.length === 0 || marks.length > 200) throw new GoErr(400, 'bad_marks', 'send between 1 and 200 marks')
  const trip = await tripOfThisBus(dev, tripId)
  const leg = legFor(trip.direction)
  const today = todayIST()
  const accepted: string[] = []
  const stmts: D1PreparedStatement[] = []
  for (const m of marks as Body[]) {
    const studentRaw = fStr(m, 'student_id'), status = fStr(m, 'status')
    if (!isUUID(studentRaw) || !['boarded', 'alighted', 'absent'].includes(status)) continue
    const now = Date.now()
    let at = parseRFC3339(fStr(m, 'at'))
    if (Number.isNaN(at) || Math.abs(at - now) > 12 * 3600 * 1000) at = now
    const tap = rfc3339UTC(at), atISO = new Date(at).toISOString()
    const alloc = await dev.db.prepare(`SELECT student_id, route_id, CASE WHEN ?4 = 'drop' THEN drop_stop_id ELSE pickup_stop_id END AS stop_id
        FROM transport_allocations WHERE student_id = ?2 AND route_id = ?3 AND institution_id = ?1 AND (valid_to IS NULL OR valid_to >= ?5) LIMIT 1`)
      .bind(dev.inst, studentRaw, trip.route_id, trip.direction, today).first<{ student_id: string; route_id: string; stop_id: string | null }>()
    if (!alloc) continue
    stmts.push(dev.db.prepare(`INSERT INTO transport_attendance (id, institution_id, student_id, route_id, stop_id, on_date, leg, status, source, marked_by,
          boarded_at, alighted_at, remarks) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'manual', ?9, ?10, ?11, ?12)
        ON CONFLICT (student_id, on_date, leg) DO UPDATE SET status = excluded.status, source = excluded.source,
          marked_by = COALESCE(excluded.marked_by, transport_attendance.marked_by),
          boarded_at = COALESCE(transport_attendance.boarded_at, excluded.boarded_at),
          alighted_at = COALESCE(excluded.alighted_at, transport_attendance.alighted_at),
          remarks = excluded.remarks
        WHERE julianday(?13) >= CASE WHEN transport_attendance.remarks GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'
          THEN julianday(transport_attendance.remarks) ELSE julianday('1970-01-01') END`)
      .bind(uuid(), dev.inst, alloc.student_id, alloc.route_id, alloc.stop_id, istDateOf(atISO), leg, status, sess?.userId ?? null,
        status === 'boarded' ? atISO : null, status === 'alighted' ? atISO : null, tap, atISO))
    accepted.push(studentRaw)
  }
  if (stmts.length) await dev.db.batch(stmts)
  return json({ accepted })
}

async function studentPhoto(dev: Dev, req: Request, id: string): Promise<Response> {
  const studentId = idParam(id)
  const vehicle = await vehicleForTracker(dev)
  if (vehicle === null) throw notFoundGo()
  const today = todayIST()
  const f = await dev.db.prepare(`SELECT f.object_key, f.content_type FROM students st
      JOIN files f ON f.id = st.photo_file_id AND f.deleted_at IS NULL
      WHERE st.id = ?1 AND st.institution_id = ?2
        AND EXISTS (SELECT 1 FROM transport_allocations ta WHERE ta.student_id = st.id AND (ta.valid_to IS NULL OR ta.valid_to >= ?4)
          AND (ta.route_id IN (SELECT id FROM routes WHERE vehicle_id = ?3)
            OR ta.route_id IN (SELECT route_id FROM vehicle_trips WHERE vehicle_id = ?3 AND ended_at IS NULL)))`)
    .bind(studentId, dev.inst, vehicle, today).first<{ object_key: string; content_type: string }>()
  if (!f || !String(f.content_type).startsWith('image/')) throw notFoundGo()
  // Bucket (write, then live) the same way downloadFile reads; a miss is a 404 and never an explanation.
  const obj = await getObject(dev.env, f.object_key, req.headers.has('range') ? req.headers : undefined)
  if (!obj) throw notFoundGo()
  return serveObject(req, obj, { 'content-type': f.content_type, 'x-content-type-options': 'nosniff',
    'content-disposition': 'inline', 'cache-control': 'private, max-age=86400' })
}

// ------------------------------------------------------------------ dispatch

type DevRoute = (dev: Dev, req: Request, url: URL, id: string) => Promise<Response>
const DEVICE_ROUTES: [string, RegExp, DevRoute][] = [
  ['POST', /^\/bus-tracker\/session$/, (d, r) => busTrackerSignIn(d, r)],
  ['POST', /^\/bus-tracker\/session\/end$/, (d) => busTrackerSignOut(d)],
  ['POST', /^\/bus-tracker\/trips$/, (d, r) => startTrip(d, r)],
  ['POST', /^\/bus-tracker\/trips\/([^/]+)\/end$/, (d, r, _u, id) => endTrip(d, r, id)],
  ['GET', /^\/bus-tracker\/trips\/([^/]+)\/roll$/, (d, _r, _u, id) => getRoll(d, id)],
  ['POST', /^\/bus-tracker\/checks$/, (d, r) => recordCheck(d, r)],
  ['POST', /^\/bus-tracker\/trips\/([^/]+)\/roll$/, (d, r, _u, id) => markChild(d, r, id)],
  ['GET', /^\/bus-tracker\/routes$/, (d, _r, u) => routesForBus(d, u)],
  ['POST', /^\/bus-tracker\/positions$/, (d, r) => ingestPositions(d, r)],
  ['POST', /^\/bus-tracker\/heartbeat$/, (d, r) => heartbeat(d, r)],
  ['GET', /^\/bus-tracker\/trips\/([^/]+)\/roster$/, (d, _r, _u, id) => getRoster(d, id)],
  ['POST', /^\/bus-tracker\/trips\/([^/]+)\/boarding$/, (d, r, _u, id) => markBoarding(d, r, id)],
  ['GET', /^\/bus-tracker\/students\/([^/]+)\/photo$/, (d, r, _u, id) => studentPhoto(d, r, id)],
  ['POST', /^\/bus-tracker\/notices\/([^/]+)\/ack$/, (d, r, _u, id) => acknowledgeNotice(d, r, id)],
]
const PUBLIC_ROUTES: Record<string, (env: Env, req: Request) => Promise<Response>> = {
  '/public/bus-tracker/claim': claimPairCode,
  '/public/bus-tracker/driver-signin': signInBusDriver,
  '/public/bus-tracker/enrol': enrolBusTracker,
}

/**
 * The handset's routes and the three public pairing routes, outside the
 * session router. Returns null for any other request. Wired in index.ts
 * right after handleSMSGatewayDevice.
 */
export async function handleBusTrackerDevice(env: Env, req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith(P + '/bus-tracker/') && !url.pathname.startsWith(P + '/public/bus-tracker/')) return null
  const p = url.pathname.slice(P.length).replace(/\/$/, '')
  const m = req.method
  try {
    const pub = PUBLIC_ROUTES[p]
    if (pub) return m === 'POST' ? await pub(env, req) : null
    for (const [method, re, h] of DEVICE_ROUTES) {
      if (method !== m) continue
      const hit = re.exec(p)
      if (!hit) continue
      const dev = await authenticate(env, req)
      return await h(dev, req, url, hit[1] ? decodeURIComponent(hit[1]) : '')
    }
    return null
  } catch (err) {
    if (err instanceof GoErr) {
      return err.body ? json({ error: { code: err.code, message: err.message }, ...err.body }, err.status) : goError(err.status, err.code, err.message)
    }
    console.error(err)
    return goError(500, 'internal', 'something went wrong')
  }
}

