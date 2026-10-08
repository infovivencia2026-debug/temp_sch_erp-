import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAnchoredPosition } from './anchored'

/* ONE CALENDAR, EVERYWHERE A DATE IS ASKED FOR.
 *
 * There are 195 date boxes across 98 screens and every one of them showed
 * whatever calendar the browser happened to have: Chrome's on Windows,
 * Safari's on a Mac, a spinning drum on a phone, and nothing at all on a few
 * older Android builds, where the field degrades to free text and a clerk can
 * type "3/4" into a due date. They are the same control to the person using
 * them and they looked like four different products.
 *
 * So the calendar is ours. It opens from the field, it is the same on every
 * machine, and it reads the app's own colours rather than iOS blue -- the
 * owner's mockup is the shape, and a picker that stayed white-on-white in
 * dark mode would be a worse bug than the one it fixed.
 *
 * The month title is a button: pressing it swaps the day grid for twelve
 * months, which is the second half of the mockup and the fast way back to
 * July when you are standing in October.
 *
 * The value contract is unchanged -- 'YYYY-MM-DD' in, 'YYYY-MM-DD' out -- so
 * no screen had to be edited to gain this.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']
const SHORT = MONTHS.map((m) => m.slice(0, 3))
const WEEK = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

const pad = (n: number) => String(n).padStart(2, '0')
export const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`

/** 'YYYY-MM-DD' to parts, or null. Never Date.parse: that reads a bare date
    as UTC and hands back yesterday to anybody west of Greenwich. */
export function parseISO(v: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((v || '').trim())
  if (!m) return null
  const y = +m[1], mo = +m[2] - 1, d = +m[3]
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null
  return { y, m: mo, d }
}

/** The date a person reads, from the value a form holds. */
export function prettyDate(v: string): string {
  const p = parseISO(v)
  return p ? `${pad(p.d)} ${SHORT[p.m]} ${p.y}` : ''
}

export function DatePopover({
  value, onChange, onClose, anchor, min, max,
}: {
  value: string
  onChange: (v: string) => void
  onClose: () => void
  anchor: RefObject<HTMLElement | null>
  min?: string
  max?: string
}) {
  const picked = parseISO(value)
  const today = new Date()
  const [view, setView] = useState(() => ({
    y: picked?.y ?? today.getFullYear(),
    m: picked?.m ?? today.getMonth(),
  }))
  const [months, setMonths] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const pos = useAnchoredPosition(true, anchor, box, { gap: 6, minWidth: 310, maxHeight: 420 })

  /* Escape closes, and so does a press anywhere else. Pointerdown rather than
     click: a click that starts outside and ends inside must not close it. */
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    const away = (e: PointerEvent) => {
      const t = e.target as Node
      if (box.current?.contains(t) || anchor.current?.contains(t)) return
      onClose()
    }
    document.addEventListener('keydown', key, true)
    document.addEventListener('pointerdown', away, true)
    return () => {
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('pointerdown', away, true)
    }
  }, [anchor, onClose])

  const grid = useMemo(() => {
    const first = new Date(view.y, view.m, 1).getDay()
    const days = new Date(view.y, view.m + 1, 0).getDate()
    const cells: (number | null)[] = Array(first).fill(null)
    for (let d = 1; d <= days; d++) cells.push(d)
    return cells
  }, [view])

  const outOfRange = (d: number) => {
    const v = iso(view.y, view.m, d)
    return (!!min && v < min) || (!!max && v > max)
  }

  const step = (by: number) => setView((v) => {
    const n = new Date(v.y, v.m + by, 1)
    return { y: n.getFullYear(), m: n.getMonth() }
  })

  const navBtn = 'grid size-7 place-items-center rounded-full bg-muted text-primary ' +
    'transition-transform hover:bg-accent active:scale-95'

  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label="Choose a date"
      style={{ ...pos, zIndex: 80 }}
      className="w-[310px] select-none rounded-[20px] border bg-popover p-3.5 shadow-[var(--lift-float)]"
    >
      <div className="mb-3 flex items-center justify-between px-1">
        <button
          type="button"
          onClick={() => setMonths((s) => !s)}
          className="flex items-baseline gap-1.5 rounded-lg px-1.5 py-0.5 text-left hover:bg-accent"
        >
          <span className="text-[16px] font-semibold tracking-[-0.01em]">{MONTHS[view.m]}</span>
          <span className="text-[15px] text-muted-foreground">{view.y}</span>
        </button>
        <div className="flex gap-1.5">
          <button type="button" aria-label={months ? 'Previous year' : 'Previous month'}
            className={navBtn} onClick={() => (months ? setView((v) => ({ ...v, y: v.y - 1 })) : step(-1))}>
            <ChevronLeft className="size-4" />
          </button>
          <button type="button" aria-label={months ? 'Next year' : 'Next month'}
            className={navBtn} onClick={() => (months ? setView((v) => ({ ...v, y: v.y + 1 })) : step(1))}>
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>

      {months ? (
        <div className="grid grid-cols-4 gap-1.5">
          {SHORT.map((label, i) => (
            <button
              key={label}
              type="button"
              onClick={() => { setView((v) => ({ ...v, m: i })); setMonths(false) }}
              className={cn(
                'rounded-[11px] py-2.5 text-[13.5px] font-medium transition-transform active:scale-95',
                i === view.m
                  ? 'bg-primary font-semibold text-primary-foreground'
                  : 'hover:bg-accent',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="mb-1.5 grid grid-cols-7 text-center">
            {WEEK.map((w) => (
              <div key={w} className="py-1 text-[11px] font-semibold uppercase text-muted-foreground">{w}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-y-1">
            {grid.map((d, i) => {
              if (d === null) return <div key={`e${i}`} className="aspect-square" />
              const isPicked = !!picked && picked.y === view.y && picked.m === view.m && picked.d === d
              const isToday = today.getFullYear() === view.y && today.getMonth() === view.m
                && today.getDate() === d
              const off = outOfRange(d)
              return (
                <button
                  key={d}
                  type="button"
                  disabled={off}
                  onClick={() => { onChange(iso(view.y, view.m, d)); onClose() }}
                  className={cn(
                    'relative mx-auto grid aspect-square w-9 place-items-center rounded-full text-[14.5px]',
                    'transition-transform active:scale-90',
                    off && 'cursor-not-allowed opacity-30',
                    !off && !isPicked && 'hover:bg-accent',
                    isPicked && 'bg-primary font-semibold text-primary-foreground',
                  )}
                >
                  {d}
                  {isToday && !isPicked && (
                    <span aria-hidden className="absolute bottom-[3px] size-1 rounded-full bg-primary" />
                  )}
                </button>
              )
            })}
          </div>
        </>
      )}

      {/* A date box is often "today" and almost as often wants emptying. */}
      <div className="mt-3 flex items-center justify-between border-t pt-2.5">
        <button
          type="button"
          className="rounded-lg px-2 py-1 text-[13px] text-primary hover:bg-accent"
          onClick={() => { const n = new Date(); onChange(iso(n.getFullYear(), n.getMonth(), n.getDate())); onClose() }}
        >
          Today
        </button>
        <button
          type="button"
          className="rounded-lg px-2 py-1 text-[13px] text-muted-foreground hover:bg-accent"
          onClick={() => { onChange(''); onClose() }}
        >
          Clear
        </button>
      </div>
    </div>,
    document.body,
  )
}

/* THE SAME PICKER WHERE A SCREEN ASKS FOR A MONTH, NOT A DAY.
 *
 * Payroll, My pay and the leave policy each had two dropdowns side by side --
 * one listing twelve months, one listing years -- which is two decisions and
 * two lists to answer "July 2026". The owner's second mockup is the fix: the
 * twelve months as a grid, the year with an arrow either side, one press.
 *
 * It shares the month grid above rather than copying it, so the two pickers
 * cannot drift apart.
 */
export function MonthField({
  month, year, onPick, className,
}: {
  /** 1-12, as the screens already hold it. */
  month: number
  year: number
  onPick: (month: number, year: number) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [shownYear, setShownYear] = useState(year)
  const anchor = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const pos = useAnchoredPosition(open, anchor, box, { gap: 6, minWidth: 280 })

  useEffect(() => { if (open) setShownYear(year) }, [open, year])
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    const away = (e: PointerEvent) => {
      const t = e.target as Node
      if (box.current?.contains(t) || anchor.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('keydown', key, true)
    document.addEventListener('pointerdown', away, true)
    return () => {
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('pointerdown', away, true)
    }
  }, [open])

  const navBtn = 'grid size-7 place-items-center rounded-full bg-muted text-primary ' +
    'transition-transform hover:bg-accent active:scale-95'

  return (
    <div ref={anchor} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        aria-expanded={open}
        className="field flex w-full items-center justify-between gap-2 text-left [@media(pointer:coarse)]:text-[16px]"
      >
        <span>{MONTHS[Math.min(Math.max(month, 1), 12) - 1]} {year}</span>
        <ChevronRight className="size-4 shrink-0 rotate-90 text-muted-foreground" aria-hidden />
      </button>
      {open && createPortal(
        <div
          ref={box}
          role="dialog"
          aria-label="Choose a month"
          style={{ ...pos, zIndex: 80 }}
          className="w-[280px] select-none rounded-[20px] border bg-popover p-3.5 shadow-[var(--lift-float)]"
        >
          <div className="mb-3 flex items-center justify-between px-1">
            <span className="text-[16px] font-semibold">{shownYear}</span>
            <div className="flex gap-1.5">
              <button type="button" aria-label="Previous year" className={navBtn}
                onClick={() => setShownYear((y) => y - 1)}><ChevronLeft className="size-4" /></button>
              <button type="button" aria-label="Next year" className={navBtn}
                onClick={() => setShownYear((y) => y + 1)}><ChevronRight className="size-4" /></button>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {SHORT.map((label, i) => (
              <button
                key={label}
                type="button"
                onClick={() => { onPick(i + 1, shownYear); setOpen(false) }}
                className={cn(
                  'rounded-[11px] py-2.5 text-[13.5px] font-medium transition-transform active:scale-95',
                  i + 1 === month && shownYear === year
                    ? 'bg-primary font-semibold text-primary-foreground'
                    : 'hover:bg-accent',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
