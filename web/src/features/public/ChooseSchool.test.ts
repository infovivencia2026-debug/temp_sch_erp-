import { describe, it, expect } from 'vitest'
import { parseSchoolCode } from './ChooseSchool'

describe('parseSchoolCode', () => {
  it('reads a typed code, a link or a QR text', () => {
    expect(parseSchoolCode('in/riverside')).toEqual({ cc: 'in', slug: 'riverside' })
    expect(parseSchoolCode(' IN / Riverside ')).toEqual({ cc: 'in', slug: 'riverside' })
    expect(parseSchoolCode('https://school-erp-d1.pages.dev/in/dps-noida')).toEqual({ cc: 'in', slug: 'dps-noida' })
    expect(parseSchoolCode('https://x.test/in/dps-noida/')).toEqual({ cc: 'in', slug: 'dps-noida' })
  })
  it('refuses what is not a code', () => {
    expect(parseSchoolCode('riverside')).toBeNull()
    expect(parseSchoolCode('')).toBeNull()
  })
})
