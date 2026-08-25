import { useQuery } from '@tanstack/react-query'
import { NavLink } from 'react-router-dom'
import { Clock } from 'lucide-react'
import { api, type List, type Period, type TimetableEntry } from '@/lib/api'
import { featurePath } from '@/lib/catalog'
import { PageHead, Loading, ErrorState, EmptyState } from '@/components/ui'
import { cn } from '@/lib/utils'

/* A teacher's own day, from their own timetable.

   THIS SCREEN USED TO BE FICTION. 190 lines, not one data call: it told every
   teacher who opened it that their next class was "Math (10th Grade)" in "Room
   304" with 26 of 28 present, and listed a roll of Alex, Ben and Chloe. None of
   those people attend this school. It was routed at two catalogue keys, so a
   teacher met it as both "Today's classes" and "My Class Hub".

   A screen that invents data is worse than a screen that says it has none. An
   empty timetable is a fact a teacher can act on — they go and ask why. A
   plausible fake is one they cannot, because nothing looks wrong until they
   walk to Room 304.

   Everything here comes from routes that already existed:
     /api/v1/timetable/periods          the bell schedule
     /api/v1/timetable/entries?teacher_id=me   this teacher's own lessons

   No new endpoint, no new feature — the same screen, telling the truth. */

/** Monday is 1 in the timetable's weekday numbering; JS Sunday is 0. */
function todayWeekday(): number {
  const d = new Date().getDay()
  return d === 0 ? 7 : d
}

function minutesInto(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

export default function TodaysClasses() {
  const role = 'faculty'
  const weekday = todayWeekday()

  const periods = useQuery({
    queryKey: ['periods'],
    queryFn: () => api.get<List<Period>>('/api/v1/timetable/periods'),
  })
  const entries = useQuery({
    queryKey: ['timetable', 'me'],
    queryFn: () => api.get<List<TimetableEntry>>('/api/v1/timetable/entries?teacher_id=me'),
  })

  if (periods.isLoading || entries.isLoading) return <Loading label="Loading your timetable" />
  if (entries.error) return <ErrorState error={entries.error} />
  if (periods.error) return <ErrorState error={periods.error} />

  const bell = new Map((periods.data?.items ?? []).map((p) => [p.id, p]))
  const mine = (entries.data?.items ?? [])
    .filter((e) => e.weekday === weekday)
    .sort((a, b) => (bell.get(a.period_id)?.sequence ?? 0) - (bell.get(b.period_id)?.sequence ?? 0))

  /* "Now" and "next" are read off the clock rather than stored, so the screen
     is right whenever it is opened and does not need refreshing to stop lying. */
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
  const current = mine.find((e) => {
    const p = bell.get(e.period_id)
    return p && minutesInto(p.starts_at) <= nowMin && nowMin < minutesInto(p.ends_at)
  })
  const next = mine.find((e) => {
    const p = bell.get(e.period_id)
    return p && minutesInto(p.starts_at) > nowMin
  })

  const timetableHref = featurePath(role, 'my_classes', 'my_timetable')
  const workHref = featurePath(role, 'home', 'my_work')

  return (
    <div className="mx-auto max-w-5xl px-6 pb-16 pt-8 sm:px-10">
      <PageHead
        eyebrow="My classes"
        title="Today"
        description={
          mine.length === 0
            ? 'Nothing is timetabled for you today.'
            : `${mine.length} ${mine.length === 1 ? 'lesson' : 'lessons'} on your timetable today.`
        }
      />

      {mine.length === 0 ? (
        /* Says which day it is looking at. An empty day and a day the timetable
           does not cover are different problems, and a teacher can only tell
           them apart if the screen says which one it means. */
        <div className="mt-6">
          <EmptyState
            title="No lessons timetabled today"
            body={
              weekday >= 6
                ? 'Today is the weekend. Your full week is on the timetable.'
                : 'If that is wrong, the timetable for your subjects may not be published yet — the timetable below shows your whole week.'
            }
          />
        </div>
      ) : (
        <>
          {(current || next) && (
            <div className="mt-6 rounded-[14px] border bg-card p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {current ? 'In progress' : 'Next'}
              </p>
              {(() => {
                const e = current ?? next!
                const p = bell.get(e.period_id)
                return (
                  <>
                    <p className="mt-1 text-[22px] font-semibold leading-tight">
                      {e.subject_name} · {e.class_name} {e.section_name}
                    </p>
                    <p className="mt-1 flex items-center gap-1.5 text-[13px] text-muted-foreground">
                      <Clock className="size-3.5" aria-hidden="true" />
                      {/* The line may wrap between its parts; the clock
                          reading may not break inside itself. */}
                      {p ? (
                        <>
                          {p.name} ·{' '}
                          <span className="num">{p.starts_at}–{p.ends_at}</span>
                        </>
                      ) : (
                        e.period_name
                      )}
                      {e.room ? ` · ${e.room}` : ''}
                    </p>
                  </>
                )
              })()}
            </div>
          )}

          <ol className="mt-6 divide-y rounded-[14px] border bg-card">
            {mine.map((e) => {
              const p = bell.get(e.period_id)
              const isNow = current?.id === e.id
              return (
                <li
                  key={e.id}
                  className={cn('flex items-center gap-4 px-5 py-3', isNow && 'bg-primary-soft')}
                >
                  {/* A period is one time, not two lines: overflow-wrap
                      breaks "09:00–09:45" at the dash once the column is
                      tight, and a clock reading is not a word. */}
                  <span className="w-24 shrink-0 whitespace-nowrap text-[12px] tabular-nums text-muted-foreground">
                    {p ? `${p.starts_at}–${p.ends_at}` : e.period_name}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{e.subject_name}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">
                      {e.class_name} {e.section_name}
                      {e.room ? ` · ${e.room}` : ''}
                    </span>
                  </span>
                  {isNow && (
                    <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground">
                      Now
                    </span>
                  )}
                </li>
              )
            })}
          </ol>
        </>
      )}

      <div className="mt-6 flex flex-wrap gap-4 text-[13px]">
        <NavLink className="underline" to={timetableHref}>My timetable</NavLink>
        <NavLink className="underline" to={workHref}>What is outstanding on me</NavLink>
      </div>
    </div>
  )
}
