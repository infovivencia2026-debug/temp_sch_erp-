import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, DoorOpen, UtensilsCrossed } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* A warden's evening.

   The hostel module could allocate a bed and nothing else. The three things a
   warden does between allocations are letting boarders out, chasing repairs
   and feeding people — and the first is the one a school gets sued over.

   The board leads with who is out, because that is the question at lights-out
   and the only thing on this screen that can be an emergency. A pass needs two
   permissions, the warden's and a guardian's, and the gate cannot record a
   boarder leaving until it has both. */

interface Outpass {
  id: string
  student_name: string
  admission_no: string
  room?: string
  reason: string
  destination?: string
  escort_name?: string
  escort_phone?: string
  expected_out: string
  expected_in: string
  status: 'requested' | 'approved' | 'rejected' | 'out' | 'returned' | 'cancelled'
  approved_by?: string
  guardian_consent_by?: string
  actual_out?: string
  actual_in?: string
  decision_note?: string
  overdue: boolean
  overdue_minutes: number
}
interface Complaint {
  id: string
  student_name?: string
  room?: string
  category: string
  subject: string
  detail?: string
  priority: 'low' | 'normal' | 'high' | 'urgent'
  status: 'open' | 'in_progress' | 'resolved' | 'closed'
  assigned_to?: string
  resolution?: string
  raised_at: string
  open_days: number
}
interface Meal {
  meal: string
  items: string
  served_count?: number
  notes?: string
}

const MEALS = ['breakfast', 'lunch', 'snacks', 'dinner'] as const

const PASS_TONE: Record<Outpass['status'], 'neutral' | 'warning' | 'success' | 'danger'> = {
  requested: 'warning',
  approved: 'success',
  rejected: 'danger',
  out: 'warning',
  returned: 'neutral',
  cancelled: 'neutral',
}
const PRIORITY_TONE: Record<Complaint['priority'], 'neutral' | 'warning' | 'danger'> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warning',
  urgent: 'danger',
}

// A boarder two hours late is a different sentence from one ten minutes late.
function lateness(minutes: number) {
  if (minutes < 60) return `${minutes} min late`
  const h = Math.floor(minutes / 60)
  return `${h}h ${minutes % 60}m late`
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

export default function HostelLife() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'passes' | 'complaints' | 'mess'>('passes')

  const passes = useQuery({
    queryKey: ['outpasses'],
    queryFn: () => api.get<List<Outpass>>('/api/v1/ops/hostel/outpasses'),
  })

  const decide = useMutation({
    mutationFn: (v: { id: string; action: string; note?: string }) =>
      api.post(`/api/v1/ops/hostel/outpasses/${v.id}/decide`, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['outpasses'] }),
  })

  if (passes.isLoading) return <Loading label="Checking who is out…" />
  if (passes.error) return <ErrorState error={passes.error} />

  const rows = passes.data?.items ?? []
  const out = rows.filter((p) => p.status === 'out')
  const overdue = out.filter((p) => p.overdue)
  const waiting = rows.filter((p) => p.status === 'requested')

  return (
    <>
      <PageHead
        eyebrow="Hostel"
        title="Outpasses, complaints and the mess"
        description="Who is off campus and who said they could be, what is broken, and what is being served."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Out now" value={out.length} icon={DoorOpen} />
          <Stat
            label="Overdue"
            value={overdue.length}
            icon={AlertTriangle}
            delta={
              overdue.length
                ? { value: 'Past their expected return', positive: false }
                : { value: 'Everyone back on time', positive: true }
            }
          />
          <Stat label="Waiting on a warden" value={waiting.length} />
          <Stat label="Passes this term" value={rows.length} />
        </CellGrid>

        {overdue.length > 0 && (
          <Card>
            <CardHeader
              title="Overdue"
              description="Out and past the hour they said they would be back. The escort's number is here so it does not have to be looked up."
            />
            <ul className="divide-y">
              {overdue.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-[14rem] flex-1">
                    <div className="font-medium">
                      {p.student_name}
                      {p.room && <span className="text-muted-foreground"> · Room {p.room}</span>}
                    </div>
                    <div className="text-[13px] text-muted-foreground">
                      {p.destination ?? p.reason}
                      {p.escort_name && ` · with ${p.escort_name}`}
                      {p.escort_phone && ` · ${p.escort_phone}`}
                    </div>
                  </div>
                  <Badge tone="danger">{lateness(p.overdue_minutes)}</Badge>
                  <Button
                    size="sm"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: p.id, action: 'in' })}
                  >
                    Mark returned
                  </Button>
                </li>
              ))}
            </ul>
            <FormNotice error={decide.error} />
          </Card>
        )}

        <div className="flex gap-1 border-b">
          {(
            [
              ['passes', 'Outpasses'],
              ['complaints', 'Complaints'],
              ['mess', 'Mess menu'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              aria-current={tab === k}
              className={
                tab === k
                  ? '-mb-px border-b-2 border-primary px-3 py-2 text-[14px] font-medium'
                  : '-mb-px border-b-2 border-transparent px-3 py-2 text-[14px] text-muted-foreground hover:text-foreground'
              }
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'passes' && (
          <PassBoard rows={rows} pending={decide.isPending} onDecide={decide.mutate} error={decide.error} />
        )}
        {tab === 'complaints' && <Complaints />}
        {tab === 'mess' && <Mess />}
      </PageBody>
    </>
  )
}

function PassBoard({
  rows,
  pending,
  onDecide,
  error,
}: {
  rows: Outpass[]
  pending: boolean
  onDecide: (v: { id: string; action: string; note?: string }) => void
  error: unknown
}) {
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [note, setNote] = useState('')

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No outpasses yet"
        body="A boarder or their guardian requests a pass; a warden permits it, the guardian consents, and the gate records the leaving."
      />
    )
  }

  return (
    <Card>
      <CardHeader
        title="Passes"
        description="Overdue first, then whoever is out. A pass needs both a warden's permission and a guardian's consent before the gate can let a boarder leave."
      />
      <Table
        head={[
          { label: 'Boarder' },
          { label: 'Going to' },
          { label: 'Out' },
          { label: 'Back' },
          { label: 'Permissions' },
          { label: 'Status' },
          { label: '' },
        ]}
      >
        {rows.map((p) => (
          <tr key={p.id}>
            <Td className="font-medium">
              {p.student_name}
              <div className="text-[12px] font-normal text-muted-foreground">
                {p.admission_no}
                {p.room && ` · Room ${p.room}`}
              </div>
            </Td>
            <Td>
              {p.destination ?? '—'}
              <div className="text-[12px] text-muted-foreground">{p.reason}</div>
            </Td>
            <Td className="text-muted-foreground">{formatDate(p.expected_out)}</Td>
            <Td className="text-muted-foreground">{formatDate(p.expected_in)}</Td>
            <Td>
              <div className="text-[12px]">
                <div className={p.approved_by ? '' : 'text-muted-foreground'}>
                  {p.approved_by ? `Warden: ${p.approved_by}` : 'Warden: not yet'}
                </div>
                <div className={p.guardian_consent_by ? '' : 'text-muted-foreground'}>
                  {p.guardian_consent_by
                    ? `Guardian: ${p.guardian_consent_by}`
                    : 'Guardian: not yet'}
                </div>
              </div>
            </Td>
            <Td>
              <Badge tone={p.overdue ? 'danger' : PASS_TONE[p.status]}>
                {p.overdue ? lateness(p.overdue_minutes) : p.status}
              </Badge>
            </Td>
            <Td>
              <div className="flex flex-wrap gap-1">
                {p.status === 'requested' && (
                  <>
                    <Button size="sm" disabled={pending} onClick={() => onDecide({ id: p.id, action: 'approve' })}>
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => {
                        setRejecting(p.id)
                        setNote('')
                      }}
                    >
                      Refuse
                    </Button>
                  </>
                )}
                {p.status === 'approved' && p.guardian_consent_by && (
                  <Button size="sm" disabled={pending} onClick={() => onDecide({ id: p.id, action: 'out' })}>
                    Sign out
                  </Button>
                )}
                {p.status === 'approved' && !p.guardian_consent_by && (
                  <span className="text-[12px] text-muted-foreground">Waiting on the guardian</span>
                )}
                {p.status === 'out' && (
                  <Button size="sm" disabled={pending} onClick={() => onDecide({ id: p.id, action: 'in' })}>
                    Sign in
                  </Button>
                )}
              </div>
              {rejecting === p.id && (
                <div className="mt-2 space-y-2">
                  <Input
                    value={note}
                    placeholder="Why it is being refused"
                    onChange={setNote}
                  />
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      tone="danger"
                      disabled={pending || note.trim() === ''}
                      onClick={() => {
                        onDecide({ id: p.id, action: 'reject', note })
                        setRejecting(null)
                      }}
                    >
                      Refuse pass
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRejecting(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      <FormNotice error={error} />
    </Card>
  )
}

function Complaints() {
  const qc = useQueryClient()
  const [status, setStatus] = useState('open')
  const [resolving, setResolving] = useState<string | null>(null)
  const [resolution, setResolution] = useState('')

  const list = useQuery({
    queryKey: ['hostel-complaints', status],
    queryFn: () => api.get<List<Complaint>>(`/api/v1/ops/hostel/complaints?status=${status}`),
  })
  const resolve = useMutation({
    mutationFn: (v: { id: string; status: string; resolution?: string; assigned_to?: string }) =>
      api.post(`/api/v1/ops/hostel/complaints/${v.id}/resolve`, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hostel-complaints'] }),
  })

  const rows = list.data?.items ?? []

  return (
    <Card>
      <CardHeader
        title="Complaints"
        description="Raised by boarders, fixed by the block. Oldest first — a geyser nobody has looked at for a week is the one worth seeing."
        action={
          <Select
            value={status}
            onChange={setStatus}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'in_progress', label: 'In progress' },
              { value: 'resolved', label: 'Resolved' },
              { value: '', label: 'All' },
            ]}
          />
        }
      />
      {list.isLoading ? (
        <Loading label="Loading complaints…" />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing open" body="Complaints raised by boarders appear here." />
      ) : (
        <Table
          head={[
            { label: 'Complaint' },
            { label: 'Raised by' },
            { label: 'Category' },
            { label: 'Priority' },
            { label: 'Waiting' },
            { label: '' },
          ]}
        >
          {rows.map((c) => (
            <tr key={c.id}>
              <Td className="font-medium">
                {c.subject}
                {c.detail && (
                  <div className="text-[12px] font-normal text-muted-foreground">{c.detail}</div>
                )}
                {c.resolution && (
                  <div className="text-[12px] font-normal text-success">Fixed: {c.resolution}</div>
                )}
              </Td>
              <Td className="text-muted-foreground">
                {c.student_name ?? '—'}
                {c.room && <div className="text-[12px]">Room {c.room}</div>}
              </Td>
              <Td className="text-muted-foreground">{c.category}</Td>
              <Td>
                <Badge tone={PRIORITY_TONE[c.priority]}>{c.priority}</Badge>
              </Td>
              <Td className="tabular-nums text-muted-foreground">
                {c.open_days === 0 ? 'Today' : `${c.open_days}d`}
              </Td>
              <Td>
                {c.status === 'open' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={resolve.isPending}
                    onClick={() => resolve.mutate({ id: c.id, status: 'in_progress' })}
                  >
                    Start
                  </Button>
                )}
                {(c.status === 'open' || c.status === 'in_progress') && (
                  <Button
                    size="sm"
                    disabled={resolve.isPending}
                    onClick={() => {
                      setResolving(c.id)
                      setResolution('')
                    }}
                  >
                    Resolve
                  </Button>
                )}
                {resolving === c.id && (
                  <div className="mt-2 space-y-2">
                    <Input
                      value={resolution}
                      placeholder="What was actually done"
                      onChange={setResolution}
                    />
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        disabled={resolve.isPending || resolution.trim() === ''}
                        onClick={() => {
                          resolve.mutate({ id: c.id, status: 'resolved', resolution })
                          setResolving(null)
                        }}
                      >
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setResolving(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <FormNotice error={resolve.error} />
    </Card>
  )
}

function Mess() {
  const qc = useQueryClient()
  const [date, setDate] = useState(today())
  const [draft, setDraft] = useState<Record<string, string> | null>(null)

  const list = useQuery({
    queryKey: ['mess', date],
    queryFn: () => api.get<List<Meal>>(`/api/v1/ops/hostel/mess?from=${date}&to=${date}`),
  })
  const save = useMutation({
    mutationFn: (meals: Meal[]) => api.put('/api/v1/ops/hostel/mess', { on_date: date, meals }),
    onSuccess: () => {
      setDraft(null)
      qc.invalidateQueries({ queryKey: ['mess'] })
    },
  })

  const saved = Object.fromEntries((list.data?.items ?? []).map((m) => [m.meal, m.items]))
  const values = draft ?? saved

  return (
    <Card>
      <CardHeader
        title="Mess menu"
        description="One day at a time, saved together. Clearing a meal removes it — a fast day is a real thing to say."
        action={
          <Input
            type="date"
            value={date}
            onChange={(v) => {
              setDate(v)
              setDraft(null)
            }}
          />
        }
      />
      {list.isLoading ? (
        <Loading label="Loading the menu…" />
      ) : (
        <>
          <FormGrid>
            {MEALS.map((meal) => (
              <Field key={meal} label={meal[0].toUpperCase() + meal.slice(1)}>
                <Textarea
                  rows={2}
                  value={values[meal] ?? ''}
                  placeholder="Not served"
                  onChange={(v) => setDraft({ ...values, [meal]: v })}
                />
              </Field>
            ))}
          </FormGrid>
          <div className="flex items-center gap-2 px-4 pb-4">
            <Button
              disabled={save.isPending || draft === null}
              onClick={() =>
                save.mutate(MEALS.map((meal) => ({ meal, items: values[meal] ?? '' })))
              }
            >
              {save.isPending ? 'Saving…' : `Save ${formatDate(date)}`}
            </Button>
            {draft !== null && (
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Discard
              </Button>
            )}
            <UtensilsCrossed className="ml-auto h-4 w-4 text-muted-foreground" aria-hidden />
          </div>
        </>
      )}
      <FormNotice error={save.error} />
    </Card>
  )
}
