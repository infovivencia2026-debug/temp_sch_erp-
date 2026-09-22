/* Where a bus is along its run, worked out from the stops.

   The server gives the route as an ordered list of stops with positions and
   the bus as one fix. It does not give the road, so "how far along" cannot be
   measured along it; what can be said honestly is which two stops the bus is
   between, and therefore which stops are behind it and which are still to
   come. That is what the guidance timeline draws: passed stops muted, the
   bus between two of them, the rest ahead.

   BETWEEN, NOT NEAREST. The first version took the nearest stop and called
   everything up to it passed, which put a bus 100 m short of Clock Tower on
   the far side of Clock Tower -- the one reading the timeline must never
   give, because a parent at that stop would see the bus as gone. So each leg
   of the run (stop i to stop i+1, as a straight line) is treated as a
   segment, the bus is projected onto every leg, and the leg it lies closest
   to is the one it is on: the stops up to that leg's start are behind it.
   Before the first leg nothing is passed; beyond the last, everything is.

   Still deliberately coarse -- a real progress model needs the road, and a
   wrong-but-confident position is worse than a plain one. */

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

/* A stop within this many metres is the one the bus is AT: the stop is the
   next thing on the timeline rather than something it has gone past. A bus
   length and a half of GPS wobble. Geofences are the server's business and
   are drawn on the map, not decided here. */
const AT_STOP_M = 60

/** Local flat coordinates in metres around a reference latitude, so a
    projection onto a segment is ordinary geometry. */
function planar(lat: number, lon: number, refLat: number): [number, number] {
  return [lon * 111320 * Math.cos(refLat * (Math.PI / 180)), lat * 110574]
}

/** Where along the segment a->b the point p projects (0 at a, 1 at b, may
    fall outside), and how far p is from the segment. */
function project(p: [number, number], a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
  const k = Math.max(0, Math.min(1, t))
  const cx = a[0] + dx * k
  const cy = a[1] + dy * k
  return { t, distance: Math.hypot(p[0] - cx, p[1] - cy) }
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

  let cut: number
  if (best <= AT_STOP_M) {
    cut = nearest
  } else if (ordered.length === 1) {
    // One stop and the bus is not at it: nothing to say about direction.
    cut = 0
  } else {
    const p = planar(lat, lon, lat)
    const pts = ordered.map((s) => planar(s.latitude, s.longitude, lat))
    let leg = 0
    let legDistance = Infinity
    let legT = 0
    for (let i = 0; i < pts.length - 1; i++) {
      const { t, distance } = project(p, pts[i], pts[i + 1])
      if (distance < legDistance) {
        legDistance = distance
        leg = i
        legT = t
      }
    }
    /* On leg i the bus has left stop i and not reached stop i+1. Short of
       the first leg it has left nothing; beyond the last it has left the
       last stop too. */
    if (leg === 0 && legT <= 0) cut = 0
    else if (leg === pts.length - 2 && legT >= 1) cut = pts.length
    else cut = leg + 1
  }

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
  if (metres == null) return '-'
  if (metres < 1000) return `${Math.round(metres)} m`
  return `${(metres / 1000).toFixed(1)} km`
}
