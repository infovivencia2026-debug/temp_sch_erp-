import type { Ctx } from '../../router'
import { HttpError } from '../../http'

/* Gemini through Vertex AI, from internal/api/assistant_chat.go (callGeminiParts,
   geminiGenerate, assistantFailure) and ratelimits.go (assistantRateLimit).

   Go authenticated with the Cloud Run metadata server (service account token,
   no API key) and read GOOGLE_CLOUD_PROJECT. A Worker has no metadata server,
   so the token is minted here from a service-account key held in the secret
   GOOGLE_SERVICE_ACCOUNT_JSON (JWT bearer grant, RS256 via WebCrypto). The
   project is GOOGLE_CLOUD_PROJECT when set, else the key's project_id. Same
   URL, model and payload as Go. */

export const ASSISTANT_MODEL = 'gemini-2.5-flash'

export class GeminiError extends Error {
  constructor(public statusCode: number, public body: string) { super(`gemini ${statusCode}: ${body}`) }
}
export class GeminiTimeout extends Error {}

export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } }

type SA = { client_email: string; private_key: string; project_id?: string; token_uri?: string }
let cached: { token: string; exp: number; email: string } | null = null

const b64url = (b: Uint8Array | string) => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : b
  let bin = ''
  for (const x of bytes) bin += String.fromCharCode(x)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function credentials(c: Ctx, signal: AbortSignal): Promise<{ project: string; token: string }> {
  const env = c.env as unknown as Record<string, unknown>
  const raw = typeof env.GOOGLE_SERVICE_ACCOUNT_JSON === 'string' ? env.GOOGLE_SERVICE_ACCOUNT_JSON : ''
  if (raw.trim() === '') throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set')
  const sa = JSON.parse(raw) as SA
  const project = (typeof env.GOOGLE_CLOUD_PROJECT === 'string' ? env.GOOGLE_CLOUD_PROJECT.trim() : '') || (sa.project_id ?? '').trim()
  if (project === '') throw new Error('no Google Cloud project id')
  const nowS = Math.floor(Date.now() / 1000)
  if (cached && cached.email === sa.client_email && cached.exp - 60 > nowS) return { project, token: cached.token }
  const aud = sa.token_uri || 'https://oauth2.googleapis.com/token'
  const unsigned = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud, iat: nowS, exp: nowS + 3600 }))
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const der = Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)))
  const res = await fetch(aud, { method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + b64url(sig) }) })
  const tok = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number }
  if (!res.ok || !tok.access_token) throw new Error('no access token from Google')
  cached = { token: tok.access_token, exp: nowS + Number(tok.expires_in ?? 3600), email: sa.client_email }
  return { project, token: tok.access_token }
}

/** callGeminiParts: one user turn of mixed parts under a system instruction. */
export async function callGeminiParts(c: Ctx, system: string, parts: GeminiPart[], maxTokens: number, timeoutMs: number): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const payload = {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { maxOutputTokens: maxTokens },
    }
    /* Two ways in. The Go server used Cloud Run's own identity against
       Vertex AI; a Worker has none, and the organisation forbids service-
       account keys. So the Gemini API with the project's API key
       (GOOGLE_API_KEY, Secret Manager temperp-google-api-key) is tried first:
       same model, same request body. A service-account key in
       GOOGLE_SERVICE_ACCOUNT_JSON still works for Vertex if one is ever set. */
    const apiKey = (c.env as unknown as Record<string, unknown>).GOOGLE_API_KEY
    let resp: Response
    if (typeof apiKey === 'string' && apiKey.trim() !== '') {
      /* A Vertex AI key (Vertex "express mode") is refused by the Gemini API
         endpoint with ACCESS_TOKEN_TYPE_UNSUPPORTED, and a Gemini API key is
         refused by Vertex; which one the project holds is not knowable from
         the key, so Vertex is tried first (it is what Go used) and the Gemini
         API second. */
      const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() }
      resp = await fetch(`https://aiplatform.googleapis.com/v1/publishers/google/models/${ASSISTANT_MODEL}:generateContent?key=${encodeURIComponent(apiKey.trim())}`,
        { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (resp.status === 401 || resp.status === 403) {
        resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${ASSISTANT_MODEL}:generateContent`,
          { method: 'POST', signal, headers, body: JSON.stringify(payload) })
      }
    } else {
      const { project, token } = await credentials(c, signal)
      const url = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${ASSISTANT_MODEL}:generateContent`
      resp = await fetch(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(payload) })
    }
    const rb = await resp.text()
    if (resp.status !== 200) throw new GeminiError(resp.status, rb)
    const out = JSON.parse(rb) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
    return (out.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('')
  } catch (e) {
    if (e instanceof GeminiError) throw e
    if (signal.aborted || (e as Error).name === 'TimeoutError') throw new GeminiTimeout('deadline exceeded')
    throw e
  }
}

/** assistantFailure: the Go mapping from a failed call to what the user reads. */
export function assistantFailure(err: unknown): HttpError {
  console.error(err)
  if (err instanceof GeminiError) {
    if (err.statusCode === 429) return new HttpError(429, 'the assistant is busy. Wait a moment and ask again.', { code: 'assistant_busy' })
    if (err.statusCode === 401 || err.statusCode === 403) {
      return new HttpError(503, "the assistant's key was refused. Ask whoever runs the server to check it.", { code: 'assistant_not_configured' })
    }
  }
  if (err instanceof GeminiTimeout) return new HttpError(504, 'the assistant took too long to answer. Ask again.', { code: 'assistant_slow' })
  return new HttpError(502, 'the assistant could not be reached just now. Ask again in a minute.', { code: 'assistant_unreachable' })
}

/** assistantRateLimit: 30 calls a minute per user (caller address before sign-in),
    counted in CONTROL.login_throttle as a fixed window. Go's limiter is a
    burst-30-per-minute policy; a store failure lets the request through, as Go. */
export async function assistantRateLimit(c: Ctx): Promise<void> {
  const who = c.id?.userId || c.req.headers.get('cf-connecting-ip') || 'unknown'
  const key = 'rl:assistant:' + who
  try {
    const row = await c.env.CONTROL.prepare('SELECT failures, window_started_at FROM login_throttle WHERE key = ?')
      .bind(key).first<{ failures: number; window_started_at: string }>()
    const fresh = !row || Date.now() - Date.parse(row.window_started_at) > 60_000
    const count = fresh ? 0 : Number(row!.failures)
    if (count >= 30) throw new HttpError(429, "You're using the assistant too fast, wait a moment and try again.", { code: 'rate_limited' })
    await c.env.CONTROL.prepare(`INSERT INTO login_throttle (key, failures, window_started_at, locked_until) VALUES (?, ?, ?, NULL)
        ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, window_started_at = excluded.window_started_at`)
      .bind(key, count + 1, fresh ? new Date().toISOString() : row!.window_started_at).run()
  } catch (e) {
    if (e instanceof HttpError) throw e
    console.error('rate limiter unavailable; allowing', e)
  }
}
