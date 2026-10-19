import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { PageHead, PageBody, Card, Badge, Button, Input, FormNotice, ErrorState, EmptyState, SkeletonTiles } from '@/components/ui'

/* The teacher's side of a subject head's meetings (owner, 2026-10-19):
   when, where and what about, and an answer -- attending, or can't come
   with the reason. Answers can be changed until the meeting. */

interface Meeting {
  id: string; title: string; agenda: string | null; meets_at: string; place: string | null; minutes: string | null
  subject: string; by_name: string | null; reply: 'yes' | 'no' | null; note: string | null
}

const when = (s: string) => new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })

export default function SubjectMeetings() {
  const q = useQuery({ queryKey: ['subject-meetings'], queryFn: () => api.get<{ items: Meeting[] }>('/api/v1/teaching/subject-meetings') })
  return (
    <>
      <PageHead eyebrow="Academics" title="Subject meetings" />
      <PageBody>
        {q.isLoading ? <SkeletonTiles /> : q.error ? <ErrorState error={q.error} /> : !q.data?.items.length ? (
          <EmptyState title="No meetings" body="Meetings your subject head calls will appear here." />
        ) : (
          <div className="space-y-3">{q.data.items.map((m) => <MeetingCard key={m.id} m={m} />)}</div>
        )}
      </PageBody>
    </>
  )
}

function MeetingCard({ m }: { m: Meeting }) {
  const qc = useQueryClient()
  const [note, setNote] = useState(m.note ?? '')
  const [asking, setAsking] = useState(false)
  const past = new Date(m.meets_at).getTime() < Date.now()
  const send = useMutation({
    mutationFn: (reply: 'yes' | 'no') => api.post(`/api/v1/teaching/subject-meetings/${m.id}/reply`, { reply, note }),
    onSuccess: () => { setAsking(false); qc.invalidateQueries({ queryKey: ['subject-meetings'] }) },
  })
  return (
    <Card>
      <div className="space-y-2 p-[var(--card-pad)]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold">{m.title}</span>
          <Badge>{m.subject}</Badge>
          {m.reply === 'yes' && <Badge tone="success">You're attending</Badge>}
          {m.reply === 'no' && <Badge tone="danger">You can't come</Badge>}
        </div>
        <div className="text-[14px] text-muted-foreground">
          {when(m.meets_at)}{m.place ? ` · ${m.place}` : ''}{m.by_name ? ` · called by ${m.by_name}` : ''}
        </div>
        {m.agenda && <div className="whitespace-pre-line text-[14px]">{m.agenda}</div>}
        {m.minutes && <div className="rounded-md bg-muted p-3 text-[14px]"><span className="font-medium">Minutes: </span><span className="whitespace-pre-line">{m.minutes}</span></div>}
        {!past && (
          <div className="space-y-2 pt-1">
            {asking && <Input value={note} onChange={setNote} placeholder="Why you can't come" autoFocus />}
            <FormNotice error={send.error} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={send.isPending} onClick={() => send.mutate('yes')}>Attending</Button>
              {asking
                ? <Button size="sm" variant="secondary" disabled={send.isPending || !note.trim()} onClick={() => send.mutate('no')}>Send: can't come</Button>
                : <Button size="sm" variant="secondary" onClick={() => setAsking(true)}>Can't come</Button>}
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
