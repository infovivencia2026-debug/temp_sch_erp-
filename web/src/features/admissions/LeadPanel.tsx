import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, MessageCircle, Phone, PhoneCall, StickyNote, MapPin, ArrowRightLeft, X } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  Card, CardHeader, Button, Input, Select, Textarea, ErrorState, FormNotice, Loading, SEG_BAR, segClass,
} from '@/components/ui'
import { StatusPill } from '@/components/NeedsAttention'
import WriteWithAI from '@/components/ai/WriteWithAI'
import { formatDate } from '@/lib/utils'

/* One lead, opened: who they are, every touch so far, and the next one.
 *
 * A counsellor on the phone needs three things on one screen: the number to
 * ring (or WhatsApp), what was said last time, and a place to write what was
 * said this time with the date to ring again. Logging the call and setting the
 * next date is one action, because a call logged without a next date is a lead
 * that quietly goes cold. */

export const STAGES = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'visit_scheduled', label: 'Visit booked' },
  { value: 'applied', label: 'Applied' },
  { value: 'lost', label: 'Lost' },
] as const
export const stageLabel = (s: string) => STAGES.find((x) => x.value === s)?.label ?? s.replace(/_/g, ' ')

export const SOURCES = [
  { value: 'walk_in', label: 'Walk-in' },
  { value: 'phone', label: 'Telephone' },
  { value: 'website', label: 'Website' },
  { value: 'referral', label: 'Referral' },
  { value: 'campaign', label: 'Campaign' },
  { value: 'other', label: 'Other' },
]

/** wa.me wants the country code and digits only. A ten-digit Indian mobile gets 91. */
export function waLink(phone: string, text?: string): string {
  let d = phone.replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  if (d.length === 10) d = '91' + d
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ''}`
}

export const ymdIn = (days: number) => {
  const d = new Date(Date.now() + days * 864e5)
  return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10)
}

export interface LeadConvert { id: string; student_name: string; parent_name?: string; phone: string; email?: string; class_id?: string }

/** Where "Convert" goes: the application form with the lead filled in. */
export function convertHref(e: LeadConvert): string {
  const q = new URLSearchParams({ from: e.id, student: e.student_name, parent: e.parent_name ?? '', phone: e.phone })
  if (e.email) q.set('email', e.email)
  if (e.class_id) q.set('class', e.class_id)
  return `/go/application_forms?${q}`
}

interface Activity {
  id: string; kind: string; body?: string; from_status?: string; to_status?: string
  next_follow_up?: string; author?: string; created_at: string
}
interface Detail {
  enquiry: {
    id: string; student_name: string; parent_name?: string; phone: string; email?: string
    class_id?: string; class_name?: string; source: string; campaign?: string; referred_by?: string
    status: string; next_follow_up?: string; notes?: string; lost_reason?: string; lost_reason_note?: string
    assigned_to?: string; created_at: string; last_contacted_at?: string
  }
  activities: Activity[]
  duplicates: { id: string; student_name: string; parent_name?: string; status: string; created_at: string }[]
  application: { id: string; application_no: string; status: string; student_id?: string } | null
}

const KIND_ICON: Record<string, typeof Phone> = {
  call: PhoneCall, whatsapp: MessageCircle, note: StickyNote, visit: MapPin, stage: ArrowRightLeft, created: StickyNote,
}
const KIND_LABEL: Record<string, string> = {
  call: 'Call', whatsapp: 'WhatsApp', note: 'Note', visit: 'Visit', created: 'Enquiry logged',
}

const when = (iso: string) => {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

export function useLostReasons() {
  return useQuery({
    queryKey: ['admissions', 'lost-reasons'],
    queryFn: () => api.get<List<{ value: string; label: string }>>('/api/v1/admissions/lost-leads/reasons'),
    staleTime: 5 * 60_000,
  })
}

/** Closing a lead as lost, with one of the school's reasons, so the lost-leads report can use it. */
/* THIS LEAD'S OWN WAY INTO THE APPLICATION. The address of the open form,
   signed for this enquiry: the family opens it with what the school already
   knows filled in, and what they send is attached to this lead rather than
   matched by phone number afterwards. Fetched when asked for, because it is
   signed for thirty days from that moment. Copy it, or open WhatsApp with
   the message written. */
function ApplyLink({ id, phone }: { id: string; phone: string }) {
  const [copied, setCopied] = useState(false)
  const link = useMutation({
    mutationFn: async () => {
      const r = await api.get<{ path: string; message_template: string; form: string }>(`/api/v1/admissions/workflow/enquiries/${id}/apply-link`)
      // The address a family opens is this site's, whatever host the API answered from.
      const url = window.location.origin + r.path
      return { url, form: r.form, message: r.message_template.replace('{url}', url) }
    },
  })
  if (!link.data) {
    return (
      <>
        <Button variant="secondary" disabled={link.isPending} onClick={() => link.mutate()}>
          <Link2 className="h-3.5 w-3.5" /> {link.isPending ? 'Making the link…' : 'Send application link'}
        </Button>
        {link.error && <FormNotice error={link.error} />}
      </>
    )
  }
  return (
    <div className="w-full rounded-[var(--radius-card)] border bg-card px-3.5 py-3">
      <p className="text-[13px] font-medium">Application link for this family</p>
      <p className="mt-0.5 text-[12.5px] text-muted-foreground">Opens “{link.data.form}” with their details filled in. Good for 30 days.</p>
      <p className="mt-2 break-all font-mono text-[12px] text-muted-foreground">{link.data.url}</p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(link.data!.url); setCopied(true); setTimeout(() => setCopied(false), 1800) }}>
          {copied ? 'Copied' : 'Copy link'}
        </Button>
        <a href={waLink(phone, link.data.message)} target="_blank" rel="noreferrer"
          className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border px-2.5 text-[13px] font-medium hover:bg-accent">
          <MessageCircle className="h-3.5 w-3.5" /> Send on WhatsApp
        </a>
      </div>
    </div>
  )
}

export function LostForm({ id, onDone, onCancel }: { id: string; onDone: () => void; onCancel: () => void }) {
  const qc = useQueryClient()
  const reasons = useLostReasons()
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const lose = useMutation({
    mutationFn: () => api.post(`/api/v1/admissions/leads/${id}/lost`, { reason, note }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enquiries'] })
      qc.invalidateQueries({ queryKey: ['enquiry', id] })
      qc.invalidateQueries({ queryKey: ['attention'] })
      onDone()
    },
  })
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted-foreground">Why was it lost?</span>
          <Select value={reason} onChange={setReason} placeholder={reasons.isLoading ? 'Loading…' : 'Pick a reason'}
            options={reasons.data?.items ?? []} />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted-foreground">Note{reason === 'other' ? '' : ' (optional)'}</span>
          <Input value={note} onChange={setNote} placeholder="What the parent said" />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button tone="danger" variant="secondary" disabled={!reason || (reason === 'other' && !note.trim()) || lose.isPending}
          onClick={() => lose.mutate()}>{lose.isPending ? 'Saving…' : 'Close as lost'}</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
      <FormNotice error={lose.error} />
    </div>
  )
}

export default function LeadPanel({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const q = useQuery({
    queryKey: ['enquiry', id],
    queryFn: () => api.get<Detail>(`/api/v1/admissions/workflow/enquiries/${id}`),
  })
  const [kind, setKind] = useState<'call' | 'whatsapp' | 'note' | 'visit'>('call')
  const [body, setBody] = useState('')
  const [follow, setFollow] = useState(ymdIn(2))
  const [msg, setMsg] = useState('')
  const [losing, setLosing] = useState(false)
  const [ok, setOk] = useState('')

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['enquiry', id] })
    qc.invalidateQueries({ queryKey: ['enquiries'] })
    qc.invalidateQueries({ queryKey: ['attention'] })
  }
  const log = useMutation({
    mutationFn: (b: { kind: string; body?: string; next_follow_up?: string }) =>
      api.post(`/api/v1/admissions/workflow/enquiries/${id}/activities`, b),
    onSuccess: (_r, b) => { setBody(''); setOk(`${KIND_LABEL[b.kind] ?? 'Entry'} logged.`); refresh() },
  })
  const stage = useMutation({
    mutationFn: (status: string) => api.put(`/api/v1/admissions/workflow/enquiries/${id}`, { status }),
    onSuccess: () => { setOk('Stage changed.'); refresh() },
  })
  const reopen = useMutation({
    mutationFn: () => api.post(`/api/v1/admissions/leads/${id}/reopen`),
    onSuccess: () => { setOk('Reopened.'); refresh() },
  })

  if (q.isLoading) return <Card><Loading shape="form" /></Card>
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>
  const { enquiry: e, activities, duplicates, application } = q.data
  const closed = e.status === 'applied' || e.status === 'lost'
  const today = ymdIn(0)
  const late = !closed && e.next_follow_up && e.next_follow_up < today

  return (
    <Card>
      <CardHeader
        title={e.student_name}
        description={[e.parent_name, e.class_name ? `for ${e.class_name}` : null, SOURCES.find((s) => s.value === e.source)?.label ?? e.source,
          `enquired ${formatDate(e.created_at)}`].filter(Boolean).join(' · ')}
        action={
          <span className="flex items-center gap-2">
            <StatusPill status={e.status} />
            <Button variant="ghost" size="sm" title="Close" onClick={onClose}><X className="h-4 w-4" /></Button>
          </span>
        }
      />
      <div className="grid gap-6 border-t p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          {/* Reach them: the two things a counsellor does most, one tap each. */}
          <div className="flex flex-wrap gap-2">
            <a href={`tel:${e.phone}`} className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-card px-3 text-[13px] font-medium hover:bg-muted">
              <Phone className="h-3.5 w-3.5" />{e.phone}
            </a>
            <a href={waLink(e.phone, msg || undefined)} target="_blank" rel="noreferrer"
              onClick={() => { if (msg.trim()) log.mutate({ kind: 'whatsapp', body: msg.trim() }) }}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-card px-3 text-[13px] font-medium text-success hover:bg-muted">
              <MessageCircle className="h-3.5 w-3.5" />WhatsApp
            </a>
            {e.email && (
              <a href={`mailto:${e.email}`} className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-[13px] hover:bg-muted">{e.email}</a>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 text-[13px]">
            <div><div className="text-muted-foreground">Parent</div><div>{e.parent_name ?? '-'}</div></div>
            <div><div className="text-muted-foreground">Class sought</div><div>{e.class_name ?? '-'}</div></div>
            <div><div className="text-muted-foreground">Source</div><div>{SOURCES.find((s) => s.value === e.source)?.label ?? e.source}</div></div>
            <div><div className="text-muted-foreground">Enquired</div><div>{formatDate(e.created_at)}</div></div>
            <div>
              <div className="text-muted-foreground">Next follow-up</div>
              <div className={late ? 'font-medium text-destructive' : ''}>
                {e.next_follow_up ? formatDate(e.next_follow_up) : 'Not set'}{late ? ' · overdue' : ''}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Last contacted</div>
              <div>{e.last_contacted_at ? when(e.last_contacted_at) : 'Never'}</div>
            </div>
            {e.assigned_to && (
              <div><div className="text-muted-foreground">Counsellor</div><div>{e.assigned_to}</div></div>
            )}
            {(e.referred_by || e.campaign) && (
              <div><div className="text-muted-foreground">{e.referred_by ? 'Referred by' : 'Campaign'}</div><div>{e.referred_by ?? e.campaign}</div></div>
            )}
          </div>

          {duplicates.length > 0 && (
            <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-[13px]">
              <div className="font-medium">Same phone number on {duplicates.length === 1 ? 'another enquiry' : `${duplicates.length} other enquiries`}</div>
              <ul className="mt-1 space-y-0.5">
                {duplicates.map((d) => (
                  <li key={d.id}>
                    <button type="button" className="text-primary hover:underline" onClick={() => onOpen(d.id)}>{d.student_name}</button>
                    <span className="text-muted-foreground"> · {stageLabel(d.status)} · {formatDate(d.created_at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Stage, and the two ways out of the pipeline. */}
          {!closed ? (
            <div className="space-y-3">
              <div className="text-[13px] text-muted-foreground">Stage</div>
              <div className={SEG_BAR} role="group" aria-label="Stage">
                {STAGES.filter((s) => s.value !== 'applied' && s.value !== 'lost').map((s) => (
                  <button key={s.value} type="button" className={segClass(e.status === s.value)} disabled={stage.isPending}
                    onClick={() => e.status !== s.value && stage.mutate(s.value)}>{s.label}</button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => nav(convertHref({ ...e }))}>Convert to application</Button>
                <ApplyLink id={id} phone={e.phone} />
                <Button variant="secondary" tone="danger" onClick={() => setLosing((v) => !v)}>Lost</Button>
              </div>
              {losing && <LostForm id={id} onDone={() => { setLosing(false); setOk('Closed as lost.') }} onCancel={() => setLosing(false)} />}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              {application ? (
                <span>Application <span className="font-medium">{application.application_no}</span> · <StatusPill status={application.status} /></span>
              ) : e.status === 'lost' ? (
                <span className="text-muted-foreground">Lost{e.lost_reason ? `: ${e.lost_reason.replace(/_/g, ' ')}` : ''}{e.lost_reason_note ? ` (${e.lost_reason_note})` : ''}</span>
              ) : null}
              {e.status === 'lost' && <Button size="sm" variant="secondary" disabled={reopen.isPending} onClick={() => reopen.mutate()}>Reopen</Button>}
            </div>
          )}

          {/* Write the WhatsApp here, with AI if it is switched on; the button above opens it with this text. */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13px] text-muted-foreground">WhatsApp message</span>
              <WriteWithAI kind="enquiry_follow_up" context={{ enquiry_id: id }} current={msg} onInsert={setMsg} label="Draft with AI" defaultLength="short" align="right" />
            </div>
            <Textarea value={msg} onChange={setMsg} rows={3} placeholder="Hello, this is the admissions office…" />
            {msg.trim() && (
              <a href={waLink(e.phone, msg)} target="_blank" rel="noreferrer"
                onClick={() => { log.mutate({ kind: 'whatsapp', body: msg.trim() }); setMsg('') }}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground">
                <MessageCircle className="h-3.5 w-3.5" />Send on WhatsApp
              </a>
            )}
          </div>
        </div>

        <div className="space-y-5">
          {/* Log what just happened, and when to try again. */}
          {!closed && (
            <div className="space-y-3 rounded-md border p-4">
              <div className={SEG_BAR} role="group" aria-label="What happened">
                {(['call', 'whatsapp', 'visit', 'note'] as const).map((k) => (
                  <button key={k} type="button" className={segClass(kind === k)} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>
                ))}
              </div>
              <Textarea value={body} onChange={setBody} rows={2}
                placeholder={kind === 'call' ? 'What did they say? (no answer, will visit Saturday…)' : kind === 'note' ? 'Note' : 'Optional detail'} />
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1.5 text-[13px]">
                  <span className="text-muted-foreground">Follow up on</span>
                  <Input type="date" value={follow} onChange={setFollow} />
                </label>
                {[['Tomorrow', 1], ['3 days', 3], ['Next week', 7]].map(([l, n]) => (
                  <Button key={l} size="sm" variant={follow === ymdIn(n as number) ? 'secondary' : 'ghost'} onClick={() => setFollow(ymdIn(n as number))}>{l}</Button>
                ))}
              </div>
              <Button disabled={log.isPending || (kind === 'note' && !body.trim())}
                onClick={() => log.mutate({ kind, body: body.trim() || undefined, next_follow_up: follow || undefined })}>
                {log.isPending ? 'Saving…' : `Log ${KIND_LABEL[kind].toLowerCase()}`}
              </Button>
            </div>
          )}
          <FormNotice error={log.error ?? stage.error ?? reopen.error} ok={ok} />

          <div>
            <div className="mb-2 text-[13px] font-medium">Timeline</div>
            {activities.length === 0 ? (
              <div className="text-[13px] text-muted-foreground">
                Nothing logged yet.{e.notes ? <div className="mt-1 whitespace-pre-line">{e.notes}</div> : null}
              </div>
            ) : (
              <ol className="space-y-3 border-l pl-4">
                {activities.map((a) => {
                  const Icon = KIND_ICON[a.kind] ?? StickyNote
                  return (
                    <li key={a.id} className="relative text-[13px]">
                      <span className="absolute -left-[25px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full border bg-card">
                        <Icon className="h-2.5 w-2.5 text-muted-foreground" />
                      </span>
                      <div className="font-medium">
                        {a.kind === 'stage'
                          ? `${a.from_status ? stageLabel(a.from_status) + ' → ' : ''}${stageLabel(a.to_status ?? '')}`
                          : KIND_LABEL[a.kind] ?? a.kind}
                      </div>
                      {a.body && <div className="whitespace-pre-line">{a.body}</div>}
                      <div className="text-muted-foreground">
                        {when(a.created_at)}{a.author ? ` · ${a.author}` : ''}{a.next_follow_up ? ` · follow up ${formatDate(a.next_follow_up)}` : ''}
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
          </div>
        </div>
      </div>
    </Card>
  )
}
