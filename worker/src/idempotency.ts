import type { Identity } from './identity'
import { HttpError, errorResponse, now } from './http'

/* Port of internal/api/idempotency.go (Server.Idempotent). A write carrying an
   Idempotency-Key runs once per (school, key); a repeat is answered from the
   stored receipt with `Idempotent-Replay: true`. Keyless requests, reads,
   non-JSON bodies and callers with no school pass through untouched.

   D1 has no interactive transactions or row locks: the claim is a single
   INSERT ... ON CONFLICT DO NOTHING, whose `changes` says whether this request
   is the first. The receipt is settled (or released on a 5xx) afterwards. */
export async function idempotent(
  req: Request, id: Identity, db: () => D1Database, next: (req: Request) => Promise<Response>,
): Promise<Response> {
  const key = (req.headers.get('Idempotency-Key') ?? '').trim()
  const m = req.method
  if (key === '' || key.length > 200 || m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next(req)
  const ct = req.headers.get('Content-Type')
  if (ct && !ct.toLowerCase().startsWith('application/json')) return next(req)
  if (!id.institution) return next(req)

  // The body is read to hash it; the handler gets a fresh Request over the same bytes.
  const body = new Uint8Array(await req.arrayBuffer())
  if (body.byteLength > 8 << 20) throw new HttpError(400, 'could not read the request body', { code: 'bad_request' })
  const inner = new Request(req, { body: m === 'GET' || m === 'HEAD' ? undefined : body })
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))]
    .map((b) => b.toString(16).padStart(2, '0')).join('')

  const d = db()
  const inst = id.institution.id
  const path = new URL(req.url).pathname
  // A claim nobody settled within two minutes is wreckage from a killed request.
  const stale = new Date(Date.now() - 2 * 60_000).toISOString()
  const [, claim] = await d.batch([
    d.prepare(`DELETE FROM idempotency_keys WHERE institution_id = ? AND key = ?
                 AND completed_at IS NULL AND created_at < ?`).bind(inst, key, stale),
    d.prepare(`INSERT INTO idempotency_keys (institution_id, key, user_id, method, path, request_hash, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (institution_id, key) DO NOTHING`)
      .bind(inst, key, id.userId, m, path, hash, now()),
  ])

  if (!claim.meta.changes) {
    const prev = await d.prepare(`SELECT status_code, response_body, method, path, request_hash
                                    FROM idempotency_keys WHERE institution_id = ? AND key = ? AND user_id = ?`)
      .bind(inst, key, id.userId)
      .first<{ status_code: number | null; response_body: unknown; method: string; path: string; request_hash: string }>()
    if (!prev) throw new HttpError(409, 'That request reference belongs to a different sign-in. Try the action again.', { code: 'idempotency_key_reused' })
    if (prev.method !== m || prev.path !== path || prev.request_hash !== hash)
      throw new HttpError(409, 'That request reference was already used for a different request.', { code: 'idempotency_key_conflict' })
    if (prev.status_code == null)
      throw new HttpError(409, 'That request is still being processed. It will not be sent twice.', { code: 'idempotency_in_flight' })
    return new Response(toBytes(prev.response_body), {
      status: prev.status_code,
      headers: { 'content-type': 'application/json', 'Idempotent-Replay': 'true' },
    })
  }

  let res: Response
  try { res = await next(inner) } catch (err) { res = errorResponse(err) }
  const out = new Uint8Array(await res.arrayBuffer())

  // Settling must not fail the response the handler already produced.
  try {
    if (res.status >= 500) {
      await d.prepare(`DELETE FROM idempotency_keys WHERE institution_id = ? AND key = ?`).bind(inst, key).run()
    } else {
      await d.prepare(`UPDATE idempotency_keys SET status_code = ?, response_body = ?, completed_at = ?
                        WHERE institution_id = ? AND key = ?`).bind(res.status, out, now(), inst, key).run()
    }
  } catch (err) { console.error('idempotency settle', err) }
  return new Response(res.status === 204 || res.status === 304 ? null : out, { status: res.status, statusText: res.statusText, headers: res.headers })
}

function toBytes(v: unknown): Uint8Array {
  if (v == null) return new Uint8Array()
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  if (Array.isArray(v)) return Uint8Array.from(v as number[])
  return new TextEncoder().encode(String(v))
}
