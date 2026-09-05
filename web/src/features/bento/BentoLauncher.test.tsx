import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* THE RECENTLY OPENED TILE MUST SURVIVE A TOUCH.

   On the iPhone a tap on a tile in the launcher's "Recently opened" band did
   nothing. The band sits at the top of the sheet, which is the one place the
   sheet's pull-down gesture is armed (scrollTop <= 0), and a finger that is
   "tapping" still moves a pixel between touchstart and touchend. That pixel
   reached onSheetTouchMove, which set `pull`, which re-rendered the launcher.

   `Tile` was declared INSIDE the launcher's render function, so every render
   produced a new component type, and React does not reconcile across a type
   change: it unmounted every tile and mounted fresh ones. The button the
   finger landed on was no longer in the document by the time the browser went
   to dispatch the click, and WebKit dispatches nothing to a detached target.

   The tiles further down worked because a finger there is scrolling, and the
   pull gesture stands down once the list has scrolled — so it looked like a
   bug in the recents list specifically. */

const navigate = vi.fn()

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: '/' }),
}))

vi.mock('@/lib/i18n', () => ({
  useT: () => (k: string) => k,
}))

vi.mock('@/lib/catalog', () => ({
  useActiveRole: () => ({
    key: 'parent',
    name: 'Parent',
    sections: [
      {
        slug: 'home', name: 'Home', workspace: 'Home',
        features: [
          { key: 'home.today', slug: 'today', name: 'Today', live: true, in_scope: true },
          { key: 'home.fees', slug: 'fees', name: 'Fees', live: true, in_scope: true },
        ],
      },
    ],
  }),
  featurePath: (r: string, s: string, f: string) => `/${r}/${s}/${f}`,
  usable: (f: { live: boolean; in_scope: boolean }) => f.live && f.in_scope,
}))

import { BentoLauncher } from './BentoLauncher'
import { recordRecent } from '@/lib/recents'

/* A touch event jsdom can build. It has no Touch constructor, so the list is
   put on a plain event; React's synthetic event reads `touches` straight off
   the native one. */
function touch(type: string, clientY: number): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'touches', { value: [{ clientY }] })
  return e
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  navigate.mockReset()
  localStorage.clear()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('BentoLauncher recents', () => {
  it('a tap that wobbles a pixel still opens the recent feature', async () => {
    recordRecent('home.fees')
    await act(async () => {
      root.render(<BentoLauncher open onClose={() => {}} />)
    })

    const tile = host.querySelector<HTMLButtonElement>('button.launcher-app')
    expect(tile, 'a recent tile is drawn').not.toBeNull()
    expect(tile!.textContent).toContain('Fees')

    // The finger lands, and drifts one pixel down before it lifts.
    await act(async () => {
      tile!.dispatchEvent(touch('touchstart', 100))
    })
    await act(async () => {
      tile!.dispatchEvent(touch('touchmove', 101))
    })
    await act(async () => {
      tile!.dispatchEvent(touch('touchend', 101))
    })

    // The element the finger pressed is the one the browser will click.
    expect(host.contains(tile), 'the pressed tile is still in the document').toBe(true)

    await act(async () => {
      tile!.click()
    })
    expect(navigate).toHaveBeenCalledWith('/parent/home/fees')
  })
})
