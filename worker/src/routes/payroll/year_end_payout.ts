/* Year-end payout (payroll.year_end_payout). Owner, 2026-10-14: "holiday pay
   may be given at the end of the working month of the academic year... if no
   leave is applied that is also considered as a pay... shows leave is used or
   not, if used when, and who worked on holidays and how many days and how much
   money they will get, and after save that will be added to that month's
   payroll."

   The summary is worked out fresh each time from the register, the leave
   requests and the salary in force; nothing is stored until Save. Save writes
   one pay adjustment per person per item (the same rows Changes to pay makes,
   so the run folds them in and the payslip prints the reason) and one record
   per academic year so it cannot be added twice. Undo removes those
   adjustments while the month is still open.

   Without migration 0087 the screen still opens: default rates, Save refused.
   Catalogue key hr.payroll.year_end_payout. Read hr.payroll.read, write hr.payroll.write. */
import type { Router, Ctx } from '../../router'
import { reply } from '../../router'
import { badRequest, bool, isUUID, notFound, readJSON, uuid, uuidParam, now } from '../../http'
import { coded, nameOf, num, numOr0, pad2, str } from '../exams/common'
import { school } from '../school'
import { staffHolidayChecker } from '../hr/staff_holidays'
import { staffPayBases, type PayBase } from '../payroll'
import type { YearEndRate, YearEndRow, YearEndSettings, YearEndSummary, YearEndSaveRow, YearEndLeaveTaken } from '@shared/api/feature_year_end_payout'

const PAYROLL_READ = 'hr.payroll.read'
const PAYROLL_WRITE = 'hr.payroll.write'
const RATES: readonly YearEndRate[] = ['gross_30', 'ctc_30', 'pattern', 'fixed']
const EMP_NAME = nameOf('e', false)

const DEFAULTS: YearEndSettings = {
  holiday_rate: 'gross_30', holiday_fixed_paise: 0, holiday_max_days: 0,
  leave_rate: 'gross_30', leave_fixed_paise: 0, leave_max_days: 0, leave_types: 'encashable', available: false,
}
const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => (allowed as readonly string[]).includes(String(v)) ? String(v) as T : dflt
const MIGRATION_NEEDED = "This school's database needs migration 0087 before a payout can be saved."

/** The rates, or the defaults when migration 0087 has not reached this school. */
async function loadSettings(c: Ctx): Promise<YearEndSettings> {
  const inst = school(c).id
  try {
    const row = await c.db.prepare(`SELECT ye_holiday_rate, ye_holiday_fixed_paise, ye_holiday_max_days, ye_leave_rate, ye_leave_fixed_paise, ye_leave_max_days, ye_leave_types
        FROM payroll_settings WHERE institution_id = ?`).bind(inst).first<Record<string, unknown>>()
    if (!row) return { ...DEFAULTS, available: true }
    return {
      holiday_rate: pick(row.ye_holiday_rate, RATES, 'gross_30'), holiday_fixed_paise: Math.max(0, numOr0(row.ye_holiday_fixed_paise)),
      holiday_max_days: Math.max(0, numOr0(row.ye_holiday_max_days)),
      leave_rate: pick(row.ye_leave_rate, RATES, 'gross_30'), leave_fixed_paise: Math.max(0, numOr0(row.ye_leave_fixed_paise)),
      leave_max_days: Math.max(0, numOr0(row.ye_leave_max_days)),
      leave_types: pick(row.ye_leave_types, ['encashable', 'paid'] as const, 'encashable'), available: true,
    }
  } catch { return { ...DEFAULTS } }
}

/** One day's pay for a person under a rate; 0 when they have no salary in force. */
function dayPay(rate: YearEndRate, fixed: number, base: PayBase | undefined): number {
  if (rate === 'fixed') return fixed
  if (!base) return 0
  if (rate === 'ctc_30') return base.ctc_paise / 30
  if (rate === 'pattern') return base.gross_paise / (base.pattern_divisor > 0 ? base.pattern_divisor : 30)
  return base.gross_paise / 30
}
const cap = (days: number, max: number) => (max > 0 ? Math.min(days, max) : days)
const r2 = (n: number) => Number(n.toFixed(2))

function intList(raw: unknown, dflt: number[]): number[] {
  const s = str(raw).trim()
  if (s === '' || s === '{}' || s === '[]') return dflt
  const out = s.replace(/^[[{]|[\]}]$/g, '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n))
  return out.length ? out : dflt
}

interface Year { id: string; name: string; starts_on: string; ends_on: string; is_current: boolean }

async function academicYears(c: Ctx): Promise<Year[]> {
  const rows = await c.db.prepare(`SELECT id, name, SUBSTR(starts_on, 1, 10) AS starts_on, SUBSTR(ends_on, 1, 10) AS ends_on, is_current FROM academic_years ORDER BY starts_on DESC`)
    .all<Record<string, unknown>>()
  return rows.results.map((y) => ({ id: str(y.id), name: str(y.name), starts_on: str(y.starts_on), ends_on: str(y.ends_on), is_current: bool(y.is_current) }))
}

interface PaidRec { id: string; period_year: number; period_month: number; people: number; total_paise: number; adjustment_ids: string; created_at: string; by_name: string }

/** The payout already saved for this year, if any (null before migration 0087 too). */
async function paidRecord(c: Ctx, yearId: string): Promise<PaidRec | null> {
  try {
    return await c.db.prepare(`SELECT p.id, p.period_year, p.period_month, p.people, p.total_paise, p.adjustment_ids, p.created_at, COALESCE(u.full_name, '') AS by_name
        FROM payroll_year_end_payouts p LEFT JOIN users u ON u.id = p.created_by WHERE p.academic_year_id = ?`).bind(yearId).first<PaidRec>()
  } catch { return null }
}

async function monthLocked(c: Ctx, year: number, month: number): Promise<boolean> {
  const run = await c.db.prepare(`SELECT status, bank_file_drawn_at FROM payroll_runs WHERE period_year = ? AND period_month = ?`).bind(year, month)
    .first<{ status: string; bank_file_drawn_at: string | null }>()
  return !!run && (run.status === 'locked' || run.status === 'paid' || !!run.bank_file_drawn_at)
}

/** Every active member of staff's leave and holiday work over the year, priced for the pay month. */
async function summaryRows(c: Ctx, year: Year, payYear: number, payMonth: number, set: YearEndSettings): Promise<{ rows: YearEndRow[]; types: YearEndSummary['leave_types'] }> {
  const bases = await staffPayBases(c, payYear, payMonth)
  const staff = (await c.db.prepare(`
    SELECT e.id, e.user_id, e.employee_code, ${EMP_NAME} AS full_name,
           COALESCE(p1.working_days, p2.working_days, p3.working_days) AS working_days
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN work_patterns p1 ON p1.id = e.work_pattern_id
      LEFT JOIN work_patterns p2 ON p2.id = d.work_pattern_id
      LEFT JOIN work_patterns p3 ON p3.id = (SELECT id FROM work_patterns WHERE is_default LIMIT 1)
     WHERE e.status = 'active' AND e.user_id IS NOT NULL
     ORDER BY e.employee_code`).all<Record<string, unknown>>()).results

  // Leave types that count, with each person's quota for the year.
  const types = (await c.db.prepare(`SELECT lt.id, lt.code, lt.name, lt.annual_quota, lt.is_paid, COALESCE(pr.encashable, 0) AS encashable
      FROM leave_types lt LEFT JOIN leave_policy_rules pr ON pr.leave_type_id = lt.id WHERE lt.applies_to = 'staff' ORDER BY lt.name`).all<Record<string, unknown>>()).results
    .map((t) => ({ id: str(t.id), code: str(t.code), name: str(t.name), quota: numOr0(t.annual_quota), encashable: bool(t.encashable), is_paid: bool(t.is_paid) }))
  const counted = types.filter((t) => (set.leave_types === 'paid' ? t.is_paid : t.encashable))
  const countedIds = new Set(counted.map((t) => t.id))
  const entitled = new Map<string, number>() // eid|type -> entitled for this year
  const bal = (await c.db.prepare(`SELECT employee_id, leave_type_id, entitled FROM leave_balances WHERE academic_year_id = ?`).bind(year.id)
    .all<{ employee_id: string; leave_type_id: string; entitled: string }>()).results
  for (const b of bal) entitled.set(`${b.employee_id}|${b.leave_type_id}`, numOr0(b.entitled))

  // Approved leave inside the year, by person, with its dates.
  const taken = new Map<string, YearEndLeaveTaken[]>()
  const leave = (await c.db.prepare(`SELECT lr.employee_id, lr.leave_type_id, SUBSTR(lr.from_date, 1, 10) AS from_date, SUBSTR(lr.to_date, 1, 10) AS to_date, lr.days, lr.is_half_day, lt.code
      FROM leave_requests lr LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
     WHERE lr.subject_kind = 'staff' AND lr.status = 'approved' AND lr.employee_id IS NOT NULL AND lr.from_date <= ? AND lr.to_date >= ?
     ORDER BY lr.from_date`).bind(year.ends_on, year.starts_on).all<Record<string, unknown>>()).results
  for (const l of leave) {
    if (!countedIds.has(str(l.leave_type_id))) continue
    const list = taken.get(str(l.employee_id)) ?? []
    list.push({ on: str(l.from_date), to: str(l.to_date), days: bool(l.is_half_day) ? 0.5 : Math.max(0.5, numOr0(l.days) || 1), type: str(l.code) })
    taken.set(str(l.employee_id), list)
  }

  // Present on a holiday or a weekly off, the whole year (as the monthly run counts comp-off).
  const isHoliday = await staffHolidayChecker(c.db, year.starts_on, year.ends_on)
  const present = (await c.db.prepare(`SELECT e.id AS eid, SUBSTR(sa.on_date, 1, 10) AS on_date FROM staff_attendance sa JOIN employees e ON e.user_id = sa.user_id
      WHERE sa.on_date BETWEEN ? AND ? AND sa.status IN ('present', 'late', 'permission', 'on_duty') ORDER BY sa.on_date`).bind(year.starts_on, year.ends_on)
    .all<{ eid: string; on_date: string }>()).results
  const presentBy = new Map<string, string[]>()
  for (const p of present) { const l = presentBy.get(p.eid) ?? []; l.push(p.on_date); presentBy.set(p.eid, l) }
  // Holidays worked typed in by hand on any month of the year (migration 0084; absent table = none).
  const manual = new Map<string, number>()
  try {
    const from = year.starts_on.slice(0, 7), to = year.ends_on.slice(0, 7)
    const md = (await c.db.prepare(`SELECT employee_id, holidays_worked, period_year, period_month FROM payroll_month_days`)
      .all<{ employee_id: string; holidays_worked: number; period_year: number; period_month: number }>()).results
    for (const m of md) {
      const key = `${m.period_year}-${pad2(m.period_month)}`
      if (key >= from && key <= to) manual.set(m.employee_id, (manual.get(m.employee_id) ?? 0) + numOr0(m.holidays_worked))
    }
  } catch { /* migration 0084 not applied */ }

  const rows: YearEndRow[] = []
  for (const e of staff) {
    const eid = str(e.id), uid = str(e.user_id)
    const workingDays = intList(e.working_days, [1, 2, 3, 4, 5, 6])
    const holidayDates: string[] = []
    for (const day of presentBy.get(eid) ?? []) {
      const dow = new Date(day + 'T00:00:00Z').getUTCDay()
      if (!workingDays.includes(dow === 0 ? 7 : dow) || isHoliday(day, uid)) holidayDates.push(day)
    }
    const quota = counted.reduce((n, t) => n + (entitled.get(`${eid}|${t.id}`) ?? t.quota), 0)
    const dates = taken.get(eid) ?? []
    const takenDays = dates.reduce((n, d) => n + d.days, 0)
    const unused = Math.max(0, quota - takenDays)
    const base = bases.get(eid)
    const hDays = cap(holidayDates.length + (manual.get(eid) ?? 0), set.holiday_max_days)
    const lDays = cap(unused, set.leave_max_days)
    const hPay = dayPay(set.holiday_rate, set.holiday_fixed_paise, base)
    const lPay = dayPay(set.leave_rate, set.leave_fixed_paise, base)
    rows.push({
      employee_id: eid, employee_code: str(e.employee_code), full_name: str(e.full_name), no_salary: !base,
      day_pay_paise: Math.round(hPay),
      leave_quota: r2(quota), leave_taken: r2(takenDays), leave_taken_dates: dates, leave_unused: r2(unused),
      leave_days: r2(lDays), leave_paise: Math.round(lPay * lDays),
      holiday_dates: holidayDates, holiday_manual: manual.get(eid) ?? 0,
      holiday_days: r2(hDays), holiday_paise: Math.round(hPay * hDays),
    })
  }
  return { rows, types }
}

async function yearFrom(c: Ctx, yearId: string | null): Promise<{ years: Year[]; year: Year | null }> {
  const years = await academicYears(c)
  if (yearId && !isUUID(yearId)) throw badRequest('Choose an academic year.')
  const today = new Date().toISOString().slice(0, 10)
  const year = yearId ? years.find((y) => y.id === yearId) ?? null
    : years.find((y) => y.is_current) ?? years.find((y) => today >= y.starts_on && today <= y.ends_on) ?? years[0] ?? null
  if (yearId && !year) throw notFound('That academic year is not here.')
  return { years, year }
}

export function registerYearEndPayout(r: Router): void {
  r.typed('GET /payroll/year-end', PAYROLL_READ, async (c) => {
    const { years, year } = await yearFrom(c, c.url.searchParams.get('year_id'))
    const set = await loadSettings(c)
    let payYear = num(c.url.searchParams.get('year')) ?? 0, payMonth = num(c.url.searchParams.get('month')) ?? 0
    if (year && (payMonth < 1 || payMonth > 12 || payYear < 2000)) { payYear = Number(year.ends_on.slice(0, 4)); payMonth = Number(year.ends_on.slice(5, 7)) }
    const rec = year ? await paidRecord(c, year.id) : null
    let phw = false
    try {
      const s = await c.db.prepare(`SELECT pay_holidays_worked FROM payroll_settings WHERE institution_id = ?`).bind(school(c).id).first<{ pay_holidays_worked: number }>()
      phw = bool(s?.pay_holidays_worked)
    } catch { /* migration 0084 not applied */ }
    const body: YearEndSummary = {
      years, year: year ? { id: year.id, name: year.name, starts_on: year.starts_on, ends_on: year.ends_on } : null,
      pay_month: payMonth, pay_year: payYear,
      month_locked: year ? await monthLocked(c, payYear, payMonth) : false,
      pay_holidays_worked: phw,
      paid: rec ? { id: rec.id, at: rec.created_at, by_name: rec.by_name, month: rec.period_month, year: rec.period_year, people: numOr0(rec.people), total_paise: numOr0(rec.total_paise) } : null,
      settings: set, leave_types: [], rows: [],
    }
    if (year) {
      const s = await summaryRows(c, year, payYear, payMonth, set)
      body.rows = s.rows; body.leave_types = s.types
    }
    return body
  })

  r.typed('PUT /payroll/year-end/settings', PAYROLL_WRITE, async (c) => {
    const b = await readJSON<Partial<YearEndSettings>>(c.req)
    const cur = await loadSettings(c)
    if (!cur.available) throw coded(409, 'migration_needed', MIGRATION_NEEDED)
    const v: YearEndSettings = {
      holiday_rate: pick(b.holiday_rate ?? cur.holiday_rate, RATES, 'gross_30'),
      holiday_fixed_paise: Math.max(0, Math.round(numOr0(b.holiday_fixed_paise ?? cur.holiday_fixed_paise))),
      holiday_max_days: Math.max(0, numOr0(b.holiday_max_days ?? cur.holiday_max_days)),
      leave_rate: pick(b.leave_rate ?? cur.leave_rate, RATES, 'gross_30'),
      leave_fixed_paise: Math.max(0, Math.round(numOr0(b.leave_fixed_paise ?? cur.leave_fixed_paise))),
      leave_max_days: Math.max(0, numOr0(b.leave_max_days ?? cur.leave_max_days)),
      leave_types: pick(b.leave_types ?? cur.leave_types, ['encashable', 'paid'] as const, 'encashable'), available: true,
    }
    if (v.holiday_rate === 'fixed' && v.holiday_fixed_paise <= 0) throw badRequest('Enter the fixed amount a day for holiday work.')
    if (v.leave_rate === 'fixed' && v.leave_fixed_paise <= 0) throw badRequest('Enter the fixed amount a day for unused leave.')
    const inst = school(c).id
    await c.db.prepare(`INSERT OR IGNORE INTO payroll_settings (institution_id, updated_at) VALUES (?, ?)`).bind(inst, now()).run()
    await c.db.prepare(`UPDATE payroll_settings SET ye_holiday_rate = ?, ye_holiday_fixed_paise = ?, ye_holiday_max_days = ?, ye_leave_rate = ?, ye_leave_fixed_paise = ?,
        ye_leave_max_days = ?, ye_leave_types = ?, updated_at = ? WHERE institution_id = ?`)
      .bind(v.holiday_rate, v.holiday_fixed_paise, v.holiday_max_days, v.leave_rate, v.leave_fixed_paise, v.leave_max_days, v.leave_types, now(), inst).run()
    return { ok: true as const }
  })

  /* SAVE TO THE MONTH'S PAYROLL. One adjustment per person per item, through
     the same table Changes to pay uses, so the run folds them in and the
     payslip prints the reason. The record per academic year is what stops a
     second save. The amounts come from the screen (a hand override is
     allowed), never zero, never past a sane ceiling. */
  r.typed('POST /payroll/year-end', PAYROLL_WRITE, async (c) => {
    const b = await readJSON<{ year_id?: string; month?: number; year?: number; rows?: YearEndSaveRow[] }>(c.req)
    const month = Number(b.month ?? 0), year = Number(b.year ?? 0)
    if (month < 1 || month > 12 || year < 2000) throw badRequest('Choose the month to pay it in.')
    const ay = (await yearFrom(c, String(b.year_id ?? ''))).year
    if (!ay) throw badRequest('Choose an academic year.')
    const set = await loadSettings(c)
    if (!set.available) throw coded(409, 'migration_needed', MIGRATION_NEEDED)
    const have = await paidRecord(c, ay.id)
    if (have) throw coded(409, 'already_added', `Already added to ${pad2(have.period_month)}/${have.period_year} payroll on ${have.created_at.slice(0, 10)}. Remove it first to redo it.`)
    if (await monthLocked(c, year, month)) throw coded(409, 'payroll_locked', 'This month is locked. Unlock it first to add the payout.')
    const rows = (Array.isArray(b.rows) ? b.rows : []).filter((x) => x && isUUID(String(x.employee_id)))
    if (!rows.length) throw badRequest('Tick at least one person.')
    const active = new Set((await c.db.prepare(`SELECT id FROM employees WHERE status = 'active'`).all<{ id: string }>()).results.map((x) => x.id))
    const inst = school(c).id
    const stmts: D1PreparedStatement[] = []
    const ids: string[] = []
    const ts = now()
    let total = 0
    const people = new Set<string>()
    for (const x of rows) {
      if (!active.has(x.employee_id)) throw badRequest('One of the people ticked is no longer on the roll.')
      const items: [number, number, string][] = [
        [numOr0(x.holiday_days), Math.round(numOr0(x.holiday_paise)), 'Holiday work'],
        [numOr0(x.leave_days), Math.round(numOr0(x.leave_paise)), 'Leave encashment'],
      ]
      for (const [days, paise, what] of items) {
        if (paise <= 0) continue
        if (paise > 1_00_00_000_00) throw badRequest(`${what} for one person is over one crore. Check the figures.`)
        const id = uuid()
        ids.push(id); total += paise; people.add(x.employee_id)
        stmts.push(c.db.prepare(`INSERT INTO payroll_adjustments (id, institution_id, employee_id, period_year, period_month, kind, amount_paise, reason, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, 'earning', ?, ?, ?, ?)`)
          .bind(id, inst, x.employee_id, year, month, paise, `${what} · ${r2(days)} day${days === 1 ? '' : 's'} (${ay.name})`, c.id.userId, ts))
      }
    }
    if (!stmts.length) throw badRequest('Nothing to pay: every ticked row comes to zero.')
    const recId = uuid()
    stmts.push(c.db.prepare(`INSERT INTO payroll_year_end_payouts (id, institution_id, academic_year_id, period_year, period_month, people, total_paise, adjustment_ids, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(recId, inst, ay.id, year, month, people.size, total, JSON.stringify(ids), c.id.userId, ts))
    await c.db.batch(stmts)
    for (const eid of people) await refold(c, eid, year, month)
    return reply({ id: recId, people: people.size, total_paise: total }, 201)
  })

  r.typed('DELETE /payroll/year-end/{id}', PAYROLL_WRITE, async (c) => {
    const id = uuidParam(c.params.id)
    let rec: { period_year: number; period_month: number; adjustment_ids: string } | null = null
    try {
      rec = await c.db.prepare(`SELECT period_year, period_month, adjustment_ids FROM payroll_year_end_payouts WHERE id = ?`).bind(id).first()
    } catch { throw coded(409, 'migration_needed', MIGRATION_NEEDED) }
    if (!rec) throw notFound()
    if (await monthLocked(c, rec.period_year, rec.period_month)) throw coded(409, 'payroll_locked', 'That month is locked. Unlock it first to remove the payout.')
    let ids: string[] = []
    try { ids = JSON.parse(rec.adjustment_ids) } catch { ids = [] }
    const who = ids.length ? (await c.db.prepare(`SELECT DISTINCT employee_id FROM payroll_adjustments WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{ employee_id: string }>()).results : []
    const stmts = ids.map((a) => c.db.prepare(`DELETE FROM payroll_adjustments WHERE id = ?`).bind(a))
    stmts.push(c.db.prepare(`DELETE FROM payroll_year_end_payouts WHERE id = ?`).bind(id))
    await c.db.batch(stmts)
    for (const w of who) await refold(c, w.employee_id, rec.period_year, rec.period_month)
    return { deleted: true as const, removed: who.length }
  })
}

/* Refold a person's adjustments into an already-run month, as POST
   /payroll/adjustments does. Kept here rather than exported from payroll.ts
   because that file's copy is private to the run; the arithmetic is the same. */
async function refold(c: Ctx, employeeId: string, year: number, month: number) {
  const run = await c.db.prepare(`SELECT id FROM payroll_runs WHERE period_year = ? AND period_month = ?`).bind(year, month).first<{ id: string }>()
  if (!run) return
  const ps = await c.db.prepare(`SELECT id, gross_paise, deduction_paise, breakup FROM payslips WHERE payroll_run_id = ? AND employee_id = ?`).bind(run.id, employeeId)
    .first<{ id: string; gross_paise: number; deduction_paise: number; breakup: string | null }>()
  if (!ps) return
  const b: Record<string, number> = (() => { try { return JSON.parse(ps.breakup ?? '{}') ?? {} } catch { return {} } })()
  const oldAdd = Number(b.ADJ_ADD ?? 0), oldCut = -Number(b.ADJ_CUT ?? 0)
  const adj = await c.db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind = 'earning' THEN amount_paise END), 0) AS earn,
      COALESCE(SUM(CASE WHEN kind = 'deduction' THEN amount_paise END), 0) AS deduct
      FROM payroll_adjustments WHERE employee_id = ? AND period_year = ? AND period_month = ?`).bind(employeeId, year, month).first<{ earn: number; deduct: number }>()
  const earn = Number(adj?.earn ?? 0), deduct = Number(adj?.deduct ?? 0)
  delete b.ADJ_ADD; delete b.ADJ_CUT
  if (earn > 0) b.ADJ_ADD = earn
  if (deduct > 0) b.ADJ_CUT = -deduct
  const gross = Number(ps.gross_paise) - oldAdd + earn
  const ded = Number(ps.deduction_paise) - oldCut + deduct
  await c.db.batch([
    c.db.prepare(`UPDATE payslips SET gross_paise = ?, deduction_paise = ?, net_paise = ?, breakup = ? WHERE id = ?`).bind(gross, ded, gross - ded, JSON.stringify(b), ps.id),
    c.db.prepare(`UPDATE payroll_runs SET gross_paise = (SELECT COALESCE(SUM(gross_paise),0) FROM payslips WHERE payroll_run_id = ?1),
        deduction_paise = (SELECT COALESCE(SUM(deduction_paise),0) FROM payslips WHERE payroll_run_id = ?1),
        net_paise = (SELECT COALESCE(SUM(net_paise),0) FROM payslips WHERE payroll_run_id = ?1) WHERE id = ?1`).bind(run.id),
  ])
}
