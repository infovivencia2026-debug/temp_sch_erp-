import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { Z_ABOVE_DIALOGS } from './anchored'
import { currentViewport, placePanel } from './place'

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

/* ABOVE THE DIALOGS, OR IT IS NOT THERE AT ALL.
   Modals in this product sit at z-index 110 and 200. This panel opened at
   80, so a date field inside a dialog -- the leave form, a bus's document
   expiry -- opened its calendar BEHIND the dialog: the field looked dead,
   and the only way to set a date was to give up. Reported as "the date
   picker is invisible", which is exactly what it was. */

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


/* ALWAYS BELOW THE FIELD, NEVER ABOVE IT.

   The shared anchor hook flips a panel above its field when there is more
   room up there. For a menu that is right; for this it is not. A calendar is
   310px tall, so near the foot of a page it flipped, and the owner saw the
   same control open downwards on one screen and upwards on the next -- so the
   day you were reaching for moved depending on where the field happened to
   sit. One direction, every time: down, shifted sideways only as far as
   keeping it on screen requires.

   ...AND NEVER OFF THE BOTTOM OF THE SCREEN (Yajur, 2026-10-14: "in August I
   don't see 30 and 31"). A month that runs to six rows is taller than the room
   left under a field low on the page, and the last row was cut off. So the
   panel is measured, and lifted only as far as it takes for its foot to sit on
   screen; on a screen too short for it at all, it scrolls inside itself. */
/* `open` re-measures each time the popup opens. The month box is mounted
   with the page, so measuring once put the popup wherever the box was while
   the page was still laying out -- the top-left corner (Yajur, 2026-10-16). */
function below(anchor: RefObject<HTMLElement | null>, width: number, box: RefObject<HTMLElement | null>, open = true): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', opacity: 0 })
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const a = anchor.current
      if (!a) return
      const r = a.getBoundingClientRect()
      const h = box.current?.offsetHeight ?? 0
      // Kept inside the visible screen with the phone's 16px gutters (components/place.ts).
      const p = placePanel(r, currentViewport(), { width, height: h, lift: true, maxHeight: 10_000 })
      const { left, top, maxHeight: room } = p
      setStyle({ position: 'fixed', left, top, width: p.width, maxHeight: room, overflowY: h > room ? 'auto' : undefined, opacity: 1 })
    }
    place()
    // Measured again once painted, and whenever its height changes (month to month, or the month grid).
    const raf = requestAnimationFrame(place)
    const ro = typeof ResizeObserver !== 'undefined' && box.current ? new ResizeObserver(place) : null
    if (ro && box.current) ro.observe(box.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    const vv = window.visualViewport
    vv?.addEventListener('resize', place)
    vv?.addEventListener('scroll', place)
    return () => {
      vv?.removeEventListener('resize', place)
      vv?.removeEventListener('scroll', place)
      cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor, width, box, open])
  return style
}

/* THE CALENDAR CRASHED THE SCREEN IT WAS OPENED ON (owner, 2026-10-23:
   "when I admit a student, where I click the DOB dropdown, the page shows no
   screen exists; I have to reload").

   The holiday lookup was a Map. Staff query caches are persisted to
   IndexedDB as JSON (App.tsx PersistGate), and JSON writes a Map as {}. On
   the next load the calendar got {} back, called .get on it, threw while
   rendering, and the screen's error boundary replaced the page with "This
   screen did not load". The lookup is a plain record now, and whatever comes
   back from storage is read defensively. */
export function holidayLookup(data: unknown): Record<string, string> {
  if (data instanceof Map) return Object.fromEntries(data) as Record<string, string>
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) if (typeof v === 'string') out[k] = v
  return out
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
  /* HOLIDAYS GREY (Yajur, 2026-10-15: "holiday is set from and to date but
     in any role i dont see that days as grey"). Every day of a ranged
     holiday, from the school calendar. Plain fetch, not api(): a date box on
     a signed-out page must not bounce anyone to the login screen, and a
     calendar that cannot load holidays is still a calendar. */
  const monthKey = `${view.y}-${pad(view.m + 1)}`
  const hol = useQuery({
    queryKey: ['holiday-days', monthKey],
    queryFn: async () => {
      const last = new Date(view.y, view.m + 1, 0).getDate()
      const r = await fetch(`/api/v1/calendar/holiday-days?from=${monthKey}-01&to=${monthKey}-${pad(last)}`, { credentials: 'include' })
      if (!r.ok) return {} as Record<string, string>
      const j = await r.json() as { items?: { date: string; name: string }[]; data?: { items?: { date: string; name: string }[] } }
      const list = j.items ?? j.data?.items ?? []
      return Object.fromEntries(list.map((h) => [h.date, h.name])) as Record<string, string>
    },
    staleTime: 10 * 60_000, retry: false,
  })
  const holidays = holidayLookup(hol.data)
  const box = useRef<HTMLDivElement>(null)
  const pos = below(anchor, 310, box)

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
      style={{ ...pos, zIndex: Z_ABOVE_DIALOGS }}
      className="select-none rounded-[20px] border bg-popover p-3.5 shadow-[var(--lift-float)]"
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
              const holiday = holidays[iso(view.y, view.m, d)]
              return (
                <button
                  key={d}
                  type="button"
                  disabled={off}
                  title={holiday ? `Holiday: ${holiday}` : undefined}
                  aria-label={holiday ? `${d}, holiday: ${holiday}` : undefined}
                  onClick={() => { onChange(iso(view.y, view.m, d)); onClose() }}
                  className={cn(
                    'relative mx-auto grid aspect-square w-9 place-items-center rounded-full text-[14.5px]',
                    'transition-transform active:scale-90',
                    off && 'cursor-not-allowed opacity-30',
                    !off && !isPicked && 'hover:bg-accent',
                    holiday && !isPicked && 'bg-muted text-muted-foreground line-through decoration-muted-foreground/50',
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
  const pos = below(anchor, 280, box, open)

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
          style={{ ...pos, zIndex: Z_ABOVE_DIALOGS }}
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
