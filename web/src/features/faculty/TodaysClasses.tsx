import { useQuery } from '@tanstack/react-query'
import { NavLink } from 'react-router-dom'
import { api } from '@/lib/api'
import { featurePath } from '@/lib/catalog'
import { Card, Loading, ErrorState, EmptyState, PageBody } from '@/components/ui'
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

  const subjectsToday = [...new Set(mine.map((e) => e.subject_name).filter(Boolean))]
  return (
    /* THE OWNER'S WEB LAYOUT: a greeting card across the top, then three
       columns -- the lesson in session, the day's lessons, and an overview
       with the figures and the two ways onward as buttons. Drawn in the
       ERP's own cards and the school's colour, so it sits with every other
       screen. One column on a phone. */
    <PageBody top><div className="flex flex-col gap-5">
      <Card className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
        <div className="min-w-0">
          <h1 className="text-[24px] font-bold tracking-[-0.02em]">{greet}{first ? `, ${first}` : ''}</h1>
          <p className="text-[14px] text-muted-foreground">
            {mine.length === 0 ? 'Nothing is timetabled for you today' : `${mine.length} ${mine.length === 1 ? 'lesson' : 'lessons'} scheduled on your timetable today`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border bg-card px-3.5 py-1.5 text-[13px] font-medium text-muted-foreground">{dateBadge}</span>
          {subjectsToday.length > 0 && (
            <span className="rounded-full border bg-card px-3.5 py-1.5 text-[13px] font-medium text-muted-foreground">Faculty: {subjectsToday.join(', ')}</span>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-[minmax(0,1fr)] items-stretch gap-5 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,2fr)_minmax(0,0.95fr)]">
        <Card className="flex flex-col justify-between border-primary/25 bg-gradient-to-b from-card to-primary/[0.06] px-6 py-6">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[11.5px] font-bold uppercase tracking-[0.05em] text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              {current ? 'Now in session' : next ? 'Up next' : 'Day complete'}
            </span>
            {focusP && <span className="text-[13px] text-muted-foreground">{focusP.name}</span>}
          </div>
          <div className="my-8">
            {focus ? (
              <>
                <h2 className="text-[32px] font-bold leading-tight tracking-[-0.02em]">{focus.subject_name}</h2>
                <p className="text-[19px] font-semibold text-primary">{focus.class_name} {focus.section_name}</p>
                {focusP && <p className="mt-1 text-[15px] text-muted-foreground">{span(focusP)}</p>}
              </>
            ) : (
              <h2 className="text-[22px] font-bold leading-tight">{mine.length ? `All ${mine.length} classes done` : 'No classes today'}</h2>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 border-t pt-4">
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Room</span>
              <strong className="mt-0.5 block text-[16px] font-semibold">{focus?.room || '-'}</strong>
            </div>
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Next up</span>
              <strong className="mt-0.5 block text-[16px] font-semibold">
                {after ? `${after.class_name} ${after.section_name}${afterP ? ` (${afterP.starts_at.slice(0, 5)})` : ''}` : '-'}
              </strong>
            </div>
          </div>
        </Card>

        <Card className="px-6 py-5">
          <div className="mb-4 flex items-center justify-between border-b pb-3">
            <h3 className="text-[16px] font-bold">Today's classes</h3>
            <span className="text-[13px] text-muted-foreground">{mine.length} {mine.length === 1 ? 'period' : 'periods'} total</span>
          </div>
          {mine.length === 0 ? (
            <EmptyState
              title="No lessons timetabled today"
              body={weekday >= 6
                ? 'Today is the weekend. Your full week is on the timetable.'
                : 'If that is wrong, the timetable for your subjects may not be published yet; your whole week is on My timetable.'}
            />
          ) : (
            <div className="flex flex-col gap-2.5">
              {mine.map((e) => {
                const p = bell.get(e.period_id)
                const isNow = current?.id === e.id
                const isDone = !!p && minutesInto(p.ends_at) <= nowMin
                return (
                  <div key={e.id}
                    className={cn('flex items-center justify-between gap-3 rounded-xl border px-5 py-4 transition-colors',
                      isNow ? 'border-primary/40 bg-primary/[0.07] shadow-sm' : 'bg-muted/30 hover:bg-muted/60')}>
                    <div className="flex min-w-0 items-center gap-6">
                      <span className={cn('min-w-[100px] whitespace-nowrap text-[14px] font-semibold tabular-nums', isNow ? 'text-primary' : 'text-muted-foreground')}>
                        {p ? span(p) : e.period_name}
                      </span>
                      <div className="min-w-0">
                        <h4 className="truncate text-[15px] font-semibold">{e.subject_name} · {e.class_name} {e.section_name}</h4>
                        <p className="truncate text-[13px] text-muted-foreground">{p?.name ?? e.period_name}{e.room ? ` • ${e.room}` : ''}</p>
                      </div>
                    </div>
                    <span className={cn('shrink-0 text-[13px]', isNow ? 'font-semibold text-primary' : isDone ? 'text-muted-foreground' : 'font-medium text-foreground/70')}>
                      {isNow ? 'Active now' : isDone ? 'Completed' : 'Upcoming'}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        <Card className="flex flex-col gap-3 px-6 py-5">
          <h3 className="text-[16px] font-bold">Overview</h3>
          {[
            ['Daily progress', `${done} / ${mine.length}`, `${current ? 1 : 0} ongoing, ${upcoming} upcoming`],
            ['Total students', String(students), 'Enrolled in your sections'],
            ['Classes today', String(mine.length), `Across ${todaysSections.size} ${todaysSections.size === 1 ? 'section' : 'sections'}`],
          ].map(([t, v, sub]) => (
            <div key={t} className="rounded-xl border bg-muted/30 px-5 py-4">
              <div className="text-[12px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">{t}</div>
              <div className="mt-1 text-[24px] font-bold tracking-[-0.02em]">{v}</div>
              <div className="text-[13px] text-muted-foreground">{sub}</div>
            </div>
          ))}
          {[
            ['My timetable', timetableHref],
            ['What is outstanding on me', workHref],
          ].map(([label, to]) => (
            <NavLink key={label} to={to}
              className="flex items-center justify-between rounded-xl border bg-card px-4 py-3 text-[14px] font-semibold transition-colors hover:border-primary/40 hover:bg-primary/[0.06] hover:text-primary">
              {label} <span aria-hidden>→</span>
            </NavLink>
          ))}
        </Card>
      </div>
    </div></PageBody>
  )
}
