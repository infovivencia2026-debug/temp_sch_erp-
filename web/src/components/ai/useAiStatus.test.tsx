import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* The AI status hook and the buttons that read it: a refused or missing key
   turns Write with AI and Translate off with a one-line reason (not hidden),
   and they come back on, without a reload, when the status says ok. */

const status = vi.fn()
vi.mock('./aiApi', async (orig) => ({ ...(await orig<typeof import('./aiApi')>()), aiApi: { status: () => status(), draft: vi.fn(), translate: vi.fn() } }))
vi.mock('@/lib/session', () => ({ useSessionIfAny: () => ({ user: { platform_admin: false, roles: ['teacher'] } }) }))
vi.mock('@/lib/viewport', () => ({ usePhone: () => false }))

import { offReason } from './useAiStatus'
import WriteWithAI from './WriteWithAI'
import TranslateNotice from './TranslateNotice'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root, qc: QueryClient

beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => { act(() => root.unmount()); host.remove(); status.mockReset() })

const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)) }) }
const render = async () => {
  await act(async () => {
    root.render(<QueryClientProvider client={qc}>
      <WriteWithAI kind="parent_message" onInsert={() => {}} />
      <TranslateNotice text="School closes at noon" />
    </QueryClientProvider>)
  })
  await flush()
}
const buttons = () => [...host.querySelectorAll('button')].filter((b) => /Write with AI|Translate to/.test(b.textContent ?? ''))

describe('offReason', () => {
  it('says nothing when ok, and tells an operator where to fix it', () => {
    expect(offReason('ok', true)).toBeNull()
    expect(offReason('refused', true)).toMatch(/Controls, AI/)
    expect(offReason('refused', false)).not.toMatch(/Controls/)
    expect(offReason('quota', false)).toMatch(/busy/)
  })
})

describe('AI buttons', () => {
  it('are on when the key works', async () => {
    status.mockResolvedValue({ configured: true, state: 'ok', checked_at: null })
    await render()
    expect(buttons()).toHaveLength(3)
    expect(buttons().every((b) => !b.disabled)).toBe(true)
  })

  it('are off, still shown, with the reason linked by aria-describedby; back on after the status changes', async () => {
    status.mockResolvedValue({ configured: false, state: 'refused', checked_at: '2026-10-07T10:00:00Z' })
    await render()
    const bs = buttons()
    expect(bs).toHaveLength(3)
    for (const b of bs) {
      expect(b.disabled).toBe(true)
      const id = b.getAttribute('aria-describedby')!
      expect(document.getElementById(id)?.textContent).toMatch(/unavailable/)
    }
    status.mockResolvedValue({ configured: true, state: 'ok', checked_at: null })
    await act(async () => { await qc.invalidateQueries({ queryKey: ['ai-status'] }) })
    await flush()
        expect(buttons().map((b) => b.disabled)).toEqual([false, false, false])
    expect(host.textContent).not.toMatch(/unavailable/)
  })

  it('stay on while the status is loading or could not be read', async () => {
    status.mockRejectedValue(new Error('offline'))
    await render()
    expect(buttons().every((b) => !b.disabled)).toBe(true)
  })
})
