import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Inbox, MessageSquare, ShieldAlert, Users, Megaphone, HeartHandshake } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Select, Input, Field,
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
  parent_teacher: 'Parent → teacher',
  concern: 'Concern',
  staff: 'Staff',
  circular: 'Circular',
}

/** "14:05" in the reader's own timezone. */
function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 24) return `${h} h`
  const d = Math.floor(h / 24)
  return d === 1 ? '1 day' : `${d} days`
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
    refetchInterval: 60_000,
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
          <Stat label="Parent → teacher waiting" value={counts?.parent_teacher ?? '–'} icon={MessageSquare}
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
          <Card>
            <CardHeader
              title={channel ? CHANNEL_LABEL[channel] : 'Every channel'}
              description={`${items.length} conversation${items.length === 1 ? '' : 's'}, newest first`}
            />
            <ul className="divide-y">
              {items.map((it) => {
                const inner =
                  it.channel === 'parent_teacher' ? (
                    /* Who wrote to whom, spelled out: the teacher with her staff
                       code, the child with class and admission number, the
                       guardian with their relation — then the message, then the
                       school's last answer if there is one. A desk cannot act on
                       "kalyan → Lakshmi". */
                    <div className="space-y-2 px-5 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                        <div className="min-w-0">
                          <div className="text-[15px] font-semibold">{it.teacher_name || '-'}</div>
                          <div className="text-[12px] text-muted-foreground">
                            {it.teacher_code ? `Staff ${it.teacher_code}` : 'Teacher'}
                          </div>
                        </div>
                        <div className="shrink-0 text-right text-[12px] text-muted-foreground">
                          <Badge tone={it.pending ? 'warning' : 'neutral'}>
                            {it.pending ? 'waiting for reply' : 'answered'}
                          </Badge>
                        </div>
                      </div>

                      <div className="text-[13px]">
                        <span className="text-muted-foreground">Student </span>
                        <span className="font-medium">{it.child_name}</span>
                        {it.child_class && <span className="text-muted-foreground"> · {it.child_class}</span>}
                        {it.admission_no && (
                          <span className="font-mono text-[12px] text-muted-foreground"> · {it.admission_no}</span>
                        )}
                      </div>
                      <div className="text-[13px]">
                        <span className="text-muted-foreground">
                          {it.parent_relation
                            ? it.parent_relation.charAt(0).toUpperCase() + it.parent_relation.slice(1)
                            : 'Parent'}{' '}
                        </span>
                        <span className="font-medium">{it.parent_name}</span>
                      </div>

                      <div className="rounded-lg bg-muted px-3 py-2">
                        <div className="text-[11px] font-semibold text-muted-foreground">
                          {it.from} · {formatDate(it.last_at)} {time(it.last_at)} · {ago(it.last_at)} ago
                        </div>
                        <div className="text-[14px]">{it.last_body}</div>
                      </div>

                      {it.reply_body && (
                        <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
                          <div className="text-[11px] font-semibold text-muted-foreground">
                            Replied by {it.reply_by} · {formatDate(it.reply_at!)} {time(it.reply_at!)}
                          </div>
                          <div className="text-[14px]">{it.reply_body}</div>
                        </div>
                      )}
                    </div>
                  ) : (
                  <div className="flex flex-wrap items-start gap-x-4 gap-y-1 px-5 py-3">
                    <div className="w-[120px] shrink-0">
                      <Badge tone={it.pending ? 'warning' : 'neutral'}>{CHANNEL_LABEL[it.channel]}</Badge>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-medium">
                        {it.title}
                        {it.about && <span className="text-muted-foreground"> · {it.about}</span>}
                      </div>
                      <div className="truncate text-[13px] text-muted-foreground">
                        <span className="font-medium text-foreground/80">{it.from || '-'}:</span> {it.last_body}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-[12px] text-muted-foreground">
                      <div>{formatDate(it.last_at)} {time(it.last_at)} · {ago(it.last_at)}</div>
                      {it.pending ? (
                        <div className="font-semibold text-warning">
                          {it.channel === 'circular' && it.asked != null
                            ? `${it.acked}/${it.asked} acknowledged`
                            : 'waiting for reply'}
                        </div>
                      ) : it.handler ? (
                        <div>with {it.handler}</div>
                      ) : it.status ? (
                        <div>{it.status.replace(/_/g, ' ')}</div>
                      ) : null}
                    </div>
                  </div>
                  )
                const cls = 'block hover:bg-accent/50'
                if (it.channel === 'parent_teacher')
                  return (
                    <li key={it.channel + it.key}>
                      <button type="button" className={cls + ' w-full text-left'} onClick={() => setOpen(it)}>
                        {inner}
                      </button>
                    </li>
                  )
                const href =
                  it.channel === 'concern' && toGrievances ? `${toGrievances}?id=${it.key}`
                  : it.channel === 'staff' && toStaff ? `${toStaff}?with=${it.key.split('|')[0]}`
                  : it.channel === 'circular' && toCirculars ? toCirculars
                  : undefined
                return (
                  <li key={it.channel + it.key}>
                    {href ? <Link to={href} className={cls}>{inner}</Link> : inner}
                  </li>
                )
              })}
            </ul>
          </Card>
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
