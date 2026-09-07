import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* THE TAB STRIP'S CONTEXT MENU, on the board's popover.

   A right-click on a tab used to open its own hand-rolled menu; it now opens
   the same `Menu` every menu on the board uses. These tests hold it to the
   contract that component makes — a `role="menu"` in the document with the
   expected rows, focus on the first row, Escape closing it — through the DOM
   and the stores rather than through any component internals.

   Rendered with react-dom/client and `act`, like the launcher test, because
   the popover is all effects: it measures its anchor after mount and installs
   its Escape listener on the document. */

const navigate = vi.fn()
const HERE = '/principal/fees/overview'
const BOARD = '/principal/home/dashboard'

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: HERE, search: '' }),
}))

vi.mock('@/lib/i18n', () => ({
  useT: () => (k: string, vars?: Record<string, string | number>) =>
    vars && 'n' in vars ? `${k}:${vars.n}` : k,
}))

vi.mock('@/lib/catalog', () => ({
  useCatalog: () => ({ active_role: 'principal', roles: [{ key: 'principal', sections: [] }] }),
  screenTitle: (_c: unknown, path: string) => path.split('/').pop() ?? path,
}))

vi.mock('@/lib/layout', () => ({
  useLayout: () => ({ layout: 'bento', setLayout: () => {} }),
}))

const closeTab = vi.fn()
vi.mock('@/lib/tabs', () => ({
  MAX_TABS: 8,
  neighbourOf: () => null,
  useTabs: () => ({
    tabs: [
      { path: BOARD, title: 'Dashboard' },
      { path: HERE, title: 'Fee overview' },
    ],
    open: () => {},
    close: closeTab,
  }),
}))

const requestArrange = vi.fn()
vi.mock('@/lib/widgets', () => ({ requestArrange: (...a: unknown[]) => requestArrange(...a) }))

import TabStrip from './TabStrip'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom has no layout and no scrollIntoView; the strip calls it on mount.
  Element.prototype.scrollIntoView = vi.fn()
  navigate.mockClear()
  requestArrange.mockClear()
  closeTab.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<TabStrip />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]')
const rows = () =>
  Array.from(menu()?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []).map((b) => b.textContent)

function rightClick(title: string) {
  const tab = Array.from(host.querySelectorAll<HTMLElement>('[role="tab"]')).find((b) => b.textContent === title)
  if (!tab) throw new Error(`no tab titled ${title}`)
  act(() => {
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  return tab
}

describe('TabStrip context menu', () => {
  it('opens the board rows on a Home tab, named after the tab, with focus on the first row', () => {
    expect(menu()).toBeNull()
    rightClick('Dashboard')
    const m = menu()
    expect(m).not.toBeNull()
    expect(m!.getAttribute('aria-label')).toBe('Dashboard')
    expect(rows()).toEqual([
      'bento.menu.add_card',
      'bento.menu.customize',
      'bento.menu.board_settings',
      'tabs.menu.close',
    ])
    expect(m!.querySelector('[role="separator"]')).not.toBeNull()
    expect(document.activeElement?.textContent).toBe('bento.menu.add_card')
  })

  it('offers the four directions on an ordinary tab, and no pane row while there is one pane', () => {
    rightClick('Fee overview')
    expect(rows()).toEqual([
      'tabs.menu.right',
      'tabs.menu.left',
      'tabs.menu.up',
      'tabs.menu.down',
      'tabs.menu.close',
    ])
  })

  it('"Customize board" goes to the board, parks the arrange request and closes the menu', () => {
    rightClick('Dashboard')
    const row = Array.from(menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((b) => b.textContent === 'bento.menu.customize')!
    act(() => { row.click() })
    expect(navigate).toHaveBeenCalledWith(BOARD)
    expect(requestArrange).toHaveBeenCalledTimes(1)
    expect(menu()).toBeNull()
  })

  it('Escape closes the menu and hands focus back to the tab', () => {
    const tab = rightClick('Dashboard')
    expect(menu()).not.toBeNull()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(tab)
  })

  it('a press outside closes it', () => {
    rightClick('Dashboard')
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(menu()).toBeNull()
  })
})
