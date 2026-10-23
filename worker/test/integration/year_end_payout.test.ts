/* Year-end payout (payroll.year_end_payout): one person, Rs 30,000 gross with
   no parts, so a day's pay at gross / 30 is Rs 1,000. She worked one holiday,
   had 12 days of encashable leave and took 3, so the year ends with Rs 1,000
   of holiday work and Rs 9,000 of unused leave. Saved into the last month of
   the academic year, the two show up as changes to pay and the run folds them
   into her payslip; a second save, and a locked month, are refused. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E, isoDay } from './fixture'

beforeAll(seed, 180_000)

const T = () => E.TENANT_TEST
const emp = crypto.randomUUID()
const leaveType = crypto.randomUUID()

/** A weekday (Mon-Sat) on or before the given offset, so a weekly off never doubles as the holiday. */
function weekday(offset: number): string {
  for (let i = 0; i < 7; i++) {
    const d = isoDay(offset - i)
    if (new Date(d + 'T00:00:00Z').getUTCDay() !== 0) return d
  }
  return isoDay(offset)
}
const holiday = weekday(-30)
const leaveFrom = isoDay(-45), leaveTo = isoDay(-43)
let payMonth = 0, payYear = 0

async function setUp() {
  const cid = (await T().prepare('SELECT id FROM campuses ORDER BY created_at LIMIT 1').first<{ id: string }>())!.id
  await T().batch([
    T().prepare(`INSERT INTO employees (id, institution_id, campus_id, employee_code, first_name, user_id, status) VALUES (?, ?, ?, 'YE-1', 'Farah', ?, 'active')`)
      .bind(emp, IDS.school, cid, IDS.finance),
    T().prepare(`INSERT INTO salary_structures (id, institution_id, employee_id, effective_from, ctc_paise) VALUES (?, ?, ?, '2020-01-01', 3000000)`).bind(crypto.randomUUID(), IDS.school, emp),
    T().prepare(`INSERT INTO holidays (id, institution_id, academic_year_id, name, on_date, kind, applies_to) VALUES (?, ?, ?, 'Founders day', ?, 'holiday', 'all')`)
      .bind(crypto.randomUUID(), IDS.school, IDS.year, holiday),
    T().prepare(`INSERT INTO staff_attendance (id, institution_id, user_id, on_date, status) VALUES (?, ?, ?, ?, 'present')`).bind(crypto.randomUUID(), IDS.school, IDS.finance, holiday),
    T().prepare(`INSERT INTO leave_types (id, institution_id, name, code, applies_to, annual_quota, is_paid) VALUES (?, ?, 'Earned leave', 'EL', 'staff', '12', 1)`).bind(leaveType, IDS.school),
    T().prepare(`INSERT INTO leave_policy_rules (leave_type_id, institution_id, encashable) VALUES (?, ?, 1)`).bind(leaveType, IDS.school),
    T().prepare(`INSERT INTO leave_balances (id, institution_id, leave_type_id, employee_id, academic_year_id, entitled, taken) VALUES (?, ?, ?, ?, ?, '12', '3')`)
      .bind(crypto.randomUUID(), IDS.school, leaveType, emp, IDS.year),
    T().prepare(`INSERT INTO leave_requests (id, institution_id, leave_type_id, subject_kind, employee_id, from_date, to_date, days, reason, status) VALUES (?, ?, ?, 'staff', ?, ?, ?, '3', 'Family', 'approved')`)
      .bind(crypto.randomUUID(), IDS.school, leaveType, emp, leaveFrom, leaveTo),
  ])
}

const summary = (extra = '') => api('admin', 'GET', `/payroll/year-end?year_id=${IDS.year}${extra}`)
const mine = (body: any) => body.rows.find((r: any) => r.employee_id === emp)

describe('year-end payout', () => {
  beforeAll(setUp, 180_000)

  it('shows the year, the leave with its dates, the holiday worked and the money at gross / 30', async () => {
    const r = await summary()
    expect(r.status).toBe(200)
    expect(r.body.year.id).toBe(IDS.year)
    expect(r.body.settings.available).toBe(true)
    expect(r.body.settings.holiday_rate).toBe('gross_30')
    expect(r.body.paid).toBeNull()
    expect(r.body.month_locked).toBe(false)
    payMonth = r.body.pay_month; payYear = r.body.pay_year
    expect(`${payYear}-${String(payMonth).padStart(2, '0')}`).toBe(isoDay(210).slice(0, 7))
    const row = mine(r.body)
    expect(row.no_salary).toBe(false)
    expect(row.day_pay_paise).toBe(100000)
    expect(row.leave_quota).toBe(12)
    expect(row.leave_taken).toBe(3)
    expect(row.leave_taken_dates).toEqual([{ on: leaveFrom, to: leaveTo, days: 3, type: 'EL' }])
    expect(row.leave_unused).toBe(9)
    expect(row.leave_days).toBe(9)
    expect(row.leave_paise).toBe(900000)
    expect(row.holiday_dates).toEqual([holiday])
    expect(row.holiday_days).toBe(1)
    expect(row.holiday_paise).toBe(100000)
  }, 180_000)

  it('rates: a fixed figure a day and a cap change the money, and are kept', async () => {
    const s = await api('admin', 'PUT', '/payroll/year-end/settings', { holiday_rate: 'fixed', holiday_fixed_paise: 50000, leave_max_days: 5 })
    expect(s.status).toBe(200)
    const row = mine((await summary()).body)
    expect(row.holiday_paise).toBe(50000)
    expect(row.leave_days).toBe(5)
    expect(row.leave_paise).toBe(500000)
    const back = await api('admin', 'PUT', '/payroll/year-end/settings', { holiday_rate: 'gross_30', leave_max_days: 0 })
    expect(back.status).toBe(200)
    expect(mine((await summary()).body).leave_paise).toBe(900000)
  }, 180_000)

  it('saves into the month as changes to pay, which the run picks up; a second save is refused', async () => {
    const rows = (await summary()).body.rows.filter((r: any) => r.employee_id === emp)
      .map((r: any) => ({ employee_id: r.employee_id, holiday_days: r.holiday_days, holiday_paise: r.holiday_paise, leave_days: r.leave_days, leave_paise: r.leave_paise }))
    const save = await api('admin', 'POST', '/payroll/year-end', { year_id: IDS.year, month: payMonth, year: payYear, rows })
    expect(save.status).toBe(201)
    expect(save.body.people).toBe(1)
    expect(save.body.total_paise).toBe(1000000)

    const adj = await api('admin', 'GET', `/payroll/adjustments?month=${payMonth}&year=${payYear}`)
    const ours = adj.body.items.filter((a: any) => a.employee_id === emp)
    expect(ours.map((a: any) => [a.kind, a.amount_paise, a.reason.split(' (')[0]]).sort()).toEqual([
      ['earning', 100000, 'Holiday work · 1 day'], ['earning', 900000, 'Leave encashment · 9 days'],
    ])

    const again = await summary()
    expect(again.body.paid.month).toBe(payMonth)
    expect(again.body.paid.total_paise).toBe(1000000)
    const twice = await api('admin', 'POST', '/payroll/year-end', { year_id: IDS.year, month: payMonth, year: payYear, rows })
    expect(twice.status).toBe(409)
    expect(twice.body.code).toBe('already_added')

    const run = await api('admin', 'POST', '/payroll/run', { month: payMonth, year: payYear, acknowledge_unmarked_attendance: true, acknowledge_unpaid_staff: true })
    expect(run.status).toBe(200)
    const slips = await api('admin', 'GET', `/payroll/payslips?month=${payMonth}&year=${payYear}`)
    const slip = slips.body.items.find((x: any) => x.employee_id === emp)
    expect(slip.breakup.ADJ_ADD).toBe(1000000)
    expect(slip.gross_paise).toBe(3000000 + 1000000)
  }, 180_000)

  it('remove takes the changes back out and lets the year be saved again; a locked month refuses', async () => {
    const paid = (await summary()).body.paid
    const del = await api('admin', 'DELETE', `/payroll/year-end/${paid.id}`)
    expect(del.status).toBe(200)
    expect(del.body.removed).toBe(1)
    const adj = await api('admin', 'GET', `/payroll/adjustments?month=${payMonth}&year=${payYear}`)
    expect(adj.body.items.filter((a: any) => a.employee_id === emp)).toEqual([])
    const slips = await api('admin', 'GET', `/payroll/payslips?month=${payMonth}&year=${payYear}`)
    expect(slips.body.items.find((x: any) => x.employee_id === emp).breakup.ADJ_ADD).toBeUndefined()
    expect((await summary()).body.paid).toBeNull()

    const lock = await api('admin', 'POST', '/payroll/state', { month: payMonth, year: payYear, to: 'locked' })
    expect(lock.status).toBe(200)
    expect((await summary()).body.month_locked).toBe(true)
    const rows = [{ employee_id: emp, holiday_days: 1, holiday_paise: 100000, leave_days: 9, leave_paise: 900000 }]
    const refused = await api('admin', 'POST', '/payroll/year-end', { year_id: IDS.year, month: payMonth, year: payYear, rows })
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe('payroll_locked')
    await api('admin', 'POST', '/payroll/state', { month: payMonth, year: payYear, to: 'draft' })
  }, 180_000)

  it('the finance role cannot save a payout', async () => {
    const r = await api('finance', 'POST', '/payroll/year-end', { year_id: IDS.year, month: payMonth, year: payYear, rows: [] })
    expect(r.status).toBe(403)
  })
})
