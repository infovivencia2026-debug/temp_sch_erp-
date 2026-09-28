import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive, ArchiveRestore, ArrowDown, ArrowUp, CalendarClock, ChevronLeft, ChevronRight, Eye, EyeOff, FolderInput, GripVertical, MoreHorizontal, Pencil, Plus, Trash2, X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, FormNotice, Input, Loading, Select, Textarea } from '@/components/ui'
import { VideoPick, VideoUpload } from './VideoLibrary'
import {
  FilePick, KIND_LABEL, KindChip, KindIcon, LessonContent, NotesEditor, ProgressRing, TypeCounts, dateRange, fmtWhen, itemKind, moduleItems, sourceMeta,
  type ItemType, type Lesson, type ModuleItem, type Placed, type RubricRow, type SourceKind, type Unit,
} from '../learning/lms-shared'
import { AssignmentForm, QuizForm } from './TeacherLMS'

/* A COURSE, MODULE FIRST (worker routes/teaching/lms.ts, migration 0011).

   The course is its modules, in order: each with a title, a short
   description, a day or date range, what is in it counted by type, and how
   many of the class have finished it. Opening one shows every source in it
   (video, PDF, notes, file, link, image, audio, slides) with its assignments
   and quizzes, in one order the teacher sets by dragging (or the arrows, on
   a phone). A source can be a draft, published, or scheduled for a moment;
   it can move to another module. The Progress view is who has finished the
   module and who has not. */

export interface TAssignment extends Placed {
  kind: string; instructions?: string | null; assigned_on: string; due_on?: string | null; max_marks?: number | null
  rubric: RubricRow[] | null; submitted: number; to_mark: number; graded: number; returned: number
}
export interface TQuiz extends Placed { status: string; duration_minutes?: number | null; closes_at?: string | null; questions: number; attempted: number }
export interface CourseDetail {
  course: { section_id: string; section_name: string; class_name: string; class_subject_id: string; subject: string }
  roll: number; today: string; units: Unit[]; assignments: TAssignment[]; quizzes: TQuiz[]
}
type Tab = 'modules' | 'assignments' | 'quizzes'

const nowIso = () => new Date().toISOString()
/** Draft, scheduled or live, for a source row. */
function StateBadge({ l }: { l: Lesson }) {
  if (!l.is_published) return <Badge tone="warning">Draft</Badge>
  if (l.publish_at && l.publish_at > nowIso()) return <Badge tone="info">Opens {fmtWhen(l.publish_at)}</Badge>
  return <Badge tone="success">Published</Badge>
}
/** Local "YYYY-MM-DDTHH:mm" for a datetime-local box. */
const toLocal = (iso?: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

/** Drag to reorder (mouse and pen); the arrows do the same on a phone. */
function useDragOrder(ids: string[], commit: (ids: string[]) => void) {
  const from = useRef<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const move = (id: string, to: number) => {
    const next = ids.filter((x) => x !== id)
    next.splice(Math.max(0, Math.min(next.length, to)), 0, id)
    if (next.join() !== ids.join()) commit(next)
  }
  /* The grip is what is dragged (so text in a form below can still be selected); the row is where it drops. */
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
    onDragOver: (e: React.DragEvent) => { if (from.current) { e.preventDefault(); setOver(id) } },
    onDragLeave: () => setOver((o) => (o === id ? null : o)),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); const f = from.current; from.current = null; setOver(null); if (f && f !== id) move(f, ids.indexOf(id)) },
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

export function Modules({ d, qkey, onTab }: { d: CourseDetail; qkey: unknown[]; onTab: (t: Tab) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const active = d.units.filter((u) => u.is_active !== false)
  const unit = active.find((u) => u.id === open)
  if (unit) return <ModuleView d={d} u={unit} n={active.indexOf(unit) + 1} qkey={qkey} back={() => setOpen(null)} onTab={onTab} />
  return <ModuleList d={d} qkey={qkey} onOpen={setOpen} />
}

/* ─── The list of modules ──────────────────────────────────────────── */

function ModuleList({ d, qkey, onOpen }: { d: CourseDetail; qkey: unknown[]; onOpen: (id: string) => void }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const active = d.units.filter((u) => u.is_active !== false)
  const archived = d.units.filter((u) => u.is_active === false)
  const [order, setOrder] = useState<string[] | null>(null)
  const ids = order ?? active.map((u) => u.id)
  const reorder = useMutation({
    mutationFn: (next: string[]) => api.post('/api/v1/lms/units/reorder', { section_id: d.course.section_id, class_subject_id: d.course.class_subject_id, ids: [...next, ...archived.map((u) => u.id)] }),
    onSettled: async () => { await qc.invalidateQueries({ queryKey: qkey }); setOrder(null) },
  })
  const drag = useDragOrder(ids, (next) => { setOrder(next); reorder.mutate(next) })
  const restore = useMutation({ mutationFn: (id: string) => api.put(`/api/v1/lms/units/${id}`, { is_active: true }), onSuccess: () => qc.invalidateQueries({ queryKey: qkey }) })
  const byId = new Map(active.map((u) => [u.id, u]))
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[14px] text-muted-foreground">{active.length ? `${active.length} module${active.length === 1 ? '' : 's'}. Drag to reorder, or use the arrows.` : 'No modules yet.'}</p>
        <Button onClick={() => setAdding(!adding)}>{adding ? <><X className="h-4 w-4" /> Close</> : <><Plus className="h-4 w-4" /> New module</>}</Button>
      </div>
      {adding && <Card><ModuleForm d={d} done={() => { setAdding(false); qc.invalidateQueries({ queryKey: qkey }) }} /></Card>}
      {!active.length && !adding && <EmptyState title="No modules yet" body="A module is a topic or a week: add one, then put videos, PDFs, notes, links, quizzes and assignments in it." />}
      <ol className="space-y-3">
        {ids.map((id, i) => {
          const u = byId.get(id)
          if (!u) return null
          return (
            <li key={id} {...drag.props(id)} className="rounded-xl data-[over]:outline data-[over]:outline-2 data-[over]:outline-primary">
              <ModuleCard d={d} u={u} n={i + 1} onOpen={() => onOpen(id)} grip={drag.handle(id)} arrows={<Arrows first={i === 0} last={i === ids.length - 1} up={() => drag.up(id)} down={() => drag.down(id)} label={u.title} />} />
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
                    <span className="text-[13px] text-muted-foreground">{u.lessons.length} source{u.lessons.length === 1 ? "" : "s"}</span>
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

interface ModProgress { totals: { total: number }; complete: number; roll: number; items: { student_id: string; full_name: string; roll_no?: number | null; done: number; total: number; complete: boolean; last_seen?: string | null; sources_done: number; assignments_done: number; quizzes_done: number }[] }
const useModuleProgress = (u: Unit, sectionId: string) =>
  useQuery({ queryKey: ['lms-module-progress', u.id, sectionId], queryFn: () => api.get<ModProgress>(`/api/v1/lms/units/${u.id}/progress?section_id=${sectionId}`) })

function ModuleCard({ d, u, n, onOpen, arrows, grip }: { d: CourseDetail; u: Unit; n: number; onOpen: () => void; arrows: React.ReactNode; grip: object }) {
  const p = useModuleProgress(u, d.course.section_id)
  const items = moduleItems(u, d.assignments, d.quizzes)
  const drafts = u.lessons.filter((l) => !l.is_published || (l.publish_at && l.publish_at > nowIso())).length
  const range = dateRange(u.starts_on, u.ends_on)
  const pct = p.data && p.data.roll ? Math.round((100 * p.data.complete) / p.data.roll) : 0
  return (
    <div className="card flex items-stretch gap-1 overflow-hidden p-0">
      <span {...grip} className="hidden cursor-grab items-center pl-2 text-muted-foreground active:cursor-grabbing sm:flex" aria-hidden title="Drag to reorder"><GripVertical className="h-4 w-4" /></span>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 px-[var(--card-pad)] py-4 text-left sm:pl-2">
        <ProgressRing pct={pct} label={p.data ? `${p.data.complete} of ${p.data.roll} have finished this module` : undefined} />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Module {n}{range ? ` · ${range}` : ''}</span>
          <span className="block text-[16px] font-semibold leading-snug">{u.title}</span>
          {u.description && <span className="block text-[13px] text-muted-foreground line-clamp-2">{u.description}</span>}
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {items.length ? <TypeCounts items={items} /> : <span className="text-[13px] text-muted-foreground">Empty</span>}
            {drafts > 0 && <Badge tone="warning">{drafts} not yet visible</Badge>}
            {p.data && p.data.totals.total > 0 && <span className="text-[13px] text-muted-foreground">{p.data.complete} of {p.data.roll} finished</span>}
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
      <span className="flex flex-col justify-center border-l pr-1">{arrows}</span>
    </div>
  )
}

function ModuleForm({ d, u, done }: { d: CourseDetail; u?: Unit; done: () => void }) {
  const [title, setTitle] = useState(u?.title ?? '')
  const [desc, setDesc] = useState(u?.description ?? '')
  const [from, setFrom] = useState(u?.starts_on ?? '')
  const [to, setTo] = useState(u?.ends_on ?? '')
  const save = useMutation({
    mutationFn: () => {
      const body = { title, description: desc, starts_on: from || null, ends_on: to || null }
      return u ? api.put(`/api/v1/lms/units/${u.id}`, body) : api.post('/api/v1/lms/units', { ...body, section_id: d.course.section_id, class_subject_id: d.course.class_subject_id })
    },
    onSuccess: done,
  })
  return (
    <div className="space-y-3 px-[var(--card-pad)] py-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Module title"><Input value={title} onChange={setTitle} placeholder="For example: Fractions" /></Field>
        <Field label="Short description" hint="Optional. One line on what the module covers."><Input value={desc} onChange={setDesc} /></Field>
        <Field label="Starts on" hint="Optional."><Input type="date" value={from} onChange={setFrom} /></Field>
        <Field label="Ends on" hint="Optional. The same day for a one-day module."><Input type="date" value={to} onChange={setTo} /></Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!title.trim()} pending={save.isPending} onClick={() => save.mutate()}>{u ? 'Save module' : 'Add module'}</Button>
        {u && <Button variant="secondary" onClick={done}>Cancel</Button>}
        <FormNotice error={save.error} />
      </div>
    </div>
  )
}

/* ─── One module ───────────────────────────────────────────────────── */

function ModuleView({ d, u, n, qkey, back, onTab }: { d: CourseDetail; u: Unit; n: number; qkey: unknown[]; back: () => void; onTab: (t: Tab) => void }) {
  const qc = useQueryClient()
  const [view, setView] = useState<'sources' | 'progress'>('sources')
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState<ItemType | 'pick' | 'attach' | null>(null)
  const refresh = () => { qc.invalidateQueries({ queryKey: qkey }); qc.invalidateQueries({ queryKey: ['lms-module-progress', u.id] }) }
  const archive = useMutation({ mutationFn: () => api.del(`/api/v1/lms/units/${u.id}`), onSuccess: () => { refresh(); back() } })
  const range = dateRange(u.starts_on, u.ends_on)
  return (
    <div className="space-y-4">
      <div>
        <Button variant="ghost" onClick={back}><ChevronLeft className="h-4 w-4" /> All modules</Button>
      </div>
      <Card>
        {editing ? <ModuleForm d={d} u={u} done={() => { setEditing(false); refresh() }} /> : (
          <div className="flex flex-wrap items-start gap-3 px-[var(--card-pad)] py-4">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Module {n}{range ? ` · ${range}` : ''}</p>
              <h2 className="text-[20px] font-semibold leading-tight">{u.title}</h2>
              {u.description && <p className="text-[14px] text-muted-foreground">{u.description}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /> Edit</Button>
              <Button variant="secondary" pending={archive.isPending} onClick={() => { if (window.confirm(`Archive "${u.title}"? The class stops seeing it. You can restore it from the list of modules.`)) archive.mutate() }}><Archive className="h-4 w-4" /> Archive</Button>
            </div>
          </div>
        )}
        <FormNotice error={archive.error} />
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex gap-1 rounded-md border bg-muted p-1" role="tablist">
          {(['sources', 'progress'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={view === t} onClick={() => setView(t)}
              className={`min-h-10 rounded px-3.5 text-[14px] font-medium ${view === t ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              {t === 'sources' ? 'Sources' : 'Progress'}
            </button>
          ))}
        </div>
        {view === 'sources' && <Button onClick={() => setAdding(adding ? null : 'pick')}>{adding ? <><X className="h-4 w-4" /> Close</> : <><Plus className="h-4 w-4" /> Add source</>}</Button>}
      </div>
      {view === 'progress' ? <ModuleProgressView d={d} u={u} /> : (
        <>
          {adding === 'pick' && <TypePicker onPick={setAdding} canAttach={d.assignments.some((a) => !a.lms_unit_id) || d.quizzes.some((q) => !q.lms_unit_id)} />}
          {adding && adding !== 'pick' && (
            <Card>
              <CardHeader title={adding === 'attach' ? 'Add an assignment or quiz already set' : ADD_TITLE[adding]} action={<Button size="sm" variant="ghost" onClick={() => setAdding('pick')}><ChevronLeft className="h-4 w-4" /> Other type</Button>} />
              {adding === 'assignment' ? <AssignmentForm d={d} unitId={u.id} done={() => { setAdding(null); refresh() }} />
                : adding === 'quiz' ? <QuizForm d={d} unitId={u.id} done={() => { setAdding(null); refresh() }} />
                  : adding === 'attach' ? <AttachExisting d={d} u={u} done={() => { setAdding(null); refresh() }} />
                    : <SourceForm kind={adding} u={u} sectionId={d.course.section_id} done={() => { setAdding(null); refresh() }} />}
            </Card>
          )}
          <ItemList d={d} u={u} qkey={qkey} refresh={refresh} onTab={onTab} />
        </>
      )}
    </div>
  )
}

const ADD_TITLE: Record<ItemType, string> = {
  video: 'Add a video', pdf: 'Add a PDF', text: 'Add notes', file: 'Add a file to download', link: 'Add a web link', image: 'Add an image', audio: 'Add a recording',
  doc: 'Add slides or a document', quiz: 'Add a quiz', assignment: 'Add an assignment',
}
const PICKS: ItemType[] = ['video', 'pdf', 'text', 'file', 'link', 'image', 'audio', 'doc', 'quiz', 'assignment']
const PICK_HINT: Record<string, string> = {
  video: 'From the library, a new upload, or YouTube', pdf: 'Read in the page', text: 'Written here, with headings and lists', file: 'Any file to download',
  link: 'A web page', image: 'A picture or diagram', audio: 'A recording', doc: 'Slides, Word or Excel', quiz: 'Timed, marked at once', assignment: 'Work to hand in',
}
function TypePicker({ onPick, canAttach }: { onPick: (t: ItemType | 'attach') => void; canAttach: boolean }) {
  return (
    <Card>
      <CardHeader title="What would you like to add?" />
      <div className="grid grid-cols-2 gap-2 p-[var(--card-pad)] sm:grid-cols-3 lg:grid-cols-5">
        {PICKS.map((k) => (
          <button key={k} type="button" onClick={() => onPick(k)} className="flex min-h-[4.5rem] items-start gap-2.5 rounded-lg border bg-background p-3 text-left hover:border-primary hover:bg-primary/[0.03]">
            <KindChip kind={k} />
            <span className="min-w-0"><span className="block text-[14px] font-medium">{KIND_LABEL[k]}</span><span className="block text-[12px] leading-snug text-muted-foreground">{PICK_HINT[k]}</span></span>
          </button>
        ))}
      </div>
      {canAttach && (
        <div className="border-t px-[var(--card-pad)] py-3">
          <button type="button" className="min-h-10 text-[14px] text-primary hover:underline" onClick={() => onPick('attach')}>Or put an assignment or quiz already set in this course into the module</button>
        </div>
      )}
    </Card>
  )
}

function AttachExisting({ d, u, done }: { d: CourseDetail; u: Unit; done: () => void }) {
  const [pick, setPick] = useState('')
  const opts = [
    ...d.assignments.filter((a) => !a.lms_unit_id).map((a) => ({ value: `assignment:${a.id}`, label: `Assignment: ${a.title}` })),
    ...d.quizzes.filter((q) => !q.lms_unit_id).map((q) => ({ value: `quiz:${q.id}`, label: `Quiz: ${q.title}` })),
  ]
  const save = useMutation({
    mutationFn: () => { const [t, id] = pick.split(':'); return api.post(`/api/v1/lms/${t === 'quiz' ? 'quizzes' : 'assignments'}/${id}/module`, { unit_id: u.id }) },
    onSuccess: done,
  })
  return (
    <div className="flex flex-wrap items-end gap-3 px-[var(--card-pad)] py-4">
      <div className="w-full sm:w-96"><Field label="Assignment or quiz"><Select value={pick} onChange={setPick} placeholder="Choose one" options={opts} /></Field></div>
      <Button disabled={!pick} pending={save.isPending} onClick={() => save.mutate()}>Add to module</Button>
      <FormNotice error={save.error} />
    </div>
  )
}

const ACCEPT: Partial<Record<SourceKind, string>> = {
  pdf: 'application/pdf,.pdf', image: 'image/*', audio: 'audio/*,.mp3,.m4a,.wav,.ogg', doc: '.pdf,.ppt,.pptx,.pps,.ppsx,.doc,.docx,.xls,.xlsx,.odp,.odt,.ods,.key,.pages',
}

function SourceForm({ kind: kind0, u, sectionId, lesson, done }: { kind: SourceKind; u: Unit; sectionId: string; lesson?: Lesson; done: () => void }) {
  const [kind] = useState<SourceKind>(lesson?.kind ?? kind0)
  const [title, setTitle] = useState(lesson?.title ?? '')
  const [body, setBody] = useState(lesson?.body ?? '')
  const [url, setUrl] = useState(lesson?.url ?? '')
  const [vsrc, setVsrc] = useState<'library' | 'upload' | 'link'>(lesson ? (lesson.video_id ? 'library' : 'link') : 'library')
  const [video, setVideo] = useState(lesson?.video_id ?? '')
  const [file, setFile] = useState<{ id: string; name: string } | null>(lesson?.file_id ? { id: lesson.file_id, name: lesson.file_name ?? 'file' } : null)
  const [mins, setMins] = useState(lesson?.duration_minutes ? String(lesson.duration_minutes) : '')
  const [publish, setPublish] = useState<'now' | 'draft' | 'schedule'>(lesson ? (!lesson.is_published ? 'draft' : lesson.publish_at && lesson.publish_at > nowIso() ? 'schedule' : 'now') : 'now')
  const [when, setWhen] = useState(toLocal(lesson?.publish_at))
  const [onlyHere, setOnlyHere] = useState(false)
  const fileKind = kind === 'pdf' || kind === 'file' || kind === 'image' || kind === 'audio' || kind === 'doc'
  const lib = kind === 'video' && vsrc !== 'link'
  const save = useMutation({
    mutationFn: () => {
      const b = {
        unit_id: u.id, title, kind, body, url: lib ? '' : fileKind && file ? '' : url, video_id: lib ? video : undefined, file_id: fileKind ? file?.id ?? null : null,
        duration_minutes: mins ? Number(mins) : null, is_published: publish !== 'draft',
        publish_at: publish === 'schedule' && when ? new Date(when).toISOString() : null, day: lesson?.day ?? null,
      }
      return lesson ? api.put(`/api/v1/lms/lessons/${lesson.id}`, b) : api.post('/api/v1/lms/lessons', { ...b, section_id: onlyHere ? sectionId : undefined })
    },
    onSuccess: done,
  })
  const ready = title.trim() && (kind === 'text' ? body.trim() : kind === 'link' ? url.trim() : kind === 'video' ? (lib ? video : url.trim()) : file || url.trim())
  return (
    <div className="space-y-4 px-[var(--card-pad)] py-4">
      <Field label="Title"><Input value={title} onChange={setTitle} placeholder={kind === 'video' ? 'For example: Adding fractions, explained' : undefined} /></Field>
      {kind === 'video' && (
        <div className="space-y-3">
          <div className="inline-flex max-w-full flex-wrap gap-1 rounded-md border bg-muted p-1" role="radiogroup" aria-label="Where the video comes from">
            {([['library', 'From the library'], ['upload', 'Upload new'], ['link', 'YouTube or link']] as const).map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={vsrc === v} onClick={() => setVsrc(v)}
                className={`min-h-10 rounded px-3 text-[14px] ${vsrc === v ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground'}`}>{label}</button>
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
      {kind !== 'text' && <Field label="A note for the class" hint="Optional. Shown under the source."><Textarea rows={2} value={body} onChange={setBody} /></Field>}
      <div className="grid gap-3 sm:grid-cols-2">
        {(kind === 'text' || kind === 'audio' || (kind === 'video' && vsrc === 'link') || kind === 'link') && (
          <Field label={kind === 'text' ? 'Reading time, minutes' : 'Length, minutes'} hint="Optional. Shown to the class."><Input type="number" value={mins} onChange={setMins} /></Field>
        )}
        <Field label="Who sees it, and when">
          <Select value={publish} onChange={(v) => setPublish(v as typeof publish)} options={[
            { value: 'now', label: 'Published now' }, { value: 'schedule', label: 'Scheduled for later' }, { value: 'draft', label: 'Draft (only you)' },
          ]} />
        </Field>
        {publish === 'schedule' && <Field label="Opens at" hint="The class sees it from this moment."><Input type="datetime-local" value={when} onChange={setWhen} /></Field>}
      </div>
      {!lesson && <label className="flex min-h-10 items-center gap-2 text-[14px]"><input type="checkbox" className="h-4 w-4" checked={onlyHere} onChange={(e) => setOnlyHere(e.target.checked)} /> Only this section (otherwise every section of the class)</label>}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!ready || (publish === 'schedule' && !when)} pending={save.isPending} onClick={() => save.mutate()}>{lesson ? 'Save' : publish === 'draft' ? 'Save as draft' : publish === 'schedule' ? 'Schedule' : 'Publish'}</Button>
        {lesson && <Button variant="secondary" onClick={done}>Cancel</Button>}
        <FormNotice error={save.error} />
      </div>
    </div>
  )
}

function ItemList({ d, u, qkey, refresh, onTab }: { d: CourseDetail; u: Unit; qkey: unknown[]; refresh: () => void; onTab: (t: Tab) => void }) {
  const qc = useQueryClient()
  const items = moduleItems(u, d.assignments, d.quizzes)
  const [order, setOrder] = useState<string[] | null>(null)
  const key = (i: ModuleItem) => `${i.type}:${i.id}`
  const ids = order ?? items.map(key)
  const byKey = new Map(items.map((i) => [key(i), i]))
  const reorder = useMutation({
    mutationFn: (next: string[]) => api.post(`/api/v1/lms/units/${u.id}/order`, { items: next.map((k) => { const [type, id] = k.split(':'); return { type, id } }) }),
    onSettled: async () => { await qc.invalidateQueries({ queryKey: qkey }); setOrder(null) },
  })
  const drag = useDragOrder(ids, (next) => { setOrder(next); reorder.mutate(next) })
  if (!items.length) return <EmptyState title="Nothing in this module yet" body="Press Add source to put in a video, a PDF, notes, a link, a quiz or an assignment." />
  return (
    <Card>
      <ol className="divide-y">
        {ids.map((k, i) => {
          const it = byKey.get(k)
          if (!it) return null
          return (
            <li key={k} {...drag.props(k)} className="data-[over]:bg-primary/[0.06]">
              <ItemRow d={d} u={u} it={it} refresh={refresh} onTab={onTab} grip={drag.handle(k)}
                arrows={<Arrows first={i === 0} last={i === ids.length - 1} up={() => drag.up(k)} down={() => drag.down(k)} label={it.type === 'lesson' ? it.lesson.title : it.title} />} />
            </li>
          )
        })}
      </ol>
      <FormNotice error={reorder.error} />
    </Card>
  )
}

function ItemRow({ d, u, it, arrows, grip, refresh, onTab }: { d: CourseDetail; u: Unit; it: ModuleItem; arrows: React.ReactNode; grip: object; refresh: () => void; onTab: (t: Tab) => void }) {
  const [open, setOpen] = useState<'preview' | 'menu' | 'edit' | null>(null)
  const kind = itemKind(it)
  const title = it.type === 'lesson' ? it.lesson.title : it.title
  let meta: React.ReactNode = null, right: React.ReactNode = null
  if (it.type === 'lesson') {
    const l = it.lesson
    meta = <>{KIND_LABEL[l.kind]}{sourceMeta(l) ? ` · ${sourceMeta(l)}` : ''}</>
    right = <><StateBadge l={l} /><span className="hidden text-[13px] text-muted-foreground sm:inline">{l.completed ?? 0}/{d.roll} done</span></>
  } else if (it.type === 'assignment') {
    const a = d.assignments.find((x) => x.id === it.id)!
    meta = <>Assignment{a.due_on ? ` · due ${a.due_on}` : ''}</>
    right = <><span className="hidden text-[13px] text-muted-foreground sm:inline">{a.submitted}/{d.roll} handed in</span>{a.to_mark > 0 && <Badge tone="warning">{a.to_mark} to mark</Badge>}</>
  } else {
    const q = d.quizzes.find((x) => x.id === it.id)!
    meta = <>Quiz · {q.questions} question{q.questions === 1 ? '' : 's'}{q.duration_minutes ? ` · ${q.duration_minutes} min` : ''}</>
    right = <><Badge tone={q.status === 'published' ? 'success' : 'neutral'}>{q.status === 'published' ? 'Open' : q.status === 'closed' ? 'Closed' : 'Draft'}</Badge><span className="hidden text-[13px] text-muted-foreground sm:inline">{q.attempted}/{d.roll} taken</span></>
  }
  return (
    <div>
      <div className="flex items-center gap-1 py-2 pl-1 pr-1 sm:pl-2">
        <span {...grip} className="hidden cursor-grab py-3 text-muted-foreground active:cursor-grabbing sm:inline" aria-hidden title="Drag to reorder"><GripVertical className="h-4 w-4" /></span>
        <button type="button" className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-md px-2 text-left hover:bg-muted/50" onClick={() => setOpen(open === 'preview' ? null : 'preview')} aria-expanded={open === 'preview'}>
          <KindChip kind={kind} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium">{title}</span>
            <span className="block truncate text-[13px] text-muted-foreground">{meta}</span>
          </span>
          <span className="flex shrink-0 flex-wrap items-center justify-end gap-2">{right}</span>
        </button>
        <button type="button" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted" aria-label={`Actions for ${title}`} aria-expanded={open === 'menu'} onClick={() => setOpen(open === 'menu' ? null : 'menu')}>
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {arrows}
      </div>
      {open === 'menu' && <ItemActions d={d} u={u} it={it} refresh={refresh} onTab={onTab} onEdit={() => setOpen('edit')} close={() => setOpen(null)} />}
      {open === 'edit' && it.type === 'lesson' && <div className="border-t bg-muted/20"><SourceForm kind={it.lesson.kind} u={u} sectionId={d.course.section_id} lesson={it.lesson} done={() => { setOpen(null); refresh() }} /></div>}
      {open === 'preview' && (
        <div className="border-t bg-muted/10 px-[var(--card-pad)] py-4">
          {it.type === 'lesson' ? <LessonContent l={it.lesson} /> : (
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

function ItemActions({ d, u, it, refresh, onTab, onEdit, close }: { d: CourseDetail; u: Unit; it: ModuleItem; refresh: () => void; onTab: (t: Tab) => void; onEdit: () => void; close: () => void }) {
  const [when, setWhen] = useState(it.type === 'lesson' ? toLocal(it.lesson.publish_at) : '')
  const [scheduling, setScheduling] = useState(false)
  const [moveTo, setMoveTo] = useState('')
  const others = d.units.filter((x) => x.is_active !== false && x.id !== u.id)
  const run = useMutation({
    mutationFn: async (a: { op: string }) => {
      if (it.type !== 'lesson') return api.post(`/api/v1/lms/${it.type === 'quiz' ? 'quizzes' : 'assignments'}/${it.id}/module`, { unit_id: null })
      const id = it.id
      if (a.op === 'publish') return api.post(`/api/v1/lms/lessons/${id}/publish`, { is_published: true, publish_at: null })
      if (a.op === 'draft') return api.post(`/api/v1/lms/lessons/${id}/publish`, { is_published: false, publish_at: it.lesson.publish_at ?? null })
      if (a.op === 'schedule') return api.post(`/api/v1/lms/lessons/${id}/publish`, { is_published: true, publish_at: new Date(when).toISOString() })
      if (a.op === 'move') return api.post(`/api/v1/lms/lessons/${id}/move`, { unit_id: moveTo })
      if (a.op === 'delete') return api.del(`/api/v1/lms/lessons/${id}`)
    },
    onSuccess: () => { close(); refresh() },
  })
  const btn = 'inline-flex min-h-10 items-center gap-1.5 rounded-md border bg-background px-3 text-[14px] hover:bg-muted'
  if (it.type !== 'lesson') {
    return (
      <div className="flex flex-wrap gap-2 border-t bg-muted/20 px-[var(--card-pad)] py-3">
        <button type="button" className={btn} onClick={() => onTab(it.type === 'assignment' ? 'assignments' : 'quizzes')}>{it.type === 'assignment' ? 'Gradebook' : 'Results'}</button>
        <button type="button" className={btn} onClick={() => run.mutate({ op: 'remove' })}><X className="h-4 w-4" /> Take out of this module</button>
        <FormNotice error={run.error} />
      </div>
    )
  }
  const l = it.lesson
  const live = l.is_published && !(l.publish_at && l.publish_at > nowIso())
  return (
    <div className="space-y-3 border-t bg-muted/20 px-[var(--card-pad)] py-3">
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
      {others.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-full sm:w-72"><Field label="Move to another module"><Select value={moveTo} onChange={setMoveTo} placeholder="Choose a module" options={others.map((x) => ({ value: x.id, label: x.title }))} /></Field></div>
          <Button variant="secondary" disabled={!moveTo} pending={run.isPending} onClick={() => run.mutate({ op: 'move' })}><FolderInput className="h-4 w-4" /> Move</Button>
        </div>
      )}
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
                <span className="w-16 shrink-0 text-right tabular-nums">{r.done}/{r.total}</span>
                {r.complete ? <Badge tone="success">Finished</Badge> : <Badge>{pct}%</Badge>}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
