/* The vendor's own people. A seller administrator hires, re-roles, resets and
   lets go of platform staff from the console; a support login reaches its
   ticket queue and nothing that edits tenants; and a support login stands
   inside a school only on a recorded, time-limited session. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, signIn, IDS, E, PASSWORD } from './fixture'
import { hashPassword } from '../../src/auth/password'

const OWNER = { id: '00000000-0000-4000-8000-0000000000a1', email: 'owner@vendor.test' }
let owner = ''

const json = async (cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await call('/api/v1' + path, {
    method, cookie,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = text
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: parsed }
}

beforeAll(async () => {
  await seed()
  const C = E.CONTROL
  if (!(await C.prepare('SELECT 1 FROM platform_users WHERE id = ?').bind(OWNER.id).first())) {
    const t = new Date().toISOString()
    const hash = await hashPassword(E.PASSWORD_PEPPER, PASSWORD)
    await C.batch([
      C.prepare(`INSERT INTO platform_users (id, email, full_name, password_hash, status, created_at, updated_at) VALUES (?, ?, 'Olive Owner', ?, 'active', ?, ?)`)
        .bind(OWNER.id, OWNER.email, hash, t, t),
      C.prepare(`INSERT INTO platform_user_roles (user_id, role_key, created_at) VALUES (?, 'seller_admin', ?)`).bind(OWNER.id, t),
      C.prepare(`INSERT INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, NULL, ?, ?)`).bind(OWNER.email, OWNER.id, t),
    ])
  }
  const s = await signIn(OWNER.email)
  if (!s.cookie) throw new Error(`owner sign-in failed: ${s.res.status}`)
  owner = s.cookie
})

describe('platform staff', () => {
  let supportId = '', support = '', supportEmail = `sam.${Date.now()}@vendor.test`

  it('lists the team, marking the caller', async () => {
    const r = await json(owner, 'GET', '/seller/staff')
    expect(r.status).toBe(200)
    const me = r.body.items.find((x: any) => x.id === OWNER.id)
    expect(me).toMatchObject({ you: true, roles: ['seller_admin'], status: 'active' })
  })

  it('creates a support login with a one-time password that signs in', async () => {
    const r = await json(owner, 'POST', '/seller/staff', { full_name: 'Sam Support', email: supportEmail, role: 'support_admin' })
    expect(r.status).toBe(201)
    expect(r.body.role).toBe('support_admin')
    expect(String(r.body.temporary_password).length).toBeGreaterThan(7)
    supportId = r.body.user_id
    const s = await signIn(supportEmail, r.body.temporary_password)
    expect(s.cookie).toBeTruthy()
    support = s.cookie!
  })

  it('refuses a second account on the same email, and an unknown role', async () => {
    expect((await json(owner, 'POST', '/seller/staff', { full_name: 'Sam Again', email: supportEmail })).status).toBe(409)
    expect((await json(owner, 'POST', '/seller/staff', { full_name: 'Sue Super', email: 'sue@vendor.test', role: 'super_admin' })).status).toBe(400)
  })

  it('a support login cannot manage staff', async () => {
    expect((await json(support, 'GET', '/seller/staff')).status).toBe(403)
    expect((await json(support, 'POST', '/seller/staff', { full_name: 'X', email: 'x@vendor.test', role: 'seller_admin' })).status).toBe(403)
  })

  it('a support login is shown its one screen, the queue, and none of the console', async () => {
    const cat = await json(support, 'GET', '/catalog')
    expect(cat.status).toBe(200)
    const keys: string[] = cat.body.roles.flatMap((r: any) => r.sections.flatMap((s: any) => s.features.map((f: any) => f.key)))
    expect(keys).toContain('seller_admin.support.support')
    expect(keys).not.toContain('seller_admin.schools.schools')
    expect(keys).not.toContain('seller_admin.support.support_team')
  })

  it('a support login reaches the ticket queue, with what was promised, and takes a ticket by name', async () => {
    const raised = await api('admin', 'POST', '/admin/platform/support/tickets', { category: 'other', subject: 'Fee receipt will not print', body: 'Since this morning.', priority: 'high' })
    expect(raised.status).toBe(201)
    const q = await json(support, 'GET', '/admin/platform/seller/tickets')
    expect(q.status).toBe(200)
    const t = q.body.items.find((x: any) => x.id === raised.body.id)
    expect(t).toBeTruthy()
    expect(typeof t.promised_hours).toBe('number')
    expect(t.promised_hours).toBeGreaterThan(0)
    expect(t.breached).toBe(false)
    expect((await json(support, 'POST', `/admin/platform/seller/tickets/${raised.body.id}`, { status: 'in_progress' })).status).toBe(200)
    const after = (await json(support, 'GET', '/admin/platform/seller/tickets')).body.items.find((x: any) => x.id === raised.body.id)
    expect(after).toMatchObject({ status: 'in_progress', assigned_to: 'Sam Support' })
  })

  it('a support login is outside every school until a session is recorded, then inside that one', async () => {
    const inSchool = { 'x-acting-institution': IDS.school }
    // The school's own ticket list needs a school in scope.
    const before = await json(support, 'GET', '/admin/platform/support/tickets', undefined, inSchool)
    expect(before.status).not.toBe(200)
    expect((await json(support, 'POST', '/admin/platform/impersonation', { institution_id: IDS.school, reason: 'no' })).status).toBe(400)
    const g = await json(support, 'POST', '/admin/platform/impersonation', { institution_id: IDS.school, reason: 'Reproducing the receipt printing fault', minutes: 60 })
    expect(g.status).toBe(201)
    expect(g.body).toMatchObject({ operator: 'Sam Support', live: true })
    const during = await json(support, 'GET', '/admin/platform/support/tickets', undefined, inSchool)
    expect(during.status).toBe(200)
    // The school's administrator can see who is inside, and end it.
    const seen = await api('admin', 'GET', '/admin/platform/impersonation')
    expect(seen.status).toBe(200)
    expect(seen.body.items.some((x: any) => x.id === g.body.id && x.live)).toBe(true)
    expect((await api('admin', 'POST', `/admin/platform/impersonation/${g.body.id}/end`)).status).toBe(200)
    const after = await json(support, 'GET', '/admin/platform/support/tickets', undefined, inSchool)
    expect(after.status).not.toBe(200)
  })

  it('nobody changes their own access, and the last seller administrator stays', async () => {
    expect((await json(owner, 'POST', `/seller/staff/${OWNER.id}/status`, { status: 'suspended', reason: 'testing' })).status).toBe(400)
    expect((await json(owner, 'POST', `/seller/staff/${OWNER.id}/role`, { role: 'support_admin' })).status).toBe(400)
  })

  it('suspending signs them out at once; reactivating, re-roling and a reset work and are recorded', async () => {
    expect((await json(owner, 'POST', `/seller/staff/${supportId}/status`, { status: 'suspended' })).status).toBe(400) // no reason
    expect((await json(owner, 'POST', `/seller/staff/${supportId}/status`, { status: 'suspended', reason: 'Left the company' })).status).toBe(200)
    expect((await json(support, 'GET', '/admin/platform/seller/tickets')).status).toBe(401)
    expect((await signIn(supportEmail, 'whatever-it-was')).cookie).toBeNull()

    expect((await json(owner, 'POST', `/seller/staff/${supportId}/status`, { status: 'active' })).status).toBe(200)
    const reset = await json(owner, 'POST', `/seller/staff/${supportId}/password`, {})
    expect(reset.status).toBe(200)
    const again = await signIn(supportEmail, reset.body.temporary_password)
    expect(again.cookie).toBeTruthy()

    expect((await json(owner, 'POST', `/seller/staff/${supportId}/role`, { role: 'seller_admin' })).status).toBe(200)
    // The role change ended their sessions; with the new role they manage staff.
    expect((await json(again.cookie!, 'GET', '/seller/staff')).status).toBe(401)
    const promoted = await signIn(supportEmail, reset.body.temporary_password)
    expect((await json(promoted.cookie!, 'GET', '/seller/staff')).status).toBe(200)
    // Two operators now, so the first may be demoted by the second, but not by themselves.
    expect((await json(promoted.cookie!, 'POST', `/seller/staff/${OWNER.id}/role`, { role: 'support_admin' })).status).toBe(200)
    expect((await json(promoted.cookie!, 'POST', `/seller/staff/${OWNER.id}/role`, { role: 'seller_admin' })).status).toBe(200)

    const ev = await E.CONTROL.prepare(`SELECT detail FROM platform_events WHERE kind = 'staff_account' ORDER BY at`).all<{ detail: string }>()
    const details = ev.results.map((e) => e.detail).join(' | ')
    expect(details).toContain('support_admin created')
    expect(details).toContain('suspended: Left the company')
    expect(details).toContain('reactivated')
    expect(details).toContain('password reset')
    expect(details).toContain('role support_admin -> seller_admin')
  })
})
