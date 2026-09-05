import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ClipboardCheck, Plus } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, Field, FormGrid, FormNotice, Input, Select, Textarea,
  SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { ExportRows, SearchBox, Showing, useSearch } from '@/components/rows'
import { useToast } from '@/components/Toast'
import { formatDate } from '@/lib/utils'
import {
  useTeachingClasses, useTeachingSubjects, today,
  type Assignment, type Submission,
} from './teaching'

/* Setting work, and the half that was missing: marking it.

   Creation posts to /api/v1/homework, the endpoint that already existed. There
   is deliberately no second assignments table — the parent and student portals
   already read homework, and a parallel one would split a child's work across
   two schemas that could disagree about what was set. */

export default function Assignments() {
  const [composing, setComposing] = useState(false)
  const [openID, setOpenID] = useState('')

  const list = useQuery({
    queryKey: ['teaching-assignments'],
    queryFn: () => api.get<List<Assignment>>('/api/v1/teaching/assignments'),
  })

  const rows = list.data?.items ?? []
  /* A term's assignments across four subjects is a long list, and the question
     is nearly always about one of them. Declared above the early returns so
     the hook count is the same on every render. */
  const { q: term, setQ: setTerm, shown } = useSearch(rows,
    (a) => [a.title, a.subject, a.class_name, a.section, a.kind])

  if (list.isLoading) return <SkeletonTable columns={7} />
  if (list.error) return <ErrorState error={list.error} />
  const waiting = rows.reduce((n, r) => n + r.awaiting_marking, 0)

  return (
    <>
      <PageHead
        eyebrow="Teaching workspace"
        title="Assignments & submissions"
        description="What you set, who handed it in, and the marks and feedback that go back."
        actions={
          <Button onClick={() => setComposing((c) => !c)}>
            <Plus className="h-3.5 w-3.5" />
            {composing ? 'Close' : 'Set work'}
          </Button>
        }
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Pieces set" value={rows.length} />
          <Stat label="Waiting to be marked" value={waiting} icon={ClipboardCheck} />
          <Stat
            label="Overdue"
            value={rows.filter((r) => r.overdue).length}
            delta={{
              value: rows.some((r) => r.overdue) ? 'Chase these' : 'Nothing overdue',
              positive: !rows.some((r) => r.overdue),
            }}
          />
        </CellGrid>

        {composing && <Compose onDone={() => setComposing(false)} />}

        <Card>
          <CardHeader title="Work set" description="Most recently assigned first" />
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing set yet"
              body="Work you set for your classes appears here, with a count of who has handed in."
            />
          ) : (
            <>
            <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
              <SearchBox value={term} onChange={setTerm} placeholder="Title, subject or class" />
              <Showing shown={shown.length} total={rows.length} noun="assignments" />
              <ExportRows
                rows={shown}
                name="assignments"
                columns={[
                  { header: 'Title', value: (a) => a.title },
                  { header: 'Kind', value: (a) => a.kind },
                  { header: 'Class', value: (a) => `${a.class_name} ${a.section ?? ''}`.trim() },
                  { header: 'Subject', value: (a) => a.subject },
                  { header: 'Due', value: (a) => a.due_on },
                  { header: 'Handed in', value: (a) => a.submitted },
                  { header: 'On roll', value: (a) => a.roll },
                ]}
              />
            </div>
            <Table
              head={['Title', 'Class', 'Subject', 'Due', 'Handed in', 'To mark', '']}
            >
              {shown.map((a) => (
                <tr key={a.id}>
                  <Td>
                    <span className="font-medium">{a.title}</span>
                    <span className="block text-[12px] text-muted-foreground">{a.kind}</span>
                  </Td>
                  <Td>{a.class_name} {a.section}</Td>
                  <Td>{a.subject ?? '—'}</Td>
                  <Td>
                    {a.due_on ? formatDate(a.due_on) : '—'}
                    {a.overdue && <Badge tone="danger">Overdue</Badge>}
                  </Td>
                  <Td>{a.submitted} of {a.roll}</Td>
                  <Td>
                    {a.awaiting_marking > 0
                      ? <Badge tone="warning">{a.awaiting_marking}</Badge>
                      : <Badge tone="success">Clear</Badge>}
                  </Td>
                  <Td>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setOpenID(openID === a.id ? '' : a.id)}
                    >
                      {openID === a.id ? 'Close' : 'Mark'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
            </>
          )}
        </Card>

        {openID && <Marking assignment={rows.find((r) => r.id === openID)!} />}
      </PageBody>
    </>
  )
}

function Compose({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const classes = useTeachingClasses()
  const subjects = useTeachingSubjects()

  const [sectionID, setSectionID] = useState('')
  const [classSubjectID, setClassSubjectID] = useState('')
  const [kind, setKind] = useState('homework')
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [dueOn, setDueOn] = useState('')
  const [maxMarks, setMaxMarks] = useState('')

  const save = useMutation({
    // The endpoint that already sets homework; this screen adds no second one.
    mutationFn: () =>
      api.post('/api/v1/homework', {
        section_id: sectionID,
        class_subject_id: classSubjectID || undefined,
        kind,
        title,
        instructions: instructions || undefined,
        due_on: dueOn || undefined,
        max_marks: maxMarks ? Number(maxMarks) : undefined,
        allow_submission: true,
      }),
    onSuccess: () => {
      toast.ok('Work set')
      qc.invalidateQueries({ queryKey: ['teaching-assignments'] })
      onDone()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not set work'),
  })

  return (
    <Card>
      <CardHeader title="Set work" description="It appears for the class straight away." />
      <div className="px-5 pb-5">
        <FormGrid>
          <Field label="Class">
            <Select
              value={sectionID}
              onChange={setSectionID}
              placeholder="Choose a class"
              options={(classes.data?.items ?? []).map((c) => ({
                value: c.section_id,
                label: `${c.class_name} ${c.section_name}`,
              }))}
            />
          </Field>
          <Field label="Subject" hint="Optional — leave blank for general work">
            <Select
              value={classSubjectID}
              onChange={setClassSubjectID}
              placeholder="No particular subject"
              options={(subjects.data?.items ?? []).map((s) => ({
                value: s.class_subject_id,
                label: `${s.class_name} · ${s.subject}`,
              }))}
            />
          </Field>
          <Field label="Kind">
            <Select
              value={kind}
              onChange={setKind}
              options={[
                { value: 'homework', label: 'Homework' },
                { value: 'classwork', label: 'Classwork' },
                { value: 'assignment', label: 'Assignment' },
                { value: 'project', label: 'Project' },
              ]}
            />
          </Field>
          <Field label="Title">
            <Input value={title} onChange={setTitle} placeholder="Fractions worksheet" />
          </Field>
          <Field label="Due">
            <Input value={dueOn} onChange={setDueOn} type="date" placeholder={today()} />
          </Field>
          <Field label="Out of" hint="Leave blank if it is not marked">
            <Input value={maxMarks} onChange={setMaxMarks} placeholder="20" />
          </Field>
        </FormGrid>
        <Field label="Instructions">
          <Textarea value={instructions} onChange={setInstructions} rows={3} />
        </Field>
        <FormNotice error={save.error} />
        <div className="mt-3 flex gap-2">
          <Button onClick={() => save.mutate()} disabled={!sectionID || !title.trim()}>
            Set work
          </Button>
          <Button variant="secondary" onClick={onDone}>Cancel</Button>
        </div>
      </div>
    </Card>
  )
}

/* The marking sheet.

   Shows every child in the class, not only those who handed in: the question a
   teacher opens this for is as often "who is missing" as "what did they get". */
function Marking({ assignment }: { assignment: Assignment }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, { marks: string; feedback: string }>>({})

  const list = useQuery({
    queryKey: ['assignment-submissions', assignment.id],
    queryFn: () =>
      api.get<List<Submission>>(`/api/v1/teaching/assignments/${assignment.id}/submissions`),
  })

  const save = useMutation({
    mutationFn: () => {
      const entries = Object.entries(draft)
        .filter(([, v]) => v.marks.trim() !== '' || v.feedback.trim() !== '')
        .map(([student_id, v]) => ({
          student_id,
          marks: v.marks.trim() === '' ? null : Number(v.marks),
          feedback: v.feedback || undefined,
        }))
      return api.post(`/api/v1/teaching/assignments/${assignment.id}/grade`, { entries })
    },
    onSuccess: () => {
      toast.ok('Marks saved')
      setDraft({})
      qc.invalidateQueries({ queryKey: ['assignment-submissions', assignment.id] })
      qc.invalidateQueries({ queryKey: ['teaching-assignments'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save'),
  })

  if (list.isLoading) return <SkeletonTable columns={6} />
  if (list.error) return <ErrorState error={list.error} />
  const rows = list.data?.items ?? []

  const set = (id: string, field: 'marks' | 'feedback', v: string) =>
    setDraft((d) => {
      const current = d[id] ?? { marks: '', feedback: '' }
      return { ...d, [id]: { ...current, [field]: v } }
    })

  return (
    <Card>
      <CardHeader
        title={`Marking — ${assignment.title}`}
        description={
          assignment.max_marks
            ? `Out of ${assignment.max_marks}. Everyone in the class is listed, submitted or not.`
            : 'Everyone in the class is listed, submitted or not.'
        }
      />
      <Table head={['Roll', 'Child', 'Status', 'Handed in', 'Mark', 'Feedback']}>
        {rows.map((s) => (
          <tr key={s.student_id}>
            <Td>{s.roll_no ?? '—'}</Td>
            <Td>
              <span className="font-medium">{s.full_name}</span>
              <span className="block text-[12px] text-muted-foreground">{s.admission_no}</span>
            </Td>
            <Td>
              <Badge
                tone={
                  s.status === 'graded' ? 'success'
                    : s.status === 'pending' ? 'danger'
                      : s.status === 'late' ? 'warning' : 'info'
                }
              >
                {s.status}
              </Badge>
            </Td>
            <Td>{s.submitted_at ? formatDate(s.submitted_at) : '—'}</Td>
            <Td>
              <Input
                value={draft[s.student_id]?.marks ?? (s.marks?.toString() ?? '')}
                onChange={(v) => set(s.student_id, 'marks', v)}
                placeholder={assignment.max_marks ? `/${assignment.max_marks}` : ''}
                className="w-20"
              />
            </Td>
            <Td>
              <Input
                value={draft[s.student_id]?.feedback ?? (s.feedback ?? '')}
                onChange={(v) => set(s.student_id, 'feedback', v)}
                placeholder="A sentence the child can act on"
              />
            </Td>
          </tr>
        ))}
      </Table>
      <div className="flex items-center gap-2 px-5 pb-5">
        <Button onClick={() => save.mutate()} disabled={Object.keys(draft).length === 0}>
          Save marks
        </Button>
        <FormNotice error={save.error} />
      </div>
    </Card>
  )
}
