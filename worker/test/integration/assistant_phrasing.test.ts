import { describe, expect, it } from 'vitest'
import { matchHelp } from '../../src/routes/misc/assistant'

// Asked any way, misspelt too, the help finds the screen (owner, 2026-11-11).
describe('assistant help matching', () => {
  const roles = ['faculty', 'institution_admin']
  it.each([
    ['how can i mark attendance', 'Take attendance'],
    ['how can i amrk attendace', 'Take attendance'],
    ['how to take attendance', 'Take attendance'],
    ['where to record attendence', 'Take attendance'],
    ['where do i enter marks', 'Marks entry'],
    ['how to collect fess', 'Fee Collection'],
    ['how to see time table', 'My timetable'],
    ['how to make question paper', 'Question papers'],
  ])('%s -> %s', (q, screen) => {
    const m = matchHelp(q, roles)
    expect(m?.name).toBe(screen)
    expect(m!.score).toBeGreaterThanOrEqual(2)
  })
})
