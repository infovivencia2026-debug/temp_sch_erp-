/* Owner, 2026-10-27: "6 exams without marking" counted subjects that had no
   exam. A subject counts for marking only when an exam is scheduled for it
   and that date has passed, and only while no mark is in it. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E, isoDay } from './fixture'

beforeAll(seed)

const T = () => E.TENANT_TEST
const campus = async () => (await T().prepare('SELECT id FROM campuses ORDER BY created_at LIMIT 1').first<{ id: string }>())!.id
const pending = async () => {
  const r = await api('admin', 'GET', '/attention')
  expect(r.status).toBe(200)
  return Number((r.body.items as any[]).find((i) => i.key === 'marks.pending')?.count ?? 0)
}

describe('papers without marks', () => {
  it('counts only a scheduled, past, unmarked subject', async () => {
    const cid = await campus()
    const before = await pending()
    const beforeMon = (await api('admin', 'GET', '/academics/admin/exam-monitor')).body.summary
    const exam = crypto.randomUUID()
    const names = ['Unmarked', 'Marked', 'Unscheduled', 'Future']
    const subs = names.map(() => crypto.randomUUID()), css = names.map(() => crypto.randomUUID()), papers = names.map(() => crypto.randomUUID())
    const dates = [isoDay(-3), isoDay(-3), null, isoDay(5)]
    await T().batch([
      T().prepare(`INSERT INTO exams (id, institution_id, campus_id, academic_year_id, name, kind, starts_on, ends_on) VALUES (?, ?, ?, ?, 'Owner unmarked', 'unit', ?, ?)`)
        .bind(exam, IDS.school, cid, IDS.year, isoDay(-3), isoDay(5)),
      ...names.map((n, i) => T().prepare(`INSERT INTO subjects (id, institution_id, campus_id, name, code) VALUES (?, ?, ?, ?, ?)`).bind(subs[i], IDS.school, cid, 'UM ' + n, 'UM' + i)),
      ...names.map((_, i) => T().prepare(`INSERT INTO class_subjects (id, institution_id, class_id, subject_id) VALUES (?, ?, ?, ?)`).bind(css[i], IDS.school, IDS.klass, subs[i])),
      ...names.map((_, i) => T().prepare(`INSERT INTO exam_subjects (id, institution_id, exam_id, class_subject_id, exam_date, max_marks, pass_marks) VALUES (?, ?, ?, ?, ?, '50', '17')`)
        .bind(papers[i], IDS.school, exam, css[i], dates[i])),
      T().prepare(`INSERT INTO marks (id, institution_id, exam_subject_id, student_id, marks_obtained) VALUES (?, ?, ?, ?, '40')`).bind(crypto.randomUUID(), IDS.school, papers[1], IDS.child),
    ])
    // Only the scheduled, past, unmarked subject is added.
    expect(await pending()).toBe(before + 1)
    const item = ((await api('admin', 'GET', '/attention')).body.items as any[]).find((i) => i.key === 'marks.pending')
    expect(item.detail).toContain('Owner unmarked')

    const mon = (await api('admin', 'GET', '/academics/admin/exam-monitor')).body
    const by = new Map((mon.items as any[]).map((r) => [r.exam_subject_id, r]))
    expect(by.get(papers[0]).due).toBe(true)
    expect(by.get(papers[1]).due).toBe(true)
    expect(by.get(papers[2]).due).toBe(false)
    expect(by.get(papers[3]).due).toBe(false)
    expect(mon.summary.unmarked_papers).toBe(beforeMon.unmarked_papers + 1)
    expect(mon.summary.papers).toBe(beforeMon.papers + 2)
  })
})
