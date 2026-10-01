import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, Image as ImageIcon, Pin, PinOff, Play, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useOptimisticMutation, useUndoableDelete } from '@/lib/optimistic'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, PageBody, PageHead } from '@/components/ui'
import StatusRings, { ViewsSheet } from './status/StatusRings'
import StatusComposer, { StatusFileInput } from './status/StatusComposer'
import { hoursLeft, type MyPost } from './status/status-api'

/* Class Status, the teacher's screen (faculty.communication.class_status):
   the rings as everyone sees them, a + to post, and "My posts" -- each with
   its audience, how many have seen it (and who), and pin or delete.
   Reads /api/v1/status/* (worker/src/routes/comms/class_status.ts). */

/* The small picture beside a post in a list. The thumbnail the poster's
   browser drew (a few KB), never the full photo or the video itself: this
   used to load a 1600px picture, or start a video, to fill 56 pixels, once
   per row. A text status has no picture and gets its own tile; so does a
   post with no thumbnail. */
export function PostThumb({ p }: { p: Pick<MyPost, 'media_kind' | 'url' | 'status' | 'thumb' | 'caption'> }) {
  const box = 'grid size-14 shrink-0 place-items-center overflow-hidden rounded-md'
  if (p.status === 'rejected') return <div className={cn(box, 'bg-muted')} />
  if (p.media_kind === 'text') {
    return <div className={cn(box, 'bg-primary p-1 text-center text-[9px] font-semibold leading-tight text-primary-foreground')} aria-hidden><span className="line-clamp-3">{p.caption || 'Aa'}</span></div>
  }
  if (p.thumb) return <img src={p.thumb} alt="" className={cn(box, 'bg-muted object-cover')} loading="lazy" decoding="async" />
  return (
    <div className={cn(box, p.media_kind === 'video' ? 'bg-black text-white' : 'bg-muted text-muted-foreground')} aria-hidden>
      {p.media_kind === 'video' ? <Play className="size-5" /> : <ImageIcon className="size-5" />}
    </div>
  )
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
  /* Pin flips on press and a delete takes the row out at once with Undo
     for five seconds (lib/optimistic): a teacher's own post, the lowest-risk
     writes on this screen. */
  const pin = useOptimisticMutation<MyPost>({
    mutationFn: (p) => api.post(`/api/v1/status/posts/${p.id}/pin`, { pinned: !p.pinned }),
    queryKeys: [['class-status-mine']],
    invalidate: [['class-status-mine'], ['notifications']],
    apply: (old, p) => {
      const d = old as { items: MyPost[] }
      return { ...d, items: d.items.map((x) => (x.id === p.id ? { ...x, pinned: !p.pinned } : x)) }
    },
    failure: "Couldn't change the pin",
  })
  const del = useUndoableDelete<string>({
    mutationFn: (id) => api.del(`/api/v1/status/posts/${id}`),
    queryKeys: [['class-status-mine']],
    invalidate: [['class-status-mine'], ['notifications']],
    apply: (old, id) => {
      const d = old as { items: MyPost[] }
      return { ...d, items: d.items.filter((x) => x.id !== id) }
    },
    undo: 'Post deleted',
    failure: "Couldn't delete the post",
  })

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
                  <Button variant="ghost" size="sm" onClick={() => void del(p.id)} title="Delete"><Trash2 className="size-4" /></Button>
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
