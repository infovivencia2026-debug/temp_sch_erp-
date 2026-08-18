import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ShieldAlert, Timer } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { formatDate } from '@/lib/utils'
import { commsQueryKeys } from './comms-keys'

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
  department?: string
  assigned_to?: string
  names_staff: boolean
  created_at: string
  respond_due_at?: string
  resolve_due_at?: string
  acknowledged_at?: string
  resolved_at?: string
  escalated: boolean
  overdue_hours?: number
  open_days: number
  satisfaction?: number
}

interface Detail extends Grievance {
  body: string
  resolution?: string
  subject_staff?: string
  satisfaction_note?: string
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

const STATUS_TONE: Record<string, 'neutral' | 'danger' | 'warning' | 'success' | 'info'> = {
  open: 'warning',
  in_progress: 'info',
  waiting: 'neutral',
  resolved: 'success',
  closed: 'neutral',
}

const hrs = (n?: number) => (n == null ? '—' : `${Math.round(n)}h`)
const days = (n?: number) => (n == null ? '—' : `${n.toFixed(1)}d`)

export default function GrievanceHub() {
  const qc = useQueryClient()
  const can = useCan()
  const mayWork = can('office.front_desk.write')

  const [status, setStatus] = useState('')
  const [category, setCategory] = useState('')
  const [overdue, setOverdue] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [note, setNote] = useState({ body: '', visible_to_parent: false, new_status: '' })
  const [resolution, setResolution] = useState('')

  /* Opening another case empties what was written about this one.

     The note and the resolution live here rather than in a keyed panel, and
     `selected` is only an id — so an update written about one family's
     complaint stayed in the box when the clerk opened the next, and Add posted
     it there. The note carries `visible_to_parent`, so the worst version of
     that is one family reading what was written about another's case. */
  const openCase = (id: string | null) => {
    setSelected(id)
    setNote({ body: '', visible_to_parent: false, new_status: '' })
    setResolution('')
  }
  const [sla, setSla] = useState({
    category: 'safety', department: '', respond_hours: 4, resolve_hours: 48,
  })

  const list = useQuery({
    queryKey: commsQueryKeys.grievances(status, category, overdue),
    queryFn: () =>
      api.get<List<Grievance>>(
        `/api/v1/comms/grievances/?status=${status}&category=${category}` +
          `&overdue=${overdue ? 'true' : ''}`,
      ),
  })
  const summary = useQuery({
    queryKey: commsQueryKeys.grievanceSummary(),
    queryFn: () => api.get<List<Pattern>>('/api/v1/comms/grievances/summary'),
  })
  const slas = useQuery({
    queryKey: commsQueryKeys.grievanceSLA(),
    queryFn: () => api.get<List<SLA>>('/api/v1/comms/grievance-sla/'),
  })
  const detail = useQuery({
    queryKey: commsQueryKeys.grievance(selected),
    queryFn: () => api.get<Detail>(`/api/v1/comms/grievances/${selected}`),
    enabled: !!selected,
  })
  const timeline = useQuery({
    queryKey: commsQueryKeys.grievanceTimeline(selected),
    queryFn: () => api.get<List<Update>>(`/api/v1/comms/grievances/${selected}/updates`),
    enabled: !!selected,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: commsQueryKeys.grievanceRoot() })
  }

  const triage = useMutation({
    mutationFn: (v: Record<string, unknown>) =>
      api.put(`/api/v1/comms/grievances/${selected}/triage`, v),
    onSuccess: refresh,
  })
  const addNote = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/comms/grievances/${selected}/updates`, {
        body: note.body,
        visible_to_parent: note.visible_to_parent,
        new_status: note.new_status || undefined,
      }),
    onSuccess: () => {
      setNote({ body: '', visible_to_parent: false, new_status: '' })
      refresh()
    },
  })
  const acknowledge = useMutation({
    mutationFn: () => api.post(`/api/v1/comms/grievances/${selected}/acknowledge`, {}),
    onSuccess: refresh,
  })
  const resolve = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/comms/grievances/${selected}/resolve`, { resolution }),
    onSuccess: () => {
      setResolution('')
      refresh()
    },
  })
  const saveSla = useMutation({
    mutationFn: () =>
      api.put('/api/v1/comms/grievance-sla/', {
        category: sla.category,
        department: sla.department || undefined,
        respond_hours: sla.respond_hours,
        resolve_hours: sla.resolve_hours,
      }),
    onSuccess: refresh,
  })

  const rows = list.data?.items ?? []
  const patterns = summary.data?.items ?? []
  const openCount = rows.filter((g) => !g.resolved_at).length
  const breached = patterns.reduce((a, p) => a + p.breached, 0)
  const sensitive = rows.filter((g) => g.names_staff).length

  return (
    <>
      <PageHead
        eyebrow="Communication"
        title="Parent feedback & grievances"
        description="Every concern a family has raised, who owns it, and whether the school kept the date it promised."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Open cases" value={openCount} icon={Timer} />
          <Stat
            label="Past their deadline"
            value={breached}
            icon={AlertTriangle}
            hint="Across the last 12 months"
          />
          <Stat
            label="About a member of staff"
            value={sensitive}
            icon={ShieldAlert}
            hint="Hidden from the person named"
          />
          <Stat
            label="Categories in play"
            value={patterns.length}
            hint="Where the complaints actually come from"
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="What recurs, and what takes longest"
            description="The queue tells you what is open today. This is the half a governing body asks about."
          />
          {summary.isLoading ? (
            <Loading />
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
                  <Td>{p.department ?? '—'}</Td>
                  <Td>{p.avg_satisfaction ? p.avg_satisfaction.toFixed(1) : '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="The queue"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={status}
                  onChange={setStatus}
                  placeholder="Any status"
                  options={[
                    { value: 'open', label: 'Open' },
                    { value: 'in_progress', label: 'In progress' },
                    { value: 'waiting', label: 'Waiting' },
                    { value: 'resolved', label: 'Resolved' },
                    { value: 'closed', label: 'Closed' },
                  ]}
                />
                <Select
                  value={category}
                  onChange={setCategory}
                  placeholder="Any category"
                  options={CATEGORIES.map((c) => ({ value: c, label: c }))}
                />
                <Button
                  variant={overdue ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setOverdue(!overdue)}
                >
                  Past deadline only
                </Button>
              </div>
            }
          />
          {list.isLoading ? (
            <Loading />
          ) : list.error ? (
            <ErrorState error={list.error} />
          ) : (
            <Table
              head={['Raised', 'Subject', 'Category', 'Family', 'Owner', 'Due', 'Status', '']}
              empty={rows.length === 0}
              emptyLabel="Nothing in the queue."
            >
              {rows.map((g) => (
                <tr key={g.id}>
                  <Td>{formatDate(g.created_at)}</Td>
                  <Td>
                    <span className="font-medium">{g.subject}</span>
                    {g.names_staff && (
                      <span className="ml-2">
                        <Badge tone="danger" solid>
                          About a member of staff
                        </Badge>
                      </span>
                    )}
                    {g.escalated && (
                      <span className="ml-2">
                        <Badge tone="warning" solid>
                          Escalated
                        </Badge>
                      </span>
                    )}
                  </Td>
                  <Td>{g.category}</Td>
                  <Td>
                    {g.raised_by}
                    {g.student && (
                      <span className="block text-[13px] text-muted-foreground">{g.student}</span>
                    )}
                  </Td>
                  <Td>{g.assigned_to ?? <span className="text-muted-foreground">—</span>}</Td>
                  <Td>
                    {g.resolve_due_at ? (
                      <>
                        {formatDate(g.resolve_due_at)}
                        {g.overdue_hours != null && g.overdue_hours > 0 && !g.resolved_at && (
                          <span className="block text-[13px] text-destructive">
                            {Math.round(g.overdue_hours)}h late
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">not triaged</span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[g.status] ?? 'neutral'}>{g.status}</Badge>
                  </Td>
                  <Td>
                    <Button size="sm" variant="ghost" onClick={() => openCase(g.id)}>
                      Open
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {selected && detail.error && <ErrorState error={detail.error} />}
        {selected && detail.data && (
          <Card>
            <CardHeader
              title={detail.data.subject}
              description={`${detail.data.category} · raised by ${detail.data.raised_by} · ${detail.data.open_days} days old`}
              action={
                <Button variant="ghost" size="sm" onClick={() => openCase(null)}>
                  Close
                </Button>
              }
            />
            <div className="space-y-5 p-5">
              <p className="whitespace-pre-wrap text-[14px] leading-relaxed">
                {detail.data.body}
              </p>
              {detail.data.subject_staff && (
                <p className="rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
                  This grievance names {detail.data.subject_staff}. They cannot see it, and it
                  cannot be assigned or escalated to them.
                </p>
              )}

              {mayWork && (
                <>
                  <FormGrid>
                    <Field label="Category">
                      <Select
                        value={detail.data.category}
                        onChange={(v) => triage.mutate({ category: v })}
                        options={CATEGORIES.map((c) => ({ value: c, label: c }))}
                      />
                    </Field>
                    <Field label="Priority">
                      <Select
                        value={detail.data.priority}
                        onChange={(v) => triage.mutate({ priority: v })}
                        options={['low', 'normal', 'high', 'urgent'].map((p) => ({
                          value: p,
                          label: p,
                        }))}
                      />
                    </Field>
                  </FormGrid>
                  <FormNotice error={triage.error} />

                  <Field
                    label="Add to the timeline"
                    hint="A note stays inside the school. A reply is what the family sees."
                  >
                    <Textarea
                      value={note.body}
                      onChange={(v) => setNote({ ...note, body: v })}
                      rows={3}
                    />
                  </Field>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        checked={note.visible_to_parent}
                        onChange={(e) =>
                          setNote({ ...note, visible_to_parent: e.target.checked })
                        }
                      />
                      Show this to the family
                    </label>
                    <Select
                      value={note.new_status}
                      onChange={(v) => setNote({ ...note, new_status: v })}
                      placeholder="Leave status alone"
                      options={[
                        { value: 'open', label: 'Open' },
                        { value: 'in_progress', label: 'In progress' },
                        { value: 'waiting', label: 'Waiting on the family' },
                      ]}
                    />
                    <Button
                      size="sm"
                      disabled={!note.body.trim() || addNote.isPending}
                      onClick={() => addNote.mutate()}
                    >
                      Add
                    </Button>
                    {!detail.data.acknowledged_at && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => acknowledge.mutate()}
                      >
                        Acknowledge
                      </Button>
                    )}
                  </div>
                  <FormNotice error={addNote.error} />

                  {!detail.data.resolved_at && (
                    <>
                      <Field
                        label="Resolution"
                        hint="Always sent to the family. A case resolved with nothing said to them is the complaint that follows the complaint."
                      >
                        <Textarea value={resolution} onChange={setResolution} rows={3} />
                      </Field>
                      <Button
                        disabled={!resolution.trim() || resolve.isPending}
                        onClick={() => resolve.mutate()}
                      >
                        Resolve
                      </Button>
                      <FormNotice error={resolve.error} />
                    </>
                  )}
                </>
              )}

              <div className="border-t pt-4">
                <h4 className="mb-3 text-[14px] font-semibold">Timeline</h4>
                {timeline.isLoading ? (
                  <Loading />
                ) : (timeline.data?.items.length ?? 0) === 0 ? (
                  <EmptyState title="Nothing recorded yet." />
                ) : (
                  <ul className="space-y-3">
                    {timeline.data?.items.map((u) => (
                      <li key={u.id} className="text-[14px]">
                        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                          <span>{formatDate(u.created_at)}</span>
                          <span>{u.author ?? 'System'}</span>
                          <Badge tone={u.visible_to_parent ? 'info' : 'neutral'} solid>
                            {u.visible_to_parent ? 'Seen by family' : 'Internal'}
                          </Badge>
                        </div>
                        <p className="whitespace-pre-wrap">{u.body}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="What the school promises"
            description="The deadline stamped onto a case at triage. Changing it here does not move deadlines already given."
          />
          {slas.isLoading ? (
            <Loading />
          ) : (
            <Table
              head={['Category', 'First response', 'Resolution', 'Owner', 'Department', 'Active']}
              empty={(slas.data?.items.length ?? 0) === 0}
              emptyLabel="No promises set — cases will be triaged without a deadline."
            >
              {slas.data?.items.map((p) => (
                <tr key={p.category}>
                  <Td>{p.category}</Td>
                  <Td>{p.respond_hours}h</Td>
                  <Td>{p.resolve_hours}h</Td>
                  <Td>{p.default_owner ?? '—'}</Td>
                  <Td>{p.department ?? '—'}</Td>
                  <Td>
                    <Badge tone={p.is_active ? 'success' : 'neutral'}>
                      {p.is_active ? 'yes' : 'no'}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
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
