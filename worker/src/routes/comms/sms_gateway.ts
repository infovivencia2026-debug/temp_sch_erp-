import type { Router, Ctx } from '../../router'
import type { Env } from '../../env'
import { json } from '../../env'
import { badRequest, isUUID, notFound, now, ok, readJSON, uuid, bool } from '../../http'
import { institutionById, tenantDb, type Institution } from '../../tenant'
import { institutionId, nowInIndia } from '../teaching/common'
import { isoZ, omitNull, optBool, optInt, toBytes, truncate } from './common'

/* Port of sms_gateway.go (and approveSMSGatewayDevice from device_login.go):
   the admin screen of the phone SMS gateway, and the three routes the
   Android handset calls with its device token.

   The handset routes (GET /sms-gateway/outbox, POST /sms-gateway/receipts,
   POST /sms-gateway/heartbeat) carry no session, so they cannot go through
   the Router, whose entry point requires one. They are served by
   handleSMSGatewayDevice, which index.ts has to call before router.match.
   Request and response bodies, status codes and the Go error envelope
   {"error":{"code","message"}} are kept exactly, because the app parses them. */

const READ = 'institution.read'
const CREDS = 'institution.integrations.write'

export const PROVIDER = 'sms:phone'
const HEARTBEAT_WINDOW_S = 15 * 60
const LEASE_S = 5 * 60
const MAX_ATTEMPTS = 3
const COLLECT_WINDOW_S = 12 * 3600
const PAIR_TTL_MIN = 10
const CODE_LENGTH = 6
const DAY_START = 6, DAY_END = 21, NIGHT_POLL = 900, IDLE_POLL = 60, MAX_BATCH = 20
const TOKEN_PREFIX = 'sgw1'

const ADVISORY = 'This is not a licensed bulk-SMS service. Indian commercial SMS requires a DLT-registered sender id and pre-approved templates; a personal SIM sending in bulk will be throttled by the carrier and may be disconnected. Use this for tens of messages a day to a few hundred parents. For a fee campaign to the whole school, buy a licensed gateway.'

const plusSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString()

// ---------------------------------------------------------------- liveness

/** humanSilence: "a minute", "40 minutes", "an hour", "3 hours", "2 days". */
export function humanSilence(seconds: number): string {
  if (seconds < 120) return 'a minute'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes`
  if (seconds < 7200) return 'an hour'
  if (seconds < 48 * 3600) return `${Math.floor(seconds / 3600)} hours`
  return `${Math.floor(Math.floor(seconds / 3600) / 24)} days`
}

/** smsGatewayReason: '' when a phone can send now, otherwise the sentence why not. */
export async function smsGatewayReason(db: D1Database, inst: string): Promise<string> {
  const r = await db.prepare(`SELECT count(*) AS paired, count(*) FILTER (WHERE paused = 0) AS active,
        max(last_seen_at) FILTER (WHERE paused = 0) AS last_seen,
        (julianday('now') - julianday(max(last_seen_at) FILTER (WHERE paused = 0))) * 86400 AS silent
      FROM sms_gateway_devices WHERE institution_id = ? AND revoked_at IS NULL`).bind(inst)
    .first<{ paired: number; active: number; last_seen: string | null; silent: number | null }>()
  if (!r || !r.paired) return 'no phone is paired. Pair the office handset to start sending SMS'
  if (!r.active) return 'every paired phone is paused. Switch one back on to start sending'
  if (r.last_seen === null || r.silent === null) return 'the paired phone has never reported in. Open the gateway app on the handset'
  if (r.silent > HEARTBEAT_WINDOW_S) return 'the office phone has not reported in for ' + humanSilence(r.silent)
  return ''
}

/** isPhoneGatewayConfig: the sms channel's stored config says kind "phone". */
export function isPhoneGatewayConfig(cfg: unknown): boolean {
  if (typeof cfg !== 'string' || cfg.trim() === '') return false
  try {
    const v = JSON.parse(cfg) as { kind?: unknown }
    return typeof v?.kind === 'string' && v.kind.trim().toLowerCase() === 'phone'
  } catch { return false }
}

/** sweepSMSGatewayLeases, as statements for one batch. */
function sweepStmts(db: D1Database, inst: string): D1PreparedStatement[] {
  const t = now()
  const lapsed = `state = 'dispatching' AND julianday(lease_expires_at) < julianday('now')`
  return [
    db.prepare(`UPDATE sms_gateway_dispatch
        SET state = 'queued', device_id = NULL, lease_expires_at = NULL, claimed_at = NULL, updated_at = ?,
            error = 'the phone claimed this and did not confirm it; returned to the queue'
        WHERE institution_id = ? AND ${lapsed} AND attempt < ?`).bind(t, inst, MAX_ATTEMPTS),
    db.prepare(`UPDATE message_log
        SET status = 'failed',
            error = 'the office phone claimed this message and never confirmed it. It was not sent again, because it may already have gone out, check with the recipient before re-sending.'
        WHERE institution_id = ? AND status <> 'failed'
          AND id IN (SELECT message_id FROM sms_gateway_dispatch WHERE institution_id = ? AND ${lapsed} AND attempt >= ?)`)
      .bind(inst, inst, MAX_ATTEMPTS),
    db.prepare(`UPDATE sms_gateway_dispatch
        SET state = 'expired', completed_at = ?, updated_at = ?,
            error = 'claimed by a phone that never confirmed it, and not re-sent, it may already have gone out'
        WHERE institution_id = ? AND ${lapsed} AND attempt >= ?`).bind(t, t, inst, MAX_ATTEMPTS),
    db.prepare(`UPDATE message_log
        SET status = 'failed', error = 'no paired phone collected this message in time, so it was not sent'
        WHERE institution_id = ? AND provider = ? AND status = 'sent'
          AND julianday(sent_at) < julianday('now') - ? / 86400.0
          AND NOT EXISTS (SELECT 1 FROM sms_gateway_dispatch d WHERE d.message_id = message_log.id AND d.state <> 'queued')`)
      .bind(inst, PROVIDER, COLLECT_WINDOW_S),
  ]
}

/** smsGatewayPollFor: the admin's daytime rate, floored when idle and at night (Indian hours). */
function pollFor(configured: number, foundWork: boolean): number {
  let floor = NIGHT_POLL
  const h = nowInIndia().getUTCHours()
  if (h >= DAY_START && h < DAY_END) {
    if (foundWork) return configured
    floor = IDLE_POLL
  }
  return configured > floor ? configured : floor
}

/** Start of today in India, as a UTC instant. */
function istMidnightUTC(): string {
  const d = nowInIndia()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - (5 * 60 + 30) * 60 * 1000).toISOString()
}

// ---------------------------------------------------------------- admin screen

async function getSMSGatewayOverview(c: Ctx): Promise<Response> {
  const inst = institutionId(c)
  const since = istMidnightUTC()
  const integ = await c.db.prepare(`SELECT config, enabled FROM integrations WHERE institution_id = ? AND kind = 'messaging' AND provider = 'sms'`)
    .bind(inst).first<{ config: string; enabled: number }>()
  const reason = await smsGatewayReason(c.db, inst)
  const today = `julianday(g.completed_at) >= julianday(?)`
  const [devs, counts, todays, fails] = await c.db.batch([
    c.db.prepare(`SELECT d.id, d.name, d.android_version, d.sim_operator, d.app_version,
          ${isoZ('d.paired_at')} AS paired_at, ${isoZ('d.last_seen_at')} AS last_seen_at,
          (julianday('now') - julianday(d.last_seen_at)) * 86400 AS silent,
          d.battery_pct, d.charging, d.signal_dbm, d.sim_ready, d.paused, d.approved_at IS NULL AS pending,
          e.full_name AS enrolled_by, d.poll_seconds, d.per_minute_cap,
          (SELECT count(*) FROM sms_gateway_dispatch g WHERE g.institution_id = d.institution_id AND g.device_id = d.id AND g.state = 'sent' AND ${today}) AS sent_today,
          (SELECT count(*) FROM sms_gateway_dispatch g WHERE g.institution_id = d.institution_id AND g.device_id = d.id AND g.state IN ('failed','expired') AND ${today}) AS failed_today,
          (SELECT COALESCE(sum(g.parts), 0) FROM sms_gateway_dispatch g WHERE g.institution_id = d.institution_id AND g.device_id = d.id AND g.state = 'sent' AND ${today}) AS parts_today
        FROM sms_gateway_devices d
        LEFT JOIN users e ON e.id = d.enrolled_by
        WHERE d.institution_id = ? AND d.revoked_at IS NULL
        ORDER BY d.paired_at`).bind(since, since, since, inst),
    c.db.prepare(`SELECT count(*) FILTER (WHERE m.status = 'sent' AND (g.id IS NULL OR g.state = 'queued')) AS waiting,
          count(*) FILTER (WHERE g.state = 'dispatching') AS in_flight
        FROM message_log m LEFT JOIN sms_gateway_dispatch g ON g.message_id = m.id
        WHERE m.institution_id = ? AND m.provider = ?`).bind(inst, PROVIDER),
    c.db.prepare(`SELECT count(*) FILTER (WHERE g.state = 'sent') AS sent, count(*) FILTER (WHERE g.state IN ('failed','expired')) AS failed,
          COALESCE(sum(g.parts) FILTER (WHERE g.state = 'sent'), 0) AS parts
        FROM sms_gateway_dispatch g WHERE g.institution_id = ? AND ${today}`).bind(inst, since),
    c.db.prepare(`SELECT g.message_id, d.name AS device, ${isoZ('g.completed_at')} AS at, COALESCE(g.error, 'no reason reported') AS reason, g.state
        FROM sms_gateway_dispatch g LEFT JOIN sms_gateway_devices d ON d.id = g.device_id
        WHERE g.institution_id = ? AND g.state IN ('failed','expired') AND g.completed_at IS NOT NULL
        ORDER BY g.completed_at DESC LIMIT 50`).bind(inst),
  ])
  const devices = (devs.results as Record<string, unknown>[]).map((v) => {
    const silent = v.silent === null || v.silent === undefined ? null : Number(v.silent)
    let health: string, silentFor = ''
    if (bool(v.pending)) health = 'pending'
    else if (bool(v.paused)) health = 'paused'
    else if (silent === null) health = 'never'
    else if (Math.trunc(silent) > HEARTBEAT_WINDOW_S) { health = 'stale'; silentFor = humanSilence(Math.trunc(silent)) }
    else { health = 'live'; silentFor = humanSilence(Math.trunc(silent)) }
    const nb = (x: unknown) => (x === null || x === undefined ? null : bool(x))
    const out = omitNull({ id: v.id, name: v.name, android_version: v.android_version, sim_operator: v.sim_operator, app_version: v.app_version,
      paired_at: v.paired_at, last_seen_at: v.last_seen_at, silent_for: silentFor === '' ? null : silentFor, health,
      battery_pct: v.battery_pct, charging: nb(v.charging), signal_dbm: v.signal_dbm, sim_ready: nb(v.sim_ready),
      paused: bool(v.paused), pending: bool(v.pending), enrolled_by: v.enrolled_by,
      poll_seconds: Number(v.poll_seconds), per_minute_cap: Number(v.per_minute_cap),
      sent_today: Number(v.sent_today ?? 0), failed_today: Number(v.failed_today ?? 0), parts_today: Number(v.parts_today ?? 0) })
    return out
  })
  const cnt = (counts.results[0] ?? {}) as Record<string, unknown>
  const tdy = (todays.results[0] ?? {}) as Record<string, unknown>
  return ok(omitNull({
    selected: !!integ && bool(integ.enabled) && isPhoneGatewayConfig(integ.config),
    configured: reason === '', reason: reason === '' ? null : reason,
    devices,
    failures: (fails.results as Record<string, unknown>[]).map((f) => omitNull({ message_id: f.message_id, device: f.device, at: f.at, reason: f.reason, state: f.state })),
    waiting: Number(cnt.waiting ?? 0), in_flight: Number(cnt.in_flight ?? 0),
    sent_today: Number(tdy.sent ?? 0), failed_today: Number(tdy.failed ?? 0), parts_today: Number(tdy.parts ?? 0),
    advisory: ADVISORY,
  }))
}

async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
}

async function pairSMSGatewayDevice(c: Ctx): Promise<Response> {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH))
  const code = Array.from(bytes, (b) => '0123456789'[b % 10]).join('')
  const expires = new Date(Date.now() + PAIR_TTL_MIN * 60 * 1000)
  const inst = institutionId(c), t = now()
  await c.db.batch([
    c.db.prepare(`UPDATE sms_gateway_pair_codes SET expires_at = ? WHERE institution_id = ? AND claimed_at IS NULL AND julianday(expires_at) > julianday('now')`)
      .bind(t, inst),
    c.db.prepare(`INSERT INTO sms_gateway_pair_codes (id, institution_id, code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(uuid(), inst, await sha256(code.trim().toUpperCase()), c.id.userId, t, expires.toISOString()),
  ])
  // time.Format(time.RFC3339): whole seconds.
  return ok({ pair_code: code, expires_at: expires.toISOString().replace(/\.\d{3}Z$/, 'Z'), valid_minutes: PAIR_TTL_MIN })
}

function deviceParam(c: Ctx): string {
  if (!isUUID(c.params.id)) throw badRequest('that is not a device id')
  return c.params.id
}
const clamp = (v: number | null, lo: number, hi: number) => (v === null ? null : Math.min(hi, Math.max(lo, v)))

async function updateSMSGatewayDevice(c: Ctx): Promise<Response> {
  const id = deviceParam(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  let name: string | null = null
  if (typeof req.name === 'string') {
    name = truncate(req.name, 80)
    if (name === '') throw badRequest('a phone needs a name somebody can recognise')
  }
  const paused = optBool(req.paused)
  const res = await c.db.prepare(`UPDATE sms_gateway_devices
      SET name = COALESCE(?, name), paused = COALESCE(?, paused), poll_seconds = COALESCE(?, poll_seconds),
          per_minute_cap = COALESCE(?, per_minute_cap), updated_at = ?
      WHERE institution_id = ? AND id = ? AND revoked_at IS NULL`)
    .bind(name, paused === null ? null : paused ? 1 : 0, clamp(optInt(req.poll_seconds), 5, 300), clamp(optInt(req.per_minute_cap), 1, 60),
      now(), institutionId(c), id).run()
  if (!res.meta.changes) throw notFound()
  return ok({ ok: true })
}

async function revokeSMSGatewayDevice(c: Ctx): Promise<Response> {
  const id = deviceParam(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const reason = typeof req.reason === 'string' && req.reason.trim() !== '' ? truncate(req.reason, 80) : null
  const inst = institutionId(c), t = now()
  const [upd] = await c.db.batch([
    c.db.prepare(`UPDATE sms_gateway_devices SET revoked_at = ?, revoked_reason = ?, paused = 1, updated_at = ?
        WHERE institution_id = ? AND id = ? AND revoked_at IS NULL`).bind(t, reason, t, inst, id),
    // Only when the revoke above landed: its revoked_at is this statement's t.
    c.db.prepare(`UPDATE sms_gateway_dispatch
        SET state = 'queued', device_id = NULL, lease_expires_at = NULL, claimed_at = NULL, updated_at = ?,
            error = 'the phone holding this was revoked; returned to the queue'
        WHERE institution_id = ? AND device_id = ? AND state = 'dispatching'
          AND EXISTS (SELECT 1 FROM sms_gateway_devices WHERE id = ? AND revoked_at = ?)`).bind(t, inst, id, id, t),
  ])
  if (!upd.meta.changes) throw notFound()
  return ok({ ok: true })
}

async function approveSMSGatewayDevice(c: Ctx): Promise<Response> {
  const id = deviceParam(c)
  const res = await c.db.prepare(`UPDATE sms_gateway_devices
      SET approved_at = COALESCE(approved_at, ?), approved_by = COALESCE(approved_by, ?), updated_at = ?
      WHERE institution_id = ? AND id = ? AND revoked_at IS NULL`).bind(now(), c.id.userId, now(), institutionId(c), id).run()
  if (!res.meta.changes) throw notFound()
  return ok({ approved: true })
}

export function registerSMSGateway(r: Router): void {
  r.get('/sms-gateway', READ, getSMSGatewayOverview)
  r.post('/sms-gateway/pair', CREDS, pairSMSGatewayDevice)
  r.put('/sms-gateway/devices/{id}', CREDS, updateSMSGatewayDevice)
  r.post('/sms-gateway/devices/{id}/revoke', CREDS, revokeSMSGatewayDevice)
  r.post('/sms-gateway/devices/{id}/approve', CREDS, approveSMSGatewayDevice)
}

// ---------------------------------------------------------------- the handset

interface Device { id: string; inst: string; db: D1Database; pollSeconds: number; perMinuteCap: number; paused: boolean }

/** httpx.Error: the Go envelope the app parses. */
const goError = (status: number, code: string, message: string) => json({ error: { code, message } }, status)
const unauthenticated = () => goError(401, 'device_unauthenticated', 'this device is not paired with any school. Pair it again from the SMS gateway screen')
const internal = () => goError(500, 'internal', 'something went wrong')

/** openSecret: AES-256-GCM under SHA-256(CREDENTIAL_KEY), nonce || ciphertext || tag. */
async function openSecret(env: Env, sealed: Uint8Array): Promise<string | null> {
  if (sealed.length === 0) return ''
  const key = env.CREDENTIAL_KEY
  if (typeof key !== 'string' || key.trim() === '') return null
  if (sealed.length < 12) return null
  try {
    const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
    const k = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt'])
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12) }, k, sealed.slice(12))
    return new TextDecoder().decode(plain)
  } catch { return null }
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b)
  if (x.length !== y.length) return false
  let d = 0
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]
  return d === 0
}

/* The device row lives in its school's own database and the token names only
   the device, so every school's database is asked for it. Go's AsPlatform
   lookup was one indexed read; this is one per school, run in parallel. */
async function findDevice(env: Env, id: string): Promise<{ inst: Institution; db: D1Database; row: Record<string, unknown> } | null> {
  const insts = await env.CONTROL.prepare(`SELECT id FROM institutions`).all<{ id: string }>()
  const hits = await Promise.all(insts.results.map(async ({ id: instId }) => {
    const inst = await institutionById(env, instId)
    if (!inst) return null
    let db: D1Database
    try { db = tenantDb(env, inst) } catch { return null }
    const row = await db.prepare(`SELECT id, institution_id, name, token_sealed, revoked_at, approved_at, poll_seconds, per_minute_cap, paused
        FROM sms_gateway_devices WHERE id = ?`).bind(id).first<Record<string, unknown>>()
    return row ? { inst, db, row } : null
  }))
  return hits.find((h) => h !== null) ?? null
}

/** requireSMSGatewayDevice: a Response when the token is refused, the device otherwise. */
async function authenticate(env: Env, req: Request): Promise<Device | Response> {
  const h = req.headers.get('authorization') ?? ''
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : ''
  const parts = token.trim().split('.')
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !isUUID(parts[1]) || parts[2] === '') return unauthenticated()
  const found = await findDevice(env, parts[1])
  if (!found) return unauthenticated()
  const row = found.row
  if (row.revoked_at !== null && row.revoked_at !== undefined) return unauthenticated()
  const want = await openSecret(env, toBytes(row.token_sealed))
  if (want === null || !constantTimeEqual(want, parts[2])) return unauthenticated()
  if (row.approved_at === null || row.approved_at === undefined) {
    return goError(403, 'awaiting_approval', 'this phone is enrolled but not yet approved, ask an administrator to approve it on the SMS gateway screen')
  }
  return { id: String(row.id), inst: String(row.institution_id), db: found.db, pollSeconds: Number(row.poll_seconds),
    perMinuteCap: Number(row.per_minute_cap), paused: bool(row.paused) }
}

async function decode<T>(req: Request): Promise<T | Response> {
  try { return (await req.json()) as T } catch { return goError(400, 'bad_request', 'malformed JSON body') }
}

async function outbox(dev: Device, url: URL): Promise<Response> {
  let max = MAX_BATCH
  const raw = (url.searchParams.get('max') ?? '').trim()
  if (raw !== '' && /^[+-]?\d+$/.test(raw)) { const n = Number(raw); if (n > 0 && n < max) max = n }
  const out = { messages: [] as { id: string; to: string; body: string; attempt: number }[], poll_seconds: 0, per_minute_cap: dev.perMinuteCap, paused: dev.paused }
  if (dev.paused) {
    out.poll_seconds = pollFor(dev.pollSeconds, false)
    return json(out)
  }
  const db = dev.db
  await db.batch(sweepStmts(db, dev.inst))
  const cands = await db.prepare(`SELECT m.id AS message_id, d.id AS dispatch_id, COALESCE(d.attempt, 0) AS attempt
      FROM message_log m LEFT JOIN sms_gateway_dispatch d ON d.message_id = m.id
      WHERE m.institution_id = ? AND m.channel = 'sms' AND m.provider = ? AND m.status = 'sent'
        AND julianday(m.sent_at) > julianday('now') - ? / 86400.0
        AND (d.id IS NULL OR d.state = 'queued'
             OR (d.state = 'dispatching' AND julianday(d.lease_expires_at) < julianday('now') AND d.attempt < ?))
      ORDER BY m.queued_at LIMIT ?`).bind(dev.inst, PROVIDER, COLLECT_WINDOW_S, MAX_ATTEMPTS, max)
    .all<{ message_id: string; dispatch_id: string | null; attempt: number }>()
  if (cands.results.length) {
    const t = now(), lease = plusSeconds(LEASE_S)
    // Each claim re-checks its own predicate, so two phones polling together
    // cannot both win one message (the SKIP LOCKED of the Go claim).
    const stmts = cands.results.map((m) => m.dispatch_id === null
      ? db.prepare(`INSERT INTO sms_gateway_dispatch (id, institution_id, message_id, device_id, state, attempt, claimed_at, lease_expires_at, created_at, updated_at)
          SELECT ?, ?, ?, ?, 'dispatching', 1, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM sms_gateway_dispatch WHERE message_id = ?)`)
        .bind(uuid(), dev.inst, m.message_id, dev.id, t, lease, t, t, m.message_id)
      : db.prepare(`UPDATE sms_gateway_dispatch
          SET device_id = ?, state = 'dispatching', attempt = attempt + 1, claimed_at = ?, lease_expires_at = ?, error = NULL, updated_at = ?
          WHERE id = ? AND (state = 'queued' OR (state = 'dispatching' AND julianday(lease_expires_at) < julianday('now') AND attempt < ?))`)
        .bind(dev.id, t, lease, t, m.dispatch_id, MAX_ATTEMPTS))
    const res = await db.batch(stmts)
    const won = cands.results.filter((_, i) => (res[i].meta.changes ?? 0) > 0)
    if (won.length) {
      const bodies = await db.prepare(`SELECT id, recipient, COALESCE(body, '') AS body FROM message_log
          WHERE institution_id = ? AND id IN (SELECT value FROM json_each(?))`)
        .bind(dev.inst, JSON.stringify(won.map((w) => w.message_id))).all<{ id: string; recipient: string; body: string }>()
      const byId = new Map(bodies.results.map((b) => [b.id, b]))
      for (const w of won) {
        const b = byId.get(w.message_id)
        if (b) out.messages.push({ id: b.id, to: b.recipient, body: b.body, attempt: Number(w.attempt) + 1 })
      }
    }
  }
  out.poll_seconds = pollFor(dev.pollSeconds, out.messages.length > 0)
  return json(out)
}

async function receipts(dev: Device, req: Request): Promise<Response> {
  const body = await decode<{ receipts?: { id?: unknown; status?: unknown; sent_at?: unknown; error?: unknown; parts?: unknown }[] }>(req)
  if (body instanceof Response) return body
  const list = Array.isArray(body?.receipts) ? body.receipts : []
  if (!list.length) return json({ accepted: 0 })
  if (list.length > 200) return goError(400, 'bad_request', 'too many receipts in one call. Send at most 200')
  const db = dev.db
  const ids = list.map((r) => (typeof r?.id === 'string' ? r.id.trim() : '')).filter(isUUID)
  if (ids.length) {
    const distinct = [...new Set(ids.map((i) => i.toLowerCase()))]
    const known = await db.prepare(`SELECT count(DISTINCT message_id) AS n FROM sms_gateway_dispatch
        WHERE institution_id = ? AND lower(message_id) IN (SELECT value FROM json_each(?))`).bind(dev.inst, JSON.stringify(distinct)).first<{ n: number }>()
    if (Number(known?.n ?? 0) !== distinct.length) return goError(404, 'not_found', 'resource not found')
  }
  let accepted = 0
  const stmts: D1PreparedStatement[] = []
  for (const rec of list) {
    const id = typeof rec?.id === 'string' ? rec.id.trim() : ''
    if (!isUUID(id)) continue
    const status = typeof rec.status === 'string' ? rec.status.trim().toLowerCase() : ''
    if (status !== 'sent' && status !== 'failed') continue
    accepted++
    let reason: string | null = null
    if (typeof rec.error === 'string') { const t = truncate(rec.error, 200); if (t !== '') reason = t }
    const parts = optInt(rec.parts)
    const t = new Date(Date.now() + stmts.length).toISOString()
    // The follow-ups apply only when this receipt is the one that settled the
    // row: its completed_at is this receipt's own timestamp.
    const settled = `EXISTS (SELECT 1 FROM sms_gateway_dispatch WHERE message_id = ? AND device_id = ? AND state = ? AND completed_at = ?)`
    stmts.push(db.prepare(`UPDATE sms_gateway_dispatch SET state = ?, completed_at = ?, parts = COALESCE(?, parts), error = ?, updated_at = ?
        WHERE institution_id = ? AND message_id = ? AND device_id = ? AND state = 'dispatching'`)
      .bind(status, t, parts, reason, t, dev.inst, id, dev.id))
    if (status === 'failed') {
      let msg = 'the office phone could not send this'
      if (reason !== null) msg += ': ' + reason
      stmts.push(db.prepare(`UPDATE message_log SET status = 'failed', error = ? WHERE institution_id = ? AND id = ? AND ${settled}`)
        .bind(truncate(msg, 500), dev.inst, id, id, dev.id, status, t))
    } else {
      let sentAt: string | null = null
      if (typeof rec.sent_at === 'string') {
        const d = new Date(rec.sent_at)
        if (Number.isNaN(d.getTime())) return internal()
        sentAt = d.toISOString()
      }
      stmts.push(db.prepare(`UPDATE message_log SET error = NULL, sent_at = COALESCE(?, sent_at)
          WHERE institution_id = ? AND id = ? AND status = 'sent' AND ${settled}`)
        .bind(sentAt, dev.inst, id, id, dev.id, status, t))
    }
  }
  if (stmts.length) await db.batch(stmts)
  return json({ accepted })
}

async function heartbeat(dev: Device, req: Request): Promise<Response> {
  const body = await decode<Record<string, unknown>>(req)
  if (body instanceof Response) return body
  const b = body ?? {}
  const out = { poll_seconds: pollFor(dev.pollSeconds, false), per_minute_cap: dev.perMinuteCap, paused: dev.paused }
  const app = typeof b.app_version === 'string' && b.app_version.trim() !== '' ? truncate(b.app_version, 80) : null
  const nb = (v: unknown) => { const x = optBool(v); return x === null ? null : x ? 1 : 0 }
  await dev.db.batch([
    dev.db.prepare(`UPDATE sms_gateway_devices
        SET last_seen_at = ?, battery_pct = COALESCE(?, battery_pct), charging = COALESCE(?, charging),
            signal_dbm = COALESCE(?, signal_dbm), sim_ready = COALESCE(?, sim_ready), app_version = COALESCE(?, app_version),
            sent_today = COALESCE(?, sent_today), updated_at = ?
        WHERE institution_id = ? AND id = ?`)
      .bind(now(), clamp(optInt(b.battery_pct), 0, 100), nb(b.charging), clamp(optInt(b.signal_dbm), -140, 0), nb(b.sim_ready), app,
        clamp(optInt(b.sent_today), 0, 100000), now(), dev.inst, dev.id),
    ...sweepStmts(dev.db, dev.inst),
  ])
  return json(out)
}

/**
 * The handset's three routes, outside the session router. Returns null for
 * any other request so the caller falls through to the normal path. Wire it
 * in index.ts before router.match:
 *   const dev = await handleSMSGatewayDevice(env, req, url); if (dev) return dev
 */
export async function handleSMSGatewayDevice(env: Env, req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname.replace(/\/$/, '')
  const m = req.method
  const route = p === '/api/v1/sms-gateway/outbox' && m === 'GET' ? 'outbox'
    : p === '/api/v1/sms-gateway/receipts' && m === 'POST' ? 'receipts'
      : p === '/api/v1/sms-gateway/heartbeat' && m === 'POST' ? 'heartbeat' : null
  if (!route) return null
  try {
    const dev = await authenticate(env, req)
    if (dev instanceof Response) return dev
    if (route === 'outbox') return await outbox(dev, url)
    if (route === 'receipts') return await receipts(dev, req)
    return await heartbeat(dev, req)
  } catch (err) {
    console.error(err)
    return internal()
  }
}
