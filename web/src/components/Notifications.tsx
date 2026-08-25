import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
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
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
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
    /* Ten seconds. Not a socket, and honest about it: the bell is the one
       thing people watch after being told "I have sent it", and a minute of
       nothing is what makes somebody reload the page. */
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    retry: false,
  })
  const readAll = useMutation({
    mutationFn: () => api.post('/api/v1/portal/notifications/read-all', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  })

  const navigate = useNavigate()

  const dismiss = () => {
    if (!open) return
    setClosing(true)
    setOpen(false)
  }

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
  const openNote = (n: Note) => {
    dismiss()
    if (n.link) navigate(n.link)
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
            className="flex h-full w-[min(26rem,100vw)] flex-col border-l bg-card shadow-[var(--lift-float)]"
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
                <div className="px-6 py-16 text-center">
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
