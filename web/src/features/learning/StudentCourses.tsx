import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Circle, Clock, Lock, PlayCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, FormNotice, Loading, PageBody, PageHead, Textarea } from '@/components/ui'
import {
  FilePick, KIND_LABEL, KindChip, KindIcon, LessonContent, ProgressRing, SECTIONS, SECTION_LABEL, dateRange, fmtWhen, sourceMeta,
  type Lesson, type RubricRow, type Section,
} from './lms-shared'

/* THE CHILD'S COURSES (worker routes/portal/lms.ts).

   Every subject of their class, with how far through they are. Inside one,
   the course is taken one day at a time (worker lms_progress.ts): a big
   Continue button, then the modules, each opening to its days (done, open
   with a ring, or locked with the reason). A day shows its four sections,
   Pre-requisites, Resources, Tools and Assessment; a source opens in its
   viewer with a way to mark it done (a library video marks itself at 90%
   watched), and previous / next run through the day and on to the next
   one once it is open. Assignments show what was handed in and, once returned, the marks
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
  student_id: string; course: { subject: string; teacher?: string | null }; today: string; gating: 'sequential' | 'open'
  modules: SModule[]; assignments: Assignment[]; quizzes: Quiz[]; resume: Resume | null
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

interface SItem { type: 'lesson' | 'assignment' | 'quiz'; id: string; section: Section; required: boolean; done: boolean; pass_percent: number | null; locked: boolean; lesson?: Lesson | null }
interface SDay { key: string; day: number | null; label: string; name: string; state: 'done' | 'open' | 'locked'; reason: string | null; done: number; total: number; opens_at: string | null; items: SItem[] }
interface SModule { id: string; title: string; description?: string | null; starts_on?: string | null; ends_on?: string | null; parent_unit_id?: string | null; state: string; days_done: number; days: SDay[] }
interface Resume { type: 'lesson' | 'assignment' | 'quiz'; id: string; unit_id: string; day_key: string; day_name: string; section: Section; title: string; kind: string; started: boolean }
const OTHER = 'other'
const shortDay = (d: SDay) => (d.day === null ? d.label || 'More' : `Day ${d.day}`)
interface Stop { m: SModule; d: SDay; it: SItem }

function DayMark({ d, size = 40 }: { d: SDay; size?: number }) {
  if (d.state === 'done') return <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-success text-white" style={{ width: size, height: size }} aria-label="Done"><Check className="h-5 w-5" /></span>
  if (d.state === 'locked') return <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" style={{ width: size, height: size }} aria-label="Locked"><Lock className="h-4 w-4" /></span>
  return <ProgressRing pct={d.total ? Math.round((100 * d.done) / d.total) : 0} size={size} label={`${d.done} of ${d.total} done`} />
}

function Course({ cs, back }: { cs: string; back: () => void }) {
  const qc = useQueryClient()
  const key = ['my-course', cs]
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Detail>(`/api/v1/portal/lms/course?class_subject_id=${cs}`) })
  const [where, setWhere] = useState<{ day: string | null; item: string | null }>({ day: null, item: null })
  const [expanded, setExpanded] = useState<string | null>(null)
  const [quiz, setQuiz] = useState<string | null>(null)
  const top = useRef<HTMLDivElement>(null)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    top.current?.scrollIntoView({ block: 'start' })
  }, [where.day, where.item, quiz])
  const refresh = () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['my-courses'] }); qc.invalidateQueries({ queryKey: ['my-lms-todo'] }) }
  const d = q.data
  if (quiz) return <div ref={top}><TakeQuiz id={quiz} back={() => { setQuiz(null); refresh() }} /></div>

  const modules = d?.modules ?? []
  const tops = modules.filter((m) => !m.parent_unit_id || !modules.some((x) => x.id === m.parent_unit_id))
  const number = (m: SModule) => {
    if (!m.parent_unit_id) return `Module ${tops.indexOf(m) + 1}`
    const p = modules.find((x) => x.id === m.parent_unit_id)
    return p ? `Module ${tops.indexOf(p) + 1}.${modules.filter((x) => x.parent_unit_id === p.id).indexOf(m) + 1}` : 'Module'
  }
  /* The stops, in the order the course is taken. */
  const stops: Stop[] = modules.flatMap((m) => m.days.flatMap((dd) => dd.items.map((it) => ({ m, d: dd, it }))))
  const loose: SItem[] = d ? [
    ...d.assignments.filter((a) => !a.lms_unit_id).map((a) => ({ type: 'assignment' as const, id: a.id, section: 'assessment' as Section, required: false, done: !!a.submitted_at && a.status !== 'resubmit' || a.status === 'graded', pass_percent: null, locked: false })),
    ...d.quizzes.filter((z) => !z.lms_unit_id).map((z) => ({ type: 'quiz' as const, id: z.id, section: 'assessment' as Section, required: false, done: z.attempts > 0, pass_percent: null, locked: false })),
  ] : []
  const otherModule: SModule = { id: OTHER, title: 'Other work', state: 'open', days_done: 0, days: [{ key: OTHER, day: null, label: 'Other work', name: 'Other work', state: 'open', reason: null, done: loose.filter((x) => x.done).length, total: loose.length, opens_at: null, items: loose }] }
  const dayStops = where.day === OTHER ? loose.map((it) => ({ m: otherModule, d: otherModule.days[0], it })) : stops
  const cur = where.day ? (where.day === OTHER ? { m: otherModule, d: otherModule.days[0] } : (() => { for (const m of modules) { const x = m.days.find((y) => y.key === where.day); if (x) return { m, d: x } } return null })()) : null
  const item = where.item ? dayStops.find((s) => `${s.it.type}:${s.it.id}` === where.item) ?? null : null
  const titleOf = (it: SItem) => it.type === 'lesson' ? it.lesson?.title ?? '' : it.type === 'quiz' ? d?.quizzes.find((z) => z.id === it.id)?.title ?? 'Quiz' : d?.assignments.find((a) => a.id === it.id)?.title ?? 'Assignment'
  const allDays = modules.flatMap((m) => m.days)
  const daysDone = allDays.filter((x) => x.state === 'done').length
  const open = (s: Stop) => setWhere({ day: s.d.key, item: `${s.it.type}:${s.it.id}` })
  const backLabel = item ? shortDay(item.d) : cur ? 'All modules' : 'My courses'
  return (
    <div ref={top} className="scroll-mt-4">
      <PageHead
        eyebrow={cur ? `${d?.course.subject ?? ''} · ${cur.m.id === OTHER ? 'Other work' : `${number(cur.m)} · ${cur.m.title}`}` : 'Learning · My courses'}
        title={item ? titleOf(item.it) : cur ? cur.d.name : d?.course.subject ?? 'Course'}
        actions={<Button variant="secondary" onClick={() => (item ? setWhere({ day: where.day, item: null }) : cur ? setWhere({ day: null, item: null }) : back())}><ChevronLeft className="h-4 w-4" /> {backLabel}</Button>}
      />
      <PageBody>
        {q.error ? <ErrorState error={q.error} /> : !d ? <Loading /> : item ? (
          <ItemPage d={d} qkey={key} stop={item} stops={dayStops} titleOf={titleOf} refresh={refresh} open={open} toDay={(k) => setWhere({ day: k, item: null })} onQuiz={setQuiz} />
        ) : cur ? (
          <DayPage d={d} m={cur.m} day={cur.d} titleOf={titleOf} open={(it) => open({ m: cur.m, d: cur.d, it })}
            prev={allDays[allDays.indexOf(cur.d) - 1] ?? null} next={allDays[allDays.indexOf(cur.d) + 1] ?? null} toDay={(k) => setWhere({ day: k, item: null })} />
        ) : (
          <div className="space-y-4">
            <Card>
              <div className="flex flex-wrap items-center gap-4 px-[var(--card-pad)] py-4">
                <ProgressRing pct={allDays.length ? Math.round((100 * daysDone) / allDays.length) : 0} size={56} />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold">{allDays.length ? `${daysDone} of ${allDays.length} days done` : 'Nothing to do yet'}</p>
                  <p className="text-[13px] text-muted-foreground">{d.course.teacher ? `Taught by ${d.course.teacher}` : 'Teacher not set'} · {tops.length} module{tops.length === 1 ? '' : 's'}</p>
                </div>
                <Badge tone={d.gating === 'open' ? 'neutral' : 'primary'}>{d.gating === 'open' ? 'Open course' : 'One day at a time'}</Badge>
              </div>
            </Card>
            {d.resume ? (() => {
              const r = d.resume!
              const s = stops.find((x) => x.it.type === r.type && x.it.id === r.id)
              if (!s) return null
              return (
                <button type="button" onClick={() => open(s)} className="flex w-full items-center gap-3 rounded-xl bg-primary px-[var(--card-pad)] py-4 text-left text-primary-foreground shadow-sm transition hover:brightness-110">
                  <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/15"><PlayCircle className="h-6 w-6" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-medium uppercase tracking-wide opacity-80">{r.started ? 'Continue' : 'Start here'}</span>
                    <span className="block text-[16px] font-semibold leading-snug [overflow-wrap:anywhere]">{shortDay(s.d)} · {SECTION_LABEL[r.section]} · {r.title}</span>
                    <span className="block truncate text-[13px] opacity-80">{number(s.m)} · {s.m.title}</span>
                  </span>
                  <ChevronRight className="h-5 w-5 shrink-0" />
                </button>
              )
            })() : allDays.length > 0 && daysDone === allDays.length ? (
              <Card><div className="flex items-center gap-3 px-[var(--card-pad)] py-4"><span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-success text-white"><Check className="h-5 w-5" /></span><p className="text-[15px] font-semibold">Every day is done. Well done.</p></div></Card>
            ) : null}
            {!modules.length && !loose.length ? <EmptyState title="Nothing here yet" body="Your teacher has not added any modules to this course yet." /> : (
              <ol className="space-y-3">
                {tops.map((m) => {
                  const subs = modules.filter((x) => x.parent_unit_id === m.id)
                  const all = [m, ...subs]
                  const days = all.flatMap((x) => x.days)
                  const done = days.filter((x) => x.state === 'done').length
                  const locked = days.length > 0 && days.every((x) => x.state === 'locked')
                  const isOpen = (expanded ?? (d.resume ? (modules.find((x) => x.id === d.resume!.unit_id)?.parent_unit_id ?? d.resume.unit_id) : tops[0]?.id)) === m.id
                  const range = dateRange(m.starts_on, m.ends_on)
                  return (
                    <li key={m.id} className="card overflow-hidden p-0">
                      <button type="button" onClick={() => setExpanded(isOpen ? '' : m.id)} aria-expanded={isOpen} className="flex w-full items-center gap-3 px-[var(--card-pad)] py-4 text-left">
                        {locked ? <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><Lock className="h-5 w-5" /></span>
                          : done === days.length && days.length ? <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-success text-white"><Check className="h-5 w-5" /></span>
                            : <ProgressRing pct={days.length ? Math.round((100 * done) / days.length) : 0} />}
                        <span className="min-w-0 flex-1 space-y-0.5">
                          <span className="block text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{number(m)}{range ? ` · ${range}` : ''}</span>
                          <span className="block text-[16px] font-semibold leading-snug">{m.title}</span>
                          <span className="block text-[13px] text-muted-foreground">{locked ? (days[0]?.reason ?? 'Locked') : `${done} of ${days.length} day${days.length === 1 ? '' : 's'} done`}</span>
                        </span>
                        <ChevronDown className={`h-5 w-5 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {isOpen && (
                        <div className="border-t">
                          {m.description && <p className="px-[var(--card-pad)] pt-3 text-[14px] text-muted-foreground">{m.description}</p>}
                          <DayList days={m.days} onOpen={(k) => setWhere({ day: k, item: null })} />
                          {subs.map((sx) => (
                            <div key={sx.id} className="border-t">
                              <p className="px-[var(--card-pad)] pt-3 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{number(sx)} · {sx.title}</p>
                              <DayList days={sx.days} onOpen={(k) => setWhere({ day: k, item: null })} />
                            </div>
                          ))}
                        </div>
                      )}
                    </li>
                  )
                })}
                {loose.length > 0 && (
                  <li>
                    <button type="button" onClick={() => setWhere({ day: OTHER, item: null })} className="card flex w-full items-center gap-3 px-[var(--card-pad)] py-4 text-left">
                      <ProgressRing pct={Math.round((100 * loose.filter((x) => x.done).length) / loose.length)} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[16px] font-semibold">Other work</span>
                        <span className="block text-[13px] text-muted-foreground">Assignments and quizzes not on a day</span>
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

function DayList({ days, onOpen }: { days: SDay[]; onOpen: (key: string) => void }) {
  if (!days.length) return <p className="px-[var(--card-pad)] py-3 text-[14px] text-muted-foreground">Nothing here yet.</p>
  return (
    <ol className="divide-y">
      {days.map((x) => (
        <li key={x.key}>
          <button type="button" disabled={x.state === 'locked'} onClick={() => onOpen(x.key)}
            className="flex min-h-[60px] w-full items-center gap-3 px-[var(--card-pad)] py-2.5 text-left enabled:hover:bg-muted/40 disabled:cursor-not-allowed">
            <DayMark d={x} size={36} />
            <span className="min-w-0 flex-1">
              <span className={`block text-[15px] font-medium leading-snug ${x.state === 'locked' ? 'text-muted-foreground' : ''}`}>{x.name}</span>
              <span className="block text-[13px] text-muted-foreground">
                {x.state === 'locked' ? x.reason : x.state === 'done' ? 'Done' : `${x.done} of ${x.total} done`}
                {x.state !== 'locked' && x.opens_at ? ` · more opens ${fmtWhen(x.opens_at)}` : ''}
              </span>
            </span>
            {x.state !== 'locked' && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
          </button>
        </li>
      ))}
    </ol>
  )
}

function itemMeta(d: Detail, it: SItem): string {
  if (it.type === 'lesson' && it.lesson) return [KIND_LABEL[it.lesson.kind], sourceMeta(it.lesson)].filter(Boolean).join(' · ')
  if (it.type === 'quiz') { const z = d.quizzes.find((x) => x.id === it.id); return ['Quiz', z ? `${z.questions} question${z.questions === 1 ? '' : 's'}` : '', it.pass_percent ? `pass ${it.pass_percent}%` : ''].filter(Boolean).join(' · ') }
  const a = d.assignments.find((x) => x.id === it.id)
  return ['Assignment', a?.due_on ? `due ${a.due_on}` : '', it.pass_percent ? `pass ${it.pass_percent}%` : ''].filter(Boolean).join(' · ')
}

function DayPage({ d, m, day, titleOf, open, prev, next, toDay }: {
  d: Detail; m: SModule; day: SDay; titleOf: (it: SItem) => string; open: (it: SItem) => void; prev: SDay | null; next: SDay | null; toDay: (k: string) => void
}) {
  const bySection = SECTIONS.map((s) => ({ s, items: day.items.filter((i) => i.section === s) })).filter((x) => x.items.length)
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center gap-4 px-[var(--card-pad)] py-4">
          <DayMark d={day} size={52} />
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold">{day.state === 'locked' ? 'Locked' : day.state === 'done' ? 'Day complete' : `${day.done} of ${day.total} done`}</p>
            <p className="text-[13px] text-muted-foreground">{day.state === 'locked' ? day.reason : m.id === OTHER ? 'Not part of any day' : day.state === 'done' ? 'Everything required is done.' : 'Finish the required items to open the next day.'}</p>
          </div>
        </div>
      </Card>
      {bySection.map(({ s, items }) => (
        <Card key={s}>
          <div className="border-b px-[var(--card-pad)] py-2.5"><h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{m.id === OTHER ? (s === 'assessment' ? 'Assignments and quizzes' : SECTION_LABEL[s]) : SECTION_LABEL[s]}</h3></div>
          <ol className="divide-y">
            {items.map((it) => {
              const k = it.type === 'lesson' ? it.lesson?.kind ?? 'text' : it.type
              const sched = it.type === 'lesson' && it.lesson?.scheduled
              const blocked = it.locked || sched
              return (
                <li key={`${it.type}:${it.id}`}>
                  <button type="button" disabled={!!blocked} onClick={() => open(it)} className="flex min-h-[64px] w-full items-center gap-3 px-[var(--card-pad)] py-2.5 text-left enabled:hover:bg-muted/40 disabled:cursor-not-allowed">
                    <KindChip kind={k} done={it.done} />
                    <span className="min-w-0 flex-1">
                      <span className={`block text-[15px] font-medium leading-snug [overflow-wrap:anywhere] ${blocked ? 'text-muted-foreground' : ''}`}>{titleOf(it)}</span>
                      <span className="block text-[13px] text-muted-foreground">{itemMeta(d, it)}{it.type === 'lesson' && it.lesson?.is_optional ? ' · optional' : ''}</span>
                    </span>
                    {sched ? <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground"><Clock className="h-3.5 w-3.5" /> Opens {fmtWhen(it.lesson?.publish_at)}</span>
                      : it.locked ? <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Locked" />
                        : it.done ? <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-label="Done" />
                          : it.lesson?.is_new ? <Badge tone="primary">New</Badge> : <Circle className="h-5 w-5 shrink-0 text-muted-foreground/50" aria-label="Not done" />}
                  </button>
                </li>
              )
            })}
          </ol>
        </Card>
      ))}
      {!bySection.length && <EmptyState title="Nothing on this day yet" body="Your teacher has not added anything here yet." />}
      {m.id !== OTHER && (
        <nav className="grid grid-cols-2 gap-2" aria-label="Previous and next day">
          {prev ? <button type="button" onClick={() => toDay(prev.key)} className="card flex min-h-14 items-center gap-2 px-3 py-2 text-left"><ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="block text-[12px] text-muted-foreground">Previous day</span><span className="block truncate text-[14px] font-medium">{prev.name}</span></span></button> : <span />}
          {next ? (
            <button type="button" disabled={next.state === 'locked'} onClick={() => toDay(next.key)} className="card flex min-h-14 items-center justify-end gap-2 px-3 py-2 text-right disabled:cursor-not-allowed disabled:opacity-70">
              <span className="min-w-0"><span className="block text-[12px] text-muted-foreground">{next.state === 'locked' ? 'Locked' : 'Next day'}</span><span className="block truncate text-[14px] font-medium">{next.name}</span></span>
              {next.state === 'locked' ? <Lock className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
            </button>
          ) : <span />}
        </nav>
      )}
    </div>
  )
}

function ItemPage({ d, qkey, stop, stops, titleOf, refresh, open, toDay, onQuiz }: {
  d: Detail; qkey: unknown[]; stop: Stop; stops: Stop[]; titleOf: (it: SItem) => string; refresh: () => void; open: (s: Stop) => void; toDay: (k: string) => void; onQuiz: (id: string) => void
}) {
  const it = stop.it
  /* Previous and next skip what cannot be opened yet (scheduled); a locked day ends the way forward. */
  const openable = (s: Stop) => !(s.it.type === 'lesson' && s.it.lesson?.scheduled)
  const idx = stops.findIndex((s) => s === stop || (s.it.type === it.type && s.it.id === it.id))
  const prev = [...stops.slice(0, idx)].reverse().find(openable) ?? null
  const next = stops.slice(idx + 1).find(openable) ?? null
  const l = it.type === 'lesson' ? it.lesson ?? null : null
  const done = useMutation({ mutationFn: (v: boolean) => api.post(`/api/v1/portal/lms/lessons/${l!.id}/complete`, { done: v }), onSuccess: refresh })
  useEffect(() => {
    if (!l || it.locked) return
    fetch(`/api/v1/portal/lms/lessons/${l.id}/view`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => { if (r.ok && l.is_new) refresh() }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [l?.id])
  const k = l ? l.kind : it.type
  const meta = itemMeta(d, it)
  const autoVideo = !!l && l.kind === 'video' && !!l.video_id
  const quiz = it.type === 'quiz' ? d.quizzes.find((z) => z.id === it.id) : null
  const asg = it.type === 'assignment' ? d.assignments.find((a) => a.id === it.id) : null
  const inDay = stop.d.items.filter((x) => x.section === it.section)
  return (
    <div className="space-y-4">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
        <KindIcon kind={k} /> {shortDay(stop.d)} · {SECTION_LABEL[it.section]}{inDay.length > 1 ? ` ${inDay.indexOf(it) + 1} of ${inDay.length}` : ''} · {meta}
        {it.done && <Badge tone="success">Done</Badge>}
        {l?.is_optional && <Badge>Optional</Badge>}
      </p>
      {it.locked ? (
        <Card><div className="flex items-center gap-3 px-[var(--card-pad)] py-6"><Lock className="h-5 w-5 text-muted-foreground" /><p className="text-[15px]">{stop.d.reason ?? 'This is locked.'}</p></div></Card>
      ) : (
        <Card>
          <div className="px-[var(--card-pad)] py-4">
            {l && <LessonContent l={l} track onFinished={refresh} />}
            {asg && <ul className="-mx-[var(--card-pad)] -my-3"><AssignmentItem a={asg} qkey={qkey} /></ul>}
            {quiz && (
              <div className="space-y-3 text-[14px]">
                {quiz.instructions && <p className="whitespace-pre-wrap text-muted-foreground">{quiz.instructions}</p>}
                <p>{quiz.questions} question{quiz.questions === 1 ? '' : 's'}{quiz.duration_minutes ? ` · ${quiz.duration_minutes} minutes` : ' · no time limit'}{quiz.closes_at ? ` · closes ${fmtWhen(quiz.closes_at)}` : ''}</p>
                {it.pass_percent ? <p className="text-muted-foreground">Score {it.pass_percent}% or more to open the next day.</p> : null}
                {quiz.best !== null && quiz.best !== undefined && <Badge tone={it.done ? 'success' : 'warning'}>Your best: {quiz.best} / {quiz.max_score}{it.pass_percent && !it.done ? ' · below the pass mark' : ''}</Badge>}
                <div>
                  {quiz.open_attempt ? <Button onClick={() => onQuiz(quiz.id)}>Carry on with the quiz</Button>
                    : quiz.open ? <Button onClick={() => onQuiz(quiz.id)}>{quiz.attempts ? 'Try again' : 'Start the quiz'}</Button>
                      : <span className="text-muted-foreground">{quiz.attempts >= quiz.max_attempts ? 'You have used every attempt. Ask your teacher if you are stuck.' : 'This quiz is not open.'}</span>}
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
      )}
      <nav className="grid grid-cols-2 gap-2" aria-label="Previous and next">
        {prev ? (
          <button type="button" onClick={() => open(prev)} className="card flex min-h-14 items-center gap-2 px-3 py-2 text-left">
            <ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0"><span className="block text-[12px] text-muted-foreground">Previous{prev.d !== stop.d ? ` · ${shortDay(prev.d)}` : ''}</span><span className="block truncate text-[14px] font-medium">{titleOf(prev.it)}</span></span>
          </button>
        ) : <button type="button" onClick={() => toDay(stop.d.key)} className="card flex min-h-14 items-center gap-2 px-3 py-2 text-left"><ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="text-[14px] font-medium">{shortDay(stop.d)}</span></button>}
        {next ? (
          <button type="button" disabled={next.it.locked} onClick={() => open(next)} className="card flex min-h-14 items-center justify-end gap-2 px-3 py-2 text-right disabled:cursor-not-allowed disabled:opacity-70">
            <span className="min-w-0">
              <span className="block text-[12px] text-muted-foreground">{next.it.locked ? `${shortDay(next.d)} is locked` : `Next${next.d !== stop.d ? ` · ${shortDay(next.d)}` : ''}`}</span>
              <span className="block truncate text-[14px] font-medium">{next.it.locked ? 'Finish this day first' : titleOf(next.it)}</span>
            </span>
            {next.it.locked ? <Lock className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
          </button>
        ) : (
          <button type="button" onClick={() => toDay(stop.d.key)} className="card flex min-h-14 items-center justify-end gap-2 px-3 py-2 text-right">
            <span className="min-w-0"><span className="block text-[12px] text-muted-foreground">The end</span><span className="block truncate text-[14px] font-medium">Back to {shortDay(stop.d)}</span></span>
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
