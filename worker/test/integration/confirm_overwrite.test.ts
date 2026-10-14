/* Identifying codes are not typed over without being asked (owner, 2026-10-14):
   a change to a non-empty code is a 409 confirm_overwrite until the flag is
   sent; a code another record holds is a 409 already_used; a bulk row that
   would change one is reported and held back. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, as, IDS } from './fixture'

beforeAll(seed)

async function staff(code: string, first: string): Promise<string> {
  const r = await api('admin', 'POST', '/setup/employees', { employee_code: code, first_name: first, last_name: 'Test' })
  expect(r.status).toBe(201)
  return r.body.id
}

describe('confirm before overwriting a code', () => {
  let a = '', b = ''
  beforeAll(async () => { a = await staff('CO001', 'Asha'); b = await staff('CO002', 'Bala') })

  it('asks before changing a staff code, then saves with the flag', async () => {
    const r = await api('admin', 'PATCH', `/setup/employees/${a}`, { employee_code: 'CO009' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('confirm_overwrite')
    expect(r.body.changes).toEqual([{ field: 'employee_code', label: 'staff code', from: 'CO001', to: 'CO009' }])
    const ok = await api('admin', 'PATCH', `/setup/employees/${a}`, { employee_code: 'CO009', confirm_overwrite: true })
    expect(ok.status).toBe(200)
    const row = await api('admin', 'GET', `/hr/employees/${a}/detail`)
    expect(row.body.employee_code).toBe('CO009')
  })

  it('fills an empty code without asking', async () => {
    const r = await api('admin', 'PATCH', `/setup/employees/${b}`, { pan: 'abcde1234f' })
    expect(r.status).toBe(200)
    const again = await api('admin', 'PATCH', `/setup/employees/${b}`, { pan: 'ABCDE1234F' })
    expect(again.status).toBe(200) // same value, different case: no change
  })

  it('refuses a staff code another person holds, flag or not', async () => {
    const r = await api('admin', 'PATCH', `/setup/employees/${b}`, { employee_code: 'CO009', confirm_overwrite: true })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('already_used')
    expect(r.body.holder).toBe('Asha Test')
  })

  it('asks before an admission number is changed, and refuses a taken one', async () => {
    const r = await api('admin', 'PATCH', `/students/${IDS.child}/fields`, { admission_no: 'A099' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('confirm_overwrite')
    expect(r.body.changes[0]).toMatchObject({ field: 'admission_no', from: 'A001', to: 'A099' })
    const dup = await api('admin', 'PATCH', `/students/${IDS.child}/fields`, { admission_no: 'A002', confirm_overwrite: true })
    expect(dup.status).toBe(409)
    expect(dup.body.code).toBe('already_used')
    const ok = await api('admin', 'PATCH', `/students/${IDS.child}/fields`, { admission_no: 'A099', overwrite: ['admission_no'] })
    expect(ok.status).toBe(200)
    const p = await api('admin', 'GET', `/students/${IDS.child}/profile`)
    expect(p.body.admission_no).toBe('A099')
    // An empty APAAR is filled without a question.
    expect((await api('admin', 'PATCH', `/students/${IDS.child}/fields`, { apaar_id: '123456789012' })).status).toBe(200)
  })

  it('holds back an import row that would replace a code', async () => {
    expect((await api('admin', 'PATCH', `/setup/employees/${b}`, { phone: '9876500001' })).status).toBe(200)
    const csv = 'employee_code,first_name,phone\nCO002,Bala Test,9876500002\n'
    const send = async (qs: string) => {
      const res = await call('/api/v1/setup/import/staff' + qs, { method: 'POST', body: csv, cookie: await as('admin'), headers: { 'content-type': 'text/csv' } })
      return { status: res.status, body: await res.json() as any }
    }
    const dry = await send('')
    expect(dry.status).toBe(200)
    expect(dry.body.replacements[0].problem).toContain('phone 9876500001 with 9876500002')
    const held = await send('?commit=true')
    expect(held.body.imported).toBe(0)
    expect(held.body.problems[0].problem).toContain('Not applied')
    let d = await api('admin', 'GET', `/hr/employees/${b}/detail`)
    expect(d.body.phone).toBe('9876500001')
    const applied = await send('?commit=true&overwrite=true')
    expect(applied.body.imported).toBe(1)
    d = await api('admin', 'GET', `/hr/employees/${b}/detail`)
    expect(d.body.phone).toBe('9876500002')
  })
})
