import type { Env } from '../env'
import { institutionById, tenantDb } from '../tenant'
import { featureOverrides } from '../routes/seller/features'

/* SESSION ACTIVITY RECORDING: a per-school switch, OFF by default.

   The school's own switch is module_settings module 'session_activity'
   (enabled, config.retention_days), the same place the AI settings keep
   theirs. The seller can forbid it for a school with the feature switch
   'staff.session_activity' (school_feature_overrides, enabled = 0); an
   override that is on, or none, leaves the choice to the school.

   While it is off nothing below writes anything. What was recorded before it
   was switched off stays until the retention sweep removes it. */

export const MODULE = 'session_activity'
export const SELLER_FEATURE = 'staff.session_activity'
export const DEFAULT_RETENTION_DAYS = 90

export interface ActivitySettings { enabled: boolean; retention_days: number; seller_blocked: boolean; recording: boolean }

export async function schoolActivitySettings(db: D1Database): Promise<{ enabled: boolean; retention_days: number }> {
  const row = await db.prepare(`SELECT enabled, config FROM module_settings WHERE module = ?`).bind(MODULE)
    .first<{ enabled: number; config: string | null }>().catch(() => null)
  let days = DEFAULT_RETENTION_DAYS
  try {
    const d = Number(JSON.parse(row?.config || '{}').retention_days)
    if (Number.isFinite(d) && d >= 7 && d <= 730) days = Math.floor(d)
  } catch { /* default */ }
  return { enabled: !!row?.enabled, retention_days: days }
}

export async function activitySettings(env: Env, institutionId: string, db: D1Database): Promise<ActivitySettings> {
  const [s, ov] = await Promise.all([schoolActivitySettings(db), featureOverrides(env, institutionId)])
  const blocked = ov.get(SELLER_FEATURE)?.enabled === false
  return { ...s, seller_blocked: blocked, recording: s.enabled && !blocked }
}

/* --- what a request tells us about the visitor ------------------------------ */

/** Cloudflare's own egress for Worker subrequests: the Pages proxy's hop. */
const viaCloudflareProxy = (ip: string | null) => !!ip && /^2a06:98c[0-7]:/i.test(ip)

/* Behind the Pages proxy (web/functions/[[path]].ts) CF-Connecting-IP and
   request.cf describe the proxy, not the person, so the proxy forwards the
   visitor's address and place as X-Visitor-*. Those are believed only when
   the request really came from a Cloudflare Worker hop; called directly, the
   request's own values are used. Place is approximate (city level at best). */
export function visitorFacts(req: Request): { ip: string | null; city: string | null; region: string | null; country: string | null } {
  const h = req.headers
  const direct = h.get('cf-connecting-ip')
  const cf = (req as unknown as { cf?: Record<string, unknown> }).cf ?? {}
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null)
  if (viaCloudflareProxy(direct) && h.get('x-visitor-ip')) {
    const d = (k: string) => { const v = h.get(k); try { return s(v === null ? null : decodeURIComponent(v)) } catch { return s(v) } }
    return { ip: d('x-visitor-ip'), city: d('x-visitor-city'), region: d('x-visitor-region'), country: d('x-visitor-country') }
  }
  return { ip: direct, city: s(cf.city), region: s(cf.region), country: s(cf.country) }
}

/** Browser, operating system and kind of device from a user agent. */
export function parseAgent(ua: string | null | undefined): { device: string; browser: string; os: string } {
  const u = ua ?? ''
  if (!u) return { device: 'Unknown', browser: 'Unknown', os: 'Unknown' }
  const browser = /Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox'
    : /SamsungBrowser\//.test(u) ? 'Samsung Internet' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari'
    : /okhttp|Dalvik/i.test(u) ? 'Android app' : /CFNetwork|Darwin/.test(u) ? 'iOS app' : 'Other'
  const os = /Windows/.test(u) ? 'Windows' : /Android/.test(u) ? 'Android' : /iPhone|iPad|iPod/.test(u) ? 'iOS'
    : /Mac OS X|Macintosh/.test(u) ? 'macOS' : /CrOS/.test(u) ? 'ChromeOS' : /Linux/.test(u) ? 'Linux' : 'Other'
  const device = /iPad|Tablet/.test(u) ? 'Tablet' : /Mobi|iPhone|Android/.test(u) ? 'Phone' : 'Computer'
  return { device, browser, os }
}

/* --- writes ------------------------------------------------------------------ */

async function schoolDb(env: Env, institutionId: string): Promise<D1Database | null> {
  const inst = await institutionById(env, institutionId)
  return inst ? tenantDb(env, inst) : null
}

/** The sign-in row. Best-effort: a failure here never blocks a sign-in. */
export async function recordSignIn(env: Env, req: Request, sessionId: string, userId: string, institutionId: string, via: string, at: string): Promise<void> {
  try {
    const db = await schoolDb(env, institutionId)
    if (!db || !(await activitySettings(env, institutionId, db)).recording) return
    const ua = req.headers.get('user-agent')?.slice(0, 512) ?? null
    const v = visitorFacts(req), a = parseAgent(ua)
    await db.prepare(`INSERT OR IGNORE INTO session_activity (session_id, institution_id, user_id, via, signed_in_at, ip, user_agent, device, browser, os, city, region, country, last_active_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(sessionId, institutionId, userId, via, at, v.ip, ua, a.device, a.browser, a.os, v.city, v.region, v.country, at).run()
  } catch (err) { console.warn('session activity: sign-in not recorded', err) }
}

/** Marks a session's row ended. Writes only to a row that exists, so it records nothing when the switch was off. */
export async function recordSignOut(env: Env, sessionId: string, reason: string, institutionId?: string | null): Promise<void> {
  try {
    let inst = institutionId
    if (inst === undefined) {
      inst = (await env.CONTROL.prepare(`SELECT institution_id FROM sessions WHERE id = ?`).bind(sessionId).first<{ institution_id: string | null }>())?.institution_id ?? null
    }
    if (!inst) return
    const db = await schoolDb(env, inst)
    if (!db) return
    await db.prepare(`UPDATE session_activity SET signed_out_at = ?, ended_reason = ? WHERE session_id = ? AND signed_out_at IS NULL`)
      .bind(new Date().toISOString(), reason, sessionId).run()
  } catch (err) { console.warn('session activity: sign-out not recorded', err) }
}

/** The same for several sessions of one school at once (sign everyone out, sign my other devices out). */
export async function recordSignOutMany(db: D1Database, ids: string[], reason: string): Promise<void> {
  if (!ids.length) return
  try {
    await db.prepare(`UPDATE session_activity SET signed_out_at = ?, ended_reason = ? WHERE signed_out_at IS NULL AND session_id IN (SELECT value FROM json_each(?))`)
      .bind(new Date().toISOString(), reason, JSON.stringify(ids)).run()
  } catch (err) { console.warn('session activity: sign-outs not recorded', err) }
}

export interface ViewIn { screen?: unknown; path?: unknown; at?: unknown; seconds?: unknown }

/** One batch of screen visits from the web app. Returns how many were kept. */
export async function recordViews(env: Env, req: Request, db: D1Database, s: { sessionId: string; userId: string; institutionId: string }, views: ViewIn[]): Promise<number> {
  if (!(await activitySettings(env, s.institutionId, db)).recording) return 0
  const nowMs = Date.now()
  const clean: { screen: string; path: string | null; at: string; seconds: number }[] = []
  for (const v of views.slice(0, 50)) {
    const screen = typeof v.screen === 'string' ? v.screen.trim().slice(0, 120) : ''
    if (!screen) continue
    const t = Date.parse(typeof v.at === 'string' ? v.at : '')
    // A browser clock can be wrong; keep the time only if it is within the last day.
    const at = Number.isFinite(t) && t <= nowMs + 60_000 && t > nowMs - 86_400_000 ? new Date(t).toISOString() : new Date(nowMs).toISOString()
    const secs = Math.max(0, Math.min(4 * 3600, Math.round(Number(v.seconds) || 0)))
    const path = typeof v.path === 'string' ? v.path.split('?')[0].slice(0, 200) : null
    clean.push({ screen, path, at, seconds: secs })
  }
  if (!clean.length) return 0
  const total = clean.reduce((n, v) => n + v.seconds, 0)
  const lastActive = new Date(Math.min(nowMs, Math.max(...clean.map((v) => Date.parse(v.at) + v.seconds * 1000)))).toISOString()

  /* A session that began before the switch was turned on has no row yet: make
     one from what CONTROL knows about it. */
  const have = await db.prepare(`SELECT 1 FROM session_activity WHERE session_id = ?`).bind(s.sessionId).first()
  if (!have) {
    const cs = await env.CONTROL.prepare(`SELECT created_at, via, user_agent FROM sessions WHERE id = ?`).bind(s.sessionId)
      .first<{ created_at: string; via: string; user_agent: string | null }>()
    const ua = req.headers.get('user-agent')?.slice(0, 512) ?? cs?.user_agent ?? null
    const v = visitorFacts(req), a = parseAgent(ua)
    await db.prepare(`INSERT OR IGNORE INTO session_activity (session_id, institution_id, user_id, via, signed_in_at, ip, user_agent, device, browser, os, city, region, country, last_active_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(s.sessionId, s.institutionId, s.userId, cs?.via ?? null, cs?.created_at ?? clean[0].at, v.ip, ua, a.device, a.browser, a.os, v.city, v.region, v.country, lastActive).run()
  }
  const ins = db.prepare(`INSERT INTO session_activity_views (session_id, institution_id, user_id, screen, path, started_at, seconds) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  await db.batch([
    ...clean.map((v) => ins.bind(s.sessionId, s.institutionId, s.userId, v.screen, v.path, v.at, v.seconds)),
    db.prepare(`UPDATE session_activity SET active_seconds = active_seconds + ?, last_active_at = max(COALESCE(last_active_at, ''), ?) WHERE session_id = ?`)
      .bind(total, lastActive, s.sessionId),
  ])
  return clean.length
}

/** The retention sweep for one school: everything older than its retention period. */
export async function purgeSessionActivity(db: D1Database, nowMs = Date.now()): Promise<{ sessions: number; views: number }> {
  const { retention_days } = await schoolActivitySettings(db)
  const cutoff = new Date(nowMs - retention_days * 86_400_000).toISOString()
  try {
    const [v, s] = await db.batch([
      db.prepare(`DELETE FROM session_activity_views WHERE started_at < ?`).bind(cutoff),
      db.prepare(`DELETE FROM session_activity WHERE COALESCE(last_active_at, signed_in_at) < ?`).bind(cutoff),
    ])
    return { views: v.meta.changes ?? 0, sessions: s.meta.changes ?? 0 }
  } catch { return { sessions: 0, views: 0 } /* a school not yet migrated */ }
}
