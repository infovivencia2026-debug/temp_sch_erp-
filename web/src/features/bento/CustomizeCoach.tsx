import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Hand } from 'lucide-react'
import { useBoard } from '@/lib/widgets'
import { usePhone } from '@/lib/viewport'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useReduceMotion } from './bento-kit'
import './coach.css'

/* ONE SENTENCE, ONCE, ON A BOARD NOBODY HAS TOUCHED.

   Customize mode has three doors — a held card, the pencil by the page dots,
   the Edit pill at the foot of a desk board — and none of them says what it
   opens. A held card is the phone's own convention, but a convention only
   helps somebody who already knows it, and a school clerk on their first
   morning has never held a card on this product. So the first time a board
   is on screen that has never been arranged, it says so: a small hand beside
   the first card on a phone, a callout over the pill on a desk.

   It is a coach mark, not a tour. One line, no Next, and it goes away on its
   own — tapped, or after eight seconds, or the moment the person does the
   thing it was describing. Then it never comes back for that board, which is
   what `erp.coach.customize.<dashboard>` remembers. A board that HAS been
   arranged needs no lesson at all, so the mark also reads the layout key the
   widgets store writes — `erp.widgets.<dashboard>` — and an untouched board
   writes nothing there, which is exactly the test.

   It lives outside the layer on purpose. The layer publishes the board it
   renders (`useBoard`) after its cards have declared themselves, which is
   after the first successful render — so "the board is up" is something this
   component can simply subscribe to, and the layer never learns the coach
   exists. The anchors are found in the DOM by the same classes the layer's own
   focus-return uses. */

/** How long the mark stays up on its own. */
export const COACH_MS = 8000

export function coachKey(dashboard: string): string {
  return `erp.coach.customize.${dashboard}`
}

function layoutKey(dashboard: string): string {
  return `erp.widgets.${dashboard}`
}

/** Should the mark show for this board: never arranged, never shown. Storage
    that cannot be read answers no — a mark that came back on every visit
    because private browsing forgot it was dismissed would be worse than none. */
export function coachDue(dashboard: string): boolean {
  try {
    return (
      localStorage.getItem(layoutKey(dashboard)) === null &&
      localStorage.getItem(coachKey(dashboard)) === null
    )
  } catch {
    return false
  }
}

function remember(dashboard: string) {
  try {
    localStorage.setItem(coachKey(dashboard), new Date().toISOString())
  } catch {
    /* private browsing: it will show again next session, once */
  }
}

interface Anchor {
  top: number
  left: number
  right: number
  bottom: number
  width: number
}

/* THE PHONE'S ANCHOR IS THE FIRST CARD ON THE FIRST PAGE. Cards mount in
   declared order and the pager lays page one out first, so the first card in
   the DOM is the first one on screen; a tint or a removal does not change
   that. The desk's is the pill, which is portalled to the body and found the
   same way the layer finds it to return focus. */
function findAnchor(phone: boolean): HTMLElement | null {
  return phone
    ? document.querySelector<HTMLElement>('.bento-board .bento-widget[data-widget-id]')
    : document.querySelector<HTMLElement>('.bento-edit-pill')
}

function rectOf(el: HTMLElement): Anchor {
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width }
}

export default function CustomizeCoach({ hold = false }: {
  /** Something else is teaching right now (the first-run tour): wait. */
  hold?: boolean
}) {
  const { dashboard, widgets, arranging } = useBoard()
  const phone = usePhone()
  const still = useReduceMotion()
  const t = useT()
  /* The dashboard the mark is up for, so a board swapped underneath it is
     noticed rather than inherited. */
  const [showing, setShowing] = useState<string | null>(null)
  const [at, setAt] = useState<Anchor | null>(null)

  /* Decide once the board has published — which the layer does in an effect
     after its cards declare, i.e. after they have rendered. `widgets.length`
     rather than `widgets`: the layer republishes on any size change and the
     decision does not depend on sizes. */
  useEffect(() => {
    if (hold || arranging || !dashboard || widgets.length === 0) return
    if (!coachDue(dashboard)) return
    setShowing(dashboard)
  }, [hold, arranging, dashboard, widgets.length])

  const dismiss = useCallback(() => {
    if (showing) remember(showing)
    setShowing(null)
  }, [showing])

  /* Doing the thing is the lesson learnt. */
  useEffect(() => {
    if (arranging && showing) dismiss()
  }, [arranging, showing, dismiss])

  /* The board went away, or the tour came up over it: hide without
     remembering — nobody saw this one out. */
  useEffect(() => {
    if (showing && (hold || dashboard !== showing)) setShowing(null)
  }, [hold, dashboard, showing])

  useEffect(() => {
    if (!showing) return
    const id = window.setTimeout(dismiss, COACH_MS)
    return () => window.clearTimeout(id)
  }, [showing, dismiss])

  useEffect(() => {
    if (!showing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showing, dismiss])

  /* Measured, not laid out inside the board: the board is a scroller on the
     phone and the pill is portalled to the body on the desk, so a fixed box
     positioned from the anchor's rectangle is the one approach that works for
     both without the layer's cooperation. Re-measured when the window moves. */
  useLayoutEffect(() => {
    if (!showing) return
    const measure = () => {
      const el = findAnchor(phone)
      setAt(el ? rectOf(el) : null)
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [showing, phone])

  if (!showing) return null

  /* Without an anchor the stylesheet's defaults place it where the pill
     normally is (desk) or a third of the way down the screen (phone). */
  const style: CSSProperties | undefined = at
    ? phone
      ? { top: at.bottom - 14, left: at.left + at.width / 2 }
      : { right: Math.max(0, window.innerWidth - at.right), bottom: Math.max(0, window.innerHeight - at.top) + 10 }
    : undefined

  return createPortal(
    <div
      role="status"
      className={cn('bento-coach', phone ? 'is-phone' : 'is-desk', still && 'is-still')}
      style={style}
      data-dashboard={showing}
    >
      <button type="button" className="bento-coach__body" onClick={dismiss}>
        {phone && (
          <span className="bento-coach__glyph" aria-hidden="true">
            <Hand className="size-4" />
          </span>
        )}
        <span className="bento-coach__text">
          {t(phone ? 'bento.coach.hold' : 'bento.coach.desk')}
        </span>
      </button>
    </div>,
    document.body,
  )
}
