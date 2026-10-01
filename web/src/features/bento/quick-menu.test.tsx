import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* THE CARD'S MENU, outside customize mode -- with no "…" drawn.

   The quick menu promises that the things people do most to one card — open
   it, resize it, recolour it, hide it, or start arranging from it — are one
   gesture away without entering the mode: a hold on touch, a right-click
   with a mouse, Shift+F10 or the Menu key from the keyboard, and a "More
   options" button that is in the tab order but painted only when focused.
   These tests reach it each of those ways, and check its rows act through
   the store, the same store the mode writes.

   Same harness as customize.test.tsx: react-dom/client and `act`, a fresh
   dashboard per test, `Board` declared at module level. */

vi.mock('@/lib/i18n', () => ({
  useT: () => (k: string, vars?: Record<string, string | number>) =>
    vars && 'label' in vars ? `${k}:${vars.label}` : k,
}))

vi.mock('./bento-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bento-kit')>()),
  useReduceMotion: () => true,
}))

import { WidgetLayer, Widget } from './WidgetLayer'
import { setArranging } from '@/lib/widgets'
import type { WidgetSize } from '@/lib/widgets'
import type { CellSpan } from './bento-kit'

let n = 0
let dashboard = ''

const CARDS: { id: string; size: WidgetSize }[] = [
  ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, size: 'medium' as const })),
  { id: 'g', size: 'small' },
]

/* The last card has no link at all, to check the Open row is not offered
   for a card that leads nowhere. */
function Board({ dashboard }: { dashboard: string }) {
  return (
    <div className="bento-board">
      <WidgetLayer dashboard={dashboard}>
        {CARDS.map((c, i) => (
          <Widget key={c.id} id={c.id} label={`Card ${c.id.toUpperCase()}`} size={c.size} index={i}>
            {(span: CellSpan) =>
              c.id === 'g' ? (
                <div className="bento-cell" data-span={span}>{c.id}</div>
              ) : (
                <a href={`#${c.id}`} className="bento-cell" data-span={span}>{c.id}</a>
              )
            }
          </Widget>
        ))}
      </WidgetLayer>
    </div>
  )
}

let host: HTMLDivElement
let root: Root

const stored = () =>
  JSON.parse(localStorage.getItem(`erp.widgets.${dashboard}`) ?? '{"placed":[],"removed":[]}') as {
    placed: { id: string; w: number; h: number }[]
    removed: string[]
  }

const key = (k: string) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

const more = (id: string) =>
  host.querySelector<HTMLButtonElement>(`.bento-widget[data-widget-id="${id}"] > .bento-more`)

const card = (id: string) => host.querySelector<HTMLElement>(`.bento-widget[data-widget-id="${id}"]`)!

const touch = (el: Element, type: string, x: number, y: number) =>
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true, cancelable: true, isPrimary: true, pointerId: 1, pointerType: 'touch',
      button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y,
    }),
  )

const menu = () => document.querySelector<HTMLElement>('[data-bento-menu]')

async function mount() {
  await act(async () => {
    root.render(<Board dashboard={dashboard} />)
  })
}

async function openMenu(id: string) {
  await act(async () => {
    more(id)!.click()
  })
  const m = menu()
  expect(m, 'the menu opened').not.toBeNull()
  return m!
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  dashboard = `quick-menu-test-${++n}`
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => {
    setArranging(false)
  })
  act(() => root.unmount())
  host.remove()
})

describe('quick menu', () => {
  it('every card has a "More options" button after its link, named for the card, that opens the five rows', async () => {
    await mount()
    expect(host.querySelectorAll('.bento-widget > .bento-more').length).toBe(CARDS.length)
    expect(host.querySelectorAll('.bento-widget[data-more]').length).toBe(CARDS.length)
    // One corner control a card: no capsule, no second arrow beside the card's own.
    expect(host.querySelectorAll('.bento-capsule, .bento-capsule__open').length).toBe(0)

    const btn = more('a')!
    expect(btn.getAttribute('aria-label')).toBe('bento.widgets.more_for:Card A')
    expect(btn.getAttribute('aria-haspopup')).toBe('menu')
    // Tab reaches the "…" after the card's link.
    const link = host.querySelector('.bento-widget[data-widget-id="a"] a')!
    expect(link.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const m = await openMenu('a')
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(m.getAttribute('aria-label')).toBe('bento.widgets.more_for:Card A')
    const items = Array.from(m.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    expect(items.map((b) => b.textContent)).toEqual([
      'bento.widgets.open', 'bento.widgets.customize', 'bento.widgets.colour_row', 'bento.widgets.hide',
    ])
    const tiers = Array.from(m.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    expect(tiers.map((b) => b.textContent)).toEqual([
      'bento.size.small', 'bento.size.tall', 'bento.size.medium', 'bento.size.large',
    ])
    expect(tiers.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false'])
    // Focus went in, to the first row.
    expect(document.activeElement).toBe(items[0])
  })

  it('offers no Open row on a card that leads nowhere', async () => {
    await mount()
    const m = await openMenu('g')
    const items = Array.from(m.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    expect(items.map((b) => b.textContent)).toEqual([
      'bento.widgets.customize', 'bento.widgets.colour_row', 'bento.widgets.hide',
    ])
  })

  it('Open follows the card link', async () => {
    await mount()
    const link = host.querySelector<HTMLAnchorElement>('.bento-widget[data-widget-id="b"] a')!
    let clicks = 0
    link.addEventListener('click', (e) => {
      e.preventDefault()
      clicks++
    })
    const m = await openMenu('b')
    await act(async () => {
      m.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click()
    })
    expect(clicks).toBe(1)
    expect(menu()).toBeNull()
  })

  it('Hide takes the card off the board through the store', async () => {
    await mount()
    const m = await openMenu('c')
    const rows = Array.from(m.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    await act(async () => {
      rows[rows.length - 1].click()
    })
    expect(menu()).toBeNull()
    expect(host.querySelector('.bento-widget[data-widget-id="c"]')).toBeNull()
    expect(stored().removed).toContain('c')
    expect(host.querySelectorAll('.bento-widget').length).toBe(CARDS.length - 1)
  })

  it('a Size row sets the tier without entering the mode', async () => {
    await mount()
    const m = await openMenu('a')
    const tiers = Array.from(m.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    // A Medium card among Mediums: Small, Tall (1x2) and Medium fit -- there
    // are two free cells stacked in the last column -- but Large (2x2) would
    // push one off the board.
    expect(tiers.map((b) => b.disabled)).toEqual([false, false, false, true])
    await act(async () => {
      tiers[0].click()
    })
    expect(menu()).toBeNull()
    expect(stored().placed.find((p) => p.id === 'a')).toMatchObject({ w: 1, h: 1 })
    expect(host.querySelector('.bento-widget[data-widget-id="a"]')?.getAttribute('data-w')).toBe('1')
    expect(document.querySelector('[role="toolbar"]'), 'not customizing').toBeNull()
    expect(host.querySelectorAll('.bento-widget[data-editing]').length).toBe(0)
  })

  it('Escape closes the menu and hands focus back to the "…"', async () => {
    await mount()
    await openMenu('d')
    await act(async () => {
      key('Escape')
    })
    expect(menu()).toBeNull()
    expect(more('d')!.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(more('d'))
  })

  it('Customize enters the mode with this card\'s size pill focused', async () => {
    await mount()
    const m = await openMenu('e')
    await act(async () => {
      m.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1].click()
    })
    expect(menu()).toBeNull()
    expect(document.querySelector('[role="toolbar"]')).not.toBeNull()
    // The "…" is the mode's job now: gone while the controls are on.
    expect(host.querySelectorAll('.bento-more').length).toBe(0)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60))
    })
    expect(document.activeElement).toBe(
      host.querySelector('.bento-widget[data-widget-id="e"] .bento-sizebtn'),
    )
  })
})

/* THE GESTURES. No button is drawn for this menu, so these are the ways in
   that a person actually uses. */
describe('quick menu: hold, right-click, keyboard', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a right-click on a card opens its menu at the pointer, and does not enter the mode', async () => {
    await mount()
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0, button: 2 })
    await act(async () => {
      card('a').querySelector('a')!.dispatchEvent(ev)
    })
    expect(ev.defaultPrevented, 'the browser menu is replaced').toBe(true)
    const m = menu()
    expect(m, 'the menu opened').not.toBeNull()
    expect(m!.getAttribute('aria-label')).toBe('bento.widgets.more_for:Card A')
    expect(m!.hasAttribute('data-at-point'), 'placed at the press, not under a button').toBe(true)
    expect(m!.hasAttribute('data-sheet')).toBe(false)
    expect(document.querySelector('[role="toolbar"]'), 'not customizing').toBeNull()
  })

  it('a hold on a card opens its menu after 450ms; Customize in it enters the mode', async () => {
    await mount()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const link = card('b').querySelector('a')!
    await act(async () => {
      touch(link, 'pointerdown', 40, 40)
    })
    await act(async () => {
      vi.advanceTimersByTime(440)
    })
    expect(menu(), 'not before the hold is up').toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(20)
    })
    const m = menu()
    expect(m, 'the hold opened the menu').not.toBeNull()
    expect(m!.getAttribute('aria-label')).toBe('bento.widgets.more_for:Card B')
    expect(document.querySelector('[role="toolbar"]'), 'a hold on a card no longer enters the mode').toBeNull()

    // The click the lift produces is swallowed: the card does not open under its menu.
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => {
      touch(link, 'pointerup', 40, 40)
      link.dispatchEvent(click)
    })
    expect(click.defaultPrevented).toBe(true)
    expect(menu()).not.toBeNull()

    vi.useRealTimers()
    await act(async () => {
      Array.from(menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        .find((b) => b.textContent === 'bento.widgets.customize')!.click()
    })
    expect(document.querySelector('[role="toolbar"]'), 'Customize is the way into the mode').not.toBeNull()
  })

  it('a finger that moves more than 8px is a swipe, not a hold', async () => {
    await mount()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const link = card('c').querySelector('a')!
    await act(async () => {
      touch(link, 'pointerdown', 40, 40)
      touch(link, 'pointermove', 52, 40)
    })
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(menu()).toBeNull()
    expect(document.querySelector('[role="toolbar"]')).toBeNull()
  })

  it('a mouse press held on a card does nothing: the right button is its way in', async () => {
    await mount()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () => {
      card('c').querySelector('a')!.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 40,
      }))
    })
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(menu()).toBeNull()
  })

  it('a hold on empty board space still enters customize mode directly', async () => {
    await mount()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () => {
      touch(host.querySelector('.bento-board')!, 'pointerdown', 300, 500)
    })
    await act(async () => {
      vi.advanceTimersByTime(460)
    })
    expect(menu()).toBeNull()
    expect(document.querySelector('[role="toolbar"]')).not.toBeNull()
  })

  it('Shift+F10 and the Menu key open it from the keyboard, and Escape gives focus back', async () => {
    await mount()
    const link = card('d').querySelector<HTMLAnchorElement>('a')!
    link.focus()
    await act(async () => {
      link.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
    })
    expect(menu()?.getAttribute('aria-label')).toBe('bento.widgets.more_for:Card D')
    await act(async () => {
      key('Escape')
    })
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(link)
    await act(async () => {
      link.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }))
    })
    expect(menu()).not.toBeNull()
  })

  it('in customize mode a right-click opens nothing: the edit surface owns the card', async () => {
    await mount()
    await act(async () => {
      setArranging(true)
    })
    await act(async () => {
      card('a').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))
    })
    expect(menu()).toBeNull()
  })
})
