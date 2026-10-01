import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, Plus } from 'lucide-react'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { Dialog } from '@/components/ui'
import StoryViewer, { initials, type StoryGroup, type StoryItem } from '@/components/StoryViewer'
import type { StatusFeed, StatusItem, StatusRing } from '@shared/api/feature_class_status'
import StatusComposer, { StatusFileInput } from './StatusComposer'
import { FEED_KEY, fileUrl, useStatusFeed, type Viewed } from './status-api'

/* THE ROW OF RINGS at the top of a home: one per poster, the school's own
   first, then whoever has something new. A coloured ring (the theme's
   accent) is unseen, grey is seen. For staff who may post, the first ring is
   theirs with a + on it, and it opens the camera directly.

   Tapping opens components/StoryViewer full screen: bars along the top, tap
   right and left, hold to pause, swipe down or Escape to close, video
   muted until unmuted. Each post reached is recorded as seen, which is what
   turns the ring grey, takes the number off the badge and reads the bell.

   A notification opens "/?status=<id>": the home this sits on reads the
   parameter, opens the viewer on that post and takes it out of the address.

   Draws nothing when the school has Class Status switched off, or when there
   is nothing to show and nothing this person may post. */

const RING_ON = 'conic-gradient(from 200deg, hsl(var(--primary)), hsl(var(--primary) / .55), hsl(var(--primary)))'

function Ring({ label, unseen, onClick, children, badge }: { label: string; unseen: boolean; onClick: () => void; children: React.ReactNode; badge?: React.ReactNode }) {
  /* The + badge is a file input of its own, so it sits beside the button
     rather than inside it: one tap, one meaning. */
  return (
    <div role="listitem" className="relative w-[72px] shrink-0">
      <button type="button" onClick={onClick} className="flex w-full flex-col items-center gap-1 text-center" aria-label={label + (unseen ? ', new' : '')}>
        <span className={cn('grid size-[62px] place-items-center rounded-full p-[3px]', !unseen && 'bg-border')} style={unseen ? { background: RING_ON } : undefined}>
          <span className="grid size-full place-items-center overflow-hidden rounded-full border-2 border-card bg-muted text-[15px] font-semibold">{children}</span>
        </span>
        <span className={cn('w-full truncate text-[12px]', unseen ? 'font-medium' : 'text-muted-foreground')}>{label}</span>
      </button>
      {badge && <div className="absolute left-[44px] top-[42px]">{badge}</div>}
    </div>
  )
}

function ViewsSheet({ postId, onClose }: { postId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['class-status-views', postId], queryFn: () => api.get<{ items: Viewed[]; views: number; audience: number }>(`/api/v1/status/posts/${postId}/views`) })
  return (
    <Dialog onClose={onClose} title="Seen by" description={q.data ? `${q.data.views} of ${q.data.audience || '—'}` : undefined} size="sm">
      {!q.data ? <p className="text-sm text-muted-foreground">Loading…</p> : q.data.items.length === 0 ? <p className="text-sm text-muted-foreground">Nobody yet.</p> : (
        <ul className="grid gap-2 text-sm">
          {q.data.items.map((v) => (
            <li key={v.user_id} className="flex items-baseline justify-between gap-3">
              <span>{v.full_name}{v.kind === 'parent' && v.student_name ? <span className="text-muted-foreground"> · parent of {v.student_name}</span> : null}</span>
              <span className="shrink-0 text-[12px] text-muted-foreground">{new Date(v.viewed_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}

export function toGroups(feed: StatusFeed, schoolName: string, schoolLogo: string | undefined, onViews: (id: string) => void): StoryGroup[] {
  const item = (p: StatusItem): StoryItem => ({
    id: p.id, title: p.caption ?? '', media: p.media_kind === 'video' ? 'video' : 'image', src: p.url,
    postedAt: p.published_at, seen: p.seen || p.mine, tag: p.audience,
    footer: p.mine ? <button type="button" onClick={() => onViews(p.id)}><Eye className="size-4" /> Seen by</button> : undefined,
  })
  const groups: StoryGroup[] = feed.rings.map((r: StatusRing) => ({
    id: r.key, name: r.as_school ? schoolName : r.mine ? 'My status' : r.name,
    avatar: r.as_school ? schoolLogo : fileUrl(r.avatar_key), items: r.posts.map(item),
  }))
  if (feed.gallery.length) groups.push({ id: 'gallery', name: 'Gallery', items: feed.gallery.map((p) => ({ ...item(p), seen: true })) })
  return groups
}

export default function StatusRings({ className }: { className?: string }) {
  const session = useSession()
  const qc = useQueryClient()
  const feed = useStatusFeed(!!session.institution)
  const [open, setOpen] = useState<{ group: number } | null>(null)
  const [compose, setCompose] = useState<{ file: File | null; asSchool: boolean } | null>(null)
  const [views, setViews] = useState<string | null>(null)
  const [params, setParams] = useSearchParams()
  const inst = session.institution
  const schoolName = inst?.display_name || inst?.short_name || inst?.name || 'School'
  const schoolLogo = fileUrl(inst?.logo_key)
  const data = feed.data
  const groups = useMemo(() => (data ? toGroups(data, schoolName, schoolLogo, setViews) : []), [data, schoolName, schoolLogo])

  // Opened from a notification: /?status=<post id>.
  const wanted = params.get('status')
  useEffect(() => {
    if (!wanted || !groups.length) return
    const at = groups.findIndex((g) => g.items.some((i) => i.id === wanted))
    if (at >= 0) setOpen({ group: at })
    const next = new URLSearchParams(params)
    next.delete('status')
    setParams(next, { replace: true })
  }, [wanted, groups, params, setParams])

  const markSeen = useCallback((it: StoryItem) => {
    void api.post(`/api/v1/status/posts/${it.id}/view`).then(() => qc.invalidateQueries({ queryKey: ['notifications'] })).catch(() => undefined)
  }, [qc])
  const close = useCallback(() => setOpen(null), [])

  if (!data || !data.enabled) return null
  const canPost = data.can_post || data.can_post_school
  const mineRing = data.rings.find((r) => r.mine)
  if (!groups.length && !canPost) return null
  const me = session.user

  return (
    <div className={cn('card', className)}>
      <div className="flex items-center justify-between px-4 pt-3 text-[13px]">
        <span className="font-medium">Status</span>
        {data.unseen > 0 && <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground" aria-label={`${data.unseen} new`}>{data.unseen} new</span>}
      </div>
      <div className="flex gap-3 overflow-x-auto px-4 pb-3 pt-2" role="list" aria-label="Class status">
        {canPost && (
          mineRing ? (
            <Ring label="My status" unseen={false} onClick={() => setOpen({ group: groups.findIndex((g) => g.id === mineRing.key) })}
              badge={<StatusFileInput onPick={(f) => setCompose({ file: f, asSchool: false })} label="Add a status" className="grid size-6 place-items-center rounded-full border-2 border-card bg-primary text-primary-foreground"><Plus className="size-3.5" /></StatusFileInput>}>
              {me?.avatar_key ? <img src={fileUrl(me.avatar_key)} alt="" className="size-full object-cover" /> : initials(me?.full_name ?? '')}
            </Ring>
          ) : (
            <StatusFileInput onPick={(f) => setCompose({ file: f, asSchool: false })} label="Add a status" className="flex w-[72px] shrink-0 flex-col items-center gap-1 text-center">
              <span className="relative grid size-[62px] place-items-center rounded-full bg-border p-[3px]">
                <span className="grid size-full place-items-center overflow-hidden rounded-full border-2 border-card bg-muted text-[15px] font-semibold">
                  {me?.avatar_key ? <img src={fileUrl(me.avatar_key)} alt="" className="size-full object-cover" /> : initials(me?.full_name ?? '')}
                </span>
                <span className="absolute -bottom-0.5 -right-0.5 grid size-6 place-items-center rounded-full border-2 border-card bg-primary text-primary-foreground"><Plus className="size-3.5" /></span>
              </span>
              <span className="w-full truncate text-[12px] text-muted-foreground">Add status</span>
            </StatusFileInput>
          )
        )}
        {data.can_post_school && !data.rings.some((r) => r.as_school) && (
          <StatusFileInput onPick={(f) => setCompose({ file: f, asSchool: true })} label="Post as the school" className="flex w-[72px] shrink-0 flex-col items-center gap-1 text-center">
            <span className="relative grid size-[62px] place-items-center rounded-full bg-border p-[3px]">
              <span className="grid size-full place-items-center overflow-hidden rounded-full border-2 border-card bg-muted text-[15px] font-semibold">
                {schoolLogo ? <img src={schoolLogo} alt="" className="size-full object-cover" /> : initials(schoolName)}
              </span>
              <span className="absolute -bottom-0.5 -right-0.5 grid size-6 place-items-center rounded-full border-2 border-card bg-primary text-primary-foreground"><Plus className="size-3.5" /></span>
            </span>
            <span className="w-full truncate text-[12px] text-muted-foreground">{schoolName}</span>
          </StatusFileInput>
        )}
        {groups.map((g, idx) => {
          if (mineRing && g.id === mineRing.key) return null
          const ring = data.rings.find((r) => r.key === g.id)
          const unseen = !!ring && ring.unseen > 0
          return (
            <Ring key={g.id} label={g.name} unseen={unseen} onClick={() => setOpen({ group: idx })}
              badge={ring?.as_school && data.can_post_school ? (
                <StatusFileInput onPick={(f) => setCompose({ file: f, asSchool: true })} label="Post as the school" className="grid size-6 place-items-center rounded-full border-2 border-card bg-primary text-primary-foreground"><Plus className="size-3.5" /></StatusFileInput>
              ) : undefined}>
              {g.avatar ? <img src={g.avatar} alt="" className="size-full object-cover" /> : initials(g.name)}
            </Ring>
          )
        })}
      </div>
      {open && groups.length > 0 && <StoryViewer groups={groups} start={Math.max(0, open.group)} onClose={close} onSeen={markSeen} startMuted />}
      {compose && <StatusComposer file={compose.file} asSchool={compose.asSchool} onClose={() => { setCompose(null); void qc.invalidateQueries({ queryKey: FEED_KEY }) }} />}
      {views && <ViewsSheet postId={views} onClose={() => setViews(null)} />}
    </div>
  )
}

export { ViewsSheet }
