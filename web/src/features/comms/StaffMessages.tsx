import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Send } from 'lucide-react'
import { api, type List } from '@/lib/api'
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
  sender_name: string
}

export default function StaffMessages() {
  const qc = useQueryClient()
  const [openWith, setOpenWith] = useState('')
  const [find, setFind] = useState('')
  const [draft, setDraft] = useState('')

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
  const unreadTotal = all.reduce((n, t) => n + t.unread, 0)

  return (
    <>
      <PageHead
        eyebrow="Communication"
        title="Direct messages"
        description="One colleague at a time. For something the whole school needs, write a circular instead."
        actions={
          unreadTotal > 0 && <Badge tone="primary">{unreadTotal} unread</Badge>
        }
      />
      <PageBody>
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
                          {m.sent_at.replace('T', ' ')}
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
                    placeholder={`Write to ${open?.full_name ?? 'them'}`}
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
      </PageBody>
    </>
  )
}
