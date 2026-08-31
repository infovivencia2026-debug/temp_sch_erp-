import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CheckCheck, Send } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { formatDateTime } from '@/lib/utils'
import {
  PageHead, PageBody, Card, CardHeader, Badge, Button, Input, Textarea,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { cn } from '@/lib/utils'

/* One member of staff writing to another.
 *
 * The product had three messaging channels and none of them was this. A parent
 * can write to their child's teacher, a counsellor has a private thread, a
 * class has a homework forum — and a principal wanting to ask one head of
 * department about Thursday had nowhere to do it. The menu entry that claimed
 * otherwise opened the circular composer, which broadcasts to the school: the
 * right tool for "tell everybody" and the wrong one for "ask one person".
 *
 * The address book is everyone on the staff, whether or not a conversation
 * exists yet, because the first message to somebody is the ordinary case and a
 * list of existing threads cannot start one. Unread first, then alphabetical,
 * which is how you look for a name you already know.
 */

interface Thread {
  user_id: string
  full_name: string
  designation?: string
  unread: number
  last_message?: string
  last_at?: string
}

interface Message {
  id: string
  body: string
  sent_at: string
  mine: boolean
  /* Served by both message endpoints and declared by neither client until
     now, so a teacher could not tell a message the parent had read from one
     still sitting unopened -- which is exactly the question a teacher asks
     before ringing a family. */
  read_at?: string
  sender_name: string
}

/* A conversation with a family, which had nowhere to land.
 *
 * A parent writes to their child's teacher from the portal, the message is
 * stored and a notification is raised — and then the teacher has no screen
 * that reads it. "Messages" was staff-to-staff only; "Communication" is what
 * the teacher sends out. The message arrived at a room with no door, and the
 * parent sat waiting for a reply to something nobody could see.
 *
 * It belongs here rather than on a menu entry of its own. A teacher opening
 * "Messages" is asking who has written to me, and answering that with two
 * separate places to look is how somebody misses one of them for a week. */
interface ParentThread {
  student_id: string
  student_name: string
  class_name?: string
  parent_user_id: string
  parent_name: string
  last_message?: string
  last_at?: string
  unread: number
  /* Sent only to a reader seeing threads that are not their own — a head of
     department or the principal. A teacher's inbox has one teacher in it. */
  teacher_user_id?: string
  teacher_name?: string
}

export default function StaffMessages() {
  const qc = useQueryClient()
  /* Opened on somebody, when the link says so.
   *
   * A notification about a message led here and stopped, leaving the reader
   * to pick the sender out of a list of colleagues — the one thing the
   * notification already knew. ?with= names them, and the URL then describes
   * the conversation, so it is linkable and the back button works. */
  const [params, setParams] = useSearchParams()
  const openWith = params.get('with') ?? ''
  const setOpenWith = (id: string) => {
    const next = new URLSearchParams(params)
    if (id) next.set('with', id)
    else next.delete('with')
    setParams(next, { replace: !id })
  }
  const [find, setFind] = useState('')
  const [draft, setDraft] = useState('')

  /* Which register is open. In the URL for the same reason `with` is: a
     notification about a parent's message has to be able to land on it. */
  const box = params.get('box') === 'parents' ? 'parents' : 'staff'
  const setBox = (b: 'staff' | 'parents') => {
    const next = new URLSearchParams(params)
    if (b === 'parents') next.set('box', 'parents')
    else next.delete('box')
    next.delete('with')
    next.delete('child')
    setParams(next, { replace: true })
  }
  const openChild = params.get('child') ?? ''
  const setOpenChild = (studentID: string, parentID: string) => {
    const next = new URLSearchParams(params)
    next.set('box', 'parents')
    next.set('child', studentID)
    next.set('with', parentID)
    setParams(next)
  }

  const parentThreads = useQuery({
    queryKey: ['parent-threads'],
    queryFn: () => api.get<List<ParentThread>>('/api/v1/teaching/parent-messages'),
  })
  const openParent = (parentThreads.data?.items ?? []).find(
    (t) => t.student_id === openChild && t.parent_user_id === openWith,
  )
  const parentMessages = useQuery({
    /* The teacher is part of the identity of a thread.

       A head can hold two conversations with the same parent about the same
       child — one with the class teacher, one with the maths teacher — and
       without this they share a cache entry, so opening the second shows the
       first. */
    queryKey: ['parent-messages', openChild, openWith, openParent?.teacher_user_id],
    queryFn: () =>
      api.get<List<Message>>(
        `/api/v1/teaching/parent-messages/thread?student_id=${openChild}` +
        `&parent_user_id=${openWith}` +
        /* Named only when reading somebody else's thread; the server ignores
           it without comms.messages.read.all, so it can never widen. */
        (openParent?.teacher_user_id ? `&teacher_user_id=${openParent.teacher_user_id}` : ''),
      ),
    enabled: box === 'parents' && !!openChild && !!openWith,
  })

  const replyToParent = useMutation({
    // The same endpoint the parent writes with: it already had a branch for a
    // teacher answering, checked against whether they teach that child.
    mutationFn: () =>
      api.post('/api/v1/portal/messages', {
        student_id: openChild,
        parent_user_id: openWith,
        body: draft,
      }),
    onSuccess: () => {
      setDraft('')
      qc.invalidateQueries({ queryKey: ['parent-messages', openChild, openWith] })
      qc.invalidateQueries({ queryKey: ['parent-threads'] })
    },
  })

  const threads = useQuery({
    queryKey: ['staff-threads'],
    queryFn: () => api.get<List<Thread>>('/api/v1/staff-messages/threads'),
  })
  const messages = useQuery({
    queryKey: ['staff-messages', openWith],
    queryFn: () => api.get<List<Message>>(`/api/v1/staff-messages?with=${openWith}`),
    enabled: !!openWith,
  })

  const send = useMutation({
    mutationFn: () => api.post('/api/v1/staff-messages', { to: openWith, body: draft }),
    onSuccess: () => {
      setDraft('')
      qc.invalidateQueries({ queryKey: ['staff-messages', openWith] })
      qc.invalidateQueries({ queryKey: ['staff-threads'] })
    },
  })

  if (threads.isLoading) return <Loading />
  if (threads.error) return <ErrorState error={threads.error} />

  const all = threads.data?.items ?? []
  const needle = find.trim().toLowerCase()
  const people = needle
    ? all.filter(
        (t) =>
          t.full_name.toLowerCase().includes(needle) ||
          (t.designation ?? '').toLowerCase().includes(needle),
      )
    : all
  const open = all.find((t) => t.user_id === openWith)
  const parents = parentThreads.data?.items ?? []
  const staffUnread = all.reduce((n, t) => n + t.unread, 0)
  const parentUnread = parents.reduce((n, t) => n + t.unread, 0)
  const unreadTotal = staffUnread + parentUnread

  return (
    <>
      <PageHead
        eyebrow="Communication"
        title="Messages"
        description="Colleagues, and the parents who have written to you. For something the whole school needs, write a circular instead."
        actions={
          unreadTotal > 0 && <Badge tone="primary">{unreadTotal} unread</Badge>
        }
      />
      <PageBody>
        {/* Two registers, one question.
            A teacher opening Messages is asking who has written to me, and
            answering that in two separate places is how one of them goes
            unread for a week. */}
        <div className="flex flex-wrap gap-1 border-b">
          {([
            ['staff', 'Colleagues', staffUnread],
            ['parents', 'Parents', parentUnread],
          ] as const).map(([k, label, unread]) => (
            <button
              key={k}
              type="button"
              onClick={() => setBox(k)}
              aria-current={box === k}
              className={
                box === k
                  ? '-mb-px flex items-center gap-1.5 border-b-2 border-primary px-3 py-2 text-[14px] font-medium'
                  : '-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-[14px] text-muted-foreground hover:text-foreground'
              }
            >
              {label}
              {unread > 0 && <Badge tone="primary">{unread}</Badge>}
            </button>
          ))}
        </div>

        {box === 'parents' ? (
          <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
            <Card className="min-w-0">
              {/* "Parents", matching the tab above it. The two said different
                  words for the same list, which reads as two different lists. */}
              <CardHeader
                title="Parents"
                description={
                  parents.length
                    ? `${parents.length} conversation${parents.length === 1 ? '' : 's'}`
                    : undefined
                }
              />
              <ul className="max-h-[28rem] divide-y overflow-auto">
                {parents.map((t) => (
                  <li key={`${t.student_id}-${t.parent_user_id}`}>
                    <button
                      type="button"
                      onClick={() => setOpenChild(t.student_id, t.parent_user_id)}
                      className={cn(
                        'w-full px-4 py-2.5 text-left transition-colors',
                        t.student_id === openChild && t.parent_user_id === openWith
                          ? 'bg-accent'
                          : 'hover:bg-muted/60',
                      )}
                    >
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
                          {t.parent_name}
                        </span>
                        {t.last_at && (
                          <span className="shrink-0 text-[11.5px] text-muted-foreground">
                            {t.last_at.slice(0, 10)}
                          </span>
                        )}
                        {t.unread > 0 && <Badge tone="primary">{t.unread}</Badge>}
                      </span>
                      {/* Whose parent, which is the fact a teacher recognises
                          — twelve surnames mean nothing without the child. */}
                      <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
                        {t.student_name}
                        {t.class_name ? ` · ${t.class_name}` : ''}
                        {/* And which teacher, for somebody reading other
                            people's threads. Without it a head sees a list of
                            parents and cannot tell who at the school each one
                            was talking to, which is most of the question. */}
                        {t.teacher_name ? ` → ${t.teacher_name}` : ''}
                      </span>
                      <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
                        {t.last_message ?? ''}
                      </span>
                    </button>
                  </li>
                ))}
                {parents.length === 0 && (
                  <li className="px-4 py-3 text-[13px] text-muted-foreground">
                    No parent has written to you yet. A parent starts the conversation from
                    their own app.
                  </li>
                )}
              </ul>
            </Card>

            <Card className="flex min-w-0 flex-col">
              {!openChild || !openWith ? (
                <div className="p-8">
                  <EmptyState
                    title="Choose a conversation"
                    body="Parents write to you about one child at a time, so each thread is about one of your students."
                  />
                </div>
              ) : (
                <>
                  <CardHeader
                    title={openParent?.parent_name ?? 'Conversation'}
                    description={
                      openParent
                        ? `About ${openParent.student_name}${openParent.class_name ? ` · ${openParent.class_name}` : ''}`
                        : undefined
                    }
                  />
                  <div className="max-h-[24rem] min-h-[12rem] flex-1 space-y-2 overflow-auto px-5 py-4">
                    {parentMessages.isLoading ? (
                      <Loading />
                    ) : (
                      (parentMessages.data?.items ?? []).map((m) => (
                        <div
                          key={m.id}
                          className={cn(
                            'max-w-[85%] rounded-lg px-3 py-2 text-[14px]',
                            m.mine ? 'ml-auto bg-primary text-primary-foreground' : 'bg-muted',
                          )}
                        >
                          <p className="whitespace-pre-wrap">{m.body}</p>
                          <p
                            className={cn(
                              'mt-1 text-[11.5px]',
                              m.mine ? 'text-primary-foreground/70' : 'text-muted-foreground',
                            )}
                          >
                            {formatDateTime(m.sent_at)}
                            {m.mine && (
                              m.read_at ? (
                                <span className="ml-1.5 inline-flex items-center gap-1">
                                  <CheckCheck className="h-3.5 w-3.5" />
                                  Read {formatDateTime(m.read_at)}
                                </span>
                              ) : (
                                <span className="ml-1.5 inline-flex items-center gap-1">
                                  <Check className="h-3.5 w-3.5" />
                                  Sent
                                </span>
                              )
                            )}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                  <form
                    className="flex items-end gap-2 border-t px-5 py-3"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (draft.trim()) replyToParent.mutate()
                    }}
                  >
                    <Textarea
                      value={draft}
                      onChange={setDraft}
                      rows={2}
                      onSubmit={() => { if (draft.trim()) replyToParent.mutate() }}
                      placeholder={`Reply to ${openParent?.parent_name ?? 'them'} — Enter sends`}
                    />
                    <Button type="submit" disabled={!draft.trim() || replyToParent.isPending}>
                      <Send className="h-3.5 w-3.5" />
                      {replyToParent.isPending ? 'Sending…' : 'Reply'}
                    </Button>
                  </form>
                  {replyToParent.isError && (
                    <p className="px-5 pb-3 text-[13px] text-destructive">
                      {replyToParent.error instanceof Error
                        ? replyToParent.error.message
                        : 'Could not send that.'}
                    </p>
                  )}
                </>
              )}
            </Card>
          </div>
        ) : (
        <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <Card className="min-w-0">
            <CardHeader title="Staff" description={`${all.length} colleagues`} />
            <div className="px-4 pb-3">
              <Input value={find} onChange={setFind} placeholder="Find a name" />
            </div>
            <ul className="max-h-[28rem] divide-y overflow-auto">
              {people.map((t) => (
                <li key={t.user_id}>
                  <button
                    type="button"
                    onClick={() => setOpenWith(t.user_id)}
                    className={cn(
                      'w-full px-4 py-2.5 text-left transition-colors',
                      t.user_id === openWith ? 'bg-accent' : 'hover:bg-muted/60',
                    )}
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
                        {t.full_name}
                      </span>
                      {/* When you last spoke, so a thread is visibly a thread.
                          Only the date: the time of a message from March is
                          not what anybody is looking for in a list. */}
                      {t.last_at && (
                        <span className="shrink-0 text-[11.5px] text-muted-foreground">
                          {t.last_at.slice(0, 10)}
                        </span>
                      )}
                      {t.unread > 0 && <Badge tone="primary">{t.unread}</Badge>}
                    </span>
                    <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
                      {t.last_message ?? t.designation ?? 'No messages yet'}
                    </span>
                  </button>
                </li>
              ))}
              {people.length === 0 && (
                <li className="px-4 py-3 text-[13px] text-muted-foreground">
                  Nobody matches “{find.trim()}”.
                </li>
              )}
            </ul>
          </Card>

          <Card className="flex min-w-0 flex-col">
            {!openWith ? (
              <div className="p-8">
                <EmptyState
                  title="Choose somebody to write to"
                  body="Every member of staff is listed, whether or not you have written to them before."
                />
              </div>
            ) : (
              <>
                <CardHeader
                  title={open?.full_name ?? 'Conversation'}
                  description={open?.designation ?? undefined}
                />
                <div className="max-h-[24rem] min-h-[12rem] flex-1 space-y-2 overflow-auto px-5 py-4">
                  {messages.isLoading ? (
                    <Loading />
                  ) : (messages.data?.items ?? []).length === 0 ? (
                    <p className="text-[13px] text-muted-foreground">
                      Nothing yet. What you write here goes to {open?.full_name} alone.
                    </p>
                  ) : (
                    (messages.data?.items ?? []).map((m) => (
                      <div
                        key={m.id}
                        className={cn(
                          'max-w-[85%] rounded-lg px-3 py-2 text-[14px]',
                          m.mine
                            ? 'ml-auto bg-primary text-primary-foreground'
                            : 'bg-muted',
                        )}
                      >
                        <p className="whitespace-pre-wrap">{m.body}</p>
                        <p
                          className={cn(
                            'mt-1 text-[11.5px]',
                            m.mine ? 'text-primary-foreground/70' : 'text-muted-foreground',
                          )}
                        >
                          {formatDateTime(m.sent_at)}
                          {m.mine && (
                            m.read_at ? (
                              <span className="ml-1.5 inline-flex items-center gap-1">
                                <CheckCheck className="h-3.5 w-3.5" />
                                Read {formatDateTime(m.read_at)}
                              </span>
                            ) : (
                              <span className="ml-1.5 inline-flex items-center gap-1">
                                <Check className="h-3.5 w-3.5" />
                                Sent
                              </span>
                            )
                          )}
                        </p>
                      </div>
                    ))
                  )}
                </div>
                <form
                  className="flex items-end gap-2 border-t px-5 py-3"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (draft.trim()) send.mutate()
                  }}
                >
                  <Textarea
                    value={draft}
                    onChange={setDraft}
                    rows={2}
                    onSubmit={() => { if (draft.trim()) send.mutate() }}
                    placeholder={`Write to ${open?.full_name ?? 'them'} — Enter sends`}
                  />
                  <Button type="submit" disabled={!draft.trim() || send.isPending}>
                    <Send className="h-3.5 w-3.5" />
                    {send.isPending ? 'Sending…' : 'Send'}
                  </Button>
                </form>
                {send.isError && (
                  <p className="px-5 pb-3 text-[13px] text-destructive">
                    {send.error instanceof Error ? send.error.message : 'Could not send that.'}
                  </p>
                )}
              </>
            )}
          </Card>
        </div>
        )}
      </PageBody>
    </>
  )
}
