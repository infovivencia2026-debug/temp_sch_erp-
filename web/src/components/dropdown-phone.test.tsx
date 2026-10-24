import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Select } from '@/components/ui'
import { PickerMenu } from '@/components/PickerMenu'

vi.mock('@/lib/session', async (orig) => ({ ...(await orig<object>()), useCan: () => () => false }))

let host: HTMLDivElement
let root: Root
function phone(on: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: on && q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  phone(true)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = '' })

const LEAVE = [{ value: 'casual', label: 'Casual' }, { value: 'sick', label: 'Sick' }, { value: 'earned', label: 'Earned' }]
let last = ''
function Kind({ options = LEAVE }: { options?: { value: string; label: string }[] }) {
  const [v, setV] = useState('')
  last = v
  return <Select value={v} onChange={setV} options={options} placeholder="Kind of leave" />
}

describe('dropdowns on a phone', () => {
  it('Select: the trigger is a button, no editable input, no keyboard', () => {
    act(() => root.render(<Kind />))
    expect(host.querySelector('input')).toBeNull()
    const btn = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!
    act(() => btn.click())
    expect(document.activeElement?.tagName).not.toBe('INPUT')
    const sheet = document.querySelector('[data-option-sheet]')!
    expect(sheet).not.toBeNull()
    expect(sheet.querySelector('input')).toBeNull()
    expect(sheet.querySelectorAll('[role="option"]').length).toBeGreaterThanOrEqual(3)
  })
  it('Select: choosing closes the sheet and sets the value', () => {
    act(() => root.render(<Kind />))
    act(() => host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!.click())
    const sick = [...document.querySelectorAll<HTMLButtonElement>('[data-option-sheet] [role="option"] button')].find((b) => b.textContent === 'Sick')!
    act(() => sick.click())
    expect(last).toBe('sick')
    expect(document.querySelector('[data-option-sheet]')).toBeNull()
    expect(host.textContent).toContain('Sick')
  })
  it('Select: a long list searches inside the sheet, without focusing it', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }))
    act(() => root.render(<Kind options={many} />))
    expect(host.querySelector('input')).toBeNull()
    act(() => host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!.click())
    const search = document.querySelector('[data-option-sheet] input[type="search"]')
    expect(search).not.toBeNull()
    expect(document.activeElement).not.toBe(search)
  })
  it('PickerMenu: opens in the sheet and closes on choose', () => {
    let got = ''
    act(() => root.render(<PickerMenu value="a" ariaLabel="Term" onChange={(v) => { got = v }}
      options={[{ value: 'a', label: 'Term 1' }, { value: 'b', label: 'Term 2' }]} />))
    act(() => host.querySelector<HTMLButtonElement>('button')!.click())
    const b = [...document.querySelectorAll<HTMLButtonElement>('[data-option-sheet] [role="option"] button')].find((x) => x.textContent === 'Term 2')!
    act(() => b.click())
    expect(got).toBe('b')
    expect(document.querySelector('[data-option-sheet]')).toBeNull()
  })
  it('desktop keeps the typeable combobox', () => {
    phone(false)
    act(() => root.render(<Kind />))
    expect(host.querySelector('input[role="combobox"]')).not.toBeNull()
  })
})
