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
   without ResizeObserver fall back to window resize. The very first
   placement is instant (no slide in from the corner), and so is every move
   under reduced motion (index.css).

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
    const place = () => {
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
      const x = r.left + r.width / 2 - w / 2 - l.left - list.clientLeft + list.scrollLeft
      const y = r.top + r.height / 2 - h / 2 - l.top - list.clientTop + list.scrollTop
      ind.style.width = `${w}px`
      ind.style.height = `${h}px`
      ind.style.transform = `translate(${x}px, ${y}px)`
      if (!placed.current) {
        placed.current = true
        // Next frame: from now on, moves animate.
        requestAnimationFrame(() => ind.setAttribute('data-ready', ''))
      }
    }
    place()
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => place())
      ro.observe(list)
      if (target) ro.observe(target)
    } else {
      window.addEventListener('resize', place)
    }
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [listRef, active, pick])

  return <span ref={ref} aria-hidden className={cn('slide-thumb', className)} />
}
