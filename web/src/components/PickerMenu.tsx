import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
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
  const [pos, setPos] = useState<
    { left: number; width: number; top?: number; bottom?: number } | null>(null)

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
      const below = window.innerHeight - r.bottom
      const above = r.top
      const wantsAbove = below < 240 && above > below
      const width = Math.max(r.width, 190)
      // Keep the menu on screen when it is wider than the trigger.
      const left = align === 'end'
        ? Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))
        : Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
      setPos(wantsAbove
        ? { left, width, bottom: window.innerHeight - r.top + 6 }
        : { left, width, top: r.bottom + 6 })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
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
          'inline-flex items-center gap-1.5 rounded-lg border bg-popover px-3 text-[13px] text-foreground',
          'min-h-[34px] [@media(pointer:coarse)]:min-h-[44px]',
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
          role="listbox"
          aria-label={ariaLabel}
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width }}
          onMouseDown={(e) => e.stopPropagation()}
          className={cn(
            'fixed z-[60] max-h-[min(20rem,60vh)] overflow-y-auto overflow-x-hidden',
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
