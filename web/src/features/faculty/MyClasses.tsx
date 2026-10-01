import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader,
  Table, Td, Badge, Button, Checkbox, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, SkeletonTiles, ErrorState, EmptyState, useSort,
  RangePicker, rangeQuery, useRange, type RangeOption,
} from '@/components/ui'
import { warningsApi } from '@/components/ai/smartApi'
import { cn, formatDate } from '@/lib/utils'
import ProgressDetail from './ProgressDetail'

interface ProgressOption {
  section_id: string
  label: string
  class_teacher: boolean
  full: boolean
  subjects: { id: string; name: string; mine: boolean }[]
  exams: { id: string; name: string }[]
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join('')
}

function Kpi({ label, value, small, danger }: { label: string; value: string; small?: string; danger?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border bg-card px-5 py-4">
      <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">{label}</span>
      <div className={cn('flex flex-wrap items-baseline gap-x-1.5 text-[22px] font-bold', danger && 'text-destructive')}>
        {value}
        {small && <small className="whitespace-nowrap text-[11px] font-medium text-muted-foreground">{small}</small>}
      </div>
    </div>
  )
}

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

const CATEGORIES = [
  { value: 'conduct', label: 'Conduct' },
  { value: 'kindness', label: 'Kindness' },
  { value: 'effort', label: 'Effort' },
  { value: 'curiosity', label: 'Curiosity' },
  { value: 'attendance', label: 'Attendance' },
  { value: 'welfare', label: 'Welfare' },
  { value: 'property', label: 'Property' },
]

export default function MyClasses() {
  const [range, setRange] = useRange()
  const [selected, setSelected] = useState<Progress | null>(null)
  const [progressOf, setProgressOf] = useState<Progress | null>(null)
  const [sectionPick, setSectionId] = useState('')
  const [subjectId, setSubjectId] = useState('')
  const [examId, setExamId] = useState('')
  const [chip, setChip] = useState<'all' | 'attention' | 'top'>('all')
  const options = useQuery({
    queryKey: ['student-progress-options'],
    queryFn: () => api.get<List<ProgressOption>>('/api/v1/teaching/progress/options'),
  })
  const sections = options.data?.items ?? []
  /* Your own class first, when you are a class teacher. */
  const sectionId = sections.some((x) => x.section_id === sectionPick)
    ? sectionPick
    : (sections.find((x) => x.class_teacher) ?? sections[0])?.section_id ?? ''
  const pickedSection = sections.find((x) => x.section_id === sectionId)
  const filterQuery = [
    sectionId && `section_id=${sectionId}`,
    subjectId && `class_subject_id=${subjectId}`,
    examId && `exam_id=${examId}`,
  ].filter(Boolean).join('&')

  const presets = useQuery({
    queryKey: ['date-ranges'],
    queryFn: () => api.get<{ items: RangeOption[] }>('/api/v1/date-ranges'),
  })
  const progress = useQuery({
    queryKey: ['student-progress', rangeQuery(range), filterQuery],
    queryFn: () => api.get<List<Progress>>(`/api/v1/teaching/progress?${rangeQuery(range)}${filterQuery ? '&' + filterQuery : ''}`),
    enabled: !options.isLoading && (range.period !== 'custom' || (!!range.from && !!range.to)),
  })
  const plans = useQuery({
    queryKey: ['support-plans'],
    queryFn: () => api.get<List<Plan>>('/api/v1/students/support-plans'),
  })
  /* The early-warnings panel sits above the figures. Fetched here, under the
     panel's own key, so the page waits for it instead of the panel arriving
     late and pushing the whole roster down. */
  const warnings = useQuery({
    queryKey: ['ai-warnings', 'active', ''],
    queryFn: () => warningsApi.list({ status: 'active', section_id: undefined }),
  })
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.call('GET /session'),
  })

  const canNote = session.data?.permissions.includes('welfare.discipline.write') ?? false
  const canPlan = session.data?.permissions.includes('students.write') ?? false

  const rows = progress.data?.items ?? []
  const sort = useSort<Progress>(
    rows,
    (p, k) => (p as unknown as Record<string, string | number>)[k],
    { key: 'full_name' },
  )

  if (options.isLoading || progress.isLoading || warnings.isLoading) return <SkeletonTiles count={4} label="Working out how each child is doing…" />
  if (progress.error) return <ErrorState error={progress.error} />

  const attention = rows.filter((r) => r.risk_band !== 'none')
  const top = rows.filter((r) => r.marks_percent != null && r.marks_percent >= 80)
  const shown = chip === 'attention' ? attention : chip === 'top' ? top : rows
  const avg = (xs: number[]) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10 : null
  const classAvg = avg(rows.map((r) => r.marks_percent).filter((x): x is number => x != null))
  const attAvg = avg(rows.map((r) => r.attendance_percent).filter((x): x is number => x != null))
  const pendingHw = rows.reduce((n, r) => n + Math.max(0, r.homework_set - r.homework_submitted), 0)
  const rangeLabel = (presets.data?.items ?? []).find((o) => o.value === range.period)?.label
  const reviewDue = (plans.data?.items ?? []).filter((p) => p.review_due)

  return (
    <>
      <PageHead
        eyebrow="My classes"
        title="How each child is doing"
        description="Attendance, marks, homework and conduct in one row per child, with the reason wherever something needs attention."
      />
      <PageBody>
        {/* THE OWNER'S LAYOUT: four figures, then one card holding the class,
            subject and exam pickers, the quick filters and the roster.
            A class teacher sees the whole class and may narrow it to a
            subject; a subject teacher sees only the subjects they teach the
            class -- the server enforces it (teaching/progress?section_id). */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Kpi label="Class average" value={classAvg == null ? '-' : `${classAvg}%`} small={pickedSection?.label} />
          <Kpi label="Avg attendance" value={attAvg == null ? '-' : `${attAvg}%`} small={rangeLabel} />
          <Kpi label="Pending homework" value={String(pendingHw)} small="Submissions" />
          <Kpi label="Needs attention" value={String(attention.length)} small="Students" danger={attention.length > 0} />
        </div>

        <Card className="overflow-hidden p-0">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b px-5 py-4">
            <div className="flex flex-wrap items-center gap-2.5">
              {sections.length > 0 && (
                <div className="w-44">
                  <Select value={sectionId} onChange={(v) => { setSectionId(v); setSubjectId(''); setExamId('') }}
                    options={sections.map((x) => ({ value: x.section_id, label: `${x.label}${x.class_teacher ? ' · my class' : ''}` }))} />
                </div>
              )}
              {pickedSection && (
                <div className="w-48">
                  <Select value={subjectId} onChange={setSubjectId}
                    placeholder={pickedSection.full ? 'All subjects' : 'My subjects'}
                    options={[
                      { value: '', label: pickedSection.full ? 'All subjects' : 'All my subjects' },
                      ...pickedSection.subjects.map((x) => ({ value: x.id, label: x.name })),
                    ]} />
                </div>
              )}
              {pickedSection && pickedSection.exams.length > 0 && (
                <div className="w-48">
                  <Select value={examId} onChange={setExamId} placeholder="All exams"
                    options={[{ value: '', label: 'All exams' }, ...pickedSection.exams.map((x) => ({ value: x.id, label: x.name }))]} />
                </div>
              )}
              <RangePicker value={range} onChange={setRange} options={presets.data?.items ?? []} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {([
                ['all', `All students (${rows.length})`],
                ['attention', `Needs attention (${attention.length})`],
                ['top', `Top scorers (${top.length})`],
              ] as const).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setChip(k)}
                  className={cn('rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition-colors',
                    chip === k ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:border-primary hover:bg-primary/10 hover:text-primary')}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {shown.length === 0 ? (
            <EmptyState
              title={rows.length === 0 ? 'No children here yet' : 'Nobody in this filter'}
              body={rows.length === 0 ? 'Once the class is assigned and the register is marked, each child appears here.' : 'Choose All students to see the whole class.'}
            />
          ) : (
            <Table
              head={[
                { label: 'Student', key: 'full_name' },
                { label: 'Attendance', key: 'attendance_percent' },
                { label: 'Academic score', key: 'marks_percent' },
                { label: 'Assignments', key: 'homework_submitted' },
                { label: 'Status', key: 'risk_band' },
                { label: '', key: 'student_id' },
              ]}
              sort={sort}
            >
              {sort.sorted.filter((r) => shown.includes(r)).map((r) => (
                <tr key={r.student_id}>
                  <Td>
                    <div className="flex items-center gap-3">
                      <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-full bg-primary/10 text-[12.5px] font-bold text-primary">
                        {initials(r.full_name)}
                      </span>
                      <div className="min-w-0">
                        <div className="font-semibold">{r.full_name}</div>
                        <div className="text-[12px] text-muted-foreground">
                          {r.class_name}-{r.section} · {r.admission_no}{r.is_cwsn ? ' · CWSN' : ''}
                        </div>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    {r.attendance_percent == null ? <span className="text-muted-foreground">-</span> : (
                      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold tabular-nums">
                        <span className={cn('h-2 w-2 rounded-full',
                          r.attendance_percent >= 90 ? 'bg-[hsl(var(--sys-green))]' : r.attendance_percent >= 75 ? 'bg-[hsl(var(--sys-orange))]' : 'bg-[hsl(var(--sys-danger-fill))]')} />
                        {Math.round(r.attendance_percent)}%
                      </span>
                    )}
                  </Td>
                  <Td>
                    {r.marks_percent == null ? <span className="text-muted-foreground">-</span> : (
                      <span className="inline-flex items-baseline gap-1.5">
                        <span className="text-[14px] font-bold tabular-nums">{r.marks_percent}%</span>
                        <span className="rounded bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground">
                          {r.papers_marked} {r.papers_marked === 1 ? 'paper' : 'papers'}
                        </span>
                      </span>
                    )}
                  </Td>
                  <Td className="tabular-nums">
                    {r.homework_set === 0 ? <span className="text-muted-foreground">-</span> : `${r.homework_submitted} / ${r.homework_set} submitted`}
                  </Td>
                  <Td>
                    <span className={cn('inline-flex rounded-md px-2 py-0.5 text-[12px] font-semibold',
                      r.risk_band === 'none' ? 'bg-[#f0fdf4] text-[#15803d]'
                        : r.risk_band === 'watch' ? 'bg-[#fefce8] text-[hsl(var(--sys-orange-ink))]' : 'bg-[#fef2f2] text-[#b91c1c]')}
                      title={r.risks.join('; ') || undefined}>
                      {r.risk_band === 'none' ? 'On track' : r.risk_band === 'watch' ? 'Under watch' : 'Intervention required'}
                    </span>
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setSelected(r)}>{canNote ? 'Add note' : 'Open'}</Button>
                      <Button size="sm" variant="secondary" onClick={() => setProgressOf(r)}>Progress</Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {progressOf && <ProgressDetail row={progressOf} onClose={() => setProgressOf(null)} />}

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
            <PlanForm studentId={child.student_id} plan={plan} onSaved={() => qc.invalidateQueries({ queryKey: ['support-plans'] })} />
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
      qc.invalidateQueries({ queryKey: ['notes', studentId] })
      qc.invalidateQueries({ queryKey: ['student-progress'] })
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
