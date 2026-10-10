import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, ArrowRight, BookOpen, ExternalLink, Share2, Calculator, Check, Clock, FlaskConical, Globe2, Languages, Lock, Monitor, Music, Palette, Play, Sparkles, Star, Trophy,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Badge, Button, Card, EmptyState, ErrorState, Field, FormNotice, PageBody, PageHead, Textarea } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  FilePick, KID_KIND_LABEL, KID_SECTION_LABEL, KindIcon, LessonContent, SECTIONS, dateRange, fmtWhen, sourceMeta,
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
  const names = new Set((q.data?.items ?? []).map((c) => c.subject))
  const unfiled = (shared.data?.items ?? []).filter((r) => !r.subject || !names.has(r.subject))
  return (
    <>
      <PageHead eyebrow="Learning" title="My subjects" />
      <PageBody>
        {q.error ? <ErrorState error={q.error} /> : !ready ? (
          <div className="space-y-4" aria-busy>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Bone key={i} className="h-[184px] rounded-2xl" />)}</div>
          </div>
        ) : (
          <div className="space-y-6">
            {!q.data!.items.length ? <EmptyState title="No subjects yet" body="Your class has no subjects set up yet." /> : (
              <section aria-label="Subjects" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {q.data!.items.map((c) => {
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
/* THE PATH'S DOT. 40px on a phone, 56px from a tablet up (owner,
   2026-10-10: "see phone and pad view also"). At 56px it took 68px of a
   390px screen before the card began, which is a sixth of the width spent
   on a bullet; the title then wrapped to three lines and the row stopped
   looking like one step.

   DOT_W and RAIL keep the circle and the line that joins them in step: the
   rail must sit on the dot's centre, and two hand-written offsets drift
   apart the first time either changes. */
const DOT_W = 'h-10 w-10 sm:h-14 sm:w-14'
/** The connector, centred on the dot at both sizes. */
const RAIL = 'absolute bottom-0 left-[19px] top-11 w-1 rounded-full sm:left-[26px] sm:top-14'
function PathDot({ n, state }: { n: number | string; state: 'done' | 'current' | 'open' | 'locked' }) {
  return (
    <span className={cn('relative z-[1] grid shrink-0 place-items-center', DOT_W)}>
      {state === 'current' && <span aria-hidden className="absolute inset-0 rounded-full bg-[hsl(var(--paint-buttons-bg,var(--primary))/0.25)] motion-safe:animate-ping [animation-duration:2.2s]" />}
      <span className={cn('relative grid place-items-center rounded-full border-2 text-[16px] font-bold sm:text-[20px]', DOT_W,
        state === 'done' ? 'border-success bg-success text-white'
          : state === 'current' ? GO
            : state === 'locked' ? 'border-border bg-muted text-muted-foreground' : 'border-primary/40 bg-card text-primary')}>
        {state === 'done' ? <Check className="h-5 w-5 sm:h-7 sm:w-7" strokeWidth={2.5} aria-hidden /> : state === 'locked' ? <Lock className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden /> : n}
      </span>
    </span>
  )
}

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
  const [, setParams] = useSearchParams()
  const [quiz, setQuiz] = useState<string | null>(null)
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
  const toDay = (k: string) => {
    const hit = stops.find((s) => s.d.key === k)
    if (hit && hit.d.day === null) toModule(hit.m.id)
    else setWhere({ mod: hit?.m.id ?? null, day: k, item: null })
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
          <ItemPage d={d} qkey={key} stop={item} stops={dayStops} titleOf={titleOf} refresh={refresh} open={open} toDay={(k) => (k === OTHER ? setWhere({ mod: null, day: OTHER, item: null }) : toDay(k))} onQuiz={setQuiz} />
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
            openItem={(it, day) => open({ m: mod, d: day, it })} openDay={(k) => setWhere({ mod: mod.id, day: k, item: null })} openModule={toModule}
            next={firstTodoIn(mod)} openStop={open} back={() => toModule(parentOf(mod)?.id ?? null)} backLabel={parentOf(mod)?.title ?? 'All parts'} />
        ) : (
          <div className="space-y-5">
            <Card>
              <div className="flex items-center gap-4 px-[var(--card-pad)] py-4">
                <Ring pct={allDays.length ? Math.round((100 * daysDone) / allDays.length) : 0} size={72} stroke={7} hue={look.hue} label={`${daysDone} of ${allDays.length} parts done`}>
                  <look.Icon className={cn('h-8 w-8', HUE[look.hue].fg)} strokeWidth={1.6} aria-hidden />
                </Ring>
                <div className="min-w-0 flex-1">
                  <p className="text-[18px] font-semibold">{allDays.length ? `${daysDone} of ${allDays.length} done` : 'Nothing to do yet'}</p>
                  {allDays.length > 0 && <Stars pct={(100 * daysDone) / allDays.length} label={`${daysDone} of ${allDays.length} done`} />}
                  {d.course.teacher && <p className="text-[15px] text-muted-foreground">Your teacher: {d.course.teacher}</p>}
                </div>
              </div>
            </Card>
            {d.resume ? (() => {
              const r = d.resume!
              const s = stops.find((x) => x.it.type === r.type && x.it.id === r.id)
              if (!s) return null
              return (
                <Button onClick={() => open(s)} className="h-auto min-h-[84px] w-full justify-start gap-3 whitespace-normal rounded-2xl px-[var(--card-pad)] py-3 text-left shadow-sm">
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-white/15"><Play className="h-6 w-6 fill-current" aria-hidden /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[20px] font-bold leading-tight">{r.started ? 'Keep going' : 'Start here'}</span>
                    <span className="block text-[15px] leading-snug opacity-90 [overflow-wrap:anywhere]">{s.d.day === null ? s.m.title : shortDay(s.d)} · {KID_KIND_LABEL[r.kind] ?? KID_SECTION_LABEL[r.section]}: {r.title}</span>
                  </span>
                  <ArrowRight className="h-8 w-8 shrink-0" aria-hidden />
                </Button>
              )
            })() : allDays.length > 0 && daysDone === allDays.length ? (
              <Card><div className="flex items-center gap-3 px-[var(--card-pad)] py-4"><span className="grid h-12 w-12 place-items-center rounded-full bg-success text-white"><Sparkles className="h-6 w-6" /></span><p className="text-[18px] font-semibold">You finished everything. Well done!</p></div></Card>
            ) : null}
            {!modules.length && !loose.length && !mySharedItems.length ? <EmptyState title="Nothing here yet" body="Your teacher has not added anything to this subject yet." /> : (
              /* A path reads as a path at a readable width. Full-bleed on a
                 1800px desk put the step's name at one end of the screen and
                 its button at the other. */
              <ol className="relative mx-auto w-full max-w-3xl" aria-label="Your path">
                {tops.map((m, i) => {
                  const days = subtree(m).flatMap((x) => x.days)
                  const done = days.filter((x) => x.state === 'done').length
                  const locked = days.length > 0 && days.every((x) => x.state === 'locked')
                  const finished = days.length > 0 && done === days.length
                  const here = isHere(m) && !finished && !locked
                  const range = dateRange(m.starts_on, m.ends_on)
                  const last = i === tops.length - 1 && !loose.length && !mySharedItems.length
                  return (
                    <li key={m.id} className="relative flex gap-3 pb-5">
                      {!last && <span aria-hidden className={cn(RAIL, finished ? 'bg-success' : 'bg-border')} />}
                      <PathDot n={i + 1} state={finished ? 'done' : locked ? 'locked' : here ? 'current' : 'open'} />
                      <button type="button" onClick={() => toModule(m.id)}
                        className={cn('card flex min-h-[64px] min-w-0 flex-1 items-center gap-3 px-[var(--card-pad)] py-3 text-left', here && 'ring-2 ring-[hsl(var(--paint-buttons-bg,var(--primary))/0.4)]')}>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[18px] font-semibold leading-snug [overflow-wrap:anywhere]">{m.title}</span>
                          <span className="block text-[15px] text-muted-foreground">
                            {locked ? (days.find((x) => x.reason)?.reason ?? 'Not open yet') : finished ? 'All done!' : `${done} of ${days.length} done`}{range ? ` · ${range}` : ''}
                          </span>
                        </span>
                        <StepGo state={finished ? 'done' : locked ? 'locked' : here ? 'current' : 'open'} />
                      </button>
                    </li>
                  )
                })}
                {loose.length > 0 && (
                  <li className={cn('relative flex gap-3', mySharedItems.length > 0 && 'pb-5')}>
                    {mySharedItems.length > 0 && <span aria-hidden className={cn(RAIL, 'bg-border')} />}
                    <PathDot n="+" state={loose.every((x) => x.done) ? 'done' : 'open'} />
                    <button type="button" onClick={() => setWhere({ mod: null, day: OTHER, item: null })} className="card flex min-h-[64px] min-w-0 flex-1 items-center gap-3 px-[var(--card-pad)] py-3 text-left">
                      <span className="min-w-0 flex-1">
                        <span className="block text-[18px] font-semibold">More to do</span>
                        <span className="block text-[15px] text-muted-foreground">Homework and quizzes · {loose.filter((x) => x.done).length} of {loose.length} done</span>
                      </span>
                      <StepGo state={loose.every((x) => x.done) ? 'done' : 'open'} />
                    </button>
                  </li>
                )}
                {mySharedItems.length > 0 && (
                  <li className="relative flex gap-3">
                    <span className="relative z-[1] grid h-14 w-14 shrink-0 place-items-center rounded-full border-2 border-primary/40 bg-card text-primary"><Share2 className="h-6 w-6" aria-hidden /></span>
                    <button type="button" onClick={() => toModule(SHARED)} className="card flex min-h-[64px] min-w-0 flex-1 items-center gap-3 px-[var(--card-pad)] py-3 text-left">
                      <span className="min-w-0 flex-1">
                        <span className="block text-[18px] font-semibold">Shared by your teacher</span>
                        <span className="block text-[15px] text-muted-foreground">{mySharedItems.length} thing{mySharedItems.length === 1 ? '' : 's'}{mySharedItems.some((r) => !r.seen) ? ` · ${mySharedItems.filter((r) => !r.seen).length} new` : ''}</span>
                      </span>
                      <ArrowRight className="h-6 w-6 shrink-0 text-muted-foreground" aria-hidden />
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
      <Card>
        <div className="flex items-center gap-4 px-[var(--card-pad)] py-4">
          <Ring pct={all.length ? Math.round((100 * done) / all.length) : 0} size={64} stroke={7} hue={all.length && done === all.length ? 'emerald' : 'indigo'} label={`${done} of ${all.length} done`}>
            {all.length && done === all.length ? <Check className="h-7 w-7 text-success" strokeWidth={2.5} /> : <span className="text-[17px] font-bold">{done}/{all.length}</span>}
          </Ring>
          <div className="min-w-0 flex-1">
            <p className="text-[18px] font-semibold">{all.length && done === all.length ? 'All done here!' : `${done} of ${all.length} done`}</p>
            {m.description && <p className="text-[15px] text-muted-foreground">{m.description}</p>}
            {range && <p className="text-[14px] text-muted-foreground">{range}</p>}
          </div>
        </div>
      </Card>
      {numbered.length > 0 && (
        <Card>
          <h3 className="border-b px-[var(--card-pad)] py-3 text-[17px] font-semibold">Days</h3>
          <div className="px-[var(--card-pad)] py-3"><DayBubbles days={numbered} here={here} onOpen={openDay} /></div>
        </Card>
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
                    <ArrowRight className="h-6 w-6 shrink-0 text-muted-foreground" aria-hidden />
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

/** A module's days as big numbered bubbles: a tick when done, a lock (and why) when shut. */
function DayBubbles({ days, here, onOpen }: { days: SDay[]; here: string | null; onOpen: (key: string) => void }) {
  if (!days.length) return <p className="py-2 text-[16px] text-muted-foreground">Nothing here yet.</p>
  return (
    <ol className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-x-2 gap-y-3">
      {days.map((x) => {
        const isHere = x.key === here && x.state === 'open'
        const sub = x.state === 'locked' ? (x.reason ?? 'Not open yet') : x.state === 'done' ? 'Done' : `${x.done} of ${x.total}`
        return (
          <li key={x.key}>
            <button type="button" disabled={x.state === 'locked'} onClick={() => onOpen(x.key)} aria-label={`${x.name}: ${sub}`}
              className="flex w-full flex-col items-center gap-1 rounded-xl p-1 text-center enabled:active:scale-95 disabled:cursor-not-allowed">
              <span className={cn('relative grid h-16 w-16 place-items-center rounded-full border-2 text-[22px] font-bold',
                x.state === 'done' ? 'border-success bg-success text-white'
                  : x.state === 'locked' ? 'border-border bg-muted text-muted-foreground'
                    : isHere ? GO
                      : 'border-primary/40 bg-card text-primary')}>
                {x.state === 'done' ? <Check className="h-8 w-8" strokeWidth={2.5} aria-hidden /> : x.state === 'locked' ? <Lock className="h-6 w-6" aria-hidden /> : x.day ?? '•'}
              </span>
              <span className="text-[15px] font-semibold leading-tight">{shortDay(x)}</span>
              <span className="line-clamp-2 text-[13px] leading-tight text-muted-foreground">{sub}</span>
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
  const autoVideo = !!l && l.kind === 'video' && !!l.video_id
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
              {autoVideo && !l.done ? <p className="text-[15px] text-muted-foreground">Watch the video to the end and it ticks itself.</p> : (
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
          : <BackBtn onClick={() => toDay(stop.d.key)} sub={shortDay(stop.d)} />}
        {next ? (
          <NextBtn btnRef={nextRef} hot={it.done || !it.required} locked={next.it.locked} onClick={() => open(next)}
            label={next.it.locked ? 'Finish this first' : next.d !== stop.d ? `Next: ${shortDay(next.d)}` : 'Next'} sub={next.it.locked ? (next.d.reason ?? `${shortDay(next.d)} is not open yet`) : titleOf(next.it)} />
        ) : <NextBtn btnRef={nextRef} hot={it.done} onClick={() => toDay(stop.d.key)} label="All done" sub={`Back to ${shortDay(stop.d)}`} />}
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
