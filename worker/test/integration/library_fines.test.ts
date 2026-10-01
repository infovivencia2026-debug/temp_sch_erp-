/* Library fines: the rate is the school's (not the browser's), and a fine can
   be waived as well as collected, with the summary saying how much of each. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, isoDay, E } from './fixture'

beforeAll(seed)

const T = () => E.TENANT_TEST
const uuid = (n: number) => `00000000-0000-4000-8000-${String(900 + n).padStart(12, '0')}`

async function lateLoan(n: number, daysLate: number): Promise<string> {
  const campus = (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
  const [title, copy, loan] = [uuid(n * 3), uuid(n * 3 + 1), uuid(n * 3 + 2)]
  await T().batch([
    T().prepare(`INSERT INTO library_titles (id, institution_id, campus_id, title) VALUES (?, ?, ?, ?)`).bind(title, IDS.school, campus, `Book ${n}`),
    T().prepare(`INSERT INTO library_copies (id, institution_id, title_id, accession_no, status) VALUES (?, ?, ?, ?, 'issued')`).bind(copy, IDS.school, title, `ACC-F${n}`),
    T().prepare(`INSERT INTO library_loans (id, institution_id, copy_id, student_id, issued_on, due_on) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(loan, IDS.school, copy, IDS.child, isoDay(-daysLate - 14), isoDay(-daysLate)),
  ])
  return loan
}

describe('library fines', () => {
  it('uses Rs 1/day until the school sets its own rate', async () => {
    const r = await api('admin', 'GET', '/ops/library/fines/settings')
    expect(r.status).toBe(200)
    expect(r.body.fine_per_day_paise).toBe(100)
  })

  it('fines a late return at the school rate and lets it be waived', async () => {
    const bad = await api('admin', 'PUT', '/ops/library/fines/settings', { fine_per_day_paise: -5 })
    expect(bad.status).toBe(400)
    const set = await api('admin', 'PUT', '/ops/library/fines/settings', { fine_per_day_paise: 250 })
    expect(set.status).toBe(200)

    const loan = await lateLoan(1, 4)
    const ret = await api('admin', 'POST', `/ops/library/loans/${loan}/return`)
    expect(ret.status).toBe(200)
    expect(ret.body.fine_paise).toBe(1000)

    const waive = await api('admin', 'POST', `/ops/library/loans/${loan}/fine/waive`)
    expect(waive.status).toBe(200)
    expect(waive.body.waived_paise).toBe(1000)
    const again = await api('admin', 'POST', `/ops/library/loans/${loan}/fine/collect`)
    expect(again.status).toBe(409)

    const sum = await api('admin', 'GET', '/ops/library/fines/summary')
    expect(sum.body.waived_paise).toBeGreaterThanOrEqual(1000)
    expect(sum.body.waived.some((w: { loan_id: string }) => w.loan_id === loan)).toBe(true)
    expect(sum.body.outstanding.some((w: { loan_id: string }) => w.loan_id === loan)).toBe(false)
    expect(sum.body.fine_per_day_paise).toBe(250)
  })

  it('does not fine at all when the rate is 0', async () => {
    await api('admin', 'PUT', '/ops/library/fines/settings', { fine_per_day_paise: 0 })
    const loan = await lateLoan(2, 3)
    const ret = await api('admin', 'POST', `/ops/library/loans/${loan}/return`)
    expect(ret.body.fine_paise).toBe(0)
  })
})
