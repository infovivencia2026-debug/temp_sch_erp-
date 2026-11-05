/* The four kinds the chat importers used to leave out (student_exits,
   marks_grid, punches, payslips): offered to exactly the people Setup > Import
   lets import them, previewed through the importer's own dry run (its
   validation, nothing written), and refused for everyone else. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, as, E } from './fixture'

beforeAll(seed)

const FOUR = ['student_exits', 'marks_grid', 'punches', 'payslips'] as const
const ident = (headers: string[], fields: (string | null)[]) => ({ headers, mapping: fields.map((field, index) => ({ index, field })) })
const count = async (sql: string) => (await E.TENANT_TEST.prepare(sql).first<{ n: number }>())!.n

describe('chat import: the four extra kinds', () => {
  it('are offered exactly when Setup > Import allows the kind', async () => {
    for (const who of ['admin', 'teacher', 'finance', 'parent'] as const) {
      const k = await api(who, 'GET', '/ai/import/kinds')
      const offered = new Set<string>(k.status === 200 ? k.body.kinds.map((x: { key: string }) => x.key) : [])
      for (const kind of FOUR) {
        const setup = await api(who, 'GET', `/setup/import/${kind}/fields`)
        expect([who, kind, offered.has(kind)]).toEqual([who, kind, setup.status === 200])
      }
    }
    const admin = await api('admin', 'GET', '/ai/import/kinds')
    for (const kind of FOUR) expect(admin.body.kinds.some((x: { key: string }) => x.key === kind)).toBe(true)
    const grid = admin.body.kinds.find((x: { key: string }) => x.key === 'marks_grid')
    expect(grid.columns).toContain('subject:Mathematics')
  }, 180_000)

  it('a person without the permission is refused, even naming the kind', async () => {
    const table = { headers: ['Code', 'Month', 'Gross', 'Net'], rows: [['E1', '2026-04', '100', '100']] }
    const { mapping } = ident(table.headers, ['employee_code', 'month', 'gross', 'net'])
    const r = await api('parent', 'POST', '/ai/import/preview', { kind: 'payslips', table, mapping, source: 'sheet' })
    expect(r.status).toBe(403)
  })

  it('payslips: the importer validation runs in the dry run, nothing saved', async () => {
    const table = { headers: ['Emp', 'Month', 'Gross', 'Deductions', 'Net'], rows: [['NOPE1', '2026-04', '45000', '3600', '41400'], ['NOPE2', 'April', '100', '0', '90']] }
    const { mapping } = ident(table.headers, ['employee_code', 'month', 'gross', 'deductions', 'net'])
    const before = await count(`SELECT count(*) AS n FROM payslips`)
    const r = await api('admin', 'POST', '/ai/import/preview', { kind: 'payslips', table, mapping, source: 'sheet' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ dry_run: true, total: 2, valid: 0, rejected: 2, imported: 0 })
    const why = r.body.problems.map((p: { problem: string }) => p.problem).join(' | ')
    expect(why).toContain('month must be written as 2026-04')
    expect(why).toContain('no staff member with code "NOPE1"')
    expect(await count(`SELECT count(*) AS n FROM payslips`)).toBe(before)
  })

  it('student_exits: previews through the exits importer, nothing saved', async () => {
    const table = { headers: ['Adm', 'Left on', 'Reason'], rows: [['A001', '2026-05-31', 'Moved city'], ['ZZZ9', '2026-05-31', 'x']] }
    const { mapping } = ident(table.headers, ['admission_no', 'exit_date', 'reason'])
    const r = await api('admin', 'POST', '/ai/import/preview', { kind: 'student_exits', table, mapping, source: 'sheet' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ dry_run: true, total: 2, imported: 0 })
    expect(r.body.rejected).toBeGreaterThanOrEqual(1)
    expect(await count(`SELECT count(*) AS n FROM students WHERE admission_no = 'A001' AND status = 'active'`)).toBe(1)
  })

  it('punches: previews through the punches importer, nothing saved', async () => {
    const table = { headers: ['Serial', 'User', 'Time'], rows: [['NO-SUCH-DEVICE', '7', '2026-04-01 09:01']] }
    const { mapping } = ident(table.headers, ['device_serial', 'device_user_id', 'punched_at'])
    const before = await count(`SELECT count(*) AS n FROM biometric_punches`)
    const r = await api('admin', 'POST', '/ai/import/preview', { kind: 'punches', table, mapping, source: 'sheet' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ dry_run: true, total: 1, imported: 0 })
    expect(await count(`SELECT count(*) AS n FROM biometric_punches`)).toBe(before)
  })

  it('marks_grid: subject columns and sheet facts reach the importer', async () => {
    const table = { headers: ['Adm No', 'Maths', 'Total'], rows: [['A001', '78', '78'], ['A002', '120', '120']] }
    const { mapping } = ident(table.headers, ['admission_no', 'subject:Mathematics', null])
    const before = await count(`SELECT count(*) AS n FROM marks`)
    const facts = { year: '2024-25', exam: 'Annual Examination', class: 'Class 5', max_marks: '100' }
    const r = await api('admin', 'POST', '/ai/import/preview', { kind: 'marks_grid', table, mapping, source: 'sheet', facts })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ dry_run: true, total: 2, valid: 1, rejected: 1, imported: 0 })
    expect(r.body.fields).toEqual(['admission_no', 'subject:Mathematics'])
    expect(r.body.problems[0].problem).toContain('more than the 100')
    expect(r.body.problems[0].source_row).toBe(1)
    // Without subject columns the importer's own check refuses every row.
    const none = await api('admin', 'POST', '/ai/import/preview', { kind: 'marks_grid', table, mapping: ident(table.headers, ['admission_no', null, null]).mapping, source: 'sheet', facts })
    expect(none.body.problems[0].problem).toContain('no subject columns were chosen')
    expect(await count(`SELECT count(*) AS n FROM marks`)).toBe(before)
  })

  it('the assistant chat upload takes payslips and student exits as a dry run', async () => {
    for (const [entity, csv] of [['payslips', 'employee_code,month,gross,net\nNOPE1,2026-04,100,100\n'], ['student_exits', 'admission_no,exit_date\nZZZ9,2026-05-31\n']]) {
      const form = new FormData()
      form.append('entity', entity)
      form.append('file', new File([csv], `${entity}.csv`, { type: 'text/csv' }))
      const res = await call('/api/v1/assistant/import/preview', { method: 'POST', cookie: await as('admin'), body: form })
      const body = await res.json() as { dry_run: boolean; imported: number; rejected: number }
      expect([entity, res.status]).toEqual([entity, 200])
      expect(body).toMatchObject({ dry_run: true, imported: 0, rejected: 1 })
      const parent = await call('/api/v1/assistant/import/preview', { method: 'POST', cookie: await as('parent'), body: form })
      expect(parent.status).toBe(403)
    }
  })
})
