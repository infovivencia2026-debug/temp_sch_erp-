/* Where a bus is along its run, worked out from the stops.

   The server gives the route as an ordered list of stops with positions and
   the bus as one fix. It does not give the road, so "how far along" cannot be
   measured along it; what can be said honestly is which stop the bus is
   nearest, and therefore which stops are behind it and which are still to
   come. That is what the guidance timeline draws: passed stops muted, the
   bus between two of them, the rest ahead.

   Nearest, not "last passed": a bus that has left stop 3 and is halfway to
   stop 4 is nearer whichever of the two it is closer to, and the timeline
   puts it after 3 in both cases because that is the only reading that never
   shows the bus ahead of a stop it has not reached. Left deliberately simple
   -- a real progress model needs the road, and a wrong-but-confident position
   is worse than a coarse one. */

export interface ProgressStop {
  id: string
  name: string
  sequence: number
  latitude: number
  longitude: number
}

export interface RouteProgress {
  /** Index into the ordered stops of the one the bus is nearest to. -1 when
      there is nothing to measure against. */
  nearest: number
  /** The stops behind the bus, in order. */
  passed: ProgressStop[]
  /** The stops still ahead, in order, the next one first. */
  ahead: ProgressStop[]
  /** Metres from the bus to the next stop ahead, straight line. */
  metresToNext?: number
}

/** Metres between two points, close enough for a bus on a road. */
export function metresBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * 110574
  const dLon = (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180))
  return Math.hypot(dLat, dLon)
}

/**
 * Split an ordered route around a bus position.
 *
 * `lat`/`lon` absent means the bus has not reported: nothing is passed and
 * everything is ahead, which is what a run that has not started looks like.
 */
export function routeProgress(
  stops: ProgressStop[],
  lat?: number,
  lon?: number,
): RouteProgress {
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence)
  if (ordered.length === 0 || lat == null || lon == null) {
    return { nearest: -1, passed: [], ahead: ordered }
  }
  let nearest = 0
  let best = Infinity
  ordered.forEach((s, i) => {
    const d = metresBetween(lat, lon, s.latitude, s.longitude)
    if (d < best) {
      best = d
      nearest = i
    }
  })
  /* Within the stop's own catchment the bus is AT it, and the stop is the
     next thing on the timeline rather than something it has gone past. Past
     that radius it has left, and the stop is behind it. 60 m is a bus length
     and a half of GPS wobble; geofences are the server's business and are
     drawn on the map, not decided here. */
  const atStop = best <= 60
  const cut = atStop ? nearest : nearest + 1
  const passed = ordered.slice(0, cut)
  const ahead = ordered.slice(cut)
  const next = ahead[0]
  return {
    nearest,
    passed,
    ahead,
    metresToNext: next ? Math.round(metresBetween(lat, lon, next.latitude, next.longitude)) : undefined,
  }
}

/** The route as a line through its stops in order, for drawing. Not the
    road -- the road is not known -- but the shape of the run. */
export function routeLine(stops: ProgressStop[]): [number, number][] {
  return [...stops]
    .sort((a, b) => a.sequence - b.sequence)
    .map((s) => [s.longitude, s.latitude] as [number, number])
}

/** A distance for a person: metres under a kilometre, otherwise km to one place. */
export function distanceText(metres?: number): string {
  if (metres == null) return '—'
  if (metres < 1000) return `${Math.round(metres)} m`
  return `${(metres / 1000).toFixed(1)} km`
}
