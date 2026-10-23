/* The report card shows only the papers the timetable dated (owner, Yajur,
   2026-10-15), totals over those only, and prints on the school format when
   the school picks it. Uses its own exam and subjects so the shared paper is
   left alone for the other files. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const EXAM = id(800)
const SUB_EN = id(801), SUB_SCI = id(802), SUB_ART = id(803)
const CS_EN = id(811), CS_SCI = id(812), CS_ART = id(813)
const P_EN = id(821), P_SCI = id(822), P_ART = id(823)

let cardId = ''

beforeAll(async () => {
  await seed()
  const T = E.TENANT_TEST
  const campus = (await T.prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
  await T.batch([
    T.prepare(`INSERT INTO exams (id, institution_id, campus_id, academic_year_id, name, kind, starts_on, ends_on) VALUES (?, ?, ?, ?, 'SA 1', 'term', '2026-01-01', '2026-01-05')`)
      .bind(EXAM, IDS.school, campus, IDS.year),
    ...[[SUB_EN, CS_EN, 'English', 'ENG'], [SUB_SCI, CS_SCI, 'Science', 'SCI'], [SUB_ART, CS_ART, 'Art', 'ART']].flatMap(([sid, csid, name, code]) => [
      T.prepare(`INSERT INTO subjects (id, institution_id, campus_id, name, code) VALUES (?, ?, ?, ?, ?)`).bind(sid, IDS.school, campus, name, code),
      T.prepare(`INSERT INTO class_subjects (id, institution_id, class_id, subject_id) VALUES (?, ?, ?, ?)`).bind(csid, IDS.school, IDS.klass, sid),
    ]),
    // Two papers on the timetable, one set up but never dated.
    T.prepare(`INSERT INTO exam_subjects (id, institution_id, exam_id, class_subject_id, max_marks, pass_marks, exam_date) VALUES (?, ?, ?, ?, '80', '26', '2026-01-02')`)
      .bind(P_EN, IDS.school, EXAM, CS_EN),
    T.prepare(`INSERT INTO exam_subjects (id, institution_id, exam_id, class_subject_id, max_marks, pass_marks, exam_date) VALUES (?, ?, ?, ?, '50', '17', '2026-01-03')`)
      .bind(P_SCI, IDS.school, EXAM, CS_SCI),
    T.prepare(`INSERT INTO exam_subjects (id, institution_id, exam_id, class_subject_id, max_marks, pass_marks) VALUES (?, ?, ?, ?, '100', '33')`)
      .bind(P_ART, IDS.school, EXAM, CS_ART),
  ])
}, 180_000)

describe('report card: only the dated papers', () => {
  it('generates totals over the dated papers only', async () => {
    for (const [paper, m] of [[P_EN, 60], [P_SCI, 40], [P_ART, 90]] as const) {
      const { status } = await api('teacher', 'POST', '/exams/marks', { exam_subject_id: paper, entries: [{ student_id: IDS.child, marks_obtained: m }] })
      expect(status).toBe(200)
    }
    const { status } = await api('teacher', 'POST', '/exams/report-cards/generate', { exam_id: EXAM, section_id: IDS.section })
    expect(status).toBe(200)
    const row = await E.TENANT_TEST.prepare(`SELECT id, CAST(total_marks AS REAL) AS total, CAST(max_marks AS REAL) AS max, CAST(percentage AS REAL) AS pct
        FROM report_cards WHERE exam_id = ? AND student_id = ?`).bind(EXAM, IDS.child).first<{ id: string; total: number; max: number; pct: number }>()
    expect(row).toMatchObject({ total: 100, max: 130, pct: 76.92 })
    cardId = row!.id
  }, 180_000)

  it('renders only the two dated subjects', async () => {
    const { status, body } = await api('teacher', 'GET', `/exams/report-cards/render?id=${cardId}`)
    expect(status).toBe(200)
    const html = body.html as string
    expect(html).toContain('English')
    expect(html).toContain('Science')
    expect(html).not.toContain('Art')
    expect(html).toContain('130')
  })

  it('prints on the school format once chosen, without touching a saved design', async () => {
    const set = await api('teacher', 'POST', '/exams/report-cards/design', { design: 'school' })
    expect(set.status).toBe(200)
    const t = await api('teacher', 'GET', '/exams/report-cards/template')
    expect(t.body.template.design).toBe('school')
    const { status, body } = await api('teacher', 'GET', `/exams/report-cards/render?id=${cardId}`)
    expect(status).toBe(200)
    const html = body.html as string
    for (const label of ['ROLL NO', 'GRAND TOTAL', 'Scholastic Grades', "Class Teacher's Remarks", 'Chirag Test', 'yrc-bar']) expect(html).toContain(label)
    expect(html).not.toContain('Art')
    expect(html).not.toContain('{{')
    expect(html).not.toContain('contenteditable')
    expect(body.css).toContain('.yrc')
    expect(html).toMatch(/GRAND TOTAL<\/td><td>130<\/td><td>100<\/td>/)
    // Back to standard for whoever runs next.
    expect((await api('teacher', 'POST', '/exams/report-cards/design', { design: 'standard' })).status).toBe(200)
  })

  it('refuses a design that does not exist', async () => {
    const { status } = await api('teacher', 'POST', '/exams/report-cards/design', { design: 'fancy' })
    expect(status).toBe(400)
  })
})
