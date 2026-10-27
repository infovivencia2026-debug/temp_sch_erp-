/* Payroll maker-checker (owner, 2026-10-27): the institution admin (the
   principal) approves a month's payroll before it is published. Here the
   admin login is the maker; the teacher login is given institution_admin as a
   second principal who did not prepare it. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

beforeAll(seed, 180_000)

const T = () => E.TENANT_TEST
const emp = crypto.randomUUID()
const M = 9, Y = 2026
const LINK = `/go/monthly_payroll?month=${M}&year=${Y}`

async function setUp() {
  const cid = (await T().prepare('SELECT id FROM campuses ORDER BY created_at LIMIT 1').first<{ id: string }>())!.id
  const adminRole = (await T().prepare(`SELECT id FROM roles WHERE key = 'institution_admin'`).first<{ id: string }>())!.id
  const ss = crypto.randomUUID()
  await T().batch([
    T().prepare(`INSERT INTO employees (id, institution_id, campus_id, employee_code, first_name, user_id, status) VALUES (?, ?, ?, 'PA-1', 'Farah', ?, 'active')`)
      .bind(emp, IDS.school, cid, IDS.finance),
    T().prepare(`INSERT INTO salary_structures (id, institution_id, employee_id, effective_from, ctc_paise) VALUES (?, ?, ?, '2026-04-01', 2000000)`).bind(ss, IDS.school, emp),
    T().prepare(`INSERT OR IGNORE INTO salary_components (id, institution_id, code, name, kind, sequence) VALUES (?, ?, 'BASIC', 'Basic pay', 'earning', 1)`)
      .bind(crypto.randomUUID(), IDS.school),
    T().prepare(`INSERT INTO salary_structure_items (id, institution_id, salary_structure_id, component_id, amount_paise)
        SELECT ?, ?, ?, id, 2000000 FROM salary_components WHERE institution_id = ? AND code = 'BASIC'`).bind(crypto.randomUUID(), IDS.school, ss, IDS.school),
    T().prepare(`INSERT INTO user_roles (id, institution_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), IDS.school, IDS.teacher, adminRole, new Date().toISOString()),
  ])
  const r = await api('admin', 'POST', '/payroll/run', { month: M, year: Y, acknowledge_unmarked_attendance: true, acknowledge_unpaid_staff: true })
  expect(r.status).toBe(200)
  expect((await api('admin', 'POST', '/payroll/state', { month: M, year: Y, to: 'locked' })).status).toBe(200)
}

const notes = (user: string, kind: string) => T().prepare(`SELECT title, body, link FROM notifications WHERE user_id = ? AND kind = ? ORDER BY created_at`)
  .bind(user, kind).all<{ title: string; body: string; link: string }>().then((r) => r.results)
const runId = async () => (await api('admin', 'GET', `/payroll/approval?month=${M}&year=${Y}`)).body.run_id as string

describe('payroll approval', () => {
  beforeAll(setUp, 180_000)

  it('publishing without approval returns 409', async () => {
    expect((await api('admin', 'POST', '/payroll/state', { month: M, year: Y, to: 'paid' })).status).toBe(200)
    const r = await api('admin', 'POST', '/payroll/state', { month: M, year: Y, to: 'published' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('not_approved')
    expect(await notes(IDS.finance, 'payslip')).toEqual([])
  }, 180_000)

  it('submit notifies the other institution admin with a link to the month, not the maker', async () => {
    const r = await api('admin', 'POST', '/payroll/submit', { month: M, year: Y })
    expect(r.status).toBe(200)
    expect(r.body.notified).toBeGreaterThanOrEqual(1)
    const got = await notes(IDS.teacher, 'payroll_approval')
    expect(got.length).toBe(1)
    expect(got[0].link).toBe(LINK)
    expect(got[0].title).toContain('September 2026')
    expect(await notes(IDS.admin, 'payroll_approval')).toEqual([])
    expect((await api('admin', 'POST', '/payroll/submit', { month: M, year: Y })).status).toBe(409)
    // Shown in the principal's Approvals inbox, not the maker's.
    const rid = await runId()
    const inbox = await api('teacher', 'GET', '/workflow/approvals')
    expect(inbox.body.items.some((i: any) => i.kind === 'payroll' && i.decide_url === `/api/v1/payroll/runs/${rid}/decide`)).toBe(true)
    const mine = await api('admin', 'GET', '/workflow/approvals')
    expect((mine.body.items ?? []).some((i: any) => i.kind === 'payroll')).toBe(false)
  }, 180_000)

  it('the maker cannot approve, and neither can a non-admin', async () => {
    const id = await runId()
    const maker = await api('admin', 'POST', `/payroll/runs/${id}/decide`, { decision: 'approved' })
    expect(maker.status).toBe(403)
    const fin = await api('finance', 'POST', `/payroll/runs/${id}/decide`, { decision: 'approved' })
    expect(fin.status).toBe(403)
  }, 180_000)

  it('send back needs a note, returns the month to draft and tells the maker the note', async () => {
    const id = await runId()
    expect((await api('teacher', 'POST', `/payroll/runs/${id}/decide`, { decision: 'rejected' })).status).toBe(400)
    const r = await api('teacher', 'POST', `/payroll/runs/${id}/decide`, { decision: 'rejected', note: 'Recheck the bonus for Farah' })
    expect(r.status).toBe(200)
    const got = await notes(IDS.admin, 'payroll_sent_back')
    expect(got.length).toBe(1)
    expect(got[0].body).toBe('Recheck the bonus for Farah')
    expect(got[0].link).toBe(LINK)
    const st = await T().prepare(`SELECT status, approval_state FROM payroll_runs WHERE id = ?`).bind(id).first<{ status: string; approval_state: string | null }>()
    expect(st).toEqual({ status: 'draft', approval_state: null })
  }, 180_000)

  it('approve, then publish sends the payslips; a second approval is 409', async () => {
    expect((await api('admin', 'POST', '/payroll/state', { month: M, year: Y, to: 'locked' })).status).toBe(200)
    expect((await api('admin', 'POST', '/payroll/submit', { month: M, year: Y })).status).toBe(200)
    const id = await runId()
    const ok = await api('teacher', 'POST', `/payroll/runs/${id}/decide`, { decision: 'approved' })
    expect(ok.status).toBe(200)
    expect((await api('teacher', 'POST', `/payroll/runs/${id}/decide`, { decision: 'approved' })).status).toBe(409)
    const told = await notes(IDS.admin, 'payroll_approved')
    expect(told.length).toBe(1)
    expect(told[0].link).toBe(LINK)
    expect((await api('admin', 'POST', '/payroll/state', { month: M, year: Y, to: 'paid' })).status).toBe(200)
    const pub = await api('admin', 'POST', '/payroll/state', { month: M, year: Y, to: 'published' })
    expect(pub.status).toBe(200)
    expect(pub.body.notified).toBe(1)
    const slip = await notes(IDS.finance, 'payslip')
    expect(slip.length).toBe(1)
    expect(slip[0].link).toBe('/go/my_profile/my_pay')
  }, 180_000)
})
