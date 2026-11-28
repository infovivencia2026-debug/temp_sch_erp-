/* The parent screens follow the home card's academic-year picker
   (owner, 2026-11-28): fees, attendance and results take `academic_year_id`,
   and a year the child was never enrolled in is refused. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

beforeAll(seed)

const OTHER_YEAR = '0b0b0b0b-0000-4000-8000-00000000f00d'

describe('parent year filter', () => {
  beforeAll(async () => {
    await E.TENANT_TEST.prepare(`INSERT OR IGNORE INTO academic_years (id, institution_id, campus_id, name, starts_on, ends_on, is_current)
        SELECT ?, institution_id, campus_id, 'Old year', '2001-04-01', '2002-03-31', 0 FROM academic_years WHERE id = ?`)
      .bind(OTHER_YEAR, IDS.year).run()
  })

  for (const path of ['/portal/fees', '/portal/attendance', '/portal/results']) {
    it(`${path} answers for the child's own year`, async () => {
      const r = await api('parent', 'GET', `${path}?student_id=${IDS.child}&academic_year_id=${IDS.year}`)
      expect(r.status).toBe(200)
    })
    it(`${path} refuses a year the child was not enrolled in`, async () => {
      const r = await api('parent', 'GET', `${path}?student_id=${IDS.child}&academic_year_id=${OTHER_YEAR}`)
      expect(r.status).toBe(404)
    })
    it(`${path} refuses a year id that is not a uuid`, async () => {
      const r = await api('parent', 'GET', `${path}?student_id=${IDS.child}&academic_year_id=nope`)
      expect(r.status).toBe(400)
    })
    it(`${path} refuses another family's child even with a real year`, async () => {
      const r = await api('parent', 'GET', `${path}?student_id=${IDS.otherChild}&academic_year_id=${IDS.year}`)
      expect(r.status).toBe(404)
    })
  }

  it('fees for the year list only that year', async () => {
    const all = await api<{ invoices: unknown[] }>('parent', 'GET', `/portal/fees?student_id=${IDS.child}`)
    const yr = await api<{ invoices: unknown[] }>('parent', 'GET', `/portal/fees?student_id=${IDS.child}&academic_year_id=${IDS.year}`)
    expect(yr.body.invoices.length).toBe(all.body.invoices.length)
  })
})
