/* The MyClassBoard gaps (docs/MCB_vs_XULO_comparison.pdf, section 4): the
   fixed finance reports, staff tasks and reporting managers, the paper
   behind a concession, leave kinds, and reading levels. Each answer and
   each refusal. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, isoDay, E } from './fixture'

beforeAll(seed)

const T = () => E.TENANT_TEST
const uuid = (n: number) => `00000000-0000-4000-8000-${String(700 + n).padStart(12, '0')}`
const EMP = { teacher: uuid(1), junior: uuid(2), other: uuid(3) }
const today = isoDay(0)
const month = today.slice(0, 7)

async function campus(): Promise<string> {
  return (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
}

/* The teacher is on the roll; a junior reports to the teacher; a third
   person reports to nobody. Idempotent across files. */
async function staff(): Promise<void> {
  const cid = await campus()
  await T().batch([
    T().prepare(`INSERT OR IGNORE INTO employees (id, institution_id, campus_id, user_id, employee_code, first_name, last_name) VALUES (?, ?, ?, ?, 'E-G1', 'Tara', 'Teacher')`)
      .bind(EMP.teacher, IDS.school, cid, IDS.teacher),
    T().prepare(`INSERT OR IGNORE INTO employees (id, institution_id, campus_id, employee_code, first_name, reports_to) VALUES (?, ?, ?, 'E-G2', 'Junior', ?)`)
      .bind(EMP.junior, IDS.school, cid, EMP.teacher),
    T().prepare(`INSERT OR IGNORE INTO employees (id, institution_id, campus_id, employee_code, first_name) VALUES (?, ?, ?, 'E-G3', 'Other')`)
      .bind(EMP.other, IDS.school, cid),
  ])
}

describe('fixed finance reports', () => {
  beforeAll(async () => {
    const cid = await campus()
    await T().batch([
      T().prepare(`INSERT OR IGNORE INTO payments (id, institution_id, campus_id, student_id, receipt_no, amount_paise, allocated_paise, mode, paid_on, reference_no, bank_name, cheque_date, status, created_at)
          VALUES (?, ?, ?, ?, 'R-G1', 150000, 150000, 'cheque', ?, '000123', 'State Bank', ?, 'pending', ?)`)
        .bind(uuid(10), IDS.school, cid, IDS.child, today, isoDay(20), new Date().toISOString()),
      T().prepare(`INSERT OR IGNORE INTO payments (id, institution_id, campus_id, student_id, receipt_no, amount_paise, allocated_paise, mode, paid_on, status, created_at)
          VALUES (?, ?, ?, ?, 'R-G2', 50000, 50000, 'cash', ?, 'success', ?)`)
        .bind(uuid(11), IDS.school, cid, IDS.child, today, new Date().toISOString()),
      T().prepare(`INSERT OR IGNORE INTO payments (id, institution_id, campus_id, student_id, receipt_no, amount_paise, allocated_paise, mode, paid_on, status, created_at)
          VALUES (?, ?, ?, ?, 'R-G3', 100000, 100000, 'card', ?, 'success', ?)`)
        .bind(uuid(12), IDS.school, cid, IDS.child, today, new Date().toISOString()),
      T().prepare(`INSERT OR IGNORE INTO student_bank_accounts (id, institution_id, student_id, account_holder_name, relationship, bank_name, account_number, ifsc, is_primary, is_active, created_at, updated_at)
          VALUES (?, ?, ?, 'Pavan Parent', 'father', 'State Bank', '123456789012', 'SBIN0000123', 1, 1, ?, ?)`)
        .bind(uuid(13), IDS.school, IDS.child, new Date().toISOString(), new Date().toISOString()),
    ])
  })

  it('cheque deposit dashboard puts a post-dated cheque under held', async () => {
    const r = await api('finance', 'GET', '/finance/reports/cheque-deposits')
    expect(r.status).toBe(200)
    const mine = r.body.items.find((v: { receipt_no: string }) => v.receipt_no === 'R-G1')
    expect(mine.stage).toBe('held')
    expect(mine.cheque_no).toBe('000123')
    expect(r.body.totals.held.count).toBeGreaterThanOrEqual(1)
  })

  it('bank submission form groups the day by bank and keeps cash apart', async () => {
    const r = await api('finance', 'GET', `/finance/reports/bank-submission?on=${today}`)
    expect(r.status).toBe(200)
    expect(r.body.cash_paise).toBeGreaterThanOrEqual(50000)
    const sbi = r.body.instruments.find((g: { bank_name: string }) => g.bank_name === 'State Bank')
    expect(sbi.amount_paise).toBeGreaterThanOrEqual(150000)
    expect(r.body.total_paise).toBe(r.body.cash_paise + r.body.instrument_paise)
    expect((await api('finance', 'GET', '/finance/reports/bank-submission?on=yesterday')).status).toBe(400)
  })

  it('outstanding as at a month end is billed minus paid by then, class by class', async () => {
    const r = await api('finance', 'GET', `/finance/reports/outstanding-as-at?month=${month}`)
    expect(r.status).toBe(200)
    expect(r.body.as_at.startsWith(month)).toBe(true)
    expect(Array.isArray(r.body.classes)).toBe(true)
    expect(r.body.total_outstanding_paise).toBeGreaterThanOrEqual(0)
    expect((await api('finance', 'GET', '/finance/reports/outstanding-as-at?month=2026-13')).status).toBe(400)
  })

  it('fee plan details lists each child head by head', async () => {
    const r = await api('finance', 'GET', '/finance/reports/fee-plan-details')
    expect(r.status).toBe(200)
    expect(r.body.year).toBeTruthy()
    const row = r.body.items.find((v: { student_id: string }) => v.student_id === IDS.child)
    expect(row).toBeTruthy()
    expect(row.fee_head).toBe('Tuition')
    expect(row.net_paise).toBe(row.amount_paise - row.discount_paise)
  })

  it('month-wise report walks every month of the range with a running outstanding', async () => {
    const r = await api('finance', 'GET', `/finance/reports/monthwise?from=${isoDay(-45)}&to=${today}`)
    expect(r.status).toBe(200)
    expect(r.body.items.length).toBeGreaterThanOrEqual(2)
    const last = r.body.items.at(-1)
    expect(last.month).toBe(month)
    expect(last.collected_paise).toBeGreaterThanOrEqual(150000)
    expect((await api('finance', 'GET', '/finance/reports/monthwise?from=x')).status).toBe(400)
  })

  it('parent bank details mask the account number', async () => {
    const r = await api('finance', 'GET', '/finance/reports/parent-bank-details')
    expect(r.status).toBe(200)
    const row = r.body.items.find((v: { ifsc: string }) => v.ifsc === 'SBIN0000123')
    expect(row.account_number).toBe('••••••••9012')
    expect(row.is_primary).toBe(true)
  })

  it('card charges use the rate the school sets', async () => {
    expect((await api('finance', 'PUT', '/finance/reports/card-charges/settings', { rate_bp: 5000 })).status).toBe(400)
    expect((await api('finance', 'PUT', '/finance/reports/card-charges/settings', { rate_bp: 150 })).status).toBe(200)
    const r = await api('finance', 'GET', `/finance/reports/card-charges?from=${today}&to=${today}`)
    expect(r.status).toBe(200)
    expect(r.body.rate_bp).toBe(150)
    const card = r.body.items.find((v: { mode: string }) => v.mode === 'card')
    expect(card.charge_paise).toBe(Math.round(card.amount_paise * 150 / 10000))
    expect(r.body.charge_paise).toBeGreaterThanOrEqual(1500)
  })

  it('refuses a parent and a teacher', async () => {
    for (const who of ['parent', 'teacher'] as const) {
      expect((await api(who, 'GET', '/finance/reports/cheque-deposits')).status).toBe(403)
      expect((await api(who, 'GET', '/finance/reports/parent-bank-details')).status).toBe(403)
    }
  })
})

describe('staff tasks and reporting managers', () => {
  beforeAll(staff)
  let taskId = ''

  it('HR hands a task to anyone; the person sees it under mine', async () => {
    expect((await api('admin', 'POST', '/hr/tasks', { title: '', assigned_to: EMP.teacher })).status).toBe(400)
    expect((await api('admin', 'POST', '/hr/tasks', { title: 'Count the chairs', assigned_to: EMP.teacher, due_on: 'soon' })).status).toBe(400)
    const r = await api('admin', 'POST', '/hr/tasks', { title: 'Count the chairs', assigned_to: EMP.teacher, due_on: isoDay(-1), priority: 'high' })
    expect(r.status).toBe(201)
    taskId = r.body.id
    const mine = await api('teacher', 'GET', '/hr/tasks?for=mine')
    expect(mine.status).toBe(200)
    const row = mine.body.items.find((v: { id: string }) => v.id === taskId)
    expect(row.overdue).toBe(true)
    expect(mine.body.summary.overdue).toBeGreaterThanOrEqual(1)
  })

  it('a manager hands tasks only to their own people', async () => {
    expect((await api('teacher', 'POST', '/hr/tasks', { title: 'Tidy the lab', assigned_to: EMP.junior })).status).toBe(201)
    expect((await api('teacher', 'POST', '/hr/tasks', { title: 'Tidy the lab', assigned_to: EMP.other })).status).toBe(403)
    const team = await api('teacher', 'GET', '/hr/tasks?for=team')
    expect(team.body.items.some((v: { employee_id: string }) => v.employee_id === EMP.junior)).toBe(true)
  })

  it('the assignee finishes their own task but cannot cancel it', async () => {
    expect((await api('teacher', 'POST', `/hr/tasks/${taskId}/status`, { status: 'cancelled' })).status).toBe(403)
    expect((await api('teacher', 'POST', `/hr/tasks/${taskId}/status`, { status: 'elsewhere' })).status).toBe(400)
    const done = await api('teacher', 'POST', `/hr/tasks/${taskId}/status`, { status: 'done', note: '42 chairs' })
    expect(done.status).toBe(200)
    const report = await api('admin', 'GET', '/hr/tasks/report')
    expect(report.status).toBe(200)
    const me = report.body.items.find((v: { employee_id: string }) => v.employee_id === EMP.teacher)
    expect(Number(me.done)).toBeGreaterThanOrEqual(1)
  })

  it('refuses somebody not on the roll, and everybody from the full list', async () => {
    expect((await api('parent', 'POST', '/hr/tasks', { title: 'x', assigned_to: EMP.teacher })).status).toBe(403)
    expect((await api('parent', 'GET', '/hr/tasks?for=all')).status).toBe(403)
    expect((await api('parent', 'GET', '/hr/tasks/report')).status).toBe(403)
  })

  it('reporting managers: no self, no loops, cleared with empty', async () => {
    expect((await api('admin', 'PUT', `/hr/employees/${EMP.teacher}/reporting-manager`, { reports_to: EMP.teacher })).status).toBe(400)
    expect((await api('admin', 'PUT', `/hr/employees/${EMP.teacher}/reporting-manager`, { reports_to: EMP.junior })).status).toBe(400)
    expect((await api('admin', 'PUT', `/hr/employees/${EMP.other}/reporting-manager`, { reports_to: EMP.teacher })).status).toBe(200)
    const list = await api('admin', 'GET', '/hr/reporting-managers')
    expect(list.status).toBe(200)
    const other = list.body.items.find((v: { id: string }) => v.id === EMP.other)
    expect(other.manager_code).toBe('E-G1')
    expect((await api('admin', 'PUT', `/hr/employees/${EMP.other}/reporting-manager`, { reports_to: '' })).status).toBe(200)
    expect((await api('teacher', 'PUT', `/hr/employees/${EMP.other}/reporting-manager`, { reports_to: EMP.teacher })).status).toBe(403)
  })
})

describe('leave kinds', () => {
  beforeAll(staff)

  it('a permission is hours on one day; a comp off needs no leave type', async () => {
    expect((await api('teacher', 'POST', '/workflow/leave', { kind: 'permission', from_date: today, to_date: isoDay(1), hours: 2, reason: 'bank' })).status).toBe(400)
    expect((await api('teacher', 'POST', '/workflow/leave', { kind: 'permission', from_date: today, to_date: today, hours: 0, reason: 'bank' })).status).toBe(400)
    expect((await api('teacher', 'POST', '/workflow/leave', { kind: 'holiday', from_date: today, to_date: today, reason: 'x' })).status).toBe(400)
    const p = await api('teacher', 'POST', '/workflow/leave', { kind: 'permission', from_date: today, to_date: today, hours: 2, reason: 'bank' })
    expect(p.status).toBe(201)
    const co = await api('teacher', 'POST', '/workflow/leave', { kind: 'comp_off', from_date: isoDay(3), to_date: isoDay(3), reason: 'worked the fete' })
    expect(co.status).toBe(201)
    const mine = await api('teacher', 'GET', '/hr/leave?for=mine')
    const perm = mine.body.items.find((v: { id: string }) => v.id === p.body.id)
    expect(perm.kind).toBe('permission')
    expect(Number(perm.hours)).toBe(2)
    expect(Number(perm.days)).toBe(0.25)
  })

  it('the register accepts work from home', async () => {
    const r = await api('admin', 'POST', '/workflow/staff-attendance', { on_date: today, entries: [{ user_id: IDS.teacher, status: 'wfh' }] })
    expect(r.status).toBe(200)
    expect((await api('admin', 'POST', '/workflow/staff-attendance', { on_date: today, entries: [{ user_id: IDS.teacher, status: 'home' }] })).status).toBe(400)
  })
})

describe('the paper behind a concession', () => {
  const cid = uuid(20)
  beforeAll(async () => {
    await T().prepare(`INSERT OR IGNORE INTO fee_concessions (id, institution_id, student_id, kind, percent, reason, status, created_at) VALUES (?, ?, ?, 'percent', '10', 'sibling', 'approved', ?)`)
      .bind(cid, IDS.school, IDS.child, new Date().toISOString()).run()
  })

  it('keeps a note and refuses an empty or foreign attachment', async () => {
    expect((await api('finance', 'POST', `/fees/concessions/${cid}/document`, {})).status).toBe(400)
    expect((await api('finance', 'POST', `/fees/concessions/${cid}/document`, { file_id: 'nope' })).status).toBe(400)
    expect((await api('finance', 'POST', `/fees/concessions/${cid}/document`, { file_id: uuid(99) })).status).toBe(400)
    expect((await api('finance', 'POST', `/fees/concessions/${uuid(98)}/document`, { note: 'x' })).status).toBe(404)
    const r = await api('finance', 'POST', `/fees/concessions/${cid}/document`, { note: 'Signed undertaking in file 12' })
    expect(r.status).toBe(200)
    const list = await api('finance', 'GET', '/fees/concessions?status=approved')
    const row = list.body.items.find((v: { id: string }) => v.id === cid)
    expect(row.document_note).toBe('Signed undertaking in file 12')
    expect((await api('parent', 'POST', `/fees/concessions/${cid}/document`, { note: 'x' })).status).toBe(403)
  })
})

describe('reading levels', () => {
  it('records a measurement, tags a title and reports the summary', async () => {
    expect((await api('admin', 'POST', `/ops/library/reading-levels/${IDS.child}`, { level: '' })).status).toBe(400)
    expect((await api('admin', 'POST', `/ops/library/reading-levels/${IDS.child}`, { level: '600L', measured_on: 'today' })).status).toBe(400)
    expect((await api('admin', 'POST', `/ops/library/reading-levels/${uuid(97)}`, { level: '600L' })).status).toBe(404)
    const r = await api('admin', 'POST', `/ops/library/reading-levels/${IDS.child}`, { level: '600L', measured_on: isoDay(-2), note: 'fluent' })
    expect(r.status).toBe(200)
    const title = uuid(30)
    await T().prepare(`INSERT OR IGNORE INTO library_titles (id, institution_id, campus_id, title) VALUES (?, ?, ?, 'Charlotte''s Web')`).bind(title, IDS.school, await campus()).run()
    expect((await api('admin', 'PUT', `/ops/library/titles/${title}/reading-level`, { level: '600L' })).status).toBe(200)
    expect((await api('admin', 'PUT', `/ops/library/titles/${uuid(96)}/reading-level`, { level: '600L' })).status).toBe(404)
    const all = await api('admin', 'GET', '/ops/library/reading-levels')
    expect(all.status).toBe(200)
    const child = all.body.items.find((v: { student_id: string }) => v.student_id === IDS.child)
    expect(child.level).toBe('600L')
    expect(all.body.titles_by_level.find((v: { level: string }) => v.level === '600L').titles).toBeGreaterThanOrEqual(1)
    expect(all.body.summary.measured).toBeGreaterThanOrEqual(1)
    const history = await api('admin', 'GET', `/ops/library/reading-levels/${IDS.child}`)
    expect(history.body.items[0].level).toBe('600L')
    expect((await api('parent', 'GET', '/ops/library/reading-levels')).status).toBe(403)
    expect((await api('parent', 'POST', `/ops/library/reading-levels/${IDS.child}`, { level: '600L' })).status).toBe(403)
  })
})
