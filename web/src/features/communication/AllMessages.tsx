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
          <Stat label="Parent → teacher" value={counts?.parent_teacher ?? '–'} icon={MessageSquare}
            active={channel === 'parent_teacher'} onClick={tile('parent_teacher')} />
          <Stat label="Concerns" value={counts?.concerns ?? '–'} icon={ShieldAlert}
            active={channel === 'concern'} onClick={tile('concern')} />
          <Stat label="Staff" value={counts?.staff ?? '–'} icon={Users}
            active={channel === 'staff'} onClick={tile('staff')} />
          <Stat label="Circulars awaiting ack" value={counts?.circulars ?? '–'} icon={Megaphone}
            active={channel === 'circular'} onClick={tile('circular')} />
        </CellGrid>
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <HeartHandshake className="h-4 w-4" />
          {counts?.counsellor ?? '–'} counselling thread{counts?.counsellor === 1 ? '' : 's'} open — private; counted here, never read.
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
                const inner = (
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
                        <span className="font-medium text-foreground/80">{it.from || '—'}:</span> {it.last_body}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-[12px] text-muted-foreground">
                      <div>{formatDate(it.last_at)} · {ago(it.last_at)}</div>
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
        title={item.title}
        description={item.about ? `About ${item.about}` : undefined}
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
        <Textarea value={body} onChange={setBody} placeholder="Reply to the parent — sent in your name, the teacher sees it too" rows={3} />
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
