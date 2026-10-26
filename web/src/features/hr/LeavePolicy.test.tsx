import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* Saved leave types are read-only rows; Edit opens one row, Cancel puts the
   saved values back, Save hands back that row's id. */

vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/lib/session', async (orig) => ({ ...(await orig<object>()), useSession: () => ({ authenticated: true, user: { id: 'u' }, modules: [] }), useCan: () => () => true }))

import { RulesTab } from './LeavePolicy'

const rule = {
  leave_type_id: 'cl', code: 'CL', name: 'Casual leave', annual_quota: 12,
  is_paid: true, carry_forward: false, accrual: 'annual', encashable: false,
  allow_half_day: true, notice_days: 1, available_during_probation: true,
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const btn = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)

describe('RulesTab', () => {
  it('shows saved rows read-only with Edit, then Save and Cancel', () => {
    const onChange = vi.fn()
    const onSaveRow = vi.fn()
    act(() => root.render(
      <RulesTab types={[rule]} saved={[rule]} onChange={onChange} onSaveRow={onSaveRow}
        saving={false} onRemove={vi.fn()} />,
    ))
    expect(host.querySelectorAll('input').length).toBe(0)
    act(() => btn('Edit')!.click())
    expect(host.querySelectorAll('input').length).toBeGreaterThan(0)
    act(() => btn('Save')!.click())
    expect(onSaveRow).toHaveBeenCalledWith('cl', expect.any(Function))
    act(() => btn('Cancel')!.click())
    expect(onChange).toHaveBeenCalledWith('cl', rule)
    expect(host.querySelectorAll('input').length).toBe(0)
  })
})
