import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive, ArchiveRestore, ArrowDown, ArrowUp, CalendarClock, Check, ChevronLeft, ChevronRight, Eye, EyeOff, FolderInput, GripVertical, Lock, MoreHorizontal, Pencil, Plus, Trash2, Unlock, X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useOptimisticMutation } from '@/lib/optimistic'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, FormNotice, Input, Loading, Select, Textarea } from '@/components/ui'
import { VideoPick, VideoUpload } from './VideoLibrary'
import {
  FilePick, KIND_LABEL, KindChip, KindIcon, LessonContent, NotesEditor, ProgressRing, SECTIONS, SECTION_LABEL, TypeCounts, dateRange, dayTitle, fmtWhen, moduleItems, sourceMeta,
  type ItemType, type Lesson, type Placed, type RubricRow, type Section, type SourceKind, type Unit,
} from '../learning/lms-shared'
import { AssignmentForm, QuizForm } from './TeacherLMS'

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

function Arrows({ first, last, up, down, label }: { first: boolean; last: boolean; up: () => void; down: () => void; label: string }) {
  return (
    <span className="inline-flex shrink-0">
      <button type="button" className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-30" disabled={first} onClick={up} aria-label={`Move ${label} up`} title="Move up"><ArrowUp className="h-4 w-4" /></button>
      <button type="button" className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-30" disabled={last} onClick={down} aria-label={`Move ${label} down`} title="Move down"><ArrowDown className="h-4 w-4" /></button>
    </span>
  )
}
const seg = (on: boolean) => `min-h-10 rounded px-3.5 text-[14px] font-medium ${on ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`

export function Modules({ d, qkey, onTab }: { d: CourseDetail; qkey: unknown[]; onTab: (t: Tab) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const active = d.units.filter((u) => u.is_active !== false)
  const unit = active.find((u) => u.id === open)
  if (unit) return <ModuleView d={d} u={unit} qkey={qkey} back={() => setOpen(unit.parent_unit_id && active.some((x) => x.id === unit.parent_unit_id) ? unit.parent_unit_id : null)} onOpen={setOpen} onTab={onTab} />
  return <ModuleList d={d} qkey={qkey} onOpen={setOpen} />
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

function GatingSwitch({ d, qkey }: { d: CourseDetail; qkey: unknown[] }) {
  /* Flips on press (lib/optimistic): the switch is the change, so it is
     drawn first and put back with Retry if the server refuses. */
  const set = useOptimisticMutation<CourseDetail['gating']>({
    mutationFn: (gating) => api.put('/api/v1/lms/course/settings', { section_id: d.course.section_id, class_subject_id: d.course.class_subject_id, gating }),
    queryKeys: [qkey],
    invalidate: [qkey, ['lms-course-progress']],
    apply: (old, gating) => ({ ...(old as CourseDetail), gating }),
    failure: "Couldn't change how the class moves through the course",
  })
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 px-[var(--card-pad)] py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium">How the class moves through the course</p>
          <p className="text-[13px] text-muted-foreground">{d.gating === 'open' ? 'Open: every published day can be opened in any order.' : 'One by one: a day opens when the one before it is finished.'}</p>
        </div>
        <div className="inline-flex gap-1 rounded-md border bg-muted p-1" role="radiogroup" aria-label="Progression">
          {([['sequential', 'One by one'], ['open', 'Open']] as const).map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={d.gating === v} onClick={() => d.gating !== v && set.mutate(v)} className={seg(d.gating === v)}>
              {v === 'sequential' ? <Lock className="mr-1.5 inline h-3.5 w-3.5" /> : <Unlock className="mr-1.5 inline h-3.5 w-3.5" />}{label}
            </button>
          ))}
        </div>
      </div>
    </Card>
  )
}

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
      <GatingSwitch d={d} qkey={qkey} />
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

function ModuleView({ d, u, qkey, back, onOpen, onTab }: { d: CourseDetail; u: Unit; qkey: unknown[]; back: () => void; onOpen: (id: string) => void; onTab: (t: Tab) => void }) {
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
  const days = (() => { const x = daysOf(d, u, items); return x.some((y) => y.day === null) ? x : [...x, { day: null, label: '' }] })()
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
      <div><Button variant="ghost" onClick={back}><ChevronLeft className="h-4 w-4" /> {parent ? parent.title : 'All modules'}</Button></div>
      <Card>
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
      </Card>
      {subs.length > 0 && (
        <div className="space-y-2">
          <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Sub-modules, taken after this module's own content</p>
          {subs.map((sx, i) => <ModuleCard key={sx.id} d={d} u={sx} onOpen={() => onOpen(sx.id)}
            arrows={subs.length > 1 ? <Arrows first={i === 0} last={i === subs.length - 1} up={() => orderSubs.mutate([sx.id, subs[i - 1].id])} down={() => orderSubs.mutate([sx.id, subs[i + 1].id])} label={sx.title} /> : undefined} />)}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex gap-1 rounded-md border bg-muted p-1" role="tablist">
          {(['days', 'progress'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={view === t} onClick={() => setView(t)} className={seg(view === t)}>{t === 'days' ? 'Days' : 'Who has finished'}</button>
          ))}
        </div>
        {view === 'days' && <Button pending={addDay.isPending} onClick={() => addDay.mutate()}><Plus className="h-4 w-4" /> Add day</Button>}
      </div>
      <FormNotice error={addDay.error ?? orderDays.error} />
      {view === 'progress' ? <ModuleProgressView d={d} u={u} /> : !days.length ? (
        <EmptyState title="No days yet" body="Press Add day. Each day has four parts: pre-requisites, resources, tools and an assessment." />
      ) : (
        <div className="space-y-4">
          {days.map((x) => (
            <DayCard key={String(x.day)} d={d} u={u} qkey={qkey} day={x.day} label={x.label} items={items.filter((i) => i.day === x.day)} refresh={refresh} onTab={onTab}
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
            <h3 className="min-w-0 flex-1 text-[16px] font-semibold">{dayTitle(day, label)}</h3>
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
  const [publish, setPublish] = useState<'now' | 'draft' | 'schedule'>(lesson ? (!lesson.is_published ? 'draft' : lesson.publish_at && lesson.publish_at > nowIso() ? 'schedule' : 'now') : 'now')
  const [when, setWhen] = useState(toLocal(lesson?.publish_at))
  const [onlyHere, setOnlyHere] = useState(false)
  const fileKind = kind === 'pdf' || kind === 'file' || kind === 'image' || kind === 'audio' || kind === 'doc'
  const lib = kind === 'video' && vsrc !== 'link'
  const save = useMutation({
    mutationFn: () => {
      const b = {
        unit_id: u.id, title, kind, body, url: lib ? '' : fileKind && file ? '' : url, video_id: lib ? video : undefined, file_id: fileKind ? file?.id ?? null : null,
        duration_minutes: mins ? Number(mins) : null, is_published: publish !== 'draft', publish_at: publish === 'schedule' && when ? new Date(when).toISOString() : null,
        day: day ? Number(day) : null, section, is_optional: optional,
      }
      return lesson ? api.put(`/api/v1/lms/lessons/${lesson.id}`, b) : api.post('/api/v1/lms/lessons', { ...b, section_id: onlyHere ? d.course.section_id : undefined })
    },
    onSuccess: done,
  })
  const ready = title.trim() && (kind === 'text' ? body.trim() : kind === 'link' ? url.trim() : kind === 'video' ? (lib ? video : url.trim()) : file || url.trim())
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

function ItemRow({ d, u, it, arrows, refresh, onTab }: { d: CourseDetail; u: Unit; it: TItem; arrows: React.ReactNode; refresh: () => void; onTab: (t: Tab) => void }) {
  const [open, setOpen] = useState<'preview' | 'menu' | 'edit' | null>(null)
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
        <button type="button" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted" aria-label={`Actions for ${it.title}`} aria-expanded={open === 'menu'} onClick={() => setOpen(open === 'menu' ? null : 'menu')}>
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {arrows}
      </div>
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
  const short = (s: { day: number | null }) => (s.day === null ? '•' : `D${s.day}`)
  return (
    <Card>
      <CardHeader title={`Where everyone is · ${g.steps.length} day${g.steps.length === 1 ? '' : 's'}`} action={<span className="text-[13px] text-muted-foreground">{g.gating === 'open' ? 'Open course: nothing is locked.' : 'One by one: a day opens when the one before is done.'}</span>} />
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-b px-[var(--card-pad)] py-2 text-[12px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="inline-flex h-4 w-4 items-center justify-center rounded bg-success text-white"><Check className="h-3 w-3" /></span> Done</span>
        <span className="inline-flex items-center gap-1"><span className="h-4 w-4 rounded border-2 border-primary bg-primary/10" /> Open: done of required</span>
        <span className="inline-flex items-center gap-1"><span className="h-4 w-4 rounded border-2 border-warning bg-warning/10" /> Opened early</span>
        <span className="inline-flex items-center gap-1"><span className="inline-flex h-4 w-4 items-center justify-center rounded bg-muted"><Lock className="h-2.5 w-2.5" /></span> Locked</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b">
              <th rowSpan={2} className="sticky left-0 z-10 bg-card px-[var(--card-pad)] py-2 text-left font-medium">Student</th>
              {mods.map((m, i) => <th key={m.unit_id + i} colSpan={m.n} className="border-l px-1 py-1.5 text-left text-[12px] font-medium text-muted-foreground"><span className="block max-w-[10rem] truncate">{m.module}</span></th>)}
              <th rowSpan={2} className="border-l px-3 py-2 text-left font-medium">Where they are</th>
            </tr>
            <tr className="border-b">
              {g.steps.map((s) => <th key={s.key} title={`${s.module} · ${s.label}`} className="px-1 py-1 text-center text-[11px] font-medium text-muted-foreground">{short(s)}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y">
            {g.students.map((r) => {
              const at = r.at ? step.get(r.at) : null
              const firstLocked = r.states.findIndex((x) => x.state === 'locked')
              const nextKey = firstLocked >= 0 ? g.steps[firstLocked].key : null
              return (
                <tr key={r.student_id}>
                  <td className="sticky left-0 z-10 bg-card px-[var(--card-pad)] py-2">
                    <span className="block max-w-[9rem] truncate font-medium sm:max-w-[14rem]">{r.full_name}</span>
                    <span className="block text-[12px] text-muted-foreground">{r.days_done} of {g.steps.length} done</span>
                  </td>
                  {r.states.map((x, i) => {
                    const s = g.steps[i]
                    const early = r.unlocks.includes(s.key)
                    return (
                      <td key={s.key} className="px-1 py-2 text-center" title={`${s.module} · ${s.label}: ${x.state === 'done' ? 'done' : x.state === 'open' ? `${x.done} of ${x.total} done` : 'locked'}${early ? ' (opened early)' : ''}`}>
                        {x.state === 'done' ? <span className="inline-flex h-7 w-7 items-center justify-center rounded bg-success text-white"><Check className="h-3.5 w-3.5" /></span>
                          : x.state === 'open' ? <span className={`inline-flex h-7 w-7 items-center justify-center rounded border-2 text-[10px] font-semibold tabular-nums ${early ? 'border-warning bg-warning/10' : 'border-primary bg-primary/10'}`}>{x.total ? `${x.done}/${x.total}` : ''}</span>
                            : <span className="inline-flex h-7 w-7 items-center justify-center rounded bg-muted text-muted-foreground"><Lock className="h-3 w-3" /></span>}
                      </td>
                    )
                  })}
                  <td className="border-l px-3 py-2">
                    <div className="flex min-w-[14rem] flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1">{!at ? <Badge tone="success">Finished</Badge> : <><span className="block text-[12px] text-muted-foreground">{at.module}</span><span className="block">{at.label}</span></>}</span>
                      {g.gating !== 'open' && nextKey && (
                        <Button size="sm" variant="secondary" pending={unlock.isPending && unlock.variables?.student_id === r.student_id} onClick={() => unlock.mutate({ student_id: r.student_id, key: nextKey, on: true })}>
                          <Unlock className="h-3.5 w-3.5" /> Open {short(step.get(nextKey)!)}
                        </Button>
                      )}
                      {r.unlocks.filter((k) => step.has(k)).map((k) => (
                        <button key={k} type="button" className="inline-flex min-h-8 items-center gap-1 rounded-md bg-warning/10 px-2 text-[12px] text-warning" title="Opened early by a teacher. Press to take it back."
                          onClick={() => unlock.mutate({ student_id: r.student_id, key: k, on: false })}>
                          {short(step.get(k)!)} opened early <X className="h-3 w-3" />
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
