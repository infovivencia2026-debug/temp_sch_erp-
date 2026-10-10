import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive, ArchiveRestore, CalendarClock, ChevronLeft, ChevronRight, Eye, EyeOff, FolderInput, GripVertical, MoreHorizontal, Pencil, Plus, Trash2, Unlock, Users, X,
  Play,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useOptimisticMutation } from '@/lib/optimistic'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, FormNotice, Input, Loading, Select, Textarea } from '@/components/ui'
import { VideoPick, VideoUpload } from './VideoLibrary'
import {
  FilePick, KIND_LABEL, KindChip, KindIcon, LessonContent, NotesEditor, ProgressRing, SECTIONS, SECTION_LABEL, TypeCounts, dateRange, dayTitle, fmtWhen, moduleItems, sourceMeta,
  type ItemType, type Lesson, type Placed, type RubricRow, type Section, type SourceKind, type Unit,
} from '../learning/lms-shared'
import { AssignmentForm, LAYOUTS, QuizForm, type Layout } from './TeacherLMS'

/* A COURSE, MODULE FIRST AND ONE DAY AT A TIME (worker routes/teaching/lms.ts,
   lms_progress.ts; migrations 0011, 0012).

   Course > Module (a module may hold sub-modules) > Day 1, Day 2, ... > the
   day's four sections: Pre-requisites, Resources, Tools and Assessment. Any
   source (video, PDF, notes, file, link, image, audio, slides) can go in any
   section; a quiz or an assignment is the day's assessment, with an
   optional pass mark. In a course taken one by one (the default), a child's
   next day opens when this one is done; the teacher can switch a course to
   open, and can open a day early for one child from the Progress grid. */

export interface TAssignment extends Placed {
  kind: string; instructions?: string | null; assigned_on: string; due_on?: string | null; max_marks?: number | null
  rubric: RubricRow[] | null; submitted: number; to_mark: number; graded: number; returned: number
}
export interface TQuiz extends Placed { status: string; duration_minutes?: number | null; closes_at?: string | null; questions: number; attempted: number }
export interface CourseDetail {
  course: { section_id: string; section_name: string; class_name: string; class_subject_id: string; subject: string }
  roll: number; today: string; units: Unit[]; assignments: TAssignment[]; quizzes: TQuiz[]
  gating: 'sequential' | 'open'; days: { unit_id: string; day: number; label: string }[]
  layout?: 'topic_day' | 'day' | 'topic'
}
export type Tab = 'modules' | 'assignments' | 'quizzes' | 'progress'

const nowIso = () => new Date().toISOString()
function StateBadge({ l }: { l: Lesson }) {
  if (!l.is_published) return <Badge tone="warning">Draft</Badge>
  if (l.publish_at && l.publish_at > nowIso()) return <Badge tone="info">Opens {fmtWhen(l.publish_at)}</Badge>
  return <Badge tone="success">Published</Badge>
}
const toLocal = (iso?: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

/** A module's items with their day and section, the teacher's way. */
interface TItem { type: 'lesson' | 'assignment' | 'quiz'; id: string; day: number | null; section: Section; seq: number; title: string; lesson?: Lesson }
function itemsOf(d: CourseDetail, u: Unit): TItem[] {
  return [
    ...u.lessons.map((l) => ({ type: 'lesson' as const, id: l.id, day: l.day ?? null, section: l.section ?? 'resources', seq: l.sequence, title: l.title, lesson: l })),
    ...d.assignments.filter((a) => a.lms_unit_id === u.id).map((a) => ({ type: 'assignment' as const, id: a.id, day: a.lms_day ?? null, section: 'assessment' as Section, seq: a.lms_sequence ?? 9999, title: a.title })),
    ...d.quizzes.filter((q) => q.lms_unit_id === u.id).map((q) => ({ type: 'quiz' as const, id: q.id, day: q.lms_day ?? null, section: 'assessment' as Section, seq: q.lms_sequence ?? 9999, title: q.title })),
  ]
}
const kindOf = (i: TItem): ItemType => (i.type === 'lesson' ? i.lesson!.kind : i.type)
/** Every day of a module: labelled ones and ones with something on them, in order, then "not on a day". */
function daysOf(d: CourseDetail, u: Unit, items: TItem[]): { day: number | null; label: string }[] {
  const lab = new Map(d.days.filter((x) => x.unit_id === u.id).map((x) => [x.day, x.label]))
  const nums = new Set<number>([...lab.keys(), ...items.filter((i) => i.day !== null).map((i) => i.day!)])
  const out: { day: number | null; label: string }[] = [...nums].sort((a, b) => a - b).map((n) => ({ day: n, label: lab.get(n) ?? '' }))
  if (items.some((i) => i.day === null)) out.push({ day: null, label: '' })
  return out
}

function useDragOrder(ids: string[], commit: (ids: string[]) => void) {
  const from = useRef<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const move = (id: string, to: number) => {
    const next = ids.filter((x) => x !== id)
    next.splice(Math.max(0, Math.min(next.length, to)), 0, id)
    if (next.join() !== ids.join()) commit(next)
  }
  /* The grip is what is dragged (text in a form below stays selectable); the row is where it drops. */
  const handle = (id: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      from.current = id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id)
      const row = (e.currentTarget as HTMLElement).closest('li')
      if (row) e.dataTransfer.setDragImage(row, 20, 20)
    },
    onDragEnd: () => { from.current = null; setOver(null) },
  })
  const props = (id: string) => ({
    onDragOver: (e: React.DragEvent) => { if (from.current && ids.includes(from.current)) { e.preventDefault(); setOver(id) } },
    onDragLeave: () => setOver((o) => (o === id ? null : o)),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); const f = from.current; from.current = null; setOver(null); if (f && f !== id && ids.includes(f)) move(f, ids.indexOf(id)) },
    'data-over': over === id ? '' : undefined,
  })
  return { props, handle, up: (id: string) => move(id, ids.indexOf(id) - 1), down: (id: string) => move(id, ids.indexOf(id) + 1) }
}

/* No up/down arrows (owner, 2026-10-10: "remove this"). Order is set by
   dragging the grip; the props stay so the call sites need not change. */
function Arrows(_: { first: boolean; last: boolean; up: () => void; down: () => void; label: string }) {
  void _
  return null
}
const seg = (on: boolean) => `min-h-10 rounded px-3.5 text-[14px] font-medium ${on ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`

export function Modules({ d, qkey, onTab }: { d: CourseDetail; qkey: unknown[]; onTab: (t: Tab) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const layout = d.layout ?? 'topic_day'
  const active = d.units.filter((u) => u.is_active !== false)
  const unit = active.find((u) => u.id === open)
  if (layout === 'day') return <><LayoutSwitch d={d} qkey={qkey} /><DaysOnly d={d} qkey={qkey} onTab={onTab} /></>
  if (unit) return <ModuleView d={d} u={unit} qkey={qkey} noDays={layout === 'topic'} back={() => setOpen(unit.parent_unit_id && active.some((x) => x.id === unit.parent_unit_id) ? unit.parent_unit_id : null)} onOpen={setOpen} onTab={onTab} />
  return <><LayoutSwitch d={d} qkey={qkey} /><ModuleList d={d} qkey={qkey} onOpen={setOpen} /></>
}

/** How the course is built: topics with days, days only, or topics only. */
function LayoutSwitch({ d, qkey }: { d: CourseDetail; qkey: unknown[] }) {
  const set = useOptimisticMutation<Layout>({
    mutationFn: (layout) => api.put('/api/v1/lms/course/settings', { section_id: d.course.section_id, class_subject_id: d.course.class_subject_id, layout }),
    queryKeys: [qkey],
    invalidate: [qkey, ['lms-courses']],
    apply: (old, layout) => ({ ...(old as CourseDetail), layout }),
    failure: "Couldn't change the layout",
  })
  const now = d.layout ?? 'topic_day'
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="text-[14px] text-muted-foreground">Layout</span>
      <div className="inline-flex max-w-full gap-1 overflow-x-auto rounded-md border bg-muted p-1" role="radiogroup" aria-label="Layout">
        {LAYOUTS.map((l) => (
          <button key={l.value} type="button" role="radio" aria-checked={now === l.value} title={l.hint} onClick={() => now !== l.value && set.mutate(l.value)} className={seg(now === l.value)}>{l.label}</button>
        ))}
      </div>
    </div>
  )
}

/* Days only: the course keeps one module behind the scenes and shows its days. */
function DaysOnly({ d, qkey, onTab }: { d: CourseDetail; qkey: unknown[]; onTab: (t: Tab) => void }) {
  const qc = useQueryClient()
  const unit = d.units.find((u) => u.is_active !== false && !u.parent_unit_id)
  const make = useMutation({
    mutationFn: () => api.post('/api/v1/lms/units', { section_id: d.course.section_id, class_subject_id: d.course.class_subject_id, title: d.course.subject }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qkey }),
  })
  useEffect(() => { if (!unit && make.isIdle) make.mutate() }, [unit, make])
  if (unit) return <ModuleView d={d} u={unit} qkey={qkey} bare back={() => {}} onOpen={() => {}} onTab={onTab} />
  return make.error ? <FormNotice error={make.error} /> : <Loading />
}

/* Modules nest up to this many levels (the worker's MAX_DEPTH). */
const MAX_DEPTH = 4
const activeKids = (d: CourseDetail, id: string) => d.units.filter((x) => x.is_active !== false && x.parent_unit_id === id)
/** 1 for a top-level module, 2 inside it, and so on. */
function depthOf(d: CourseDetail, u: Unit): number {
  let n = 1, at = u.parent_unit_id
  while (at && n < 10) { n++; at = d.units.find((x) => x.id === at)?.parent_unit_id ?? null }
  return n
}
/** The levels a module and everything inside it take up. */
function heightOf(d: CourseDetail, u: Unit, seen = new Set<string>()): number {
  if (seen.has(u.id)) return 0
  seen.add(u.id)
  return 1 + Math.max(0, ...d.units.filter((x) => x.parent_unit_id === u.id).map((k) => heightOf(d, k, seen)))
}
/** "Module 3", or "Module 3.2", "Module 3.2.1" inside it. */
function moduleNumber(d: CourseDetail, u: Unit): string {
  const tops = d.units.filter((x) => x.is_active !== false && !x.parent_unit_id)
  if (!u.parent_unit_id) return `Module ${tops.indexOf(u) + 1}`
  const p = d.units.find((x) => x.id === u.parent_unit_id)
  if (!p || p.is_active === false) return 'Sub-module'
  return `${moduleNumber(d, p)}.${activeKids(d, p.id).indexOf(u) + 1}`
}
/** Swaps two modules in the course's whole order (sub-modules are ordered among their siblings by it). */
function swapOrder(d: CourseDetail, a: string, b: string): string[] {
  const ids = d.units.map((x) => x.id)
  const i = ids.indexOf(a), j = ids.indexOf(b)
  if (i >= 0 && j >= 0) [ids[i], ids[j]] = [ids[j], ids[i]]
  return ids
}

/** A module's sub-modules (and theirs), indented under it. */
function SubTree({ d, u, onOpen }: { d: CourseDetail; u: Unit; onOpen: (id: string) => void }) {
  const subs = activeKids(d, u.id)
  if (!subs.length) return null
  return (
    <ol className="space-y-2 border-l-2 border-primary/15 pl-3 sm:ml-6 sm:pl-4">
      {subs.map((sx) => <li key={sx.id} className="space-y-2"><ModuleCard d={d} u={sx} onOpen={() => onOpen(sx.id)} /><SubTree d={d} u={sx} onOpen={onOpen} /></li>)}
    </ol>
  )
}

/* ─── The list of modules ──────────────────────────────────────────── */

/** The course with its units in the order `ids` gives; anything not named keeps its place at the end. */
function unitsInOrder(d: CourseDetail, ids: string[]): CourseDetail {
  const rank = new Map(ids.map((id, i) => [id, i]))
  const units = [...d.units].sort((a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length))
  return { ...d, units }
}

function ModuleList({ d, qkey, onOpen }: { d: CourseDetail; qkey: unknown[]; onOpen: (id: string) => void }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const active = d.units.filter((u) => u.is_active !== false)
  const tops = active.filter((u) => !u.parent_unit_id)
  const archived = d.units.filter((u) => u.is_active === false)
  const ids = tops.map((u) => u.id)
  /* A drop is the new order, silently (lib/optimistic): the list is
     rewritten in the cache the moment the row lands, the save goes behind
     it, and a refusal puts the old order back with Retry. */
  const fullOrder = (next: string[]) => [...next, ...active.filter((u) => u.parent_unit_id).map((u) => u.id), ...archived.map((u) => u.id)]
  const reorder = useOptimisticMutation<string[]>({
    mutationFn: (next) => api.post('/api/v1/lms/units/reorder', { section_id: d.course.section_id, class_subject_id: d.course.class_subject_id, ids: fullOrder(next) }),
    queryKeys: [qkey],
    apply: (old, next) => unitsInOrder(old as CourseDetail, fullOrder(next)),
    failure: "Couldn't save the order",
  })
  const drag = useDragOrder(ids, (next) => reorder.mutate(next))
  const restore = useMutation({ mutationFn: (id: string) => api.put(`/api/v1/lms/units/${id}`, { is_active: true }), onSuccess: () => qc.invalidateQueries({ queryKey: qkey }) })
  const byId = new Map(tops.map((u) => [u.id, u]))
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted-foreground">One by one: each video opens when the one before it has been watched to the end.</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[14px] text-muted-foreground">{tops.length ? `${tops.length} module${tops.length === 1 ? '' : 's'}, in the order the class takes them.` : 'No modules yet.'}</p>
        <Button onClick={() => setAdding(!adding)}>{adding ? <><X className="h-4 w-4" /> Close</> : <><Plus className="h-4 w-4" /> New module</>}</Button>
      </div>
      {adding && <Card><ModuleForm d={d} done={() => { setAdding(false); qc.invalidateQueries({ queryKey: qkey }) }} /></Card>}
      {!tops.length && !adding && <EmptyState title="No modules yet" body="A module is a topic or a week. Add one, give it days, and put videos, PDFs, notes, links, quizzes and assignments on each day." />}
      <ol className="space-y-3">
        {ids.map((id, i) => {
          const u = byId.get(id)
          if (!u) return null
          return (
            <li key={id} {...drag.props(id)} className="space-y-2 rounded-xl data-[over]:outline data-[over]:outline-2 data-[over]:outline-primary">
              <ModuleCard d={d} u={u} onOpen={() => onOpen(id)} grip={drag.handle(id)} arrows={<Arrows first={i === 0} last={i === ids.length - 1} up={() => drag.up(id)} down={() => drag.down(id)} label={u.title} />} />
              <SubTree d={d} u={u} onOpen={onOpen} />
            </li>
          )
        })}
      </ol>
      <FormNotice error={reorder.error ?? restore.error} />
      {archived.length > 0 && (
        <div className="pt-2">
          <button type="button" className="inline-flex min-h-10 items-center gap-1.5 text-[14px] text-muted-foreground hover:text-foreground" onClick={() => setShowArchived(!showArchived)} aria-expanded={showArchived}>
            <Archive className="h-4 w-4" /> {showArchived ? 'Hide' : 'Show'} archived modules ({archived.length})
          </button>
          {showArchived && (
            <Card className="mt-2">
              <ul className="divide-y">
                {archived.map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center gap-2 px-[var(--card-pad)] py-2.5 text-[14px]">
                    <span className="min-w-0 flex-1 font-medium text-muted-foreground">{u.title}</span>
                    <span className="text-[13px] text-muted-foreground">{u.lessons.length} source{u.lessons.length === 1 ? '' : 's'}</span>
                    <Button size="sm" variant="secondary" pending={restore.isPending && restore.variables === u.id} onClick={() => restore.mutate(u.id)}><ArchiveRestore className="h-4 w-4" /> Restore</Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}

interface ModProgress { totals: { total: number }; complete: number; roll: number; items: { student_id: string; full_name: string; roll_no?: number | null; done: number; total: number; complete: boolean; last_seen?: string | null }[] }
const useModuleProgress = (u: Unit, sectionId: string) =>
  useQuery({ queryKey: ['lms-module-progress', u.id, sectionId], queryFn: () => api.get<ModProgress>(`/api/v1/lms/units/${u.id}/progress?section_id=${sectionId}`) })

function ModuleCard({ d, u, onOpen, arrows, grip }: { d: CourseDetail; u: Unit; onOpen: () => void; arrows?: React.ReactNode; grip?: object }) {
  const p = useModuleProgress(u, d.course.section_id)
  const items = moduleItems(u, d.assignments, d.quizzes)
  const days = daysOf(d, u, itemsOf(d, u)).filter((x) => x.day !== null).length
  const drafts = u.lessons.filter((l) => !l.is_published || (l.publish_at && l.publish_at > nowIso())).length
  const range = dateRange(u.starts_on, u.ends_on)
  const pct = p.data && p.data.roll ? Math.round((100 * p.data.complete) / p.data.roll) : 0
  return (
    <div className="card flex items-stretch gap-1 overflow-hidden p-0">
      {grip && <span {...grip} className="hidden cursor-grab items-center pl-2 text-muted-foreground active:cursor-grabbing sm:flex" aria-hidden title="Drag to reorder"><GripVertical className="h-4 w-4" /></span>}
      <button type="button" onClick={onOpen} className={`flex min-w-0 flex-1 items-center gap-3 px-[var(--card-pad)] ${u.parent_unit_id ? 'py-3' : 'py-4'} text-left ${grip ? 'sm:pl-2' : ''}`}>
        <ProgressRing pct={pct} size={u.parent_unit_id ? 38 : 44} label={p.data ? `${p.data.complete} of ${p.data.roll} have finished this module` : undefined} />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{moduleNumber(d, u)}{u.parent_unit_id ? ' · sub-module' : ''}{range ? ` · ${range}` : ''}</span>
          <span className={`block font-semibold leading-snug ${u.parent_unit_id ? 'text-[15px]' : 'text-[16px]'}`}>{u.title}</span>
          {u.description && <span className="block text-[13px] text-muted-foreground line-clamp-2">{u.description}</span>}
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {days > 0 && <span className="text-[13px] font-medium">{days} day{days === 1 ? '' : 's'}</span>}
            {items.length ? <TypeCounts items={items} /> : <span className="text-[13px] text-muted-foreground">Empty</span>}
            {drafts > 0 && <Badge tone="warning">{drafts} not yet visible</Badge>}
            {p.data && p.data.totals.total > 0 && <span className="text-[13px] text-muted-foreground">{p.data.complete} of {p.data.roll} finished</span>}
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
      {arrows && <span className="flex flex-col justify-center border-l pr-1">{arrows}</span>}
    </div>
  )
}

function ModuleForm({ d, u, parent, done }: { d: CourseDetail; u?: Unit; parent?: Unit; done: () => void }) {
  const [title, setTitle] = useState(u?.title ?? '')
  const [desc, setDesc] = useState(u?.description ?? '')
  const [from, setFrom] = useState(u?.starts_on ?? '')
  const [to, setTo] = useState(u?.ends_on ?? '')
  const [inside, setInside] = useState(u?.parent_unit_id ?? '')
  /* Where an existing module can move: the top level, or inside any module
     that is not itself or inside it, with room for its own levels. */
  const homes = u ? [{ value: '', label: 'Top level (its own module)' }, ...d.units.filter((x) => {
    if (x.is_active === false || x.id === u.id) return false
    for (let at: Unit | undefined = x; at; at = d.units.find((y) => y.id === at!.parent_unit_id)) if (at.id === u.id) return false
    return depthOf(d, x) + heightOf(d, u) <= MAX_DEPTH
  }).map((x) => ({ value: x.id, label: `Inside ${moduleNumber(d, x)} · ${x.title}` }))] : []
  const save = useMutation({
    mutationFn: () => {
      const body = { title, description: desc, starts_on: from || null, ends_on: to || null, ...(u && inside !== (u.parent_unit_id ?? '') ? { parent_unit_id: inside || null } : {}) }
      return u ? api.put(`/api/v1/lms/units/${u.id}`, body)
        : api.post('/api/v1/lms/units', { ...body, section_id: d.course.section_id, class_subject_id: d.course.class_subject_id, parent_unit_id: parent?.id })
    },
    onSuccess: done,
  })
  return (
    <div className="space-y-3 px-[var(--card-pad)] py-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={parent ? 'Sub-module title' : 'Module title'}><Input value={title} onChange={setTitle} placeholder={parent ? 'For example: Fraction puzzles' : 'For example: Fractions'} /></Field>
        <Field label="Short description" hint="Optional. One line on what it covers."><Input value={desc} onChange={setDesc} /></Field>
        <Field label="Starts on" hint="Optional."><Input type="date" value={from} onChange={setFrom} /></Field>
        <Field label="Ends on" hint="Optional."><Input type="date" value={to} onChange={setTo} /></Field>
        {u && <Field label="Where it sits" hint="Move it, with everything in it, inside another module."><Select value={inside} onChange={setInside} options={homes} /></Field>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!title.trim()} pending={save.isPending} onClick={() => save.mutate()}>{u ? 'Save' : parent ? 'Add sub-module' : 'Add module'}</Button>
        <Button variant="secondary" onClick={done}>Cancel</Button>
        <FormNotice error={save.error} />
      </div>
    </div>
  )
}

/* ─── One module: its days and their sections ─────────────────────── */

interface Adding { day: number | null; section: Section; type: ItemType | 'pick' | 'attach' }

function ModuleView({ d, u, qkey, back, onOpen, onTab, bare, noDays }: { d: CourseDetail; u: Unit; qkey: unknown[]; back: () => void; onOpen: (id: string) => void; onTab: (t: Tab) => void; bare?: boolean; noDays?: boolean }) {
  const qc = useQueryClient()
  const [view, setView] = useState<'days' | 'progress'>('days')
  const [editing, setEditing] = useState<'module' | 'sub' | null>(null)
  const refresh = () => { qc.invalidateQueries({ queryKey: qkey }); qc.invalidateQueries({ queryKey: ['lms-module-progress'] }); qc.invalidateQueries({ queryKey: ['lms-course-progress'] }) }
  const archive = useMutation({ mutationFn: () => api.del(`/api/v1/lms/units/${u.id}`), onSuccess: () => { refresh(); back() } })
  const addDay = useMutation({ mutationFn: () => api.post(`/api/v1/lms/units/${u.id}/days`, {}), onSuccess: refresh })
  const range = dateRange(u.starts_on, u.ends_on)
  const subs = activeKids(d, u.id)
  const parent = d.units.find((x) => x.id === u.parent_unit_id)
  const items = itemsOf(d, u)
  /* "Not on a day" is always there: content can go straight in the module, days or not. */
  /* Topics only: everything sits in the module, no days. Days only: just the days. */
  const days = noDays ? [{ day: null, label: 'Videos and content' }]
    : (() => { const x = daysOf(d, u, items); return bare ? x.filter((y) => y.day !== null) : x.some((y) => y.day === null) ? x : [...x, { day: null, label: '' }] })()
  // Silent and at once, like the drag above (lib/optimistic).
  const orderSubs = useOptimisticMutation<[string, string]>({
    mutationFn: (pair) => api.post('/api/v1/lms/units/reorder', { section_id: d.course.section_id, class_subject_id: d.course.class_subject_id, ids: swapOrder(d, pair[0], pair[1]) }),
    queryKeys: [qkey],
    invalidate: [qkey, ['lms-module-progress'], ['lms-course-progress']],
    apply: (old, pair) => unitsInOrder(old as CourseDetail, swapOrder(old as CourseDetail, pair[0], pair[1])),
    failure: "Couldn't save the order",
  })
  const numbered = days.filter((x) => x.day !== null).map((x) => x.day as number)
  const orderDays = useMutation({ mutationFn: (next: number[]) => api.post(`/api/v1/lms/units/${u.id}/days/order`, { days: next }), onSuccess: refresh })
  const moveDay = (day: number, by: number) => {
    const i = numbered.indexOf(day), j = i + by
    if (j < 0 || j >= numbered.length) return
    const next = [...numbered]; [next[i], next[j]] = [next[j], next[i]]
    orderDays.mutate(next)
  }
  return (
    <div className="space-y-4">
      {!bare && <div><Button variant="ghost" onClick={back}><ChevronLeft className="h-4 w-4" /> {parent ? parent.title : 'All modules'}</Button></div>}
      {!bare && <Card>
        {editing === 'module' ? <ModuleForm d={d} u={u} done={() => { setEditing(null); refresh() }} /> : (
          <div className="flex flex-wrap items-start gap-3 px-[var(--card-pad)] py-4">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{moduleNumber(d, u)}{parent ? ` · in ${parent.title}` : ''}{range ? ` · ${range}` : ''}</p>
              <h2 className="text-[20px] font-semibold leading-tight">{u.title}</h2>
              {u.description && <p className="text-[14px] text-muted-foreground">{u.description}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setEditing('module')}><Pencil className="h-4 w-4" /> Edit</Button>
              {depthOf(d, u) < MAX_DEPTH && <Button variant="secondary" onClick={() => setEditing('sub')}><Plus className="h-4 w-4" /> Sub-module</Button>}
              <Button variant="secondary" pending={archive.isPending} onClick={() => { if (window.confirm(`Archive "${u.title}"? The class stops seeing it. You can restore it from the list of modules.`)) archive.mutate() }}><Archive className="h-4 w-4" /> Archive</Button>
            </div>
          </div>
        )}
        {editing === 'sub' && <div className="border-t"><ModuleForm d={d} parent={u} done={() => { setEditing(null); refresh() }} /></div>}
        <FormNotice error={archive.error} />
      </Card>}
      {!bare && subs.length > 0 && (
        <div className="space-y-2">
          <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Sub-modules, taken after this module's own content</p>
          {subs.map((sx, i) => <ModuleCard key={sx.id} d={d} u={sx} onOpen={() => onOpen(sx.id)}
            arrows={subs.length > 1 ? <Arrows first={i === 0} last={i === subs.length - 1} up={() => orderSubs.mutate([sx.id, subs[i - 1].id])} down={() => orderSubs.mutate([sx.id, subs[i + 1].id])} label={sx.title} /> : undefined} />)}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex gap-1 rounded-md border bg-muted p-1" role="tablist">
          {(['days', 'progress'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={view === t} onClick={() => setView(t)} className={seg(view === t)}>{t === 'days' ? (noDays ? 'Content' : 'Days') : 'Who has finished'}</button>
          ))}
        </div>
        {view === 'days' && !noDays && <Button pending={addDay.isPending} onClick={() => addDay.mutate()}><Plus className="h-4 w-4" /> Add day</Button>}
      </div>
      <FormNotice error={addDay.error ?? orderDays.error} />
      {view === 'progress' ? <ModuleProgressView d={d} u={u} /> : !days.length ? (
        <EmptyState title="No days yet" body="Press Add day. Each day has four parts: pre-requisites, resources, tools and an assessment." />
      ) : (
        <div className="space-y-4">
          {days.map((x) => (
            <DayCard key={String(x.day)} d={d} u={u} qkey={qkey} day={x.day} label={x.label} items={noDays ? items : items.filter((i) => i.day === x.day)} refresh={refresh} onTab={onTab}
              arrows={x.day === null ? null : <Arrows first={numbered.indexOf(x.day) === 0} last={numbered.indexOf(x.day) === numbered.length - 1} up={() => moveDay(x.day!, -1)} down={() => moveDay(x.day!, 1)} label={`Day ${x.day}`} />} />
          ))}
        </div>
      )}
    </div>
  )
}

function DayCard({ d, u, qkey, day, label, items, arrows, refresh, onTab }: { d: CourseDetail; u: Unit; qkey: unknown[]; day: number | null; label: string; items: TItem[]; arrows: React.ReactNode; refresh: () => void; onTab: (t: Tab) => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(label)
  const [adding, setAdding] = useState<Adding | null>(null)
  const saveLabel = useMutation({ mutationFn: () => api.put(`/api/v1/lms/units/${u.id}/days/${day}`, { label: name }), onSuccess: () => { setEditing(false); refresh() } })
  const del = useMutation({ mutationFn: () => api.del(`/api/v1/lms/units/${u.id}/days/${day}`), onSuccess: refresh })
  /* An arrow press is the new order, silently (lib/optimistic): the items'
     sequence numbers are rewritten in the cache first, the save follows. */
  const reorder = useOptimisticMutation<TItem[]>({
    mutationFn: (next) => api.post(`/api/v1/lms/units/${u.id}/order`, { items: next.map((i) => ({ type: i.type, id: i.id })) }),
    queryKeys: [qkey],
    invalidate: [qkey, ['lms-module-progress'], ['lms-course-progress']],
    apply: (old, next) => {
      const c = old as CourseDetail
      const seq = new Map(next.map((i, n) => [`${i.type}:${i.id}`, n + 1]))
      return {
        ...c,
        units: c.units.map((x) => x.id !== u.id ? x : { ...x, lessons: x.lessons.map((l) => seq.has(`lesson:${l.id}`) ? { ...l, sequence: seq.get(`lesson:${l.id}`)! } : l) }),
        assignments: c.assignments.map((a) => seq.has(`assignment:${a.id}`) ? { ...a, lms_sequence: seq.get(`assignment:${a.id}`)! } : a),
        quizzes: c.quizzes.map((q) => seq.has(`quiz:${q.id}`) ? { ...q, lms_sequence: seq.get(`quiz:${q.id}`)! } : q),
      }
    },
    failure: "Couldn't save the order",
  })
  const sorted = (s: Section) => items.filter((i) => i.section === s).sort((a, b) => a.seq - b.seq)
  const done = () => { setAdding(null); refresh() }
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b px-[var(--card-pad)] py-3">
        {editing && day !== null ? (
          <div className="flex w-full flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1"><Field label={`Name for Day ${day}`} hint="Optional, for example: Fractions on a line."><Input value={name} onChange={setName} /></Field></div>
            <Button pending={saveLabel.isPending} onClick={() => saveLabel.mutate()}>Save</Button>
            <Button variant="secondary" onClick={() => { setEditing(false); setName(label) }}>Cancel</Button>
            <FormNotice error={saveLabel.error} />
          </div>
        ) : (
          <>
            <h3 className="min-w-0 flex-1 text-[16px] font-semibold">{day === null && label ? label : dayTitle(day, label)}</h3>
            <span className="text-[13px] text-muted-foreground">{items.length} item{items.length === 1 ? '' : 's'}</span>
            {day !== null && <button type="button" className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted" aria-label={`Rename Day ${day}`} title="Rename" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /></button>}
            {day !== null && !items.length && <button type="button" className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted" aria-label={`Remove Day ${day}`} title="Remove this empty day" onClick={() => del.mutate()}><Trash2 className="h-4 w-4" /></button>}
            {arrows}
          </>
        )}
        <FormNotice error={del.error} />
      </div>
      <div className="divide-y">
        {SECTIONS.map((s) => {
          const list = sorted(s)
          const open = !!adding && adding.section === s
          return (
            <section key={s} className="py-2" aria-label={SECTION_LABEL[s]}>
              <div className="flex items-center justify-between gap-2 px-[var(--card-pad)]">
                <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{SECTION_LABEL[s]}{list.length ? ` · ${list.length}` : ''}</h4>
                <button type="button" className="inline-flex min-h-10 items-center gap-1 rounded-md px-2 text-[13px] font-medium text-primary hover:bg-primary/5"
                  onClick={() => setAdding(open ? null : { day, section: s, type: 'pick' })} aria-expanded={open} aria-label={open ? 'Close' : `Add to ${SECTION_LABEL[s]}`}>
                  {open ? <><X className="h-3.5 w-3.5" /> Close</> : <><Plus className="h-3.5 w-3.5" /> Add</>}
                </button>
              </div>
              {open && adding && (
                <div className="mx-[var(--card-pad)] my-2 overflow-hidden rounded-lg border bg-muted/20">
                  {adding.type === 'pick' ? <TypePicker section={s} onPick={(t) => setAdding({ ...adding, type: t })} canAttach={d.assignments.some((a) => !a.lms_unit_id) || d.quizzes.some((q) => !q.lms_unit_id)} />
                    : adding.type === 'assignment' ? <AssignmentForm d={d} unitId={u.id} day={day} done={done} />
                      : adding.type === 'quiz' ? <QuizForm d={d} unitId={u.id} day={day} done={done} />
                        : adding.type === 'attach' ? <AttachExisting d={d} u={u} day={day} done={done} />
                          : <SourceForm kind={adding.type} u={u} d={d} day={day} section={s} done={done} />}
                </div>
              )}
              {list.length > 0 && (
                <ol>
                  {list.map((it, i) => (
                    <li key={`${it.type}:${it.id}`}>
                      <ItemRow d={d} u={u} it={it} refresh={refresh} onTab={onTab}
                        arrows={<Arrows first={i === 0} last={i === list.length - 1} label={it.title}
                          up={() => { const n = [...list]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; reorder.mutate(n) }}
                          down={() => { const n = [...list]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; reorder.mutate(n) }} />} />
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )
        })}
      </div>
      <FormNotice error={reorder.error} />
    </Card>
  )
}

const PICKS: ItemType[] = ['video', 'pdf', 'text', 'file', 'link', 'image', 'audio', 'doc', 'quiz', 'assignment']
const PICK_HINT: Record<string, string> = {
  video: 'Library, upload or YouTube', pdf: 'Read in the page', text: 'Written here', file: 'Any file to download',
  link: 'A web page', image: 'A picture or diagram', audio: 'A recording', doc: 'Slides, Word or Excel', quiz: 'Marked at once', assignment: 'Work to hand in',
}
const ADD_TITLE: Record<ItemType, string> = {
  video: 'Add a video', pdf: 'Add a PDF', text: 'Add notes', file: 'Add a file to download', link: 'Add a web link', image: 'Add an image', audio: 'Add a recording',
  doc: 'Add slides or a document', quiz: 'Add a quiz', assignment: 'Add an assignment',
}
function TypePicker({ section, onPick, canAttach }: { section: Section; onPick: (t: ItemType | 'attach') => void; canAttach: boolean }) {
  /* The assessment section offers the quiz and the assignment first; any source can still go there. */
  const assess: ItemType[] = ['quiz', 'assignment']
  const sources: ItemType[] = PICKS.filter((k) => !assess.includes(k))
  const picks: ItemType[] = section === 'assessment' ? [...assess, ...sources] : sources
  return (
    <div>
      <p className="px-3 pt-3 text-[13px] font-medium">Add to {SECTION_LABEL[section]}</p>
      <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4">
        {picks.map((k) => (
          <button key={k} type="button" onClick={() => onPick(k)} className="flex min-h-[3.5rem] items-center gap-2 rounded-lg border bg-background p-2 text-left hover:border-primary hover:bg-primary/[0.03]">
            <KindChip kind={k} />
            <span className="min-w-0"><span className="block text-[14px] font-medium leading-tight">{KIND_LABEL[k]}</span><span className="block text-[12px] leading-snug text-muted-foreground">{PICK_HINT[k]}</span></span>
          </button>
        ))}
      </div>
      {section === 'assessment' && canAttach && (
        <div className="border-t px-3 py-2">
          <button type="button" className="min-h-10 text-left text-[14px] text-primary hover:underline" onClick={() => onPick('attach')}>Or use an assignment or quiz already set in this course</button>
        </div>
      )}
    </div>
  )
}

function AttachExisting({ d, u, day, done }: { d: CourseDetail; u: Unit; day: number | null; done: () => void }) {
  const [pick, setPick] = useState('')
  const [pass, setPass] = useState('')
  const opts = [
    ...d.assignments.filter((a) => !a.lms_unit_id).map((a) => ({ value: `assignment:${a.id}`, label: `Assignment: ${a.title}` })),
    ...d.quizzes.filter((q) => !q.lms_unit_id).map((q) => ({ value: `quiz:${q.id}`, label: `Quiz: ${q.title}` })),
  ]
  const save = useMutation({
    mutationFn: () => { const [t, id] = pick.split(':'); return api.post(`/api/v1/lms/${t === 'quiz' ? 'quizzes' : 'assignments'}/${id}/module`, { unit_id: u.id, day, pass_percent: pass || null }) },
    onSuccess: done,
  })
  return (
    <div className="flex flex-wrap items-end gap-3 p-3">
      <div className="w-full sm:w-80"><Field label="Assignment or quiz"><Select value={pick} onChange={setPick} placeholder="Choose one" options={opts} /></Field></div>
      <div className="w-full sm:w-40"><Field label="Pass mark, %" hint="Empty: handing in is enough."><Input type="number" value={pass} onChange={setPass} /></Field></div>
      <Button disabled={!pick} pending={save.isPending} onClick={() => save.mutate()}>Add to this day</Button>
      <FormNotice error={save.error} />
    </div>
  )
}

const ACCEPT: Partial<Record<SourceKind, string>> = {
  pdf: 'application/pdf,.pdf', image: 'image/*', audio: 'audio/*,.mp3,.m4a,.wav,.ogg', doc: '.pdf,.ppt,.pptx,.pps,.ppsx,.doc,.docx,.xls,.xlsx,.odp,.odt,.ods,.key,.pages',
}
const sectionOptions = SECTIONS.map((s) => ({ value: s, label: SECTION_LABEL[s] }))
function dayOptions(d: CourseDetail, u: Unit) {
  return [...daysOf(d, u, itemsOf(d, u)).filter((x) => x.day !== null).map((x) => ({ value: String(x.day), label: dayTitle(x.day, x.label) })), { value: '', label: 'Not on a day' }]
}

function SourceForm({ kind: kind0, u, d, day: day0, section: section0, lesson, done }: { kind: SourceKind; u: Unit; d: CourseDetail; day: number | null; section: Section; lesson?: Lesson; done: () => void }) {
  const kind = lesson?.kind ?? kind0
  const [title, setTitle] = useState(lesson?.title ?? '')
  const [body, setBody] = useState(lesson?.body ?? '')
  const [url, setUrl] = useState(lesson?.url ?? '')
  const [vsrc, setVsrc] = useState<'library' | 'upload' | 'link'>(lesson ? (lesson.video_id ? 'library' : 'link') : 'library')
  const [video, setVideo] = useState(lesson?.video_id ?? '')
  const [file, setFile] = useState<{ id: string; name: string } | null>(lesson?.file_id ? { id: lesson.file_id, name: lesson.file_name ?? 'file' } : null)
  const [mins, setMins] = useState(lesson?.duration_minutes ? String(lesson.duration_minutes) : '')
  const [day, setDay] = useState(lesson ? (lesson.day ? String(lesson.day) : '') : day0 === null ? '' : String(day0))
  const [section, setSection] = useState<string>(lesson?.section ?? section0)
  const [optional, setOptional] = useState(!!lesson?.is_optional)
  const [openNow, setOpenNow] = useState(!!lesson?.open_now)
  const [publish, setPublish] = useState<'now' | 'draft' | 'schedule'>(lesson ? (!lesson.is_published ? 'draft' : lesson.publish_at && lesson.publish_at > nowIso() ? 'schedule' : 'now') : 'now')
  const [when, setWhen] = useState(toLocal(lesson?.publish_at))
  const [onlyHere, setOnlyHere] = useState(false)
  /* THE TEACHER'S OWN WORDS ABOUT THE VIDEO, and who made it.

     key_points is what the class should take away, written by the teacher.
     It is deliberately not generated: a summary derived from somebody
     else's recording, or from its captions, is derived from their work, and
     this product does not make one. The child writes their own notes under
     the player; this is the other half of that pair.

     yt_channel is attribution. The server stores the video id and nothing
     else -- no title, no thumbnail, no description, because YouTube's terms
     cap how long its metadata may be cached -- so the uploader's name is
     typed here once and shown beside the player. */
  const [keyPoints, setKeyPoints] = useState(lesson?.key_points ?? '')
  const [channel, setChannel] = useState(lesson?.yt_channel ?? '')
  /* Only a YouTube address grows the two extra boxes. Matched loosely on
     purpose: the server decides what is really a YouTube id, this only
     decides whether to offer the fields. */
  const isYouTube = /(?:youtube\.com|youtu\.be)\//i.test(url)
  const fileKind = kind === 'pdf' || kind === 'file' || kind === 'image' || kind === 'audio' || kind === 'doc'
  const lib = kind === 'video' && vsrc !== 'link'
  const save = useMutation({
    mutationFn: () => {
      const b = {
        unit_id: u.id, title, kind, body, url: lib ? '' : fileKind && file ? '' : url, video_id: lib ? video : undefined, file_id: fileKind ? file?.id ?? null : null,
        duration_minutes: mins ? Number(mins) : null, is_published: publish !== 'draft', publish_at: publish === 'schedule' && when ? new Date(when).toISOString() : null,
        day: day ? Number(day) : null, section, is_optional: optional, open_now: openNow,
        /* Always sent, so clearing the box clears the field. The server
           only replaces key_points when the key is present, which keeps a
           screen that has no such box from wiping what was written here. */
        key_points: keyPoints, yt_channel: channel,
      }
      return lesson ? api.put(`/api/v1/lms/lessons/${lesson.id}`, b) : api.post('/api/v1/lms/lessons', { ...b, section_id: onlyHere ? d.course.section_id : undefined })
    },
    onSuccess: done,
  })
  const ready = title.trim() && (kind === 'text' ? body.trim() : kind === 'link' ? url.trim() : kind === 'video' ? (lib ? video : url.trim()) : file || url.trim())
  /* Rendered by the form below, kept here so the markup stays one line of
     intent rather than twenty of layout. */
  const youTubeFields = isYouTube ? (
    <>
      <Field label="Whose channel is it?" hint="Shown under the player so the uploader is credited. The school stores only the video's id, never its title or thumbnail.">
        <Input value={channel} onChange={setChannel} placeholder="e.g. Khan Academy India" />
      </Field>
      <Field label="Key points" hint="Your own words — what this class should take from the video. Not a summary of it.">
        <Textarea value={keyPoints} onChange={setKeyPoints} rows={4} placeholder="Three or four things to watch for…" />
      </Field>
    </>
  ) : null
  return (
    <div className="space-y-4 p-3 sm:p-4">
      <p className="text-[14px] font-semibold">{lesson ? `Edit: ${lesson.title}` : ADD_TITLE[kind]}</p>
      <Field label="Title"><Input value={title} onChange={setTitle} /></Field>
      {kind === 'video' && (
        <div className="space-y-3">
          <div className="inline-flex max-w-full flex-wrap gap-1 rounded-md border bg-muted p-1" role="radiogroup" aria-label="Where the video comes from">
            {([['library', 'From the library'], ['upload', 'Upload new'], ['link', 'YouTube or link']] as const).map(([v, lab]) => (
              <button key={v} type="button" role="radio" aria-checked={vsrc === v} onClick={() => setVsrc(v)} className={`min-h-10 rounded px-3 text-[14px] ${vsrc === v ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground'}`}>{lab}</button>
            ))}
          </div>
          {vsrc === 'library' && <Field label="Video"><VideoPick value={video} onChange={setVideo} /></Field>}
          {vsrc === 'upload' && <VideoUpload onUploaded={(id, t) => { setVideo(id); if (!title.trim()) setTitle(t); setVsrc('library') }} />}
          {vsrc === 'link' && <Field label="Video address" hint="YouTube and Vimeo play in the page; any other address opens in a new tab."><Input value={url} onChange={setUrl} placeholder="https://www.youtube.com/watch?v=…" /></Field>}
        </div>
      )}
      {kind === 'text' && <Field label="Notes"><NotesEditor value={body} onChange={setBody} /></Field>}
      {kind === 'link' && <Field label="Address"><Input value={url} onChange={setUrl} placeholder="https://" /></Field>}
      {fileKind && (
        <div className="space-y-2">
          <FilePick purpose="study_material" accept={ACCEPT[kind]} onDone={setFile} label={file ? 'Replace the file' : kind === 'image' ? 'Upload an image' : kind === 'audio' ? 'Upload a recording' : 'Upload the file'} />
          {file && lesson?.file_id === file.id && <p className="text-[13px] text-muted-foreground">Now: {file.name}</p>}
          {!file && <Field label="Or a link to it" hint="Optional, when the file lives somewhere else."><Input value={url} onChange={setUrl} placeholder="https://" /></Field>}
        </div>
      )}
      {kind !== 'text' && <Field label="A note for the class" hint="Optional. Shown with the source."><Textarea rows={2} value={body} onChange={setBody} /></Field>}
      {youTubeFields}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Day"><Select value={day} onChange={setDay} options={dayOptions(d, u)} /></Field>
        <Field label="Section"><Select value={section} onChange={setSection} options={sectionOptions} /></Field>
        {(kind === 'text' || kind === 'audio' || (kind === 'video' && vsrc === 'link') || kind === 'link') && (
          <Field label={kind === 'text' ? 'Reading time, minutes' : 'Length, minutes'} hint="Optional."><Input type="number" value={mins} onChange={setMins} /></Field>
        )}
        <Field label="Who sees it, and when">
          <Select value={publish} onChange={(v) => setPublish(v as typeof publish)} options={[{ value: 'now', label: 'Published now' }, { value: 'schedule', label: 'Scheduled for later' }, { value: 'draft', label: 'Draft (only you)' }]} />
        </Field>
        {publish === 'schedule' && <Field label="Opens at" hint="The class sees it from this moment."><Input type="datetime-local" value={when} onChange={setWhen} /></Field>}
      </div>
      {/* WHEN CAN STUDENTS OPEN IT (owner, 2026-10-10: "unlock this now, or
          wait till the other videos are completed"). */}
      <Field label="When can students open it?">
        <Select value={openNow ? 'now' : 'after'} onChange={(v) => setOpenNow(v === 'now')} options={[
          { value: 'after', label: 'After the videos before it are watched' },
          { value: 'now', label: 'Unlocked now: open straight away' },
        ]} />
      </Field>
      <label className="flex min-h-10 items-center gap-2 text-[14px]"><input type="checkbox" className="h-4 w-4" checked={optional} onChange={(e) => setOptional(e.target.checked)} /> Optional: the next day can open without it</label>
      {!lesson && <label className="flex min-h-10 items-center gap-2 text-[14px]"><input type="checkbox" className="h-4 w-4" checked={onlyHere} onChange={(e) => setOnlyHere(e.target.checked)} /> Only this section (otherwise every section of the class)</label>}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!ready || (publish === 'schedule' && !when)} pending={save.isPending} onClick={() => save.mutate()}>{lesson ? 'Save' : publish === 'draft' ? 'Save as draft' : publish === 'schedule' ? 'Schedule' : 'Publish'}</Button>
        <Button variant="secondary" onClick={done}>Cancel</Button>
        <FormNotice error={save.error} />
      </div>
    </div>
  )
}

/** One video or source: who in the section has finished it, and who has not.

    THE OWNER'S TRACKER (2026-10-10, "Task Tracker" design): a header with
    the source and a progress bar, Pending / Completed tabs, and one row per
    child -- initials, name, class and section, and a status badge. No
    reminders from here ("no need of remind"). */
function WhoDone({ d, id, title, meta }: { d: CourseDetail; id: string; title: string; meta: string }) {
  const q = useQuery({
    queryKey: ['lms-lesson-progress', id, d.course.section_id],
    queryFn: () => api.get<{ items: { student_id: string; full_name: string; roll_no?: number | null; completed_at?: string | null }[] }>(`/api/v1/lms/lessons/${id}/progress?section_id=${d.course.section_id}`),
  })
  const [tab, setTab] = useState<'pending' | 'done'>('pending')
  if (q.error) return <div className="px-[var(--card-pad)] pb-2"><ErrorState error={q.error} /></div>
  if (!q.data) return <Loading />
  const all = q.data.items
  const done = all.filter((x) => x.completed_at), left = all.filter((x) => !x.completed_at)
  const pct = all.length ? Math.round((100 * done.length) / all.length) : 0
  const cls = [d.course.class_name, d.course.section_name].filter(Boolean).join(' · ')
  const rows = tab === 'done' ? done : left
  const initials = (n: string) => n.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?'
  return (
    <div className="mx-[var(--card-pad)] mb-3 overflow-hidden rounded-xl border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.05)]">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b px-5 py-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-[#fee2e2] text-[#ef4444]"><Play className="size-4 fill-current" aria-hidden /></span>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold">{title}</p>
            <p className="truncate text-[13px] text-muted-foreground">{meta}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-200" title={`${pct}% completed`}>
            <div className="h-full rounded-full bg-[#16a34a]" style={{ width: `${pct}%` }} />
          </div>
          <span className="rounded-full bg-muted px-2.5 py-1 text-[13px] font-semibold text-muted-foreground">{done.length} / {all.length} completed</span>
        </div>
      </div>
      <div className="flex gap-2 border-b bg-[#fafafa] px-5 py-3 dark:bg-muted/30">
        {(['pending', 'done'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} aria-pressed={tab === t}
            className={cn('rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors',
              tab === t ? 'border-border bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {t === 'pending' ? `Pending (${left.length})` : `Completed (${done.length})`}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-6 text-center text-[13.5px] text-muted-foreground">{tab === 'pending' ? 'Everyone has finished this.' : 'Nobody has finished this yet.'}</p>
      ) : (
        <ul className="max-h-[420px] overflow-y-auto">
          {rows.map((x) => (
            <li key={x.student_id} className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3 transition-colors last:border-b-0 hover:bg-slate-50 dark:border-border dark:hover:bg-muted/30">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#e0e7ff] text-[12px] font-semibold text-[#4338ca]">{initials(x.full_name)}</span>
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-medium">{x.full_name}</p>
                  <p className="truncate text-[12px] text-muted-foreground">{cls}{x.roll_no ? ` · Roll ${x.roll_no}` : ''}</p>
                </div>
              </div>
              {x.completed_at ? (
                <span className="shrink-0 rounded px-2 py-0.5 text-[12px] font-medium text-[#166534] bg-[#dcfce7]" title={fmtWhen(x.completed_at)}>Completed · {fmtWhen(x.completed_at)}</span>
              ) : (
                <span className="shrink-0 rounded bg-[#fef3c7] px-2 py-0.5 text-[12px] font-medium text-[#92400e]">Pending</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ItemRow({ d, u, it, arrows, refresh, onTab }: { d: CourseDetail; u: Unit; it: TItem; arrows: React.ReactNode; refresh: () => void; onTab: (t: Tab) => void }) {
  const [open, setOpen] = useState<'preview' | 'menu' | 'edit' | 'who' | null>(null)
  const kind = kindOf(it)
  let meta: React.ReactNode = null, right: React.ReactNode = null
  if (it.type === 'lesson') {
    const l = it.lesson!
    meta = <>{KIND_LABEL[l.kind]}{sourceMeta(l) ? ` · ${sourceMeta(l)}` : ''}{l.is_optional ? ' · optional' : ''}</>
    right = <><StateBadge l={l} /><span className="hidden text-[13px] text-muted-foreground sm:inline">{l.completed ?? 0}/{d.roll} done</span></>
  } else if (it.type === 'assignment') {
    const a = d.assignments.find((x) => x.id === it.id)!
    meta = <>Assignment{a.due_on ? ` · due ${a.due_on}` : ''}{a.lms_pass_percent ? ` · pass ${a.lms_pass_percent}%` : ''}</>
    right = <><span className="hidden text-[13px] text-muted-foreground sm:inline">{a.submitted}/{d.roll} handed in</span>{a.to_mark > 0 && <Badge tone="warning">{a.to_mark} to mark</Badge>}</>
  } else {
    const q = d.quizzes.find((x) => x.id === it.id)!
    meta = <>Quiz · {q.questions} question{q.questions === 1 ? '' : 's'}{q.duration_minutes ? ` · ${q.duration_minutes} min` : ''}{q.lms_pass_percent ? ` · pass ${q.lms_pass_percent}%` : ''}</>
    right = <><Badge tone={q.status === 'published' ? 'success' : 'neutral'}>{q.status === 'published' ? 'Open' : q.status === 'closed' ? 'Closed' : 'Draft'}</Badge><span className="hidden text-[13px] text-muted-foreground sm:inline">{q.attempted}/{d.roll} taken</span></>
  }
  return (
    <div>
      <div className="flex items-center gap-1 py-1 pl-1 pr-1 sm:pl-2">
        <button type="button" className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-md px-2 text-left hover:bg-muted/50" onClick={() => setOpen(open === 'preview' ? null : 'preview')} aria-expanded={open === 'preview'}>
          <KindChip kind={kind} />
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium leading-snug [overflow-wrap:anywhere] sm:truncate">{it.title}</span>
            <span className="block text-[13px] text-muted-foreground sm:truncate">{meta}</span>
            <span className="mt-1 flex flex-wrap items-center gap-2 sm:hidden">{right}</span>
          </span>
          <span className="hidden shrink-0 flex-wrap items-center justify-end gap-2 sm:flex">{right}</span>
        </button>
        {it.type === 'lesson' && <button type="button" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted" aria-label={`Who has finished ${it.title}`} title="Who has finished" aria-expanded={open === 'who'} onClick={() => setOpen(open === 'who' ? null : 'who')}>
          <Users className="h-4 w-4" />
        </button>}
        <button type="button" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted" aria-label={`Actions for ${it.title}`} aria-expanded={open === 'menu'} onClick={() => setOpen(open === 'menu' ? null : 'menu')}>
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {arrows}
      </div>
      {open === 'who' && <WhoDone d={d} id={it.id} title={it.title} meta={it.type === 'lesson' && it.lesson ? sourceMeta(it.lesson) : ''} />}
      {open === 'menu' && <ItemActions d={d} u={u} it={it} refresh={refresh} onTab={onTab} onEdit={() => setOpen('edit')} close={() => setOpen(null)} />}
      {open === 'edit' && it.lesson && <div className="mx-[var(--card-pad)] mb-2 rounded-lg border bg-muted/20"><SourceForm kind={it.lesson.kind} u={u} d={d} day={it.day} section={it.section} lesson={it.lesson} done={() => { setOpen(null); refresh() }} /></div>}
      {open === 'preview' && (
        <div className="mx-[var(--card-pad)] mb-2 rounded-lg border bg-background p-3">
          {it.lesson ? <LessonContent l={it.lesson} /> : (
            <div className="flex flex-wrap items-center gap-3 text-[14px]">
              <KindIcon kind={kind} />
              <span className="text-muted-foreground">{it.type === 'assignment' ? 'Marks, rubric and who has handed in are in the gradebook.' : 'Scores are in the quiz results.'}</span>
              <Button size="sm" variant="secondary" onClick={() => onTab(it.type === 'assignment' ? 'assignments' : 'quizzes')}>{it.type === 'assignment' ? 'Open the gradebook' : 'See results'}</Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ItemActions({ d, u, it, refresh, onTab, onEdit, close }: { d: CourseDetail; u: Unit; it: TItem; refresh: () => void; onTab: (t: Tab) => void; onEdit: () => void; close: () => void }) {
  const [when, setWhen] = useState(it.lesson ? toLocal(it.lesson.publish_at) : '')
  const [scheduling, setScheduling] = useState(false)
  const [toUnit, setToUnit] = useState(u.id)
  const [toDay, setToDay] = useState(it.day === null ? '' : String(it.day))
  const [toSection, setToSection] = useState<string>(it.section)
  const placed = it.type === 'assignment' ? d.assignments.find((x) => x.id === it.id) : it.type === 'quiz' ? d.quizzes.find((x) => x.id === it.id) : null
  const [pass, setPass] = useState(placed?.lms_pass_percent ? String(placed.lms_pass_percent) : '')
  const target = d.units.find((x) => x.id === toUnit) ?? u
  const run = useMutation({
    mutationFn: async (a: { op: string }) => {
      if (it.type !== 'lesson') {
        const base = `/api/v1/lms/${it.type === 'quiz' ? 'quizzes' : 'assignments'}/${it.id}/module`
        if (a.op === 'remove') return api.post(base, { unit_id: null })
        return api.post(base, { unit_id: toUnit, day: toDay ? Number(toDay) : null, pass_percent: pass || null })
      }
      const id = it.id
      if (a.op === 'publish') return api.post(`/api/v1/lms/lessons/${id}/publish`, { is_published: true, publish_at: null })
      if (a.op === 'draft') return api.post(`/api/v1/lms/lessons/${id}/publish`, { is_published: false, publish_at: it.lesson!.publish_at ?? null })
      if (a.op === 'schedule') return api.post(`/api/v1/lms/lessons/${id}/publish`, { is_published: true, publish_at: new Date(when).toISOString() })
      if (a.op === 'place') return api.post(`/api/v1/lms/lessons/${id}/move`, { unit_id: toUnit, day: toDay ? Number(toDay) : null, section: toSection })
      if (a.op === 'delete') return api.del(`/api/v1/lms/lessons/${id}`)
    },
    onSuccess: () => { close(); refresh() },
  })
  const btn = 'inline-flex min-h-10 items-center gap-1.5 rounded-md border bg-background px-3 text-[14px] hover:bg-muted'
  const modules = d.units.filter((x) => x.is_active !== false).map((x) => ({ value: x.id, label: `${moduleNumber(d, x)} · ${x.title}` }))
  const place = (
    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
      <Field label="Module"><Select value={toUnit} onChange={(v) => { setToUnit(v); setToDay('') }} options={modules} /></Field>
      <Field label="Day"><Select value={toDay} onChange={setToDay} options={dayOptions(d, target)} /></Field>
      {it.type === 'lesson' ? <Field label="Section"><Select value={toSection} onChange={setToSection} options={sectionOptions} /></Field>
        : <Field label="Pass mark, %"><Input type="number" value={pass} onChange={setPass} /></Field>}
      <Button variant="secondary" pending={run.isPending} onClick={() => run.mutate({ op: 'place' })}><FolderInput className="h-4 w-4" /> {it.type === 'lesson' ? 'Move' : 'Save'}</Button>
    </div>
  )
  if (it.type !== 'lesson') {
    return (
      <div className="mx-[var(--card-pad)] mb-2 space-y-3 rounded-lg border bg-muted/20 p-3">
        {place}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn} onClick={() => onTab(it.type === 'assignment' ? 'assignments' : 'quizzes')}>{it.type === 'assignment' ? 'Gradebook' : 'Results'}</button>
          <button type="button" className={btn} onClick={() => run.mutate({ op: 'remove' })}><X className="h-4 w-4" /> Take out of this module</button>
        </div>
        <FormNotice error={run.error} />
      </div>
    )
  }
  const l = it.lesson!
  const live = l.is_published && !(l.publish_at && l.publish_at > nowIso())
  return (
    <div className="mx-[var(--card-pad)] mb-2 space-y-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} onClick={onEdit}><Pencil className="h-4 w-4" /> Edit</button>
        {!live && <button type="button" className={btn} onClick={() => run.mutate({ op: 'publish' })}><Eye className="h-4 w-4" /> Publish now</button>}
        {l.is_published && <button type="button" className={btn} onClick={() => run.mutate({ op: 'draft' })}><EyeOff className="h-4 w-4" /> Back to draft</button>}
        <button type="button" className={btn} aria-expanded={scheduling} onClick={() => setScheduling(!scheduling)}><CalendarClock className="h-4 w-4" /> Schedule</button>
        <button type="button" className={`${btn} text-destructive`} onClick={() => { if (window.confirm(`Delete "${l.title}"? The class's progress on it goes too.`)) run.mutate({ op: 'delete' }) }}><Trash2 className="h-4 w-4" /> Delete</button>
      </div>
      {scheduling && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-full sm:w-64"><Field label="Opens at"><Input type="datetime-local" value={when} onChange={setWhen} /></Field></div>
          <Button disabled={!when} pending={run.isPending} onClick={() => run.mutate({ op: 'schedule' })}>Schedule</Button>
        </div>
      )}
      {place}
      <FormNotice error={run.error} />
    </div>
  )
}

function ModuleProgressView({ d, u }: { d: CourseDetail; u: Unit }) {
  const p = useModuleProgress(u, d.course.section_id)
  const [filter, setFilter] = useState<'all' | 'done' | 'not'>('all')
  if (p.error) return <ErrorState error={p.error} />
  if (!p.data) return <Loading />
  const g = p.data
  const rows = g.items.filter((r) => filter === 'all' || (filter === 'done' ? r.complete : !r.complete))
  return (
    <Card>
      <CardHeader title={`${g.complete} of ${g.roll} have finished this module`} action={
        <div className="inline-flex gap-1 rounded-md border bg-muted p-1">
          {([['all', 'Everyone'], ['done', 'Finished'], ['not', 'Not yet']] as const).map(([v, label]) => (
            <button key={v} type="button" aria-pressed={filter === v} onClick={() => setFilter(v)} className={`min-h-9 rounded px-2.5 text-[13px] ${filter === v ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground'}`}>{label}</button>
          ))}
        </div>
      } />
      {!g.totals.total ? <p className="px-[var(--card-pad)] py-4 text-[14px] text-muted-foreground">Nothing in this module is visible to the class yet.</p> : !rows.length ? <p className="px-[var(--card-pad)] py-4 text-[14px] text-muted-foreground">Nobody here.</p> : (
        <ul className="divide-y">
          {rows.map((r) => {
            const pct = r.total ? Math.round((100 * r.done) / r.total) : 0
            return (
              <li key={r.student_id} className="flex items-center gap-3 px-[var(--card-pad)] py-2.5 text-[14px]">
                <span className="w-7 shrink-0 text-right tabular-nums text-muted-foreground">{r.roll_no ?? ''}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{r.full_name}</span>
                  <span className="block text-[12px] text-muted-foreground">{r.last_seen ? `Last opened ${fmtWhen(r.last_seen)}` : 'Not opened yet'}</span>
                </span>
                <span className="hidden w-40 sm:block" aria-hidden><span className="block h-2 overflow-hidden rounded-full bg-muted"><span className={`block h-full ${r.complete ? 'bg-success' : 'bg-primary'}`} style={{ width: `${pct}%` }} /></span></span>
                <span className="w-12 shrink-0 text-right tabular-nums">{r.done}/{r.total}</span>
                {r.complete ? <Badge tone="success">Finished</Badge> : <Badge>{pct}%</Badge>}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

/* ─── The course's progress grid: every child against every day ────── */

interface Grid {
  gating: string
  steps: { key: string; unit_id: string; day: number | null; label: string; module: string; items: number }[]
  students: { student_id: string; full_name: string; roll_no?: number | null; states: { state: 'done' | 'open' | 'locked'; done: number; total: number }[]; days_done: number; at: string | null; unlocks: string[] }[]
}

export function CourseProgress({ d }: { d: CourseDetail }) {
  const qc = useQueryClient()
  const key = ['lms-course-progress', d.course.section_id, d.course.class_subject_id]
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Grid>(`/api/v1/lms/course/progress?section_id=${d.course.section_id}&class_subject_id=${d.course.class_subject_id}`) })
  const unlock = useMutation({
    mutationFn: (v: { student_id: string; key: string; on: boolean }) => {
      const [unit_id, day] = v.key.split(':')
      const body = { student_id: v.student_id, unit_id, day: Number(day) || null }
      return v.on ? api.post('/api/v1/lms/unlocks', body) : api.del('/api/v1/lms/unlocks', body)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  })
  if (q.error) return <ErrorState error={q.error} />
  if (!q.data) return <Loading />
  const g = q.data
  if (!g.steps.length) return <EmptyState title="No days yet" body="Once a module has days with something on them, every child's progress shows here." />
  const step = new Map(g.steps.map((s, i) => [s.key, { ...s, i }]))
  const mods: { unit_id: string; module: string; n: number }[] = []
  for (const s of g.steps) { const last = mods[mods.length - 1]; if (last && last.unit_id === s.unit_id) last.n++; else mods.push({ unit_id: s.unit_id, module: s.module, n: 1 }) }
  const short = (s: { day: number | null }) => (s.day === null ? '•' : `Day ${s.day}`)
  /* THE COHORT TRACKER, TO THE OWNER'S MOCKUP (2026-10-10, their own HTML).

     WHAT WENT. A matrix: every child down the side, every day across the
     top, a 28px box in each cell. On a three-day course that is nine boxes
     saying "0/1" and a column headed D1, D2, D3 that only means anything
     once you have read the legend. Every row then repeated the same
     sentence in "Where they are", and the same "Open D2" button beside it.
     Wide, repetitive, and hard to read a single child out of.

     WHAT CAME. One line per child, read left to right: who they are and
     how far they have got, then the days as a row of pills joined by a
     line -- finished, the one they are on, the ones still shut -- then the
     single thing a teacher can actually do about it, which is open the
     next day early.

     The line between two pills is green only where the day before it is
     finished, so a glance down the column shows how far the class has
     come without reading a number.

     WHAT IS KEPT FROM OURS. Days opened early stay marked and stay
     revocable: the mockup has no such state, but a teacher who opened a
     day for one child needs to see that they did and be able to take it
     back. They are the amber pills with a cross. */
  const initials = (n: string) => n.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
  const modNames = [...new Set(g.steps.map((x) => x.module))]
  return (
    <Card>
      <CardHeader
        title={modNames.length === 1 ? `Module: ${modNames[0]}` : `${modNames.length} parts`}
        description={`${g.steps.length}-day sequence · ${g.gating === 'open' ? 'open course, nothing is locked' : 'a day opens when the one before is done'}`}
        action={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-success" /> Done</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-warning" /> In progress</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-muted-foreground/40" /> Locked</span>
          </div>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="px-[var(--card-pad)] py-3 text-[12px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Student</th>
              <th className="px-3 py-3 text-[12px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Progress</th>
              <th className="px-[var(--card-pad)] py-3 text-right text-[12px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
                {g.gating === 'open' ? '' : 'Open early'}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {g.students.map((r) => {
              const firstLocked = r.states.findIndex((x) => x.state === 'locked')
              const nextKey = firstLocked >= 0 ? g.steps[firstLocked].key : null
              const early = r.unlocks.filter((k) => step.has(k))
              return (
                <tr key={r.student_id} className="transition-colors hover:bg-muted/30">
                  <td className="px-[var(--card-pad)] py-4">
                    <div className="flex items-center gap-3">
                      <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/10 text-[12px] font-semibold text-primary">
                        {initials(r.full_name)}
                      </span>
                      <span className="min-w-0">
                        <span className="block max-w-[11rem] truncate text-[14px] font-semibold sm:max-w-[16rem]">{r.full_name}</span>
                        <span className="block text-[12px] text-muted-foreground">{r.days_done} of {g.steps.length} finished</span>
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-4">
                    <div className="inline-flex items-center">
                      {r.states.map((x, i) => {
                        const st = g.steps[i]
                        const wasEarly = r.unlocks.includes(st.key)
                        const label = short(st)
                        return (
                          <span key={st.key} className="inline-flex items-center">
                            {i > 0 && (
                              <span aria-hidden className={cn('h-0.5 w-6', r.states[i - 1].state === 'done' ? 'bg-success' : 'bg-border')} />
                            )}
                            <span
                              title={`${st.module} · ${st.label}: ${x.state === 'done' ? 'done' : x.state === 'open' ? `${x.done} of ${x.total} done` : 'locked'}${wasEarly ? ' (opened early)' : ''}`}
                              className={cn('inline-flex min-w-[52px] items-center justify-center whitespace-nowrap rounded-full border px-2 py-1 text-[11px] font-semibold',
                                x.state === 'done' ? 'border-success/40 bg-success/10 text-success'
                                  : x.state === 'open' ? (wasEarly ? 'border-warning/50 bg-warning/10 text-warning' : 'border-warning/50 bg-warning/10 text-warning')
                                    : 'border-border bg-muted text-muted-foreground')}>
                              {label}{x.state === 'done' ? ' ✓' : ''}
                            </span>
                          </span>
                        )
                      })}
                    </div>
                  </td>
                  <td className="px-[var(--card-pad)] py-4 text-right">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {!nextKey && <Badge tone="success">Finished</Badge>}
                      {g.gating !== 'open' && nextKey && (
                        <Button size="sm" variant="secondary"
                          pending={unlock.isPending && unlock.variables?.student_id === r.student_id}
                          onClick={() => unlock.mutate({ student_id: r.student_id, key: nextKey, on: true })}>
                          <Unlock className="h-3.5 w-3.5" /> Unlock {short(step.get(nextKey)!)}
                        </Button>
                      )}
                      {early.map((k) => (
                        <button key={k} type="button"
                          className="inline-flex min-h-8 items-center gap-1 rounded-md bg-warning/10 px-2 text-[12px] text-warning"
                          title="Opened early by a teacher. Press to take it back."
                          onClick={() => unlock.mutate({ student_id: r.student_id, key: k, on: false })}>
                          {short(step.get(k)!)} early <X className="h-3 w-3" />
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <FormNotice error={unlock.error} />
    </Card>
  )
}
