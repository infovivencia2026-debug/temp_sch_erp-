/* Marks entry's sheets, round trip: build the file from what the screen
   fetches, type marks into it, upload the same file, save the way the
   screen saves. One paper (in parts, and plain), and the whole-class sheet
   with every subject. Uses the web's own builder/reader, so the test
   exercises the file the user actually gets. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'
import {
  marksTemplate, readMarksSheet, parseCSV, classTemplate, readClassSheet, paperSave,
  type SheetRow, type ClassPaper,
} from '../../../web/src/features/exams/marksSheet'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const EXAM = id(760), PAPER = id(761), PLAIN_EXAM = id(762), PLAIN = id(763)
const SUBJ2 = id(764), CS2 = id(765), PAPER2 = id(766), PLAIN2 = id(767)
const paperInfo = { class_name: 'Grade', subject: 'Maths', exam_name: 'Term', max_marks: 100 }

const marksOf = async (es: string, st: string) => (await E.TENANT_TEST.prepare(
  `SELECT CAST(marks_obtained AS REAL) AS m FROM marks WHERE exam_subject_id = ? AND student_id = ?`).bind(es, st).first<{ m: number | null }>())?.m

const book = async (es: string): Promise<SheetRow[]> =>
  (await api('admin', 'GET', `/exams/gradebook?exam_subject_id=${es}`)).body.items

const toCsv = (lines: string[][]) => lines.map((l) => l.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n')

/** Types into the marks columns of a one-paper template, leaving every other cell as it was. */
function fill(csv: string, byAdm: Record<string, string[]>, firstMarkCol: number): string {
  const lines = parseCSV(csv)
  for (const l of lines.slice(1)) {
    const v = byAdm[l[0]]
    if (v) v.forEach((x, i) => { l[firstMarkCol + i] = x })
  }
  return toCsv(lines)
}

let parts: { id: string; name: string; max_marks: number }[] = []
let admChild = '', admOther = ''
const vals = (byName: Record<string, string>) => parts.map((p) => byName[p.name] ?? '')

beforeAll(async () => {
  await seed()
  const T = E.TENANT_TEST
  const campus = (await T.prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
  await T.batch([
    T.prepare(`INSERT INTO exams (id, institution_id, campus_id, academic_year_id, name, kind, starts_on, ends_on) VALUES (?, ?, ?, ?, 'Sheet parts', 'term', '2026-01-01', '2026-01-05')`).bind(EXAM, IDS.school, campus, IDS.year),
    T.prepare(`INSERT INTO exam_subjects (id, institution_id, exam_id, class_subject_id, max_marks, pass_marks) VALUES (?, ?, ?, ?, '100', '33')`).bind(PAPER, IDS.school, EXAM, IDS.classSubject),
    T.prepare(`INSERT INTO exams (id, institution_id, campus_id, academic_year_id, name, kind, starts_on, ends_on) VALUES (?, ?, ?, ?, 'Sheet plain', 'term', '2026-01-01', '2026-01-05')`).bind(PLAIN_EXAM, IDS.school, campus, IDS.year),
    T.prepare(`INSERT INTO exam_subjects (id, institution_id, exam_id, class_subject_id, max_marks, pass_marks) VALUES (?, ?, ?, ?, '50', '17')`).bind(PLAIN, IDS.school, PLAIN_EXAM, IDS.classSubject),
    T.prepare(`INSERT INTO subjects (id, institution_id, campus_id, name, code) VALUES (?, ?, ?, 'Science', 'SCI-RT')`).bind(SUBJ2, IDS.school, campus),
    T.prepare(`INSERT INTO class_subjects (id, institution_id, class_id, subject_id) VALUES (?, ?, ?, ?)`).bind(CS2, IDS.school, IDS.klass, SUBJ2),
    T.prepare(`INSERT INTO exam_subjects (id, institution_id, exam_id, class_subject_id, max_marks, pass_marks) VALUES (?, ?, ?, ?, '100', '33')`).bind(PAPER2, IDS.school, EXAM, CS2),
    T.prepare(`INSERT INTO exam_subjects (id, institution_id, exam_id, class_subject_id, max_marks, pass_marks) VALUES (?, ?, ?, ?, '50', '17')`).bind(PLAIN2, IDS.school, PLAIN_EXAM, CS2),
  ])
  const r = await api('admin', 'PUT', `/exams/${EXAM}/parts`, { parts: [{ name: 'Written', max_marks: 80 }, { name: 'Project', max_marks: 20 }] })
  expect(r.status).toBe(200)
  parts = r.body.parts
  const rows = await book(PAPER)
  admChild = rows.find((x) => x.student_id === IDS.child)!.admission_no
  admOther = rows.find((x) => x.student_id === IDS.otherChild)!.admission_no
})

describe('one-paper sheet', () => {
  it('template for a parts exam has a column per part and every child', async () => {
    const rows = await book(PAPER)
    const lines = parseCSV(marksTemplate(paperInfo, rows, parts))
    expect(lines[0]).toEqual(['Admission no.', 'Student', 'Section', 'Class', 'Subject', 'Exam', ...parts.map((p) => `${p.name} (${p.max_marks})`), 'Total'])
    expect(lines[0]).toContain('Written (80)')
    expect(lines.length - 1).toBe(rows.length)
  })

  it('a filled template uploads unchanged and saves parts and the total', async () => {
    const rows = await book(PAPER)
    const csv = fill(marksTemplate(paperInfo, rows, parts), { [admChild]: vals({ Written: '70', Project: '15' }), [admOther]: vals({ Written: '40' }) }, 6)
    const got = readMarksSheet(csv, rows, parts, 100)
    expect(got.errors).toEqual([])
    expect(got.missed).toEqual([])
    const entries = Object.entries(got.parts).map(([sid, p]) => ({ student_id: sid, is_absent: false,
      parts: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Number(v)])) }))
    const put = await api('teacher', 'PUT', `/exams/subjects/${PAPER}/part-marks`, { entries })
    expect(put.status).toBe(200)
    expect(await marksOf(PAPER, IDS.child)).toBe(85)
    expect(await marksOf(PAPER, IDS.otherChild)).toBe(40)

    // Downloaded again it carries what is recorded, and goes back in unchanged without complaint.
    const pm = (await api('teacher', 'GET', `/exams/subjects/${PAPER}/part-marks`)).body
    expect(Array.isArray(pm.bands)).toBe(true)
    const saved = new Map<string, Record<string, number | null>>(pm.items.map((x: { student_id: string; parts: Record<string, number | null> }) => [x.student_id, x.parts]))
    const again = marksTemplate(paperInfo, await book(PAPER), parts, saved)
    const line = parseCSV(again).find((l) => l[0] === admChild)!
    expect(line.slice(6)).toEqual([...vals({ Written: '70', Project: '15' }), '85'])
    expect(readMarksSheet(again, await book(PAPER), parts, 100).errors).toEqual([])
  })

  it('an over-max part is refused for that row, by name, and the server agrees', async () => {
    const rows = await book(PAPER)
    const csv = fill(marksTemplate(paperInfo, rows, parts), { [admChild]: vals({ Written: '90', Project: '5' }), [admOther]: vals({ Written: '30', Project: 'x' }) }, 6)
    const got = readMarksSheet(csv + '\r\nNOPE,Nobody,,,,,1,1,\r\n', rows, parts, 100)
    expect(got.errors).toHaveLength(2)
    expect(got.errors[0]).toMatch(/Written 90 is more than 80/)
    expect(got.errors[1]).toMatch(/Project "x" is not a mark/)
    expect(got.missed).toEqual(['NOPE'])
    expect(got.parts[IDS.child]).toBeUndefined()
    const written = parts.find((p) => p.name === 'Written')!
    const bad = await api('teacher', 'PUT', `/exams/subjects/${PAPER}/part-marks`, { entries: [{ student_id: IDS.child, parts: { [written.id]: 90 } }] })
    expect(bad.status).toBe(400)
    expect(await marksOf(PAPER, IDS.child)).toBe(85)
  })

  it('a plain paper: template has one marks column, and the filled file saves', async () => {
    const rows = await book(PLAIN)
    const csv = marksTemplate({ ...paperInfo, max_marks: 50 }, rows, [])
    expect(parseCSV(csv)[0]).toContain('Marks (50)')
    const got = readMarksSheet(fill(csv, { [admChild]: ['42'] }, 6), rows, [], 50)
    expect(got.errors).toEqual([])
    const entries = Object.entries(got.marks).map(([sid, v]) => ({ student_id: sid, is_absent: false, marks_obtained: Number(v) }))
    const post = await api('teacher', 'POST', '/exams/marks', { exam_subject_id: PLAIN, entries })
    expect(post.status).toBeLessThan(300)
    expect(await marksOf(PLAIN, IDS.child)).toBe(42)
    expect(readMarksSheet(fill(csv, { [admChild]: ['51'] }, 6), rows, [], 50).errors[0]).toMatch(/more than 50/)
  })
})

describe('whole-class sheet', () => {
  const classPapers = async (ids: string[], subjects: string[]): Promise<ClassPaper[]> => Promise.all(ids.map(async (pid, i) => {
    const pm = (await api('admin', 'GET', `/exams/subjects/${pid}/part-marks`)).body
    const rows = await book(pid)
    return { id: pid, subject: subjects[i], max_marks: rows[0]?.max_marks ?? 0, parts: pm.parts, rows,
      saved: new Map<string, Record<string, number | null>>(pm.items.map((x: { student_id: string; parts: Record<string, number | null> }) => [x.student_id, x.parts])) }
  }))
  const saveClass = async (papers: ClassPaper[], cells: Record<string, Record<string, Record<string, string>>>) => {
    for (const [pid, c] of Object.entries(cells)) {
      const b = paperSave(papers.find((x) => x.id === pid)!, c)
      const res = b.kind === 'parts' ? await api('admin', 'PUT', `/exams/subjects/${pid}/part-marks`, b.body) : await api('admin', 'POST', '/exams/marks', b.body)
      expect(res.status).toBeLessThan(300)
    }
  }
  const setCells = (csv: string, adm: string, byHeading: Record<string, string>) => {
    const lines = parseCSV(csv)
    const row = lines.find((l) => l[4] === adm)!
    for (const [h, v] of Object.entries(byHeading)) { const i = lines[0].indexOf(h); expect(i, h).toBeGreaterThanOrEqual(0); row[i] = v }
    return toCsv(lines)
  }

  it('exam in parts: subject by subject, parts then Total; the exported file re-imports as-is', async () => {
    const papers = await classPapers([PAPER, PAPER2], ['Maths', 'Science'])
    const csv = classTemplate({ class_name: 'Grade', exam_name: 'Term' }, papers)
    const head = parseCSV(csv)[0]
    expect(head.slice(0, 5)).toEqual(['Roll no', 'Student name', 'Class', 'Section', 'Admission no'])
    expect(head).toContain('MATHS · Written (80)')
    expect(head.indexOf(`MATHS · Total (${papers[0].max_marks})`)).toBeLessThan(head.indexOf('SCIENCE · Written (80)'))
    const same = readClassSheet(csv, papers)
    expect(same.errors).toEqual([]); expect(same.missed).toEqual([]); expect(same.filled).toBe(0)

    const filled = setCells(csv, admChild, { 'SCIENCE · Written (80)': '60', 'SCIENCE · Project (20)': '18', 'MATHS · Project (20)': '25' })
    const got = readClassSheet(filled, papers)
    expect(got.errors).toHaveLength(1)
    expect(got.errors[0]).toMatch(/Maths · Project 25 is more than 20/)
    expect(got.cells[PAPER]).toBeUndefined()
    await saveClass(papers, got.cells)
    expect(await marksOf(PAPER2, IDS.child)).toBe(78)
    expect(await marksOf(PAPER, IDS.child)).toBe(85)
  })

  it('plain exam: one column per subject, AB is absent', async () => {
    const papers = await classPapers([PLAIN, PLAIN2], ['Maths', 'Science'])
    const csv = classTemplate({ class_name: 'Grade', exam_name: 'Term' }, papers)
    expect(parseCSV(csv)[0].slice(5)).toEqual(['MATHS · Marks (50)', 'SCIENCE · Marks (50)'])
    const got = readClassSheet(setCells(csv, admOther, { 'SCIENCE · Marks (50)': '33', 'MATHS · Marks (50)': 'AB' }), papers)
    expect(got.errors).toEqual([])
    await saveClass(papers, got.cells)
    expect(await marksOf(PLAIN2, IDS.otherChild)).toBe(33)
    expect(await marksOf(PLAIN, IDS.otherChild)).toBeNull()
  })
})
