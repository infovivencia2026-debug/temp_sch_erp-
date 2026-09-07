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

import { WidgetLayer, Widget } from './WidgetLayer'
import { setArranging } from '@/lib/widgets'
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

let host: HTMLDivElement
let root: Root

const stored = () =>
  JSON.parse(localStorage.getItem(`erp.widgets.${dashboard}`) ?? '{"placed":[],"removed":[]}') as {
    placed: { id: string; w: number; h: number }[]
    removed: string[]
  }

const key = (k: string) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

async function mount() {
  await act(async () => {
    root.render(<Board dashboard={dashboard} />)
  })
  await act(async () => {
    setArranging(true)
  })
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

  it('the size menu lists the four tiers and marks the ones that will not fit', async () => {
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
      'bento.size.small', 'bento.size.medium', 'bento.size.large', 'bento.size.wide',
    ])
    expect(tiers.map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false'])
    expect(tiers.map((b) => b.disabled), 'only the size it already is fits').toEqual([false, true, true, true])
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
    // A Medium card: Small always fits, Wide (3x1) still packs, Large (2x2)
    // pushes the last Medium off the board.
    expect(tiers.map((b) => b.disabled)).toEqual([false, false, true, false])
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
