/* What a school needs most: the returns readiness count, the rules on
   one page (their endpoints answer the principal), and the move from
   MyClassBoard (its column names map onto the importer). */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, as, call, IDS } from './fixture'

beforeAll(seed)

describe('returns readiness', () => {
  it('counts what each return still needs and names the screen', async () => {
    const r = await api('admin', 'GET', '/compliance/readiness')
    expect(r.status).toBe(200)
    expect(r.body.groups.map((g: { key: string }) => g.key)).toEqual(['udise', 'apaar', 'rte', 'training'])
    const apaar = r.body.groups.find((g: { key: string }) => g.key === 'apaar')
    const noApaar = apaar.items.find((i: { key: string }) => i.key === 'apaar')
    expect(noApaar.missing).toBe(2)
    expect(noApaar.of).toBe(2)
    expect(noApaar.where).toBe('APAAR ID register')
    expect(noApaar.ok).toBe(false)
    expect(r.body.students).toBe(2)
    expect(r.body.missing_total).toBeGreaterThan(0)
    expect((await api('teacher', 'GET', '/compliance/readiness')).status).toBe(403)
    expect((await api('parent', 'GET', '/compliance/readiness')).status).toBe(403)
  })
})

describe('rules on one page', () => {
  it('the three rules answer the principal', async () => {
    expect((await api('admin', 'GET', '/fees/reminders/schedule')).status).toBe(200)
    expect((await api('admin', 'GET', '/reports/digest/settings')).status).toBe(200)
    expect((await api('admin', 'GET', '/admin/messaging/delivery-rules')).status).toBe(200)
    expect((await api('parent', 'GET', '/reports/digest/settings')).status).toBe(403)
  })
})

describe('move from MyClassBoard', () => {
  it('a students file with MCB column names dry-runs through the column map', async () => {
    const csv = ['Admission No,Student Name,Date Of Birth,Gender,Class,Section,Father Name,Father Mobile',
      'MCB001,Anil Kumar,14/06/2013,male,Class 5,A,Ramesh Kumar,9000000099',
      ',No Admission No,01/01/2014,female,Class 5,A,Somebody,9000000098'].join('\n')
    const map = { full_name: 'Student Name', admission_no: 'Admission No', date_of_birth: 'Date Of Birth', gender: 'Gender', class: 'Class', section: 'Section', father_name: 'Father Name', father_phone: 'Father Mobile' }
    const cookie = await as('admin')
    const res = await call('/api/v1/students/import?commit=false', { method: 'POST', cookie, body: csv, headers: { 'content-type': 'text/csv', 'x-column-map': JSON.stringify(map) } })
    const text0 = await res.clone().text()
    expect(res.status, text0).toBe(200)
    const out = await res.json() as { total: number; valid: number; rejected: number; dry_run: boolean; problems: { row: number; problem: string }[] }
    expect(out.dry_run).toBe(true)
    expect(out.total).toBe(2)
    expect(out.valid).toBeGreaterThanOrEqual(1)
    const fields = await api('admin', 'GET', '/setup/import/students/fields')
    expect(fields.body.fields.some((f: { name: string }) => f.name === 'father_phone')).toBe(true)
    const tpl = await call('/api/v1/setup/import/fee_payments/template', { cookie })
    expect(tpl.status).toBe(200)
    expect(await tpl.text()).toContain('admission_no')
    expect((await api('parent', 'GET', '/setup/import/students/fields')).status).toBe(403)
  })
})
