import { beforeAll, beforeEach, expect, it } from 'vitest'
import { E, IDS, seed } from './fixture'
import { runStaffAutoAbsent } from '../../src/services/background/staff_auto_absent'

/* Staff with no punch marked absent at 18:00 school time (owner, 2026-10-26). */
const T = () => E.TENANT_TEST
const TZ = 'Asia/Kolkata'
const MON = '2026-10-26'
const at = (iso: string) => Date.parse(iso)
const MON_1800 = at('2026-10-26T12:30:00Z')
let campus = ''
let dev = ''

async function staff(name: string): Promise<{ uid: string; eid: string }> {
  const uid = crypto.randomUUID(), eid = crypto.randomUUID()
  await T().prepare(`INSERT INTO users (id, institution_id, email, full_name) VALUES (?, ?, ?, ?)`).bind(uid, IDS.school, `${uid}@t.school`, name).run()
  await T().prepare(`INSERT INTO employees (id, institution_id, campus_id, employee_code, first_name, user_id, status) VALUES (?, ?, ?, ?, ?, ?, 'active')`)
    .bind(eid, IDS.school, campus, 'A' + eid.slice(0, 6), name, uid).run()
  return { uid, eid }
}
const mark = (uid: string, day = MON) => T().prepare(`SELECT status, source FROM staff_attendance WHERE user_id = ? AND on_date = ?`).bind(uid, day).first<{ status: string; source: string }>()
const setting = (enabled: number, time = '18:00') => T().prepare(`INSERT INTO module_settings (institution_id, module, enabled, config) VALUES (?, 'staff_auto_absent', ?, json_object('time', ?))
    ON CONFLICT (institution_id, module) DO UPDATE SET enabled = excluded.enabled, config = excluded.config`).bind(IDS.school, enabled, time).run()

beforeAll(async () => {
  await seed()
  campus = (await T().prepare(`SELECT id FROM campuses LIMIT 1`).first<{ id: string }>())!.id
  dev = crypto.randomUUID()
  await T().prepare(`INSERT INTO biometric_devices (id, institution_id, serial, name, is_active) VALUES (?, ?, 'AUTOABS1', 'Gate', 1)`).bind(dev, IDS.school).run()
})
beforeEach(async () => {
  await T().prepare(`DELETE FROM cron_runs WHERE name = 'staff_auto_absent:done'`).run()
  await setting(1)
})

it('no punch: absent at 18:00 local, not before; punched staff untouched', async () => {
  const a = await staff('Asha'), b = await staff('Bala')
  await T().prepare(`INSERT INTO biometric_punches (institution_id, device_id, device_user_id, employee_id, punched_at) VALUES (?, ?, '1', ?, '2026-10-26T03:10:00Z')`).bind(IDS.school, dev, b.eid).run()
  expect((await runStaffAutoAbsent(T(), IDS.school, TZ, at('2026-10-26T12:20:00Z'))).ran).toBe(false)
  expect(await mark(a.uid)).toBeNull()
  const r = await runStaffAutoAbsent(T(), IDS.school, TZ, MON_1800)
  expect(r.ran).toBe(true)
  expect(await mark(a.uid)).toMatchObject({ status: 'absent', source: 'auto_absent' })
  expect(await mark(b.uid)).toBeNull()
})

it('approved leave (half day too) and a pending attendance request are skipped', async () => {
  const a = await staff('Chitra'), b = await staff('Deepa'), c = await staff('Esha'), d = await staff('Farah')
  await T().prepare(`INSERT INTO leave_requests (institution_id, subject_kind, employee_id, from_date, to_date, reason, status) VALUES (?, 'employee', ?, '2026-10-25', '2026-10-27', 'x', 'approved')`).bind(IDS.school, a.eid).run()
  await T().prepare(`INSERT INTO leave_requests (institution_id, subject_kind, employee_id, from_date, to_date, is_half_day, reason, status) VALUES (?, 'employee', ?, ?, ?, 1, 'x', 'approved')`).bind(IDS.school, b.eid, MON, MON).run()
  await T().prepare(`INSERT INTO leave_requests (institution_id, subject_kind, employee_id, from_date, to_date, reason, status) VALUES (?, 'employee', ?, ?, ?, 'x', 'pending')`).bind(IDS.school, c.eid, MON, MON).run()
  await T().prepare(`INSERT INTO staff_attendance_requests (id, institution_id, employee_id, on_date, reason) VALUES (?, ?, ?, ?, 'was at the board office')`).bind(crypto.randomUUID(), IDS.school, d.eid, MON).run()
  await runStaffAutoAbsent(T(), IDS.school, TZ, MON_1800)
  expect(await mark(a.uid)).toBeNull()
  expect(await mark(b.uid)).toBeNull()
  expect(await mark(c.uid)).toMatchObject({ status: 'absent' })
  expect(await mark(d.uid)).toBeNull()
})

it('a holiday and Sunday are skipped', async () => {
  const a = await staff('Gita')
  await runStaffAutoAbsent(T(), IDS.school, TZ, at('2026-10-25T12:30:00Z'))
  expect(await mark(a.uid, '2026-10-25')).toBeNull()
  await T().prepare(`INSERT INTO holidays (institution_id, name, on_date, kind, applies_to) VALUES (?, 'Founders day', '2026-10-27', 'holiday', 'all')`).bind(IDS.school).run()
  await runStaffAutoAbsent(T(), IDS.school, TZ, at('2026-10-27T12:30:00Z'))
  expect(await mark(a.uid, '2026-10-27')).toBeNull()
})

it('an existing mark (manual, on duty) is never overwritten', async () => {
  const a = await staff('Hema'), b = await staff('Indu')
  await T().prepare(`INSERT INTO staff_attendance (institution_id, user_id, on_date, status, source) VALUES (?, ?, ?, 'present', 'manual')`).bind(IDS.school, a.uid, MON).run()
  await T().prepare(`INSERT INTO staff_attendance (institution_id, user_id, on_date, status, source) VALUES (?, ?, ?, 'on_duty', 'manual')`).bind(IDS.school, b.uid, MON).run()
  await runStaffAutoAbsent(T(), IDS.school, TZ, MON_1800)
  expect(await mark(a.uid)).toMatchObject({ status: 'present', source: 'manual' })
  expect(await mark(b.uid)).toMatchObject({ status: 'on_duty', source: 'manual' })
})

it('setting off: nothing', async () => {
  await setting(0)
  const a = await staff('Jaya')
  expect((await runStaffAutoAbsent(T(), IDS.school, TZ, MON_1800)).ran).toBe(false)
  expect(await mark(a.uid)).toBeNull()
})

it('a second run the same day does nothing, and a deleted auto mark is not put back', async () => {
  const a = await staff('Kala')
  await runStaffAutoAbsent(T(), IDS.school, TZ, MON_1800)
  const n = (await T().prepare(`SELECT count(*) AS n FROM staff_attendance WHERE on_date = ?`).bind(MON).first<{ n: number }>())!.n
  await T().prepare(`DELETE FROM staff_attendance WHERE user_id = ?`).bind(a.uid).run()
  const r = await runStaffAutoAbsent(T(), IDS.school, TZ, at('2026-10-26T13:00:00Z'))
  expect(r).toMatchObject({ ran: false, reason: 'done' })
  expect(await mark(a.uid)).toBeNull()
  expect((await T().prepare(`SELECT count(*) AS n FROM staff_attendance WHERE on_date = ?`).bind(MON).first<{ n: number }>())!.n).toBe(n - 1)
})
