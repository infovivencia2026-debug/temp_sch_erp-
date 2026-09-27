/* Sign-in through POST /login and the session the web app reads. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, signIn, api, call, USERS, IDS, E } from './fixture'

beforeAll(seed)

describe('sign-in', () => {
  it('answers /healthz without a session', async () => {
    const res = await call('/healthz')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('signs in with the right password and sets an HttpOnly session cookie', async () => {
    const { res, cookie } = await signIn(USERS.admin)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/')
    expect(cookie).toMatch(/^erp_session=/)
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/)
    const ev = await E.CONTROL.prepare(`SELECT outcome FROM login_events WHERE identifier = ? ORDER BY at DESC LIMIT 1`).bind(USERS.admin).first<{ outcome: string }>()
    expect(ev?.outcome).toBe('ok')
  })

  it('refuses a wrong password with 401 and no cookie', async () => {
    const { res, cookie } = await signIn(USERS.teacher, 'not the password')
    expect(res.status).toBe(401)
    expect(cookie).toBeNull()
  })

  it('refuses a POST without the CSRF cookie', async () => {
    const res = await call('/login', { method: 'POST', body: new URLSearchParams({ identifier: USERS.admin, password: 'x', csrf_token: 'forged' }) })
    expect(res.status).toBe(403)
  })

  it('returns the session shape the web app reads', async () => {
    const { status, body } = await api('admin', 'GET', '/session')
    expect(status).toBe(200)
    expect(body.authenticated).toBe(true)
    expect(body.user).toMatchObject({ id: IDS.admin, full_name: 'Asha Admin', roles: ['institution_admin'], platform_admin: false })
    expect(body.institution).toMatchObject({ id: IDS.school, slug: 'test', timezone: 'Asia/Kolkata' })
    expect(body.permissions).toEqual(expect.arrayContaining(['students.read', 'finance.payments.write']))
    expect(body).toHaveProperty('modules')
    expect(body).toHaveProperty('subscription')
  })

  it('gives a parent only the self-service permissions', async () => {
    const { body } = await api('parent', 'GET', '/session')
    expect(body.user.roles).toEqual(['parent'])
    expect(body.permissions).toContain('self.profile.read')
    expect(body.permissions).not.toContain('students.read')
  })

  it('401s an API call with no session', async () => {
    const { status } = await api(null, 'GET', '/students')
    expect(status).toBe(401)
  })

  it('ends the session on /logout', async () => {
    const { cookie } = await signIn(USERS.finance)
    const out = await call('/logout', { cookie: cookie! })
    expect(out.status).toBe(303)
    const res = await call('/api/v1/students', { cookie: cookie! })
    expect(res.status).toBe(401)
  })
})
