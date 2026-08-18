import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ticket, CalendarDays, DoorOpen } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button,
  ConfirmButton, FormNotice, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface ClubEvent {
  id: string
  club_name: string
  title: string
  description?: string
  venue?: string
  starts_at: string
  ends_at?: string
  capacity?: number
  ticket_price_paise: number
  booking_closes_at?: string
  status: string
  tickets_booked: number
  seats_left?: number
  ticket_id?: string
  ticket_code?: string
  ticket_status?: string
  checked_in_at?: string
  can_book: boolean
}

/** "2026-12-05T16:00" as a person would say it. */
function when(iso: string) {
  const [date, time] = iso.split('T')
  const d = new Date(`${date}T00:00:00`)
  return `${d.toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short',
  })}, ${time ?? ''}`.trim()
}

/* Club nights, and the pass that gets you in.

   The code is what the door reads. It is shown large and in a monospaced face
   with the confusable characters already excluded by the server, because the
   scanner fails often enough that somebody always ends up reading it aloud to
   a prefect with a clipboard — and "0 or O" at that moment is the whole
   problem the alphabet was chosen to avoid.

   Nothing on this screen can mark a ticket used. That is the door's act, on
   the door's own permission: a guest who could check themselves in could let a
   friend through on the same code. */
export default function ClubEvents() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)

  const events = useQuery({
    queryKey: ['club-events', studentId],
    queryFn: () =>
      api.get<List<ClubEvent>>(`/api/v1/portal/campus/events${studentQuery(studentId)}`),
    enabled: ready,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['club-events'] })

  const book = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/portal/campus/events/${id}/ticket`, {
        student_id: studentId || undefined,
      }),
    onSuccess: refresh,
  })

  const cancel = useMutation({
    mutationFn: (ticketId: string) =>
      api.post(`/api/v1/portal/campus/tickets/${ticketId}/cancel`, {
        student_id: studentId || undefined,
      }),
    onSuccess: refresh,
  })

  if (events.isLoading && ready) return <Loading label="Looking up what is on…" />
  if (events.error) return <ErrorState error={events.error} />

  const rows = events.data?.items ?? []
  const booked = rows.filter((e) => e.ticket_id && e.ticket_status !== 'cancelled')
  const attended = rows.filter((e) => e.ticket_status === 'checked_in').length

  return (
    <>
      <PageHead
        eyebrow="Campus life"
        title="Club events"
        description="What the clubs have on for your year group, and the pass that gets you in."
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState title="Choose a child" body="Events are offered by year group." />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Open to you" value={rows.length} icon={CalendarDays} />
              <Stat label="You have tickets for" value={booked.length} icon={Ticket} />
              <Stat label="Been to" value={attended} icon={DoorOpen}
                hint="Checked in at the door" />
            </CellGrid>

            {booked.length > 0 && (
              <Card>
                <CardHeader
                  title="Your passes"
                  description="Show this at the door. The code is the ticket."
                />
                <div className="grid gap-px bg-border sm:grid-cols-2">
                  {booked.map((e) => (
                    <div key={e.id} className="bg-card p-5">
                      <p className="text-[13px] text-muted-foreground">{e.club_name}</p>
                      <p className="text-[15px] font-semibold">{e.title}</p>
                      <p className="mt-1 text-[13px] text-muted-foreground">
                        {when(e.starts_at)}
                        {e.venue ? ` · ${e.venue}` : ''}
                      </p>
                      <p className="mt-4 font-mono text-[26px] font-semibold tracking-[0.2em]">
                        {e.ticket_code}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {e.ticket_status === 'checked_in' ? (
                          <Badge tone="success" solid>Checked in</Badge>
                        ) : (
                          <Badge tone="info">Not used yet</Badge>
                        )}
                        {e.ticket_status === 'booked' && (
                          <ConfirmButton
                            size="sm"
                            variant="ghost"
                            tone="danger"
                            question="Give the seat back?"
                            confirmLabel="Cancel it"
                            onConfirm={() => cancel.mutate(e.ticket_id as string)}
                          >
                            Cancel
                          </ConfirmButton>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="border-t px-5 py-3">
                  <FormNotice error={cancel.error} />
                </div>
              </Card>
            )}

            <Card>
              <CardHeader title="What is on" description="Soonest first." />
              {rows.length === 0 ? (
                <EmptyState
                  title="Nothing on at the moment"
                  body="When a club puts on something for your year group it appears here."
                />
              ) : (
                <ul className="divide-y">
                  {rows.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                      <div className="min-w-0">
                        <p className="text-[14px] font-medium">
                          {e.title}
                          <Badge tone="info">{e.club_name}</Badge>
                          {e.status !== 'open' && <Badge>{e.status}</Badge>}
                        </p>
                        {e.description && (
                          <p className="mt-1 text-[13px] text-muted-foreground">{e.description}</p>
                        )}
                        <p className="mt-1 text-[12.5px] text-muted-foreground">
                          {when(e.starts_at)}
                          {e.venue ? ` · ${e.venue}` : ''}
                          {' · '}
                          {e.ticket_price_paise > 0 ? formatPaise(e.ticket_price_paise) : 'free'}
                          {e.capacity
                            ? ` · ${e.seats_left ?? 0} of ${e.capacity} seats left`
                            : ' · no seat limit'}
                        </p>
                      </div>
                      <div className="shrink-0">
                        {e.ticket_id && e.ticket_status !== 'cancelled' ? (
                          <Badge tone="success">You have a pass</Badge>
                        ) : (
                          <Button size="sm" disabled={!e.can_book || book.isPending}
                            onClick={() => book.mutate(e.id)}>
                            {book.isPending
                              ? 'Booking…'
                              : e.can_book
                                ? 'Book a seat'
                                : e.seats_left === 0
                                  ? 'Full'
                                  : 'Closed'}
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t px-5 py-3">
                <FormNotice error={book.error} />
              </div>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
