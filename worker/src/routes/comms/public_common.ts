import type { Env } from '../../env'
import { json } from '../../env'
import { HttpError } from '../../http'
import { institutionById, tenantDb, type Institution } from '../../tenant'

/* Helpers for the /api/v1/public/... routes, which carry no session and so
   are served outside the Router. Everything here answers in the Go envelope
   {"error":{"code","message"}} because the clients of these routes (the
   Android gateway app, the static message-test page, the public apply form)
   parse that shape. */

/** httpx.Error. */
export const goError = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  json({ error: { code, message, ...extra } }, status)
export const goNotFound = () => goError(404, 'not_found', 'resource not found')
export const goBadRequest = (msg: string) => goError(400, 'bad_request', msg)
export const goInternal = () => goError(500, 'internal', 'something went wrong')

/** Rule 7: a side effect the Worker does not perform. */
export const notImplemented = (what: string) => new HttpError(501, `not implemented in the worker: ${what}`)

/** An HttpError thrown by a public handler, answered in the Go envelope. */
export function publicErrorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    const code = err.status === 501 ? 'not_implemented' : err.status === 404 ? 'not_found' : err.status === 400 ? 'bad_request' : 'error'
    return goError(err.status, code, err.message)
  }
  console.error(err)
  return goInternal()
}

type FieldKind = 'string' | 'map'

/**
 * httpx.Decode: a 1 MiB JSON object whose keys are the struct's json tags and
 * whose values have the struct's types. Unknown fields, wrong types, a missing
 * or malformed body are all "malformed JSON body", as DisallowUnknownFields
 * and encoding/json made them. null is accepted for any field (Go leaves the
 * zero value).
 */
export async function decodeStrict<T>(req: Request, fields: Record<string, FieldKind>): Promise<T | Response> {
  const bad = () => goBadRequest('malformed JSON body')
  let text: string
  try { text = await req.text() } catch { return bad() }
  if (new TextEncoder().encode(text).length > 1 << 20) return bad()
  let v: unknown
  try { v = JSON.parse(text) } catch { return bad() }
  if (v === null) return {} as T
  if (typeof v !== 'object' || Array.isArray(v)) return bad()
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    // encoding/json matches keys case-insensitively.
    const key = Object.keys(fields).find((f) => f.toLowerCase() === k.toLowerCase())
    if (!key) return bad()
    if (val === null) continue
    if (fields[key] === 'string') {
      if (typeof val !== 'string') return bad()
      out[key] = val
    } else {
      if (typeof val !== 'object' || Array.isArray(val)) return bad()
      const m: Record<string, string> = {}
      for (const [mk, mv] of Object.entries(val as Record<string, unknown>)) {
        if (mv === null) { m[mk] = ''; continue }
        if (typeof mv !== 'string') return bad()
        m[mk] = mv
      }
      out[key] = m
    }
  }
  return out as T
}

/** callerAddress: the client's address as Cloudflare saw it. */
export const callerAddress = (req: Request) => req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? 'unknown'

/**
 * s.rateLimited: a fixed window of `burst` attempts per `windowS` seconds per
 * key, counted on every call. Kept in CONTROL.login_throttle under an "rl:"
 * prefix so it is shared by every isolate. A limiter fault allows the request,
 * as the Go one did. Returns the 429 to send, or null.
 */
export async function rateLimited(env: Env, scope: string, windowS: number, burst: number, key: string, msg: string): Promise<Response | null> {
  try {
    const k = `rl:${scope}:${key}`
    const row = await env.CONTROL.prepare('SELECT failures, window_started_at FROM login_throttle WHERE key = ?')
      .bind(k).first<{ failures: number; window_started_at: string }>()
    const fresh = !row || Date.now() - Date.parse(row.window_started_at) > windowS * 1000
    const n = (fresh ? 0 : Number(row!.failures)) + 1
    await env.CONTROL.prepare(`INSERT INTO login_throttle (key, failures, window_started_at, locked_until) VALUES (?, ?, ?, NULL)
        ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, window_started_at = excluded.window_started_at`)
      .bind(k, n, fresh ? new Date().toISOString() : row!.window_started_at).run()
    if (n > burst) return goError(429, 'rate_limited', msg)
  } catch (e) {
    console.error('rate limiter unavailable; allowing', scope, e)
  }
  return null
}

export interface Tenant { inst: Institution; db: D1Database }

/**
 * Every school with a reachable database. The platform-wide queries Go ran
 * AsPlatform (a slug, a pair-code digest, an HMAC key) become one query per
 * school here, as sms_gateway.ts's findDevice does.
 */
export async function allTenants(env: Env): Promise<Tenant[]> {
  const ids = await env.CONTROL.prepare(`SELECT id FROM institutions`).all<{ id: string }>()
  const out = await Promise.all(ids.results.map(async ({ id }) => {
    const inst = await institutionById(env, id)
    if (!inst) return null
    try { return { inst, db: tenantDb(env, inst) } } catch { return null }
  }))
  return out.filter((t): t is Tenant => t !== null)
}

/** sealSecret (messaging.go): AES-256-GCM under SHA-256(CREDENTIAL_KEY), nonce || ciphertext || tag. */
export async function sealSecretEnv(env: Env, plain: string): Promise<Uint8Array> {
  const key = env.CREDENTIAL_KEY
  if (typeof key !== 'string' || key.trim() === '') throw new Error('CREDENTIAL_KEY is not set. Refusing to store a password in clear')
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  const k = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt'])
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, new TextEncoder().encode(plain)))
  const out = new Uint8Array(nonce.length + sealed.length)
  out.set(nonce, 0); out.set(sealed, nonce.length)
  return out
}

/** base64.RawURLEncoding of 32 random bytes. */
export function randomSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b)
  if (x.length !== y.length) return false
  let d = 0
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]
  return d === 0
}
