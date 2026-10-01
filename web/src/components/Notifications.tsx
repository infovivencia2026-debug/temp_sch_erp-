import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOverlayHistory } from '@/lib/overlay-history'
import { useFeatureHref } from '@/features/bento/bento-kit'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bell, BookOpen, CalendarClock, IndianRupee, Megaphone, MessageSquare, X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useOpenState } from '@/lib/motion'

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
}

function kindOf(kind: string) {
  return KINDS[kind] ?? { icon: Bell, label: kind.replace(/[-_]/g, ' ') }
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
  { key: 'other', label: 'Other' },
]

function timeOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
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
  const qc = useQueryClient()

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
  const readAll = useMutation({
    mutationFn: () => api.post('/api/v1/portal/notifications/read-all', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  })
  /* Clear empties the list; Mark all read only quiets the badge. Both were
     asked for by name: a feed a fortnight long that can only be marked read
     is a feed that has to be scrolled past every time. */
  const clearAll = useMutation({
    mutationFn: () => api.post('/api/v1/portal/notifications/clear', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  })

  const navigate = useNavigate()

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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

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
    dismiss()
    const link = linkFor(n)
    if (link) navigate(link)
    // Read on open rather than on sight: a count that clears because somebody
    // glanced at the bell is a count that stops meaning anything.
    if (!n.read_at) readAll.mutate()
  }

  /* Grouped as it is read: newest day first, in the order the server sent.
     Re-sorting here would fight an endpoint that already knows what is
     urgent. */
  const listed = FILTERS.flatMap((x) => x.kinds ?? [])
  const inKinds = (kind: string, ks: string[]) => ks.some((k) => kind === k || kind.startsWith(k + '_'))
  const inFilter = (n: Note) => filter === 'all' ? true
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
        <Bell className="h-4 w-4" />
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
            <header className="flex shrink-0 items-center justify-between gap-3 border-b bg-card px-5 py-4">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="text-[15px] font-bold tracking-tight">Notifications</h2>
                {unread > 0 && (
                  <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                    {unread} new
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {unread > 0 && (
                  <button onClick={() => readAll.mutate()}
                    className="rounded-lg px-2.5 py-1 text-[12px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground">
                    Mark read
                  </button>
                )}
                {items.length > 0 && (
                  <button onClick={() => clearAll.mutate()} disabled={clearAll.isPending} aria-label="Clear all notifications"
                    className="rounded-lg px-2.5 py-1 text-[12px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
                    {clearAll.isPending ? 'Clearing…' : 'Clear'}
                  </button>
                )}
                <button onClick={dismiss} aria-label="Close notifications"
                  className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
                  <X className="size-4" />
                </button>
              </div>
            </header>

            {items.length > 0 && (
              <div className="flex shrink-0 gap-1 overflow-x-auto border-b bg-muted/40 px-4 py-2">
                {FILTERS.map((f) => (
                  <button key={f.key} type="button" onClick={() => setFilter(f.key)}
                    className={cn('shrink-0 rounded-md px-3 py-1 text-[12px] transition-colors',
                      filter === f.key ? 'border bg-card font-semibold text-foreground shadow-sm' : 'font-medium text-muted-foreground hover:text-foreground')}>
                    {f.label}
                  </button>
                ))}
              </div>
            )}

            <div className="scroll-y min-h-0 flex-1 space-y-4 overscroll-contain p-4">
              {items.length === 0 ? (
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
                    <div className="space-y-2">
                      {g.notes.map((n) => {
                        const { icon: Icon, label } = kindOf(n.kind)
                        return (
                          <button key={n.id} type="button" onClick={() => openNote(n)}
                            className={cn('flex w-full items-start gap-3 rounded-xl border bg-card p-3.5 text-left transition-all hover:shadow-md',
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
          </aside>
        </div>,
        document.body,
      )}
    </>
  )
}
