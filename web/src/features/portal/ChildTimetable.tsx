import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List, type Period, type TimetableEntry } from '@/lib/api'
import { PageHead, PageBody, Card, Select, ErrorState, EmptyState } from '@/components/ui'
import WeekGrid from '@/components/WeekGrid'
import { cn, WEEKDAYS } from '@/lib/utils'
import { Freshness, ScreenSkeleton } from './screen-state'
import { useChildren, childOptions, readyFor } from './use-children'

/* Your child's week.
 *
 * The school had a timetable for every section and the family had no way to
 * read it: "is there PT tomorrow, does she need the kit" was a question for
 * the class WhatsApp group.
 *
 * On a phone — which is where a parent reads this — a six-by-nine grid is a
 * squint. So the phone gets one day at a time: a strip of day chips, and the
 * chosen day as a vertical timeline, period by period, times down the left,
 * the period that is on right now lit up. Today is selected on open. A wide
 * screen keeps the same grid the class teacher reads.
 *
 * Asked by section, not by "me": the timetable endpoint's family scope covers
 * every child's section at once, which for a parent of two is two weeks
 * overlaid. The child list carries each child's section_id, so the picker
 * chooses and the query names one section. */
export default function ChildTimetable() {
  const { children: kids, query: kidsQuery, studentId, child, setChosen } = useChildren()
  const sectionId = child?.section_id ?? ''

  const periods = useQuery({
    queryKey: ['periods'],
    queryFn: () => api.get<List<Period>>('/api/v1/timetable/periods'),
    enabled: !!sectionId,
  })
  const entries = useQuery({
    queryKey: ['timetable', 'section', sectionId],
    queryFn: () => api.get<List<TimetableEntry>>(`/api/v1/timetable/entries?section_id=${sectionId}`),
    enabled: !!sectionId,
  })

  const ready = readyFor(kids, studentId)

  return (
    <>
      <PageHead
        eyebrow="My child"
        title="Timetable"
        actions={
          kids.length > 1 && (
            <Select
              value={studentId}
              onChange={setChosen}
              placeholder="Which child?"
              options={childOptions(kids)}
            />
          )
        }
      />
      <Freshness query={entries} />
      <PageBody>
        {kidsQuery.isLoading ? (
          <ScreenSkeleton rows={6} label="Loading your children" />
        ) : kidsQuery.error ? (
          <ErrorState error={kidsQuery.error} />
        ) : kids.length === 0 ? (
          <EmptyState
            title="No child is linked to this account yet."
            body="Once the school links your child, their week appears here."
          />
        ) : !ready ? (
          <EmptyState title="Choose a child above to see their week." />
        ) : !sectionId ? (
          <EmptyState
            title={`${child?.full_name ?? 'Your child'} is not placed in a section yet.`}
            body="The timetable belongs to a section; it appears once the school places them."
          />
        ) : periods.isLoading || entries.isLoading ? (
          <ScreenSkeleton rows={6} label="Loading the week" />
        ) : entries.error ? (
          <ErrorState error={entries.error} />
        ) : (
          <>
            <DayTimeline
              who={`${child?.full_name ?? ''}`}
              where={`${child?.class_name ?? ''} ${child?.section_name ?? ''}`.trim()}
              periods={periods.data?.items ?? []}
              entries={entries.data?.items ?? []}
            />
            <Card className="hidden lg:block">
              <div className="border-b px-4 py-2.5 text-[13px] text-muted-foreground">
                {child?.full_name} · {child?.class_name} {child?.section_name}
              </div>
              <div className="p-4">
                <WeekGrid
                  entries={(entries.data?.items ?? []).map((e) => ({
                    weekday: e.weekday,
                    period_id: e.period_id,
                    title: e.subject_name || e.subject_code,
                    detail: (e.teacher_name ?? '') + (e.room ? `${e.teacher_name ? ' · ' : ''}${e.room}` : ''),
                  }))}
                  periods={periods.data?.items ?? []}
                  empty="Nothing timetabled for this class yet."
                />
              </div>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}

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

function DayTimeline({
  who,
  where,
  periods,
  entries,
}: {
  who: string
  where: string
  periods: Period[]
  entries: TimetableEntry[]
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

  const ordered = useMemo(() => [...periods].sort((a, b) => a.sequence - b.sequence), [periods])
  const byPeriod = useMemo(() => {
    const m = new Map<string, TimetableEntry>()
    for (const e of entries) if (e.weekday === day) m.set(e.period_id, e)
    return m
  }, [entries, day])

  const current = (p: Period) =>
    day === today && nowMin >= minutes(p.starts_at) && nowMin < minutes(p.ends_at)
  const live = ordered.find(current)

  const rows = ordered.filter((p) => p.is_break || byPeriod.has(p.id))

  return (
    <Card className="lg:hidden">
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
        <ol className="relative flex flex-col gap-3 px-4 pb-6 pt-4">
          {/* the track the dots sit on */}
          <span aria-hidden className="absolute bottom-6 left-[76px] top-5 w-0.5 bg-border" />
          {rows.map((p) => {
            const e = byPeriod.get(p.id)
            const isNow = current(p)
            const isBreak = p.is_break
            return (
              <li key={p.id} className="relative flex items-start">
                <div className="flex w-[56px] shrink-0 flex-col items-end pr-3 pt-2.5">
                  <span className="text-[12px] font-bold">{hhmm(p.starts_at)}</span>
                  <span className="text-[11px] font-medium text-muted-foreground">{hhmm(p.ends_at)}</span>
                </div>
                <span
                  aria-hidden
                  className={cn(
                    'absolute left-[60px] top-3.5 z-[1] h-2.5 w-2.5 rounded-full border-2 border-card',
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
                      <div className="text-[14px] font-bold">{e?.subject_name || e?.subject_code}</div>
                      {(e?.teacher_name || e?.room) && (
                        <div className="mt-0.5 text-[12px] text-muted-foreground">
                          {[e?.teacher_name, e?.room].filter(Boolean).join(' • ')}
                        </div>
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
