import { useEffect, useMemo, useState } from 'react'
import type { Period } from '@/lib/api'
import { Card } from '@/components/ui'
import { cn, WEEKDAYS } from '@/lib/utils'

/** "09:15:00" → "09:15"; anything odd is shown as it came. */
function hhmm(t: string): string {
  return /^\d{2}:\d{2}/.test(t) ? t.slice(0, 5) : t
}

/** Minutes since midnight for "HH:MM[:SS]", or NaN. */
function minutes(t: string): number {
  const m = /^(\d{2}):(\d{2})/.exec(t)
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN
}

/** ISO weekday of a Date, 1 = Monday … 7 = Sunday. */
function isoWeekday(d: Date): number {
  return d.getDay() === 0 ? 7 : d.getDay()
}

export interface DayEntry {
  weekday: number
  period_id: string
  title: string
  detail?: string
}

/* One day at a time, as a timeline.

   A strip of day chips — today preselected, any day a tap away — and the
   chosen day down the page: times on the left, one card per period, breaks
   marked, the period on right now lit in the theme's primary. Shared by the
   parent's child timetable and the teacher's own week, so the two read as one
   product: same chips, same cards, same "now". Callers decide what a card
   says (subject + teacher for a parent; class + room for a teacher). */
export default function DayTimeline({
  who,
  where,
  periods,
  entries,
  breaks = true,
}: {
  who: string
  where: string
  periods: Period[]
  entries: DayEntry[]
  /** Show the schedule's breaks between periods. Off for a teacher whose
      week spans several bell schedules, where "the" break is ambiguous. */
  breaks?: boolean
}) {
  // The days the timetable actually has something on, Monday first. A school
  // that runs Saturday shows it; one that does not never shows an empty chip.
  const days = useMemo(() => {
    const seen = new Set(entries.map((e) => e.weekday))
    const list = [1, 2, 3, 4, 5, 6, 7].filter((d) => seen.has(d))
    return list.length ? list : [1, 2, 3, 4, 5, 6]
  }, [entries])

  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  const today = isoWeekday(now)
  const nowMin = now.getHours() * 60 + now.getMinutes()

  // Today if the school runs today, else the next school day.
  const [day, setDay] = useState<number>(() => {
    const t = isoWeekday(new Date())
    return days.includes(t) ? t : (days.find((d) => d > t) ?? days[0])
  })

  const ordered = useMemo(() => {
    const seen = new Set<string>()
    return [...periods]
      .filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
      .sort((a, b) => a.sequence - b.sequence || a.starts_at.localeCompare(b.starts_at))
  }, [periods])
  const byPeriod = useMemo(() => {
    const m = new Map<string, DayEntry>()
    for (const e of entries) if (e.weekday === day) m.set(e.period_id, e)
    return m
  }, [entries, day])

  const current = (p: Period) =>
    day === today && nowMin >= minutes(p.starts_at) && nowMin < minutes(p.ends_at)
  const live = ordered.find(current)

  const rows = ordered.filter((p) => (breaks && p.is_break) || byPeriod.has(p.id))

  return (
    <Card className="mx-auto w-full max-w-[640px]">
      {/* Sticky head: who, and the day strip. Stays put while the day scrolls. */}
      <div className="sticky top-0 z-10 border-b bg-card px-4 pb-2.5 pt-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold tracking-[-0.01em]">{who}</div>
            <div className="text-[12px] font-medium text-muted-foreground">{where}</div>
          </div>
          {live && (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-[11px] font-semibold text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              {live.name} now
            </span>
          )}
        </div>
        <div role="tablist" aria-label="Day" className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {days.map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={day === d}
              onClick={() => setDay(d)}
              className={cn(
                'h-11 min-w-[48px] flex-1 rounded-lg text-[12px] font-semibold',
                day === d
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'bg-muted text-muted-foreground',
                d === today && day !== d && 'ring-1 ring-primary/40',
              )}
            >
              {WEEKDAYS[d - 1]}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">
          Nothing timetabled for {WEEKDAYS[day - 1]}.
        </p>
      ) : (
        <ol className="relative flex flex-col gap-3 pb-6 pl-3 pr-4 pt-4">
          {/* the track the dots sit on */}
          <span aria-hidden className="absolute bottom-6 left-[72px] top-5 w-0.5 bg-border" />
          {rows.map((p) => {
            const e = byPeriod.get(p.id)
            const isNow = current(p)
            const isBreak = p.is_break
            return (
              <li key={p.id} className="relative flex items-start">
                <div className="flex w-[56px] shrink-0 flex-col items-end pr-2 pt-2.5">
                  <span className="text-[12px] font-bold">{hhmm(p.starts_at)}</span>
                  <span className="text-[11px] font-medium text-muted-foreground">{hhmm(p.ends_at)}</span>
                </div>
                <span
                  aria-hidden
                  className={cn(
                    'absolute left-[56px] top-3.5 z-[1] h-2.5 w-2.5 rounded-full border-2 border-card',
                    isNow ? 'bg-primary ring-4 ring-primary/20' : isBreak ? 'bg-warning' : 'bg-border',
                  )}
                />
                <div
                  className={cn(
                    'ml-5 min-w-0 flex-1 rounded-xl border px-3.5 py-2.5 shadow-sm',
                    isNow
                      ? 'border-primary bg-primary/10'
                      : isBreak
                        ? 'border-dashed border-warning/40 bg-warning/5 py-2'
                        : 'border-border bg-card',
                  )}
                >
                  {isBreak ? (
                    <div className="text-[12px] font-semibold text-warning">
                      {p.name} · {Math.max(0, minutes(p.ends_at) - minutes(p.starts_at))} min
                    </div>
                  ) : (
                    <>
                      <div className={cn('text-[11px] font-bold uppercase tracking-wide', isNow ? 'text-primary' : 'text-muted-foreground')}>
                        {p.name}
                        {isNow && ' · in progress'}
                      </div>
                      <div className="text-[14px] font-bold">{e?.title}</div>
                      {e?.detail && (
                        <div className="mt-0.5 text-[12px] text-muted-foreground">{e.detail}</div>
                      )}
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </Card>
  )
}
