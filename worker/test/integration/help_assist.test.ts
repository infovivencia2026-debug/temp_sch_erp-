/* Quick Assist: a code from the person, read-only access for the desk, a banner and End now, the school's register. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, signIn, IDS, E, PASSWORD } from './fixture'
import { hashPassword } from '../../src/auth/password'

const AGENT = { id: '00000000-0000-4000-8000-0000000000b3', email: 'assist@vendor.test' }
let agent = ''
const as = async (method: string, path: string, body?: unknown, acting = false) => {
  const headers: Record<string, string> = body === undefined ? {} : { 'content-type': 'application/json' }
  if (acting) headers['x-acting-institution'] = IDS.school
  const res = await call('/api/v1' + path, { method, cookie: agent, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text(); let b: any = text; try { b = JSON.parse(text) } catch { /* text */ }
  return { status: res.status, body: b }
}
beforeAll(async () => {
  await seed()
  const C = E.CONTROL
  if (!(await C.prepare('SELECT 1 FROM platform_users WHERE id = ?').bind(AGENT.id).first())) {
    const t = new Date().toISOString(), hash = await hashPassword(E.PASSWORD_PEPPER, PASSWORD)
    await C.batch([
      C.prepare(`INSERT INTO platform_users (id, email, full_name, password_hash, status, created_at, updated_at) VALUES (?, ?, 'Ajay Assist', ?, 'active', ?, ?)`).bind(AGENT.id, AGENT.email, hash, t, t),
      C.prepare(`INSERT INTO platform_user_roles (user_id, role_key, created_at) VALUES (?, 'support_admin', ?)`).bind(AGENT.id, t),
      C.prepare(`INSERT INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, NULL, ?, ?)`).bind(AGENT.email, AGENT.id, t),
    ])
  }
  agent = (await signIn(AGENT.email)).cookie!
})

describe('quick assist', () => {
  it('refuses a wrong code, an expired code, a used code, and a school account at the desk', async () => {
    expect((await as('POST', '/admin/platform/assist/redeem', { code: '12' })).status).toBe(400)
    const c = (await api('teacher', 'POST', '/help/assist/code')).body
    expect(c.code).toMatch(/^\d{6}$/)
    expect((await api('admin', 'POST', '/admin/platform/assist/redeem', { code: c.code })).status).toBe(403)
    await E.CONTROL.prepare(`UPDATE assist_codes SET expires_at = ? WHERE code = ?`).bind(new Date(Date.now() - 1000).toISOString(), c.code).run()
    expect((await as('POST', '/admin/platform/assist/redeem', { code: c.code })).status).toBe(404)
    await E.CONTROL.prepare(`DELETE FROM assist_attempts`).run()
  })

  it('a good code starts a read-only session the person sees and the school can read', async () => {
    expect((await api('parent', 'POST', '/help/assist/code')).status).toBe(403)
    const c = (await api('finance', 'POST', '/help/assist/code')).body
    // Without the code, the support login is outside the school.
    expect((await as('GET', '/admin/platform/support/tickets', undefined, true)).status).not.toBe(200)
    const g = await as('POST', '/admin/platform/assist/redeem', { code: c.code })
    expect(g.status).toBe(201)
    expect(g.body).toMatchObject({ institution_id: IDS.school, person: 'Farah Finance', read_only: true })
    expect((await as('POST', '/admin/platform/assist/redeem', { code: c.code })).status).toBe(404) // once
    // Inside, reading works and every write is refused.
    expect((await as('GET', '/admin/platform/support/tickets', undefined, true)).status).toBe(200)
    const w = await as('POST', '/admin/platform/support/tickets', { category: 'other', subject: 's', body: 'b' }, true)
    expect(w.status).toBe(403)
    expect(w.body.code).toBe('read_only_session')
    // The person sees it, and the school's register lists it with who agreed.
    const mine = await api('finance', 'GET', '/help/assist/active')
    expect(mine.body.session).toMatchObject({ id: g.body.id, operator: 'Ajay Assist' })
    expect((await api('teacher', 'GET', '/help/assist/active')).body.session).toBeUndefined()
    const reg = await api('admin', 'GET', '/admin/platform/impersonation')
    expect(reg.body.items.find((x: any) => x.id === g.body.id)).toMatchObject({ read_only: true, consented_by: 'Farah Finance', live: true })
    // Only the person ends it from the banner; then the desk is outside again.
    expect((await api('teacher', 'POST', `/help/assist/${g.body.id}/end`)).status).toBe(404)
    expect((await api('finance', 'POST', `/help/assist/${g.body.id}/end`)).status).toBe(200)
    expect((await as('GET', '/admin/platform/support/tickets', undefined, true)).status).not.toBe(200)
  })

  it('ten wrong codes and the desk must wait', async () => {
    for (let i = 0; i < 10; i++) await as('POST', '/admin/platform/assist/redeem', { code: '000000' })
    expect((await as('POST', '/admin/platform/assist/redeem', { code: '000000' })).status).toBe(429)
    await E.CONTROL.prepare(`DELETE FROM assist_attempts`).run()
  })
})
