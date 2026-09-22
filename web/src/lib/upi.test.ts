import { describe, expect, it } from 'vitest'
import { isValidVpa, upiNote } from './upi'

describe('isValidVpa', () => {
  it('accepts the shapes banks issue', () => {
    for (const v of ['kalyan.qb@axl', 'school@sbi', 'vhs-fees_2026@okhdfcbank', '9876543210@ybl', ' school@sbi ']) {
      expect(isValidVpa(v), v).toBe(true)
    }
  })
  it('refuses what is not an address', () => {
    for (const v of ['', 'school', '@sbi', 'school@', 'sc@sbi', 'school @sbi', 'school@sbi@axl', 'school@sbi.co', 'school%40sbi']) {
      expect(isValidVpa(v), v).toBe(false)
    }
  })
})

describe('upiNote', () => {
  it('joins parts, drops what an app may refuse, and clips to 50', () => {
    expect(upiNote('Fee', 'ADM/2026/0142', undefined, '', 'INV-7')).toBe('Fee ADM/2026/0142 INV-7')
    expect(upiNote('Fee', 'Term 1 (Q3) & books!')).toBe('Fee Term 1 Q3 books')
    expect(upiNote('రవి కుమార్', 'ADM-1')).toBe('రవి కుమార్ ADM-1')
    expect(Array.from(upiNote('Fee', 'y'.repeat(80))).length).toBe(50)
  })
})
