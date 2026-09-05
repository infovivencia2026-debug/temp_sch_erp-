import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useVisibleInterval } from '@/lib/visible'

/* My bus and route, for a driver.

   Read-only, and read from one endpoint that resolves the bus from the
   caller's own employee row (internal/api/transport_driver.go). The live
   position is the office's list filtered down to this one vehicle; the
   driver holds transport.read, which is what that list is gated on. */

export interface MyBusStop {
  name: string
  sequence: number
  pickup_time?: string
  drop_time?: string
  riders: number
}
export interface MyBusCheck {
  on_date: string
  leg: string
  cleared: boolean
  failed_items: string[]
}
export interface MyBus {
  note?: string
  employee_code?: string
  vehicle_id?: string
  registration_no?: string
  model?: string
  capacity?: number
  attendant?: string
  next_expiry?: string
  route_id?: string
  route_name?: string
  route_code?: string
  riders: number
  stops: MyBusStop[]
  trip_direction?: string
  trip_started_at?: string
  tracker_paired: boolean
  checks: MyBusCheck[]
}
interface LiveVehicle {
  vehicle_id: string
  speed_kmph?: number
  age_seconds?: number
  state: string
  battery_pct?: number
}

export default function DriverRun() {
  // A driver's phone left on this screen in a pocket was polling for nobody;
  // on a server billed per request that is the bill, so the poll stops with
  // the tab.
  const liveEvery = useVisibleInterval(30_000)
  const bus = useQuery({
    queryKey: ['my-bus'],
    queryFn: () => api.get<MyBus>('/api/v1/ops/transport/my-bus'),
  })
  const live = useQuery({
    queryKey: ['transport-live'],
    queryFn: () => api.get<List<LiveVehicle>>('/api/v1/transport/live'),
    enabled: Boolean(bus.data?.vehicle_id),
    refetchInterval: liveEvery,
  })

  if (bus.isLoading) return <SkeletonTiles count={4} label="Finding your bus…" />
  if (bus.error) return <ErrorState error={bus.error} />
  const d = bus.data!

  if (d.note) {
    return (
      <>
        <PageHead eyebrow="Transport" title="My bus & route" />
        <PageBody>
          <EmptyState title="No bus against your name" body={d.note} />
        </PageBody>
      </>
    )
  }

  const mine = (live.data?.items ?? []).find((v) => v.vehicle_id === d.vehicle_id)
  const position =
    !mine ? '—'
    : mine.age_seconds == null ? 'No position yet'
    : mine.age_seconds < 120 ? `${Math.round(mine.speed_kmph ?? 0)} km/h`
    : `Last seen ${Math.round(mine.age_seconds / 60)} min ago`

  return (
    <>
      <PageHead eyebrow="Transport" title="My bus & route" />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Bus" value={d.registration_no ?? '—'} hint={d.model} />
          <Stat
            label="Route"
            value={d.route_name ?? 'Not set'}
            hint={d.route_code ? `Code ${d.route_code}` : undefined}
          />
          <Stat label="Riders" value={d.riders} hint={d.capacity != null ? `${d.capacity} seats` : undefined} />
          <Stat
            label="Tracker"
            value={d.tracker_paired ? position : 'Not paired'}
            hint={d.trip_direction ? `${d.trip_direction} run in progress` : undefined}
          />
        </CellGrid>

        <Card>
          <CardHeader title="Stops, in order" />
          <Table head={['#', 'Stop', 'Pickup', 'Drop', 'Riders']} empty={d.stops.length === 0} emptyLabel="No stop is on this route yet.">
            {d.stops.map((s) => (
              <tr key={s.sequence}>
                <Td className="num">{s.sequence}</Td>
                <Td className="font-medium">{s.name}</Td>
                <Td>{s.pickup_time ?? '—'}</Td>
                <Td>{s.drop_time ?? '—'}</Td>
                <Td className="num">{s.riders}</Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader title="Pre-trip checks, last fortnight" />
          <Table head={['Date', 'Leg', 'Result']} empty={d.checks.length === 0} emptyLabel="No check has been recorded on this bus in the last fortnight.">
            {d.checks.map((c, i) => (
              <tr key={`${c.on_date}-${c.leg}-${i}`}>
                <Td>{formatDate(c.on_date)}</Td>
                <Td>{c.leg}</Td>
                <Td>
                  {c.cleared ? (
                    <Badge tone="success">Cleared</Badge>
                  ) : (
                    <Badge tone="warning">{c.failed_items.length ? c.failed_items.join(', ') : 'Not cleared'}</Badge>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader title="Papers" />
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            {d.next_expiry ? `The next of insurance, fitness, permit or PUC lapses on ${formatDate(d.next_expiry)}.` : 'No expiry date is recorded on this bus.'}
            {d.attendant ? ` Attendant: ${d.attendant}.` : ''}
          </p>
        </Card>
      </PageBody>
    </>
  )
}
