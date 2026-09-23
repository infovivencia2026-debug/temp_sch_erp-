import { describe, it, expect } from 'vitest'
import { within1 } from './CommandSearch'

describe('within1: one typo, not two', () => {
  it('accepts a swap, a drop, an extra and a transposition', () => {
    expect(within1('attendence', 'attendance')).toBe(true)
    expect(within1('recipt', 'receipt')).toBe(true)
    expect(within1('timetablee', 'timetable')).toBe(true)
    expect(within1('timetabel', 'timetable')).toBe(true)
  })
  it('refuses two edits, so "fees" does not reach "fines"', () => {
    expect(within1('fees', 'fines')).toBe(false)
    expect(within1('attndnce', 'attendance')).toBe(false)
  })
  it('is exact for equal strings and refuses a length gap of two', () => {
    expect(within1('marks', 'marks')).toBe(true)
    expect(within1('mark', 'marked')).toBe(false)
  })
})
