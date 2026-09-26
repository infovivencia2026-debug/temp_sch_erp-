import type { Router, Ctx } from '../../router'
import { badRequest, isUUID, notFound, ok, readJSON, uuid } from '../../http'
import { firstLast } from '../comms/common'
import { inJSON, instId, istFormat, todayIST } from './common'
import { metresBetween, trackingPolicy } from './tracking'

/* The parent's view of the bus: getChildBus and saveWatchPrefs in
   bus_tracking_views.go. Gated on self.profile.read and narrowed in SQL to
   the caller's own children (g.user_id = the caller), as the Go handler is. */

const SELF = 'self.profile.read'
const ZERO = '00000000-0000-0000-0000-000000000000'

const staleAfter = (ping: number) => ping * 3 + 15

/** etaMinutes: crow-flies, floored at a crawl, rounded up. */
function etaMinutes(metres: number, speed: number | null): number | null {
  if (speed === null || metres < 0) return null
  return Math.trunc(metres / (Math.max(speed, 8) * 1000 / 60)) + 1
}

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

async function getChildBus(c: Ctx): Promise<Response> {
  const inst = instId(c)
  const policy = await trackingPolicy(c, inst)
  const today = todayIST()
  const rows = (await c.db.prepare(`
    WITH mine AS (
      SELECT st.id AS student_id, ${firstLast('st')} AS student_name
        FROM students st
        JOIN student_guardians sg ON sg.student_id = st.id
        JOIN guardians g ON g.id = sg.guardian_id
       WHERE g.user_id = ?1)
    SELECT m.student_id, m.student_name, rt.name AS route, COALESCE(v.registration_no, '') AS registration_no,
           rt.id AS route_id, rs.id AS stop_id, t.direction,
           ${firstLast('e')} AS driver,
           CASE WHEN t.id IS NOT NULL THEN e.phone END AS driver_phone,
           rs.name AS stop,
           substr(CASE WHEN t.direction = 'drop' THEN rs.drop_time ELSE rs.pickup_time END, 1, 5) AS scheduled_at,
           ev.occurred_at AS arrived,
           lp.latitude, lp.longitude, lp.speed_kmph, lp.heading_deg,
           rs.latitude AS stop_latitude, rs.longitude AS stop_longitude,
           CAST(ROUND((julianday('now') - julianday(lp.recorded_at)) * 86400) AS INTEGER) AS age_seconds,
           COALESCE(wp.refresh_seconds, wpall.refresh_seconds, ?2) AS refresh_seconds,
           COALESCE(wp.proximity_m, wpall.proximity_m, ?3) AS proximity_m
      FROM mine m
      JOIN transport_allocations ta ON ta.student_id = m.student_id
           AND ta.valid_from <= ?4 AND (ta.valid_to IS NULL OR ta.valid_to >= ?4)
      JOIN routes rt ON rt.id = ta.route_id
      LEFT JOIN vehicle_trips t ON t.route_id = rt.id AND t.ended_at IS NULL
      LEFT JOIN vehicles v ON v.id = COALESCE(t.vehicle_id, rt.vehicle_id)
      LEFT JOIN route_stops rs ON rs.id = CASE WHEN t.direction = 'drop' THEN ta.drop_stop_id ELSE ta.pickup_stop_id END
      LEFT JOIN transport_stop_events ev ON ev.trip_id = t.id AND ev.stop_id = rs.id AND ev.kind = 'arrived'
      LEFT JOIN vehicle_last_position lp ON lp.vehicle_id = v.id AND lp.trip_id = t.id
      LEFT JOIN employees e ON e.id = v.driver_employee_id
      LEFT JOIN transport_watch_prefs wp ON wp.user_id = ?1 AND wp.student_id = m.student_id
      LEFT JOIN transport_watch_prefs wpall ON wpall.user_id = ?1 AND wpall.student_id IS NULL
     ORDER BY m.student_name`)
    .bind(c.id.userId, policy.pingSeconds, 800, today).all<Record<string, unknown>>()).results

  const routeIds = [...new Set(rows.map((r) => String(r.route_id)))]
  const stopsByRoute = new Map<string, Record<string, unknown>[]>()
  if (routeIds.length) {
    const stops = (await c.db.prepare(`SELECT id, route_id, name, sequence, latitude, longitude, geofence_m FROM route_stops
        WHERE ${inJSON('route_id')} AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY route_id, sequence`)
      .bind(JSON.stringify(routeIds)).all<Record<string, unknown>>()).results
    for (const s of stops) {
      const o: Record<string, unknown> = { id: s.id, name: s.name, sequence: Number(s.sequence), latitude: Number(s.latitude), longitude: Number(s.longitude) }
      if (s.geofence_m !== null) o.geofence_m = Number(s.geofence_m)
      const k = String(s.route_id)
      if (!stopsByRoute.has(k)) stopsByRoute.set(k, [])
      stopsByRoute.get(k)!.push(o)
    }
  }

  const stale = staleAfter(policy.pingSeconds)
  const items = rows.map((r) => {
    let lat = n(r.latitude), lon = n(r.longitude), heading = n(r.heading_deg)
    let driverPhone = (r.driver_phone as string | null) ?? null
    const stopLat = n(r.stop_latitude), stopLon = n(r.stop_longitude), speed = n(r.speed_kmph), age = n(r.age_seconds)
    const arrivedAt = istFormat(r.arrived as string | null, 'hm')
    const metres = lat !== null && lon !== null && stopLat !== null && stopLon !== null ? Math.trunc(metresBetween(lat, lon, stopLat, stopLon)) : null
    let state: string
    if (!policy.parentsMayWatch) { state = 'not_published'; lat = null; lon = null; heading = null; driverPhone = null }
    else if (arrivedAt !== null) state = 'arrived'
    else if (r.direction === null) state = 'not_running'
    else if (lat === null || age === null) state = 'no_signal'
    else if (age > stale) state = 'stale'
    else state = 'running'
    const eta = state === 'running' && metres !== null ? etaMinutes(metres, speed) : null
    const o: Record<string, unknown> = {
      student_id: r.student_id, student_name: r.student_name, route: r.route, registration_no: r.registration_no,
      direction: r.direction, driver: r.driver, driver_phone: driverPhone, stop: r.stop, scheduled_at: r.scheduled_at, arrived_at: arrivedAt,
      latitude: lat, longitude: lon, stop_latitude: stopLat, stop_longitude: stopLon,
      route_id: r.route_id, stop_id: r.stop_id, stops: stopsByRoute.get(String(r.route_id)) ?? [],
      age_seconds: age, metres_away: metres, eta_minutes: eta, speed_kmph: speed, heading_deg: heading,
      state, refresh_seconds: Number(r.refresh_seconds), proximity_m: Number(r.proximity_m), watchable: policy.parentsMayWatch,
    }
    for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined) delete o[k]
    return o
  })
  return ok({ items, stale_after_seconds: stale, parents_may_watch: policy.parentsMayWatch })
}

async function saveWatchPrefs(c: Ctx): Promise<Response> {
  const inst = instId(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const intField = (k: string): number => {
    const v = req[k]
    if (v === undefined || v === null) return 0
    if (typeof v !== 'number' || !Number.isInteger(v)) throw badRequest('malformed JSON body')
    return v
  }
  const studentId = typeof req.student_id === 'string' ? req.student_id : ''
  if (req.student_id !== undefined && req.student_id !== null && typeof req.student_id !== 'string') throw badRequest('malformed JSON body')
  let refresh = intField('refresh_seconds'), proximity = intField('proximity_m')
  if (refresh === 0) refresh = 20
  if (proximity === 0) proximity = 800
  if (refresh < 10 || refresh > 300) throw badRequest('refresh between 10 and 300 seconds')
  if (proximity < 100 || proximity > 5000) throw badRequest('the alert distance has to be between 100 m and 5 km')
  if (req.notify_approach !== undefined && req.notify_approach !== null && typeof req.notify_approach !== 'boolean') throw badRequest('malformed JSON body')
  const notify = typeof req.notify_approach === 'boolean' ? req.notify_approach : true

  if (studentId !== '') {
    if (!isUUID(studentId)) throw badRequest(`invalid input syntax for type uuid: "${studentId}"`)
    const mine = await c.db.prepare(`SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE g.user_id = ? AND sg.student_id = ?`)
      .bind(c.id.userId, studentId).first()
    if (!mine) throw notFound()
  }
  const student = studentId === '' ? null : studentId
  const t = new Date().toISOString()
  // ON CONFLICT (user_id, COALESCE(student_id, nil)): an update, then an insert where nothing matched.
  const match = `user_id = ?1 AND COALESCE(student_id, '${ZERO}') = COALESCE(?2, '${ZERO}')`
  await c.db.batch([
    c.db.prepare(`UPDATE transport_watch_prefs SET refresh_seconds = ?3, proximity_m = ?4, notify_approach = ?5, updated_at = ?6 WHERE ${match}`)
      .bind(c.id.userId, student, refresh, proximity, notify ? 1 : 0, t),
    c.db.prepare(`INSERT INTO transport_watch_prefs (id, institution_id, user_id, student_id, refresh_seconds, proximity_m, notify_approach, updated_at)
        SELECT ?7, ?8, ?1, ?2, ?3, ?4, ?5, ?6 WHERE NOT EXISTS (SELECT 1 FROM transport_watch_prefs WHERE ${match})`)
      .bind(c.id.userId, student, refresh, proximity, notify ? 1 : 0, t, uuid(), inst),
  ])
  return ok({ saved: true })
}

export function registerChildBus(r: Router): void {
  r.get('/me/child-bus', SELF, getChildBus)
  r.post('/me/child-bus/prefs', SELF, saveWatchPrefs)
}
