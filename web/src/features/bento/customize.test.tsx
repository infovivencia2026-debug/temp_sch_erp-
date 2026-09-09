import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* CUSTOMIZE MODE, AS A KEYBOARD AND A SCREEN READER MEET IT.

   The old desk editor showed its size picker on hover, which meant a
   touchscreen never saw it and a test could not reach it without faking a
   pointer. The one mode that replaced it promises every control is simply
   THERE while the mode is on: a remove button and a size pill on each card,
   a toolbar at the foot of the screen, and Escape as the way out. These
   tests hold it to that, through the DOM and the store rather than through
   any component internals.

   Rendered with react-dom/client and `act`, like the launcher test, because
   the layer is all effects: cards declare themselves after mount, the layer
   packs them on the render after that, and the mode is a global the board
   subscribes to. A static render would show none of it.

   No component is declared inside a render function or inside a test body —
   `Board` is at module level — for the reason the launcher test records: a
   component type that changes every render is remounted every render. */

vi.mock('@/lib/i18n', () => ({
  useT: () => (k: string, vars?: Record<string, string | number>) =>
    vars && 'label' in vars ? `${k}:${vars.label}` : k,
}))

/* `useReduceMotion` reads the account through react-query, which the add
   gallery calls on every render whether or not it is open; the layer keeps
   the gallery mounted while the mode is on. Everything else in the kit —
   the span classes the layer sizes cards with — stays real. */
vi.mock('./bento-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bento-kit')>()),
  useReduceMotion: () => true,
}))

/* The colour wheel paints a canvas; jsdom has no 2D context. The rest of
   ColourDialog — the page-ink constant the chrome reads — stays real. */
vi.mock('./ColourDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ColourDialog')>()),
  WheelCanvas: () => <div data-wheel="" />,
}))

import { WidgetLayer, Widget } from './WidgetLayer'
import { setArranging, dropIndex } from '@/lib/widgets'
import type { WidgetSize } from '@/lib/widgets'
import type { CellSpan } from './bento-kit'

/* A fresh dashboard name per test. The widgets store keeps an in-memory
   cache per dashboard that never re-reads localStorage, so clearing storage
   between tests would not clear a removal made by the test before. */
let n = 0
let dashboard = ''

/* Seven cards on a five-by-three board: six Medium (2x1) and one Small.

   Two Mediums fill four of a row's five columns, so six of them take all
   three rows and leave one spare column per row; the Small takes one of
   those cells. Every card fits — and the Small can be nothing bigger, since
   any wider shape has no row to go to, which is what the size-menu test
   needs: one tier enabled, three marked as not fitting. */
const CARDS: { id: string; size: WidgetSize }[] = [
  ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, size: 'medium' as const })),
  { id: 'g', size: 'small' },
]

function Board({ dashboard }: { dashboard: string }) {
  return (
    <div className="bento-board">
      <WidgetLayer dashboard={dashboard}>
        {CARDS.map((c, i) => (
          <Widget key={c.id} id={c.id} label={`Card ${c.id.toUpperCase()}`} size={c.size} index={i}>
            {(span: CellSpan) => (
              <a href={`#${c.id}`} className="bento-cell" data-span={span}>
                {c.id}
              </a>
            )}
          </Widget>
        ))}
      </WidgetLayer>
    </div>
  )
}

/* THE SAME BOARD WITH A RENDER COUNTER inside card A's content: what a
   cell's queries and charts would be. A drag must not touch it. */
let probeRenders = 0
function Probe() {
  probeRenders++
  return <span>probe</span>
}
function ProbeBoard({ dashboard }: { dashboard: string }) {
  return (
    <div className="bento-board">
      <WidgetLayer dashboard={dashboard}>
        {CARDS.map((c, i) => (
          <Widget key={c.id} id={c.id} label={`Card ${c.id.toUpperCase()}`} size={c.size} index={i}>
            {(span: CellSpan) => (
              <a href={`#${c.id}`} className="bento-cell" data-span={span}>
                {c.id === 'a' ? <Probe /> : c.id}
              </a>
            )}
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
    placed: { id: string; w: number; h: number; tint?: { h: number; s: number; l: number } }[]
    removed: string[]
  }

/* One animation frame, inside act: the mode's first focus, a drag's paint
   and the focus after a removal all land on a frame. */
const frame = () =>
  act(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
  })

const key = (k: string) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

/* Mounted, in the mode, and past the frame on which the mode puts its
   first focus on Done — so no test races that frame with its own focus. */
async function mount(board: 'plain' | 'probe' = 'plain') {
  await act(async () => {
    root.render(board === 'probe' ? <ProbeBoard dashboard={dashboard} /> : <Board dashboard={dashboard} />)
  })
  await act(async () => {
    setArranging(true)
  })
  await frame()
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  dashboard = `customize-test-${++n}`
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

describe('customize mode', () => {
  it('puts a remove button and a size pill on every card, without hover', async () => {
    await mount()

    const cards = host.querySelectorAll('.bento-widget[data-editing]')
    expect(cards.length, 'every card is in the mode').toBe(CARDS.length)
    expect(host.querySelectorAll('.bento-edit__remove').length).toBe(CARDS.length)
    expect(host.querySelectorAll('.bento-sizebtn').length).toBe(CARDS.length)

    const remove = host.querySelector<HTMLButtonElement>('.bento-widget[data-widget-id="a"] .bento-edit__remove')
    expect(remove?.getAttribute('aria-label')).toBe('bento.widgets.remove_card:Card A')

    // The card's own content is still drawn but is neither a link nor a tab
    // stop while the controls sit over it.
    const content = host.querySelector('.bento-widget[data-widget-id="a"] > :first-child')
    expect(content?.hasAttribute('inert')).toBe(true)
    expect(content?.querySelector('a')).not.toBeNull()

    // The bar is the only chrome, and it says what it is.
    const bar = document.querySelector('[role="toolbar"]')
    expect(bar?.getAttribute('aria-label')).toBe('bento.widgets.customize')
    expect(document.querySelector('.bento-sheet-backdrop'), 'no backdrop in this mode').toBeNull()

    // Announced once, a beat after the bar mounts.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120))
    })
    expect(bar?.querySelector('[role="status"]')?.textContent).toBe('bento.widgets.announce')
  })

  it('the remove button takes the card off the board through the store', async () => {
    await mount()
    const remove = host.querySelector<HTMLButtonElement>('.bento-widget[data-widget-id="c"] .bento-edit__remove')
    await act(async () => {
      remove!.click()
    })
    expect(host.querySelector('.bento-widget[data-widget-id="c"]')).toBeNull()
    expect(stored().removed).toContain('c')
    expect(host.querySelectorAll('.bento-widget').length).toBe(CARDS.length - 1)
  })

  it('the size menu lists the three tiers and marks the ones that will not fit', async () => {
    await mount()
    const pill = host.querySelector<HTMLButtonElement>('.bento-widget[data-widget-id="g"] .bento-sizebtn')
    expect(pill?.getAttribute('aria-haspopup')).toBe('menu')
    await act(async () => {
      pill!.click()
    })
    const menu = document.querySelector('[data-bento-menu]')
    expect(menu, 'the menu opened').not.toBeNull()
    const tiers = Array.from(menu!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    expect(tiers.map((b) => b.textContent)).toEqual([
      'bento.size.small', 'bento.size.medium', 'bento.size.large',
    ])
    expect(tiers.map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    expect(tiers.map((b) => b.disabled), 'only the size it already is fits').toEqual([false, true, true])
    // The colour wheel is reachable from the last row.
    const rows = Array.from(menu!.querySelectorAll('[role^="menuitem"]'))
    expect(rows[rows.length - 1].textContent).toBe('bento.widgets.colour_row')
  })

  it('choosing a tier writes that footprint to the store and closes the menu', async () => {
    await mount()
    const pill = host.querySelector<HTMLButtonElement>('.bento-widget[data-widget-id="a"] .bento-sizebtn')
    await act(async () => {
      pill!.click()
    })
    const tiers = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-bento-menu] [role="menuitemradio"]'))
    // A Medium card: Small always fits and Large (2x2) pushes the last Medium
    // off the board.
    expect(tiers.map((b) => b.disabled)).toEqual([false, false, true])
    await act(async () => {
      tiers[0].click()
    })
    expect(document.querySelector('[data-bento-menu]')).toBeNull()
    expect(stored().placed.find((p) => p.id === 'a')).toMatchObject({ w: 1, h: 1 })
    expect(host.querySelector('.bento-widget[data-widget-id="a"]')?.getAttribute('data-w')).toBe('1')
  })

  it('Escape leaves the mode, and the controls go with it', async () => {
    await mount()
    expect(host.querySelectorAll('.bento-edit__remove').length).toBe(CARDS.length)
    await act(async () => {
      key('Escape')
    })
    expect(host.querySelectorAll('.bento-edit__remove').length).toBe(0)
    expect(host.querySelectorAll('.bento-widget[data-editing]').length).toBe(0)
    expect(document.querySelector('[role="toolbar"]')).toBeNull()
    // The cards are cards again.
    expect(host.querySelector('.bento-widget[data-widget-id="a"] > :first-child')?.hasAttribute('inert')).toBe(false)
  })

  it('Escape inside an open size menu closes the menu, not the mode', async () => {
    await mount()
    const pill = host.querySelector<HTMLButtonElement>('.bento-widget[data-widget-id="b"] .bento-sizebtn')
    await act(async () => {
      pill!.click()
    })
    expect(document.querySelector('[data-bento-menu]')).not.toBeNull()
    await act(async () => {
      key('Escape')
    })
    expect(document.querySelector('[data-bento-menu]')).toBeNull()
    expect(document.querySelector('[role="toolbar"]'), 'still customizing').not.toBeNull()
    expect(host.querySelectorAll('.bento-edit__remove').length).toBe(CARDS.length)
  })
})

/* KEYBOARD MOVES. With a card's remove button or size pill focused, Alt
   (or Cmd) with an arrow moves the card; a bare arrow moves focus to the
   neighbouring card's same control; Delete removes and lands on Undo. */
const press = (el: Element, k: string, mods: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }))

const pill = (id: string) =>
  host.querySelector<HTMLButtonElement>(`.bento-widget[data-widget-id="${id}"] .bento-sizebtn`)!

const status = () => document.querySelector('[role="toolbar"] [role="status"]')?.textContent?.trim()

describe('keyboard moves in customize mode', () => {
  it('Alt+Arrow moves the card and says so; Cmd does the same', async () => {
    await mount()
    pill('a').focus()
    await act(async () => {
      press(pill('a'), 'ArrowRight', { altKey: true })
    })
    expect(stored().placed.map((p) => p.id)).toEqual(['b', 'a', 'c', 'd', 'e', 'f', 'g'])
    // Every untouched card was seeded at its own size: a move is not a resize.
    expect(stored().placed.find((p) => p.id === 'g')).toMatchObject({ w: 1, h: 1 })
    expect(status()).toBe('bento.widgets.moved_to:Card A')
    // The card's own control keeps the keyboard.
    expect(document.activeElement).toBe(pill('a'))

    await act(async () => {
      press(pill('a'), 'ArrowLeft', { metaKey: true })
    })
    expect(stored().placed.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    // Earlier than first goes nowhere.
    await act(async () => {
      press(pill('a'), 'ArrowUp', { altKey: true })
    })
    expect(stored().placed.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  })

  it('a bare arrow moves focus to the same control on the next card', async () => {
    await mount()
    pill('b').focus()
    await act(async () => {
      press(pill('b'), 'ArrowRight')
    })
    expect(document.activeElement).toBe(pill('c'))
    expect(stored().placed, 'nothing moved').toEqual([])
    const remove = host.querySelector<HTMLButtonElement>('.bento-widget[data-widget-id="c"] .bento-edit__remove')!
    remove.focus()
    await act(async () => {
      press(remove, 'ArrowUp')
    })
    expect(document.activeElement).toBe(
      host.querySelector('.bento-widget[data-widget-id="b"] .bento-edit__remove'),
    )
  })

  it('Delete removes the card and puts the keyboard on Undo', async () => {
    await mount()
    pill('d').focus()
    await act(async () => {
      press(pill('d'), 'Delete')
    })
    expect(host.querySelector('.bento-widget[data-widget-id="d"]')).toBeNull()
    expect(stored().removed).toContain('d')
    expect(status()).toBe('bento.widgets.removed_card:Card D')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60))
    })
    const undo = document.querySelector<HTMLButtonElement>('.bento-bar__undo')!
    expect(undo.disabled).toBe(false)
    expect(document.activeElement).toBe(undo)
    await act(async () => {
      undo.click()
    })
    expect(host.querySelector('.bento-widget[data-widget-id="d"]'), 'undone').not.toBeNull()
  })

  it('arrows inside an open size menu belong to the menu', async () => {
    await mount()
    await act(async () => {
      pill('a').click()
    })
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-bento-menu] [role^="menuitem"]:not(:disabled)'))
    expect(document.activeElement).toBe(items[0])
    await act(async () => {
      press(items[0], 'ArrowDown')
    })
    expect(document.activeElement).toBe(items[1])
    expect(stored().placed, 'nothing moved').toEqual([])
  })
})

/* THE DRAG, THE WHEEL, THE BAR AND THE EMPTY BOARD: the desk review's
   fixes, each held to what it promised. */
const pointer = (el: Element, type: string, x: number, y: number) =>
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true, cancelable: true, isPrimary: true, pointerId: 1, pointerType: 'mouse',
      button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y,
    }),
  )

const removeOf = (id: string) =>
  host.querySelector<HTMLButtonElement>(`.bento-widget[data-widget-id="${id}"] .bento-edit__remove`)!

const colourRow = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[data-bento-menu] [role="menuitem"]')).find(
    (b) => b.textContent === 'bento.widgets.colour_row',
  )!

describe('dragging a card', () => {
  it('carries the card without re-rendering its content, and leaves no trace on release', async () => {
    await mount('probe')
    const wrap = host.querySelector<HTMLElement>('.bento-widget[data-widget-id="a"]')!
    const surface = wrap.querySelector<HTMLElement>('.bento-edit')!
    const board = host.querySelector<HTMLElement>('.bento-board')!
    const before = probeRenders
    expect(before).toBeGreaterThan(0)

    await act(async () => {
      pointer(surface, 'pointerdown', 20, 20)
    })
    // A press is not yet a drag: nothing on the card or the board says so.
    expect(wrap.hasAttribute('data-dragging')).toBe(false)
    expect(board.hasAttribute('data-dragging')).toBe(false)
    for (let i = 1; i <= 30; i++) {
      await act(async () => {
        pointer(surface, 'pointermove', 20 + i * 4, 20 + i * 3)
      })
    }
    await frame()
    expect(probeRenders, 'no render of the content during thirty moves').toBe(before)
    // The ghost is a transform on the wrapper and an attribute on both.
    expect(wrap.hasAttribute('data-dragging')).toBe(true)
    expect(board.hasAttribute('data-dragging')).toBe(true)
    expect(wrap.style.transform).toBe('translate3d(120px, 90px, 0)')
    expect(wrap.style.zIndex).toBe('40')

    await act(async () => {
      pointer(surface, 'pointerup', 140, 110)
    })
    expect(wrap.hasAttribute('data-dragging')).toBe(false)
    expect(board.hasAttribute('data-dragging')).toBe(false)
    expect(wrap.style.transform).toBe('')
    expect(wrap.style.zIndex).toBe('')
    // jsdom lays nothing out, so nothing was under the pointer: no move,
    // and still no render.
    expect(stored().placed).toEqual([])
    expect(probeRenders).toBe(before)
  })

  it('dropIndex lands on the target from either side, and after it when asked', () => {
    expect(dropIndex(0, 3, false)).toBe(3)
    expect(dropIndex(5, 3, false)).toBe(3)
    // From earlier, the splice has already moved the target up one: inserting
    // at its index IS after it. From later it needs the extra one.
    expect(dropIndex(0, 3, true)).toBe(3)
    expect(dropIndex(5, 3, true)).toBe(4)
  })
})

describe('the colour wheel', () => {
  it('Escape peels one layer: the wheel, then the menu, then the mode', async () => {
    await mount()
    await act(async () => {
      pill('a').click()
    })
    await act(async () => {
      colourRow().click()
    })
    expect(document.querySelector('[data-colour-pop]'), 'the wheel opened').not.toBeNull()
    await act(async () => {
      key('Escape')
    })
    expect(document.querySelector('[data-colour-pop]'), 'the wheel closed').toBeNull()
    expect(document.querySelector('[data-bento-menu]'), 'the menu stayed').not.toBeNull()
    await act(async () => {
      key('Escape')
    })
    expect(document.querySelector('[data-bento-menu]')).toBeNull()
    expect(document.querySelector('[role="toolbar"]'), 'still in the mode').not.toBeNull()
    await act(async () => {
      key('Escape')
    })
    expect(document.querySelector('[role="toolbar"]')).toBeNull()
  })

  it('a drag on the lightness slider is one undo step', async () => {
    await mount()
    await act(async () => {
      pill('a').click()
    })
    await act(async () => {
      colourRow().click()
    })
    const range = document.querySelector<HTMLInputElement>('[data-colour-pop] input[type="range"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const slide = (v: number) => {
      setter.call(range, String(v))
      range.dispatchEvent(new Event('input', { bubbles: true }))
    }
    for (const v of [30, 40, 55]) {
      await act(async () => {
        slide(v)
      })
    }
    expect(stored().placed.find((p) => p.id === 'a')?.tint?.l).toBe(55)
    const undo = document.querySelector<HTMLButtonElement>('.bento-bar__undo')!
    expect(undo.disabled).toBe(false)
    await act(async () => {
      undo.click()
    })
    expect(stored().placed.find((p) => p.id === 'a'), 'back to before the drag, not one sample').toBeUndefined()
    expect(undo.disabled, 'one step, and it is spent').toBe(true)
  })
})

describe('the toolbar', () => {
  it('arrow keys walk its enabled buttons, wrapping; Home and End jump', async () => {
    await mount()
    const bar = document.querySelector<HTMLElement>('[role="toolbar"]')!
    const btns = Array.from(bar.querySelectorAll<HTMLButtonElement>('.bento-bar__btn:not(:disabled)'))
    expect(btns.length).toBeGreaterThan(2)
    btns[0].focus()
    await act(async () => {
      press(btns[0], 'ArrowRight')
    })
    expect(document.activeElement).toBe(btns[1])
    await act(async () => {
      press(btns[1], 'ArrowLeft')
    })
    expect(document.activeElement).toBe(btns[0])
    await act(async () => {
      press(btns[0], 'ArrowLeft')
    })
    expect(document.activeElement, 'wraps').toBe(btns[btns.length - 1])
    await act(async () => {
      press(btns[btns.length - 1], 'Home')
    })
    expect(document.activeElement).toBe(btns[0])
    await act(async () => {
      press(btns[0], 'End')
    })
    expect(document.activeElement).toBe(btns[btns.length - 1])
  })

  it('says reduce-motion on the board when the account asks for it', async () => {
    await mount()
    expect(host.querySelector('.bento-board')!.hasAttribute('data-reduce-motion')).toBe(true)
  })
})

describe('removing with the pointer', () => {
  it('moves focus to the next card\'s remove button; the last removal lands on Done and shows the empty board', async () => {
    await mount()
    await act(async () => {
      removeOf('a').click()
    })
    await frame()
    expect(document.activeElement).toBe(removeOf('b'))
    expect(status()).toBe('bento.widgets.removed_card:Card A')

    for (const id of ['b', 'c', 'd', 'e', 'f', 'g']) {
      await act(async () => {
        removeOf(id).click()
      })
      await frame()
    }
    expect(host.querySelectorAll('.bento-widget').length).toBe(0)
    const done = document.querySelector<HTMLButtonElement>('[role="toolbar"] .bento-bar__btn.is-primary')!
    expect(document.activeElement).toBe(done)

    const hint = host.querySelector<HTMLElement>('[data-board-empty]')
    expect(hint, 'the board says it is empty').not.toBeNull()
    expect(hint!.textContent).toContain('bento.widgets.empty_board')
    const [addCards, resetLayout] = Array.from(hint!.querySelectorAll<HTMLButtonElement>('button'))
    expect(addCards.textContent).toContain('bento.widgets.add_cards')
    expect(addCards.disabled).toBe(false)
    await act(async () => {
      addCards.click()
    })
    expect(document.querySelector('[data-add-gallery]'), 'Add cards opens the gallery').not.toBeNull()
    expect(resetLayout.textContent).toContain('bento.widgets.reset')
    await act(async () => {
      resetLayout.click()
    })
    expect(host.querySelectorAll('.bento-widget').length, 'Reset brings every card back').toBe(CARDS.length)
    expect(host.querySelector('[data-board-empty]')).toBeNull()
  })
})

describe('the add gallery', () => {
  it('Add on a card that is placed but fell off the board resizes it and puts it last', async () => {
    // Five Mediums, the Small, then A as Large (2x2): fifteen slots hold the
    // first six and A needs two rows nobody has, so it is placed yet not drawn.
    localStorage.setItem(
      `erp.widgets.${dashboard}`,
      JSON.stringify({
        placed: [
          ...['b', 'c', 'd', 'e', 'f'].map((id) => ({ id, w: 2, h: 1 })),
          { id: 'g', w: 1, h: 1 },
          { id: 'a', w: 2, h: 2 },
        ],
        removed: [],
      }),
    )
    await mount()
    expect(host.querySelector('.bento-widget[data-widget-id="a"]'), 'A fell off').toBeNull()
    const add = document.querySelector<HTMLButtonElement>('[role="toolbar"] button[aria-haspopup="dialog"]')!
    expect(add.disabled).toBe(false)
    await act(async () => {
      add.click()
    })
    const small = document.querySelector<HTMLButtonElement>('[data-gallery-tile="a"] button[data-tier="small"]')!
    expect(small.disabled).toBe(false)
    await act(async () => {
      small.click()
    })
    expect(stored().placed.map((p) => p.id)).toEqual(['b', 'c', 'd', 'e', 'f', 'g', 'a'])
    expect(stored().placed.find((p) => p.id === 'a')).toMatchObject({ w: 1, h: 1 })
    expect(host.querySelector('.bento-widget[data-widget-id="a"]'), 'A is drawn again').not.toBeNull()
    // One write: one undo.
    const undo = document.querySelector<HTMLButtonElement>('.bento-bar__undo')!
    await act(async () => {
      undo.click()
    })
    expect(stored().placed.find((p) => p.id === 'a')).toMatchObject({ w: 2, h: 2 })
    expect(host.querySelector('.bento-widget[data-widget-id="a"]')).toBeNull()
  })
})
