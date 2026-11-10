import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Info as InfoIcon } from 'lucide-react'
import { api } from '@/lib/api'
import type { ConnectConversation, ConnectMatch, ConnectMessage, ConnectState, ConnectThread } from '@shared/api/feature_yajur_connect'
import {
  PageHead, PageBody, Button, Card, ConfirmButton, EmptyState, ErrorState, Field, FormNotice, Input, Loading, Select,
  Switch, Textarea, SEG_BAR, TAB_BAR, segClass, tabClass,
} from '@/components/ui'
import { CampaignsTab, ScheduledTab, SendTab } from './YajurConnectSend'
import { LogTab } from './YajurConnectLog'
import { ChatThread, type ChatMessage } from '@/components/Chat'
import { ConversationPane, PersonAvatar } from '@/components/ChatScreen'
import { cn, formatDateTime } from '@/lib/utils'

/* Yajur Connect: the school's WhatsApp chats with parents
   (worker/src/routes/comms/yajur_connect.ts). The list on the left, the open
   chat on the right (the whole screen on a phone), and beside the chat the
   family the number belongs to. A reply goes into the school's message queue;
   while the recipient guard is on it waits there and is not delivered, and
   the screen says so. The Send, Campaigns, Scheduled and Auto-replies tabs
   are for holders of comms.connect.write. */

type View = ConnectState | 'all'
const VIEWS: { key: View; label: string }[] = [{ key: 'open', label: 'Open' }, { key: 'resolved', label: 'Resolved' }, { key: 'all', label: 'All' }]
const MATCH_LABEL: Record<ConnectMatch, string> = { exact: 'Is exactly', starts: 'Starts with', contains: 'Contains' }
const PAUSED = 'Sending is paused: the recipient guard is on and the test list is empty, so replies, auto-replies and broadcasts are blocked and will not be sent later.'
const NOT_ON_LIST = 'Test mode: this number is not on the test list, so messages to it are blocked.'
type Tab = 'chats' | 'send' | 'campaigns' | 'scheduled' | 'log' | 'rules'
const TABS: { key: Tab; label: string }[] = [
  { key: 'chats', label: 'Chats' }, { key: 'send', label: 'Send' }, { key: 'campaigns', label: 'Campaigns' }, { key: 'scheduled', label: 'Scheduled' },
  { key: 'log', label: 'Log' }, { key: 'rules', label: 'Auto-replies' },
]

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
const PREVIEW: Record<string, string> = {
  image: '📷 Photo', video: '🎥 Video', audio: '🎤 Voice note', document: '📄 Document', sticker: 'Sticker', location: '📍 Location', reaction: 'Reaction',
}
/** "[image]" as WhatsApp's chat list words it: "📷 Photo". */
function previewOf(p: string | null): string {
  const k = /^\[(\w+)\]$/.exec(p ?? '')?.[1]
  return k ? PREVIEW[k] ?? k : p ?? ''
}
/** message_log status to the bubble's WhatsApp-style mark. */
const DELIVERY: Record<string, NonNullable<ChatMessage['delivery']>> = {
  queued: 'waiting', scheduled: 'waiting', held: 'waiting', sending: 'waiting', sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed', suppressed: 'failed', blocked: 'failed',
}
const istTime = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).toUpperCase()
function deliveryOf(m: ConnectMessage): Pick<ChatMessage, 'delivery' | 'delivery_note'> {
  if (m.direction !== 'out') return {}
  const d = DELIVERY[m.status] ?? 'waiting'
  if (d === 'waiting') return { delivery: d, delivery_note: m.send_after && Date.parse(m.send_after) > Date.now() ? `Sends at ${istTime(m.send_after)}` : undefined }
  if (d === 'failed') return { delivery: d, delivery_note: m.error || (m.status === 'suppressed' ? 'Held by the recipient guard' : 'Not delivered') }
  return { delivery: d }
}

const when = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

export default function YajurConnect() {
  const [params, setParams] = useSearchParams()
  const openId = params.get('c')
  // The open chat fills the screen below the filters exactly, on any screen (owner, 2026-11-09: the message box fell off the bottom).
  const gridRef = useRef<HTMLDivElement>(null)
  const [chatH, setChatH] = useState(600)
  useEffect(() => {
    const fit = () => {
      const el = gridRef.current
      if (!el) return
      // The page scrolls inside the shell, not the window: measure from the top of that scroller as if unscrolled.
      let sc: HTMLElement | null = el.parentElement
      while (sc && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement
      const scTop = sc ? sc.getBoundingClientRect().top : 0, scrolled = sc ? sc.scrollTop : window.scrollY
      const top = el.getBoundingClientRect().top - scTop + scrolled + scTop
      setChatH(Math.max(380, Math.round(window.innerHeight - top - 16)))
    }
    fit(); window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [openId])
  const tabParam = params.get('tab') as Tab | null
  const setOpenId = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) { next.set('c', id); next.delete('tab') }
    else next.delete('c')
    setParams(next, { replace: !id })
  }
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params)
    if (t === 'chats') next.delete('tab')
    else next.set('tab', t)
    setParams(next, { replace: true })
  }
  const [view, setView] = useState<View>('open')
  const [q, setQ] = useState('')
  const [mine, setMine] = useState(false)
  const query = { state: view, q: q.trim() || undefined, mine: mine ? ('1' as const) : undefined }
  const list = useQuery({
    queryKey: ['connect', 'list', query],
    queryFn: () => api.call('GET /comms/yajur-connect', { query }),
    refetchInterval: 15_000,
  })
  const items = list.data?.items ?? []
  const canWrite = !!list.data?.can_write
  // Readers get the chats and the log; the sending tabs are for comms.connect.write.
  const tabs = canWrite ? TABS : TABS.filter((t) => t.key === 'chats' || t.key === 'log')
  const tab: Tab = tabParam && tabs.some((t) => t.key === tabParam) ? tabParam : 'chats'

  return (
    <>
      <PageHead eyebrow="Communication" title="Yajur Connect" />
      <PageBody>
        {list.data && (
          <div className={cn(TAB_BAR, 'mb-4 flex-nowrap overflow-x-auto')} role="tablist">
            {tabs.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tabClass(tab === t.key)} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        {tab === 'send' ? <SendTab onOpenChat={setOpenId} />
          : tab === 'campaigns' ? <CampaignsTab />
          : tab === 'scheduled' ? <ScheduledTab />
          : tab === 'log' ? <LogTab />
          : tab === 'rules' ? <AutoReplies />
          : chats()}
      </PageBody>
    </>
  )

  /* Called, not mounted: a component defined here would remount the search box on every render. */
  function chats() {
    /* As the owner's design (2026-11-09): the list in its own card with its search and filters,
       the chat beside it, both filling the screen below the tabs. */
    return (
      <div ref={gridRef} style={{ '--chat-h': `${chatH}px` } as CSSProperties}
        className="space-y-3 lg:grid lg:h-[var(--chat-h)] lg:grid-cols-[minmax(300px,340px)_minmax(0,1fr)] lg:gap-4 lg:space-y-0">
        <section className={cn('card flex min-h-0 flex-col overflow-hidden', openId && 'max-lg:hidden')}>
          <div className="space-y-2.5 px-4 pb-2 pt-4">
            <h2 className="text-[20px] font-bold">Chats</h2>
            <Input value={q} onChange={setQ} placeholder="Search name, number or words" />
            <div className={cn(SEG_BAR, 'w-full')} role="tablist">
              {VIEWS.map((v) => (
                <button key={v.key} type="button" role="tab" aria-selected={view === v.key} className={cn(segClass(view === v.key), 'flex-1')} onClick={() => setView(v.key)}>
                  {v.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2">
              <Switch on={mine} onChange={setMine} label="Only chats assigned to me" />
              <span className="text-[13px] text-muted-foreground">Assigned to me</span>
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} /> : items.length === 0 ? (
              <EmptyState
                title={q || mine ? 'No chat matches.' : view === 'resolved' ? 'No resolved chats.' : 'No WhatsApp chats yet.'}
                body={q || mine ? 'Clear the search or the Assigned to me switch.' : 'A chat appears here when a parent writes to the school on WhatsApp.'}
              />
            ) : (
              <ul className="space-y-0.5">
                {items.map((c) => <Row key={c.id} c={c} active={c.id === openId} onOpen={() => setOpenId(c.id)} />)}
              </ul>
            )}
          </div>
        </section>
        {openId ? <Thread id={openId} canWrite={canWrite} onClose={() => setOpenId(null)} /> : (
          <div className="card hidden min-h-0 place-items-center text-[14px] text-muted-foreground lg:grid">Pick a chat to read it.</div>
        )}
      </div>
    )
  }
}

function Row({ c, active, onOpen }: { c: ConnectConversation; active: boolean; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'true' : undefined}
        className={cn('flex w-full items-center gap-3 rounded-[14px] px-2.5 py-2.5 text-left transition-colors hover:bg-muted/60', active && 'bg-primary/10 hover:bg-primary/10')}
      >
        <PersonAvatar name={c.name} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={cn('min-w-0 flex-1 truncate text-[15px]', c.unread ? 'font-bold' : 'font-semibold')}>{c.name}</span>
            <span className={cn('shrink-0 text-[12px]', c.unread ? 'font-semibold text-[#12b76a]' : 'text-muted-foreground')}>{when(c.last_message_at)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground">{previewOf(c.last_preview)}</span>
            {c.unread > 0 && <span className="grid min-w-[20px] place-items-center rounded-full bg-[#12b76a] px-1.5 text-[11px] font-bold leading-[18px] text-white">{c.unread}</span>}
          </div>
          {(c.student_name || c.labels.length > 0 || c.assigned_name || c.state === 'resolved') && (
            <div className="mt-1 flex flex-wrap gap-1">
              {c.student_name && c.student_name !== c.name && <span className="rounded-full bg-primary/10 px-2 text-[11.5px] text-primary">{c.student_name}</span>}
              {c.labels.map((l) => <span key={l} className="rounded-full bg-primary/10 px-2 text-[11.5px] text-primary">{l}</span>)}
              {c.assigned_name && <span className="rounded-full bg-muted px-2 text-[11.5px] text-muted-foreground">{c.assigned_name}</span>}
              {c.state === 'resolved' && <span className="rounded-full bg-[#12b76a]/15 px-2 text-[11.5px] text-[#067647]">Resolved</span>}
            </div>
          )}
        </div>
      </button>
    </li>
  )
}

function Thread({ id, canWrite, onClose }: { id: string; canWrite: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  // Details closed to begin with (owner, 2026-11-09): the chat first.
  const [details, setDetails] = useState(false)
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
    mutationFn: (body: { text?: string; template_code?: string; vars?: Record<string, string> }) => api.call('POST /comms/yajur-connect/{id}/reply', { params: { id }, body }),
    onSuccess: refresh,
  })
  const fix = useMutation({
    mutationFn: (v: { mid: string; discard: boolean }): Promise<unknown> => v.discard
      ? api.call('DELETE /comms/yajur-connect/{id}/messages/{mid}', { params: { id, mid: v.mid } })
      : api.call('POST /comms/yajur-connect/{id}/messages/{mid}/retry', { params: { id, mid: v.mid } }),
    onSuccess: refresh,
  })
  const d = t.data
  const title = d?.conversation.name ?? ''
  const messages: ChatMessage[] = (d?.messages ?? []).map((m) => ({
    id: m.id,
    // A photo, voice note or file is drawn from WhatsApp itself; only the caption is text.
    body: m.media_id && m.kind !== 'sticker' ? (m.text ?? '') : bodyOf(m),
    attachments: m.media_id && m.kind !== 'sticker' ? [{
      file_id: m.media_id, name: m.media_name || KIND_LABEL[m.kind] || 'File', size_bytes: 0,
      content_type: m.media_mime || (m.kind === 'image' ? 'image/jpeg' : m.kind === 'audio' ? 'audio/ogg' : m.kind === 'video' ? 'video/mp4' : 'application/octet-stream'),
      url: `/api/v1/comms/yajur-connect/media/${m.id}`,
    }] : undefined,
    at: (m.direction === 'out' && m.sent_at) || m.at,
    ...deliveryOf(m),
    mine: m.direction === 'out',
    sender: m.direction === 'out' ? (m.auto_reply ? 'Auto-reply' : m.sent_by_name ?? undefined) : undefined,
  }))

  return (
    <ConversationPane
      open
      title={title || 'Chat'}
      subtitle={d ? `+${d.conversation.phone}${d.conversation.student_name ? ' · ' + d.conversation.student_name : ''}` : undefined}
      onBack={onClose}
      actions={<button type="button" title={details ? 'Hide details' : 'Details'} aria-label={details ? 'Hide details' : 'Details'} aria-expanded={details} onClick={() => setDetails((v) => !v)} className={cn('grid h-9 w-9 place-items-center rounded-full transition-colors', details ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/70')}><InfoIcon className="h-[18px] w-[18px]" /></button>}
    >
      {t.isLoading ? <Loading /> : t.error ? <ErrorState error={t.error} /> : d && (
        <>
          {details && <Info thread={d} canWrite={canWrite} onSaved={refresh} />}
          {d.sending.paused && <p className="shrink-0 border-b px-4 py-2 text-[14px] text-muted-foreground">{d.sending.test_numbers > 0 ? NOT_ON_LIST : PAUSED}</p>}
          <ChatThread
            messages={messages}
            peerName={title}
            showSender
            empty="No messages yet."
            allowAttachments={false}
            height="min-h-0"
            canSend={canWrite && d.sending.window_open}
            cannotSendNote={canWrite ? <TemplatePicker thread={d} pending={send.isPending} onSend={(code, vars) => send.mutate({ template_code: code, vars })} error={send.error} />
              : 'You can read this chat. Replying needs the Manage Yajur Connect permission.'}
            onSend={(m) => send.mutateAsync({ text: m.body })}
            onRetryDelivery={canWrite ? (mid) => fix.mutate({ mid, discard: false }) : undefined}
            onDiscardDelivery={canWrite ? (mid) => fix.mutate({ mid, discard: true }) : undefined}
            sending={send.isPending}
            error={send.error ?? fix.error}
          />
        </>
      )}
    </ConversationPane>
  )
}

function TemplatePicker({ thread, pending, onSend, error }: { thread: ConnectThread; pending: boolean; onSend: (code: string, vars: Record<string, string>) => void; error: unknown }) {
  const [code, setCode] = useState('')
  const [vars, setVars] = useState<Record<string, string>>({})
  const { guardian, student } = thread.contact
  // The blanks the chat already knows; the rest are asked for (owner, 2026-11-09).
  const known: Record<string, string> = {
    parent_name: guardian?.name ?? thread.conversation.profile_name ?? '', student_name: student?.name ?? '', class: student?.class_section ?? '',
  }
  const tpl = thread.templates.find((t) => t.code === code)
  const value = (p: string) => vars[p] ?? known[p] ?? ''
  const blanks = tpl?.params ?? []
  const ready = !!tpl && blanks.every((p) => value(p).trim())
  const preview = tpl ? tpl.body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, p: string) => value(p).trim() || `[${p.replace(/_/g, ' ')}]`) : ''
  const label = (p: string) => p.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase())
  if (thread.templates.length === 0) {
    return (
      <p className="text-[14px] text-muted-foreground">
        More than 24 hours since the parent last wrote, so WhatsApp accepts only an approved template. None is mapped yet: add one under
        Communication, Message channels, Wording.
      </p>
    )
  }
  return (
    <div className="space-y-2 pb-1 sm:pe-16">
      <p className="text-[14px] text-muted-foreground">The parent has not written in 24 hours, so WhatsApp only allows an approved template.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="min-w-0 flex-1">
          <Select value={code} onChange={(v) => { setCode(v); setVars({}) }} placeholder="Choose a template" options={thread.templates.map((t) => ({ value: t.code, label: t.name }))} />
        </div>
        <Button disabled={!ready} pending={pending} onClick={() => onSend(code, Object.fromEntries(blanks.map((p) => [p, value(p).trim()])))}>Send template</Button>
      </div>
      {tpl && blanks.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-3">
          {blanks.map((p) => (
            <Field key={p} label={label(p)} required>
              <Input value={value(p)} onChange={(v) => setVars((o) => ({ ...o, [p]: v }))} />
            </Field>
          ))}
        </div>
      )}
      {tpl && (
        <p className="whitespace-pre-wrap rounded-xl bg-muted/60 px-3 py-2 text-[13.5px]">
          <span className="mb-1 block text-[12px] font-semibold text-muted-foreground">The parent will get</span>{preview}
        </p>
      )}
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

function AutoReplies() {
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
    <Card>
      <div className="space-y-4 p-4">
        <p className="text-[14px] text-muted-foreground">When a parent's message matches a keyword, this reply is queued at once. The first match in the list is used.</p>
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
    </Card>
  )
}
