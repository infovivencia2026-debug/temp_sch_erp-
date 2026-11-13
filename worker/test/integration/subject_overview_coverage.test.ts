/* Syllabus covered reads chapter_progress (Lesson plan -> Chapters): a chapter
   marked completed counts in the subject overview, an ongoing one counts half
   in the progress, and a completed sub-topic is not a chapter. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS } from './fixture'

const CO = { section_id: IDS.section, class_subject_id: IDS.classSubject }
const unit = async (title: string, parent?: string) => {
  const r = await api('teacher', 'POST', '/lms/units', { ...CO, title, ...(parent ? { parent_unit_id: parent } : {}) })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return r.body.id as string
}
const mark = async (unit_id: string, status: string) => {
  const r = await api('admin', 'PUT', '/academics/chapter-plan/progress', { section_id: IDS.section, unit_id, status, from_date: '2026-07-01', to_date: '2026-07-10' })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
}

beforeAll(async () => { await seed() })

describe('subject overview syllabus covered', () => {
  it('counts a completed chapter from chapter_progress', async () => {
    const a = await unit('Numbers'), b = await unit('Shapes')
    const sub = await unit('Counting', b)
    await mark(a, 'completed')
    await mark(sub, 'completed')
    let r = await api('admin', 'GET', `/teaching/my-subjects?subject=${IDS.subject}`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    let row = r.body.sections.find((s: { section_id: string; class_subject_id: string }) => s.section_id === IDS.section && s.class_subject_id === IDS.classSubject)
    expect(row.units_total).toBe(2)
    expect(row.units_done).toBe(1)
    await mark(b, 'ongoing')
    r = await api('admin', 'GET', `/teaching/my-subjects?subject=${IDS.subject}`)
    row = r.body.sections.find((s: { section_id: string; class_subject_id: string }) => s.section_id === IDS.section && s.class_subject_id === IDS.classSubject)
    expect(row.units_done).toBe(1)
    expect(row.units_progress).toBe(1.5)
    const sm = await api('admin', 'GET', '/academics/subject-heads/summary')
    expect(sm.body.items.find((s: { id: string }) => s.id === IDS.subject).done).toBe(1)
  })
})
