import { useMemo } from 'react'
import { FleetMap, type MapStop, type MapVehicle } from './FleetMap'
import { cn } from '@/lib/utils'
import { distanceText, routeLine, routeProgress, type ProgressStop } from '@/lib/route-progress'
import './route-guidance.css'

/* The bus, the way a navigation screen shows a journey.

   One panel. The map, made quiet, with the run drawn through its stops as a
   single accent line. Down the left, a timeline: the destination at the top,
   the next stop and how far, the bus's speed, and the stops still to come
   before ours. In the corner, the minutes. That is the whole reading a parent
   wants at the gate, and it is the owner's route-guidance design applied to
   a school bus.

   WHAT IT IS CAREFUL NOT TO CLAIM. The road is not known, so "next stop" is
   worked out from which stop the bus is nearest (see lib/route-progress.ts)
   and the distance to it is a straight line. The minutes come from the
   server, which refuses to invent them when the bus is not moving; when there
   are none, the corner shows the distance instead and says it is a straight
   line. A stale bus keeps its red, dashed marker: the panel changes how the
   map is dressed, never what it is allowed to say. */

export interface GuidanceRow {
  /** The bus, as the map draws it. Empty when it has not reported. */
  vehicle?: MapVehicle
  /** Every stop on the run with a position, in order. */
  stops: ProgressStop[]
  /** The stop this viewer is waiting at, if any. */
  myStopId?: string
  myStopName?: string
  /** Where the bus is, if it has reported. */
  latitude?: number
  longitude?: number
  metresAway?: number
  etaMinutes?: number
  speedKmph?: number
  proximityM?: number
  scheduledAt?: string
  /** What to say under "Destination" when the bus is not on its way. */
  status?: string
  /** How long a marker takes to glide between fixes. */
  glideMs?: number
}

const MAX_UPCOMING = 3

export function RouteGuidance({ row, className }: { row: GuidanceRow; className?: string }) {
  const progress = useMemo(
    () => routeProgress(row.stops, row.latitude, row.longitude),
    [row.stops, row.latitude, row.longitude],
  )
  const routes = useMemo(() => [routeLine(row.stops)], [row.stops])
  const mine = row.stops.find((s) => s.id === row.myStopId)
  const next = progress.ahead[0]
  /* The stops between the next one and ours -- what the bus still has to do
     before it reaches this family. Ours is at the top already, so it is left
     out; anything past ours is somebody else's journey. */
  const before = progress.ahead
    .slice(1)
    .filter((s) => (mine ? s.sequence < mine.sequence : true))
  const shown = before.slice(0, MAX_UPCOMING)
  const more = before.length - shown.length

  const mapStops: MapStop[] = row.stops.map((s) => ({
    id: s.id,
    name: s.id === row.myStopId ? `${s.name} · your stop` : s.name,
    latitude: s.latitude,
    longitude: s.longitude,
    geofence_m: s.id === row.myStopId ? row.proximityM : undefined,
    mine: s.id === row.myStopId,
  }))

  const hasFix = row.latitude != null && row.longitude != null

  return (
    <section className={cn('guide', className)} aria-label="Route guidance">
      <div className="guide__map">
        <FleetMap
          tone="guidance"
          className="h-[min(48vh,520px)] sm:h-[520px]"
          vehicles={row.vehicle ? [row.vehicle] : []}
          stops={mapStops}
          routes={routes}
          glideMs={row.glideMs}
          link={
            hasFix && mine
              ? {
                  from: { latitude: row.latitude!, longitude: row.longitude! },
                  to: { latitude: mine.latitude, longitude: mine.longitude },
                  label: row.metresAway != null ? `${distanceText(row.metresAway)} straight line` : undefined,
                }
              : null
          }
        />
      </div>
      <div className="guide__fade" aria-hidden="true" />

      <ol className="guide__timeline">
        <li className="contents">
          <span className={cn('guide__ring', mine && 'guide__ring--accent')} aria-hidden="true" />
          <div>
            <div className="guide__title guide__title--lead">{row.myStopName ?? mine?.name ?? 'Destination'}</div>
            <div className="guide__sub">
              {row.status ?? (row.scheduledAt ? `Scheduled ${row.scheduledAt}` : 'Your stop')}
            </div>
          </div>
        </li>

        {hasFix && next && next.id !== row.myStopId && (
          <li className="contents">
            <span className="guide__ring" aria-hidden="true" />
            <div>
              <div className="guide__title">
                <span className="guide__turn" aria-hidden="true" />
                {distanceText(progress.metresToNext)} to {next.name}
              </div>
              <div className="guide__sub">Next stop on the run</div>
            </div>
          </li>
        )}

        {hasFix && next && next.id === row.myStopId && (
          <li className="contents">
            <span className="guide__ring" aria-hidden="true" />
            <div>
              <div className="guide__title">
                <span className="guide__turn" aria-hidden="true" />
                {distanceText(progress.metresToNext)} to your stop
              </div>
              <div className="guide__sub">Yours is the next stop</div>
            </div>
          </li>
        )}

        {hasFix && row.speedKmph != null && (
          <li className="contents">
            <span className="guide__ring guide__ring--point" aria-hidden="true" />
            <div className="guide__title guide__title--plain">{Math.round(row.speedKmph)} km/h</div>
          </li>
        )}

        {shown.map((s) => (
          <li key={s.id} className="contents guide__row--muted">
            <span className="guide__ring guide__ring--muted" aria-hidden="true" />
            <div className="guide__title">{s.name}</div>
          </li>
        ))}
        {more > 0 && (
          <li className="contents guide__row--muted">
            <span className="guide__ring guide__ring--muted" aria-hidden="true" />
            <div className="guide__title">{more} more before yours</div>
          </li>
        )}
      </ol>

      {hasFix && (
        <div className="guide__eta">
          {row.etaMinutes != null ? (
            <>
              <strong>{row.etaMinutes}</strong>
              <span>{row.etaMinutes === 1 ? 'minute' : 'minutes'}, at this speed</span>
            </>
          ) : row.metresAway != null ? (
            <>
              <strong>{distanceText(row.metresAway)}</strong>
              <span>straight line to your stop</span>
            </>
          ) : null}
        </div>
      )}
    </section>
  )
}
