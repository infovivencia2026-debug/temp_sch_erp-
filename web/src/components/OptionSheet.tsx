import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { lockPageScroll } from '@/lib/keyboard'

/* EVERY DROPDOWN ON A PHONE OPENS HERE (owner, 2026-10-24: "fix ALL the
   dropdowns ... I shouldn't see this" -- a Choose field put a caret in the box,
   raised the keyboard, and floated its list over the From field).

   Below 640px a dropdown is a button, never a text box, and its options open
   in this bottom sheet: full width, above the safe area, at most 70% of the
   screen and scrolling inside itself, 48px rows in 16px type, a tick on the
   chosen one. Tap the dim layer or the handle to close. A list long enough to
   need typing (more than SEARCH_AT options, or a caller that asks) gets a
   search box INSIDE the sheet. Since 2026-10-26 (owner) that box takes focus
   150ms after the sheet opens; a short fixed list has no box, so it never
   raises the keyboard.

   Look (owner, 2026-10-26, docs/owner-designs/2026-10-26-phone-dropdown-sheet.html):
   blurred dim layer, card sheet with 28px top corners, options as separate
   rounded rows with no lines and no grey fill, the chosen one tinted primary
   with a tick. Drag the handle down to close (or flick it); a short drag
   springs back. Escape closes. No grey wash on press. */

export const PHONE_QUERY = '(max-width: 639.98px)'
/** Lists longer than this get a search box in the sheet. */
export const SEARCH_AT = 12

function phoneNow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(PHONE_QUERY).matches
}

/** True below 640px; follows rotation and resizing. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(phoneNow)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(PHONE_QUERY)
    const on = () => setPhone(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return phone
}

export interface SheetOption {
  value: string
  label: ReactNode
  /** Text the search matches against, when the label is not a string. */
  text?: string
  style?: CSSProperties
  disabled?: boolean
  muted?: boolean
}

const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'
const SLIDE_MS = 350
/** Drag the handle further down than this (px), or flick it, and it closes. */
const CLOSE_AT = 80
const FLICK = 0.5 // px per ms

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function OptionSheet({
  open,
  onClose,
  title,
  options,
  value,
  onPick,
  searchable,
  query,
  onQuery,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  options: readonly SheetOption[]
  value: string
  onPick: (v: string) => void
  /** Force the search box on or off; default: more than SEARCH_AT options. */
  searchable?: boolean
  /** Controlled search, for callers that act on the typed text (Select). */
  query?: string
  onQuery?: (q: string) => void
  /** Extra rows under the options (add-your-own, messages). */
  footer?: ReactNode
}) {
  const [own, setOwn] = useState('')
  const q = query ?? own
  const setQ = onQuery ?? setOwn
  /* mounted stays true through the slide-out after open turns false; entered
     drives the slide (false = below the screen, dim layer clear). */
  const [mounted, setMounted] = useState(open)
  const [entered, setEntered] = useState(false)
  const sheetRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; y0: number; dy: number; t: number; y: number; v: number; moved: boolean } | null>(null)
  const justDragged = useRef(false)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (!open && !onQuery) setOwn('') }, [open, onQuery])
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [open, onClose])

  // Enter and leave: transform and opacity only; instant under reduced motion.
  useEffect(() => {
    if (open) {
      setMounted(true)
      if (reducedMotion()) { setEntered(true); return }
      let r2 = 0
      const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setEntered(true)) })
      return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2) }
    }
    setEntered(false)
    if (reducedMotion()) { setMounted(false); return }
    const t = window.setTimeout(() => setMounted(false), SLIDE_MS)
    return () => window.clearTimeout(t)
  }, [open])

  // While open the page underneath does not scroll; focus moves into the
  // sheet and returns to the field that opened it on close.
  useEffect(() => {
    if (!open) return
    const unlock = lockPageScroll()
    const back = document.activeElement as HTMLElement | null
    sheetRef.current?.focus({ preventScroll: true })
    /* A searchable sheet is there to type in (owner, 2026-10-26): the field
       takes focus once the sheet has risen, and the keyboard with it. The
       sheet is pinned to the visible screen (.vv-screen-phone, --vvh), so it
       sits above the keyboard. On close the field is blurred. */
    const input = () => searchRef.current
    const t = window.setTimeout(() => input()?.focus({ preventScroll: true }), 150)
    return () => {
      window.clearTimeout(t)
      input()?.blur()
      unlock()
      if (back && back !== document.body && document.contains(back)) back.focus({ preventScroll: true })
    }
  }, [open])

  if (!mounted) return null
  const search = searchable ?? options.length > SEARCH_AT
  const needle = q.trim().toLowerCase()
  const shown = needle && !onQuery
    ? options.filter((o) => (o.text ?? (typeof o.label === 'string' ? o.label : String(o.value))).toLowerCase().includes(needle))
    : options
  const visible = open && entered
  const row = search ? 'rounded-[12px] px-[14px] py-3' : 'rounded-[14px] px-4 py-[14px]'

  const setY = (y: number, animate: boolean) => {
    const el = sheetRef.current
    if (!el) return
    el.style.transition = animate && !reducedMotion() ? `transform ${SLIDE_MS}ms ${EASE}` : 'none'
    el.style.transform = y ? `translateY(${y}px)` : ''
  }
  const onDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    drag.current = { id: e.pointerId, y0: e.clientY, dy: 0, t: e.timeStamp, y: e.clientY, v: 0, moved: false }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setY(0, false)
  }
  const onMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const raw = e.clientY - d.y0
    d.v = (e.clientY - d.y) / Math.max(1, e.timeStamp - d.t)
    d.t = e.timeStamp
    d.y = e.clientY
    if (Math.abs(raw) > 4) d.moved = true
    // Down follows the finger; up is resisted.
    d.dy = raw < 0 ? raw * 0.2 : raw
    setY(d.dy, false)
  }
  const onUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    justDragged.current = d.moved
    if (d.moved && (d.dy > CLOSE_AT || (d.dy > 20 && d.v > FLICK))) {
      // Hand the slide-out to the class transform, from where the finger left it.
      setY(0, true)
      onClose()
    } else {
      setY(0, true)
    }
  }

  return createPortal(
    <div className={cn("vv-screen-phone fixed inset-0 z-[300] flex flex-col justify-end", !open && "pointer-events-none")} data-option-sheet="" data-closing={open ? undefined : ""}>
      <div
        aria-hidden="true"
        className={cn(
          'option-sheet-backdrop absolute inset-0 bg-[rgba(15,23,42,0.5)] backdrop-blur-[4px] transition-opacity duration-300 ease-out motion-reduce:transition-none',
          visible ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'option-sheet-panel relative flex [animation:none] max-h-[min(75dvh,calc(var(--vvh,100dvh)-16px))] w-full flex-col rounded-t-[28px] bg-card px-5 pt-1 text-card-foreground outline-none',
          'shadow-[0_-10px_30px_rgba(0,0,0,0.15)] transition-transform duration-[350ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
          visible ? 'translate-y-0' : 'translate-y-full',
        )}
        style={{ paddingBottom: 'max(36px, calc(16px + env(safe-area-inset-bottom, 0px)))' }}
      >
        <button
          type="button"
          aria-label="Close"
          onClick={() => { if (justDragged.current) { justDragged.current = false; return } onClose() }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          className="group flex w-full shrink-0 cursor-grab touch-none select-none items-center justify-center pb-[10px] pt-[14px] [-webkit-tap-highlight-color:transparent] focus-visible:outline-none active:cursor-grabbing"
        >
          <span className="h-[5px] w-10 rounded-[3px] bg-muted-foreground/35 transition-colors group-hover:bg-muted-foreground/55 group-focus-visible:bg-primary" />
        </button>
        <p className="mb-[14px] shrink-0 px-2 text-[16px] font-bold text-foreground">{title}</p>
        {search && (
          <label className="relative mb-3 block shrink-0">
            <Search className="pointer-events-none absolute left-[14px] top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              aria-label={`Search ${title}`}
              placeholder="Search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className={cn(
                // Fill and focus ring: .option-sheet-search in index.css.
                'option-sheet-search block h-12 w-full rounded-[12px] py-[10px] pl-[38px] pr-[14px] text-[16px] text-foreground outline-none',
                'transition-[background-color,box-shadow] duration-200 motion-reduce:transition-none placeholder:text-muted-foreground',
              )}
            />
          </label>
        )}
        <ul role="listbox" aria-label={title} className="menu-scroll flex min-h-0 shadow-none [animation:none] flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain px-1 [scrollbar-gutter:auto] [scrollbar-width:none]">
          {shown.map((o) => {
            const on = o.value === value
            return (
              <li key={o.value} role="option" aria-selected={on}>
                <button
                  type="button"
                  disabled={o.disabled}
                  onClick={() => { onPick(o.value); onClose() }}
                  className={cn(
                    'flex min-h-[48px] w-full items-center justify-between gap-3 text-left text-[16px]', row,
                    'transition-colors duration-150 [-webkit-tap-highlight-color:transparent] motion-reduce:transition-none',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    'disabled:pointer-events-none disabled:opacity-40',
                    on
                      ? 'bg-primary/[0.08] font-semibold text-primary'
                      : cn('bg-transparent [@media(hover:hover)]:hover:bg-muted/50', o.muted ? 'text-muted-foreground' : 'text-foreground'),
                  )}
                >
                  <span className="min-w-0 break-words" style={o.style}>{o.label}</span>
                  {on && <Check className="size-[18px] shrink-0 text-primary" strokeWidth={2.5} aria-hidden="true" />}
                </button>
              </li>
            )
          })}
          {!shown.length && !footer && (
            <li className="p-4 text-center text-[14px] text-muted-foreground">No results</li>
          )}
        </ul>
        {footer && <div className="shrink-0 px-1 pt-1.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/** The phone field for a dropdown: a 52px button with a chevron, never a
    text box, so tapping it raises no keyboard and shows no caret. */
export function SheetTrigger({
  label, placeholder, open, onOpen, ariaLabel, style,
}: {
  label: ReactNode
  placeholder: string
  open: boolean
  onOpen: () => void
  ariaLabel?: string
  style?: CSSProperties
}) {
  return (
    <button
      type="button"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={ariaLabel}
      onClick={onOpen}
      className="field flex min-h-[52px] w-full items-center justify-between gap-2 rounded-[12px] px-4 text-left text-[16px] text-foreground"
    >
      <span className={cn('min-w-0 truncate', !label && 'text-muted-foreground')} style={style}>{label || placeholder}</span>
      <ChevronDown className={cn('field-chevron size-6 shrink-0 opacity-60 transition-transform', open && 'rotate-180')} aria-hidden="true" />
    </button>
  )
}

/* A tap inside the sheet is not a tap "away" (Yajur, 2026-10-26: "I can't see
   students when I choose a class", phone only). The sheet is portaled to
   <body>, so a dropdown's outside-press listener saw the mousedown on an
   option as outside, closed the dropdown, and the sheet unmounted before the
   click landed: nothing was ever chosen. Every outside-press listener of a
   dropdown that opens this sheet must ask this first. */
export function inOptionSheet(t: EventTarget | null): boolean {
  return t instanceof Element && !!t.closest('[data-option-sheet]')
}
