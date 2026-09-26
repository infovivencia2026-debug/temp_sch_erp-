import { Router, type Ctx, type Handler } from '../../router'
import { badRequest, created, isUUID, notFound, ok, readJSON, uuid } from '../../http'
import { registerTransport } from '../ops/transport'
import { all, coded, instId, istFormat, nowISO, numOrNull, rfc3339UTC, todayIST, trimStr, uuidOr400 } from './common'
import { clampTripTimeoutMins, hashPairCode, trackingPolicy } from './tracking'

/* The transport office's tracker screens under /transport/*:
   bus_tracker_admin.go (trackers, tracking policy, stop events),
   bus_tracker.go (pairing), device_login.go (approving a handset),
   bus_tracker_roster.go (driver notices), bus_tracking_views.go (live map,
   safety events) and transport_live_map.go (map stops).

   /transport/tracking-policy is the same Go handler pair as
   /ops/transport/policy, which ops/transport.ts already ports. It is reused
   rather than copied: that module's routes are registered on a private
   router and the two policy handlers are dispatched from it. */

const READ = 'operations.transport.read'
const WRITE = 'operations.transport.write'

const opsTransport = new Router()
registerTransport(opsTransport)
/** The handler ops/transport.ts registered for this method and /ops path. */
function opsHandler(method: 'GET' | 'PUT', path: string): Handler {
  const hit = opsTransport.match(method, '/api/v1' + path)
  if (!hit) throw new Error(`ops/transport.ts no longer serves ${method} ${path}`)
  return hit.route.handler
}

const actor = (c: Ctx) => (c.id.platformAdmin ? null : c.id.userId)
const b = (v: number | null) => (v === null ? null : !!v)
const secondsSince = (iso: string | null) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 1000) : null)
function put(o: Record<string, unknown>, k: string, v: unknown) { if (v !== null && v !== undefined) o[k] = v }

// --- trackers ----------------------------------------------------------------------

async function listTrackers(c: Ctx): Promise<Response> {
  const rows = await all<{ vehicle_id: string; registration_no: string; model: string | null; status: string; route: string | null
    driver: string; tracker_id: string | null; tracker: string | null; device_model: string | null; app_version: string | null
    last_seen_at: string | null; battery_pct: number | null; charging: number | null; location_ok: number | null; ping_seconds: number | null
    paused: number | null; revoked_at: string | null; revoked_reason: string | null; approved_at: string | null; enrolled_by: string | null
    trip_id: string | null; trip_started: string | null; last_fix: string | null; timeout_mins: number | null }>(c.db.prepare(`
    SELECT v.id AS vehicle_id, v.registration_no, v.model, v.status, rt.name AS route,
           TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) AS driver,
           tr.id AS tracker_id, tr.name AS tracker, tr.device_model, tr.app_version, tr.last_seen_at, tr.battery_pct, tr.charging,
           tr.location_ok, tr.ping_seconds, tr.paused, tr.revoked_at, tr.revoked_reason, tr.approved_at, eu.full_name AS enrolled_by,
           vt.id AS trip_id, vt.started_at AS trip_started, lp.recorded_at AS last_fix, pol.trip_timeout_mins AS timeout_mins
      FROM vehicles v
      LEFT JOIN vehicle_trackers tr ON tr.id = (SELECT t.id FROM vehicle_trackers t WHERE t.vehicle_id = v.id
                                               ORDER BY t.revoked_at IS NULL DESC, t.paired_at DESC LIMIT 1)
      LEFT JOIN vehicle_trips vt ON vt.vehicle_id = v.id AND vt.ended_at IS NULL
      LEFT JOIN routes rt ON rt.id = vt.route_id
      LEFT JOIN vehicle_last_position lp ON lp.vehicle_id = v.id AND lp.trip_id = vt.id
      LEFT JOIN transport_tracking_policy pol ON pol.institution_id = v.institution_id
      LEFT JOIN employees e ON e.id = v.driver_employee_id
      LEFT JOIN users eu ON eu.id = tr.enrolled_by
     WHERE v.status <> 'retired'
     ORDER BY (tr.id IS NOT NULL AND tr.revoked_at IS NULL AND tr.approved_at IS NULL) DESC,
              (tr.id IS NOT NULL AND tr.revoked_at IS NULL), v.registration_no`))
  let unpaired = 0
  const items = rows.map((v) => {
    const paired = v.tracker_id !== null && v.revoked_at === null
    const pending = paired && v.approved_at === null
    if (!paired) unpaired++
    let timedOut = false
    if (v.trip_id !== null && v.trip_started) {
      const heard = Math.max(Date.parse(v.trip_started), v.last_fix ? Date.parse(v.last_fix) : Date.parse(v.trip_started))
      timedOut = heard + clampTripTimeoutMins(v.timeout_mins ?? 20) * 60_000 < Date.now()
    }
    const o: Record<string, unknown> = { vehicle_id: v.vehicle_id, registration_no: v.registration_no }
    if (v.model) o.vehicle_model = v.model
    o.vehicle_status = v.status
    if (v.route) o.route = v.route
    if (v.driver) o.driver = v.driver
    put(o, 'tracker_id', v.tracker_id)
    put(o, 'tracker', v.tracker)
    put(o, 'device_model', v.device_model)
    put(o, 'app_version', v.app_version)
    put(o, 'last_seen_at', istFormat(v.last_seen_at, 'datetime'))
    put(o, 'quiet_seconds', secondsSince(v.last_seen_at))
    put(o, 'battery_pct', v.battery_pct)
    put(o, 'charging', b(v.charging))
    put(o, 'location_ok', b(v.location_ok))
    put(o, 'ping_seconds', v.ping_seconds)
    put(o, 'paused', b(v.paused))
    put(o, 'revoked_at', istFormat(v.revoked_at, 'datetime'))
    put(o, 'revoked_reason', v.revoked_reason)
    o.paired = paired
    o.pending = pending
    put(o, 'enrolled_by', v.enrolled_by)
    o.run_timed_out = timedOut
    return o
  })
  return ok({ items, unpaired })
}

async function updateTracker(c: Ctx): Promise<Response> {
  const trackerID = uuidOr400(c.params.id)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const name = req.name === undefined || req.name === null ? null : String(req.name)
  const ping = req.ping_seconds === undefined || req.ping_seconds === null ? null : Math.trunc(Number(req.ping_seconds))
  const paused = req.paused === undefined || req.paused === null ? null : !!req.paused
  if (name !== null && name.trim() === '') {
    throw badRequest('give the handset a name somebody will recognise when this bus stops reporting, "Ravi\'s phone", not a blank')
  }
  if (ping !== null && (ping < 5 || ping > 300)) {
    throw badRequest('the phone can report every 5 to 300 seconds. Below 5 it flattens the battery before lunch; above 300 the map is five minutes behind the bus')
  }
  if (name === null && ping === null && paused === null) throw badRequest('nothing to change: send a name, ping_seconds or paused')
  const r = await c.db.prepare(`UPDATE vehicle_trackers SET name = COALESCE(?, name), ping_seconds = COALESCE(?, ping_seconds),
      paused = COALESCE(?, paused), updated_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(name === null ? null : name.trim(), ping, paused === null ? null : paused ? 1 : 0, nowISO(), trackerID).run()
  if (!r.meta.changes) throw coded(409, 'no_such_tracker', 'that tracker is either missing or has already been revoked')
  return ok({ saved: true })
}

async function revokeTracker(c: Ctx): Promise<Response> {
  const trackerID = uuidOr400(c.params.id)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const reason = trimStr(req.reason)
  if (reason === '') throw badRequest('say why this phone is being unpaired, the next person on this desk has to decide whether to re-pair it')
  const ts = nowISO()
  const res = await c.db.batch([
    c.db.prepare(`UPDATE vehicle_trackers SET revoked_at = ?, revoked_reason = ?, paused = 1, updated_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .bind(ts, reason, ts, trackerID),
    // Only when this call did the revoking: the trip closes with it.
    c.db.prepare(`UPDATE vehicle_trips SET ended_at = ?, ended_reason = 'admin'
        WHERE tracker_id = ?2 AND ended_at IS NULL AND (SELECT revoked_at FROM vehicle_trackers WHERE id = ?2) = ?1`).bind(ts, trackerID),
  ])
  if (!res[0].meta.changes) throw coded(409, 'no_such_tracker', 'that tracker is either missing or already revoked')
  return ok({ revoked: true })
}

async function pairBusTracker(c: Ctx): Promise<Response> {
  const inst = instId(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  let vehicle: string | null = null
  const raw = trimStr(req.vehicle_id)
  if (raw !== '') {
    if (!isUUID(raw)) throw badRequest('vehicle_id must be a uuid, or left out entirely')
    vehicle = raw
  }
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  const code = Array.from(bytes, (x) => '0123456789'[x % 10]).join('')
  const expiresMs = Date.now() + 10 * 60_000
  let registration = ''
  if (vehicle !== null) {
    const v = await c.db.prepare(`SELECT registration_no FROM vehicles WHERE id = ?`).bind(vehicle).first<{ registration_no: string }>()
    if (!v) throw notFound()
    registration = v.registration_no
  }
  const ts = nowISO()
  try {
    await c.db.batch([
      c.db.prepare(`UPDATE vehicle_tracker_pair_codes SET expires_at = ? WHERE institution_id = ? AND claimed_at IS NULL AND expires_at > ?`).bind(ts, inst, ts),
      c.db.prepare(`INSERT INTO vehicle_tracker_pair_codes (id, institution_id, vehicle_id, code_hash, expires_at, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst, vehicle, await hashPairCode(code), new Date(expiresMs).toISOString(), actor(c), ts),
    ])
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : String(e))
  }
  return ok({ pair_code: code, expires_at: rfc3339UTC(expiresMs), valid_minutes: 10, vehicle: registration })
}

async function approveBusTracker(c: Ctx): Promise<Response> {
  const inst = instId(c)
  const trackerID = c.params.id
  if (!isUUID(trackerID)) throw badRequest('that is not a tracker id')
  const allowed = c.id.platformAdmin || c.id.roles.includes('institution_admin') || c.id.roles.includes('super_admin')
  if (!allowed) throw coded(403, 'not_an_approver', 'only the principal or a platform administrator can let a bus tracker start reporting')
  const ts = nowISO()
  const r = await c.db.prepare(`UPDATE vehicle_trackers SET approved_at = COALESCE(approved_at, ?), approved_by = COALESCE(approved_by, ?)
      WHERE institution_id = ? AND id = ? AND revoked_at IS NULL`).bind(ts, actor(c), inst, trackerID).run()
  if (!r.meta.changes) throw notFound()
  return ok({ approved: true })
}

// --- stop events, live map, safety -------------------------------------------------------

async function listStopEvents(c: Ctx): Promise<Response> {
  const q = c.url.searchParams
  let trip: string | null = null
  const rawTrip = trimStr(q.get('trip_id'))
  if (rawTrip !== '') { if (!isUUID(rawTrip)) throw badRequest('trip_id must be a uuid'); trip = rawTrip }
  let date: string | null = null
  const rawDate = trimStr(q.get('date'))
  if (rawDate !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) || Number.isNaN(Date.parse(rawDate + 'T00:00:00Z'))) throw badRequest('date must be YYYY-MM-DD')
    date = rawDate
  }
  if (trip === null && date === null) date = todayIST()
  // The IST day as a UTC half-open range.
  const from = date ? new Date(Date.parse(date + 'T00:00:00Z') - 330 * 60_000).toISOString() : null
  const to = date ? new Date(Date.parse(date + 'T00:00:00Z') + (1440 - 330) * 60_000).toISOString() : null
  const rows = await all<{ id: string; trip_id: string; registration_no: string; route: string; direction: string; stop: string; sequence: number; kind: string
    scheduled: string | null; occurred_at: string; deviation_mins: number | null; latitude: string | null; longitude: string | null; driver: string }>(c.db.prepare(`
    SELECT se.id, se.trip_id, v.registration_no, rt.name AS route, t.direction, rs.name AS stop, rs.sequence, se.kind,
           CASE WHEN t.direction = 'drop' THEN rs.drop_time ELSE rs.pickup_time END AS scheduled,
           se.occurred_at, se.deviation_mins, se.latitude, se.longitude,
           TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) AS driver
      FROM transport_stop_events se
      JOIN vehicle_trips t ON t.id = se.trip_id
      JOIN vehicles v ON v.id = t.vehicle_id
      JOIN routes rt ON rt.id = t.route_id
      JOIN route_stops rs ON rs.id = se.stop_id
      LEFT JOIN employees e ON e.id = v.driver_employee_id
     WHERE (?1 IS NULL OR se.trip_id = ?1) AND (?2 IS NULL OR (se.occurred_at >= ?2 AND se.occurred_at < ?3))
     ORDER BY se.occurred_at DESC LIMIT 500`).bind(trip, from, to))
  return ok({
    items: rows.map((v) => {
      const o: Record<string, unknown> = { id: v.id, trip_id: v.trip_id, registration_no: v.registration_no, route: v.route, direction: v.direction,
        stop: v.stop, sequence: v.sequence, kind: v.kind }
      if (v.scheduled) o.scheduled_at = v.scheduled.slice(0, 5)
      o.occurred_at = istFormat(v.occurred_at, 'datetime') ?? ''
      put(o, 'deviation_mins', v.deviation_mins)
      put(o, 'latitude', numOrNull(v.latitude))
      put(o, 'longitude', numOrNull(v.longitude))
      if (v.driver) o.driver = v.driver
      return o
    }),
  })
}

async function listLiveVehicles(c: Ctx): Promise<Response> {
  const inst = instId(c)
  const rows = await all<{ vehicle_id: string; registration_no: string; route: string | null; route_id: string | null; direction: string | null
    trip_id: string | null; driver: string; driver_phone: string | null; latitude: string | null; longitude: string | null; speed_kmph: string | null
    heading_deg: number | null; recorded_at: string | null; tracker: string | null; battery_pct: number | null; charging: number | null
    location_ok: number | null; tracker_seen: string | null; paired: number }>(c.db.prepare(`
    SELECT v.id AS vehicle_id, v.registration_no, rt.name AS route, rt.id AS route_id, t.direction, t.id AS trip_id,
           TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) AS driver, e.phone AS driver_phone,
           lp.latitude, lp.longitude, lp.speed_kmph, lp.heading_deg, lp.recorded_at,
           tr.name AS tracker, tr.battery_pct, tr.charging, tr.location_ok, tr.last_seen_at AS tracker_seen, tr.id IS NOT NULL AS paired
      FROM vehicles v
      LEFT JOIN vehicle_trackers tr ON tr.vehicle_id = v.id AND tr.revoked_at IS NULL
      LEFT JOIN vehicle_trips t ON t.vehicle_id = v.id AND t.ended_at IS NULL
      LEFT JOIN routes rt ON rt.id = t.route_id
      LEFT JOIN vehicle_last_position lp ON lp.vehicle_id = v.id AND lp.trip_id = t.id
      LEFT JOIN employees e ON e.id = v.driver_employee_id
     WHERE v.status <> 'retired'
     ORDER BY t.id IS NULL, rt.name IS NULL, rt.name, v.registration_no`))
  const ping = (await trackingPolicy(c, inst)).pingSeconds
  const stale = ping * 3 + 15
  const items = rows.map((v) => {
    const age = secondsSince(v.recorded_at)
    const o: Record<string, unknown> = { vehicle_id: v.vehicle_id, registration_no: v.registration_no }
    put(o, 'route', v.route)
    put(o, 'route_id', v.route_id)
    put(o, 'direction', v.direction)
    put(o, 'trip_id', v.trip_id)
    o.driver = v.driver
    put(o, 'driver_phone', v.driver_phone)
    put(o, 'latitude', numOrNull(v.latitude))
    put(o, 'longitude', numOrNull(v.longitude))
    put(o, 'speed_kmph', numOrNull(v.speed_kmph))
    put(o, 'heading_deg', v.heading_deg)
    put(o, 'recorded_at', istFormat(v.recorded_at, 'datetime_s'))
    put(o, 'age_seconds', age)
    o.state = v.trip_id === null ? 'idle' : age === null || age > stale ? 'stale' : 'running'
    put(o, 'tracker', v.tracker)
    put(o, 'battery_pct', v.battery_pct)
    put(o, 'charging', b(v.charging))
    put(o, 'location_ok', b(v.location_ok))
    put(o, 'tracker_last_seen', istFormat(v.tracker_seen, 'datetime_s'))
    o.paired = !!v.paired
    return o
  })
  return ok({ items, ping_seconds: ping, stale_after_seconds: stale })
}

async function listSafetyEvents(c: Ctx): Promise<Response> {
  const open = c.url.searchParams.get('open') === 'true'
  const rows = await all<{ id: string; registration_no: string; route: string | null; driver: string; kind: string; started_at: string; ended_at: string | null
    peak_kmph: string | null; limit_kmph: number | null; latitude: string | null; longitude: string | null; reviewed_at: string | null; review_note: string | null }>(
    c.db.prepare(`
    SELECT se.id, v.registration_no, rt.name AS route, TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) AS driver,
           se.kind, se.started_at, se.ended_at, se.peak_kmph, se.limit_kmph, se.latitude, se.longitude, se.reviewed_at, se.review_note
      FROM transport_safety_events se
      JOIN vehicles v ON v.id = se.vehicle_id
      LEFT JOIN vehicle_trips t ON t.id = se.trip_id
      LEFT JOIN routes rt ON rt.id = t.route_id
      LEFT JOIN employees e ON e.id = v.driver_employee_id
     WHERE (? = 0 OR se.reviewed_at IS NULL)
     ORDER BY se.reviewed_at IS NOT NULL, se.started_at DESC LIMIT 300`).bind(open ? 1 : 0))
  return ok({
    items: rows.map((v) => {
      const o: Record<string, unknown> = { id: v.id, registration_no: v.registration_no }
      put(o, 'route', v.route)
      o.driver = v.driver
      o.kind = v.kind
      o.started_at = istFormat(v.started_at, 'datetime') ?? ''
      const end = v.ended_at ? Date.parse(v.ended_at) : Date.now()
      o.minutes = Math.max(1, Math.round((end - Date.parse(v.started_at)) / 60_000))
      put(o, 'peak_kmph', numOrNull(v.peak_kmph))
      put(o, 'limit_kmph', v.limit_kmph)
      put(o, 'latitude', numOrNull(v.latitude))
      put(o, 'longitude', numOrNull(v.longitude))
      put(o, 'reviewed_at', istFormat(v.reviewed_at, 'datetime'))
      put(o, 'review_note', v.review_note)
      return o
    }),
  })
}

async function reviewSafetyEvent(c: Ctx): Promise<Response> {
  const eventID = uuidOr400(c.params.id)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const note = typeof req.review_note === 'string' ? req.review_note : ''
  if (note.length === 0) throw badRequest('say what was done about it before closing it')
  const r = await c.db.prepare(`UPDATE transport_safety_events SET reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ? AND reviewed_at IS NULL`)
    .bind(nowISO(), actor(c), note, eventID).run()
  if (!r.meta.changes) throw coded(409, 'already_reviewed', 'that alert is either missing or already closed')
  return ok({ reviewed: true })
}

async function listTransportMapStops(c: Ctx): Promise<Response> {
  const rows = await all<{ id: string; name: string; route_id: string; route: string; sequence: number; latitude: string; longitude: string; geofence_m: number | null }>(
    c.db.prepare(`
    SELECT rs.id, rs.name, rs.route_id, rt.name AS route, rs.sequence, rs.latitude, rs.longitude, rs.geofence_m
      FROM route_stops rs JOIN routes rt ON rt.id = rs.route_id
     WHERE rs.latitude IS NOT NULL AND rs.longitude IS NOT NULL
     ORDER BY rt.name, rs.sequence`))
  return ok({
    items: rows.map((v) => {
      const o: Record<string, unknown> = { id: v.id, name: v.name, route_id: v.route_id, route: v.route, sequence: v.sequence,
        latitude: Number(v.latitude), longitude: Number(v.longitude) }
      put(o, 'geofence_m', v.geofence_m)
      return o
    }),
  })
}

// --- driver notices ---------------------------------------------------------------------------

async function sendDriverNotice(c: Ctx): Promise<Response> {
  const inst = instId(c)
  const vehicle = uuidOr400(c.params.id)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const body = trimStr(req.body)
  if (body === '' || new TextEncoder().encode(body).length > 500) throw badRequest('body must be 1 to 500 characters')
  const v = await c.db.prepare(`SELECT id FROM vehicles WHERE id = ?`).bind(vehicle).first<{ id: string }>()
  if (!v) throw notFound()
  const id = uuid()
  const ts = Date.now()
  await c.db.prepare(`INSERT INTO driver_notices (id, institution_id, vehicle_id, body, sent_by, sent_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, inst, vehicle, body, actor(c), new Date(ts).toISOString(), new Date(ts + 12 * 3600_000).toISOString()).run()
  return created({ id })
}

async function listDriverNotices(c: Ctx): Promise<Response> {
  const vehicle = uuidOr400(c.params.id)
  const rows = await all<{ id: string; body: string; sent_at: string; sent_by: string | null; acknowledged_at: string | null; acknowledged_by: string | null; expires_at: string }>(
    c.db.prepare(`
    SELECT n.id, n.body, n.sent_at, (SELECT full_name FROM users WHERE id = n.sent_by) AS sent_by, n.acknowledged_at,
           (SELECT full_name FROM users WHERE id = n.acknowledged_by) AS acknowledged_by, n.expires_at
      FROM driver_notices n WHERE n.vehicle_id = ? ORDER BY n.sent_at DESC LIMIT 30`).bind(vehicle))
  return ok({
    items: rows.map((v) => {
      const o: Record<string, unknown> = { id: v.id, body: v.body, sent_at: istFormat(v.sent_at, 'dmon_hm') ?? '' }
      put(o, 'sent_by', v.sent_by)
      put(o, 'acknowledged_at', istFormat(v.acknowledged_at, 'dmon_hm'))
      put(o, 'acknowledged_by', v.acknowledged_by)
      o.expired = v.acknowledged_at === null && Date.parse(v.expires_at) <= Date.now()
      return o
    }),
  })
}

export function registerTransportOfficeTracking(r: Router): void {
  r.get('/transport/trackers', READ, listTrackers)
  r.post('/transport/trackers/pair', WRITE, pairBusTracker)
  r.put('/transport/trackers/{id}', WRITE, updateTracker)
  r.post('/transport/trackers/{id}/revoke', WRITE, revokeTracker)
  r.post('/transport/trackers/{id}/approve', WRITE, approveBusTracker)
  r.get('/transport/tracking-policy', READ, opsHandler('GET', '/ops/transport/policy'))
  r.put('/transport/tracking-policy', WRITE, opsHandler('PUT', '/ops/transport/policy'))
  r.get('/transport/stop-events', READ, listStopEvents)
  r.get('/transport/live', READ, listLiveVehicles)
  r.get('/transport/safety-events', READ, listSafetyEvents)
  r.post('/transport/safety-events/{id}/review', WRITE, reviewSafetyEvent)
  r.get('/transport/map-stops', READ, listTransportMapStops)
  r.get('/transport/vehicles/{id}/notices', READ, listDriverNotices)
  r.post('/transport/vehicles/{id}/notices', WRITE, sendDriverNotice)
}
