/* The front door: the origin secret, whose address a request is believed to
   come from, the identity cache and its invalidation, and GET /bootstrap.

   These call the Worker's fetch directly with an env that differs from the
   test config in one or two variables (ORIGIN_SHARED_SECRET,
   IDENTITY_CACHE_TTL_SECONDS), which a Miniflare binding cannot vary per
   test. */
import { describe, it, expect, beforeAll } from 'vitest'
import worker from '../../src/index'
import { normalizeRequest, TRUSTED_MARK } from '../../src/origin'
import { forgetAll } from '../../src/idcache'
import { tokenHash } from '../../src/auth/session'
import { seed, E, BASE, IDS, USERS, PASSWORD, api } from './fixture'
import type { Env } from '../../src/env'
import type { BootstrapResponse } from '@shared/api'

const SECRET = 'test-origin-secret-7f3a'
const withSecret = { ...E, ORIGIN_SHARED_SECRET: SECRET } as Env
const cachedEnv = { ...E, IDENTITY_CACHE_TTL_SECONDS: '45' } as Env

type Init = RequestInit & { cookie?: string }
function wcall(env: Env, path: string, init: Init = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set('cookie', init.cookie)
  const w = worker as unknown as { fetch: (r: Request, e: Env) => Promise<Response> }
  return w.fetch(new Request(BASE + path, { ...init, headers, redirect: 'manual' }), env)
}

async function signInVia(env: Env, identifier: string, password: string, headers: Record<string, string> = {}): Promise<{ status: number; cookie: string | null }> {
  const page = await wcall(env, '/login', { headers })
  const csrf = (page.headers.get('set-cookie') ?? '').match(/erp_csrf=([^;]+)/)?.[1]
  const html = await page.text()
  const token = html.match(/name="csrf_token"\s+value="([^"]+)"/)?.[1] ?? html.match(/value="([^"]+)"\s+name="csrf_token"/)?.[1]
  if (!csrf || !token) throw new Error('no CSRF token on the sign-in page')
  const res = await wcall(env, '/login', {
    method: 'POST', body: new URLSearchParams({ identifier, password, csrf_token: token, next: '/' }), cookie: `erp_csrf=${csrf}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  })
  const c = (res.headers.get('set-cookie') ?? '').match(/erp_session=([^;]+)/)?.[1]
  return { status: res.status, cookie: c ? `erp_session=${c}` : null }
}

async function jget<T = any>(env: Env, path: string, cookie?: string, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await wcall(env, '/api/v1' + path, { cookie, headers })
  const text = await res.text()
  let body: unknown = text
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: body as T }
}

const throttleKeys = async () =>
  (await E.CONTROL.prepare(`SELECT key FROM login_throttle WHERE key LIKE 'ip:%'`).all<{ key: string }>()).results.map((r) => r.key)

beforeAll(async () => {
  await seed()
  /* The feature list is empty while a school is still in setup (as in feature_grants.test.ts). */
  const T = E.TENANT_TEST
  const campus = await T.prepare(`SELECT id FROM campuses LIMIT 1`).first<{ id: string }>()
  await T.prepare(`UPDATE institutions SET district = 'Hyderabad', state = 'Telangana', affiliation_board = 'CBSE' WHERE id = ?`).bind(IDS.school).run()
  await T.prepare(`INSERT OR IGNORE INTO employees (id, institution_id, campus_id, employee_code, first_name, status) VALUES (?, ?, ?, 'E-1', 'Tara', 'active')`)
    .bind('00000000-0000-4000-8000-0000000000e1', IDS.school, campus!.id).run()
})

describe('origin secret', () => {
  it('refuses /api without the secret once one is configured, 404 so nothing is announced', async () => {
    const r = await wcall(withSecret, '/api/v1/attention')
    expect(r.status).toBe(404)
    const wrong = await wcall(withSecret, '/api/v1/attention', { headers: { 'x-origin-secret': SECRET + 'x' } })
    expect(wrong.status).toBe(404)
  })

  it('lets /api through with the secret (then the usual 401 without a session)', async () => {
    const r = await wcall(withSecret, '/api/v1/attention', { headers: { 'x-origin-secret': SECRET } })
    expect(r.status).toBe(401)
    const s = await wcall(withSecret, '/api/v1/session', { headers: { 'x-origin-secret': SECRET } })
    expect(s.status).toBe(200)
  })

  it('keeps device and public endpoints and the sign-in page reachable without it', async () => {
    expect((await wcall(withSecret, '/healthz')).status).toBe(200)
    expect((await wcall(withSecret, '/login')).status).toBe(200)
    for (const p of ['/api/v1/sms-gateway/outbox', '/api/v1/bus-tracker/config', '/api/v1/public/nothing-here']) {
      const r = await wcall(withSecret, p)
      // Whatever the route says (401 without a device token, 404 unknown), never the origin refusal's bare 404 body.
      expect(await r.text()).not.toBe('Not Found')
    }
  })

  it('changes nothing while no secret is configured', async () => {
    expect((await wcall(E, '/api/v1/attention')).status).toBe(401)
  })
})

describe('whose address a request carries', () => {
  it('believes X-Visitor-IP only alongside the right secret, and never X-Forwarded-For or X-Real-IP', () => {
    const base = { 'cf-connecting-ip': '10.0.0.1', 'x-visitor-ip': '198.51.100.7', 'x-visitor-city': 'Pune',
      'x-forwarded-for': '6.6.6.6', 'x-real-ip': '7.7.7.7', [TRUSTED_MARK]: '1' }
    const ok = normalizeRequest(withSecret, new Request(BASE + '/x', { headers: { ...base, 'x-origin-secret': SECRET } }))
    expect(ok.verified).toBe(true)
    expect(ok.req.headers.get('cf-connecting-ip')).toBe('198.51.100.7')
    expect(ok.req.headers.get(TRUSTED_MARK)).toBe('1')
    expect(ok.req.headers.get('x-visitor-city')).toBe('Pune')
    expect(ok.req.headers.get('x-origin-secret')).toBeNull()
    for (const env of [withSecret, E]) {
      const bad = normalizeRequest(env, new Request(BASE + '/x', { headers: { ...base, 'x-origin-secret': 'guess' } }))
      expect(bad.verified).toBe(false)
      expect(bad.req.headers.get('cf-connecting-ip')).toBe('10.0.0.1')
      expect(bad.req.headers.get(TRUSTED_MARK)).toBeNull()
      expect(bad.req.headers.get('x-visitor-ip')).toBeNull()
      expect(bad.req.headers.get('x-forwarded-for')).toBeNull()
      expect(bad.req.headers.get('x-real-ip')).toBeNull()
    }
  })

  it('throttles sign-in by the visitor behind the proxy, not the proxy', async () => {
    const r = await signInVia(withSecret, 'nobody-' + crypto.randomUUID() + '@test.school', 'wrong password', {
      'x-origin-secret': SECRET, 'cf-connecting-ip': '10.9.9.9', 'x-visitor-ip': '198.51.100.21', 'x-forwarded-for': '6.6.6.21' })
    expect(r.cookie).toBeNull()
    const keys = await throttleKeys()
    expect(keys).toContain('ip:198.51.100.21')
    expect(keys).not.toContain('ip:10.9.9.9')
    expect(keys).not.toContain('ip:6.6.6.21')
  })

  it('throttles by the connecting address when the secret is missing, whatever the headers claim', async () => {
    await signInVia(withSecret, 'nobody-' + crypto.randomUUID() + '@test.school', 'wrong password', {
      'cf-connecting-ip': '10.9.9.22', 'x-visitor-ip': '198.51.100.22', 'x-forwarded-for': '6.6.6.22', 'x-real-ip': '7.7.7.22' })
    const keys = await throttleKeys()
    expect(keys).toContain('ip:10.9.9.22')
    for (const k of ['ip:198.51.100.22', 'ip:6.6.6.22', 'ip:7.7.7.22']) expect(keys).not.toContain(k)
  })

  it('records the visitor on the session behind the proxy', async () => {
    const r = await signInVia(withSecret, USERS.parent, PASSWORD, { 'x-origin-secret': SECRET, 'cf-connecting-ip': '10.9.9.30', 'x-visitor-ip': '198.51.100.30' })
    expect(r.cookie).not.toBeNull()
    const row = await E.CONTROL.prepare(`SELECT ip FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`).bind(IDS.parent).first<{ ip: string }>()
    expect(row?.ip).toBe('198.51.100.30')
  })
})

describe('identity cache', () => {
  const FEATURE = 'institution_admin.students.class_promotion'
  const keysOf = (body: any): string[] =>
    (body.roles ?? []).flatMap((r: any) => r.sections.flatMap((s: any) => s.features.map((f: any) => f.key)))

  it('serves a cached identity, and drops it the moment a permission changes through the app', async () => {
    forgetAll()
    const teacher = (await signInVia(cachedEnv, USERS.teacher, PASSWORD)).cookie!
    const admin = (await signInVia(cachedEnv, USERS.admin, PASSWORD)).cookie!
    expect(keysOf((await jget(cachedEnv, '/catalog', admin)).body).length).toBeGreaterThan(0)
    expect(keysOf((await jget(cachedEnv, '/catalog', teacher)).body)).not.toContain(FEATURE)

    // Written straight to D1, behind the app's back: the cached identity does not see it (the TTL bounds this).
    await E.TENANT_TEST.prepare(`INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, ?)`).bind(IDS.teacher, FEATURE).run()
      .catch(() => E.TENANT_TEST.prepare(`INSERT OR IGNORE INTO user_permissions (id, user_id, permission_key) VALUES (?, ?, ?)`).bind(crypto.randomUUID(), IDS.teacher, FEATURE).run())
    expect(keysOf((await jget(cachedEnv, '/catalog', teacher)).body)).not.toContain(FEATURE)
    await E.TENANT_TEST.prepare(`DELETE FROM user_permissions WHERE user_id = ?`).bind(IDS.teacher).run()

    // Through the app: the school's version is bumped and every cached identity of the school goes.
    const put = (keys: string[]) => wcall(cachedEnv, `/api/v1/admin/users/${IDS.teacher}/permissions`, {
      method: 'PUT', cookie: admin, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ permission_keys: keys }) })
    expect((await put([FEATURE])).status).toBe(200)
    expect(keysOf((await jget(cachedEnv, '/catalog', teacher)).body)).toContain(FEATURE)
    expect((await put([])).status).toBe(200)
    expect(keysOf((await jget(cachedEnv, '/catalog', teacher)).body)).not.toContain(FEATURE)
  })

  it('refuses a signed-out session at once, cached or not', async () => {
    forgetAll()
    const parent = (await signInVia(cachedEnv, USERS.parent, PASSWORD)).cookie!
    expect((await jget(cachedEnv, '/attention', parent)).status).toBe(200)
    await wcall(cachedEnv, '/logout', { cookie: parent })
    expect((await jget(cachedEnv, '/attention', parent)).status).toBe(401)
  })

  it('refuses a session revoked elsewhere (another isolate) on the next request', async () => {
    forgetAll()
    const parent = (await signInVia(cachedEnv, USERS.parent, PASSWORD)).cookie!
    expect((await jget(cachedEnv, '/attention', parent)).status).toBe(200)
    // Only this session: other test files may hold the parent's other sessions.
    const hash = await tokenHash(decodeURIComponent(parent.slice('erp_session='.length)))
    await E.CONTROL.prepare(`UPDATE sessions SET revoked_at = ? WHERE token_hash = ?`).bind(new Date().toISOString(), hash).run()
    expect((await jget(cachedEnv, '/attention', parent)).status).toBe(401)
  })
})

describe('GET /bootstrap', () => {
  it('answers a visitor with no session with the session part alone', async () => {
    const { status, body } = await jget<BootstrapResponse>(E, '/bootstrap')
    expect(status).toBe(200)
    expect(body.session.authenticated).toBe(false)
    expect([body.catalog, body.display_preferences, body.working_year, body.attention, body.today]).toEqual([null, null, null, null, null])
  })

  it('carries each part in the shape of its own endpoint', async () => {
    const { status, body } = await api<BootstrapResponse>('admin', 'GET', '/bootstrap')
    expect(status).toBe(200)
    expect(Object.keys(body).sort()).toEqual(['attention', 'catalog', 'display_preferences', 'session', 'today', 'working_year'])
    const [session, catalog, working, display, attention, today] = await Promise.all(
      ['/session', '/catalog', '/working-year', '/portal/preferences/display', '/attention', '/rollups/today'].map((p) => api('admin', 'GET', p)))
    expect(body.session).toEqual(session.body)
    expect(body.catalog).toEqual(catalog.body)
    expect(body.working_year).toEqual(working.body)
    expect(body.display_preferences).toEqual(display.body)
    expect({ ...body.attention, greeting: '' }).toEqual({ ...attention.body, greeting: '' })
    expect(body.today).toEqual(today.body)
    expect(body.session.authenticated).toBe(true)
    expect(Array.isArray(body.attention!.items)).toBe(true)
    expect(Array.isArray(body.working_year!.years)).toBe(true)
  })

  it('leaves out what the caller may not read', async () => {
    const { body } = await api<BootstrapResponse>('parent', 'GET', '/bootstrap')
    expect((await api('parent', 'GET', '/rollups/today')).status).toBe(403)
    expect(body.today).toBeNull()
    expect(body.session.authenticated).toBe(true)
    expect(body.attention).not.toBeNull()
  })
})
