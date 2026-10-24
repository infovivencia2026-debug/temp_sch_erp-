/* Staff leave self service (Yajur, 2026-10-24): the Kind of leave picker only
   offers the types this person was given, and a request the head approves
   reads approved in the applicant's own list straight away. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, isoDay, E } from './fixture'

beforeAll(seed)
const T = () => E.TENANT_TEST
const uuid = (n: number) => `00000000-0000-4000-8000-${String(1300 + n).padStart(12, '0')}`

describe('leave self service', () => {
  const given = uuid(10), other = uuid(11), emp = uuid(1)
  beforeAll(async () => {
    const cid = (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
    const year = (await T().prepare('SELECT id FROM academic_years WHERE is_current = 1 LIMIT 1').first<{ id: string }>())!.id
    await T().batch([
      T().prepare(`INSERT OR IGNORE INTO employees (id, institution_id, campus_id, user_id, employee_code, first_name) VALUES (?, ?, ?, ?, 'E-LS1', 'Tara')`)
        .bind(emp, IDS.school, cid, IDS.teacher),
      T().prepare(`INSERT INTO leave_types (id, institution_id, name, code, applies_to, annual_quota) VALUES (?, ?, 'Casual Leave', 'LS-CL', 'staff', '12')`).bind(given, IDS.school),
      T().prepare(`INSERT INTO leave_types (id, institution_id, name, code, applies_to, annual_quota) VALUES (?, ?, 'Study Leave', 'LS-SL', 'staff', '5')`).bind(other, IDS.school),
      T().prepare(`INSERT INTO leave_balances (institution_id, leave_type_id, employee_id, academic_year_id, entitled, taken) VALUES (?, ?, ?, ?, '12', '3')`)
        .bind(IDS.school, given, emp, year),
    ])
  })

  it('lists only the types this person holds, with what is left', async () => {
    const r = await api('teacher', 'GET', '/hr/leave-types?for=mine')
    expect(r.status).toBe(200)
    expect(r.body.items.map((t: { id: string }) => t.id)).toEqual([given])
    expect(r.body.items[0].remaining).toBe(9)
    const all = await api('admin', 'GET', '/hr/leave-types?applies_to=staff')
    expect(all.body.items.map((t: { id: string }) => t.id)).toContain(other)
  })

  it('shows approved in the applicant\'s own list once approved', async () => {
    const sent = await api('teacher', 'POST', '/workflow/leave', { leave_type_id: given, from_date: isoDay(10), to_date: isoDay(10), reason: 'Testing' })
    expect(sent.status).toBe(201)
    const row = await T().prepare(`SELECT id FROM leave_requests WHERE employee_id = ? AND reason = 'Testing'`).bind(emp).first<{ id: string }>()
    expect((await api('admin', 'POST', `/workflow/leave/${row!.id}/decide`, { decision: 'approved' })).status).toBe(200)
    const mine = await api('teacher', 'GET', '/hr/leave?for=mine')
    const it = mine.body.items.find((l: { id: string }) => l.id === row!.id)
    expect(it.status).toBe('approved')
    const pending = await api('teacher', 'GET', '/hr/leave?for=mine&status=pending')
    expect(pending.body.items.some((l: { id: string }) => l.id === row!.id)).toBe(false)
  })
})
