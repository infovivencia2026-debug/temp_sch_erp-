import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOverlayHistory } from '@/lib/overlay-history'
import { useFeatureHref } from '@/features/bento/bento-kit'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowUpRight, Award, Bell, UserPlus, BookOpen, Bus, CalendarCheck, CalendarClock, Camera, Image as ImageIcon, IndianRupee, Megaphone, MessageSquare, Play, Type, X,
} from 'lucide-react'
import StatusRings from '@/features/comms/status/StatusRings'
import { useStatusFeed } from '@/features/comms/status/status-api'
import type { StatusItem } from '@shared/api/feature_class_status'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useOptimisticMutation } from '@/lib/optimistic'
import { useOpenState } from '@/lib/motion'
import { Button, Dialog } from '@/components/ui'

/* The bell in the header, and the panel it opens.

   Notices used to be a menu entry of their own, which meant a family had to
   go looking for something the school had already decided was urgent. The
   feed itself is not new — /api/v1/portal/notifications runs its delivery
   pass on read, so a screen opened after a fortnight away is not empty.

   The button hides itself for anyone the endpoint refuses. Staff have no
   family feed, and a bell that opens on "you are not allowed to see this" is
   worse than no bell.

   WHY A DRAWER AND NOT A DROPDOWN. It was a 22rem menu hanging off the bell,
   capped at 60vh, which is enough to show that there are notifications and not
   enough to read them: a two-line body was clipped to one, the day was a
   YYYY-MM-DD stamp because nothing longer fitted, and there was no room to say
   what KIND of thing had happened. A notification is a message from the
   school, and this is the only place most families will ever read one. It gets
   the side of the screen.

   Anchored to the window rather than to the bell, so it is the same panel at
   every width and does not have to be measured away from the right edge. */

interface Note {
  id: string
  kind: string
  title: string
  body?: string
  link?: string
  student_name?: string
  created_at: string
  read_at?: string
}

/* What sort of thing happened, at a glance.

   With one line per row there was no space for this and the title had to carry
   it — "Fee due: term 2" rather than "Term 2". A mark down the left lets the
   eye sort a fortnight's feed into fees, homework and notices without reading
   a word, which is what somebody catching up actually does first. */
const KINDS: Record<string, { icon: typeof Bell; label: string }> = {
  fee: { icon: IndianRupee, label: 'Fees' },
  fees: { icon: IndianRupee, label: 'Fees' },
  homework: { icon: BookOpen, label: 'Homework' },
  timetable: { icon: CalendarClock, label: 'Timetable' },
  message: { icon: MessageSquare, label: 'Message' },
  notice: { icon: Megaphone, label: 'Notice' },
  // Class Status: opens the home with the viewer on that post (/?status=<id>).
  status: { icon: Camera, label: 'Status' },
}

/* The server's kinds are finer than a reader's: fee_due and fee_overdue are
   both "Fees", report_card and result both "Results". Matched by what the
   kind starts with, so a new variant lands in its family, with its icon,
   instead of showing a bell and its own raw name. */
const FAMILIES: [RegExp, { icon: typeof Bell; label: string }][] = [
  [/^fee|^payment/, { icon: IndianRupee, label: 'Fees' }],
  [/^enquir|^admission/, { icon: UserPlus, label: 'Admissions' }],
  [/^homework/, { icon: BookOpen, label: 'Homework' }],
  [/^attendance|^absen|^leave/, { icon: CalendarCheck, label: 'Attendance' }],
  [/^report_card|^result|^exam/, { icon: Award, label: 'Results' }],
  [/^transport|bus/, { icon: Bus, label: 'Bus' }],
  [/message|^chat/, { icon: MessageSquare, label: 'Messages' }],
]

function kindOf(kind: string) {
  const k = kind.toLowerCase()
  return KINDS[k] ?? FAMILIES.find(([re]) => re.test(k))?.[1] ?? { icon: Bell, label: k.replace(/[-_]/g, ' ') }
}

/* Days, not timestamps.

   "2026-08-19" is a date somebody has to work out the distance to. The panel
   has the room to say "Yesterday", and for anything older the day and month in
   words, which is how the message would have been spoken. */
function dayOf(iso: string): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return 'Earlier'
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((midnight(new Date()) - midnight(then)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  return then.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })
}

function dateOf(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

/* The filter row: what a parent sorts a feed by. */
const FILTERS: { key: string; label: string; kinds?: string[] }[] = [
  { key: 'all', label: 'All' },
  { key: 'message', label: 'Messages', kinds: ['message', 'chat'] },
  { key: 'academic', label: 'Academic', kinds: ['homework', 'timetable', 'exam', 'result', 'results', 'report', 'attendance', 'leave'] },
  { key: 'fees', label: 'Fees', kinds: ['fee', 'fees', 'payment'] },
  { key: 'status', label: 'Status', kinds: ['status'] },
  { key: 'other', label: 'Other' },
]

function timeOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/* The post a status notification is about: its link is "/?status=<id>". */
function statusPostId(n: Note): string | null {
  if (n.kind !== 'status' || !n.link) return null
  const m = /[?&]status=([0-9a-f-]{36})/i.exec(n.link)
  return m ? m[1].toLowerCase() : null
}

function seconds(n?: number): string {
  if (!n) return ''
  const s = Math.round(n)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/* A STATUS AS A MEDIA NOTIFICATION: the picture (the auth-checked ~320px
   thumbnail), a play tile with the length for a video without one, the
   accent for a text status, the type icon when nothing else is known. */
function StatusThumb({ post, read }: { post?: StatusItem; read: boolean }) {
  const [broken, setBroken] = useState(false)
  const kind = post?.media_kind
  const box = 'relative grid size-14 shrink-0 place-items-center overflow-hidden rounded-lg'
  if (kind === 'text') {
    return <span className={cn(box, 'bg-primary p-1 text-center text-[9px] font-semibold leading-tight text-primary-foreground')} aria-hidden>
      <span className="line-clamp-3">{post?.caption || <Type className="size-4" />}</span>
    </span>
  }
  const video = kind === 'video'
  return (
    <span className={cn(box, post?.thumb && !broken ? 'bg-black' : read ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary')} aria-hidden>
      {post?.thumb && !broken
        ? <img src={post.thumb} alt="" loading="lazy" className="size-full object-cover" onError={() => setBroken(true)} />
        : video ? <Play className="size-5" /> : kind === 'photo' ? <ImageIcon className="size-5" /> : <Camera className="size-5" />}
      {video && (
        <span className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent px-1 pb-0.5 pt-2 text-[10px] font-semibold text-white">
          <Play className="size-2.5 fill-current" />{seconds(post?.duration_seconds)}
        </span>
      )}
    </span>
  )
}

export default function Notifications() {
  const [open, setOpen] = useOpenState(false)
  /* Kept mounted for one animation after the close.

     Unmounting on the click is what makes a panel vanish: the drawer came in
     over half a second and left in a single frame, which reads as a glitch
     rather than as leaving. `closing` holds it on screen long enough to slide
     back out the way it came. */
  const [closing, setClosing] = useState(false)
  const [filter, setFilter] = useState('all')
  /* The owner's design: two toggles at the foot of the drawer. */
  const [onlyUnread, setOnlyUnread] = useState(false)
  const [type, setType] = useState<'messages' | 'activity' | null>(null)
  const hubStudent = useFeatureHref('student.learning.e_learning_resource_hub')
  const hubParent = useFeatureHref('parent.academics.homework_academics')
  const toHub = hubStudent ?? hubParent
  const statuses = useQuery({
    queryKey: ['notif-statuses'],
    queryFn: () => api.get<{ items: { id: string; title: string; kind: string; uploaded_by?: string; posted_on: string; posted_at?: string; seen?: boolean }[] }>('/api/v1/portal/learning/resources'),
    /* Fetched while the drawer is open, so the Activity toggle can carry its count. */
    enabled: open,
    retry: false,
  })
  
  const feed = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.call('GET /portal/notifications'),
    /* THE SECOND POLL, WHICH THE FIRST ONE EXISTS TO MAKE UNNECESSARY.
     *
     * This was `refetchInterval: 10_000` — precisely the per-screen interval
     * lib/live.ts opens by arguing against, and the bell is mounted in the
     * header, so it was on every screen at once. Measured: two independent
     * ten-second timers, twelve requests a minute out of an idle tab that
     * nobody was looking at, for ever.
     *
     * The revision poll already answers "has anything changed?" for the whole
     * app and invalidates everything when it has, which refetches this query
     * because it is mounted. So a notification still arrives without anybody
     * reloading — it arrives by the one mechanism the product already has,
     * rather than by a second one that duplicated it.
     *
     * `refetchOnWindowFocus` is kept, and is now one of the few queries that
     * asks for it (see App.tsx): the bell is the thing people watch after
     * being told "I have sent it", so coming back to the tab must not show a
     * stale count. */
    refetchOnWindowFocus: true,
    // The count on the bell is the freshest thing on the page; nothing else
    // should be serving it out of a cache the revision poll has not touched.
    staleTime: 60_000,
    retry: false,
  })
  /* Optimistic (lib/optimistic): the badge clears and the list empties the
     moment either is pressed; a refusal puts them back with the reason. */
  type Feed = { items?: Note[]; unread?: number }
  const readAll = useOptimisticMutation<void>({
    mutationFn: () => api.post('/api/v1/portal/notifications/read-all', {}),
    queryKeys: [['notifications']],
    apply: (old) => {
      const f = old as Feed
      const now = new Date().toISOString()
      return { ...f, unread: 0, items: (f.items ?? []).map((n) => (n.read_at ? n : { ...n, read_at: now })) }
    },
    failure: "Couldn't mark them read",
  })
  /* Clear empties the list; Mark all read only quiets the badge. Both were
     asked for by name: a feed a fortnight long that can only be marked read
     is a feed that has to be scrolled past every time. */
  const clearAll = useOptimisticMutation<void>({
    mutationFn: () => api.post('/api/v1/portal/notifications/clear', {}),
    queryKeys: [['notifications']],
    apply: (old) => ({ ...(old as Feed), unread: 0, items: [] }),
    failure: "Couldn't clear them",
  })

  /* One entry read, not the lot: opening a message used to mark every other
     one read with it. */
  const readOne = useOptimisticMutation<string>({
    mutationFn: (id) => api.post(`/api/v1/portal/notifications/${id}/read`, {}),
    queryKeys: [['notifications']],
    apply: (old, id) => {
      const f = old as Feed
      const now = new Date().toISOString()
      const hit = (f.items ?? []).some((n) => n.id === id && !n.read_at)
      return {
        ...f,
        unread: hit ? Math.max(0, (f.unread ?? 0) - 1) : f.unread,
        items: (f.items ?? []).map((n) => (n.id === id && !n.read_at ? { ...n, read_at: now } : n)),
      }
    },
    failure: "Couldn't mark it read",
  })
  /* The message being read in full, over the drawer. */
  const [viewing, setViewing] = useState<Note | null>(null)

  const navigate = useNavigate()
  // The rings' feed (shared cache with the strip): what each status entry is about.
  const statusFeed = useStatusFeed(open || closing)
  const [statusOpen, setStatusOpen] = useState<string | null>(null)
  const statusHandled = useCallback(() => setStatusOpen(null), [])
  const postById = new Map<string, StatusItem>()
  for (const r of statusFeed.data?.rings ?? []) for (const p of r.posts) postById.set(p.id, p)
  for (const p of statusFeed.data?.gallery ?? []) postById.set(p.id, p)

  const dismiss = useCallback(() => {
    setClosing(true)
    setOpen(false)
  }, [])

  /* The phone's back gesture closes the drawer rather than the app. Routed
     through `dismiss` so a back press plays the same exit the close button
     does, instead of the panel vanishing in a frame. */
  useOverlayHistory(open, dismiss)

  useEffect(() => {
    if (!open) return
    // Escape inside the status viewer or a dialog over the drawer closes that, not the drawer.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !viewing && !document.querySelector('.story')) dismiss() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, viewing])

  // Refused, or this account has no feed: show nothing rather than a dead control.
  if (feed.error) return null

  const items = feed.data?.items ?? []
  const unread = feed.data?.unread ?? 0

  /* Clicking a notification opens the thing it is about.
   *
   * Every row carried a link and nothing used it: the panel listed what had
   * happened and left the reader to work out where it lived, which for a
   * staff message meant knowing that Communication has a Messages screen. The
   * one action a notification exists to prompt was the one thing it did not
   * do. */
  /* Rows written before links were, and any kind the server does not map,
     still land somewhere sensible for a parent: the kind names the screen.
     Each href is undefined for a reader who does not hold that screen, so
     staff see nothing they cannot open. */
  const fallback: Record<string, string | undefined> = {
    transport: useFeatureHref('parent.my_childs_bus.live_bus_tracking'),
    fee: useFeatureHref('parent.fees.fees_payments'),
    attendance: useFeatureHref('parent.attendance.attendance'),
    homework: useFeatureHref('parent.academics.homework_academics'),
    result: useFeatureHref('parent.academics.results_report_cards'),
  }
  const linkFor = (n: Note): string | undefined => {
    /* The digest rows (fee_due, attendance) carry the API-shaped link Go
       writes, "/portal/fees" and "/portal/attendance". No screen lives there,
       so following it fell through to the dashboard; the kind names the
       screen instead. Every other link is a /go/ or screen path already. */
    if (n.link && !n.link.startsWith('/portal/')) return n.link
    const k = n.kind.toLowerCase()
    if (k.startsWith('transport') || k.includes('bus')) return fallback.transport
    if (k.startsWith('fee')) return fallback.fee
    if (k.startsWith('attendance') || k.startsWith('absen')) return fallback.attendance
    if (k.startsWith('homework')) return fallback.homework
    if (k.startsWith('report_card') || k.startsWith('result')) return fallback.result
    return undefined
  }
  const openNote = (n: Note) => {
    /* A status opens the viewer at that post, over the drawer; seeing it
       is what reads the entry (POST /status/posts/{id}/view). */
    const post = statusPostId(n)
    if (post && postById.has(post)) {
      setStatusOpen(post)
      return
    }
    /* Everything else opens in full, here. A press used to shut the drawer
       and jump to a screen, so a message with no screen of its own simply
       vanished and a long one was never readable anywhere. The screen it is
       about is one button away in the dialog (`follow`). */
    setViewing(n)
    // Read on open rather than on sight: a count that clears because somebody
    // glanced at the bell is a count that stops meaning anything.
    if (!n.read_at) readOne.mutate(n.id)
  }
  const viewingLink = viewing ? linkFor(viewing) : undefined
  const follow = () => {
    const link = viewingLink
    setViewing(null)
    dismiss()
    if (!link) return
    /* Two overlays shut at once, and each hands its history entry back
       asynchronously (lib/overlay-history). Going to the screen before both
       have gone would let one of those Backs eat the navigation instead. */
    if (!window.history.state?.erpOverlay) { navigate(link); return }
    const go = () => {
      window.removeEventListener('popstate', settled)
      window.clearTimeout(giveUp)
      navigate(link)
    }
    const settled = () => { if (!window.history.state?.erpOverlay) go() }
    const giveUp = window.setTimeout(go, 400)
    window.addEventListener('popstate', settled)
  }

  /* Grouped as it is read: newest day first, in the order the server sent.
     Re-sorting here would fight an endpoint that already knows what is
     urgent. */
  const listed = FILTERS.flatMap((x) => x.kinds ?? [])
  const inKinds = (kind: string, ks: string[]) => ks.some((k) => kind === k || kind.startsWith(k + '_'))
  const isMessage = (n: Note) => inKinds(n.kind, ['message', 'chat', 'parent_message', 'teacher_message'])
  /* Messages first if there are any, otherwise activity, so the drawer never
     opens on an empty side by default. */
  /* The owner's split: Messages is every notification; Activity is status
     posts (the e-learning hub's photo, video and note statuses). */
  const shownType = type ?? 'messages'
  const newStatuses = (statuses.data?.items ?? []).filter((x) => !x.seen && Date.now() - new Date(x.posted_at ?? x.posted_on).getTime() < 7 * 86400000).length
  const countFor = (v: string) => v === 'messages' ? unread : v === 'activity' ? newStatuses : 0
  void isMessage
  const inToggles = (n: Note) => (!onlyUnread || !n.read_at)
  void setFilter
  const inFilter = (n: Note) => !inToggles(n) ? false : filter === 'all' ? true
    : filter === 'other' ? !inKinds(n.kind, listed)
    /* By prefix: the server sends fee_due, fee_overdue, report_card and so on. */
    : (FILTERS.find((x) => x.key === filter)?.kinds ?? []).some((k) => n.kind === k || n.kind.startsWith(k + '_') || n.kind.startsWith(k.replace(/s$/, '') + '_'))
  const groups: { day: string; notes: Note[] }[] = []
  for (const n of items.filter(inFilter)) {
    const day = dayOf(n.created_at)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.notes.push(n)
    else groups.push({ day, notes: [n] })
  }

  const shownGroups = groups

  return (
    <>
      <button
        onClick={() => (open ? dismiss() : setOpen(true))}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        data-help-anchor="bell"
        aria-expanded={open}
        // data-tip as well as title: the dock draws its own label instantly,
        // and the browser's own tooltip takes about a second to appear, so in
        // the dock the bell was the one item that looked unlabelled next to
        // eleven that were not.
        data-tip="Notifications"
        title="Notifications"
        className="relative grid h-9 w-9 place-items-center rounded-[7px] text-muted-foreground
                   hover:bg-surface-hover hover:text-foreground"
      >
        {/* Bigger on a phone: the owner asked for larger top-bar buttons there. */}
        <Bell className="h-[22px] w-[22px] md:h-4 md:w-4" />
        {unread > 0 && (
          <span
            /* 12px, the smallest size text is drawn at anywhere else: at 10 the
               count was the one figure in the chrome a phone could not read.
               Placed from the glyph's centre, not the button's corner: the
               button is 32px in the desk dock and 44 on a phone, and pinned
               to the corner the badge sat squarely on the bell in the first
               and floated clear of it in the second. */
            className="absolute left-[calc(50%+1px)] top-[calc(50%-16px)] grid h-4 min-w-4 place-items-center rounded-full
                       bg-destructive px-1 text-[12px] font-medium leading-none text-destructive-foreground"
            aria-hidden
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {(open || closing) && createPortal(
        <div
          className={cn(
            'fixed inset-0 z-[100] flex justify-end',
            // The ground dims with the drawer rather than appearing under it.
            'transition-colors',
            open ? 'bg-[hsl(var(--scrim))]' : 'pointer-events-none bg-transparent',
          )}
          onClick={dismiss}
        >
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Notifications"
            data-side="right"
            data-closing={closing && !open ? '' : undefined}
            onAnimationEnd={() => { if (!open) setClosing(false) }}
            onClick={(e) => e.stopPropagation()}
            /* THE OWNER'S MOCK: a quiet header with a count pill, a segmented
               filter, day groups with the date on the right, and each
               notification a card. No unread dot (they asked for none): an
               unread card is picked out by its border and bolder title.
               Full screen on a phone -- 100dvh, above the app header -- so it
               no longer starts under the top bar. */
            className="flex h-[100dvh] w-full flex-col border-l bg-background shadow-[var(--lift-float)] sm:h-full sm:w-[400px]"
            style={{
              paddingTop: 'env(safe-area-inset-top, 0px)',
              paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            }}
          >
            {/* TWO ROWS, so the title never breaks: the name and the close on
                top, the count and the two actions under it. On a narrow drawer
                one row squeezed "Notifications" onto two lines. */}
            <header className="shrink-0 border-b bg-card px-5 pb-3 pt-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="whitespace-nowrap text-[20px] font-bold tracking-[-0.02em]">Notifications</h2>
                <button onClick={dismiss} aria-label="Close notifications"
                  className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
                  <X className="size-4" />
                </button>
              </div>
              {items.length > 0 && (
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-[12.5px] font-semibold text-muted-foreground">
                    {unread > 0
                      ? <span className="rounded-full bg-primary/10 px-2.5 py-1 text-primary">{unread} new</span>
                      : 'All caught up'}
                  </span>
                  <span className="flex items-center gap-1">
                    {unread > 0 && (
                      <button onClick={() => readAll.mutate()}
                        className="rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground">
                        Mark read
                      </button>
                    )}
                    <button onClick={() => clearAll.mutate()} disabled={clearAll.isPending} aria-label="Clear all notifications"
                      className="rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-muted-foreground hover:bg-[hsl(var(--sys-danger)/0.1)] hover:text-[hsl(var(--sys-danger-ink))] disabled:opacity-50">
                      {clearAll.isPending ? 'Clearing…' : 'Clear all'}
                    </button>
                  </span>
                </div>
              )}
            </header>

            {/* Class Status: Add, then the rings, unseen first. Draws nothing
                when the school has it off or there is nothing to show. */}
            <StatusRings compact raised openId={statusOpen} onOpenHandled={statusHandled} className="shrink-0 border-b bg-card" />

            <div className="scroll-y min-h-0 flex-1 space-y-4 overscroll-contain p-4">
              {shownType === 'activity' ? (
                statuses.isLoading ? <p className="py-16 text-center text-[13px] text-muted-foreground">Loading status updates…</p>
                : (statuses.data?.items ?? []).filter((x) => Date.now() - new Date(x.posted_at ?? x.posted_on).getTime() < 7 * 86400000).length === 0
                  ? <p className="py-16 text-center text-[13px] text-muted-foreground">No status updates this week.</p>
                  : (
                    <div className="m-stagger space-y-2">
                      {(statuses.data?.items ?? [])
                        .filter((x) => Date.now() - new Date(x.posted_at ?? x.posted_on).getTime() < 7 * 86400000)
                        .map((x) => (
                          <button key={x.id} type="button" onClick={() => { dismiss(); if (toHub) navigate(toHub) }}
                            className="flex w-full items-center gap-3.5 rounded-2xl border bg-card px-4 py-3.5 text-left transition-all hover:-translate-y-px hover:bg-muted/30">
                            <span className={cn('grid size-10 shrink-0 place-items-center rounded-full text-[12px] font-bold',
                              x.seen ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary ring-2 ring-primary ring-offset-2 ring-offset-card')}>
                              {(x.uploaded_by ?? 'School').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-baseline justify-between gap-2">
                                <span className="truncate text-[13.5px] font-semibold">{x.uploaded_by ?? 'School'}</span>
                                <span className="shrink-0 text-[11px] text-muted-foreground">{timeOf(x.posted_at ?? x.posted_on)}</span>
                              </span>
                              <span className="block truncate text-[12.5px] text-muted-foreground">{x.title}</span>
                            </span>
                          </button>
                        ))}
                    </div>
                  )
              ) : items.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
                  <p className="text-[14px] font-medium">Nothing yet</p>
                  <p className="mx-auto mt-1.5 max-w-[22rem] text-[13px] text-muted-foreground">
                    Homework, notices, fees and timetable changes appear here as
                    the school sends them.
                  </p>
                </div>
              ) : shownGroups.length === 0 ? (
                <p className="py-16 text-center text-[13px] text-muted-foreground">Nothing in this filter.</p>
              ) : (
                shownGroups.map((g) => (
                  <section key={g.day}>
                    <div className="mb-2.5 flex items-center justify-between px-1">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{g.day}</span>
                      <span className="text-[11px] font-medium text-muted-foreground">{dateOf(g.notes[0].created_at)}</span>
                    </div>
                    <div className="m-stagger space-y-2">
                      {g.notes.map((n) => {
                        const { icon: Icon, label } = kindOf(n.kind)
                        const postId = statusPostId(n)
                        if (postId) {
                          const post = postById.get(postId)
                          const chip = post?.media_kind === 'video' ? 'Video' : post?.media_kind === 'text' ? 'Text' : post ? 'Photo' : 'Status'
                          /* The title is "<poster> added a status · <audience>". */
                          const [who, aud] = n.title.split(' added a status · ')
                          const excerpt = post ? post.caption : n.body && !['Photo', 'Video', 'Text'].includes(n.body) ? n.body : undefined
                          return (
                            <button key={n.id} type="button" onClick={() => openNote(n)}
                              className={cn('flex min-h-[44px] w-full items-start gap-3 rounded-xl border bg-card p-3 text-left transition-all hover:shadow-md',
                                n.read_at ? 'border-border/70' : 'border-primary/30 shadow-sm')}>
                              <StatusThumb post={post} read={!!n.read_at} />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-baseline justify-between gap-2">
                                  <span className={cn('min-w-0 truncate text-[13.5px]', n.read_at ? 'font-semibold' : 'font-bold')}>{who || n.title}</span>
                                  <span className="shrink-0 text-[11px] text-muted-foreground">{timeOf(n.created_at)}</span>
                                </span>
                                <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px]">
                                  <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px font-semibold text-primary">{chip}</span>
                                  <span className="min-w-0 truncate text-muted-foreground">{post?.audience || aud || ''}{n.student_name ? ` · ${n.student_name}` : ''}</span>
                                </span>
                                {excerpt && post?.media_kind !== 'text' && (
                                  <span className="mt-1 line-clamp-2 block text-[12.5px] leading-snug text-muted-foreground">{excerpt}</span>
                                )}
                                {!post && statusFeed.data && <span className="mt-1 block text-[11.5px] text-muted-foreground">No longer showing</span>}
                              </span>
                            </button>
                          )
                        }
                        return (
                          <button key={n.id} type="button" onClick={() => openNote(n)}
                            className={cn('flex w-full items-start gap-3.5 rounded-2xl border bg-card px-4 py-3.5 text-left transition-all hover:-translate-y-px hover:bg-muted/30',
                              n.read_at ? 'border-border/70' : 'border-primary/30 shadow-sm')}>
                            <span className={cn('grid size-8 shrink-0 place-items-center rounded-full',
                              n.read_at ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary')} aria-hidden>
                              <Icon className="size-3.5" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-baseline justify-between gap-2">
                                <span className={cn('min-w-0 truncate text-[13.5px]', n.read_at ? 'font-semibold' : 'font-bold')}>{n.title}</span>
                                <span className="shrink-0 text-[11px] text-muted-foreground">{timeOf(n.created_at)}</span>
                              </span>
                              <span className="block text-[11.5px] font-medium text-primary">
                                <span className="capitalize">{label}</span>{n.student_name ? ` · ${n.student_name}` : ''}
                              </span>
                              {n.body && (
                                <span className="mt-1 block text-[12.5px] leading-relaxed text-muted-foreground">{n.body}</span>
                              )}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </section>
                ))
              )}
            </div>
            {items.length > 0 && (
              <footer className="flex shrink-0 items-center gap-3.5 border-t bg-card px-5 py-4">
                <div className="flex flex-1 gap-1 rounded-full bg-muted p-1">
                  {[["unread","Unread"],["all","All"]].map(([v, label]) => (
                    <button key={v} type="button" onClick={() => setOnlyUnread(v === 'unread')}
                      className={cn('relative min-h-[40px] flex-1 rounded-full px-3 text-[14px] font-semibold transition-all',
                        (v === 'unread') === onlyUnread ? 'bg-card text-foreground shadow-[0_4px_10px_-2px_rgba(15,23,42,0.12)]' : 'text-muted-foreground hover:text-foreground')}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-1 gap-1 rounded-full bg-muted p-1">
                  {[["messages","Messages"],["activity","Activity"]].map(([v, label]) => (
                    <button key={v} type="button" onClick={() => setType(v as 'messages' | 'activity')}
                      className={cn('relative min-h-[40px] flex-1 rounded-full px-3 text-[14px] font-semibold transition-all',
                        v === shownType ? 'bg-card text-foreground shadow-[0_4px_10px_-2px_rgba(15,23,42,0.12)]' : 'text-muted-foreground hover:text-foreground')}>
                      {label}{countFor(v) > 0 && <span className="absolute -top-1 right-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full border-2 border-white bg-[hsl(var(--sys-danger-fill))] px-[5px] text-[11px] font-bold leading-none text-white shadow-[0_2px_5px_rgba(239,68,68,0.3)]">{countFor(v)}</span>}
                    </button>
                  ))}
                </div>
              </footer>
            )}
          </aside>
        </div>,
        document.body,
      )}

      {viewing && (() => {
        const { icon: KindIcon, label: kindLabel } = kindOf(viewing.kind)
        return (
          <Dialog
            raised
            onClose={() => setViewing(null)}
            title={viewing.title}
            description={`${dayOf(viewing.created_at)}, ${timeOf(viewing.created_at)}`}
            footer={viewingLink ? (
              <>
                <Button variant="ghost" onClick={() => setViewing(null)}>Close</Button>
                <Button onClick={follow}>
                  Open {kindLabel}<ArrowUpRight className="size-4" />
                </Button>
              </>
            ) : undefined}
          >
            {/* What it is and whose it is, before what it says. */}
            <div className="mb-3.5 flex flex-wrap items-center gap-2 text-[12.5px] font-semibold">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 capitalize text-primary">
                <KindIcon className="size-3.5" aria-hidden />{kindLabel}
              </span>
              {viewing.student_name && (
                <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">{viewing.student_name}</span>
              )}
            </div>
            {viewing.body
              ? <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.65]">{viewing.body}</p>
              : <p className="text-[13.5px] text-muted-foreground">Nothing more was sent with this notification.</p>}
          </Dialog>
        )
      })()}
    </>
  )
}
