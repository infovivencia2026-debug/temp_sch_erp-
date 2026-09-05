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

function timeOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export default function Notifications() {
  const [open, setOpen] = useState(false)
  /* Kept mounted for one animation after the close.

     Unmounting on the click is what makes a panel vanish: the drawer came in
     over half a second and left in a single frame, which reads as a glitch
     rather than as leaving. `closing` holds it on screen long enough to slide
     back out the way it came. */
  const [closing, setClosing] = useState(false)
  const qc = useQueryClient()

  const feed = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ items: Note[]; unread: number }>('/api/v1/portal/notifications'),
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
    staleTime: 10_000,
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
    if (n.link) return n.link
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
  const groups: { day: string; notes: Note[] }[] = []
  for (const n of items) {
    const day = dayOf(n.created_at)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.notes.push(n)
    else groups.push({ day, notes: [n] })
  }

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
            className="absolute right-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full
                       bg-destructive px-1 text-[10px] font-medium text-white"
            aria-hidden
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {(open || closing) && createPortal(
        <div
          className={cn(
            'fixed inset-0 z-[60] flex justify-end',
            // The ground dims with the drawer rather than appearing under it.
            'transition-colors',
            open ? 'bg-black/40' : 'pointer-events-none bg-transparent',
          )}
          onClick={dismiss}
        >
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Notifications"
            /* data-side is what index.css reads to bring this in from the
               right rather than down from above — a 400px column that rises
               reads as the wrong gesture for something that lives at the edge. */
            data-side="right"
            data-closing={closing && !open ? '' : undefined}
            onAnimationEnd={() => { if (!open) setClosing(false) }}
            onClick={(e) => e.stopPropagation()}
            /* FULL WIDTH ON A PHONE, A DRAWER ON EVERYTHING ELSE.

               This was `w-[min(26rem,100vw)]`, written to mean "26rem, or the
               whole screen if that is narrower". It never reached the whole
               screen: index.css pins the root font to 14px for the dense
               desktop baseline, so 26rem is 364px rather than the 416 the
               figure suggests, and on a 390px phone the drawer stopped 26px
               short. What was left was a sliver of the dashboard down one edge
               and no way to press it, which reads as a panel that failed to
               finish opening rather than as a drawer.

               The same 14px root turned a 44px touch minimum written in rem
               into 38.5px elsewhere in this product. A length that has to
               clear a device edge is stated in pixels here for that reason. */
            className="flex h-full w-full flex-col border-l bg-card shadow-[var(--lift-float)] sm:w-[416px]"
            /* Fixed to the viewport, so the body's notch padding does not reach it:
               in the iPhone app the header sat under the clock and the list ran
               under the home indicator. Zero in a browser and on Android. */
            style={{
              paddingTop: 'env(safe-area-inset-top, 0px)',
              paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            }}
          >
            <header className="flex shrink-0 items-center gap-3 border-b px-5 py-4">
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-semibold">Notifications</h2>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  {unread > 0 ? `${unread} unread` : 'Everything here has been read'}
                </p>
              </div>
              {unread > 0 && (
                <button
                  onClick={() => readAll.mutate()}
                  className="shrink-0 rounded-[7px] px-2 py-1 text-[12px] text-muted-foreground
                             hover:bg-surface-hover hover:text-foreground"
                >
                  Mark all read
                </button>
              )}
              {items.length > 0 && (
                <button
                  onClick={() => clearAll.mutate()}
                  disabled={clearAll.isPending}
                  aria-label="Clear all notifications"
                  className="shrink-0 rounded-[7px] px-2 py-1 text-[12px] text-muted-foreground
                             hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
                >
                  {clearAll.isPending ? 'Clearing…' : 'Clear all'}
                </button>
              )}
              <button
                onClick={dismiss}
                aria-label="Close notifications"
                className="grid size-8 shrink-0 place-items-center rounded-[7px] text-muted-foreground
                           hover:bg-surface-hover hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </header>

            {/* Same reason as the settings dialog: a panel is not a page, and
                a fortnight's feed is longer than one. */}
            <div className="scroll-y min-h-0 flex-1 overscroll-contain">
              {items.length === 0 ? (
                /* Centred in the panel, not sitting near its top. An empty
                   state anchored to the first sixth of a full-height sheet
                   leaves a thousand pixels of nothing under two lines of
                   text, which is what the drawer looked like on a phone. */
                <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
                  <p className="text-[14px] font-medium">Nothing yet</p>
                  <p className="mx-auto mt-1.5 max-w-[22rem] text-[13px] text-muted-foreground">
                    Homework, notices, fees and timetable changes appear here as
                    the school sends them.
                  </p>
                </div>
              ) : (
                groups.map((g) => (
                  <section key={g.day}>
                    {/* Sticky, because a fortnight's feed is longer than the
                        panel and a day heading that has scrolled away leaves
                        every row below it undated. */}
                    <h3 className="sticky top-0 z-10 border-b bg-surface-subtle px-5 py-1.5
                                   text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {g.day}
                    </h3>
                    <ul className="divide-y">
                      {g.notes.map((n) => {
                        const { icon: Icon, label } = kindOf(n.kind)
                        return (
                          <li key={n.id}>
                            <button
                              type="button"
                              onClick={() => openNote(n)}
                              className={cn(
                                'flex w-full gap-3 px-5 py-3.5 text-left hover:bg-accent',
                                !n.read_at && 'bg-surface-hover',
                              )}
                            >
                              <span
                                className={cn(
                                  'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full',
                                  n.read_at
                                    ? 'bg-surface-subtle text-muted-foreground'
                                    : 'bg-primary/10 text-primary',
                                )}
                                aria-hidden
                              >
                                <Icon className="size-3.5" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="flex items-baseline gap-2">
                                  <span className="min-w-0 flex-1 text-[13.5px] font-medium">
                                    {n.title}
                                  </span>
                                  <span className="shrink-0 text-[11px] text-muted-foreground">
                                    {timeOf(n.created_at)}
                                  </span>
                                </span>
                                {/* Three lines, not one. The body is the
                                    message; clamping it to a single line meant
                                    every notification had to be opened to be
                                    read, including the ones that had nowhere
                                    to open to. */}
                                {n.body && (
                                  <span className="mt-1 block text-[12.5px] leading-relaxed text-muted-foreground">
                                    {n.body}
                                  </span>
                                )}
                                <span className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                  <span className="capitalize">{label}</span>
                                  {n.student_name && (
                                    <>
                                      <span aria-hidden>·</span>
                                      <span className="truncate">{n.student_name}</span>
                                    </>
                                  )}
                                  {!n.read_at && (
                                    <span className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />
                                  )}
                                </span>
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
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
