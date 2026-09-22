import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Inbox, MessageSquare, ShieldAlert, Users, Megaphone, HeartHandshake } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Select, Input, Field,
  Button, Textarea, SkeletonTable, ErrorState, EmptyState, FormNotice,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useFeatureHref } from '../bento/bento-kit'

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

type Channel = 'parent_teacher' | 'concern' | 'staff' | 'circular'

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
  admission_no?: string
  reply_by?: string
  reply_body?: string
  reply_at?: string
}

interface Counts {
  parent_teacher: number
  concerns: number
  staff: number
  circulars: number
  counsellor: number
  total: number
}

const CHANNEL_LABEL: Record<Channel, string> = {
  parent_teacher: 'Parent ↔ teacher',
  concern: 'Concern',
  staff: 'Staff',
  circular: 'Circular',
}

export default function AllMessages() {
  const [channel, setChannel] = useState<'' | Channel>('')
  const [status, setStatus] = useState<'pending' | 'answered' | 'all'>('pending')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Item | null>(null)

  const params = new URLSearchParams({ status })
  if (channel) params.set('channel', channel)
  if (q.trim()) params.set('q', q.trim())

  const inbox = useQuery({
    queryKey: ['admin-inbox', channel, status, q.trim()],
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
                  { value: 'all', label: 'Everything' },
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
        <CellGrid cols={4}>
          <Stat label="Parent ↔ teacher waiting" value={counts?.parent_teacher ?? '–'} icon={MessageSquare}
            active={channel === 'parent_teacher'} onClick={tile('parent_teacher')} />
          <Stat label="Concerns waiting" value={counts?.concerns ?? '–'} icon={ShieldAlert}
            active={channel === 'concern'} onClick={tile('concern')} />
          <Stat label="Staff waiting" value={counts?.staff ?? '–'} icon={Users}
            active={channel === 'staff'} onClick={tile('staff')} />
          <Stat label="Circulars awaiting ack" value={counts?.circulars ?? '–'} icon={Megaphone}
            active={channel === 'circular'} onClick={tile('circular')} />
        </CellGrid>
        <p className="text-[12px] text-muted-foreground">
          Each tile counts what is still waiting for a reply, across the whole school,
          pressing one filters the list below without changing the counts.
        </p>
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <HeartHandshake className="h-4 w-4" />
          {counts?.counsellor ?? '–'} counselling thread{counts?.counsellor === 1 ? '' : 's'} open, private; counted here, never read.
        </p>

        {inbox.isLoading ? (
          <SkeletonTable columns={5} />
        ) : inbox.error ? (
          <ErrorState error={inbox.error} />
        ) : items.length === 0 ? (
          <Card>
            <EmptyState
              title={status === 'pending' ? 'Nothing is waiting on the school.' : 'No messages match.'}
              body={status === 'pending' ? 'Every conversation has been answered.' : 'Change the filter above.'}
            />
          </Card>
        ) : (
          <section className="space-y-4">
            <h2 className="flex items-center gap-2 text-[15px] font-bold text-foreground/80">
              {channel ? CHANNEL_LABEL[channel] : 'Every channel'}
              <span className="text-[12.5px] font-normal text-muted-foreground">
                {items.length} conversation{items.length === 1 ? '' : 's'}, newest first
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
                  onOpen={it.channel === 'parent_teacher' ? () => setOpen(it) : undefined}
                  href={it.channel === 'parent_teacher' ? undefined : href}
                />
              )
            })}
          </section>
        )}

        {open && <ParentThread item={open} onClose={() => setOpen(null)} />}
      </PageBody>
    </>
  )
}

/* One parent ↔ teacher thread, read in full and answered from the desk. */
function ParentThread({ item, onClose }: { item: Item; onClose: () => void }) {
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const coords = new URLSearchParams({
    student_id: item.student_id ?? '',
    parent_user_id: item.parent_user_id ?? '',
    teacher_user_id: item.teacher_user_id ?? '',
  })
  const thread = useQuery({
    queryKey: ['admin-inbox-thread', item.key],
    queryFn: () =>
      api.get<{ items: { id: string; sender: string; from_school: boolean; body: string; sent_at: string }[] }>(
        `/api/v1/admin/inbox/thread?${coords}`,
      ),
  })
  const reply = useMutation({
    mutationFn: () =>
      api.post('/api/v1/admin/inbox/reply', {
        student_id: item.student_id,
        parent_user_id: item.parent_user_id,
        teacher_user_id: item.teacher_user_id,
        body,
      }),
    onSuccess: () => {
      setBody('')
      qc.invalidateQueries({ queryKey: ['admin-inbox-thread', item.key] })
      qc.invalidateQueries({ queryKey: ['admin-inbox'] })
    },
  })

  return (
    <Card>
      <CardHeader
        title={`${item.parent_name ?? 'Parent'} → ${item.teacher_name ?? 'Teacher'}`}
        description={[item.child_name, item.child_class, item.admission_no].filter(Boolean).join(' · ')}
        action={<Button variant="secondary" size="sm" onClick={onClose}>Close</Button>}
      />
      <div className="max-h-[50vh] space-y-3 overflow-y-auto px-5 py-4">
        {thread.isLoading ? (
          <SkeletonTable columns={1} />
        ) : thread.error ? (
          <ErrorState error={thread.error} />
        ) : (
          (thread.data?.items ?? []).map((m) => (
            <div key={m.id} className={m.from_school ? 'flex justify-end' : 'flex justify-start'}>
              <div
                className={
                  'max-w-[80%] rounded-xl px-3.5 py-2 text-[14px] ' +
                  (m.from_school ? 'bg-primary/10' : 'bg-muted')
                }
              >
                <div className="text-[11px] font-semibold text-muted-foreground">
                  {m.sender} · {formatDate(m.sent_at)}
                </div>
                <div className="whitespace-pre-wrap">{m.body}</div>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="space-y-2 border-t px-5 py-4">
        <Textarea value={body} onChange={setBody} placeholder="Reply to the parent, sent in your name, the teacher sees it too" rows={3} />
        <div className="flex items-center gap-3">
          <Button onClick={() => reply.mutate()} disabled={!body.trim() || reply.isPending} pending={reply.isPending}>
            <Inbox className="h-4 w-4" /> Send reply
          </Button>
          {reply.isError && <FormNotice error={reply.error} />}
        </div>
      </div>
    </Card>
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
  const parentWrote = it.channel === 'parent_teacher' ? it.from === it.parent_name : false
  const toName =
    it.channel === 'parent_teacher'
      ? (parentWrote ? it.teacher_name : it.parent_name) || '-'
      : it.title || '-'
  const toCode = it.channel === 'parent_teacher' && parentWrote && it.teacher_code ? `Staff ${it.teacher_code}` : undefined
  const senderRole =
    it.channel === 'parent_teacher'
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
          {it.channel !== 'parent_teacher' && (
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
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-indigo-100 text-[13px] font-bold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200"
          aria-hidden="true"
        >
          {initials(it.from)}
        </span>
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
                  {it.channel === 'circular' && it.asked != null ? `${it.acked}/${it.asked} acknowledged` : 'Waiting for reply'}
                </span>
              ) : (
                <span className="rounded-full bg-muted px-2 py-px text-[11px] font-semibold text-foreground/70">
                  {it.handler ? `With ${it.handler}` : it.status ? it.status.replace(/_/g, ' ') : 'Answered'}
                </span>
              )}
            </div>
          </div>
          <div className="rounded-r-lg rounded-bl-lg border border-l-[3px] border-l-indigo-500 bg-muted/40 px-4 py-3 text-[14px] leading-relaxed">
            <span className="whitespace-pre-wrap">{it.last_body}</span>
          </div>
          {it.reply_body && (
            <div className="mt-3 flex gap-3">
              <span
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-emerald-100 text-[11px] font-bold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200"
                aria-hidden="true"
              >
                {initials(it.reply_by ?? '')}
              </span>
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-[12px] text-muted-foreground">
                  Replied by <span className="font-semibold text-foreground">{it.reply_by}</span>
                  {it.reply_at && <> · {when(it.reply_at)}</>}
                </div>
                <div className="rounded-r-lg rounded-bl-lg border border-l-[3px] border-l-emerald-500 bg-emerald-50/60 px-4 py-2.5 text-[14px] leading-relaxed dark:bg-emerald-900/10">
                  <span className="whitespace-pre-wrap">{it.reply_body}</span>
                </div>
              </div>
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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
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
