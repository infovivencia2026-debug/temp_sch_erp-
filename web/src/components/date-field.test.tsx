import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdmitStudent from '@/features/setup/AdmitStudent'

vi.mock('@/lib/session', async (orig) => ({ ...(await orig<object>()), useSession: () => ({ authenticated: true, user: { id: 'u' }, modules: [] }), useCan: () => () => true }))

let host: HTMLDivElement
let root: Root
let where = ''
function Where() { where = useLocation().pathname + useLocation().search + useLocation().hash; return null }

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })))
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; vi.unstubAllGlobals() })

describe('date of birth on the admit form', () => {
  it('opens the calendar without leaving the screen', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const errors: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((e) => { errors.push(e) })
    await act(async () => {
      root.render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/office/students/admit']}><Where /><AdmitStudent onDone={() => {}} /></MemoryRouter></QueryClientProvider>)
    })
    const btn = document.querySelector<HTMLButtonElement>('button[aria-label="Choose a date"], button[aria-expanded]')!
    expect(btn).toBeTruthy()
    const before = where
    await act(async () => { btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); btn.click() })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(document.querySelector('[role="dialog"][aria-label="Choose a date"]')).toBeTruthy()
    expect(where).toBe(before)
    spy.mockRestore()
  })
})

describe('holiday lookup survives the persisted cache', () => {
  it('reads {} (a Map after JSON), a Map, a record or junk without throwing', async () => {
    const { holidayLookup } = await import('./DatePopover')
    expect(holidayLookup({})).toEqual({})
    expect(holidayLookup(new Map([['2026-10-02', 'Gandhi Jayanti']]))).toEqual({ '2026-10-02': 'Gandhi Jayanti' })
    expect(holidayLookup({ '2026-10-02': 'X', bad: 3 })).toEqual({ '2026-10-02': 'X' })
    expect(holidayLookup(null)).toEqual({})
    expect(holidayLookup([1])).toEqual({})
  })

  it('opens the calendar with a JSON-restored holiday cache without crashing or moving', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const now = new Date()
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    qc.setQueryData(['holiday-days', key], JSON.parse(JSON.stringify(new Map([['x', 'y']]))))
    await act(async () => {
      root.render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/office/students/admit']}><Where /><AdmitStudent onDone={() => {}} /></MemoryRouter></QueryClientProvider>)
    })
    const before = where
    const btn = document.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    await act(async () => { btn.click() })
    expect(document.querySelector('[role="dialog"][aria-label="Choose a date"]')).toBeTruthy()
    expect(where).toBe(before)
  })
})
