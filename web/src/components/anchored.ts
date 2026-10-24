import { useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import { currentViewport, placePanel } from './place'

/* ONE PLACEMENT FOR EVERY PANEL OPENED FROM A TRIGGER.

   A menu drawn `absolute` under its button lives inside whatever holds the
   button, and that is where the dropdown bugs came from: a card with
   overflow hidden cut it off, a page header whose entrance animation made it
   a stacking context put it behind the next card, a button near the left
   edge of a phone sent a right-aligned menu off the screen, and one near the
   bottom opened into the dock.

   So the panel is portalled to the body and placed here, in viewport
   coordinates, by the same rules PickerMenu already followed:

   - it lines up with the trigger's start or end edge, and is shifted back on
     screen, with a 16px gutter on phones and 8px elsewhere, when it is wider than the room on that side;
   - it opens below unless the space below is short and there is more above,
     in which case it flips;
   - its height is capped to the space on the side it opened, so a long list
     scrolls inside itself instead of running off the screen;
   - the visual viewport is the screen, so the on-screen keyboard counts as
     the bottom edge.

   Returns a style for the panel. Until the panel has been measured it is
   placed off screen and hidden, so it never flashes in the wrong place. */

export interface AnchorOptions {
  /** Which edge of the trigger the panel lines up with. */
  align?: 'start' | 'end'
  /** A fixed width, 'trigger' to match the trigger, or undefined to use the
      panel's own width. */
  width?: number | 'trigger'
  minWidth?: number
  /** Gap between trigger and panel. */
  gap?: number
  /** Upper bound on the panel's height, before the space available. */
  maxHeight?: number
  /** Distance kept from every edge of the screen; default 16px on phones, 8px elsewhere. */
  margin?: number
}

/** Above dialogs and sheets, so a list opened inside one is never behind it. */
export const Z_ABOVE_DIALOGS = 240

const HIDDEN: CSSProperties = { position: 'fixed', left: -9999, top: 0, visibility: 'hidden' }

export function useAnchoredPosition(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  opts: AnchorOptions = {},
): CSSProperties {
  const { align = 'start', width, minWidth = 0, gap = 6, maxHeight = 360, margin } = opts
  const [style, setStyle] = useState<CSSProperties>(HIDDEN)

  useLayoutEffect(() => {
    if (!open) { setStyle(HIDDEN); return }
    const place = () => {
      const a = anchor.current
      const p = panel.current
      if (!a) return
      const r = a.getBoundingClientRect()
      const natural = p ? p.scrollWidth : 0
      let w = width === 'trigger' ? r.width : typeof width === 'number' ? width : natural || 200
      w = Math.max(w, minWidth)
      const q = placePanel(r, currentViewport(), {
        width: w, height: p ? p.scrollHeight : 0, align, gap, maxHeight, margin,
      }, window.innerHeight)
      setStyle(
        q.up
          ? { position: 'fixed', left: q.left, width: q.width, bottom: q.bottom, maxHeight: q.maxHeight, overflowY: 'auto' }
          : { position: 'fixed', left: q.left, width: q.width, top: q.top, maxHeight: q.maxHeight, overflowY: 'auto' },
      )
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const vv = window.visualViewport
    vv?.addEventListener('resize', place)
    vv?.addEventListener('scroll', place)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    if (panel.current) ro?.observe(panel.current)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      vv?.removeEventListener('resize', place)
      vv?.removeEventListener('scroll', place)
      ro?.disconnect()
    }
  }, [open, anchor, panel, align, width, minWidth, gap, maxHeight, margin])

  return style
}

/** Close on Escape and on a press outside every one of `inside` (the trigger's
    wrapper and the portalled panel, which are not DOM relatives). */
export function useDismiss(
  open: boolean,
  close: () => void,
  inside: RefObject<HTMLElement | null>[],
) {
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      const t = e.target as Node
      if (inside.some((r) => r.current?.contains(t))) return
      close()
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', key)
    }
    // `inside` is a fresh array each render; the refs in it are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, close])
}
