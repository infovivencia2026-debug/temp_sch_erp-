import type { Env } from '../env'
import { now } from '../env'
import { issueSession } from '../auth/session'
import { loginHTML } from '../auth/login-page'
import { institutionById, tenantDb } from '../tenant'
import { mfaPage } from './render'

/* POST /login/mfa: internal/auth/mfa_login.go and totp.go.

   A password that checks out for an account with a second factor opens a
   pending ticket (erp_mfa cookie, five minutes, HMAC-SHA256 with the pepper
   over "mfa-pending\0" + msg) instead of a session; the code plus a valid
   ticket opens the session. Tickets are byte-compatible with Go's. */

const CSRF = 'erp_csrf'
const PENDING = 'erp_mfa'
const PENDING_TTL = 5 * 60
const NIL_UUID = '00000000-0000-0000-0000-000000000000'
const MFA_MAX_FAILS = 5
const MFA_WINDOW_MS = 15 * 60_000

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function unb64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null
  try { return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)) } catch { return null }
}

async function hmac(hash: 'SHA-1' | 'SHA-256', key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, msg))
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

const enc = new TextEncoder()
const pendingMac = (pepper: string, msg: string) => hmac('SHA-256', enc.encode(pepper), enc.encode('mfa-pending\0' + msg))

export async function signPending(pepper: string, parts: string[]): Promise<string> {
  const msg = parts.join('|')
  return b64url(enc.encode(msg)) + '.' + b64url(await pendingMac(pepper, msg))
}

interface Pending { userId: string; instId: string | null; via: string; next: string }

async function openPending(pepper: string, tok: string): Promise<Pending | null> {
  const i = tok.lastIndexOf('.')
  if (i < 0) return null
  const msgB = unb64url(tok.slice(0, i)); const sig = unb64url(tok.slice(i + 1))
  if (!msgB || !sig) return null
  const msg = new TextDecoder().decode(msgB)
  if (!equal(sig, await pendingMac(pepper, msg))) return null
  const parts = msg.split('|')
  if (parts.length !== 6) return null
  const exp = Number(parts[4])
  if (!/^-?\d+$/.test(parts[4]) || Math.floor(Date.now() / 1000) > exp) return null
  if (!/^[0-9a-f-]{36}$/i.test(parts[0])) return null
  const inst = parts[1].toLowerCase()
  return { userId: parts[0].toLowerCase(), instId: inst && inst !== NIL_UUID ? inst : null, via: parts[2], next: safeNext(parts[5]) }
}

const safeNext = (n: string) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/')

// --- TOTP, RFC 6238: HMAC-SHA1, 30 s, 6 digits, one step of skew -------------

function base32(s: string): Uint8Array | null {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0, val = 0
  const out: number[] = []
  for (const ch of s) {
    const v = A.indexOf(ch)
    if (v < 0) return null
    val = (val << 5) | v; bits += 5
    if (bits >= 8) { bits -= 8; out.push((val >>> bits) & 0xff) }
  }
  return new Uint8Array(out)
}

export async function totpCode(secret: string, step: number): Promise<string | null> {
  const key = base32(secret.trim().toUpperCase())
  if (!key) return null
  const msg = new Uint8Array(8)
  new DataView(msg.buffer).setBigUint64(0, BigInt(step))
  const sum = await hmac('SHA-1', key, msg)
  const off = sum[sum.length - 1] & 0x0f
  const v = new DataView(sum.buffer).getUint32(off) & 0x7fffffff
  return String(v % 1_000_000).padStart(6, '0')
}

export async function verifyTOTP(secret: string, code: string, at = Date.now()): Promise<boolean> {
  code = code.trim().replace(/ /g, '')
  if (code.length !== 6) return false
  const step = Math.floor(at / 1000 / 30)
  let ok = false
  for (let d = -1; d <= 1; d++) {
    const want = await totpCode(secret, step + d)
    if (want === null) return false
    if (equal(enc.encode(want), enc.encode(code))) ok = true
  }
  return ok
}

// --- the handler --------------------------------------------------------------

function csrfToken(): string {
  const b = new Uint8Array(32); crypto.getRandomValues(b)
  return b64url(b)
}

const secure = (env: Env) => (env.COOKIE_SECURE !== 'false' ? '; Secure' : '')
const csrfCookie = (env: Env, tok: string) => `${CSRF}=${tok}; Path=/login; HttpOnly; SameSite=Lax; Max-Age=900${secure(env)}`
const clearPending = (env: Env) => `${PENDING}=; Path=/login; Max-Age=0; HttpOnly; SameSite=Lax${secure(env)}`

function readCookie(req: Request, name: string): string | undefined {
  return (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1]
}

function respond(env: Env, status: number, body: (csrf: string) => string, extra: string[] = []): Response {
  const tok = csrfToken()
  const h = new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  h.append('set-cookie', csrfCookie(env, tok))
  for (const c of extra) h.append('set-cookie', c)
  return new Response(body(tok), { status, headers: h })
}

/** The code form, as login.gohtml renders it with MFAStep. */
const codeStep = (env: Env, status: number, next: string, error?: string, extra: string[] = []) =>
  respond(env, status, (csrf) => mfaPage({ csrf, next, error }), extra)

/** The password form with an error (MFAStep false, Next empty, as Go renders it). */
const passwordStep = (env: Env, status: number, error: string, extra: string[] = []) =>
  respond(env, status, (csrf) => loginHTML({ csrf, next: '', error }), extra)

/**
 * For routes/login.ts: call instead of issuing a session when the account's
 * users.mfa_secret is set. Mirrors askForCode.
 */
export async function askForCode(env: Env, req: Request, userId: string, instId: string | null, via: string, next: string): Promise<Response> {
  const exp = Math.floor(Date.now() / 1000) + PENDING_TTL
  const tok = await signPending(env.PASSWORD_PEPPER, [userId, instId ?? NIL_UUID, via, '0', String(exp), next])
  await record(env, req, 'mfa_required', instId, userId)
  return codeStep(env, 200, next, undefined,
    [`${PENDING}=${tok}; Path=/login; Max-Age=${PENDING_TTL}; HttpOnly; SameSite=Lax${secure(env)}`])
}

async function mfaSecretFor(env: Env, p: Pending): Promise<string> {
  // Only school users carry mfa_secret; platform_users has no such column.
  if (!p.instId) return ''
  const inst = await institutionById(env, p.instId)
  if (!inst) return ''
  const r = await tenantDb(env, inst).prepare('SELECT mfa_secret FROM users WHERE id = ?').bind(p.userId).first<{ mfa_secret: string | null }>()
  return r?.mfa_secret ?? ''
}

export async function loginMFA(env: Env, req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null)
  if (!form) return passwordStep(env, 400, 'Malformed form submission.')
  const c = readCookie(req, CSRF)
  if (!c || c !== form.get('csrf_token')) return passwordStep(env, 403, 'Your sign-in form expired. Please try again.')
  const expired = 'That code step has expired. Sign in with your password again.'
  const pc = readCookie(req, PENDING)
  if (!pc) return passwordStep(env, 401, expired)
  const p = await openPending(env.PASSWORD_PEPPER, pc)
  if (!p) return passwordStep(env, 401, expired, [clearPending(env)])

  /* Wrong codes are counted per account. Go's comment promised that three end the ticket but
     nothing enforced it, so a five-minute ticket allowed as many guesses as the network could
     carry against a six-digit code (and a fresh ticket was one password away). */
  const tkey = 'mfa:' + p.userId
  const tr = await env.CONTROL.prepare('SELECT failures, window_started_at FROM login_throttle WHERE key = ?').bind(tkey)
    .first<{ failures: number; window_started_at: string }>()
  const fresh = !tr || Date.now() - Date.parse(tr.window_started_at) > MFA_WINDOW_MS
  if (!fresh && tr!.failures >= MFA_MAX_FAILS) {
    await record(env, req, 'mfa_locked', p.instId, p.userId)
    return passwordStep(env, 429, 'Too many wrong codes. Wait fifteen minutes, then sign in again.', [clearPending(env)])
  }
  const secret = await mfaSecretFor(env, p)
  const code = form.get('code')
  if (!secret || !(await verifyTOTP(secret, typeof code === 'string' ? code : ''))) {
    await env.CONTROL.prepare(`INSERT INTO login_throttle (key, failures, window_started_at, locked_until) VALUES (?, ?, ?, NULL)
        ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, window_started_at = excluded.window_started_at`)
      .bind(tkey, (fresh ? 0 : tr!.failures) + 1, fresh ? now() : tr!.window_started_at).run()
    await record(env, req, 'mfa_failed', p.instId, p.userId)
    return codeStep(env, 401, p.next, 'That code is not right. Open your authenticator app and type the current six digits.')
  }
  await env.CONTROL.prepare('DELETE FROM login_throttle WHERE key = ?').bind(tkey).run()
  const session = await issueSession(env, req, p.userId, p.instId, p.via)
  await record(env, req, 'ok', p.instId, p.userId)
  const h = new Headers({ location: p.next })
  h.append('set-cookie', clearPending(env))
  h.append('set-cookie', session)
  return new Response(null, { status: 303, headers: h })
}

async function record(env: Env, req: Request, outcome: string, inst: string | null, user: string) {
  await env.CONTROL.prepare(`INSERT INTO login_events (at, identifier, outcome, institution_id, user_id, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(now(), null, outcome, inst, user, req.headers.get('cf-connecting-ip'), req.headers.get('user-agent')?.slice(0, 512) ?? null).run()
}

