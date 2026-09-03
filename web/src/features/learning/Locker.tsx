import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, KeyRound, History } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, FormNotice, SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface AccessEvent {
  action: string
  happened_at: string
  actor?: string
  note?: string
}
interface LockerResponse {
  student_id: string
  assigned: boolean
  locker_id?: string
  locker_no?: string
  location?: string
  assigned_on?: string
  has_combination: boolean
  access_log: AccessEvent[]
}
interface Revealed {
  locker_no: string
  combination?: string
}

const ACTION_LABEL: Record<string, string> = {
  opened: 'Opened',
  closed: 'Shut',
  combination_viewed: 'Combination read',
  reported_jammed: 'Reported jammed',
  reported_tampered: 'Reported tampered with',
}
const ACTION_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'danger'> = {
  opened: 'info',
  closed: 'neutral',
  combination_viewed: 'warning',
  reported_jammed: 'warning',
  reported_tampered: 'danger',
}

/* The locker, and the record of who has been into it.

   The combination is never in the page until it is asked for, and asking
   writes a line in the log below. That is the whole point: a locker forced
   open is discovered eventually, but a combination quietly looked up leaves no
   trace at all unless the looking is itself the event.

   It is also cleared from the screen as soon as the child navigates away —
   there is nowhere for it to be cached, because the response is not part of
   the locker query. */
export default function Locker() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)
  const [shown, setShown] = useState<string | null>(null)

  const locker = useQuery({
    queryKey: ['locker', studentId],
    queryFn: () => api.get<LockerResponse>(`/api/v1/portal/campus/locker${studentQuery(studentId)}`),
    enabled: ready,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['locker'] })

  const reveal = useMutation({
    mutationFn: () =>
      api.post<Revealed>('/api/v1/portal/campus/locker/reveal', {
        student_id: studentId || undefined,
      }),
    onSuccess: (data) => {
      setShown(data.combination ?? null)
      refresh()
    },
  })

  const log = useMutation({
    mutationFn: (action: string) =>
      api.post('/api/v1/portal/campus/locker/access', {
        student_id: studentId || undefined,
        action,
      }),
    onSuccess: refresh,
  })

  if (locker.isLoading && ready) return <SkeletonTiles count={3} label="Looking up your locker…" />
  if (locker.error) return <ErrorState error={locker.error} />

  const l = locker.data
  const events = l?.access_log ?? []
  const views = events.filter((e) => e.action === 'combination_viewed').length

  return (
    <>
      <PageHead
        eyebrow="Campus life"
        title="Digital locker"
        description="Your locker, its combination, and every time it has been opened."
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState title="Choose a child" body="Lockers are allotted to one child each." />
        ) : !l?.assigned ? (
          <EmptyState
            title="No locker allotted"
            body="The school has not given you a locker yet. Ask the office if you think you should have one."
          />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Locker" value={l.locker_no ?? '—'} icon={Lock}
                hint={l.location ?? undefined} />
              <Stat label="Times opened" value={events.filter((e) => e.action === 'opened').length}
                icon={History} />
              <Stat
                label="Combination read"
                value={views}
                icon={KeyRound}
                hint="Every look is logged below"
              />
            </CellGrid>

            <Card>
              <CardHeader
                title="Combination"
                description="Asking for it puts a line in the log. That is deliberate — it is what makes the log worth reading."
              />
              <div className="space-y-4 p-5">
                {shown ? (
                  <p className="font-mono text-[28px] font-semibold tracking-[0.15em]">{shown}</p>
                ) : (
                  <p className="text-[14px] text-muted-foreground">
                    {l.has_combination
                      ? 'Hidden until you ask.'
                      : 'The school has not recorded a combination for this locker.'}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => reveal.mutate()}
                    disabled={!l.has_combination || reveal.isPending}>
                    {reveal.isPending ? 'Fetching…' : 'Show me the combination'}
                  </Button>
                  {shown && (
                    <Button variant="secondary" onClick={() => setShown(null)}>
                      Hide it again
                    </Button>
                  )}
                </div>
                <FormNotice error={reveal.error} />
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Tell the school"
                description="Log an opening as you use it, or report a problem so the office knows before you do."
              />
              <div className="flex flex-wrap gap-2 p-5">
                <Button size="sm" variant="secondary" disabled={log.isPending}
                  onClick={() => log.mutate('opened')}>
                  I have opened it
                </Button>
                <Button size="sm" variant="secondary" disabled={log.isPending}
                  onClick={() => log.mutate('closed')}>
                  I have shut it
                </Button>
                <Button size="sm" variant="secondary" tone="danger" disabled={log.isPending}
                  onClick={() => log.mutate('reported_jammed')}>
                  It is jammed
                </Button>
                <Button size="sm" variant="secondary" tone="danger" disabled={log.isPending}
                  onClick={() => log.mutate('reported_tampered')}>
                  Somebody has been in it
                </Button>
              </div>
              <div className="border-t px-5 py-3">
                <FormNotice error={log.error} />
              </div>
            </Card>

            <Card>
              <CardHeader title="Access log" description="Most recent first, last hundred events." />
              <Table
                head={['When', 'What happened', 'Who', 'Note']}
                empty={events.length === 0}
                emptyLabel="Nothing recorded against this locker yet."
              >
                {events.map((e, i) => (
                  <tr key={`${e.happened_at}-${i}`}>
                    <Td className="font-mono text-[13px] tabular-nums text-muted-foreground">
                      {e.happened_at.replace('T', ' ')}
                    </Td>
                    <Td>
                      <Badge tone={ACTION_TONE[e.action] ?? 'neutral'}>
                        {ACTION_LABEL[e.action] ?? e.action}
                      </Badge>
                    </Td>
                    <Td>{e.actor ?? <span className="text-muted-foreground">—</span>}</Td>
                    <Td className="text-[13px] text-muted-foreground">{e.note ?? '—'}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
