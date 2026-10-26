/* Staff sign in with just their phone number (the username without its
   ".CODE"), or their school email (an active Staff Inbox address), on the
   school's own page; "number.CODE" keeps working. On the shared page a bare
   number held by two schools with one password is ambiguous. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, call, E, IDS, PASSWORD } from './fixture'
import { hashPassword } from '../../src/auth/password'

const TWO = { school: '00000000-0000-4000-8000-0000000000c1', user: '00000000-0000-4000-8000-0000000000c2' }
const MINE = '00000000-0000-4000-8000-0000000000c3'
const MAILER = '00000000-0000-4000-8000-0000000000c4'
const OFFMAIL = '00000000-0000-4000-8000-0000000000c5'
const PHONE = '9000000771'

beforeAll(async () => {
  await seed()
  const C = E.CONTROL
  if (await C.prepare('SELECT 1 FROM institutions WHERE id = ?').bind(TWO.school).first()) return
  const t = new Date().toISOString()
  const hash = await hashPassword(E.PASSWORD_PEPPER, PASSWORD)
  const row = (await C.prepare('SELECT * FROM institutions WHERE id = ?').bind(IDS.school).first<Record<string, unknown>>())!
  Object.assign(row, { id: TWO.school, slug: 'twoschool', name: 'Two School', custom_domain: null, app_id: null })
  const cols = Object.keys(row)
  await C.prepare(`INSERT INTO institutions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map((k) => row[k] ?? null)).run()
  const user = (id: string, username: string | null, name: string) => E.TENANT_TEST.prepare(`INSERT INTO users (id, institution_id, username, full_name, password_hash, status, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)`).bind(id, IDS.school, username, name, hash, t, t)
  await E.TENANT_TEST.batch([
    user(MINE, `${PHONE}.TEST`, 'Pavan Phone'), user(TWO.user, `${PHONE}.TWOS`, 'Twin Phone'),
    user(MAILER, null, 'Mala Mail'), user(OFFMAIL, null, 'Off Mail'),
    E.TENANT_TEST.prepare(`INSERT INTO mail_addresses (id, user_id, address, status) VALUES ('ma-1', ?, 'mala@test.school', 'active')`).bind(MAILER),
    E.TENANT_TEST.prepare(`INSERT INTO mail_addresses (id, user_id, address, status) VALUES ('ma-2', ?, 'off@test.school', 'disabled')`).bind(OFFMAIL),
  ])
  const idx = (v: string, inst: string, u: string) => C.prepare(`INSERT INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('username', ?, ?, ?, ?)`).bind(v, inst, u, t)
  await C.batch([
    idx(`${PHONE}.TEST`, IDS.school, MINE), idx(`${PHONE}.TWOS`, TWO.school, TWO.user),
    C.prepare(`INSERT OR IGNORE INTO mail_domains (domain, institution_id) VALUES ('test.school', ?)`).bind(IDS.school),
  ])
})

const at = (host: string, path: string, init: RequestInit & { cookie?: string } = {}) =>
  call(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), 'x-forwarded-host': host } })

async function signInAt(host: string, identifier: string, password = PASSWORD, tab = '') {
  const page = await at(host, '/login')
  const csrf = (page.headers.get('set-cookie') ?? '').match(/erp_csrf=([^;]+)/)![1]
  const token = (await page.text()).match(/name="csrf_token"\s+value="([^"]+)"/)![1]
  const res = await at(host, '/login', {
    method: 'POST', cookie: `erp_csrf=${csrf}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '198.51.100.' + Math.floor(Math.random() * 250) },
    body: new URLSearchParams({ identifier, password, csrf_token: token, next: '/', ...(tab ? { tab } : {}) }),
  })
  return { res, session: /erp_session=[^;]+/.test(res.headers.get('set-cookie') ?? ''), text: res.status === 303 ? '' : await res.text() }
}

describe('staff sign in with a plain phone number or school email', () => {
  it('bare number on the school page signs in', async () => {
    expect((await signInAt('test.xulo.in', PHONE)).session).toBe(true)
  })
  it('number.CODE no longer signs in, even with the right password', async () => {
    const r = await signInAt('test.xulo.in', `${PHONE}.TEST`, PASSWORD, 'staff')
    expect(r.session).toBe(false)
    expect(r.text).toContain('That school email or phone number and password do not match')
    expect((await signInAt('school-erp-d1.pages.dev', `${PHONE}.TEST`)).session).toBe(false)
    expect((await signInAt('xulo.in', `${PHONE}.TEST`)).session).toBe(false) // vendor page takes no school accounts
  })
  it('wrong password fails', async () => {
    const r = await signInAt('test.xulo.in', PHONE, 'not the password')
    expect(r.session).toBe(false)
    expect(r.res.status).toBe(401)
  })
  it('bare number on the shared page held by two schools is ambiguous', async () => {
    const r = await signInAt('school-erp-d1.pages.dev', PHONE)
    expect(r.session).toBe(false)
    expect(r.text).toContain('more than one school')
  })
  it('school email signs in, on the school page and on the shared page', async () => {
    expect((await signInAt('test.xulo.in', 'mala@test.school')).session).toBe(true)
    expect((await signInAt('school-erp-d1.pages.dev', 'Mala@Test.School')).session).toBe(true)
  })
  it('a disabled school email does not sign in', async () => {
    expect((await signInAt('test.xulo.in', 'off@test.school')).session).toBe(false)
  })
  it('tabs ask parents for a phone (tel keypad) and staff for school email or phone', async () => {
    const h = await (await at('test.xulo.in', '/login')).text()
    expect(h).toMatch(/"label":"Phone number"[^}]*"mode":"tel"/)
    expect(h).toMatch(/"label":"School email or phone number"[^}]*"mode":"text"/)
    expect(h).toContain('Admission number')
  })
  it('wrong details are told in the words of the tab used', async () => {
    expect((await signInAt('test.xulo.in', PHONE, 'nope', 'staff')).text).toContain('That school email or phone number and password do not match')
    expect((await signInAt('test.xulo.in', '9000000999', 'nope', 'parent')).text).toContain('That phone number and password do not match')
    expect((await signInAt('test.xulo.in', 'A-1', 'nope')).text).toContain('That username, email or phone and password do not match')
  })
  it('the forgotten-password page uses the tab words', async () => {
    const p = await (await call('/forgot?tab=parent')).text()
    expect(p).toContain('<label for="identifier">Phone number</label>')
    expect(p).toContain('inputmode="tel"')
    expect(await (await call('/forgot?tab=staff')).text()).toContain('<label for="identifier">School email or phone number</label>')
    expect(await (await call('/forgot')).text()).toContain('<label for="identifier">Email, username or phone</label>')
  })
})
