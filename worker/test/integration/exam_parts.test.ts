/* Exams marked in parts: the paper's mark is the sum of its parts, and the
   parts stay editable after marks exist. Uses its own exam so the shared
   paper's maximum is left alone for the other files. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const EXAM = id(700), PAPER = id(701)
const OTHER_CLASS = id(710), OTHER_SECTION = id(711), OTHER_CS = id(712), OTHER_PAPER = id(713), OTHER_EXAM = id(714), STRANGER = id(715)

const marksOf = async (es: string, st: string) => (await E.TENANT_TEST.prepare(
  `SELECT CAST(marks_obtained AS REAL) AS m FROM marks WHERE exam_subject_id = ? AND student_id = ?`).bind(es, st).first<{ m: number | null }>())?.m
const maxOf = async (es: string) => (await E.TENANT_TEST.prepare(`SELECT CAST(max_marks AS REAL) AS m FROM exam_subjects WHERE id = ?`).bind(es).first<{ m: number }>())!.m

let parts: { id: string; name: string; max_marks: number }[] = []

beforeAll(async () => {
  await seed()
  const T = E.TENANT_TEST
  const campus = (await T.prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
  await T.batch([
    T.prepare(`INSERT INTO exams (id, institution_id, campus_id, academic_year_id, name, kind, starts_on, ends_on) VALUES (?, ?, ?, ?, 'Term 1 parts', 'term', '2026-01-01', '2026-01-05')`)
      .bind(EXAM, IDS.school, campus, IDS.year),
    T.prepare(`INSERT INTO exam_subjects (id, institution_id, exam_id, class_subject_id, max_marks, pass_marks) VALUES (?, ?, ?, ?, '100', '33')`)
      .bind(PAPER, IDS.school, EXAM, IDS.classSubject),
    // A class the test teacher neither teaches nor heads.
    T.prepare(`INSERT INTO classes (id, institution_id, campus_id, name, level) VALUES (?, ?, ?, 'Class 9', 9)`).bind(OTHER_CLASS, IDS.school, campus),
    T.prepare(`INSERT INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name) VALUES (?, ?, ?, ?, ?, 'B')`)
      .bind(OTHER_SECTION, IDS.school, campus, OTHER_CLASS, IDS.year),
    T.prepare(`INSERT INTO students (id, institution_id, campus_id, admission_no, first_name, last_name, admission_date) VALUES (?, ?, ?, 'Z900', 'Zed', 'Test', '2026-01-01')`)
      .bind(STRANGER, IDS.school, campus),
    T.prepare(`INSERT INTO enrollments (id, institution_id, student_id, academic_year_id, class_id, section_id, roll_no, enrolled_on) VALUES (?, ?, ?, ?, ?, ?, 1, '2026-01-01')`)
      .bind(crypto.randomUUID(), IDS.school, STRANGER, IDS.year, OTHER_CLASS, OTHER_SECTION),
    T.prepare(`INSERT INTO class_subjects (id, institution_id, class_id, subject_id) VALUES (?, ?, ?, ?)`).bind(OTHER_CS, IDS.school, OTHER_CLASS, IDS.subject),
    T.prepare(`INSERT INTO exams (id, institution_id, campus_id, academic_year_id, name, kind, starts_on, ends_on) VALUES (?, ?, ?, ?, 'Other parts', 'term', '2026-01-01', '2026-01-05')`)
      .bind(OTHER_EXAM, IDS.school, campus, IDS.year),
    T.prepare(`INSERT INTO exam_subjects (id, institution_id, exam_id, class_subject_id, max_marks, pass_marks) VALUES (?, ?, ?, ?, '100', '33')`)
      .bind(OTHER_PAPER, IDS.school, OTHER_EXAM, OTHER_CS),
  ])
})

describe('exam parts', () => {
  it('sets the parts and the paper becomes out of their sum', async () => {
    const { status, body } = await api('admin', 'PUT', `/exams/${EXAM}/parts`, { parts: [
      { name: 'Written', max_marks: 80 }, { name: 'Project', max_marks: 10 }, { name: 'Notebook', max_marks: 5 }, { name: 'Overall', max_marks: 5 },
    ] })
    expect(status).toBe(200)
    parts = body.parts
    expect(parts.map((p) => p.name)).toEqual(['Written', 'Project', 'Notebook', 'Overall'])
    expect(await maxOf(PAPER)).toBe(100)
    const got = await api('teacher', 'GET', `/exams/${EXAM}/parts`)
    expect(got.body.items).toHaveLength(4)
  })

  it('refuses duplicate names and a zero maximum', async () => {
    expect((await api('admin', 'PUT', `/exams/${EXAM}/parts`, { parts: [{ name: 'A', max_marks: 5 }, { name: 'a', max_marks: 5 }] })).status).toBe(400)
    expect((await api('admin', 'PUT', `/exams/${EXAM}/parts`, { parts: [{ name: 'A', max_marks: 0 }] })).status).toBe(400)
  })

  it('saves part marks and the total lands in marks', async () => {
    const [w, p, n, o] = parts
    const { status } = await api('teacher', 'PUT', `/exams/subjects/${PAPER}/part-marks`, { entries: [
      { student_id: IDS.child, parts: { [w.id]: 72, [p.id]: 9, [n.id]: 5, [o.id]: 4 } },
      { student_id: IDS.otherChild, parts: { [w.id]: 60 } },
    ] })
    expect(status).toBe(200)
    expect(await marksOf(PAPER, IDS.child)).toBe(90)
    expect(await marksOf(PAPER, IDS.otherChild)).toBe(60)
    const read = await api('teacher', 'GET', `/exams/subjects/${PAPER}/part-marks`)
    expect(read.status).toBe(200)
    const mine = read.body.items.find((x: { student_id: string }) => x.student_id === IDS.child)
    expect(mine.parts[p.id]).toBe(9)
  })

  it('refuses a part mark above that part\'s maximum', async () => {
    const { status, body } = await api('teacher', 'PUT', `/exams/subjects/${PAPER}/part-marks`, { entries: [
      { student_id: IDS.child, parts: { [parts[1].id]: 11 } },
    ] })
    expect(status).toBe(400)
    expect(JSON.stringify(body)).toMatch(/out of 10/)
    expect(await marksOf(PAPER, IDS.child)).toBe(90)
  })

  it('refuses lowering a maximum below a mark already given', async () => {
    const { status } = await api('admin', 'PUT', `/exams/${EXAM}/parts`, { parts: parts.map((x) => ({ ...x, max_marks: x.name === 'Project' ? 5 : x.max_marks })) })
    expect(status).toBe(400)
  })

  it('editing a maximum and removing a part recompute the totals', async () => {
    const [w, p, n] = parts
    const { status } = await api('admin', 'PUT', `/exams/${EXAM}/parts`, { parts: [
      { id: w.id, name: 'Written', max_marks: 85 }, { id: n.id, name: 'Notebook', max_marks: 5 }, { id: p.id, name: 'Project work', max_marks: 10 },
    ] })
    expect(status).toBe(200)
    expect(await maxOf(PAPER)).toBe(100)
    expect(await marksOf(PAPER, IDS.child)).toBe(86) // 72 + 9 + 5, Overall gone
    const left = (await E.TENANT_TEST.prepare(`SELECT COUNT(*) AS n FROM mark_parts WHERE part_id = ?`).bind(parts[3].id).first<{ n: number }>())!.n
    expect(left).toBe(0)
    const now = (await api('teacher', 'GET', `/exams/${EXAM}/parts`)).body.items
    expect(now.map((x: { name: string }) => x.name)).toEqual(['Written', 'Notebook', 'Project work'])
  })

  it('the report card shows the total only, not the parts (owner, 2026-10-13)', async () => {
    expect((await api('teacher', 'POST', '/exams/report-cards/generate', { exam_id: EXAM, section_id: IDS.section })).status).toBe(200)
    const card = await E.TENANT_TEST.prepare(`SELECT id FROM report_cards WHERE exam_id = ? AND student_id = ?`).bind(EXAM, IDS.child).first<{ id: string }>()
    const { status, body } = await api('teacher', 'GET', `/exams/report-cards/render?id=${card!.id}`)
    expect(status).toBe(200)
    expect(body.html).not.toContain('Written 72')
    expect(body.html).not.toContain('rc-parts')
  })

  it('refuses a teacher who neither teaches the paper nor heads the class', async () => {
    await api('admin', 'PUT', `/exams/${OTHER_EXAM}/parts`, { parts: [{ name: 'Written', max_marks: 50 }] })
    const pid = (await api('admin', 'GET', `/exams/${OTHER_EXAM}/parts`)).body.items[0].id
    const { status } = await api('teacher', 'PUT', `/exams/subjects/${OTHER_PAPER}/part-marks`, { entries: [
      { student_id: STRANGER, parts: { [pid]: 40 } },
    ] })
    expect(status).toBe(403)
  })

  it('an exam without parts still takes a mark as one figure', async () => {
    const { status } = await api('teacher', 'POST', '/exams/marks', { exam_subject_id: IDS.paper, entries: [{ student_id: IDS.child, marks_obtained: 77 }] })
    expect(status).toBe(200)
    expect((await api('teacher', 'GET', `/exams/${IDS.exam}/parts`)).body.items).toEqual([])
  })
})
