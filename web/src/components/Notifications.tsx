import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell } from 'lucide-react'
import { api } from '@/lib/api'

/* The bell in the header.

   Notices used to be a menu entry of their own, which meant a family had to
   go looking for something the school had already decided was urgent. The
   feed itself is not new — /api/v1/portal/notifications runs its delivery
   pass on read, so a screen opened after a fortnight away is not empty.

   The button hides itself for anyone the endpoint refuses. Staff have no
   family feed, and a bell that opens on "you are not allowed to see this" is
   worse than no bell. */

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

export default function Notifications() {
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()

  const feed = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ items: Note[]; unread: number }>('/api/v1/portal/notifications'),
    /* Twenty seconds, and again whenever the tab is looked at.
    
       A minute was chosen as cheap, and it is — but somebody who has just
       been told "I have sent it to you" waits a minute staring at a bell that
       does not move, and reloads. Refetching on focus covers the common case
       exactly: the message arrives while they are in another tab, and it is
       there the moment they come back. */
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
  const navigate = useNavigate()
  const openNote = (n: Note) => {
    setOpen(false)
    if (n.link) navigate(n.link)
    // Read on open rather than on sight: a count that clears because somebody
    // glanced at the bell is a count that stops meaning anything.
    if (!n.read_at) readAll.mutate()
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        title="Notifications"
        className="relative grid h-9 w-9 place-items-center rounded-[7px] text-muted-foreground transition-colors duration-100 hover:bg-surface-hover hover:text-foreground"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span
            className="absolute right-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-medium text-white"
            aria-hidden
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Clicking anywhere else closes it, which is what every other
              dismissible surface in this product does. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="chrome absolute right-0 z-50 mt-1 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-[10px] border shadow-lg">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-[13px] font-medium">Notifications</span>
              {unread > 0 && (
                <button
                  onClick={() => readAll.mutate()}
                  className="text-[12px] text-muted-foreground hover:text-foreground"
                >
                  Mark all read
                </button>
              )}
            </div>
            <div className="max-h-[60vh] overflow-auto">
              {items.length === 0 ? (
                <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">
                  Nothing yet. Homework, notices, fees and timetable changes appear here.
                </p>
              ) : (
                <ul className="divide-y">
                  {items.map((n) => (
                    <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => openNote(n)}
                      className={
                        (n.read_at ? 'px-3 py-2.5' : 'bg-surface-hover px-3 py-2.5') +
                        ' block w-full cursor-pointer text-left hover:bg-accent'
                      }
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="text-[13px] font-medium">{n.title}</span>
                        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                          {n.created_at.slice(0, 10)}
                        </span>
                      </div>
                      {n.body && (
                        <p className="mt-0.5 text-[12px] text-muted-foreground">{n.body}</p>
                      )}
                      {n.student_name && (
                        <p className="text-[11px] text-muted-foreground">{n.student_name}</p>
                      )}
                    </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
