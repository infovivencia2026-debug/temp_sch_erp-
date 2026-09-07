import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
  useT: () => (k: string, vars?: Record<string, string | number>) =>
    vars ? `${k}[${Object.values(vars).join(',')}]` : k,
}))

/* The kit's hook reads the account's display preference over the network;
   the launcher only needs its answer. */
vi.mock('./bento-kit', () => ({
  useReduceMotion: () => true,
}))

vi.mock('@/lib/haptics', () => ({
  buzz: () => {},
}))

/* Two workspaces, five features, one of which the account may not open. */
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
          { key: 'home.fee_dashboard', slug: 'fee-dashboard', name: 'Fee Dashboard', live: true, in_scope: true },
          { key: 'home.locked', slug: 'locked', name: 'Locked Away', live: false, in_scope: true },
        ],
      },
      {
        slug: 'child', name: 'My Child', workspace: 'My Child',
        features: [
          { key: 'child.attendance', slug: 'attendance', name: 'Attendance', live: true, in_scope: true },
          { key: 'child.marks', slug: 'marks', name: 'Marks & Grades', live: true, in_scope: true },
        ],
      },
    ],
  }),
  featurePath: (r: string, s: string, f: string) => `/${r}/${s}/${f}`,
  usable: (f: { live: boolean; in_scope: boolean }) => f.live && f.in_scope,
}))

import { BentoLauncher, monogram, splitMatch } from './BentoLauncher'
import { recordRecent, reloadRecents } from '@/lib/recents'
import { PINS_KEY, parsePins, reloadPins, toggled, withPin, PINS_LIMIT } from '@/lib/pins'
import { code } from './bento-test-render'

/* A touch event jsdom can build. It has no Touch constructor, so the list is
   put on a plain event; React's synthetic event reads `touches` straight off
   the native one. */
function touch(type: string, clientX: number, clientY: number): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'touches', { value: [{ clientX, clientY }] })
  return e
}

/** Type into a controlled React input the way a keyboard would: through the
    native value setter, so React's own tracker notices the change. */
async function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function key(k: string, target: EventTarget = window) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}

const tiles = (scope: ParentNode = host) => Array.from(scope.querySelectorAll<HTMLButtonElement>('button.lch-app'))
/** The name under each plate, without the "where it belongs" caption. */
const names = (scope: ParentNode = host) =>
  tiles(scope).map((b) => {
    const n = b.querySelector('.lch-name')!
    const all = n.textContent ?? ''
    const where = n.querySelector('.lch-where')?.textContent ?? ''
    return all.slice(0, all.length - where.length)
  })
const band = (name: string) => host.querySelector<HTMLElement>(`[data-band="${name}"]`)

let host: HTMLDivElement
let root: Root
const onClose = vi.fn()

async function render(open = true) {
  await act(async () => {
    root.render(<BentoLauncher open={open} onClose={onClose} />)
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  navigate.mockReset()
  onClose.mockReset()
  localStorage.clear()
  reloadPins()
  reloadRecents()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('BentoLauncher recents', () => {
  it('a tap that wobbles a pixel still opens the recent feature', async () => {
    recordRecent('home.fees')
    await render()

    const recent = band('recent')
    expect(recent, 'a recents band is drawn').not.toBeNull()
    const tile = recent!.querySelector<HTMLButtonElement>('button.lch-app')
    expect(tile, 'a recent tile is drawn').not.toBeNull()
    expect(tile!.textContent).toContain('Fees')

    // The finger lands, and drifts one pixel down before it lifts.
    await act(async () => {
      tile!.dispatchEvent(touch('touchstart', 50, 100))
    })
    await act(async () => {
      tile!.dispatchEvent(touch('touchmove', 50, 101))
    })
    await act(async () => {
      tile!.dispatchEvent(touch('touchend', 50, 101))
    })

    // The element the finger pressed is the one the browser will click.
    expect(host.contains(tile), 'the pressed tile is still in the document').toBe(true)

    await act(async () => {
      tile!.click()
    })
    expect(navigate).toHaveBeenCalledWith('/parent/home/fees')
  })

  it('the recents band scrolls sideways and snaps', async () => {
    recordRecent('home.fees')
    await render()
    const strip = band('recent')!.querySelector('.lch-band')
    expect(strip).not.toBeNull()
    expect(strip!.querySelector('.lch-cell')).not.toBeNull()
  })
})

describe('BentoLauncher grid', () => {
  it('draws every feature the role may open, under its workspace, once each', async () => {
    await render()
    const all = Array.from(host.querySelectorAll<HTMLElement>('[data-band="all"]'))
    expect(all.map((s) => s.dataset.workspace)).toEqual(['Home', 'My Child'])
    const drawn = all.flatMap((s) => tiles(s).map((b) => b.closest<HTMLElement>('.lch-cell')!.dataset.key))
    expect(drawn).toEqual(['home.today', 'home.fees', 'home.fee_dashboard', 'child.attendance', 'child.marks'])
    expect(host.textContent).not.toContain('Locked Away')
    // Quiet labels, not panels: each workspace is a heading over the same grid.
    expect(all[0].querySelector('h3.lch-label')!.textContent).toBe('Home')
    expect(all[0].querySelector('.lch-grid')).not.toBeNull()
  })

  it('every tile carries a monogram on a plate tinted from its workspace', async () => {
    await render()
    const cell = host.querySelector<HTMLElement>('[data-key="home.fee_dashboard"]')!
    expect(cell.querySelector('.lch-mono')!.textContent).toBe('FD')
    const plate = cell.querySelector<HTMLElement>('.lch-plate')!
    expect(plate.getAttribute('style')).toMatch(/--plate:\s*color-mix\(in srgb, var\(--dom-operations\)/)
  })

  it('is a labelled modal dialog', async () => {
    await render()
    const dialog = host.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('bento.launcher.title')
    expect(host.querySelector('input[aria-label]')).not.toBeNull()
  })

  it('draws nothing once closed', async () => {
    await render(false)
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('BentoLauncher search', () => {
  it('filters live and marks the match in the name', async () => {
    await render()
    const input = host.querySelector<HTMLInputElement>('input')!
    await type(input, 'fee')
    expect(band('all'), 'the workspaces give way to the results').toBeNull()
    const results = band('results')!
    // Both start with the needle, so they tie on rank and fall to the alphabet.
    expect(names(results)).toEqual(['Fee Dashboard', 'Fees'])
    const marks = Array.from(results.querySelectorAll('mark.lch-hl')).map((m) => m.textContent)
    expect(marks).toEqual(['Fee', 'Fee'])

    await type(input, 'zzz')
    expect(band('results')).toBeNull()
    expect(host.textContent).toContain('bento.launcher.empty[zzz]')

    await type(input, '')
    expect(band('all')).not.toBeNull()
  })

  it('splitMatch cuts the name around the first hit, case-insensitively', () => {
    expect(splitMatch('Fee Dashboard', 'dash')).toEqual([
      { text: 'Fee ', hit: false }, { text: 'Dash', hit: true }, { text: 'board', hit: false },
    ])
    expect(splitMatch('Fees', 'x')).toEqual([{ text: 'Fees', hit: false }])
    expect(splitMatch('Fees', '')).toEqual([{ text: 'Fees', hit: false }])
  })

  it('monogram takes two initials, skipping the little words', () => {
    expect(monogram('Fee Dashboard')).toBe('FD')
    expect(monogram('Working Days & Instructional Hours')).toBe('WD')
    expect(monogram('Fees')).toBe('Fe')
    expect(monogram('Of Note')).toBe('ON')
    expect(monogram('My Work')).toBe('MW')
  })
})

describe('BentoLauncher pins', () => {
  it('pins from the tile menu, keeps it in erp.launcher.pins, and unpins', async () => {
    await render()
    expect(band('pinned')).toBeNull()

    const cell = host.querySelector<HTMLElement>('[data-key="home.fees"]')!
    const more = cell.querySelector<HTMLButtonElement>('button.lch-more')!
    expect(more.getAttribute('aria-label')).toBe('bento.launcher.more_for[Fees]')
    await act(async () => { more.click() })
    const item = cell.querySelector<HTMLButtonElement>('[role="menu"] [role="menuitem"]')!
    expect(item.textContent).toBe('bento.launcher.pin')
    await act(async () => { item.click() })

    expect(JSON.parse(localStorage.getItem(PINS_KEY)!)).toEqual(['home.fees'])
    expect(band('pinned'), 'a pinned row appears').not.toBeNull()
    expect(names(band('pinned')!)).toEqual(['Fees'])
    // The tile in its own workspace says so too.
    expect(host.querySelector('[data-band="all"] [data-key="home.fees"] .lch-pinmark')).not.toBeNull()
    expect(host.querySelector('[role="menu"]'), 'the menu closed').toBeNull()

    // A fresh mount reads the same list back.
    act(() => root.unmount())
    root = createRoot(host)
    await render()
    expect(names(band('pinned')!)).toEqual(['Fees'])

    const again = host.querySelector<HTMLElement>('[data-band="all"] [data-key="home.fees"]')!
    await act(async () => { again.querySelector<HTMLButtonElement>('button.lch-more')!.click() })
    const unpin = again.querySelector<HTMLButtonElement>('[role="menuitem"]')!
    expect(unpin.textContent).toBe('bento.launcher.unpin')
    await act(async () => { unpin.click() })
    expect(JSON.parse(localStorage.getItem(PINS_KEY)!)).toEqual([])
    expect(band('pinned')).toBeNull()
  })

  it('a long press on a phone pins without opening the feature', async () => {
    vi.useFakeTimers()
    try {
      await render()
      const tile = host.querySelector<HTMLButtonElement>('[data-key="child.marks"] button.lch-app')!
      await act(async () => { tile.dispatchEvent(touch('touchstart', 40, 300)) })
      await act(async () => { vi.advanceTimersByTime(500) })
      await act(async () => { tile.dispatchEvent(touch('touchend', 40, 300)) })
      await act(async () => { tile.click() })
      expect(navigate).not.toHaveBeenCalled()
      expect(JSON.parse(localStorage.getItem(PINS_KEY)!)).toEqual(['child.marks'])
      expect(host.querySelector('[role="status"]')!.textContent).toBe('bento.launcher.pinned_note[Marks & Grades]')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a pin to a feature the account can no longer open is not drawn', async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify(['gone.feature', 'home.today']))
    reloadPins()
    await render()
    expect(names(band('pinned')!)).toEqual(['Today'])
  })

  it('the pure helpers are pure', () => {
    expect(withPin([], 'a')).toEqual(['a'])
    expect(withPin(['a'], 'a')).toEqual(['a'])
    expect(toggled(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggled(['a'], 'b')).toEqual(['a', 'b'])
    const full = Array.from({ length: PINS_LIMIT }, (_, i) => `k${i}`)
    expect(withPin(full, 'extra')).toEqual(full)
    expect(parsePins(null)).toEqual([])
    expect(parsePins('not json')).toEqual([])
    expect(parsePins(JSON.stringify(['a', 1, 'a', '', 'b']))).toEqual(['a', 'b'])
  })
})

describe('BentoLauncher keyboard', () => {
  it('arrows walk the tiles, Enter opens, Escape closes', async () => {
    await render()
    expect(host.querySelector('[data-cursor="true"]')!.closest<HTMLElement>('.lch-cell')!.dataset.key).toBe('home.today')
    await key('ArrowRight')
    expect(host.querySelector('[data-cursor="true"]')!.closest<HTMLElement>('.lch-cell')!.dataset.key).toBe('home.fees')
    await key('ArrowLeft')
    await key('ArrowLeft')
    // Wraps to the last tile.
    expect(host.querySelector('[data-cursor="true"]')!.closest<HTMLElement>('.lch-cell')!.dataset.key).toBe('child.marks')
    await key('Enter')
    expect(navigate).toHaveBeenCalledWith('/parent/child/marks')
    expect(onClose).toHaveBeenCalled()

    onClose.mockReset()
    await key('Escape')
    // Escape closes through the history entry the open pushed (see
    // useOverlayHistory), so onClose arrives on the popstate task.
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('left and right in a field with text belong to the caret', async () => {
    await render()
    const input = host.querySelector<HTMLInputElement>('input')!
    await type(input, 'fee')
    const before = host.querySelector('[data-cursor="true"]')!.closest<HTMLElement>('.lch-cell')!.dataset.key
    await key('ArrowRight', input)
    expect(host.querySelector('[data-cursor="true"]')!.closest<HTMLElement>('.lch-cell')!.dataset.key).toBe(before)
    await key('ArrowDown', input)
    expect(host.querySelector('[data-cursor="true"]')!.closest<HTMLElement>('.lch-cell')!.dataset.key).not.toBe(before)
  })
})

/* ── no source names a colour ───────────────────────────────────────────── */

describe('the launcher names no colour', () => {
  const files = ['src/features/bento/BentoLauncher.tsx', 'src/features/bento/launcher.css']
  for (const file of files) {
    const source = code(readFileSync(resolve(process.cwd(), file), 'utf8'))
    it(`${file} contains no hex literal`, () => {
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    })
    it(`${file} contains no rgb() or hsl() literal`, () => {
      // `hsl(from var(--x) …)` is the relative-colour syntax that derives an
      // ink from a token; it names no colour of its own.
      expect(source).not.toMatch(/\b(rgba?|hsla?)\s*\((?!from\b)/)
    })
  }
  it('the stylesheet states every strength through currentColor mixes', () => {
    const css = code(readFileSync(resolve(process.cwd(), files[1]), 'utf8'))
    expect(css).toMatch(/color-mix\(in srgb, currentColor/)
  })
  it('the sheet moves in 200ms, by transform and opacity', () => {
    const tsx = code(readFileSync(resolve(process.cwd(), files[0]), 'utf8'))
    expect(tsx).toMatch(/const MOTION_MS = 200/)
    expect(tsx).toMatch(/transform \$\{MOTION_MS\}ms .*?, opacity \$\{MOTION_MS\}ms/)
  })
})
