import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, Pin, PinOff, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, PageBody, PageHead } from '@/components/ui'
import StatusRings, { ViewsSheet } from './status/StatusRings'
import StatusComposer, { StatusFileInput } from './status/StatusComposer'
import { hoursLeft, type MyPost } from './status/status-api'

/* Class Status, the teacher's screen (faculty.communication.class_status):
   the rings as everyone sees them, a + to post, and "My posts" -- each with
   its audience, how many have seen it (and who), and pin or delete.
   Reads /api/v1/status/* (worker/src/routes/comms/class_status.ts). */

export function PostThumb({ p }: { p: Pick<MyPost, 'media_kind' | 'url' | 'status'> }) {
  if (p.status === 'rejected') return <div className="size-14 shrink-0 rounded-md bg-muted" />
  return p.media_kind === 'video'
    ? <video src={p.url} className="size-14 shrink-0 rounded-md bg-black object-cover" muted playsInline preload="metadata" />
    : <img src={p.url} alt="" className="size-14 shrink-0 rounded-md bg-muted object-cover" loading="lazy" />
}

export default function ClassStatus() {
  const qc = useQueryClient()
  const [compose, setCompose] = useState<File | null | undefined>(undefined)
  const [views, setViews] = useState<string | null>(null)
  const mine = useQuery({ queryKey: ['class-status-mine'], queryFn: () => api.get<{ items: MyPost[] }>('/api/v1/status/mine') })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['class-status-mine'] })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }
  const pin = useMutation({ mutationFn: (p: MyPost) => api.post(`/api/v1/status/posts/${p.id}/pin`, { pinned: !p.pinned }), onSuccess: refresh })
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/v1/status/posts/${id}`), onSuccess: refresh })

  return (
    <>
      <PageHead eyebrow="Communication" title="Class Status" actions={
        <StatusFileInput onPick={(f) => setCompose(f)} label="New status" className="btn inline-flex h-10 items-center gap-1.5 rounded-sm px-3" >
          <Plus className="size-4" /> New status
        </StatusFileInput>
      } />
      <PageBody>
        <StatusRings />
        <Card>
          <CardHeader title="My posts" description="Live for 24 hours from when they went live. Pinned posts stay in the class gallery." />
          {mine.isError ? <ErrorState error={mine.error} /> : !mine.data ? null : mine.data.items.length === 0 ? (
            <EmptyState title="Nothing posted yet" body="Take a photo of today's class and share it with the families." />
          ) : (
            <ul className="divide-y">
              {mine.data.items.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-5 py-3">
                  <PostThumb p={p} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.caption || (p.media_kind === 'video' ? 'Video' : 'Photo')}</div>
                    <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                      <span>{p.audience}</span>
                      {p.status === 'pending' && <Badge tone="warning">Waiting for approval</Badge>}
                      {p.status === 'rejected' && <Badge tone="danger">Not approved</Badge>}
                      {p.status === 'live' && <span>{p.pinned ? 'Pinned' : hoursLeft(p.expires_at)}</span>}
                    </div>
                  </div>
                  {p.status === 'live' && (
                    <Button variant="ghost" size="sm" onClick={() => setViews(p.id)} title="Seen by"><Eye className="size-4" /> {p.views}</Button>
                  )}
                  {p.status === 'live' && (
                    <Button variant="ghost" size="sm" onClick={() => pin.mutate(p)} title={p.pinned ? 'Unpin' : 'Pin to the class gallery'}>
                      {p.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => del.mutate(p.id)} title="Delete"><Trash2 className="size-4" /></Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageBody>
      {compose !== undefined && <StatusComposer file={compose} onClose={() => { setCompose(undefined); refresh() }} />}
      {views && <ViewsSheet postId={views} onClose={() => setViews(null)} />}
    </>
  )
}
