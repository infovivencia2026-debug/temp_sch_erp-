import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
/* The app's own NavLink, not the router's: routes live under /:industryId, so
   a bare "/attendance" matches nothing and falls through to the catch-all,
   which sends you back to the industry chooser. This wrapper adds the prefix
   the same way every other link in the app gets it. */
import { NavLink } from '@/lib/nav'
import { cx } from '@/lib/utils'
import { useApp } from '@/hooks/useAppState'
import { modulesForRole, type RoleId } from '@/modules/registry'

/* The seven the dock reaches for first, in this order. Any the current role
   cannot open are dropped and the next ones it can are used instead, so the
   bar is always seven things that actually open. It used to be a fixed list:
   a parent was offered Student Information and Admissions CRM, and clicking
   either bounced them back to their own home page. */
const PREFERRED = ['dashboard', 'admissions', 'students', 'academics',
  'attendance', 'examinations', 'settings']
const SLOTS = 7

/* ===========================================================================
   THE DOCK

   A scoop travels along the bar to whichever icon the pointer is over, and
   that icon rises into it. The scoop is a disc painted in the page's own
   colour, sitting half over the bar's top edge — so it reads as a bite taken
   out of the bar rather than as a shape laid on top of it. Being a disc, it
   only ever translates: no path is morphed, nothing is re-rendered per frame,
   and the whole thing runs on the compositor.

   It follows the pointer while the pointer is on the bar, and returns to the
   current page when it leaves, so the bar always ends up showing where you are.
   =========================================================================== */

export function BottomBar() {
  const { pathname } = useLocation()
  const { role } = useApp()

  /* Preferred first, then whatever else the role has, up to seven. A parent
     ends up with their portal, fees and helpdesk rather than seven blanks. */
  const allowed = modulesForRole(role as RoleId)
  const items = [
    ...PREFERRED.map((id) => allowed.find((m) => m.id === id)).filter(Boolean),
    ...allowed.filter((m) => !PREFERRED.includes(m.id)),
  ].slice(0, SLOTS).map((m) => ({ id: m!.id, label: m!.label, path: `/${m!.id}`, icon: m!.icon }))
  /* pathname carries the industry; the item paths do not. Compare on the
     module segment so the dock still knows which item you are on. */
  const seg = `/${pathname.split('/').filter(Boolean)[1] ?? ''}`
  const activeIndex = Math.max(0, items.findIndex((i) => i.path === seg))

  const barRef = useRef<HTMLElement>(null)
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([])
  const [hovered, setHovered] = useState<number | null>(null)
  const [x, setX] = useState<number | null>(null)

  const focus = hovered ?? activeIndex

  /* Measured rather than calculated: the items are laid out by flexbox, and
     assuming a width here would drift the moment the padding changes. */
  useEffect(() => {
    const el = itemRefs.current[focus]
    const bar = barRef.current
    if (!el || !bar) return
    const move = () => {
      const b = bar.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      setX(r.left - b.left + r.width / 2)
    }
    move()
    window.addEventListener('resize', move)
    return () => window.removeEventListener('resize', move)
  }, [focus, pathname])

  return (
    <nav
      ref={barRef}
      onPointerLeave={() => setHovered(null)}
      className="fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full chrome hairline px-3.5 py-2 shadow-2xl no-print"
    >
      {/* The bite. Painted in the page colour so the bar appears cut, and
          hidden until the bar has been measured to avoid a jump on first paint. */}
      <span
        aria-hidden
        className="dock-scoop pointer-events-none absolute -top-[17px] h-[38px] w-[38px] rounded-full"
        style={{
          left: 0,
          transform: `translateX(${(x ?? 0) - 19}px)`,
          opacity: x === null ? 0 : 1,
          background: 'hsl(var(--background))',
        }}
      />

      {items.map((item, i) => {
        const active = i === activeIndex
        const lifted = i === focus
        const Icon = item.icon
        return (
          <div key={item.id} className="group relative">
            <NavLink
              ref={(el) => { itemRefs.current[i] = el }}
              to={item.path}
              aria-label={item.label}
              /* Named whether or not it is the current page: this bar sits at
                 the bottom, far from the heading, so nothing is duplicated. */
              data-tip={item.label}
              onPointerEnter={() => setHovered(i)}
              onFocus={() => setHovered(i)}
              className={cx(
                'rail-tip dock-item relative flex h-10 w-11 flex-col items-center justify-center rounded-full',
                lifted ? 'is-lifted' : '',
                active ? 'text-[hsl(var(--primary))]' : 'muted hover:text-foreground',
              )}
            >
              <Icon className="dock-icon h-[18px] w-[18px]" />
              {active && <span className="dock-dot" aria-hidden />}
            </NavLink>

          </div>
        )
      })}
    </nav>
  )
}
