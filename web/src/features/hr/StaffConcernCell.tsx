import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Inbox } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  Card, CardHeader, Table, Td, Badge, Button, Checkbox, Field, FormGrid, FormNotice,
  Input, Select, Textarea, SkeletonTable, ErrorState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { useEmployeeRoster } from '@/lib/rosters'
import { formatDate } from '@/lib/utils'
import {
  AttachmentLink, SlaCell, StageBadge, StageBar, Stars, Timeline, type Stage,
} from '@/features/communication/concern-ui'
import { STAFF_CATEGORIES, staffCategoryLabel } from '@/features/me/MyConcerns'

/* HR's grievance cell as a pipeline: new -> acknowledged -> in progress ->
   resolved or closed, with the deadline each category promises, who owns each
   case, a timeline that keeps internal notes apart from replies to the raiser,
   and escalation when a deadline is missed.

   An anonymous case shows no name anywhere: the server never sends one, and
   it has none to send. The raiser follows it from their own /concerns page. */

export interface CellRow {
  id: string
  reference_no: string
  is_anonymous: boolean
  full_name?: string
  category: string
  severity: string
  subject: string
  description: string
  status: string
  stage: Stage
  assigned_to?: string
  assigned_to_id?: string
  escalated_to?: string
  escalated: boolean
  resolution?: string
  satisfaction?: number
  satisfaction_note?: string
  reopened_count: number
  has_attachment: boolean
  created_at: string
  acknowledged_at?: string
  respond_due_at?: string
  resolve_due_at?: string
  respond_breached: boolean
  resolve_breached: boolean
  open_days: number
  unanswered_replies: number
  attachment?: { id: string; name: string }
}

interface Update {
  id: string
  kind: string
  body: string
  new_status?: string
  visible_to_raiser: boolean
  from_raiser: boolean
  author?: string
  created_at: string
}

interface Person { id: string; name: string; designation?: string }
interface StaffSLA { category: string; respond_hours: number; resolve_hours: number; default_owner?: string }

const ROOT = ['hr', 'grievances'] as const
const settled = (s: string) => s === 'resolved' || s === 'closed'

export function StaffConcernCell() {
  const qc = useQueryClient()
  const can = useCan()
  const isHR = can('hr.employees.write')
  const [stage, setStage] = useState('')
  const [category, setCategory] = useState('')
  const [overdue, setOverdue] = useState(false)
  const [mine, setMine] = useState(false)
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(window.location.search).get('id'))
  const [escalateTo, setEscalateTo] = useState('')
  const detailRef = useRef<HTMLDivElement>(null)

  const list = useQuery({
    queryKey: [...ROOT, 'list', stage, category, overdue, mine],
    queryFn: () => api.get<List<CellRow> & { counts: Record<Stage, number> }>(
      `/api/v1/hr/grievances?stage=${stage}&category=${category}&overdue=${overdue ? 'true' : ''}&mine=${mine ? 'true' : ''}`),
    staleTime: 0,
  })
  const people = useQuery({
    queryKey: [...ROOT, 'assignees'],
    queryFn: () => api.get<List<Person>>('/api/v1/hr/grievances/assignees'), staleTime: 0,
    enabled: isHR,
  })
  const peopleOptions = (people.data?.items ?? []).map((p) => ({ value: p.id, label: p.designation ? `${p.name}, ${p.designation}` : p.name }))
  const refresh = () => qc.invalidateQueries({ queryKey: ROOT })
  const quick = useMutation({
    mutationFn: (v: { id: string; action: 'acknowledge' | 'start' }) => api.post(`/api/v1/hr/grievances/${v.id}/${v.action}`, {}),
    onSuccess: refresh,
  })
  const escalateAll = useMutation({
    mutationFn: () => api.post<{ escalated: number }>('/api/v1/hr/grievances/escalate-overdue', { to_user_id: escalateTo }),
    onSuccess: refresh,
  })
  const open = (id: string | null) => {
    setSelected(id)
    if (id) requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const rows = list.data?.items ?? []
  const toEscalate = rows.filter((g) => !settled(g.stage) && g.resolve_breached && !g.escalated).length

  return (
    <>
      {isHR && toEscalate > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-[var(--card-pad)] py-3 text-[14px]">
          <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden />
          <span className="font-medium">{toEscalate} {toEscalate === 1 ? 'case is' : 'cases are'} past the resolution deadline and not escalated.</span>
          <div className="min-w-[14rem]"><Select value={escalateTo} onChange={setEscalateTo} placeholder="Escalate to…" options={peopleOptions} /></div>
          <Button size="sm" tone="danger" disabled={!escalateTo || escalateAll.isPending} onClick={() => escalateAll.mutate()}>Escalate all</Button>
          <FormNotice error={escalateAll.error} ok={escalateAll.data ? `${escalateAll.data.escalated} escalated.` : undefined} />
        </div>
      )}

      <Card>
        <CardHeader title="The cell" />
        <div className="flex flex-wrap items-center gap-2 border-b px-[var(--card-pad)] py-3">
          <StageBar counts={list.data?.counts} value={stage} onChange={setStage} />
          <div className="min-w-[10rem]">
            <Select value={category} onChange={setCategory} placeholder="Any category"
              options={[{ value: '', label: 'Any category' }, ...STAFF_CATEGORIES]} />
          </div>
          <Button variant={mine ? 'primary' : 'secondary'} size="sm" onClick={() => setMine(!mine)}>Assigned to me</Button>
          <Button variant={overdue ? 'primary' : 'secondary'} size="sm" onClick={() => setOverdue(!overdue)}>Past deadline</Button>
        </div>
        {list.isLoading ? <SkeletonTable columns={6} /> : list.error ? <ErrorState error={list.error} /> : (
          <Table head={['Concern', 'From', 'Owner', 'Deadline', 'Stage', '']} empty={rows.length === 0} emptyLabel="Nothing here.">
            {rows.map((g) => (
              <tr key={g.id} className={selected === g.id ? 'bg-accent/40' : undefined}>
                <Td>
                  <button type="button" className="text-left font-medium hover:underline" onClick={() => open(g.id)}>{g.subject}</button>
                  {g.severity === 'high' && <Badge tone="danger" className="ml-2">High</Badge>}
                  {g.escalated && <Badge tone="warning" className="ml-2">Escalated</Badge>}
                  {g.reopened_count > 0 && <Badge tone="warning" className="ml-2">Reopened</Badge>}
                  {g.unanswered_replies > 0 && !settled(g.stage) && <Badge tone="primary" className="ml-2">New reply</Badge>}
                  <span className="block text-[13px] text-muted-foreground">
                    <span className="tabular-nums">{g.reference_no}</span> · {staffCategoryLabel(g.category)} · {formatDate(g.created_at)}
                  </span>
                </Td>
                <Td>{g.is_anonymous ? <Badge tone="info">Anonymous</Badge> : (g.full_name ?? '-')}</Td>
                <Td>{g.assigned_to ?? <span className="text-muted-foreground">No owner</span>}</Td>
                <Td>
                  <SlaCell respondDue={g.respond_due_at} resolveDue={g.resolve_due_at} respondBreached={g.respond_breached}
                    resolveBreached={g.resolve_breached} acknowledged={!!g.acknowledged_at} settled={settled(g.stage)} />
                </Td>
                <Td><StageBadge stage={g.stage} /></Td>
                <Td>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {g.stage === 'new' && <Button size="sm" variant="secondary" disabled={quick.isPending} onClick={() => quick.mutate({ id: g.id, action: 'acknowledge' })}>Acknowledge</Button>}
                    {(g.stage === 'new' || g.stage === 'acknowledged') && <Button size="sm" variant="secondary" disabled={quick.isPending} onClick={() => quick.mutate({ id: g.id, action: 'start' })}>Start</Button>}
                    <Button size="sm" variant="ghost" onClick={() => open(g.id)}>Open</Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <div ref={detailRef} className="scroll-mt-4">
        {selected && <CellCase key={selected} id={selected} isHR={isHR} peopleOptions={peopleOptions} onClose={() => open(null)} onChanged={refresh} />}
      </div>

      {isHR && <RaiseOnBehalf onDone={refresh} />}
      {isHR && <StaffSlaCard />}
    </>
  )
}

function CellCase({ id, isHR, peopleOptions, onClose, onChanged }: {
  id: string; isHR: boolean; peopleOptions: { value: string; label: string }[]; onClose: () => void; onChanged: () => void
}) {
  const detail = useQuery({ queryKey: [...ROOT, 'one', id], queryFn: () => api.get<CellRow>(`/api/v1/hr/grievances/${id}`), staleTime: 0 })
  const timeline = useQuery({ queryKey: [...ROOT, 'timeline', id], queryFn: () => api.get<List<Update>>(`/api/v1/hr/grievances/${id}/updates`), staleTime: 0 })
  const [reply, setReply] = useState('')
  const [note, setNote] = useState('')
  const [assignee, setAssignee] = useState('')
  const [escalateTo, setEscalateTo] = useState('')
  const [reason, setReason] = useState('')
  const [resolution, setResolution] = useState('')
  const [showEscalate, setShowEscalate] = useState(false)
  useEffect(() => { setAssignee(detail.data?.assigned_to_id ?? '') }, [detail.data?.assigned_to_id])

  const post = (path: string, body: unknown) => api.post(`/api/v1/hr/grievances/${id}/${path}`, body)
  const sendReply = useMutation({ mutationFn: () => post('updates', { body: reply, visible_to_raiser: true }), onSuccess: () => { setReply(''); onChanged() } })
  const addNote = useMutation({ mutationFn: () => post('updates', { body: note, visible_to_raiser: false }), onSuccess: () => { setNote(''); onChanged() } })
  const act = useMutation({ mutationFn: (a: 'acknowledge' | 'start') => post(a, {}), onSuccess: onChanged })
  const assign = useMutation({ mutationFn: () => api.put(`/api/v1/hr/grievances/${id}/assign`, { assigned_to: assignee }), onSuccess: onChanged })
  const escalate = useMutation({ mutationFn: () => post('escalate', { to_user_id: escalateTo, reason }), onSuccess: () => { setReason(''); setShowEscalate(false); onChanged() } })
  const decide = useMutation({ mutationFn: (status: string) => post('decide', { status, resolution }), onSuccess: () => { setResolution(''); onChanged() } })

  if (detail.error) return <ErrorState error={detail.error} />
  if (!detail.data) return <SkeletonTable columns={3} />
  const d = detail.data
  const done = settled(d.stage)

  return (
    <Card>
      <CardHeader title={`${d.reference_no}: ${d.subject}`} action={<Button variant="ghost" size="sm" onClick={onClose}>Close</Button>} />
      <div className="space-y-5 p-[var(--card-pad)]">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
          <StageBadge stage={d.stage} />
          <span>{staffCategoryLabel(d.category)} · {d.severity} severity</span>
          <span>{d.is_anonymous ? 'Raised anonymously' : `From ${d.full_name ?? '-'}`}, {formatDate(d.created_at)}</span>
          <span>{d.assigned_to ? `Owner: ${d.assigned_to}` : 'No owner yet'}</span>
          {d.escalated_to && <span>Escalated to {d.escalated_to}</span>}
          {d.reopened_count > 0 && <Badge tone="warning">Reopened {d.reopened_count}x</Badge>}
          {d.satisfaction ? <span className="inline-flex items-center gap-1">Rated <Stars value={d.satisfaction} /></span> : null}
        </div>
        <SlaCell respondDue={d.respond_due_at} resolveDue={d.resolve_due_at} respondBreached={d.respond_breached}
          resolveBreached={d.resolve_breached} acknowledged={!!d.acknowledged_at} settled={done} />
        <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{d.description}</p>
        <AttachmentLink file={d.attachment} />
        {d.is_anonymous && (
          <p className="rounded-md bg-info/10 px-3 py-2 text-[13px]">
            Anonymous: nobody, HR included, can see who raised this. Replies you send reach them on their own page; they get no notification.
          </p>
        )}

        {!done && (
          <>
            <div className="flex flex-wrap gap-2">
              {d.stage === 'new' && <Button size="sm" variant="secondary" disabled={act.isPending} onClick={() => act.mutate('acknowledge')}>Acknowledge</Button>}
              {(d.stage === 'new' || d.stage === 'acknowledged') && <Button size="sm" variant="secondary" disabled={act.isPending} onClick={() => act.mutate('start')}>Start work</Button>}
              <Button size="sm" variant="secondary" onClick={() => setShowEscalate(!showEscalate)}>Escalate</Button>
            </div>
            <FormNotice error={act.error} />
            {isHR && (
              <Field label="Owner" hint="Who handles it. They are notified and can then see this case.">
                <div className="flex max-w-xl gap-2">
                  <div className="min-w-0 flex-1"><Select value={assignee} onChange={setAssignee} placeholder="Choose a member of staff" options={peopleOptions} /></div>
                  <Button size="sm" disabled={!assignee || assignee === d.assigned_to_id || assign.isPending} onClick={() => assign.mutate()}>Assign</Button>
                </div>
                <FormNotice error={assign.error} />
              </Field>
            )}
            {showEscalate && (
              <div className="space-y-3 rounded-md border border-warning/40 bg-warning/5 p-3">
                <FormGrid>
                  <Field label="Escalate to" required>
                    <Select value={escalateTo} onChange={setEscalateTo} placeholder="Choose a senior member of staff" options={peopleOptions} />
                  </Field>
                  <Field label="Why" required wide><Textarea rows={2} value={reason} onChange={setReason} /></Field>
                </FormGrid>
                <Button size="sm" disabled={!escalateTo || !reason.trim() || escalate.isPending} onClick={() => escalate.mutate()}>Escalate</Button>
                <FormNotice error={escalate.error} />
              </div>
            )}
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <Field label="Reply to the raiser" hint="They see this on their own page.">
                  <Textarea rows={3} value={reply} onChange={setReply} />
                </Field>
                <Button size="sm" disabled={!reply.trim() || sendReply.isPending} onClick={() => sendReply.mutate()}>Send reply</Button>
                <FormNotice error={sendReply.error} />
              </div>
              <div className="space-y-2">
                <Field label="Internal note" hint="Stays with HR. Never shown to the raiser.">
                  <Textarea rows={3} value={note} onChange={setNote} />
                </Field>
                <Button size="sm" variant="secondary" disabled={!note.trim() || addNote.isPending} onClick={() => addNote.mutate()}>Add note</Button>
                <FormNotice error={addNote.error} />
              </div>
            </div>
            <div className="space-y-2 border-t pt-4">
              <Field label="Resolution" hint="Sent to the raiser, who can rate it or reopen it within 14 days.">
                <Textarea value={resolution} onChange={setResolution} rows={3} />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button disabled={!resolution.trim() || decide.isPending} onClick={() => decide.mutate('resolved')}>Resolve</Button>
                <Button variant="secondary" disabled={!resolution.trim() || decide.isPending} onClick={() => decide.mutate('closed')}>Close without resolving</Button>
              </div>
              <FormNotice error={decide.error} />
            </div>
          </>
        )}
        {done && d.resolution && (
          <div className="rounded-md bg-success/10 px-3 py-2 text-[14px]"><span className="font-medium">Resolution: </span>{d.resolution}</div>
        )}
        {d.satisfaction_note && <p className="text-[13px] text-muted-foreground">Their comment on the answer: {d.satisfaction_note}</p>}

        <div className="border-t pt-4">
          <h4 className="mb-3 flex items-center gap-2 text-[14px] font-semibold"><Inbox className="h-4 w-4" aria-hidden /> Timeline</h4>
          {timeline.error ? <ErrorState error={timeline.error} /> : timeline.isLoading ? <SkeletonTable columns={2} /> : (
            <Timeline office items={(timeline.data?.items ?? []).map((u) => ({ ...u, visible: u.visible_to_raiser }))} />
          )}
        </div>
      </div>
    </Card>
  )
}

/** A complaint made to HR in person or on paper, recorded for the person. */
function RaiseOnBehalf({ onDone }: { onDone: () => void }) {
  const employees = useEmployeeRoster<{ id: string; full_name?: string; name?: string }>()
  const [openForm, setOpenForm] = useState(false)
  const [anonymous, setAnonymous] = useState(false)
  const [employeeId, setEmployeeId] = useState('')
  const [category, setCategory] = useState('workload')
  const [severity, setSeverity] = useState('medium')
  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')
  const raise = useMutation({
    mutationFn: () => api.post<{ reference_no: string }>('/api/v1/hr/grievances', {
      is_anonymous: anonymous, employee_id: anonymous ? undefined : employeeId, category, severity, subject, description,
    }),
    onSuccess: () => { setSubject(''); setDescription(''); onDone() },
  })
  return (
    <Card>
      <CardHeader title="Record a complaint made in person"
        action={<Button size="sm" variant="secondary" onClick={() => setOpenForm(!openForm)}>{openForm ? 'Hide' : 'Record one'}</Button>} />
      {openForm && (
        <div className="space-y-5 p-[var(--card-pad)]">
          <p className="text-[13px] text-muted-foreground">Staff raise their own from My concerns on their profile page. Use this for one made to you directly.</p>
          <Checkbox checked={anonymous} onChange={setAnonymous} label="Record it anonymously" hint="Nothing identifying the reporter is written down" />
          <FormGrid>
            {!anonymous && (
              <Field label="Employee" required>
                <Select value={employeeId} onChange={setEmployeeId} placeholder="Choose an employee"
                  options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name ?? e.name ?? e.id }))} />
              </Field>
            )}
            <Field label="About"><Select value={category} onChange={setCategory} options={STAFF_CATEGORIES} /></Field>
            <Field label="Severity">
              <Select value={severity} onChange={setSeverity} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
            </Field>
            <Field label="Subject" required wide><Input value={subject} onChange={setSubject} /></Field>
            <Field label="What happened" required wide><Textarea value={description} onChange={setDescription} rows={4} /></Field>
          </FormGrid>
          <FormNotice error={raise.error} ok={raise.data ? `Recorded as ${raise.data.reference_no}.` : undefined} />
          <Button onClick={() => raise.mutate()} disabled={!subject || !description || (!anonymous && !employeeId) || raise.isPending}>Record it</Button>
        </div>
      )}
    </Card>
  )
}

/** The cell's promises per category; without one, the deadline follows severity. */
function StaffSlaCard() {
  const qc = useQueryClient()
  const slas = useQuery({
    queryKey: [...ROOT, 'sla'],
    queryFn: () => api.get<List<StaffSLA> & { defaults: Record<string, { respond_hours: number; resolve_hours: number }> }>('/api/v1/hr/grievance-sla'),
  })
  const [form, setForm] = useState({ category: 'harassment', respond_hours: 24, resolve_hours: 72 })
  const save = useMutation({
    mutationFn: () => api.put('/api/v1/hr/grievance-sla', form),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ROOT, 'sla'] }),
  })
  const defaults = slas.data?.defaults
  return (
    <Card>
      <CardHeader title="Deadlines the cell promises" />
      <Table loading={slas.isLoading} head={['Category', 'First response', 'Resolution', 'Default owner']}
        empty={(slas.data?.items.length ?? 0) === 0}
        emptyLabel={defaults ? `None set. Deadlines follow severity: high ${defaults.high.respond_hours}h / ${defaults.high.resolve_hours}h, medium ${defaults.medium.respond_hours}h / ${defaults.medium.resolve_hours}h, low ${defaults.low.respond_hours}h / ${defaults.low.resolve_hours}h.` : 'None set.'}>
        {slas.data?.items.map((p) => (
          <tr key={p.category}>
            <Td>{staffCategoryLabel(p.category)}</Td>
            <Td>{p.respond_hours}h</Td>
            <Td>{p.resolve_hours}h</Td>
            <Td>{p.default_owner ?? '-'}</Td>
          </tr>
        ))}
      </Table>
      <div className="space-y-4 border-t p-[var(--card-pad)]">
        <FormGrid>
          <Field label="Category" required><Select value={form.category} onChange={(v) => setForm({ ...form, category: v })} options={STAFF_CATEGORIES} /></Field>
          <Field label="First response within (hours)" required>
            <Input type="number" value={String(form.respond_hours)} onChange={(v) => setForm({ ...form, respond_hours: Number(v) || 0 })} />
          </Field>
          <Field label="Resolved within (hours)" required>
            <Input type="number" value={String(form.resolve_hours)} onChange={(v) => setForm({ ...form, resolve_hours: Number(v) || 0 })} />
          </Field>
        </FormGrid>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>Save deadline</Button>
        <FormNotice error={save.error} ok={save.isSuccess ? 'Saved.' : undefined} />
      </div>
    </Card>
  )
}
