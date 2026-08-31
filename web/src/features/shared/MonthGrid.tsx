import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Card, CardHeader, Badge, Button, Loading, ErrorState, EmptyState } from '@/components/ui'
import { formatDate, formatTime, cn } from '@/lib/utils'

/* THE MONTH, AS ONE PICTURE.

   Every date in this product already existed and none of them were ever in the
   same place. A parent checked homework on one screen, fees on another, exams
   on a third, and found the clash between a fee due date and an exam week by
   being surprised by it. `holidays.kind` has carried exactly the values a
   calendar wants -- holiday, vacation, exam, event, ptm, working_day -- since
   the baseline, and the grid that would read them was never drawn: every
   calendar screen in the product is a list grouped by month.

   A list answers "what is next". The questions a school actually asks are
   "how bad is that week" and "does this land on a holiday", and only a grid
   answers those. So this is the grid, and it is deliberately not a screen: the
   admin calendar, the parent calendar and the staff calendar each already own
   their fetching, their filters and their editing. They differ in what they
   ask the server for, not in how a month is drawn.
*/

export interface CalendarEntry {
  date: string
  end_date?: string
  kind: string
  title: string
  detail?: string
  starts_at?: string
  venue?: string
  ref_id?: string
  student_name?: string
}

/* Colour is never the only signal. Every entry carries its kind as a word in
   the day panel and in the legend, because a parent reading this on a phone in
   sunlight is not distinguishing four pastels, and neither is a colour-blind
   reader. */
const KINDS: Record<string, { label: string; tone: string; rank: number }> = {
  exam: { label: 'Exam', tone: 'bg-destructive/12 text-destructive border-destructive/30', rank: 1 },
  exam_paper: { label: 'Paper', tone: 'bg-destructive/12 text-destructive border-destructive/30', rank: 1 },
  fee_due: { label: 'Fees', tone: 'bg-warning/14 text-warning border-warning/35', rank: 2 },
  homework: { label: 'Homework', tone: 'bg-info/12 text-info border-info/30', rank: 3 },
  ptm: { label: 'PTM', tone: 'bg-success/12 text-success border-success/30', rank: 4 },
  ptm_booking: { label: 'Meeting', tone: 'bg-success/14 text-success border-success/35', rank: 4 },
  duty: { label: 'Duty', tone: 'bg-info/12 text-info border-info/30', rank: 5 },
  leave: { label: 'Leave', tone: 'bg-muted text-muted-foreground border-border', rank: 6 },
  event: { label: 'Event', tone: 'bg-primary/10 text-primary border-primary/30', rank: 7 },
  club: { label: 'Club', tone: 'bg-primary/10 text-primary border-primary/30', rank: 7 },
  holiday: { label: 'Holiday', tone: 'bg-success/10 text-success border-success/25', rank: 8 },
  vacation: { label: 'Vacation', tone: 'bg-success/10 text-success border-success/25', rank: 8 },
  term: { label: 'Term', tone: 'bg-muted text-muted-foreground border-border', rank: 9 },
  working_day: { label: 'Working day', tone: 'bg-muted text-foreground border-border', rank: 9 },
}

export const kindOf = (k: string) =>
  KINDS[k] ?? {
    label: k.replace(/_/g, ' '),
    tone: 'bg-muted text-foreground border-border',
    rank: 10,
  }

// A closed day is drawn as a closed day, not as one more sticker in the cell.
const CLOSED = new Set(['holiday', 'vacation'])

/** YYYY-MM-DD in local time. Never toISOString: that converts to UTC first, so
 *  in IST every date after 5:30am renders as the day before. */
export function isoDate(d: Date) {
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/* Six weeks from the Monday on or before the first. Fixed at 42 cells on
   purpose: a month beginning on a Sunday with 31 days needs six rows, and a
   grid that changes height as you page through the year makes the page jump
   under the reader's hand. */
function monthCells(year: number, month: number) {
  const first = new Date(year, month, 1)
  const start = new Date(first)
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7))
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

/** Spreads a multi-day entry across every day it covers, so an exam week reads
 *  as a band rather than one mark on the Monday nobody looks past. */
function byDay(entries: CalendarEntry[]) {
  const map = new Map<string, CalendarEntry[]>()
  for (const e of entries) {
    if (!e.date) continue
    const end = e.end_date && e.end_date >= e.date ? e.end_date : e.date
    // Local midday, never local midnight: midnight plus a timezone or DST
    // shift can roll the date backwards a day inside the loop.
    const d = new Date(`${e.date}T12:00:00`)
    for (let guard = 0; guard < 370 && isoDate(d) <= end; guard++) {
      const key = isoDate(d)
      const list = map.get(key)
      if (list) list.push(e)
      else map.set(key, [e])
      d.setDate(d.getDate() + 1)
    }
  }
  for (const list of map.values()) list.sort((a, b) => kindOf(a.kind).rank - kindOf(b.kind).rank)
  return map
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December']
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function MonthGrid({
  entries,
  loading,
  error,
  onRange,
  title = 'Month',
  description = 'A day the school is closed is shaded. Everything else is marked on the day it falls.',
}: {
  entries: CalendarEntry[]
  loading?: boolean
  error?: unknown
  /** Fired on mount and on every month change, with the grid's own six-week
   *  bounds -- not the month's. An exam that began in late September must
   *  still be drawn on the 1st of October, so the caller has to fetch the
   *  wider window or the first row comes back empty. */
  onRange?: (from: string, to: string) => void
  title?: string
  description?: string
}) {
  const today = new Date()
  const [cursor, setCursor] = useState({ y: today.getFullYear(), m: today.getMonth() })
  const [picked, setPicked] = useState<string>(isoDate(today))

  const cells = useMemo(() => monthCells(cursor.y, cursor.m), [cursor])
  const from = isoDate(cells[0])
  const to = isoDate(cells[41])

  // from/to rather than the callback in the dependency list: a caller that
  // passes an inline arrow would otherwise refetch on every render.
  useEffect(() => {
    onRange?.(from, to)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to])

  const map = useMemo(() => byDay(entries), [entries])
  const step = (by: number) => {
    const d = new Date(cursor.y, cursor.m + by, 1)
    setCursor({ y: d.getFullYear(), m: d.getMonth() })
  }
  const pickedList = map.get(picked) ?? []
  const legend = [...new Set(entries.map((e) => e.kind))].sort(
    (a, b) => kindOf(a).rank - kindOf(b).rank,
  )

  return (
    <>
      <Card>
        <CardHeader
          title={`${title} · ${MONTHS[cursor.m]} ${cursor.y}`}
          description={description}
          action={
            <div className="flex items-center gap-1">
              <Button variant="secondary" onClick={() => step(-1)} aria-label="Previous month">
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  const n = new Date()
                  setCursor({ y: n.getFullYear(), m: n.getMonth() })
                  setPicked(isoDate(n))
                }}
              >
                Today
              </Button>
              <Button variant="secondary" onClick={() => step(1)} aria-label="Next month">
                <ChevronRight className="size-4" />
              </Button>
            </div>
          }
        />

        {error ? <ErrorState error={error} /> : null}

        <div className="p-3">
          {/* The grid is drawn while loading rather than replaced by a
              spinner: the month's shape does not change, and swapping it for
              a spinner on every page makes the whole screen flash. */}
          <div
            className={cn(
              'grid grid-cols-7 gap-px overflow-hidden rounded-md bg-border p-px transition-opacity',
              loading && 'opacity-60',
            )}
          >
            {DAYS.map((d) => (
              <div
                key={d}
                className="bg-card px-1 py-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                {d}
              </div>
            ))}

            {cells.map((d) => {
              const key = isoDate(d)
              const list = map.get(key) ?? []
              const outside = d.getMonth() !== cursor.m
              const isToday = key === isoDate(today)
              const closed = list.some((e) => CLOSED.has(e.kind)) || d.getDay() === 0

              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setPicked(key)}
                  aria-current={isToday ? 'date' : undefined}
                  aria-label={`${formatDate(key)}${list.length ? `, ${list.length} entries` : ''}`}
                  className={cn(
                    'flex min-h-[84px] flex-col items-start gap-1 bg-card p-1.5 text-left',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary',
                    outside && 'opacity-45',
                    closed && 'bg-muted/50',
                    picked === key ? 'ring-2 ring-inset ring-primary' : 'hover:bg-muted/60',
                  )}
                >
                  <span
                    className={cn(
                      'inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] tabular-nums',
                      isToday
                        ? 'bg-primary font-semibold text-primary-foreground'
                        : 'text-foreground',
                    )}
                  >
                    {d.getDate()}
                  </span>

                  {/* Two, then a count. A cell that grows with its contents
                      makes every other row in that week taller, and the month
                      stops being one picture. */}
                  <span className="flex w-full min-w-0 flex-col gap-0.5">
                    {list.slice(0, 2).map((e, i) => (
                      <span
                        key={`${e.kind}-${e.ref_id ?? i}`}
                        title={e.title}
                        className={cn(
                          'truncate rounded border px-1 py-px text-[10.5px] leading-tight',
                          kindOf(e.kind).tone,
                        )}
                      >
                        {e.title}
                      </span>
                    ))}
                    {list.length > 2 && (
                      <span className="px-1 text-[10.5px] text-muted-foreground">
                        {list.length - 2} more
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>

          {legend.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {legend.map((k) => (
                <span
                  key={k}
                  className={cn('rounded border px-1.5 py-0.5 text-[11px]', kindOf(k).tone)}
                >
                  {kindOf(k).label}
                </span>
              ))}
            </div>
          )}

          {loading && <Loading label="Reading the month…" />}
        </div>
      </Card>

      <Card>
        <CardHeader
          title={formatDate(picked)}
          description="What falls on the day picked in the grid above."
        />
        {pickedList.length === 0 ? (
          <EmptyState title="Nothing on this day" body="Pick another day in the grid above." />
        ) : (
          <ul className="divide-y">
            {pickedList.map((e, i) => {
              const line = [
                e.student_name,
                e.detail,
                e.starts_at ? formatTime(e.starts_at) : null,
                e.venue,
                e.end_date && e.end_date !== e.date ? `until ${formatDate(e.end_date)}` : null,
              ]
                .filter(Boolean)
                .join(' · ')
              return (
                <li key={`${e.kind}-${e.ref_id ?? i}`} className="flex items-start gap-3 p-4">
                  <Badge tone="neutral">{kindOf(e.kind).label}</Badge>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{e.title}</p>
                    {line && <p className="text-[13px] text-muted-foreground">{line}</p>}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </>
  )
}
