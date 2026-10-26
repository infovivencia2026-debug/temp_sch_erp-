import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

/* EVERY DROPDOWN ON A PHONE OPENS HERE (owner, 2026-10-24: "fix ALL the
   dropdowns ... I shouldn't see this" -- a Choose field put a caret in the box,
   raised the keyboard, and floated its list over the From field).

   Below 640px a dropdown is a button, never a text box, and its options open
   in this bottom sheet: full width, above the safe area, at most 70% of the
   screen and scrolling inside itself, 48px rows in 16px type, a tick on the
   chosen one. Tap the dim layer or the handle to close. A list long enough to
   need typing (more than SEARCH_AT options, or a caller that asks) gets a
   search box INSIDE the sheet, which is not focused on open, so the keyboard
   only rises when somebody taps it. */

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
  useEffect(() => { if (!open && !onQuery) setOwn('') }, [open, onQuery])
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [open, onClose])
  if (!open) return null
  const search = searchable ?? options.length > SEARCH_AT
  const needle = q.trim().toLowerCase()
  const shown = needle && !onQuery
    ? options.filter((o) => (o.text ?? (typeof o.label === 'string' ? o.label : String(o.value))).toLowerCase().includes(needle))
    : options

  return createPortal(
    <div className="vv-screen-phone fixed inset-0 z-[300] flex flex-col justify-end" data-option-sheet="">
      <div aria-hidden="true" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex max-h-[70vh] w-full flex-col rounded-t-[20px] bg-popover text-popover-foreground shadow-[0_-10px_30px_rgba(0,0,0,0.2)]"
        style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))' }}
      >
        <button type="button" aria-label="Close" onClick={onClose}
          className="mx-auto flex h-6 w-full shrink-0 items-center justify-center">
          <span className="h-1.5 w-10 rounded-full bg-muted-foreground/40" />
        </button>
        <p className="shrink-0 px-4 pb-2 pt-1 text-[14px] font-semibold text-muted-foreground">{title}</p>
        {search && (
          <label className="mx-4 mb-2 flex h-12 shrink-0 items-center gap-2 rounded-[12px] bg-card px-3 shadow-[var(--field-shadow)]">
            <Search className="size-5 shrink-0 opacity-60" aria-hidden="true" />
            <input
              type="search"
              aria-label={`Search ${title}`}
              placeholder="Search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent text-[16px] outline-none"
            />
          </label>
        )}
        <ul role="listbox" aria-label={title} className="menu-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 [scrollbar-gutter:auto] [scrollbar-width:none]">
          {shown.map((o) => {
            const on = o.value === value
            return (
              <li key={o.value} role="option" aria-selected={on}>
                <button
                  type="button"
                  disabled={o.disabled}
                  onClick={() => { onPick(o.value); onClose() }}
                  className={cn(
                    'flex min-h-[48px] w-full items-center justify-between gap-3 rounded-[12px] px-3 py-2 text-left text-[16px]',
                    'disabled:pointer-events-none disabled:opacity-40 active:bg-accent',
                    on && 'bg-accent font-semibold',
                    o.muted && 'text-muted-foreground',
                  )}
                >
                  <span className="min-w-0 break-words" style={o.style}>{o.label}</span>
                  {on && <Check className="size-6 shrink-0" aria-hidden="true" />}
                </button>
              </li>
            )
          })}
          {!shown.length && !footer && (
            <li className="px-3 py-3 text-[14px] text-muted-foreground">Nothing matches.</li>
          )}
        </ul>
        {footer && <div className="shrink-0 px-4">{footer}</div>}
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
      className="flex min-h-[52px] w-full items-center justify-between gap-2 rounded-[12px] bg-card px-4 text-left text-[16px] text-foreground shadow-[var(--field-shadow)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className={cn('min-w-0 truncate', !label && 'text-muted-foreground')} style={style}>{label || placeholder}</span>
      <ChevronDown className={cn('size-6 shrink-0 opacity-60 transition-transform', open && 'rotate-180')} aria-hidden="true" />
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
