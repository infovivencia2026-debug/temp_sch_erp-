import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarX2, CheckCircle2, ShieldAlert, UserMinus } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button,
  FormNotice, Input, Loading, ErrorState, EmptyState,
} from '@/components/ui'

/* The first job of the morning in every Indian school.

   Who is not in today, which of their periods that leaves uncovered, and who
   is free in each one. The candidate list is worked out on the server rather
   than by the person holding the timetable on paper: a proxy who is not
   actually free just moves the uncovered class somewhere else.

   A teacher who already takes the subject is offered first, because a free
   period held by somebody who knows the subject is a lesson and anybody else
   is a supervised hour. */

interface Candidate {
  user_id: string
  full_name: string
  teaches_subject: boolean
  periods_today: number
}

interface Slot {
  timetable_entry_id: string
  absent_user_id: string
  absent_teacher: string
  reason: string
  period: string
  period_sequence: number
  starts_at: string
  class_name: string
  section: string
  subject: string
  covered_by?: string
  covered_by_user_id?: string
  candidates: Candidate[]
}

interface BoardResponse {
  items: Slot[]
  on_date: string
  summary: {
    absent_teachers: number
    periods: number
    covered: number
    uncovered: number
    no_candidate: number
  }
}

const today = () => new Date().toISOString().slice(0, 10)

export default function SubstitutionBoard() {
  const qc = useQueryClient()
  const [onDate, setOnDate] = useState(today())

  const board = useQuery({
    queryKey: ['substitution-board', onDate],
    queryFn: () =>
      api.get<BoardResponse>(
        `/api/v1/academics/admin/substitution-board?on_date=${onDate}`,
      ),
  })

  // The write already exists on the timetable module; this screen decides who,
  // and that endpoint refuses a proxy who turns out not to be free after all.
  const cover = useMutation({
    mutationFn: (v: { timetable_entry_id: string; substitute_user_id: string }) =>
      api.post('/api/v1/timetable-admin/substitutions', {
        ...v,
        on_date: onDate,
        reason: 'Cover for an absent teacher',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['substitution-board'] }),
  })

  if (board.isLoading) return <Loading label="Reading this morning’s register…" />
  if (board.error) return <ErrorState error={board.error} />

  const rows = board.data?.items ?? []
  const s = board.data?.summary

  return (
    <>
      <PageHead
        eyebrow="Academics"
        title="Substitution board"
        description="Who is absent, the periods that leaves open, and the staff actually free to take them."
        actions={
          <Input type="date" value={onDate} onChange={setOnDate} className="w-44" />
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Absent today" value={s?.absent_teachers ?? 0} icon={UserMinus} />
          <Stat label="Periods affected" value={s?.periods ?? 0} icon={CalendarX2} />
          <Stat label="Covered" value={s?.covered ?? 0} icon={CheckCircle2} />
          <Stat
            label="Nobody free"
            value={s?.no_candidate ?? 0}
            icon={ShieldAlert}
            hint="Merge the class or send it to the library"
          />
        </CellGrid>

        {rows.length === 0 ? (
          <Card>
            <EmptyState
              title="Nobody is absent"
              body="Absence is read from the staff register and from approved leave. Both are empty for this date."
            />
          </Card>
        ) : (
          <Card>
            <CardHeader
              title="Periods to cover"
              description="A teacher who already takes the subject is offered first; everybody listed is genuinely free in the period."
            />
            <ul className="divide-y">
              {rows.map((r) => (
                <li key={r.timetable_entry_id} className="px-5 py-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <p className="text-[14px] font-medium">
                        {r.period} · {r.starts_at} — {r.class_name}-{r.section} · {r.subject}
                      </p>
                      <p className="mt-0.5 text-[14px] text-muted-foreground">
                        {r.absent_teacher} is{' '}
                        {r.reason === 'leave' ? 'on leave' : 'marked absent'}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {r.covered_by ? (
                        <Badge tone="success">covered by {r.covered_by}</Badge>
                      ) : r.candidates.length === 0 ? (
                        <Badge tone="danger">nobody free this period</Badge>
                      ) : (
                        r.candidates.slice(0, 4).map((c) => (
                          <Button
                            key={c.user_id}
                            size="sm"
                            variant={c.teaches_subject ? 'primary' : 'secondary'}
                            disabled={cover.isPending}
                            title={
                              c.teaches_subject
                                ? `Takes ${r.subject} elsewhere · ${c.periods_today} periods today`
                                : `${c.periods_today} periods today`
                            }
                            onClick={() =>
                              cover.mutate({
                                timetable_entry_id: r.timetable_entry_id,
                                substitute_user_id: c.user_id,
                              })
                            }
                          >
                            {c.full_name}
                          </Button>
                        ))
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="px-5 py-4">
              <FormNotice error={cover.error} />
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
