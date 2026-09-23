import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChatThread, type Attachment } from '@/components/Chat'
import { ChatScreen, PersonAvatar } from '@/components/ChatScreen'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Badge, Input,
  Loading, ErrorState, tabClass, TAB_BAR } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useSession } from '@/lib/session'

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
  photo?: string
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
  attachments?: Attachment[]
  /** Full-precision send time; pass as `before` to fetch the page above. */
  cursor?: string
  reply_to_id?: string
  reply_body?: string
  reply_sender?: string
  edited?: boolean
  deleted?: boolean
  /* 'parent' or 'teacher'. Who wrote it, in a thread that has exactly two
     sides — which "mine" cannot answer for a principal reading somebody
     else's conversation, where nothing is theirs. */
  sender_side?: string
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
  student_photo?: string
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
  /* Unread only. A school has a hundred colleagues and four conversations
     that want answering; scrolling the address book to find them is the
     wrong way round. */
  const [unreadOnly, setUnreadOnly] = useState(false)
  const me = useSession().user?.id

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
    mutationFn: (m: { body: string; attachments: Attachment[]; reply_to_id?: string }) =>
      api.post('/api/v1/portal/messages', {
        student_id: openChild,
        parent_user_id: openWith,
        body: m.body,
        attachments: m.attachments,
        reply_to_id: m.reply_to_id,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['parent-messages', openChild, openWith] })
      qc.invalidateQueries({ queryKey: ['parent-threads'] })
    },
  })

  /* How far back each open thread has been read. A conversation loads its
     newest page; pressing "Older messages" walks the cursor backwards, and the
     pages are kept so the thread reads continuously. */
  const [olderStaff, setOlderStaff] = useState<Message[]>([])
  const [olderParent, setOlderParent] = useState<Message[]>([])
  const [loadingOlder, setLoadingOlder] = useState(false)

  const threads = useQuery({
    queryKey: ['staff-threads'],
    queryFn: () => api.get<List<Thread>>('/api/v1/staff-messages/threads'),
  })
  const messages = useQuery({
    queryKey: ['staff-messages', openWith],
    queryFn: () => api.get<List<Message>>(`/api/v1/staff-messages?with=${openWith}`),
    enabled: !!openWith,
  })

  useEffect(() => {
    setOlderStaff([])
  }, [openWith])
  useEffect(() => {
    setOlderParent([])
  }, [openChild, openWith])

  /* Tell the other side their message was seen -- once it has actually been on
     screen, which is what the tick is supposed to mean. */
  const seenStaff = () => {
    if (openWith) void api.post(`/api/v1/chat/staff-thread/read?with=${openWith}`, {})
      .then(() => {
        qc.invalidateQueries({ queryKey: ['staff-threads'] })
        qc.invalidateQueries({ queryKey: ['notifications'] })
      })
      .catch(() => {})
  }
  const seenParent = () => {
    /* The teacher on the thread. The list omits it on a teacher's own inbox
       -- there is one teacher in it and it is them -- so it was being left off
       the call, which needs all three ids and answered 400. Nothing was
       marked, and the tab kept its unread count over a conversation that had
       plainly been read. */
    const teacher = openParent?.teacher_user_id ?? me
    if (!openChild || !openWith || !teacher) return
    void api.post(
      `/api/v1/chat/parent-thread/read?student_id=${openChild}&parent_user_id=${openWith}` +
      `&teacher_user_id=${teacher}`,
      {},
    ).then(() => {
      qc.invalidateQueries({ queryKey: ['parent-threads'] })
      qc.invalidateQueries({ queryKey: ['notifications'] })
    }).catch(() => {})
  }

  const editMessage = (channel: 'staff' | 'parent') => async (id: string, body: string) => {
    await api.put(`/api/v1/chat/messages/${id}?channel=${channel}`, { body })
    qc.invalidateQueries({ queryKey: [channel === 'staff' ? 'staff-messages' : 'parent-messages'] })
  }
  const unsendMessage = (channel: 'staff' | 'parent') => async (id: string) => {
    await api.del(`/api/v1/chat/messages/${id}?channel=${channel}`)
    qc.invalidateQueries({ queryKey: [channel === 'staff' ? 'staff-messages' : 'parent-messages'] })
  }

  const loadOlder = async (kind: 'staff' | 'parent') => {
    const cur = kind === 'staff' ? [...olderStaff, ...(messages.data?.items ?? [])]
                                 : [...olderParent, ...(parentMessages.data?.items ?? [])]
    const before = cur[0]?.cursor
    if (!before || loadingOlder) return
    setLoadingOlder(true)
    try {
      const url = kind === 'staff'
        ? `/api/v1/staff-messages?with=${openWith}&before=${encodeURIComponent(before)}`
        : `/api/v1/teaching/parent-messages/thread?student_id=${openChild}&parent_user_id=${openWith}` +
          (openParent?.teacher_user_id ? `&teacher_user_id=${openParent.teacher_user_id}` : '') +
          `&before=${encodeURIComponent(before)}`
      const page = await api.get<List<Message> & { has_more?: boolean }>(url)
      if (kind === 'staff') setOlderStaff((p) => [...(page.items ?? []), ...p])
      else setOlderParent((p) => [...(page.items ?? []), ...p])
    } finally {
      setLoadingOlder(false)
    }
  }

  const send = useMutation({
    mutationFn: (m: { body: string; attachments: Attachment[]; reply_to_id?: string }) =>
      api.post('/api/v1/staff-messages', {
        to: openWith, body: m.body, attachments: m.attachments, reply_to_id: m.reply_to_id,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['staff-messages', openWith] })
      qc.invalidateQueries({ queryKey: ['staff-threads'] })
    },
  })

  if (threads.isLoading) return <Loading />
  if (threads.error) return <ErrorState error={threads.error} />

  const all = threads.data?.items ?? []
  const needle = find.trim().toLowerCase()
  const people = all
    .filter(
      (t) =>
        !needle ||
        t.full_name.toLowerCase().includes(needle) ||
        (t.designation ?? '').toLowerCase().includes(needle),
    )
    .filter((t) => !unreadOnly || t.unread > 0)
  const open = all.find((t) => t.user_id === openWith)
  /* The parents list takes the same two filters as the colleagues list:
     the name box is the one already on screen, and unread-only answers the
     question a teacher actually opens this with. */
  const parents = (parentThreads.data?.items ?? [])
    .filter(
      (t) =>
        !needle ||
        t.parent_name.toLowerCase().includes(needle) ||
        t.student_name.toLowerCase().includes(needle) ||
        (t.class_name ?? '').toLowerCase().includes(needle),
    )
    .filter((t) => !unreadOnly || t.unread > 0)
  /* The badges count both lists whole, never the filtered view: a tab that
     says "0 unread" because a name was typed in the box is a tab lying about
     the school. */
  /* A conversation being read does not count as waiting. The server catches
     up a moment later; until it does, the tab must not claim there are two
     unread messages in the thread somebody is looking at. */
  const staffUnread = all.reduce((n, t) => n + (t.user_id === openWith ? 0 : t.unread), 0)
  const parentUnread = (parentThreads.data?.items ?? []).reduce(
    (n, t) => n + (t.student_id === openChild && t.parent_user_id === openWith ? 0 : t.unread),
    0,
  )
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
        <div className={cn(TAB_BAR, 'justify-center')}>
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
                  ? tabClass(true)
                  : tabClass(false)
              }
            >
              {label}
              {unread > 0 && <Badge tone="primary">{unread}</Badge>}
            </button>
          ))}
        </div>

        {box === 'parents' ? (
          <div className="grid gap-4">
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
              <div className="space-y-2 px-4 pb-3 pt-3">
                <Input value={find} onChange={setFind} placeholder="Find a parent, child or class" />
                <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={unreadOnly}
                    onChange={(e) => setUnreadOnly(e.target.checked)}
                    className="h-4 w-4"
                  />
                  Unread only{parentUnread > 0 ? ` (${parentUnread})` : ''}
                </label>
              </div>
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
                      <span className="flex items-start gap-3">
                      <PersonAvatar name={t.student_name || t.parent_name} photoId={t.student_photo} size={44} />
                      <span className="min-w-0 flex-1">
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
                      {/* Wrapped, not truncated. "Nikhil Gupta · Grade 6-B →
                          Priya Rao" is three facts and the ellipsis was eating
                          the third — so a head saw which family but not which
                          teacher, which is most of what they opened the list
                          for. A second line costs nothing here. */}
                      <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
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
                      </span>
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

            {/* The conversation takes the whole screen, the way a phone does
                it: the list is one screen, the chat is the next, and Back
                returns to the list exactly as it was. See ChatScreen. */}
            <ChatScreen
              open={!!openChild && !!openWith}
              title={openParent ? openParent.parent_name : 'Conversation'}
              photoId={openParent?.student_photo}
              subtitle={
                openParent
                  ? `Parent of ${openParent.student_name}${openParent.class_name ? ` · ${openParent.class_name}` : ''}`
                  : undefined
              }
              onBack={() => setBox('parents')}
            >
              {/* READING SOMEBODY ELSE'S CONVERSATION IS NOT JOINING IT.
                  A principal opens a parent's thread to see what was said;
                  replying into it would put the head's words in a conversation
                  the parent is having with their child's teacher. The server
                  refuses it; the composer is hidden. openParent.teacher_user_id
                  is missing only on the caller's own threads. */}
              <ChatThread
                /* Live: "typing…" from the parent, and ours to them. The
                   teacher on a thread of my own is me; on a colleague's thread
                   it is theirs (and the composer is hidden anyway). */
                live={openParent && me ? {
                  scope: 'parent', student: openChild, parent: openWith,
                  teacher: openParent.teacher_user_id ?? me,
                } : undefined}
                messages={[...olderParent, ...(parentMessages.data?.items ?? [])].map((m) => ({
                  id: m.id,
                  body: m.body,
                  at: m.sent_at,
                  mine: m.mine,
                  /* The school's side of the paper is the right. A colleague's
                     reply from the desk sits with the teacher's own, not with
                     the family's -- the family is the other party here. */
                  right: m.sender_side ? m.sender_side !== 'parent' : m.mine,
                  read_at: m.read_at,
                  sender: `${m.sender_name}${m.sender_side ? ` · ${m.sender_side}` : ''}`,
                  attachments: m.attachments,
                  reply_to_id: m.reply_to_id,
                  reply_body: m.reply_body,
                  reply_sender: m.reply_sender,
                  edited: m.edited,
                  deleted: m.deleted,
                }))}
                hasMore={!!(parentMessages.data as { has_more?: boolean } | undefined)?.has_more || olderParent.length > 0}
                loadingOlder={loadingOlder}
                onLoadOlder={() => void loadOlder('parent')}
                onSeen={seenParent}
                onEdit={editMessage('parent')}
                onUnsend={unsendMessage('parent')}
                showSender
                loading={parentMessages.isLoading}
                empty="Nothing yet in this conversation."
                canSend={openParent?.teacher_user_id === me || !openParent?.teacher_user_id}
                cannotSendNote={
                  <>
                    Reading {openParent?.teacher_name ?? 'a teacher'}&rsquo;s conversation with this
                    family. Replies come from the teacher it was addressed to.
                  </>
                }
                onSend={(m) => replyToParent.mutate(m)}
                sending={replyToParent.isPending}
                error={replyToParent.error}
                placeholder={`Reply to ${openParent?.parent_name ?? 'them'}`}
                height="min-h-0"
              />
            </ChatScreen>
          </div>
        ) : (
        <div className="grid gap-4">
          <Card className="min-w-0">
            <CardHeader title="Staff" description={`${all.length} colleagues`} />
            <div className="space-y-2 px-4 pb-3 pt-3">
              <Input value={find} onChange={setFind} placeholder="Find a name" />
              <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={unreadOnly}
                  onChange={(e) => setUnreadOnly(e.target.checked)}
                  className="h-4 w-4"
                />
                Unread only{staffUnread > 0 ? ` (${staffUnread})` : ''}
              </label>
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
                    <span className="flex items-start gap-3">
                    <PersonAvatar name={t.full_name} photoId={t.photo} size={44} />
                    <span className="min-w-0 flex-1">
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
                    </span>
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

          <ChatScreen
            open={!!openWith}
            title={open?.full_name ?? 'Conversation'}
            subtitle={open?.designation ?? undefined}
            photoId={open?.photo}
            onBack={() => setOpenWith('')}
          >
            <ChatThread
              live={openWith ? { scope: 'staff', peer: openWith } : undefined}
              messages={[...olderStaff, ...(messages.data?.items ?? [])].map((m) => ({
                id: m.id,
                body: m.body,
                at: m.sent_at,
                mine: m.mine,
                read_at: m.read_at,
                sender: m.sender_name,
                attachments: m.attachments,
                reply_to_id: m.reply_to_id,
                reply_body: m.reply_body,
                reply_sender: m.reply_sender,
                edited: m.edited,
                deleted: m.deleted,
              }))}
              hasMore={!!(messages.data as { has_more?: boolean } | undefined)?.has_more || olderStaff.length > 0}
              loadingOlder={loadingOlder}
              onLoadOlder={() => void loadOlder('staff')}
              onSeen={seenStaff}
              onEdit={editMessage('staff')}
              onUnsend={unsendMessage('staff')}
              loading={messages.isLoading}
              empty={`Nothing yet. What you write here goes to ${open?.full_name ?? 'them'} alone.`}
              onSend={(m) => send.mutate(m)}
              sending={send.isPending}
              error={send.error}
              placeholder={`Write to ${open?.full_name ?? 'them'}`}
              height="min-h-0"
            />
          </ChatScreen>
        </div>
        )}
      </PageBody>
    </>
  )
}
