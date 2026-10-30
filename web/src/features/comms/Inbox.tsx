import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Paperclip, Reply, ReplyAll, Settings, Star } from 'lucide-react'
import { api } from '@/lib/api'
import { useOptimisticMutation } from '@/lib/optimistic'
import type { MailConnection, MailFolder, MailMessage, MailPage, MailPerson, MailSummary } from '@shared/api/feature_inbox'
import {
  PageHead, PageBody, Card, Badge, Button, ConfirmButton, Dialog, EmptyState, ErrorState, Field, FormNotice,
  Input, Loading, Textarea, TAB_BAR_FILL, tabClass,
} from '@/components/ui'
import { cn, formatDate, formatDateTime } from '@/lib/utils'
import { useToast } from '@/components/Toast'
import { buzz } from '@/lib/haptics'
import { useSearchParams } from 'react-router-dom'
import { ConversationPane } from '@/components/ChatScreen'
import { usePhone } from '@/lib/viewport'

/* A member of staff's own school email (worker/src/routes/comms/inbox.ts).
   Only the signed-in person's mailbox is ever fetched. HTML mail is shown in
   a frame sandboxed without scripts and without the app's origin, with
   remote content blocked; the plain text is always one tap away. */

type Tab = 'inbox' | 'starred' | 'sent' | 'trash'
const TABS: { key: Tab; label: string }[] = [
  { key: 'inbox', label: 'Inbox' }, { key: 'starred', label: 'Starred' }, { key: 'sent', label: 'Sent' }, { key: 'trash', label: 'Trash' },
]
const folderOf = (t: Tab): MailFolder => (t === 'starred' ? 'inbox' : t)

const who = (p: MailPerson) => p.name || p.address
const list = (ps: MailPerson[]) => ps.map((p) => (p.name ? `${p.name} <${p.address}>` : p.address)).join(', ')
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${Math.round(n / 1024)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`)
const addresses = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)

interface Draft { to: string; cc: string; subject: string; text: string; reply_to_id?: string }

/* The sender's HTML, made inert: no scripts (sandbox), no reach into the app
   (no allow-same-origin), nothing fetched from outside (CSP), links open in a
   new tab. */
function inertHtml(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><base target="_blank"><style>body{margin:0;padding:12px;font:14px/1.5 system-ui,sans-serif;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`
}

export default function Inbox() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('inbox')
  const [q, setQ] = useState('')
  /* The open message lives in the URL (?m=), as Messages keeps ?with=, so a
     reload or a shared link lands on it and Back closes it. */
  const [params, setParams] = useSearchParams()
  const openId = params.get('m')
  const setOpenId = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('m', id)
    else next.delete('m')
    setParams(next, { replace: !id })
  }
  const phone = usePhone()
  const [draft, setDraft] = useState<Draft | null>(null)

  const box = useQuery({ queryKey: ['mail', 'box'], queryFn: () => api.call('GET /comms/mail/box') })
  const query = { folder: folderOf(tab), q: q.trim() || undefined, starred: tab === 'starred' ? true : undefined, limit: 50 }
  const page = useQuery({
    queryKey: ['mail', 'list', query],
    queryFn: () => api.call('GET /comms/mail', { query }),
    enabled: !!box.data?.address,
  })
  const msg = useQuery({
    queryKey: ['mail', 'message', openId],
    queryFn: async () => {
      const m = await api.call('GET /comms/mail/{id}', { params: { id: openId! } })
      qc.invalidateQueries({ queryKey: ['mail', 'box'] }); qc.invalidateQueries({ queryKey: ['mail', 'list'] })
      return m
    },
    enabled: !!openId,
  })

  /* The row and the open message change at once; the server follows. */
  const patchRows = (old: unknown, id: string, f: (m: MailSummary) => MailSummary | null) => {
    if (!old || typeof old !== 'object') return old
    if ('items' in old) {
      const p = old as MailPage
      return { ...p, items: p.items.map((m) => (m.id === id ? f(m) : m)).filter((m): m is MailSummary => m !== null) }
    }
    const m = old as MailMessage
    if (m.id !== id) return old
    const next = f(m)
    return next ? { ...m, ...next } : old
  }
  const flag = useOptimisticMutation<{ id: string; read?: boolean; starred?: boolean }>({
    mutationFn: ({ id, ...body }) => api.call('PATCH /comms/mail/{id}', { params: { id }, body }),
    queryKeys: [['mail', 'list'], ['mail', 'message']],
    invalidate: [['mail']],
    apply: (old, v) => patchRows(old, v.id, (m) => ({ ...m, ...(v.read !== undefined && { read: v.read }), ...(v.starred !== undefined && { starred: v.starred }) })),
    failure: "Couldn't change that message",
  })
  const move = useOptimisticMutation<{ id: string; to: 'trash' | 'restore' }>({
    mutationFn: ({ id, to }) => (to === 'trash'
      ? api.call('POST /comms/mail/{id}/trash', { params: { id } })
      : api.call('POST /comms/mail/{id}/restore', { params: { id } })),
    queryKeys: [['mail', 'list']],
    invalidate: [['mail']],
    apply: (old, v) => patchRows(old, v.id, () => null),
    confirm: (v) => (v.to === 'trash' ? 'Moved to Trash' : 'Moved back'),
    failure: "Couldn't move that message",
    onSuccess: () => setOpenId(null),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.call('DELETE /comms/mail/{id}', { params: { id } }),
    onSuccess: () => { setOpenId(null); qc.invalidateQueries({ queryKey: ['mail'] }) },
  })

  const reply = (m: MailMessage, all: boolean) => {
    const me = box.data?.address ?? ''
    const others = all ? [...m.to, ...m.cc].map((p) => p.address).filter((a) => a !== me && a !== m.from.address) : []
    const quoted = m.text.split('\n').map((l) => '> ' + l).join('\n')
    setDraft({
      to: m.folder === 'sent' ? m.to.map((p) => p.address).join(', ') : m.from.address,
      cc: others.join(', '),
      subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
      text: `\n\nOn ${formatDateTime(m.received_at)}, ${who(m.from)} wrote:\n${quoted}`,
      reply_to_id: m.id,
    })
  }

  if (box.isError) return <><PageHead eyebrow="Communication" title="Inbox" /><PageBody><ErrorState error={box.error} /></PageBody></>
  if (!box.data) return <><PageHead eyebrow="Communication" title="Inbox" /><PageBody><Loading shape="page" /></PageBody></>
  const b = box.data
  const canSend = b.status === 'active'

  return (
    <>
      <PageHead
        eyebrow="Communication"
        title="Inbox"
        actions={b.address ? (
          <div className="flex items-center gap-2">
            <MailboxSettings />
            <Button onClick={() => setDraft({ to: '', cc: '', subject: '', text: '' })} disabled={!canSend}>Write</Button>
          </div>
        ) : undefined}
      />
      <PageBody>
        {!b.address ? (
          <EmptyState title="You have no school email address yet." body="The office gives one on Communication > Mail addresses." />
        ) : (
          <div className="space-y-3">
            <div className={TAB_BAR_FILL} role="tablist" aria-label="Folders">
              {TABS.map((t) => (
                <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tabClass(tab === t.key, 'lg')}
                  onClick={() => { setTab(t.key); setOpenId(null) }}>
                  {t.label}
                  {t.key === 'inbox' && b.unread > 0 && <Badge tone="primary">{b.unread}</Badge>}
                </button>
              ))}
            </div>
            {!canSend && <p className="text-[13px] text-muted-foreground">{b.address} <Badge tone="warning" className="ms-2">Switched off by the office</Badge></p>}
            <ConnectPrompt />
            {/* Messages' layout: the list alone, full width, until a message is
                opened; then the list narrows to the left and the message opens
                beside it. On a phone the message takes the screen with Back. */}
            <div className={cn('grid gap-4 lg:items-start', openId && 'lg:grid-cols-[380px_minmax(0,1fr)]')}>
              <Card className="min-w-0 lg:flex lg:h-[calc(100dvh-8.5rem-var(--dock-reserve,0px))] lg:flex-col">
                <div className="px-4 py-3">
                  <Input value={q} onChange={setQ} placeholder="Search subject, sender or text" srLabel="Search mail" type="search" />
                </div>
                <div className="lg:min-h-0 lg:flex-1 lg:overflow-auto">
                  <MailList page={page.data} error={page.error} loading={page.isLoading} openId={openId} onOpen={setOpenId} folder={folderOf(tab)} />
                </div>
              </Card>
              {(phone || openId) && (
                <ConversationPane
                  open={!!openId}
                  title={msg.data ? (msg.data.subject || '(no subject)') : 'Message'}
                  subtitle={msg.data ? who(msg.data.from) : undefined}
                  onBack={() => setOpenId(null)}
                >
                  <div className="min-h-0 flex-1 overflow-auto">
                    {msg.isError ? <div className="p-4"><ErrorState error={msg.error} /></div> : !msg.data ? <div className="p-4"><Loading shape="cards" /></div> : (
                      <Reader
                        key={msg.data.id}
                        m={msg.data}
                        canSend={canSend}
                        onReply={(all) => reply(msg.data!, all)}
                        onStar={() => flag.mutate({ id: msg.data!.id, starred: !msg.data!.starred })}
                        onUnread={() => { flag.mutate({ id: msg.data!.id, read: false }); setOpenId(null) }}
                        onTrash={() => move.mutate({ id: msg.data!.id, to: 'trash' })}
                        onRestore={() => move.mutate({ id: msg.data!.id, to: 'restore' })}
                        onDelete={() => remove.mutate(msg.data!.id)}
                        deleteError={remove.error}
                      />
                    )}
                  </div>
                </ConversationPane>
              )}
            </div>
          </div>
        )}
      </PageBody>
      {draft && <Compose draft={draft} from={b.address ?? ''} onClose={() => setDraft(null)} />}
    </>
  )
}

function MailList({ page, error, loading, openId, onOpen, folder }: {
  page?: MailPage; error: unknown; loading: boolean; openId: string | null; onOpen: (id: string) => void; folder: MailFolder
}) {
  if (error) return <div className="px-4 pb-4"><ErrorState error={error} /></div>
  if (loading || !page) return <div className="px-4 pb-4"><Loading shape="inline" /></div>
  if (!page.items.length) return <p className="px-4 pb-4 text-[13px] text-muted-foreground">No messages here.</p>
  return (
    <ul className="divide-y border-t">
      {page.items.map((m) => {
        const name = folder === 'sent' ? `To ${m.to.map(who).join(', ')}` : who(m.from)
        return (
          <li key={m.id}>
            <button type="button" onClick={() => onOpen(m.id)} aria-current={m.id === openId}
              className={cn('flex min-h-[var(--control-h)] w-full flex-col gap-0.5 px-4 py-2.5 text-left transition-colors', m.id === openId ? 'bg-accent' : 'hover:bg-muted/60')}>
              <span className="flex w-full items-baseline gap-2">
                <span className={cn('min-w-0 flex-1 truncate text-[14px]', !m.read ? 'font-semibold' : 'font-medium')}>{name}</span>
                {m.starred && <Star className="h-3.5 w-3.5 shrink-0 self-center" aria-label="Starred" />}
                {m.has_attachments && <Paperclip className="h-3.5 w-3.5 shrink-0 self-center" aria-label="Has attachments" />}
                <span className="shrink-0 text-[12px] text-muted-foreground">{formatDate(m.received_at)}</span>
              </span>
              <span className={cn('block truncate text-[13px]', !m.read && 'font-semibold')}>{m.subject || '(no subject)'}</span>
              <span className="block truncate text-[12.5px] text-muted-foreground">{m.snippet}</span>
            </button>
          </li>
        )
      })}
      {page.total > page.items.length && (
        <li className="px-4 py-3 text-[12.5px] text-muted-foreground">Showing the newest {page.items.length} of {page.total}. Search to find older mail.</li>
      )}
    </ul>
  )
}

function Reader({ m, canSend, onReply, onStar, onUnread, onTrash, onRestore, onDelete, deleteError }: {
  m: MailMessage; canSend: boolean; onReply: (all: boolean) => void; onStar: () => void
  onUnread: () => void; onTrash: () => void; onRestore: () => void; onDelete: () => void; deleteError: unknown
}) {
  const doc = useMemo(() => (m.html ? inertHtml(m.html) : ''), [m.html])
  const many = m.to.length + m.cc.length > 1
  return (
    <div className="min-w-0">
      <div className="space-y-3 border-b px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          {m.folder !== 'trash' && canSend && <Button variant="secondary" size="sm" onClick={() => onReply(false)}><Reply className="h-4 w-4" /> Reply</Button>}
          {m.folder !== 'trash' && canSend && many && <Button variant="secondary" size="sm" onClick={() => onReply(true)}><ReplyAll className="h-4 w-4" /> Reply all</Button>}
          <Button variant="ghost" size="sm" onClick={onStar}>{m.starred ? 'Unstar' : 'Star'}</Button>
          {m.folder === 'inbox' && <Button variant="ghost" size="sm" onClick={onUnread}>Mark unread</Button>}
          {m.folder === 'trash' ? (
            <>
              <Button variant="ghost" size="sm" onClick={onRestore}>Move back</Button>
              <ConfirmButton tone="danger" confirmLabel="Delete for good" question="This message and its attachments are deleted and cannot be brought back." onConfirm={onDelete}>
                Delete for good
              </ConfirmButton>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={onTrash}>Delete</Button>
          )}
        </div>
        <FormNotice error={deleteError} />
        <h2 className="break-words text-[17px] font-semibold">{m.subject || '(no subject)'}</h2>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
          <dt className="text-muted-foreground">From</dt><dd className="break-words">{list([m.from])}</dd>
          <dt className="text-muted-foreground">To</dt><dd className="break-words">{list(m.to)}</dd>
          {m.cc.length > 0 && <><dt className="text-muted-foreground">Cc</dt><dd className="break-words">{list(m.cc)}</dd></>}
          <dt className="text-muted-foreground">Date</dt><dd>{formatDateTime(m.received_at)}</dd>
        </dl>
      </div>
      {m.html ? (
        <iframe title="Message" srcDoc={doc} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"
          className="block h-[60dvh] w-full border-0 bg-card" />
      ) : (
        <pre className="whitespace-pre-wrap break-words px-4 py-4 font-sans text-[14px] leading-relaxed">{m.text || '(no text)'}</pre>
      )}
      {m.attachments.length > 0 && (
        <ul className="space-y-1 border-t px-4 py-3 text-[13px]">
          {m.attachments.map((a) => (
            <li key={a.id} className="flex min-w-0 items-center gap-2">
              <Paperclip className="h-3.5 w-3.5 shrink-0" />
              <a className="min-w-0 truncate font-medium hover:underline" download={a.filename}
                href={`/api/v1/comms/mail/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(a.id)}`}>{a.filename}</a>
              <span className="shrink-0 text-muted-foreground">{size(a.size_bytes)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Compose({ draft, from, onClose }: { draft: Draft; from: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [d, setD] = useState(draft)
  const set = (k: keyof Draft) => (v: string) => setD((x) => ({ ...x, [k]: v }))
  const send = useMutation({
    mutationFn: () => api.call('POST /comms/mail/send', {
      body: { to: addresses(d.to), cc: addresses(d.cc), subject: d.subject, text: d.text, reply_to_id: d.reply_to_id },
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['mail'] }); onClose() },
  })
  return (
    <Dialog
      onClose={onClose}
      title={d.reply_to_id ? 'Reply' : 'New message'}
      description={`From ${from}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button pending={send.isPending} needsNetwork disabled={!addresses(d.to).length} onClick={() => send.mutate()}>Send</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="To" hint="Separate addresses with commas."><Input value={d.to} onChange={set('to')} autoComplete="email" /></Field>
        <Field label="Cc"><Input value={d.cc} onChange={set('cc')} /></Field>
        <Field label="Subject"><Input value={d.subject} onChange={set('subject')} /></Field>
        <Field label="Message"><Textarea value={d.text} onChange={set('text')} rows={8} maxRows={20} aria-label="Message" /></Field>
        <FormNotice error={send.error} />
      </div>
    </Dialog>
  )
}

/* The person's own mailbox on the school's mail server: once connected, mail
   is sent through it as them, and old mail can be copied in. Hidden until the
   office has set the server. Everything about it sits behind one settings
   button in the page head; the list itself stays clear. */
function useConnection() {
  const qc = useQueryClient()
  const conn = useQuery({
    queryKey: ['mail', 'connection'],
    queryFn: () => api.call('GET /comms/mail/connection'),
    refetchInterval: (q) => (q.state.data && (q.state.data.import.state === 'queued' || q.state.data.import.state === 'running') ? 3000 : false),
  })
  // Copied mail shows in the list as soon as the copy finishes.
  const state = conn.data?.import.state
  const was = useRef(state)
  useEffect(() => {
    if (was.current && was.current !== 'done' && state === 'done') qc.invalidateQueries({ queryKey: ['mail', 'list'] })
    was.current = state
  }, [state, qc])
  /* New mail on the school's server comes in by itself (owner, 2026-10-28:
     no Import button): once each time Mail opens, when connected and no copy
     is already running. It carries on from where the last copy stopped. */
  const fetched = useRef(false)
  useEffect(() => {
    const d = conn.data
    if (fetched.current || !d?.connected || d.import.state === 'queued' || d.import.state === 'running') return
    fetched.current = true
    api.call('POST /comms/mail/connection/import').then((v) => qc.setQueryData(['mail', 'connection'], v)).catch(() => {})
  }, [conn.data, qc])
  const c = conn.data
  return c && (c.server_ready || c.connected) ? c : null
}

function MailboxSettings() {
  const c = useConnection()
  const [open, setOpen] = useState(false)
  if (!c) return null
  return (
    <>
      <Button variant="ghost" title="Mailbox settings" ariaHasPopup="dialog" onClick={() => setOpen(true)}><Settings className="h-4 w-4" /></Button>
      {open && <ConnectDialog c={c} onClose={() => setOpen(false)} />}
    </>
  )
}

function ConnectPrompt() {
  const c = useConnection()
  const [open, setOpen] = useState(false)
  if (!c || c.connected) return null
  return (
    <>
      <Button size="sm" variant="secondary" ariaHasPopup="dialog" onClick={() => setOpen(true)}>Connect your mailbox</Button>
      {open && <ConnectDialog c={c} onClose={() => setOpen(false)} />}
    </>
  )
}

function ConnectDialog({ c, onClose }: { c: MailConnection; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [tested, setTested] = useState(false)
  const test = useMutation({
    mutationFn: () => api.call('POST /comms/mail/connection/test', { body: password ? { password } : {} }),
    onSuccess: () => setTested(true),
    onMutate: () => setTested(false),
  })
  const save = useMutation({
    mutationFn: () => api.call('PUT /comms/mail/connection', { body: { password } }),
    onSuccess: (v) => {
      qc.setQueryData(['mail', 'connection'], v); buzz('tap'); toast.ok('Mailbox connected'); onClose()
      // Mail already on the server comes in straight away.
      api.call('POST /comms/mail/connection/import').then((n) => qc.setQueryData(['mail', 'connection'], n)).catch(() => {})
    },
  })
  return (
    <Dialog
      onClose={onClose}
      title={c.connected ? 'Your mailbox' : 'Connect your mailbox'}
      description="Sign in once with your own mailbox password. Your mail is then sent through the school mail server as you, and your mail comes in by itself. Only you can use this; the office cannot see the password."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="secondary" pending={test.isPending} needsNetwork disabled={!password && !c.connected} onClick={() => test.mutate()}>Test</Button>
          <Button pending={save.isPending} needsNetwork disabled={!password} onClick={() => save.mutate()}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Address"><Input value={c.address ?? ''} onChange={() => {}} disabled /></Field>
        <Field label={c.connected ? 'New password' : 'Mailbox password'} hint={c.connected ? 'Leave empty and press Test to check the saved one.' : undefined}>
          <Input value={password} onChange={(v) => { setPassword(v); setTested(false) }} type="password" autoComplete="current-password" />
        </Field>
        <FormNotice error={test.error ?? save.error} ok={tested ? 'Signed in to the mail server.' : undefined} />
        {c.connected && (
          <div className="border-t pt-3">
            <Badge tone="success">Connected</Badge>
          </div>
        )}
      </div>
    </Dialog>
  )
}
