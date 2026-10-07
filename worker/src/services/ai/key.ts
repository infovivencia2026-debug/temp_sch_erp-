import type { Env } from '../../env'
import type { Ctx } from '../../router'
import { openSecret, sealSecret } from '../../routes/admin/providers'

/* Which Google key the AI features use, and whether Google accepts it.

   The key: a seller admin may store one under Controls > AI (CONTROL.ai_key,
   sealed with CREDENTIAL_KEY like connector credentials); it wins over the
   GOOGLE_API_KEY secret. Removing it falls back to the secret.

   The state: ok, refused, quota, unreachable or missing, from one cheap call
   (the model's metadata) cached ten minutes per isolate and in CONTROL for the
   others, keyed by a fingerprint of the key so a new key is checked again.
   A generation call that is refused records it at once (noteAiResult), and
   geminiRequest then fails without calling Google until the next check. */

export type AiState = 'ok' | 'refused' | 'quota' | 'unreachable' | 'missing'
export interface AiStatus { state: AiState; checked_at: string | null }
export interface AiKey { key: string | null; source: 'stored' | 'env' | 'service_account' | 'none'; last4: string | null; set_at: string | null }

const TTL = 10 * 60_000
const CHECK_TIMEOUT = 5_000
const MODEL = 'gemini-2.5-flash'

/** The bare key; tolerates quotes or a pasted snippet around it. */
export function extractApiKey(raw: string): string | null {
  const m = raw.match(/AIza[0-9A-Za-z_-]{35}|AQ\.[0-9A-Za-z_.-]{20,}/)
  return m ? m[0] : null
}

let keyCache: { at: number; v: AiKey } | null = null
let stateCache: { at: number; fp: string; v: AiStatus } | null = null

/** Tests: forget what this isolate knows. */
export function resetAiKeyCache(): void { keyCache = null; stateCache = null }

const envStr = (env: Env, k: string) => {
  const v = (env as unknown as Record<string, unknown>)[k]
  return typeof v === 'string' ? v.trim() : ''
}

async function fingerprint(key: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return [...new Uint8Array(d).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

type Row = { sealed: ArrayBuffer | null; last4: string | null; set_at: string | null; state: string | null; checked_at: string | null; key_fp: string | null }
async function row(env: Env): Promise<Row | null> {
  try { return await env.CONTROL.prepare('SELECT sealed, last4, set_at, state, checked_at, key_fp FROM ai_key WHERE id = 1').first<Row>() } catch (e) {
    console.error('ai_key read', e); return null
  }
}

/** The key in use: stored (sealed) first, then the secret. Cached a minute per isolate. */
export async function aiKey(env: Env): Promise<AiKey> {
  if (keyCache && Date.now() - keyCache.at < 60_000) return keyCache.v
  let v: AiKey = { key: null, source: 'none', last4: null, set_at: null }
  const r = await row(env)
  if (r?.sealed) {
    try {
      const k = extractApiKey(await openSecret({ env } as unknown as Ctx, r.sealed))
      if (k) v = { key: k, source: 'stored', last4: r.last4, set_at: r.set_at }
    } catch (e) { console.error('stored AI key will not open', (e as Error).message) }
  }
  if (!v.key) {
    const raw = envStr(env, 'GOOGLE_API_KEY')
    if (raw) v = { key: extractApiKey(raw), source: 'env', last4: null, set_at: null }
    else if (envStr(env, 'GOOGLE_SERVICE_ACCOUNT_JSON')) v = { key: null, source: 'service_account', last4: null, set_at: null }
  }
  keyCache = { at: Date.now(), v }
  return v
}

/** A key or a service account is set (says nothing about whether Google takes it). */
export async function aiKeyPresent(env: Env): Promise<boolean> {
  return (await aiKey(env)).source !== 'none'
}

/** True for the one answer that means "this AQ. key is a Vertex express key": worth one try on Vertex. */
export function vertexOnly(status: number, body: string): boolean {
  if (status !== 401 && status !== 403) return false
  if (/API_KEY_INVALID|API key not valid|API_KEY_SERVICE_BLOCKED|leaked|expired/i.test(body)) return false
  return /API keys are not supported by this API|CREDENTIALS_MISSING|ACCESS_TOKEN_TYPE_UNSUPPORTED/i.test(body)
}

/** What an HTTP answer from Google says about the key. */
export function stateOf(status: number, body = ''): AiState {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 429) return 'quota'
  if (status === 401 || status === 403 || (status === 400 && /API_KEY_INVALID|API key not valid/i.test(body))) return 'refused'
  return 'unreachable'
}

async function save(env: Env, fp: string, st: AiStatus): Promise<void> {
  stateCache = { at: Date.now(), fp, v: st }
  try {
    await env.CONTROL.prepare(`INSERT INTO ai_key (id, state, checked_at, key_fp) VALUES (1, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET state = excluded.state, checked_at = excluded.checked_at, key_fp = excluded.key_fp`)
      .bind(st.state, st.checked_at, fp).run()
  } catch (e) { console.error('ai_key write', e) }
}

/** A generation call's outcome, so status reads are right at once. */
export async function noteAiResult(env: Env, state: AiState): Promise<void> {
  const k = await aiKey(env)
  const fp = k.key ? await fingerprint(k.key) : k.source
  if (stateCache?.fp === fp && stateCache.v.state === state) return
  await save(env, fp, { state, checked_at: new Date().toISOString() })
}

/** One cheap call: the model's metadata. Vertex express keys get one try on Vertex. */
async function probe(key: string): Promise<AiState> {
  const signal = AbortSignal.timeout(CHECK_TIMEOUT)
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}`, { signal, headers: { 'x-goog-api-key': key } })
    const body = r.ok ? '' : await r.text()
    if (key.startsWith('AQ.') && vertexOnly(r.status, body)) {
      const v = await fetch(`https://aiplatform.googleapis.com/v1/publishers/google/models/${MODEL}:countTokens?key=${encodeURIComponent(key)}`,
        { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }) })
      return stateOf(v.status, v.ok ? '' : await v.text())
    }
    return stateOf(r.status, body)
  } catch (e) {
    console.error('ai key check', (e as Error).name)
    return 'unreachable'
  }
}

const isTestFake = (env: Env) => envStr(env, 'APP_ENV') === 'test' && typeof (globalThis as { __FAKE_GEMINI__?: unknown }).__FAKE_GEMINI__ === 'function'

/** The state of the key in use; `force` checks again now. */
export async function aiStatus(env: Env, force = false): Promise<AiStatus> {
  if (isTestFake(env)) return { state: 'ok', checked_at: null }
  const k = await aiKey(env)
  if (k.source === 'none' || (k.source !== 'service_account' && !k.key)) return { state: 'missing', checked_at: null }
  const fp = k.key ? await fingerprint(k.key) : k.source
  if (!force && stateCache && stateCache.fp === fp && Date.now() - stateCache.at < TTL) return stateCache.v
  if (!force) {
    const r = await row(env)
    if (r?.key_fp === fp && r.state && r.checked_at && Date.now() - Date.parse(r.checked_at) < TTL) {
      const v = { state: r.state as AiState, checked_at: r.checked_at }
      stateCache = { at: Date.parse(r.checked_at), fp, v }
      return v
    }
  }
  // A service account has no cheap check; it is trusted until a call is refused.
  const state = k.key ? await probe(k.key) : (stateCache?.fp === fp ? stateCache.v.state : 'ok')
  const v = { state, checked_at: new Date().toISOString() }
  await save(env, fp, v)
  return v
}

/** The known state without calling Google (null when not checked recently). */
export async function knownAiState(env: Env): Promise<AiState | null> {
  const k = await aiKey(env)
  if (!k.key) return null
  const fp = await fingerprint(k.key)
  return stateCache && stateCache.fp === fp && Date.now() - stateCache.at < TTL ? stateCache.v.state : null
}

/** Store a new key (sealed), or remove the stored one (null). Never logs or returns it. */
export async function storeAiKey(c: Ctx, raw: string | null): Promise<void> {
  if (raw === null) {
    await c.env.CONTROL.prepare(`UPDATE ai_key SET sealed = NULL, last4 = NULL, set_at = NULL, set_by = NULL WHERE id = 1`).run()
  } else {
    const key = extractApiKey(raw)
    if (!key) throw new Error('not a Google API key')
    const sealed = await sealSecret(c, key)
    await c.env.CONTROL.prepare(`INSERT INTO ai_key (id, sealed, last4, set_at, set_by) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET sealed = excluded.sealed, last4 = excluded.last4, set_at = excluded.set_at, set_by = excluded.set_by`)
      .bind(sealed, key.slice(-4), new Date().toISOString(), c.id.userId).run()
  }
  resetAiKeyCache()
}
