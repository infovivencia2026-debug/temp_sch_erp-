import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarDays, GraduationCap, PartyPopper, Users } from 'lucide-react'
import { api } from '@/lib/api'
import { MonthGrid } from '../shared/MonthGrid'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Select, Field,
  EmptyState,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import { Freshness, ScreenSkeleton } from './screen-state'
import { formatDate } from '@/lib/utils'
import { useT, type MessageKey } from '@/lib/i18n'
import { useChildren, childOptions } from './use-children'

/* The school year on one page.

   A parent asking "what is on in March" does not know that a holiday, an
   examination, a concert and their own booked meeting are four different
   tables, and a screen that fetched them separately would stack them in four
   boxes that scroll independently. The server merges them; this groups the
   result by month and gets out of the way.

   Booked meetings appear here but are not managed here. Taking a slot is its
   own screen with its own catalogue entry, because choosing a time is a task
   and reading the calendar is a glance. */

/* What each card counts, said once.

   These were three inline predicates — one of them a seven-item exclusion list
   — so a card and the list it stands over could disagree about what an event
   is, and the day somebody adds a kind they would. */
const isExam = (e: { kind: string }) => e.kind === 'exam'
const isMeeting = (e: { kind: string }) => e.kind === 'ptm_booking'
const isEvent = (e: { kind: string }) =>
  !['exam', 'term', 'ptm', 'ptm_booking', 'holiday', 'vacation', 'working_day'].includes(e.kind)

type CalendarView = 'all' | 'exam' | 'event' | 'meeting'

interface Entry {
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

const TONE: Record<string, 'danger' | 'warning' | 'success' | 'info' | 'primary' | 'neutral'> = {
  exam: 'danger',
  ptm: 'warning',
  ptm_booking: 'primary',
  holiday: 'success',
  vacation: 'success',
  term: 'neutral',
  working_day: 'neutral',
}

const LABEL: Record<string, MessageKey> = {
  ptm_booking: 'portal.calendar.kind_ptm_booking',
  working_day: 'portal.calendar.kind_working_day',
  annual_day: 'portal.calendar.kind_annual_day',
  sports_day: 'portal.calendar.kind_sports_day',
  field_trip: 'portal.calendar.kind_field_trip',
}

function label(kind: string, t: (key: MessageKey) => string) {
  const key = LABEL[kind]
  return key ? t(key) : kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, ' ')
}

function monthOf(iso: string) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso.slice(0, 7)
    : d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}

export default function Calendar() {
  const t = useT()
  const { children, studentId, chosen, setChosen } = useChildren()
  const [view, setView] = useState<CalendarView>('all')

  /* The window the grid is showing, which the grid itself decides.

     The feed defaults to thirty days back and a hundred and twenty forward.
     That is the right default for the list -- a parent wants what is next --
     but it is the wrong thing to hand a grid somebody can page: March of last
     year would have come back empty and read as "nothing happened", which is
     a lie the screen tells confidently. So the grid says which six weeks it is
     drawing and the query follows it. */
  const [range, setRange] = useState<{ from: string; to: string } | null>(null)
  const span = range ? `&from=${range.from}&to=${range.to}` : ''

  const query = useQuery({
    queryKey: ['portal-calendar', studentId, range?.from, range?.to],
    queryFn: () =>
      api.get<{ items: Entry[]; from: string; to: string }>(
        `/api/v1/portal/school-life/calendar?student_id=${studentId ?? ''}${span}`,
      ),
    // The previous month stays on screen while the next one loads, instead of
    // the whole page dropping to a spinner on every arrow press.
    placeholderData: (prev) => prev,
  })

  // Only the very first load blanks the page; a month change is drawn by the
  // grid's own dimming, so the screen does not flash on every arrow press.
  if (query.isLoading) return <ScreenSkeleton label={t('portal.calendar.loading')} />
  if (query.error && !query.data) return <ScreenError error={query.error} />

  const items = [...(query.data?.items ?? [])].sort((a, b) => a.date.localeCompare(b.date))
  const today = new Date().toISOString().slice(0, 10)
  const upcoming = items.filter((e) => (e.end_date ?? e.date) >= today)

  /* The three kinds the cards count, defined once.

     They were three different inline predicates — one of them a seven-item
     exclusion list — so a card and the list it stands over could disagree
     about what an event is, and the day somebody added a kind they would. */
  const shown = view === 'all' ? upcoming : upcoming.filter(
    view === 'exam' ? isExam : view === 'event' ? isEvent : isMeeting,
  )

  // Grouped by month rather than listed flat. Sixty rows of dates is a
  // spreadsheet; a parent reads the calendar to find the next thing.
  const months: { name: string; rows: Entry[] }[] = []
  for (const e of shown) {
    const name = monthOf(e.date)
    const last = months[months.length - 1]
    if (last && last.name === name) last.rows.push(e)
    else months.push({ name, rows: [e] })
  }

  return (
    <>
      <PageHead
        eyebrow={t('portal.calendar.eyebrow')}
        title={t('portal.calendar.title')}
        description={t('portal.calendar.description')}
      />
      <Freshness query={query} />
      <PageBody>
        {/* The month first, the list under it.

            A parent opens this to find out whether a fee falls in the same
            week as an exam, and the answer to that is a shape, not a sorted
            list. The grid reads `items` -- every entry the feed returned, not
            just the upcoming ones the cards count -- so a date already past is
            still on the calendar it happened in. */}
        <MonthGrid
          entries={items}
          loading={query.isFetching}
          onRange={(from, to) => setRange({ from, to })}
          description="Exams, homework due, fees due, holidays and meetings. A day the school is closed is shaded."
        />

        {/* The cards are the filter.

            "Examinations 1" said there was one and not which one, and the
            entry was somewhere in a list below sorted by month. The card
            already knows exactly which rows it counted, so pressing it shows
            them — one click instead of a scroll and a scan. Pressing it again
            goes back to everything. */}
        <CellGrid cols={4}>
          <Stat
            label={t('portal.calendar.stat_coming_up')}
            value={upcoming.length}
            icon={CalendarDays}
            active={view === 'all'}
            onClick={() => setView('all')}
          />
          <Stat
            label={t('portal.calendar.stat_examinations')}
            value={upcoming.filter(isExam).length}
            icon={GraduationCap}
            active={view === 'exam'}
            onClick={() => setView(view === 'exam' ? 'all' : 'exam')}
          />
          <Stat
            label={t('portal.calendar.stat_events')}
            value={upcoming.filter(isEvent).length}
            icon={PartyPopper}
            active={view === 'event'}
            onClick={() => setView(view === 'event' ? 'all' : 'event')}
          />
          <Stat
            label={t('portal.calendar.stat_your_meetings')}
            value={upcoming.filter(isMeeting).length}
            icon={Users}
            active={view === 'meeting'}
            onClick={() => setView(view === 'meeting' ? 'all' : 'meeting')}
          />
        </CellGrid>

        {children.length > 1 && (
          <Card>
            <div className="px-5 py-4">
              <Field label={t('portal.calendar.field_child')} hint={t('portal.calendar.field_child_hint')}>
                <Select
                  value={chosen}
                  onChange={setChosen}
                  options={[{ value: '', label: t('portal.calendar.all_children') }, ...childOptions(children)]}
                />
              </Field>
            </div>
          </Card>
        )}

        {months.length === 0 ? (
          <Card>
            {/* A filter that hides everything must say it is a filter, or the
                parent reads "nothing coming up" and believes the school has
                nothing planned. */}
            <EmptyState
              title={
                view === 'all'
                  ? t('portal.calendar.empty_title')
                  : 'Nothing of that kind coming up'
              }
              body={
                view === 'all'
                  ? t('portal.calendar.empty_body')
                  : 'Press the same card again, or “Coming up”, to see everything.'
              }
            />
          </Card>
        ) : (
          months.map((m) => (
            <Card key={m.name}>
              <CardHeader
                title={m.name}
                description={t('portal.calendar.entry_count', { count: m.rows.length })}
              />
              <ul className="divide-y">
                {m.rows.map((e, i) => (
                  <li key={`${e.ref_id ?? e.title}-${i}`} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3">
                    <span className="w-32 shrink-0 text-[13px] text-muted-foreground">
                      {formatDate(e.date)}
                      {e.end_date && e.end_date !== e.date && ` – ${formatDate(e.end_date)}`}
                    </span>
                    <span className="min-w-0 flex-1 text-[14px]">
                      {e.title}
                      {e.student_name && (
                        <span className="text-muted-foreground"> · {e.student_name}</span>
                      )}
                      {(e.starts_at || e.venue || e.detail) && (
                        <span className="block text-[13px] text-muted-foreground">
                          {[e.starts_at, e.venue, e.detail].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </span>
                    <Badge tone={TONE[e.kind] ?? 'info'}>{label(e.kind, t)}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          ))
        )}
      </PageBody>
    </>
  )
}
