import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clock, MapPin, TimerReset, TriangleAlert } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Select, Input, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { cn } from '@/lib/utils'

/* Which stops were served late today, and by how much.

   The screen exists because a geofence crossing is only interesting against
   the time the route promised. Two decisions shape it.

   EARLY IS NOT GOOD. A bus fifteen minutes early is a child still indoors and
   a bus that does not wait, which is a missed pickup dressed up as
   punctuality. Style lateness alone and every early row reads as fine, so
   early gets its own colour, its own count and its own side of the deviation
   bar rather than being folded into "within tolerance".

   ORDER IS THE ORDER THE BUS DRIVES. Stops are grouped by route and run, and
   within a run they are sorted along the direction of travel — ascending
   sequence on a pickup, descending on a drop. Sorting by clock time instead
   would look identical on a good morning and scramble exactly on the bad one,
   when a driver ran the route out of order. */

interface StopEvent {
  id: string
  trip_id: string
  registration_no: string
  route: string
  direction: 'pickup' | 'drop' | string
  stop: string
  sequence: number
  kind: 'arrived' | 'departed' | string
  /** Time of day the route promised, "HH:MM" in India. Absent where the stop has no scheduled time. */
  scheduled_at?: string
  /** India-local wall clock from the server, "YYYY-MM-DDTHH:MM". */
  occurred_at: string
  /** Negative early, positive late. Absent where the stop has no schedule to deviate from. */
  deviation_mins?: number
  latitude?: number
  longitude?: number
  driver?: string
}

interface MapStop {
  id: string
  name: string
  route_id: string
  route: string
  sequence: number
  latitude: number
  longitude: number
  geofence_m?: number
}

/* Minutes, not seconds: the geofence itself is a circle tens of metres across,
   so a bus is "at" a stop for a window of that order and a one-minute claim of
   precision would be a claim the measurement cannot support. Four minutes is
   the width of that honest window. */
const TOLERANCE_MINS = 4

type Punctuality = 'early' | 'late' | 'ontime' | 'unscheduled'

function punctuality(dev?: number): Punctuality {
  if (dev == null) return 'unscheduled'
  if (dev <= -TOLERANCE_MINS) return 'early'
  if (dev >= TOLERANCE_MINS) return 'late'
  return 'ontime'
}

const TONE: Record<Punctuality, 'success' | 'danger' | 'warning' | 'neutral'> = {
  early: 'warning',
  late: 'danger',
  ontime: 'success',
  unscheduled: 'neutral',
}
const INK: Record<Punctuality, string> = {
  early: 'text-warning',
  late: 'text-destructive',
  ontime: 'text-success',
  unscheduled: 'text-muted-foreground',
}

function deviationText(dev?: number): string {
  if (dev == null) return 'No scheduled time'
  if (dev === 0) return 'On time'
  return dev < 0 ? `${Math.abs(dev)} min early` : `${dev} min late`
}

function clockOf(iso: string): string {
  // The server already emitted India-local wall clock, so this is a slice, not
  // a conversion. Parsing it into a Date would re-interpret an offset-less
  // string against the viewer's own zone and shift every time on the screen.
  const t = iso.slice(11, 16)
  return t || iso
}

function todayInIndia(): string {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
}

interface Served {
  key: string
  stop: string
  sequence: number
  arrived?: StopEvent
  departed?: StopEvent
  /** Minutes the bus stood at the stop. Late for everybody downstream, invisible in the arrival row alone. */
  dwellMins?: number
}

interface Run {
  key: string
  route: string
  direction: string
  registration: string
  driver: string
  stops: Served[]
}

function minutesBetween(a: string, b: string): number | undefined {
  const at = Date.parse(`${a}:00`)
  const bt = Date.parse(`${b}:00`)
  if (Number.isNaN(at) || Number.isNaN(bt)) return undefined
  return Math.round((bt - at) / 60000)
}

/** One row per stop served, arrivals and departures paired, in driving order. */
function buildRuns(events: StopEvent[]): Run[] {
  const runs = new Map<string, Run>()
  for (const e of events) {
    const run = runs.get(e.trip_id) ?? {
      key: e.trip_id,
      route: e.route,
      direction: e.direction,
      registration: e.registration_no,
      driver: e.driver ?? '',
      stops: [],
    }
    const stopKey = `${e.trip_id}:${e.stop}:${e.sequence}`
    let served = run.stops.find((s) => s.key === stopKey)
    if (!served) {
      served = { key: stopKey, stop: e.stop, sequence: e.sequence }
      run.stops.push(served)
    }
    if (e.kind === 'departed') served.departed = e
    else served.arrived = e
    runs.set(e.trip_id, run)
  }
  for (const run of runs.values()) {
    // A drop run visits the highest sequence first; sorting ascending would
    // print the afternoon backwards and make the last child look like the first.
    const descending = run.direction === 'drop'
    run.stops.sort((a, b) => (descending ? b.sequence - a.sequence : a.sequence - b.sequence))
    for (const s of run.stops) {
      if (s.arrived && s.departed) {
        s.dwellMins = minutesBetween(s.arrived.occurred_at, s.departed.occurred_at)
      }
    }
  }
  return [...runs.values()].sort(
    (a, b) =>
      a.route.localeCompare(b.route) ||
      a.direction.localeCompare(b.direction) ||
      a.registration.localeCompare(b.registration),
  )
}

/* Deviation drawn against a fixed zero in the middle: early to the left, late
   to the right, both to the same scale. A bar that grew from the left edge in
   one colour would make a fifteen-minute early arrival and a fifteen-minute
   late one draw identically. */
function DeviationBar({ mins }: { mins?: number }) {
  if (mins == null) return <span className="text-muted-foreground">—</span>
  const CAP = 20
  const clamped = Math.max(-CAP, Math.min(CAP, mins))
  const half = 46
  const width = (Math.abs(clamped) / CAP) * half
  const kind = punctuality(mins)
  return (
    <svg
      viewBox="0 0 100 14"
      className={cn('h-3.5 w-[100px]', INK[kind])}
      role="img"
      aria-label={deviationText(mins)}
    >
      <line x1="50" y1="1" x2="50" y2="13" stroke="currentColor" strokeWidth="1" opacity="0.35" />
      <rect
        x={mins < 0 ? 50 - width : 50}
        y="4"
        width={Math.max(width, 1)}
        height="6"
        rx="1"
        fill="currentColor"
        opacity={kind === 'ontime' ? 0.45 : 0.85}
      />
      {Math.abs(mins) > CAP && (
        // The bar is capped; the row must not quietly claim the delay was 20.
        <text
          x={mins < 0 ? 2 : 98}
          y="11"
          fontSize="9"
          textAnchor={mins < 0 ? 'start' : 'end'}
          fill="currentColor"
        >
          {mins < 0 ? '‹' : '›'}
        </text>
      )}
    </svg>
  )
}

export default function StopAlerts() {
  const [date, setDate] = useState(todayInIndia)
  const [routeFilter, setRouteFilter] = useState('')
  const [only, setOnly] = useState<'all' | 'off'>('all')

  const events = useQuery({
    queryKey: ['transport-stop-events', date],
    queryFn: () => api.get<List<StopEvent>>(`/api/v1/transport/stop-events?date=${date}`),
  })

  // Read-only: the radius each stop's geofence actually used. There is no
  // per-stop write endpoint on this API, so this column reports and does not
  // edit — see NOTES. The school-wide default lives on the tracking policy.
  const stops = useQuery({
    queryKey: ['transport-map-stops'],
    queryFn: () => api.get<List<MapStop>>('/api/v1/transport/map-stops'),
    staleTime: 10 * 60 * 1000,
  })

  const radiusByStop = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of stops.data?.items ?? []) {
      if (s.geofence_m != null) m.set(`${s.route}|${s.name}`, s.geofence_m)
    }
    return m
  }, [stops.data])

  const all = events.data?.items ?? []

  const routes = useMemo(
    () => [...new Set(all.map((e) => e.route))].sort((a, b) => a.localeCompare(b)),
    [all],
  )

  const runs = useMemo(
    () => buildRuns(all.filter((e) => !routeFilter || e.route === routeFilter)),
    [all, routeFilter],
  )

  /* Counted over arrivals only. A departure carries a deviation too, but
     counting both would report one late stop twice and inflate every figure
     the transport office quotes upstairs. */
  const arrivals = all.filter((e) => e.kind === 'arrived')
  const late = arrivals.filter((e) => punctuality(e.deviation_mins) === 'late')
  const early = arrivals.filter((e) => punctuality(e.deviation_mins) === 'early')
  const worst = late.reduce((m, e) => Math.max(m, e.deviation_mins ?? 0), 0)

  return (
    <>
      <PageHead
        eyebrow="Transport"
        title="Geo-fenced stop alerts"
        description="Every stop a bus entered or left today, against the time the route promised. Recorded when the vehicle crossed the stop's geofence."
        width="wide"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Input type="date" value={date} onChange={setDate} srLabel="Date" className="w-[9.5rem]" />
            <Select
              value={routeFilter}
              onChange={setRouteFilter}
              options={[
                { value: '', label: 'All routes' },
                ...routes.map((r) => ({ value: r, label: r })),
              ]}
            />
            <Select
              value={only}
              onChange={(v) => setOnly(v as 'all' | 'off')}
              options={[
                { value: 'all', label: 'Every stop' },
                { value: 'off', label: 'Off schedule only' },
              ]}
            />
          </div>
        }
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat
            label="Stops served"
            value={arrivals.length}
            icon={MapPin}
            period={date}
            hint="Arrivals recorded by geofence"
          />
          <Stat
            label={`Late by ${TOLERANCE_MINS}+ min`}
            value={late.length}
            icon={TriangleAlert}
            period={date}
          />
          <Stat
            label={`Early by ${TOLERANCE_MINS}+ min`}
            value={early.length}
            icon={TimerReset}
            period={date}
            hint="A bus ahead of its time is a child not yet outside"
          />
          <Stat label="Worst delay" value={worst ? `${worst} min` : '—'} icon={Clock} period={date} />
        </CellGrid>

        {events.isError ? (
          <ErrorState error={events.error} />
        ) : events.isLoading ? (
          <Loading />
        ) : !runs.length ? (
          <EmptyState
            title="No stop events on this date"
            body="A stop is logged when a tracked bus crosses its geofence during an open trip. Nothing here means no trip ran, no phone was reporting, or the route's stops carry no coordinates to fence."
          />
        ) : (
          runs.map((run) => {
            const shown =
              only === 'off'
                ? run.stops.filter(
                    (s) =>
                      punctuality(s.arrived?.deviation_mins) === 'late' ||
                      punctuality(s.arrived?.deviation_mins) === 'early',
                  )
                : run.stops
            if (!shown.length) return null
            const runLate = run.stops.filter(
              (s) => punctuality(s.arrived?.deviation_mins) === 'late',
            ).length
            const runEarly = run.stops.filter(
              (s) => punctuality(s.arrived?.deviation_mins) === 'early',
            ).length
            return (
              <Card key={run.key}>
                <CardHeader
                  title={`${run.route} · ${run.direction === 'drop' ? 'Afternoon drop' : 'Morning pickup'}`}
                  description={[
                    run.registration,
                    run.driver,
                    `${run.stops.length} stops in driving order`,
                    runLate ? `${runLate} late` : null,
                    runEarly ? `${runEarly} early` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
                <Table
                  head={[
                    '#',
                    'Stop',
                    'Scheduled',
                    'Arrived',
                    'Deviation',
                    { label: 'Off by', align: 'right' },
                    { label: 'Dwell', align: 'right' },
                    'Departed',
                    { label: 'Geofence', align: 'right' },
                  ]}
                  empty={!shown.length}
                >
                  {shown.map((s) => {
                    const dev = s.arrived?.deviation_mins
                    const kind = punctuality(dev)
                    const radius = radiusByStop.get(`${run.route}|${s.stop}`)
                    return (
                      <tr key={s.key}>
                        <Td className="text-muted-foreground tabular-nums">{s.sequence}</Td>
                        <Td className="font-medium">{s.stop}</Td>
                        <Td className="tabular-nums text-muted-foreground">
                          {s.arrived?.scheduled_at ?? '—'}
                        </Td>
                        <Td className="tabular-nums">
                          {s.arrived ? clockOf(s.arrived.occurred_at) : '—'}
                        </Td>
                        <Td>
                          <DeviationBar mins={dev} />
                        </Td>
                        <Td className="text-right">
                          <Badge tone={TONE[kind]}>{deviationText(dev)}</Badge>
                        </Td>
                        <Td className="text-right tabular-nums">
                          {s.dwellMins == null ? '—' : `${s.dwellMins} min`}
                        </Td>
                        <Td className="tabular-nums text-muted-foreground">
                          {s.departed ? clockOf(s.departed.occurred_at) : 'still there / not logged'}
                        </Td>
                        <Td className="text-right tabular-nums text-muted-foreground">
                          {radius == null ? 'default' : `${radius} m`}
                        </Td>
                      </tr>
                    )
                  })}
                </Table>
              </Card>
            )
          })
        )}

        <p className="text-[12.5px] text-muted-foreground">
          Times are India local, as recorded by the bus's phone. A stop with no scheduled time on
          the route has no deviation to report — it is shown, not scored. The geofence column is
          the radius the stop is fenced at; stops left blank use the school-wide default from the
          tracking policy, and the radius is edited there rather than here.
        </p>
      </PageBody>
    </>
  )
}
