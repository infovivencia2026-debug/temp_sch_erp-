/* Who may change whose access, and the school reset. Each refusal from the
   users-and-access audit, the audit rows those changes write, and the
   throttles on forgot-password and SMS-gateway enrolment. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, signIn, IDS, E, USERS } from './fixture'

const T = () => E.TENANT_TEST
const audits = async (action: string, entity: string) =>
  Number((await T().prepare(`SELECT count(*) AS n FROM audit_log WHERE action = ? AND entity_id = ?`).bind(action, entity).first<{ n: number }>())!.n)
const statusOf = async (id: string) => (await T().prepare(`SELECT status FROM users WHERE id = ?`).bind(id).first<{ status: string }>())!.status
const ip = () => '198.51.100.' + Math.floor(Math.random() * 250)

beforeAll(async () => {
  await seed()
  /* Finance is a user manager here, without being a school administrator. */
  for (const k of ['access.users.write', 'access.users.read', 'access.roles.write']) {
    await T().prepare(`INSERT OR IGNORE INTO user_permissions (user_id, institution_id, permission_key, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(IDS.finance, IDS.school, k, IDS.admin, new Date().toISOString()).run()
  }
})

describe('PUT /admin/users/{id}/permissions', () => {
  it('refuses a key the granter does not hold', async () => {
    const r = await api('finance', 'PUT', `/admin/users/${IDS.teacher}/permissions`, { permission_keys: ['platform.audit.read', 'students.delete'] })
    expect(r.status).toBe(403)
  })
  it('allows a key the granter holds, and writes an audit row', async () => {
    const r = await api('finance', 'PUT', `/admin/users/${IDS.teacher}/permissions`, { permission_keys: ['access.users.read'] })
    expect(r.status).toBe(200)
    expect(await audits('user.permissions.set', IDS.teacher)).toBeGreaterThan(0)
    await api('admin', 'PUT', `/admin/users/${IDS.teacher}/permissions`, { permission_keys: [] })
  })
  it('refuses changing your own permissions', async () => {
    expect((await api('finance', 'PUT', `/admin/users/${IDS.finance}/permissions`, { permission_keys: ['access.users.read'] })).status).toBe(403)
    expect((await api('admin', 'PUT', `/admin/users/${IDS.admin}/permissions`, { permission_keys: [] })).status).toBe(403)
  })
  it("refuses a non-administrator changing an administrator's permissions", async () => {
    expect((await api('finance', 'PUT', `/admin/users/${IDS.admin}/permissions`, { permission_keys: [] })).status).toBe(403)
  })
})

describe('roles, reset and suspend', () => {
  it('refuses a non-administrator granting the administrator role', async () => {
    expect((await api('finance', 'PUT', `/admin/users/${IDS.teacher}/roles`, { role_keys: ['institution_admin'] })).status).toBe(403)
  })
  it('refuses a non-administrator resetting or suspending an administrator', async () => {
    expect((await api('finance', 'POST', `/admin/users/${IDS.admin}/reset-password`)).status).toBe(403)
    expect((await api('finance', 'PUT', `/admin/users/${IDS.admin}/status`, { status: 'suspended' })).status).toBe(403)
  })
  it('refuses resetting your own password through the admin route', async () => {
    expect((await api('finance', 'POST', `/admin/users/${IDS.finance}/reset-password`)).status).toBe(403)
    expect((await api('admin', 'POST', `/admin/users/${IDS.admin}/reset-password`)).status).toBe(403)
  })
  it('a reset keeps a suspended account suspended, and both changes are audited', async () => {
    expect((await api('admin', 'PUT', `/admin/users/${IDS.parent}/status`, { status: 'suspended' })).status).toBe(200)
    expect(await audits('user.status.set', IDS.parent)).toBeGreaterThan(0)
    const r = await api('admin', 'POST', `/admin/users/${IDS.parent}/reset-password`, { new_password: 'a brand new password 1' })
    expect(r.status).toBe(200)
    expect(await statusOf(IDS.parent)).toBe('suspended')
    expect(await audits('user.password.reset', IDS.parent)).toBeGreaterThan(0)
  })
})

describe('POST /setup/logins/bulk', () => {
  it('keeps suspended accounts suspended, signs everyone out, and audits each reset', async () => {
    const other = await signIn(USERS.otherParent)
    expect(other.cookie).toBeTruthy()
    const r = await api('admin', 'POST', '/setup/logins/bulk', { kind: 'guardians', reset: true })
    expect(r.status).toBe(200)
    expect(await statusOf(IDS.parent)).toBe('suspended')
    expect(await statusOf(IDS.otherParent)).toBe('active')
    expect(await audits('user.password.reset', IDS.otherParent)).toBeGreaterThan(0)
    const after = await call('/api/v1/catalog', { cookie: other.cookie! })
    expect(after.status).toBe(401)
  })
  it('asks for the password again when the sign-in is old', async () => {
    const s = await signIn(USERS.admin)
    await E.CONTROL.prepare(`UPDATE sessions SET created_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
      .bind(new Date(Date.now() - 3600_000).toISOString(), IDS.admin).run()
    const r = await call('/api/v1/setup/logins/bulk', { method: 'POST', cookie: s.cookie!, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'guardians', reset: true }) })
    expect(r.status).toBe(403)
    expect(((await r.json()) as any).code ?? '').toContain('reauth')
  })
})

describe('import undo', () => {
  it('writes an audit row', async () => {
    const run = crypto.randomUUID()
    await T().prepare(`INSERT INTO import_runs (id, institution_id, entity, imported_by) VALUES (?, ?, 'students', ?)`).bind(run, IDS.school, IDS.admin).run()
    const s = await signIn(USERS.admin)
    const r = await call(`/api/v1/setup/import/history/${run}/undo`, { method: 'POST', cookie: s.cookie! })
    expect(r.status).toBe(200)
    expect(await audits('import.undo', run)).toBe(1)
  })
})

describe('forgot password', () => {
  const ask = (identifier: string, from: string) => call('/forgot', { method: 'POST', body: new URLSearchParams({ identifier }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': from } })
  it('says the same thing whether or not the account exists', async () => {
    const a = await (await ask(USERS.teacher, ip())).text()
    const b = await (await ask('nobody-' + crypto.randomUUID() + '@nowhere.test', ip())).text()
    expect(a).toContain('If the account exists')
    expect(b).toContain('If the account exists')
  })
  it('is rate-limited per identifier', async () => {
    const who = 'limit-' + crypto.randomUUID() + '@nowhere.test'
    const codes: number[] = []
    for (let i = 0; i < 5; i++) codes.push((await ask(who, ip())).status)
    expect(codes.slice(0, 3)).toEqual([200, 200, 200])
    expect(codes[4]).toBe(429)
  })
  it('is rate-limited per address', async () => {
    const from = ip()
    let last = 0
    for (let i = 0; i < 12; i++) last = (await ask('x-' + crypto.randomUUID() + '@nowhere.test', from)).status
    expect(last).toBe(429)
  })
})

describe('SMS gateway enrolment', () => {
  it('locks the identifier after repeated wrong passwords, as /login does', async () => {
    const enrol = (password: string) => call('/api/v1/public/sms-gateway/enrol', { method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip() }, body: JSON.stringify({ phone: USERS.finance, password }) })
    for (let i = 0; i < 8; i++) expect((await enrol('wrong password ' + i)).status).not.toBe(200)
    expect((await enrol('wrong again')).status).toBe(429)
    await E.CONTROL.prepare(`DELETE FROM login_throttle WHERE key = ?`).bind('id:' + USERS.finance).run()
  })
})

/* Last: it empties the school. */
describe('POST /setup/reset', () => {
  const school = async () => (await T().prepare(`SELECT name FROM institutions WHERE id = ?`).bind(IDS.school).first<{ name: string }>())!.name
  it('is refused to anyone but a school administrator', async () => {
    const r = await api('finance', 'POST', '/setup/reset', { confirm: await school() })
    expect(r.status).toBe(403)
  })
  it('is refused while the school is in use, and the attempt is audited', async () => {
    const s = await signIn(USERS.admin)
    const r = await call('/api/v1/setup/reset', { method: 'POST', cookie: s.cookie!, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: await school() }) })
    expect(r.status).toBe(409)
    expect(await audits('school.reset.refused', IDS.school)).toBeGreaterThan(0)
    expect(Number((await T().prepare(`SELECT count(*) AS n FROM invoices`).first<{ n: number }>())!.n)).toBeGreaterThan(0)
  })
  it('asks for the password again on an old sign-in, then empties an unused school and keeps the audit trail', async () => {
    await T().batch([T().prepare(`DELETE FROM invoice_lines`), T().prepare(`DELETE FROM payments`), T().prepare(`DELETE FROM invoices`)])
    const stale = await signIn(USERS.admin)
    await E.CONTROL.prepare(`UPDATE sessions SET created_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
      .bind(new Date(Date.now() - 3600_000).toISOString(), IDS.admin).run()
    const body = JSON.stringify({ confirm: await school() })
    const refused = await call('/api/v1/setup/reset', { method: 'POST', cookie: stale.cookie!, headers: { 'content-type': 'application/json' }, body })
    expect(refused.status).toBe(403)
    const fresh = await signIn(USERS.admin)
    const r = await call('/api/v1/setup/reset', { method: 'POST', cookie: fresh.cookie!, headers: { 'content-type': 'application/json' }, body })
    expect(r.status).toBe(200)
    expect(Number((await T().prepare(`SELECT count(*) AS n FROM students`).first<{ n: number }>())!.n)).toBe(0)
    expect(await audits('school.reset', IDS.school)).toBe(1)
    expect(await audits('user.status.set', IDS.parent)).toBeGreaterThan(0)
  })
})
