import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Badge, Button, Card, Checkbox, ErrorState, FormNotice, Loading, Textarea } from '@/components/ui'
import { PickerMenu } from '@/components/PickerMenu'
import { ConversationPane } from '@/components/ChatScreen'
import { useSession } from '@/lib/session'
import { cn, formatDateTime } from '@/lib/utils'
import { buzz } from '@/lib/haptics'
import { useToast } from '@/components/Toast'
import type { VendorTicket } from '../super_admin/platform-lib'
import type { HelpDiagnostics, HelpThreadEntry } from '@shared/api/feature_helpdesk'

/* THE DESK: queues on the left, tickets in the middle, the conversation and
   what is known about it on the right. On a phone the queues become a picker
   and the conversation a full screen.

   Built on the queue that was already here (SupportTickets.tsx and
   GET /admin/platform/seller/tickets, with the SLA by plan and the agent who
   holds each ticket); the conversation, context and bulk actions are
   worker/src/routes/help/desk.ts. */

type Queue = { key: string; label: string; test: (t: VendorTicket) => boolean }

const BASE = '/api/v1/admin/platform'
const STATUS: Record<string, string> = { open: 'Open', in_progress: 'In progress', waiting: 'Waiting on school', resolved: 'Solved', closed: 'Closed' }
const PRIORITY_TONE = (p: string) => (p === 'urgent' ? 'danger' : p === 'high' ? 'warning' : 'neutral') as 'danger' | 'warning' | 'neutral'

/** "5 h left", "2 h over": the clock against what the school's plan was promised. */
export function slaClock(t: VendorTicket): { text: string; late: boolean; close: boolean } {
  if (t.status === 'resolved' || t.status === 'closed' || !t.promised_hours) return { text: '', late: false, close: false }
  const left = t.promised_hours - t.open_hours
  const fmt = (h: number) => (h >= 48 ? `${Math.floor(h / 24)} d` : `${h} h`)
  return left < 0 ? { text: `${fmt(-left)} over`, late: true, close: false } : { text: `${fmt(left)} left`, late: false, close: left <= t.promised_hours * 0.25 }
}

interface Detail {
  id: string; subject: string; body: string; status: string; stage: string; priority: string; category: string; school: { id: string; name: string }
  raised_by?: string; agent?: string; escalated: boolean; route?: string; error_ref?: string; diagnostics: HelpDiagnostics
  error?: { code: string; at: string; method: string; route: string; message: string; role?: string; user?: string; release?: string }
  error_expired: boolean; incident?: { title: string; workaround: string }; thread: HelpThreadEntry[]; created_at: string
}
interface Context {
  school: { name: string; status: string; plan?: string; subscription?: string }
  health?: { computed_at: string; errors_24h?: number; jobs_failed_24h?: number; last_activity_at?: string; problems: { label: string; count: number }[] }
  switches: { feature: string; on: boolean; ends_at?: string }[]
  raised_by: { roles?: string; last_sign_in?: string }
  recent_changes: { at: string; action: string; entity_type: string }[]
}
interface Canned { key: string; title: string; body: string }

export function DeskPanes({ items }: { items: VendorTicket[] }) {
  const me = useSession().user?.id
  const [queue, setQueue] = useState('open')
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const qc = useQueryClient()
  const toast = useToast()

  const queues = useMemo<Queue[]>(() => {
    const live = (t: VendorTicket) => t.status !== 'resolved' && t.status !== 'closed'
    const base: Queue[] = [
      { key: 'open', label: 'All open', test: live },
      { key: 'unassigned', label: 'Unassigned', test: (t) => live(t) && !t.assigned_to },
      { key: 'mine', label: 'Mine', test: (t) => live(t) && !!me && t.agent_id === me },
      { key: 'reply', label: 'School replied', test: (t) => live(t) && t.last_reply_side === 'raiser' },
      { key: 'waiting', label: 'Waiting on school', test: (t) => t.status === 'waiting' },
      { key: 'overdue', label: 'Overdue', test: (t) => live(t) && t.breached },
    ]
    const schools = [...new Set(items.map((t) => t.school ?? ''))].filter(Boolean).sort()
    const cats = [...new Set(items.map((t) => t.category))].sort()
    return [...base,
      ...schools.map((s) => ({ key: `s:${s}`, label: s, test: (t: VendorTicket) => live(t) && t.school === s })),
      ...cats.map((k) => ({ key: `c:${k}`, label: k.replace(/_/g, ' '), test: (t: VendorTicket) => live(t) && t.category === k })),
    ]
  }, [items, me])
  const q = queues.find((x) => x.key === queue) ?? queues[0]
  const shown = items.filter(q.test)
  const keyOf = (t: VendorTicket) => `${t.institution_id}/${t.id}`
  const open = items.find((t) => keyOf(t) === openKey)

  const bulk = useMutation({
    mutationFn: (b: { action: string; into?: { school: string; id: string } }) => api.post<{ done: number }>(`${BASE}/desk/bulk`, {
      ...b, items: [...picked].map((k) => { const [school, id] = k.split('/'); return { school, id } }) }),
    onSuccess: (r, b) => {
      buzz('tap'); setPicked(new Set())
      toast.ok(b.action === 'take' ? `${r.done} taken` : b.action === 'close' ? `${r.done} closed` : `${r.done} merged`)
      qc.invalidateQueries({ queryKey: ['platform', 'tickets'] })
    },
  })
  const pickedTickets = items.filter((t) => picked.has(keyOf(t)))
  const oneSchool = pickedTickets.length > 1 && new Set(pickedTickets.map((t) => t.institution_id)).size === 1

  const QueueList = (
    <nav aria-label="Queues" className="hidden lg:block">
      <Card className="py-2">
        {queues.map((x, i) => {
          const n = items.filter(x.test).length
          if (i >= 6 && !n) return null
          const heading = i === 6 ? 'By school' : x.key.startsWith('c:') && !queues[i - 1].key.startsWith('c:') ? 'By category' : null
          return (
            <div key={x.key}>
              {heading && <p className="px-4 pb-1 pt-3 text-[12px] font-semibold text-muted-foreground">{heading}</p>}
              <button type="button" onClick={() => setQueue(x.key)} aria-current={queue === x.key ? 'true' : undefined}
                className={cn('flex min-h-[40px] w-full items-center justify-between gap-2 px-4 text-left text-[14px] hover:bg-surface-hover', x.key.startsWith('c:') && 'capitalize', queue === x.key && 'bg-surface-hover font-semibold')}>
                <span className="min-w-0 truncate">{x.label}</span><span className="tabular-nums text-muted-foreground">{n}</span>
              </button>
            </div>
          )
        })}
      </Card>
    </nav>
  )

  return (
    <div className="grid gap-4 lg:grid-cols-[13rem_minmax(0,1fr)_minmax(0,1.6fr)]">
      {QueueList}
      <div className="min-w-0 space-y-3">
        <div className="lg:hidden">
          <PickerMenu ariaLabel="Queue" value={queue} align="start" onChange={setQueue}
            options={queues.filter((x, i) => i < 6 || items.some(x.test)).map((x) => ({ value: x.key, label: `${x.label} (${items.filter(x.test).length})` }))} />
        </div>
        {picked.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2 text-[14px]">
            <span className="mr-auto">{picked.size} chosen</span>
            <Button size="sm" variant="secondary" pending={bulk.isPending} onClick={() => bulk.mutate({ action: 'take' })}>Take</Button>
            {oneSchool && open && picked.has(keyOf(open)) && (
              <Button size="sm" variant="secondary" pending={bulk.isPending}
                onClick={() => bulk.mutate({ action: 'merge', into: { school: open.institution_id!, id: open.id } })}>Merge into the open one</Button>
            )}
            <Button size="sm" variant="secondary" pending={bulk.isPending} onClick={() => bulk.mutate({ action: 'close' })}>Close</Button>
            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>
          </div>
        )}
        <FormNotice error={bulk.error} />
        {shown.length === 0 ? (
          <Card className="px-4 py-6 text-center text-[14px] text-muted-foreground">Nothing in this queue.</Card>
        ) : (
          <Card>
            <ul className="divide-y">
              {shown.map((t) => {
                const k = keyOf(t), clock = slaClock(t)
                return (
                  <li key={k} className={cn('flex items-start gap-2 px-3 py-3', openKey === k && 'bg-surface-hover')}>
                    <Checkbox checked={picked.has(k)} srLabel={`Choose ${t.subject}`} label=""
                      onChange={(v) => setPicked((s) => { const n = new Set(s); if (v) n.add(k); else n.delete(k); return n })} />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpenKey(k)} aria-current={openKey === k ? 'true' : undefined}>
                      <div className={cn('truncate', t.last_reply_side === 'raiser' ? 'font-semibold' : 'font-medium')}>{t.subject}</div>
                      <div className="truncate text-[12px] text-muted-foreground">{t.school} · {t.category.replace(/_/g, ' ')}{t.assigned_to ? ` · ${t.assigned_to}` : ' · unassigned'}</div>
                    </button>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Badge tone={PRIORITY_TONE(t.priority)}><span className="capitalize">{t.priority}</span></Badge>
                      {clock.text && <span className={cn('text-[12px] tabular-nums', clock.late ? 'font-semibold text-destructive' : clock.close ? 'text-warning' : 'text-muted-foreground')}>{clock.text}</span>}
                    </div>
                  </li>
                )
              })}
            </ul>
          </Card>
        )}
      </div>
      {open?.institution_id ? <Conversation t={open} onClose={() => setOpenKey(null)} /> : (
        <ConversationPane open={false} title="" onBack={() => setOpenKey(null)} empty="Open a ticket from the list.">{null}</ConversationPane>
      )}
    </div>
  )
}

function fill(body: string, t: { raised_by?: string; school?: string }, agent: string): string {
  return body.replace(/\{\{name\}\}/g, (t.raised_by ?? '').split(' ')[0] || 'there').replace(/\{\{school\}\}/g, t.school ?? 'your school').replace(/\{\{agent\}\}/g, agent)
}

function Conversation({ t, onClose }: { t: VendorTicket; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const agent = useSession().user?.full_name ?? ''
  const path = `${BASE}/desk/${t.institution_id}/tickets/${t.id}`
  const d = useQuery({ queryKey: ['desk', t.id], queryFn: () => api.get<Detail>(path), staleTime: 0 })
  const ctx = useQuery({ queryKey: ['desk', t.id, 'context'], queryFn: () => api.get<Context>(`${path}/context`) })
  const canned = useQuery({ queryKey: ['help-content', 'canned'], queryFn: () => api.get<{ items: { item: Canned; hidden: boolean }[] }>(`${BASE}/help-content/canned`) })
  const [body, setBody] = useState('')
  const [internal, setInternal] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [tab, setTab] = useState<'talk' | 'context'>('talk')
  const refresh = () => { qc.invalidateQueries({ queryKey: ['desk', t.id] }); qc.invalidateQueries({ queryKey: ['platform', 'tickets'] }) }
  const reply = useMutation({ mutationFn: () => api.post(`${path}/reply`, { body, internal, waiting }), onSuccess: () => { setBody(''); setWaiting(false); refresh() } })
  const solve = useMutation({ mutationFn: () => api.post(`${path}/resolve`, { resolution: body }), onSuccess: () => { buzz('tap'); setBody(''); toast.ok('Solved. The school is told.'); refresh() } })
  const v = d.data
  const settled = v && (v.status === 'resolved' || v.status === 'closed')
  const cannedOptions = (canned.data?.items ?? []).filter((x) => !x.hidden).map((x) => ({ value: x.item.key, label: x.item.title }))

  return (
    <ConversationPane open title={<span>{t.subject}</span>} onBack={onClose}
      subtitle={`${t.school} · ${STATUS[t.status] ?? t.status}${slaClock(t).text ? ` · ${slaClock(t).text}` : ''}`}>
      <div className="flex shrink-0 gap-1 border-b px-3 py-2" role="tablist">
        {(['talk', 'context'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cn('rounded-full px-3 py-1.5 text-[13px]', tab === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-surface-hover')}>
            {k === 'talk' ? 'Conversation' : 'What we know'}
          </button>
        ))}
      </div>
      {d.error ? <div className="p-4"><ErrorState error={d.error} /></div> : !v ? <Loading /> : tab === 'context' ? (
        <ContextPanel v={v} c={ctx.data} error={ctx.error} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
            {v.escalated && <p className="text-[13px] text-muted-foreground">Passed on by the school's helpdesk. The text is their summary; the family's own words stay in the school.</p>}
            <Bubble e={{ id: 'first', kind: 'raised', body: v.body, side: 'raiser', author: v.raised_by ?? 'School', internal: false, created_at: v.created_at }} />
            {v.thread.map((e) => <Bubble key={e.id} e={e} />)}
          </div>
          {!settled && (
            <div className="space-y-2 border-t p-3">
              {cannedOptions.length > 0 && (
                <PickerMenu ariaLabel="Canned reply" value={'' as string} placeholder="Canned reply" align="start" options={cannedOptions}
                  onChange={(k) => { const c = canned.data?.items.find((x) => x.item.key === k)?.item; if (c) setBody(fill(c.body, t, agent)) }} />
              )}
              <Textarea value={body} onChange={setBody} rows={3} aria-label="Reply" placeholder={internal ? 'A note only the desk sees' : `Reply to ${t.school}`} />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Checkbox checked={internal} onChange={setInternal} label="Note for the desk only" />
                {!internal && <Checkbox checked={waiting} onChange={setWaiting} label="Waiting on the school" />}
                <div className="ml-auto flex gap-2">
                  {!internal && <Button size="sm" variant="secondary" disabled={!body.trim()} pending={solve.isPending} onClick={() => solve.mutate()}>Send as the answer</Button>}
                  <Button size="sm" disabled={!body.trim()} pending={reply.isPending} onClick={() => reply.mutate()}>Send</Button>
                </div>
              </div>
              <FormNotice error={reply.error ?? solve.error} />
            </div>
          )}
        </div>
      )}
    </ConversationPane>
  )
}

function Bubble({ e }: { e: HelpThreadEntry }) {
  const ours = e.side === 'vendor'
  return (
    <div className={cn('max-w-[85%] rounded-lg px-3 py-2 text-[14px]', ours ? 'ml-auto bg-primary/10' : 'mr-auto bg-muted', e.internal && 'border border-dashed border-warning/60 bg-warning/10')}>
      <div className="mb-0.5 text-[12px] text-muted-foreground">{e.author || (ours ? 'XULO support' : 'School')}{e.internal ? ' · desk note' : ''} · {formatDateTime(e.created_at)}</div>
      <p className="whitespace-pre-wrap break-words">{e.body}</p>
    </div>
  )
}

function Row({ k, v }: { k: string; v?: string | number | null }) {
  if (v === undefined || v === null || v === '') return null
  return <div className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>
}

function ContextPanel({ v, c, error }: { v: Detail; c?: Context; error: unknown }) {
  const g = v.diagnostics
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-[14px]">
      {v.error ? (
        <section>
          <h4 className="mb-1 font-semibold">Error {v.error.code}</h4>
          <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
            <Row k="When" v={formatDateTime(v.error.at)} /><Row k="Request" v={`${v.error.method} ${v.error.route}`} />
            <Row k="Who" v={[v.error.user, v.error.role].filter(Boolean).join(', ')} /><Row k="Release" v={v.error.release} />
          </dl>
          <pre className="mt-1 whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-[12px]">{v.error.message}</pre>
        </section>
      ) : v.error_expired ? <p className="text-muted-foreground">Error {v.error_ref}: no longer kept (14 days).</p> : null}
      {v.incident && <section><h4 className="font-semibold">Known problem</h4><p>{v.incident.title}. {v.incident.workaround}</p></section>}
      {(v.route || Object.keys(g).length > 0) && <section>
        <h4 className="mb-1 font-semibold">The device</h4>
        <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
          <Row k="Screen" v={v.route ?? g.route} /><Row k="Role" v={g.role} /><Row k="Browser" v={[g.browser, g.os].filter(Boolean).join(' on ')} />
          <Row k="Size" v={g.viewport} /><Row k="Layout" v={[g.layout, g.theme].filter(Boolean).join(', ')} /><Row k="App version" v={g.app_version} />
          <Row k="Last failure" v={g.last_failed ? `${g.last_failed.path} (${g.last_failed.status})` : undefined} /><Row k="Page errors" v={g.client_errors?.join('; ')} />
        </dl>
      </section>}
      {error ? <ErrorState error={error} /> : !c ? <Loading /> : (
        <>
          <section>
            <h4 className="mb-1 font-semibold">{c.school.name}</h4>
            <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
              <Row k="Plan" v={[c.school.plan, c.school.subscription].filter(Boolean).join(', ')} /><Row k="Status" v={c.school.status} />
              <Row k="Errors, 24 h" v={c.health?.errors_24h} /><Row k="Failed jobs, 24 h" v={c.health?.jobs_failed_24h} />
              <Row k="Raised by" v={c.raised_by.roles} /><Row k="Their last sign-in" v={c.raised_by.last_sign_in ? formatDateTime(c.raised_by.last_sign_in) : undefined} />
            </dl>
            {!!c.health?.problems.length && <ul className="mt-1 list-disc pl-5">{c.health.problems.map((p) => <li key={p.label}>{p.label}: {p.count}</li>)}</ul>}
          </section>
          {c.switches.length > 0 && (
            <section><h4 className="mb-1 font-semibold">Feature switches</h4>
              <ul>{c.switches.map((s) => <li key={s.feature}>{s.feature}: {s.on ? 'on' : 'off'}{s.ends_at ? ` until ${s.ends_at.slice(0, 10)}` : ''}</li>)}</ul></section>
          )}
          {c.recent_changes.length > 0 && (
            <section><h4 className="mb-1 font-semibold">Recent changes in the school</h4>
              <ul>{c.recent_changes.map((a, i) => <li key={i} className="text-muted-foreground">{formatDateTime(a.at)} · {a.action} {a.entity_type}</li>)}</ul></section>
          )}
        </>
      )}
    </div>
  )
}
