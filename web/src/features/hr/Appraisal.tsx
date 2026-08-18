import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Gauge, ScrollText, Scale, MessageSquare } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Field, FormGrid, FormNotice,
  Input, Select, Textarea, Loading, ErrorState, EmptyState,
} from '@/components/ui'

/* The annual KPI appraisal.

   HR's own instrument, and deliberately not the 360. A 360 collects several
   people's view of one person and is anonymous by construction; this produces
   one attributable number that an increment hangs off, and the reviewer is
   named because a judgement nobody will put their name to is not one a school
   can defend. Where a school runs both, the 360's published aggregate can be
   attached here as one input among several — a reference, never a join.

   Two invariants are visible on this screen because they are enforced below
   it. The weights for a role must total exactly 100, and the database refuses
   to raise an appraisal against a set that does not; and an employee sees
   their own appraisal and nobody else's, which is decided by the server from
   the session rather than by which rows this screen asks for. */

interface Cycle {
  id: string
  name: string
  academic_year?: string
  status: string
  opens_on?: string
  self_due_on?: string
  review_due_on?: string
  score_scale_max: number
  allow_360_input: boolean
  appraisals: number
  published: number
  unbalanced_roles: number
}

interface KPI {
  id: string
  cycle_id: string
  designation_id?: string
  designation?: string
  code: string
  title: string
  description?: string
  weight: number
  sequence: number
  source: string
}

interface Appraisal {
  id: string
  cycle: string
  employee_id: string
  employee_code: string
  full_name: string
  designation?: string
  department?: string
  reviewer?: string
  status: string
  self_score?: number
  reviewer_score?: number
  moderated_score?: number
  final_score?: number
  final_band?: string
  score_scale_max: number
  discussion_on?: string
  increment_percent?: number
  acknowledged: boolean
}

interface Designation { id: string; name: string }

const STATUS_LABEL: Record<string, string> = {
  not_started: 'Not started',
  self_submitted: 'Self-assessment in',
  reviewed: 'Reviewed',
  moderated: 'Moderated',
  published: 'Published',
  acknowledged: 'Acknowledged',
}

function statusTone(s: string) {
  if (s === 'acknowledged') return 'success' as const
  if (s === 'published') return 'primary' as const
  if (s === 'not_started') return 'neutral' as const
  return 'info' as const
}

const TABS = [
  ['cycles', 'Cycles', ScrollText],
  ['kpis', 'KPIs & weights', Scale],
  ['records', 'Appraisals', Gauge],
] as const

export default function Appraisal() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('cycles')
  const [cycle, setCycle] = useState('')

  const cycles = useQuery({
    queryKey: ['hr-growth', 'cycles'],
    queryFn: () => api.get<List<Cycle>>('/api/v1/hr-growth/appraisal/cycles'),
  })

  if (cycles.isLoading) return <Loading label="Reading the appraisal cycles…" />
  if (cycles.error) return <ErrorState error={cycles.error} />

  const all = cycles.data?.items ?? []
  const current = all.find((c) => c.id === cycle) ?? all[0]
  const unbalanced = all.reduce((n, c) => n + c.unbalanced_roles, 0)
  const raised = all.reduce((n, c) => n + c.appraisals, 0)
  const published = all.reduce((n, c) => n + c.published, 0)

  return (
    <>
      <PageHead
        eyebrow="Hiring & growth"
        title="Annual performance appraisal"
        description="A cycle per year, weighted KPIs per role, a self-assessment, the reviewer's rating, moderation, and the conversation that follows. Scores are visible to the person they are about and to the people who decide them — nobody else."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Cycles" value={all.length} icon={ScrollText} />
          <Stat label="Appraisals raised" value={raised} icon={Gauge} />
          <Stat label="Published" value={published}
            hint={raised ? `${raised - published} still in progress` : undefined} />
          <Stat label="Roles not adding to 100" value={unbalanced} icon={Scale}
            delta={unbalanced
              ? { value: 'No appraisal can be raised for these', positive: false }
              : { value: 'Every KPI set totals 100', positive: true }} />
        </CellGrid>

        <div className="flex flex-wrap gap-1 border-b">
          {TABS.map(([k, label, Icon]) => (
            <button key={k} type="button" onClick={() => setTab(k)} aria-current={tab === k}
              className={tab === k
                ? '-mb-px flex items-center gap-1.5 border-b-2 border-primary px-3 py-2 text-[14px] font-medium'
                : '-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-[14px] text-muted-foreground hover:text-foreground'}>
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>

        {tab === 'cycles' && <CyclesTab cycles={all} />}
        {tab === 'kpis' && <KPITab cycles={all} cycleID={current?.id ?? ''} onCycle={setCycle} />}
        {tab === 'records' && <RecordsTab cycles={all} cycleID={current?.id ?? ''} onCycle={setCycle} />}
      </PageBody>
    </>
  )
}

function CyclesTab({ cycles }: { cycles: Cycle[] }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [opensOn, setOpensOn] = useState('')
  const [selfDue, setSelfDue] = useState('')
  const [reviewDue, setReviewDue] = useState('')
  const [scale, setScale] = useState('5')

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/v1/hr-growth/appraisal/cycles', {
        name,
        opens_on: opensOn || undefined,
        self_due_on: selfDue || undefined,
        review_due_on: reviewDue || undefined,
        score_scale_max: Number(scale) || 5,
        status: 'self_assessment',
      }),
    onSuccess: () => {
      setName(''); setOpensOn(''); setSelfDue(''); setReviewDue('')
      qc.invalidateQueries({ queryKey: ['hr-growth'] })
    },
  })

  return (
    <>
      <Card>
        <CardHeader
          title="Open a cycle"
          description="One per academic year in most schools. The scale is the school's — five is the Indian norm, and changing it here changes one number rather than every screen."
        />
        <div className="space-y-5 p-5">
          <FormGrid>
            <Field label="Name" required><Input value={name} onChange={setName} placeholder="Annual 2026-27" /></Field>
            <Field label="Opens on"><Input value={opensOn} onChange={setOpensOn} type="date" /></Field>
            <Field label="Self-assessment due"><Input value={selfDue} onChange={setSelfDue} type="date" /></Field>
            <Field label="Review due"><Input value={reviewDue} onChange={setReviewDue} type="date" /></Field>
            <Field label="Scored out of"><Input value={scale} onChange={setScale} type="number" /></Field>
          </FormGrid>
          <FormNotice error={create.error} ok={create.isSuccess ? 'Cycle opened.' : undefined} />
          <Button onClick={() => create.mutate()} disabled={!name || create.isPending}>
            {create.isPending ? 'Opening…' : 'Open cycle'}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Cycles" />
        <Table head={['Cycle', 'Year', 'Status', 'Raised', 'Published', 'Weights']}
          empty={cycles.length === 0} emptyLabel="No cycle has been opened yet.">
          {cycles.map((c) => (
            <tr key={c.id}>
              <Td><span className="font-medium">{c.name}</span></Td>
              <Td>{c.academic_year ?? '—'}</Td>
              <Td><Badge tone={c.status === 'published' ? 'success' : 'info'}>
                {c.status.replace(/_/g, ' ')}
              </Badge></Td>
              <Td>{c.appraisals}</Td>
              <Td>{c.published}</Td>
              <Td>
                {c.unbalanced_roles === 0 ? (
                  <Badge tone="success">All total 100</Badge>
                ) : (
                  <Badge tone="danger">{c.unbalanced_roles} role(s) short</Badge>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  )
}

/* The weights.

   Edited as a whole set rather than row by row, because the invariant is
   about the set: every intermediate state of a per-row edit is invalid, and
   validating each write in isolation is how a set ends up at 97 with nobody
   able to say which row is wrong. The running total is shown as you type so
   the rule is visible before the save rather than after it. */
function KPITab({
  cycles, cycleID, onCycle,
}: { cycles: Cycle[]; cycleID: string; onCycle: (v: string) => void }) {
  const qc = useQueryClient()
  const [designation, setDesignation] = useState('')
  const [draft, setDraft] = useState<{ code: string; title: string; weight: string }[]>([])

  const designations = useQuery({
    queryKey: ['hr-growth', 'designations'],
    queryFn: () => api.get<List<Designation>>('/api/v1/hr-growth/designations'),
    retry: false,
  })
  const kpis = useQuery({
    queryKey: ['hr-growth', 'kpis', cycleID, designation],
    queryFn: () =>
      api.get<List<KPI>>(
        `/api/v1/hr-growth/appraisal/kpis?cycle_id=${cycleID}` +
          (designation ? `&designation_id=${designation}` : ''),
      ),
    enabled: !!cycleID,
  })

  const rows = draft.length
    ? draft
    : (kpis.data?.items ?? []).map((k) => ({
        code: k.code, title: k.title, weight: String(k.weight),
      }))

  const total = rows.reduce((n, r) => n + (Number(r.weight) || 0), 0)
  const balanced = total > 99.98 && total < 100.02

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/hr-growth/appraisal/kpis', {
        cycle_id: cycleID,
        designation_id: designation || undefined,
        kpis: rows.map((r) => ({ code: r.code, title: r.title, weight: Number(r.weight) })),
      }),
    onSuccess: () => {
      setDraft([])
      qc.invalidateQueries({ queryKey: ['hr-growth'] })
    },
  })

  const update = (i: number, field: 'code' | 'title' | 'weight', v: string) =>
    setDraft(rows.map((r, n) => (n === i ? { ...r, [field]: v } : r)))

  if (!cycleID) {
    return <Card><EmptyState title="Open a cycle first" body="KPIs belong to a cycle." /></Card>
  }

  return (
    <Card>
      <CardHeader
        title="KPIs and weights"
        description="A teacher's KPIs are not an accountant's. Leave the role unset to define the default set — what a role with no set of its own is appraised against."
        action={
          <div className="flex flex-wrap gap-2">
            <Select value={cycleID} onChange={onCycle}
              options={cycles.map((c) => ({ value: c.id, label: c.name }))} />
            <Select value={designation} onChange={(v) => { setDesignation(v); setDraft([]) }}
              placeholder="Default set (all roles)"
              options={(designations.data?.items ?? []).map((d) => ({ value: d.id, label: d.name }))} />
          </div>
        }
      />
      <div className="space-y-5 p-5">
        <Table head={['Code', 'KPI', { label: 'Weight %', align: 'right' }, '']}
          empty={rows.length === 0}
          emptyLabel="No KPIs defined for this role yet. Add the first one below.">
          {rows.map((r, i) => (
            <tr key={i}>
              <Td><Input value={r.code} onChange={(v) => update(i, 'code', v)} placeholder="TEACH" /></Td>
              <Td><Input value={r.title} onChange={(v) => update(i, 'title', v)} placeholder="Classroom practice" /></Td>
              <Td className="text-right">
                <Input value={r.weight} onChange={(v) => update(i, 'weight', v)} type="number" />
              </Td>
              <Td className="text-right">
                <Button size="sm" variant="ghost"
                  onClick={() => setDraft(rows.filter((_, n) => n !== i))}>
                  Remove
                </Button>
              </Td>
            </tr>
          ))}
        </Table>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm bg-muted px-4 py-3">
          <span className="text-[14px]">
            Weights total{' '}
            <span className={balanced ? 'font-semibold text-success' : 'font-semibold text-destructive'}>
              {total.toFixed(2)}
            </span>
            {!balanced && (
              <span className="ml-2 text-[13px] text-muted-foreground">
                — a set must total 100 before any appraisal can be raised against it
              </span>
            )}
          </span>
          <Button size="sm" variant="secondary"
            onClick={() => setDraft([...rows, { code: '', title: '', weight: '' }])}>
            Add a KPI
          </Button>
        </div>

        <FormNotice error={save.error} ok={save.isSuccess ? 'Weights saved.' : undefined} />
        <Button onClick={() => save.mutate()}
          disabled={!balanced || rows.length === 0 || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save this KPI set'}
        </Button>
      </div>
    </Card>
  )
}

function RecordsTab({
  cycles, cycleID, onCycle,
}: { cycles: Cycle[]; cycleID: string; onCycle: (v: string) => void }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState<Appraisal | null>(null)

  const records = useQuery({
    queryKey: ['hr-growth', 'records', cycleID],
    queryFn: () =>
      api.get<List<Appraisal>>(
        `/api/v1/hr-growth/appraisal/records${cycleID ? `?cycle_id=${cycleID}` : ''}`,
      ),
  })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['hr-growth'] })

  const raise = useMutation({
    mutationFn: () =>
      api.post<{ raised: number; skipped: { employee: string; reason: string }[] }>(
        '/api/v1/hr-growth/appraisal/records', { cycle_id: cycleID },
      ),
    onSuccess: invalidate,
  })

  const publish = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/hr-growth/appraisal/records/${id}/publish`, {}),
    onSuccess: invalidate,
  })

  const rows = records.data?.items ?? []

  return (
    <>
      <Card>
        <CardHeader
          title="Raise the cycle"
          description="Opens an appraisal for every active member of staff, each with a rating row per KPI carrying today's weight. A role whose weights do not total 100 is skipped and named, rather than failing the whole batch."
          action={
            <Select value={cycleID} onChange={onCycle}
              options={cycles.map((c) => ({ value: c.id, label: c.name }))} />
          }
        />
        <div className="space-y-4 p-5">
          <FormNotice error={raise.error} />
          {raise.data && (
            <div className="space-y-2 text-[14px]">
              <p className="text-success">{raise.data.raised} appraisal(s) raised.</p>
              {raise.data.skipped?.length > 0 && (
                <div className="rounded-sm bg-muted p-3">
                  <p className="mb-1 font-medium">Skipped:</p>
                  <ul className="space-y-0.5 text-[13px] text-muted-foreground">
                    {raise.data.skipped.map((s, i) => (
                      <li key={i}>{s.employee} — {s.reason}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <Button onClick={() => raise.mutate()} disabled={!cycleID || raise.isPending}>
            {raise.isPending ? 'Raising…' : 'Raise for all active staff'}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Appraisals"
          description="Only the ones you are entitled to see: the whole institution for HR, your own department if you head one, the ones you review, and your own."
        />
        <Table
          head={['Employee', 'Role', 'Reviewer', 'Status', { label: 'Score', align: 'right' }, '']}
          empty={rows.length === 0}
          emptyLabel="Nothing raised for this cycle yet."
        >
          {rows.map((a) => (
            <tr key={a.id}>
              <Td>
                <span className="font-medium">{a.full_name}</span>
                <span className="block text-[12.5px] text-muted-foreground">{a.employee_code}</span>
              </Td>
              <Td>
                {a.designation ?? '—'}
                {a.department && (
                  <span className="block text-[12.5px] text-muted-foreground">{a.department}</span>
                )}
              </Td>
              <Td>{a.reviewer ?? <span className="text-muted-foreground">Unassigned</span>}</Td>
              <Td><Badge tone={statusTone(a.status)}>{STATUS_LABEL[a.status] ?? a.status}</Badge></Td>
              <Td className="text-right">
                {a.final_score != null
                  ? <span className="font-medium">{a.final_score.toFixed(2)} / {a.score_scale_max}</span>
                  : a.moderated_score != null || a.reviewer_score != null
                    ? <span className="text-muted-foreground">
                        {(a.moderated_score ?? a.reviewer_score)!.toFixed(2)} provisional
                      </span>
                    : '—'}
              </Td>
              <Td className="text-right">
                <div className="flex flex-wrap justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setOpen(a)}>Open</Button>
                  {(a.status === 'reviewed' || a.status === 'moderated') && (
                    <Button size="sm" onClick={() => publish.mutate(a.id)}>Publish</Button>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      {open && <DiscussionCard appraisal={open} onDone={() => { setOpen(null); invalidate() }} />}
    </>
  )
}

/* The conversation.

   A score with no record of the discussion is the appraisal every teacher
   complains about, so recording it is a first-class action rather than a
   notes field somebody may or may not fill in. */
function DiscussionCard({ appraisal, onDone }: { appraisal: Appraisal; onDone: () => void }) {
  const [on, setOn] = useState(appraisal.discussion_on ?? '')
  const [note, setNote] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/hr-growth/appraisal/records/${appraisal.id}/discussion`, {
        discussion_on: on || undefined,
        note,
      }),
    onSuccess: onDone,
  })

  return (
    <Card>
      <CardHeader
        title={`Appraisal discussion — ${appraisal.full_name}`}
        description="What was actually said, and when. This is the part an appeal reads."
        action={<Button variant="ghost" size="sm" onClick={onDone}>Close</Button>}
      />
      <div className="space-y-5 p-5">
        <FormGrid>
          <Field label="Discussed on"><Input value={on} onChange={setOn} type="date" /></Field>
        </FormGrid>
        <Field label="Note of the conversation" wide>
          <Textarea value={note} onChange={setNote} rows={4}
            placeholder="Agreed to take the Class 9 remedial group next term; asked for training on the new assessment framework." />
        </Field>
        <FormNotice error={save.error} />
        <div className="flex items-center gap-2">
          <Button onClick={() => save.mutate()} disabled={!note.trim() || save.isPending}>
            {save.isPending ? 'Saving…' : 'Record the discussion'}
          </Button>
          <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <MessageSquare className="h-3.5 w-3.5" aria-hidden />
            {appraisal.acknowledged
              ? 'The employee has acknowledged this appraisal'
              : 'Awaiting the employee’s acknowledgement'}
          </span>
        </div>
      </div>
    </Card>
  )
}
