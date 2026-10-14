/* Per-school payroll rules (migration 0084), checked against a school's own
   August 2026 salary workbook: G MANOJITHA, BASIC 6000, HRA 3500, DA 580,
   CA 4692, OA 1200 = gross 15972; CTC 16692 (gross + 12% of Basic); 3 days
   LOP in a 31-day month; PF 720; PT 150; ESI worked out but not deducted.
   Net = 15972 - 720 - 150 - 16692 x 3 / 31 = 13486.65. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

beforeAll(seed, 180_000)

const T = () => E.TENANT_TEST
const emp = crypto.randomUUID()
const PARTS: [string, number][] = [['BASIC', 600000], ['HRA', 350000], ['DA', 58000], ['CA', 469200], ['OA', 120000]]

async function setUp() {
  const cid = (await T().prepare('SELECT id FROM campuses ORDER BY created_at LIMIT 1').first<{ id: string }>())!.id
  const ss = crypto.randomUUID()
  const stmts = [
    T().prepare(`INSERT INTO employees (id, institution_id, campus_id, employee_code, first_name, user_id, status) VALUES (?, ?, ?, 'YPS-T1', 'Manojitha', ?, 'active')`)
      .bind(emp, IDS.school, cid, IDS.teacher),
    T().prepare(`INSERT INTO salary_structures (id, institution_id, employee_id, effective_from, ctc_paise) VALUES (?, ?, ?, '2026-04-01', 1597200)`).bind(ss, IDS.school, emp),
    T().prepare(`DELETE FROM pt_slabs WHERE institution_id = ?`).bind(IDS.school),
    T().prepare(`INSERT INTO pt_slabs (id, institution_id, state, from_paise, to_paise, monthly_paise) VALUES (?, ?, 'Telangana', 1500000, 2000000, 15000)`).bind(crypto.randomUUID(), IDS.school),
    T().prepare(`INSERT INTO pt_slabs (id, institution_id, state, from_paise, to_paise, monthly_paise) VALUES (?, ?, 'Telangana', 2000000, NULL, 20000)`).bind(crypto.randomUUID(), IDS.school),
  ]
  for (const [i, [code, amt]] of PARTS.entries()) {
    stmts.push(T().prepare(`INSERT OR IGNORE INTO salary_components (id, institution_id, code, name, kind, sequence) VALUES (?, ?, ?, ?, 'earning', ?)`)
      .bind(crypto.randomUUID(), IDS.school, code, code, i + 1))
    stmts.push(T().prepare(`INSERT INTO salary_structure_items (id, institution_id, salary_structure_id, component_id, amount_paise)
        SELECT ?, ?, ?, id, ? FROM salary_components WHERE institution_id = ? AND code = ?`).bind(crypto.randomUUID(), IDS.school, ss, amt, IDS.school, code))
  }
  // Three days absent in August 2026, every other working day present.
  for (let d = 1; d <= 31; d++) {
    const day = `2026-08-${String(d).padStart(2, '0')}`
    if (new Date(day + 'T00:00:00Z').getUTCDay() === 0) continue
    const status = d <= 6 && d >= 4 ? 'absent' : 'present'
    stmts.push(T().prepare(`INSERT INTO staff_attendance (id, institution_id, user_id, on_date, status) VALUES (?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), IDS.school, IDS.teacher, day, status))
  }
  await T().batch(stmts)
}

async function run() {
  const r = await api('admin', 'POST', '/payroll/run', { month: 8, year: 2026, acknowledge_unmarked_attendance: true, acknowledge_unpaid_staff: true })
  expect(r.status).toBe(200)
  const s = await api('admin', 'GET', '/payroll/payslips?month=8&year=2026')
  return s.body.items.find((x: any) => x.employee_id === emp)
}

async function settings(patch: Record<string, unknown>) {
  const cur = await api('admin', 'GET', '/payroll/settings')
  const r = await api('admin', 'PUT', '/payroll/settings', { ...cur.body, pt_slabs: undefined, ...patch })
  expect(r.status).toBe(200)
  expect(r.body.rules_saved).toBe(true)
}

describe('payroll rules', () => {
  beforeAll(setUp, 180_000)

  it('defaults keep the current method: every part cut by days not worked', async () => {
    const cur = await api('admin', 'GET', '/payroll/settings')
    expect(cur.body.lop_method).toBe('prorate')
    expect(cur.body.pf_wage_base).toBe('basic_da')
    expect(cur.body.esi_mode).toBe('deduct')
    const p = await run()
    expect(Number(p.lop_days)).toBe(3)
    // 26 working days (Mon-Sat), 23 paid.
    const cut = PARTS.map(([, a]) => Math.trunc((a * 23) / 26))
    const gross = cut.reduce((n, x) => n + x, 0)
    const pf = Math.floor(((cut[0] + cut[2]) * 12) / 100 + 0.5)
    const esi = Math.floor((gross * 0.75) / 100 + 0.5)
    const pt = gross >= 1500000 ? 15000 : 0
    expect(p.gross_paise).toBe(gross)
    expect(p.breakup.PF).toBe(-pf)
    expect(p.breakup.ESI).toBe(-esi)
    expect(p.net_paise).toBe(gross - pf - esi - pt)
    expect(p.breakup.LOP).toBeUndefined()
  }, 180_000)

  it("school-style rules reproduce the workbook: Manojitha's net is 13486.65", async () => {
    await settings({ pf_wage_base: 'basic', lop_method: 'day_pay', lop_day_base: 'ctc', lop_divisor: 'month', esi_mode: 'employer',
      late_rule: 'per_day', late_marks_per_day: 3, free_leave_days: 0 })
    const p = await run()
    expect(p.gross_paise).toBe(1597200)
    expect(p.breakup.PF).toBe(-72000)
    expect(p.breakup.PT).toBe(-15000)
    expect(p.breakup.ESI).toBeUndefined()
    expect(p.breakup.ESI_EE_BY_EMPLOYER).toBe(11979)
    expect(p.breakup.LOP).toBe(-161535)
    expect(p.net_paise).toBe(1348665)

    const st = await api('admin', 'GET', '/payroll/statement?month=8&year=2026')
    expect(st.status).toBe(200)
    const row = st.body.items.find((x: any) => x.employee_id === emp)
    expect(row.ctc_paise).toBe(1669200)
    expect(row.lop_paise).toBe(161535)
    expect(row.esi_deducted).toBe(false)
  }, 180_000)

  it('one free leave a month is forgiven before loss of pay', async () => {
    await settings({ free_leave_days: 1 })
    const p = await run()
    expect(Number(p.lop_days)).toBe(2)
    expect(p.breakup.LOP).toBe(-Math.round((1669200 * 2) / 31))
  }, 180_000)

  it('holidays worked are paid as extra days when switched on', async () => {
    await settings({ free_leave_days: 0, pay_holidays_worked: true })
    const m = await api('admin', 'PUT', '/payroll/month-days', { year: 2026, month: 8, employee_id: emp, holidays_worked: 1, vacation_days: 2, vacation_dates: '10-11 Aug' })
    expect(m.status).toBe(200)
    const p = await run()
    expect(p.breakup.HOLIDAY_WORK).toBe(Math.round(1669200 / 31))
    expect(p.net_paise).toBe(1348665 + Math.round(1669200 / 31))
    const st = await api('admin', 'GET', '/payroll/statement?month=8&year=2026')
    expect(st.body.items.find((x: any) => x.employee_id === emp).vacation_days).toBe(2)
  }, 180_000)
})
