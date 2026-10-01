/* Marks import: the per-paper lookups and the "is there a mark already?"
   checks are cached for the run. A re-import must still update in place, and
   the paper keeps the max_marks of the last row that named it. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, call, as, IDS, E } from './fixture'

beforeAll(seed)

async function importCSV(csv: string) {
  const res = await call('/api/v1/setup/import/marks?commit=true', {
    method: 'POST', cookie: await as('admin'), headers: { 'content-type': 'text/csv' }, body: csv,
  })
  return { status: res.status, body: await res.json<any>() }
}

const HEAD = 'admission_no,year,exam,class,subject,max_marks,marks_obtained,grade\n'

describe('marks import', () => {
  it('writes a mark per child, then updates them in place on a second file', async () => {
    const first = await importCSV(HEAD +
      'A001,Current year,Half yearly,Class 5,Mathematics,100,87,A\n' +
      'A002,Current year,Half yearly,Class 5,Mathematics,100,,\n')
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ imported: 2, rejected: 0 })

    const again = await importCSV(HEAD +
      'A001,Current year,Half yearly,Class 5,Mathematics,80,70,B\n' +
      'A002,Current year,Half yearly,Class 5,Mathematics,80,40,C\n' +
      'A001,Current year,Half yearly,Class 5,Mathematics,90,71,B\n')
    expect(again.body).toMatchObject({ imported: 3, rejected: 0 })

    const rows = (await E.TENANT_TEST.prepare(`SELECT student_id, marks_obtained, is_absent FROM marks WHERE exam_subject_id = ? ORDER BY student_id`)
      .bind(IDS.paper).all<{ student_id: string; marks_obtained: string; is_absent: number }>()).results
    expect(rows).toEqual([
      { student_id: IDS.child, marks_obtained: '71', is_absent: 0 },
      { student_id: IDS.otherChild, marks_obtained: '40', is_absent: 0 },
    ])
    const paper = await E.TENANT_TEST.prepare('SELECT max_marks FROM exam_subjects WHERE id = ?').bind(IDS.paper).first<{ max_marks: string }>()
    expect(String(paper?.max_marks)).toBe('90')
  })

  it('rejects a subject the class does not teach', async () => {
    const r = await importCSV(HEAD + 'A001,Current year,Half yearly,Class 5,Latin,100,50,\n')
    expect(r.body).toMatchObject({ imported: 0, rejected: 1 })
  })
})
