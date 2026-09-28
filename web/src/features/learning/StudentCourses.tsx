import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ChevronLeft, Circle, Clock } from 'lucide-react'
import { api } from '@/lib/api'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, FormNotice, Loading, PageBody, PageHead, Textarea } from '@/components/ui'
import { FilePick, KIND_LABEL, KindIcon, LessonContent, type RubricRow, type Unit } from './lms-shared'

/* THE CHILD'S COURSES (worker routes/portal/lms.ts).

   Every subject of their class, with how far through they are; inside one,
   the lessons by unit and day (ticked off as they are finished), the
   assignments with what they handed in and, once returned, the marks and the
   teacher's comments, and the quizzes, taken here against the clock. A
   parent opening this reads it; only the child's own login does the work. */

interface CourseRow { class_subject_id: string; subject: string; teacher?: string | null; lessons: number; completed: number; to_do: number; quizzes_open: number }
interface Assignment {
  id: string; title: string; instructions?: string | null; due_on?: string | null; max_marks?: number | null; rubric: RubricRow[] | null
  allow_submission: boolean; status: string; submitted_at?: string | null; text_answer?: string | null; file_id?: string | null; file_name?: string | null
  returned_at?: string | null; marks?: number | null; feedback?: string | null; rubric_scores?: Record<string, number> | null
  files: { file_id: string; name: string }[]; overdue: boolean; late: boolean
}
interface Quiz { id: string; title: string; instructions?: string | null; closes_at?: string | null; duration_minutes?: number | null; questions: number; max_score?: number | null; attempts: number; max_attempts: number; best?: number | null; open: boolean; open_attempt?: string | null }
interface Detail { student_id: string; course: { subject: string; teacher?: string | null }; today: string; units: Unit[]; assignments: Assignment[]; quizzes: Quiz[] }
interface Todo {
  assignments: { id: string; title: string; subject?: string; class_subject_id?: string; due_on?: string | null; overdue: boolean; status: string }[]
  quizzes: { id: string; title: string; subject: string; class_subject_id: string; closes_at?: string | null; duration_minutes?: number | null }[]
  lessons: { id: string; title: string; subject: string; class_subject_id: string; unit: string }[]
}

export default function StudentCourses() {
  const [open, setOpen] = useState<string | null>(null)
  if (open) return <Course cs={open} back={() => setOpen(null)} />
  return <List onOpen={setOpen} />
}

function List({ onOpen }: { onOpen: (cs: string) => void }) {
  const q = useQuery({ queryKey: ['my-courses'], queryFn: () => api.get<{ class_name: string; section_name: string; items: CourseRow[] }>('/api/v1/portal/lms/courses') })
  const todo = useQuery({ queryKey: ['my-lms-todo'], queryFn: () => api.get<Todo>('/api/v1/portal/lms/todo') })
  const t = todo.data
  const count = t ? t.assignments.length + t.quizzes.length : 0
  return (
    <>
      <PageHead eyebrow="Learning" title="My courses" />
      <PageBody>
        {q.error ? <ErrorState error={q.error} /> : !q.data ? <Loading /> : (
          <div className="space-y-4">
            <Card>
              <CardHeader title={count ? `To do (${count})` : 'To do'} />
              {!t ? <Loading /> : !count && !t.lessons.length ? <p className="px-[var(--card-pad)] py-4 text-[14px] text-muted-foreground">Nothing waiting. Well done.</p> : (
                <ul className="divide-y text-[14px]">
                  {t.assignments.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2 px-[var(--card-pad)] py-2.5">
                      <Badge tone={a.overdue ? 'danger' : 'warning'}>{a.overdue ? 'Overdue' : 'Hand in'}</Badge>
                      <button type="button" className="font-medium hover:underline" onClick={() => a.class_subject_id && onOpen(a.class_subject_id)}>{a.title}</button>
                      <span className="text-muted-foreground">{a.subject}{a.due_on ? ` · due ${a.due_on}` : ''}{a.status === 'resubmit' ? ' · your teacher asked for a redo' : ''}</span>
                    </li>
                  ))}
                  {t.quizzes.map((z) => (
                    <li key={z.id} className="flex flex-wrap items-center gap-2 px-[var(--card-pad)] py-2.5">
                      <Badge tone="info">Quiz</Badge>
                      <button type="button" className="font-medium hover:underline" onClick={() => onOpen(z.class_subject_id)}>{z.title}</button>
                      <span className="text-muted-foreground">{z.subject}{z.duration_minutes ? ` · ${z.duration_minutes} min` : ''}</span>
                    </li>
                  ))}
                  {t.lessons.slice(0, 3).map((l) => (
                    <li key={l.id} className="flex flex-wrap items-center gap-2 px-[var(--card-pad)] py-2.5">
                      <Badge>Next lesson</Badge>
                      <button type="button" className="font-medium hover:underline" onClick={() => onOpen(l.class_subject_id)}>{l.title}</button>
                      <span className="text-muted-foreground">{l.subject} · {l.unit}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {!q.data.items.length ? <EmptyState title="No subjects yet" body="Your class has no subjects set up yet." /> : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {q.data.items.map((c) => {
                  const pct = c.lessons ? Math.round((100 * c.completed) / c.lessons) : 0
                  return (
                    <button key={c.class_subject_id} type="button" onClick={() => onOpen(c.class_subject_id)} className="card p-4 text-left transition hover:border-primary">
                      <p className="text-[16px] font-semibold">{c.subject}</p>
                      <p className="text-[13px] text-muted-foreground">{c.teacher ?? 'Teacher not set'}</p>
                      <div className="mt-3 h-2 rounded bg-muted" aria-hidden><div className="h-2 rounded bg-primary" style={{ width: `${pct}%` }} /></div>
                      <p className="mt-1.5 text-[13px]">{c.lessons ? `${c.completed} of ${c.lessons} lessons done` : 'No lessons yet'}</p>
                      <p className="mt-1 flex gap-2">
                        {c.to_do > 0 && <Badge tone="warning">{c.to_do} to hand in</Badge>}
                        {c.quizzes_open > 0 && <Badge tone="info">{c.quizzes_open} quiz open</Badge>}
                      </p>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </PageBody>
    </>
  )
}

function Course({ cs, back }: { cs: string; back: () => void }) {
  const qc = useQueryClient()
  const key = ['my-course', cs]
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Detail>(`/api/v1/portal/lms/course?class_subject_id=${cs}`) })
  const [openLesson, setOpenLesson] = useState<string | null>(null)
  const [quiz, setQuiz] = useState<string | null>(null)
  const done = useMutation({
    mutationFn: (v: { id: string; done: boolean }) => api.post(`/api/v1/portal/lms/lessons/${v.id}/complete`, { done: v.done }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['my-courses'] }) },
  })
  const d = q.data
  if (quiz) return <TakeQuiz id={quiz} back={() => { setQuiz(null); qc.invalidateQueries({ queryKey: key }) }} />
  const total = d ? d.units.reduce((a, u) => a + u.lessons.length, 0) : 0
  const finished = d ? d.units.reduce((a, u) => a + u.lessons.filter((l) => l.done).length, 0) : 0
  return (
    <>
      <PageHead eyebrow="Learning · My courses" title={d?.course.subject ?? 'Course'} actions={<Button variant="secondary" onClick={back}><ChevronLeft className="h-4 w-4" /> My courses</Button>} />
      <PageBody>
        {q.error ? <ErrorState error={q.error} /> : !d ? <Loading /> : (
          <div className="space-y-4">
            <p className="text-[14px] text-muted-foreground">{d.course.teacher ? `Taught by ${d.course.teacher}. ` : ''}{total ? `${finished} of ${total} lessons done.` : ''}</p>
            {d.units.map((u) => (
              <Card key={u.id}>
                <CardHeader title={u.title} />
                <ul className="divide-y">
                  {u.lessons.map((l) => (
                    <li key={l.id} className="px-[var(--card-pad)] py-2.5">
                      <div className="flex flex-wrap items-center gap-2 text-[14px]">
                        {l.done ? <CheckCircle2 className="h-4 w-4 text-success" aria-label="Done" /> : <Circle className="h-4 w-4 text-muted-foreground" aria-label="Not done" />}
                        <KindIcon kind={l.kind} />
                        <button type="button" className="font-medium hover:underline" onClick={() => setOpenLesson(openLesson === l.id ? null : l.id)}>{l.title}</button>
                        {l.day ? <Badge>Day {l.day}</Badge> : null}
                        <Badge>{KIND_LABEL[l.kind]}</Badge>
                      </div>
                      {openLesson === l.id && (
                        <div className="mt-3 space-y-3 pl-6">
                          <LessonContent l={l} />
                          <Button size="sm" variant={l.done ? 'secondary' : 'primary'} pending={done.isPending} onClick={() => done.mutate({ id: l.id, done: !l.done })}>
                            {l.done ? 'Mark as not done' : 'Mark as done'}
                          </Button>
                          <FormNotice error={done.error} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
            {!d.units.length && <EmptyState title="No lessons yet" body="Your teacher has not added lessons to this course yet." />}
            <Card>
              <CardHeader title="Assignments" />
              {!d.assignments.length ? <p className="px-[var(--card-pad)] py-4 text-[14px] text-muted-foreground">Nothing set yet.</p> : (
                <ul className="divide-y">{d.assignments.map((a) => <AssignmentItem key={a.id} a={a} qkey={key} />)}</ul>
              )}
            </Card>
            <Card>
              <CardHeader title="Quizzes" />
              {!d.quizzes.length ? <p className="px-[var(--card-pad)] py-4 text-[14px] text-muted-foreground">No quizzes yet.</p> : (
                <ul className="divide-y">
                  {d.quizzes.map((z) => (
                    <li key={z.id} className="flex flex-wrap items-center gap-2 px-[var(--card-pad)] py-2.5 text-[14px]">
                      <span className="font-medium">{z.title}</span>
                      <span className="text-muted-foreground">{z.questions} questions{z.duration_minutes ? ` · ${z.duration_minutes} min` : ''}</span>
                      {z.best !== null && z.best !== undefined && <Badge tone="success">Scored {z.best} / {z.max_score}</Badge>}
                      <span className="ml-auto">
                        {z.open_attempt ? <Button size="sm" onClick={() => setQuiz(z.id)}>Carry on</Button>
                          : z.open ? <Button size="sm" onClick={() => setQuiz(z.id)}>Start</Button>
                            : <span className="text-muted-foreground">{z.attempts >= z.max_attempts ? 'Done' : 'Closed'}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </PageBody>
    </>
  )
}

function AssignmentItem({ a, qkey }: { a: Assignment; qkey: unknown[] }) {
  const qc = useQueryClient()
  const [text, setText] = useState(a.text_answer ?? '')
  const [file, setFile] = useState<{ id: string; name: string } | null>(null)
  const [open, setOpen] = useState(false)
  const canHandIn = a.allow_submission && a.status !== 'graded'
  const submit = useMutation({
    mutationFn: () => api.post<{ late: boolean }>(`/api/v1/portal/lms/assignments/${a.id}/submit`, { text_answer: text, file_id: file?.id ?? a.file_id ?? undefined }),
    onSuccess: () => { setOpen(false); qc.invalidateQueries({ queryKey: qkey }); qc.invalidateQueries({ queryKey: ['my-lms-todo'] }) },
  })
  const handed = !!a.submitted_at && a.status !== 'resubmit'
  return (
    <li className="space-y-2 px-[var(--card-pad)] py-3 text-[14px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{a.title}</span>
        {a.due_on && <span className="text-muted-foreground">due {a.due_on}</span>}
        {a.returned_at && a.status === 'graded' ? <Badge tone="success">Marked{a.marks !== null && a.marks !== undefined ? `: ${a.marks}${a.max_marks ? ` / ${a.max_marks}` : ''}` : ''}</Badge>
          : a.status === 'resubmit' ? <Badge tone="warning">Redo asked</Badge>
            : handed ? <Badge tone="info">{a.late ? 'Handed in late' : 'Handed in'}</Badge>
              : a.overdue ? <Badge tone="danger">Overdue</Badge> : a.allow_submission ? <Badge tone="warning">To hand in</Badge> : <Badge>In your notebook</Badge>}
        {canHandIn && <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setOpen(!open)}>{open ? 'Close' : handed ? 'Change what I handed in' : 'Hand in'}</Button>}
      </div>
      {a.instructions && <p className="whitespace-pre-wrap text-muted-foreground">{a.instructions}</p>}
      {a.files.map((f) => <a key={f.file_id} href={`/api/v1/files/${f.file_id}`} target="_blank" rel="noreferrer" className="mr-3 text-primary hover:underline">{f.name}</a>)}
      {a.returned_at && (a.feedback || a.rubric_scores) && (
        <div className="rounded-md border bg-muted/30 p-3">
          {a.rubric && a.rubric_scores && <p>{a.rubric.map((r) => `${r.criterion}: ${a.rubric_scores?.[r.criterion] ?? '—'} / ${r.max}`).join(' · ')}</p>}
          {a.feedback && <p className="mt-1"><span className="font-medium">Your teacher: </span>{a.feedback}</p>}
        </div>
      )}
      {open && (
        <div className="space-y-2">
          <Field label="Your answer"><Textarea rows={5} value={text} onChange={setText} /></Field>
          <FilePick purpose="homework_submission" onDone={setFile} label={a.file_id ? 'Replace the file' : 'Attach a file'} />
          {a.file_id && !file && <p className="text-[13px] text-muted-foreground">Handed in with: {a.file_name}</p>}
          <div className="flex items-center gap-2">
            <Button disabled={!text.trim() && !file && !a.file_id} pending={submit.isPending} onClick={() => submit.mutate()}>Hand in</Button>
            {a.due_on && a.due_on < new Date().toISOString().slice(0, 10) && <span className="text-[13px] text-warning">This will be marked late.</span>}
            <FormNotice error={submit.error} />
          </div>
        </div>
      )}
    </li>
  )
}

interface Started {
  attempt_id: string; deadline: string | null; server_now: string
  quiz: { title: string; instructions?: string | null; duration_minutes?: number | null }
  questions: { test_question_id: string; stem: string; marks: number; options: { id: string; body: string }[] }[]
}

function TakeQuiz({ id, back }: { id: string; back: () => void }) {
  const start = useQuery({ queryKey: ['quiz-start', id], queryFn: () => api.post<Started>(`/api/v1/portal/lms/quizzes/${id}/start`, {}), staleTime: Infinity, retry: false })
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [left, setLeft] = useState<number | null>(null)
  const s = start.data
  const submit = useMutation({
    mutationFn: () => api.post<{ score: number; max_score: number; timed_out: boolean; review: { test_question_id: string; correct: string | null; right: boolean }[] }>(`/api/v1/portal/lms/quizzes/${id}/submit`, { attempt_id: s!.attempt_id, answers }),
  })
  useEffect(() => {
    if (!s?.deadline) return
    const skew = Date.parse(s.server_now) - Date.now()
    const tick = () => {
      const ms = Date.parse(s.deadline!) - (Date.now() + skew)
      setLeft(Math.max(0, Math.floor(ms / 1000)))
      if (ms <= 0 && !submit.isPending && !submit.data) submit.mutate()
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.deadline, submit.data])
  const r = submit.data
  return (
    <>
      <PageHead eyebrow="Learning · Quiz" title={s?.quiz.title ?? 'Quiz'} actions={<Button variant="secondary" onClick={back}><ChevronLeft className="h-4 w-4" /> Back to the course</Button>} />
      <PageBody>
        {start.error ? <ErrorState error={start.error} /> : !s ? <Loading /> : r ? (
          <Card>
            <div className="space-y-2 p-6 text-center">
              <p className="text-[32px] font-semibold">{r.score} / {r.max_score}</p>
              <p className="text-muted-foreground">{r.timed_out ? 'The time ran out before this was handed in, so the answers could not be counted.' : 'Marked. Your teacher sees this score too.'}</p>
              {r.review.length > 0 && <p className="text-[14px]">{r.review.filter((x) => x.right).length} of {r.review.length} right.</p>}
              <Button onClick={back}>Back to the course</Button>
            </div>
          </Card>
        ) : (
          <div className="space-y-4">
            {left !== null && (
              <p className={`sticky top-2 z-10 inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-[15px] font-medium ${left < 60 ? 'text-destructive' : ''}`}>
                <Clock className="h-4 w-4" /> {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} left
              </p>
            )}
            {s.quiz.instructions && <p className="text-[14px] text-muted-foreground">{s.quiz.instructions}</p>}
            {s.questions.map((q, i) => (
              <Card key={q.test_question_id}>
                <fieldset className="space-y-2 p-4">
                  <legend className="mb-2 text-[15px] font-medium">{i + 1}. {q.stem} <span className="text-[12px] text-muted-foreground">({q.marks} mark{q.marks === 1 ? '' : 's'})</span></legend>
                  {q.options.map((o) => (
                    <label key={o.id} className="flex items-center gap-2 text-[14px]">
                      <input type="radio" name={q.test_question_id} checked={answers[q.test_question_id] === o.id} onChange={() => setAnswers({ ...answers, [q.test_question_id]: o.id })} />
                      {o.body}
                    </label>
                  ))}
                </fieldset>
              </Card>
            ))}
            <div className="flex items-center gap-3">
              <Button pending={submit.isPending} onClick={() => { if (Object.keys(answers).length === s.questions.length || window.confirm('Some questions have no answer. Hand in anyway?')) submit.mutate() }}>Hand in</Button>
              <span className="text-[13px] text-muted-foreground">{Object.keys(answers).length} of {s.questions.length} answered</span>
              <FormNotice error={submit.error} />
            </div>
          </div>
        )}
      </PageBody>
    </>
  )
}
