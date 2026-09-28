import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Film, Sparkles, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import {
  Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, FormNotice, Input, Loading, PageBody, PageHead, Select, Table, Td, Textarea,
} from '@/components/ui'
import VideoLibrary, { VideoPick } from './VideoLibrary'
import { FilePick, KIND_LABEL, KindIcon, LessonContent, fmtWhen, type Lesson, type RubricRow, type Unit } from '../learning/lms-shared'

/* THE LMS, FROM THE FRONT OF THE CLASS (worker routes/teaching/lms.ts).

   A course is one subject in one section. A teacher sees the ones they
   teach; the LMS Admin (and anyone who sees every student) sees them all.
   Inside: units of lessons laid out by day and published on a schedule,
   assignments with an optional rubric and a gradebook, and timed MCQ
   quizzes with an optional AI draft from a lesson. */

interface Course {
  section_id: string; section_name: string; class_name: string; class_subject_id: string; subject: string; teacher?: string | null
  units: number; lessons: number; assignments: number; to_mark: number; quizzes: number; roll: number
}
interface Assignment {
  id: string; kind: string; title: string; instructions?: string | null; assigned_on: string; due_on?: string | null; max_marks?: number | null
  rubric: RubricRow[] | null; submitted: number; to_mark: number; graded: number; returned: number
}
interface Quiz { id: string; title: string; status: string; duration_minutes?: number | null; closes_at?: string | null; questions: number; attempted: number }
interface CourseDetail {
  course: { section_id: string; section_name: string; class_name: string; class_subject_id: string; subject: string }
  roll: number; today: string; units: Unit[]; assignments: Assignment[]; quizzes: Quiz[]
}

export default function TeacherLMS() {
  const [open, setOpen] = useState<{ section_id: string; class_subject_id: string } | null>(null)
  const [videos, setVideos] = useState(false)
  if (videos) return <VideoLibrary back={() => setVideos(false)} />
  if (open) return <CourseView k={open} back={() => setOpen(null)} />
  return <CourseList onOpen={setOpen} onVideos={() => setVideos(true)} />
}

function CourseList({ onOpen, onVideos }: { onOpen: (k: { section_id: string; class_subject_id: string }) => void; onVideos: () => void }) {
  const q = useQuery({ queryKey: ['lms-courses'], queryFn: () => api.get<{ items: Course[] }>('/api/v1/lms/courses') })
  const [filter, setFilter] = useState('')
  const items = (q.data?.items ?? []).filter((c) => !filter || `${c.class_name} ${c.section_name} ${c.subject}`.toLowerCase().includes(filter.toLowerCase()))
  return (
    <>
      <PageHead eyebrow="LMS" title="Courses" actions={<Button variant="secondary" onClick={onVideos}><Film className="h-4 w-4" /> Video library</Button>} />
      <PageBody>
        {q.error ? <ErrorState error={q.error} /> : q.isLoading ? <Loading /> : !q.data?.items.length ? (
          <EmptyState title="No courses yet" body="A course appears for every subject you teach in a section. Ask the office to allocate your subjects." />
        ) : (
          <Card>
            <CardHeader title={`${q.data.items.length} courses`} action={<div className="w-64"><Input value={filter} onChange={setFilter} placeholder="Find a class or subject" /></div>} />
            <Table head={['Course', 'Teacher', 'Lessons', 'Assignments', 'To mark', 'Quizzes', '']}>
              {items.map((c) => (
                <tr key={c.section_id + c.class_subject_id}>
                  <Td><button type="button" className="font-medium text-primary hover:underline" onClick={() => onOpen(c)}>{c.subject} · {c.class_name} {c.section_name}</button></Td>
                  <Td>{c.teacher ?? '—'}</Td>
                  <Td>{c.lessons} in {c.units} units</Td>
                  <Td>{c.assignments}</Td>
                  <Td>{c.to_mark ? <Badge tone="warning">{c.to_mark}</Badge> : '0'}</Td>
                  <Td>{c.quizzes}</Td>
                  <Td><Button size="sm" variant="secondary" onClick={() => onOpen(c)}>Open</Button></Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}
      </PageBody>
    </>
  )
}

function CourseView({ k, back }: { k: { section_id: string; class_subject_id: string }; back: () => void }) {
  const [tab, setTab] = useState<'lessons' | 'assignments' | 'quizzes'>('lessons')
  const key = ['lms-course', k.section_id, k.class_subject_id]
  const q = useQuery({ queryKey: key, queryFn: () => api.get<CourseDetail>(`/api/v1/lms/course?section_id=${k.section_id}&class_subject_id=${k.class_subject_id}`) })
  const d = q.data
  return (
    <>
      <PageHead
        eyebrow="LMS · Courses"
        title={d ? `${d.course.subject} · ${d.course.class_name} ${d.course.section_name}` : 'Course'}
        actions={<Button variant="secondary" onClick={back}><ChevronLeft className="h-4 w-4" /> All courses</Button>}
      />
      <PageBody>
        {q.error ? <ErrorState error={q.error} /> : !d ? <Loading /> : (
          <div className="space-y-4">
            <div className="flex gap-2" role="tablist">
              {(['lessons', 'assignments', 'quizzes'] as const).map((t) => (
                <Button key={t} variant={tab === t ? 'primary' : 'secondary'} onClick={() => setTab(t)}>
                  {t === 'lessons' ? `Lessons (${d.units.reduce((a, u) => a + u.lessons.length, 0)})` : t === 'assignments' ? `Assignments (${d.assignments.length})` : `Quizzes (${d.quizzes.length})`}
                </Button>
              ))}
            </div>
            {tab === 'lessons' && <Lessons d={d} qkey={key} />}
            {tab === 'assignments' && <Assignments d={d} qkey={key} />}
            {tab === 'quizzes' && <Quizzes d={d} qkey={key} />}
          </div>
        )}
      </PageBody>
    </>
  )
}

/* ─── LESSONS ─────────────────────────────────────────────────────────── */

function Lessons({ d, qkey }: { d: CourseDetail; qkey: unknown[] }) {
  const qc = useQueryClient()
  const [unitTitle, setUnitTitle] = useState('')
  const [adding, setAdding] = useState<string | null>(null)
  const [openLesson, setOpenLesson] = useState<string | null>(null)
  const addUnit = useMutation({
    mutationFn: () => api.post('/api/v1/lms/units', { section_id: d.course.section_id, class_subject_id: d.course.class_subject_id, title: unitTitle }),
    onSuccess: () => { setUnitTitle(''); qc.invalidateQueries({ queryKey: qkey }) },
  })
  const delLesson = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/lms/lessons/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qkey }),
  })
  const now = new Date().toISOString()
  return (
    <div className="space-y-4">
      {d.units.map((u) => {
        const days = [...new Set(u.lessons.map((l) => l.day ?? null))]
        return (
          <Card key={u.id}>
            <CardHeader title={u.title} action={<Button size="sm" onClick={() => setAdding(adding === u.id ? null : u.id)}>{adding === u.id ? 'Close' : 'Add a lesson'}</Button>} />
            {adding === u.id && <LessonForm unit={u} sectionId={d.course.section_id} done={() => { setAdding(null); qc.invalidateQueries({ queryKey: qkey }) }} />}
            {!u.lessons.length ? <p className="px-[var(--card-pad)] py-4 text-[14px] text-muted-foreground">No lessons in this unit yet.</p> : days.map((day) => (
              <div key={String(day)} className="border-t">
                <p className="block w-full bg-muted/40 px-[var(--card-pad)] py-1.5 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{day ? `Day ${day}` : 'Any day'}</p>
                <ul className="divide-y">
                  {u.lessons.filter((l) => (l.day ?? null) === day).map((l: Lesson) => (
                    <li key={l.id} className="px-[var(--card-pad)] py-2.5">
                      <div className="flex flex-wrap items-center gap-2 text-[14px]">
                        <KindIcon kind={l.kind} />
                        <button type="button" className="font-medium hover:underline" onClick={() => setOpenLesson(openLesson === l.id ? null : l.id)}>{l.title}</button>
                        <Badge>{KIND_LABEL[l.kind]}</Badge>
                        {!l.is_published ? <Badge tone="warning">Draft</Badge> : l.publish_at && l.publish_at > now ? <Badge tone="info">Opens {fmtWhen(l.publish_at)}</Badge> : null}
                        <span className="ml-auto text-[13px] text-muted-foreground">{l.completed ?? 0} of {d.roll} finished</span>
                        <Button size="sm" variant="ghost" title="Delete lesson" onClick={() => { if (window.confirm(`Delete "${l.title}"? Children's progress on it goes too.`)) delLesson.mutate(l.id) }}><Trash2 className="h-4 w-4" /></Button>
                      </div>
                      {openLesson === l.id && <div className="mt-3 pl-6"><LessonContent l={l} /></div>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Card>
        )
      })}
      <Card>
        <div className="flex flex-wrap items-end gap-3 px-[var(--card-pad)] py-4">
          <div className="w-80"><Field label="New unit"><Input value={unitTitle} onChange={setUnitTitle} placeholder="For example: Fractions" /></Field></div>
          <Button disabled={!unitTitle.trim()} pending={addUnit.isPending} onClick={() => addUnit.mutate()}>Add unit</Button>
          <FormNotice error={addUnit.error} />
        </div>
      </Card>
    </div>
  )
}

function LessonForm({ unit, sectionId, done }: { unit: Unit; sectionId: string; done: () => void }) {
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState('text')
  const [body, setBody] = useState('')
  const [url, setUrl] = useState('')
  const [source, setSource] = useState<'library' | 'link'>('library')
  const [video, setVideo] = useState('')
  const [file, setFile] = useState<{ id: string; name: string } | null>(null)
  const [day, setDay] = useState('')
  const [when, setWhen] = useState('')
  const [onlyHere, setOnlyHere] = useState(false)
  const save = useMutation({
    mutationFn: () => api.post('/api/v1/lms/lessons', {
      unit_id: unit.id, title, kind, body, url: kind === 'video' && source === 'library' ? '' : url,
      video_id: kind === 'video' && source === 'library' ? video : undefined, file_id: file?.id, day: day ? Number(day) : null,
      publish_at: when ? new Date(when).toISOString() : null, section_id: onlyHere ? sectionId : undefined,
    }),
    onSuccess: done,
  })
  return (
    <div className="space-y-3 border-b bg-muted/20 px-[var(--card-pad)] py-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title"><Input value={title} onChange={setTitle} /></Field>
        <Field label="Kind">
          <Select value={kind} onChange={setKind} options={[
            { value: 'text', label: 'Reading (text)' }, { value: 'pdf', label: 'PDF' }, { value: 'file', label: 'File to download' },
            { value: 'video', label: 'Video' }, { value: 'link', label: 'Web link' },
          ]} />
        </Field>
        <Field label="Day of the unit" hint="Optional. Lessons are listed by day."><Input type="number" value={day} onChange={setDay} /></Field>
        <Field label="Publish at" hint="Optional. Children see it from this moment; empty is now."><Input type="datetime-local" value={when} onChange={setWhen} /></Field>
      </div>
      <Field label={kind === 'text' ? 'Lesson text' : 'Notes for the class (optional)'}><Textarea rows={kind === 'text' ? 8 : 3} value={body} onChange={setBody} /></Field>
      {kind === 'video' && (
        <div className="flex flex-wrap gap-4 text-[14px]">
          <label className="flex items-center gap-2"><input type="radio" checked={source === 'library'} onChange={() => setSource('library')} /> From the video library</label>
          <label className="flex items-center gap-2"><input type="radio" checked={source === 'link'} onChange={() => setSource('link')} /> A link (YouTube, Vimeo or any address)</label>
        </div>
      )}
      {kind === 'video' && source === 'library' && <Field label="Video"><VideoPick value={video} onChange={setVideo} /></Field>}
      {((kind === 'video' && source === 'link') || kind === 'link' || kind === 'file' || kind === 'pdf') && (
        <Field label={kind === 'video' ? 'Video address (YouTube, Vimeo or any link)' : 'Link'} hint={kind === 'file' || kind === 'pdf' ? 'Or attach the file below.' : undefined}>
          <Input value={url} onChange={setUrl} placeholder="https://" />
        </Field>
      )}
      {(kind === 'file' || kind === 'pdf') && <FilePick purpose="study_material" onDone={setFile} />}
      <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" checked={onlyHere} onChange={(e) => setOnlyHere(e.target.checked)} /> Only this section (otherwise every section of the class)</label>
      <div className="flex items-center gap-3">
        <Button disabled={!title.trim()} pending={save.isPending} onClick={() => save.mutate()}>Save lesson</Button>
        <FormNotice error={save.error} />
      </div>
    </div>
  )
}

/* ─── ASSIGNMENTS ─────────────────────────────────────────────────────── */

interface GradeRow {
  student_id: string; full_name: string; roll_no?: number | null; has_login: boolean; status: string; submitted_at?: string | null
  text_answer?: string | null; file_id?: string | null; file_name?: string | null; marks?: number | null; feedback?: string | null
  rubric_scores?: Record<string, number> | null; returned_at?: string | null; missing: boolean; late: boolean
}
interface Gradebook {
  assignment: { id: string; title: string; due_on?: string | null; max_marks: number | null; rubric: RubricRow[] | null; overdue: boolean }
  items: GradeRow[]; summary: { roll: number; submitted: number; missing: number; late: number; graded: number; returned: number }
}

function Assignments({ d, qkey }: { d: CourseDetail; qkey: unknown[] }) {
  const qc = useQueryClient()
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  if (openId) return <GradebookView id={openId} back={() => { setOpenId(null); qc.invalidateQueries({ queryKey: qkey }) }} />
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Assignments" action={<Button onClick={() => setCreating(!creating)}>{creating ? 'Close' : 'Set an assignment'}</Button>} />
        {creating && <AssignmentForm d={d} done={() => { setCreating(false); qc.invalidateQueries({ queryKey: qkey }) }} />}
        <Table head={['Title', 'Due', 'Handed in', 'To mark', 'Returned', '']} empty={!d.assignments.length} emptyLabel="Nothing set in this course yet.">
          {d.assignments.map((a) => (
            <tr key={a.id}>
              <Td><span className="font-medium">{a.title}</span>{a.rubric && <Badge className="ml-2">Rubric</Badge>}</Td>
              <Td>{a.due_on ?? '—'}{a.due_on && a.due_on < d.today && <Badge tone="danger" className="ml-2">Past due</Badge>}</Td>
              <Td>{a.submitted} of {d.roll}</Td>
              <Td>{a.to_mark ? <Badge tone="warning">{a.to_mark}</Badge> : '0'}</Td>
              <Td>{a.returned}</Td>
              <Td><Button size="sm" variant="secondary" onClick={() => setOpenId(a.id)}>Gradebook</Button></Td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  )
}

function AssignmentForm({ d, done }: { d: CourseDetail; done: () => void }) {
  const [title, setTitle] = useState('')
  const [instr, setInstr] = useState('')
  const [due, setDue] = useState('')
  const [max, setMax] = useState('10')
  const [rubric, setRubric] = useState<RubricRow[]>([])
  const [file, setFile] = useState<{ id: string; name: string } | null>(null)
  const save = useMutation({
    mutationFn: () => api.post('/api/v1/lms/assignments', {
      section_id: d.course.section_id, class_subject_id: d.course.class_subject_id, title, instructions: instr, due_on: due || null,
      max_marks: max === '' ? null : Number(max), rubric: rubric.filter((r) => r.criterion.trim() && r.max > 0), file_ids: file ? [file.id] : [],
    }),
    onSuccess: done,
  })
  return (
    <div className="space-y-3 border-b bg-muted/20 px-[var(--card-pad)] py-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Title"><Input value={title} onChange={setTitle} /></Field>
        <Field label="Due on"><Input type="date" value={due} onChange={setDue} /></Field>
        <Field label="Out of" hint={rubric.length ? 'Set by the rubric.' : undefined}><Input type="number" value={rubric.length ? String(rubric.reduce((a, r) => a + (r.max || 0), 0)) : max} onChange={setMax} /></Field>
      </div>
      <Field label="Instructions"><Textarea rows={3} value={instr} onChange={setInstr} /></Field>
      <div className="space-y-2">
        <p className="text-[13px] font-medium text-secondary-foreground">Rubric (optional)</p>
        {rubric.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="w-64"><Input value={r.criterion} onChange={(v) => setRubric(rubric.map((x, j) => (j === i ? { ...x, criterion: v } : x)))} placeholder="Criterion" /></div>
            <div className="w-24"><Input type="number" value={String(r.max)} onChange={(v) => setRubric(rubric.map((x, j) => (j === i ? { ...x, max: Number(v) } : x)))} /></div>
            <Button size="sm" variant="ghost" onClick={() => setRubric(rubric.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button size="sm" variant="secondary" onClick={() => setRubric([...rubric, { criterion: '', max: 5 }])}>Add a criterion</Button>
      </div>
      <FilePick purpose="study_material" onDone={setFile} label="Attach a worksheet" />
      <div className="flex items-center gap-3">
        <Button disabled={!title.trim()} pending={save.isPending} onClick={() => save.mutate()}>Set it</Button>
        <span className="text-[13px] text-muted-foreground">The class and their parents are told.</span>
        <FormNotice error={save.error} />
      </div>
    </div>
  )
}

function GradebookView({ id, back }: { id: string; back: () => void }) {
  const qc = useQueryClient()
  const key = ['lms-gradebook', id]
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Gradebook>(`/api/v1/lms/assignments/${id}/gradebook`) })
  const [marking, setMarking] = useState<string | null>(null)
  const nudge = useMutation({
    mutationFn: (to: string) => api.post<{ missing: number; told: number; unreachable: number }>(`/api/v1/lms/assignments/${id}/nudge`, { to }),
  })
  const giveBack = useMutation({
    mutationFn: () => api.post<{ returned: number }>(`/api/v1/lms/assignments/${id}/return`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  })
  const g = q.data
  if (q.error) return <ErrorState error={q.error} />
  if (!g) return <Loading />
  const s = g.summary
  return (
    <Card>
      <CardHeader title={`Gradebook: ${g.assignment.title}`} action={<Button variant="secondary" onClick={back}><ChevronLeft className="h-4 w-4" /> Assignments</Button>} />
      <div className="flex flex-wrap items-center gap-3 border-b px-[var(--card-pad)] py-3 text-[14px]">
        <span><strong>{s.submitted}</strong> of {s.roll} handed in</span>
        <Badge tone={s.missing ? 'danger' : 'success'}>{s.missing} missing</Badge>
        {s.late > 0 && <Badge tone="warning">{s.late} late</Badge>}
        <span>{s.graded} marked, {s.returned} returned</span>
        <span className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={!s.missing} pending={nudge.isPending} onClick={() => nudge.mutate('both')}>Remind the missing, and their parents</Button>
          <Button size="sm" disabled={s.graded === s.returned} pending={giveBack.isPending} onClick={() => giveBack.mutate()}>Return all marked work</Button>
        </span>
      </div>
      {nudge.data && <p className="border-b px-[var(--card-pad)] py-2 text-[13px]">Reminded {nudge.data.told} people about {nudge.data.missing} children{nudge.data.unreachable ? `; ${nudge.data.unreachable} have no login to reach` : ''}.</p>}
      {giveBack.data && <p className="border-b px-[var(--card-pad)] py-2 text-[13px]">{giveBack.data.returned} returned.</p>}
      <Table head={['Roll', 'Student', 'Status', 'Work', `Marks${g.assignment.max_marks !== null ? ` / ${g.assignment.max_marks}` : ''}`, '']}>
        {g.items.map((r) => (
          <Fragment key={r.student_id}>
            <tr>
              <Td>{r.roll_no ?? ''}</Td>
              <Td>{r.full_name}</Td>
              <Td>
                {r.missing ? <Badge tone="danger">Missing</Badge> : r.status === 'graded' ? <Badge tone="success">{r.returned_at ? 'Returned' : 'Marked'}</Badge> : r.status === 'resubmit' ? <Badge tone="warning">Redo asked</Badge> : <Badge tone="info">Handed in</Badge>}
                {r.late && <Badge tone="warning" className="ml-1">Late</Badge>}
              </Td>
              <Td>
                {r.text_answer && <span className="line-clamp-2 max-w-xs whitespace-pre-wrap">{r.text_answer}</span>}
                {r.file_id && <a className="text-primary hover:underline" href={`/api/v1/files/${r.file_id}`} target="_blank" rel="noreferrer">{r.file_name ?? 'file'}</a>}
              </Td>
              <Td>{r.marks ?? '—'}</Td>
              <Td><Button size="sm" variant="secondary" onClick={() => setMarking(marking === r.student_id ? null : r.student_id)}>{marking === r.student_id ? 'Close' : 'Mark'}</Button></Td>
            </tr>
            {marking === r.student_id && (
              <tr><td colSpan={6} className="bg-muted/20 p-4"><MarkForm id={id} g={g} r={r} done={() => { setMarking(null); qc.invalidateQueries({ queryKey: key }) }} /></td></tr>
            )}
          </Fragment>
        ))}
      </Table>
    </Card>
  )
}

function MarkForm({ id, g, r, done }: { id: string; g: Gradebook; r: GradeRow; done: () => void }) {
  const rubric = g.assignment.rubric
  const [scores, setScores] = useState<Record<string, string>>(Object.fromEntries((rubric ?? []).map((x) => [x.criterion, r.rubric_scores?.[x.criterion] !== undefined ? String(r.rubric_scores[x.criterion]) : ''])))
  const [marks, setMarks] = useState(r.marks !== null && r.marks !== undefined ? String(r.marks) : '')
  const [feedback, setFeedback] = useState(r.feedback ?? '')
  const save = useMutation({
    mutationFn: (v: { give: boolean; redo?: boolean }) => api.post(`/api/v1/lms/assignments/${id}/grade`, {
      student_id: r.student_id, feedback, return: v.give, status: v.redo ? 'resubmit' : 'graded',
      ...(rubric ? { rubric_scores: Object.fromEntries(Object.entries(scores).filter(([, x]) => x !== '').map(([kk, x]) => [kk, Number(x)])) } : { marks: marks === '' ? null : Number(marks) }),
    }),
    onSuccess: done,
  })
  return (
    <div className="space-y-3">
      {r.text_answer && <div className="max-w-2xl whitespace-pre-wrap rounded-md border bg-background p-3 text-[14px]">{r.text_answer}</div>}
      <div className="flex flex-wrap gap-3">
        {rubric ? rubric.map((x) => (
          <div key={x.criterion} className="w-40"><Field label={`${x.criterion} (of ${x.max})`}><Input type="number" value={scores[x.criterion] ?? ''} onChange={(v) => setScores({ ...scores, [x.criterion]: v })} /></Field></div>
        )) : <div className="w-40"><Field label={`Marks${g.assignment.max_marks !== null ? ` (of ${g.assignment.max_marks})` : ''}`}><Input type="number" value={marks} onChange={setMarks} /></Field></div>}
      </div>
      <Field label="Comments for the student"><Textarea rows={2} value={feedback} onChange={setFeedback} /></Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button pending={save.isPending} onClick={() => save.mutate({ give: true })}>Save and return</Button>
        <Button variant="secondary" pending={save.isPending} onClick={() => save.mutate({ give: false })}>Save, return later</Button>
        <Button variant="ghost" pending={save.isPending} onClick={() => save.mutate({ give: true, redo: true })}>Ask for a redo</Button>
        <FormNotice error={save.error} />
      </div>
    </div>
  )
}

/* ─── QUIZZES ─────────────────────────────────────────────────────────── */

interface DraftQ { stem: string; options: string[]; correct: number; marks?: number }

function Quizzes({ d, qkey }: { d: CourseDetail; qkey: unknown[] }) {
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [results, setResults] = useState<string | null>(null)
  const status = useMutation({
    mutationFn: (v: { id: string; status: string }) => api.post(`/api/v1/lms/quizzes/${v.id}/status`, { status: v.status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qkey }),
  })
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Quizzes" action={<Button onClick={() => setCreating(!creating)}>{creating ? 'Close' : 'New quiz'}</Button>} />
        {creating && <QuizForm d={d} done={() => { setCreating(false); qc.invalidateQueries({ queryKey: qkey }) }} />}
        <Table head={['Title', 'Questions', 'Time limit', 'Taken', 'Status', '']} empty={!d.quizzes.length} emptyLabel="No quizzes in this course yet.">
          {d.quizzes.map((z) => (
            <tr key={z.id}>
              <Td><span className="font-medium">{z.title}</span></Td>
              <Td>{z.questions}</Td>
              <Td>{z.duration_minutes ? `${z.duration_minutes} min` : 'None'}</Td>
              <Td>{z.attempted} of {d.roll}</Td>
              <Td><Badge tone={z.status === 'published' ? 'success' : 'neutral'}>{z.status === 'published' ? 'Open' : z.status === 'closed' ? 'Closed' : 'Draft'}</Badge></Td>
              <Td>
                <span className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setResults(results === z.id ? null : z.id)}>Results</Button>
                  <Button size="sm" variant="ghost" onClick={() => status.mutate({ id: z.id, status: z.status === 'published' ? 'closed' : 'published' })}>{z.status === 'published' ? 'Close' : 'Open'}</Button>
                </span>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      {results && <QuizResults id={results} />}
    </div>
  )
}

function QuizResults({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['lms-quiz-results', id],
    queryFn: () => api.get<{ quiz: { title: string; max_score: number | null }; items: { student_id: string; full_name: string; roll_no?: number; best: number | null; attempts: number; last_status?: string | null }[] }>(`/api/v1/lms/quizzes/${id}/results`),
  })
  if (!q.data) return q.error ? <ErrorState error={q.error} /> : <Loading />
  return (
    <Card>
      <CardHeader title={`Results: ${q.data.quiz.title}`} />
      <Table head={['Roll', 'Student', 'Best score', 'Attempts']}>
        {q.data.items.map((r) => (
          <tr key={r.student_id}>
            <Td>{r.roll_no ?? ''}</Td><Td>{r.full_name}</Td>
            <Td>{r.best === null ? <span className="text-muted-foreground">Not taken</span> : `${r.best} / ${q.data!.quiz.max_score ?? ''}`}{r.last_status === 'timed_out' && <Badge tone="warning" className="ml-2">Out of time</Badge>}</Td>
            <Td>{r.attempts}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

function QuizForm({ d, done }: { d: CourseDetail; done: () => void }) {
  const [title, setTitle] = useState('')
  const [mins, setMins] = useState('15')
  const [closes, setCloses] = useState('')
  const [qs, setQs] = useState<DraftQ[]>([{ stem: '', options: ['', '', '', ''], correct: 0 }])
  const [aiLesson, setAiLesson] = useState('')
  const [aiNote, setAiNote] = useState('')
  const lessons = d.units.flatMap((u) => u.lessons.filter((l) => l.kind === 'text' || l.body))
  const draft = useMutation({
    mutationFn: () => api.post<{ configured: boolean; message?: string; questions: DraftQ[] }>('/api/v1/lms/ai/quiz-draft', { lesson_id: aiLesson, count: 5 }),
    onSuccess: (r) => {
      if (!r.configured) { setAiNote(r.message ?? 'AI drafting is not set up for this school.'); return }
      if (!r.questions.length) { setAiNote('The AI returned nothing usable. Try a longer lesson.'); return }
      setQs([...qs.filter((x) => x.stem.trim()), ...r.questions.map((x) => ({ ...x, options: [...x.options] }))])
      setAiNote(`${r.questions.length} questions drafted by AI. Check every one before you save.`)
    },
  })
  const save = useMutation({
    mutationFn: () => api.post('/api/v1/lms/quizzes', {
      section_id: d.course.section_id, class_subject_id: d.course.class_subject_id, title, duration_minutes: mins === '' ? null : Number(mins),
      closes_at: closes ? new Date(closes).toISOString() : null,
      questions: qs.filter((x) => x.stem.trim()).map((x) => {
        const opts = x.options.map((o, i) => ({ o: o.trim(), i })).filter((y) => y.o)
        return { stem: x.stem, options: opts.map((y) => y.o), correct: Math.max(0, opts.findIndex((y) => y.i === x.correct)), marks: x.marks ?? 1 }
      }),
    }),
    onSuccess: done,
  })
  const set = (i: number, v: Partial<DraftQ>) => setQs(qs.map((x, j) => (j === i ? { ...x, ...v } : x)))
  return (
    <div className="space-y-4 border-b bg-muted/20 px-[var(--card-pad)] py-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Title"><Input value={title} onChange={setTitle} /></Field>
        <Field label="Time limit, minutes" hint="Empty for no limit."><Input type="number" value={mins} onChange={setMins} /></Field>
        <Field label="Closes at" hint="Optional."><Input type="datetime-local" value={closes} onChange={setCloses} /></Field>
      </div>
      {lessons.length > 0 && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed p-3">
          <Sparkles className="mb-2 h-4 w-4 text-primary" />
          <div className="w-72"><Field label="Optional: draft questions with AI from a lesson"><Select value={aiLesson} onChange={setAiLesson} placeholder="Choose a lesson" options={lessons.map((l) => ({ value: l.id, label: l.title }))} /></Field></div>
          <Button variant="secondary" disabled={!aiLesson} pending={draft.isPending} onClick={() => draft.mutate()}>AI draft</Button>
          {aiNote && <span className="text-[13px] text-muted-foreground">{aiNote}</span>}
          <FormNotice error={draft.error} />
        </div>
      )}
      {qs.map((x, i) => (
        <div key={i} className="space-y-2 rounded-md border bg-background p-3">
          <Field label={`Question ${i + 1}`}><Textarea rows={2} value={x.stem} onChange={(v) => set(i, { stem: v })} /></Field>
          {x.options.map((o, j) => (
            <label key={j} className="flex items-center gap-2 text-[14px]">
              <input type="radio" name={`q${i}`} checked={x.correct === j} onChange={() => set(i, { correct: j })} aria-label={`Option ${j + 1} is correct`} />
              <div className="w-96"><Input value={o} onChange={(v) => set(i, { options: x.options.map((y, k) => (k === j ? v : y)) })} placeholder={`Option ${j + 1}`} /></div>
            </label>
          ))}
          <div className="flex gap-2">
            {x.options.length < 6 && <Button size="sm" variant="ghost" onClick={() => set(i, { options: [...x.options, ''] })}>Add option</Button>}
            <Button size="sm" variant="ghost" onClick={() => setQs(qs.filter((_, j) => j !== i))}>Remove question</Button>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => setQs([...qs, { stem: '', options: ['', '', '', ''], correct: 0 }])}>Add a question</Button>
        <Button disabled={!title.trim() || !qs.some((x) => x.stem.trim())} pending={save.isPending} onClick={() => save.mutate()}>Publish quiz</Button>
        <span className="text-[13px] text-muted-foreground">Mark the correct option with the circle. Marked the moment a child hands in.</span>
        <FormNotice error={save.error} />
      </div>
    </div>
  )
}
