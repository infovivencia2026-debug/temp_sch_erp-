import type { Ctx, Router } from '../../router'
import { HttpError, badRequest, bool, created, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { instId } from './common'

/* Port of the transport fleet, routes and tracking-policy handlers:
   role_backoffice.go (listVehicles), transport_driver.go (getMyBus),
   transport_vehicles.go, transport_routes.go, mod_ops.go (listRoutes,
   listRouteStops) and the two policy handlers of bus_tracker_admin.go.

   Postgres-only pieces and how they are done here:
   - least(COALESCE(expiry,'infinity')): the dates are ISO text, so a plain
     min() over COALESCE(..., '9999-12-31') with NULLIF back to null.
   - trackingPolicyFor's INSERT ... ON CONFLICT DO NOTHING: INSERT OR IGNORE.
   - ensureSchoolStops' partial unique upsert: the school stop is looked up
     first, then updated or inserted inside the same batch.
   - saveRoute's "id <> ALL($2)": the kept ids are known before the batch,
     so the delete lists them with `NOT IN (?, ...)`.
   No CREATE TRIGGER exists on vehicles, routes, route_stops or
   transport_tracking_policy, so nothing else is re-implemented. */

// --- shared -------------------------------------------------------------------

/** requireInstitution in Go: the same sentence, a 400, and no write attempted. */
function requireInstitution(c: Ctx): string {
  const inst = c.id.institution
  if (!inst) {
    throw badRequest('this screen belongs to a school. Sign in against one, or pick a school first - ' +
      "a platform operator's account is not attached to any.")
  }
  return inst.id
}

/** optionalUUID: '' is null, anything else must parse. */
function optionalUUID(raw: unknown, msg: string): string | null {
  const v = typeof raw === 'string' ? raw.trim() : ''
  if (v === '') return null
  if (!isUUID(v)) throw badRequest(msg)
  return v
}

const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message)

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const nullable = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** to_char(least(expiries),'YYYY-MM-DD') over ISO text dates. */
const NEXT_EXPIRY = `NULLIF(min(
    COALESCE(v.insurance_expiry,'9999-12-31'), COALESCE(v.fitness_expiry,'9999-12-31'),
    COALESCE(v.permit_expiry,'9999-12-31'), COALESCE(v.puc_expiry,'9999-12-31')), '9999-12-31')`

const fullName = (alias: string) => `NULLIF(TRIM(COALESCE(${alias}.first_name,'') || ' ' || COALESCE(${alias}.last_name,'')), '')`

// --- tracking policy ------------------------------------------------------------

interface Policy {
  default_geofence_m: number
  speed_limit_kmph: number
  speeding_hold_secs: number
  trip_timeout_mins: number
  ping_seconds: number
  parents_may_watch: boolean
  watch_window_mins: number
  retain_days: number
  school_latitude?: number
  school_longitude?: number
  school_geofence_m?: number
}

const parentsMayWatchNotice = 'While a bus is on a run, every guardian on that ' +
  'route can see where it is, how fast it is going and how late it is. ' +
  "They see nothing outside a run: the tracker is the driver's own phone, " +
  'and it is not visible before the trip starts or after it ends.'

interface PolicyRow {
  default_geofence_m: number; speed_limit_kmph: number; speeding_hold_secs: number
  trip_timeout_mins: number; ping_seconds: number; parents_may_watch: number
  watch_window_mins: number; retain_days: number
  school_latitude: string | null; school_longitude: string | null; school_geofence_m: number | null
}

/** trackingPolicyFor: the school's settings, created with the schema defaults on first read. */
async function trackingPolicyFor(c: Ctx, inst: string): Promise<Policy> {
  const q = c.db.prepare(`SELECT default_geofence_m, speed_limit_kmph, speeding_hold_secs, trip_timeout_mins, ping_seconds,
      parents_may_watch, watch_window_mins, retain_days, school_latitude, school_longitude, school_geofence_m
      FROM transport_tracking_policy WHERE institution_id = ?`).bind(inst)
  let row = await q.first<PolicyRow>()
  if (!row) {
    await c.db.prepare(`INSERT OR IGNORE INTO transport_tracking_policy (institution_id, updated_at) VALUES (?, ?)`).bind(inst, now()).run()
    row = await q.first<PolicyRow>()
    if (!row) throw new Error('tracking policy could not be created')
  }
  const p: Policy = {
    default_geofence_m: row.default_geofence_m, speed_limit_kmph: row.speed_limit_kmph,
    speeding_hold_secs: row.speeding_hold_secs, trip_timeout_mins: row.trip_timeout_mins,
    ping_seconds: row.ping_seconds, parents_may_watch: bool(row.parents_may_watch),
    watch_window_mins: row.watch_window_mins, retain_days: row.retain_days,
  }
  if (row.school_latitude !== null) p.school_latitude = Number(row.school_latitude)
  if (row.school_longitude !== null) p.school_longitude = Number(row.school_longitude)
  if (row.school_geofence_m !== null) p.school_geofence_m = row.school_geofence_m
  return p
}

function validateTrackingPolicy(b: Record<string, unknown>): string {
  const limits: [string, number, number, string][] = [
    ['default_geofence_m', 30, 2000, "under 30m a phone's own error puts the bus outside its own stop; over 2km the circle covers the next stop as well"],
    ['speed_limit_kmph', 10, 120, "this is the speed above which you want to be told, not the road's limit"],
    ['speeding_hold_secs', 5, 300, 'how long the bus must stay over before it counts, too short and every flyover raises an alert nobody reads by the second week'],
    ['trip_timeout_mins', 5, 240, 'how long a run may go unheard before the server closes it; too long and a parent watches a marker that stopped moving an hour ago'],
    ['ping_seconds', 5, 300, 'below 5 the handset is flat by two o\'clock; above 300 the map is five minutes behind the bus'],
    ['watch_window_mins', 5, 240, 'how long before the scheduled pickup the map opens to a parent'],
    ['retain_days', 7, 3650, 'how long the breadcrumb trail is kept; an incident enquiry needs weeks'],
  ]
  for (const [field, lo, hi, guidance] of limits) {
    const v = Number(b[field] ?? 0)
    if (!Number.isFinite(v) || v < lo || v > hi) return `${field} must be between ${lo} and ${hi}, ${guidance}`
  }
  return ''
}

/** ensureSchoolStops: the school pinned as the last stop of every route (or one route). Returns the statements. */
async function ensureSchoolStops(c: Ctx, inst: string, p: Policy, route: string | null): Promise<D1PreparedStatement[]> {
  if (p.school_latitude === undefined || p.school_longitude === undefined) return []
  const routes = route
    ? await c.db.prepare(`SELECT id FROM routes WHERE institution_id = ? AND id = ?`).bind(inst, route).all<{ id: string }>()
    : await c.db.prepare(`SELECT id FROM routes WHERE institution_id = ?`).bind(inst).all<{ id: string }>()
  const lat = String(p.school_latitude), lon = String(p.school_longitude), geo = p.school_geofence_m ?? null
  const out: D1PreparedStatement[] = []
  for (const { id } of routes.results) {
    const existing = await c.db.prepare(`SELECT id FROM route_stops WHERE route_id = ? AND is_school = 1 LIMIT 1`).bind(id).first<{ id: string }>()
    if (existing) {
      out.push(c.db.prepare(`UPDATE route_stops SET latitude = ?, longitude = ?, geofence_m = ?,
          sequence = (SELECT COALESCE(MAX(x.sequence), 0) + 1 FROM route_stops x WHERE x.route_id = ? AND NOT x.is_school)
          WHERE id = ?`).bind(lat, lon, geo, id, existing.id))
    } else {
      out.push(c.db.prepare(`INSERT INTO route_stops (id, institution_id, route_id, name, sequence, latitude, longitude, geofence_m, is_school)
          SELECT ?, ?, ?, 'School', COALESCE((SELECT MAX(sequence) FROM route_stops WHERE route_id = ?), 0) + 1, ?, ?, ?, 1`)
        .bind(uuid(), inst, id, id, lat, lon, geo))
    }
  }
  return out
}

// --- vehicles -------------------------------------------------------------------

interface VehicleBody {
  registration: string; model: string; capacity: number; driver: string | null; attendant: string | null
  campus: string | null; insurance: string; fitness: string; permit: string; puc: string; status: string
}

/** vehicleRequest.normalise: validates what needs no database, in the Go wording. */
function normaliseVehicle(req: Record<string, unknown>): VehicleBody {
  const registration = str(req.registration_no).trim().toUpperCase()
  if (registration === '') throw badRequest('the bus needs its registration number')
  const status = str(req.status) || 'active'
  if (!['active', 'maintenance', 'retired'].includes(status)) throw badRequest('status must be active, maintenance or retired')
  let capacity = 40
  if (req.capacity !== undefined && req.capacity !== null) capacity = Number(req.capacity)
  if (!Number.isFinite(capacity) || capacity <= 0) throw badRequest('capacity must be more than zero')
  return {
    registration, model: str(req.model).trim(), capacity: Math.trunc(capacity),
    driver: optionalUUID(req.driver_employee_id, 'driver_employee_id must be a uuid'),
    attendant: optionalUUID(req.attendant_employee_id, 'attendant_employee_id must be a uuid'),
    campus: optionalUUID(req.campus_id, 'campus_id must be a uuid'),
    insurance: str(req.insurance_expiry), fitness: str(req.fitness_expiry),
    permit: str(req.permit_expiry), puc: str(req.puc_expiry), status,
  }
}

/** staffBelongs: an employee id that is not in this school's database is refused. */
async function staffBelongs(c: Ctx, ...ids: (string | null)[]) {
  for (const id of ids) {
    if (!id) continue
    const row = await c.db.prepare(`SELECT 1 AS x FROM employees WHERE id = ?`).bind(id).first()
    if (!row) throw badRequest("that person is not on this school's staff")
  }
}

async function campusBelongs(c: Ctx, campus: string | null) {
  if (!campus) return
  const row = await c.db.prepare(`SELECT 1 AS x FROM campuses WHERE id = ?`).bind(campus).first()
  if (!row) throw badRequest("that campus is not this school's")
}

/** driverFree: a driver already on another active bus is refused, naming that bus. */
async function driverFree(c: Ctx, driver: string | null, exclude: string | null) {
  if (!driver) return
  const other = await c.db.prepare(`SELECT registration_no FROM vehicles WHERE driver_employee_id = ? AND status = 'active' AND (? IS NULL OR id <> ?) LIMIT 1`)
    .bind(driver, exclude, exclude).first<{ registration_no: string }>()
  if (other) {
    throw new HttpError(409, `that driver is already on bus ${other.registration_no}. Take him off it first, or the handset cannot tell which bus he is signing into`,
      { code: 'driver_assigned' })
  }
}

function vehicleWriteFailed(e: unknown): never {
  if (isUniqueViolation(e)) {
    throw new HttpError(409, 'a bus with that registration number is already on the register', { code: 'duplicate_registration' })
  }
  throw e
}

// --- register -------------------------------------------------------------------

export function registerTransport(r: Router): void {
  // Literal segments first, ahead of /transport/vehicles/{id} and /transport/routes/{id}.

  r.get('/ops/transport/my-bus', 'operations.transport.read', async (c) => {
    requireInstitution(c)
    const out: Record<string, unknown> = { stops: [], checks: [], riders: 0, tracker_paired: false }
    const emp = await c.db.prepare(`SELECT id, employee_code FROM employees WHERE user_id = ? AND status = 'active'`)
      .bind(c.id.userId).first<{ id: string; employee_code: string }>()
    if (!emp) {
      out.note = 'This login is not on the staff roll, so no bus can be found against it.'
      return ok(out)
    }
    out.employee_code = emp.employee_code
    const v = await c.db.prepare(`SELECT v.id, v.registration_no, v.model, v.capacity, ${fullName('a')} AS attendant,
        ${NEXT_EXPIRY} AS next_expiry, rt.id AS route_id, rt.name AS route_name, rt.code AS route_code,
        EXISTS (SELECT 1 FROM vehicle_trackers tr WHERE tr.vehicle_id = v.id AND tr.revoked_at IS NULL) AS paired
        FROM vehicles v
        LEFT JOIN employees a ON a.id = v.attendant_employee_id
        LEFT JOIN routes rt ON rt.vehicle_id = v.id AND rt.is_active
        WHERE v.driver_employee_id = ? AND v.status <> 'retired'
        ORDER BY rt.name IS NULL, rt.name LIMIT 1`).bind(emp.id)
      .first<{ id: string; registration_no: string; model: string | null; capacity: number; attendant: string | null; next_expiry: string | null; route_id: string | null; route_name: string | null; route_code: string | null; paired: number }>()
    if (!v) {
      out.note = 'No bus is assigned to you yet. The transport office puts a driver on a bus.'
      return ok(out)
    }
    out.vehicle_id = v.id
    out.registration_no = v.registration_no
    out.model = v.model ?? ''
    out.capacity = v.capacity
    out.attendant = v.attendant ?? ''
    out.next_expiry = v.next_expiry ?? ''
    out.route_id = v.route_id ?? ''
    out.route_name = v.route_name ?? ''
    out.route_code = v.route_code ?? ''
    out.tracker_paired = bool(v.paired)

    if (v.route_id) {
      const stops = await c.db.prepare(`SELECT rs.name, rs.sequence, substr(rs.pickup_time,1,5) AS pickup_time, substr(rs.drop_time,1,5) AS drop_time,
          (SELECT count(*) FROM transport_allocations ta WHERE ta.pickup_stop_id = rs.id AND ta.valid_to IS NULL) AS riders
          FROM route_stops rs WHERE rs.route_id = ? ORDER BY rs.sequence`).bind(v.route_id)
        .all<{ name: string; sequence: number; pickup_time: string | null; drop_time: string | null; riders: number }>()
      let riders = 0
      out.stops = stops.results.map((s) => { riders += s.riders; return s })
      out.riders = riders
    }

    const trip = await c.db.prepare(`SELECT direction, strftime('%Y-%m-%dT%H:%M:%S', started_at, '+5 hours', '+30 minutes') AS started
        FROM vehicle_trips WHERE vehicle_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`).bind(v.id)
      .first<{ direction: string; started: string | null }>()
    out.trip_direction = trip?.direction ?? ''
    out.trip_started_at = trip?.started ?? ''

    const checks = await c.db.prepare(`SELECT substr(on_date,1,10) AS on_date, leg, cleared, brakes_ok, tyres_ok, lights_ok, first_aid_ok,
        extinguisher_ok, doors_ok, breathalyser FROM trip_checks
        WHERE vehicle_id = ? AND on_date >= date('now','-14 days') ORDER BY on_date DESC, leg LIMIT 30`).bind(v.id)
      .all<Record<string, unknown>>()
    out.checks = checks.results.map((t) => {
      const failed: string[] = []
      if (!bool(t.brakes_ok)) failed.push('brakes')
      if (!bool(t.tyres_ok)) failed.push('tyres')
      if (!bool(t.lights_ok)) failed.push('lights')
      if (!bool(t.first_aid_ok)) failed.push('first aid')
      if (!bool(t.extinguisher_ok)) failed.push('extinguisher')
      if (!bool(t.doors_ok)) failed.push('doors')
      if ((Number(t.breathalyser) || 0) > 0) failed.push('breathalyser')
      return { on_date: t.on_date, leg: t.leg, cleared: bool(t.cleared), failed_items: failed }
    })
    return ok(out)
  })

  r.get('/ops/transport/assignable-staff', 'operations.transport.read', async (c) => {
    const rows = await c.db.prepare(`SELECT e.id, COALESCE(${fullName('e')}, 'Unnamed') AS full_name, COALESCE(e.employee_code, '') AS employee_code
        FROM employees e WHERE e.status = 'active' ORDER BY e.first_name, e.last_name LIMIT 500`).all()
    return ok({ items: rows.results })
  })

  r.get('/ops/transport/policy', 'operations.transport.read', async (c) => {
    const inst = requireInstitution(c)
    const policy = await trackingPolicyFor(c, inst)
    return ok({ policy, parents_may_watch_notice: parentsMayWatchNotice })
  })

  r.put('/ops/transport/policy', 'operations.transport.write', async (c) => {
    const inst = requireInstitution(c)
    const req = await readJSON(c.req)
    const msg = validateTrackingPolicy(req)
    if (msg) throw badRequest(msg)
    await trackingPolicyFor(c, inst)
    const lat = req.school_latitude ?? null, lon = req.school_longitude ?? null
    if ((lat === null) !== (lon === null)) throw badRequest('school_latitude and school_longitude go together: pick the school on the map')
    const geo = req.school_geofence_m === undefined || req.school_geofence_m === null ? null : Number(req.school_geofence_m)
    if (geo !== null && (geo < 30 || geo > 2000)) throw badRequest("school_geofence_m must be between 30 and 2000: the gate's circle in metres")

    await c.db.prepare(`UPDATE transport_tracking_policy
        SET default_geofence_m = ?, speed_limit_kmph = ?, speeding_hold_secs = ?, trip_timeout_mins = ?, ping_seconds = ?,
            parents_may_watch = ?, watch_window_mins = ?, retain_days = ?, school_latitude = ?, school_longitude = ?, school_geofence_m = ?,
            updated_at = ?, updated_by = ?
        WHERE institution_id = ?`)
      .bind(Number(req.default_geofence_m), Number(req.speed_limit_kmph), Number(req.speeding_hold_secs), Number(req.trip_timeout_mins),
        Number(req.ping_seconds), bool(req.parents_may_watch) ? 1 : 0, Number(req.watch_window_mins), Number(req.retain_days),
        lat === null ? null : String(Number(lat)), lon === null ? null : String(Number(lon)), geo, now(), c.id.userId, inst).run()
    const saved = await trackingPolicyFor(c, inst)
    // The gate goes onto every route the moment it is known.
    const stmts = await ensureSchoolStops(c, inst, saved, null)
    if (stmts.length) await c.db.batch(stmts)
    return ok({ policy: saved, parents_may_watch_notice: parentsMayWatchNotice })
  })

  // --- vehicles ---

  r.get('/ops/transport/vehicles', 'operations.transport.read', async (c) => {
    const rows = await c.db.prepare(`SELECT v.id, v.registration_no, v.model, v.capacity,
        (SELECT rt.name FROM routes rt WHERE rt.vehicle_id = v.id LIMIT 1) AS route,
        ${fullName('e')} AS driver, ${NEXT_EXPIRY} AS next_expiry, v.status,
        (SELECT rt.id FROM routes rt WHERE rt.vehicle_id = v.id LIMIT 1) AS route_id,
        v.driver_employee_id, v.attendant_employee_id,
        v.insurance_expiry, v.fitness_expiry, v.permit_expiry, v.puc_expiry, v.bus_code
        FROM vehicles v LEFT JOIN employees e ON e.id = v.driver_employee_id ORDER BY v.registration_no`).all()
    return ok({ items: rows.results })
  })

  r.post('/ops/transport/vehicles', 'operations.transport.write', async (c) => {
    const inst = instId(c)
    const req = normaliseVehicle(await readJSON(c.req))
    await staffBelongs(c, req.driver, req.attendant)
    await campusBelongs(c, req.campus)
    await driverFree(c, req.driver, null)
    // The six-digit sticker code, drawn until one is free in this school.
    let code = ''
    for (let attempt = 0; ; attempt++) {
      code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
      const taken = await c.db.prepare(`SELECT 1 AS x FROM vehicles WHERE institution_id = ? AND bus_code = ?`).bind(inst, code).first()
      if (!taken) break
      if (attempt > 20) throw badRequest('could not allocate a bus code')
    }
    const id = uuid()
    try {
      await c.db.prepare(`INSERT INTO vehicles (id, institution_id, campus_id, registration_no, model, capacity, driver_employee_id, attendant_employee_id,
          insurance_expiry, fitness_expiry, permit_expiry, puc_expiry, status, bus_code, created_at)
          VALUES (?, ?, COALESCE(?, (SELECT id FROM campuses ORDER BY created_at LIMIT 1)), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, inst, req.campus, req.registration, nullable(req.model), req.capacity, req.driver, req.attendant,
          nullable(req.insurance), nullable(req.fitness), nullable(req.permit), nullable(req.puc), req.status, code, now()).run()
    } catch (e) { vehicleWriteFailed(e) }
    return created({ id, registration_no: req.registration })
  })

  r.put('/ops/transport/vehicles/{id}', 'operations.transport.write', async (c) => {
    const vid = c.params.id
    if (!isUUID(vid)) throw badRequest('invalid vehicle id')
    const req = normaliseVehicle(await readJSON(c.req))
    await staffBelongs(c, req.driver, req.attendant)
    await driverFree(c, req.driver, vid)
    let changed = 0
    try {
      const res = await c.db.prepare(`UPDATE vehicles SET registration_no = ?, model = ?, capacity = ?, driver_employee_id = ?, attendant_employee_id = ?,
          insurance_expiry = ?, fitness_expiry = ?, permit_expiry = ?, puc_expiry = ?, status = ? WHERE id = ?`)
        .bind(req.registration, nullable(req.model), req.capacity, req.driver, req.attendant,
          nullable(req.insurance), nullable(req.fitness), nullable(req.permit), nullable(req.puc), req.status, vid).run()
      changed = res.meta.changes
    } catch (e) { vehicleWriteFailed(e) }
    if (!changed) throw notFound('resource not found')
    return ok({ id: vid, registration_no: req.registration })
  })

  r.put('/ops/transport/vehicles/{id}/route', 'operations.transport.write', async (c) => {
    const vid = c.params.id
    if (!isUUID(vid)) throw badRequest('invalid vehicle id')
    const req = await readJSON(c.req)
    const route = optionalUUID(req.route_id, 'route_id must be a uuid')
    const vehicle = await c.db.prepare(`SELECT 1 AS x FROM vehicles WHERE id = ?`).bind(vid).first()
    if (!vehicle) throw notFound('resource not found')
    // The route is confirmed before anything is cleared.
    if (route) {
      const found = await c.db.prepare(`SELECT 1 AS x FROM routes WHERE id = ?`).bind(route).first()
      if (!found) throw notFound('resource not found')
    }
    const stmts = [c.db.prepare(`UPDATE routes SET vehicle_id = NULL WHERE vehicle_id = ?`).bind(vid)]
    if (route) stmts.push(c.db.prepare(`UPDATE routes SET vehicle_id = ? WHERE id = ?`).bind(vid, route))
    await c.db.batch(stmts)
    return ok({ id: vid, route_id: str(req.route_id) })
  })

  // --- routes ---

  r.get('/ops/transport/routes', 'operations.transport.read', async (c) => {
    const rows = await c.db.prepare(`SELECT rt.id, rt.name, rt.code, v.registration_no AS vehicle, rt.distance_km,
        (SELECT count(*) FROM route_stops rs WHERE rs.route_id = rt.id) AS stops,
        (SELECT count(*) FROM transport_allocations ta WHERE ta.route_id = rt.id AND ta.valid_to IS NULL) AS riders,
        rt.is_active FROM routes rt LEFT JOIN vehicles v ON v.id = rt.vehicle_id ORDER BY rt.name`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((x) => ({ ...x, distance_km: x.distance_km === null ? null : String(x.distance_km), is_active: bool(x.is_active) })) })
  })

  r.get('/ops/transport/routes/{id}/stops', 'operations.transport.read', async (c) => {
    const rid = c.params.id
    if (!isUUID(rid)) throw badRequest('invalid route id')
    const rows = await c.db.prepare(`SELECT rs.id, rs.name, rs.sequence, substr(rs.pickup_time,1,5) AS pickup_time, substr(rs.drop_time,1,5) AS drop_time,
        COALESCE(rs.fare_paise,0) AS fare_paise, rs.geofence_m, rs.latitude, rs.longitude,
        (SELECT count(*) FROM transport_allocations ta WHERE ta.pickup_stop_id = rs.id AND ta.valid_to IS NULL) AS riders
        FROM route_stops rs WHERE rs.route_id = ? ORDER BY rs.sequence`).bind(rid).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((x) => ({ ...x,
      latitude: x.latitude === null ? null : String(x.latitude), longitude: x.longitude === null ? null : String(x.longitude) })) })
  })

  const saveRoute = async (c: Ctx) => {
    const inst = instId(c)
    const req = await readJSON(c.req)
    const name = str(req.name).trim()
    if (name === '') throw badRequest('a route needs a name')
    let routeID: string | null = null
    if (c.params.id !== undefined && c.params.id.trim() !== '') {
      if (!isUUID(c.params.id.trim())) throw badRequest('invalid route id')
      routeID = c.params.id.trim()
    }
    const vehicle = optionalUUID(req.vehicle_id, 'vehicle_id must be a uuid')
    const campus = optionalUUID(req.campus_id, 'campus_id must be a uuid')
    const active: boolean | null = typeof req.is_active === 'boolean' ? req.is_active : null
    const code = nullable(str(req.code))
    const distance = nullable(str(req.distance_km))

    if (campus) await campusBelongs(c, campus)
    if (vehicle) {
      const found = await c.db.prepare(`SELECT 1 AS x FROM vehicles WHERE id = ?`).bind(vehicle).first()
      if (!found) throw badRequest("that bus is not on this school's register")
    }

    const stmts: D1PreparedStatement[] = []
    let rid: string
    if (routeID === null) {
      rid = uuid()
      stmts.push(c.db.prepare(`INSERT INTO routes (id, institution_id, campus_id, name, code, vehicle_id, distance_km, is_active)
          VALUES (?, ?, COALESCE(?, (SELECT id FROM campuses WHERE institution_id = ? ORDER BY created_at LIMIT 1)), ?, ?, ?, ?, ?)`)
        .bind(rid, inst, campus, inst, name, code, vehicle, distance, active === null ? 1 : active ? 1 : 0))
    } else {
      rid = routeID
      const exists = await c.db.prepare(`SELECT 1 AS x FROM routes WHERE id = ?`).bind(rid).first()
      if (!exists) throw notFound('resource not found')
      stmts.push(c.db.prepare(`UPDATE routes SET name = ?, code = ?, vehicle_id = ?, distance_km = ?,
          is_active = COALESCE(?, is_active), campus_id = COALESCE(?, campus_id) WHERE id = ?`)
        .bind(name, code, vehicle, distance, active === null ? null : active ? 1 : 0, campus, rid))
    }
    // One bus, one route at a time.
    if (vehicle) stmts.push(c.db.prepare(`UPDATE routes SET vehicle_id = NULL WHERE vehicle_id = ? AND id <> ?`).bind(vehicle, rid))

    let stopCount = 0
    const stopsIn = Array.isArray(req.stops) ? (req.stops as Record<string, unknown>[]) : null
    if (stopsIn !== null) {
      // Matched by id, not replaced wholesale; positions parked out of the way first.
      const existing = new Set((await c.db.prepare(`SELECT id FROM route_stops WHERE route_id = ?`).bind(rid).all<{ id: string }>()).results.map((x) => x.id))
      stmts.push(c.db.prepare(`UPDATE route_stops SET sequence = sequence + 1000000 WHERE route_id = ?`).bind(rid))
      const kept: string[] = []
      let seq = 0
      for (const st of stopsIn) {
        const sname = str(st.name).trim()
        if (sname === '') { seq++; continue }
        seq++
        const pickup = nullable(str(st.pickup_time)), drop = nullable(str(st.drop_time))
        const lat = nullable(str(st.latitude).trim()), lon = nullable(str(st.longitude).trim())
        const fare = st.fare_paise === undefined || st.fare_paise === null ? null : Number(st.fare_paise)
        const geo = st.geofence_m === undefined || st.geofence_m === null ? null : Number(st.geofence_m)
        const sid = str(st.id).trim()
        if (isUUID(sid) && existing.has(sid)) {
          stmts.push(c.db.prepare(`UPDATE route_stops SET name = ?, sequence = ?, pickup_time = ?, drop_time = ?, latitude = ?, longitude = ?,
              fare_paise = COALESCE(?, fare_paise), geofence_m = COALESCE(?, geofence_m) WHERE id = ? AND route_id = ?`)
            .bind(sname, seq, pickup, drop, lat, lon, fare, geo, sid, rid))
          kept.push(sid)
        } else {
          const made = uuid()
          stmts.push(c.db.prepare(`INSERT INTO route_stops (id, institution_id, route_id, name, sequence, pickup_time, drop_time, latitude, longitude, fare_paise, geofence_m)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(made, inst, rid, sname, seq, pickup, drop, lat, lon, fare, geo))
          kept.push(made)
        }
        stopCount++
      }
      // The school stop is the server's, not the list's.
      stmts.push(c.db.prepare(`DELETE FROM route_stops WHERE route_id = ? AND NOT is_school AND id NOT IN (SELECT value FROM json_each(?))`).bind(rid, JSON.stringify(kept)))
    }

    // The school is the last stop, whatever the list said.
    const policy = await trackingPolicyFor(c, inst)
    if (routeID !== null) {
      stmts.push(...await ensureSchoolStops(c, inst, policy, rid))
    } else if (policy.school_latitude !== undefined && policy.school_longitude !== undefined) {
      stmts.push(c.db.prepare(`INSERT INTO route_stops (id, institution_id, route_id, name, sequence, latitude, longitude, geofence_m, is_school)
          SELECT ?, ?, ?, 'School', COALESCE((SELECT MAX(sequence) FROM route_stops WHERE route_id = ?), 0) + 1, ?, ?, ?, 1`)
        .bind(uuid(), inst, rid, rid, String(policy.school_latitude), String(policy.school_longitude), policy.school_geofence_m ?? null))
    }

    try {
      await c.db.batch(stmts)
    } catch (e) {
      if (isUniqueViolation(e)) {
        if (/route_stops/.test((e as Error).message)) throw new HttpError(409, 'two stops landed on the same position; reorder them and save again', { code: 'duplicate_stop' })
        throw new HttpError(409, 'a route with that name already exists on this campus', { code: 'duplicate_route' })
      }
      throw badRequest((e as Error).message)
    }
    if (stopsIn === null) {
      const n = await c.db.prepare(`SELECT count(*) AS n FROM route_stops WHERE route_id = ?`).bind(rid).first<{ n: number }>()
      stopCount = n?.n ?? 0
    }
    const out = { id: rid, name, stops: stopCount }
    return routeID === null ? created(out) : ok(out)
  }
  r.post('/ops/transport/routes', 'operations.transport.write', saveRoute)
  r.put('/ops/transport/routes/{id}', 'operations.transport.write', saveRoute)

  r.del('/ops/transport/routes/{id}', 'operations.transport.write', async (c) => {
    const rid = c.params.id
    if (!isUUID(rid)) throw badRequest('invalid route id')
    const res = await c.db.prepare(`UPDATE routes SET is_active = 0, vehicle_id = NULL WHERE id = ?`).bind(rid).run()
    if (!res.meta.changes) throw notFound('resource not found')
    return ok({ id: rid, retired: true })
  })
}

