import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/* A scrolling panel that admits it is scrolling.

   A dropdown that runs past the bottom of its box looks like a dropdown that
   has ended. The Actions menu on a student's record was exactly this: nine
   items, six visible, and "Record that they have left" sliced in half at the
   edge — which reads as a rendering fault, not as an invitation to scroll. A
   mouse wheel finds the rest; a trackpad over the wrong half of the screen, a
   touchscreen in a school office and a keyboard do not.

   So the affordance is a control, not a hint: a chevron appears at whichever
   end has more behind it, and pressing it moves one screenful. The fade under
   it is decoration on top of a real button rather than the only signal.

   Both buttons are aria-hidden and unfocusable on purpose. They duplicate
   what the arrow keys and the wheel already do for anybody who has them, and
   a screen reader announcing "scroll down, button" between two menu items
   would be reading out the furniture. */
export default function ScrollBox({
  children,
  className,
  step = 0.8,
}: {
  children: ReactNode
  /** Height and any padding. The overflow is set here. */
  className?: string
  /** How much of a screenful one press moves. */
  step?: number
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [more, setMore] = useState({ up: false, down: false })

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    // A pixel of tolerance: fractional scroll heights are ordinary at
    // non-integer zoom, and a permanently lit arrow that does nothing is
    // worse than no arrow.
    setMore({
      up: el.scrollTop > 1,
      down: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
    })
  }, [])

  useEffect(() => {
    measure()
    const el = ref.current
    if (!el) return
    // Content can arrive after mount — a query resolving, a menu item
    // appearing once a permission loads — so the box watches itself rather
    // than measuring once and believing it.
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
    return () => ro.disconnect()
  }, [measure, children])

  const nudge = (direction: 1 | -1) => {
    const el = ref.current
    if (!el) return
    el.scrollBy({ top: direction * el.clientHeight * step, behavior: 'smooth' })
  }

  return (
    <div className="relative">
      {more.up && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={() => nudge(-1)}
          className="absolute inset-x-0 top-0 z-10 flex h-6 items-center justify-center bg-gradient-to-b from-card via-card/90 to-transparent text-muted-foreground hover:text-foreground"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
      )}

      <div ref={ref} onScroll={measure} className={cn('overflow-y-auto', className)}>
        {children}
      </div>

      {more.down && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={() => nudge(1)}
          className="absolute inset-x-0 bottom-0 z-10 flex h-6 items-center justify-center bg-gradient-to-t from-card via-card/90 to-transparent text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
