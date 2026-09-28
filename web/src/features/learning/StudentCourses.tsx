import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CheckCircle2, ChevronLeft, ChevronRight, Circle, Clock, PlayCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, FormNotice, Loading, PageBody, PageHead, Textarea } from '@/components/ui'
import {
  FilePick, KIND_LABEL, KindChip, KindIcon, LessonContent, ProgressRing, TypeCounts, dateRange, fmtWhen, itemKind, moduleItems, sourceMeta,
  type ModuleItem, type RubricRow, type SourceKind, type Unit,
} from './lms-shared'

/* THE CHILD'S COURSES (worker routes/portal/lms.ts).

   Every subject of their class, with how far through they are. Inside one,
   module first: each module with a progress ring, and "continue where you
   left off". A module lists its sources (video, PDF, notes, file, link,
   image, audio, slides) with its assignments and quizzes in the teacher's
   order; opening one shows its viewer, a way to mark it done (a library
   video marks itself at 90% watched), and previous / next through the
   module. Assignments show what was handed in and, once returned, the marks
   and comments; quizzes are taken here against the clock. A parent opening
   this reads it; only the child's own login does the work. */

interface CourseRow { class_subject_id: string; subject: string; teacher?: string | null; lessons: number; completed: number; to_do: number; quizzes_open: number }
interface Assignment {
  id: string; title: string; instructions?: string | null; due_on?: string | null; max_marks?: number | null; rubric: RubricRow[] | null
  allow_submission: boolean; status: string; submitted_at?: string | null; text_answer?: string | null; file_id?: string | null; file_name?: string | null
  returned_at?: string | null; marks?: number | null; feedback?: string | null; rubric_scores?: Record<string, number> | null
  files: { file_id: string; name: string }[]; overdue: boolean; late: boolean; lms_unit_id?: string | null; lms_sequence?: number | null
}
interface Quiz { id: string; title: string; instructions?: string | null; closes_at?: string | null; duration_minutes?: number | null; questions: number; max_score?: number | null; attempts: number; max_attempts: number; best?: number | null; open: boolean; open_attempt?: string | null; lms_unit_id?: string | null; lms_sequence?: number | null }
interface Detail {
  student_id: string; course: { subject: string; teacher?: string | null }; today: string; units: Unit[]; assignments: Assignment[]; quizzes: Quiz[]
  resume: { lesson_id: string; unit_id: string; title: string; kind: SourceKind; started: boolean } | null
}
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
                      <Badge>Up next</Badge>
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
                      <p className="mt-1.5 text-[13px]">{c.lessons ? `${c.completed} of ${c.lessons} sources done` : 'Nothing added yet'}</p>
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

type Item = ModuleItem
const OTHER = 'other'

function Course({ cs, back }: { cs: string; back: () => void }) {
  const qc = useQueryClient()
  const key = ['my-course', cs]
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Detail>(`/api/v1/portal/lms/course?class_subject_id=${cs}`) })
  const [where, setWhere] = useState<{ unit: string | null; item: string | null }>({ unit: null, item: null })
  const [quiz, setQuiz] = useState<string | null>(null)
  const top = useRef<HTMLDivElement>(null)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    top.current?.scrollIntoView({ block: 'start' })
  }, [where.unit, where.item, quiz])
  const refresh = () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['my-courses'] }); qc.invalidateQueries({ queryKey: ['my-lms-todo'] }) }
  const d = q.data
  if (quiz) return <div ref={top}><TakeQuiz id={quiz} back={() => { setQuiz(null); refresh() }} /></div>

  const units = d?.units ?? []
  const other: Unit = { id: OTHER, title: 'Other work', lessons: [] }
  const loose = d ? moduleItems(other, d.assignments.filter((a) => !a.lms_unit_id).map((a) => ({ ...a, lms_unit_id: OTHER })), d.quizzes.filter((z) => !z.lms_unit_id).map((z) => ({ ...z, lms_unit_id: OTHER }))) : []
  const itemsOf = (u: Unit): Item[] => (!d ? [] : u.id === OTHER ? loose : moduleItems(u, d.assignments, d.quizzes))
  const isDone = (i: Item) => {
    if (!d) return false
    if (i.type === 'lesson') return !!i.lesson.done
    if (i.type === 'assignment') { const a = d.assignments.find((x) => x.id === i.id); return !!a && (a.status === 'graded' || (!!a.submitted_at && a.status !== 'resubmit') || !a.allow_submission) }
    const z = d.quizzes.find((x) => x.id === i.id); return !!z && z.attempts > 0
  }
  const unit = where.unit === OTHER ? other : units.find((u) => u.id === where.unit)
  const n = unit ? units.indexOf(unit) + 1 : 0
  const items = unit ? itemsOf(unit) : []
  const idx = items.findIndex((i) => `${i.type}:${i.id}` === where.item)
  const item = idx >= 0 ? items[idx] : null
  const all = units.flatMap(itemsOf)
  const doneAll = all.filter(isDone).length
  return (
    <div ref={top} className="scroll-mt-4">
      <PageHead
        eyebrow={unit ? `My courses · ${d?.course.subject ?? ''}` : 'Learning · My courses'}
        title={item ? (item.type === 'lesson' ? item.lesson.title : item.title) : unit ? unit.title : d?.course.subject ?? 'Course'}
        actions={
          <Button variant="secondary" onClick={() => (item ? setWhere({ unit: where.unit, item: null }) : unit ? setWhere({ unit: null, item: null }) : back())}>
            <ChevronLeft className="h-4 w-4" /> {item ? (unit!.id === OTHER ? 'Other work' : `Module ${n}`) : unit ? 'All modules' : 'My courses'}
          </Button>
        }
      />
      <PageBody>
        {q.error ? <ErrorState error={q.error} /> : !d ? <Loading /> : item && unit ? (
          <ItemPage d={d} qkey={key} unit={unit} n={n} items={items} idx={idx} isDone={isDone} refresh={refresh}
            go={(i) => setWhere({ unit: unit.id, item: i ? `${i.type}:${i.id}` : null })} onQuiz={setQuiz}
            nextModule={() => { const nu = units[units.indexOf(unit) + 1]; setWhere({ unit: nu ? nu.id : null, item: null }) }} hasNextModule={unit.id !== OTHER && units.indexOf(unit) < units.length - 1} />
        ) : unit ? (
          <ModulePage unit={unit} n={n} items={items} isDone={isDone} open={(i) => setWhere({ unit: unit.id, item: `${i.type}:${i.id}` })} />
        ) : (
          <div className="space-y-4">
            <Card>
              <div className="flex flex-wrap items-center gap-4 px-[var(--card-pad)] py-4">
                <ProgressRing pct={all.length ? Math.round((100 * doneAll) / all.length) : 0} size={56} />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold">{all.length ? `${doneAll} of ${all.length} done` : 'Nothing to do yet'}</p>
                  <p className="text-[13px] text-muted-foreground">{d.course.teacher ? `Taught by ${d.course.teacher}` : 'Teacher not set'} · {units.length} module{units.length === 1 ? '' : 's'}</p>
                </div>
              </div>
              {d.resume && (() => {
                const ru = units.find((u) => u.id === d.resume!.unit_id)
                if (!ru) return null
                return (
                  <button type="button" onClick={() => setWhere({ unit: ru.id, item: `lesson:${d.resume!.lesson_id}` })}
                    className="flex w-full items-center gap-3 border-t px-[var(--card-pad)] py-3 text-left hover:bg-primary/[0.03]">
                    <KindChip kind={d.resume.kind} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] font-medium uppercase tracking-wide text-primary">{d.resume.started ? 'Continue where you left off' : 'Start here'}</span>
                      <span className="block truncate text-[15px] font-medium">{d.resume.title}</span>
                      <span className="block truncate text-[13px] text-muted-foreground">Module {units.indexOf(ru) + 1} · {ru.title}</span>
                    </span>
                    <PlayCircle className="h-6 w-6 shrink-0 text-primary" />
                  </button>
                )
              })()}
            </Card>
            {!units.length && !loose.length ? <EmptyState title="Nothing here yet" body="Your teacher has not added any modules to this course yet." /> : (
              <ol className="space-y-3">
                {units.map((u, i) => {
                  const its = itemsOf(u), done = its.filter(isDone).length, fresh = u.lessons.filter((l) => l.is_new).length
                  const range = dateRange(u.starts_on, u.ends_on)
                  return (
                    <li key={u.id}>
                      <button type="button" onClick={() => setWhere({ unit: u.id, item: null })} className="card flex w-full items-center gap-3 px-[var(--card-pad)] py-4 text-left">
                        <ProgressRing pct={its.length ? Math.round((100 * done) / its.length) : 0} label={`${done} of ${its.length} done`} />
                        <span className="min-w-0 flex-1 space-y-1">
                          <span className="block text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Module {i + 1}{range ? ` · ${range}` : ''}</span>
                          <span className="flex flex-wrap items-center gap-2"><span className="text-[16px] font-semibold leading-snug">{u.title}</span>{fresh > 0 && <Badge tone="primary">{fresh} new</Badge>}</span>
                          {u.description && <span className="block text-[13px] text-muted-foreground line-clamp-2">{u.description}</span>}
                          <span className="flex flex-wrap items-center gap-x-3 gap-y-1"><TypeCounts items={its} /><span className="text-[13px] text-muted-foreground">{done} of {its.length} done</span></span>
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </button>
                    </li>
                  )
                })}
                {loose.length > 0 && (
                  <li>
                    <button type="button" onClick={() => setWhere({ unit: OTHER, item: null })} className="card flex w-full items-center gap-3 px-[var(--card-pad)] py-4 text-left">
                      <ProgressRing pct={Math.round((100 * loose.filter(isDone).length) / loose.length)} />
                      <span className="min-w-0 flex-1 space-y-1">
                        <span className="block text-[16px] font-semibold">Other work</span>
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-1"><TypeCounts items={loose} /><span className="text-[13px] text-muted-foreground">Assignments and quizzes not in a module</span></span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                )}
              </ol>
            )}
          </div>
        )}
      </PageBody>
    </div>
  )
}

function itemTitle(i: Item) { return i.type === 'lesson' ? i.lesson.title : i.title }

function ModulePage({ unit, n, items, isDone, open }: { unit: Unit; n: number; items: Item[]; isDone: (i: Item) => boolean; open: (i: Item) => void }) {
  const done = items.filter(isDone).length
  const range = dateRange(unit.starts_on, unit.ends_on)
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center gap-4 px-[var(--card-pad)] py-4">
          <ProgressRing pct={items.length ? Math.round((100 * done) / items.length) : 0} size={56} />
          <div className="min-w-0 flex-1 space-y-0.5">
            {unit.id !== OTHER && <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Module {n}{range ? ` · ${range}` : ''}</p>}
            <p className="text-[15px] font-semibold">{done} of {items.length} done</p>
            {unit.description && <p className="text-[14px] text-muted-foreground">{unit.description}</p>}
          </div>
        </div>
      </Card>
      {!items.length ? <EmptyState title="Nothing here yet" body="Your teacher has not added anything to this module yet." /> : (
        <Card>
          <ol className="divide-y">
            {items.map((i) => {
              const k = itemKind(i), ok = isDone(i)
              const meta = i.type === 'lesson' ? sourceMeta(i.lesson) : ''
              return (
                <li key={`${i.type}:${i.id}`}>
                  <button type="button" onClick={() => open(i)} className="flex min-h-[64px] w-full items-center gap-3 px-[var(--card-pad)] py-2.5 text-left hover:bg-muted/40">
                    <KindChip kind={k} done={ok} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-medium leading-snug [overflow-wrap:anywhere]">{itemTitle(i)}</span>
                      <span className="block text-[13px] text-muted-foreground">{KIND_LABEL[k]}{meta ? ` · ${meta}` : ''}</span>
                    </span>
                    {i.type === 'lesson' && i.lesson.is_new && !ok && <Badge tone="primary">New</Badge>}
                    {ok ? <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-label="Done" /> : <Circle className="h-5 w-5 shrink-0 text-muted-foreground/50" aria-label="Not done" />}
                  </button>
                </li>
              )
            })}
          </ol>
        </Card>
      )}
    </div>
  )
}

function ItemPage({ d, qkey, unit, n, items, idx, isDone, refresh, go, onQuiz, nextModule, hasNextModule }: {
  d: Detail; qkey: unknown[]; unit: Unit; n: number; items: Item[]; idx: number; isDone: (i: Item) => boolean; refresh: () => void
  go: (i: Item | null) => void; onQuiz: (id: string) => void; nextModule: () => void; hasNextModule: boolean
}) {
  const it = items[idx]
  const prev = items[idx - 1], next = items[idx + 1]
  const l = it.type === 'lesson' ? it.lesson : null
  const done = useMutation({
    mutationFn: (v: boolean) => api.post(`/api/v1/portal/lms/lessons/${l!.id}/complete`, { done: v }),
    onSuccess: refresh,
  })
  /* Opened: no longer "new", and the place to come back to. */
  useEffect(() => {
    if (!l) return
    fetch(`/api/v1/portal/lms/lessons/${l.id}/view`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => { if (r.ok && l.is_new) refresh() }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [l?.id])
  const k = itemKind(it)
  const meta = l ? sourceMeta(l) : ''
  const autoVideo = !!l && l.kind === 'video' && !!l.video_id
  const quiz = it.type === 'quiz' ? d.quizzes.find((z) => z.id === it.id) : null
  const asg = it.type === 'assignment' ? d.assignments.find((a) => a.id === it.id) : null
  return (
    <div className="space-y-4">
      <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        <KindIcon kind={k} /> {KIND_LABEL[k]}{meta ? ` · ${meta}` : ''} · {idx + 1} of {items.length} in {unit.id === OTHER ? 'Other work' : `Module ${n}`}
        {isDone(it) && <Badge tone="success">Done</Badge>}
      </p>
      <Card>
        <div className="px-[var(--card-pad)] py-4">
          {l && <LessonContent l={l} track onFinished={refresh} />}
          {asg && <ul className="-mx-[var(--card-pad)] -my-3"><AssignmentItem a={asg} qkey={qkey} /></ul>}
          {quiz && (
            <div className="space-y-3 text-[14px]">
              {quiz.instructions && <p className="whitespace-pre-wrap text-muted-foreground">{quiz.instructions}</p>}
              <p>{quiz.questions} question{quiz.questions === 1 ? '' : 's'}{quiz.duration_minutes ? ` · ${quiz.duration_minutes} minutes` : ' · no time limit'}{quiz.closes_at ? ` · closes ${fmtWhen(quiz.closes_at)}` : ''}</p>
              {quiz.best !== null && quiz.best !== undefined && <Badge tone="success">Your best: {quiz.best} / {quiz.max_score}</Badge>}
              <div>
                {quiz.open_attempt ? <Button onClick={() => onQuiz(quiz.id)}>Carry on with the quiz</Button>
                  : quiz.open ? <Button onClick={() => onQuiz(quiz.id)}>Start the quiz</Button>
                    : <span className="text-muted-foreground">{quiz.attempts >= quiz.max_attempts ? 'You have taken this quiz.' : 'This quiz is not open.'}</span>}
              </div>
            </div>
          )}
        </div>
        {l && (
          <div className="flex flex-wrap items-center gap-3 border-t px-[var(--card-pad)] py-3">
            {autoVideo && !l.done ? <p className="text-[13px] text-muted-foreground">This is marked done by itself when you have watched 90% of the video.</p> : (
              <Button variant={l.done ? 'secondary' : 'primary'} pending={done.isPending} onClick={() => done.mutate(!l.done)}>
                {l.done ? <><Check className="h-4 w-4" /> Done · undo</> : 'Mark as done'}
              </Button>
            )}
            <FormNotice error={done.error} />
          </div>
        )}
      </Card>
      <nav className="grid grid-cols-2 gap-2" aria-label="Previous and next in this module">
        {prev ? (
          <button type="button" onClick={() => go(prev)} className="card flex min-h-14 items-center gap-2 px-3 py-2 text-left">
            <ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0"><span className="block text-[12px] text-muted-foreground">Previous</span><span className="block truncate text-[14px] font-medium">{itemTitle(prev)}</span></span>
          </button>
        ) : <button type="button" onClick={() => go(null)} className="card flex min-h-14 items-center gap-2 px-3 py-2 text-left"><ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="text-[14px] font-medium">Module list</span></button>}
        {next ? (
          <button type="button" onClick={() => go(next)} className="card flex min-h-14 items-center justify-end gap-2 px-3 py-2 text-right">
            <span className="min-w-0"><span className="block text-[12px] text-muted-foreground">Next</span><span className="block truncate text-[14px] font-medium">{itemTitle(next)}</span></span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        ) : (
          <button type="button" onClick={hasNextModule ? nextModule : () => go(null)} className="card flex min-h-14 items-center justify-end gap-2 px-3 py-2 text-right">
            <span className="min-w-0"><span className="block text-[12px] text-muted-foreground">End of module</span><span className="block truncate text-[14px] font-medium">{hasNextModule ? 'Next module' : 'Back to the module'}</span></span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        )}
      </nav>
    </div>
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
