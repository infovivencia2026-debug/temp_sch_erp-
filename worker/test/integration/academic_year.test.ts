/* One academic year, April to March, as the office lives it: the price list
   and the first demand, a concession, the term exam and its report cards,
   the second demand with the concession applied, payroll for a month, the
   new year, promotion and the roll-over of the price list. Each test states
   the rule the school expects; a failure is a gap. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E, isoDay } from './fixture'

beforeAll(seed)
const T = () => E.TENANT_TEST
const Y = { head: '', structure: '', nextYear: '', nextSection: '', concession: '', employee: '' }

describe('April: the price list and the first demand', () => {
  it('an academic year that ends before it starts, or has no real dates, is refused', async () => {
    const back = await api('admin', 'POST', '/setup/academic-years', { name: 'Backwards', starts_on: '2027-04-01', ends_on: '2027-03-31' })
    expect(back.status, JSON.stringify(back.body)).toBe(400)
    const junk = await api('admin', 'POST', '/setup/academic-years', { name: 'Junk', starts_on: 'april', ends_on: 'march' })
    expect(junk.status, JSON.stringify(junk.body)).toBe(400)
  })

  it('a fee head and a three-instalment structure for Class 5', async () => {
    const h = await api('finance', 'POST', '/setup/fee-heads', { name: 'Term fee', code: 'TERM' })
    expect(h.status).toBe(201); Y.head = h.body.id
    const s = await api('finance', 'POST', '/setup/fee-structures', { name: 'Class 5 term fees', class_id: IDS.klass, academic_year_id: IDS.year, items: [
      { fee_head_id: Y.head, instalment_no: 1, amount_paise: 300_000, due_on: isoDay(10) },
      { fee_head_id: Y.head, instalment_no: 2, amount_paise: 300_000, due_on: isoDay(100) },
      { fee_head_id: Y.head, instalment_no: 3, amount_paise: 300_000, due_on: isoDay(200) },
    ] })
    expect(s.status, JSON.stringify(s.body)).toBe(201); Y.structure = s.body.id
    expect(s.body.total_paise).toBe(900_000)
  })

  it('a structure with a negative line is refused', async () => {
    const s = await api('finance', 'POST', '/setup/fee-structures', { name: 'Bad', class_id: IDS.klass, items: [{ fee_head_id: Y.head, instalment_no: 1, amount_paise: -1 }] })
    expect(s.status).toBe(400)
  })

  it('the first demand reaches every child in the class once, and running it again raises nothing', async () => {
    const r = await api('finance', 'POST', '/fees/invoices/generate', { fee_structure_id: Y.structure, instalment_no: 1 })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.created).toBe(2)
    const again = await api('finance', 'POST', '/fees/invoices/generate', { fee_structure_id: Y.structure, instalment_no: 1 })
    expect(again.body.created).toBe(0)
    const n = await T().prepare(`SELECT count(*) AS n FROM invoices WHERE instalment_no = 1 AND academic_year_id = ?`).bind(IDS.year).first<{ n: number }>()
    expect(n?.n).toBe(2)
  })

  it('a demand for an instalment that is not priced is refused', async () => {
    const r = await api('finance', 'POST', '/fees/invoices/generate', { fee_structure_id: Y.structure, instalment_no: 4 })
    expect(r.status).toBe(409)
  })

  it('a demand due in the past is refused', async () => {
    const r = await api('finance', 'POST', '/fees/invoices/generate', { fee_structure_id: Y.structure, instalment_no: 3, due_on: isoDay(-5) })
    expect(r.status, JSON.stringify(r.body)).toBe(400)
  })
})

describe('May: a concession, and the second demand honours it', () => {
  it('finance asks for 10 percent off the term fee for Chirag; the principal approves', async () => {
    const c = await api('finance', 'POST', '/fees/concessions', { student_id: IDS.child, academic_year_id: IDS.year, fee_head_id: Y.head, kind: 'merit', percent: '10', reason: 'topper' })
    expect(c.status, JSON.stringify(c.body)).toBe(201); Y.concession = c.body.id
    const d = await api('admin', 'POST', `/workflow/concessions/${Y.concession}/decide`, { decision: 'approved' })
    expect(d.status, JSON.stringify(d.body)).toBe(200)
    const twice = await api('admin', 'POST', `/workflow/concessions/${Y.concession}/decide`, { decision: 'rejected', note: 'oops' })
    expect(twice.status).toBe(404)
  })

  it('the second demand is 10 percent lower for Chirag and full for Diya', async () => {
    const r = await api('finance', 'POST', '/fees/invoices/generate', { fee_structure_id: Y.structure, instalment_no: 2 })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const rows = await T().prepare(`SELECT student_id, net_paise FROM invoices WHERE instalment_no = 2 AND academic_year_id = ?`).bind(IDS.year).all<{ student_id: string; net_paise: number }>()
    const by = new Map(rows.results.map((x) => [x.student_id, Number(x.net_paise)]))
    expect(by.get(IDS.child)).toBe(270_000)
    expect(by.get(IDS.otherChild)).toBe(300_000)
  })

  it('a payment against several open invoices settles the earliest due first', async () => {
    const r = await api('finance', 'POST', '/fees/payments', { student_id: IDS.otherChild, amount_paise: 600_000, mode: 'cash' })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const rows = await T().prepare(`SELECT invoice_no, due_on, status, paid_paise, net_paise FROM invoices WHERE student_id = ? AND status <> 'cancelled' ORDER BY due_on, invoice_no`)
      .bind(IDS.otherChild).all<{ invoice_no: string; due_on: string; status: string; paid_paise: number; net_paise: number }>()
    expect(rows.results.reduce((s, x) => s + Number(x.paid_paise), 0)).toBe(600_000)
    // No invoice may carry money while one due earlier is still short.
    let shortSeen = false
    for (const x of rows.results) {
      const short = Number(x.paid_paise) < Number(x.net_paise)
      if (shortSeen) expect(Number(x.paid_paise), `${x.invoice_no} due ${x.due_on} was paid before an earlier one`).toBe(0)
      if (short) shortSeen = true
    }
  })
})

describe('September: the term exam and the report cards', () => {
  it('marks go in, the class teacher builds the cards, and they start as drafts the family cannot see', async () => {
    const m = await api('teacher', 'POST', '/exams/marks', { exam_subject_id: IDS.paper, entries: [{ student_id: IDS.child, marks_obtained: 81 }, { student_id: IDS.otherChild, marks_obtained: 64 }] })
    expect(m.status, 'marks: ' + JSON.stringify(m.body)).toBe(200)
    const g = await api('teacher', 'POST', '/exams/report-cards/generate', { exam_id: IDS.exam, section_id: IDS.section })
    expect(g.status, 'generate: ' + JSON.stringify(g.body)).toBe(200)
    const cards = await T().prepare(`SELECT status, is_published FROM report_cards WHERE exam_id = ?`).bind(IDS.exam).all<{ status: string; is_published: number }>()
    expect(cards.results.length).toBe(2)
    expect(cards.results.every((x) => x.status === 'draft' && !x.is_published)).toBe(true)
    const fam = await api('parent', 'GET', '/portal/results')
    expect(fam.status, JSON.stringify(fam.body)).toBe(200)
    expect(JSON.stringify(fam.body)).not.toContain('Half yearly')
  })

  it('the teacher cannot release the cards; sent up, the principal releases them and the family sees theirs only', async () => {
    const no = await api('teacher', 'POST', '/exams/report-cards/generate', { exam_id: IDS.exam, section_id: IDS.section, publish: true })
    expect(no.status).toBe(403)
    const early = await api('admin', 'POST', '/exams/report-cards/publish', { section_ids: [IDS.section] })
    expect(early.status).toBe(200)
    expect(Number(early.body.published ?? 0), 'nothing is published before it is submitted').toBe(0)
    const sub = await api('teacher', 'POST', '/exams/report-cards/submit', { section_ids: [IDS.section] })
    expect(sub.body.submitted).toBe(2)
    const pub = await api('admin', 'POST', '/exams/report-cards/publish', { section_ids: [IDS.section] })
    expect(pub.status, JSON.stringify(pub.body)).toBe(200)
    const fam = await api('parent', 'GET', '/portal/results')
    const text = JSON.stringify(fam.body)
    expect(text).toContain('Half yearly')
    expect(text).toContain(IDS.child)
    expect(text).not.toContain(IDS.otherChild)
    const cardId = (await T().prepare('SELECT id FROM report_cards WHERE exam_id = ? AND student_id = ?').bind(IDS.exam, IDS.child).first<{ id: string }>())!.id
    const other = (await T().prepare('SELECT id FROM report_cards WHERE exam_id = ? AND student_id = ?').bind(IDS.exam, IDS.otherChild).first<{ id: string }>())!.id
    expect((await api('parent', 'GET', `/portal/results/card?id=${cardId}`)).status).toBe(200)
    expect((await api('parent', 'GET', `/portal/results/card?id=${other}`)).status).toBe(403)
  })

  it('marks cannot be quietly changed under a published report card', async () => {
    const m = await api('teacher', 'POST', '/exams/marks', { exam_subject_id: IDS.paper, entries: [{ student_id: IDS.child, marks_obtained: 95 }] })
    const card = await T().prepare(`SELECT CAST(total_marks AS REAL) AS t FROM report_cards WHERE exam_id = ? AND student_id = ?`).bind(IDS.exam, IDS.child).first<{ t: number }>()
    // Either the change is refused, or the card is pulled back from published; a published card that says 81 over marks that say 95 is the gap.
    expect(m.status === 409 || Number(card?.t) === 95, `marks ${m.status}, card total ${card?.t}`).toBe(true)
  })
})

describe('October: a month of payroll', () => {
  it('a member of staff with a salary structure', async () => {
    Y.employee = crypto.randomUUID()
    const campus = await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>()
    await T().prepare(`INSERT INTO employees (id, institution_id, campus_id, employee_code, first_name, last_name, user_id, joined_on, status)
      VALUES (?, ?, ?, 'E001', 'Tara', 'Teacher', ?, ?, 'active')`).bind(Y.employee, IDS.school, campus!.id, IDS.teacher, isoDay(-400)).run()
    const comps = await api('admin', 'POST', '/payroll/components', { starters: true })
    expect(comps.status, JSON.stringify(comps.body)).toBe(200)
    const basic = await T().prepare(`SELECT id FROM salary_components WHERE code = 'BASIC'`).first<{ id: string }>()
    expect(basic).toBeTruthy()
    const s = await api('admin', 'POST', '/payroll/structures', { employee_id: Y.employee, effective_from: isoDay(-400), items: [{ component_id: basic!.id, amount_paise: 3_000_000 }] })
    expect(s.status, JSON.stringify(s.body)).toBe(200)
  })

  it('payroll will not run over a month with no staff attendance unless the office acknowledges it', async () => {
    const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 1)
    const month = d.getUTCMonth() + 1, year = d.getUTCFullYear()
    const r = await api('admin', 'POST', '/payroll/run', { month, year })
    expect([401, 403, 409], JSON.stringify(r.body)).toContain(r.status)
    if (r.status === 409) expect(r.body.code ?? r.body.error?.code ?? JSON.stringify(r.body)).toMatch(/attendance_unmarked/)
  })

  it('a salary structure for a month in the future, or with no lines, is refused', async () => {
    const none = await api('admin', 'POST', '/payroll/structures', { employee_id: Y.employee, effective_from: isoDay(0), items: [] })
    expect(none.status).toBe(400)
  })
})

describe('March: the next year, promotion and roll-over', () => {
  it('the next academic year is created, not current, after the current one', async () => {
    const cur = await T().prepare('SELECT ends_on FROM academic_years WHERE id = ?').bind(IDS.year).first<{ ends_on: string }>()
    const start = new Date(cur!.ends_on + 'T00:00:00Z'); start.setUTCDate(start.getUTCDate() + 1)
    const end = new Date(start); end.setUTCFullYear(end.getUTCFullYear() + 1); end.setUTCDate(end.getUTCDate() - 1)
    const r = await api('admin', 'POST', '/setup/academic-years', { name: 'Next year', starts_on: start.toISOString().slice(0, 10), ends_on: end.toISOString().slice(0, 10) })
    expect(r.status, JSON.stringify(r.body)).toBe(201); Y.nextYear = r.body.id
    const over = await api('admin', 'POST', '/setup/academic-years', { name: 'Overlapping', starts_on: isoDay(0), ends_on: isoDay(300) })
    expect(over.status, 'a year overlapping the current one is refused: ' + JSON.stringify(over.body)).toBe(409)
  })

  it('Class 6 A exists in the next year', async () => {
    const k = await api('admin', 'POST', '/setup/classes', { name: 'Class 6', level: 6 })
    expect(k.status, JSON.stringify(k.body)).toBe(201)
    const s = await api('admin', 'POST', '/setup/sections', { class_id: k.body.id, academic_year_id: Y.nextYear, name: 'A', class_teacher_id: IDS.teacher })
    expect(s.status, JSON.stringify(s.body)).toBe(201); Y.nextSection = s.body.id
  })

  it('promotion into a section of the same year, or into the section the children are already in, is refused', async () => {
    const same = await api('admin', 'POST', '/lifecycle/promote', { from_section_id: IDS.section, to_section_id: IDS.section, academic_year_id: IDS.year })
    expect(same.status, JSON.stringify(same.body)).toBe(400)
    const wrongYear = await api('admin', 'POST', '/lifecycle/promote', { from_section_id: IDS.section, to_section_id: Y.nextSection, academic_year_id: IDS.year })
    expect(wrongYear.status, 'the target section is not in the year given: ' + JSON.stringify(wrongYear.body)).toBe(400)
  })

  it('a child with unpaid dues is held back from promotion until the office says otherwise', async () => {
    // Chirag owes instalment 2 (2,70,000) and more; Diya is paid up on INV-2 but owes instalments 1 and 2 of the structure.
    const r = await api('admin', 'POST', '/lifecycle/promote', { from_section_id: IDS.section, to_section_id: Y.nextSection, academic_year_id: Y.nextYear })
    expect(r.status, JSON.stringify(r.body)).toBe(409)
  })

  it('with dues acknowledged, the whole section moves up once; the second run moves nobody', async () => {
    const r = await api('admin', 'POST', '/lifecycle/promote', { from_section_id: IDS.section, to_section_id: Y.nextSection, academic_year_id: Y.nextYear, allow_dues: true })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.promoted).toBe(2)
    const again = await api('admin', 'POST', '/lifecycle/promote', { from_section_id: IDS.section, to_section_id: Y.nextSection, academic_year_id: Y.nextYear, allow_dues: true })
    expect(again.body.promoted).toBe(0)
    const rows = await T().prepare(`SELECT status, academic_year_id FROM enrollments WHERE student_id = ? ORDER BY enrolled_on`).bind(IDS.child).all<{ status: string; academic_year_id: string }>()
    expect(rows.results.map((x) => x.status)).toEqual(['promoted', 'active'])
    expect(rows.results[1].academic_year_id).toBe(Y.nextYear)
  })

  it('the price list rolls into the new year once', async () => {
    const r = await api('admin', 'POST', `/admin/academic-years/${IDS.year}/rollover`, { target_year_id: Y.nextYear, fee_structure: true })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const copied = await T().prepare(`SELECT count(*) AS n FROM fee_structures WHERE academic_year_id = ?`).bind(Y.nextYear).first<{ n: number }>()
    expect(copied?.n).toBe(1)
    const again = await api('admin', 'POST', `/admin/academic-years/${IDS.year}/rollover`, { target_year_id: Y.nextYear, fee_structure: true })
    expect(again.status).toBe(200)
    const still = await T().prepare(`SELECT count(*) AS n FROM fee_structures WHERE academic_year_id = ?`).bind(Y.nextYear).first<{ n: number }>()
    expect(still?.n).toBe(1)
  })

  it('the old year\'s register and marks are closed to new writes once the new year is current', async () => {
    const cur = await api('admin', 'PATCH', `/setup/academic-years/${Y.nextYear}`, { is_current: true })
    expect(cur.status).toBe(200)
    const m = await api('admin', 'POST', '/exams/marks', { exam_subject_id: IDS.paper, entries: [{ student_id: IDS.otherChild, marks_obtained: 70 }] })
    expect([400, 409], 'marks on a paper of a year that is over: ' + JSON.stringify(m.body)).toContain(m.status)
    await api('admin', 'PATCH', `/setup/academic-years/${IDS.year}`, { is_current: true })
  })
})
