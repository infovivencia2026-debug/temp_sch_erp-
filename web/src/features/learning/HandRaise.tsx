import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Hand, Video, CheckCheck } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button,
  Field, FormNotice, Input,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface LiveClass {
  id: string
  topic: string
  subject?: string
  scheduled_at: string
  duration_minutes: number
  status: string
  join_url?: string
  teacher?: string
  hand_up: boolean
  my_raises: number
  my_times_called: number
}
interface Raise {
  id: string
  student_id: string
  student_name: string
  raised_at: string
  waiting_seconds: number
  answered_at?: string
  lowered_at?: string
  note?: string
}

const STATUS_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  live: 'success',
  scheduled: 'info',
  ended: 'neutral',
  cancelled: 'danger',
  provider_pending: 'warning',
}

/* Putting your hand up in a live lesson, and the record of what happened next.

   There is no video here. The school's meeting runs wherever the launcher
   scheduled it; this is the register beside it — who put a hand up, when, and
   whether anybody called on them.

   The column that matters is the last one. A hand that is taken down again and
   a hand that was never picked look identical if both simply disappear, and a
   teacher who believes they call on everybody is usually right about the
   children they can remember. Keeping the two apart is the only reason the
   record is worth having, and it is why a child can see their own tally: nine
   raises and one answer is a fact worth being able to point at. */
export default function HandRaise() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)

  const [note, setNote] = useState('')

  const classes = useQuery({
    queryKey: ['live-classes', studentId],
    queryFn: () => api.get<List<LiveClass>>(`/api/v1/portal/live-classes${studentQuery(studentId)}`),
    enabled: ready,
  })

  const history = useQuery({
    queryKey: ['hand-history', studentId],
    queryFn: () =>
      api.get<List<Raise>>(`/api/v1/portal/live-classes/my-engagement${studentQuery(studentId)}`),
    enabled: ready,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['live-classes'] })
    qc.invalidateQueries({ queryKey: ['hand-history'] })
  }

  const raise = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/portal/live-classes/${id}/hand`, {
        student_id: studentId || undefined,
        note: note || undefined,
      }),
    onSuccess: () => {
      setNote('')
      refresh()
    },
  })

  const lower = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/portal/live-classes/${id}/hand/lower`, {
        student_id: studentId || undefined,
      }),
    onSuccess: refresh,
  })

  if (classes.isLoading && ready) return <Loading label="Reading your classes…" />
  if (classes.error) return <ErrorState error={classes.error} />

  const rows = classes.data?.items ?? []
  const live = rows.filter((c) => c.status === 'live')
  const raises = history.data?.items ?? []
  const called = raises.filter((h) => h.answered_at).length
  const ignored = raises.filter((h) => !h.answered_at && !h.lowered_at).length

  return (
    <>
      <PageHead
        eyebrow="Learning"
        title="Live classes"
        description="Put your hand up, and see how often it was picked."
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState title="Choose a child" body="Hands go up in a child's own name." />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Live now" value={live.length} icon={Video} />
              <Stat label="Hands you have put up" value={raises.length} icon={Hand} />
              <Stat
                label="Times you were called on"
                value={called}
                icon={CheckCheck}
                hint={ignored > 0 ? `${ignored} were never picked` : undefined}
              />
            </CellGrid>

            <Card>
              <CardHeader
                title="Your classes"
                description="Only a class that is running will take a hand."
                action={
                  <div className="w-64">
                    <Field label="Say what you want to ask" hint="Optional; helps the teacher order the queue.">
                      <Input value={note} onChange={setNote} placeholder="About question 4" />
                    </Field>
                  </div>
                }
              />
              {rows.length === 0 ? (
                <EmptyState title="No live classes" body="Nothing has been scheduled for your section." />
              ) : (
                <ul className="divide-y">
                  {rows.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                      <div className="min-w-0">
                        <p className="text-[14px] font-medium">
                          {c.topic}
                          <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{c.status}</Badge>
                          {c.hand_up && <Badge tone="warning">your hand is up</Badge>}
                        </p>
                        <p className="mt-1 text-[12.5px] text-muted-foreground">
                          {c.subject ? `${c.subject} · ` : ''}
                          {c.scheduled_at.replace('T', ' ')} · {c.duration_minutes} min
                          {c.teacher ? ` · ${c.teacher}` : ''}
                          {c.my_raises > 0
                            ? ` · you raised ${c.my_raises}, called on ${c.my_times_called}`
                            : ''}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {c.join_url && c.status === 'live' && (
                          <a
                            href={c.join_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[13px] underline"
                          >
                            Join
                          </a>
                        )}
                        {c.status === 'live' &&
                          (c.hand_up ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={lower.isPending}
                              onClick={() => lower.mutate(c.id)}
                            >
                              Take it down
                            </Button>
                          ) : (
                            <Button size="sm" disabled={raise.isPending} onClick={() => raise.mutate(c.id)}>
                              Put my hand up
                            </Button>
                          ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t px-5 py-3">
                <FormNotice error={raise.error ?? lower.error} />
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Every hand you have put up"
                description="Including the ones nobody picked."
              />
              {history.isLoading ? (
                <Loading label="Reading your record…" />
              ) : raises.length === 0 ? (
                <EmptyState title="No hands yet" body="Put one up in your next live lesson." />
              ) : (
                <ul className="divide-y">
                  {raises.map((h) => (
                    <li key={h.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                      <div className="min-w-0">
                        <p className="text-[14px]">
                          {h.student_name}
                          {h.answered_at ? (
                            <Badge tone="success">called on</Badge>
                          ) : h.lowered_at ? (
                            <Badge tone="neutral">you took it down</Badge>
                          ) : (
                            <Badge tone="warning">never picked</Badge>
                          )}
                        </p>
                        <p className="mt-1 text-[12.5px] text-muted-foreground">
                          {h.raised_at.replace('T', ' ')} · waited {Math.round(h.waiting_seconds / 60)} min
                          {h.note ? ` · ${h.note}` : ''}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
