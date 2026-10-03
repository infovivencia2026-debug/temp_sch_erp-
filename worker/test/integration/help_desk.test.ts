/* The vendor's desk: context beside a ticket, bulk take/close/merge, and help content kept once for every school. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, signIn, IDS, E, PASSWORD } from './fixture'
import { hashPassword } from '../../src/auth/password'

const AGENT = { id: '00000000-0000-4000-8000-0000000000b2', email: 'desk2@vendor.test' }
let agent = ''
const as = async (method: string, path: string, body?: unknown) => {
  const res = await call('/api/v1' + path, { method, cookie: agent, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text(); let b: any = text; try { b = JSON.parse(text) } catch { /* text */ }
  return { status: res.status, body: b }
}
beforeAll(async () => {
  await seed()
  const C = E.CONTROL
  if (!(await C.prepare('SELECT 1 FROM platform_users WHERE id = ?').bind(AGENT.id).first())) {
    const t = new Date().toISOString(), hash = await hashPassword(E.PASSWORD_PEPPER, PASSWORD)
    await C.batch([
      C.prepare(`INSERT INTO platform_users (id, email, full_name, password_hash, status, created_at, updated_at) VALUES (?, ?, 'Devi Desk', ?, 'active', ?, ?)`).bind(AGENT.id, AGENT.email, hash, t, t),
      C.prepare(`INSERT INTO platform_user_roles (user_id, role_key, created_at) VALUES (?, 'support_admin', ?)`).bind(AGENT.id, t),
      C.prepare(`INSERT INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, NULL, ?, ?)`).bind(AGENT.email, AGENT.id, t),
    ])
  }
  agent = (await signIn(AGENT.email)).cookie!
})

describe('the desk', () => {
  let a = '', b = ''
  it('lists vendor tickets with the school id and the promise from the shared policy', async () => {
    a = (await api('admin', 'POST', '/help/requests', { category: 'slow', body: 'Reports are slow to open.' })).body.id
    b = (await api('admin', 'POST', '/help/requests', { category: 'slow', body: 'The report page takes a minute.' })).body.id
    const q = await as('GET', '/admin/platform/seller/tickets')
    const t = q.body.items.find((x: any) => x.id === a)
    expect(t).toMatchObject({ institution_id: IDS.school, promised_hours: 72 })
  })
  it('reads the context beside a ticket', async () => {
    const c = await as('GET', `/admin/platform/desk/${IDS.school}/tickets/${a}/context`)
    expect(c.status).toBe(200)
    expect(c.body.school).toMatchObject({ id: IDS.school, name: 'Test Public School' })
    expect(c.body.raised_by.roles).toBeTruthy()
    expect((await api('admin', 'GET', `/admin/platform/desk/${IDS.school}/tickets/${a}/context`)).status).toBe(403)
  })
  it('bulk take, merge within a school, close; refuses across schools and nonsense', async () => {
    expect((await as('POST', '/admin/platform/desk/bulk', { action: 'take', items: [{ school: IDS.school, id: a }, { school: IDS.school, id: b }] })).body.done).toBe(2)
    expect((await as('POST', '/admin/platform/desk/bulk', { action: 'merge', items: [{ school: IDS.school, id: b }], into: { school: crypto.randomUUID(), id: a } })).status).toBe(400)
    expect((await as('POST', '/admin/platform/desk/bulk', { action: 'delete', items: [{ school: IDS.school, id: b }] })).status).toBe(400)
    expect((await as('POST', '/admin/platform/desk/bulk', { action: 'merge', items: [{ school: IDS.school, id: b }], into: { school: IDS.school, id: a } })).body.done).toBe(1)
    const merged = await E.TENANT_TEST.prepare('SELECT status, merged_into FROM support_tickets WHERE id = ?').bind(b).first<any>()
    expect(merged).toMatchObject({ status: 'closed', merged_into: a })
    expect((await api('admin', 'GET', `/help/requests/${b}`)).body.thread.at(-1).body).toContain('Reports are slow')
    expect((await as('POST', '/admin/platform/desk/bulk', { action: 'close', items: [{ school: IDS.school, id: a }] })).body.done).toBe(1)
    expect((await api('admin', 'POST', '/admin/platform/desk/bulk', { action: 'close', items: [{ school: IDS.school, id: a }] })).status).toBe(403)
  })
  it('content: edit an article for every school, hide one, add a canned reply, reset; checked', async () => {
    const list = await as('GET', '/admin/platform/help-content/article')
    expect(list.body.items.find((x: any) => x.item.key === 'change_password').source).toBe('default')
    expect((await as('PUT', '/admin/platform/help-content/article/change_password', { data: { title: 'Change your password now', topic: 'sign_in', body: 'Open your account.', roles: [] } })).status).toBe(200)
    expect((await api('parent', 'GET', '/help/articles')).body.items.find((x: any) => x.key === 'change_password').title).toBe('Change your password now')
    expect((await as('PUT', '/admin/platform/help-content/article/me_too', { data: { title: 'x', topic: 'other', body: 'y', roles: [] }, hidden: true })).status).toBe(200)
    expect((await api('parent', 'GET', '/help/articles')).body.items.some((x: any) => x.key === 'me_too')).toBe(false)
    expect((await as('PUT', '/admin/platform/help-content/article/bad', { data: { title: 'no body' } })).status).toBe(400)
    expect((await as('PUT', '/admin/platform/help-content/sla/policy', { data: { respond_hours: 10, resolve_hours: 5 } })).status).toBe(400)
    expect((await as('PUT', '/admin/platform/help-content/canned/hello', { data: { title: 'Hello', body: 'Hello {{name}}' } })).status).toBe(200)
    expect((await as('GET', '/admin/platform/help-content/canned')).body.items.some((x: any) => x.item.key === 'hello' && x.source === 'added')).toBe(true)
    expect((await as('DELETE', '/admin/platform/help-content/article/change_password')).status).toBe(200)
    expect((await as('DELETE', '/admin/platform/help-content/article/me_too')).status).toBe(200)
    expect((await api('parent', 'GET', '/help/articles')).body.items.find((x: any) => x.key === 'change_password').title).toBe('Change your password')
    expect((await api('admin', 'PUT', '/admin/platform/help-content/canned/x', { data: { title: 'a', body: 'b' } })).status).toBe(403)
    expect((await as('GET', '/admin/platform/help-content/secrets')).status).toBe(404)
  })
})
