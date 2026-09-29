import type { Env } from './env'

/* WHO SENT THIS REQUEST, AND FROM WHERE.

   The Pages function (web/functions/[[path]].ts) is the front door. It adds
   X-Origin-Secret, a value shared only between it and this Worker
   (ORIGIN_SHARED_SECRET, set with `wrangler secret put` here and
   `wrangler pages secret put` there), and forwards the visitor's own address
   as X-Visitor-IP (and place as X-Visitor-City/-Region/-Country). Past that
   hop CF-Connecting-IP is the function's address, the same for everyone.

   normalizeRequest runs first on every request and leaves the handlers one
   rule: CF-Connecting-IP is the caller.
   - Secret checks out: CF-Connecting-IP becomes X-Visitor-IP, and the
     X-Visitor-* place headers are marked trusted (TRUSTED_MARK).
   - Otherwise (a direct call to workers.dev, a device): CF-Connecting-IP is
     Cloudflare's own and stays; every X-Visitor-* is dropped.
   X-Forwarded-For, X-Real-IP and X-Origin-Secret never reach a handler.

   With no ORIGIN_SHARED_SECRET configured (local tests, a fresh account) no
   request is verified and none is refused: visitor headers are simply never
   believed. */

export const TRUSTED_MARK = 'x-erp-visitor-trusted'

/** Paths that answer without the origin secret: callers that never pass the Pages function. */
export const PUBLIC_PREFIXES = [
  '/api/v1/sms-gateway/',   // the Android SMS gateway (device bearer token)
  '/api/v1/bus-tracker/',   // the bus-tracker phone (device bearer token)
  '/api/v1/public/',        // public forms, bus-tracker enrolment, message test link
]

function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b)
  if (x.length !== y.length || x.length === 0) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

export function originConfigured(env: Env): boolean {
  return typeof env.ORIGIN_SHARED_SECRET === 'string' && env.ORIGIN_SHARED_SECRET !== ''
}

/** True when the request carries the shared secret, i.e. came through our Pages function. */
export function originVerified(env: Env, req: Request): boolean {
  if (!originConfigured(env)) return false
  const got = req.headers.get('x-origin-secret')
  return !!got && sameSecret(got, env.ORIGIN_SHARED_SECRET as string)
}

/** An /api request the Worker refuses: the secret is configured and missing or wrong. */
export function originRefused(env: Env, pathname: string, verified: boolean): boolean {
  if (verified || !originConfigured(env)) return false
  if (!pathname.startsWith('/api/')) return false
  return !PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))
}

const decode = (v: string) => { try { return decodeURIComponent(v) } catch { return v } }

/** The request with the caller's address settled (see above). */
export function normalizeRequest(env: Env, req: Request): { req: Request; verified: boolean } {
  const verified = originVerified(env, req)
  const h = new Headers(req.headers)
  for (const k of ['x-origin-secret', 'x-forwarded-for', 'x-real-ip', TRUSTED_MARK]) h.delete(k)
  const visitor = req.headers.get('x-visitor-ip')
  if (verified && visitor) {
    h.set('cf-connecting-ip', decode(visitor).slice(0, 64))
    h.set(TRUSTED_MARK, '1')
  } else {
    for (const k of ['x-visitor-ip', 'x-visitor-city', 'x-visitor-region', 'x-visitor-country']) h.delete(k)
  }
  const cf = (req as unknown as { cf?: IncomingRequestCfProperties }).cf
  const out = new Request(req, { headers: h, ...(cf ? { cf } : {}) } as RequestInit)
  if (cf && !(out as unknown as { cf?: unknown }).cf) Object.defineProperty(out, 'cf', { value: cf })
  return { req: out, verified }
}

/** The caller's address after normalizeRequest. */
export const clientIp = (req: Request): string | null => req.headers.get('cf-connecting-ip')
