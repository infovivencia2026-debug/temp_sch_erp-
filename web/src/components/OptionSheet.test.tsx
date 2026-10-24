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
    expect(cls).toContain('px-4')
    expect(cls.some((c) => /^(pl|pr|ps|pe)-/.test(c))).toBe(false)
    expect(cls).toContain('[scrollbar-width:none]')
    const sheet = document.querySelector('[data-option-sheet] [role="dialog"]') as HTMLElement
    expect(sheet.getAttribute('style')).toContain('calc(16px + env(safe-area-inset-bottom')
    for (const b of list.querySelectorAll('button')) expect(b.className).toContain('rounded-[12px]')
    act(() => root.unmount())
  })
})
