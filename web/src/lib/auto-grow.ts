import { useEffect, useLayoutEffect, type RefObject } from 'react'

/* A TEXT BOX THAT GROWS AS THE LINES COME (owner, 2026-10-01: "text area
   should grow as new line comes in").

   It starts at `minRows`, follows its content line by line up to `maxRows`,
   and from there scrolls inside; nothing below it jumps, because the height
   is set from the box's own scrollHeight with its padding and border
   accounted for (box-sizing is content-box or border-box, and the two
   disagree about what `height` means). Browsers that know
   `field-sizing: content` do the growing themselves and the hook only
   applies the two clamps; the rest get the measurement.

   Measured on every input, whenever the value is set from outside (a form
   reset, a draft restored), on mount, and when the window or the root font
   size changes, which is what a person changing the app's type size does. */

export interface GrowBounds { minRows?: number; maxRows?: number }

export interface GrowMetrics {
  /** The content's own height: scrollHeight, measured at height:auto. */
  scrollHeight: number
  lineHeight: number
  /** Top plus bottom. */
  padding: number
  /** Top plus bottom. */
  border: number
  boxSizing: 'content-box' | 'border-box'
}

/** The pixel height to set, and whether the box has more than it can show. */
export function growHeight(m: GrowMetrics, { minRows = 2, maxRows = 10 }: GrowBounds = {}): { height: number; overflow: boolean } {
  const lo = Math.max(1, Math.min(minRows, maxRows))
  const hi = Math.max(lo, maxRows)
  const chrome = m.padding + m.border
  // The lines the content needs, from a content height that excludes the chrome.
  const content = Math.max(0, m.scrollHeight - m.padding)
  const minContent = lo * m.lineHeight
  const maxContent = hi * m.lineHeight
  const wanted = Math.min(maxContent, Math.max(minContent, content))
  const overflow = content > maxContent + 0.5
  // border-box's `height` includes the padding and the border; content-box's does not.
  const height = m.boxSizing === 'border-box' ? wanted + chrome : wanted
  return { height: Math.ceil(height), overflow }
}

const supportsFieldSizing = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')

function px(v: string): number { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }

/** Read the box and set its height. Exported for the hook and for callers that
    keep their own ref and only want the measurement. */
export function fitTextarea(el: HTMLTextAreaElement, bounds: GrowBounds = {}) {
  const cs = window.getComputedStyle(el)
  const fontSize = px(cs.fontSize) || 16
  const lineHeight = cs.lineHeight === 'normal' || !cs.lineHeight ? fontSize * 1.2 : px(cs.lineHeight)
  const padding = px(cs.paddingTop) + px(cs.paddingBottom)
  const border = px(cs.borderTopWidth) + px(cs.borderBottomWidth)
  const boxSizing = cs.boxSizing === 'border-box' ? 'border-box' : 'content-box'
  const { minRows = 2, maxRows = 10 } = bounds
  const lo = Math.max(1, Math.min(minRows, maxRows))
  const hi = Math.max(lo, maxRows)
  const chrome = boxSizing === 'border-box' ? padding + border : 0
  if (supportsFieldSizing) {
    // The browser sizes it; the two clamps are all it needs.
    el.style.setProperty('field-sizing', 'content')
    el.style.height = ''
    el.style.minHeight = `${Math.ceil(lo * lineHeight + chrome)}px`
    el.style.maxHeight = `${Math.ceil(hi * lineHeight + chrome)}px`
    el.style.overflowY = 'auto'
    return
  }
  // Measured with the height let go, so a box that shrank is measured small.
  // The page is not re-laid-out in between: the two writes are back to back.
  el.style.height = 'auto'
  const { height, overflow } = growHeight({ scrollHeight: el.scrollHeight, lineHeight, padding, border, boxSizing }, { minRows: lo, maxRows: hi })
  el.style.height = `${height}px`
  el.style.overflowY = overflow ? 'auto' : 'hidden'
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** Keep `ref`'s textarea sized to its content between `minRows` and `maxRows`.
    `value` is the controlled value, so a change from props re-measures too. */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, bounds: GrowBounds = {}, value?: string) {
  const { minRows, maxRows } = bounds
  // Before paint, so the first frame is already the right height: no jump on mount.
  useIsoLayoutEffect(() => {
    const el = ref.current
    if (el) fitTextarea(el, { minRows, maxRows })
  }, [ref, minRows, maxRows, value])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => fitTextarea(el, { minRows, maxRows })
    // `input` catches what a controlled value cannot: an IME mid-composition, a drag-drop of text.
    el.addEventListener('input', fit)
    window.addEventListener('resize', fit)
    // The root font size (the app's type-size setting) changes the line height.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null
    ro?.observe(document.documentElement)
    ro?.observe(el)
    return () => {
      el.removeEventListener('input', fit)
      window.removeEventListener('resize', fit)
      ro?.disconnect()
    }
  }, [ref, minRows, maxRows])
}
