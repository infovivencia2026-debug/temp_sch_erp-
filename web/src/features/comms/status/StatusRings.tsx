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
import StatusComposer, { AddChooser } from './StatusComposer'
import { FEED_KEY, fileUrl, useStatusFeed, type AddMode, type Viewed } from './status-api'

/* THE ROW OF RINGS at the top of a home: one per poster, the school's own
   first, then whoever has something new. A coloured ring (the theme's
   accent) is unseen, grey is seen. For staff who may post, the first ring is
   Add (or theirs with a + on it), which opens the chooser: Photo, Video,
   Camera or Text. `compact` is the same strip at the top of the bell's panel.

   Tapping opens components/StoryViewer full screen: bars along the top, tap
   right and left, hold to pause, swipe down or Escape to close, video
   muted until unmuted. Each post reached is recorded as seen, which is what
   turns the ring grey, takes the number off the badge and reads the bell.

   A notification opens "/?status=<id>": the home this sits on reads the
   parameter, opens the viewer on that post and takes it out of the address.

   Draws nothing when the school has Class Status switched off, or when there
   is nothing to show and nothing this person may post. */

const RING_ON = 'conic-gradient(from 200deg, hsl(var(--primary)), hsl(var(--primary) / .55), hsl(var(--primary)))'

function Ring({ label, unseen, onClick, children, badge, compact }: { label: string; unseen: boolean; onClick: () => void; children: React.ReactNode; badge?: React.ReactNode; compact?: boolean }) {
  /* The + badge is a button of its own, so it sits beside the ring rather
     than inside it: one tap, one meaning. */
  return (
    <div role="listitem" className={cn('relative shrink-0', compact ? 'w-[64px]' : 'w-[72px]')}>
      <button type="button" onClick={onClick} className="flex min-h-[44px] w-full flex-col items-center gap-1 text-center" aria-label={label + (unseen ? ', new' : '')}>
        <span className={cn('grid place-items-center rounded-full p-[3px]', compact ? 'size-[54px]' : 'size-[62px]', !unseen && 'bg-border')} style={unseen ? { background: RING_ON } : undefined}>
          <span className="grid size-full place-items-center overflow-hidden rounded-full border-2 border-card bg-muted text-[15px] font-semibold">{children}</span>
        </span>
        <span className={cn('w-full truncate text-[12px]', unseen ? 'font-medium' : 'text-muted-foreground')}>{label}</span>
      </button>
      {badge && <div className={cn('absolute', compact ? 'left-[38px] top-[34px]' : 'left-[44px] top-[42px]')}>{badge}</div>}
    </div>
  )
}

function ViewsSheet({ postId, onClose, raised = false }: { postId: string; onClose: () => void; raised?: boolean }) {
  const q = useQuery({ queryKey: ['class-status-views', postId], queryFn: () => api.get<{ items: Viewed[]; views: number; audience: number }>(`/api/v1/status/posts/${postId}/views`) })
  return (
    <Dialog raised={raised} onClose={onClose} title="Seen by" description={q.data ? `${q.data.views} of ${q.data.audience || '—'}` : undefined} size="sm">
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
    id: p.id, title: p.caption ?? '', media: p.media_kind === 'video' ? 'video' : p.media_kind === 'text' ? 'text' : 'image', src: p.url || undefined,
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

/** A + on a ring: opens the Add chooser. 44px to the finger, 24px drawn. */
function PlusBadge({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="-m-2.5 grid size-11 place-items-center">
      <span className="grid size-6 place-items-center rounded-full border-2 border-card bg-primary text-primary-foreground"><Plus className="size-3.5" /></span>
    </button>
  )
}

export default function StatusRings({ className, compact = false, openId, onOpenHandled, raised = false }: {
  className?: string
  /** The strip at the top of the notification panel: no card, smaller rings, no heading. */
  compact?: boolean
  /** Open the viewer at this post (a status notification was tapped). */
  openId?: string | null
  onOpenHandled?: () => void
  /** Dialogs above the notification drawer. */
  raised?: boolean
}) {
  const session = useSession()
  const qc = useQueryClient()
  const feed = useStatusFeed(!!session.institution)
  const [open, setOpen] = useState<{ group: number; id?: string } | null>(null)
  const [choose, setChoose] = useState<{ asSchool: boolean } | null>(null)
  const [compose, setCompose] = useState<{ file: File | null; asSchool: boolean; mode?: AddMode } | null>(null)
  const [views, setViews] = useState<string | null>(null)
  const [params, setParams] = useSearchParams()
  const inst = session.institution
  const schoolName = inst?.display_name || inst?.short_name || inst?.name || 'School'
  const schoolLogo = fileUrl(inst?.logo_key)
  const data = feed.data
  const groups = useMemo(() => (data ? toGroups(data, schoolName, schoolLogo, setViews) : []), [data, schoolName, schoolLogo])

  // Opened from a notification: /?status=<post id> (the home), or openId (the panel).
  const wanted = compact ? null : params.get('status')
  useEffect(() => {
    if (!wanted || !groups.length) return
    const at = groups.findIndex((g) => g.items.some((i) => i.id === wanted))
    if (at >= 0) setOpen({ group: at, id: wanted })
    const next = new URLSearchParams(params)
    next.delete('status')
    setParams(next, { replace: true })
  }, [wanted, groups, params, setParams])
  useEffect(() => {
    if (!openId || !data) return
    const at = groups.findIndex((g) => g.items.some((i) => i.id === openId))
    if (at >= 0) setOpen({ group: at, id: openId })
    onOpenHandled?.()
  }, [openId, data, groups, onOpenHandled])

  const markSeen = useCallback((it: StoryItem) => {
    void api.post(`/api/v1/status/posts/${it.id}/view`).then(() => qc.invalidateQueries({ queryKey: ['notifications'] })).catch(() => undefined)
  }, [qc])
  const close = useCallback(() => setOpen(null), [])

  if (!data || !data.enabled) return null
  const canPost = data.can_post || data.can_post_school
  const mineRing = data.rings.find((r) => r.mine)
  if (!groups.length && !canPost) return null
  const me = session.user
  const add = (asSchool: boolean) => setChoose({ asSchool })
  const size = compact ? 'size-[54px]' : 'size-[62px]'
  const width = compact ? 'w-[64px]' : 'w-[72px]'

  const addRing = (label: string, face: React.ReactNode, asSchool: boolean) => (
    <div role="listitem" className={cn('shrink-0', width)}>
      <button type="button" onClick={() => add(asSchool)} aria-label={asSchool ? 'Post as the school' : 'Add a status'} className="flex min-h-[44px] w-full flex-col items-center gap-1 text-center">
        <span className={cn('relative grid place-items-center rounded-full border-2 border-dashed border-primary/50 p-[2px]', size)}>
          <span className="grid size-full place-items-center overflow-hidden rounded-full bg-muted text-[15px] font-semibold">{face}</span>
          <span className="absolute -bottom-0.5 -right-0.5 grid size-6 place-items-center rounded-full border-2 border-card bg-primary text-primary-foreground"><Plus className="size-3.5" /></span>
        </span>
        <span className="w-full truncate text-[12px] text-muted-foreground">{label}</span>
      </button>
    </div>
  )
  const myFace = me?.avatar_key ? <img src={fileUrl(me.avatar_key)} alt="" className="size-full object-cover" /> : initials(me?.full_name ?? '')

  const strip = (
    <div className={cn('scroll-x flex gap-3 overflow-x-auto overscroll-x-contain', compact ? 'px-4 py-3' : 'px-4 pb-3 pt-2')} role="list" aria-label="Class status">
      {canPost && (
        mineRing ? (
          <Ring compact={compact} label="My status" unseen={false} onClick={() => setOpen({ group: groups.findIndex((g) => g.id === mineRing.key) })}
            badge={<PlusBadge onClick={() => add(false)} label="Add a status" />}>
            {myFace}
          </Ring>
        ) : addRing(compact ? 'Add' : 'Add status', myFace, false)
      )}
      {data.can_post_school && !data.rings.some((r) => r.as_school) &&
        addRing(schoolName, schoolLogo ? <img src={schoolLogo} alt="" className="size-full object-cover" /> : initials(schoolName), true)}
      {groups.map((g, idx) => {
        if (mineRing && g.id === mineRing.key) return null
        const ring = data.rings.find((r) => r.key === g.id)
        const unseen = !!ring && ring.unseen > 0
        return (
          <Ring compact={compact} key={g.id} label={g.name} unseen={unseen} onClick={() => setOpen({ group: idx })}
            badge={ring?.as_school && data.can_post_school ? <PlusBadge onClick={() => add(true)} label="Post as the school" /> : undefined}>
            {g.avatar ? <img src={g.avatar} alt="" className="size-full object-cover" /> : initials(g.name)}
          </Ring>
        )
      })}
    </div>
  )

  return (
    <div className={cn(!compact && 'card', className)}>
      {!compact && (
        <div className="flex items-center justify-between px-4 pt-3 text-[13px]">
          <span className="font-medium">Status</span>
          {data.unseen > 0 && <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground" aria-label={`${data.unseen} new`}>{data.unseen} new</span>}
        </div>
      )}
      {strip}
      {open && groups.length > 0 && <StoryViewer groups={groups} start={Math.max(0, open.group)} startId={open.id} onClose={close} onSeen={markSeen} startMuted />}
      {choose && (
        <AddChooser raised={raised} asSchool={choose.asSchool} allowVideo={data.allow_video} onClose={() => setChoose(null)}
          onPick={(f) => { setCompose({ file: f, asSchool: choose.asSchool }); setChoose(null) }}
          onText={() => { setCompose({ file: null, asSchool: choose.asSchool, mode: 'text' }); setChoose(null) }} />
      )}
      {compose && <StatusComposer raised={raised} file={compose.file} mode={compose.mode} asSchool={compose.asSchool} onClose={() => { setCompose(null); void qc.invalidateQueries({ queryKey: FEED_KEY }) }} />}
      {views && <ViewsSheet raised={raised} postId={views} onClose={() => setViews(null)} />}
    </div>
  )
}

export { ViewsSheet }
