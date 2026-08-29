import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Phone, Mail, MapPin, Users, CalendarClock, AlertTriangle, UserX } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button,
  Field, FormGrid, FormNotice, Input, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'

/* THE SALES PIPELINE.

   Leads have arrived through the public buy form since migration 00013, into a
   table with a five-stage status and a CHECK constraint enforcing it. Nothing
   in the product could ever move one, and no screen ever fetched the endpoint
   that lists them — so every enquiry this product has received sat at 'new',
   in a list nobody could open.

   This is the screen that works them. Not a generic CRM: it does the four
   things a person selling school software actually does in a morning, and
   nothing else.

     what is overdue      the first question, so it is the first number
     move a lead          with a note saying what was said
     own a lead           because one nobody owns is one nobody rings
     why we lost          demanded at the moment of losing, never after

   ---------------------------------------------------------------------------
   WHY A LIST AND NOT A DRAG-AND-DROP BOARD

   Kanban is the expected shape and it is the wrong one here. A board sorts by
   stage, and the question this desk asks is "who do I ring today", which is a
   date. A column of forty 'contacted' leads tells you nothing about which of
   them is overdue. So: stage is a filter, follow-up date is the order, and the
   summary at the top counts the two things that decide the morning. */

const BASE = '/api/v1/seller/enquiries'

const STAGES = ['new', 'contacted', 'demo_booked', 'won', 'lost'] as const
type Stage = (typeof STAGES)[number]

const STAGE_LABEL: Record<Stage, string> = {
  new: 'New',
  contacted: 'Contacted',
  demo_booked: 'Demo booked',
  won: 'Won',
  lost: 'Lost',
}

/* Mirrors leadMoves in internal/api/seller_crm.go. The server refuses an
   illegal move with a 400; this stops the screen offering one in the first
   place, which is the difference between a control that is missing and a
   control that fails. Keep the two in step. */
const MOVES: Record<Stage, Stage[]> = {
  new: ['contacted', 'lost'],
  contacted: ['demo_booked', 'won', 'lost'],
  demo_booked: ['won', 'lost', 'contacted'],
  won: ['contacted'],
  lost: ['new', 'contacted'],
}

const TONE: Record<Stage, 'neutral' | 'warning' | 'success' | 'danger'> = {
  new: 'neutral', contacted: 'warning', demo_booked: 'warning',
  won: 'success', lost: 'danger',
}

interface Lead {
  id: string
  school_name: string
  contact_name: string
  email?: string
  phone?: string
  district?: string
  students?: number
  plan_code?: string
  message?: string
  status: Stage
  source: string
  created_at: string
  provisioned: boolean
  owner?: string
  owner_user_id?: string
  next_follow_up?: string
  lost_reason?: string
  value_paise?: number
  notes: number
}

interface Pipeline {
  stages: { stage: Stage; count: number; value_paise: number }[]
  due_today: number
  overdue: number
  unowned: number
}

interface Note {
  kind: string
  body: string
  author?: string
  at: string
}

const rupees = (paise?: number) =>
  paise ? `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'

/** Today at local midnight, for comparing a YYYY-MM-DD the server sent.
    Not Date.parse: it reads a bare date as UTC, and subtracting a UTC midnight
    from a local one rounds a day the wrong way either side of the boundary. */
function daysUntil(iso?: string): number | null {
  if (!iso) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((d.getTime() - today.getTime()) / 86_400_000)
}

export default function Leads() {
  const qc = useQueryClient()
  const toast = useToast()
  const [stage, setStage] = useState<'' | Stage>('')
  const [open, setOpen] = useState<string | null>(null)

  const leads = useQuery({
    queryKey: ['sales-leads'],
    queryFn: () => api.get<List<Lead>>(BASE),
  })
  const pipeline = useQuery({
    queryKey: ['sales-pipeline'],
    queryFn: () => api.get<Pipeline>(`${BASE}/pipeline`),
  })

  if (leads.isLoading) return <Loading />
  if (leads.error) return <ErrorState error={leads.error} />

  const items = leads.data?.items ?? []
  const shown = stage ? items.filter((l) => l.status === stage) : items
  const p = pipeline.data

  return (
    <>
      <PageHead
        eyebrow="Sales"
        title="Leads"
        description="Schools that have asked to buy, and what has been done about each."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat
            label="Overdue"
            value={p?.overdue ?? 0}
            hint={p?.overdue ? 'Past their follow-up date' : 'Nothing is late'}
            icon={AlertTriangle}
          />
          <Stat
            label="Due today"
            value={p?.due_today ?? 0}
            hint="Follow up before the day ends"
            icon={CalendarClock}
          />
          <Stat
            label="Nobody owns"
            value={p?.unowned ?? 0}
            hint={p?.unowned ? 'A lead nobody owns is a lead nobody rings' : 'All assigned'}
            icon={UserX}
          />
          <Stat
            label="Open pipeline"
            value={rupees(
              p?.stages
                .filter((s) => s.stage !== 'won' && s.stage !== 'lost')
                .reduce((a, s) => a + s.value_paise, 0),
            )}
            hint="Value not yet won or lost"
          />
        </CellGrid>

        {/* The stages, as a filter rather than as columns. Every stage is drawn
            even at zero — a row of buttons that appears and disappears as leads
            move is unreadable, and an empty stage is information. */}
        <Card>
          <div className="flex flex-wrap gap-1.5 p-3">
            <StageChip
              label="All"
              count={items.length}
              active={stage === ''}
              onClick={() => setStage('')}
            />
            {STAGES.map((s) => (
              <StageChip
                key={s}
                label={STAGE_LABEL[s]}
                count={p?.stages.find((x) => x.stage === s)?.count ?? 0}
                active={stage === s}
                onClick={() => setStage(stage === s ? '' : s)}
              />
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader
            title={stage ? STAGE_LABEL[stage] : 'Every lead'}
            description="Oldest follow-up first. A lead with no date sits at the bottom."
          />
          {shown.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No leads here"
                body={
                  stage
                    ? 'Nothing is at this stage yet.'
                    : 'Enquiries from the public buy page arrive here.'
                }
              />
            </div>
          ) : (
            <ul className="divide-y">
              {shown.map((l) => (
                <LeadRow
                  key={l.id}
                  lead={l}
                  open={open === l.id}
                  onToggle={() => setOpen(open === l.id ? null : l.id)}
                  onSaved={() => {
                    void qc.invalidateQueries({ queryKey: ['sales-leads'] })
                    void qc.invalidateQueries({ queryKey: ['sales-pipeline'] })
                    toast.ok('Lead updated')
                  }}
                />
              ))}
            </ul>
          )}
        </Card>
      </PageBody>
    </>
  )
}

function StageChip({
  label, count, active, onClick,
}: {
  label: string; count: number; active: boolean; onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[3px] border px-3 py-1.5 text-[13px] transition-colors ${
        active ? 'border-primary bg-accent font-medium' : 'hover:bg-accent'
      }`}
    >
      {label} <span className="tabular-nums opacity-60">{count}</span>
    </button>
  )
}

function LeadRow({
  lead, open, onToggle, onSaved,
}: {
  lead: Lead; open: boolean; onToggle: () => void; onSaved: () => void
}) {
  const due = daysUntil(lead.next_follow_up)
  const late = due !== null && due < 0 && lead.status !== 'won' && lead.status !== 'lost'
  return (
    <li className="px-5 py-4">
      <button type="button" onClick={onToggle} className="flex w-full items-start justify-between gap-3 text-left">
        <div className="min-w-0">
          <p className="text-[14px] font-medium">
            {lead.school_name}
            {lead.provisioned && (
              <span className="ml-2 align-middle"><Badge tone="success">Customer</Badge></span>
            )}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
            <span>{lead.contact_name}</span>
            {lead.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{lead.phone}</span>}
            {lead.email && <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{lead.email}</span>}
            {lead.district && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{lead.district}</span>}
            {lead.students != null && <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />{lead.students}</span>}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge tone={TONE[lead.status]}>{STAGE_LABEL[lead.status]}</Badge>
          {lead.next_follow_up && (
            <span className={`text-[12.5px] ${late ? 'text-destructive' : 'text-muted-foreground'}`}>
              {late ? `${Math.abs(due!)}d overdue` : due === 0 ? 'Due today' : `in ${due}d`}
            </span>
          )}
          <span className="text-[12px] text-muted-foreground">
            {lead.owner ?? 'Unowned'}
          </span>
        </div>
      </button>
      {open && <LeadPanel lead={lead} onSaved={onSaved} />}
    </li>
  )
}

function LeadPanel({ lead, onSaved }: { lead: Lead; onSaved: () => void }) {
  const [note, setNote] = useState('')
  const [follow, setFollow] = useState(lead.next_follow_up ?? '')
  const [reason, setReason] = useState('')

  const notes = useQuery({
    queryKey: ['sales-lead-notes', lead.id],
    queryFn: () => api.get<List<Note>>(`${BASE}/${lead.id}/notes`),
  })

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.put(`${BASE}/${lead.id}`, { from: lead.status, ...body }),
    onSuccess: () => { setNote(''); setReason(''); onSaved() },
  })

  return (
    <div className="mt-3 rounded-[3px] border bg-muted/30 p-4">
      {lead.message && (
        <p className="mb-3 text-[13.5px] leading-relaxed text-muted-foreground">
          “{lead.message}”
        </p>
      )}

      <FormGrid>
        <Field label="Next follow-up" hint="What puts this lead in tomorrow's list.">
          <Input type="date" value={follow} onChange={setFollow} />
        </Field>
        <Field label="Worth" hint="Rupees. Read as a pipeline total above.">
          <Input
            value={lead.value_paise ? String(lead.value_paise / 100) : ''}
            onChange={(v) => save.mutate({ value_paise: Math.round(Number(v || 0) * 100) })}
            placeholder="60000"
          />
        </Field>
        <Field label="What happened" wide hint="Said on the call. This is what the next call needs.">
          <Input value={note} onChange={setNote} placeholder="Spoke to the correspondent; wants a demo after exams." />
        </Field>
      </FormGrid>

      {lead.status === 'lost' && lead.lost_reason && (
        <p className="mt-3 text-[13px] text-muted-foreground">
          Lost because: {lead.lost_reason}
        </p>
      )}

      {/* Only the moves the server will accept. A control that fails when
          pressed is worse than one that is not offered. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={save.isPending || (!note.trim() && follow === (lead.next_follow_up ?? ''))}
          onClick={() => save.mutate({ note, next_follow_up: follow || null })}
        >
          Save note
        </Button>
        {MOVES[lead.status].map((to) => (
          <Button
            key={to}
            size="sm"
            variant={to === 'won' ? 'primary' : 'secondary'}
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                status: to,
                note: note.trim() || undefined,
                lost_reason: to === 'lost' ? reason.trim() || note.trim() : undefined,
                next_follow_up: follow || null,
              })
            }
          >
            {to === 'lost' ? 'Mark lost' : to === 'won' ? 'Mark won' : `Move to ${STAGE_LABEL[to]}`}
          </Button>
        ))}
      </div>

      {MOVES[lead.status].includes('lost') && (
        <div className="mt-3">
          <Field label="If lost, why" hint="Asked now because nobody ever comes back to fill it in.">
            <Input value={reason} onChange={setReason} placeholder="Went with a cheaper vendor" />
          </Field>
        </div>
      )}

      <FormNotice error={save.error} />

      <div className="mt-4">
        <p className="mb-2 text-[12px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
          History
        </p>
        {notes.data?.items.length ? (
          <ul className="space-y-2">
            {notes.data.items.map((n, i) => (
              <li key={i} className="flex gap-2 text-[13px]">
                <span className="w-[104px] shrink-0 tabular-nums text-muted-foreground">{n.at}</span>
                <span className="min-w-0">
                  {n.kind === 'stage' ? <span className="text-muted-foreground">moved {n.body}</span> : n.body}
                  {n.author && <span className="ml-2 text-muted-foreground">— {n.author}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted-foreground">Nothing recorded yet.</p>
        )}
      </div>
    </div>
  )
}
