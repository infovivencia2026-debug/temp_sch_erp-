/* Marks entry by the class teacher, then report cards for the section. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

beforeAll(seed)

describe('exams', () => {
  it('lets the class teacher enter marks for her section', async () => {
    const { status, body } = await api('teacher', 'POST', '/exams/marks', {
      exam_subject_id: IDS.paper,
      entries: [{ student_id: IDS.child, marks_obtained: 88 }, { student_id: IDS.otherChild, marks_obtained: 71.5 }],
    })
    expect(status).toBe(200)
    expect(body.written).toBe(2)
  })

  it('refuses a mark above the paper maximum', async () => {
    const { status, body } = await api('teacher', 'POST', '/exams/marks', { exam_subject_id: IDS.paper, entries: [{ student_id: IDS.child, marks_obtained: 101 }] })
    expect(status).toBe(400)
    expect(JSON.stringify(body)).toMatch(/out of 100/)
  })

  it('generates report cards with totals and ranks', async () => {
    const { status, body } = await api('teacher', 'POST', '/exams/report-cards/generate', { exam_id: IDS.exam, section_id: IDS.section })
    expect(status).toBe(200)
    expect(body).toEqual({ report_cards: 2, published: false })
    const rows = (await E.TENANT_TEST.prepare(`SELECT student_id, CAST(total_marks AS REAL) AS total, CAST(percentage AS REAL) AS pct, rank_in_section, status
        FROM report_cards WHERE exam_id = ? ORDER BY rank_in_section`).bind(IDS.exam).all()).results
    expect(rows).toEqual([
      { student_id: IDS.child, total: 88, pct: 88, rank_in_section: 1, status: 'draft' },
      { student_id: IDS.otherChild, total: 71.5, pct: 71.5, rank_in_section: 2, status: 'draft' },
    ])
  })

  it('regenerating updates in place rather than duplicating', async () => {
    await api('teacher', 'POST', '/exams/marks', { exam_subject_id: IDS.paper, entries: [{ student_id: IDS.otherChild, marks_obtained: 95 }] })
    await api('teacher', 'POST', '/exams/report-cards/generate', { exam_id: IDS.exam, section_id: IDS.section })
    const rows = (await E.TENANT_TEST.prepare(`SELECT student_id, rank_in_section FROM report_cards WHERE exam_id = ? ORDER BY rank_in_section`).bind(IDS.exam).all()).results
    expect(rows).toEqual([{ student_id: IDS.otherChild, rank_in_section: 1 }, { student_id: IDS.child, rank_in_section: 2 }])
  })

  it('lists the draft cards for the teacher', async () => {
    const { status, body } = await api('teacher', 'GET', `/exams/report-cards?exam_id=${IDS.exam}&section_id=${IDS.section}`)
    expect(status).toBe(200)
    expect(JSON.stringify(body)).toContain(IDS.child)
  })

  it('refuses report cards to the finance office (no academics.reportcards.generate)', async () => {
    const { status } = await api('finance', 'POST', '/exams/report-cards/generate', { exam_id: IDS.exam, section_id: IDS.section })
    expect(status).toBe(403)
  })
})
