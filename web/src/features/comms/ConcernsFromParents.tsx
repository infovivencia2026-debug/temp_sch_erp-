import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { PageHead, PageBody, Card, Badge, Button, Input, FormNotice, ErrorState, EmptyState, SkeletonTiles } from '@/components/ui'

/* Concerns the front desk passed to this teacher (owner, 2026-10-20). Mark
   one resolved with what was done; the front desk then tells the parent. */

interface Row {
  id: string; subject: string; body: string; created_at: string; status: string
  student: string | null; class: string | null; desk_note: string | null; my_note: string | null
}
const when = (s: string) => new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })

export default function ConcernsFromParents() {
  const q = useQuery({ queryKey: ['concerns-from-parents'], queryFn: () => api.get<{ items: Row[] }>('/api/v1/teaching/parent-concerns') })
  return (
    <>
      <PageHead eyebrow="Communication" title="Concerns from parents" />
      <PageBody>
        {q.isLoading ? <SkeletonTiles /> : q.error ? <ErrorState error={q.error} /> : !q.data?.items.length ? (
          <EmptyState title="No concerns" body="Concerns the front desk sends you appear here." />
        ) : (
          <div className="space-y-3">{q.data.items.map((r) => <Item key={r.id} r={r} />)}</div>
        )}
      </PageBody>
    </>
  )
}

function Item({ r }: { r: Row }) {
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const done = useMutation({
    mutationFn: () => api.post(`/api/v1/teaching/parent-concerns/${r.id}/resolved`, { note }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['concerns-from-parents'] }),
  })
  const told = ['resolved', 'closed'].includes(r.status)
  return (
    <Card>
      <div className="space-y-2 p-[var(--card-pad)] text-[14px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold">{r.subject}</span>
          {told ? <Badge tone="success">Parent told</Badge> : r.my_note ? <Badge tone="warning">You resolved it</Badge> : <Badge tone="danger">Open</Badge>}
        </div>
        <div className="text-muted-foreground">{r.student ?? '—'}{r.class ? ` · ${r.class}` : ''} · {when(r.created_at)}</div>
        <div className="whitespace-pre-wrap">{r.body}</div>
        {r.desk_note && <div className="text-muted-foreground">Front desk: {r.desk_note}</div>}
        {r.my_note && <div className="rounded-md bg-muted p-3"><span className="font-medium">You: </span>{r.my_note}</div>}
        {!told && !r.my_note && (
          <div className="space-y-2 pt-1">
            <Input value={note} onChange={setNote} placeholder="What was done" />
            <FormNotice error={done.error} />
            <Button size="sm" disabled={!note.trim() || done.isPending} onClick={() => done.mutate()}>Resolved</Button>
          </div>
        )}
      </div>
    </Card>
  )
}
