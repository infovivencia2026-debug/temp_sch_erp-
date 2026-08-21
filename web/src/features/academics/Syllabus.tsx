import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, CheckCircle2, ClipboardCheck, TrendingDown } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState, useSort,
} from '@/components/ui'
import { cn, formatDate } from '@/lib/utils'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'

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
  /* Two menu entries, two screens.
   *
   * "Lesson Plans" and "Syllabus Progress" both opened this, whole, so the
   * school had two names for one page and no reason to click the second. They
   * are different questions asked by different people: a head of department
   * signs plans this week, and a principal asks in February whether Class 8
   * has finished the syllabus.
   *
   * One component still, because the coverage numbers are computed from the
   * plans and splitting the file would mean fetching the same rows twice and
   * letting the two drift. What splits is what is shown. */
  const { featureSlug } = useParams()
  const view = featureSlug === 'syllabus_progress' ? 'coverage' : 'plans'
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
        title={view === 'coverage' ? 'Syllabus progress' : 'Lesson plans'}
        description={
          view === 'coverage'
            ? 'How much of each subject has actually been taught, against how much was planned. The question asked in the month before an exam.'
            : 'Plans teachers have written, and the ones waiting on a signature.'
        }
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

        {view === 'plans' && canReview && waiting > 0 && (
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

        {view === 'coverage' && (
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
        )}

        {view === 'plans' && (
          <>
            <MyPlans plans={mine.data?.items ?? []} canReview={canReview} />
            <NewLessonPlan />
          </>
        )}
        {view === 'coverage' && canReview && <ChapterPlanner />}
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

/**
 * Writing a lesson plan.
 *
 * The plans table, the review queue and the coverage percentage all existed
 * and there was no way to create a plan. The empty state said "write one for
 * the coming week below" and there was nothing below it: every plan in the
 * product had to be inserted in SQL, which is why the review queue was empty
 * in every school.
 *
 * A file, and four boxes, and both are optional except that one of them has to
 * be filled. Teachers do not write lesson plans into four boxes — they write
 * them in Word, or on a school proforma, or on the state's template — so the
 * attachment is the plan as it actually exists. The boxes stay because a head
 * of department reviewing twenty plans wants the objectives on screen rather
 * than twenty attachments to open.
 *
 * The day is optional and means what its absence means: a plan for the whole
 * week. Schools that plan per lesson pick a day; schools that plan per week
 * leave it, and neither is made to pretend to be the other.
 */
function NewLessonPlan() {
  const qc = useQueryClient()
  const classSubjects = useQuery({
    queryKey: ['class-subjects'],
    queryFn: () => api.get<List<ClassSubject>>('/api/v1/setup/class-subjects'),
  })
  const [f, setF] = useState({
    class_subject_id: '',
    section_id: '',
    week_of: monday(),
    teaching_day: '',
    objectives: '',
    activities: '',
    resources: '',
    homework: '',
  })
  const [file, setFile] = useState<UploadedFile | null>(null)

  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<{ id: string; name: string; class_name: string }>>('/api/v1/academics/sections'),
  })

  const save = useMutation({
    mutationFn: (submit: boolean) =>
      api.post('/api/v1/syllabus/lesson-plans', {
        ...f,
        teaching_day: f.teaching_day ? Number(f.teaching_day) : undefined,
        file_id: file?.file_id,
        submit,
      }),
    onSuccess: () => {
      setF({ ...f, objectives: '', activities: '', resources: '', homework: '' })
      setFile(null)
      qc.invalidateQueries()
    },
  })

  const ready =
    !!f.section_id &&
    !!f.class_subject_id &&
    !!f.week_of &&
    (!!file || !!f.objectives.trim())

  return (
    <Card>
      <CardHeader
        title="Write a lesson plan"
        description="Attach the plan you already wrote, or fill in the boxes, or both."
      />
      <form
        className="px-5 pb-5"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate(true)
        }}
      >
        <FormGrid>
          <Field label="Class and section" required>
            <Select
              value={f.section_id}
              onChange={(v) => setF({ ...f, section_id: v })}
              placeholder="Choose a section"
              options={(sections.data?.items ?? []).map((s) => ({
                value: s.id,
                label: `${s.class_name}-${s.name}`,
              }))}
            />
          </Field>
          <Field label="Subject" required>
            <Select
              value={f.class_subject_id}
              onChange={(v) => setF({ ...f, class_subject_id: v })}
              placeholder="Choose a subject"
              options={(classSubjects.data?.items ?? []).map((s) => ({
                value: s.id,
                label: `${s.class_name} · ${s.subject_name}`,
              }))}
            />
          </Field>
          <Field label="Week beginning" required>
            <Input
              type="date"
              value={f.week_of}
              onChange={(v) => setF({ ...f, week_of: v })}
            />
          </Field>
          <Field label="Day" hint="Leave blank if the plan covers the whole week.">
            <Select
              value={f.teaching_day}
              onChange={(v) => setF({ ...f, teaching_day: v })}
              placeholder="Whole week"
              options={[
                { value: '', label: 'Whole week' },
                { value: '1', label: 'Monday' },
                { value: '2', label: 'Tuesday' },
                { value: '3', label: 'Wednesday' },
                { value: '4', label: 'Thursday' },
                { value: '5', label: 'Friday' },
                { value: '6', label: 'Saturday' },
              ]}
            />
          </Field>
          <Field label="Attach the plan" wide hint="Word, PDF, slides, a scan of the proforma — anything up to 64 MB.">
            <FilePicker value={file} onChange={setFile} purpose="lesson_plan" />
          </Field>
          <Field label="Objectives" wide hint="What the class should be able to do afterwards. Shown to your head of department.">
            <Textarea
              value={f.objectives}
              onChange={(v) => setF({ ...f, objectives: v })}
              rows={2}
              placeholder="Add and subtract fractions with unlike denominators."
            />
          </Field>
          <Field label="Activities" wide>
            <Textarea
              value={f.activities}
              onChange={(v) => setF({ ...f, activities: v })}
              rows={2}
              placeholder="Board work, pair work on the worksheet, three at the board."
            />
          </Field>
          <Field label="Resources">
            <Input
              value={f.resources}
              onChange={(v) => setF({ ...f, resources: v })}
              placeholder="Textbook p. 74, fraction strips"
            />
          </Field>
          <Field label="Homework set">
            <Input
              value={f.homework}
              onChange={(v) => setF({ ...f, homework: v })}
              placeholder="Exercise 6.3, sums 1 to 8"
            />
          </Field>
        </FormGrid>
        <FormNotice error={save.error} />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!ready || save.isPending}>
            {save.isPending ? 'Saving…' : 'Submit for approval'}
          </Button>
          {/* Saving without submitting, because a plan written on Friday for
              the following week is not ready to be reviewed on Friday. */}
          <Button
            variant="secondary"
            disabled={!ready || save.isPending}
            onClick={() => save.mutate(false)}
          >
            Save as draft
          </Button>
        </div>
      </form>
    </Card>
  )
}

/** The Monday of the coming week, which is what "week beginning" nearly always
 *  means when somebody opens this form. */
function monday(): string {
  const d = new Date()
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7))
  return d.toISOString().slice(0, 10)
}
