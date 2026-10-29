import { describe, it, expect } from 'vitest'
import { todayTimeline } from './todayTimeline'

describe('todayTimeline', () => {
  it('turns summary rows into periods and today entries', () => {
    const wed = new Date('2026-10-21T10:00:00')
    const { periods, entries } = todayTimeline([
      { period: 'P1', starts_at: '09:00', ends_at: '09:40', subject: 'Maths', teacher: 'Ms A', room: '12' },
      { period: 'P2', starts_at: '09:40', ends_at: '10:20', subject: 'English' },
    ], wed)
    expect(periods.map((p) => p.name)).toEqual(['P1', 'P2'])
    expect(entries[0]).toEqual({ weekday: 3, period_id: periods[0].id, title: 'Maths', detail: 'Ms A · 12' })
    expect(entries[1].detail).toBeUndefined()
  })
})
