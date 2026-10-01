/* The whole-class fee run: per-child reads are grouped into one read for the
   class and invoices are written in chunks under one block of numbers. Each
   child must still get their own concession and their own charges, and the
   series must stay gapless. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

const FS = '00000000-0000-4000-8000-000000000900'
const BUS = '00000000-0000-4000-8000-000000000901'

beforeAll(async () => {
  await seed()
  const T = E.TENANT_TEST
  const campus = (await T.prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
  await T.batch([
    T.prepare(`INSERT INTO fee_structures (id, institution_id, campus_id, academic_year_id, class_id, name) VALUES (?, ?, ?, ?, ?, 'Class 5 fees')`)
      .bind(FS, IDS.school, campus, IDS.year, IDS.klass),
    T.prepare(`INSERT INTO fee_structure_items (institution_id, fee_structure_id, fee_head_id, instalment_no, amount_paise) VALUES (?, ?, ?, 2, 100000)`)
      .bind(IDS.school, FS, IDS.feeHead),
    T.prepare(`INSERT INTO fee_heads (id, institution_id, name, code) VALUES (?, ?, 'Bus', 'BUS')`).bind(BUS, IDS.school),
    // Chirag: 10% off tuition. Diya: a bus fare of her own.
    T.prepare(`INSERT INTO fee_concessions (institution_id, student_id, academic_year_id, fee_head_id, kind, percent, approved_at, status)
        VALUES (?, ?, ?, ?, 'sibling', '10', '2026-01-01', 'approved')`).bind(IDS.school, IDS.child, IDS.year, IDS.feeHead),
    T.prepare(`INSERT INTO student_fee_components (institution_id, student_id, academic_year_id, fee_head_id, code, description, amount_paise, valid_from)
        VALUES (?, ?, ?, ?, 'bus', 'Bus fare', 20000, '2000-01-01')`).bind(IDS.school, IDS.otherChild, IDS.year, BUS),
  ])
})

describe('whole-class fee run', () => {
  it('bills each child their own figure under consecutive numbers', async () => {
    const { status, body } = await api('admin', 'POST', '/fees/invoices/generate', { fee_structure_id: FS, instalment_no: 2 })
    expect(status).toBe(201)
    expect(body.created).toBe(2)
    const rows = (await E.TENANT_TEST.prepare(`SELECT student_id, invoice_no, gross_paise, discount_paise, net_paise FROM invoices
        WHERE instalment_no = 2 ORDER BY invoice_no`).all<{ student_id: string; invoice_no: string; gross_paise: number; discount_paise: number; net_paise: number }>()).results
    expect(rows).toHaveLength(2)
    const by = Object.fromEntries(rows.map((r) => [r.student_id, r]))
    expect(by[IDS.child]).toMatchObject({ gross_paise: 100000, discount_paise: 10000, net_paise: 90000 })
    expect(by[IDS.otherChild]).toMatchObject({ gross_paise: 120000, discount_paise: 0, net_paise: 120000 })
    const seqs = rows.map((r) => Number(/(\d+)$/.exec(r.invoice_no)![1]))
    expect(seqs[1]).toBe(seqs[0] + 1)
    const lines = await E.TENANT_TEST.prepare(`SELECT count(*) AS n FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE i.instalment_no = 2`).first<{ n: number }>()
    expect(lines?.n).toBe(3)
  })

  it('continues the series on the next run', async () => {
    const before = await E.TENANT_TEST.prepare(`SELECT max(invoice_no) AS m FROM invoices WHERE instalment_no = 2`).first<{ m: string }>()
    await E.TENANT_TEST.prepare(`INSERT INTO fee_structure_items (institution_id, fee_structure_id, fee_head_id, instalment_no, amount_paise) VALUES (?, ?, ?, 3, 5000)`)
      .bind(IDS.school, FS, IDS.feeHead).run()
    const { body } = await api('admin', 'POST', '/fees/invoices/generate', { fee_structure_id: FS, instalment_no: 3 })
    expect(body.created).toBe(2)
    const after = (await E.TENANT_TEST.prepare(`SELECT invoice_no FROM invoices WHERE instalment_no = 3 ORDER BY invoice_no`).all<{ invoice_no: string }>()).results
    const n = (s: string) => Number(/(\d+)$/.exec(s)![1])
    expect(after.map((r) => n(r.invoice_no))).toEqual([n(before!.m) + 1, n(before!.m) + 2])
  })
})
