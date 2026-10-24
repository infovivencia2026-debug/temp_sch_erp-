import { useState } from 'react'
import { rupeesToPaise } from '@/lib/money'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Phone, Mail, MapPin, Users, CalendarClock, AlertTriangle, UserX, Plus } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button, ConfirmButton, Dialog,
  Field, FormGrid, FormNotice, Input, Select, Textarea, SkeletonTiles, ErrorState, EmptyState, SEG_BAR, segClass,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { useOpenState } from '@/lib/motion'
import { formatPaise } from '@/lib/utils'
import { NewSchool, type NewSchoolPrefill } from '@/features/seller/NewSchool'

/* THE SALES PIPELINE (Sales → Leads).

   Leads arrive through the public buy form, or are added here by hand. The
   list answers "who do I ring today": stage, owner and a search are filters,
   follow-up date is the order, and it pages on the server so a long book is
   all reachable. Each lead opens to its notes, its stage moves, its quotes,
   a demo school once a demo is booked, and "Set up school" once it is won.

   WHY A LIST AND NOT A DRAG-AND-DROP BOARD. A board sorts by stage, and the
   question this desk asks is a date. A column of forty 'contacted' leads says
   nothing about which of them is overdue. */

const BASE = '/api/v1/seller/enquiries'
const PAGE = 50

const STAGES = ['new', 'contacted', 'demo_booked', 'won', 'lost'] as const
type Stage = (typeof STAGES)[number]

const STAGE_LABEL: Record<Stage, string> = {
  new: 'New', contacted: 'Contacted', demo_booked: 'Demo booked', won: 'Won', lost: 'Lost',
}

/* Mirrors LEAD_MOVES in worker/src/routes/seller/platform.ts. The server
   refuses an illegal move; this stops the screen offering one. */
const MOVES: Record<Stage, Stage[]> = {
  new: ['contacted', 'lost'],
  contacted: ['demo_booked', 'won', 'lost'],
  demo_booked: ['won', 'lost', 'contacted'],
  won: ['contacted'],
  lost: ['new', 'contacted'],
}

const TONE: Record<Stage, 'neutral' | 'warning' | 'success' | 'danger'> = {
  new: 'neutral', contacted: 'warning', demo_booked: 'warning', won: 'success', lost: 'danger',
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
  institution_id?: string
  owner?: string
  owner_user_id?: string
  next_follow_up?: string
  lost_reason?: string
  value_paise?: number
  notes: number
}
interface Owner { id: string; full_name: string }
interface LeadPage { items: Lead[]; total: number; has_more: boolean; owners: Owner[] }

interface Pipeline {
  stages: { stage: Stage; count: number; value_paise: number }[]
  due_today: number
  overdue: number
  unowned: number
}
interface Note { kind: string; body: string; author?: string; at: string }
interface Quote {
  id: string; number: string; amount_paise: number; gst_paise: number; total_paise: number; gst_rate_bp: number
  valid_until: string; status: 'open' | 'converted' | 'void'; expired: boolean; invoice_number?: string | null
}
interface Demo {
  provisioning_id: string; name: string; stage: string; error: string | null; expires_on: string; expired: boolean
  suspended_at: string | null; sign_in_path: string; sign_in_as: string | null
}
interface DemoCreated { name: string; sign_in_path: string; sign_in_as: string; password: string; expires_on: string }
interface Plan { code: string; name: string; price_paise: number }

/** Days from today to a YYYY-MM-DD, read in local time. */
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
  const [owner, setOwner] = useState('')
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [settingUp, setSettingUp] = useState<NewSchoolPrefill | null>(null)
  const [open, setOpen] = useOpenState<string | null>(null)

  const params = (offset: number) => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
    if (stage) p.set('stage', stage)
    if (owner) p.set('owner', owner)
    if (q.trim()) p.set('q', q.trim())
    return p.toString()
  }
  const leads = useInfiniteQuery({
    queryKey: ['sales-leads', stage, owner, q.trim()],
    queryFn: ({ pageParam }) => api.get<LeadPage>(`${BASE}?${params(pageParam)}`),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.has_more ? all.reduce((n, p) => n + p.items.length, 0) : undefined),
    placeholderData: (prev) => prev,
  })
  const pipeline = useQuery({ queryKey: ['sales-pipeline'], queryFn: () => api.get<Pipeline>(`${BASE}/pipeline`) })
  const plans = useQuery({ queryKey: ['seller-plans'], queryFn: () => api.get<List<Plan>>('/api/v1/seller/plans') })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['sales-leads'] })
    void qc.invalidateQueries({ queryKey: ['sales-pipeline'] })
  }

  if (leads.isLoading && !leads.data) return <SkeletonTiles count={4} />
  if (leads.error) return <ErrorState error={leads.error} />

  if (settingUp) {
    return (
      <>
        <PageHead eyebrow="Sales" title={`Set up ${settingUp.school_name}`} description="The lead is linked to the school when it is ready." />
        <PageBody>
          <NewSchool plans={plans.data?.items ?? []} prefill={settingUp} onClose={() => { setSettingUp(null); refresh() }} />
        </PageBody>
      </>
    )
  }

  const pages = leads.data?.pages ?? []
  const items = pages.flatMap((p) => p.items)
  const total = pages[0]?.total ?? 0
  const owners = pages[0]?.owners ?? []
  const p = pipeline.data
  const filtered = !!(stage || owner || q.trim())

  return (
    <>
      <PageHead
        eyebrow="Sales"
        title="Leads"
        description="Schools that may buy, and what has been done about each."
        actions={<Button onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" />Add lead</Button>}
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Overdue" value={p?.overdue ?? 0} hint={p?.overdue ? 'Past their follow-up date' : 'Nothing is late'} icon={AlertTriangle} />
          <Stat label="Due today" value={p?.due_today ?? 0} hint="Follow up before the day ends" icon={CalendarClock} />
          <Stat label="Nobody owns" value={p?.unowned ?? 0} hint={p?.unowned ? 'Give each one an owner' : 'All assigned'} icon={UserX} />
          <Stat
            label="Open pipeline"
            value={formatPaise(p?.stages.filter((s) => s.stage !== 'won' && s.stage !== 'lost').reduce((a, s) => a + s.value_paise, 0) ?? 0)}
            hint="Value not yet won or lost"
          />
        </CellGrid>

        <Card>
          <div className="space-y-3 p-3">
            <div role="tablist" aria-label="Stage" className={SEG_BAR}>
              <button type="button" role="tab" aria-selected={stage === ''} className={segClass(stage === '')} onClick={() => setStage('')}>
                All
              </button>
              {STAGES.map((s) => (
                <button key={s} type="button" role="tab" aria-selected={stage === s} className={segClass(stage === s)} onClick={() => setStage(stage === s ? '' : s)}>
                  {STAGE_LABEL[s]} <span className="tabular-nums opacity-60">{p?.stages.find((x) => x.stage === s)?.count ?? 0}</span>
                </button>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input value={q} onChange={setQ} placeholder="Search school, contact, phone or district" srLabel="Search leads" />
              <Select
                value={owner}
                onChange={setOwner}
                options={[{ value: '', label: 'Every owner' }, { value: 'none', label: 'Nobody owns' }, ...owners.map((o) => ({ value: o.id, label: o.full_name }))]}
              />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={stage ? STAGE_LABEL[stage] : 'Every lead'}
            description={`${total} ${total === 1 ? 'lead' : 'leads'}. Oldest follow-up first; a lead with no date sits at the bottom.`}
          />
          {items.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No leads here"
                body={filtered ? 'Nothing matches these filters.' : 'Enquiries from the public buy page arrive here. Add a call or a referral with Add lead.'}
              />
            </div>
          ) : (
            <ul className="divide-y">
              {items.map((l) => (
                <LeadRow
                  key={l.id}
                  lead={l}
                  owners={owners}
                  open={open === l.id}
                  onToggle={() => setOpen(open === l.id ? null : l.id)}
                  onSaved={(msg) => { refresh(); toast.ok(msg) }}
                  onSetUp={() => setSettingUp({
                    enquiry_id: l.id, school_name: l.school_name, admin_name: l.contact_name, admin_email: l.email,
                    admin_phone: l.phone, district: l.district, plan_code: l.plan_code,
                  })}
                />
              ))}
            </ul>
          )}
          {leads.hasNextPage && (
            <div className="border-t p-3 text-center">
              <Button variant="secondary" pending={leads.isFetchingNextPage} onClick={() => void leads.fetchNextPage()}>
                Show {Math.min(PAGE, total - items.length)} more
              </Button>
            </div>
          )}
        </Card>
      </PageBody>
      {adding && <AddLead owners={owners} plans={plans.data?.items ?? []} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); refresh(); toast.ok('Lead added') }} />}
    </>
  )
}

function AddLead({ owners, plans, onClose, onAdded }: { owners: Owner[]; plans: Plan[]; onClose: () => void; onAdded: () => void }) {
  const [f, setF] = useState({ school_name: '', contact_name: '', phone: '', email: '', district: '', students: '', value: '', plan_code: '', owner_user_id: '', next_follow_up: '', message: '' })
  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }))
  const add = useMutation({
    mutationFn: () => api.post(BASE, {
      school_name: f.school_name, contact_name: f.contact_name, phone: f.phone, email: f.email, district: f.district,
      students: f.students ? Number(f.students) : null, value_paise: f.value ? rupeesToPaise(f.value) : null,
      plan_code: f.plan_code, owner_user_id: f.owner_user_id || null, next_follow_up: f.next_follow_up || null, message: f.message,
    }),
    onSuccess: onAdded,
  })
  const ready = f.school_name.trim() && f.contact_name.trim() && (f.phone.trim() || f.email.trim())
  return (
    <Dialog
      onClose={onClose}
      title="Add a lead"
      description="A call, a walk-in or a referral. A phone or an email is needed to follow it up."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!ready} pending={add.isPending} onClick={() => add.mutate()}>Add lead</Button>
        </>
      }
    >
      <FormGrid>
        <Field label="School" required wide><Input value={f.school_name} onChange={(v) => set('school_name', v)} /></Field>
        <Field label="Who to speak to" required><Input value={f.contact_name} onChange={(v) => set('contact_name', v)} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(v) => set('phone', v)} /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={(v) => set('email', v)} /></Field>
        <Field label="District"><Input value={f.district} onChange={(v) => set('district', v)} /></Field>
        <Field label="Students"><Input value={f.students} onChange={(v) => set('students', v.replace(/\D/g, ''))} /></Field>
        <Field label="Worth" hint="Rupees a year."><Input value={f.value} onChange={(v) => set('value', v.replace(/[^\d.]/g, ''))} /></Field>
        <Field label="Plan">
          <Select value={f.plan_code} onChange={(v) => set('plan_code', v)} options={[{ value: '', label: 'Not decided' }, ...plans.map((p) => ({ value: p.code, label: p.name }))]} />
        </Field>
        <Field label="Owner">
          <Select value={f.owner_user_id} onChange={(v) => set('owner_user_id', v)} options={[{ value: '', label: 'Nobody yet' }, ...owners.map((o) => ({ value: o.id, label: o.full_name }))]} />
        </Field>
        <Field label="Next follow-up"><Input type="date" value={f.next_follow_up} onChange={(v) => set('next_follow_up', v)} /></Field>
        <Field label="What they asked" wide><Textarea value={f.message} onChange={(v) => set('message', v)} rows={2} /></Field>
      </FormGrid>
      <FormNotice error={add.error} />
    </Dialog>
  )
}

function LeadRow({
  lead, owners, open, onToggle, onSaved, onSetUp,
}: {
  lead: Lead; owners: Owner[]; open: boolean; onToggle: () => void; onSaved: (msg: string) => void; onSetUp: () => void
}) {
  const due = daysUntil(lead.next_follow_up)
  const late = due !== null && due < 0 && lead.status !== 'won' && lead.status !== 'lost'
  return (
    <li className="px-4 py-4 sm:px-5">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-start justify-between gap-3 text-left">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-medium">
            {lead.school_name}
            {lead.provisioned && <Badge tone="success" className="ml-2 align-middle">Customer</Badge>}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
            <span>{lead.contact_name}</span>
            {lead.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{lead.phone}</span>}
            {lead.email && <span className="inline-flex min-w-0 items-center gap-1"><Mail className="h-3 w-3 shrink-0" /><span className="truncate">{lead.email}</span></span>}
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
          <span className="text-[12px] text-muted-foreground">{lead.owner ?? 'Unowned'}</span>
        </div>
      </button>
      {open && <LeadPanel lead={lead} owners={owners} onSaved={onSaved} onSetUp={onSetUp} />}
    </li>
  )
}

function LeadPanel({ lead, owners, onSaved, onSetUp }: { lead: Lead; owners: Owner[]; onSaved: (msg: string) => void; onSetUp: () => void }) {
  const [note, setNote] = useState('')
  const [follow, setFollow] = useState(lead.next_follow_up ?? '')
  const [worth, setWorth] = useState(lead.value_paise ? String(lead.value_paise / 100) : '')
  const [reason, setReason] = useState('')

  const notes = useQuery({ queryKey: ['sales-lead-notes', lead.id], queryFn: () => api.get<List<Note>>(`${BASE}/${lead.id}/notes`) })
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put(`${BASE}/${lead.id}`, { from: lead.status, ...body }),
    onSuccess: () => { setNote(''); setReason(''); void notes.refetch(); onSaved('Lead updated') },
  })
  const worthChanged = (worth ? rupeesToPaise(worth) : 0) !== (lead.value_paise ?? 0)

  return (
    <div className="mt-3 space-y-4 rounded-[var(--radius-card)] bg-muted/30 p-4">
      {lead.message && <p className="text-[13.5px] leading-relaxed text-muted-foreground">“{lead.message}”</p>}

      <FormGrid>
        <Field label="Next follow-up" hint="What puts this lead in tomorrow's list.">
          <Input type="date" value={follow} onChange={setFollow} />
        </Field>
        <Field label="Worth" hint="Rupees a year. Quotes start from it.">
          <Input value={worth} onChange={(v) => setWorth(v.replace(/[^\d.]/g, ''))} placeholder="60000" />
        </Field>
        <Field label="Owner">
          <Select
            value={lead.owner_user_id ?? ''}
            onChange={(v) => save.mutate({ owner_user_id: v || null })}
            options={[{ value: '', label: 'Nobody' }, ...owners.map((o) => ({ value: o.id, label: o.full_name }))]}
          />
        </Field>
        <Field label="What happened" wide hint="Said on the call. This is what the next call needs.">
          <Input value={note} onChange={setNote} />
        </Field>
      </FormGrid>

      {lead.status === 'lost' && lead.lost_reason && <p className="text-[13px] text-muted-foreground">Lost because: {lead.lost_reason}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          pending={save.isPending}
          disabled={!note.trim() && follow === (lead.next_follow_up ?? '') && !worthChanged}
          onClick={() => save.mutate({ note: note.trim() || undefined, next_follow_up: follow || null, ...(worthChanged ? { value_paise: worth ? rupeesToPaise(worth) : null } : {}) })}
        >
          Save
        </Button>
        {MOVES[lead.status].map((to) => (
          <Button
            key={to}
            size="sm"
            variant="secondary"
            disabled={save.isPending}
            onClick={() => save.mutate({
              status: to, note: note.trim() || undefined,
              lost_reason: to === 'lost' ? reason.trim() || note.trim() : undefined, next_follow_up: follow || null,
            })}
          >
            {to === 'lost' ? 'Mark lost' : to === 'won' ? 'Mark won' : `Move to ${STAGE_LABEL[to]}`}
          </Button>
        ))}
        {lead.status === 'won' && !lead.provisioned && <Button size="sm" onClick={onSetUp}>Set up school</Button>}
      </div>

      {MOVES[lead.status].includes('lost') && (
        <Field label="If lost, why" hint="Asked now because nobody comes back to fill it in.">
          <Input value={reason} onChange={setReason} />
        </Field>
      )}
      <FormNotice error={save.error} />

      <Quotes lead={lead} onSaved={onSaved} />
      {lead.status === 'demo_booked' && <DemoSchool lead={lead} onSaved={onSaved} />}

      <div>
        <p className="mb-2 text-[13px] font-semibold">History</p>
        {notes.data?.items.length ? (
          <ul className="space-y-2">
            {notes.data.items.map((n, i) => (
              <li key={i} className="flex gap-2 text-[13px]">
                <span className="w-[104px] shrink-0 tabular-nums text-muted-foreground">{n.at}</span>
                <span className="min-w-0 break-words">
                  {n.kind === 'stage' ? <span className="text-muted-foreground">moved {n.body}</span> : n.body}
                  {n.author && <span className="ml-2 text-muted-foreground"> · {n.author}</span>}
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

const QUOTE_TONE = { open: 'info', converted: 'success', void: 'neutral' } as const

/** Quotes for this lead. Money: every action waits for the server's answer. */
function Quotes({ lead, onSaved }: { lead: Lead; onSaved: (msg: string) => void }) {
  const qc = useQueryClient()
  const key = ['sales-quotes', lead.id]
  const quotes = useQuery({ queryKey: key, queryFn: () => api.get<List<Quote>>(`/api/v1/seller/quotes?enquiry_id=${lead.id}`) })
  const done = (msg: string) => { void qc.invalidateQueries({ queryKey: key }); onSaved(msg) }
  const write = useMutation({ mutationFn: () => api.post<Quote>('/api/v1/seller/quotes', { enquiry_id: lead.id }), onSuccess: (q) => done(`Quote ${q.number} written`) })
  const convert = useMutation({
    mutationFn: (id: string) => api.post<{ invoice: { number: string } }>(`/api/v1/seller/quotes/${id}/convert`, {}),
    onSuccess: (r) => done(`Invoice ${r.invoice.number} issued`),
  })
  const voidQ = useMutation({ mutationFn: (id: string) => api.post(`/api/v1/seller/quotes/${id}/void`), onSuccess: () => done('Quote voided') })
  const rows = quotes.data?.items ?? []
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-semibold">Quotes</p>
        <Button size="sm" variant="secondary" pending={write.isPending} disabled={!lead.value_paise} needsNetwork onClick={() => write.mutate()}>
          Write a quote
        </Button>
      </div>
      {!lead.value_paise && <p className="text-[13px] text-muted-foreground">Set what the lead is worth to write a quote from it.</p>}
      {rows.length > 0 && (
        <ul className="divide-y rounded-[var(--radius-card)] bg-card">
          {rows.map((q) => (
            <li key={q.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-[13px]">
              <a className="font-medium underline-offset-2 hover:underline" href={`/api/v1/seller/quotes/${q.id}/pdf`} target="_blank" rel="noreferrer">{q.number}</a>
              <span className="tabular-nums">{formatPaise(q.total_paise)}</span>
              <span className="text-muted-foreground">incl. GST {formatPaise(q.gst_paise)}</span>
              <Badge tone={q.expired ? 'warning' : QUOTE_TONE[q.status]}>
                {q.expired ? 'Expired' : q.status === 'converted' ? `Invoice ${q.invoice_number ?? ''}`.trim() : q.status === 'void' ? 'Void' : `Valid to ${q.valid_until}`}
              </Badge>
              {q.status === 'open' && (
                <span className="ml-auto flex gap-2">
                  <Button size="sm" variant="secondary" needsNetwork pending={convert.isPending && convert.variables === q.id}
                    disabled={!lead.provisioned} title={lead.provisioned ? undefined : 'Set up the school first'} onClick={() => convert.mutate(q.id)}>
                    Make invoice
                  </Button>
                  <ConfirmButton confirmLabel="Void quote" question="The quote stays on record, marked void." onConfirm={() => voidQ.mutate(q.id)} disabled={voidQ.isPending}>
                    Void
                  </ConfirmButton>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {rows.some((q) => q.status === 'open') && !lead.provisioned && (
        <p className="mt-2 text-[12.5px] text-muted-foreground">A quote becomes an invoice once the school is set up.</p>
      )}
      <FormNotice error={write.error ?? convert.error ?? voidQ.error} />
    </div>
  )
}

function DemoSchool({ lead, onSaved }: { lead: Lead; onSaved: (msg: string) => void }) {
  const qc = useQueryClient()
  const key = ['sales-demos', lead.id]
  const [days, setDays] = useState('14')
  const [made, setMade] = useState<DemoCreated | null>(null)
  const demos = useQuery({ queryKey: key, queryFn: () => api.get<List<Demo>>(`/api/v1/seller/demos?enquiry_id=${lead.id}`), refetchInterval: (q) => (q.state.data?.items.some((d) => d.stage !== 'ready' && d.stage !== 'failed') ? 5000 : false) })
  const create = useMutation({
    mutationFn: () => api.post<DemoCreated>('/api/v1/seller/demos', { enquiry_id: lead.id, days: Number(days) }),
    onSuccess: (d) => { setMade(d); void qc.invalidateQueries({ queryKey: key }); onSaved('Demo school started') },
  })
  const rows = demos.data?.items ?? []
  const live = rows.some((d) => !d.expired && !d.suspended_at)
  return (
    <div>
      <p className="mb-2 text-[13px] font-semibold">Demo school</p>
      <p className="mb-3 text-[13px] text-muted-foreground">
        A school of its own with invented classes and children for the demo. It is suspended after its last day.
      </p>
      {made && (
        <div className="mb-3 rounded-[var(--radius-card)] bg-card p-3 text-[13px]">
          <p className="font-medium">Sign in at {made.sign_in_path} as {made.sign_in_as}</p>
          <p className="mt-1">Password, shown once: <span className="font-mono">{made.password}</span></p>
          <p className="mt-1 text-muted-foreground">Open until {made.expires_on}.</p>
        </div>
      )}
      {rows.length > 0 && (
        <ul className="mb-3 divide-y rounded-[var(--radius-card)] bg-card">
          {rows.map((d) => (
            <li key={d.provisioning_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-[13px]">
              <span className="min-w-0 truncate font-medium">{d.name}</span>
              <span className="font-mono text-[12px] text-muted-foreground">{d.sign_in_path}</span>
              <Badge tone={d.suspended_at || d.expired ? 'neutral' : d.stage === 'failed' ? 'danger' : d.stage === 'ready' ? 'success' : 'info'}>
                {d.suspended_at ? 'Suspended' : d.expired ? 'Expired' : d.stage === 'ready' ? `Open until ${d.expires_on}` : d.stage === 'failed' ? 'Failed' : 'Being set up'}
              </Badge>
              {d.stage === 'failed' && d.error && <span className="w-full text-[12.5px] text-destructive">{d.error}</span>}
            </li>
          ))}
        </ul>
      )}
      {!live && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-40">
            <Field label="Open for">
              <Select value={days} onChange={setDays} options={[7, 14, 21, 30].map((n) => ({ value: String(n), label: `${n} days` }))} />
            </Field>
          </div>
          <Button size="sm" needsNetwork pending={create.isPending} onClick={() => create.mutate()}>Set up demo school</Button>
        </div>
      )}
      <FormNotice error={create.error} />
    </div>
  )
}
