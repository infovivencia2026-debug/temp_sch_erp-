import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ticket, Armchair } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button, Select,
  Field, FormGrid, FormNotice, Loading, ErrorState, EmptyState, PrintButton,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, childOptions } from './use-children'

/* The family's seats, and the number that gets them through the door.

   Seats are allocated in the order families claim them. That is the only rule
   a school can operate without drawing a seating plan, and it is honest about
   itself: claim on the morning the event is announced and you sit at the front.

   The code is shown as text rather than as a scannable image. Rendering a QR
   code needs a library this project does not carry, and inventing a
   barcode-shaped picture that no scanner reads would be worse than a number
   somebody can type — which is exactly how the emergency pickup pass already
   works at this school's gate. */

interface Pass {
  id: string
  event_id: string
  event_name: string
  on_date: string
  starts_at?: string
  venue?: string
  student_id: string
  student_name: string
  row_label?: string
  seat_from?: number
  seats: number
  code: string
  note?: string
  issued_at: string
  admitted_at?: string
  revoked_at?: string
}

interface CalendarEntry {
  date: string
  kind: string
  title: string
  venue?: string
  starts_at?: string
  ref_id?: string
}

const EVENT_KINDS = [
  'event', 'sports_day', 'annual_day', 'concert', 'exhibition',
  'competition', 'field_trip', 'assembly', 'fete',
]

function seatLabel(p: Pass) {
  if (!p.row_label || !p.seat_from) return `${p.seats} seats`
  const to = p.seat_from + p.seats - 1
  return p.seats === 1
    ? `Row ${p.row_label}, seat ${p.seat_from}`
    : `Row ${p.row_label}, seats ${p.seat_from}–${to}`
}

export default function EventPasses() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const [eventId, setEventId] = useState('')
  const [seats, setSeats] = useState('2')

  const passes = useQuery({
    queryKey: ['event-passes', studentId],
    queryFn: () =>
      api.get<List<Pass>>(
        `/api/v1/portal/school-life/event-passes${studentId ? `?student_id=${studentId}` : ''}`,
      ),
  })
  // The calendar already knows which events are coming and which of them this
  // family is in scope for; asking it again is cheaper than a second endpoint
  // that would have to repeat the same scoping rules.
  const calendar = useQuery({
    queryKey: ['portal-calendar', studentId],
    queryFn: () =>
      api.get<{ items: CalendarEntry[] }>(
        `/api/v1/portal/school-life/calendar${studentId ? `?student_id=${studentId}` : ''}`,
      ),
  })

  const claim = useMutation({
    mutationFn: () =>
      api.post('/api/v1/portal/school-life/event-passes', {
        event_id: eventId,
        student_id: studentId,
        seats: Number(seats) || 2,
      }),
    onSuccess: () => {
      setEventId('')
      qc.invalidateQueries({ queryKey: ['event-passes'] })
    },
  })

  if (passes.isLoading) return <Loading label="Looking up your passes…" />
  if (passes.error) return <ErrorState error={passes.error} />

  const rows = passes.data?.items ?? []
  const today = new Date().toISOString().slice(0, 10)
  const live = rows.filter((p) => !p.revoked_at && !p.admitted_at && p.on_date >= today)

  const claimed = new Set(rows.filter((p) => !p.revoked_at).map((p) => `${p.event_id}:${p.student_id}`))
  const options = (calendar.data?.items ?? [])
    .filter((e) => EVENT_KINDS.includes(e.kind) && e.ref_id && e.date >= today)
    .filter((e) => !studentId || !claimed.has(`${e.ref_id}:${studentId}`))
    .map((e) => ({ value: e.ref_id as string, label: `${e.title} · ${formatDate(e.date)}` }))

  const ready = studentId !== '' && eventId !== ''

  return (
    <>
      <PageHead
        eyebrow="School life"
        title="Event seating"
        description="Claim your seats for a school event and show the number at the door."
        actions={<PrintButton label="Print passes" />}
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Passes to use" value={live.length} icon={Ticket} />
          <Stat label="Seats held" value={live.reduce((n, p) => n + p.seats, 0)} icon={Armchair} />
          <Stat label="Events attended" value={rows.filter((p) => p.admitted_at).length} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Claim seats"
            description="Seats are given out in the order families claim them."
          />
          <div className="px-5 py-4">
            <FormGrid>
              {children.length > 1 && (
                <Field label="Child" required>
                  <Select
                    value={chosen}
                    onChange={setChosen}
                    options={childOptions(children)}
                    placeholder="Which child…"
                  />
                </Field>
              )}
              <Field label="Event" required>
                <Select
                  value={eventId}
                  onChange={setEventId}
                  options={options}
                  placeholder={options.length ? 'Choose an event…' : 'No events open'}
                />
              </Field>
              <Field label="Seats" hint="How many of you are coming.">
                <Select
                  value={seats}
                  onChange={setSeats}
                  options={['1', '2', '3', '4', '5', '6'].map((v) => ({ value: v, label: v }))}
                />
              </Field>
            </FormGrid>
            <FormNotice error={claim.error} ok={claim.isSuccess ? 'Seats confirmed.' : undefined} />
            <div className="mt-3">
              <Button disabled={!ready || claim.isPending} onClick={() => claim.mutate()}>
                Claim seats
              </Button>
            </div>
          </div>
        </Card>

        {rows.length === 0 ? (
          <Card>
            <EmptyState
              title="No passes yet"
              body="Claim seats above and the pass will appear here."
            />
          </Card>
        ) : (
          <CellGrid cols={2}>
            {rows.map((p) => (
              <div key={p.id} className="cell">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold">{p.event_name}</p>
                    <p className="text-[13px] text-muted-foreground">
                      {[formatDate(p.on_date), p.starts_at, p.venue].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  {p.revoked_at ? (
                    <Badge tone="neutral">Withdrawn</Badge>
                  ) : p.admitted_at ? (
                    <Badge tone="success">Admitted</Badge>
                  ) : (
                    <Badge tone="primary">Valid</Badge>
                  )}
                </div>
                <p className="mt-3 text-[14px]">{p.student_name}</p>
                <p className="text-[13px] text-muted-foreground">{seatLabel(p)}</p>
                <p className="mt-3 font-mono text-[24px] tracking-[0.18em]">{p.code}</p>
                <p className="text-[12px] text-muted-foreground">
                  Show this number at the door.
                </p>
              </div>
            ))}
          </CellGrid>
        )}
      </PageBody>
    </>
  )
}
