import { useQuery } from '@tanstack/react-query'
import { Bell, CalendarClock } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Loading, ErrorState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { commsQueryKeys } from './comms-keys'

/* parent.school_life.ptm_appointment_reminder_alert

   The family's view of the meetings they have booked and the reminder that is
   waiting to go out before each one.

   There is no booking form here — /portal/school-life/ptm already books, and a
   second one would give the school two diaries that disagree on the morning of
   the meeting. What this screen adds is the reminder: booking a slot queues a
   'ptm.upcoming' message event, and the school's trigger rule decides the
   channel and how far ahead it goes. Fifteen minutes is what the catalogue
   asks for; the same emit serves a day-before rule without any code changing. */

interface Booking {
  id: string
  student_id: string
  student: string
  teacher: string
  on_date: string
  starts_at: string
  minutes: number
  purpose?: string
  status: string
  outcome?: string
  cancellable: boolean
  concerns?: string
  agreed_actions?: string
}

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'info'> = {
  booked: 'info',
  completed: 'success',
  cancelled: 'neutral',
  no_show: 'warning',
}

// A meeting is upcoming if its date has not passed and nobody has cancelled it.
const upcoming = (b: Booking) =>
  b.status === 'booked' && new Date(`${b.on_date}T${b.starts_at}`) > new Date()

export default function PTMReminders() {
  const bookings = useQuery({
    queryKey: commsQueryKeys.ptmBookings(),
    queryFn: () => api.get<List<Booking>>('/api/v1/portal/school-life/ptm/bookings'),
  })

  const rows = bookings.data?.items ?? []
  const next = rows.filter(upcoming).sort((a, b) => a.on_date.localeCompare(b.on_date))

  return (
    <>
      <PageHead
        eyebrow="School life"
        title="Parent-teacher meetings"
        description="The meetings you have booked, and the reminder queued for each one."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Meetings coming up" value={next.length} icon={CalendarClock} />
          <Stat
            label="Next meeting"
            value={next[0] ? formatDate(next[0].on_date) : '—'}
            hint={next[0] ? `${next[0].starts_at.slice(0, 5)} with ${next[0].teacher}` : undefined}
          />
          <Stat
            label="Reminders"
            value={next.length ? 'Queued' : 'None due'}
            icon={Bell}
            hint="Held until shortly before the slot"
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Your meetings"
            description="Booked through School life › Parent-teacher meetings. Cancelling there also withdraws the reminder."
          />
          {bookings.isLoading ? (
            <Loading />
          ) : bookings.error ? (
            <ErrorState error={bookings.error} />
          ) : (
            <Table
              head={['Date', 'Time', 'Child', 'Teacher', 'Reminder', 'Status']}
              empty={rows.length === 0}
              emptyLabel="No meetings booked."
            >
              {rows.map((b) => (
                <tr key={b.id}>
                  <Td>{formatDate(b.on_date)}</Td>
                  <Td>{b.starts_at.slice(0, 5)}</Td>
                  <Td>{b.student}</Td>
                  <Td>{b.teacher}</Td>
                  <Td>
                    {upcoming(b) ? (
                      <Badge tone="info">queued</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[b.status] ?? 'neutral'}>{b.status}</Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="How the reminder works" />
          <div className="space-y-2 p-5 text-[14px] leading-relaxed text-muted-foreground">
            {/* The emit is real and the queue row is real; what is not yet real is
                anything dispatching that queue on a schedule — a gap that
                predates this screen and affects every trigger rule. So this
                says what the product does, which is queue the reminder, and
                stops short of promising it arrives. Wording, because the
                alternative is a screen that tells a parent to expect a message
                the system will not send. */}
            <p>
              Booking a slot queues a reminder straight away and holds it until shortly before
              the meeting. Cancelling withdraws it, and rebooking queues a fresh one.
            </p>
            <p>
              Whether it reaches you, on which channel and how far ahead, is set by the school
              on its messaging rules rather than here — and a school that has not set a rule for
              parent-teacher meetings sends nothing at all. Treat this page as the record of
              your meetings rather than as proof a message went out, and check the date here if
              you are relying on it.
            </p>
          </div>
        </Card>
      </PageBody>
    </>
  )
}
