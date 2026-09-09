import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* THE "…" ON EVERY CARD, outside customize mode.

   The quick menu promises that the things people do most to one card — open
   it, resize it, recolour it, hide it, or start arranging from it — are one
   press away without entering the mode. These tests reach the control the
   way a keyboard does, and check its rows act through the store, the same
   store the mode writes.

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
  it('every card has a "…" after its link, named for the card, that opens the five rows', async () => {
    await mount()
    expect(host.querySelectorAll('.bento-widget > .bento-more').length).toBe(CARDS.length)
    expect(host.querySelectorAll('.bento-widget[data-more]').length).toBe(CARDS.length)

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
      'bento.size.small', 'bento.size.medium', 'bento.size.large',
    ])
    expect(tiers.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
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
    // A Medium card among Mediums: Large (2x2) would push one off the board.
    expect(tiers.map((b) => b.disabled)).toEqual([false, false, true])
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
