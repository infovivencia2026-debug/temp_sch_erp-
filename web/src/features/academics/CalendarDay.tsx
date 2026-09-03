import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarClock } from 'lucide-react'
import { api } from '@/lib/api'
import { Card, CardHeader, Table, Td, Badge, Input, Reload, SkeletonTable, ErrorState, EmptyState } from '@/components/ui'

/* The day, rather than the year.

   The calendar above says the school is open on Wednesday. This says what
   Wednesday is: which periods ring, what is taught in them, who teaches it,
   who is standing in, and what the lesson plan for that period says. All of it
   already existed on three separate screens; the server joins it and this
   reads the join.

   A period with no lesson plan shows the gap plainly rather than hiding the
   row. An unplanned lesson is the thing a head of department opens this page
   to find. */

interface Lesson {
  id: string
  status: string
  week_of: string
  teaching_day?: number
  objectives?: string
  activities?: string
  resources?: string
  homework?: string
  delivered_on?: string
}

interface Period {
  period_id: string
  name: string
  sequence: number
  starts_at: string
  ends_at: string
  is_break: boolean
  entry_id?: string
  class?: string
  section?: string
  subject?: string
  teacher?: string
  room?: string
  substitute?: string
  substitute_reason?: string
  lesson?: Lesson
}

interface DayResponse {
  date: string
  open: boolean
  reason?: string | null
  almanac: { id: string; source: string; name: string; kind: string }[]
  periods: Period[]
  summary: { periods_taught: number; periods_planned: number }
}

const PLAN_TONE: Record<string, 'neutral' | 'warning' | 'success' | 'info'> = {
  draft: 'neutral',
  submitted: 'info',
  approved: 'success',
  returned: 'warning',
}

const today = () => new Date().toISOString().slice(0, 10)

export default function CalendarDay() {
  const [date, setDate] = useState(today)

  const day = useQuery({
    queryKey: ['calendar-day', date],
    queryFn: () => api.get<DayResponse>(`/api/v1/academics/admin/calendar/day?date=${date}`),
  })

  const d = day.data
  const taught = d?.summary.periods_taught ?? 0
  const planned = d?.summary.periods_planned ?? 0

  return (
    <Card>
      <CardHeader
        title="The day"
        description="Periods, who teaches them and the lesson plan for each — the timetable, the plan and the almanac read together."
        action={
          <div className="flex items-center gap-2">
            <Input type="date" value={date} onChange={setDate} className="w-auto" />
            <Reload onClick={() => day.refetch()} busy={day.isFetching} label="Re-read this day" />
          </div>
        }
      />

      {day.isLoading && <SkeletonTable columns={5} label="Reading the day…" />}
      {day.error && <ErrorState error={day.error} />}

      {d && (
        <>
          <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-[13px]">
            {d.open ? (
              <Badge tone="success">School open</Badge>
            ) : (
              <Badge tone="danger">Shut{d.reason ? ` — ${d.reason}` : ''}</Badge>
            )}
            {d.almanac
              .filter((a) => a.source !== 'calendar' || a.kind !== 'working_day')
              .map((a) => (
                <Badge key={`${a.source}-${a.id}`} tone={a.source === 'term' ? 'neutral' : 'info'}>
                  {a.name}
                </Badge>
              ))}
            {taught > 0 && (
              <span className="text-muted-foreground">
                {planned} of {taught} periods planned
              </span>
            )}
          </div>

          {d.periods.length === 0 ? (
            <EmptyState
              title="Nothing timetabled on this date"
              body={
                d.open
                  ? 'No periods are scheduled for this weekday. Set the timetable first and the day fills itself in.'
                  : 'The school is shut, so no periods ring.'
              }
            />
          ) : (
            <Table head={['Period', 'Class', 'Subject', 'Teacher', 'Lesson plan']}>
              {d.periods.map((p) => (
                <tr key={`${p.period_id}-${p.entry_id ?? 'break'}`}>
                  <Td className="whitespace-nowrap font-medium">
                    {p.name}
                    <span className="block text-[12px] text-muted-foreground">
                      {p.starts_at}–{p.ends_at}
                    </span>
                  </Td>
                  {p.is_break && !p.entry_id ? (
                    <Td colSpan={4} className="text-muted-foreground">
                      Break
                    </Td>
                  ) : (
                    <>
                      <Td className="whitespace-nowrap">
                        {p.class} {p.section}
                        {p.room && (
                          <span className="block text-[12px] text-muted-foreground">{p.room}</span>
                        )}
                      </Td>
                      <Td>{p.subject}</Td>
                      <Td>
                        {p.substitute ? (
                          <>
                            <span className="font-medium">{p.substitute}</span>
                            <span className="block text-[12px] text-muted-foreground">
                              standing in for {p.teacher ?? 'the scheduled teacher'}
                              {p.substitute_reason ? ` — ${p.substitute_reason}` : ''}
                            </span>
                          </>
                        ) : (
                          (p.teacher ?? <span className="text-muted-foreground">Unassigned</span>)
                        )}
                      </Td>
                      <Td>
                        {p.lesson ? (
                          <>
                            <Badge tone={PLAN_TONE[p.lesson.status] ?? 'neutral'}>
                              {p.lesson.status}
                            </Badge>
                            {p.lesson.objectives && (
                              <span className="mt-1 block text-[12px]">{p.lesson.objectives}</span>
                            )}
                            {p.lesson.homework && (
                              <span className="block text-[12px] text-muted-foreground">
                                Homework: {p.lesson.homework}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <CalendarClock className="h-3.5 w-3.5" />
                            Not planned
                          </span>
                        )}
                      </Td>
                    </>
                  )}
                </tr>
              ))}
            </Table>
          )}
        </>
      )}
    </Card>
  )
}
