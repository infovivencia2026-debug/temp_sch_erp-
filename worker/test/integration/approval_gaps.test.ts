/* Approval gaps (2026-10-27): punch fixes and attendance corrections tell
   their deciders and appear only in the inbox of people who can decide them;
   nobody decides their own leave or approves their own concession; a
   concession decision must be approved or rejected. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, E, IDS, isoDay } from './fixture'

const T = () => E.TENANT_TEST
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const EMP_T = id(2701), EMP_A = id(2702), ATT = id(2703), LEAVE = id(2704), CONC = id(2705)
const note = (user: string, kind: string, src: string) =>
  T().prepare(`SELECT link FROM notifications WHERE user_id = ? AND kind = ? AND source_id = ?`).bind(user, kind, src).first<{ link: string }>()
const inbox = async (who: 'admin' | 'teacher' | 'finance') => (await api(who, 'GET', '/workflow/approvals')).body.items as Array<{ id: string; kind: string; decide_url: string }>

beforeAll(async () => {
  await seed()
  const cid = (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
  const adminRole = (await T().prepare(`SELECT id FROM roles WHERE key = 'institution_admin'`).first<{ id: string }>())!.id
  await T().batch([
    T().prepare(`INSERT OR IGNORE INTO employees (id, institution_id, campus_id, user_id, employee_code, first_name, status) VALUES (?, ?, ?, ?, 'E-AG1', 'Tara', 'active')`)
      .bind(EMP_T, IDS.school, cid, IDS.teacher),
    T().prepare(`INSERT OR IGNORE INTO employees (id, institution_id, campus_id, user_id, employee_code, first_name, status) VALUES (?, ?, ?, ?, 'E-AG2', 'Asha', 'active')`)
      .bind(EMP_A, IDS.school, cid, IDS.admin),
    T().prepare(`INSERT OR IGNORE INTO student_attendance (id, institution_id, student_id, section_id, on_date, status) VALUES (?, ?, ?, ?, ?, 'absent')`)
      .bind(ATT, IDS.school, IDS.child, IDS.section, isoDay(-2)),
    T().prepare(`INSERT OR IGNORE INTO leave_requests (id, institution_id, subject_kind, employee_id, from_date, to_date, days, reason, status, applied_by)
      VALUES (?, ?, 'staff', ?, ?, ?, 1, 'Family function', 'pending', ?)`).bind(LEAVE, IDS.school, EMP_A, isoDay(3), isoDay(3), IDS.admin),
    T().prepare(`INSERT OR IGNORE INTO fee_concessions (id, institution_id, student_id, kind, amount_paise, reason, status, requested_by)
      VALUES (?, ?, ?, 'sibling', 1000, 'Second child', 'pending', ?)`).bind(CONC, IDS.school, IDS.child, IDS.admin),
    // A second approver: finance also holds the admin role in this file.
    T().prepare(`INSERT INTO user_roles (id, institution_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), IDS.school, IDS.finance, adminRole, new Date().toISOString()),
  ])
})

describe('staff punch-fix requests', () => {
  let fix = ''
  it('the deciders are told, with a link to the Staff register', async () => {
    const r = await api('teacher', 'POST', '/hr/attendance-requests', { on_date: isoDay(-1), check_in: '08:50', reason: 'The reader at the gate was off' })
    expect(r.status).toBe(201)
    fix = r.body.id
    expect((await note(IDS.admin, 'attendance_fix_request', fix))?.link).toBe('/go/attendance/staff_register')
    expect(await note(IDS.teacher, 'attendance_fix_request', fix)).toBeNull()
  })
  it('shows in the inbox only of those who can decide it', async () => {
    const mine = (await inbox('admin')).find((i) => i.id === fix)
    expect(mine?.kind).toBe('attendance_fix')
    expect((await inbox('teacher')).some((i) => i.id === fix)).toBe(false)
    // The inbox's Approve goes to the existing decide route, and the asker is told.
    expect((await api('admin', 'POST', mine!.decide_url.replace('/api/v1', ''), { decision: 'approved' })).status).toBe(200)
    expect((await note(IDS.teacher, 'attendance_fix_decided', fix))?.link).toBe('/go/my_profile/leave_self_service')
    expect((await inbox('admin')).some((i) => i.id === fix)).toBe(false)
  })
})

describe('student attendance corrections', () => {
  it('the deciders are told, and only they see it in the inbox', async () => {
    const r = await api('teacher', 'POST', '/attendance-workflow/corrections', { attendance_id: ATT, to_status: 'present', reason: 'Was at the sports meet' })
    expect(r.status).toBe(201)
    expect((await note(IDS.admin, 'correction_request', r.body.id))?.link).toBe('/go/approvals/approvals')
    expect((await inbox('admin')).some((i) => i.id === r.body.id && i.kind === 'attendance_correction')).toBe(true)
    expect((await inbox('teacher')).some((i) => i.kind === 'attendance_correction')).toBe(false)
    expect((await api('teacher', 'POST', `/attendance-workflow/corrections/${r.body.id}/decide`, { decision: 'approved' })).status).toBe(403)
  })
})

describe('leave self-approval', () => {
  it('an approver cannot decide their own leave, another can', async () => {
    expect((await inbox('admin')).some((i) => i.id === LEAVE)).toBe(false)
    expect((await inbox('finance')).some((i) => i.id === LEAVE)).toBe(true)
    const r = await api('admin', 'POST', `/workflow/leave/${LEAVE}/decide`, { decision: 'approved' })
    expect(r.status).toBe(403)
    expect(JSON.stringify(r.body)).toContain('your own leave')
    expect((await api('finance', 'POST', `/workflow/leave/${LEAVE}/decide`, { decision: 'approved' })).status).toBe(200)
  })
})

describe('concession decide', () => {
  it('refuses a bad decision value and approving your own', async () => {
    expect((await api('admin', 'POST', `/workflow/concessions/${CONC}/decide`, { decision: 'maybe' })).status).toBe(400)
    expect((await api('admin', 'POST', `/workflow/concessions/${CONC}/decide`, {})).status).toBe(400)
    const own = await api('admin', 'POST', `/workflow/concessions/${CONC}/decide`, { decision: 'approved' })
    expect(own.status).toBe(403)
    expect(JSON.stringify(own.body)).toContain('someone else must approve')
    expect((await api('finance', 'POST', `/workflow/concessions/${CONC}/decide`, { decision: 'approved' })).status).toBe(200)
  })
})
