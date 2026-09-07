import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* THE COACH MARK, HELD TO ITS THREE PROMISES.

   It shows on a board nobody has arranged, it never shows again once seen
   out, and it never shows at all on a board somebody has already arranged.
   Everything below goes through the DOM and localStorage — the two things a
   person and the next session can see — and not through the component.

   Rendered with react-dom/client and `act`, as customize.test.tsx does and
   for the same reason: the coach subscribes to the board the layer publishes
   AFTER its cards have declared themselves, which is two effects deep. A
   static render would show a board with no cards and a coach with nothing
   to say. */

vi.mock('@/lib/i18n', () => ({
  useT: () => (k: string, vars?: Record<string, string | number>) =>
    vars && 'label' in vars ? `${k}:${vars.label}` : k,
}))

/* `useReduceMotion` reads the account through react-query and there is no
   client here; the still/moving distinction is a class, asserted below. */
vi.mock('./bento-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bento-kit')>()),
  useReduceMotion: () => true,
}))

import { WidgetLayer, Widget } from './WidgetLayer'
import CustomizeCoach, { COACH_MS, coachKey } from './CustomizeCoach'
import { setArranging } from '@/lib/widgets'
import type { WidgetSize } from '@/lib/widgets'
import type { CellSpan } from './bento-kit'

/* A fresh dashboard name per test: the widgets store caches per dashboard
   and never re-reads localStorage. */
let n = 0
let dashboard = ''

const CARDS: { id: string; size: WidgetSize }[] = [
  { id: 'a', size: 'medium' },
  { id: 'b', size: 'small' },
  { id: 'c', size: 'small' },
]

function Screen({ dashboard }: { dashboard: string }) {
  return (
    <>
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
      <CustomizeCoach />
    </>
  )
}

let host: HTMLDivElement
let root: Root

const coach = () => document.querySelector<HTMLElement>('.bento-coach')

async function mount() {
  await act(async () => {
    root.render(<Screen dashboard={dashboard} />)
  })
}

async function unmount() {
  await act(async () => {
    root.unmount()
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  dashboard = `coach-test-${++n}`
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => {
    setArranging(false)
  })
  await unmount()
  host.remove()
  vi.useRealTimers()
})

describe('the customize coach mark', () => {
  it('shows on a board that has never been arranged, once the board is up', async () => {
    await mount()
    const el = coach()
    expect(el).not.toBeNull()
    // jsdom has no matchMedia, so the viewport answers desktop: the callout
    // over the pill, worded for the pill, with no hand.
    expect(el!.classList.contains('is-desk')).toBe(true)
    expect(el!.textContent).toBe('bento.coach.desk')
    expect(el!.querySelector('.bento-coach__glyph')).toBeNull()
    // Reduced motion (mocked on) is a class the stylesheet reads.
    expect(el!.classList.contains('is-still')).toBe(true)
    // Nothing is remembered until it is seen out.
    expect(localStorage.getItem(coachKey(dashboard))).toBeNull()
  })

  it('goes away on tap, and does not come back on the next visit', async () => {
    await mount()
    expect(coach()).not.toBeNull()
    await act(async () => {
      coach()!.querySelector<HTMLButtonElement>('.bento-coach__body')!.click()
    })
    expect(coach()).toBeNull()
    expect(localStorage.getItem(coachKey(dashboard))).not.toBeNull()

    await unmount()
    root = createRoot(host)
    await mount()
    expect(coach()).toBeNull()
  })

  it('does not show on a board somebody has arranged', async () => {
    localStorage.setItem(
      `erp.widgets.${dashboard}`,
      JSON.stringify({ placed: [{ id: 'a', w: 1, h: 1 }], removed: [] }),
    )
    await mount()
    expect(coach()).toBeNull()
    // And it did not quietly mark itself as shown either.
    expect(localStorage.getItem(coachKey(dashboard))).toBeNull()
  })

  it('is dismissed by entering the mode — the lesson was learnt', async () => {
    await mount()
    expect(coach()).not.toBeNull()
    await act(async () => {
      setArranging(true)
    })
    expect(coach()).toBeNull()
    expect(localStorage.getItem(coachKey(dashboard))).not.toBeNull()
    // Leaving the mode does not bring it back.
    await act(async () => {
      setArranging(false)
    })
    expect(coach()).toBeNull()
  })

  it('goes away by itself after eight seconds', async () => {
    // Only the timer the coach uses is faked: React's scheduler must keep its
    // own channels or `act` cannot flush.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await mount()
    expect(coach()).not.toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(COACH_MS - 1)
    })
    expect(coach()).not.toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(coach()).toBeNull()
    expect(localStorage.getItem(coachKey(dashboard))).not.toBeNull()
  })

  it('is dismissed by Escape', async () => {
    await mount()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(coach()).toBeNull()
    expect(localStorage.getItem(coachKey(dashboard))).not.toBeNull()
  })

  it('waits while something else is teaching', async () => {
    await act(async () => {
      root.render(
        <>
          <div className="bento-board">
            <WidgetLayer dashboard={dashboard}>
              <Widget id="a" label="Card A" size="small" index={0}>
                {() => <span className="bento-cell">a</span>}
              </Widget>
            </WidgetLayer>
          </div>
          <CustomizeCoach hold />
        </>,
      )
    })
    expect(coach()).toBeNull()
    expect(localStorage.getItem(coachKey(dashboard))).toBeNull()
  })
})
