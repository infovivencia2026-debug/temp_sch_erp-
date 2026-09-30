import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import { PageHead, PageBody, Card, Select, Field, EmptyState } from '@/components/ui'
import { ScreenError } from './screen-error'
import { Freshness, ScreenSkeleton } from './screen-state'
import { cn } from '@/lib/utils'
import { useT, type MessageKey } from '@/lib/i18n'
import { useChildren, childOptions } from './use-children'

/* THE SCHOOL YEAR, AS A MONTH AND AS A LIST.
 *
 * A parent asking "what is on in March" does not know that a holiday, an
 * examination, a concert and their own booked meeting are four different
 * tables. The server merges them; this draws them.
 *
 * TWO LAYOUTS, ONE SCREEN, BECAUSE THE QUESTION CHANGES WITH THE DEVICE.
 *
 * At a desk the question is a shape -- does the fee fall in the same week as
 * the exams -- and only a month grid answers it. On a phone a six-by-seven
 * grid of 44px cells cannot hold a word, so the same grid becomes a strip of
 * the current week with a dot under the days that have something, and the
 * answer is an agenda underneath: the chosen day first, then the rest of the
 * month. Same data, same colours, same filter; the arrangement is what moves.
 *
 * COLOUR CARRIES THE KIND, AND SO DOES THE WORD. Every entry is tagged in
 * words as well as tinted, so the screen survives a cheap phone, a colour-blind
 * reader and a black-and-white print -- the tint is how you scan it, the word
 * is how you are sure.
 *
 * Booked meetings appear here but are not made here. Taking a slot is its own
 * screen: choosing a time is a task, reading the calendar is a glance.
 */

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

/* THE FIVE FAMILIES A PARENT ACTUALLY DISTINGUISHES.
 *
 * The feed returns a dozen kinds -- annual_day, sports_day, field_trip,
 * vacation, working_day and so on -- and a legend of twelve is a legend nobody
 * reads. These are the five a family sorts by: is the school shut, is there an
 * examination, must I attend, must I pay, is something happening. Every kind
 * lands in exactly one of them, and `event` is the catch-all rather than a
 * list that has to be kept in step with the server. */
type Family = 'holiday' | 'exam' | 'ptm' | 'fee' | 'event'

function familyOf(kind: string): Family {
  if (kind === 'holiday' || kind === 'vacation') return 'holiday'
  if (kind === 'exam') return 'exam'
  if (kind === 'ptm' || kind === 'ptm_booking') return 'ptm'
  if (kind === 'fee' || kind === 'fee_due' || kind === 'invoice') return 'fee'
  return 'event'
}

/* Tailwind cannot see a class name built at runtime, so each family names its
   classes in full. Written out once here rather than interpolated at four call
   sites, which is how a colour ends up right in the grid and missing on the
   card. */
const FAMILY: Record<Family, { label: string; rail: string; chip: string; dot: string; text: string }> = {
  holiday: {
    label: 'Holiday',
    rail: 'bg-emerald-600',
    chip: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
    dot: 'bg-emerald-600',
    text: 'text-emerald-700 dark:text-emerald-400',
  },
  exam: {
    label: 'Examination',
    rail: 'bg-red-600',
    chip: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
    dot: 'bg-red-600',
    text: 'text-red-700 dark:text-red-400',
  },
  ptm: {
    label: 'Meeting',
    rail: 'bg-violet-600',
    chip: 'bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300',
    dot: 'bg-violet-600',
    text: 'text-violet-700 dark:text-violet-400',
  },
  fee: {
    label: 'Fees',
    rail: 'bg-amber-600',
    chip: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
    dot: 'bg-amber-600',
    text: 'text-amber-700 dark:text-amber-400',
  },
  event: {
    label: 'Event',
    rail: 'bg-blue-600',
    chip: 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
    dot: 'bg-blue-600',
    text: 'text-blue-700 dark:text-blue-400',
  },
}

const ORDER: Family[] = ['holiday', 'exam', 'ptm', 'event', 'fee']

const KIND_LABEL: Record<string, MessageKey> = {
  ptm_booking: 'portal.calendar.kind_ptm_booking',
  working_day: 'portal.calendar.kind_working_day',
  annual_day: 'portal.calendar.kind_annual_day',
  sports_day: 'portal.calendar.kind_sports_day',
  field_trip: 'portal.calendar.kind_field_trip',
}

function kindLabel(kind: string, t: (key: MessageKey) => string) {
  const key = KIND_LABEL[kind]
  return key ? t(key) : kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, ' ')
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Monday-first index, because an Indian school week is read that way. */
const dow = (d: Date) => (d.getDay() + 6) % 7

const longDay = (isoDate: string) =>
  new Date(isoDate + 'T00:00:00').toLocaleDateString('en-IN',
    { weekday: 'long', day: 'numeric', month: 'long' })

const shortMonth = (isoDate: string) =>
  new Date(isoDate + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short' })

/** Does this entry cover that day? A span covers every day between its ends. */
const covers = (e: Entry, day: string) => day >= e.date && day <= (e.end_date ?? e.date)

/* The six weeks a month grid draws: from the Monday on or before the 1st to
   the Sunday on or after the last. Exactly what the feed must be asked for --
   an examination that began in late September is still drawn on the 1st of
   October, and asking only for the month returns an empty first row. */
function sixWeeks(year: number, month: number) {
  const first = new Date(year, month, 1)
  const start = new Date(year, month, 1 - dow(first))
  const days: Date[] = []
  for (let i = 0; i < 42; i++) days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
  return days
}

export default function Calendar() {
  const t = useT()
  const { children, studentId, chosen, setChosen } = useChildren()
  const today = iso(new Date())

  const [cursor, setCursor] = useState(() => {
    const d = new Date()
    return { y: d.getFullYear(), m: d.getMonth() }
  })
  const [picked, setPicked] = useState<string>(today)
  const [only, setOnly] = useState<Family | null>(null)

  const days = useMemo(() => sixWeeks(cursor.y, cursor.m), [cursor])
  const from = iso(days[0])
  const to = iso(days[41])

  const query = useQuery({
    queryKey: ['portal-calendar', studentId, from, to],
    queryFn: () =>
      api.get<{ items: Entry[] }>(
        `/api/v1/portal/school-life/calendar?student_id=${studentId ?? ''}&from=${from}&to=${to}`,
      ),
    /* The month you are looking at stays on screen while the next one loads,
       instead of the page dropping to a spinner on every arrow press. */
    placeholderData: (prev) => prev,
  })

  /* Moving to another month moves the chosen day with it, to that month's
     first day -- otherwise the agenda underneath still shows a day from the
     month you just left, under a heading naming the month you are now in. */
  useEffect(() => {
    const monthStart = `${cursor.y}-${String(cursor.m + 1).padStart(2, '0')}-01`
    setPicked((p) => (p.slice(0, 7) === monthStart.slice(0, 7)
      ? p
      : (today.slice(0, 7) === monthStart.slice(0, 7) ? today : monthStart)))
  }, [cursor, today])

  if (query.isLoading && !query.data) return <ScreenSkeleton label={t('portal.calendar.loading')} />
  if (query.error && !query.data) return <ScreenError error={query.error} />

  const all = [...(query.data?.items ?? [])].sort((a, b) => a.date.localeCompare(b.date))
  const items = only ? all.filter((e) => familyOf(e.kind) === only) : all

  const monthKey = `${cursor.y}-${String(cursor.m + 1).padStart(2, '0')}`
  const monthName = new Date(cursor.y, cursor.m, 1)
    .toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

  const counts = ORDER.map((f) => ({ f, n: all.filter((e) => familyOf(e.kind) === f).length }))
    .filter((x) => x.n > 0)

  /* The week the chosen day sits in: what the phone shows in place of the
     grid. Monday to Sunday, so it reads like the grid's rows do. */
  const pickedDate = new Date(picked + 'T00:00:00')
  const weekStart = new Date(pickedDate.getFullYear(), pickedDate.getMonth(), pickedDate.getDate() - dow(pickedDate))
  const week = Array.from({ length: 7 }, (_, i) =>
    new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i))

  const onPicked = items.filter((e) => covers(e, picked))
  /* Everything else this month, after the chosen day. The agenda answers "what
     is today" and then "what is next", which is the order a parent asks in. */
  const later = items
    .filter((e) => e.date.slice(0, 7) === monthKey && e.date > picked)
    .sort((a, b) => a.date.localeCompare(b.date))

  const step = (n: number) =>
    setCursor((c) => {
      const d = new Date(c.y, c.m + n, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })

  const goToday = () => {
    const d = new Date()
    setCursor({ y: d.getFullYear(), m: d.getMonth() })
    setPicked(today)
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

        {/* THE MONTH, AND WHICH WAY TO IT.

            One row: the month on the left, back / today / forward on the
            right, so the two things a parent does here are never more than a
            thumb apart. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[19px] font-bold tracking-[-0.02em]">{monthName}</h2>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => step(-1)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={goToday}
              className="inline-flex h-9 items-center rounded-full border bg-card px-3.5 text-[13px] font-semibold shadow-sm transition-colors hover:bg-accent"
            >
              Today
            </button>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => step(1)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* THE LEGEND IS THE FILTER.

            A legend that only explains the colours asks a parent to hold five
            meanings in their head and then scan for one of them by eye. The
            same row does the scanning: press "Examination" and the month keeps
            only those. Press it again for everything. Counts are of the month
            on screen, so a family with nothing of that kind this month is not
            offered the chip at all. */}
        {counts.length > 0 && (
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            <button
              type="button"
              onClick={() => setOnly(null)}
              aria-pressed={only === null}
              className={cn(
                'shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition-colors',
                only === null ? 'bg-primary/15 text-primary font-semibold' : 'bg-muted text-muted-foreground hover:text-foreground',
              )}
            >
              All {all.length}
            </button>
            {counts.map(({ f, n }) => (
              <button
                key={f}
                type="button"
                onClick={() => setOnly(only === f ? null : f)}
                aria-pressed={only === f}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition-colors',
                  only === f ? 'bg-primary/15 text-primary font-semibold' : 'bg-muted text-muted-foreground hover:text-foreground',
                )}
              >
                <span className={cn('h-2 w-2 rounded-full', FAMILY[f].dot)} />
                {FAMILY[f].label} {n}
              </button>
            ))}
          </div>
        )}

        {/* THE MONTH GRID -- from a tablet upward.

            Below that it is six rows of seven 44px cells, which cannot hold a
            word, so the phone gets the week strip underneath instead. Drawing
            both and hiding one costs nothing: they read the same arrays. */}
        <Card className="hidden overflow-hidden p-0 md:block">
          <div className="grid grid-cols-7 border-b bg-surface-sunken/60 text-center text-[11px] font-bold uppercase tracking-[0.05em] text-muted-foreground">
            {WEEK.map((d) => <div key={d} className="py-2.5">{d}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {days.map((d) => {
              const day = iso(d)
              const outside = d.getMonth() !== cursor.m
              const weekend = dow(d) >= 5
              const on = items.filter((e) => covers(e, day))
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => setPicked(day)}
                  className={cn(
                    'flex min-h-[104px] flex-col items-stretch gap-1 border-b border-r p-2 text-left transition-colors last:border-r-0',
                    outside ? 'bg-surface-sunken/40 opacity-45' : weekend ? 'bg-surface-sunken/30' : 'bg-card',
                    picked === day && 'ring-2 ring-inset ring-primary',
                    'hover:bg-accent/40',
                  )}
                >
                  <span
                    className={cn(
                      'grid h-[22px] w-[22px] place-items-center rounded-full text-[12.5px] font-semibold',
                      day === today ? 'bg-primary/15 text-primary font-semibold' : 'text-foreground',
                    )}
                  >
                    {d.getDate()}
                  </span>
                  {on.slice(0, 3).map((e, i) => (
                    <span
                      key={`${e.ref_id ?? e.title}-${i}`}
                      title={e.title}
                      className={cn(
                        'truncate rounded px-1.5 py-[3px] text-[11px] font-semibold',
                        FAMILY[familyOf(e.kind)].chip,
                      )}
                    >
                      {e.title}
                    </span>
                  ))}
                  {on.length > 3 && (
                    <span className="px-1 text-[10.5px] font-semibold text-muted-foreground">
                      +{on.length - 3} more
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </Card>

        {/* THE WEEK STRIP -- the phone's grid.

            Seven days, the chosen one filled, and a dot under any day that has
            something on it. A dot rather than the entry itself: the entry is
            three words at least and the cell is a thumb wide, so the strip
            says WHERE to look and the agenda below says what. */}
        <Card className="overflow-hidden p-0 md:hidden">
          <div className="flex justify-between gap-1 px-3 py-3">
            {week.map((d) => {
              const day = iso(d)
              const on = items.filter((e) => covers(e, day))
              const sel = picked === day
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => setPicked(day)}
                  aria-pressed={sel}
                  className={cn(
                    'flex w-11 flex-col items-center gap-1.5 rounded-xl py-2 transition-colors',
                    sel ? 'bg-primary/15 text-primary font-semibold' : 'hover:bg-muted',
                  )}
                >
                  <span className={cn('text-[10.5px] font-bold uppercase',
                    sel ? 'text-background/70' : 'text-muted-foreground')}>
                    {WEEK[dow(d)]}
                  </span>
                  <span className={cn('text-[15px] font-bold tabular-nums',
                    !sel && day === today && 'text-primary')}>
                    {d.getDate()}
                  </span>
                  <span
                    className={cn('h-1 w-1 rounded-full',
                      on.length === 0 ? 'bg-transparent'
                        : sel ? 'bg-background'
                        : FAMILY[familyOf(on[0].kind)].dot)}
                  />
                </button>
              )
            })}
          </div>
        </Card>

        {/* THE AGENDA.

            The chosen day, then the rest of the month. On a phone this is the
            screen; on a desk it is what the grid hands you when you press a
            square. Either way it is where the detail lives -- the time, the
            venue, whose child it is -- because none of that fits in a cell. */}
        <div className="flex flex-col gap-3">
          <h3 className="text-[12px] font-bold uppercase tracking-[0.06em] text-muted-foreground">
            {picked === today ? 'Today · ' : ''}{longDay(picked)}
          </h3>
          {onPicked.length === 0 ? (
            <Card>
              <div className="px-5 py-6 text-[13.5px] text-muted-foreground">
                {only
                  ? 'Nothing of that kind on this day. Press the chip again for everything.'
                  : 'Nothing on this day.'}
              </div>
            </Card>
          ) : (
            onPicked.map((e, i) => <EventCard key={`p${e.ref_id ?? e.title}${i}`} e={e} t={t} />)
          )}

          {later.length > 0 && (
            <>
              <h3 className="mt-2 text-[12px] font-bold uppercase tracking-[0.06em] text-muted-foreground">
                Later in {new Date(cursor.y, cursor.m, 1).toLocaleDateString('en-IN', { month: 'long' })}
              </h3>
              {later.map((e, i) => <EventCard key={`l${e.ref_id ?? e.title}${i}`} e={e} t={t} />)}
            </>
          )}

          {all.length === 0 && (
            <Card>
              <EmptyState
                title={t('portal.calendar.empty_title')}
                body={t('portal.calendar.empty_body')}
              />
            </Card>
          )}
        </div>

      </PageBody>
    </>
  )
}

/* One entry, as a card: the date blocked on the left, the kind in its colour,
   the title, and everything else -- time, venue, which child -- on one line
   under it. The coloured rail down the left edge is what makes a column of
   these scannable without reading a word of it. */
function EventCard({ e, t }: { e: Entry; t: ReturnType<typeof useT> }) {
  const f = FAMILY[familyOf(e.kind)]
  const span = e.end_date && e.end_date !== e.date
  const meta = [e.starts_at, e.venue, e.detail, e.student_name].filter(Boolean).join(' · ')
  return (
    <div className="relative flex gap-3.5 overflow-hidden rounded-2xl border bg-card p-4">
      <span className={cn('absolute inset-y-3.5 left-0 w-1 rounded-r', f.rail)} />
      <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border bg-surface-sunken">
        <span className="text-[16px] font-extrabold leading-none tabular-nums">{e.date.slice(8, 10)}</span>
        <span className="mt-0.5 text-[9px] font-bold uppercase text-muted-foreground">{shortMonth(e.date)}</span>
      </div>
      <div className="min-w-0 flex-1">
        <span className={cn('text-[10px] font-bold uppercase tracking-[0.03em]', f.text)}>
          {kindLabel(e.kind, t)}
        </span>
        <div className="text-[14px] font-bold leading-snug">{e.title}</div>
        {span && (
          <div className="text-[12px] text-muted-foreground">
            Until {longDay(e.end_date!)}
          </div>
        )}
        {meta && <div className="text-[12px] text-muted-foreground">{meta}</div>}
      </div>
    </div>
  )
}
