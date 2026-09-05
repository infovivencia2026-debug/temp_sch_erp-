import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BatteryWarning, BusFront, MapPin, RadioTower, TriangleAlert } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Select, SkeletonTable, ErrorState, EmptyState, Button, Textarea,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import { FleetMap } from '@/components/FleetMap'
import { useVisibleInterval } from '@/lib/visible'

/* Where the fleet is, right now.

   Two things this screen refuses to do. It does not draw a street map: there
   is no basemap and no tile server behind this product, so what you get is a
   plot of coordinates with the route's own stops as the only landmarks, and
   the page says so in words rather than letting a bare white rectangle imply
   a city that is not drawn. And it does not let a stale fix look live. A
   marker that reads as a moving bus but is forty minutes old is the single
   worst thing this feature can do to a transport office, so "stale" is red,
   hollow, dashed, labelled with its age on the plot itself, and sorted to the
   top of the table. You should not have to hover to find out. */

interface LiveVehicle {
  vehicle_id: string
  registration_no: string
  route?: string
  route_id?: string
  direction?: string
  trip_id?: string
  driver?: string
  driver_phone?: string
  latitude?: number
  longitude?: number
  speed_kmph?: number
  heading_deg?: number
  recorded_at?: string
  age_seconds?: number
  state: 'running' | 'stale' | 'idle'
  tracker?: string
  battery_pct?: number
  charging?: boolean
  location_ok?: boolean
  tracker_last_seen?: string
  paired: boolean
}
interface LiveFeed {
  items: LiveVehicle[]
  ping_seconds: number
  stale_after_seconds: number
}
interface StopPoint {
  id: string
  name: string
  route_id: string
  route: string
  sequence: number
  latitude: number
  longitude: number
  geofence_m?: number
}

const STATE_LABEL: Record<LiveVehicle['state'], string> = {
  running: 'Running',
  stale: 'No fix',
  idle: 'Parked',
}
/* Colour carries the state in both themes because these are the theme's own
   semantic tokens, not hex picked against a white page. Shape carries it too:
   colour alone fails the colour-blind driver-line manager and fails again on
   the projector in the transport office. */
const STATE_TONE: Record<LiveVehicle['state'], 'success' | 'danger' | 'neutral'> = {
  running: 'success',
  stale: 'danger',
  idle: 'neutral',
}
/** Stale first, then running, then parked: the map's job is the exceptions. */
const STATE_ORDER: Record<LiveVehicle['state'], number> = { stale: 0, running: 1, idle: 2 }

function ageText(secs?: number): string {
  if (secs == null) return 'never'
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`
  const h = Math.floor(secs / 3600)
  if (h < 24) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

/* Seconds since this payload arrived, ticking on its own.

   age_seconds is frozen at the moment the server answered it. The poll below
   stops with the tab, and React Query will happily hand back an answer from
   twenty minutes ago, so without this the map would keep drawing a solid
   green marker labelled "8s ago" for a bus nothing has heard from since
   breakfast. The drift is added back on before any state is decided. */
function useSecondsSince(at?: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(t)
  }, [])
  if (!at) return 0
  return Math.max(0, Math.round((now - at) / 1000))
}

/* The vehicle as it is now, not as it was when fetched. Same shape, so the
   plot, the table and the tiles all keep reading one state and cannot end up
   disagreeing about whether a bus is running. */
function withDrift(v: LiveVehicle, drift: number, staleAfter: number): LiveVehicle {
  if (drift <= 0 || v.state === 'idle') return v
  const age = v.age_seconds == null ? undefined : v.age_seconds + drift
  const state = age == null || age > staleAfter ? 'stale' : v.state
  return { ...v, age_seconds: age, state }
}

/* Is this tab in front of somebody?

   A live map left open on a machine nobody is at is a poll every ten seconds
   for the whole weekend, against a phone battery budget the school is paying
   for. React Query's own refetchInterval keeps firing in a background tab, so
   the visibility is read here and the interval turned off with it. */
function useTabVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : !document.hidden,
  )
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

export default function LiveVehicleMap() {
  const visible = useTabVisible()
  const [routeFilter, setRouteFilter] = useState('')
  const [focus, setFocus] = useState<string | null>(null)

  const live = useQuery({
    queryKey: ['transport-live'],
    queryFn: () => api.get<LiveFeed>('/api/v1/transport/live'),
    /* One of the three queries that still refetch on focus, now that the
       default is off (see App.tsx). The interval below is deliberately
       stopped while the tab is hidden, so without this, coming back to a map
       left open shows the last positions from before it was hidden until the
       next tick — up to a ping later. On a screen whose entire subject is
       where a bus is at this second, that is the wrong thing to draw. */
    refetchOnWindowFocus: true,
    staleTime: 0,
  })

  const stops = useQuery({
    queryKey: ['transport-map-stops'],
    queryFn: () => api.get<List<StopPoint>>('/api/v1/transport/map-stops'),
    staleTime: 10 * 60 * 1000,
  })

  const feed = live.data
  const ping = feed?.ping_seconds ?? 15

  /* Poll on the server's number. Kept as an effect over a refetchInterval
     expression so the interval changes the moment the policy does, without
     waiting for the component to be remounted. */
  useEffect(() => {
    if (!visible) return
    const ms = Math.max(5, ping) * 1000
    const t = setInterval(() => void live.refetch(), ms)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, ping])

  /* The server sends this; the fallback mirrors staleAfter() in
     internal/api/bus_tracking_views.go, three pings plus a margin, so a
     missing field cannot make every bus look fresh forever. */
  const staleAfter = feed?.stale_after_seconds ?? ping * 3 + 15
  const drift = useSecondsSince(live.dataUpdatedAt)
  const all = useMemo(
    () => (feed?.items ?? []).map((v) => withDrift(v, drift, staleAfter)),
    [feed, drift, staleAfter],
  )
  const routes = useMemo(() => {
    const seen = new Map<string, string>()
    for (const v of all) if (v.route_id && v.route) seen.set(v.route_id, v.route)
    for (const s of stops.data?.items ?? []) seen.set(s.route_id, s.route)
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [all, stops.data])

  const vehicles = useMemo(
    () =>
      all
        .filter((v) => !routeFilter || v.route_id === routeFilter)
        .slice()
        .sort(
          (a, b) =>
            STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
            (a.route ?? '~').localeCompare(b.route ?? '~') ||
            a.registration_no.localeCompare(b.registration_no),
        ),
    [all, routeFilter],
  )

  const stopPoints = useMemo(
    () => (stops.data?.items ?? []).filter((s) => !routeFilter || s.route_id === routeFilter),
    [stops.data, routeFilter],
  )

  const plottable = vehicles.filter(
    (v) => v.latitude != null && v.longitude != null && v.state !== 'idle',
  )

  const running = all.filter((v) => v.state === 'running').length
  const stale = all.filter((v) => v.state === 'stale').length
  const blind = all.filter((v) => v.location_ok === false).length
  const lowBattery = all.filter((v) => v.battery_pct != null && v.battery_pct < 20).length

  return (
    <>
      <PageHead
        eyebrow="Transport"
        title="Live vehicle tracking"
        description="Every bus on the fleet, where its phone last said it was, drawn on the street map."
        width="wide"
        actions={
          <Select
            value={routeFilter}
            onChange={setRouteFilter}
            options={[
              { value: '', label: 'All routes' },
              ...routes.map(([id, name]) => ({ value: id, label: name })),
            ]}
          />
        }
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Running" value={running} icon={BusFront} hint="Open trip, fresh fix" />
          <Stat
            label="No recent fix"
            value={stale}
            icon={TriangleAlert}
            hint={`On a trip but silent for over ${Math.round(staleAfter / 60) || 1} min`}
          />
          <Stat
            label="Location blocked"
            value={blind}
            icon={RadioTower}
            hint="Phone reporting in, OS refusing location"
          />
          <Stat label="Battery under 20%" value={lowBattery} icon={BatteryWarning} />
        </CellGrid>

        {live.isError ? (
          <ErrorState error={live.error} />
        ) : live.isLoading ? (
          <SkeletonTable columns={4} />
        ) : (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <Card>
              <CardHeader
                title="Live positions"
                description="Every reporting bus on the map, with the route's own stops and their arrival geofences."
              />
              <div className="px-5 py-4">
                {plottable.length === 0 && stopPoints.length === 0 ? (
                  /* Four different facts have been arriving here as one grey
                     box. A fleet of nothing, a fleet that is all parked, a
                     route filter that excludes everything, and a school whose
                     stops have never been geocoded are four different things
                     to go and do, and only one of them is a fault. */
                  <EmptyState {...plotGap(all, vehicles, stopPoints, !!routeFilter)} />
                ) : (
                  <FleetMap
                    className="h-[560px]"
                    vehicles={plottable.map((v) => ({
                      id: v.vehicle_id,
                      label: v.registration_no,
                      latitude: v.latitude!,
                      longitude: v.longitude!,
                      heading_deg: v.heading_deg,
                      state: v.state,
                      note: `no fix · ${ageText(v.age_seconds)}`,
                    }))}
                    stops={stopPoints}
                    focusId={focus}
                    onFocus={setFocus}
                    // Each bus glides for most of the interval between fixes,
                    // so the fleet is seen moving rather than stepping.
                    glideMs={Math.min(Math.max(5, ping), 15) * 900}
                  />
                )}
                {stops.isError && (
                  /* Without the stops the plot is dots on white. Said out
                     loud, because an office that does not know the landmarks
                     failed to load will read a bus sitting two kilometres off
                     its route as a bus sitting at a stop. */
                  <p className="mt-3 text-[12.5px] text-destructive">
                    The route stops could not be loaded, so the plot has no landmarks on it. The
                    positions above are still today's; only the stops are missing.
                  </p>
                )}
                <p className="mt-3 text-[12.5px] text-muted-foreground">
                  <MapPin className="mr-1 inline h-3.5 w-3.5" />
                  A bus with no recent fix is drawn hollow and dashed with its age beside it, so a
                  stale position never reads as a moving bus. Parked vehicles are listed but not
                  plotted. Street map © OpenStreetMap contributors.
                </p>
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Fleet"
                description={`Refreshing every ${ping}s${visible ? '' : ' — paused while this tab is in the background'}.`}
              />
              <Table
                head={[
                  'Vehicle',
                  'Route',
                  'Driver',
                  { label: 'Speed', align: 'right' },
                  'Last fix',
                  { label: 'Battery', align: 'right' },
                  'Phone',
                  'Message',
                ]}
                empty={vehicles.length === 0}
                emptyLabel={
                  all.length === 0
                    ? 'No vehicle is on the fleet yet. Buses are added under Transport, and one appears here as soon as it exists, running or not.'
                    : 'No vehicle is on the route you have picked. Choose All routes to see the rest of the fleet.'
                }
              >
                {vehicles.map((v) => (
                  <tr
                    key={v.vehicle_id}
                    className={cn(v.state === 'stale' && 'bg-destructive/[0.06]')}
                  >
                    <Td>
                      <div className="font-medium">{v.registration_no}</div>
                      <Badge tone={STATE_TONE[v.state]}>
                        {STATE_LABEL[v.state]}
                        {v.direction ? ` · ${v.direction}` : ''}
                      </Badge>
                    </Td>
                    <Td>{v.route ?? '—'}</Td>
                    <Td>
                      <div>{v.driver ?? '—'}</div>
                      {v.driver_phone && (
                        <div className="text-[12.5px] text-muted-foreground">{v.driver_phone}</div>
                      )}
                    </Td>
                    <Td className="text-right">
                      {v.state === 'running' && v.speed_kmph != null
                        ? `${Math.round(v.speed_kmph)} km/h`
                        : '—'}
                    </Td>
                    <Td>
                      <span className={cn(v.state === 'stale' && 'font-medium text-destructive')}>
                        {v.trip_id ? ageText(v.age_seconds) : '—'}
                      </span>
                    </Td>
                    <Td className="text-right">
                      {v.battery_pct == null ? (
                        '—'
                      ) : (
                        <span
                          className={cn(
                            v.battery_pct < 20 && !v.charging && 'font-medium text-destructive',
                          )}
                        >
                          {v.battery_pct}%{v.charging ? ' ⚡' : ''}
                        </span>
                      )}
                    </Td>
                    <Td>
                      {!v.paired ? (
                        <Badge tone="neutral">No tracker</Badge>
                      ) : v.location_ok === false ? (
                        /* The failure that looks like health: online, charged,
                           and the OS is refusing it location. */
                        <Badge tone="danger">Location blocked</Badge>
                      ) : (
                        <Badge tone="success">Paired</Badge>
                      )}
                    </Td>
                    <Td>
                      <DriverMessage vehicleId={v.vehicle_id} paired={!!v.paired} />
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>
        )}
      </PageBody>
    </>
  )
}

/* Which of the four nothings is this?

   Named separately because "Nothing to plot" over an empty rectangle is the
   sentence that gets a working screen reported as broken: a school that has
   not put a bus on the system, a fleet that is simply parked at nine at night,
   a route filter with nothing behind it and a stop list with no coordinates
   all need different people to do different things. */
function plotGap(
  all: LiveVehicle[],
  filtered: LiveVehicle[],
  stopPoints: StopPoint[],
  filtering: boolean,
): { title: string; body: string } {
  if (all.length === 0)
    return {
      title: 'No vehicle is on the fleet yet',
      body: 'Nothing can be tracked until a bus exists. Add vehicles under Transport, pair a driver phone with each, and they appear here from the first trip onwards.',
    }
  if (filtering && filtered.length === 0)
    return {
      title: 'Nothing on this route',
      body: 'No vehicle on the fleet is on the route you have selected. Choose All routes to see the rest of them.',
    }
  if (filtered.every((v) => v.state === 'idle'))
    return {
      title: 'Every bus is parked',
      body: 'No trip is open, so no position is being published. A bus appears on the plot from the moment its driver starts a run, and drops off it when the run ends. The list beside this shows the whole fleet meanwhile.',
    }
  if (stopPoints.length === 0)
    return {
      title: 'No position and no landmark',
      body: 'A trip is open but no phone on it has reported a position yet, and no stop on this route has coordinates recorded, so there is nothing to draw against. The transport office can add stop coordinates under Routes.',
    }
  return {
    title: 'No position reported yet',
    body: 'A trip is open, but no phone on it has sent a position. Usually the phone is still finding satellites, or the OS has refused it location — the Location blocked count above tells the two apart.',
  }
}

type DriverNotice = {
  id: string
  body: string
  sent_at: string
  sent_by?: string
  acknowledged_at?: string
  acknowledged_by?: string
  expired: boolean
}

/* A line to the driver, and whether it was read.

   The phone fetches this on its heartbeat and shows it as a banner with one
   button; tapping it is what turns "sent" into "seen" here. Delivered is not
   the same as read on a phone face-down on a dashboard, so only the tap is
   shown as anything. */
function DriverMessage({ vehicleId, paired }: { vehicleId: string; paired: boolean }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState('')
  // The main poll above stops with the tab; this one did not, so a hidden map
  // still asked for every bus's notices once a minute for nobody. Same gate.
  const noticesEvery = useVisibleInterval(open ? 10_000 : 60_000)
  const notices = useQuery({
    queryKey: ['driver-notices', vehicleId],
    queryFn: () => api.get<List<DriverNotice>>(`/api/v1/transport/vehicles/${vehicleId}/notices`),
    enabled: paired,
    refetchInterval: noticesEvery,
  })
  const send = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`/api/v1/transport/vehicles/${vehicleId}/notices`, {
        body: body.trim().slice(0, 500),
      }),
    onSuccess: () => {
      setBody('')
      qc.invalidateQueries({ queryKey: ['driver-notices', vehicleId] })
    },
  })
  if (!paired) return <span className="text-muted-foreground">—</span>
  const latest = notices.data?.items?.[0]
  return (
    <div className="min-w-[180px] space-y-1">
      {latest && (
        <div className="text-[12.5px]">
          <div className="max-w-[240px] truncate" title={latest.body}>{latest.body}</div>
          <div className="text-muted-foreground">
            {latest.acknowledged_at
              ? `Seen ${latest.acknowledged_at}${latest.acknowledged_by ? ` by ${latest.acknowledged_by}` : ''}`
              : latest.expired
                ? 'Never seen'
                : `Sent ${latest.sent_at}, not seen yet`}
          </div>
        </div>
      )}
      {open ? (
        <div className="space-y-1">
          <Textarea
            value={body}
            onChange={setBody}
            rows={2}
            placeholder="Return to school, run cancelled."
            onSubmit={() => { if (body.trim() && !send.isPending) send.mutate() }}
          />
          <div className="flex gap-1">
            <Button size="sm" disabled={send.isPending || !body.trim()} onClick={() => send.mutate()}>
              Send to driver
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          {send.isError && <div className="text-[12px] text-destructive">Could not send.</div>}
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Message driver
        </Button>
      )}
    </div>
  )
}
