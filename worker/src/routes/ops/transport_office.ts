import type { Router, Ctx } from '../../router'
import { badRequest, bool, created, isUUID, now, ok, readJSON, uuid, uuidQuery } from '../../http'
import { addDays, daysBetween, resolveRange, today } from '../fees/common'
import { instId } from './common'

/* Port of internal/api/transport_office.go: drivers and attendants, the
   student allocation, the bus register, fuel and servicing, the pre-trip
   check and incidents. Response fields follow the Go structs field for field. */

const READ = 'operations.transport.read'
const WRITE = 'operations.transport.write'

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
const nul = (v: unknown): string | null => { const s = str(v); return s === '' ? null : s }
const oneOf = (v: string, ...allowed: string[]) => allowed.includes(v)
/** A date the client sent, or today (COALESCE(NULLIF($n,'')::date, current_date)). */
const dateOr = (v: unknown): string => nul(v) ?? today()
const hhmm = (ts: unknown): string | null => { const s = nul(ts); return s ? s.slice(11, 16) : null }
const minute = (ts: unknown): string | null => { const s = nul(ts); return s ? s.slice(0, 16) : null }

const NAME = (a: string) => `TRIM(COALESCE(${a}.first_name,'') || ' ' || COALESCE(${a}.last_name,''))`
const LIVE = (a: string) => `(${a}.valid_to IS NULL OR ${a}.valid_to >= ?)`

export function registerTransportOffice(r: Router): void {
  /* --- drivers and attendants ------------------------------------------ */

  r.get('/ops/transport/staff', READ, async (c) => {
    const t = today()
    const rows = await c.db.prepare(`
      SELECT ts.id, ts.employee_id, ${NAME('e')} AS name, ts.role, ts.licence_no,
             ts.licence_expiry, ts.badge_no, ts.police_verified_on, ts.medical_expiry,
             ts.phone, v.registration_no AS vehicle
        FROM transport_staff ts
        JOIN employees e ON e.id = ts.employee_id
        LEFT JOIN vehicles v ON v.driver_employee_id = ts.employee_id OR v.attendant_employee_id = ts.employee_id
       WHERE ts.is_active = 1
       ORDER BY e.first_name`).all<Record<string, unknown>>()
    /* The soonest of licence, medical and police (+365 days) lapses; a row
       with none of the three sorts first, as the Go NULLS FIRST did. */
    const items = rows.results.map((x) => {
      const cands: [string | null, string][] = [
        [nul(x.licence_expiry), 'licence'],
        [nul(x.medical_expiry), 'medical'],
        [nul(x.police_verified_on) ? addDays(str(x.police_verified_on), 365) : null, 'police check'],
      ]
      let soonest: [string, string] | null = null
      for (const [d, label] of cands) if (d && (!soonest || d < soonest[0])) soonest = [d, label]
      const out: Record<string, unknown> = {
        id: x.id, employee_id: x.employee_id, name: x.name, role: x.role,
      }
      for (const k of ['licence_no', 'licence_expiry', 'badge_no', 'police_verified_on', 'medical_expiry', 'phone', 'vehicle'] as const) {
        if (nul(x[k]) !== null) out[k] = x[k]
      }
      if (soonest) { out.days_to_lapse = daysBetween(t, soonest[0]); out.lapsed_item = soonest[1] }
      return out
    })
    items.sort((a, b) => {
      const da = a.days_to_lapse as number | undefined, db = b.days_to_lapse as number | undefined
      if (da === undefined && db !== undefined) return -1
      if (db === undefined && da !== undefined) return 1
      if (da !== undefined && db !== undefined && da !== db) return da - db
      return 0
    })
    return ok(items.slice(0, 200))
  })

  r.post('/ops/transport/staff', WRITE, async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const employee = str(req.employee_id)
    if (!isUUID(employee)) throw badRequest('employee_id must be a uuid')
    const role = str(req.role) || 'driver'
    const licenceNo = nul(req.licence_no), licenceExpiry = nul(req.licence_expiry)
    if (licenceNo && !licenceExpiry) {
      throw badRequest('a licence number needs its expiry date. A licence on file with no expiry is a gap that hides itself')
    }
    const vals = [role, licenceNo, licenceExpiry, nul(req.badge_no), nul(req.police_verified_on), nul(req.police_ref),
      nul(req.medical_expiry), nul(req.blood_group), nul(req.phone), nul(req.notes)]
    // ON CONFLICT (employee_id) WHERE is_active: one live row per employee.
    const live = await c.db.prepare(`SELECT id FROM transport_staff WHERE employee_id = ? AND is_active = 1 LIMIT 1`)
      .bind(employee).first<{ id: string }>()
    if (live) {
      await c.db.prepare(`UPDATE transport_staff SET role = ?, licence_no = ?, licence_expiry = ?, badge_no = ?,
            police_verified_on = ?, police_ref = ?, medical_expiry = ?, blood_group = ?, phone = ?, notes = ?, updated_at = ?
          WHERE id = ?`).bind(...vals, now(), live.id).run()
      return ok({ id: live.id })
    }
    const id = uuid(); const ts = now()
    await c.db.prepare(`INSERT INTO transport_staff
          (id, institution_id, employee_id, role, licence_no, licence_expiry, badge_no, police_verified_on,
           police_ref, medical_expiry, blood_group, phone, notes, is_active, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).bind(id, instId(c), employee, ...vals, ts, ts).run()
    return ok({ id })
  })

  /* --- student allocation ---------------------------------------------- */

  r.get('/ops/transport/allocations', READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT ta.id, st.id AS student_id, ${NAME('st')} AS full_name, st.admission_no,
             cl.name AS class_name, rt.name AS route, rt.id AS route_id,
             ps.name AS pickup_stop, ds.name AS drop_stop, ps.pickup_time, ps.fare_paise
        FROM transport_allocations ta
        JOIN students st ON st.id = ta.student_id
        LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
        LEFT JOIN sections sec ON sec.id = en.section_id
        LEFT JOIN classes cl ON cl.id = sec.class_id
        LEFT JOIN routes rt ON rt.id = ta.route_id
        LEFT JOIN route_stops ps ON ps.id = ta.pickup_stop_id
        LEFT JOIN route_stops ds ON ds.id = ta.drop_stop_id
       WHERE ${LIVE('ta')}
       ORDER BY rt.name, ps.sequence, st.first_name
       LIMIT 600`).bind(today()).all<Record<string, unknown>>()
    return ok(rows.results.map((x) => {
      const out: Record<string, unknown> = { id: x.id, student_id: x.student_id, full_name: x.full_name, admission_no: x.admission_no }
      for (const k of ['class_name', 'route', 'route_id', 'pickup_stop', 'drop_stop'] as const) if (nul(x[k]) !== null) out[k] = x[k]
      const pt = nul(x.pickup_time)
      if (pt) out.pickup_time = pt.length <= 8 ? pt.slice(0, 5) : pt.slice(11, 16)
      if (x.fare_paise !== null && x.fare_paise !== undefined) out.fare_paise = Number(x.fare_paise)
      return out
    }))
  })

  r.post('/ops/transport/allocations', WRITE, async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const student = str(req.student_id)
    if (!isUUID(student)) throw badRequest('student_id must be a uuid')
    const route = str(req.route_id)
    if (!isUUID(route)) throw badRequest('route_id must be a uuid')
    const pickup = str(req.pickup_stop_id)
    const drop = str(req.drop_stop_id) || pickup

    const stop = await c.db.prepare(`SELECT fare_paise FROM route_stops WHERE id = ? AND route_id = ?`)
      .bind(pickup, route).first<{ fare_paise: number | null }>()
    if (!stop) throw badRequest('that stop is not on that route')
    const year = await c.db.prepare(`SELECT id FROM academic_years WHERE is_current = 1 LIMIT 1`).first<{ id: string }>()
    if (!year) throw badRequest('no current academic year')

    const t = today(); const inst = instId(c)
    const allocId = uuid()
    const fare = stop.fare_paise === null ? null : Number(stop.fare_paise)
    const stmts: D1PreparedStatement[] = [
      // Ending the old allocation rather than deleting it.
      c.db.prepare(`UPDATE transport_allocations SET valid_to = ? WHERE student_id = ? AND ${LIVE('transport_allocations')}`)
        .bind(addDays(t, -1), student, t),
      c.db.prepare(`INSERT INTO transport_allocations
            (id, institution_id, student_id, academic_year_id, route_id, pickup_stop_id, drop_stop_id, valid_from)
          VALUES (?,?,?,?,?,?,?,?)`).bind(allocId, inst, student, year.id, route, pickup, drop, t),
      ...(await syncTransportFeeComponent(c, inst, student, { allocId, yearId: year.id, fare, route, stop: pickup })),
    ]
    await c.db.batch(stmts)
    return created({ fare_paise: fare })
  })

  /* --- route attendance ------------------------------------------------ */

  r.get('/ops/transport/attendance', READ, async (c) => {
    const q = c.url.searchParams
    const leg = q.get('leg') || 'morning'
    const onDate = dateOr(q.get('on_date'))
    const routeId = uuidQuery(q.get('route_id'))
    const rows = await c.db.prepare(`
      SELECT st.id AS student_id, ${NAME('st')} AS full_name, st.admission_no, ps.name AS stop,
             COALESCE(att.status, 'not_scanned') AS status, att.boarded_at, att.alighted_at,
             COALESCE(att.source, 'manual') AS source
        FROM transport_allocations ta
        JOIN students st ON st.id = ta.student_id
        LEFT JOIN route_stops ps ON ps.id = ta.pickup_stop_id
        LEFT JOIN transport_attendance att ON att.student_id = st.id AND att.on_date = ? AND att.leg = ?
       WHERE ${LIVE('ta')} AND (? IS NULL OR ta.route_id = ?)
       ORDER BY ps.sequence, st.first_name
       LIMIT 400`).bind(onDate, leg, today(), routeId, routeId).all<Record<string, unknown>>()
    return ok(rows.results.map((x) => {
      const out: Record<string, unknown> = {
        student_id: x.student_id, full_name: x.full_name, admission_no: x.admission_no,
      }
      if (nul(x.stop) !== null) out.stop = x.stop
      out.status = x.status
      const b = hhmm(x.boarded_at), a = hhmm(x.alighted_at)
      if (b) out.boarded_at = b
      if (a) out.alighted_at = a
      out.source = x.source
      out.still_aboard = x.boarded_at !== null && x.alighted_at === null && x.status === 'boarded'
      return out
    }))
  })

  r.post('/ops/transport/attendance', WRITE, async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const student = str(req.student_id)
    if (!isUUID(student)) throw badRequest('student_id must be a uuid')
    const leg = str(req.leg) || 'morning'
    const status = str(req.status)
    if (!oneOf(status, 'boarded', 'alighted', 'absent')) throw badRequest('status must be boarded, alighted or absent')
    const source = str(req.source) || 'manual'
    const onDate = dateOr(req.on_date)
    const ts = now()
    const boardedAt = status === 'boarded' ? ts : null
    const alightedAt = status === 'alighted' ? ts : null

    const alloc = await c.db.prepare(`SELECT route_id, pickup_stop_id FROM transport_allocations ta
        WHERE ta.student_id = ? AND ${LIVE('ta')} LIMIT 1`).bind(student, today())
      .first<{ route_id: string; pickup_stop_id: string | null }>()
    // INSERT ... SELECT FROM the allocation: no allocation, no row, no error.
    if (!alloc) return ok({ marked: status })
    const routeId = nul(req.route_id) ?? alloc.route_id
    await c.db.prepare(`INSERT INTO transport_attendance
          (id, institution_id, student_id, route_id, stop_id, on_date, leg, status, source, marked_by, boarded_at, alighted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (student_id, on_date, leg) DO UPDATE SET
          status = excluded.status, source = excluded.source, marked_by = excluded.marked_by,
          boarded_at = COALESCE(transport_attendance.boarded_at, excluded.boarded_at),
          alighted_at = COALESCE(excluded.alighted_at, transport_attendance.alighted_at)`)
      .bind(uuid(), instId(c), student, routeId, alloc.pickup_stop_id, onDate, leg, status, source, c.id.userId, boardedAt, alightedAt).run()
    return ok({ marked: status })
  })

  /* --- fuel, servicing and repairs ------------------------------------- */

  r.get('/ops/transport/logs', READ, async (c) => {
    const rng = resolveRange(c)
    const vehicleId = uuidQuery(c.url.searchParams.get('vehicle_id'))
    const rows = await c.db.prepare(`
      WITH fuel AS (
        SELECT vl.id, vl.odometer_km - lag(vl.odometer_km) OVER (PARTITION BY vl.vehicle_id ORDER BY vl.on_date, vl.id) AS run_km
          FROM vehicle_logs vl WHERE vl.kind = 'fuel' AND vl.odometer_km IS NOT NULL)
      SELECT vl.id, v.registration_no AS vehicle, v.id AS vehicle_id, vl.kind, vl.on_date, vl.odometer_km, vl.litres,
             vl.amount_paise, vl.vendor, vl.next_due_on, vl.notes, f.run_km
        FROM vehicle_logs vl
        JOIN vehicles v ON v.id = vl.vehicle_id
        LEFT JOIN fuel f ON f.id = vl.id
       WHERE vl.on_date BETWEEN ? AND ? AND (? IS NULL OR vl.vehicle_id = ?)
       ORDER BY vl.on_date DESC, v.registration_no
       LIMIT 300`).bind(rng.from, rng.to, vehicleId, vehicleId).all<Record<string, unknown>>()
    return ok(rows.results.map((x) => {
      const out: Record<string, unknown> = { id: x.id, vehicle: x.vehicle, vehicle_id: x.vehicle_id, kind: x.kind, on_date: x.on_date }
      if (x.odometer_km !== null) out.odometer_km = Number(x.odometer_km)
      const litres = x.litres === null ? null : Number(x.litres)
      if (litres !== null) out.litres = litres
      out.amount_paise = Number(x.amount_paise ?? 0)
      if (nul(x.vendor) !== null) out.vendor = x.vendor
      if (nul(x.next_due_on) !== null) out.next_due_on = x.next_due_on
      if (nul(x.notes) !== null) out.notes = x.notes
      const run = x.run_km === null || x.run_km === undefined ? null : Number(x.run_km)
      if (run !== null && run > 0 && litres !== null && litres > 0) out.km_per_litre = Math.round((run / litres) * 100) / 100
      return out
    }))
  })

  r.post('/ops/transport/logs', WRITE, async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const vehicle = str(req.vehicle_id)
    if (!isUUID(vehicle)) throw badRequest('vehicle_id must be a uuid')
    const kind = str(req.kind)
    if (!oneOf(kind, 'fuel', 'service', 'repair', 'tyre', 'insurance', 'other')) throw badRequest('unknown kind ' + kind)
    const litres = req.litres === null || req.litres === undefined ? null : Number(req.litres)
    if (kind === 'fuel' && (litres === null || !(litres > 0))) {
      throw badRequest('a fuel entry needs the litres, or mileage can never be worked out')
    }
    const odo = req.odometer_km === null || req.odometer_km === undefined ? null : Number(req.odometer_km)
    const onDate = dateOr(req.on_date)
    if (odo !== null) {
      const last = await c.db.prepare(`SELECT max(odometer_km) AS m FROM vehicle_logs WHERE vehicle_id = ? AND on_date <= ?`)
        .bind(vehicle, onDate).first<{ m: number | null }>()
      if (last?.m !== null && last?.m !== undefined && odo < Number(last.m)) {
        throw badRequest('that odometer reading is lower than an earlier one for this vehicle')
      }
    }
    const id = uuid()
    await c.db.prepare(`INSERT INTO vehicle_logs
          (id, institution_id, vehicle_id, kind, on_date, odometer_km, litres, amount_paise, vendor, invoice_no,
           next_due_on, notes, recorded_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, instId(c), vehicle, kind, onDate, odo, litres === null ? null : String(litres),
        Number(req.amount_paise ?? 0), nul(req.vendor), nul(req.invoice_no), nul(req.next_due_on), nul(req.notes), c.id.userId, now())
      .run()
    return created({ id })
  })

  /* --- the pre-trip check ---------------------------------------------- */

  r.get('/ops/transport/checks', READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT tc.id, v.registration_no AS vehicle, rt.name AS route, tc.on_date, tc.leg, ${NAME('e')} AS driver,
             tc.cleared, tc.breathalyser, tc.brakes_ok, tc.tyres_ok, tc.lights_ok, tc.first_aid_ok,
             tc.extinguisher_ok, tc.doors_ok, tc.remarks, u.full_name AS checked_by
        FROM trip_checks tc
        JOIN vehicles v ON v.id = tc.vehicle_id
        LEFT JOIN routes rt ON rt.id = tc.route_id
        LEFT JOIN employees e ON e.id = tc.driver_employee_id
        LEFT JOIN users u ON u.id = tc.checked_by
       WHERE tc.on_date >= ?
       ORDER BY tc.on_date DESC, tc.leg, v.registration_no
       LIMIT 200`).bind(addDays(today(), -14)).all<Record<string, unknown>>()
    return ok(rows.results.map((x) => {
      const breath = x.breathalyser === null ? null : Number(x.breathalyser)
      const failed: string[] = []
      if (!bool(x.brakes_ok)) failed.push('brakes')
      if (!bool(x.tyres_ok)) failed.push('tyres')
      if (!bool(x.lights_ok)) failed.push('lights')
      if (!bool(x.first_aid_ok)) failed.push('first aid')
      if (!bool(x.extinguisher_ok)) failed.push('extinguisher')
      if (!bool(x.doors_ok)) failed.push('doors')
      if ((breath ?? 0) > 0) failed.push('breathalyser')
      const out: Record<string, unknown> = { id: x.id, vehicle: x.vehicle }
      if (nul(x.route) !== null) out.route = x.route
      out.on_date = x.on_date; out.leg = x.leg
      if (nul(x.driver) !== null) out.driver = x.driver
      out.cleared = bool(x.cleared)
      if (breath !== null) out.breathalyser = breath
      out.failed_items = failed
      if (nul(x.remarks) !== null) out.remarks = x.remarks
      if (nul(x.checked_by) !== null) out.checked_by = x.checked_by
      return out
    }))
  })

  r.post('/ops/transport/checks', WRITE, async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const vehicle = str(req.vehicle_id)
    if (!isUUID(vehicle)) throw badRequest('vehicle_id must be a uuid')
    const leg = str(req.leg) || 'morning'
    const onDate = dateOr(req.on_date)
    const flags = ['brakes_ok', 'tyres_ok', 'lights_ok', 'first_aid_ok', 'extinguisher_ok', 'doors_ok'].map((k) => req[k] === true)
    const breath = req.breathalyser === null || req.breathalyser === undefined ? null : Number(req.breathalyser)
    // cleared is derived here rather than accepted from the form.
    const cleared = flags.every(Boolean) && (breath === null || breath === 0)
    const ints = flags.map((b) => (b ? 1 : 0))
    const ts = now()
    const live = await c.db.prepare(`SELECT id FROM trip_checks WHERE vehicle_id = ? AND on_date = ? AND leg = ?`)
      .bind(vehicle, onDate, leg).first<{ id: string }>()
    const id = live?.id ?? uuid()
    await c.db.prepare(`INSERT INTO trip_checks
          (id, institution_id, vehicle_id, route_id, on_date, leg, driver_employee_id, brakes_ok, tyres_ok, lights_ok,
           first_aid_ok, extinguisher_ok, doors_ok, breathalyser, cleared, remarks, checked_by, checked_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (vehicle_id, on_date, leg) DO UPDATE SET
          brakes_ok = excluded.brakes_ok, tyres_ok = excluded.tyres_ok, lights_ok = excluded.lights_ok,
          first_aid_ok = excluded.first_aid_ok, extinguisher_ok = excluded.extinguisher_ok, doors_ok = excluded.doors_ok,
          breathalyser = excluded.breathalyser, cleared = excluded.cleared, remarks = excluded.remarks,
          checked_by = excluded.checked_by, checked_at = excluded.checked_at`)
      .bind(id, instId(c), vehicle, nul(req.route_id), onDate, leg, nul(req.driver_employee_id), ...ints,
        breath === null ? null : String(breath), cleared ? 1 : 0, nul(req.remarks), c.id.userId, ts).run()
    return ok({ id, cleared })
  })

  /* --- delays, breakdowns and the children still aboard ---------------- */

  r.get('/ops/transport/incidents', READ, async (c) => {
    const rng = resolveRange(c)
    const rows = await c.db.prepare(`
      SELECT i.id, v.registration_no AS vehicle, rt.name AS route, i.on_date, i.leg, i.kind, i.reported_at,
             i.delay_minutes, i.description, rv.registration_no AS replacement_vehicle, i.parents_informed,
             i.resolved_at, i.resolution,
             COALESCE((SELECT count(*) FROM transport_allocations ta
                        WHERE ta.route_id = i.route_id AND ${LIVE('ta')}), 0) AS children_affected
        FROM transport_incidents i
        LEFT JOIN vehicles v ON v.id = i.vehicle_id
        LEFT JOIN vehicles rv ON rv.id = i.replacement_vehicle_id
        LEFT JOIN routes rt ON rt.id = i.route_id
       WHERE i.on_date BETWEEN ? AND ?
       ORDER BY (i.resolved_at IS NULL) DESC, i.reported_at DESC
       LIMIT 200`).bind(today(), rng.from, rng.to).all<Record<string, unknown>>()
    return ok(rows.results.map((x) => {
      const out: Record<string, unknown> = { id: x.id }
      if (nul(x.vehicle) !== null) out.vehicle = x.vehicle
      if (nul(x.route) !== null) out.route = x.route
      out.on_date = x.on_date
      if (nul(x.leg) !== null) out.leg = x.leg
      out.kind = x.kind
      out.reported_at = minute(x.reported_at) ?? ''
      if (x.delay_minutes !== null) out.delay_minutes = Number(x.delay_minutes)
      out.description = x.description
      if (nul(x.replacement_vehicle) !== null) out.replacement_vehicle = x.replacement_vehicle
      out.parents_informed = bool(x.parents_informed)
      const res = minute(x.resolved_at)
      if (res) out.resolved_at = res
      if (nul(x.resolution) !== null) out.resolution = x.resolution
      out.children_affected = Number(x.children_affected ?? 0)
      return out
    }))
  })

  r.post('/ops/transport/incidents', WRITE, async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const informed = req.parents_informed === true ? 1 : 0

    // Closing one out.
    if (str(req.id) !== '') {
      if (str(req.resolution).trim() === '') throw badRequest('say how it ended. A breakdown closed with no note cannot be reviewed')
      const incId = str(req.id)
      if (!isUUID(incId)) throw badRequest('id must be a uuid')
      await c.db.prepare(`UPDATE transport_incidents
          SET resolved_at = ?, resolution = ?, parents_informed = (parents_informed OR ?),
              replacement_vehicle_id = COALESCE(?, replacement_vehicle_id)
        WHERE id = ?`).bind(now(), str(req.resolution), informed, nul(req.replacement_vehicle_id), incId).run()
      return ok({ resolved: true })
    }

    if (str(req.description).trim() === '') throw badRequest('say what happened')
    const kind = str(req.kind)
    if (!oneOf(kind, 'breakdown', 'delay', 'diversion', 'accident', 'other')) throw badRequest('unknown kind ' + kind)
    const delay = req.delay_minutes === null || req.delay_minutes === undefined ? null : Number(req.delay_minutes)
    const id = uuid()
    await c.db.prepare(`INSERT INTO transport_incidents
          (id, institution_id, vehicle_id, route_id, on_date, leg, kind, reported_at, delay_minutes, description,
           replacement_vehicle_id, parents_informed, reported_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, instId(c), nul(req.vehicle_id), nul(req.route_id), today(), nul(req.leg), kind, now(), delay,
        str(req.description), nul(req.replacement_vehicle_id), informed, c.id.userId).run()
    return created({ id })
  })
}

/* Port of syncTransportFeeComponent (fee_components.go): the child's live
   transport charge follows the live allocation. Returns the statements to run
   in the caller's batch; the allocation being written is passed in because
   it is not in the database yet. */
export async function syncTransportFeeComponent(
  c: Ctx, inst: string, student: string,
  a: { allocId: string; yearId: string; fare: number | null; route: string; stop: string },
): Promise<D1PreparedStatement[]> {
  const t = today()
  const stmts = [
    c.db.prepare(`UPDATE student_fee_components SET valid_to = ? WHERE student_id = ? AND code = 'transport' AND valid_to IS NULL`)
      .bind(addDays(t, -1), student),
  ]
  if (a.fare === null) return stmts
  const names = await c.db.prepare(`SELECT rt.name AS route, COALESCE(ps.name, '') AS stop
      FROM routes rt LEFT JOIN route_stops ps ON ps.id = ? WHERE rt.id = ?`).bind(a.stop, a.route)
    .first<{ route: string; stop: string }>()
  const head = await ensureFeeHead(c, inst, 'transport', 'Transport fee')
  let descr = 'Transport · ' + (names?.route ?? '')
  if (names?.stop) descr += ', ' + names.stop
  stmts.push(c.db.prepare(`INSERT INTO student_fee_components
        (id, institution_id, student_id, academic_year_id, fee_head_id, code, description, amount_paise,
         valid_from, source_kind, source_id, created_at)
      VALUES (?,?,?,?,?,'transport',?,?,?,'transport_allocation',?,?)`)
    .bind(uuid(), inst, student, a.yearId, head, descr, a.fare, t, a.allocId, now()))
  return stmts
}

/* Port of ensureFeeHead: the school's own head by code, then by name, else a new one. */
async function ensureFeeHead(c: Ctx, inst: string, code: string, name: string): Promise<string> {
  const up = code.toUpperCase()
  const found = await c.db.prepare(`SELECT id FROM fee_heads
      WHERE institution_id = ? AND (code = ? OR name LIKE ? COLLATE NOCASE)
      ORDER BY (code = ?) DESC, created_at LIMIT 1`).bind(inst, up, `%${code}%`, up).first<{ id: string }>()
  if (found) return found.id
  const id = uuid()
  await c.db.prepare(`INSERT INTO fee_heads (id, institution_id, name, code, is_recurring, created_at) VALUES (?,?,?,?,1,?)
      ON CONFLICT (institution_id, code) DO UPDATE SET name = fee_heads.name`).bind(id, inst, name, up, now()).run()
  const row = await c.db.prepare(`SELECT id FROM fee_heads WHERE institution_id = ? AND code = ?`).bind(inst, up).first<{ id: string }>()
  return row?.id ?? id
}
