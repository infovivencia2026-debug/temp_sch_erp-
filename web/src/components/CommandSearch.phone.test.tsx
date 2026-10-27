import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* The phone top bar's search (owner, 2026-10-27): an icon button that opens
   the palette across the top with the field focused and the page blurred. */

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/institution_admin/home/dashboard', search: '' }),
}))
vi.mock('@/lib/catalog', () => ({
  useCatalog: () => ({ active_role: 'institution_admin', roles: [{ key: 'institution_admin', sections: [] }] }),
  featurePath: () => '/x',
}))
vi.mock('@/lib/session', () => ({ useSession: () => ({ user: { full_name: 'A B' }, roles: [], permissions: [] }) }))
vi.mock('@/lib/api', () => ({ api: { get: () => Promise.resolve({ items: [] }) } }))

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = '' })

describe('phone header search', () => {
  it('renders the search icon and opening it focuses the input on a blurred sheet', async () => {
    const { CommandSearch } = await import('./CommandSearch')
    const qc = new QueryClient()
    await act(async () => { root.render(<QueryClientProvider client={qc}><CommandSearch wide /></QueryClientProvider>) })
    const btn = host.querySelector<HTMLButtonElement>('button[aria-label="Search features"]')
    expect(btn).toBeTruthy()
    expect(btn!.className).toContain('max-sm:h-12')
    expect(btn!.querySelector('svg')).toBeTruthy()
    await act(async () => { btn!.click() })
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')
    expect(input).toBeTruthy()
    expect(document.activeElement).toBe(input)
    expect(document.querySelector('.scrim.search-sheet')).toBeTruthy()
  })
})
