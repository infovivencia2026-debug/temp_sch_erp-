import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Inbox, LayoutGrid, List as ListIcon, MessageCircleReply, ShieldAlert, Timer } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Field, FormGrid, FormNotice, Input, Select, Textarea,
  SkeletonTable, ErrorState, SEG_BAR, segClass,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { cn, formatDate } from '@/lib/utils'
import { commsQueryKeys } from './comms-keys'
import {
  AttachmentLink, SlaCell, StageBadge, StageBar, Stars, Timeline, STAGES, STAGE_LABEL, type Stage,
} from './concern-ui'

/* institution_admin.communication.parent_feedback_grievance_hub

   The school side of a complaint a family has already filed. Nothing here
   creates a grievance — POST /portal/concerns does that, and has since the
   parent portal shipped. What this adds is the queue over those tickets:
   categorise, route, promise a date, and let the family watch it move.

   The two things to notice on this screen are the SLA panel, which is where
   the promise is set rather than hard-coded, and the "About a member of staff"
   marker. A ticket with that marker is invisible to the person it names —
   enforced by a predicate on every query the server runs, not by this screen
   choosing not to draw it. */

interface Grievance {
  id: string
  student?: string
  raised_by: string
  category: string
  subject: string
  priority: string
  status: string
  stage: Stage
  department?: string
  assigned_to?: string
  assigned_to_id?: string
  escalated_to?: string
  names_staff: boolean
  created_at: string
  respond_due_at?: string
  resolve_due_at?: string
  acknowledged_at?: string
  resolved_at?: string
  escalated: boolean
  respond_breached: boolean
  resolve_breached: boolean
  overdue_hours?: number
  open_days: number
  satisfaction?: number
  reopened_count: number
  has_attachment: boolean
  unanswered_replies: number
}

interface Detail extends Grievance {
  body: string
  resolution?: string
  subject_staff?: string
  satisfaction_note?: string
  attachment?: { id: string; name: string }
}

interface Update {
  id: string
  kind: string
  body: string
  new_status?: string
  visible_to_parent: boolean
  author?: string
  created_at: string
}

interface Person { id: string; name: string; designation?: string }

interface Pattern {
  category: string
  total: number
  open: number
  breached: number
  median_days?: number
  avg_first_response_hours?: number
  department?: string
  avg_satisfaction?: number
}

interface SLA {
  category: string
  department?: string
  default_owner?: string
  respond_hours: number
  resolve_hours: number
  is_sensitive: boolean
  is_active: boolean
}

const CATEGORIES = [
  'academic', 'fees', 'transport', 'hostel', 'discipline', 'safety', 'staff',
  'facilities', 'other',
]

const hrs = (n?: number) => (n == null ? '-' : `${Math.round(n)}h`)
const days = (n?: number) => (n == null ? '-' : `${n.toFixed(1)}d`)
const settledStage = (s: string) => s === 'resolved' || s === 'closed'

export default function GrievanceHub() {
  const qc = useQueryClient()
  const can = useCan()
  const mayWork = can('office.front_desk.write')

  const [stage, setStage] = useState('')
  const [category, setCategory] = useState('')
  const [overdue, setOverdue] = useState(false)
  const [mine, setMine] = useState(false)
  const [search, setSearch] = useState('')
  const [view, setView] = useState<'list' | 'board'>('list')
  // ?id= opens one straight away — the All-messages desk and notifications link here.
  const [selected, setSelected] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('id'),
  )
  const [sla, setSla] = useState({
    category: 'safety', department: '', respond_hours: 4, resolve_hours: 48,
  })
  const [escalateTo, setEscalateTo] = useState('')

  const q = search.trim()
  const list = useQuery({
    queryKey: commsQueryKeys.grievances(view === 'board' ? '' : stage, category, overdue, mine, q),
    queryFn: () =>
      api.get<List<Grievance> & { counts: Record<Stage, number> }>(
        `/api/v1/comms/grievances?stage=${view === 'board' ? '' : stage}&category=${category}` +
          `&overdue=${overdue ? 'true' : ''}&mine=${mine ? 'true' : ''}&q=${encodeURIComponent(q)}`,
      ),
  })
  const summary = useQuery({
    queryKey: commsQueryKeys.grievanceSummary(),
    queryFn: () => api.get<List<Pattern>>('/api/v1/comms/grievances/summary'), staleTime: 0,
  })
  const slas = useQuery({
    queryKey: commsQueryKeys.grievanceSLA(),
    queryFn: () => api.get<List<SLA>>('/api/v1/comms/grievance-sla'),
  })
  const people = useQuery({
    queryKey: commsQueryKeys.grievanceAssignees(),
    queryFn: () => api.get<List<Person>>('/api/v1/comms/grievances/assignees'), staleTime: 0,
    enabled: mayWork,
  })
  const peopleOptions = (people.data?.items ?? []).map((p) => ({
    value: p.id, label: p.designation ? `${p.name}, ${p.designation}` : p.name,
  }))

  const refresh = () => qc.invalidateQueries({ queryKey: commsQueryKeys.grievanceRoot() })
  const quick = useMutation({
    mutationFn: (v: { id: string; action: 'acknowledge' | 'start' }) =>
      api.post(`/api/v1/comms/grievances/${v.id}/${v.action}`, {}),
    onSuccess: refresh,
  })
  const escalateAll = useMutation({
    mutationFn: () => api.post<{ escalated: number }>('/api/v1/comms/grievances/escalate-overdue', { to_user_id: escalateTo }),
    onSuccess: refresh,
  })
  const saveSla = useMutation({
    mutationFn: () =>
      api.put('/api/v1/comms/grievance-sla', {
        category: sla.category,
        department: sla.department || undefined,
        respond_hours: sla.respond_hours,
        resolve_hours: sla.resolve_hours,
      }),
    onSuccess: refresh,
  })

  const rows = list.data?.items ?? []
  const counts = list.data?.counts
  const patterns = summary.data?.items ?? []
  const openCount = counts ? counts.new + counts.acknowledged + counts.in_progress : 0
  const liveRows = rows.filter((g) => !settledStage(g.stage))
  const breached = liveRows.filter((g) => g.resolve_breached || g.respond_breached).length
  const toEscalate = liveRows.filter((g) => g.resolve_breached && !g.escalated).length
  const unanswered = liveRows.reduce((a, g) => a + (g.unanswered_replies > 0 ? 1 : 0), 0)

  const detailRef = useRef<HTMLDivElement>(null)
  const openCase = (id: string | null) => {
    setSelected(id)
    if (id) requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const quickActions = (g: Grievance) => mayWork && !settledStage(g.stage) && (
    <>
      {g.stage === 'new' && (
        <Button size="sm" variant="secondary" disabled={quick.isPending}
          onClick={() => quick.mutate({ id: g.id, action: 'acknowledge' })}>Acknowledge</Button>
      )}
      {(g.stage === 'new' || g.stage === 'acknowledged') && (
        <Button size="sm" variant="secondary" disabled={quick.isPending}
          onClick={() => quick.mutate({ id: g.id, action: 'start' })}>Start</Button>
      )}
    </>
  )

  const flags = (g: Grievance) => (
    <>
      {g.names_staff && <Badge tone="danger" className="ml-2">About a member of staff</Badge>}
      {g.escalated && <Badge tone="warning" className="ml-2">Escalated</Badge>}
      {g.reopened_count > 0 && <Badge tone="warning" className="ml-2">Reopened</Badge>}
      {g.unanswered_replies > 0 && !settledStage(g.stage) && (
        <Badge tone="primary" className="ml-2">
          {g.unanswered_replies === 1 ? 'New reply' : `${g.unanswered_replies} new replies`}
        </Badge>
      )}
    </>
  )

  return (
    <>
      <PageHead
        eyebrow="Communication"
        title="Parent feedback & grievances"
        description="Every concern a parent or student has raised, who owns it, and whether the school kept the date it promised."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Open cases" value={openCount} icon={Timer} hint={counts ? `${counts.new} not yet acknowledged` : undefined} />
          <Stat label="Past their deadline" value={breached} icon={AlertTriangle} hint="Open now, reply or resolution late" />
          <Stat label="Waiting on the school" value={unanswered} icon={MessageCircleReply} hint="The raiser wrote back since the last update" />
          <Stat label="About a member of staff" value={rows.filter((g) => g.names_staff).length} icon={ShieldAlert} hint="Hidden from the person named" />
        </CellGrid>

        {mayWork && toEscalate > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-[var(--card-pad)] py-3 text-[14px]">
            <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden />
            <span className="font-medium">
              {toEscalate} {toEscalate === 1 ? 'concern is' : 'concerns are'} past the resolution deadline and not escalated.
            </span>
            <div className="min-w-[14rem]">
              <Select value={escalateTo} onChange={setEscalateTo} placeholder="Escalate to…" options={peopleOptions} />
            </div>
            <Button size="sm" tone="danger" disabled={!escalateTo || escalateAll.isPending} onClick={() => escalateAll.mutate()}>
              Escalate all
            </Button>
            <FormNotice error={escalateAll.error} ok={escalateAll.data ? `${escalateAll.data.escalated} escalated.` : undefined} />
          </div>
        )}

        <Card>
          <CardHeader
            title="The pipeline"
            action={
              <div className={SEG_BAR} role="group" aria-label="View">
                <button type="button" className={cn(segClass(view === 'list'), 'inline-flex items-center gap-1.5')} aria-pressed={view === 'list'} onClick={() => setView('list')}>
                  <ListIcon className="h-3.5 w-3.5" aria-hidden /> List
                </button>
                <button type="button" className={cn(segClass(view === 'board'), 'inline-flex items-center gap-1.5')} aria-pressed={view === 'board'} onClick={() => setView('board')}>
                  <LayoutGrid className="h-3.5 w-3.5" aria-hidden /> Board
                </button>
              </div>
            }
          />
          <div className="flex flex-wrap items-center gap-2 border-b px-[var(--card-pad)] py-3">
            {view === 'list' && <StageBar counts={counts} value={stage} onChange={setStage} />}
            <div className="min-w-[10rem]">
              <Select value={category} onChange={setCategory} placeholder="Any category"
                options={[{ value: '', label: 'Any category' }, ...CATEGORIES.map((c) => ({ value: c, label: c }))]} />
            </div>
            <div className="min-w-[12rem] flex-1 sm:max-w-[16rem]">
              <Input value={search} onChange={setSearch} placeholder="Search subject or name" />
            </div>
            <Button variant={mine ? 'primary' : 'secondary'} size="sm" onClick={() => setMine(!mine)}>Assigned to me</Button>
            <Button variant={overdue ? 'primary' : 'secondary'} size="sm" onClick={() => setOverdue(!overdue)}>Past deadline</Button>
          </div>
          {list.isLoading ? (
            <SkeletonTable columns={6} />
          ) : list.error ? (
            <ErrorState error={list.error} />
          ) : view === 'board' ? (
            <div className="grid gap-3 overflow-x-auto p-[var(--card-pad)] md:grid-cols-5">
              {STAGES.map((s) => {
                const col = rows.filter((g) => g.stage === s)
                return (
                  <section key={s} className="min-w-[13rem] rounded-md bg-muted/50 p-2" aria-label={STAGE_LABEL[s]}>
                    <h4 className="mb-2 flex items-center justify-between px-1 text-[13px] font-semibold">
                      {STAGE_LABEL[s]}
                      <span className="tabular-nums text-[12px] font-normal text-muted-foreground">{counts?.[s] ?? col.length}</span>
                    </h4>
                    <div className="space-y-2">
                      {col.length === 0 && <p className="px-1 py-2 text-[12px] text-muted-foreground">None</p>}
                      {col.map((g) => (
                        <div key={g.id} className={cn('rounded-md border bg-card p-2.5 text-[13px] shadow-sm', selected === g.id && 'ring-2 ring-primary')}>
                          <button type="button" className="block w-full text-left" onClick={() => openCase(g.id)}>
                            <div className="font-medium leading-snug">{g.subject}</div>
                            <div className="mt-1 text-[12px] text-muted-foreground">
                              {g.raised_by}{g.student ? ` · ${g.student}` : ''} · {g.category}
                            </div>
                            <div className="mt-1 text-[12px] text-muted-foreground">{g.assigned_to ? `Owner: ${g.assigned_to}` : 'No owner yet'}</div>
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {(g.resolve_breached || g.respond_breached) && !settledStage(g.stage) && <Badge tone="danger">Late</Badge>}
                              {g.escalated && <Badge tone="warning">Escalated</Badge>}
                              {g.unanswered_replies > 0 && !settledStage(g.stage) && <Badge tone="primary">New reply</Badge>}
                              {g.satisfaction ? <Stars value={g.satisfaction} /> : null}
                            </div>
                          </button>
                          {quickActions(g) && <div className="mt-2 flex flex-wrap gap-1.5">{quickActions(g)}</div>}
                        </div>
                      ))}
                    </div>
                  </section>
                )
              })}
            </div>
          ) : (
            <Table
              head={['Concern', 'Category', 'Owner', 'Deadline', 'Stage', '']}
              empty={rows.length === 0}
              emptyLabel="Nothing here."
            >
              {rows.map((g) => (
                <tr key={g.id} className={selected === g.id ? 'bg-accent/40' : undefined}>
                  <Td>
                    <button type="button" className="text-left font-medium hover:underline" onClick={() => openCase(g.id)}>{g.subject}</button>
                    {flags(g)}
                    <span className="block text-[13px] text-muted-foreground">
                      {g.raised_by}{g.student ? ` · ${g.student}` : ''} · {formatDate(g.created_at)}
                    </span>
                  </Td>
                  <Td>{g.category}</Td>
                  <Td>
                    {g.assigned_to ?? <span className="text-muted-foreground">No owner</span>}
                    {g.department && <span className="block text-[13px] text-muted-foreground">{g.department}</span>}
                  </Td>
                  <Td>
                    <SlaCell respondDue={g.respond_due_at} resolveDue={g.resolve_due_at}
                      respondBreached={g.respond_breached} resolveBreached={g.resolve_breached}
                      acknowledged={!!g.acknowledged_at} settled={settledStage(g.stage)} />
                  </Td>
                  <Td><StageBadge stage={g.stage} /></Td>
                  <Td>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {quickActions(g)}
                      <Button size="sm" variant="ghost" onClick={() => openCase(g.id)}>Open</Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <div ref={detailRef} className="scroll-mt-4">
          {selected && (
            <CaseCard key={selected} id={selected} mayWork={mayWork} peopleOptions={peopleOptions}
              onClose={() => openCase(null)} onChanged={refresh} />
          )}
        </div>

        <Card>
          <CardHeader
            title="What recurs, and what takes longest"
            description="The queue tells you what is open today. This is the half a governing body asks about."
          />
          {summary.isLoading ? (
            <SkeletonTable columns={9} />
          ) : summary.error ? (
            <ErrorState error={summary.error} />
          ) : (
            <Table
              head={[
                'Category', 'Total', 'Open', 'Missed deadline', 'Median to resolve',
                'Avg first response', 'Usual owner', 'Avg rating',
              ]}
              empty={patterns.length === 0}
              emptyLabel="No concerns filed in the last year."
            >
              {patterns.map((p) => (
                <tr key={p.category}>
                  <Td>{p.category}</Td>
                  <Td>{p.total}</Td>
                  <Td>{p.open}</Td>
                  <Td>
                    {p.breached > 0 ? (
                      <Badge tone="danger">{p.breached}</Badge>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </Td>
                  <Td>{days(p.median_days)}</Td>
                  <Td>{hrs(p.avg_first_response_hours)}</Td>
                  <Td>{p.department ?? '-'}</Td>
                  <Td>{p.avg_satisfaction ? p.avg_satisfaction.toFixed(1) : '-'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="What the school promises"
            description="The deadline stamped onto a case at triage. Changing it here does not move deadlines already given."
          />
          <Table loading={slas.isLoading}
            head={['Category', 'First response', 'Resolution', 'Owner', 'Department', 'Active']}
            empty={(slas.data?.items.length ?? 0) === 0}
            emptyLabel="No promises set, cases will be triaged without a deadline."
          >
            {slas.data?.items.map((p) => (
              <tr key={p.category}>
                <Td>{p.category}</Td>
                <Td>{p.respond_hours}h</Td>
                <Td>{p.resolve_hours}h</Td>
                <Td>{p.default_owner ?? '-'}</Td>
                <Td>{p.department ?? '-'}</Td>
                <Td>
                  <Badge tone={p.is_active ? 'success' : 'neutral'}>
                    {p.is_active ? 'yes' : 'no'}
                  </Badge>
                </Td>
              </tr>
            ))}
          </Table>

          {mayWork && (
            <div className="space-y-4 border-t p-5">
              <FormGrid>
                <Field label="Category" required>
                  <Select
                    value={sla.category}
                    onChange={(v) => setSla({ ...sla, category: v })}
                    options={CATEGORIES.map((c) => ({ value: c, label: c }))}
                  />
                </Field>
                <Field label="Department">
                  <Input
                    value={sla.department}
                    onChange={(v) => setSla({ ...sla, department: v })}
                    placeholder="Transport office"
                  />
                </Field>
                <Field label="First response within (hours)" required>
                  <Input
                    type="number"
                    value={String(sla.respond_hours)}
                    onChange={(v) => setSla({ ...sla, respond_hours: Number(v) || 0 })}
                  />
                </Field>
                <Field label="Resolved within (hours)" required>
                  <Input
                    type="number"
                    value={String(sla.resolve_hours)}
                    onChange={(v) => setSla({ ...sla, resolve_hours: Number(v) || 0 })}
                  />
                </Field>
              </FormGrid>
              <Button disabled={saveSla.isPending} onClick={() => saveSla.mutate()}>
                Save promise
              </Button>
              <FormNotice error={saveSla.error} ok={saveSla.isSuccess ? 'Saved.' : undefined} />
            </div>
          )}
        </Card>
      </PageBody>
    </>
  )
}

/* One case. Keyed on the id, so nothing typed about one family's complaint
   survives into the next: a reply box carried over is one family reading
   what was written about another's case. The reply and the internal note are
   two separate boxes with two separate buttons, so a note cannot be sent to
   the raiser by a missed checkbox. */
function CaseCard({
  id, mayWork, peopleOptions, onClose, onChanged,
}: {
  id: string
  mayWork: boolean
  peopleOptions: { value: string; label: string }[]
  onClose: () => void
  onChanged: () => void
}) {
  const detail = useQuery({
    queryKey: commsQueryKeys.grievance(id),
    queryFn: () => api.get<Detail>(`/api/v1/comms/grievances/${id}`), staleTime: 0,
  })
  const timeline = useQuery({
    queryKey: commsQueryKeys.grievanceTimeline(id),
    queryFn: () => api.get<List<Update>>(`/api/v1/comms/grievances/${id}/updates`), staleTime: 0,
  })
  const [reply, setReply] = useState('')
  const [note, setNote] = useState('')
  const [assignee, setAssignee] = useState('')
  const [escalateTo, setEscalateTo] = useState('')
  const [reason, setReason] = useState('')
  const [resolution, setResolution] = useState('')
  const [showEscalate, setShowEscalate] = useState(false)
  useEffect(() => { setAssignee(detail.data?.assigned_to_id ?? '') }, [detail.data?.assigned_to_id])

  const done = () => onChanged()
  const post = (path: string, body: unknown) => api.post(`/api/v1/comms/grievances/${id}/${path}`, body)
  const sendReply = useMutation({ mutationFn: (status?: string) => post('updates', { body: reply, visible_to_parent: true, new_status: status }), onSuccess: () => { setReply(''); done() } })
  const addNote = useMutation({ mutationFn: () => post('updates', { body: note, visible_to_parent: false }), onSuccess: () => { setNote(''); done() } })
  const act = useMutation({ mutationFn: (a: 'acknowledge' | 'start') => post(a, {}), onSuccess: done })
  const assign = useMutation({ mutationFn: () => api.put(`/api/v1/comms/grievances/${id}/assign`, { assigned_to: assignee }), onSuccess: done })
  const triage = useMutation({ mutationFn: (v: Record<string, unknown>) => api.put(`/api/v1/comms/grievances/${id}/triage`, v), onSuccess: done })
  const escalate = useMutation({ mutationFn: () => post('escalate', { to_user_id: escalateTo, reason }), onSuccess: () => { setReason(''); setShowEscalate(false); done() } })
  const resolve = useMutation({ mutationFn: (status: 'resolved' | 'closed') => post('resolve', { resolution, status }), onSuccess: () => { setResolution(''); done() } })

  if (detail.error) return <ErrorState error={detail.error} />
  if (!detail.data) return <SkeletonTable columns={3} />
  const d = detail.data
  const settled = settledStage(d.stage)

  return (
    <Card>
      <CardHeader
        title={d.subject}
        action={<Button variant="ghost" size="sm" onClick={onClose}>Close</Button>}
      />
      <div className="space-y-5 p-[var(--card-pad)]">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
          <StageBadge stage={d.stage} />
          <span>{d.category}</span>
          <span>Raised by {d.raised_by}{d.student ? ` about ${d.student}` : ''}, {formatDate(d.created_at)}</span>
          <span>{d.assigned_to ? `Owner: ${d.assigned_to}` : 'No owner yet'}</span>
          {d.escalated_to && <span>Escalated to {d.escalated_to}</span>}
          {d.reopened_count > 0 && <Badge tone="warning">Reopened {d.reopened_count}x</Badge>}
          {d.satisfaction ? <span className="inline-flex items-center gap-1">Rated <Stars value={d.satisfaction} /></span> : null}
        </div>
        <SlaCell respondDue={d.respond_due_at} resolveDue={d.resolve_due_at}
          respondBreached={d.respond_breached} resolveBreached={d.resolve_breached}
          acknowledged={!!d.acknowledged_at} settled={settled} />
        <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{d.body}</p>
        <AttachmentLink file={d.attachment} />
        {d.subject_staff && (
          <p className="rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
            This grievance names {d.subject_staff}. They cannot see it, and it
            cannot be assigned or escalated to them.
          </p>
        )}
        {d.satisfaction_note && <p className="text-[13px] text-muted-foreground">Their comment on the answer: {d.satisfaction_note}</p>}

        {mayWork && !settled && (
          <>
            <div className="flex flex-wrap gap-2">
              {d.stage === 'new' && <Button size="sm" variant="secondary" disabled={act.isPending} onClick={() => act.mutate('acknowledge')}>Acknowledge</Button>}
              {(d.stage === 'new' || d.stage === 'acknowledged') && <Button size="sm" variant="secondary" disabled={act.isPending} onClick={() => act.mutate('start')}>Start work</Button>}
              <Button size="sm" variant="secondary" onClick={() => setShowEscalate(!showEscalate)}>Escalate</Button>
            </div>
            <FormNotice error={act.error} />

            <FormGrid>
              <Field label="Owner" hint="The person answerable for this case. They are notified.">
                <div className="flex gap-2">
                  <div className="min-w-0 flex-1"><Select value={assignee} onChange={setAssignee} placeholder="Choose a member of staff" options={peopleOptions} /></div>
                  <Button size="sm" disabled={!assignee || assignee === d.assigned_to_id || assign.isPending} onClick={() => assign.mutate()}>Assign</Button>
                </div>
              </Field>
              <Field label="Priority">
                <Select value={d.priority} onChange={(v) => triage.mutate({ priority: v })}
                  options={['low', 'normal', 'high', 'urgent'].map((p) => ({ value: p, label: p }))} />
              </Field>
              <Field label="Category" hint="Changing it applies that category's deadlines if none were set.">
                <Select value={d.category} onChange={(v) => triage.mutate({ category: v })}
                  options={CATEGORIES.map((c) => ({ value: c, label: c }))} />
              </Field>
            </FormGrid>
            <FormNotice error={assign.error ?? triage.error} />

            {showEscalate && (
              <div className="space-y-3 rounded-md border border-warning/40 bg-warning/5 p-3">
                <FormGrid>
                  <Field label="Escalate to" required>
                    <Select value={escalateTo} onChange={setEscalateTo} placeholder="Choose a senior member of staff" options={peopleOptions} />
                  </Field>
                  <Field label="Why" required wide>
                    <Textarea rows={2} value={reason} onChange={setReason} />
                  </Field>
                </FormGrid>
                <Button size="sm" disabled={!escalateTo || !reason.trim() || escalate.isPending} onClick={() => escalate.mutate()}>Escalate</Button>
                <FormNotice error={escalate.error} />
              </div>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <Field label="Reply to the raiser" hint="They see this and are notified.">
                  <Textarea rows={3} value={reply} onChange={setReply} />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={!reply.trim() || sendReply.isPending} onClick={() => sendReply.mutate(undefined)}>Send reply</Button>
                  <Button size="sm" variant="secondary" disabled={!reply.trim() || sendReply.isPending} onClick={() => sendReply.mutate('waiting')}>Send and wait for them</Button>
                </div>
                <FormNotice error={sendReply.error} />
              </div>
              <div className="space-y-2">
                <Field label="Internal note" hint="Stays inside the school. Never shown to the raiser.">
                  <Textarea rows={3} value={note} onChange={setNote} />
                </Field>
                <Button size="sm" variant="secondary" disabled={!note.trim() || addNote.isPending} onClick={() => addNote.mutate()}>Add note</Button>
                <FormNotice error={addNote.error} />
              </div>
            </div>

            <div className="space-y-2 border-t pt-4">
              <Field label="Resolution" hint="Always sent to the raiser, who can rate it or reopen it within 14 days.">
                <Textarea value={resolution} onChange={setResolution} rows={3} />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button disabled={!resolution.trim() || resolve.isPending} onClick={() => resolve.mutate('resolved')}>Resolve</Button>
                <Button variant="secondary" disabled={!resolution.trim() || resolve.isPending} onClick={() => resolve.mutate('closed')}>Close without resolving</Button>
              </div>
              <FormNotice error={resolve.error} />
            </div>
          </>
        )}
        {settled && d.resolution && (
          <div className="rounded-md bg-success/10 px-3 py-2 text-[14px]"><span className="font-medium">Resolution: </span>{d.resolution}</div>
        )}

        <div className="border-t pt-4">
          <h4 className="mb-3 flex items-center gap-2 text-[14px] font-semibold"><Inbox className="h-4 w-4" aria-hidden /> Timeline</h4>
          {timeline.isLoading ? <SkeletonTable columns={2} /> : (
            <Timeline office items={(timeline.data?.items ?? []).map((u) => ({ ...u, visible: u.visible_to_parent }))} />
          )}
        </div>
      </div>
    </Card>
  )
}
