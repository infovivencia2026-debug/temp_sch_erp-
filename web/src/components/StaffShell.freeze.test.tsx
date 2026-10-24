import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* THE STAFF LAYOUT MUST SETTLE (incident: 432871c2 froze the live site for a
   teaching account with staff_layout on). Renders the whole Shell for that
   account and holds it to a bounded number of commits and history writes. */

const { CATALOG, SESSION, never } = vi.hoisted(() => {
localStorage.setItem('erp.layout', 'classic')
const feat = (slug: string, name: string) => ({ key: `faculty.${slug}`, slug, name, summary: name, scope: 'self', tier: 'core', in_scope: true, live: true })
const CATALOG = {
  active_role: 'faculty',
  roles: [{ key: 'faculty', name: 'Faculty', sections: [
    { slug: 'home', name: 'Home', workspace: 'home', features: [feat('dashboard', 'Dashboard')] },
    { slug: 'classes', name: 'Classes', workspace: 'teaching', features: [feat('attendance', 'Attendance'), feat('homework', 'Homework')] },
  ] }],
  scope: { platform_admin: false, all_campuses: false, campuses: 1, departments: 1, sections: 1 },
}
const SESSION = {
  authenticated: true,
  user: { id: 1, full_name: 'Asha Rao', permissions: [] },
  roles: ['faculty'],
  permissions: [],
  modules: [{ module: 'staff_layout', enabled: true }],
  institution: { name: 'School' },
}
return { CATALOG, SESSION, never: () => new Promise(() => {}) }
})

vi.mock('@/lib/api', async (orig) => {
  const real = await orig<{ api: object }>()
  const call = (route: string) => (console.log('CALL', route), 0) ||
    route.startsWith('GET /session') ? Promise.resolve(SESSION)
      : route.startsWith('GET /catalog') ? Promise.resolve(CATALOG) : never()
  return { ...real, api: { ...real.api, call, get: never, post: never, put: never, patch: never, del: never, delete: never } }
})

import { SessionProvider } from '@/lib/session'
import { CatalogProvider } from '@/lib/catalog'
import { Shell } from './Shell'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = ((q: string) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as never
  localStorage.setItem('erp.layout', 'classic')
  ;(Element.prototype as { getAnimations?: () => Animation[] }).getAnimations ??= () => []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('Shell with the staff layout', () => {
  it('renders the staff panel and settles', async () => {
    const push = vi.spyOn(window.history, 'pushState')
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.map(String).join(' ')) })
    let commits = 0
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/faculty/classes/attendance']}>
            <Profiler id="shell" onRender={() => { commits++ }}>
              <SessionProvider><CatalogProvider><Shell><div>page</div></Shell></CatalogProvider></SessionProvider>
            </Profiler>
          </MemoryRouter>
        </QueryClientProvider>,
      )
    })
    for (let i = 0; i < 30; i++) await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(errors.join('\n')).not.toMatch(/Maximum update depth/)
    expect(commits).toBeLessThan(40)
    expect(push.mock.calls.length).toBeLessThan(3)
    expect(host.querySelector('a[href="/logout"]')).not.toBeNull()

    // Open the drawer, as a phone user does, and let it settle.
    const settled = commits
    const opener = host.querySelector('button[aria-label="Open navigation"]') as HTMLButtonElement
    expect(opener).not.toBeNull()
    await act(async () => { opener.click() })
    for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(errors.join('\n')).not.toMatch(/Maximum update depth/)
    expect(commits - settled).toBeLessThan(40)
    expect(push.mock.calls.length).toBeLessThan(3)
  })
})
