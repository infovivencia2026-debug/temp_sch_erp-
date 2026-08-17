import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, CheckCircle2, ClipboardCheck, TrendingDown } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Field, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState, useSort,
} from '@/components/ui'
import { cn, formatDate } from '@/lib/utils'

/* Are we behind?

   The question a head of department asks every fortnight and an inspection
   asks once a year. The product knew a class studies Mathematics and nothing
   about what Mathematics contains, so the answer lived in a teacher's diary.

   Three things on one screen because they are one loop: the chapters, the
   plans that deliver them, and the percentage that follows. Splitting them
   would mean three screens each showing a third of an answer. */

interface Unit {
  id: string
  sequence: number
  title: string
  outcomes?: string
  planned_periods: number
  class_name: string
  subject: string
  delivered: boolean
  delivered_on?: string
}
interface Coverage {
  class_subject_id: string
  class_name: string
  subject: string
  teacher?: string
  units: number
  delivered: number
  percent: number
  behind: boolean
  last_taught?: string
  plans_waiting: number
}
interface Plan {
  id: string
  section: string
  class_name: string
  subject: string
  teacher?: string
  week_of: string
  status: 'draft' | 'submitted' | 'approved' | 'returned'
  objectives?: string
  remarks?: string
  delivered_on?: string
  units: string[]
  waiting_days: number
}
interface ClassSubject {
  id: string
  class_id: string
  class_name: string
  subject_name: string
}

const STATUS: Record<string, 'neutral' | 'warning' | 'success' | 'danger'> = {
  draft: 'neutral',
  submitted: 'warning',
  approved: 'success',
  returned: 'danger',
}

export default function Syllabus() {
  const qc = useQueryClient()
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<{ permissions: string[] }>('/api/v1/session'),
  })
  const canReview = session.data?.permissions.includes('academics.write') ?? false

  const coverage = useQuery({
    queryKey: ['syllabus-coverage'],
    queryFn: () => api.get<List<Coverage>>('/api/v1/syllabus/coverage'),
  })
  const queue = useQuery({
    queryKey: ['lesson-plans', 'submitted'],
    queryFn: () => api.get<List<Plan>>('/api/v1/syllabus/lesson-plans?status=submitted'),
    enabled: canReview,
  })
  const mine = useQuery({
    queryKey: ['lesson-plans', 'mine'],
    queryFn: () => api.get<List<Plan>>('/api/v1/syllabus/lesson-plans'),
  })

  const decide = useMutation({
    mutationFn: (v: { id: string; decision?: string; remarks?: string; delivered_on?: string }) =>
      api.post(`/api/v1/syllabus/lesson-plans/${v.id}/decide`, v),
    onSuccess: () => qc.invalidateQueries(),
  })

  const rows = coverage.data?.items ?? []
  const sort = useSort<Coverage>(
    rows,
    (c, k) => (c as unknown as Record<string, string | number>)[k],
    { key: 'percent' },
  )

  if (coverage.isLoading) return <Loading label="Working out how far each class has got…" />
  if (coverage.error) return <ErrorState error={coverage.error} />

  const behind = rows.filter((r) => r.behind).length
  const average = rows.length
    ? Math.round(rows.reduce((n, r) => n + r.percent, 0) / rows.length)
    : 0
  const waiting = queue.data?.items.length ?? 0

  return (
    <>
      <PageHead
        eyebrow="Academics"
        title="Syllabus and lesson plans"
        description="What each class is meant to cover, what has actually been taught, and the plans waiting on a signature."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Average coverage" value={`${average}%`} icon={BookOpen} />
          <Stat
            label="Behind"
            value={behind}
            icon={TrendingDown}
            delta={
              behind
                ? { value: 'Under 75% this late in the year', positive: false }
                : { value: 'On track', positive: true }
            }
          />
          <Stat label="Plans to review" value={waiting} icon={ClipboardCheck} />
          <Stat label="Subjects tracked" value={rows.length} />
        </CellGrid>

        {canReview && waiting > 0 && (
          <Card>
            <CardHeader
              title="Waiting on you"
              description="Oldest first. A plan returned without remarks tells the teacher nothing, so remarks are required."
            />
            <ul className="divide-y">
              {(queue.data?.items ?? []).map((p) => (
                <ReviewRow key={p.id} plan={p} pending={decide.isPending} onDecide={decide.mutate} />
              ))}
            </ul>
            <FormNotice error={decide.error} />
          </Card>
        )}

        <Card>
          <CardHeader
            title="Coverage"
            description="Chapters with a delivered lesson plan, over chapters planned"
          />
          {rows.length === 0 ? (
            <EmptyState
              title="No syllabus entered yet"
              body="Add chapters to a subject below and coverage follows from the lesson plans."
            />
          ) : (
            <Table
              head={[
                { label: 'Class', key: 'class_name' },
                { label: 'Subject', key: 'subject' },
                { label: 'Teacher', key: 'teacher' },
                { label: 'Covered', key: 'percent' },
                { label: 'Last taught', key: 'last_taught' },
                { label: 'Waiting', key: 'plans_waiting' },
              ]}
              sort={sort}
            >
              {sort.sorted.map((r) => (
                <tr key={r.class_subject_id}>
                  <Td className="font-medium">{r.class_name}</Td>
                  <Td>{r.subject}</Td>
                  <Td className="text-muted-foreground">{r.teacher ?? 'Unassigned'}</Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <div className="h-1 w-20 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            'h-full rounded-full',
                            r.behind ? 'bg-destructive' : 'bg-success',
                          )}
                          style={{ width: `${r.percent}%` }}
                        />
                      </div>
                      <span className="tabular-nums">{r.percent}%</span>
                      <span className="text-[12px] text-muted-foreground">
                        {r.delivered}/{r.units}
                      </span>
                    </div>
                  </Td>
                  <Td className="text-muted-foreground">
                    {r.last_taught ? formatDate(r.last_taught) : 'never'}
                  </Td>
                  <Td className="tabular-nums">{r.plans_waiting || '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <MyPlans plans={mine.data?.items ?? []} canReview={canReview} />
        {canReview && <ChapterPlanner />}
      </PageBody>
    </>
  )
}

function ReviewRow({
  plan,
  pending,
  onDecide,
}: {
  plan: Plan
  pending: boolean
  onDecide: (v: { id: string; decision?: string; remarks?: string }) => void
}) {
  const [remarks, setRemarks] = useState('')
  return (
    <li className="px-5 py-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-[14px] font-medium">
            {plan.class_name}-{plan.section} · {plan.subject}
          </p>
          <p className="mt-0.5 text-[14px] text-muted-foreground">
            Week of {formatDate(plan.week_of)}
            {plan.teacher && ` · ${plan.teacher}`}
            {plan.waiting_days > 0 && ` · waiting ${plan.waiting_days}d`}
          </p>
          {plan.objectives && <p className="mt-1.5 text-[14px]">{plan.objectives}</p>}
          {plan.units.length > 0 && (
            <p className="mt-1.5 flex flex-wrap gap-1.5">
              {plan.units.map((u) => (
                <Badge key={u} tone="neutral">
                  {u}
                </Badge>
              ))}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Input value={remarks} onChange={setRemarks} placeholder="Remarks" className="w-44" />
          <Button
            size="sm"
            disabled={pending}
            onClick={() => onDecide({ id: plan.id, decision: 'approved', remarks })}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="secondary"
            tone="danger"
            disabled={pending || !remarks.trim()}
            title={remarks.trim() ? 'Send back with remarks' : 'Say why before returning it'}
            onClick={() => onDecide({ id: plan.id, decision: 'returned', remarks })}
          >
            Return
          </Button>
        </div>
      </div>
    </li>
  )
}

/** A teacher's own plans, and the button that marks one actually taught. */
function MyPlans({ plans, canReview }: { plans: Plan[]; canReview: boolean }) {
  const qc = useQueryClient()
  const deliver = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/syllabus/lesson-plans/${id}/decide`, {
        delivered_on: new Date().toISOString().slice(0, 10),
      }),
    onSuccess: () => qc.invalidateQueries(),
  })

  return (
    <Card>
      <CardHeader
        title={canReview ? 'All lesson plans' : 'My lesson plans'}
        description="Marking a plan taught is what advances coverage — approval alone does not, because a school can close for rain."
      />
      {plans.length === 0 ? (
        <EmptyState title="No plans yet" body="Write one for the coming week below." />
      ) : (
        <Table head={['Week', 'Class', 'Subject', 'Chapters', 'Status', 'Taught', '']}>
          {plans.slice(0, 25).map((p) => (
            <tr key={p.id}>
              <Td className="font-medium">{formatDate(p.week_of)}</Td>
              <Td>
                {p.class_name}-{p.section}
              </Td>
              <Td>{p.subject}</Td>
              <Td className="text-muted-foreground">{p.units.join(', ') || '—'}</Td>
              <Td>
                <Badge tone={STATUS[p.status]}>{p.status}</Badge>
                {p.status === 'returned' && p.remarks && (
                  <span className="ml-2 text-[12px] text-muted-foreground">“{p.remarks}”</span>
                )}
              </Td>
              <Td>
                {p.delivered_on ? (
                  <span className="inline-flex items-center gap-1.5 text-success">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {formatDate(p.delivered_on)}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </Td>
              <Td>
                {!p.delivered_on && p.status === 'approved' && (
                  <Button size="sm" variant="secondary" disabled={deliver.isPending}
                    onClick={() => deliver.mutate(p.id)}>
                    Mark taught
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <FormNotice error={deliver.error} />
    </Card>
  )
}

/** The chapter list for one subject. */
function ChapterPlanner() {
  const qc = useQueryClient()
  const subjects = useQuery({
    queryKey: ['class-subjects'],
    queryFn: () => api.get<List<ClassSubject>>('/api/v1/setup/class-subjects'),
  })
  const [csID, setCsID] = useState('')
  const units = useQuery({
    queryKey: ['syllabus-units', csID],
    queryFn: () => api.get<List<Unit>>(`/api/v1/syllabus/units?class_subject_id=${csID}`),
    enabled: !!csID,
  })
  const [draft, setDraft] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/syllabus/units', {
        class_subject_id: csID,
        units: draft
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((title) => ({ title })),
      }),
    onSuccess: () => {
      setDraft('')
      qc.invalidateQueries()
    },
  })

  return (
    <Card>
      <CardHeader
        title="Chapters"
        description="One per line. Chapters already taught are kept — removing one would quietly reduce coverage a class has earned."
        action={
          <Select
            value={csID}
            onChange={setCsID}
            placeholder="Choose a subject"
            options={(subjects.data?.items ?? []).map((c) => ({
              value: c.id,
              label: `${c.class_name} · ${c.subject_name}`,
            }))}
          />
        }
      />
      {!csID ? (
        <EmptyState title="Pick a subject" body="Then enter its chapter list." />
      ) : (
        <>
          <Table head={['#', 'Chapter', 'Periods', 'Taught']}>
            {(units.data?.items ?? []).map((u) => (
              <tr key={u.id}>
                <Td className="tabular-nums text-muted-foreground">{u.sequence}</Td>
                <Td className="font-medium">
                  {u.title}
                  {u.outcomes && (
                    <span className="block text-[12px] font-normal text-muted-foreground">
                      {u.outcomes}
                    </span>
                  )}
                </Td>
                <Td className="tabular-nums">{u.planned_periods}</Td>
                <Td>
                  {u.delivered ? (
                    <Badge tone="success">{formatDate(u.delivered_on)}</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
          <form
            className="border-t px-5 py-5"
            onSubmit={(e) => {
              e.preventDefault()
              save.mutate()
            }}
          >
            <Field label="Add chapters" hint="One per line, in teaching order.">
              <Textarea
                value={draft}
                onChange={setDraft}
                rows={5}
                placeholder={'Knowing our numbers\nWhole numbers\nPlaying with numbers'}
              />
            </Field>
            <FormNotice error={save.error} />
            <div className="mt-4">
              <Button type="submit" disabled={save.isPending || !draft.trim()}>
                {save.isPending ? 'Saving…' : 'Add chapters'}
              </Button>
            </div>
          </form>
        </>
      )}
    </Card>
  )
}
