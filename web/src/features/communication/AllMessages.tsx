import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquare, ShieldAlert, Users, Megaphone, HeartHandshake, Send, X } from 'lucide-react'
import { ChatThread, type Attachment } from '@/components/Chat'
import { ChatScreen, PersonAvatar } from '@/components/ChatScreen'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  PageHead, PageBody, Card, CardHeader, Button, Stat, Select, Input, Field,
  SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { useFeatureHref } from '../bento/bento-kit'
import { usePhone } from '@/lib/viewport'

/* All messages.
 *
 * Every conversation in the school on one desk — a parent writing to a class
 * teacher, a concern raised, a teacher writing to the office, a circular
 * waiting to be acknowledged — with a count of what is still waiting for the
 * school's reply. The four tiles are the filter; the number on each is how
 * many of that channel are pending. Counselling is a fifth tile that is a
 * count only: those threads are confidential by design and nobody reads them
 * from here.
 *
 * A parent thread opens inline and can be answered here, in the teacher's
 * name-space: the row keeps the teacher on the thread and names the principal
 * as the sender, so the parent sees who wrote and the teacher sees the reply
 * in their own inbox. A concern opens the grievance desk on that ticket; a
 * staff thread opens Messages with that person. */

type Channel = 'parent_teacher' | 'staff_parent' | 'concern' | 'staff' | 'circular'

interface Item {
  channel: Channel
  key: string
  title: string
  from: string
  about?: string | null
  handler?: string | null
  last_body: string
  last_at: string
  pending: boolean
  status?: string | null
  student_id?: string
  parent_user_id?: string
  teacher_user_id?: string
  acked?: number
  asked?: number
  teacher_name?: string
  teacher_code?: string
  parent_name?: string
  parent_relation?: string
  child_name?: string
  child_class?: string
  child_photo?: string
  teacher_photo?: string
  admission_no?: string
  reply_by?: string
  reply_body?: string
  reply_at?: string
  recent?: { sender: string; from_school: boolean; body: string; at: string }[]
}

interface Counts {
  parent_teacher: number
  staff_parent: number
  concerns: number
  staff: number
  circulars: number
  counsellor: number
  total: number
}

const CHANNEL_LABEL: Record<Channel, string> = {
  parent_teacher: 'Parent → teacher',
  staff_parent: 'Staff → parent',
  concern: 'Concern',
  staff: 'Staff',
  circular: 'Circular',
}

export default function AllMessages() {
  const [channel, setChannel] = useState<'' | Channel>('')
  const [status, setStatus] = useState<'pending' | 'answered' | 'all'>('all')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Item | null>(null)
  const [openStaff, setOpenStaff] = useState<Item | null>(null)
  /* Smaller questions of a big desk: what came in this week, what is one
     class saying, what has one teacher been dealing with. The tiles keep
     counting the whole school either way, so a filter cannot make the school
     look quieter than it is. */
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [klass, setKlass] = useState('')
  const [person, setPerson] = useState('')

  const params = new URLSearchParams({ status })
  if (channel) params.set('channel', channel)
  if (q.trim()) params.set('q', q.trim())
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  if (klass) params.set('class', klass)
  if (person.trim()) params.set('person', person.trim())

  const inbox = useQuery({
    queryKey: ['admin-inbox', channel, status, q.trim(), from, to, klass, person.trim()],
    queryFn: () => api.get<{ items: Item[]; counts: Counts }>(`/api/v1/admin/inbox?${params}`),
    placeholderData: (prev) => prev,
    /* Live. The stream (lib/live-stream.ts) invalidates this on any message
       hint it receives, but the principal is not a party to a parent's
       thread with a teacher, so the hint may never reach this tab. A short
       poll is the guarantee: a message sent anywhere in the school is on
       this desk within five seconds. */
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  })

  const toGrievances = useFeatureHref('institution_admin.communication.grievances')
  const toStaff = useFeatureHref('institution_admin.communication.messages')
  const toCirculars = useFeatureHref('institution_admin.communication.circulars')

  const counts = inbox.data?.counts
  const items = inbox.data?.items ?? []

  /* The class picker is built from what the desk has seen, and remembered:
     a filtered fetch returns only that class, which would collapse the list
     to the one choice and strand whoever picked it. */
  const [classes, setClasses] = useState<string[]>([])
  useEffect(() => {
    if (klass) return
    const seen = Array.from(
      new Set(items.map((i) => i.child_class).filter((c): c is string => !!c)),
    ).sort()
    if (seen.length) setClasses((cur) => (cur.join('|') === seen.join('|') ? cur : seen))
  }, [items, klass])

  const filtered = !!(from || to || klass || person.trim())

  const tile = (c: '' | Channel) => () => setChannel(channel === c ? '' : c)

  return (
    <>
      <PageHead
        eyebrow="Communication"
        title="All messages"
        actions={
          <>
            <Field label="Show">
              <Select
                value={status}
                onChange={(v) => setStatus(v as typeof status)}
                options={[
                  { value: 'pending', label: 'Not responded yet' },
                  { value: 'answered', label: 'Answered' },
                  { value: 'all', label: 'Everything (newest first)' },
                ]}
              />
            </Field>
            <Field label="Search">
              <Input value={q} onChange={setQ} placeholder="Name, child, words" />
            </Field>
          </>
        }
      />
      <PageBody>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Parent → teacher waiting" value={counts?.parent_teacher ?? '–'} icon={MessageSquare}
            active={channel === 'parent_teacher'} onClick={tile('parent_teacher')} />
          <Stat label="Staff → parent unread" value={counts?.staff_parent ?? '–'} icon={Send}
            active={channel === 'staff_parent'} onClick={tile('staff_parent')} />
          <Stat label="Concerns waiting" value={counts?.concerns ?? '–'} icon={ShieldAlert}
            active={channel === 'concern'} onClick={tile('concern')} />
          <Stat label="Staff waiting" value={counts?.staff ?? '–'} icon={Users}
            active={channel === 'staff'} onClick={tile('staff')} />
          <Stat label="Circulars awaiting ack" value={counts?.circulars ?? '–'} icon={Megaphone}
            active={channel === 'circular'} onClick={tile('circular')} />
        </div>
        <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card px-4 py-3">
          <Field label="From">
            <Input type="date" value={from} onChange={setFrom} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={setTo} />
          </Field>
          <Field label="Class">
            <Select
              value={klass}
              onChange={setKlass}
              placeholder="Every class"
              options={classes.map((c) => ({ value: c, label: c }))}
            />
          </Field>
          <Field label="Teacher or parent">
            <Input value={person} onChange={setPerson} placeholder="A name" />
          </Field>
          {filtered && (
            <button
              type="button"
              className="h-9 rounded-md border px-3 text-[13px] font-medium hover:bg-accent"
              onClick={() => {
                setFrom('')
                setTo('')
                setKlass('')
                setPerson('')
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        <p className="text-[12px] text-muted-foreground">
          Each tile counts what is still waiting for a reply, across the whole school,
          pressing one filters the list below without changing the counts.
        </p>
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <HeartHandshake className="h-4 w-4" />
          {counts?.counsellor ?? '–'} counselling thread{counts?.counsellor === 1 ? '' : 's'} open, private; counted here, never read.
        </p>

        {/* On a desk the conversation opens BESIDE the list, the way the web
            chat does: the feed narrows to the left, the thread sits on the
            right and stays put while the feed scrolls. Only a phone takes the
            whole screen, where there is no room for two. */}
        <div
          className={cn(
            'space-y-4',
            (open || openStaff) && 'lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start lg:gap-4 lg:space-y-0',
          )}
        >
        {inbox.isLoading ? (
          <SkeletonTable columns={5} />
        ) : inbox.error ? (
          <ErrorState error={inbox.error} />
        ) : items.length === 0 ? (
          <Card>
            <EmptyState
              title={
                filtered ? 'Nothing matches these filters.'
                : status === 'pending' ? 'Nothing is waiting on the school.'
                : 'No messages match.'
              }
              body={
                filtered ? 'Widen the dates, the class or the name, or clear the filters.'
                : status === 'pending' ? 'Every conversation has been answered.'
                : 'Change the filter above.'
              }
            />
          </Card>
        ) : (
          <section className="space-y-4">
            <h2 className="flex items-center gap-2 text-[15px] font-bold text-foreground/80">
              {channel ? CHANNEL_LABEL[channel] : 'Every channel'}
              <span className="text-[12.5px] font-normal text-muted-foreground">
                {items.length} conversation{items.length === 1 ? '' : 's'}, newest first
                {filtered && ' · filtered'}
              </span>
            </h2>
            {items.map((it) => {
              const href =
                it.channel === 'concern' && toGrievances ? `${toGrievances}?id=${it.key}`
                : it.channel === 'staff' && toStaff ? `${toStaff}?with=${it.key.split('|')[0]}`
                : it.channel === 'circular' && toCirculars ? toCirculars
                : undefined
              return (
                <MessageCard
                  key={it.channel + it.key}
                  it={it}
                  onOpen={
                    it.channel === 'parent_teacher' || it.channel === 'staff_parent'
                      ? () => setOpen(it)
                      : it.channel === 'staff'
                        ? () => setOpenStaff(it)
                        : undefined
                  }
                  href={it.channel === 'concern' || it.channel === 'circular' ? href : undefined}
                />
              )
            })}
          </section>
        )}

        {open && <ParentThread item={open} onClose={() => setOpen(null)} />}
        {openStaff && <StaffThread item={openStaff} onClose={() => setOpenStaff(null)} />}
        </div>
      </PageBody>
    </>
  )
}

interface ThreadMsg {
  id: string
  sender: string
  sender_id?: string
  from_school?: boolean
  body: string
  sent_at: string
  read_at?: string
  attachments?: Attachment[]
}

/* One parent ↔ teacher thread, read in full and answered from the desk.

   The whole conversation on its own screen, drawn like every other chat
   in the product, and live: the thread is asked for again every three
   seconds and the moment the stream hints at a message. A reply goes in
   the principal's name on the teacher's thread, so the parent sees who
   wrote and the teacher sees it in their own inbox. No files here: the
   desk's reply endpoint carries words only. */
function ParentThread({ item, onClose }: { item: Item; onClose: () => void }) {
  const qc = useQueryClient()
  const coords = new URLSearchParams({
    student_id: item.student_id ?? '',
    parent_user_id: item.parent_user_id ?? '',
    teacher_user_id: item.teacher_user_id ?? '',
  })
  const thread = useQuery({
    queryKey: ['admin-inbox-thread', item.key],
    queryFn: () => api.get<{ items: ThreadMsg[] }>(`/api/v1/admin/inbox/thread?${coords}`),
    refetchInterval: 3_000,
    refetchOnWindowFocus: true,
  })
  const reply = useMutation({
    mutationFn: (m: { body: string }) =>
      api.post('/api/v1/admin/inbox/reply', {
        student_id: item.student_id,
        parent_user_id: item.parent_user_id,
        teacher_user_id: item.teacher_user_id,
        body: m.body,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-inbox-thread', item.key] })
      qc.invalidateQueries({ queryKey: ['admin-inbox'] })
    },
  })

  return (
    <ThreadPane
      title={`${item.parent_name ?? 'Parent'} ↔ ${item.teacher_name ?? 'Teacher'}`}
      subtitle={[item.child_name, item.child_class, item.admission_no].filter(Boolean).join(' · ')}
      onClose={onClose}
    >
      <ChatThread
        messages={(thread.data?.items ?? []).map((m) => ({
          id: m.id,
          body: m.body,
          at: m.sent_at,
          mine: !!m.from_school,
          sender: m.sender,
          read_at: m.read_at,
          attachments: m.attachments,
        }))}
        peerName={item.child_name ?? item.parent_name}
        peerPhoto={item.child_photo}
        showSender
        loading={thread.isLoading}
        empty="Nothing said yet."
        /* The desk may withdraw what the desk itself wrote, within the same
           window as anybody. Somebody else's message is theirs to take back. */
        onUnsend={async (id) => {
          await api.del(`/api/v1/chat/messages/${id}?channel=parent`)
          qc.invalidateQueries({ queryKey: ['admin-inbox-thread'] })
          qc.invalidateQueries({ queryKey: ['admin-inbox'] })
        }}
        onSend={(m) => reply.mutate({ body: m.body })}
        sending={reply.isPending}
        error={reply.error}
        allowAttachments={false}
        placeholder="Reply to the parent, sent in your name; the teacher sees it too"
        height="min-h-0"
      />
    </ThreadPane>
  )
}

/* A conversation between two colleagues, read from the desk. Read-only:
   the principal is not a party to it. To say something, they write to
   either person from Messages, in their own name. Live the same way. */
function StaffThread({ item, onClose }: { item: Item; onClose: () => void }) {
  const [a, b] = item.key.split('|')
  const thread = useQuery({
    queryKey: ['admin-inbox-staff-thread', item.key],
    queryFn: () => api.get<{ items: ThreadMsg[] }>(`/api/v1/admin/inbox/staff-thread?a=${a}&b=${b}`),
    refetchInterval: 3_000,
    refetchOnWindowFocus: true,
  })
  const [left] = item.title.split(' ↔ ')
  return (
    <ThreadPane title={item.title} subtitle="Between two colleagues, read from the desk" onClose={onClose}>
      <ChatThread
        messages={(thread.data?.items ?? []).map((m) => ({
          id: m.id,
          body: m.body,
          at: m.sent_at,
          // Drawn from the first-named person's side, so the two voices sit
          // on opposite sides as they would for either of them.
          mine: m.sender === left,
          sender: m.sender,
          read_at: m.read_at,
          attachments: m.attachments,
        }))}
        showSender
        loading={thread.isLoading}
        empty="Nothing said yet."
        onSend={() => undefined}
        canSend={false}
        cannotSendNote="You are reading a conversation between two colleagues. To write to either of them, open Messages."
        height="min-h-0"
      />
    </ThreadPane>
  )
}

/* One conversation as a card, the way the desk reads it.

   A dashed meta bar says who it was sent TO (the teacher with her staff code,
   or the parent when the teacher wrote first) and which child it is about
   (class and admission number). Below it, the sender: initials, name, a
   role pill (Father, Mother, Teacher, Staff), the time with how long ago,
   and an amber "Waiting for reply" chip while the school owes an answer.
   The message sits in a left-accented bubble; the school's reply, when
   there is one, under it with who replied and when. Staff-to-staff and
   teacher-to-parent threads read the same way, so the desk is one feed. */
function MessageCard({ it, onOpen, href }: { it: Item; onOpen?: () => void; href?: string }) {
  const family = it.channel === 'parent_teacher' || it.channel === 'staff_parent'
  const parentWrote = it.channel === 'parent_teacher'
  const toName = family ? (parentWrote ? it.teacher_name : it.parent_name) || '-' : it.title || '-'
  const toCode = family && parentWrote && it.teacher_code ? `Staff ${it.teacher_code}` : undefined
  const senderRole = family
      ? parentWrote
        ? cap(it.parent_relation) || 'Parent'
        : 'Teacher'
      : it.channel === 'staff'
        ? 'Staff'
        : CHANNEL_LABEL[it.channel]
  const body = (
    <article className="rounded-xl border bg-card shadow-sm transition-colors hover:border-primary/40">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-dashed px-5 py-3 text-[13px] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <span>To:</span>
          <strong className="truncate text-[14px] text-foreground">{toName}</strong>
          {toCode && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-foreground/70">{toCode}</span>
          )}
          {!parentWrote && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-foreground/70">
              {CHANNEL_LABEL[it.channel]}
            </span>
          )}
        </div>
        {it.child_name ? (
          <div className="rounded-md border bg-muted/40 px-2.5 py-1 text-[12.5px]">
            Student: <strong className="text-foreground">{it.child_name}</strong>
            {it.child_class && <> • {it.child_class}</>}
            {it.admission_no && <span className="text-muted-foreground/80"> ({it.admission_no})</span>}
          </div>
        ) : it.about ? (
          <div className="rounded-md border bg-muted/40 px-2.5 py-1 text-[12.5px]">{it.about}</div>
        ) : null}
      </div>
      <div className="flex gap-3.5 px-5 py-4">
        {/* The face of whoever wrote it, where the school holds one: the
            child's when a parent wrote, the teacher's when the school did. A
            desk of forty cards is otherwise forty coloured circles. */}
        <PersonAvatar
          name={it.from || it.title}
          photoId={it.from === it.parent_name ? it.child_photo : it.teacher_photo}
          size={40}
        />
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-[14.5px] font-bold">{it.from || '-'}</span>
              <span className="rounded-full bg-sky-100 px-2 py-px text-[11px] font-semibold text-sky-800 dark:bg-sky-900/40 dark:text-sky-200">
                {senderRole}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
              <span>{when(it.last_at)}</span>
              {it.pending ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-px text-[11px] font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-600" />
                  {it.channel === 'circular' && it.asked != null
                    ? `${it.acked}/${it.asked} acknowledged`
                    : it.channel === 'staff_parent'
                      ? 'Not read by the parent yet'
                      : 'Waiting for reply'}
                </span>
              ) : (
                <span className="rounded-full bg-muted px-2 py-px text-[11px] font-semibold text-foreground/70">
                  {it.handler ? `With ${it.handler}` : it.status ? it.status.replace(/_/g, ' ') : 'Answered'}
                </span>
              )}
            </div>
          </div>
          {/* The exchange itself, last three lines, oldest first: the family
              on the left, the school on the right. Only the newest line was
              shown before, and a desk that had just watched three texts go
              by could not see them. */}
          {(it.recent ?? []).length > 0 ? (
            <div className="space-y-1.5">
              {(it.recent ?? []).map((m, i) => (
                <div key={i} className={cn('flex', m.from_school ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'max-w-[85%] rounded-lg px-3 py-2 text-[14px] leading-relaxed',
                      m.from_school
                        ? 'rounded-tr-sm border border-l-[3px] border-l-emerald-500 bg-emerald-50/60 dark:bg-emerald-900/10'
                        : 'rounded-tl-sm border border-l-[3px] border-l-indigo-500 bg-muted/40',
                    )}
                  >
                    <div className="mb-0.5 text-[11px] font-semibold text-muted-foreground">
                      {m.sender} · {when(m.at)}
                    </div>
                    <span className="whitespace-pre-wrap">{m.body}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-r-lg rounded-bl-lg border border-l-[3px] border-l-indigo-500 bg-muted/40 px-4 py-3 text-[14px] leading-relaxed">
              <span className="whitespace-pre-wrap">{it.last_body}</span>
            </div>
          )}
        </div>
      </div>
    </article>
  )
  if (onOpen) {
    return (
      <button type="button" className="block w-full text-left" onClick={onOpen}>
        {body}
      </button>
    )
  }
  if (href) return <Link to={href} className="block">{body}</Link>
  return body
}

function cap(s?: string | null): string {
  if (!s) return ''
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** "05 Sept 2026, 07:34 AM (17d ago)" */
function when(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  const t = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  const ms = Date.now() - d.getTime()
  const m = Math.floor(ms / 60_000)
  const rel = m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`
  return `${date}, ${t} (${rel})`
}

/* Where a conversation opens: beside the list on a desk, over everything on a
   phone. The two-pane web chat is what a person at a desk expects; a sheet
   that hides the list is what a thumb expects. */
function ThreadPane({
  title,
  subtitle,
  onClose,
  actions,
  children,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  actions?: ReactNode
  children: ReactNode
}) {
  const phone = usePhone()
  if (phone) {
    return (
      <ChatScreen open title={title} subtitle={subtitle} onBack={onClose} actions={actions}>
        {children}
      </ChatScreen>
    )
  }
  return (
    <Card className="flex max-h-[82vh] min-h-[60vh] flex-col overflow-hidden lg:sticky lg:top-4">
      <CardHeader
        title={title}
        description={subtitle}
        action={
          <div className="flex items-center gap-2">
            {actions}
            <Button size="sm" variant="ghost" onClick={onClose} title="Close" aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </Card>
  )
}
