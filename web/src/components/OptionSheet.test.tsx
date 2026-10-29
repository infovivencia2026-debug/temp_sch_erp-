// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect } from 'vitest'
import { OptionSheet } from './OptionSheet'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('OptionSheet gutters (owner 2026-10-24: nothing touches an edge)', () => {
  it('list has symmetric 16px padding, hidden scrollbar, 16px + safe-area bottom', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(
      <OptionSheet open onClose={() => {}} title="Child" value="a" onPick={() => {}}
        options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />,
    ))
    const list = document.querySelector('[data-option-sheet] ul[role="listbox"]')!
    const cls = list.className.split(/\s+/)
    expect(cls).toContain('px-1')
    expect(cls.some((c) => /^(pl|pr|ps|pe)-/.test(c))).toBe(false)
    expect(cls).toContain('[scrollbar-width:none]')
    const sheet = document.querySelector('[data-option-sheet] [role="dialog"]') as HTMLElement
    expect(sheet.getAttribute('style')).toContain('16px + env(safe-area-inset-bottom')
    for (const b of list.querySelectorAll('button')) expect(b.className).toContain('rounded-[14px]')
    act(() => root.unmount())
  })

  it('search filters live, case-insensitive, and says No results (owner 2026-10-26)', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const options = Array.from({ length: 20 }, (_, i) => ({ value: `v${i}`, label: i === 7 ? 'Ravi Kumar' : `Student ${i}` }))
    act(() => root.render(<OptionSheet open onClose={() => {}} title="Student" value="" onPick={() => {}} options={options} />))
    const input = document.querySelector('[data-option-sheet] input[type="search"]') as HTMLInputElement
    const type = (v: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    type('RAVI')
    expect([...document.querySelectorAll('[data-option-sheet] [role="option"]')].map((li) => li.textContent)).toEqual(['Ravi Kumar'])
    type('zzz')
    expect(document.querySelector('[data-option-sheet] ul')!.textContent).toContain('No results')
    act(() => root.unmount())
  })
})
