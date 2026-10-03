import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { onShared, peekShared, takeShared } from '@/lib/shell'
import { useStaggerOnce } from '@/lib/motion'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { Dialog } from '@/components/ui'
import { StatParts } from '@/components/stat-extras'
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

/* Unseen is the warm sweep every phone's story ring wears (orange into pink
   into purple, styles/color-system.css); seen is grey. */
const RING_ON = 'var(--sys-ring-unseen)'

function Ring({ label, unseen, onClick, children, badge, compact }: { label: string; unseen: boolean; onClick: (face: HTMLElement | null) => void; children: React.ReactNode; badge?: React.ReactNode; compact?: boolean }) {
  /* The + badge is a button of its own, so it sits beside the ring rather
     than inside it: one tap, one meaning. The face is handed to onClick so
     the viewer can be opened as a container transform from it. */
  const face = useRef<HTMLSpanElement>(null)
  return (
    <div role="listitem" className={cn('relative shrink-0', compact ? 'w-[64px]' : 'w-[72px]')}>
      <button type="button" onClick={() => onClick(face.current)} className="m-press flex min-h-[44px] w-full flex-col items-center gap-1 rounded-xl text-center" aria-label={label + (unseen ? ', new' : '')}>
        <span className={cn('grid place-items-center rounded-full p-[3px]', compact ? 'size-[54px]' : 'size-[62px]', !unseen && 'bg-border')} style={unseen ? { background: RING_ON } : undefined}>
          <span ref={face} className="grid size-full place-items-center overflow-hidden rounded-full border-2 border-card bg-muted text-[15px] font-semibold">{children}</span>
        </span>
        <span className={cn('w-full truncate text-[12px]', unseen ? 'font-medium' : 'text-muted-foreground')}>{label}</span>
      </button>
      {badge && <div className={cn('absolute', compact ? 'left-[38px] top-[34px]' : 'left-[44px] top-[42px]')}>{badge}</div>}
    </div>
  )
}

function ViewsSheet({ postId, onClose, raised = false }: { postId: string; onClose: () => void; raised?: boolean }) {
  const q = useQuery({ queryKey: ['class-status-views', postId], queryFn: () => api.get<{ items: Viewed[]; views: number; audience: number }>(`/api/v1/status/posts/${postId}/views`) })
  /* WHO HAS SEEN IT, SAID IN FULL. This was "3 of 20" and a list. The poster
     wants to know how far it got, among whom, and who is left: the share, a
     bar split into parents, students and staff that narrows the list when a
     part is pressed, when it was first and last opened, and how many it has
     not reached yet. */
  const [kind, setKind] = useState<string | null>(null)
  const d = q.data
  const n = (k: Viewed['kind']) => d?.items.filter((v) => v.kind === k).length ?? 0
  const share = d && d.audience > 0 ? Math.min(100, Math.round((100 * d.views) / d.audience)) : null
  const times = d?.items.map((v) => new Date(v.viewed_at).getTime()).filter((t) => !Number.isNaN(t)) ?? []
  const clock = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  const list = d?.items.filter((v) => !kind || v.kind === kind) ?? []
  return (
    <Dialog raised={raised} onClose={onClose} title="Seen by" size="sm">
      {!d ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <>
          <div className="rounded-[var(--radius-card)] border bg-card px-4 py-3.5">
            <p className="text-[13px] text-muted-foreground">Reached</p>
            <p className="mt-0.5 text-[26px] font-bold leading-tight tracking-[-0.02em] tabular-nums">
              {d.views}{d.audience > 0 && <span className="text-[15px] font-medium text-muted-foreground"> of {d.audience}</span>}
              {share !== null && <span className="ml-2 text-[15px] font-semibold text-primary">{share}%</span>}
            </p>
            <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
              {d.views === 0
                ? 'Nobody has opened it yet.'
                : <>First opened {clock(Math.min(...times))}{times.length > 1 ? `, most recently ${clock(Math.max(...times))}` : ''}.{d.audience > d.views ? ` ${d.audience - d.views} still to see it.` : d.audience > 0 ? ' Everyone it was for has seen it.' : ''}</>}
            </p>
            <StatParts
              parts={[
                { key: 'parent', label: 'Parents', value: n('parent'), tone: 'primary' },
                { key: 'student', label: 'Students', value: n('student'), tone: 'info' },
                { key: 'staff', label: 'Staff', value: n('staff'), tone: 'success' },
              ]}
              onPart={setKind}
              activePart={kind}
            />
          </div>
          {list.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">{d.views === 0 ? 'It will show here as people open it.' : 'Nobody of that kind yet.'}</p>
          ) : (
            <ul className="mt-4 grid gap-2.5 text-sm">
              {list.map((v) => (
                <li key={v.user_id} className="flex items-baseline justify-between gap-3">
                  <span>{v.full_name}{v.kind === 'parent' && v.student_name ? <span className="text-muted-foreground"> · parent of {v.student_name}</span> : null}</span>
                  <span className="shrink-0 text-[12px] text-muted-foreground">{new Date(v.viewed_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Dialog>
  )
}

export function toGroups(feed: StatusFeed, schoolName: string, schoolLogo: string | undefined, _onViews: (id: string) => void): StoryGroup[] {
  const item = (p: StatusItem): StoryItem => ({
    id: p.id, title: p.caption ?? '', media: p.media_kind === 'video' ? 'video' : p.media_kind === 'text' ? 'text' : 'image', src: p.url || undefined,
    postedAt: p.published_at, seen: p.seen || p.mine, poster: p.thumb,
    /* Seen by lives on the poster's own status sheet, not over the picture. */
    footer: undefined,
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
  const photoIn = useRef<HTMLInputElement>(null)
  const videoIn = useRef<HTMLInputElement>(null)
  const cameraIn = useRef<HTMLInputElement>(null)
  const pickFor = useRef(false)
  /* ONE POP-UP AFTER THE OTHER. Closing the chooser steps the browser back
     (that is how a pop-up honours the phone's back button); opening the
     composer in the same moment let that back close the composer too, so a
     picked photo led straight back to the home screen. The composer opens
     once the chooser's back has landed. */
  const openComposer = (next: { file: File | null; asSchool: boolean; mode?: AddMode }) => {
    setChoose(null)
    window.setTimeout(() => setCompose(next), 350)
  }
  const picked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (f) openComposer({ file: f, asSchool: pickFor.current })
  }
  const [views, setViews] = useState<string | null>(null)
  /* Photos shared into the app from the phone's gallery (components/ShareInbox.tsx). */
  useEffect(() => {
    const take = () => {
      const f = peekShared()?.target === 'status' ? takeShared()?.files.find((x) => /^(image|video)\//.test(x.type)) : undefined
      if (f) setCompose({ file: f, asSchool: false })
    }
    take()
    return onShared(take)
  }, [])
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

  /* SEEN, WITHOUT ASKING AGAIN. Each post reached used to post the view and
     then refetch the whole feed and the bell (they share a key), so watching
     ten statuses loaded both ten times over. The ring is greyed and the
     count taken down here, in the cache, the moment the post is on screen;
     the server is told on the post's own signed address (one read there,
     see class_status.ts), with `last=1` on the ring's final unseen post so
     it can read the bell entry; and the feed and the bell are fetched once,
     when the viewer closes. */
  const sawAny = useRef(false)
  const markSeen = useCallback((it: StoryItem) => {
    const feedNow = qc.getQueryData<StatusFeed>(FEED_KEY)
    const ring = feedNow?.rings.find((r) => r.posts.some((x) => x.id === it.id))
    const post = ring?.posts.find((x) => x.id === it.id)
    if (!feedNow || !ring || !post || post.seen || post.mine) return
    const last = ring.unseen <= 1
    sawAny.current = true
    qc.setQueryData<StatusFeed>(FEED_KEY, {
      ...feedNow,
      unseen: Math.max(0, feedNow.unseen - 1),
      rings: feedNow.rings.map((r) => (r !== ring ? r : { ...r, unseen: Math.max(0, r.unseen - 1), posts: r.posts.map((x) => (x.id === it.id ? { ...x, seen: true } : x)) })),
    })
    const to = post.seen_url ? post.seen_url + (last ? '&last=1' : '') : `/api/v1/status/posts/${it.id}/view`
    void api.post(to).catch(() => undefined)
  }, [qc])
  const close = useCallback(() => {
    setOpen(null)
    if (sawAny.current) {
      sawAny.current = false
      void qc.invalidateQueries({ queryKey: ['notifications'] })
    }
  }, [qc])
  /* The tapped face morphs into the viewer's avatar (a shared element);
     where the engine cannot, the viewer simply opens. */
  const openFrom = useCallback((face: HTMLElement | null, at: { group: number; id?: string }) => {
    /* Straight open, no zoom-from-the-ring transition: that transition drew
       the sidebar on its own layer above the viewer, so it stayed lit over
       the black screen. */
    void face
    setOpen(at)
  }, [])
  const stripRef = useStaggerOnce<HTMLDivElement>()

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
    <div ref={stripRef} className={cn('scroll-x m-snap-x m-stagger flex gap-3 overflow-x-auto overscroll-x-contain', compact ? 'px-4 py-3' : 'px-4 pb-3 pt-2')} role="list" aria-label="Class status">
      {canPost && (
        mineRing ? (
          <Ring compact={compact} label="My status" unseen={false} onClick={(face) => openFrom(face, { group: groups.findIndex((g) => g.id === mineRing.key) })}
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
          <Ring compact={compact} key={g.id} label={g.name} unseen={unseen} onClick={(face) => openFrom(face, { group: idx })}
            badge={ring?.as_school && data.can_post_school ? <PlusBadge onClick={() => add(true)} label="Post as the school" /> : undefined}>
            {/* The ring shows what is inside it: the first unseen picture, or
                the latest. The thumbnail is the signed one the feed sent, so
                it costs one read and stays in the browser's cache. */}
            {(() => {
              const peek = ring?.posts.find((x) => !x.seen && x.thumb)?.thumb ?? [...(ring?.posts ?? [])].reverse().find((x) => x.thumb)?.thumb
              const face = peek ?? g.avatar
              return face ? <img src={face} alt="" loading="lazy" decoding="async" className="size-full object-cover" /> : initials(g.name)
            })()}
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
      {open && groups.length > 0 && <StoryViewer groups={groups} start={Math.max(0, open.group)} startId={open.id} onClose={close} onSeen={markSeen} />}
      <input ref={photoIn} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden onChange={picked} />
      <input ref={videoIn} type="file" accept="video/*" className="sr-only" tabIndex={-1} aria-hidden onChange={picked} />
      <input ref={cameraIn} type="file" accept={data.allow_video ? 'image/*,video/*' : 'image/*'} capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={picked} />
      {choose && (
        <AddChooser raised={raised} asSchool={choose.asSchool} allowVideo={data.allow_video} onClose={() => setChoose(null)}
          openPicker={(k) => { pickFor.current = choose.asSchool; (k === 'photo' ? photoIn : k === 'video' ? videoIn : cameraIn).current?.click() }}
          onPick={(f) => openComposer({ file: f, asSchool: choose.asSchool })}
          onText={() => openComposer({ file: null, asSchool: choose.asSchool, mode: 'text' })} />
      )}
      {compose && <StatusComposer raised={raised} file={compose.file} mode={compose.mode} asSchool={compose.asSchool} onClose={() => { setCompose(null); void qc.invalidateQueries({ queryKey: FEED_KEY }) }} />}
      {views && <ViewsSheet raised={raised} postId={views} onClose={() => setViews(null)} />}
    </div>
  )
}

export { ViewsSheet }
