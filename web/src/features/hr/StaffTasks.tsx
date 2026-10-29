import { useEffect, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Columns3, MessageSquare, Pencil, Plus, Rows3, SlidersHorizontal } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Input, Textarea, Button, Select, Field, FormGrid,
  Loading, ErrorState, EmptyState, FormNotice, Badge, Dialog, SEG_BAR, segClass, TAB_BAR, tabClass,
} from '@/components/ui'
import { PickerMenu } from '@/components/PickerMenu'
import { SearchBox } from '@/components/rows'
import { useToast } from '@/components/Toast'
import { useCan } from '@/lib/session'
import { useOptimisticMutation } from '@/lib/optimistic'
import { usePhone } from '@/lib/viewport'
import { buzz } from '@/lib/haptics'
import { formatDate, cn } from '@/lib/utils'

/* Office work handed to a member of staff, as a pipeline: To do, In
   progress, Review, Done. Work somebody gave comes back to them to accept or
   send back; every step, change and comment is kept on the task.

   Two doors, one screen. HR's door (hr.tasks.staff_tasks) shows every task,
   the per-person report and who reports to whom. A teacher's door
   (faculty.my_profile.my_tasks) shows only their own (owner, 2026-10-28: "only
   their own tasks is enough; let them add"), with no "Who" anywhere. The route
   says which; the server narrows regardless of what the screen asks. */

export default function StaffTasks() {
  const selfService = useLocation().pathname.includes('/my_profile/')
  const hr = useCan()('hr.employees.read') && !selfService
  const [tab, setTab] = useState<'tasks' | 'report' | 'managers'>('tasks')
  return (
    <>
      <PageHead eyebrow={selfService ? 'My work' : 'People'} title={selfService ? 'My tasks' : 'Staff tasks'} />
      <PageBody>
        {hr && (
          <div className={cn(TAB_BAR, 'mb-4')}>
            {([['tasks', 'Tasks'], ['report', 'Report'], ['managers', 'Reporting managers']] as const).map(([k, label]) => (
              <button key={k} type="button" className={tabClass(tab === k)} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>
        )}
        {(!hr || tab === 'tasks') && <Tasks hr={hr} />}
        {hr && tab === 'report' && <Report />}
        {hr && tab === 'managers' && <ReportingManagers />}
      </PageBody>
    </>
  )
}

interface Task {
  id: string; title: string; detail?: string; due_on?: string; priority: 'low' | 'normal' | 'high'; status: Stage | 'cancelled'
  done_note?: string; done_at?: string; created_at: string
  employee_id: string; assigned_to: string; employee_code: string; assigned_by?: string; overdue: boolean
  /** The signed-in person is the one doing it. */
  mine: boolean
  /** The signed-in person steers it: gave it, manages the person, or is HR. */
  manage: boolean
  /** Handed over by somebody else, so finishing it sends it back for review. */
  reviewed: boolean
  comments: number
}
interface Update { id: string; kind: string; note?: string; created_at: string; by_name?: string }
interface TaskDetail extends Task { updates: Update[] }
interface Staff { id: string; full_name: string; employee_code: string }
interface Summary { open: number; in_progress: number; review: number; overdue: number; done: number }

type Stage = 'open' | 'in_progress' | 'review' | 'done'
type Action = 'start' | 'finish' | 'accept' | 'return' | 'reopen' | 'cancel'

const STAGES: { key: Stage; label: string; hint: string }[] = [
  { key: 'open', label: 'To do', hint: 'Not started yet.' },
  { key: 'in_progress', label: 'In progress', hint: 'Being worked on.' },
  { key: 'review', label: 'Review', hint: 'Finished, waiting for whoever gave it to check.' },
  { key: 'done', label: 'Done', hint: 'Accepted.' },
]
const STATUS_LABEL: Record<string, string> = { open: 'To do', in_progress: 'In progress', review: 'Review', done: 'Done', cancelled: 'Cancelled' }
const PRIORITY: Record<string, string> = { low: 'Low', normal: 'Normal', high: 'High' }
const UPDATE_LABEL: Record<string, string> = {
  created: 'Gave the task', edited: 'Changed the details', reassigned: 'Handed it to someone else', started: 'Started it',
  submitted: 'Handed it in for review', accepted: 'Marked it done', returned: 'Sent it back', reopened: 'Reopened it',
  cancelled: 'Cancelled it', comment: 'Commented',
}

/* What a card dropped in a column means, for the person moving it; null when
   that move is not theirs to make. Into Review is "finish" for the person
   doing it; into Done is "finish" for one's own task and "accept" for the one
   who gave it. Back to In progress from Review is a send-back (needs a note). */
function moveFor(t: Task, to: Stage): Action | null {
  if (t.status === to) return null
  if (to === 'in_progress') return t.status === 'open' && (t.mine || t.manage) ? 'start' : t.status === 'review' && t.manage ? 'return' : t.status === 'done' && t.manage ? 'reopen' : null
  if (to === 'review') return (t.status === 'open' || t.status === 'in_progress') && t.mine && t.reviewed && !t.manage ? 'finish' : null
  if (to === 'done') {
    if (t.status === 'review' && t.manage) return 'accept'
    if ((t.status === 'open' || t.status === 'in_progress') && (t.mine || t.manage) && (!t.reviewed || t.manage)) return 'finish'
  }
  return null
}

/* The buttons a task offers its reader, in the order they read. */
function actionsFor(t: Task): { action: Action; label: string; primary?: boolean; danger?: boolean; needsNote?: boolean }[] {
  const out: { action: Action; label: string; primary?: boolean; danger?: boolean; needsNote?: boolean }[] = []
  if (t.status === 'open' && (t.mine || t.manage)) out.push({ action: 'start', label: 'Start' })
  if ((t.status === 'open' || t.status === 'in_progress') && t.mine) out.push({ action: 'finish', label: t.reviewed && !t.manage ? 'Hand in for review' : 'Mark done', primary: true })
  if ((t.status === 'open' || t.status === 'in_progress') && !t.mine && t.manage) out.push({ action: 'finish', label: 'Mark done' })
  if (t.status === 'review' && t.manage) {
    out.push({ action: 'accept', label: 'Accept', primary: true })
    out.push({ action: 'return', label: 'Send back', needsNote: true })
  }
  if (t.status === 'done' && t.manage) out.push({ action: 'reopen', label: 'Reopen' })
  if (t.status !== 'done' && t.status !== 'cancelled' && t.manage) out.push({ action: 'cancel', label: 'Cancel task', danger: true })
  return out
}

const today = () => new Date().toLocaleDateString('en-CA')
function DueChip({ t }: { t: Task }) {
  if (!t.due_on) return null
  const label = t.due_on === today() ? 'Due today' : t.overdue ? `Overdue · ${formatDate(t.due_on)}` : `Due ${formatDate(t.due_on)}`
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-px text-[11.5px]',
      t.overdue ? 'bg-[hsl(var(--sys-red)/0.12)] text-[hsl(var(--sys-red-ink))]' : t.due_on === today() ? 'bg-[hsl(var(--sys-orange)/0.12)] text-[hsl(var(--sys-orange-ink))]' : 'bg-muted text-muted-foreground')}>
      <CalendarClock className="h-3 w-3" aria-hidden />{label}
    </span>
  )
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')

function TaskCard({ t, onOpen, draggable, own }: { t: Task; onOpen: () => void; draggable: boolean; own?: boolean }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      draggable={draggable}
      onDragStart={(e) => { e.dataTransfer.setData('text/task', t.id); e.dataTransfer.effectAllowed = 'move' }}
      className={cn('task-card block w-full rounded-[var(--radius-control)] bg-card p-3 text-left shadow-[var(--elev-1)] transition-shadow hover:shadow-[var(--elev-2)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', t.priority === 'high' && 'border-s-[3px] border-[hsl(var(--sys-red))]')}
    >
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[13.5px] font-medium leading-snug">{t.title}</span>
        {t.priority === 'high' && <Badge tone="danger">High</Badge>}
      </span>
      {t.detail && <span className="mt-1 line-clamp-2 block text-[12px] text-muted-foreground">{t.detail}</span>}
      <span className="mt-2 flex flex-wrap items-center gap-2">
        <DueChip t={t} />
        {t.comments > 0 && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground"><MessageSquare className="h-3 w-3" aria-hidden />{t.comments}</span>
        )}
      </span>
      {own ? (t.reviewed && t.assigned_by && <span className="mt-2 block truncate text-[12px] text-muted-foreground">from {t.assigned_by}</span>) : (
      <span className="mt-2 flex items-center gap-2 text-[12px] text-muted-foreground">
        <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-muted text-[10.5px] font-semibold text-foreground">{initials(t.assigned_to)}</span>
        <span className="min-w-0 truncate">{t.mine ? 'You' : t.assigned_to}{t.assigned_by ? ` · from ${t.assigned_by}` : ''}</span>
      </span>
      )}
    </button>
  )
}

function Board({ items, onOpen, onMove, own }: { items: Task[]; onOpen: (id: string) => void; onMove: (t: Task, to: Stage) => void; own?: boolean }) {
  const phone = usePhone()
  const [shown, setShown] = useState<Stage>('open')
  const [over, setOver] = useState<Stage | null>(null)
  const byStage = (k: Stage) => items.filter((t) => t.status === k)
  const column = (s: (typeof STAGES)[number]) => {
    const list = byStage(s.key)
    return (
      <section
        key={s.key}
        aria-label={s.label}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('text/task')) { e.preventDefault(); setOver(s.key) } }}
        onDragLeave={() => setOver(null)}
        onDrop={(e) => {
          e.preventDefault(); setOver(null)
          const t = items.find((x) => x.id === e.dataTransfer.getData('text/task'))
          if (t) onMove(t, s.key)
        }}
        className={cn('flex min-w-0 flex-col gap-2 rounded-[var(--radius-card)] bg-muted/60 p-2 transition-colors', over === s.key && 'bg-accent ring-2 ring-ring')}
      >
        <header className="flex items-baseline justify-between px-1 pt-1">
          <h3 className="text-[13px] font-semibold">{s.label}</h3>
          <span className="text-[12px] tabular-nums text-muted-foreground">{list.length}</span>
        </header>
        {list.length === 0
          ? <p className="px-1 pb-2 text-[12px] text-muted-foreground">{s.hint}</p>
          : list.map((t) => <TaskCard key={t.id} t={t} own={own} draggable={!phone} onOpen={() => onOpen(t.id)} />)}
      </section>
    )
  }
  if (phone) {
    return (
      <div className="space-y-3">
        <div className={SEG_BAR} role="group" aria-label="Stage">
          {STAGES.map((s) => (
            <button key={s.key} type="button" aria-pressed={shown === s.key} className={segClass(shown === s.key)} onClick={() => setShown(s.key)}>
              {s.label} <span className="tabular-nums opacity-70">{byStage(s.key).length}</span>
            </button>
          ))}
        </div>
        {column(STAGES.find((s) => s.key === shown)!)}
      </div>
    )
  }
  return <div className="grid grid-cols-4 items-start gap-3">{STAGES.map(column)}</div>
}

/* One task: what it is, where it has got to, what the reader can do next,
   its story, and (for whoever steers it) the details to change. */
function TaskDialog({ id, onClose, move, own }: { id: string; onClose: () => void; move: (v: { id: string; action: Action; note?: string }) => Promise<unknown>; own?: boolean }) {
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['staff-task', id], queryFn: () => api.get<TaskDetail>(`/api/v1/hr/tasks/${id}`) })
  const [note, setNote] = useState('')
  const [comment, setComment] = useState('')
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ title: '', detail: '', due_on: '', priority: 'normal', assigned_to: '' })
  const staff = useQuery({ queryKey: ['work-pattern-staff'], queryFn: () => api.get<{ items: Staff[] }>('/api/v1/setup/work-patterns/staff'), enabled: editing && !own })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['staff-task', id] }); qc.invalidateQueries({ queryKey: ['staff-tasks'] }) }
  const act = useMutation({
    mutationFn: (v: { action: Action; note?: string }) => move({ id, ...v }),
    onSuccess: () => { setNote(''); refresh() },
  })
  const say = useMutation({
    mutationFn: () => api.post(`/api/v1/hr/tasks/${id}/comments`, { note: comment }),
    onSuccess: () => { setComment(''); refresh() },
  })
  const save = useMutation({
    mutationFn: () => {
      const { assigned_to, ...rest } = form
      return api.patch(`/api/v1/hr/tasks/${id}`, own ? rest : { ...rest, assigned_to })
    },
    onSuccess: () => { setEditing(false); toast.ok('Task changed'); refresh() },
  })
  /* One's own to-do (set by oneself) may be deleted. */
  const [confirmDel, setConfirmDel] = useState(false)
  const del = useMutation({
    mutationFn: () => api.del(`/api/v1/hr/tasks/${id}`),
    onSuccess: () => { buzz('warn'); toast.ok('Task deleted'); qc.invalidateQueries({ queryKey: ['staff-tasks'] }); onClose() },
  })
  const t = q.data
  const live = t && t.status !== 'done' && t.status !== 'cancelled'
  const actions = t ? actionsFor(t) : []
  const sendBack = actions.find((a) => a.needsNote)
  return (
    <Dialog title={t?.title ?? 'Task'} description={t ? (own ? `${STATUS_LABEL[t.status]}${t.reviewed && t.assigned_by ? ` · from ${t.assigned_by}` : ''}` : `${STATUS_LABEL[t.status]} · ${t.mine ? 'yours' : t.assigned_to}${t.assigned_by ? `, from ${t.assigned_by}` : ''}`) : undefined}
      size="lg" onClose={onClose}>
      {q.isLoading ? <Loading shape="form" /> : q.error ? <ErrorState error={q.error} /> : t && (
        <div className="space-y-5">
          {editing ? (
            <div className="space-y-3">
              <Field label="What" required><Input value={form.title} onChange={(v) => setForm({ ...form, title: v })} /></Field>
              <FormGrid>
                {!own && <Field label="Who">
                  <Select value={form.assigned_to} onChange={(v) => setForm({ ...form, assigned_to: v })}
                    options={(staff.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name || e.employee_code }))} />
                </Field>}
                <Field label="By when"><Input type="date" value={form.due_on} onChange={(v) => setForm({ ...form, due_on: v })} /></Field>
                <Field label="Priority">
                  <Select value={form.priority} onChange={(v) => setForm({ ...form, priority: v })} options={Object.entries(PRIORITY).map(([value, label]) => ({ value, label }))} />
                </Field>
              </FormGrid>
              <Field label="Detail"><Textarea value={form.detail} onChange={(v) => setForm({ ...form, detail: v })} /></Field>
              <FormNotice error={save.error} />
              <div className="flex gap-2">
                <Button disabled={!form.title.trim() || save.isPending} pending={save.isPending} onClick={() => save.mutate()}>Save changes</Button>
                <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={t.status === 'done' ? 'success' : t.status === 'review' ? 'warning' : t.status === 'cancelled' ? 'neutral' : 'primary'}>{STATUS_LABEL[t.status]}</Badge>
                {t.priority === 'high' && <Badge tone="danger">High priority</Badge>}
                <DueChip t={t} />
              </div>
              {t.detail && <p className="whitespace-pre-wrap text-[13.5px]">{t.detail}</p>}
              {live && t.manage && (
                <Button size="sm" variant="ghost" onClick={() => {
                  setForm({ title: t.title, detail: t.detail ?? '', due_on: t.due_on ?? '', priority: t.priority, assigned_to: t.employee_id })
                  setEditing(true)
                }}><Pencil className="size-4" /> Change details</Button>
              )}
              {t.mine && !t.reviewed && (confirmDel ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13.5px]">Delete this task for good?</span>
                  <Button size="sm" tone="danger" disabled={del.isPending} pending={del.isPending} onClick={() => del.mutate()}>Delete</Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDel(false)}>Keep it</Button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" tone="danger" onClick={() => setConfirmDel(true)}>Delete task</Button>
              ))}
              <FormNotice error={del.error} />
            </div>
          )}

          {actions.length > 0 && !editing && (
            <div className="space-y-2 rounded-[var(--radius-control)] bg-muted/50 p-3">
              {(sendBack || actions.some((a) => a.action === 'finish' || a.action === 'reopen')) && (
                <Field label={sendBack ? 'Note' : 'Note (optional)'} hint={sendBack ? 'Needed to send it back: say what still needs doing.' : 'Goes with the step, into the story below.'}>
                  <Textarea value={note} onChange={setNote} rows={2} />
                </Field>
              )}
              <div className="flex flex-wrap gap-2">
                {actions.map((a) => (
                  <Button key={a.action} size="sm" variant={a.primary ? 'primary' : 'secondary'} tone={a.danger ? 'danger' : undefined}
                    disabled={act.isPending || (a.needsNote && !note.trim())} onClick={() => act.mutate({ action: a.action, note: note.trim() || undefined })}>
                    {a.label}
                  </Button>
                ))}
              </div>
              <FormNotice error={act.error} />
            </div>
          )}

          <section>
            <h3 className="mb-2 text-[13px] font-semibold">What has happened</h3>
            <ol className="relative ms-[7px] border-s">
              {t.updates.map((u) => (
                <li key={u.id} className="relative ps-4 pb-3 last:pb-0">
                  <span aria-hidden className={cn('absolute -start-[4px] top-[6px] h-2 w-2 rounded-full ring-4 ring-card',
                    u.kind === 'returned' || u.kind === 'cancelled' ? 'bg-[hsl(var(--sys-red))]' : u.kind === 'accepted' ? 'bg-[hsl(var(--sys-green))]' : u.kind === 'submitted' ? 'bg-[hsl(var(--sys-orange))]' : 'bg-[hsl(var(--sys-gray))]')} />
                  <p className="text-[13px]"><span className="font-medium">{u.by_name ?? 'Someone'}</span> {UPDATE_LABEL[u.kind]?.toLowerCase() ?? u.kind}</p>
                  {u.note && <p className="mt-0.5 whitespace-pre-wrap rounded-md bg-muted/60 px-2 py-1 text-[13px]">{u.note}</p>}
                  <p className="text-[11.5px] text-muted-foreground">{new Date(u.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</p>
                </li>
              ))}
            </ol>
          </section>

          {(t.mine || t.manage) && (
            <div className="space-y-2">
              <Field label="Comment"><Textarea value={comment} onChange={setComment} rows={2} /></Field>
              <FormNotice error={say.error} />
              <Button size="sm" variant="secondary" disabled={!comment.trim() || say.isPending} pending={say.isPending} onClick={() => say.mutate()}>Add comment</Button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  )
}

function NewTask({ onClose, onMade }: { onClose: () => void; onMade: () => void }) {
  const [form, setForm] = useState({ title: '', detail: '', assigned_to: '', due_on: '', priority: 'normal' })
  /* HR may hand a task to anyone on the roll; a manager only to their own
     people (or themselves), which the server enforces. A wrong pick is
     refused with the reason. */
  const staff = useQuery({ queryKey: ['work-pattern-staff'], queryFn: () => api.get<{ items: Staff[] }>('/api/v1/setup/work-patterns/staff') })
  const add = useMutation({
    mutationFn: () => api.post('/api/v1/hr/tasks', { ...form, detail: form.detail || undefined, due_on: form.due_on || undefined }),
    onSuccess: () => { buzz('tap'); onMade() },
  })
  return (
    <Dialog title="New task" description="Whoever you give it to sees it under My tasks and is told by the bell. When they finish it, it comes back to you to accept."
      onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={!form.title.trim() || !form.assigned_to || add.isPending} pending={add.isPending} onClick={() => add.mutate()}>Give the task</Button>
      </>}>
      <div className="space-y-3">
        <Field label="What" required><Input value={form.title} onChange={(v) => setForm({ ...form, title: v })} /></Field>
        <FormGrid>
          <Field label="Who" required>
            <Select value={form.assigned_to} onChange={(v) => setForm({ ...form, assigned_to: v })} placeholder="Choose"
              options={(staff.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name || e.employee_code }))} />
          </Field>
          <Field label="By when"><Input type="date" value={form.due_on} onChange={(v) => setForm({ ...form, due_on: v })} /></Field>
          <Field label="Priority">
            <Select value={form.priority} onChange={(v) => setForm({ ...form, priority: v })} options={Object.entries(PRIORITY).map(([value, label]) => ({ value, label }))} />
          </Field>
        </FormGrid>
        <Field label="Detail" hint="Anything they need to know to do it."><Textarea value={form.detail} onChange={(v) => setForm({ ...form, detail: v })} /></Field>
        <FormNotice error={add.error} />
      </div>
    </Dialog>
  )
}

function Tasks({ hr }: { hr: boolean }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  /* No "Mine / My team / Everyone" switch (owner, 2026-10-28): staff see their
     own tasks, HR's door every task. The API still takes for=team. */
  const scope = hr ? 'all' : 'mine'
  const own = !hr
  const [view, setView] = useState<'board' | 'list'>('board')
  const [due, setDue] = useState<'' | 'overdue' | 'week'>('')
  const [priority, setPriority] = useState('')
  const [text, setText] = useState('')
  const [adding, setAdding] = useState(false)
  /* A bell entry links here with ?task=, which opens that task. */
  const open = params.get('task')
  const setOpen = (id: string | null) => {
    const p = new URLSearchParams(params)
    if (id) p.set('task', id); else p.delete('task')
    setParams(p, { replace: true })
  }
  const settled = useSettledText(text)
  const qs = new URLSearchParams({ for: scope })
  if (due) qs.set('due', due)
  if (priority) qs.set('priority', priority)
  if (settled) qs.set('q', settled)
  const key = ['staff-tasks', qs.toString()]
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ items: Task[]; summary: Summary }>(`/api/v1/hr/tasks?${qs}`) })

  const NEXT: Record<Action, Task['status']> = { start: 'in_progress', finish: 'done', accept: 'done', return: 'in_progress', reopen: 'in_progress', cancel: 'cancelled' }
  const move = useOptimisticMutation<{ id: string; action: Action; note?: string }>({
    mutationFn: (v) => api.post(`/api/v1/hr/tasks/${v.id}/status`, { action: v.action, note: v.note }),
    queryKeys: [['staff-tasks']],
    apply: (old, v) => {
      const d = old as { items: Task[]; summary: Summary } | undefined
      if (!d?.items) return old
      return { ...d, items: d.items.map((t) => (t.id !== v.id ? t
        : { ...t, status: v.action === 'finish' && t.reviewed && !t.manage ? 'review' : NEXT[v.action] })) }
    },
    invalidate: [['staff-tasks'], ['staff-task']],
    failure: "Couldn't move the task",
  })
  const onMove = (t: Task, to: Stage) => {
    const action = moveFor(t, to)
    if (!action) { toast.error(`You can't move "${t.title}" to ${STATUS_LABEL[to]}.`); return }
    if (action === 'return') { setOpen(t.id); toast.error('Say what still needs doing, then press Send back.'); return }
    buzz('snap')
    move.mutate({ id: t.id, action })
  }

  const items = (q.data?.items ?? []).filter((t) => t.status !== 'cancelled')
  const s = q.data?.summary ?? { open: 0, in_progress: 0, review: 0, overdue: 0, done: 0 }
  const narrowed = !!(due || priority || settled)
  /* On a phone the filters fold behind one button, so the board is in view;
     the board already shows one stage at a time there, so no list view. */
  const phone = usePhone()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const showFilters = !phone || filtersOpen
  const nOn = [due, priority, settled].filter(Boolean).length
  return (
    <div className="space-y-4">
      {own && <AddTask />}
      <CellGrid cols={4}>
        <Stat label="To do" value={s.open} />
        <Stat label="In progress" value={s.in_progress} />
        <Stat label="Waiting for review" value={s.review} hint={s.review ? 'Finished work to accept or send back.' : undefined} />
        <Stat label="Overdue" value={s.overdue} onClick={() => setDue(due === 'overdue' ? '' : 'overdue')} active={due === 'overdue'} />
      </CellGrid>
      <Card>
        <CardHeader title="Tasks" action={hr ? <Button onClick={() => setAdding(true)}><Plus className="size-4" /> New task</Button> : undefined} />
        <div className="flex flex-wrap items-center gap-3 px-[var(--card-pad)] pb-3 pt-3">
          {phone && (
            <Button size="sm" variant="secondary" ariaExpanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>
              <SlidersHorizontal className="size-4" /> Filters{nOn ? ` (${nOn})` : ''}
            </Button>
          )}
          {showFilters && <>
          <div className={SEG_BAR} role="group" aria-label="Due">
            {([['', 'Any time'], ['overdue', 'Overdue'], ['week', 'This week']] as const).map(([k, label]) => (
              <button key={k || 'any'} type="button" aria-pressed={due === k} className={segClass(due === k)} onClick={() => setDue(k)}>{label}</button>
            ))}
          </div>
          <PickerMenu ariaLabel="Priority" value={priority} onChange={setPriority}
            options={[{ value: '', label: 'Any priority' }, ...Object.entries(PRIORITY).map(([value, label]) => ({ value, label }))]} />
          <SearchBox value={text} onChange={setText} placeholder={own ? 'Task' : 'Task or person'} />
          {narrowed && <Button size="sm" variant="ghost" onClick={() => { setDue(''); setPriority(''); setText('') }}>Clear</Button>}
          </>}
          {!phone && (
            <div className={cn(SEG_BAR, 'ms-auto')} role="group" aria-label="View">
              <button type="button" aria-pressed={view === 'board'} className={segClass(view === 'board')} onClick={() => setView('board')}><Columns3 className="inline size-4" /> Board</button>
              <button type="button" aria-pressed={view === 'list'} className={segClass(view === 'list')} onClick={() => setView('list')}><Rows3 className="inline size-4" /> List</button>
            </div>
          )}
        </div>
        <div className="px-[var(--card-pad)] pb-[var(--card-pad)]">
          {q.isLoading ? <Loading shape="cards" /> : q.error ? <ErrorState error={q.error} /> : items.length === 0 ? (
            <EmptyState title={narrowed ? 'No task matches.' : 'No tasks here.'} body={narrowed ? 'Clear the filters to see every task.' : (own ? 'Add one with Add a task above.' : 'Give somebody a task with New task.')} />
          ) : view === 'board' || phone ? (
            <Board items={items} own={own} onOpen={setOpen} onMove={onMove} />
          ) : (
            <Table head={own ? ['Task', 'Due', 'Priority', 'Stage'] : ['Task', 'Who', 'Due', 'Priority', 'Stage']}>
              {items.map((t) => (
                <tr key={t.id} className="cursor-pointer hover:bg-accent/50" onClick={() => setOpen(t.id)}>
                  <Td className="font-medium">{t.title}{t.assigned_by && (!own || t.reviewed) && <span className="block text-[11.5px] font-normal text-muted-foreground">from {t.assigned_by}</span>}</Td>
                  {!own && <Td>{t.mine ? 'You' : t.assigned_to}</Td>}
                  <Td>{t.due_on ? <DueChip t={t} /> : <span className="text-muted-foreground">-</span>}</Td>
                  <Td>{t.priority === 'high' ? <Badge tone="danger">High</Badge> : <span className="text-muted-foreground">{PRIORITY[t.priority]}</span>}</Td>
                  <Td>{STATUS_LABEL[t.status]}</Td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      </Card>
      {adding && <NewTask onClose={() => setAdding(false)} onMade={() => { setAdding(false); toast.ok('Task given'); qc.invalidateQueries({ queryKey: ['staff-tasks'] }) }} />}
      {open && <TaskDialog id={open} onClose={() => setOpen(null)} own={own} move={(v) => move.mutateAsync(v)} />}
    </div>
  )
}

/* Add a task: one's own to-do, laid out like the Leave screen's apply form
   (owner, 2026-10-28): the button in the card's header opens the form in
   place; once saved it shows read only, with Edit, until another is added. */
function AddTask() {
  const qc = useQueryClient()
  const blank = { title: '', detail: '', due_on: '', priority: 'normal' }
  const [openForm, setOpenForm] = useState(false)
  const [form, setForm] = useState(blank)
  const [sent, setSent] = useState<(typeof blank & { id: string }) | null>(null)
  const [editing, setEditing] = useState(false)
  const formRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!openForm) return
    const el = formRef.current
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    el.querySelector<HTMLElement>('input, textarea, button')?.focus({ preventScroll: true })
  }, [openForm])
  const done = () => { setForm(blank); setEditing(false); setOpenForm(false); qc.invalidateQueries({ queryKey: ['staff-tasks'] }) }
  const body = () => ({ title: form.title.trim(), detail: form.detail, due_on: form.due_on, priority: form.priority })
  const add = useMutation({
    mutationFn: () => api.post<{ id: string }>('/api/v1/hr/tasks', { ...body(), detail: form.detail || undefined, due_on: form.due_on || undefined }),
    onSuccess: (r) => { buzz('tap'); setSent({ ...form, id: (r as { id: string }).id }); done() },
  })
  const save = useMutation({
    mutationFn: () => api.patch(`/api/v1/hr/tasks/${sent!.id}`, body()),
    onSuccess: () => { buzz('tap'); setSent({ ...form, id: sent!.id }); done() },
  })
  const cancel = () => { setEditing(false); setOpenForm(false); setForm(blank); save.reset(); add.reset() }
  const pending = add.isPending || save.isPending
  return (
    <Card>
      <CardHeader title="Add a task" description="Your own to-do. Only you see it."
        action={
          <div className="-mt-[5.25px] mb-[5.25px]">
            <Button variant={openForm ? 'ghost' : 'primary'} onClick={() => (openForm ? cancel() : setOpenForm(true))}>
              {openForm ? 'Cancel' : 'Add a task'}
            </Button>
          </div>
        } />
      {openForm && (
        <div ref={formRef} className="scroll-mt-24 flex flex-col gap-3" style={{ padding: '0 var(--card-pad) var(--card-pad)' }}>
          <Field label="What" required><Input value={form.title} onChange={(v) => setForm({ ...form, title: v })} /></Field>
          <FormGrid>
            <Field label="By when"><Input type="date" value={form.due_on} onChange={(v) => setForm({ ...form, due_on: v })} /></Field>
            <Field label="Priority">
              <Select value={form.priority} onChange={(v) => setForm({ ...form, priority: v })} options={Object.entries(PRIORITY).map(([value, label]) => ({ value, label }))} />
            </Field>
          </FormGrid>
          <Field label="Notes"><Textarea value={form.detail} onChange={(v) => setForm({ ...form, detail: v })} /></Field>
          <FormNotice error={editing ? save.error : add.error} />
          {editing ? (
            <div className="flex flex-wrap gap-2">
              <Button className="m-0" disabled={!form.title.trim() || pending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</Button>
              <Button className="m-0" variant="secondary" onClick={cancel}>Cancel</Button>
            </div>
          ) : (
            <Button className="m-0 self-start" disabled={!form.title.trim() || pending} onClick={() => add.mutate()}>{add.isPending ? 'Adding…' : 'Add task'}</Button>
          )}
        </div>
      )}
      {!openForm && sent && (
        <div className="flex flex-col gap-3" style={{ padding: '0 var(--card-pad) var(--card-pad)' }}>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[14px]">
            <dt className="text-muted-foreground">Task</dt><dd className="m-0 break-words">{sent.title}</dd>
            <dt className="text-muted-foreground">By when</dt><dd className="m-0">{sent.due_on ? formatDate(sent.due_on) : 'No date'}</dd>
            <dt className="text-muted-foreground">Priority</dt><dd className="m-0">{PRIORITY[sent.priority]}</dd>
            {sent.detail && <><dt className="text-muted-foreground">Notes</dt><dd className="m-0 whitespace-pre-wrap break-words">{sent.detail}</dd></>}
          </dl>
          <Button className="m-0 self-start" variant="secondary"
            onClick={() => { const { id: _id, ...v } = sent; setForm(v); setEditing(true); setOpenForm(true) }}>
            Edit
          </Button>
        </div>
      )}
    </Card>
  )
}

/** The search box waits for a pause in typing before it asks the server. */
function useSettledText(v: string, ms = 350) {
  const [s, setS] = useState(v.trim())
  useEffect(() => { const t = setTimeout(() => setS(v.trim()), ms); return () => clearTimeout(t) }, [v, ms])
  return s
}

function Report() {
  interface Row { employee_id: string; full_name: string; employee_code: string; department?: string; open: number; review: number; overdue: number; done: number; next_due?: string }
  const q = useQuery({ queryKey: ['staff-tasks', 'report'], queryFn: () => api.get<{ items: Row[] }>('/api/v1/hr/tasks/report') })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorState error={q.error} />
  const rows = q.data?.items ?? []
  return (
    <Card>
      <CardHeader title="Who has what" description="Most overdue first." />
      <Table head={['Person', 'Department', { label: 'Open', align: 'right' }, { label: 'For review', align: 'right' }, { label: 'Overdue', align: 'right' }, { label: 'Done', align: 'right' }, 'Next due']} empty={!rows.length} emptyLabel="No tasks have been handed out yet.">
        {rows.map((r) => (
          <tr key={r.employee_id}>
            <Td className="font-medium">{r.full_name}<span className="block font-mono text-[11.5px] font-normal text-muted-foreground">{r.employee_code}</span></Td>
            <Td className="text-muted-foreground">{r.department ?? '-'}</Td>
            <Td className="text-right tabular-nums">{r.open}</Td>
            <Td className="text-right tabular-nums">{r.review ?? 0}</Td>
            <Td className={cn('text-right tabular-nums', Number(r.overdue) > 0 && 'font-medium text-destructive')}>{r.overdue}</Td>
            <Td className="text-right tabular-nums">{r.done}</Td>
            <Td className="text-muted-foreground">{r.next_due ? formatDate(r.next_due) : '-'}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

function ReportingManagers() {
  interface Row { id: string; full_name: string; employee_code: string; department?: string; designation?: string; reports_to?: string; manager_name?: string; manager_code?: string; reports: number }
  const qc = useQueryClient()
  const [find, setFind] = useState('')
  const q = useQuery({ queryKey: ['reporting-managers'], queryFn: () => api.get<{ items: Row[] }>('/api/v1/hr/reporting-managers') })
  const set = useMutation({
    mutationFn: (v: { id: string; reports_to: string }) => api.put(`/api/v1/hr/employees/${v.id}/reporting-manager`, { reports_to: v.reports_to }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reporting-managers'] }),
  })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorState error={q.error} />
  const all = q.data?.items ?? []
  const needle = find.trim().toLowerCase()
  const rows = all.filter((r) => !needle || r.full_name.toLowerCase().includes(needle) || (r.department ?? '').toLowerCase().includes(needle))
  const options = [{ value: '', label: 'Nobody' }, ...all.map((e) => ({ value: e.id, label: `${e.full_name} (${e.employee_code})` }))]
  return (
    <Card>
      <CardHeader title="Who answers to whom" description="A leave request goes to the reporting manager first, then to HR." action={<Input className="w-56" value={find} onChange={setFind} placeholder="Find a person or department" />} />
      <Table head={['Person', 'Department', 'Reports to', { label: 'Team', align: 'right' }]} empty={!rows.length} emptyLabel="Nobody on the roll.">
        {rows.map((r) => (
          <tr key={r.id}>
            <Td className="font-medium">{r.full_name}<span className="block text-[11.5px] font-normal text-muted-foreground">{r.employee_code}{r.designation ? ` · ${r.designation}` : ''}</span></Td>
            <Td className="text-muted-foreground">{r.department ?? '-'}</Td>
            <Td>
              <Select value={r.reports_to ?? ''} onChange={(v) => set.mutate({ id: r.id, reports_to: v })} options={options.filter((o) => o.value !== r.id)} />
            </Td>
            <Td className="text-right tabular-nums">{r.reports}</Td>
          </tr>
        ))}
      </Table>
      <div className="px-5 pb-4"><FormNotice error={set.error} /></div>
    </Card>
  )
}
