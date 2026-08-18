import { useQuery } from '@tanstack/react-query'
import { CalendarDays, GraduationCap, PartyPopper, Users } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Select, Field,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
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

const LABEL: Record<string, string> = {
  ptm_booking: 'Your meeting',
  working_day: 'Working day',
  annual_day: 'Annual day',
  sports_day: 'Sports day',
  field_trip: 'Field trip',
}

function label(kind: string) {
  return LABEL[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, ' ')
}

function monthOf(iso: string) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso.slice(0, 7)
    : d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}

export default function Calendar() {
  const { children, studentId, chosen, setChosen } = useChildren()
  const query = useQuery({
    queryKey: ['portal-calendar', studentId],
    queryFn: () =>
      api.get<{ items: Entry[]; from: string; to: string }>(
        `/api/v1/portal/school-life/calendar${studentId ? `?student_id=${studentId}` : ''}`,
      ),
  })

  if (query.isLoading) return <Loading label="Looking up the calendar…" />
  if (query.error) return <ErrorState error={query.error} />

  const items = [...(query.data?.items ?? [])].sort((a, b) => a.date.localeCompare(b.date))
  const today = new Date().toISOString().slice(0, 10)
  const upcoming = items.filter((e) => (e.end_date ?? e.date) >= today)

  // Grouped by month rather than listed flat. Sixty rows of dates is a
  // spreadsheet; a parent reads the calendar to find the next thing.
  const months: { name: string; rows: Entry[] }[] = []
  for (const e of upcoming) {
    const name = monthOf(e.date)
    const last = months[months.length - 1]
    if (last && last.name === name) last.rows.push(e)
    else months.push({ name, rows: [e] })
  }

  return (
    <>
      <PageHead
        eyebrow="School life"
        title="Calendar"
        description="Holidays, examinations, events and the meetings you have booked."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Coming up" value={upcoming.length} icon={CalendarDays} />
          <Stat label="Examinations" value={upcoming.filter((e) => e.kind === 'exam').length} icon={GraduationCap} />
          <Stat
            label="Events"
            value={upcoming.filter((e) => !['exam', 'term', 'ptm', 'ptm_booking', 'holiday', 'vacation', 'working_day'].includes(e.kind)).length}
            icon={PartyPopper}
          />
          <Stat label="Your meetings" value={upcoming.filter((e) => e.kind === 'ptm_booking').length} icon={Users} />
        </CellGrid>

        {children.length > 1 && (
          <Card>
            <div className="px-5 py-4">
              <Field label="Child" hint="Events for a class are shown only for the child in it.">
                <Select
                  value={chosen}
                  onChange={setChosen}
                  options={[{ value: '', label: 'All my children' }, ...childOptions(children)]}
                />
              </Field>
            </div>
          </Card>
        )}

        {months.length === 0 ? (
          <Card>
            <EmptyState
              title="Nothing scheduled"
              body="When the school publishes holidays, examinations or events they will appear here."
            />
          </Card>
        ) : (
          months.map((m) => (
            <Card key={m.name}>
              <CardHeader title={m.name} description={`${m.rows.length} entries`} />
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
                    <Badge tone={TONE[e.kind] ?? 'info'}>{label(e.kind)}</Badge>
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
