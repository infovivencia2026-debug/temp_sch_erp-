import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Accessibility, AlertTriangle, Award, Users } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Checkbox, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, SkeletonTiles, ErrorState, EmptyState, useSort,
  RangePicker, rangeQuery, useRange, type RangeOption,
} from '@/components/ui'
import { cn, formatDate } from '@/lib/utils'

/* How is this one doing?

   The question a class teacher is asked at every parent meeting, and the one
   the product could not answer: attendance lived in the register, marks in the
   gradebook, homework in its own screen and arrears in the fee ledger. Nobody
   teaching thirty children opens four screens per child.

   Each child gets one row and, where something is wrong, the reason in
   words. "At risk" with no reason is an accusation; "missed a quarter of the
   term and is averaging 30% across two papers" is something a teacher can act
   on while there is still term left. Fee arrears are shown but never make a
   child at-risk — that is the office's business, not a reason to treat a
   child differently. */

interface Progress {
  student_id: string
  admission_no: string
  full_name: string
  section: string
  class_name: string
  attendance_present: number
  attendance_marked: number
  attendance_percent?: number
  homework_set: number
  homework_submitted: number
  section_submission_rate?: number
  marks_percent?: number
  papers_marked: number
  fees_due_paise: number
  is_cwsn: boolean
  cwsn_type?: string
  has_support_plan: boolean
  notes_of_concern: number
  commendations: number
  risks: string[]
  risk_band: 'none' | 'watch' | 'at_risk'
}
interface Note {
  id: string
  student_id: string
  student_name: string
  occurred_on: string
  category: string
  is_positive: boolean
  description: string
  action_taken?: string
  visible_to_student: boolean
  parent_notified: boolean
  recorded_by?: string
}
interface Plan {
  id: string
  student_id: string
  student_name: string
  class_name: string
  cwsn_type?: string
  concern: string
  accommodations: string
  exam_concession?: string
  external_support?: string
  review_on?: string
  status: string
  review_due: boolean
}

const BAND: Record<Progress['risk_band'], 'neutral' | 'warning' | 'danger'> = {
  none: 'neutral',
  watch: 'warning',
  at_risk: 'danger',
}

const CATEGORIES = [
  { value: 'conduct', label: 'Conduct' },
  { value: 'kindness', label: 'Kindness' },
  { value: 'effort', label: 'Effort' },
  { value: 'curiosity', label: 'Curiosity' },
  { value: 'attendance', label: 'Attendance' },
  { value: 'welfare', label: 'Welfare' },
  { value: 'property', label: 'Property' },
]

function rupees(paise: number) {
  return (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

export default function MyClasses() {
  const [range, setRange] = useRange()
  const [selected, setSelected] = useState<Progress | null>(null)

  const presets = useQuery({
    queryKey: ['date-ranges'],
    queryFn: () => api.get<{ items: RangeOption[] }>('/api/v1/date-ranges'),
  })
  const progress = useQuery({
    queryKey: ['student-progress', rangeQuery(range)],
    queryFn: () => api.get<List<Progress>>(`/api/v1/teaching/progress?${rangeQuery(range)}`),
    enabled: range.period !== 'custom' || (!!range.from && !!range.to),
  })
  const plans = useQuery({
    queryKey: ['support-plans'],
    queryFn: () => api.get<List<Plan>>('/api/v1/students/support-plans'),
  })
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<{ permissions: string[] }>('/api/v1/session'),
  })

  const canNote = session.data?.permissions.includes('welfare.discipline.write') ?? false
  const canPlan = session.data?.permissions.includes('students.write') ?? false

  const rows = progress.data?.items ?? []
  const sort = useSort<Progress>(
    rows,
    (p, k) => (p as unknown as Record<string, string | number>)[k],
    { key: 'full_name' },
  )

  if (progress.isLoading) return <SkeletonTiles count={4} label="Working out how each child is doing…" />
  if (progress.error) return <ErrorState error={progress.error} />

  const attention = rows.filter((r) => r.risk_band !== 'none')
  const reviewDue = (plans.data?.items ?? []).filter((p) => p.review_due)

  return (
    <>
      <PageHead
        eyebrow="My classes"
        title="How each child is doing"
        description="Attendance, marks, homework and conduct in one row per child, with the reason wherever something needs attention."
      />
      <PageBody>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CellGrid cols={4}>
            <Stat label="Children" value={rows.length} icon={Users} />
            <Stat
              label="Needing attention"
              value={attention.length}
              icon={AlertTriangle}
              delta={
                attention.length
                  ? { value: 'Two or more signals is at-risk', positive: false }
                  : { value: 'Nothing flagged', positive: true }
              }
            />
            <Stat
              label="Commendations"
              value={rows.reduce((n, r) => n + r.commendations, 0)}
              icon={Award}
            />
            <Stat
              label="Support plans"
              value={(plans.data?.items ?? []).length}
              icon={Accessibility}
              delta={
                reviewDue.length
                  ? { value: `${reviewDue.length} past review`, positive: false }
                  : undefined
              }
            />
          </CellGrid>
          <RangePicker
            value={range}
            onChange={setRange}
            options={presets.data?.items ?? []}
          />
        </div>

        {attention.length > 0 && (
          <Card>
            <CardHeader
              title="Needing attention"
              description="The reason is the point. A flag without one is an accusation nobody can act on."
            />
            <ul className="divide-y">
              {attention.map((r) => (
                <li key={r.student_id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                  <div className="min-w-[15rem] flex-1">
                    <div className="font-medium">
                      {r.full_name}
                      <span className="text-muted-foreground">
                        {' '}
                        · {r.class_name}-{r.section}
                      </span>
                    </div>
                    <ul className="mt-0.5 text-[13px] text-muted-foreground">
                      {r.risks.map((x) => (
                        <li key={x}>· {x}</li>
                      ))}
                    </ul>
                  </div>
                  <Badge tone={BAND[r.risk_band]}>
                    {r.risk_band === 'at_risk' ? 'At risk' : 'Watch'}
                  </Badge>
                  <Button size="sm" variant="secondary" onClick={() => setSelected(r)}>
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Roster"
            description="Attendance and homework follow the chosen window; marks and arrears are true as of today."
          />
          {rows.length === 0 ? (
            <EmptyState
              title="No children in your classes yet"
              body="Once sections are assigned and the register is marked, each child appears here."
            />
          ) : (
            <Table
              head={[
                { label: 'Child', key: 'full_name' },
                { label: 'Class', key: 'class_name' },
                { label: 'Attendance', key: 'attendance_percent' },
                { label: 'Marks', key: 'marks_percent' },
                { label: 'Homework', key: 'homework_submitted' },
                { label: 'Notes', key: 'commendations' },
                { label: 'Owed', key: 'fees_due_paise' },
                { label: '', key: 'risk_band' },
              ]}
              sort={sort}
            >
              {sort.sorted.map((r) => (
                <tr key={r.student_id}>
                  <Td className="font-medium">
                    {r.full_name}
                    <div className="text-[12px] font-normal text-muted-foreground">
                      {r.admission_no}
                      {r.is_cwsn && ' · CWSN'}
                    </div>
                  </Td>
                  <Td className="text-muted-foreground">
                    {r.class_name}-{r.section}
                  </Td>
                  <Td>
                    {r.attendance_percent == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className={cn(
                          'tabular-nums',
                          r.attendance_percent < 75 && 'text-destructive',
                        )}
                      >
                        {Math.round(r.attendance_percent)}%
                        <span className="ml-1 text-[12px] text-muted-foreground">
                          {r.attendance_present}/{r.attendance_marked}
                        </span>
                      </span>
                    )}
                  </Td>
                  <Td>
                    {r.marks_percent == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className={cn('tabular-nums', r.marks_percent < 35 && 'text-destructive')}
                      >
                        {r.marks_percent}%
                        <span className="ml-1 text-[12px] text-muted-foreground">
                          {r.papers_marked}p
                        </span>
                      </span>
                    )}
                  </Td>
                  <Td className="tabular-nums text-muted-foreground">
                    {r.homework_set === 0 ? '—' : `${r.homework_submitted}/${r.homework_set}`}
                  </Td>
                  <Td className="tabular-nums">
                    {r.commendations > 0 && <span className="text-success">+{r.commendations}</span>}
                    {r.commendations > 0 && r.notes_of_concern > 0 && ' '}
                    {r.notes_of_concern > 0 && (
                      <span className="text-muted-foreground">−{r.notes_of_concern}</span>
                    )}
                    {r.commendations === 0 && r.notes_of_concern === 0 && (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </Td>
                  <Td className="tabular-nums text-muted-foreground">
                    {r.fees_due_paise > 0 ? `₹${rupees(r.fees_due_paise)}` : '—'}
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      {r.risk_band !== 'none' && (
                        <Badge tone={BAND[r.risk_band]}>
                          {r.risk_band === 'at_risk' ? 'At risk' : 'Watch'}
                        </Badge>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setSelected(r)}>
                        Open
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {reviewDue.length > 0 && (
          <Card>
            <CardHeader
              title="Support plans past their review"
              description="A plan nobody revisits is a plan nobody follows."
            />
            <ul className="divide-y">
              {reviewDue.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <div className="min-w-[14rem] flex-1">
                    <span className="font-medium">{p.student_name}</span>
                    <span className="text-muted-foreground"> · {p.concern}</span>
                  </div>
                  <Badge tone="warning">Due {formatDate(p.review_on!)}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {/* Opened from a table halfway down the page, the panel used to be
            appended below everything else — off screen, so pressing Open
            looked like pressing nothing. It scrolls itself into view now. */}
        {selected && (
          <ChildPanel
            child={selected}
            canNote={canNote}
            canPlan={canPlan}
            plan={(plans.data?.items ?? []).find((p) => p.student_id === selected.student_id)}
            onClose={() => setSelected(null)}
          />
        )}
      </PageBody>
    </>
  )
}

function ChildPanel({
  child,
  plan,
  canNote,
  canPlan,
  onClose,
}: {
  child: Progress
  plan?: Plan
  canNote: boolean
  canPlan: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [child.student_id])

  const notes = useQuery({
    queryKey: ['notes', child.student_id],
    queryFn: () => api.get<List<Note>>(`/api/v1/students/notes?student_id=${child.student_id}`),
  })

  return (
    <div ref={box}>
    <Card className="border-primary/50">
      <CardHeader
        title={`${child.full_name} · ${child.class_name}-${child.section}`}
        description={
          child.risks.length ? child.risks.join(' · ') : 'Nothing flagged for this child.'
        }
        action={
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        }
      />
      <div className="grid gap-6 p-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-[14px] font-medium">Conduct file</h3>
          {canNote && <NoteForm studentId={child.student_id} />}
          {notes.isLoading ? (
            <Loading label="Loading notes…" />
          ) : (notes.data?.items ?? []).length === 0 ? (
            <p className="text-[13px] text-muted-foreground">Nothing recorded yet.</p>
          ) : (
            <ul className="mt-3 divide-y">
              {(notes.data?.items ?? []).map((n) => (
                <li key={n.id} className="py-2.5">
                  <div className="flex items-center gap-2">
                    <Badge tone={n.is_positive ? 'success' : 'neutral'}>{n.category}</Badge>
                    <span className="text-[12px] text-muted-foreground">
                      {formatDate(n.occurred_on)}
                      {n.recorded_by && ` · ${n.recorded_by}`}
                    </span>
                    {!n.visible_to_student && (
                      <span className="text-[12px] text-muted-foreground">· staff only</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[13px]">{n.description}</p>
                  {n.action_taken && (
                    <p className="text-[13px] text-muted-foreground">Action: {n.action_taken}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-[14px] font-medium">Support plan</h3>
          {canPlan ? (
            <PlanForm studentId={child.student_id} plan={plan} onSaved={() => qc.invalidateQueries()} />
          ) : plan ? (
            <div className="space-y-1 text-[13px]">
              <p>{plan.concern}</p>
              <p className="whitespace-pre-line text-muted-foreground">{plan.accommodations}</p>
              {plan.exam_concession && (
                <p className="text-muted-foreground">Exams: {plan.exam_concession}</p>
              )}
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              No plan recorded. A class teacher can add one.
            </p>
          )}
        </div>
      </div>
    </Card>
    </div>
  )
}

function NoteForm({ studentId }: { studentId: string }) {
  const qc = useQueryClient()
  const [category, setCategory] = useState('conduct')
  const [positive, setPositive] = useState(false)
  const [description, setDescription] = useState('')
  const [action, setAction] = useState('')
  const [shared, setShared] = useState(true)
  const [notified, setNotified] = useState(false)
  // Notes are usually written the same day, but not always — a teacher
  // catching up on Friday needs to say which day it happened.
  const [occurred, setOccurred] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/students/notes', {
        student_id: studentId,
        occurred_on: occurred,
        category,
        is_positive: positive,
        description,
        action_taken: action,
        visible_to_student: shared,
        parent_notified: notified,
      }),
    onSuccess: () => {
      setDescription('')
      setAction('')
      qc.invalidateQueries()
    },
  })

  return (
    <div className="space-y-3 rounded-md border p-3">
      <FormGrid>
        <Field label="Kind">
          <Select value={category} onChange={setCategory} options={CATEGORIES} />
        </Field>
        <Field label="When" hint="Defaults to today.">
          <Input type="date" value={occurred} onChange={setOccurred} />
        </Field>
      </FormGrid>
      <Field label="What happened" required>
        <Textarea
          rows={2}
          value={description}
          onChange={setDescription}
          placeholder="Stayed back to help a classmate who had missed a week with dengue."
        />
      </Field>
      <Field label="What was done about it">
        <Input value={action} onChange={setAction} placeholder="Optional" />
      </Field>
      <div className="flex flex-wrap gap-4">
        <Checkbox
          checked={positive}
          onChange={setPositive}
          label="This is something good"
        />
        <Checkbox
          checked={shared}
          onChange={setShared}
          label="Parent can see this"
        />
        <Checkbox
          checked={notified}
          onChange={setNotified}
          label="Parent has been told"
        />
      </div>
      <Button disabled={save.isPending || description.trim() === ''} onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : 'Add note'}
      </Button>
      <FormNotice error={save.error} />
    </div>
  )
}

function PlanForm({
  studentId,
  plan,
  onSaved,
}: {
  studentId: string
  plan?: Plan
  onSaved: () => void
}) {
  const [concern, setConcern] = useState(plan?.concern ?? '')
  const [accommodations, setAccommodations] = useState(plan?.accommodations ?? '')
  const [exam, setExam] = useState(plan?.exam_concession ?? '')
  const [external, setExternal] = useState(plan?.external_support ?? '')
  const [review, setReview] = useState(plan?.review_on ?? '')
  const [type, setType] = useState(plan?.cwsn_type ?? '')

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/students/support-plans', {
        student_id: studentId,
        concern,
        accommodations,
        exam_concession: exam,
        external_support: external,
        review_on: review,
        cwsn_type: type,
      }),
    onSuccess: onSaved,
  })

  return (
    <div className="space-y-3 rounded-md border p-3">
      <Field label="What the child finds hard" required>
        <Textarea
          rows={2}
          value={concern}
          onChange={setConcern}
          placeholder="Moderate hearing loss in the left ear; misses instructions given from the back of the room."
        />
      </Field>
      <Field label="What the school will do" hint="One per line." required>
        <Textarea
          rows={3}
          value={accommodations}
          onChange={setAccommodations}
          placeholder={'Seat front-left, right ear to the class.\nWrite homework on the board, never only spoken.'}
        />
      </Field>
      <FormGrid>
        <Field
          label="Exam concession"
          hint="A scribe or extra time has to be applied for from the board."
        >
          <Input value={exam} onChange={setExam} placeholder="Optional" />
        </Field>
        <Field label="Outside support">
          <Input value={external} onChange={setExternal} placeholder="Therapist, clinic, resource centre" />
        </Field>
        <Field label="Category" hint="Goes on the UDISE+ return.">
          <Input value={type} onChange={setType} placeholder="hearing_impairment" />
        </Field>
        <Field label="Review on" hint="A plan with no review date is one nobody revisits.">
          <Input type="date" value={review} onChange={setReview} />
        </Field>
      </FormGrid>
      <Button
        disabled={save.isPending || concern.trim() === '' || accommodations.trim() === ''}
        onClick={() => save.mutate()}
      >
        {save.isPending ? 'Saving…' : plan ? 'Update plan' : 'Record plan'}
      </Button>
      <FormNotice error={save.error} ok={save.isSuccess ? 'Plan saved.' : undefined} />
    </div>
  )
}
