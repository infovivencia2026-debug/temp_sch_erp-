/* The AI key and its state (services/ai/key.ts, routes/seller/controls.ts):
   Google is a stubbed fetch, so nothing leaves the machine. A refused key
   reads as refused and fails generation at once, without a second endpoint;
   a stored key wins over the secret; only a seller admin sets it; no route
   ever returns it, and the audit row does not hold it. */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { seed, api, call, signIn, E, PASSWORD } from './fixture'
import { hashPassword } from '../../src/auth/password'
import { resetAiKeyCache } from '../../src/services/ai/key'

const OWNER = { id: '00000000-0000-4000-8000-0000000000d1', email: 'ai.owner@vendor.test' }
const SUPPORT = { id: '00000000-0000-4000-8000-0000000000d2', email: 'ai.support@vendor.test' }
const ENV_KEY = 'AIza' + 'E'.repeat(35)
const NEW_KEY = 'AIza' + 'N'.repeat(31) + 'WXYZ'
const AQ_KEY = 'AQ.' + 'q'.repeat(30)
let owner = '', support = ''
const env = E as unknown as Record<string, unknown>

type Answer = { status: number; body?: string }
let answer: (url: string, key: string) => Answer = () => ({ status: 200, body: '{}' })
const seen: { url: string; key: string }[] = []
const realFetch = globalThis.fetch

const json = async (cookie: string, method: string, path: string, body?: unknown) => {
  const res = await call('/api/v1' + path, {
    method, cookie, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = text
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: parsed, text }
}

beforeAll(async () => {
  await seed()
  const C = E.CONTROL, t = new Date().toISOString()
  const hash = await hashPassword(E.PASSWORD_PEPPER, PASSWORD)
  for (const [u, role] of [[OWNER, 'seller_admin'], [SUPPORT, 'support_admin']] as const) {
    if (await C.prepare('SELECT 1 FROM platform_users WHERE id = ?').bind(u.id).first()) continue
    await C.batch([
      C.prepare(`INSERT INTO platform_users (id, email, full_name, password_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`).bind(u.id, u.email, role, hash, t, t),
      C.prepare(`INSERT INTO platform_user_roles (user_id, role_key, created_at) VALUES (?, ?, ?)`).bind(u.id, role, t),
      C.prepare(`INSERT INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, NULL, ?, ?)`).bind(u.email, u.id, t),
    ])
  }
  owner = (await signIn(OWNER.email)).cookie!
  support = (await signIn(SUPPORT.email)).cookie!
  env.CREDENTIAL_KEY = 'integration-test-credential-key'
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!/googleapis\.com/.test(url)) return realFetch(input as RequestInfo, init)
    const key = new Headers(init?.headers).get('x-goog-api-key') ?? new URL(url).searchParams.get('key') ?? ''
    seen.push({ url, key })
    const a = answer(url, key)
    return new Response(a.body ?? '{}', { status: a.status })
  }) as typeof fetch
})
afterAll(() => { globalThis.fetch = realFetch; delete env.GOOGLE_API_KEY; delete env.CREDENTIAL_KEY })
beforeEach(async () => {
  seen.length = 0
  env.GOOGLE_API_KEY = ENV_KEY
  await E.CONTROL.prepare('DELETE FROM ai_key').run()
  resetAiKeyCache()
})

const REFUSED = { status: 400, body: '{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}' }
const GEN_OK = JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"title":"","text":"Namaste"}' }] } }] })

describe('status', () => {
  it('missing when no key is set', async () => {
    delete env.GOOGLE_API_KEY
    const r = await api('admin', 'GET', '/ai/status')
    expect(r.body).toMatchObject({ configured: false, state: 'missing' })
  })
  it('ok, checked once and then cached', async () => {
    answer = () => ({ status: 200, body: '{}' })
    const r = await api('admin', 'GET', '/ai/status')
    expect(r.body).toMatchObject({ configured: true, state: 'ok' })
    expect(r.body.checked_at).toBeTruthy()
    await api('admin', 'GET', '/ai/status')
    expect(seen.length).toBe(1)
  })
  it('quota', async () => {
    answer = () => ({ status: 429 })
    expect((await api('admin', 'GET', '/ai/status')).body).toMatchObject({ configured: false, state: 'quota' })
  })
  it('refused: status says so, and generation fails fast without trying another endpoint', async () => {
    env.GOOGLE_API_KEY = AQ_KEY
    answer = () => REFUSED
    const t = await api('admin', 'POST', '/ai/translate', { text: 'Hello', language: 'hi' })
    expect(t.status).toBe(503)
    expect(t.body.code).toBe('assistant_not_configured')
    expect(seen.length).toBe(1)
    expect(seen[0].url).toContain('generativelanguage')
    expect((await api('admin', 'GET', '/ai/status')).body).toMatchObject({ state: 'refused', configured: false })
    // The next call does not reach Google at all.
    seen.length = 0
    expect((await api('admin', 'POST', '/ai/translate', { text: 'Hello', language: 'hi' })).status).toBe(503)
    expect(seen.length).toBe(0)
  })
  it('an AQ. key that only works on Vertex gets one try there', async () => {
    env.GOOGLE_API_KEY = AQ_KEY
    answer = (url) => url.includes('generativelanguage')
      ? { status: 401, body: '{"error":{"message":"API keys are not supported by this API. Expected OAuth2 access token","details":[{"reason":"CREDENTIALS_MISSING"}]}}' }
      : { status: 200, body: GEN_OK }
    const t = await api('admin', 'POST', '/ai/translate', { text: 'Hello', language: 'hi' })
    expect(t.status).toBe(200)
    expect(seen.map((s) => s.url.includes('aiplatform'))).toEqual([false, true])
  })
})

describe('the stored key', () => {
  it('only a seller admin sets it; support reads the state but not the key', async () => {
    expect((await json(support, 'PUT', '/seller/controls/ai', { api_key: NEW_KEY })).status).toBe(403)
    expect((await json(support, 'POST', '/seller/controls/ai/test')).status).toBe(403)
    expect((await json(support, 'DELETE', '/seller/controls/ai')).status).toBe(403)
    expect((await api('admin', 'PUT', '/seller/controls/ai', { api_key: NEW_KEY })).status).toBe(403)
    const g = await json(support, 'GET', '/seller/controls/ai')
    expect(g.status).toBe(200)
    expect(g.body).toMatchObject({ source: 'env', can_edit: false })
  })
  it('takes precedence over the secret, is never returned, and the audit row does not hold it', async () => {
    answer = () => ({ status: 200, body: GEN_OK })
    const put = await json(owner, 'PUT', '/seller/controls/ai', { api_key: '  "' + NEW_KEY + '" ' })
    expect(put.status).toBe(200)
    expect(put.body).toMatchObject({ source: 'stored', last4: 'WXYZ', state: 'ok', can_edit: true })
    expect(put.text).not.toContain(NEW_KEY)
    expect(seen.at(-1)!.key).toBe(NEW_KEY)
    const stored = await E.CONTROL.prepare('SELECT sealed, last4 FROM ai_key WHERE id = 1').first<{ sealed: ArrayBuffer; last4: string }>()
    expect(new TextDecoder().decode(new Uint8Array(stored!.sealed as unknown as ArrayBuffer))).not.toContain(NEW_KEY)
    expect(stored!.last4).toBe("WXYZ")
    seen.length = 0
    expect((await api('admin', 'POST', '/ai/translate', { text: 'Hello', language: 'hi' })).status).toBe(200)
    expect(seen[0].key).toBe(NEW_KEY)
    for (const p of ['/seller/controls/ai', '/ai/status']) expect(JSON.stringify((await json(owner, 'GET', p)).body)).not.toContain(NEW_KEY)
    const audit = await E.CONTROL.prepare(`SELECT action, before_summary, after_summary FROM seller_audit WHERE actor_id = ? AND action = 'controls.ai_key.set' ORDER BY at DESC LIMIT 1`).bind(OWNER.id).first<any>()
    expect(audit).toBeTruthy()
    expect(JSON.stringify(audit)).not.toContain(NEW_KEY)
    // Remove: back to the secret.
    const del = await json(owner, 'DELETE', '/seller/controls/ai')
    expect(del.body).toMatchObject({ source: 'env', last4: null })
    seen.length = 0
    await api('admin', 'POST', '/ai/translate', { text: 'Hello', language: 'hi' })
    expect(seen[0].key).toBe(ENV_KEY)
  })
  it('refuses something that is not a key, and Test key reports a refusal', async () => {
    expect((await json(owner, 'PUT', '/seller/controls/ai', { api_key: 'hello' })).status).toBe(400)
    answer = () => REFUSED
    const t = await json(owner, 'POST', '/seller/controls/ai/test')
    expect(t.body).toMatchObject({ state: 'refused', source: 'env' })
  })
})

vi.setConfig({ testTimeout: 30_000 })
