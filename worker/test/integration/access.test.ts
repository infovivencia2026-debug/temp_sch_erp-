/* Who may read what: a parent reaches only their own child, roles without a
   permission get 403, and a school that is not paying gets 402. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

beforeAll(seed)

describe('a parent', () => {
  it('sees only their own child in the portal', async () => {
    const { status, body } = await api('parent', 'GET', '/portal/students')
    expect(status).toBe(200)
    expect(body.items.map((s: any) => s.student_id)).toEqual([IDS.child])
  })

  it("cannot read another family's child's attendance", async () => {
    const { status } = await api('parent', 'GET', `/portal/attendance?student_id=${IDS.otherChild}`)
    expect(status).toBe(404)
  })

  it("cannot read another family's fee ledger", async () => {
    const own = await api('parent', 'GET', `/fees/students/${IDS.child}/ledger`)
    expect(own.status).toBe(200)
    const other = await api('parent', 'GET', `/fees/students/${IDS.otherChild}/ledger`)
    expect(other.status).toBe(404)
  })

  it("cannot open another child's profile", async () => {
    const { status } = await api('parent', 'GET', `/students/${IDS.otherChild}/profile`)
    expect(status).toBe(403)
  })
})

describe('permissions', () => {
  it('403s fee collection for a class teacher', async () => {
    const { status } = await api('teacher', 'POST', '/fees/payments', { student_id: IDS.child, amount_paise: 100, mode: 'cash' })
    expect(status).toBe(403)
  })

  it('403s the finance dashboard for a parent (group permission)', async () => {
    const { status } = await api('parent', 'GET', '/finance/dashboard')
    expect(status).toBe(403)
  })

  it('403s marking attendance for the finance office', async () => {
    const { status } = await api('finance', 'POST', '/attendance', { section_id: IDS.section, entries: [{ student_id: IDS.child, status: 'present' }] })
    expect(status).toBe(403)
  })

  it('403s enqueueing jobs for a teacher', async () => {
    const { status } = await api('teacher', 'POST', '/jobs', { type: 'export:build', payload: { kind: 'students' } })
    expect(status).toBe(403)
  })
})

describe('subscription gate', () => {
  const setStatus = (s: string, trialEnds: string | null = null) =>
    E.CONTROL.prepare('UPDATE subscriptions SET status = ?, trial_ends_on = COALESCE(?, trial_ends_on) WHERE institution_id = ?').bind(s, trialEnds, IDS.school).run()

  it('402s a suspended school, but still answers the session', async () => {
    await setStatus('suspended')
    try {
      const res = await api('admin', 'GET', '/students')
      expect(res.status).toBe(402)
      expect(res.body.code).toBe('subscription_suspended')
      expect((await api('admin', 'GET', '/session')).status).toBe(200)
    } finally { await setStatus('trial') }
  })

  it('402s a trial that has ended', async () => {
    await setStatus('trial', '2000-01-01')
    try {
      const res = await api('admin', 'GET', '/students')
      expect(res.status).toBe(402)
      expect(res.body.code).toBe('subscription_expired')
    } finally { await E.CONTROL.prepare(`UPDATE subscriptions SET trial_ends_on = '2999-12-31' WHERE institution_id = ?`).bind(IDS.school).run() }
  })

  it('opens again once active', async () => {
    await setStatus('active')
    expect((await api('admin', 'GET', '/students')).status).toBe(200)
  })
})
