/* Leave bells reach the right people with links they can open (audit, 2026-11-12). */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, isoDay, E } from './fixture'

beforeAll(seed)
const T = () => E.TENANT_TEST
const link = (user: string, id: string) =>
  T().prepare(`SELECT link FROM notifications WHERE user_id = ? AND source_id = ? AND kind = ?`)

describe('leave bell routing', { timeout: 90_000 }, () => {
  it('a child\'s leave sends the class teacher to Student leave requests, the head to Approvals, the parent back to their screen', async () => {
    const sent = await api('parent', 'POST', '/workflow/leave', { student_id: IDS.child, from_date: isoDay(20), to_date: isoDay(20), reason: 'bell routing' })
    expect(sent.status).toBe(201)
    const id = sent.body.id as string
    const teacher = await link(IDS.teacher, id).bind(IDS.teacher, id, 'leave_request').first<{ link: string }>()
    expect(teacher?.link).toBe('/go/my_profile/student_leave_requests')
    const head = await link(IDS.admin, id).bind(IDS.admin, id, 'leave_request').first<{ link: string }>()
    expect(head?.link).toBe('/go/approvals/approvals')
    expect((await api('admin', 'POST', `/workflow/leave/${id}/decide`, { decision: 'approved' })).status).toBe(200)
    const parent = await link(IDS.parent, id).bind(IDS.parent, id, 'leave_decided').first<{ link: string }>()
    expect(parent?.link).toBe('/go/leave_absence/apply_student_leave')
  })

  it('a staff leave also rings someone granted hr.leave.approve directly', async () => {
    await T().prepare(`INSERT OR IGNORE INTO user_permissions (user_id, institution_id, permission_key) VALUES (?, ?, 'hr.leave.approve')`).bind(IDS.finance, IDS.school).run()
    const cid = (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
    await T().prepare(`INSERT OR IGNORE INTO employees (id, institution_id, campus_id, user_id, employee_code, first_name) VALUES ('00000000-0000-4000-8000-000000001401', ?, ?, ?, 'E-LB1', 'Tara')`)
      .bind(IDS.school, cid, IDS.teacher).run()
    const sent = await api('teacher', 'POST', '/workflow/leave', { from_date: isoDay(30), to_date: isoDay(30), reason: 'direct grant' })
    expect(sent.status).toBe(201)
    const row = await link(IDS.finance, sent.body.id).bind(IDS.finance, sent.body.id, 'leave_request').first<{ link: string }>()
    expect(row).not.toBeNull()
  })
})
