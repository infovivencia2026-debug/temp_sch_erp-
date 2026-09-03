import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarDays, GraduationCap, Palmtree } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Field, Input,
  SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface Entry {
  on_date: string
  to_date?: string
  kind: string
  title: string
  detail?: string
  source: string
  all_day: boolean
  starts_at?: string
}
interface CalendarResponse {
  student_id: string
  class_name: string
  section_name: string
  items: Entry[]
}

const TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'primary'> = {
  term: 'neutral',
  holiday: 'success',
  vacation: 'success',
  exam: 'danger',
  event: 'primary',
  ptm: 'info',
  working_day: 'warning',
  club_event: 'info',
}
const LABEL: Record<string, string> = {
  term: 'Term',
  holiday: 'Holiday',
  vacation: 'Vacation',
  exam: 'Exam',
  event: 'School event',
  ptm: 'Parents evening',
  working_day: 'Working day',
  club_event: 'Club',
}

/* The year, as this child's own class will live it.

   Assembled from the four tables that already hold the school's year rather
   than from a calendar table of its own: terms, holidays, the exam timetable
   and the club diary. A fifth copy would be the one that still showed the old
   date after a paper moved.

   The exam papers are why it cannot be a school-wide feed. A Grade 6 child
   shown Grade 9's mathematics paper does not shrug — they revise from it. */
export default function Calendar() {
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const calendar = useQuery({
    queryKey: ['student-calendar', studentId, from, to],
    queryFn: () =>
      api.get<CalendarResponse>(
        `/api/v1/portal/calendar${studentQuery(
          studentId,
          from ? `from=${from}` : '',
          to ? `to=${to}` : '',
        )}`,
      ),
    enabled: ready,
  })

  if (calendar.isLoading && ready) return <SkeletonTiles count={3} label="Building your calendar…" />
  if (calendar.error) return <ErrorState error={calendar.error} />

  const rows = calendar.data?.items ?? []
  const exams = rows.filter((r) => r.kind === 'exam')
  const closures = rows.filter((r) => r.kind === 'holiday' || r.kind === 'vacation')
  const today = new Date().toISOString().slice(0, 10)
  const upcoming = rows.filter((r) => (r.to_date ?? r.on_date) >= today)

  // Grouped by day so a date is written once, however much falls on it.
  const byDay = new Map<string, Entry[]>()
  for (const e of rows) {
    const list = byDay.get(e.on_date) ?? []
    list.push(e)
    byDay.set(e.on_date, list)
  }

  return (
    <>
      <PageHead
        eyebrow="Notices and calendar"
        title="Calendar"
        description={
          calendar.data
            ? `Term dates, holidays, papers and events for ${calendar.data.class_name}-${calendar.data.section_name}.`
            : 'Term dates, holidays, papers and events for your class.'
        }
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState
            title="Choose a child"
            body="Exam dates differ by class, so the calendar is built per child."
          />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Still to come" value={upcoming.length} icon={CalendarDays}
                hint="From today onwards" />
              <Stat label="Papers scheduled" value={exams.length} icon={GraduationCap}
                hint="Your class only" />
              <Stat label="Closures" value={closures.length} icon={Palmtree} />
            </CellGrid>

            <Card>
              <CardHeader
                title="The year"
                description="Defaults to your own academic year. Narrow it if you want a single month."
                action={
                  <div className="flex flex-wrap gap-3">
                    <div className="w-40">
                      <Field label="From">
                        <Input value={from} onChange={setFrom} type="date" />
                      </Field>
                    </div>
                    <div className="w-40">
                      <Field label="To">
                        <Input value={to} onChange={setTo} type="date" />
                      </Field>
                    </div>
                  </div>
                }
              />
              {rows.length === 0 ? (
                <EmptyState
                  title="Nothing in this window"
                  body="No term dates, holidays, papers or events fall between those dates."
                />
              ) : (
                <ul className="divide-y">
                  {[...byDay.entries()].map(([day, entries]) => (
                    <li key={day} className="flex flex-wrap gap-4 px-5 py-3.5">
                      <div className="w-32 shrink-0">
                        <p className="text-[13px] font-medium">{formatDate(day)}</p>
                        {day < today && (
                          <p className="text-[12px] text-muted-foreground">past</p>
                        )}
                      </div>
                      <ul className="min-w-0 flex-1 space-y-1.5">
                        {entries.map((e, i) => (
                          <li key={`${e.title}-${i}`} className="flex flex-wrap items-baseline gap-2">
                            <Badge tone={TONE[e.kind] ?? 'neutral'}>
                              {LABEL[e.kind] ?? e.kind}
                            </Badge>
                            <span className="text-[14px]">{e.title}</span>
                            {e.starts_at && (
                              <span className="font-mono text-[12.5px] tabular-nums text-muted-foreground">
                                {e.starts_at}
                              </span>
                            )}
                            {e.to_date && e.to_date !== e.on_date && (
                              <span className="text-[12.5px] text-muted-foreground">
                                until {formatDate(e.to_date)}
                              </span>
                            )}
                            {e.detail && (
                              <span className="text-[12.5px] text-muted-foreground">{e.detail}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
