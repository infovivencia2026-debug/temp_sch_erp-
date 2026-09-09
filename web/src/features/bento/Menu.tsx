import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { dimsForTier, type SizeTier } from '@/lib/size-tiers'

/* ONE POPOVER FOR EVERY MENU ON THE BOARD: the size menu on a card, the
   layouts menu on the customize bar, the "…" quick menu on a card, the tab
   strip's and the dock's context menus.

   API
   ---
   <Menu open anchor label onClose [width]>{children}</Menu>

   open     Render and position the popover. Nothing renders while false.
   anchor   The button the menu hangs from (its DOM node, usually `ref.current`
            read at render). Positioned under it, or above it when there is
            no room below — the bar's buttons never have room below. Focus
            returns to it on close. A null anchor pins the menu near the
            top-left of the viewport.
   label    aria-label of the `role="menu"` container.
   onClose  Called on Escape, on a pointer press outside the popover and its
            anchor, and by the items themselves after acting. Keep it
            referentially stable (useCallback): it is a dependency of the
            effect that installs the document listeners.
   width    Pixel width on a wide screen (default 208). On a phone the menu
            is a full-width sheet above the bar instead, the same answer the
            colour wheel gives, and `width` is ignored.
   phone    Which of the two shapes to draw. The board passes the same flag
            it lays itself out by (usePhone, < 768px); without it the menu
            reads the window (< 640px), which a phone in landscape gets wrong.
   still    Reduce motion, as the account has it. The menu enters and leaves
            with a short fade-and-slide on the --bento-dur-fast token; with
            `still`, or when the OS asks for it, both are instant. Where there
            is no matchMedia at all (a test renderer) they are instant too, so
            a closed menu is gone from the DOM in the same act().

   ROLES. The container is `role="menu"`. Children supply the items with
   `role="menuitem"`, `role="menuitemradio"` (with aria-checked) or
   `role="menuitemcheckbox"`; a `<div role="separator" className="bento-menu__rule">`
   draws a rule. Give items `className="bento-menu__item"` (add `is-on` for
   the checked one). Disabled items are skipped by the arrow keys. Anything
   whose role starts with "menuitem" and is not disabled is walkable.

   KEYBOARD. On open, focus lands on the first enabled item. ArrowDown/ArrowUp
   wrap through the items, Home/End jump. Escape is caught ON THE WAY DOWN
   (capture phase, on document) and stopped there: the customize layer's own
   Escape leaves the mode, and somebody closing a menu has not asked for
   that. Enter/Space act through the native button.

   POINTER. A pointerdown outside the popover and outside the anchor closes
   it — except inside `[data-colour-pop]`, the colour wheel, which the size
   menu opens from its last row and which portals itself elsewhere.

   Portalled into document.body and `position: fixed` (see .bento-menu in
   bento-theme.css), because a card may be one grid cell across and the bar
   is a fixed strip; a popover inside either would be clipped. */
export function Menu({
  open,
  anchor,
  label,
  onClose,
  width = 208,
  centre,
  phone,
  still: stillProp,
  children,
}: {
  open: boolean
  anchor: HTMLElement | null
  label: string
  onClose: () => void
  width?: number
  /* Open in the middle of the screen instead of under the button.

     A menu belongs beside the thing it acts on, which is why this is opt-in
     rather than the default. Settings is the exception: it is the one menu
     that acts on the whole screen rather than on the row it hangs off, and
     hanging it off a dock that is itself centred at the bottom edge put it
     in the corner of the screen, pointing at nothing. */
  centre?: boolean
  phone?: boolean
  still?: boolean
  children: ReactNode
}) {
  const pop = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ left: number; top: number; up: boolean } | null>(null)
  const narrow = phone ?? (typeof window !== 'undefined' && window.innerWidth < 640)
  const still = stillProp || osStill()
  const { mounted, shown } = useEnterExit(open, still, DUR_FAST_MS)

  useLayoutEffect(() => {
    if (!open) {
      setAt(null)
      return
    }
    const r = anchor?.getBoundingClientRect()
    const h = pop.current?.offsetHeight ?? 220
    if (centre) {
      setAt({
        left: Math.max(8, (window.innerWidth - width) / 2),
        top: Math.max(8, (window.innerHeight - h) / 2),
        up: false,
      })
      return
    }
    if (!r) {
      setAt({ left: 16, top: 16, up: false })
      return
    }
    const below = r.bottom + 6 + h <= window.innerHeight - 8
    setAt({
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      top: below ? r.bottom + 6 : Math.max(8, r.top - 6 - h),
      up: !below,
    })
  }, [open, anchor, width, centre])

  useEffect(() => {
    if (!open) return
    const first = pop.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')
    first?.focus()
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node
      if (pop.current?.contains(n) || anchor?.contains(n)) return
      if ((n as HTMLElement).closest?.('[data-colour-pop]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
      anchor?.focus()
    }
  }, [open, anchor, onClose])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const items = Array.from(
      pop.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [],
    )
    if (items.length === 0) return
    e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next =
      e.key === 'Home' ? 0
      : e.key === 'End' ? items.length - 1
      : e.key === 'ArrowDown' ? (i + 1) % items.length
      : (i - 1 + items.length) % items.length
    items[next].focus()
  }

  if (!mounted) return null
  return createPortal(
    <div
      ref={pop}
      role="menu"
      aria-label={label}
      aria-hidden={open ? undefined : true}
      data-bento-menu=""
      data-shown={shown ? '' : undefined}
      data-still={still ? '' : undefined}
      data-up={at?.up ? '' : undefined}
      data-sheet={narrow ? '' : undefined}
      className="bento-menu"
      onKeyDown={onKeyDown}
      style={
        narrow
          ? { left: 12, right: 12, bottom: 'calc(var(--customize-bar-h, 84px) + env(safe-area-inset-bottom, 0px))', width: 'auto' }
          : { left: at?.left ?? 0, top: at?.top ?? 0, width, visibility: at ? 'visible' : 'hidden' }
      }
    >
      {children}
    </div>,
    document.body,
  )
}

/** The menu's enter and exit, in milliseconds: the --bento-dur-fast token
    in bento-theme.css, which every transition of the mode's chrome reads. */
export const DUR_FAST_MS = 150
/** The slower one, --bento-dur: the gallery, the sheet and the card lift. */
export const DUR_MS = 200

/** Does the OS ask for reduced motion? True where there is no matchMedia
    to ask — a test renderer — so nothing there ever waits on a timer. */
export function osStill(): boolean {
  return typeof matchMedia !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches
}

/* MOUNTED FOR THE EXIT, SHOWN FOR THE ENTER. The pattern the add gallery
   uses, in one hook so the menu, the colour wheel and the reorder sheet all
   leave the same way: `mounted` stays true for `ms` after `open` drops, and
   `shown` turns true two frames after it rises — one frame to paint the
   start state, one for the transition to have somewhere to start from.
   With `still` both follow `open` at once, and the render that sees
   `open` false sees nothing mounted. */
export function useEnterExit(open: boolean, still: boolean, ms: number): { mounted: boolean; shown: boolean } {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(open && still)
  useEffect(() => {
    if (open) {
      setMounted(true)
      if (still) {
        setShown(true)
        return
      }
      let inner = 0
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setShown(true))
      })
      return () => {
        cancelAnimationFrame(outer)
        cancelAnimationFrame(inner)
      }
    }
    setShown(false)
    if (still) {
      setMounted(false)
      return
    }
    const timer = window.setTimeout(() => setMounted(false), ms)
    return () => window.clearTimeout(timer)
  }, [open, still, ms])
  return { mounted: still ? open : mounted || open, shown }
}

/* THE FOOTPRINT OF A TIER, drawn on a miniature of the board it is for: three
   by two on the desk (Wide is the third column), two by two on the phone.
   The lit cells are the tier; the dim ones are the board around it. Lives
   here because every menu that lists sizes draws it. */
export function TierGlyph({ tier, phone }: { tier: SizeTier; phone: boolean }) {
  const { w, h } = dimsForTier(tier, phone)
  const cols = phone ? 2 : 3
  return (
    <svg viewBox={`0 0 ${cols * 10} 20`} width={cols * 7} height={14} aria-hidden="true" className="shrink-0">
      {Array.from({ length: cols * 2 }, (_, i) => {
        const c = i % cols
        const r = Math.floor(i / cols)
        const on = c < w && r < h
        return (
          <rect key={i} x={c * 10 + 1} y={r * 10 + 1} width={8} height={8} rx="1.5"
            fill="currentColor" opacity={on ? 0.9 : 0.18} />
        )
      })}
    </svg>
  )
}
