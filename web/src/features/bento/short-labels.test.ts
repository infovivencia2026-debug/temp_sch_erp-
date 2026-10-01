import { describe, expect, it } from 'vitest'
import { shortLabel, shortLabels } from './short-labels'

describe('shortLabel', () => {
  it('uses the curated name', () => {
    expect(shortLabel('Student 360')).toBe('Students')
    expect(shortLabel('Admissions Pipeline')).toBe('Admissions')
    expect(shortLabel('School setup')).toBe('Setup')
    expect(shortLabel('Class Status')).toBe('Status')
    expect(shortLabel('Homework / classwork')).toBe('Homework')
  })
  it('drops generic words and leading verbs', () => {
    expect(shortLabel('My classes')).toBe('Classes')
    expect(shortLabel('Take attendance')).toBe('Attendance')
    expect(shortLabel('My timetable')).toBe('Timetable')
    expect(shortLabel('Question Bank Management')).toBe('Question')
  })
  it('is one word for every default teacher and parent icon', () => {
    for (const n of ['My classes', 'Take attendance', 'Homework / classwork', 'My timetable', 'Attendance', 'Homework & academics', 'Fees & payments', 'Live bus tracking'])
      expect(shortLabel(n)).not.toMatch(/\s/)
  })
})

describe('shortLabels', () => {
  it('never repeats a label on one board', () => {
    const l = shortLabels(['Staff attendance register', 'Staff hiring', 'Fees'])
    expect(new Set(l).size).toBe(3)
    expect(l[2]).toBe('Fees')
  })
})
