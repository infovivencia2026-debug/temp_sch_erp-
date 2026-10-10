import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, ArrowRight, BookOpen, ChevronDown, ExternalLink, Share2, Calculator, Check, Clock, FlaskConical, Globe2, Languages, Lock, Monitor, Music, Palette, Play, Search, Sparkles, Star, Trophy,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Badge, Button, Card, EmptyState, ErrorState, Field, FormNotice, PageBody, PageHead, Textarea } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  FilePick, KID_KIND_LABEL, KID_SECTION_LABEL, KIND_LABEL, KindIcon, LessonContent, SECTIONS, dateRange, fmtWhen, sourceMeta, youTubeIds,
  type Lesson, type RubricRow, type Section,
} from './lms-shared'
import { Bone, DoneCheck, DueChip, HUE, Ring, confetti, reducedMotion, rememberPlace, type Hue } from '../portal/student-kit'
import { StudentQuiz } from './StudentQuiz'

/* THE CHILD'S COURSES (worker routes/portal/lms.ts).

   Every subject of their class, with how far through they are. Inside one,
   the course is taken one day at a time (worker lms_progress.ts): a big
   Keep going button, then the modules as a path of numbered stops, each
   opening to its days as big numbered bubbles (done, open, or locked with
   the reason). The words are for young children: the four sections show as
   Before you start, Learn, Practice and Show what you know (KID_SECTION_LABEL;
   the stored values do not change), and a day is a checklist of steps with
   big Back / Next arrows stuck to the bottom on a phone. A source opens in its
   viewer with a way to mark it done (a library video marks itself at 90%
   watched), and previous / next run through the day and on to the next
   one once it is open. Assignments show what was handed in and, once returned, the marks
   and comments; quizzes are taken here against the clock. A parent opening
   this reads it; only the child's own login does the work. */

interface CourseRow { class_subject_id: string; subject: string; teacher?: string | null; added?: number | boolean; lessons: number; completed: number; to_do: number; quizzes_open: number }
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

/* The course, day and item open are in the address (?cs=&day=&item=), so the
   home's Continue button, Back, and a reload all land in the same place. */
export default function StudentCourses() {
  const [params, setParams] = useSearchParams()
  const open = params.get('cs')
  if (open) return <Course key={open} cs={open} initial={{ mod: params.get('mod'), day: params.get('day'), item: params.get('item') }} back={() => setParams({})} />
  return <List onOpen={(cs) => setParams({ cs })} />
}

/* A subject's picture: a line icon and a soft colour from the scheme, picked
   from the name so the same subject always looks the same. */
const SUBJECT_LOOKS: [RegExp, typeof BookOpen, Hue][] = [
  [/physical|sport|\bpe\b|games|yoga/i, Trophy, 'sky'],
  [/math|arith|algebra|geometr|ganit/i, Calculator, 'indigo'],
  [/science|physic|chem|bio|evs|environment/i, FlaskConical, 'emerald'],
  [/social|history|geograph|civic|econom|\bgk\b|general knowledge/i, Globe2, 'amber'],
  [/english|hindi|telugu|tamil|kannada|sanskrit|urdu|french|language|lit|grammar|reading/i, Languages, 'rose'],
  [/computer|coding|\bict\b|\bit\b|robot/i, Monitor, 'sky'],
  [/art|draw|craft|paint/i, Palette, 'rose'],
  [/music|danc|sing/i, Music, 'sky'],
]
const HUE_CYCLE: Hue[] = ['indigo', 'emerald', 'amber', 'sky', 'rose']
function subjectLook(name: string): { Icon: typeof BookOpen; hue: Hue } {
  for (const [re, Icon, hue] of SUBJECT_LOOKS) if (re.test(name)) return { Icon, hue }
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return { Icon: BookOpen, hue: HUE_CYCLE[h % HUE_CYCLE.length] }
}

/** Up to five stars for how far through a subject is (0-100). */
function Stars({ pct, label }: { pct: number; label: string }) {
  const n = Math.round(pct / 20)
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={label}>
      {[0, 1, 2, 3, 4].map((i) => <Star key={i} className={cn('h-4 w-4', i < n ? 'fill-[hsl(var(--sys-orange))] text-[hsl(var(--sys-orange))]' : 'text-muted-foreground/40')} strokeWidth={1.75} aria-hidden />)}
    </span>
  )
}

/* The bar of big arrow buttons at the bottom of a day or a step. On a phone it
   sticks above the tab bar (and the home indicator), so the thumb finds it. */
function ArrowBar({ children, label }: { children: ReactNode; label: string }) {
  return (
    <nav aria-label={label}
      className="sticky bottom-[calc(var(--dock-reserve,env(safe-area-inset-bottom,0px))+8px)] z-20 -mx-1 mt-3 flex items-center justify-between gap-2 rounded-full border bg-card/95 p-1.5 shadow-lg backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:p-0 md:shadow-none md:backdrop-blur-none">
      {children}
    </nav>
  )
}
/* Compact pills, not full-width slabs (owner, 2026-10-10: "long big buttons look ugly"). */
const ARROW = 'h-auto min-h-[44px] w-auto max-w-full gap-2 whitespace-nowrap rounded-full px-4 py-1.5 text-[15px] font-semibold'
/* THE TWO ARROWS ARE ONE SIZE (owner, 2026-10-10: "back and all done
   button should be in same size").

   They shared a height already and nothing else: Back took the width of the
   word "Back" and Next took up to 60% of the bar, so a row meant to read as
   one control forward and one back was a small button and a large one. Each
   takes half now -- flex-1 from a zero basis, so the longer label does not
   win the extra space -- and the pair is symmetrical whatever the labels
   under them say.

   ONE SIZE, AND SMALL (owner, 2026-10-10: "that looks ugly, back and all
   done, long big buttons"). Halves of the bar were wide slabs on a desktop;
   both are now the same fixed width (up to 200px), Back at the left and
   Next at the right. */
function BackBtn({ onClick, sub }: { onClick: () => void; sub?: string }) {
  return (
    <Button variant="secondary" onClick={onClick} className={cn(ARROW, 'w-[min(46vw,200px)] justify-start text-left')}>
      <ArrowLeft className="h-5 w-5 shrink-0" aria-hidden />
      <span className="min-w-0"><span className="block">Back</span>{sub && <span className="block truncate text-[12px] font-normal text-muted-foreground">{sub}</span>}</span>
    </Button>
  )
}
/* Both arrows are flex children of ArrowBar, which is already a flex row. */
const NextBtn = ({ onClick, label, sub, locked, hot, btnRef }: { onClick: () => void; label: string; sub?: string; locked?: boolean; hot?: boolean; btnRef?: Ref<HTMLSpanElement> }) => (
  <span ref={btnRef} className="ml-auto block w-[min(46vw,200px)] min-w-0"><Button variant={hot && !locked ? 'primary' : 'secondary'} disabled={locked} onClick={onClick}
    className={cn(ARROW, 'w-full justify-end text-right', hot && !locked && 'ring-2 ring-primary/20')}>
    <span className="min-w-0"><span className="block">{label}</span>{sub && <span className={cn('block truncate text-[12px] font-normal', hot && !locked ? 'opacity-85' : 'text-muted-foreground')}>{sub}</span>}</span>
    {locked ? <Lock className="h-5 w-5 shrink-0" aria-hidden /> : <ArrowRight className="h-5 w-5 shrink-0" aria-hidden />}
  </Button></span>
)

/* One skeleton the shape of the page, then the page: the to-do and the
   subjects arrive together, so nothing is pushed down when the second lands. */
function List({ onOpen }: { onOpen: (cs: string) => void }) {
  const q = useQuery({ queryKey: ['my-courses'], queryFn: () => api.get<{ class_name: string; section_name: string; items: CourseRow[] }>('/api/v1/portal/lms/courses') })
  const todo = useQuery({ queryKey: ['my-lms-todo'], queryFn: () => api.get<Todo>('/api/v1/portal/lms/todo') })
  const t = todo.data
  const rows = t ? [
    ...t.assignments.map((a) => ({ id: a.id, cs: a.class_subject_id, kind: 'assignment', chip: <DueChip due={a.due_on} />, title: a.title, meta: `${a.subject ?? 'Homework'}${a.status === 'resubmit' ? ' · your teacher asked you to try again' : ''}` })),
    ...t.quizzes.map((z) => ({ id: z.id, cs: z.class_subject_id, kind: 'quiz', chip: <Badge tone="info">Quiz</Badge>, title: z.title, meta: `${z.subject}${z.duration_minutes ? ` · ${z.duration_minutes} min` : ''}` })),
    ...t.lessons.slice(0, 3).map((l) => ({ id: l.id, cs: l.class_subject_id, kind: 'text', chip: <Badge>Up next</Badge>, title: l.title, meta: `${l.subject} · ${l.unit}` })),
  ] : []
  const ready = !!q.data && (!!t || !!todo.error)
  const shared = useShared()
  /* Only courses the LMS admin has put something in (owner, 2026-10-10: "until
     they add any, show nothing"). The year's subjects are on Courses / subjects. */
  /* Only courses the LMS Admin has added to this section (Add course) that
     have lessons in them: homework alone is not a course (owner, 2026-10-10),
     and a course taken off the admin's list goes from here too. */
  const withContent = (q.data?.items ?? []).filter((c) => !!c.added && c.lessons > 0)
  const names = new Set((q.data?.items ?? []).map((c) => c.subject))
  const unfiled = (shared.data?.items ?? []).filter((r) => !r.subject || !names.has(r.subject))
  return (
    <>
      <PageHead eyebrow="Learning" title="LMS" description="Your courses, day by day or topic by topic, with their videos" />
      <PageBody>
        {q.error ? <ErrorState error={q.error} /> : !ready ? (
          <div className="space-y-4" aria-busy>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Bone key={i} className="h-[184px] rounded-2xl" />)}</div>
          </div>
        ) : (
          <div className="space-y-6">
            {!withContent.length ? <EmptyState title="No courses yet" body="Courses appear here once your school adds them." /> : (
              <section aria-label="Subjects" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {withContent.map((c) => {
                  const pct = c.lessons ? Math.round((100 * c.completed) / c.lessons) : 0
                  const { Icon, hue } = subjectLook(c.subject)
                  const all = c.lessons > 0 && c.completed >= c.lessons
                  return (
                    <button key={c.class_subject_id} type="button" onClick={() => onOpen(c.class_subject_id)}
                      className="card flex min-h-[184px] flex-col items-center justify-start gap-2 p-4 text-center transition active:scale-[.98] hover:bg-muted/30">
                      <Ring pct={pct} size={84} stroke={7} hue={hue} label={`${c.completed} of ${c.lessons} done`}>
                        <span className={cn('grid h-[58px] w-[58px] place-items-center rounded-full', HUE[hue].bg, HUE[hue].fg)}>
                          {all ? <Check className="h-8 w-8" strokeWidth={2.25} aria-hidden /> : <Icon className="h-8 w-8" strokeWidth={1.6} aria-hidden />}
                        </span>
                      </Ring>
                      <span className="block text-[18px] font-semibold leading-tight [overflow-wrap:anywhere]">{c.subject}</span>
                      {c.lessons ? <Stars pct={pct} label={`${c.completed} of ${c.lessons} done`} /> : <span className="text-[14px] text-muted-foreground">Nothing yet</span>}
                      {(c.to_do > 0 || c.quizzes_open > 0) && (
                        <span className="flex flex-wrap justify-center gap-1.5">
                          {c.to_do > 0 && <Badge tone="warning">{c.to_do} homework</Badge>}
                          {c.quizzes_open > 0 && <Badge tone="info">{c.quizzes_open} quiz</Badge>}
                        </span>
                      )}
                    </button>
                  )
                })}
              </section>
            )}
            {unfiled.length > 0 && (
              <Card>
                <h2 className="border-b px-[var(--card-pad)] py-3 text-[17px] font-semibold">Shared by your teachers</h2>
                <SharedRows items={unfiled} />
              </Card>
            )}
            {rows.length > 0 && (
              <Card>
                <h2 className="border-b px-[var(--card-pad)] py-3 text-[17px] font-semibold">To do ({rows.length})</h2>
                <ul className="divide-y">
                  {rows.map((r) => (
                    <li key={r.id}>
                      <button type="button" onClick={() => r.cs && onOpen(r.cs)}
                        className="flex min-h-[68px] w-full items-center gap-3 px-[var(--card-pad)] py-2.5 text-left hover:bg-muted/40">
                        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/[0.07] text-primary"><KindIcon kind={r.kind} className="h-6 w-6" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[17px] font-medium leading-snug [overflow-wrap:anywhere]">{r.title}</span>
                          <span className="block text-[14px] text-muted-foreground">{r.meta}</span>
                        </span>
                        {r.chip}
                        <ArrowRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
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
const kindOf = (it: SItem) => (it.type === 'lesson' ? it.lesson?.kind ?? 'text' : it.type)
const canOpen = (it: SItem) => !it.locked && !(it.type === 'lesson' && it.lesson?.scheduled)

/* "Where you are" wears the same colour as the primary button (which the
   school may paint apart from the accent), with a soft halo round it. */
const GO = 'border-[hsl(var(--paint-buttons-bg,var(--primary)))] bg-[hsl(var(--paint-buttons-bg,var(--primary)))] text-[hsl(var(--paint-buttons-text,var(--primary-foreground)))] shadow-[0_0_0_6px_hsl(var(--paint-buttons-bg,var(--primary))/0.18)]'

/** A stop on the module path: tick when done, lock when shut, glowing when it is where the child is. */
/* THE WORD ON THE BUTTON (owner, 2026-10-10: "dont know where the button
   is and what is button is").

   Every row on the path was a card with a grey arrow at its far right and
   no verb anywhere. On a wide screen that arrow sits a thousand pixels from
   the title it belongs to, and an arrow does not say whether a step is new,
   half-finished, shut, or already passed. One word does, and it is the same
   word in the same place on every row. */
function StepGo({ state }: { state: 'done' | 'current' | 'open' | 'locked' }) {
  const word = state === 'locked' ? 'Locked' : state === 'done' ? 'Review' : state === 'current' ? 'Continue' : 'Open'
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[13px] font-semibold sm:text-[14px]',
      state === 'locked' ? 'text-muted-foreground'
        : state === 'current' ? 'bg-[hsl(var(--paint-buttons-bg,var(--primary))/0.12)] text-[hsl(var(--paint-buttons-bg,var(--primary)))]'
          : 'text-primary')}>
      {word}
      {state === 'locked'
        ? <Lock className="h-4 w-4 shrink-0" aria-hidden />
        : <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />}
    </span>
  )
}

/* What a teacher shared with the child outside any module (worker
   portal/learning.ts, study_materials): kept so nothing is lost now that the
   LMS opens on the subjects. Shown inside its subject, or on the subjects
   page when it names none. */
interface Shared {
  id: string; title: string; description?: string; kind: string; subject?: string; external_url?: string; file_id?: string; file_name?: string
  content_type?: string; uploaded_by?: string; posted_on: string; seen?: boolean
}
const SHARED = 'shared'
const useShared = () => useQuery({ queryKey: ['learning-resources-lms'], queryFn: () => api.get<{ items: Shared[] }>('/api/v1/portal/learning/resources'), retry: false })
function sharedKind(r: Shared): string {
  const ct = r.content_type ?? ''
  if (!r.file_id) return r.kind === 'video' ? 'video' : 'link'
  if (ct.startsWith('image/')) return 'image'
  if (ct.startsWith('video/')) return 'video'
  if (ct.startsWith('audio/')) return 'audio'
  if (ct === 'application/pdf') return 'pdf'
  return 'file'
}
const sharedHref = (r: Shared) => (r.file_id ? `/api/v1/files/${r.file_id}?inline=1` : r.external_url ?? '#')

/** Shared items as big rows; opening one marks it seen. */
function SharedRows({ items }: { items: Shared[] }) {
  const qc = useQueryClient()
  const seen = (id: string) => { void api.post(`/api/v1/portal/learning/resources/${id}/seen`, {}).catch(() => undefined).then(() => qc.invalidateQueries({ queryKey: ['learning-resources-lms'] })) }
  return (
    <ol className="divide-y">
      {items.map((r) => {
        const k = sharedKind(r)
        return (
          <li key={r.id}>
            <a href={sharedHref(r)} target="_blank" rel="noreferrer" onClick={() => seen(r.id)}
              className="flex min-h-[76px] w-full items-center gap-3 px-[var(--card-pad)] py-3 text-left hover:bg-muted/40">
              <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-full', r.seen ? 'bg-muted text-muted-foreground' : 'bg-primary/[0.08] text-primary')}><KindIcon kind={k} className="h-5 w-5" /></span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[14px] font-semibold uppercase tracking-wide text-primary">{KID_KIND_LABEL[k] ?? 'Open'}{!r.seen && <Badge tone="primary">New</Badge>}</span>
                <span className="block text-[17px] font-medium leading-snug [overflow-wrap:anywhere]">{r.title}</span>
                <span className="block text-[14px] text-muted-foreground">{[r.uploaded_by, r.posted_on].filter(Boolean).join(' · ')}</span>
              </span>
              <ExternalLink className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
            </a>
          </li>
        )
      })}
    </ol>
  )
}

interface Where { mod: string | null; day: string | null; item: string | null }

function Course({ cs, back, initial }: { cs: string; back: () => void; initial: Where }) {
  const qc = useQueryClient()
  const key = ['my-course', cs]
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Detail>(`/api/v1/portal/lms/course?class_subject_id=${cs}`) })
  const shared = useShared()
  const [where, setWhere] = useState<Where>(initial)
  /* The page a lesson was opened from: the subject, or a topic. Back from the
     lesson returns there, one step at a time (owner, 2026-10-10: "make it a
     proper pipeline"). Moving lesson to lesson does not change it. */
  const lastPage = useRef<Where>({ mod: null, day: null, item: null })
  useEffect(() => { if (!where.item) lastPage.current = where }, [where])
  const [, setParams] = useSearchParams()
  const [quiz, setQuiz] = useState<string | null>(null)
  /* The subject page's own two controls (owner's design, 2026-10-10). Local
     to the page: a filter somebody set last week is not something they
     asked to still be in force today. */
  const [filter, setFilter] = useState<'all' | 'doing' | 'done' | 'locked'>('all')
  const [find, setFind] = useState('')
  const top = useRef<HTMLDivElement>(null)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    top.current?.scrollIntoView({ block: 'start' })
  }, [where.mod, where.day, where.item, quiz])
  const refresh = () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['my-courses'] }); qc.invalidateQueries({ queryKey: ['my-lms-todo'] }) }
  const d = q.data
  /* Keep the address and the device's "where I left off" on this place. */
  useEffect(() => {
    const p = new URLSearchParams({ cs })
    if (where.mod) p.set('mod', where.mod)
    if (where.day) p.set('day', where.day)
    if (where.item) p.set('item', where.item)
    setParams(p, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cs, where.mod, where.day, where.item])
  useEffect(() => {
    if (!d) return
    const [ty, iid] = (where.item ?? ':').split(':')
    const title = ty === 'lesson' ? d.modules.flatMap((m) => m.days.flatMap((x) => x.items)).find((x) => x.id === iid)?.lesson?.title
      : ty === 'quiz' ? d.quizzes.find((z) => z.id === iid)?.title : ty === 'assignment' ? d.assignments.find((a) => a.id === iid)?.title : undefined
    const dayName = where.day ? d.modules.flatMap((m) => m.days).find((x) => x.key === where.day)?.name : undefined
    const modName = where.mod ? d.modules.find((m) => m.id === where.mod)?.title : undefined
    rememberPlace({ cs, day: where.day, item: where.item, subject: d.course.subject, title: title ?? dayName ?? modName ?? d.resume?.title ?? d.course.subject })
  }, [cs, d, where.mod, where.day, where.item])
  if (quiz) return <div ref={top}><StudentQuiz id={quiz} back={() => { setQuiz(null); refresh() }} /></div>

  const modules = d?.modules ?? []
  const byId = new Map(modules.map((m) => [m.id, m]))
  const tops = modules.filter((m) => !m.parent_unit_id || !byId.has(m.parent_unit_id))
  const kids = (id: string) => modules.filter((x) => x.parent_unit_id === id)
  /** A module and everything inside it, in the order taken. */
  const subtree = (m: SModule, seen = new Set<string>()): SModule[] => (seen.has(m.id) ? [] : (seen.add(m.id), [m, ...kids(m.id).flatMap((k) => subtree(k, seen))]))
  const parentOf = (m: SModule) => (m.parent_unit_id ? byId.get(m.parent_unit_id) ?? null : null)
  /* The stops, in the order the course is taken. */
  const stops: Stop[] = modules.flatMap((m) => m.days.flatMap((dd) => dd.items.map((it) => ({ m, d: dd, it }))))
  const loose: SItem[] = d ? [
    ...d.assignments.filter((a) => !a.lms_unit_id).map((a) => ({ type: 'assignment' as const, id: a.id, section: 'assessment' as Section, required: false, done: !!a.submitted_at && a.status !== 'resubmit' || a.status === 'graded', pass_percent: null, locked: false })),
    ...d.quizzes.filter((z) => !z.lms_unit_id).map((z) => ({ type: 'quiz' as const, id: z.id, section: 'assessment' as Section, required: false, done: z.attempts > 0, pass_percent: null, locked: false })),
  ] : []
  const otherModule: SModule = { id: OTHER, title: 'More to do', state: 'open', days_done: 0, days: [{ key: OTHER, day: null, label: 'More to do', name: 'More to do', state: 'open', reason: null, done: loose.filter((x) => x.done).length, total: loose.length, opens_at: null, items: loose }] }
  const mySharedItems = (shared.data?.items ?? []).filter((r) => d && r.subject === d.course.subject)
  /* A link that names only the item (the home's Quiz time) may point at work
     that is on no day; it is then found among the other work. */
  const looseStops = loose.map((it) => ({ m: otherModule, d: otherModule.days[0], it }))
  const inLoose = !where.day && !!where.item && !stops.some((s) => `${s.it.type}:${s.it.id}` === where.item) && looseStops.some((s) => `${s.it.type}:${s.it.id}` === where.item)
  const dayStops = where.day === OTHER || inLoose ? looseStops : stops
  const cur = where.day ? (where.day === OTHER ? { m: otherModule, d: otherModule.days[0] } : (() => { for (const m of modules) { const x = m.days.find((y) => y.key === where.day); if (x) return { m, d: x } } return null })()) : null
  const item = where.item ? dayStops.find((s) => `${s.it.type}:${s.it.id}` === where.item) ?? null : null
  const mod = !item && !cur && where.mod ? (where.mod === SHARED ? SHARED : byId.get(where.mod) ?? null) : null
  const titleOf = (it: SItem) => it.type === 'lesson' ? it.lesson?.title ?? '' : it.type === 'quiz' ? d?.quizzes.find((z) => z.id === it.id)?.title ?? 'Quiz' : d?.assignments.find((a) => a.id === it.id)?.title ?? 'Homework'
  const allDays = modules.flatMap((m) => m.days)
  const daysDone = allDays.filter((x) => x.state === 'done').length
  const open = (s: Stop) => setWhere({ mod: s.m.id, day: s.d.key, item: `${s.it.type}:${s.it.id}` })
  const toModule = (id: string | null) => setWhere({ mod: id, day: null, item: null })
  /* Back from a day (or from a step with no day to go back to): the day's
     page, or for the part of a module with no day, the module itself. */
  /* NO DAY PAGE (owner, 2026-10-10: "so many pages to view an LMS video,
     those two are enough"). The topic shows its days as cards and a card
     opens the lesson, so back from a lesson is the topic itself. */
  const toDay = (k: string) => {
    void k
    setWhere(lastPage.current)
  }
  /* A day card opens that day's next step, or its first once all are done. */
  const openDayDirect = (m: SModule, k: string) => {
    const day = m.days.find((x) => x.key === k)
    if (!day || day.state === 'locked') return
    const steps = SECTIONS.flatMap((sec) => day.items.filter((i) => i.section === sec)).filter(canOpen)
    const it = steps.find((i) => !i.done) ?? steps[0]
    if (it) open({ m, d: day, it })
  }
  /* The day the child is on: the resume's, else the first open one not done. */
  const hereDay = d?.resume?.day_key ?? allDays.find((x) => x.state === 'open')?.key ?? null
  const hereUnit = modules.find((m) => m.days.some((x) => x.key === hereDay)) ?? null
  const isHere = (m: SModule) => !!hereUnit && subtree(m).includes(hereUnit)
  const look = subjectLook(d?.course.subject ?? '')
  const firstTodoIn = (m: SModule) => stops.find((s) => subtree(m).includes(s.m) && !s.it.done && canOpen(s.it)) ?? null
  const crumb = (m: SModule | null): string => (m ? [crumb(parentOf(m)), m.title].filter(Boolean).join(' · ') : '')
  const eyebrow = item || cur ? `${d?.course.subject ?? ''}${(item ?? cur)!.m.id === OTHER ? ' · More to do' : ` · ${crumb((item ?? cur)!.m)}`}`
    : mod && mod !== SHARED ? [d?.course.subject, crumb(parentOf(mod))].filter(Boolean).join(' · ') : mod === SHARED ? d?.course.subject ?? '' : 'My subjects'
  const title = item ? titleOf(item.it) : cur ? (cur.d.day === null ? cur.m.title : cur.d.name) : mod === SHARED ? 'Shared by your teacher' : mod ? mod.title : d?.course.subject ?? 'Subject'
  return (
    <div ref={top} className="scroll-mt-4">
      <PageHead eyebrow={eyebrow} title={title}
        actions={!item && !cur && !mod ? <Button variant="secondary" className="min-h-[48px] text-[16px]" onClick={back}><ArrowLeft className="h-5 w-5" /> All subjects</Button> : undefined} />
      <PageBody>
        {q.error ? <ErrorState error={q.error} /> : !d ? <CourseSkeleton /> : item ? (
          <ItemPage backLabel={lastPage.current.mod && lastPage.current.mod !== SHARED ? byId.get(lastPage.current.mod)?.title ?? d.course.subject : d.course.subject} d={d} qkey={key} stop={item} stops={dayStops} titleOf={titleOf} refresh={refresh} open={open} toDay={(k) => (k === OTHER ? setWhere({ mod: null, day: OTHER, item: null }) : toDay(k))} onQuiz={setQuiz} />
        ) : cur ? (
          <DayPage d={d} m={cur.m} day={cur.d} titleOf={titleOf} open={(it) => open({ m: cur.m, d: cur.d, it })}
            next={(() => { const sib = cur.m.days.filter((x) => x.day !== null); return sib[sib.indexOf(cur.d) + 1] ?? null })()}
            toDay={toDay} toBack={() => toModule(cur.m.id === OTHER ? null : cur.m.id)} backLabel={cur.m.id === OTHER ? 'All parts' : cur.m.title} />
        ) : mod === SHARED ? (
          <div className="space-y-4">
            <Card>{mySharedItems.length ? <SharedRows items={mySharedItems} /> : <p className="px-[var(--card-pad)] py-4 text-[16px] text-muted-foreground">Nothing shared yet.</p>}</Card>
            <ArrowBar label="Back"><BackBtn onClick={() => toModule(null)} sub="All parts" /><span /></ArrowBar>
          </div>
        ) : mod ? (
          <ModulePage d={d} m={mod} kids={kids(mod.id)} subtree={subtree} here={hereDay} isHere={isHere} titleOf={titleOf}
            openItem={(it, day) => open({ m: mod, d: day, it })} openDay={(k) => openDayDirect(mod, k)} openModule={toModule}
            next={firstTodoIn(mod)} openStop={open} back={() => toModule(parentOf(mod)?.id ?? null)} backLabel={parentOf(mod)?.title ?? 'All parts'} />
        ) : (
          /* THE SUBJECT, AS THE OWNER DREW IT (2026-10-10, three mockups:
             web, pad and phone).

             WHAT WENT. A vertical path of big numbered bubbles joined by a
             rail. It showed the modules and nothing inside them, so finding
             one lesson meant opening a module, then a day, then the step --
             three screens to reach a thing the child could already name. The
             owner's word for it was that the pipeline is hard and you cannot
             tell where the button is.

             WHAT CAME. The curriculum itself, open on the page: a unit is a
             row you can expand, and the lessons are listed under it with
             their own state and their own action. Nothing is nested out of
             sight, and every row says what pressing it will do.

             THE SHAPE AT EACH WIDTH, from the mockups. On a desk, two
             columns: the teacher and the progress stay still on the left
             while the curriculum scrolls on the right. On a pad and a phone
             the same pieces in one column, the progress card compact at the
             top. One component, two layouts, because they are the same
             information and a phone is not a different product. */
          <div className="lg:grid lg:grid-cols-12 lg:items-start lg:gap-6">
            <aside className="space-y-4 lg:col-span-4 lg:sticky lg:top-4">
              <Card>
                <div className="space-y-4 px-[var(--card-pad)] py-4">
                  {/* Who teaches it, and how far in they are. */}
                  <div className="flex items-center gap-3">
                    <Ring pct={allDays.length ? Math.round((100 * daysDone) / allDays.length) : 0} size={56} stroke={6} hue={look.hue} label={`${daysDone} of ${allDays.length} parts done`}>
                      <look.Icon className={cn('h-6 w-6', HUE[look.hue].fg)} strokeWidth={1.6} aria-hidden />
                    </Ring>
                    <div className="min-w-0 flex-1">
                      {/* Only when a teacher is set (owner, 2026-10-10: "don't show that"). */}
                      {d.course.teacher && <><p className="text-[12px] font-bold uppercase tracking-wider text-muted-foreground">Your teacher</p>
                      <p className="truncate text-[17px] font-bold leading-tight">{d.course.teacher}</p></>}
                      {allDays.length > 0 && <Stars pct={(100 * daysDone) / allDays.length} label={`${daysDone} of ${allDays.length} done`} />}
                    </div>
                  </div>

                  {/* The bar the mockup leads with: one number, one line. */}
                  <div>
                    <div className="mb-1.5 flex items-baseline justify-between">
                      <span className="text-[12px] font-bold uppercase tracking-wider text-muted-foreground">Finished</span>
                      <span className="text-[15px] font-bold text-success">{allDays.length ? Math.round((100 * daysDone) / allDays.length) : 0}%</span>
                    </div>
                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-2.5 rounded-full bg-success transition-[width] duration-500" style={{ width: `${allDays.length ? Math.round((100 * daysDone) / allDays.length) : 0}%` }} />
                    </div>
                    <p className="mt-1.5 text-[13px] text-muted-foreground">{daysDone} of {allDays.length} parts done</p>
                  </div>

                  {/* Three counts, from what this page already holds -- no
                      invented figures: parts, quizzes set, and the best mark
                      the child has where any quiz has been marked. */}
                  <div className="grid grid-cols-3 gap-2 border-t pt-3 text-center">
                    {([
                      ['Parts', String(allDays.length)],
                      ['Quizzes', String(d.quizzes.length)],
                      ['Best', (() => {
                        const marked = d.quizzes.filter((z) => z.best !== null && z.best !== undefined && z.max_score)
                        if (!marked.length) return '–'
                        const pct = Math.round(100 * marked.reduce((a, z) => a + (z.best ?? 0) / (z.max_score || 1), 0) / marked.length)
                        return `${pct}%`
                      })()],
                    ] as [string, string][]).map(([k, v]) => (
                      <div key={k} className="rounded-xl border bg-muted/40 px-1 py-2">
                        <span className="block text-[11px] text-muted-foreground">{k}</span>
                        <span className="block text-[16px] font-bold">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </Card>

              {/* The one big button, kept from before: it is the thing most
                  children press and the mockup's "Start" in another skin. */}
              {d.resume ? (() => {
                const r = d.resume!
                const st = stops.find((x) => x.it.type === r.type && x.it.id === r.id)
                if (!st) return null
                return (
                  <Button onClick={() => open(st)} className="h-auto min-h-[72px] w-full justify-start gap-3 whitespace-normal rounded-2xl px-[var(--card-pad)] py-3 text-left shadow-sm">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/15"><Play className="h-5 w-5 fill-current" aria-hidden /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[18px] font-bold leading-tight">{r.started ? 'Keep going' : 'Start here'}</span>
                      <span className="block text-[14px] leading-snug opacity-90 [overflow-wrap:anywhere]">{KID_KIND_LABEL[r.kind] ?? KID_SECTION_LABEL[r.section]}: {r.title}</span>
                    </span>
                    <ArrowRight className="h-7 w-7 shrink-0" aria-hidden />
                  </Button>
                )
              })() : allDays.length > 0 && daysDone === allDays.length ? (
                <Card><div className="flex items-center gap-3 px-[var(--card-pad)] py-4"><span className="grid h-10 w-10 place-items-center rounded-full bg-success text-white"><Sparkles className="h-5 w-5" /></span><p className="text-[16px] font-semibold">You finished everything. Well done!</p></div></Card>
              ) : null}
            </aside>

            <main className="mt-4 space-y-3 lg:col-span-8 lg:mt-0">
              {!modules.length && !loose.length && !mySharedItems.length ? (
                <EmptyState title="Nothing here yet" body="Your teacher has not added anything to this subject yet." />
              ) : (
                <>
                  {/* FOUR CHIPS AND A SEARCH. A course of twenty steps is a
                      page you scan, not read; the chips answer "what is left"
                      and the box answers "where is that one lesson". Counts
                      are on the chips because a chip that might be empty is a
                      press somebody has to spend to find out. */}
                  <Card>
                    <div className="flex flex-col gap-2.5 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 text-[13px] font-semibold [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        {(() => {
                          /* Only what this page lists. The loose homework
                             and quizzes are no longer shown here (see
                             below), so counting them would advertise work
                             the chips cannot take anybody to. */
                          const all = stops
                          const counts = {
                            all: all.length,
                            doing: all.filter((x) => !x.it.done && canOpen(x.it)).length,
                            done: all.filter((x) => x.it.done).length,
                            locked: all.filter((x) => !canOpen(x.it)).length,
                          }
                          return ([
                            ['all', 'All'], ['doing', 'To do'], ['done', 'Done'], ['locked', 'Locked'],
                          ] as const).map(([k, label]) => (
                            <button key={k} type="button" onClick={() => setFilter(k)}
                              className={cn('shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 transition-colors',
                                filter === k ? 'bg-foreground text-background' : 'border bg-card text-muted-foreground hover:text-foreground')}>
                              {label} ({counts[k]})
                            </button>
                          ))
                        })()}
                      </div>
                      <div className="relative shrink-0 sm:w-56">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                        <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a lesson"
                          aria-label="Find a lesson"
                          className="h-10 w-full rounded-xl border bg-muted/40 pl-8 pr-3 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                      </div>
                    </div>
                  </Card>

                  {/* THE UNITS, EACH ONE OPENABLE IN PLACE. <details> rather
                      than state of our own: it is open-by-default on the unit
                      the child is in, it survives a re-render, and the
                      keyboard and the screen reader already know what it is. */}
                  {/* NEWEST FIRST (owner, 2026-10-10: "recent uplaoding
                      should be first").

                      The part whose content went up most recently sits at
                      the top. On a course still being built, the video added
                      this morning is what a student came back for, and
                      Part 1 is the one they finished a fortnight ago.

                      The UNITS reorder; the lessons inside one do not. A
                      topic read back to front is not a topic, and nobody
                      asked for that -- what they asked for is to see new
                      work without scrolling to the bottom. A unit with
                      nothing datable in it keeps its syllabus place under
                      the rest. */}
                  {[...tops].sort((a, b) => {
                    const latest = (m: SModule) => stops
                      .filter((x) => subtree(m).includes(x.m))
                      .reduce((t, x) => { const at = x.it.lesson?.created_at ?? ''; return at > t ? at : t }, '')
                    return latest(b).localeCompare(latest(a))
                  }).map((m, i) => {
                    const mine = stops.filter((x) => subtree(m).includes(x.m))
                    const shown = mine.filter((x) => {
                      if (find.trim() && !titleOf(x.it).toLowerCase().includes(find.trim().toLowerCase())) return false
                      if (filter === 'done') return x.it.done
                      if (filter === 'doing') return !x.it.done && canOpen(x.it)
                      if (filter === 'locked') return !canOpen(x.it)
                      return true
                    })
                    const doneN = mine.filter((x) => x.it.done).length
                    const locked = mine.length > 0 && mine.every((x) => !canOpen(x.it))
                    const finished = mine.length > 0 && doneN === mine.length
                    const here = isHere(m) && !finished && !locked
                    /* A filter that empties a unit hides the unit: a row that
                       says "0 of 0" under a filter is noise. */
                    if ((find.trim() || filter !== 'all') && !shown.length) return null
                    return (
                      <details key={m.id} open={here || !!find.trim()}
                        className={cn('group card overflow-hidden', here && 'border-2 border-[hsl(var(--paint-buttons-bg,var(--primary))/0.6)]', locked && 'opacity-75')}>
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-[var(--card-pad)] py-3.5 transition-opacity hover:opacity-80 [&::-webkit-details-marker]:hidden">
                          <span className="flex min-w-0 items-center gap-3">
                            <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-[10px] text-[13px] font-bold',
                              finished ? 'bg-success/15 text-success' : locked ? 'bg-muted text-muted-foreground' : here ? GO : 'bg-primary/10 text-primary')}>
                              {finished ? <Check className="h-4 w-4" strokeWidth={3} aria-hidden /> : locked ? <Lock className="h-4 w-4" aria-hidden /> : i + 1}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-[16px] font-bold leading-tight">{m.title}</span>
                              <span className="block text-[13px] text-muted-foreground">
                                {locked ? (m.days.find((x) => x.reason)?.reason ?? 'Not open yet') : `${doneN} of ${mine.length} done`}
                              </span>
                            </span>
                          </span>
                          <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" aria-hidden />
                        </summary>
                        <ul className="border-t">
                          {shown.length === 0 ? (
                            <li className="px-[var(--card-pad)] py-3 text-[13.5px] text-muted-foreground">Nothing in this part yet.</li>
                          ) : shown.map((x) => {
                            const can = canOpen(x.it)
                            const quizOf = x.it.type === 'quiz' ? d.quizzes.find((z) => z.id === x.it.id) : null
                            const scored = quizOf && quizOf.best !== null && quizOf.best !== undefined && quizOf.max_score
                            const isNext = !x.it.done && can && mine.find((y) => !y.it.done && canOpen(y.it)) === x
                            return (
                              <li key={`${x.it.type}:${x.it.id}`} className={cn('border-t first:border-t-0', isNext && 'bg-success/[0.06]', !can && 'opacity-60')}>
                                <button type="button" disabled={!can} onClick={() => open(x)}
                                  className="flex w-full items-center justify-between gap-3 px-[var(--card-pad)] py-3 text-left transition-colors enabled:hover:bg-accent/40">
                                  <span className="flex min-w-0 items-center gap-2.5">
                                    <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full',
                                      x.it.done ? 'bg-success' : isNext ? 'bg-warning motion-safe:animate-pulse' : can ? 'bg-primary/40' : 'bg-muted-foreground/30')} />
                                    <span className="min-w-0">
                                      <span className={cn('block truncate text-[14.5px]', isNext ? 'font-bold' : 'font-medium')}>{titleOf(x.it)}</span>
                                      <span className="block text-[12px] text-muted-foreground">
                                        {KID_KIND_LABEL[kindOf(x.it)] ?? KIND_LABEL[kindOf(x.it)] ?? 'Step'}
                                        {x.d.day !== null ? ` · ${shortDay(x.d)}` : ''}
                                      </span>
                                    </span>
                                  </span>
                                  {scored ? (
                                    <span className="shrink-0 rounded-md bg-success/15 px-2 py-0.5 text-[12px] font-bold text-success">{Math.round((100 * (quizOf!.best ?? 0)) / (quizOf!.max_score || 1))}%</span>
                                  ) : !can ? (
                                    <span className="shrink-0 text-[12.5px] text-muted-foreground">Locked</span>
                                  ) : isNext ? (
                                    <span className="shrink-0 rounded-lg bg-[hsl(var(--paint-buttons-bg,var(--primary)))] px-3 py-1.5 text-[13px] font-semibold text-[hsl(var(--paint-buttons-text,var(--primary-foreground)))]">Start</span>
                                  ) : (
                                    <span className="shrink-0 rounded-lg bg-muted px-2.5 py-1 text-[12.5px] font-semibold text-muted-foreground">{x.it.done ? 'Review' : 'Open'}</span>
                                  )}
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      </details>
                    )
                  })}

                  {/* NO "MORE TO DO" HERE (owner, 2026-10-10: "no need of more
                      to do in lms ONLY VDS").

                      That row collected the homework and quizzes a teacher
                      set against no particular day and parked them at the
                      foot of the course. It made the LMS a second inbox for
                      work that already has its own screens -- Homework has a
                      tab in the dock, a quiz arrives as its own notice -- and
                      it is not what this page is for.

                      WHAT IS NOT REMOVED, and why. A quiz or an assignment
                      that a teacher placed ON a day stays inside its unit.
                      Those are `required` in lms_progress: the day is not done
                      until they are, and in a sequential course the next day
                      opens only when the day is done. Hiding them would be a
                      course that can never be finished, which is the same
                      trap as hiding the Done tick. Only the dayless pile
                      goes. */}
                  {mySharedItems.length > 0 && filter === 'all' && !find.trim() && (
                    <button type="button" onClick={() => toModule(SHARED)}
                      className="card flex w-full items-center justify-between gap-3 px-[var(--card-pad)] py-3.5 text-left transition-colors hover:bg-accent/40">
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-primary/10 text-primary"><Share2 className="h-4 w-4" aria-hidden /></span>
                        <span className="min-w-0">
                          <span className="block text-[16px] font-bold leading-tight">Shared by your teacher</span>
                          <span className="block text-[13px] text-muted-foreground">{mySharedItems.length} thing{mySharedItems.length === 1 ? '' : 's'}{mySharedItems.some((r) => !r.seen) ? ` · ${mySharedItems.filter((r) => !r.seen).length} new` : ''}</span>
                        </span>
                      </span>
                      <StepGo state={mySharedItems.some((r) => !r.seen) ? 'current' : 'open'} />
                    </button>
                  )}
                </>
              )}
            </main>
          </div>
        )}
      </PageBody>
    </div>
  )
}

/** One step of a day or a module, as a big row: a tick when done, its number, what to do and the title. */
function StepRow({ d, it, n, isNext, titleOf, onOpen }: { d: Detail; it: SItem; n: number; isNext: boolean; titleOf: (it: SItem) => string; onOpen: () => void }) {
  const k = kindOf(it)
  const sched = it.type === 'lesson' && it.lesson?.scheduled
  const blocked = !canOpen(it)
  return (
    <button type="button" disabled={blocked} onClick={onOpen}
      className={cn('flex min-h-[76px] w-full items-center gap-3 px-[var(--card-pad)] py-3 text-left enabled:hover:bg-muted/40 disabled:cursor-not-allowed', isNext && 'bg-primary/[0.05]')}>
      {it.done ? <DoneCheck done size={40} />
        : blocked ? <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><Lock className="h-5 w-5" aria-hidden /></span>
          : <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-full border-2 text-[17px] font-bold', isNext ? 'border-primary text-primary' : 'border-border text-muted-foreground')}>{n}</span>}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[14px] font-semibold uppercase tracking-wide text-primary">
          <KindIcon kind={k} className="h-5 w-5 shrink-0" /> {KID_KIND_LABEL[k] ?? 'Open'}
          {it.type === 'lesson' && it.lesson?.is_optional && <span className="font-normal normal-case tracking-normal text-muted-foreground">· if you like</span>}
          {it.lesson?.is_new && !it.done && <Badge tone="primary">New</Badge>}
        </span>
        <span className={cn('block text-[17px] font-medium leading-snug [overflow-wrap:anywhere]', blocked && 'text-muted-foreground')}>{titleOf(it)}</span>
        {sched ? <span className="flex items-center gap-1 text-[14px] text-muted-foreground"><Clock className="h-4 w-4" /> Opens {fmtWhen(it.lesson?.publish_at)}</span>
          : itemMeta(d, it) ? <span className="block text-[14px] text-muted-foreground">{itemMeta(d, it)}</span> : null}
      </span>
      {!blocked && <ArrowRight className={cn('h-6 w-6 shrink-0', isNext ? 'text-primary' : 'text-muted-foreground')} aria-hidden />}
    </button>
  )
}

/* One module: its days as bubbles, what sits straight in it as steps, and
   the modules inside it as cards, with Back and Next at the bottom. */
function ModulePage({ d, m, kids, subtree, here, isHere, titleOf, openItem, openDay, openModule, next, openStop, back, backLabel }: {
  d: Detail; m: SModule; kids: SModule[]; subtree: (m: SModule) => SModule[]; here: string | null; isHere: (m: SModule) => boolean; titleOf: (it: SItem) => string
  openItem: (it: SItem, day: SDay) => void; openDay: (k: string) => void; openModule: (id: string) => void; next: Stop | null; openStop: (s: Stop) => void; back: () => void; backLabel: string
}) {
  const all = subtree(m).flatMap((x) => x.days)
  const done = all.filter((x) => x.state === 'done').length
  const numbered = m.days.filter((x) => x.day !== null)
  const loose = m.days.find((x) => x.day === null) ?? null
  const looseItems = loose ? SECTIONS.flatMap((s) => loose.items.filter((i) => i.section === s)) : []
  const firstLoose = looseItems.find((it) => !it.done && canOpen(it)) ?? null
  const range = dateRange(m.starts_on, m.ends_on)
  return (
    <div className="space-y-4">
      {/* THE TOPIC, AS THE OWNER DREW IT (2026-10-10, "Topic Completed").
          A hero that celebrates when everything is done, with the progress
          on the right; then the days as cards that open their lesson. */}
      {(() => {
        const fin = all.length > 0 && done === all.length
        const pct = all.length ? Math.round((100 * done) / all.length) : 0
        return (
          <section className={cn('relative overflow-hidden rounded-3xl border bg-card/90 p-5 shadow-xl backdrop-blur-xl sm:p-8',
            fin ? 'border-emerald-100 shadow-emerald-950/5' : 'border-indigo-100 shadow-indigo-950/5')}>
            <div aria-hidden className={cn('pointer-events-none absolute -bottom-10 -right-10 size-64 rounded-full blur-3xl', fin ? 'bg-emerald-100/60' : 'bg-indigo-100/50')} />
            <div className="relative z-10 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-4 sm:gap-5">
                <div className={cn('grid size-14 shrink-0 place-items-center rounded-2xl text-white shadow-lg sm:size-16',
                  fin ? 'bg-gradient-to-tr from-emerald-500 to-teal-400 shadow-emerald-500/30' : 'bg-gradient-to-tr from-indigo-500 to-violet-400 shadow-indigo-500/30')}>
                  {fin ? <Check className="size-8" strokeWidth={3} aria-hidden /> : <span className="text-[18px] font-extrabold">{done}/{all.length}</span>}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h2 className="text-[20px] font-extrabold tracking-tight sm:text-[24px]">{fin ? 'All done here!' : all.length ? 'Keep going' : 'Nothing here yet'}</h2>
                    {all.length > 0 && (
                      <span className={cn('rounded-full border px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider',
                        fin ? 'border-emerald-200 bg-emerald-100 text-emerald-800' : 'border-indigo-200 bg-indigo-50 text-indigo-700')}>{pct}% complete</span>
                    )}
                  </div>
                  <p className="mt-1 text-[14px] text-muted-foreground">
                    {fin ? <>Outstanding work! You have finished every day in <strong className="font-semibold text-foreground">{m.title}</strong>.</> : m.description || `${done} of ${all.length} days done in ${m.title}.`}
                  </p>
                  {range && <p className="text-[13px] text-muted-foreground">{range}</p>}
                </div>
              </div>
              {all.length > 0 && (
                <div className="flex shrink-0 items-center gap-4 self-start rounded-2xl border border-slate-200/70 bg-slate-50/80 p-3 sm:self-auto">
                  <div className="px-3 text-center">
                    <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-400">Progress</span>
                    <span className={cn('font-mono text-[18px] font-bold', fin ? 'text-emerald-600' : 'text-indigo-600')}>{pct}%</span>
                  </div>
                  <div className="h-8 w-px bg-slate-200" />
                  <div className="px-3 text-center">
                    <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-400">Days</span>
                    <span className="font-mono text-[16px] font-bold text-amber-500">{done}/{all.length}</span>
                  </div>
                </div>
              )}
            </div>
          </section>
        )
      })()}
      {numbered.length > 0 && (
        <section className="space-y-4 rounded-3xl border bg-card p-5 shadow-sm sm:p-7">
          <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3">
            <div>
              <h3 className="text-[15px] font-bold">Daily study track</h3>
              <p className="text-[12px] text-muted-foreground">Tap a day to open its lesson</p>
            </div>
            <span className="shrink-0 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[12px] font-semibold text-emerald-700">
              {numbered.filter((x) => x.state === 'done').length} of {numbered.length} days done
            </span>
          </div>
          <DayCards d={d} days={numbered} here={here} titleOf={titleOf} onOpen={openDay} />
        </section>
      )}
      {loose && looseItems.length > 0 && (
        <Card>
          <h3 className="border-b px-[var(--card-pad)] py-3 text-[17px] font-semibold">{numbered.length ? 'More in this part' : 'Steps'}</h3>
          {loose.state === 'locked' && <p className="flex items-center gap-2 px-[var(--card-pad)] pt-3 text-[15px] text-muted-foreground"><Lock className="h-4 w-4" /> {loose.reason ?? 'Not open yet'}</p>}
          <ol className="divide-y">
            {looseItems.map((it, i) => <li key={`${it.type}:${it.id}`}><StepRow d={d} it={it} n={i + 1} isNext={it === firstLoose} titleOf={titleOf} onOpen={() => openItem(it, loose)} /></li>)}
          </ol>
        </Card>
      )}
      {kids.length > 0 && (
        <section aria-label="Inside this part" className="space-y-2">
          <h3 className="px-1 text-[17px] font-semibold">Inside this part</h3>
          <ol className="grid gap-3 sm:grid-cols-2">
            {kids.map((k) => {
              const days = subtree(k).flatMap((x) => x.days)
              const kd = days.filter((x) => x.state === 'done').length
              const locked = days.length > 0 && days.every((x) => x.state === 'locked')
              const fin = days.length > 0 && kd === days.length
              return (
                <li key={k.id}>
                  <button type="button" onClick={() => openModule(k.id)}
                    className={cn('card flex min-h-[84px] w-full items-center gap-3 px-[var(--card-pad)] py-3 text-left', isHere(k) && !fin && 'ring-2 ring-[hsl(var(--paint-buttons-bg,var(--primary))/0.4)]')}>
                    {locked ? <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><Lock className="h-5 w-5" /></span>
                      : <Ring pct={days.length ? (100 * kd) / days.length : 0} size={48} stroke={5} hue={fin ? 'emerald' : 'indigo'} label={`${kd} of ${days.length} done`}>{fin ? <Check className="h-5 w-5 text-success" strokeWidth={2.5} /> : null}</Ring>}
                    <span className="min-w-0 flex-1">
                      <span className="block text-[17px] font-semibold leading-snug [overflow-wrap:anywhere]">{k.title}</span>
                      <span className="block text-[14px] text-muted-foreground">{locked ? (days.find((x) => x.reason)?.reason ?? 'Not open yet') : fin ? 'All done!' : `${kd} of ${days.length} done`}</span>
                    </span>
                    <StepGo state={fin ? 'done' : locked ? 'locked' : isHere(k) ? 'current' : 'open'} />
                  </button>
                </li>
              )
            })}
          </ol>
        </section>
      )}
      {!all.length && !kids.length && <EmptyState title="Nothing here yet" body="Your teacher has not added anything here yet." />}
      <ArrowBar label="Back and next">
        <BackBtn onClick={back} sub={backLabel} />
        {next ? <NextBtn hot onClick={() => openStop(next)} label={done ? 'Keep going' : 'Start'} sub={titleOf(next.it)} />
          : <NextBtn hot={!!all.length && done === all.length} onClick={back} label={all.length && done === all.length ? 'All done' : 'Back up'} sub={backLabel} />}
      </ArrowBar>
    </div>
  )
}

/** The days as cards (owner, 2026-10-10): the day, a tick or lock, what the
    first step is, what kinds of steps it holds, and one button that opens
    the lesson directly -- Review when done, Start or Continue otherwise. */
function DayCards({ d, days, here, titleOf, onOpen }: { d: Detail; days: SDay[]; here: string | null; titleOf: (it: SItem) => string; onOpen: (key: string) => void }) {
  return (
    <ol className="grid grid-cols-2 gap-3 pt-1 sm:grid-cols-3 lg:grid-cols-5">
      {days.map((x) => {
        const locked = x.state === 'locked'
        const fin = x.state === 'done'
        const isHere = x.key === here && x.state === 'open'
        const first = SECTIONS.flatMap((sec) => x.items.filter((i) => i.section === sec))[0]
        const kinds = [...new Set(x.items.map((i) => KID_KIND_LABEL[kindOf(i)] ?? KIND_LABEL[kindOf(i)] ?? 'Step'))].slice(0, 2).join(' & ')
        void d
        return (
          <li key={x.key}>
            <button type="button" disabled={locked} onClick={() => onOpen(x.key)}
              className={cn('group flex h-full w-full flex-col justify-between gap-3 rounded-2xl border p-4 text-left transition-all',
                locked ? 'cursor-not-allowed border-slate-200/80 bg-muted/50 opacity-70'
                  : isHere ? 'border-indigo-300 bg-white shadow-md ring-2 ring-indigo-200/60'
                    : 'border-slate-200/80 bg-slate-50/70 hover:border-emerald-300 hover:bg-white hover:shadow-md')}>
              <span className="flex items-center justify-between">
                <span className="text-[12px] font-bold text-slate-700">{shortDay(x)}</span>
                {fin ? <span className="grid size-5 place-items-center rounded-full bg-emerald-500 text-white"><Check className="size-3" strokeWidth={3.5} aria-hidden /></span>
                  : locked ? <Lock className="size-4 text-muted-foreground" aria-hidden />
                    : <span className="text-[11px] font-semibold text-muted-foreground">{x.done}/{x.total}</span>}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold text-slate-900">{first ? titleOf(first) : x.name}</span>
                <span className="block truncate text-[11px] text-slate-500">{locked ? (x.reason ?? 'Not open yet') : kinds || 'Nothing yet'}</span>
              </span>
              <span className={cn('w-full rounded-xl border py-1.5 text-center text-[12px] font-semibold transition-colors',
                locked ? 'border-slate-200 bg-white text-muted-foreground'
                  : fin ? 'border-slate-200 bg-white text-slate-700 group-hover:border-emerald-200 group-hover:bg-emerald-50 group-hover:text-emerald-800'
                    : 'border-indigo-500 bg-indigo-500 text-white group-hover:bg-indigo-600')}>
                {locked ? 'Locked' : fin ? 'Review' : x.done ? 'Continue' : 'Start'}
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

function itemMeta(d: Detail, it: SItem): string {
  if (it.type === 'lesson' && it.lesson) return sourceMeta(it.lesson)
  if (it.type === 'quiz') { const z = d.quizzes.find((x) => x.id === it.id); return [z ? `${z.questions} question${z.questions === 1 ? '' : 's'}` : '', it.pass_percent ? `get ${it.pass_percent}% to pass` : ''].filter(Boolean).join(' · ') }
  const a = d.assignments.find((x) => x.id === it.id)
  return [a?.due_on ? `due ${a.due_on}` : '', it.pass_percent ? `get ${it.pass_percent}% to pass` : ''].filter(Boolean).join(' · ')
}

function DayPage({ d, m, day, titleOf, open, next, toDay, toBack, backLabel }: {
  d: Detail; m: SModule; day: SDay; titleOf: (it: SItem) => string; open: (it: SItem) => void; next: SDay | null; toDay: (k: string) => void; toBack: () => void; backLabel: string
}) {
  const bySection = SECTIONS.map((s) => ({ s, items: day.items.filter((i) => i.section === s) })).filter((x) => x.items.length)
  /* Steps are numbered through the whole day, in order. */
  const ordered = bySection.flatMap((x) => x.items)
  const firstTodo = ordered.find((it) => !it.done && canOpen(it)) ?? null
  const pct = day.total ? Math.round((100 * day.done) / day.total) : 0
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center gap-4 px-[var(--card-pad)] py-4">
          <Ring pct={day.state === 'done' ? 100 : pct} size={64} stroke={7} hue={day.state === 'done' ? 'emerald' : 'indigo'} label={`${day.done} of ${day.total} done`}>
            {day.state === 'done' ? <Check className="h-7 w-7 text-success" strokeWidth={2.5} /> : day.state === 'locked' ? <Lock className="h-6 w-6 text-muted-foreground" /> : <span className="text-[17px] font-bold">{day.done}/{day.total}</span>}
          </Ring>
          <div className="min-w-0 flex-1">
            <p className="text-[18px] font-semibold">{day.state === 'locked' ? 'Not open yet' : day.state === 'done' ? 'You did it! Day done.' : `${day.done} of ${day.total} steps done`}</p>
            <p className="text-[15px] text-muted-foreground">{day.state === 'locked' ? day.reason : m.id === OTHER ? 'Homework and quizzes' : day.state === 'done' ? 'Great work.' : 'Tick off each step, one at a time.'}</p>
          </div>
        </div>
      </Card>
      {bySection.map(({ s, items }) => (
        <Card key={s}>
          <h3 className="border-b px-[var(--card-pad)] py-3 text-[17px] font-semibold">{m.id === OTHER ? 'Homework and quizzes' : KID_SECTION_LABEL[s]}</h3>
          <ol className="divide-y">
            {items.map((it) => <li key={`${it.type}:${it.id}`}><StepRow d={d} it={it} n={ordered.indexOf(it) + 1} isNext={it === firstTodo} titleOf={titleOf} onOpen={() => open(it)} /></li>)}
          </ol>
        </Card>
      ))}
      {!bySection.length && <EmptyState title="Nothing on this day yet" body="Your teacher has not added anything here yet." />}
      <ArrowBar label="Back and next">
        <BackBtn onClick={toBack} sub={backLabel} />
        {firstTodo ? <NextBtn hot onClick={() => open(firstTodo)} label={day.done ? 'Next step' : 'Start'} sub={titleOf(firstTodo)} />
          : next && m.id !== OTHER ? <NextBtn hot={next.state !== 'locked'} locked={next.state === 'locked'} onClick={() => toDay(next.key)} label="Next day" sub={next.state === 'locked' ? (next.reason ?? 'Not open yet') : next.name} />
            : <NextBtn hot onClick={toBack} label="All done" sub={backLabel} />}
      </ArrowBar>
    </div>
  )
}

function ItemPage({ backLabel, d, qkey, stop, stops, titleOf, refresh, open, toDay, onQuiz }: {
  backLabel: string; d: Detail; qkey: unknown[]; stop: Stop; stops: Stop[]; titleOf: (it: SItem) => string; refresh: () => void; open: (s: Stop) => void; toDay: (k: string) => void; onQuiz: (id: string) => void
}) {
  const it = stop.it
  /* Previous and next skip what cannot be opened yet (scheduled); a locked day ends the way forward. */
  const openable = (s: Stop) => !(s.it.type === 'lesson' && s.it.lesson?.scheduled)
  const idx = stops.findIndex((s) => s === stop || (s.it.type === it.type && s.it.id === it.id))
  const prev = [...stops.slice(0, idx)].reverse().find(openable) ?? null
  const next = stops.slice(idx + 1).find(openable) ?? null
  const l = it.type === 'lesson' ? it.lesson ?? null : null
  const qc = useQueryClient()
  const [pop, setPop] = useState(false)
  /* THE RECEIPT SHOWS ITSELF, THEN GETS OUT OF THE WAY (owner, 2026-10-10:
     "show done and undo only few se[c]onds").

     Marking a step done put a green bar across the foot of the card and
     left it there for as long as the child stayed on the page -- on a step
     they finished last week it was the loudest thing on screen, announcing
     news from a fortnight ago. It is a receipt: it belongs for the moment
     after the press, and then it should be a quiet mark.

     Six seconds, and only after a press in this sitting. Opening a step
     that was already done shows the quiet mark straight away, because
     nothing just happened.

     The quiet mark is still the way back: it is the Undo control, with its
     own label, so nothing is taken away by the shrinking -- a child who
     ticked the wrong row can always untick it. */
  const [justDone, setJustDone] = useState(false)
  useEffect(() => {
    if (!justDone) return
    const t = window.setTimeout(() => setJustDone(false), 6000)
    return () => window.clearTimeout(t)
  }, [justDone])
  const btn = useRef<HTMLDivElement>(null)
  const nextRef = useRef<HTMLSpanElement>(null)
  /* Finishing a step: the tick pops, a little confetti, and the Next arrow
     gives a nudge so the child knows where to go (all still under reduced motion). */
  const cheer = (dayFinished: boolean) => {
    setPop(true)
    confetti(dayFinished ? btn.current : nextRef.current ?? btn.current)
    if (!reducedMotion()) nextRef.current?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 500, delay: 250, easing: 'ease-out' })
  }
  /* Optimistic: the tick, the day's ring and the counts move the moment it
     is tapped; the server's answer then settles them (or rolls them back). */
  const done = useMutation({
    mutationFn: (v: boolean) => api.post(`/api/v1/portal/lms/lessons/${l!.id}/complete`, { done: v }),
    onMutate: async (v: boolean) => {
      await qc.cancelQueries({ queryKey: qkey })
      const before = qc.getQueryData<Detail>(qkey)
      let finished = false
      qc.setQueryData<Detail>(qkey, (dd) => dd && {
        ...dd,
        modules: dd.modules.map((m) => ({
          ...m,
          days: m.days.map((day) => {
            const hit = day.items.find((x) => x.type === 'lesson' && x.id === l!.id)
            if (!hit || hit.done === v) return day
            const items = day.items.map((x) => (x === hit ? { ...x, done: v, lesson: x.lesson ? { ...x.lesson, done: v } : x.lesson } : x))
            const counted = hit.required || day.total === day.items.length
            const n = Math.max(0, Math.min(day.total, day.done + (counted ? (v ? 1 : -1) : 0)))
            const state = day.state === 'locked' ? day.state : n >= day.total && day.total > 0 ? 'done' as const : 'open' as const
            if (state === 'done' && day.state !== 'done') finished = true
            return { ...day, items, done: n, state }
          }),
        })),
      })
      if (v) cheer(finished)
      return { before }
    },
    onError: (_e, _v, ctx) => { if (ctx?.before) qc.setQueryData(qkey, ctx.before) },
    onSettled: refresh,
  })
  useEffect(() => {
    if (!l || it.locked) return
    fetch(`/api/v1/portal/lms/lessons/${l.id}/view`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => { if (r.ok && l.is_new) refresh() }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [l?.id])
  const k = l ? l.kind : it.type
  const meta = itemMeta(d, it)
  /* Any video, library or YouTube, finishes only by being watched to the end
     (owner, 2026-10-10): no "I finished this", and no Undo once it is done. */
  const autoVideo = !!l && (l.kind === 'video' || !!l.video_id || !!l.yt_video_id || !!youTubeIds(l.url).video)
  const quiz = it.type === 'quiz' ? d.quizzes.find((z) => z.id === it.id) : null
  const asg = it.type === 'assignment' ? d.assignments.find((a) => a.id === it.id) : null
  const inDay = stop.d.items
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex min-h-9 items-center gap-2 rounded-full bg-primary/[0.08] px-3 text-[16px] font-semibold text-primary">
          <KindIcon kind={k} className="h-5 w-5 shrink-0" /> {KID_KIND_LABEL[k] ?? 'Open'}
        </span>
        <span className="text-[15px] text-muted-foreground">
          {stop.d.day === null ? stop.m.title : shortDay(stop.d)} · {stop.m.id === OTHER ? 'More to do' : KID_SECTION_LABEL[it.section]}{inDay.length > 1 ? ` · step ${inDay.indexOf(it) + 1} of ${inDay.length}` : ''}{meta ? ` · ${meta}` : ''}
        </span>
        {it.done && <Badge tone="success">Done</Badge>}
        {l?.is_optional && <Badge>If you like</Badge>}
      </div>
      {it.locked ? (
        <Card><div className="flex items-center gap-3 px-[var(--card-pad)] py-6"><Lock className="h-6 w-6 text-muted-foreground" /><p className="text-[17px]">{stop.d.reason ?? 'This is not open yet.'}</p></div></Card>
      ) : (
        <Card>
          <div className="px-[var(--card-pad)] py-4 text-[17px]">
            {l && <LessonContent l={l} track onFinished={refresh} />}
            {asg && <ul className="-mx-[var(--card-pad)] -my-3"><AssignmentItem a={asg} qkey={qkey} /></ul>}
            {quiz && (
              <div className="space-y-3 text-[17px]">
                {quiz.instructions && <p className="whitespace-pre-wrap text-muted-foreground">{quiz.instructions}</p>}
                <p>{quiz.questions} question{quiz.questions === 1 ? '' : 's'}{quiz.duration_minutes ? ` · ${quiz.duration_minutes} minutes` : ' · take your time'}{quiz.closes_at ? ` · closes ${fmtWhen(quiz.closes_at)}` : ''}</p>
                {it.pass_percent ? <p className="text-muted-foreground">Get {it.pass_percent}% or more to open the next day.</p> : null}
                {quiz.best !== null && quiz.best !== undefined && <Badge tone={it.done ? 'success' : 'warning'}>Your best: {quiz.best} / {quiz.max_score}{it.pass_percent && !it.done ? ' · try again to pass' : ''}</Badge>}
                <div>
                  {quiz.open_attempt ? <Button className="min-h-[56px] px-6 text-[17px]" onClick={() => onQuiz(quiz.id)}>Carry on with the quiz <ArrowRight className="h-5 w-5" /></Button>
                    : quiz.open ? <Button className="min-h-[56px] px-6 text-[17px]" onClick={() => onQuiz(quiz.id)}>{quiz.attempts ? 'Try again' : 'Start the quiz'} <ArrowRight className="h-5 w-5" /></Button>
                      : <span className="text-muted-foreground">{quiz.attempts >= quiz.max_attempts ? 'You have had all your tries. Ask your teacher if you are stuck.' : 'This quiz is not open.'}</span>}
                </div>
              </div>
            )}
          </div>
          {l && (
            <div ref={btn} className="flex flex-wrap items-center gap-3 border-t px-[var(--card-pad)] py-3">
              {autoVideo ? (l.done
                ? <span className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-success"><DoneCheck done pop={pop} size={20} /> Watched</span>
                : <p className="text-[15px] text-muted-foreground">Watch the whole video to the end and it ticks itself. It carries on from where you left it.</p>) : (
                l.done ? (
                  /* Smaller (owner, 2026-10-10: "decreases the size of the
                     done"). A 40px tick and 18px type announced the finish of
                     a two-minute video like the end of an exam.

                     And it only says it for a moment. The full receipt --
                     tick, the word, and Undo spelled out -- belongs to the
                     six seconds after the press. After that, and on a step
                     that was already done when the child opened it, the same
                     control shrinks to a quiet tick that is still the Undo
                     button: nothing is taken away by the shrinking, so a
                     child who ticked the wrong row can always untick it. */
                  justDone ? (
                    <span className="inline-flex items-center gap-3">
                      <span className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-success"><DoneCheck done pop={pop} size={24} /> Done</span>
                      <Button variant="ghost" size="sm" onClick={() => { setPop(false); setJustDone(false); done.mutate(false) }}>Undo</Button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      title="Done — press to undo"
                      aria-label="Done. Press to mark this as not finished."
                      onClick={() => { setPop(false); done.mutate(false) }}
                      className="inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[13px] font-medium text-success transition-colors hover:bg-success/10"
                    >
                      <DoneCheck done pop={false} size={18} /> Done
                    </button>
                  )
                ) : (
                  <Button className="min-h-[56px] w-full px-6 text-[17px] sm:w-auto" onClick={() => { setJustDone(true); done.mutate(true) }}>
                    <Check className="h-6 w-6" strokeWidth={2.5} /> I finished this
                  </Button>
                )
              )}
              <FormNotice error={done.error} />
            </div>
          )}
        </Card>
      )}
      <ArrowBar label="Back and next">
        {prev ? <BackBtn onClick={() => open(prev)} sub={prev.d !== stop.d ? shortDay(prev.d) : titleOf(prev.it)} />
          : <BackBtn onClick={() => toDay(stop.d.key)} sub={backLabel} />}
        {next ? (
          <NextBtn btnRef={nextRef} hot={it.done || !it.required} locked={next.it.locked} onClick={() => open(next)}
            label={next.it.locked ? 'Finish this first' : next.d !== stop.d ? `Next: ${shortDay(next.d)}` : 'Next'} sub={next.it.locked ? (next.d.reason ?? (next.d === stop.d ? 'Watch this video to the end first' : `${shortDay(next.d)} is not open yet`)) : titleOf(next.it)} />
        ) : <NextBtn btnRef={nextRef} hot={it.done} onClick={() => toDay(stop.d.key)} label="All done" sub={`Back to ${backLabel}`} />}
      </ArrowBar>
    </div>
  )
}

function AssignmentItem({ a, qkey }: { a: Assignment; qkey: unknown[] }) {
  const qc = useQueryClient()
  const [text, setText] = useState(a.text_answer ?? '')
  const [file, setFile] = useState<{ id: string; name: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [sent, setSent] = useState('')
  const canHandIn = a.allow_submission && a.status !== 'graded'
  const submit = useMutation({
    mutationFn: () => api.post<{ late: boolean }>(`/api/v1/portal/lms/assignments/${a.id}/submit`, { text_answer: text, file_id: file?.id ?? a.file_id ?? undefined }),
    onSuccess: (r) => { setOpen(false); setSent(r.late ? 'Handed in (late). Your teacher will see it.' : 'Handed in! Your teacher will see it.'); qc.invalidateQueries({ queryKey: qkey }); qc.invalidateQueries({ queryKey: ['my-lms-todo'] }); qc.invalidateQueries({ queryKey: ['portal-student-homework'] }) },
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
      {sent && <p role="status" className="flex items-center gap-2 rounded-xl bg-[hsl(var(--sys-green)/0.12)] px-3 py-2 font-medium text-[hsl(var(--sys-green-ink))]"><DoneCheck done pop size={24} /> {sent}</p>}
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
          <span className="flex flex-wrap gap-2">
            <FilePick purpose="homework_submission" onDone={setFile} label="Take a photo" accept="image/*" capture />
            <FilePick purpose="homework_submission" onDone={setFile} label={a.file_id ? 'Replace the file' : 'Attach a file'} />
          </span>
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

function CourseSkeleton() {
  return (
    <div className="space-y-4" aria-busy>
      <Bone className="h-[88px] rounded-2xl" />
      <Bone className="h-[76px] rounded-2xl" />
      {[0, 1, 2].map((i) => <Bone key={i} className="h-[92px] rounded-2xl" />)}
    </div>
  )
}
