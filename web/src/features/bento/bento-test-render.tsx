import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WidgetSizeContext, type WidgetSize } from '@/lib/widget-size'

/* Rendering, for the card tests.

   `react-dom/server` rather than a client render: every drawing in
   `bento-cards.tsx` and `bento-viz.tsx` is a pure function of its props with
   no effects and no state, so one static pass is the whole of its behaviour —
   and a static pass has no timers, no scheduler and nothing to await, which is
   what keeps these tests deterministic.

   The markup is then parsed into a real jsdom node so the assertions can ask
   the DOM questions (`querySelector`, `getAttribute`) instead of matching
   strings against the markup. What jsdom CANNOT answer is anything about
   LAYOUT — it has no box model, so every measured size is zero. Nothing below
   asserts on a computed size for that reason; see the note at the end of each
   file. */

/** Render a drawing into a detached node, at a stated cell size.

    3x2 by default: several of the `bento-viz` drawings return null below the
    room they need, and a default that hid them would make every other
    assertion in the file vacuous. The size gates themselves are tested
    explicitly. */
export function draw(node: ReactElement, size: WidgetSize = { w: 3, h: 2 }): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(
    <WidgetSizeContext.Provider value={size}>{node}</WidgetSizeContext.Provider>,
  )
  return host
}

/** Did it draw nothing at all? A drawing that refuses renders no markup. */
export function drewNothing(node: ReactElement, size?: WidgetSize): boolean {
  return draw(node, size).innerHTML === ''
}

/** The raw `style` attribute of the first match — read as text rather than
    through `el.style`, so a value jsdom's CSS parser rejects (`NaN%`, a
    `color-mix()`) is still visible to the assertion instead of vanishing. */
export function styleOf(host: HTMLElement, selector: string): string {
  const el = host.querySelector(selector)
  if (!el) throw new Error(`no element matching ${selector}`)
  return el.getAttribute('style') ?? ''
}

/** One declaration out of that attribute, e.g. `left` -> `12.5%`. */
export function decl(style: string, prop: string): string {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(style)
  return m ? m[1].trim() : ''
}

/** Source text with comments removed, for the assertions that read the file.

    The comments in `bento-cards.tsx` DISCUSS the tokens the code must not
    name — they are the record of the two bugs that shipped — so a scan that
    did not strip them would fail on its own documentation. */
export function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}
