import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, Badge, Button, Checkbox, Dialog, Field, FormNotice, Input, Textarea, EmptyState, ErrorState, Loading, SEG_BAR, segClass,
} from '@/components/ui'
import { ConversationPane } from '@/components/ChatScreen'
import { formatDate, formatDateTime, cn } from '@/lib/utils'
import { buzz } from '@/lib/haptics'
import { useToast } from '@/components/Toast'
import type { DeskTicket, DeskTicketDetail, HelpThreadEntry } from '@shared/api/feature_helpdesk'
import { STAGE_TONE, shownStage } from './help-lib'

/* Helpdesk: the school's own first line for requests from its families and
   staff (Help > Report a problem). Answer here, keep a note for the office,
   or pass it to XULO support with a summary that names no child.

   Lists down the left (or the whole phone screen), the open request on the
   right (or full screen with Back). Reads GET /help/desk and /help/desk/{id}
   (worker/src/routes/help/helpdesk.ts). */

const BOXES: { key: string; label: string; count: keyof import('@shared/api/feature_helpdesk').DeskCounts }[] = [
  { key: 'open', label: 'Open', count: 'open' },
  { key: 'unassigned', label: 'Unassigned', count: 'unassigned' },
  { key: 'mine', label: 'Mine', count: 'mine' },
  { key: 'waiting', label: 'Waiting', count: 'waiting' },
  { key: 'overdue', label: 'Overdue', count: 'overdue' },
  { key: 'vendor', label: 'With XULO support', count: 'with_vendor' },
  { key: 'solved', label: 'Solved', count: 'solved' },
]

const STAGE_NAME: Record<string, string> = { new: 'New', acknowledged: 'Seen', in_progress: 'In progress', waiting: 'Waiting on them', resolved: 'Solved', closed: 'Closed' }

export default function Helpdesk() {
  const [params, setParams] = useSearchParams()
  const box = params.get('box') ?? 'open'
  const openId = params.get('id')
  const [q, setQ] = useState('')
  const list = useQuery({
    queryKey: ['helpdesk', box, q],
    queryFn: () => api.call('GET /help/desk', { query: { box, q } }),
    staleTime: 0,
    refetchInterval: 60_000,
  })
  const set = (next: Record<string, string>) => setParams({ box, ...next })
  const counts = list.data?.counts

  return (
    <>
      <PageHead eyebrow="Help" title="Helpdesk" />
      <PageBody>
        <div className={cn(SEG_BAR, 'w-full')} role="tablist" aria-label="Lists">
          {BOXES.map((b) => (
            <button key={b.key} type="button" role="tab" aria-selected={box === b.key} className={segClass(box === b.key)}
              onClick={() => setParams({ box: b.key })}>
              {b.label}{counts ? ` ${counts[b.count]}` : ''}
            </button>
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
          <div className="min-w-0 space-y-3" data-help-anchor="helpdesk-list" data-help-label="Requests from your school wait here. Open one to answer it.">
            <Input value={q} onChange={setQ} type="search" srLabel="Search requests" placeholder="Search by words, name or Ref code" />
            {list.error ? <ErrorState error={list.error} /> : list.isLoading ? <Loading /> : !list.data?.items.length ? (
              <EmptyState title={box === 'open' ? 'Nothing waiting' : 'Nothing in this list'}
                body={box === 'open' ? 'Requests families and staff send from Help appear here, and the bell tells you.' : undefined} />
            ) : (
              <Card>
                <ul className="divide-y">
                  {list.data.items.map((t) => <Row key={t.id} t={t} active={t.id === openId} onOpen={() => set({ id: t.id })} />)}
                </ul>
              </Card>
            )}
          </div>
          {openId ? <Detail id={openId} onClose={() => set({})} /> : (
            <ConversationPane open={false} title="" onBack={() => set({})} empty="Open a request from the list.">{null}</ConversationPane>
          )}
        </div>
      </PageBody>
    </>
  )
}

function Row({ t, active, onOpen }: { t: DeskTicket; active: boolean; onOpen: () => void }) {
  const stage = shownStage(t)
  return (
    <li>
      <button type="button" onClick={onOpen} aria-current={active ? 'true' : undefined}
        className={cn('flex min-h-[44px] w-full items-start gap-3 px-[var(--card-pad)] py-3 text-left hover:bg-surface-hover', active && 'bg-surface-hover')}>
        <div className="min-w-0 flex-1">
          <div className={cn('truncate', t.last_reply_side === 'raiser' && t.stage !== 'closed' ? 'font-semibold' : 'font-medium')}>{t.subject}</div>
          <div className="truncate text-[12px] text-muted-foreground">
            {t.with === 'vendor' ? 'Sent to XULO support' : t.raised_by}{` · ${formatDate(t.created_at)}`}
            {t.me_too > 0 && ` · ${t.me_too + 1} people`}
            {t.assigned_to && ` · ${t.assigned_to}`}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone={STAGE_TONE[stage] ?? 'neutral'}>{STAGE_NAME[stage] ?? stage}</Badge>
          {t.resolve_breached && t.stage !== 'resolved' && t.stage !== 'closed' && <Badge tone="danger">Overdue</Badge>}
          {t.priority === 'high' || t.priority === 'urgent' ? <Badge tone="warning">Urgent</Badge> : null}
        </div>
      </button>
    </li>
  )
}

function Entry({ e }: { e: HelpThreadEntry }) {
  const theirs = e.side === 'raiser'
  return (
    <li className={cn('max-w-[85%] rounded-lg px-3 py-2 text-[14px]', theirs ? 'mr-auto bg-muted' : 'ml-auto bg-primary/10',
      e.internal && 'border border-dashed border-warning/60 bg-warning/10')}>
      <div className="mb-0.5 text-[12px] text-muted-foreground">
        {e.author || (theirs ? 'They' : 'School')}{e.internal ? ' · note for the office' : ''}{` · ${formatDateTime(e.created_at)}`}
      </div>
      <p className="whitespace-pre-wrap break-words">{e.body}</p>
    </li>
  )
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const key = ['helpdesk', 'ticket', id]
  const q = useQuery({ queryKey: key, queryFn: () => api.call('GET /help/desk/{id}', { params: { id } }), staleTime: 0 })
  const done = () => { qc.invalidateQueries({ queryKey: ['helpdesk'] }) }
  const [body, setBody] = useState('')
  const [internal, setInternal] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [solveOpen, setSolveOpen] = useState(false)
  const [resolution, setResolution] = useState('')
  const [escOpen, setEscOpen] = useState(false)

  const reply = useMutation({
    mutationFn: () => api.call('POST /help/desk/{id}/reply', { params: { id }, body: { body, internal, waiting } }),
    onSuccess: () => { setBody(''); setWaiting(false); done() },
  })
  const take = useMutation({ mutationFn: () => api.call('POST /help/desk/{id}/take', { params: { id } }), onSuccess: done })
  const solve = useMutation({
    mutationFn: () => api.call('POST /help/desk/{id}/resolve', { params: { id }, body: { resolution } }),
    onSuccess: () => { buzz('tap'); setSolveOpen(false); setResolution(''); toast.ok('Marked solved. They have been told.'); done() },
  })

  const d: DeskTicketDetail | undefined = q.data
  const open = d && d.status !== 'resolved' && d.status !== 'closed'
  const own = d?.with === 'school'
  const escalationOpen = d?.escalation && d.escalation.status !== 'resolved' && d.escalation.status !== 'closed'

  return (
    <ConversationPane open title={<span>{d?.subject ?? ''}</span>} onBack={onClose}
      subtitle={d ? `${d.with === 'vendor' ? 'Sent to XULO support' : d.raised_by} · ${STAGE_NAME[shownStage(d)] ?? d.stage}` : undefined}>
      {q.error ? <div className="p-4"><ErrorState error={q.error} /></div> : !d ? <Loading /> : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {d.incident && (
              <div className="rounded-md bg-muted px-3 py-2 text-[14px]">
                <p className="font-semibold">Known problem: {d.incident.title}</p>
                <p>{d.incident.workaround}</p>
              </div>
            )}
            <ul className="flex flex-col gap-2">
              <Entry e={{ id: 'first', kind: 'raised', body: d.body, side: 'raiser', author: d.raised_by, internal: false, created_at: d.created_at }} />
              {d.thread.map((e) => <Entry key={e.id} e={e} />)}
            </ul>
            {d.attachment && (
              <a href={`/api/v1/help/desk/${d.id}/attachment`} target="_blank" rel="noreferrer" className="block">
                <img src={`/api/v1/help/desk/${d.id}/attachment`} alt="Screenshot sent with the request" className="max-h-72 rounded-md shadow-[var(--field-shadow)]" />
              </a>
            )}
            {d.escalation_thread && d.escalation && (
              <section className="space-y-2 rounded-md border px-3 py-3">
                <p className="text-[13px] font-semibold">XULO support · {STAGE_NAME[d.escalation.status === 'waiting' ? 'waiting' : d.escalation.stage] ?? d.escalation.stage}</p>
                {d.escalation_thread.length ? (
                  <ul className="flex flex-col gap-2">{d.escalation_thread.map((e) => <Entry key={e.id} e={e} />)}</ul>
                ) : <p className="text-[13px] text-muted-foreground">No reply yet. The bell tells you when there is one.</p>}
                {escalationOpen && (
                  <p className="text-[13px] text-muted-foreground">To write to XULO support, open the request in With XULO support.</p>
                )}
              </section>
            )}
            <Diagnostics d={d} />
          </div>

          {open && (
            <div className="space-y-2 border-t p-3">
              <Textarea value={body} onChange={setBody} rows={2} aria-label="Reply"
                placeholder={own ? (internal ? 'A note only the office sees' : `Reply to ${d.raised_by}`) : 'Write to XULO support. Name no child.'} />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {own && <Checkbox checked={internal} onChange={setInternal} label="Note for the office only" />}
                {own && !internal && <Checkbox checked={waiting} onChange={setWaiting} label="Waiting for their answer" />}
                <div className="ml-auto flex flex-wrap gap-2">
                  {own && !d.assigned_to_id && <Button variant="secondary" size="sm" pending={take.isPending} onClick={() => take.mutate()}>Take</Button>}
                  {own && !escalationOpen && (
                    <span data-help-anchor="helpdesk-escalate"><Button variant="secondary" size="sm" onClick={() => setEscOpen(true)}>Pass to XULO support</Button></span>
                  )}
                  {own && <Button variant="secondary" size="sm" onClick={() => setSolveOpen(true)}>Mark solved</Button>}
                  <Button size="sm" disabled={!body.trim()} pending={reply.isPending} onClick={() => reply.mutate()}>Send</Button>
                </div>
              </div>
              <FormNotice error={reply.error ?? take.error} />
            </div>
          )}
        </div>
      )}

      {solveOpen && d && (
        <Dialog onClose={() => setSolveOpen(false)} title="Mark solved" description={`${d.raised_by} is told at once and can say whether it worked.`}
          footer={<><Button variant="ghost" onClick={() => setSolveOpen(false)}>Cancel</Button>
            <Button disabled={!resolution.trim()} pending={solve.isPending} onClick={() => solve.mutate()}>Mark solved</Button></>}>
          <Field label="What solved it" required>
            <Textarea value={resolution} onChange={setResolution} rows={3} aria-label="What solved it" />
          </Field>
          <FormNotice error={solve.error} />
        </Dialog>
      )}
      {escOpen && d && <Escalate d={d} onClose={() => setEscOpen(false)} onDone={() => { setEscOpen(false); done() }} />}
    </ConversationPane>
  )
}

function Escalate({ d, onClose, onDone }: { d: DeskTicketDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [summary, setSummary] = useState('')
  const [urgent, setUrgent] = useState(d.priority === 'high' || d.priority === 'urgent')
  const [confirmed, setConfirmed] = useState(false)
  const send = useMutation({
    mutationFn: () => api.call('POST /help/desk/{id}/escalate', { params: { id: d.id }, body: { summary, urgent, confirmed } }),
    onSuccess: () => { buzz('tap'); toast.ok('Sent to XULO support. The bell tells you when they reply.'); onDone() },
  })
  return (
    <Dialog onClose={onClose} title="Pass to XULO support"
      description="XULO support gets your summary, the screen, the role and the device details. Not the family's words, their name, the screenshot or any child."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={!summary.trim() || !confirmed} pending={send.isPending} onClick={() => send.mutate()}>Send to XULO support</Button></>}>
      <div className="space-y-4">
        <Field label="Summary for XULO support" hint='Say what goes wrong and on which screen. Write "a student in Class 5 A", never a name or admission number.' required>
          <Textarea value={summary} onChange={setSummary} rows={4} aria-label="Summary for XULO support" />
        </Field>
        <Checkbox checked={urgent} onChange={setUrgent} label="It is stopping work at the school" />
        <Checkbox checked={confirmed} onChange={setConfirmed} label="I have checked that this summary names no child" />
        <FormNotice error={send.error} />
      </div>
    </Dialog>
  )
}

function Diagnostics({ d }: { d: DeskTicketDetail }) {
  const g = d.diagnostics
  const rows: [string, string | undefined][] = [
    ['Screen', d.route ?? g.route], ['Role', d.role ?? g.role], ['Error reference', d.error_ref], ['Browser', [g.browser, g.os].filter(Boolean).join(' on ') || undefined],
    ['Screen size', g.viewport], ['Layout and theme', [g.layout, g.theme].filter(Boolean).join(', ') || undefined], ['App version', g.app_version],
    ['Connection', g.online === undefined ? undefined : g.online ? 'Online' : 'Offline'],
    ['Last failed request', g.last_failed ? `${g.last_failed.path} (${g.last_failed.status})` : undefined],
    ['Errors on the page', g.client_errors?.join('; ')],
  ]
  const shown = rows.filter(([, v]) => v)
  if (!shown.length && !g.conversation?.length && !g.checks?.length) return null
  return (
    <details className="rounded-md bg-muted/60 px-3 py-2 text-[13px]">
      <summary className="cursor-pointer py-1 font-medium">Sent with the request</summary>
      <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
        {shown.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>)}
      </dl>
      {g.checks?.length ? (
        <ul className="mt-2 space-y-1">{g.checks.map((c, i) => <li key={i}>{c.ok ? 'OK' : 'Problem'}: {c.check}. {c.detail}</li>)}</ul>
      ) : null}
      {g.conversation?.length ? (
        <div className="mt-2 space-y-1">
          <p className="font-medium">Their conversation with the assistant</p>
          {g.conversation.map((m, i) => <p key={i}><span className="text-muted-foreground">{m.role === 'user' ? 'They' : 'Assistant'}:</span> {m.text}</p>)}
        </div>
      ) : null}
    </details>
  )
}
