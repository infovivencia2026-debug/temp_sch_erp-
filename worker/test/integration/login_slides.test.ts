/* Sign-in pictures (routes/seller/tenants.ts, routes/login.ts): the vendor
   uploads up to eight pictures per school; the school's public sign-in page
   lists them in order and serves each one, never another school's. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, call, signIn, IDS, E, USERS, PASSWORD } from './fixture'
import { hashPassword } from '../../src/auth/password'

const OWNER = { id: '00000000-0000-4000-8000-0000000000d1', email: 'slides.owner@vendor.test' }
const OTHER = '00000000-0000-4000-8000-0000000000d9'
let owner = '', admin = '', path = '', otherPath = ''

const PNG = 'data:image/png;base64,' + btoa('\x89PNG\r\n\x1a\n-test-picture')
const json = async (cookie: string, method: string, p: string, body?: unknown) => {
  const res = await call('/api/v1' + p, {
    method, cookie,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = text
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: parsed }
}
const base = (school: string) => `/seller/tenants/${school}/slides`

beforeAll(async () => {
  await seed()
  const C = E.CONTROL
  const t = new Date().toISOString()
  if (!(await C.prepare('SELECT 1 FROM platform_users WHERE id = ?').bind(OWNER.id).first())) {
    const hash = await hashPassword(E.PASSWORD_PEPPER, PASSWORD)
    await C.batch([
      C.prepare(`INSERT INTO platform_users (id, email, full_name, password_hash, status, created_at, updated_at) VALUES (?, ?, 'Sam Slides', ?, 'active', ?, ?)`).bind(OWNER.id, OWNER.email, hash, t, t),
      C.prepare(`INSERT INTO platform_user_roles (user_id, role_key, created_at) VALUES (?, 'seller_admin', ?)`).bind(OWNER.id, t),
      C.prepare(`INSERT INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, NULL, ?, ?)`).bind(OWNER.email, OWNER.id, t),
    ])
  }
  await C.prepare(`INSERT OR IGNORE INTO institutions (id, name, short_name, slug, status, primary_color, d1_database_id, d1_binding, created_at, updated_at)
      VALUES (?, 'Slides Other School', 'SOS', 'slides-other', 'active', '#1e40af', 'tenant-test', 'TENANT_TEST', ?, ?)`).bind(OTHER, t, t).run()
  const p = async (id: string) => {
    const r = (await C.prepare('SELECT country, slug FROM institutions WHERE id = ?').bind(id).first<{ country: string; slug: string }>())!
    return `/${r.country}/${r.slug}`
  }
  path = await p(IDS.school)
  otherPath = await p(OTHER)
  owner = (await signIn(OWNER.email)).cookie!
  admin = (await signIn(USERS.admin)).cookie!
  expect(owner && admin).toBeTruthy()
})

describe('sign-in pictures', () => {
  let ids: string[] = []

  it('adds pictures and lists them in the order added', async () => {
    for (let i = 0; i < 3; i++) expect((await json(owner, 'POST', base(IDS.school), { data_url: PNG })).status).toBe(201)
    const r = await json(owner, 'GET', base(IDS.school))
    expect(r.status).toBe(200)
    expect(r.body.max).toBe(8)
    expect(r.body.items.map((s: any) => s.position)).toEqual([1, 2, 3])
    ids = r.body.items.map((s: any) => s.id)
    expect(r.body.items[0].url.startsWith(`${path}/slide/${ids[0]}?v=`)).toBe(true)
  })

  it('each one is served at its public address, and the brand lists them in order', async () => {
    const { brandOf, loginSlides } = await import('../../src/routes/login')
    const { institutionById } = await import('../../src/tenant')
    const inst = (await institutionById(E, IDS.school))!
    expect(brandOf(inst, path, await loginSlides(E, inst)).slides?.map((u) => u.split('?')[0])).toEqual(ids.map((id) => `${path}/slide/${id}`))
    const res = await call(`${path}/slide/${ids[0]}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('public')
  })

  it("another school's address does not serve this school's picture", async () => {
    expect((await call(`${otherPath}/slide/${ids[0]}`)).status).toBe(404)
  })

  it('reorders, and refuses an order that is not exactly the school\'s pictures', async () => {
    const order = [ids[2], ids[0], ids[1]]
    const r = await json(owner, 'PUT', `${base(IDS.school)}/order`, { ids: order })
    expect(r.status).toBe(200)
    expect(r.body.items.map((s: any) => s.id)).toEqual(order)
    expect((await json(owner, 'PUT', `${base(IDS.school)}/order`, { ids: order.slice(1) })).status).toBe(400)
    expect((await json(owner, 'PUT', `${base(IDS.school)}/order`, { ids: [ids[0], ids[0], ids[1]] })).status).toBe(400)
    ids = order
  })

  it('refuses a type that is not PNG, JPEG or WebP, and a picture over 1 MB', async () => {
    const svg = await json(owner, 'POST', base(IDS.school), { data_url: 'data:image/svg+xml;base64,' + btoa('<svg/>') })
    expect(svg.status).toBe(400)
    expect(svg.body.error ?? svg.body.message ?? JSON.stringify(svg.body)).toMatch(/PNG, JPEG or WebP/)
    const big = 'data:image/jpeg;base64,' + btoa('x'.repeat(1024 * 1024 + 10))
    expect((await json(owner, 'POST', base(IDS.school), { data_url: big })).status).toBe(400)
  })

  it('refuses the ninth picture with a plain message', async () => {
    for (let i = 3; i < 8; i++) expect((await json(owner, 'POST', base(IDS.school), { data_url: PNG })).status).toBe(201)
    const ninth = await json(owner, 'POST', base(IDS.school), { data_url: PNG })
    expect(ninth.status).toBe(400)
    expect(JSON.stringify(ninth.body)).toMatch(/8 sign-in pictures/)
  })

  it('removes a picture; it is gone from the list and the public address', async () => {
    const r = await json(owner, 'DELETE', `${base(IDS.school)}/${ids[0]}`)
    expect(r.status).toBe(200)
    expect(r.body.items.map((s: any) => s.id)).not.toContain(ids[0])
    expect(r.body.items).toHaveLength(7)
    expect((await call(`${path}/slide/${ids[0]}`)).status).toBe(404)
    expect((await json(owner, 'DELETE', `${base(OTHER)}/${ids[1]}`)).status).toBe(404)
  })

  it('a school user cannot reach the vendor routes', async () => {
    expect((await json(admin, 'GET', base(IDS.school))).status).toBe(403)
    expect((await json(admin, 'POST', base(IDS.school), { data_url: PNG })).status).toBe(403)
    expect((await json(admin, 'DELETE', `${base(IDS.school)}/${ids[1]}`)).status).toBe(403)
  })
})
