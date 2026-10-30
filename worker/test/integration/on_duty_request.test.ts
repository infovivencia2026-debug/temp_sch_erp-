/* On duty / outside work (owner, 2026-10-26): a staff member files it like
   leave; the leave approver is told; approved, the day reads on_duty and the
   6 PM auto-absent skips it; pending is skipped too; rejected is not. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'
import { runStaffAutoAbsent } from '../../src/services/background/staff_auto_absent'

const T = () => E.TENANT_TEST
const TZ = 'Asia/Kolkata'
const MON = '2026-10-26', TUE = '2026-10-27', WED = '2026-10-28'
const at1800 = (d: string) => Date.parse(d + 'T12:30:00Z')
const emp = '00000000-0000-4000-8000-000000001401'
const mark = (day: string) => T().prepare(`SELECT status, source FROM staff_attendance WHERE user_id = ? AND on_date = ?`).bind(IDS.teacher, day).first<{ status: string; source: string }>()
const reset = () => T().prepare(`DELETE FROM cron_runs WHERE name = 'staff_auto_absent:done'`).run()

beforeAll(async () => {
  await seed()
  const cid = (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
  await T().batch([
    T().prepare(`INSERT OR IGNORE INTO employees (id, institution_id, campus_id, user_id, employee_code, first_name, status) VALUES (?, ?, ?, ?, 'E-OD1', 'Tara', 'active')`)
      .bind(emp, IDS.school, cid, IDS.teacher),
    T().prepare(`DELETE FROM staff_attendance WHERE user_id = ? AND on_date IN (?, ?, ?)`).bind(IDS.teacher, MON, TUE, WED),
    T().prepare(`INSERT INTO module_settings (institution_id, module, enabled, config) VALUES (?, 'staff_auto_absent', 1, json_object('time', '18:00'))
      ON CONFLICT (institution_id, module) DO UPDATE SET enabled = 1, config = excluded.config`).bind(IDS.school),
  ])
})

describe('on duty request', () => {
  it('refuses without a place; others cannot edit', async () => {
    expect((await api('teacher', 'POST', '/workflow/leave', { kind: 'on_duty', from_date: WED, to_date: WED, reason: 'Exam duty' })).status).toBe(400)
    const r = await api('teacher', 'POST', '/workflow/leave', { kind: 'on_duty', from_date: WED, to_date: WED, reason: 'Exam duty', place: 'Board office', from_time: '10:00', to_time: '14:00' })
    expect(r.status).toBe(201)
    expect((await api('admin', 'PATCH', '/workflow/leave/' + r.body.id, { reason: 'Not mine' })).status).toBe(404)
    const ed = await api('teacher', 'PATCH', '/workflow/leave/' + r.body.id, { place: 'District office' })
    expect(ed.status).toBe(200)
    const row = await T().prepare('SELECT place, from_time, kind, leave_type_id FROM leave_requests WHERE id = ?').bind(r.body.id).first()
    expect(row).toMatchObject({ place: 'District office', from_time: '10:00', kind: 'on_duty', leave_type_id: null })
    // Pending: auto-absent skips the day.
    await reset()
    await runStaffAutoAbsent(T(), IDS.school, TZ, at1800(WED))
    expect(await mark(WED)).toBeNull()
  })

  it('approver is told; approved marks on_duty and auto-absent skips', async () => {
    const r = await api('teacher', 'POST', '/workflow/leave', { kind: 'on_duty', from_date: MON, to_date: MON, reason: 'Sports meet', place: 'Stadium' })
    expect(r.status).toBe(201)
    const n = await T().prepare(`SELECT title, link FROM notifications WHERE source_id = ? AND user_id = ?`).bind(r.body.id, IDS.admin).first<{ title: string; link: string }>()
    expect(n?.title).toContain('on duty')
    expect(n?.link).toBe('/go/approvals/approvals')
    const inbox = await api('admin', 'GET', '/workflow/approvals')
    expect(JSON.stringify(inbox.body)).toContain('On duty at Stadium')
    expect((await api('admin', 'POST', `/workflow/leave/${r.body.id}/decide`, { decision: 'approved', note: 'ok' })).status).toBe(200)
    expect(await mark(MON)).toMatchObject({ status: 'on_duty', source: 'on_duty' })
    const told = await T().prepare(`SELECT title FROM notifications WHERE source_id = ? AND user_id = ?`).bind(r.body.id, IDS.teacher).first<{ title: string }>()
    expect(told?.title).toBe('Your on-duty request was approved')
    await reset()
    await runStaffAutoAbsent(T(), IDS.school, TZ, at1800(MON))
    expect(await mark(MON)).toMatchObject({ status: 'on_duty' })
  })

  it('rejected: auto-absent marks absent', async () => {
    const r = await api('teacher', 'POST', '/workflow/leave', { kind: 'on_duty', from_date: TUE, to_date: TUE, reason: 'Visit', place: 'Bank' })
    expect(r.status).toBe(201)
    expect((await api('admin', 'POST', `/workflow/leave/${r.body.id}/decide`, { decision: 'rejected', note: 'no' })).status).toBe(200)
    expect(await mark(TUE)).toBeNull()
    await reset()
    await runStaffAutoAbsent(T(), IDS.school, TZ, at1800(TUE))
    expect(await mark(TUE)).toMatchObject({ status: 'absent', source: 'auto_absent' })
  })

  it('approval never overwrites an existing mark', async () => {
    const day = '2026-10-29'
    await T().prepare(`INSERT OR REPLACE INTO staff_attendance (institution_id, user_id, on_date, status, source) VALUES (?, ?, ?, 'present', 'manual')`).bind(IDS.school, IDS.teacher, day).run()
    const r = await api('teacher', 'POST', '/workflow/leave', { kind: 'on_duty', from_date: day, to_date: day, reason: 'x', place: 'y' })
    await api('admin', 'POST', `/workflow/leave/${r.body.id}/decide`, { decision: 'approved' })
    expect(await mark(day)).toMatchObject({ status: 'present', source: 'manual' })
  })
})
