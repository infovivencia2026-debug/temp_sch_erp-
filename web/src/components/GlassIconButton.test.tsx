import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GlassIconButton } from './ui'
import { RecordShell } from './RecordShell'

/* Owner, 2026-10-26: the drawer ✕ and the phone ← are iOS glass, and grow
   under the finger -- except under reduced motion. */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const src = (p: string) => readFileSync(resolve(__dirname, p), 'utf8')

function render(node: React.ReactNode) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  act(() => { createRoot(el).render(node) })
  return el
}

describe('GlassIconButton', () => {
  it('renders a labelled glass button', () => {
    const el = render(<GlassIconButton label="Close">x</GlassIconButton>)
    const b = el.querySelector('button[aria-label="Close"]')!
    expect(b.classList.contains('glass-btn')).toBe(true)
  })

  it('is the record back button', () => {
    const el = render(<MemoryRouter><RecordShell title="Asha" tabs={[{ key: 'a', label: 'A', render: () => null }]} onBack={() => {}} backLabel="Students" /></MemoryRouter>)
    expect(el.querySelector('button.glass-btn[aria-label="Students"]')).not.toBeNull()
  })

  it('is the drawer close', () => {
    expect(src('Shell.tsx')).toMatch(/<GlassIconButton label="Close menu"/)
  })

  it('grows on press, and not under reduced motion', () => {
    const css = src('../index.css')
    expect(css).toMatch(/button\.glass-btn:active:not\(:disabled\) \{\s*transform: scale\(1\.1\)/)
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*button\.glass-btn, button\.glass-btn:active:not\(:disabled\) \{ transform: none;/)
  })
})
