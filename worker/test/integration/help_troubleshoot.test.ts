/* Troubleshooters: checks about the caller, or about someone else only with the right permission; the one fix. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, E, IDS } from './fixture'

beforeAll(seed)
const failed = (r: any, name: string) => r.body.checks.find((c: any) => c.check === name)

describe('troubleshooters', () => {
  it('sign-in about yourself, and about someone else only with Logins and access', async () => {
    const me = await api('parent', 'GET', '/help/troubleshoot/sign_in')
    expect(me.status).toBe(200)
    expect(me.body.checks[0]).toMatchObject({ ok: true })
    expect((await api('parent', 'GET', '/help/troubleshoot/sign_in?who=teacher@test.school')).status).toBe(403)
    const t = await api('admin', 'GET', '/help/troubleshoot/sign_in?who=teacher@test.school')
    expect(t.body.about).toBe('Tara Teacher')
    expect(failed(t, 'Not locked out').ok).toBe(true)
    const none = await api('admin', 'GET', '/help/troubleshoot/sign_in?who=nobody@x.y')
    expect(none.body.checks[0].ok).toBe(false)
  })

  it('a lock is found and lifted by the administrator, never by a parent', async () => {
    await E.CONTROL.prepare(`INSERT OR REPLACE INTO login_throttle (key, failures, window_started_at, locked_until) VALUES ('id:teacher@test.school', 9, ?, ?)`)
      .bind(new Date().toISOString(), new Date(Date.now() + 600_000).toISOString()).run()
    const t = await api('admin', 'GET', '/help/troubleshoot/sign_in?who=teacher@test.school')
    expect(failed(t, 'Not locked out')).toMatchObject({ ok: false, fix: { action: 'unlock' } })
    expect((await api('parent', 'POST', '/help/troubleshoot/sign_in/fix', { who: 'teacher@test.school', action: 'unlock' })).status).toBe(403)
    expect((await api('admin', 'POST', '/help/troubleshoot/sign_in/fix', { who: 'teacher@test.school', action: 'unlock' })).status).toBe(200)
    expect(await E.CONTROL.prepare(`SELECT 1 FROM login_throttle WHERE key = 'id:teacher@test.school'`).first()).toBeNull()
  })

  it('messages, fees and attendance about your own children only', async () => {
    const m = await api('parent', 'GET', '/help/troubleshoot/messages')
    expect(m.body.checks.map((c: any) => c.check)).toContain('A mobile number is on record')
    expect((await api('parent', 'GET', '/help/troubleshoot/messages?who=other.parent@test.school')).status).toBe(403)
    const f = await api('parent', 'GET', '/help/troubleshoot/fee_receipt')
    expect(JSON.stringify(f.body)).toContain('Chirag')
    expect(JSON.stringify(f.body)).not.toContain('Diya')
    expect((await api('parent', 'GET', '/help/troubleshoot/fee_receipt?receipt=R-1')).status).toBe(403)
    const a = await api('parent', 'GET', '/help/troubleshoot/attendance?date=2026-01-05')
    expect(a.body.checks).toHaveLength(1)
    expect(a.body.checks[0].check).toContain('Chirag')
    const teacher = await api('teacher', 'GET', '/help/troubleshoot/attendance')
    expect(teacher.body.checks[0].check).toContain('Section A')
  })

  it('a screen: why it is not there', async () => {
    const s = await api('parent', 'GET', '/help/troubleshoot/screen?route=/institution_admin/help/helpdesk')
    expect(failed(s, 'You hold that role').ok).toBe(false)
    const own = await api('admin', 'GET', '/help/troubleshoot/screen?route=/institution_admin/help/helpdesk')
    expect(own.body.checks.every((c: any) => c.ok)).toBe(true)
    expect((await api('admin', 'GET', '/help/troubleshoot/screen?route=nonsense')).status).toBe(400)
    expect((await api('admin', 'GET', '/help/troubleshoot/everything')).status).toBe(400)
    expect((await api(null, 'GET', '/help/troubleshoot/sign_in')).status).toBe(401)
    void IDS
  })
})
