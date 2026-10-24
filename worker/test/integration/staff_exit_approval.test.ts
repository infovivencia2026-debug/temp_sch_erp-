/* Staff exit approval (owner, 2026-10-23): HR sends an exit once every
   department has signed; only the institution admin approves it. Approving
   relieves the person, suspends their login and signs out their sessions;
   rejecting needs a note and goes back to HR. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, as, call, E, IDS } from './fixture'

const T = () => E.TENANT_TEST
const EMP = '00000000-0000-4000-8000-000000000501'
let exitID = ''

beforeAll(async () => {
  await seed()
  const t = new Date().toISOString()
  const campus = (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
  const hr = (await T().prepare(`SELECT id FROM roles WHERE key = 'hr'`).first<{ id: string }>())!.id
  await T().batch([
    // The accounts user also keeps the staff records here: the HR desk in these tests.
    T().prepare(`INSERT OR IGNORE INTO user_roles (id, institution_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), IDS.school, IDS.finance, hr, t),
    T().prepare(`INSERT OR IGNORE INTO employees (id, institution_id, campus_id, employee_code, first_name, last_name, user_id, status, joined_on)
      VALUES (?, ?, ?, 'EXIT1', 'Tara', 'Teacher', ?, 'active', '2020-06-01')`).bind(EMP, IDS.school, campus, IDS.teacher),
    T().prepare(`INSERT OR IGNORE INTO clearance_departments (institution_id, code, name) VALUES (?, 'LIB', 'Library')`).bind(IDS.school),
  ])
})

const signAll = async () => {
  const list = await api('finance', 'GET', `/hr/exits/${exitID}/clearances`)
  for (const c of list.body.items) {
    const r = await api('finance', 'POST', `/hr/exits/${exitID}/clearances`, { department_code: c.code, status: 'cleared', dues_paise: 0 })
    expect(r.status).toBe(200)
  }
}

describe('staff exit approval', () => {
  it('HR cannot send before every department signs, nor relieve directly', async () => {
    const teacherCookie = await as('teacher') // a live session, to be signed out on approval
    expect(teacherCookie).toBeTruthy()
    const open = await api('finance', 'POST', '/hr/exits', { employee_id: EMP, kind: 'resignation' })
    expect(open.status).toBe(201)
    exitID = open.body.id
    expect((await api('finance', 'POST', `/hr/exits/${exitID}/send-for-approval`, {})).status).toBe(409)
    await signAll()
    expect((await api('finance', 'POST', `/hr/exits/${exitID}/relieve`, {})).status).toBe(403)
    expect((await api('finance', 'POST', `/hr/exits/${exitID}/settle`, { settlement_paise: 1000 })).status).toBe(409)
  })

  it('sending notifies the institution admin and puts it in their Approvals', async () => {
    const sent = await api('finance', 'POST', `/hr/exits/${exitID}/send-for-approval`, {})
    expect(sent.status).toBe(200)
    expect(sent.body.status).toBe('pending_approval')
    expect((await api('finance', 'POST', `/hr/exits/${exitID}/send-for-approval`, {})).status).toBe(409)
    const note = await T().prepare(`SELECT link FROM notifications WHERE user_id = ? AND kind = 'staff_exit_approval' AND source_id = ?`)
      .bind(IDS.admin, exitID).first<{ link: string }>()
    expect(note?.link).toBe('/go/approvals/approvals')
    const inbox = await api('admin', 'GET', '/workflow/approvals')
    const item = inbox.body.items.find((i: { id: string }) => i.id === exitID)
    expect(item?.kind).toBe('staff_exit')
    expect(item?.decide_url).toBe(`/api/v1/hr/exits/${exitID}/decide`)
    // Clearances are frozen while it waits.
    expect((await api('finance', 'POST', `/hr/exits/${exitID}/clearances`, { department_code: 'LIB', status: 'dues', dues_paise: 100 })).status).toBe(409)
  })

  it('only the institution admin decides, and a rejection needs a note', async () => {
    expect((await api('finance', 'POST', `/hr/exits/${exitID}/decide`, { decision: 'approved' })).status).toBe(403)
    expect((await api('admin', 'POST', `/hr/exits/${exitID}/decide`, { decision: 'maybe' })).status).toBe(400)
    expect((await api('admin', 'POST', `/hr/exits/${exitID}/decide`, { decision: 'rejected' })).status).toBe(400)
    const back = await api('admin', 'POST', `/hr/exits/${exitID}/decide`, { decision: 'rejected', note: 'Library card not returned' })
    expect(back.status).toBe(200)
    expect(back.body.status).toBe('returned')
    const told = await T().prepare(`SELECT link FROM notifications WHERE user_id = ? AND kind = 'staff_exit_decided' AND source_id = ?`)
      .bind(IDS.finance, exitID).first<{ link: string }>()
    expect(told?.link).toContain(`exit=${exitID}`)
    expect((await api('admin', 'POST', `/hr/exits/${exitID}/decide`, { decision: 'approved' })).status).toBe(409)
    const list = await api('finance', 'GET', '/hr/exits?open=true')
    expect(list.body.items.find((x: { id: string }) => x.id === exitID)?.decision_note).toBe('Library card not returned')
  })

  it('approval relieves them, suspends the login, signs them out and keeps the record', async () => {
    const teacherCookie = await as('teacher')
    expect((await api('finance', 'POST', `/hr/exits/${exitID}/send-for-approval`, {})).status).toBe(200)
    const ok = await api('admin', 'POST', `/hr/exits/${exitID}/decide`, { decision: 'approved', note: 'Thank you for six years' })
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('relieved')
    expect(ok.body.login_suspended).toBe(true)
    const emp = await T().prepare(`SELECT status, relieved_on FROM employees WHERE id = ?`).bind(EMP).first<{ status: string; relieved_on: string }>()
    expect(emp?.status).toBe('resigned')
    expect(emp?.relieved_on).toBeTruthy()
    const u = await T().prepare(`SELECT status FROM users WHERE id = ?`).bind(IDS.teacher).first<{ status: string }>()
    expect(u?.status).toBe('suspended')
    const live = await E.CONTROL.prepare(`SELECT count(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL`).bind(IDS.teacher).first<{ n: number }>()
    expect(live?.n).toBe(0)
    expect((await call('/api/v1/students', { cookie: teacherCookie })).status).toBe(401)
    // Out of "in progress", still readable, and now the settlement can be paid.
    const open = await api('finance', 'GET', '/hr/exits?open=true')
    expect(open.body.items.some((x: { id: string }) => x.id === exitID)).toBe(false)
    expect((await api('finance', 'GET', `/hr/employees/${EMP}/detail`)).status).toBe(200)
    expect((await api('finance', 'POST', `/hr/exits/${exitID}/settle`, { settlement_paise: 1000 })).status).toBe(200)
    // The admin's pending notification is done once decided.
    expect((await api('admin', 'POST', `/hr/exits/${exitID}/decide`, { decision: 'approved' })).status).toBe(409)
  })
})
