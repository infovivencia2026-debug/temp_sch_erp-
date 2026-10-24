// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { mergePeriods } from '@/lib/mergePeriods'

let phone = false
vi.mock('@/lib/viewport', () => ({ usePhone: () => phone }))
const { default: WeekGrid } = await import('@/components/WeekGrid')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* Three bell schedules with the same Assembly and Period 1 (Yajur, 2026-10-24). */
const periods = ['A', 'B', 'C'].flatMap((s) => [
  { id: `${s}-asm`, name: 'School Assembly', starts_at: '09:00:00', ends_at: '09:15:00', is_break: true, bell_schedule_id: s },
  { id: `${s}-p1`, name: 'Period1', starts_at: '09:15:00', ends_at: '10:00:00', is_break: false, bell_schedule_id: s },
])

describe('mergePeriods', () => {
  it('collapses identical periods across schedules to one row each', () => {
    const r = mergePeriods(periods, [])
    expect(r.periods.map((p) => p.name)).toEqual(['School Assembly', 'Period1'])
  })
  it("moves an entry on schedule B's Period 1 onto the merged row", () => {
    const r = mergePeriods(periods, [{ weekday: 1, period_id: 'B-p1' }])
    expect(r.periods).toHaveLength(2)
    const row = r.periods.find((p) => p.name === 'Period1')!
    expect(r.entries[0].period_id).toBe(row.id)
  })
})

function render() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  act(() => createRoot(el).render(
    <WeekGrid periods={periods} entries={[{ weekday: 1, period_id: 'B-p1', title: 'Maths' }]} />))
  return el
}

describe('WeekGrid', () => {
  it('desktop: a grid with Period 1 once and the lesson on it', () => {
    phone = false
    const el = render()
    expect(el.querySelector('table')).not.toBeNull()
    expect(el.textContent!.match(/Period1/g)).toHaveLength(1)
    expect(el.textContent!.match(/School Assembly/g)).toHaveLength(1)
    expect(el.textContent).toContain('Maths')
  })
  it('phone: the day timeline, not a table', () => {
    phone = true
    const el = render()
    expect(el.querySelector('table')).toBeNull()
    expect(el.querySelector('[role="tablist"]')).not.toBeNull()
  })
})
