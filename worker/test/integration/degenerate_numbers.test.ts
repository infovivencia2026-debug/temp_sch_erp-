/* Audit 2026-09-23 Tier 3: numbers from degenerate sources, and writes that
   answered 200 while dropping what was sent. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E, isoDay } from './fixture'

beforeAll(seed)

const T = () => E.TENANT_TEST
const campus = async () => (await T().prepare('SELECT id FROM campuses ORDER BY created_at LIMIT 1').first<{ id: string }>())!.id

describe('numbers from degenerate sources', () => {
  it('RTE share with nobody admitted is no data, not 0% (or green)', async () => {
    const { status, body } = await api('admin', 'GET', '/admissions/register')
    expect(status).toBe(200)
    expect(body.admitted_total).toBe(0)
    expect(body.rte_percent).toBeNull()
  })

  it('a lead that has applied is not follow-up overdue', async () => {
    const cid = await campus()
    const open = crypto.randomUUID(), applied = crypto.randomUUID()
    await T().batch([open, applied].map((id, i) => T().prepare(`INSERT INTO enquiries (id, institution_id, campus_id, student_name, phone, status, next_follow_up)
        VALUES (?, ?, ?, ?, '9000000100', ?, ?)`).bind(id, IDS.school, cid, `Lead ${i}`, i ? 'applied' : 'contacted', isoDay(-3))))
    const { body } = await api('admin', 'GET', '/admissions/leads')
    const by = new Map(body.items.map((l: any) => [l.id, l]))
    expect((by.get(open) as any).follow_up_overdue).toBe(true)
    expect((by.get(applied) as any).follow_up_overdue).toBe(false)
  })

  it('performance trend: pass % is per student, and unmarked papers are not zeros', async () => {
    const exam = crypto.randomUUID(), p1 = crypto.randomUUID(), p2 = crypto.randomUUID(), cs2 = crypto.randomUUID(), sub2 = crypto.randomUUID()
    const cid = await campus()
    await T().batch([
      T().prepare(`INSERT INTO subjects (id, institution_id, campus_id, name, code) VALUES (?, ?, ?, 'Science', 'SCI')`).bind(sub2, IDS.school, cid),
      T().prepare(`INSERT INTO class_subjects (id, institution_id, class_id, subject_id) VALUES (?, ?, ?, ?)`).bind(cs2, IDS.school, IDS.klass, sub2),
      T().prepare(`INSERT INTO exams (id, institution_id, campus_id, academic_year_id, name, kind, starts_on, ends_on) VALUES (?, ?, ?, ?, 'Unit test T3', 'unit', ?, ?)`)
        .bind(exam, IDS.school, cid, IDS.year, isoDay(-4), isoDay(-3)),
      ...[[p1, IDS.classSubject], [p2, cs2]].map(([pid, csid]) => T().prepare(`INSERT INTO exam_subjects (id, institution_id, exam_id, class_subject_id, max_marks, pass_marks)
          VALUES (?, ?, ?, ?, '100', '33')`).bind(pid, IDS.school, exam, csid)),
      // Chirag passes both; Diya passes one and fails one. Per mark-row that is 75%, per student 50%.
      ...[[p1, IDS.child, '80'], [p2, IDS.child, '70'], [p1, IDS.otherChild, '60'], [p2, IDS.otherChild, '10']].map(([pid, sid, m]) =>
        T().prepare(`INSERT INTO marks (id, institution_id, exam_subject_id, student_id, marks_obtained) VALUES (?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), IDS.school, pid, sid, m)),
    ])
    const row = async () => ((await api('admin', 'GET', '/rollups/performance/trend')).body.items as any[]).find((r) => r.exam_id === exam)
    let r = await row()
    expect(r.pass_pct).toBe(50)
    expect(r.avg_pct).toBe(55)
    // A mark row with nothing entered (not absent) must not drag the average down as a zero.
    await T().prepare(`UPDATE marks SET marks_obtained = NULL WHERE exam_subject_id = ? AND student_id = ?`).bind(p2, IDS.otherChild).run()
    r = await row()
    expect(r.avg_pct).toBe(70)
    expect(r.pass_pct).toBe(100)
  })

  it('annual salary is paid-so-far plus the salary on file, not one payslip times twelve', async () => {
    const cid = await campus()
    const emp = crypto.randomUUID(), comp = crypto.randomUUID(), ss = crypto.randomUUID(), run = crypto.randomUUID()
    await T().batch([
      T().prepare(`INSERT INTO employees (id, institution_id, campus_id, employee_code, first_name) VALUES (?, ?, ?, 'E-T3', 'Ravi')`).bind(emp, IDS.school, cid),
      T().prepare(`INSERT INTO salary_components (id, institution_id, code, name, kind) VALUES (?, ?, 'BASIC_T3', 'Basic', 'earning')`).bind(comp, IDS.school),
      T().prepare(`INSERT INTO salary_structures (id, institution_id, employee_id, effective_from) VALUES (?, ?, ?, '2000-01-01')`).bind(ss, IDS.school, emp),
      T().prepare(`INSERT INTO salary_structure_items (id, institution_id, salary_structure_id, component_id, amount_paise) VALUES (?, ?, ?, ?, 5000000)`)
        .bind(crypto.randomUUID(), IDS.school, ss, comp),
      // One month with a big arrears payment: 2,00,000 rupees.
      T().prepare(`INSERT INTO payroll_runs (id, institution_id, period_month, period_year) VALUES (?, ?, 5, 2025)`).bind(run, IDS.school),
      T().prepare(`INSERT INTO payslips (id, institution_id, payroll_run_id, employee_id, gross_paise) VALUES (?, ?, ?, ?, 20000000)`)
        .bind(crypto.randomUUID(), IDS.school, run, emp),
    ])
    const { status, body } = await api('admin', 'GET', `/payroll/tax?fy=2025&employee_id=${emp}`)
    expect(status).toBe(200)
    expect(body.months_paid).toBe(1)
    expect(body.projection_basis).toBe('salary_structure')
    expect(body.gross_annual_paise).toBe(20000000 + 11 * 5000000)
  })
})

describe('writes are persisted or refused, never dropped', () => {
  it('rescheduling a live class persists the new time; moving it to a section is refused', async () => {
    const made = await api('admin', 'POST', '/teaching/virtual-classes', { section_id: IDS.section, topic: 'Fractions', scheduled_at: '2030-01-01T04:30:00Z' })
    expect(made.status).toBe(200)
    const id = made.body.id
    const put = await api('admin', 'PUT', `/teaching/virtual-classes/${id}`, { scheduled_at: '2030-01-02T05:00:00Z', duration_minutes: 55 })
    expect(put.status).toBe(200)
    const row = await T().prepare('SELECT scheduled_at, duration_minutes FROM virtual_class_sessions WHERE id = ?').bind(id).first<any>()
    expect(row).toEqual({ scheduled_at: '2030-01-02T05:00:00.000Z', duration_minutes: 55 })
    expect((await api('admin', 'PUT', `/teaching/virtual-classes/${id}`, { scheduled_at: 'soon' })).status).toBe(400)
    expect((await api('admin', 'PUT', `/teaching/virtual-classes/${id}`, { section_id: IDS.section })).status).toBe(400)
  })

  it('re-targeting a worksheet persists the class-subject; changing its audience is refused', async () => {
    const made = await api('admin', 'POST', '/teaching/materials', { title: 'Sheet 1', kind: 'worksheet', section_id: IDS.section, external_url: 'https://example.org/s1' })
    expect(made.status).toBe(200)
    const id = made.body.id
    const put = await api('admin', 'PUT', `/teaching/materials/${id}`, { class_subject_id: IDS.classSubject, section_id: null })
    expect(put.status).toBe(200)
    const row = await T().prepare('SELECT class_subject_id, section_id FROM study_materials WHERE id = ?').bind(id).first<any>()
    expect(row).toEqual({ class_subject_id: IDS.classSubject, section_id: null })
    expect((await api('admin', 'PUT', `/teaching/materials/${id}`, { audience: 'school' })).status).toBe(400)
  })

  it('moving a bus to another campus persists the campus', async () => {
    const other = crypto.randomUUID()
    await T().prepare(`INSERT INTO campuses (id, institution_id, name, code) VALUES (?, ?, 'North', 'N')`).bind(other, IDS.school).run()
    const made = await api('admin', 'POST', '/ops/transport/vehicles', { registration_no: 'KA01AB1234', capacity: 30 })
    expect([200, 201]).toContain(made.status)
    const id = made.body.id
    const put = await api('admin', 'PUT', `/ops/transport/vehicles/${id}`, { registration_no: 'KA01AB1234', capacity: 30, campus_id: other })
    expect(put.status).toBe(200)
    expect((await T().prepare('SELECT campus_id FROM vehicles WHERE id = ?').bind(id).first<any>()).campus_id).toBe(other)
    expect((await api('admin', 'PUT', `/ops/transport/vehicles/${id}`, { registration_no: 'KA01AB1234', capacity: 30, campus_id: crypto.randomUUID() })).status).toBe(400)
  })
})
