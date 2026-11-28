import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { staffRegisterXls, type RegInput } from './staff-register-xls'

const staff = [
  { employee_code: 'Y001', biometric_id: '1', full_name: 'Asha', department: 'Teaching' },
  { employee_code: 'Y002', biometric_id: '2', full_name: 'Ravi', department: 'Teaching' },
  { employee_code: 'Y003', biometric_id: '3', full_name: 'Lata', department: 'Non Teaching' },
  { employee_code: 'Y004', biometric_id: '4', full_name: 'Mohan', department: 'Non Teaching' },
]
const make = (days: string[]): RegInput => {
  const marks: RegInput['marks'] = {}, ins: RegInput['ins'] = {}, outs: RegInput['outs'] = {}
  days.forEach((d, i) => {
    marks[d] = { Y003: 'leave' }; ins[d] = { Y001: '08:30:00', Y002: i % 2 ? '09:05:12' : '08:40' }; outs[d] = { Y001: '16:10', Y002: '16:30' }
    if (i % 3 === 0) marks[d].Y002 = 'late'
  })
  return { school: 'Yajur', groupLabel: 'All staff', from: days[0], to: days[days.length - 1], days, staff, marks, ins, outs }
}
const range = Array.from({ length: 28 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`)

describe('staff register xls', () => {
  it('one day: Status/In/Out, no totals, late amber', () => {
    const h = staffRegisterXls(make(['2026-11-28']))
    expect(h).toContain('28-Nov Sat')
    expect(h).toContain('>Status<')
    expect(h).not.toContain('>Late</th>')
    expect(h).not.toContain('punched in, not marked')
    expect(h).toMatch(/fde68a[^>]*>08:40</)
    expect(h).toContain('>16:10<')
    expect(h).toMatch(/>A</) // Mohan
    expect(h).toMatch(/>L</) // Lata
  })
  it('range: totals P A L Late', () => {
    const h = staffRegisterXls(make(range))
    expect(h).toContain('>Late</th>')
    expect((h.match(/>Status</g) ?? []).length).toBe(28)
  })
  it('writes samples', () => {
    const dir = process.env.REG_OUT; if (!dir) return
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/staff-register-2026-11-28.xls`, '\uFEFF' + staffRegisterXls(make(['2026-11-28'])))
    writeFileSync(`${dir}/staff-register-2026-11-01-to-2026-11-28.xls`, '\uFEFF' + staffRegisterXls(make(range)))
  })
})
