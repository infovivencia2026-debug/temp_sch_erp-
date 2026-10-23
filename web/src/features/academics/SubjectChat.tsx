import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Card, Button, Textarea, Select, FormNotice, EmptyState, SkeletonTiles, Badge } from '@/components/ui'

/* One subject's group chat: its head and every teacher under them (owner,
   2026-10-19). The principal reads every thread but does not write in it.
   Refreshed every 15 seconds while open. */

interface Msg { id: string; body: string; sent_at: string; sender_user_id: string; sender: string; is_head: number | null }
interface Thread { id: string; name: string; read_only: boolean }

const when = (s: string) => new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

/** Every subject chat this person is in, with a picker when there is more than one. */
export default function SubjectChat({ subjectId }: { subjectId?: string }) {
  const threads = useQuery({ queryKey: ['subject-chat-mine'], queryFn: () => api.get<{ items: Thread[] }>('/api/v1/teaching/subject-chat/mine') })
  const [pick, setPick] = useState('')
  const list = threads.data?.items ?? []
  // On one subject's page, only that subject's thread; never fall back to another.
  const current = subjectId ? list.find((t) => t.id === subjectId) : list.find((t) => t.id === pick) ?? list[0]
  if (threads.isLoading) return <SkeletonTiles />
  if (!current) return <EmptyState title="No group chat yet" body="A subject's chat opens once the principal picks its head." />
  return (
    <div className="space-y-3">
      {!subjectId && list.length > 1 && (
        <div className="w-72"><Select value={current.id} onChange={setPick} options={list.map((t) => ({ value: t.id, label: t.name }))} /></div>
      )}
      <Thread subjectId={current.id} readOnly={current.read_only} name={current.name} />
    </div>
  )
}

function Thread({ subjectId, readOnly, name }: { subjectId: string; readOnly: boolean; name: string }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['subject-chat', subjectId],
    queryFn: () => api.get<{ items: Msg[]; me: string }>(`/api/v1/teaching/subject-chat?subject=${subjectId}`),
    refetchInterval: 15_000,
  })
  const [text, setText] = useState('')
  const send = useMutation({
    mutationFn: () => api.post('/api/v1/teaching/subject-chat', { subject_id: subjectId, body: text }),
    onSuccess: () => { setText(''); qc.invalidateQueries({ queryKey: ['subject-chat', subjectId] }) },
  })
  const end = useRef<HTMLDivElement>(null)
  const count = q.data?.items.length ?? 0
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }) }, [count])
  const me = q.data?.me
  return (
    <Card>
      <div className="flex items-center gap-2 border-b px-[var(--card-pad)] py-3">
        <span className="text-[15px] font-semibold">{name} group</span>
        {readOnly && <Badge>Reading only</Badge>}
      </div>
      <div className="max-h-[55vh] min-h-[12rem] space-y-2 overflow-y-auto p-[var(--card-pad)]">
        {q.isLoading ? <SkeletonTiles /> : !count ? (
          <div className="py-8 text-center text-[14px] text-muted-foreground">No messages yet.</div>
        ) : q.data!.items.map((m) => {
          const mine = m.sender_user_id === me
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-[14px] ${mine ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                {!mine && <div className="text-[12.5px] font-semibold">{m.sender}{m.is_head ? ' · Head' : ''}</div>}
                <div className="whitespace-pre-wrap break-words">{m.body}</div>
                <div className={`mt-0.5 text-[11.5px] ${mine ? 'text-primary-foreground/75' : 'text-muted-foreground'}`}>{when(m.sent_at)}</div>
              </div>
            </div>
          )
        })}
        <div ref={end} />
      </div>
      {!readOnly && (
        <div className="space-y-2 border-t p-[var(--card-pad)]">
          <Textarea value={text} onChange={setText} rows={2} placeholder="Write to the group" onSubmit={() => text.trim() && send.mutate()} />
          <FormNotice error={send.error} />
          <Button disabled={!text.trim() || send.isPending} onClick={() => send.mutate()}>{send.isPending ? 'Sending…' : 'Send'}</Button>
        </div>
      )}
    </Card>
  )
}
