import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { api } from '@/lib/api'
import type { ConnectConversation, ConnectMatch, ConnectMessage, ConnectState, ConnectThread } from '@shared/api/feature_yajur_connect'
import {
  PageHead, PageBody, Badge, Button, Card, ConfirmButton, Dialog, EmptyState, ErrorState, Field, FormNotice, Input, Loading, Select,
  Switch, Textarea, SEG_BAR, segClass,
} from '@/components/ui'
import { ChatThread, type ChatMessage } from '@/components/Chat'
import { ConversationPane, PersonAvatar } from '@/components/ChatScreen'
import { cn, formatDateTime } from '@/lib/utils'
import { usePhone } from '@/lib/viewport'

/* Yajur Connect: the school's WhatsApp chats with parents
   (worker/src/routes/comms/yajur_connect.ts). The list on the left, the open
   chat on the right (the whole screen on a phone), and beside the chat the
   family the number belongs to. A reply goes into the school's message queue;
   while the recipient guard is on it waits there and is not delivered, and
   the screen says so. */

type View = ConnectState | 'all'
const VIEWS: { key: View; label: string }[] = [{ key: 'open', label: 'Open' }, { key: 'resolved', label: 'Resolved' }, { key: 'all', label: 'All' }]
const MATCH_LABEL: Record<ConnectMatch, string> = { exact: 'Is exactly', starts: 'Starts with', contains: 'Contains' }
const PAUSED = 'Sending is paused: the recipient guard is on, so replies and auto-replies are blocked and will not be sent later.'

const KIND_LABEL: Record<string, string> = {
  image: 'Photo', video: 'Video', audio: 'Voice note', document: 'Document', sticker: 'Sticker', location: 'Location', reaction: 'Reaction',
}
function bodyOf(m: ConnectMessage): string {
  if (m.kind === 'reaction') return `Reacted ${m.text ?? ''}`.trim()
  const label = KIND_LABEL[m.kind]
  if (m.media_id || (label && m.kind !== 'location')) {
    const name = m.media_name ? ` ${m.media_name}` : ''
    return `[${label ?? m.kind}${name}, kept on WhatsApp]${m.text ? '\n' + m.text : ''}`
  }
  if (m.kind === 'location') return `[Location] ${m.text ?? ''}`.trim()
  return m.text ?? ''
}
const STATUS_NOTE: Record<string, string> = { queued: 'Queued', suppressed: 'Held by the recipient guard', failed: 'Not delivered', sent: 'Sent', delivered: 'Delivered', read: 'Read' }

const when = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

export default function YajurConnect() {
  const [params, setParams] = useSearchParams()
  const openId = params.get('c')
  const setOpenId = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('c', id)
    else next.delete('c')
    setParams(next, { replace: !id })
  }
  const [view, setView] = useState<View>('open')
  const [q, setQ] = useState('')
  const [mine, setMine] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const query = { state: view, q: q.trim() || undefined, mine: mine ? ('1' as const) : undefined }
  const list = useQuery({
    queryKey: ['connect', 'list', query],
    queryFn: () => api.call('GET /comms/yajur-connect', { query }),
    refetchInterval: 15_000,
  })
  const items = list.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="Communication"
        title="Yajur Connect"
        actions={list.data?.can_write ? <Button variant="secondary" onClick={() => setRulesOpen(true)}>Auto-replies</Button> : undefined}
      />
      <PageBody>
        {list.data?.guard_on && <p className="mb-3 text-[14px] text-muted-foreground">{PAUSED}</p>}
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="min-w-0 sm:w-72"><Input value={q} onChange={setQ} placeholder="Name, number, label or words" /></div>
          <div className={SEG_BAR} role="tablist">
            {VIEWS.map((v) => (
              <button key={v.key} type="button" role="tab" aria-selected={view === v.key} className={segClass(view === v.key)} onClick={() => setView(v.key)}>
                {v.label}
              </button>
            ))}
          </div>
          <label className="flex shrink-0 items-center gap-2">
            <Switch on={mine} onChange={setMine} label="Only chats assigned to me" />
            <span className="whitespace-nowrap text-[14px] text-muted-foreground">Assigned to me</span>
          </label>
        </div>
        <div className={cn('space-y-3', openId && 'lg:grid lg:h-[82dvh] lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-4 lg:space-y-0 lg:overflow-hidden')}>
          {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} /> : items.length === 0 ? (
            <Card>
              <EmptyState
                title={q || mine ? 'No chat matches.' : view === 'resolved' ? 'No resolved chats.' : 'No WhatsApp chats yet.'}
                body={q || mine ? 'Clear the search or the Assigned to me switch.' : 'A chat appears here when a parent writes to the school on WhatsApp.'}
              />
            </Card>
          ) : (
            <ul className="space-y-2 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:pr-1">
              {items.map((c) => <Row key={c.id} c={c} active={c.id === openId} onOpen={() => setOpenId(c.id)} />)}
            </ul>
          )}
          {openId && <Thread id={openId} canWrite={!!list.data?.can_write} onClose={() => setOpenId(null)} />}
        </div>
      </PageBody>
      {rulesOpen && <AutoReplies onClose={() => setRulesOpen(false)} />}
    </>
  )
}

function Row({ c, active, onOpen }: { c: ConnectConversation; active: boolean; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'true' : undefined}
        className={cn('card flex min-h-[64px] w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:border-primary/50', active && 'border-primary')}
      >
        <PersonAvatar name={c.name} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={cn('min-w-0 flex-1 truncate text-[16px] sm:text-[15px]', c.unread ? 'font-bold' : 'font-semibold')}>{c.name}</span>
            <span className="shrink-0 text-[12px] text-muted-foreground">{when(c.last_message_at)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[14px] text-muted-foreground">{c.last_preview ?? ''}</span>
            {c.unread > 0 && <Badge tone="primary">{String(c.unread)}</Badge>}
          </div>
          {(c.student_name || c.labels.length > 0 || c.assigned_name || c.state === 'resolved') && (
            <div className="mt-1 flex flex-wrap gap-1">
              {c.student_name && c.student_name !== c.name && <Badge>{c.student_name}</Badge>}
              {c.labels.map((l) => <Badge key={l} tone="info">{l}</Badge>)}
              {c.assigned_name && <Badge>{c.assigned_name}</Badge>}
              {c.state === 'resolved' && <Badge tone="success">Resolved</Badge>}
            </div>
          )}
        </div>
      </button>
    </li>
  )
}

function Thread({ id, canWrite, onClose }: { id: string; canWrite: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const phone = usePhone()
  const [details, setDetails] = useState(!phone)
  const t = useQuery({
    queryKey: ['connect', 'thread', id],
    queryFn: async () => {
      const r = await api.call('GET /comms/yajur-connect/{id}', { params: { id } })
      qc.invalidateQueries({ queryKey: ['connect', 'list'] })
      return r
    },
    refetchInterval: 10_000,
  })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['connect'] }) }
  const send = useMutation({
    mutationFn: (body: { text?: string; template_code?: string }) => api.call('POST /comms/yajur-connect/{id}/reply', { params: { id }, body }),
    onSuccess: refresh,
  })
  const d = t.data
  const title = d?.conversation.name ?? ''
  const messages: ChatMessage[] = (d?.messages ?? []).map((m) => ({
    id: m.id,
    body: bodyOf(m) + (m.direction === 'out' && STATUS_NOTE[m.status] ? `\n${STATUS_NOTE[m.status]}${m.error && m.status !== 'queued' ? ': ' + m.error : ''}` : ''),
    at: m.at,
    mine: m.direction === 'out',
    sender: m.direction === 'out' ? (m.auto_reply ? 'Auto-reply' : m.sent_by_name ?? undefined) : undefined,
    failed: m.status === 'failed',
  }))

  return (
    <ConversationPane
      open
      title={title || 'Chat'}
      subtitle={d ? `+${d.conversation.phone}${d.conversation.student_name ? ' · ' + d.conversation.student_name : ''}` : undefined}
      onBack={onClose}
      actions={<Button variant="ghost" size="sm" onClick={() => setDetails((v) => !v)} ariaExpanded={details}>{details ? 'Hide details' : 'Details'}</Button>}
    >
      {t.isLoading ? <Loading /> : t.error ? <ErrorState error={t.error} /> : d && (
        <>
          {details && <Info thread={d} canWrite={canWrite} onSaved={refresh} />}
          {d.sending.paused && <p className="shrink-0 border-b px-4 py-2 text-[14px] text-muted-foreground">{PAUSED}</p>}
          <ChatThread
            messages={messages}
            peerName={title}
            showSender
            empty="No messages yet."
            allowAttachments={false}
            height="min-h-0"
            canSend={canWrite && d.sending.window_open}
            cannotSendNote={canWrite ? <TemplatePicker thread={d} pending={send.isPending} onSend={(code) => send.mutate({ template_code: code })} error={send.error} />
              : 'You can read this chat. Replying needs the Manage Yajur Connect permission.'}
            onSend={(m) => send.mutateAsync({ text: m.body })}
            sending={send.isPending}
            error={send.error}
          />
        </>
      )}
    </ConversationPane>
  )
}

function TemplatePicker({ thread, pending, onSend, error }: { thread: ConnectThread; pending: boolean; onSend: (code: string) => void; error: unknown }) {
  const [code, setCode] = useState('')
  if (thread.templates.length === 0) {
    return (
      <p className="text-[14px] text-muted-foreground">
        More than 24 hours since the parent last wrote, so WhatsApp accepts only an approved template. None is mapped yet: add one under
        Communication, Message channels, Wording.
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <p className="text-[14px] text-muted-foreground">More than 24 hours since the parent last wrote. Send an approved template instead.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="min-w-0 flex-1">
          <Select value={code} onChange={setCode} placeholder="Choose a template" options={thread.templates.map((t) => ({ value: t.code, label: t.name }))} />
        </div>
        <Button disabled={!code} pending={pending} onClick={() => onSend(code)}>Send template</Button>
      </div>
      <FormNotice error={error} />
    </div>
  )
}

function Info({ thread, canWrite, onSaved }: { thread: ConnectThread; canWrite: boolean; onSaved: () => void }) {
  const c = thread.conversation
  const { guardian, student } = thread.contact
  const [labels, setLabels] = useState(c.labels.join(', '))
  useEffect(() => setLabels(c.labels.join(', ')), [c.id, c.labels])
  const staff = useQuery({ queryKey: ['connect', 'staff'], queryFn: () => api.call('GET /comms/yajur-connect/staff'), enabled: canWrite, staleTime: 300_000 })
  const save = useMutation({
    mutationFn: (body: { assigned_to?: string | null; labels?: string[]; state?: ConnectState }) =>
      api.call('PUT /comms/yajur-connect/{id}', { params: { id: c.id }, body }),
    onSuccess: onSaved,
  })
  const labelList = labels.split(',').map((l) => l.trim()).filter(Boolean)
  return (
    <div className="max-h-[45dvh] shrink-0 space-y-3 overflow-y-auto border-b px-4 py-3 text-[14px]">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        {guardian ? (
          <>
            <dt className="text-muted-foreground">Guardian</dt>
            <dd className="min-w-0 truncate">{guardian.name} ({guardian.relation})</dd>
            {guardian.email && <><dt className="text-muted-foreground">Email</dt><dd className="min-w-0 truncate">{guardian.email}</dd></>}
          </>
        ) : null}
        {student ? (
          <>
            <dt className="text-muted-foreground">Student</dt>
            <dd className="min-w-0 truncate">{student.name}, {student.admission_no}{student.class_section ? `, ${student.class_section}` : ''}</dd>
          </>
        ) : null}
        {!guardian && !student && <><dt className="text-muted-foreground">Family</dt><dd>This number is not on any guardian or student record.</dd></>}
        {c.profile_name && <><dt className="text-muted-foreground">WhatsApp name</dt><dd className="min-w-0 truncate">{c.profile_name}</dd></>}
        <dt className="text-muted-foreground">Last message</dt>
        <dd>{c.last_inbound_at ? formatDateTime(c.last_inbound_at) : 'None from the parent'}</dd>
      </dl>
      {canWrite && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Assigned to">
            <Select
              value={c.assigned_to ?? ''}
              onChange={(v) => save.mutate({ assigned_to: v || null })}
              options={[{ value: '', label: 'Nobody' }, ...(staff.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))]}
            />
          </Field>
          <Field label="Labels" hint="Separate with commas">
            <div className="flex gap-2">
              <div className="min-w-0 flex-1"><Input value={labels} onChange={setLabels} placeholder="Fees, Transport" /></div>
              <Button variant="secondary" disabled={labelList.join(',') === c.labels.join(',')} pending={save.isPending} onClick={() => save.mutate({ labels: labelList })}>Save</Button>
            </div>
          </Field>
          <div className="sm:col-span-2">
            {c.state === 'open'
              ? <Button variant="secondary" pending={save.isPending} onClick={() => save.mutate({ state: 'resolved' })}>Mark resolved</Button>
              : <Button variant="secondary" pending={save.isPending} onClick={() => save.mutate({ state: 'open' })}>Reopen</Button>}
          </div>
          <div className="sm:col-span-2"><FormNotice error={save.error} /></div>
        </div>
      )}
    </div>
  )
}

function AutoReplies({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const rules = useQuery({ queryKey: ['connect', 'rules'], queryFn: () => api.call('GET /comms/yajur-connect/autoreplies') })
  const [match, setMatch] = useState<ConnectMatch>('contains')
  const [keyword, setKeyword] = useState('')
  const [text, setText] = useState('')
  const done = () => qc.invalidateQueries({ queryKey: ['connect', 'rules'] })
  const add = useMutation({
    mutationFn: () => api.call('POST /comms/yajur-connect/autoreplies', { body: { match_type: match, keyword, reply: text } }),
    onSuccess: () => { setKeyword(''); setText(''); done() },
  })
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.call('PUT /comms/yajur-connect/autoreplies/{id}', { params: { id: v.id }, body: { enabled: v.enabled } }),
    onSuccess: done,
  })
  const remove = useMutation({
    mutationFn: (rid: string) => api.call('DELETE /comms/yajur-connect/autoreplies/{id}', { params: { id: rid } }),
    onSuccess: done,
  })
  return (
    <Dialog
      onClose={onClose}
      title="Auto-replies"
      description="When a parent's message matches a keyword, this reply is queued at once. The first match in the list is used."
      size="lg"
    >
      <div className="space-y-4">
        {rules.isLoading ? <Loading /> : rules.error ? <ErrorState error={rules.error} /> : (rules.data?.items ?? []).length === 0 ? (
          <p className="text-[14px] text-muted-foreground">No auto-replies yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {rules.data!.items.map((r) => (
              <li key={r.id} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[14px]"><span className="text-muted-foreground">{MATCH_LABEL[r.match_type]}</span> <strong className="break-words">{r.keyword}</strong></div>
                  <div className="whitespace-pre-wrap break-words text-[14px]">{r.reply}</div>
                </div>
                <Switch on={r.enabled} onChange={(v) => toggle.mutate({ id: r.id, enabled: v })} label={`Use the reply for ${r.keyword}`} />
                <ConfirmButton variant="ghost" size="sm" tone="danger" question={`Delete the auto-reply for "${r.keyword}"?`} confirmLabel="Delete" onConfirm={() => remove.mutate(r.id)}>
                  Delete
                </ConfirmButton>
              </li>
            ))}
          </ul>
        )}
        <FormNotice error={toggle.error ?? remove.error} />
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <Field label="When the message">
            <Select value={match} onChange={(v) => setMatch(v as ConnectMatch)} options={(Object.keys(MATCH_LABEL) as ConnectMatch[]).map((k) => ({ value: k, label: MATCH_LABEL[k] }))} />
          </Field>
          <Field label="Keyword"><Input value={keyword} onChange={setKeyword} placeholder="fee" /></Field>
          <div className="sm:col-span-2">
            <Field label="Reply"><Textarea value={text} onChange={setText} rows={3} placeholder="The words the parent receives" /></Field>
          </div>
        </div>
        <FormNotice error={add.error} />
        <Button disabled={!keyword.trim() || !text.trim()} pending={add.isPending} onClick={() => add.mutate()}>Add auto-reply</Button>
      </div>
    </Dialog>
  )
}
