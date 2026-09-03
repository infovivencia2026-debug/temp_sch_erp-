import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CalendarCheck, ClipboardCheck, Users } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'

/* The head of department's morning.

   Every other role opens on a dashboard; HOD opened on a timetable, so the
   questions a head of department actually arrives with had to be assembled by
   visiting four screens and remembering what each one said.

   Three questions, in the order they matter before nine o'clock:

     Is my department covered? A period uncovered at 08:50 is a problem; the
     same period at 11:00 is a complaint from a parent.

     What is waiting on me? A HOD is an approver before they are anything else,
     and an approval nobody can see is an approval that does not happen.

     Is the work going in? Registers and marks — the two things a HOD chases
     rather than does.

   Deliberately not the principal's dashboard with the numbers changed. A HOD
   does not run the school's money or its admissions; putting those figures
   here would make the page look important while answering nothing they can
   act on. */

interface Absentee {
  name: string
  reason: string
  periods: number
  uncovered: number
}

interface Dash {
  departments: number
  department_names: string[]
  teachers: number
  sections: number
  absent_today: number
  periods_uncovered: number
  registers_not_taken: number
  leave_to_decide: number
  subs_to_approve: number
  papers_to_approve: number
  marks_to_moderate: number
  absent: Absentee[]
}

export default function HodDashboard() {
  const nav = useNavigate()
  const { data, isLoading, error } = useQuery({
    queryKey: ['hod-dashboard'],
    queryFn: () => api.get<Dash>('/api/v1/teaching/hod-dashboard'),
  })

  if (isLoading) return <SkeletonTiles count={4} label="Reading your department…" />
  if (error) return <ErrorState error={error} />
  if (!data) return null

  const waiting =
    data.leave_to_decide + data.subs_to_approve + data.papers_to_approve + data.marks_to_moderate

  const queues = [
    { n: data.leave_to_decide, label: 'Leave to decide', to: '/hod/staff/leaves_subs' },
    { n: data.subs_to_approve, label: 'Substitutions to approve', to: '/hod/timetable/substitution_requests' },
    { n: data.papers_to_approve, label: 'Question papers to pass', to: '/hod/exams/question_paper_approval' },
    { n: data.marks_to_moderate, label: 'Papers to moderate', to: '/hod/exams/mark_moderation' },
  ].filter((q) => q.n > 0)

  return (
    <>
      <PageHead
        eyebrow="Department"
        title={
          data.department_names.length
            ? data.department_names.join(', ')
            : 'My department'
        }
        description="Who is out, what is uncovered, and what is waiting on you."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat
            label="Teachers"
            value={data.teachers}
            icon={Users}
            hint={data.sections ? `${data.sections} sections` : undefined}
          />
          <Stat
            label="Out today"
            value={data.absent_today}
            icon={AlertTriangle}
            delta={
              data.absent_today
                ? { value: `${data.periods_uncovered} periods uncovered`, positive: false }
                : { value: 'Everybody in', positive: true }
            }
          />
          <Stat
            label="Waiting on you"
            value={waiting}
            icon={ClipboardCheck}
            delta={
              waiting
                ? { value: 'Nobody else can decide these', positive: false }
                : { value: 'Nothing pending', positive: true }
            }
          />
          <Stat
            label="Registers not taken"
            value={data.registers_not_taken}
            icon={CalendarCheck}
            delta={
              data.registers_not_taken
                ? { value: 'In your own sections', positive: false }
                : { value: 'All marked', positive: true }
            }
          />
        </CellGrid>

        {/* A school that has not created departments yet gives its HOD the
            whole staff. Said out loud, because otherwise these numbers read as
            "my department" when they are "everybody". */}
        {data.departments === 0 && (
          <Card>
            {/* The sentence is the whole card, so it goes in the body.

                Card descriptions are no longer drawn, so a card whose only
                content was one rendered as a heading over an empty box —
                which reads as a screen that failed to load rather than as
                an explanation. */}
            <EmptyState
              title="No department is assigned to you"
              body="The figures above are the whole school, not a department of your own. Once the school creates departments and puts you on one, everything here narrows to it."
            />
          </Card>
        )}

        <Card>
          <CardHeader
            title="Out today"
            description="From both registers a school keeps absence in — this morning's mark, and leave approved weeks ago that nobody has marked."
          />
          {data.absent.length === 0 ? (
            <EmptyState
              title="Everybody is in"
              body="No absence marked and no approved leave running today."
            />
          ) : (
            <Table head={['Teacher', 'Why', 'Periods today', 'Uncovered', '']}>
              {data.absent.map((a) => (
                <tr key={a.name}>
                  <Td className="whitespace-nowrap font-medium">{a.name}</Td>
                  <Td>
                    <Badge tone={a.reason === 'leave' ? 'info' : 'warning'}>
                      {a.reason === 'leave' ? 'on leave' : 'marked absent'}
                    </Badge>
                  </Td>
                  <Td className="num">{a.periods}</Td>
                  <Td className="num">
                    {a.uncovered > 0 ? (
                      <span className="font-medium text-destructive">{a.uncovered}</span>
                    ) : (
                      <span className="text-muted-foreground">all covered</span>
                    )}
                  </Td>
                  <Td>
                    {a.uncovered > 0 && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => nav('/hod/timetable/substitution_requests')}
                      >
                        Find cover
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {/* Only the queues that have something in them. A row of noughts is a
            list somebody learns to skip, and the point of this card is that it
            is worth reading every morning. */}
        {queues.length > 0 && (
          <Card>
            <CardHeader
              title="Waiting on you"
              description="Nobody else in the school can decide these."
            />
            <ul className="divide-y">
              {queues.map((q) => (
                <li key={q.label} className="flex items-center justify-between px-5 py-3">
                  <span className="text-[14px]">
                    <span className="num mr-2 font-semibold">{q.n}</span>
                    {q.label}
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => nav(q.to)}>
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </PageBody>
    </>
  )
}
