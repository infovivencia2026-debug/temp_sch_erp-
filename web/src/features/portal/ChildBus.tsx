import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BusFront, MapPin, Ruler } from 'lucide-react'
import { api } from '@/lib/api'
import { TileMap } from '@/components/TileMap'
import {
  PageHead, PageBody, Card, CardHeader, Badge, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import {
  ageText, hasPlot, minutes, stateSentence, usePoll, useSecondsSince, useTabVisible, withDrift,
  STATE_LABEL, STATE_TONE, type ChildBusFeed, type ChildBusRow,
} from './child-bus'

/* Where my child's bus is.

   Two refusals, both deliberate, both stated on the screen rather than only
   here.

   There is no street map. This product has no basemap and no tile server, so
   what a parent gets is the bus, their child's stop, and the line between
   them, drawn to scale with a scale bar. A blank rectangle that looks like a
   map with the roads failing to load would be read as a broken screen and
   reported as one; a plot that says what it is gets read correctly.

   And the distance is a straight line. A parent who sees "400 m" and comes
   down to the gate expecting the bus in thirty seconds, when it has three
   turns and a level crossing to make, does not trust this screen a second
   time. So the number is labelled "straight line" everywhere it appears, and
   no arrival time is estimated from it — an ETA from a crow-flies distance is
   a guess wearing a clock's clothes. */

const PLOT_W = 640
const PLOT_H = 380
const PAD = 56

/* Local flat projection, metres about the midpoint of the two plotted points.
   A degree of longitude is treated as constant across the box: true to well
   under a metre over the few kilometres between a bus and a stop, and wrong
   over a state, which is not a distance this plot ever spans. */
const M_PER_DEG_LAT = 110574
const metresPerDegLon = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180)

export default function ChildBus() {
  const visible = useTabVisible()
  const feed = useQuery({
    queryKey: ['me-child-bus'],
    queryFn: () => api.get<ChildBusFeed>('/api/v1/me/child-bus'),
  })

  const staleAfter = feed.data?.stale_after_seconds ?? 60
  /* Age the cached rows by however long the answer has been sitting here, so
     a paused poll cannot leave a bus looking live. */
  const drift = useSecondsSince(feed.dataUpdatedAt)
  const rows = (feed.data?.items ?? []).map((r) => withDrift(r, drift, staleAfter))
  const every = usePoll(rows, visible, () => void feed.refetch())

  if (feed.isLoading) return <Loading label="Finding your child's bus…" />
  if (feed.error) return <ErrorState error={feed.error} />

  return (
    <>
      <PageHead
        eyebrow="My child's bus"
        title="Live bus tracking"
        description="The bus, your child's stop, and the straight-line distance between them. There is no street map behind the plot — the school does not run one — so treat the distance as how far away it is, not how long it will take."
      />
      <PageBody>
        {rows.length === 0 ? (
          <EmptyState
            title="No child of yours is on a school bus"
            body="This page shows children with a current transport allocation. If your child travels by bus and is not listed, the transport office holds that record."
          />
        ) : (
          <>
            {rows.map((row) => (
              <ChildCard key={row.student_id} row={row} staleAfter={staleAfter} />
            ))}
            <p className="text-[12.5px] text-muted-foreground">
              {every && visible
                ? `Refreshing every ${every} seconds while this tab is in front of you.`
                : 'Not refreshing — nothing is on a run, or this tab is in the background.'}
            </p>
          </>
        )}
      </PageBody>
    </>
  )
}

function ChildCard({ row, staleAfter }: { row: ChildBusRow; staleAfter: number }) {
  return (
    <Card>
      <CardHeader
        title={row.student_name}
        description={`${row.route}${row.registration_no ? ` · ${row.registration_no}` : ''}${
          row.direction ? ` · ${row.direction === 'drop' ? 'Afternoon drop' : 'Morning pickup'}` : ''
        }`}
        action={<Badge tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Badge>}
      />
      <div className="space-y-4 px-5 py-4">
        <p className="max-w-2xl text-[14px] leading-relaxed text-muted-foreground">
          {stateSentence(row, staleAfter)}
        </p>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
          <Fact label="Stop" value={row.stop ?? 'Not recorded'} />
          <Fact label="Scheduled" value={row.scheduled_at ?? '—'} />
          <Fact
            label="Straight-line distance"
            value={row.metres_away != null ? `${row.metres_away} m` : '—'}
          />
          <Fact label="Last position" value={ageText(row.age_seconds)} />
        </dl>

        {hasPlot(row) ? (
          /* The map first, the plot under it.

             A parent knows their own street and not a pair of decimal
             degrees, so "has it turned into our road yet" is a question only
             streets can answer. The plot stays because it is the one that
             still works when the tiles do not load, and because it carries the
             scale bar and the straight-line distance the map does not. */
          <>
            <TileMap
              height={240}
              points={[
                ...(row.stop_latitude != null && row.stop_longitude != null
                  ? [{
                      lat: row.stop_latitude,
                      lon: row.stop_longitude,
                      kind: 'stop' as const,
                      label: row.stop ?? undefined,
                    }]
                  : []),
                { lat: row.latitude!, lon: row.longitude!, kind: 'bus' as const },
              ]}
              ariaLabel={`Map showing ${row.registration_no || 'the bus'}${
                row.stop ? ` and ${row.stop}` : ''
              }`}
            />
            <Plot row={row} />
          </>
        ) : (
          /* No plot rather than an empty one. A blank axis box under a
             sentence that already said why is a second, wordless claim that
             something is broken. */
          null
        )}

        {row.state === 'running' && row.metres_away != null && (
          <p className="text-[12.5px] text-muted-foreground">
            {row.metres_away} m is measured in a straight line across the map, not along the road.
            The bus may have turns, traffic and other stops to make first, so this is a distance,
            not an arrival time. You will be alerted when it comes within {row.proximity_m} m.
          </p>
        )}
      </div>
    </Card>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  )
}

/* The plot: two points and the line between them.

   Deliberately not a map. There are no roads because none are known, and
   inventing a grid of grey lines to make it feel map-like would be drawing
   streets that do not exist. */
function Plot({ row }: { row: ChildBusRow }) {
  const geo = useMemo(() => {
    const busLat = row.latitude!
    const busLon = row.longitude!
    const stopLat = row.stop_latitude
    const stopLon = row.stop_longitude
    const lats = stopLat != null ? [busLat, stopLat] : [busLat]
    const lons = stopLon != null ? [busLon, stopLon] : [busLon]
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2
    const midLon = (Math.min(...lons) + Math.max(...lons)) / 2
    const mLon = metresPerDegLon(midLat)
    // One point alone has no extent; a degenerate box divides by zero and
    // puts the bus nowhere. 300 m of context instead.
    const spanX = Math.max((Math.max(...lons) - Math.min(...lons)) * mLon, 300)
    const spanY = Math.max((Math.max(...lats) - Math.min(...lats)) * M_PER_DEG_LAT, 300)
    const scale = Math.min((PLOT_W - 2 * PAD) / spanX, (PLOT_H - 2 * PAD) / spanY)
    const project = (lat: number, lon: number) => ({
      x: PLOT_W / 2 + (lon - midLon) * mLon * scale,
      // Screen y grows downwards; north must not come out at the bottom.
      y: PLOT_H / 2 - (lat - midLat) * M_PER_DEG_LAT * scale,
    })
    return { project, scale }
  }, [row.latitude, row.longitude, row.stop_latitude, row.stop_longitude])

  // A round number of metres drawn at whatever pixel length that is, rather
  // than a round number of pixels labelled with an unreadable distance.
  const bar = useMemo(() => {
    const target = (PLOT_W - 2 * PAD) / 4 / geo.scale
    const nice = [50, 100, 200, 500, 1000, 2000, 5000]
    const metres = nice.find((n) => n >= target) ?? nice[nice.length - 1]
    return { metres, px: metres * geo.scale }
  }, [geo])

  const bus = geo.project(row.latitude!, row.longitude!)
  const stop =
    row.stop_latitude != null && row.stop_longitude != null
      ? geo.project(row.stop_latitude, row.stop_longitude)
      : null
  const staleLook = row.state === 'stale'

  return (
    <div>
      <svg
        viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
        className="w-full rounded-[8px] border bg-muted/30"
        role="img"
        aria-label={`Plot of ${row.registration_no || 'the bus'} against ${row.stop ?? 'the stop'}${
          row.metres_away != null ? `, ${row.metres_away} metres away in a straight line` : ''
        }`}
      >
        {stop && (
          <>
            <line
              x1={bus.x}
              y1={bus.y}
              x2={stop.x}
              y2={stop.y}
              className="stroke-muted-foreground"
              strokeWidth={1.5}
              strokeDasharray="5 4"
            />
            {row.metres_away != null && (
              <text
                x={(bus.x + stop.x) / 2}
                y={(bus.y + stop.y) / 2 - 8}
                textAnchor="middle"
                className="fill-secondary-foreground text-[13px]"
              >
                {row.metres_away} m straight line
              </text>
            )}
            {/* The stop's own alert radius, so the distance has something to
                be near rather than being a bare number. */}
            <circle
              cx={stop.x}
              cy={stop.y}
              r={Math.max(6, row.proximity_m * geo.scale)}
              className="fill-primary/5 stroke-primary/30"
              strokeWidth={1}
            />
            <circle cx={stop.x} cy={stop.y} r={6} className="fill-primary" />
            <text
              x={stop.x}
              y={stop.y + 22}
              textAnchor="middle"
              className="fill-secondary-foreground text-[13px]"
            >
              {row.stop}
            </text>
          </>
        )}

        {/* Hollow and dashed when the fix is old: a solid marker that reads as
            a moving bus but is twenty minutes stale is the worst thing this
            screen can show a parent standing at a gate. */}
        <circle
          cx={bus.x}
          cy={bus.y}
          r={9}
          className={staleLook ? 'fill-none stroke-destructive' : 'fill-success stroke-success'}
          strokeWidth={2}
          strokeDasharray={staleLook ? '4 3' : undefined}
        />
        <text
          x={bus.x}
          y={bus.y - 16}
          textAnchor="middle"
          className={staleLook ? 'fill-destructive text-[13px]' : 'fill-success text-[13px]'}
        >
          {row.registration_no || 'Bus'} · {ageText(row.age_seconds)}
        </text>

        <g transform={`translate(${PAD},${PLOT_H - 22})`} className="text-muted-foreground">
          <line x1={0} y1={0} x2={bar.px} y2={0} stroke="currentColor" strokeWidth={1.5} />
          <line x1={0} y1={-5} x2={0} y2={5} stroke="currentColor" strokeWidth={1.5} />
          <line x1={bar.px} y1={-5} x2={bar.px} y2={5} stroke="currentColor" strokeWidth={1.5} />
          <text x={bar.px + 8} y={4} className="fill-current text-[12px]">
            {bar.metres} m
          </text>
        </g>
      </svg>
      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <BusFront className="h-3.5 w-3.5" /> Bus, last reported position
        </span>
        <span className="inline-flex items-center gap-1.5">
          <MapPin className="h-3.5 w-3.5" /> Your child's stop
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Ruler className="h-3.5 w-3.5" /> Drawn to scale. No roads, no street map — none exist
          behind this plot.
        </span>
      </p>
      {row.state === 'stale' && (
        <p className="mt-1 text-[12px] text-destructive">
          This position is over {minutes(row.age_seconds ?? 0)} old. It is where the bus was.
        </p>
      )}
    </div>
  )
}
