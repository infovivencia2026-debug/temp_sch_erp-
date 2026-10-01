import { useQuery } from '@tanstack/react-query'
import { NavLink } from 'react-router-dom'
import { api } from '@/lib/api'
import { featurePath } from '@/lib/catalog'
import { Loading, ErrorState, EmptyState } from '@/components/ui'
import { useSession } from '@/lib/session'
import type { List, Section } from '@/lib/api'
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
    queryFn: () => api.call('GET /timetable/periods'),
  })
  const session = useSession()
  const sections = useQuery({
    queryKey: ['academics', 'sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })
  const entries = useQuery({
    queryKey: ['timetable', 'me'],
    queryFn: () => api.call('GET /timetable/entries', { query: { teacher_id: 'me' } }),
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

  /* THE OWNER'S LAYOUT: a greeting with today's date, the lesson in session
     (or the next one) as a card on the left, the day's lessons on the right
     -- done, now, upcoming -- and three figures underneath. */
  const hour = new Date().getHours()
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const first = (session.user?.full_name ?? '').split(/\s+/)[0]
  const dateBadge = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })
  const ownSections = [...new Set((entries.data?.items ?? []).map((e) => e.section_id).filter(Boolean))]
  const todaysSections = new Set(mine.map((e) => e.section_id))
  const students = (sections.data?.items ?? [])
    .filter((x) => ownSections.includes(x.id))
    .reduce((n, x) => n + (x.enrolled ?? 0), 0)
  const done = mine.filter((e) => { const p = bell.get(e.period_id); return p && minutesInto(p.ends_at) <= nowMin }).length
  const upcoming = mine.filter((e) => { const p = bell.get(e.period_id); return p && minutesInto(p.starts_at) > nowMin }).length
  const focus = current ?? next
  const focusP = focus ? bell.get(focus.period_id) : undefined
  const after = focus ? mine[mine.indexOf(focus) + 1] : undefined
  const afterP = after ? bell.get(after.period_id) : undefined
  const span = (p?: { starts_at: string; ends_at: string }) => p ? `${p.starts_at.slice(0, 5)} – ${p.ends_at.slice(0, 5)}` : ''

  return (
    <div className="mx-auto flex max-w-[980px] flex-col gap-7 px-4 pb-16 pt-8 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-bold tracking-[-0.02em]">{greet}{first ? `, ${first}` : ''}</h1>
          <p className="mt-1 text-[14px] text-muted-foreground">
            {mine.length === 0 ? 'Nothing is timetabled for you today.' : `${mine.length} ${mine.length === 1 ? 'lesson' : 'lessons'} on your timetable today.`}
          </p>
        </div>
        <span className="rounded-full border bg-card px-3.5 py-1.5 text-[13px] font-medium text-muted-foreground shadow-sm">{dateBadge}</span>
      </header>

      {mine.length === 0 ? (
        <EmptyState
          title="No lessons timetabled today"
          body={weekday >= 6
            ? 'Today is the weekend. Your full week is on the timetable.'
            : 'If that is wrong, the timetable for your subjects may not be published yet; your whole week is on My timetable.'}
        />
      ) : (
        <section className="grid items-stretch gap-5 md:grid-cols-[320px_1fr]">
          <aside className="flex flex-col justify-between rounded-[20px] border bg-card px-6 py-7 shadow-sm">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[11.5px] font-semibold uppercase tracking-[0.05em] text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              {current ? 'Now in session' : next ? 'Up next' : 'Day complete'}
            </span>
            <div className="my-8">
              {focus ? (
                <>
                  <h2 className="text-[24px] font-bold leading-tight tracking-[-0.02em]">
                    {focus.subject_name}<br />{focus.class_name} {focus.section_name}
                  </h2>
                  <p className="mt-2 text-[14px] text-muted-foreground">
                    {focusP?.name ?? focus.period_name}{focusP ? ` · ${span(focusP)}` : ''}
                  </p>
                </>
              ) : (
                <h2 className="text-[22px] font-bold leading-tight">All {mine.length} lessons done</h2>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 border-t pt-4">
              <div>
                <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground/80">Room</span>
                <strong className="mt-0.5 block text-[15px] font-semibold">{focus?.room || '-'}</strong>
              </div>
              <div className="text-right">
                <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground/80">Next up</span>
                <strong className="mt-0.5 block text-[15px] font-semibold">
                  {after ? `${after.class_name} ${after.section_name}${afterP ? ` (${afterP.starts_at.slice(0, 5)})` : ''}` : '-'}
                </strong>
              </div>
            </div>
          </aside>

          <section className="flex flex-col rounded-[20px] border bg-card px-5 py-6 shadow-sm sm:px-7">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-[14px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Today's classes</h3>
              <span className="text-[13px] text-muted-foreground/80">{mine.length} {mine.length === 1 ? 'period' : 'periods'} total</span>
            </div>
            <div className="flex flex-col gap-2">
              {mine.map((e) => {
                const p = bell.get(e.period_id)
                const isNow = current?.id === e.id
                const isDone = !!p && minutesInto(p.ends_at) <= nowMin
                return (
                  <div key={e.id}
                    className={cn('flex items-center justify-between gap-3 rounded-xl border px-4 py-3.5 transition-colors',
                      isNow ? 'border-primary/30 bg-primary/10' : 'border-border/60 bg-muted/30 hover:bg-muted/60')}>
                    <div className="flex min-w-0 items-center gap-5">
                      <span className={cn('min-w-[95px] whitespace-nowrap text-[13px] font-semibold tabular-nums', isNow ? 'text-primary' : 'text-muted-foreground')}>
                        {p ? span(p) : e.period_name}
                      </span>
                      <div className="min-w-0">
                        <h4 className="truncate text-[14.5px] font-semibold">{e.subject_name} · {e.class_name} {e.section_name}</h4>
                        <p className="truncate text-[12.5px] text-muted-foreground">{p?.name ?? e.period_name}{e.room ? ` • ${e.room}` : ''}</p>
                      </div>
                    </div>
                    <span className={cn('shrink-0 text-[11.5px]', isNow ? 'font-semibold text-primary' : 'font-medium text-muted-foreground/80')}>
                      {isNow ? 'Active now' : isDone ? 'Completed' : 'Upcoming'}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>
        </section>
      )}

      <footer className="grid gap-4 sm:grid-cols-3">
        {[
          ['Classes today', String(mine.length), `Across ${todaysSections.size} ${todaysSections.size === 1 ? 'section' : 'sections'}`],
          ['Total students', String(students), 'Enrolled in your sections'],
          ['Daily progress', `${done} / ${mine.length}`, `${current ? 1 : 0} ongoing, ${upcoming} upcoming`],
        ].map(([t, v, sub]) => (
          <div key={t} className="rounded-xl border bg-card px-5 py-4 shadow-sm">
            <div className="text-[12px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">{t}</div>
            <div className="mb-0.5 mt-1 text-[24px] font-bold tracking-[-0.02em]">{v}</div>
            <div className="text-[12.5px] text-muted-foreground">{sub}</div>
          </div>
        ))}
      </footer>

      <div className="flex flex-wrap gap-4 text-[13px]">
        <NavLink className="underline" to={timetableHref}>My timetable</NavLink>
        <NavLink className="underline" to={workHref}>What is outstanding on me</NavLink>
      </div>
    </div>
  )
}
