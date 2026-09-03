import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessagesSquare, Lightbulb, EyeOff } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button,
  Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface Thread {
  id: string
  title: string
  body: string
  homework_title?: string
  homework_id?: string
  subject?: string
  author_name: string
  status: string
  opened_by_me: boolean
  reply_count: number
  withheld_count: number
  opened_at: string
  due_on?: string
  removal_reason?: string
  section?: string
  last_reply_at?: string
}
interface Post {
  id: string
  kind: string
  body: string
  author_name: string
  from_staff: boolean
  written_by_me: boolean
  at: string
  withheld: boolean
  removal_reason?: string
}
interface ThreadDetail {
  thread: Thread
  posts: Post[]
}

const KIND_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  question: 'info',
  hint: 'success',
  solution: 'warning',
}

/* Asking a classmate, without it becoming a place to copy the answer.

   The distinction the whole feature turns on is between asking about a problem
   and posting the finished solution, and it is a choice the person replying
   makes explicitly. A hint goes up at once. An answer marked as an answer is
   held back from everyone but its author until the due date has passed —
   visible to the teacher throughout, so a thread quietly filling with worked
   solutions is something they can see rather than something they find out
   about at marking.

   That is not a claim the software can detect a mislabelled answer. It cannot.
   What it does is make the honest label the one that gets your help read
   today, and leave the rest to the teacher who can see the thread. */
export default function HomeworkForum() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)

  const [open, setOpen] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [homeworkId, setHomeworkId] = useState('')
  const [replyKind, setReplyKind] = useState('hint')
  const [reply, setReply] = useState('')

  const threads = useQuery({
    queryKey: ['forum-threads', studentId],
    queryFn: () =>
      api.get<List<Thread>>(`/api/v1/portal/homework/forum/threads${studentQuery(studentId)}`),
    enabled: ready,
  })

  const detail = useQuery({
    queryKey: ['forum-thread', open],
    queryFn: () => api.get<ThreadDetail>(`/api/v1/portal/homework/forum/threads/${open}`),
    enabled: !!open,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['forum-threads'] })
    qc.invalidateQueries({ queryKey: ['forum-thread'] })
  }

  const ask = useMutation({
    mutationFn: () =>
      api.post('/api/v1/portal/homework/forum/threads', {
        student_id: studentId || undefined,
        homework_id: homeworkId,
        title,
        body,
      }),
    onSuccess: () => {
      setTitle('')
      setBody('')
      refresh()
    },
  })

  const answer = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/portal/homework/forum/threads/${open}/posts`, {
        student_id: studentId || undefined,
        kind: replyKind,
        body: reply,
      }),
    onSuccess: () => {
      setReply('')
      refresh()
    },
  })

  const close = useMutation({
    mutationFn: () => api.post(`/api/v1/portal/homework/forum/threads/${open}/resolve`),
    onSuccess: refresh,
  })

  if (threads.isLoading && ready) return <SkeletonTiles count={3} label="Reading the forum…" />
  if (threads.error) return <ErrorState error={threads.error} />

  const rows = threads.data?.items ?? []
  const openThreads = rows.filter((t) => t.status === 'open')
  const withheld = rows.reduce((n, t) => n + t.withheld_count, 0)

  return (
    <>
      <PageHead
        eyebrow="Homework"
        title="Help from your class"
        description="Ask about a problem you are stuck on. Your teacher can see these."
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState title="Choose a child" body="The forum is your own class's." />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Questions open" value={openThreads.length} icon={MessagesSquare} />
              <Stat
                label="Answers held back"
                value={withheld}
                icon={EyeOff}
                hint="Shown once the work is due"
              />
              <Stat label="Yours" value={rows.filter((t) => t.opened_by_me).length} icon={Lightbulb} />
            </CellGrid>

            <Card>
              <CardHeader
                title="Ask something"
                description="Say what you tried, not just what the question is."
              />
              <div className="space-y-5 p-5">
                <FormGrid>
                  <Field label="Which homework" required hint="The homework id from your work list.">
                    <Input value={homeworkId} onChange={setHomeworkId} placeholder="homework id" />
                  </Field>
                  <Field label="In one line" required>
                    <Input value={title} onChange={setTitle} placeholder="Stuck on question 7" />
                  </Field>
                  <Field label="What is the problem" wide required>
                    <Textarea
                      value={body}
                      onChange={setBody}
                      rows={3}
                      placeholder="I get 42 but the back of the book says 24, and I think I am dividing in the wrong order."
                    />
                  </Field>
                </FormGrid>
                <FormNotice error={ask.error} ok={ask.isSuccess ? 'Posted.' : undefined} />
                <Button
                  onClick={() => ask.mutate()}
                  disabled={!homeworkId.trim() || !title.trim() || !body.trim() || ask.isPending}
                >
                  {ask.isPending ? 'Posting…' : 'Ask'}
                </Button>
              </div>
            </Card>

            <Card>
              <CardHeader title="Questions" description="Open ones first." />
              {rows.length === 0 ? (
                <EmptyState title="Nothing asked yet" body="Nobody in your class has asked anything." />
              ) : (
                <ul className="divide-y">
                  {rows.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                      <div className="min-w-0">
                        <p className="text-[14px] font-medium">
                          {t.title}
                          {t.status !== 'open' && <Badge tone="neutral">{t.status}</Badge>}
                          {t.withheld_count > 0 && (
                            <Badge tone="warning">{t.withheld_count} held back</Badge>
                          )}
                        </p>
                        <p className="mt-1 text-[12.5px] text-muted-foreground">
                          {t.homework_title ?? t.subject ?? '—'} · {t.opened_by_me ? 'you' : t.author_name}
                          {' · '}
                          {t.reply_count} {t.reply_count === 1 ? 'reply' : 'replies'}
                          {t.due_on ? ` · due ${formatDate(t.due_on)}` : ''}
                        </p>
                        {t.removal_reason && (
                          <p className="mt-1 text-[12.5px] text-muted-foreground">
                            Taken down: {t.removal_reason}
                          </p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant={open === t.id ? 'primary' : 'secondary'}
                        onClick={() => setOpen(open === t.id ? '' : t.id)}
                      >
                        {open === t.id ? 'Open' : 'Read'}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {open && (
              <Card>
                <CardHeader
                  title={detail.data?.thread.title ?? 'Thread'}
                  description={detail.data?.thread.body}
                  action={
                    detail.data?.thread.opened_by_me && detail.data.thread.status === 'open' ? (
                      <Button size="sm" variant="secondary" onClick={() => close.mutate()}>
                        Mark sorted
                      </Button>
                    ) : undefined
                  }
                />
                {detail.isLoading ? (
                  <Loading label="Reading replies…" />
                ) : (
                  <ul className="divide-y">
                    {(detail.data?.posts ?? []).map((p) => (
                      <li key={p.id} className="px-5 py-4">
                        <p className="text-[13px] font-medium">
                          {p.written_by_me ? 'You' : p.author_name}
                          {p.from_staff && <Badge tone="info">teacher</Badge>}
                          <Badge tone={KIND_TONE[p.kind] ?? 'neutral'}>{p.kind}</Badge>
                        </p>
                        {p.withheld ? (
                          <p className="mt-1 text-[13px] text-muted-foreground">
                            An answer is waiting here until the work is due.
                          </p>
                        ) : (
                          <p className="mt-1 text-[13px]">{p.body}</p>
                        )}
                        <p className="mt-1 text-[12.5px] text-muted-foreground">{p.at}</p>
                      </li>
                    ))}
                    {(detail.data?.posts ?? []).length === 0 && (
                      <li className="px-5 py-4">
                        <EmptyState title="No replies yet" body="Be the one who helps." />
                      </li>
                    )}
                  </ul>
                )}
                <div className="space-y-5 border-t p-5">
                  <FormGrid>
                    <Field
                      label="What kind of reply"
                      hint="A hint goes up now. An answer waits until the work is due."
                    >
                      <Select
                        value={replyKind}
                        onChange={setReplyKind}
                        options={[
                          { value: 'hint', label: 'A hint or a nudge' },
                          { value: 'question', label: 'Asking something back' },
                          { value: 'solution', label: 'The worked answer' },
                        ]}
                      />
                    </Field>
                    <Field label="Your reply" wide required>
                      <Textarea
                        value={reply}
                        onChange={setReply}
                        rows={3}
                        placeholder="Check what order you did the brackets in — that is where I went wrong too."
                      />
                    </Field>
                  </FormGrid>
                  <FormNotice
                    error={answer.error ?? close.error}
                    ok={answer.isSuccess ? 'Posted.' : undefined}
                  />
                  <Button
                    onClick={() => answer.mutate()}
                    disabled={!reply.trim() || answer.isPending}
                  >
                    {answer.isPending ? 'Posting…' : 'Reply'}
                  </Button>
                </div>
              </Card>
            )}
          </>
        )}
      </PageBody>
    </>
  )
}
