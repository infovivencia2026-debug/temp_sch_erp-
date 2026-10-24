import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { currentViewport, placePanel } from './place'
import { useOpenState } from '@/lib/motion'

/* ONE DROPDOWN, EVERYWHERE OUTSIDE A FORM FIELD.

   The app has three dropdown shapes, and each earns its place:
     - the shared Select (components/ui.tsx) is a combobox — a field you type
       into, for choosing one row out of many, in a form;
     - the settings DropdownRow is this menu drawn in the bento ink tokens,
       laid out as a settings row;
     - this, PickerMenu, is the plain version for everywhere else: a compact
       button that opens a floating menu of options with a tick on the chosen
       one. It replaces the native <select>s that were scattered through the
       top-bar switchers and a few forms, each of which popped the operating
       system's own list — a different, heavier control on every platform, and
       the one thing on the screen that never matched the product.

   The menu is portalled to <body> so a switcher sitting in a scrolling bar or
   a table cell is not clipped by it, and it flips above the trigger when there
   is no room below. Drawn in the app's popover tokens, so it themes in light
   and dark and in every layout. Keyboard: Enter/Space/ArrowDown to open,
   Escape and outside-click to close, arrows to move, Enter to choose. */

export interface PickerOption<T extends string> {
  value: T
  label: ReactNode
  /** Renders this option (and, when current, the trigger) in its own style —
      the typeface picker shows each face in itself. */
  style?: CSSProperties
  disabled?: boolean
}

export function PickerMenu<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = 'Select',
  className,
  menuClassName,
  align = 'end',
  children,
}: {
  value: T
  options: readonly PickerOption<T>[]
  onChange: (v: T) => void
  ariaLabel: string
  placeholder?: string
  /** Classes for the default trigger button. Ignored when `children` is given. */
  className?: string
  menuClassName?: string
  /** Which edge of the trigger the menu lines up with. */
  align?: 'start' | 'end'
  /** A custom trigger. Receives nothing; the whole node becomes the button. */
  children?: ReactNode
}) {
  const [open, setOpen] = useOpenState(false)
  const [active, setActive] = useState(0)
  const wrap = useRef<HTMLDivElement>(null)
  /* The menu lives in a portal on document.body, so it is NOT inside `wrap`.
     Outside-click has to know about both, or it treats the menu as outside
     itself -- see the note on the listener below. */
  const menu = useRef<HTMLUListElement>(null)
  const [pos, setPos] = useState<
    { left: number; width: number; top?: number; bottom?: number; maxH?: number } | null>(null)

  const current = options.find((o) => o.value === value)

  // Place the menu against the trigger's box in viewport coordinates, above it
  // when the space below is short — the same discipline the shared Select uses,
  // so a picker in a scrolling bar is never clipped or dropped off-screen.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const place = () => {
      const el = wrap.current
      if (!el) return
      const r = el.getBoundingClientRect()
      // Against the visual viewport, so the on-screen keyboard counts as
      // the bottom of the screen (see the combobox in ui.tsx).
      // Kept fully on screen, 16px from a phone's edges (components/place.ts).
      const q = placePanel(r, currentViewport(), { width: Math.max(r.width, 190), height: 240, align, maxHeight: 320 }, window.innerHeight)
      setPos(q.up
        ? { left: q.left, width: q.width, bottom: q.bottom, maxH: q.maxHeight }
        : { left: q.left, width: q.width, top: q.top, maxH: q.maxHeight })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const vv = window.visualViewport
    vv?.addEventListener('resize', place)
    vv?.addEventListener('scroll', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      vv?.removeEventListener('resize', place)
      vv?.removeEventListener('scroll', place)
    }
  }, [open, align])

  /* CHOOSING AN OPTION WAS AN OUTSIDE CLICK.

     This asked whether the pointer landed inside `wrap`, the trigger's own
     div. The menu is rendered with createPortal onto document.body, so it is
     not inside `wrap` -- and an option is not inside it either. Pressing one
     fired pointerdown, was judged "outside", closed the menu, and unmounted
     the button before its click event could run. onChange never fired.

     So every one of these pickers was inert to a mouse and to a finger, in
     every place the component is used, and only the keyboard worked: arrows
     and Enter go through onKeyDown and never touch this listener. That is the
     month that would not change however many times it was pressed.

     The stopPropagation on the <ul> below could not have saved it: that is a
     React mousedown handler, and this is a native pointerdown already
     dispatched on document. Different event, different phase.

     Both elements are consulted now. */
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      const t = e.target as Node
      if (wrap.current?.contains(t)) return
      if (menu.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  useEffect(() => {
    if (open) setActive(Math.max(0, options.findIndex((o) => o.value === value)))
  }, [open, options, value])

  const choose = (o: PickerOption<T>) => {
    if (o.disabled) return
    onChange(o.value)
    setOpen(false)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); return }
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault(); setOpen(true); return
    }
    if (!open) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, options.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (options[active]) choose(options[active]) }
  }

  return (
    <div ref={wrap} className="relative inline-flex">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
        className={children ? undefined : cn(
          'inline-flex items-center gap-1.5 rounded-[var(--radius-input)] bg-card px-3 text-[14px] text-foreground shadow-[var(--field-shadow)]',
          'min-h-[var(--control-h)]',
          'transition-colors hover:bg-accent',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
      >
        {children ?? (
          <>
            <span className="min-w-0 truncate" style={current?.style}>
              {current?.label ?? placeholder}
            </span>
            <ChevronDown
              className={cn('size-4 shrink-0 opacity-60 transition-transform', open && 'rotate-180')}
              aria-hidden="true"
            />
          </>
        )}
      </button>

      {open && pos && createPortal(
        <ul
          ref={menu}
          role="listbox"
          aria-label={ariaLabel}
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxH }}
          onMouseDown={(e) => e.stopPropagation()}
          className={cn(
            'menu-scroll fixed z-[200] max-h-[min(20rem,60vh)] overflow-y-auto overflow-x-hidden',
            'rounded-xl border bg-popover p-1.5 text-popover-foreground',
            'shadow-[0_10px_25px_-5px_rgba(0,0,0,0.18)]',
            menuClassName,
          )}
        >
          {options.map((o, i) => {
            const on = o.value === value
            return (
              <li key={o.value} role="option" aria-selected={on}>
                <button
                  type="button"
                  disabled={o.disabled}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-[13px]',
                    'min-h-[34px] [@media(pointer:coarse)]:min-h-[44px]',
                    'disabled:pointer-events-none disabled:opacity-40',
                    i === active ? 'bg-accent' : 'hover:bg-accent',
                    on && 'font-semibold',
                  )}
                >
                  <span className="min-w-0 truncate" style={o.style}>{o.label}</span>
                  {on && <Check className="size-4 shrink-0 opacity-80" aria-hidden="true" />}
                </button>
              </li>
            )
          })}
        </ul>,
        document.body,
      )}
    </div>
  )
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

/** "2026-10" -> "October 2026". Anything else comes back as it went in. */
export function monthLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key)
  if (!m) return key
  const i = Number(m[2]) - 1
  return i >= 0 && i < 12 ? `${MONTH_NAMES[i]} ${m[1]}` : key
}

/* A MONTH, IN THE PRODUCT'S OWN MENU (owner, 2026-10-13: "change this
   dropdown").

   `<input type="month">` hands the job to the browser, and Chrome answers
   with its own panel: a grid of months in its own orange and blue, its own
   typeface and its own idea of a focus ring, sitting on top of a screen
   that looks nothing like it. It is also the one control on the page that
   ignores the dark theme entirely, and on the browsers that do not
   implement it at all the field degrades to a bare text box wanting
   "2026-10" typed by hand.

   The value is still YYYY-MM, exactly what the native input gave, so
   callers and every endpoint behind them are untouched -- only the way it
   is chosen changes. The list runs back from this month, far enough for a
   year's reporting, and a value from outside that window is kept in the
   list so an older saved month still shows its name rather than vanishing. */
export function MonthPicker({
  value, onChange, ariaLabel = 'Month', back = 24, ahead = 0, className,
}: {
  value: string
  onChange: (v: string) => void
  ariaLabel?: string
  /** How many months before this one to offer. */
  back?: number
  /** How many after — a payroll month can be set before it has run. */
  ahead?: number
  className?: string
}) {
  const now = new Date()
  const keys: string[] = []
  for (let i = -ahead; i <= back; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  if (value && !keys.includes(value)) keys.push(value)
  keys.sort().reverse()
  return (
    <PickerMenu
      value={value}
      options={keys.map((k) => ({ value: k, label: monthLabel(k) }))}
      onChange={onChange}
      ariaLabel={ariaLabel}
      placeholder="Choose a month"
      align="start"
      className={className}
    />
  )
}

/** "14:05" -> "2:05 pm". Anything else comes back as it went in. */
export function timeLabel(v: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(v)
  if (!m) return v
  const h = Number(m[1]), mm = m[2]
  if (h < 0 || h > 23) return v
  const ampm = h < 12 ? 'am' : 'pm'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${mm} ${ampm}`
}

/* A TIME IS TYPED (owner, 2026-10-13: "instead of this let them write time").

   It began as a menu, like the month picker, and that was wrong: a month has
   twelve choices, a time has two hundred and eighty-eight. The list opened at
   12:00 am -- the middle of the night, nowhere near a school day -- and
   finding 9:30 meant scrolling past a hundred and fourteen times nobody
   wanted. Faster to type it, which is what the native control was at least
   letting people do.

   So it is a plain field of ours, and it reads what a person actually writes:
   "9:30", "9.30", "930", "0930", "9:30 am", "9 pm", "21:45". Bare hours below
   8 are read as the afternoon -- a school writing "2:30" for a paper means
   half past two, not half past two in the morning -- and anything genuinely
   unreadable leaves the last good value alone rather than silently becoming
   midnight. The value stays "HH:MM" on the 24-hour clock, exactly what the
   native input gave, so every endpoint behind it is untouched. */
export function parseTime(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/\s+/g, '')
  if (!t) return ''
  const m = /^(\d{1,2})(?:[:.]?(\d{2}))?(am|pm|a|p)?$/.exec(t)
  if (!m) return null
  let h = Number(m[1])
  const mins = m[2] === undefined ? 0 : Number(m[2])
  if (mins > 59) return null
  const ap = m[3]?.[0]
  if (m[1].length === 4) return null
  if (ap === 'a') { if (h < 1 || h > 12) return null; if (h === 12) h = 0 }
  else if (ap === 'p') { if (h < 1 || h > 12) return null; if (h !== 12) h += 12 }
  else {
    if (h > 23) return null
    /* "930" is 9:30; "1430" is half past two. A bare 1 to 7 with no am/pm is
       the afternoon, because a school day does not start then. */
    if (h >= 1 && h <= 7 && m[2] === undefined) h += 12
  }
  return `${String(h).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
}

export function TimePicker({
  value, onChange, ariaLabel, srLabel, className, placeholder = '9:30 am',
}: {
  value: string
  onChange: (v: string) => void
  ariaLabel?: string
  /** The same thing by the name the form fields use. */
  srLabel?: string
  className?: string
  placeholder?: string
}) {
  const now = (value || '').slice(0, 5)
  const [text, setText] = useState(() => (now ? timeLabel(now) : ''))
  const [live, setLive] = useState(false)
  /* While it is not being typed in, the field shows the tidy reading of
     whatever is stored -- so "0930" becomes "9:30 am" the moment focus
     leaves, and a value changed elsewhere on the screen shows up here. */
  useEffect(() => { if (!live) setText(now ? timeLabel(now) : '') }, [now, live])
  const commit = (raw: string) => {
    const parsed = parseTime(raw)
    if (parsed === null) { setText(now ? timeLabel(now) : ''); return }
    if (parsed !== now) onChange(parsed)
    setText(parsed ? timeLabel(parsed) : '')
  }
  return (
    <input
      type="text"
      inputMode="numeric"
      value={text}
      aria-label={ariaLabel ?? srLabel ?? 'Time'}
      placeholder={placeholder}
      onFocus={(e) => { setLive(true); setText(now); e.currentTarget.select() }}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => { setLive(false); commit(e.target.value) }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
      className={cn('field w-full [@media(pointer:coarse)]:text-[16px]', className)}
    />
  )
}
