import type { Env } from '../env'
import { now } from '../env'
import { recordSignIn, recordSignOut } from '../services/session_activity'
import { forgetSession } from '../idcache'

export const COOKIE = 'erp_session'

export interface Session {
  id: string
  institution_id: string | null
  user_id: string
  via: string
  expires_at: string
  last_seen_at: string
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function cookieHeader(env: Env, value: string, maxAge: number): string {
  const secure = env.COOKIE_SECURE !== 'false' ? '; Secure' : ''
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

export async function issueSession(env: Env, req: Request, userId: string, institutionId: string | null, via = 'password'): Promise<string> {
  const raw = new Uint8Array(32)
  crypto.getRandomValues(raw)
  const token = b64url(raw)
  const ttl = Number(env.SESSION_TTL_SECONDS) || 2592000
  const t = now()
  const expires = new Date(Date.now() + ttl * 1000).toISOString()
  const id = crypto.randomUUID()
  await env.CONTROL.prepare(`INSERT INTO sessions (id, token_hash, institution_id, user_id, ip, user_agent, via, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, await sha256hex(token), institutionId, userId,
      req.headers.get('cf-connecting-ip'), req.headers.get('user-agent')?.slice(0, 512) ?? null, via, t, t, expires)
    .run()
  // Session activity (off unless the school switched it on): records nothing otherwise.
  if (institutionId) await recordSignIn(env, req, id, userId, institutionId, via, t)
  return cookieHeader(env, token, ttl)
}

export function clearCookie(env: Env): string {
  return cookieHeader(env, '', 0)
}

export function readCookie(req: Request): string | null {
  const m = (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))
  return m ? m[1] : null
}

export const tokenHash = sha256hex

/** The statement that finds the live session behind a token hash (batched by identity.ts). */
export function sessionStmt(env: Env, hash: string): D1PreparedStatement {
  return env.CONTROL.prepare(
    `SELECT id, institution_id, user_id, via, expires_at, last_seen_at FROM sessions
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`).bind(hash, now())
}

/** Applies the idle limit to a session row just read; touches last_seen_at at most once a minute,
    after the response when an ExecutionContext is at hand (it is not on the request's critical path). */
export async function liveSession(env: Env, s: Session | null, ctx?: ExecutionContext): Promise<Session | null> {
  if (!s) return null
  const idle = Number(env.SESSION_IDLE_SECONDS) || 86400
  if (Date.now() - Date.parse(s.last_seen_at) > idle * 1000) {
    await env.CONTROL.prepare(`UPDATE sessions SET revoked_at = ?, ended_reason = 'idle' WHERE id = ?`).bind(now(), s.id).run()
    await recordSignOut(env, s.id, 'idle', s.institution_id)
    forgetSession(s.id)
    return null
  }
  if (Date.now() - Date.parse(s.last_seen_at) > 60_000) {
    const touch = env.CONTROL.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).bind(now(), s.id).run()
    if (ctx) ctx.waitUntil(touch.catch(() => undefined)); else await touch
  }
  return s
}

/** The live session behind the cookie, or null. Touches last_seen_at at most once a minute. */
export async function currentSession(env: Env, req: Request, ctx?: ExecutionContext): Promise<Session | null> {
  const token = readCookie(req)
  if (!token) return null
  const s = await sessionStmt(env, await sha256hex(token)).first<Session>()
  return liveSession(env, s, ctx)
}

export async function revokeSession(env: Env, id: string, reason: string): Promise<void> {
  await env.CONTROL.prepare(`UPDATE sessions SET revoked_at = ?, ended_reason = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(now(), reason, id).run()
  forgetSession(id)
  await recordSignOut(env, id, reason)
}
