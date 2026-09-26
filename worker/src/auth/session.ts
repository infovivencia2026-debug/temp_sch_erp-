import type { Env } from '../env'
import { now } from '../env'

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
  await env.CONTROL.prepare(`INSERT INTO sessions (id, token_hash, institution_id, user_id, ip, user_agent, via, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), await sha256hex(token), institutionId, userId,
      req.headers.get('cf-connecting-ip'), req.headers.get('user-agent')?.slice(0, 512) ?? null, via, t, t, expires)
    .run()
  return cookieHeader(env, token, ttl)
}

export function clearCookie(env: Env): string {
  return cookieHeader(env, '', 0)
}

function readCookie(req: Request): string | null {
  const m = (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))
  return m ? m[1] : null
}

/** The live session behind the cookie, or null. Touches last_seen_at at most once a minute. */
export async function currentSession(env: Env, req: Request): Promise<Session | null> {
  const token = readCookie(req)
  if (!token) return null
  const s = await env.CONTROL.prepare(
    `SELECT id, institution_id, user_id, via, expires_at, last_seen_at FROM sessions
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`)
    .bind(await sha256hex(token), now()).first<Session>()
  if (!s) return null
  const idle = Number(env.SESSION_IDLE_SECONDS) || 86400
  if (Date.now() - Date.parse(s.last_seen_at) > idle * 1000) {
    await env.CONTROL.prepare(`UPDATE sessions SET revoked_at = ?, ended_reason = 'idle' WHERE id = ?`).bind(now(), s.id).run()
    return null
  }
  if (Date.now() - Date.parse(s.last_seen_at) > 60_000) {
    await env.CONTROL.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).bind(now(), s.id).run()
  }
  return s
}

export async function revokeSession(env: Env, id: string, reason: string): Promise<void> {
  await env.CONTROL.prepare(`UPDATE sessions SET revoked_at = ?, ended_reason = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(now(), reason, id).run()
}
