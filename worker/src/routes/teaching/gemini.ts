import type { Ctx } from '../../router'
import { HttpError } from '../../http'
import { aiKey, knownAiState, noteAiResult, stateOf, vertexOnly } from '../../services/ai/key'

/* Gemini through Vertex AI, from internal/api/assistant_chat.go (callGeminiParts,
   geminiGenerate, assistantFailure) and ratelimits.go (assistantRateLimit).

   Go authenticated with the Cloud Run metadata server (service account token,
   no API key) and read GOOGLE_CLOUD_PROJECT. A Worker has no metadata server,
   so the token is minted here from a service-account key held in the secret
   GOOGLE_SERVICE_ACCOUNT_JSON (JWT bearer grant, RS256 via WebCrypto). The
   project is GOOGLE_CLOUD_PROJECT when set, else the key's project_id. Same
   URL, model and payload as Go. */

export const ASSISTANT_MODEL = 'gemini-2.5-flash'
/** No generation call waits longer than this. */
export const GENERATION_TIMEOUT_MS = 15_000

export class GeminiError extends Error {
  constructor(public statusCode: number, public body: string) { super(`gemini ${statusCode}: ${body}`) }
}
export class GeminiTimeout extends Error {}
export class GeminiNotConfigured extends Error {}

export { extractApiKey } from '../../services/ai/key'

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
export function callGeminiParts(c: Ctx, system: string, parts: GeminiPart[], maxTokens: number, timeoutMs: number): Promise<string> {
  return geminiGenerate(c, system, [{ role: 'user', parts }], maxTokens, timeoutMs)
}

/** One turn of a conversation, in Gemini's vocabulary: role "user" or "model". */
export interface GeminiTurn { role: 'user' | 'model'; text: string }

/** callGemini: the assistant chat, a system instruction and the conversation so far. */
export function callGemini(c: Ctx, system: string, turns: GeminiTurn[], maxTokens: number, timeoutMs: number): Promise<string> {
  return geminiGenerate(c, system, turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })), maxTokens, timeoutMs)
}

/** geminiGenerate: one text answer, through geminiRequest. */
async function geminiGenerate(c: Ctx, system: string, contents: { role: string; parts: GeminiPart[] }[], maxTokens: number, timeoutMs: number): Promise<string> {
  const out = await geminiRequest(c, {
    system_instruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } },
  }, timeoutMs) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  return (out.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('')
}

/** geminiRequest: the one HTTPS POST every caller shares; a whole generateContent
    payload in (tools and all), the parsed answer out. In the integration tests
    (APP_ENV=test) a scripted fake on globalThis.__FAKE_GEMINI__ answers instead,
    so nothing leaves the machine. */
export async function geminiRequest(c: Ctx, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const fake = (globalThis as { __FAKE_GEMINI__?: (p: Record<string, unknown>) => unknown }).__FAKE_GEMINI__
  if (fake && (c.env as unknown as Record<string, unknown>).APP_ENV === 'test') return await fake(payload)
  /* Fail fast: one attempt, at most GENERATION_TIMEOUT_MS, and none at all
     when the key was refused at the last check (services/ai/key.ts). */
  const signal = AbortSignal.timeout(Math.min(timeoutMs, GENERATION_TIMEOUT_MS))
  try {
    /* A key (stored under Controls > AI, else GOOGLE_API_KEY) goes to the
       Gemini API. Only an AQ. key that the Gemini API answers with "API keys
       are not supported here" (a Vertex express-mode key) gets one try on
       Vertex; a refused key is never retried elsewhere. Without a key, a
       service-account key in GOOGLE_SERVICE_ACCOUNT_JSON reaches Vertex. */
    const k = await aiKey(c.env)
    let resp: Response
    if (k.source === 'stored' || k.source === 'env') {
      const apiKey = k.key
      if (!apiKey) throw new GeminiNotConfigured('GOOGLE_API_KEY does not hold a Google API key (expected AIza... or AQ....); set it to the bare key')
      const known = await knownAiState(c.env)
      if (known === 'refused') throw new GeminiError(401, 'key refused at the last check')
      resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${ASSISTANT_MODEL}:generateContent`,
        { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(payload) })
      if (apiKey.startsWith('AQ.') && (resp.status === 401 || resp.status === 403)) {
        const body = await resp.text()
        resp = vertexOnly(resp.status, body)
          ? await fetch(`https://aiplatform.googleapis.com/v1/publishers/google/models/${ASSISTANT_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
            { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
          : new Response(body, { status: resp.status })
      }
    } else {
      const { project, token } = await credentials(c, signal)
      const url = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${ASSISTANT_MODEL}:generateContent`
      resp = await fetch(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(payload) })
    }
    const rb = await resp.text()
    const st = stateOf(resp.status, rb)
    if (st === 'ok' || st === 'refused' || st === 'quota') await noteAiResult(c.env, st)
    if (resp.status !== 200) throw new GeminiError(resp.status, rb)
    return JSON.parse(rb)
  } catch (e) {
    if (e instanceof GeminiError || e instanceof GeminiNotConfigured) throw e
    if (signal.aborted || (e as Error).name === 'TimeoutError') throw new GeminiTimeout('deadline exceeded')
    throw e
  }
}

/** assistantFailure: the Go mapping from a failed call to what the user reads. */
export function assistantFailure(err: unknown): HttpError {
  console.error(err)
  if (err instanceof GeminiError) {
    if (err.statusCode === 429) return new HttpError(429, 'the assistant is busy. Wait a moment and ask again.', { code: 'assistant_busy' })
    if (err.statusCode === 401 || err.statusCode === 403 || (err.statusCode === 400 && err.body.includes('API_KEY_INVALID'))) {
      return new HttpError(503, 'The assistant is unavailable right now: Google refused the AI key. A seller admin can replace it under Controls, AI.', { code: 'assistant_not_configured' })
    }
  }
  if (err instanceof GeminiNotConfigured) {
    return new HttpError(503, "the assistant's key is not set up correctly. Ask whoever runs the server to check it.", { code: 'assistant_not_configured' })
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
