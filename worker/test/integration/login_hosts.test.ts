/* Which address shows which sign-in page, and whose accounts it takes
   (tenant.ts siteOf, routes/login.ts loginAt). SCHOOL_DOMAIN is xulo.in in
   the test config; the seeded school's slug is "test". The host comes in
   x-forwarded-host, as the Pages proxy passes it. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, call, E, IDS, PASSWORD, USERS } from './fixture'
import { hashPassword } from '../../src/auth/password'

const OTHER = { school: '00000000-0000-4000-8000-0000000000b1', user: '00000000-0000-4000-8000-0000000000b2', email: 'office@other.school' }
const VENDOR = { id: '00000000-0000-4000-8000-0000000000b3', email: 'ops@vendor.hosts' }

beforeAll(async () => {
  await seed()
  const C = E.CONTROL
  if (await C.prepare('SELECT 1 FROM institutions WHERE id = ?').bind(OTHER.school).first()) return
  const t = new Date().toISOString()
  const hash = await hashPassword(E.PASSWORD_PEPPER, PASSWORD)
  /* A second school sharing the test tenant database: login_index names it, which is all
     sign-in reads (the tenant row keeps the seeded school's id for its foreign key). */
  const row = (await C.prepare('SELECT * FROM institutions WHERE id = ?').bind(IDS.school).first<Record<string, unknown>>())!
  Object.assign(row, { id: OTHER.school, slug: 'other', name: 'Other School', custom_domain: null, app_id: null })
  const cols = Object.keys(row)
  await C.prepare(`INSERT INTO institutions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map((k) => row[k] ?? null)).run()
  await E.TENANT_TEST.prepare(`INSERT INTO users (id, institution_id, email, full_name, password_hash, status, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, 'Omar Office', ?, 'active', 0, ?, ?)`).bind(OTHER.user, IDS.school, OTHER.email, hash, t, t).run()
  await C.batch([
    C.prepare(`INSERT INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, ?, ?, ?)`).bind(OTHER.email, OTHER.school, OTHER.user, t),
    C.prepare(`INSERT INTO platform_users (id, email, full_name, password_hash, status, created_at, updated_at) VALUES (?, ?, 'Vera Vendor', ?, 'active', ?, ?)`)
      .bind(VENDOR.id, VENDOR.email, hash, t, t),
    C.prepare(`INSERT INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, NULL, ?, ?)`).bind(VENDOR.email, VENDOR.id, t),
  ])
})

const at = (host: string, path: string, init: RequestInit & { cookie?: string } = {}) =>
  call(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), 'x-forwarded-host': host } })

/** GET then POST /login on one host, as a browser would. */
async function signInAt(host: string, identifier: string) {
  const page = await at(host, '/login')
  const csrf = (page.headers.get('set-cookie') ?? '').match(/erp_csrf=([^;]+)/)![1]
  const token = (await page.text()).match(/name="csrf_token"\s+value="([^"]+)"/)![1]
  const res = await at(host, '/login', {
    method: 'POST', cookie: `erp_csrf=${csrf}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '198.51.100.' + Math.floor(Math.random() * 250) },
    body: new URLSearchParams({ identifier, password: PASSWORD, csrf_token: token, next: '/' }),
  })
  return { res, session: /erp_session=[^;]+/.test(res.headers.get('set-cookie') ?? '') }
}

describe('sign-in by host', () => {
  it("shows a school's own page on <slug>.xulo.in", async () => {
    const res = await at('test.xulo.in', '/login')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Test Public School')
  })

  it("refuses another school's account on a school's address", async () => {
    const { res, session } = await signInAt('test.xulo.in', OTHER.email)
    expect(res.status).toBe(401)
    expect(session).toBe(false)
  })

  it("takes that school's own account there", async () => {
    const { res, session } = await signInAt('test.xulo.in', USERS.teacher)
    expect(res.status).toBe(303)
    expect(session).toBe(true)
  })

  it('asks for the school code on school.xulo.in', async () => {
    const res = await at('school.xulo.in', '/login')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('name="code"')
    expect(html).not.toContain('name="password"')
  })

  it("sends a known code to the school's address, keeping next", async () => {
    const res = await at('school.xulo.in', '/login?code=Test&next=%2Ffees')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://test.xulo.in/login?next=%2Ffees')
  })

  it('says plainly when no school uses a code', async () => {
    const res = await at('school.xulo.in', '/login?code=nosuch')
    expect(res.status).toBe(404)
    const html = await res.text()
    expect(html).toContain('No school uses the code nosuch. Check it with the school office.')
    expect(html).toContain('name="code"')
  })

  it('refuses a school account on xulo.in and points to the school address', async () => {
    const { res, session } = await signInAt('xulo.in', USERS.teacher)
    expect(res.status).toBe(403)
    expect(session).toBe(false)
    expect(await res.text()).toContain('school.xulo.in')
  })

  it('takes a platform account on xulo.in and www.xulo.in', async () => {
    expect((await signInAt('xulo.in', VENDOR.email)).session).toBe(true)
    expect((await signInAt('www.xulo.in', VENDOR.email)).session).toBe(true)
  })

  it('keeps every account on a shared host', async () => {
    expect((await signInAt('school-erp-d1.pages.dev', OTHER.email)).session).toBe(true)
    expect((await signInAt('school-erp-d1.pages.dev', VENDOR.email)).session).toBe(true)
    expect((await signInAt('school-erp-d1.pages.dev', USERS.teacher)).session).toBe(true)
  })

  it('treats reserved labels as shared hosts, not schools', async () => {
    const res = await at('app.xulo.in', '/login')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('name="password"')
  })
})
