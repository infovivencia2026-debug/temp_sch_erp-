import { useLayoutEffect, useRef, type RefObject } from 'react'
import { cn } from '@/lib/utils'

/* THE THUMB SLIDES; IT DOES NOT JUMP.

   A segmented control or a tab row used to repaint the active pill on the
   new button in the same frame, so the eye saw the old one vanish and a new
   one appear. This is the one moving piece: an absolutely positioned span,
   placed under whichever child is active, moved with `transform` (and sized
   with width/height on an out-of-flow box, which reflows nothing else). The
   move rides --motion-ease, the iOS settle curve, at --motion.

   Measured, not computed: a ResizeObserver on the row and the active child
   re-places it when labels translate, fonts land or the row wraps. Browsers
   without ResizeObserver fall back to window resize. Only a change of
   selection slides: the very first placement is instant (no slide in from
   the corner), so is a re-measure after a resize, and so is every move under
   reduced motion (index.css). Width and height are animated on a box that is
   out of flow, so nothing else reflows (data-motion-layout-ok tells the dev
   audit so).

   The row carries `data-slide`; index.css then paints the active child's own
   background transparent so the pill is not drawn twice, and lifts the
   children above the pill. If this never mounts (old engine, JS error), the
   row keeps its ordinary active styling -- the failure is "no slide". */
export function SlidingIndicator({
  listRef,
  active,
  className,
  pick,
}: {
  listRef: RefObject<HTMLElement | null>
  /** Anything that changes when the selection does (the active key). */
  active: unknown
  className?: string
  /** Finds the active child. Defaults to the selected/pressed/current one. */
  pick?: (list: HTMLElement) => HTMLElement | null
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const placed = useRef(false)
  /** The last size and place written, so an unchanged measurement is a no-op. */
  const at = useRef('')

  useLayoutEffect(() => {
    const list = listRef.current
    const ind = ref.current
    if (!list || !ind) return
    list.setAttribute('data-slide', '')
    const find = () =>
      pick
        ? pick(list)
        : (Array.from(list.children).find(
            (c) =>
              c !== ind &&
              (c.getAttribute('aria-selected') === 'true' ||
                c.getAttribute('aria-pressed') === 'true' ||
                c.getAttribute('aria-current') === 'page'),
          ) as HTMLElement | undefined) ?? null
    let target = find()
    /* `slide` is true only for a change of selection. A resize, a font
       landing or a label translating re-places the thumb in one step: sliding
       there made the pill drift across the row while the window was dragged.
       Unchanged measurements are left alone, so an observer firing in the
       middle of a slide does not cut it short. */
    const place = (slide: boolean) => {
      target = find()
      if (!target) {
        ind.style.opacity = '0'
        return
      }
      ind.style.opacity = '1'
      /* Rects rather than offsetLeft: the target may sit inside a positioned
         child (the student tab bar puts the pill round the icon), and its
         offsetParent is then not the row. Scroll is added back so a row that
         scrolls sideways carries the thumb with its content. */
      const r = target.getBoundingClientRect()
      const l = list.getBoundingClientRect()
      /* Size from offsetWidth/Height and position from the rect's CENTRE:
         the button just clicked may still be mid-press at scale(0.97), which
         shrinks its rect but not its centre or its layout size. */
      const w = target.offsetWidth
      const h = target.offsetHeight
      const x = Math.round((r.left + r.width / 2 - w / 2 - l.left - list.clientLeft + list.scrollLeft) * 100) / 100
      const y = Math.round((r.top + r.height / 2 - h / 2 - l.top - list.clientTop + list.scrollTop) * 100) / 100
      const next = `${w}|${h}|${x}|${y}`
      if (next === at.current) return
      at.current = next
      const still = !slide && placed.current
      if (still) ind.style.transition = 'none'
      ind.style.width = `${w}px`
      ind.style.height = `${h}px`
      ind.style.transform = `translate(${x}px, ${y}px)`
      if (still) {
        void ind.offsetWidth   // the new place is taken before the transition comes back
        ind.style.transition = ''
      }
      if (!placed.current) {
        placed.current = true
        // Next frame: from now on, a change of selection slides.
        requestAnimationFrame(() => ind.setAttribute('data-ready', ''))
      }
    }
    const resized = () => place(false)
    place(true)
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(resized)
      ro.observe(list)
      if (target) ro.observe(target)
    } else {
      window.addEventListener('resize', resized)
    }
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', resized)
    }
  }, [listRef, active, pick])

  return <span ref={ref} aria-hidden data-motion-layout-ok="" className={cn('slide-thumb', className)} />
}
