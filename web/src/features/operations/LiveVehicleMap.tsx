import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BatteryWarning, BusFront, MapPin, RadioTower, TriangleAlert } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Select, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { cn } from '@/lib/utils'

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
const STATE_INK: Record<LiveVehicle['state'], string> = {
  running: 'text-success',
  stale: 'text-destructive',
  idle: 'text-muted-foreground',
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

/* Local flat projection, metres from the centre of the plotted set.

   Fine here and wrong at scale: it treats a degree of longitude as constant
   across the box, which holds to well under a metre over the twenty-odd
   kilometres a school route covers and would not hold over a state. */
const M_PER_DEG_LAT = 110574

function metresPerDegLon(lat: number): number {
  return 111320 * Math.cos((lat * Math.PI) / 180)
}

interface Plotted {
  x: number
  y: number
}

const PLOT_W = 960
const PLOT_H = 560
const PAD = 44

export default function LiveVehicleMap() {
  const visible = useTabVisible()
  const [routeFilter, setRouteFilter] = useState('')
  const [focus, setFocus] = useState<string | null>(null)

  const live = useQuery({
    queryKey: ['transport-live'],
    queryFn: () => api.get<LiveFeed>('/api/v1/transport/live'),
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

  /* Bounding box over everything that will be drawn, vehicles and stops
     together. Taking it from the vehicles alone would make a bus that has
     wandered off its route look central and correct. */
  const geo = useMemo(() => {
    const lats = [...plottable.map((v) => v.latitude!), ...stopPoints.map((s) => s.latitude)]
    const lons = [...plottable.map((v) => v.longitude!), ...stopPoints.map((s) => s.longitude)]
    if (!lats.length) return null
    const minLat = Math.min(...lats)
    const maxLat = Math.max(...lats)
    const minLon = Math.min(...lons)
    const maxLon = Math.max(...lons)
    const midLat = (minLat + maxLat) / 2
    const mLon = metresPerDegLon(midLat)
    // A single reporting bus has no extent at all; a degenerate box would
    // divide by zero and put it nowhere. Give it 300 m of context instead.
    const spanX = Math.max((maxLon - minLon) * mLon, 300)
    const spanY = Math.max((maxLat - minLat) * M_PER_DEG_LAT, 300)
    const scale = Math.min((PLOT_W - 2 * PAD) / spanX, (PLOT_H - 2 * PAD) / spanY)
    const midLon = (minLon + maxLon) / 2
    const project = (lat: number, lon: number): Plotted => ({
      x: PLOT_W / 2 + (lon - midLon) * mLon * scale,
      // Screen y grows downwards; north must not come out at the bottom.
      y: PLOT_H / 2 - (lat - midLat) * M_PER_DEG_LAT * scale,
    })
    return { project, scale, spanX, spanY }
  }, [plottable, stopPoints])

  /* A scale bar the eye can use: a round number of metres, drawn at whatever
     pixel length that works out to, rather than a round number of pixels
     labelled with an unreadable distance. */
  const scaleBar = useMemo(() => {
    if (!geo) return null
    const target = (PLOT_W - 2 * PAD) / 5 / geo.scale
    const nice = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
    const metres = nice.find((n) => n >= target) ?? nice[nice.length - 1]
    return { metres, px: metres * geo.scale }
  }, [geo])

  const running = all.filter((v) => v.state === 'running').length
  const stale = all.filter((v) => v.state === 'stale').length
  const blind = all.filter((v) => v.location_ok === false).length
  const lowBattery = all.filter((v) => v.battery_pct != null && v.battery_pct < 20).length

  return (
    <>
      <PageHead
        eyebrow="Transport"
        title="Live vehicle tracking"
        description="Every bus on the fleet, where its phone last said it was. Positions only — there is no street map behind the plot."
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
          <Loading />
        ) : (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <Card>
              <CardHeader
                title="Position plot"
                description="Coordinates projected to scale. Stops are the landmarks; no roads are drawn because none are known."
              />
              <div className="px-5 py-4">
                {!geo ? (
                  /* Four different facts have been arriving here as one grey
                     box. A fleet of nothing, a fleet that is all parked, a
                     route filter that excludes everything, and a school whose
                     stops have never been geocoded are four different things
                     to go and do, and only one of them is a fault. */
                  <EmptyState {...plotGap(all, vehicles, stopPoints, !!routeFilter)} />
                ) : (
                  <svg
                    viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
                    className="w-full rounded-[8px] border bg-muted/30"
                    role="img"
                    aria-label="Plot of vehicle positions against route stops"
                  >
                    {stopPoints.map((s) => {
                      const p = geo.project(s.latitude, s.longitude)
                      return (
                        <g key={s.id} className="text-muted-foreground">
                          {s.geofence_m ? (
                            <circle
                              cx={p.x}
                              cy={p.y}
                              r={Math.max(2, s.geofence_m * geo.scale)}
                              fill="currentColor"
                              opacity={0.08}
                            />
                          ) : null}
                          <circle cx={p.x} cy={p.y} r={3.5} fill="currentColor" opacity={0.55} />
                          <text
                            x={p.x + 6}
                            y={p.y + 3.5}
                            fontSize={10}
                            fill="currentColor"
                            opacity={0.7}
                          >
                            {s.name}
                          </text>
                        </g>
                      )
                    })}

                    {plottable.map((v) => {
                      const p = geo.project(v.latitude!, v.longitude!)
                      const isStale = v.state === 'stale'
                      const heading = v.heading_deg ?? 0
                      return (
                        <g
                          key={v.vehicle_id}
                          className={STATE_INK[v.state]}
                          onMouseEnter={() => setFocus(v.vehicle_id)}
                          onMouseLeave={() => setFocus(null)}
                        >
                          {/* A stale bus wears a dashed hollow ring so it is
                              distinguishable from a running one on a black and
                              white printout and at a glance across the room. */}
                          <circle
                            cx={p.x}
                            cy={p.y}
                            r={13}
                            fill={isStale ? 'none' : 'currentColor'}
                            fillOpacity={0.14}
                            stroke="currentColor"
                            strokeWidth={isStale ? 2 : 1}
                            strokeDasharray={isStale ? '4 3' : undefined}
                            opacity={focus === v.vehicle_id ? 1 : 0.85}
                          />
                          <path
                            d="M 0 -8 L 5.5 7 L 0 3.5 L -5.5 7 Z"
                            transform={`translate(${p.x} ${p.y}) rotate(${heading})`}
                            fill={isStale ? 'none' : 'currentColor'}
                            stroke="currentColor"
                            strokeWidth={1.5}
                            strokeDasharray={isStale ? '3 2' : undefined}
                          />
                          <text
                            x={p.x}
                            y={p.y + 26}
                            fontSize={11}
                            textAnchor="middle"
                            fill="currentColor"
                            fontWeight={600}
                          >
                            {v.registration_no}
                          </text>
                          {isStale && (
                            <text
                              x={p.x}
                              y={p.y + 38}
                              fontSize={10}
                              textAnchor="middle"
                              fill="currentColor"
                            >
                              no fix · {ageText(v.age_seconds)}
                            </text>
                          )}
                        </g>
                      )
                    })}

                    {scaleBar && (
                      <g
                        className="text-muted-foreground"
                        transform={`translate(${PAD} ${PLOT_H - 20})`}
                      >
                        <line x1={0} y1={0} x2={scaleBar.px} y2={0} stroke="currentColor" strokeWidth={2} />
                        <line x1={0} y1={-5} x2={0} y2={5} stroke="currentColor" strokeWidth={2} />
                        <line
                          x1={scaleBar.px}
                          y1={-5}
                          x2={scaleBar.px}
                          y2={5}
                          stroke="currentColor"
                          strokeWidth={2}
                        />
                        <text x={scaleBar.px / 2} y={-9} fontSize={11} textAnchor="middle" fill="currentColor">
                          {scaleBar.metres >= 1000
                            ? `${scaleBar.metres / 1000} km`
                            : `${scaleBar.metres} m`}
                        </text>
                      </g>
                    )}
                    <g className="text-muted-foreground" transform={`translate(${PLOT_W - 34} 34)`}>
                      <path d="M 0 12 L 0 -12 M -5 -5 L 0 -12 L 5 -5" stroke="currentColor" strokeWidth={2} fill="none" />
                      <text x={0} y={26} fontSize={10} textAnchor="middle" fill="currentColor">N</text>
                    </g>
                  </svg>
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
                  This is a scaled position plot, not a street map. Distances are true; roads,
                  buildings and one-way restrictions are not shown because the system holds no map
                  data. Parked vehicles are listed but not plotted.
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
