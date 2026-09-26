import type { Env } from '../env'
import { Messenger } from './messaging'

/* The in-app bus notices of transport_approach_notify.go and
   transport_school_stop.go: notifyTripStarted, notifyArrived and
   notifyApproaching. Once per child per run (occurrence keyed on trip and
   student); every failure is logged and swallowed, never failing the run or
   the position batch. */

const IST_MS = 330 * 60_000
const today = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10)
const NAME = `COALESCE(NULLIF(TRIM(st.first_name || ' ' || COALESCE(st.last_name,'')),''), 'Your child')`

interface Target { user_id: string; student_id: string; name: string; stop?: string }

async function fanOut(env: Env, db: D1Database, inst: string, trip: string, template: string, key: string, targets: Target[],
  vars: (t: Target) => Record<string, unknown>, what: string): Promise<void> {
  if (!targets.length) return
  const ms = new Messenger({ env, db, inst })
  for (const t of targets) {
    try {
      await ms.queue({ channel: 'in_app', template_code: template, to_user_id: t.user_id, student_id: t.student_id, vars: vars(t),
        source_kind: 'transport_trip', source_id: trip, occurrence_key: `${key}:${trip}:${t.student_id}` })
    } catch (e) { console.warn(what + ' notice not queued', (e as Error).message, trip, t.student_id) }
  }
  await ms.kick()
}

export async function notifyTripStarted(env: Env, db: D1Database, inst: string, trip: string, route: string, direction: string): Promise<void> {
  try {
    const dirWord = direction === 'drop' ? 'drop-off' : 'pickup'
    const school = (await db.prepare(`SELECT name FROM institutions WHERE id = ?`).bind(inst).first<{ name: string }>())?.name ?? ''
    const rt = await db.prepare(`SELECT name FROM routes WHERE id = ?`).bind(route).first<{ name: string }>()
    if (!rt) return
    const d = today()
    const targets = (await db.prepare(`SELECT g.user_id, ta.student_id, ${NAME} AS name, COALESCE(rs.name, 'the stop') AS stop
        FROM transport_allocations ta JOIN students st ON st.id = ta.student_id
        JOIN student_guardians sg ON sg.student_id = ta.student_id JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL
        LEFT JOIN route_stops rs ON rs.id = CASE WHEN ?3 = 'drop' THEN ta.drop_stop_id ELSE ta.pickup_stop_id END
       WHERE ta.institution_id = ?1 AND ta.route_id = ?2 AND ta.valid_from <= ?4 AND (ta.valid_to IS NULL OR ta.valid_to >= ?4) AND st.status = 'active'`)
      .bind(inst, route, direction, d).all<Target>()).results
    // the key is "started:<trip>:<student>"
    await fanOut(env, db, inst, trip, 'transport.trip_started', 'started', targets,
      (t) => ({ student_name: t.name, route_name: rt.name, direction: dirWord, stop_name: t.stop, school_name: school }), 'trip-start')
  } catch (e) { console.error('trip-start notice', e) }
}

export async function notifyArrived(env: Env, db: D1Database, inst: string, trip: string, route: string, stop: string, direction: string, isSchool: boolean): Promise<void> {
  try {
    const d = today()
    let template: string, key: string, targets: Target[]
    if (isSchool && direction !== 'drop') {
      template = 'transport.bus_reached_school'; key = 'reached_school'
      targets = (await db.prepare(`WITH on_run AS (
            SELECT ta.student_id FROM transport_allocations ta
              LEFT JOIN transport_attendance att ON att.student_id = ta.student_id AND att.on_date = ?3 AND att.leg = 'morning'
             WHERE ta.institution_id = ?1 AND ta.route_id = ?2 AND ta.valid_from <= ?3 AND (ta.valid_to IS NULL OR ta.valid_to >= ?3)
               AND (att.status = 'boarded' OR NOT EXISTS (SELECT 1 FROM transport_attendance a2 JOIN transport_allocations t2 ON t2.student_id = a2.student_id
                     WHERE t2.route_id = ?2 AND a2.on_date = ?3 AND a2.leg = 'morning' AND a2.status = 'boarded')))
          SELECT g.user_id, st.id AS student_id, ${NAME} AS name FROM on_run
            JOIN students st ON st.id = on_run.student_id AND st.status = 'active'
            JOIN student_guardians sg ON sg.student_id = st.id JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL`)
        .bind(inst, route, d).all<Target>()).results
    } else if (!isSchool && direction === 'drop') {
      template = 'transport.bus_at_stop'; key = 'at_stop'
      targets = (await db.prepare(`SELECT g.user_id, st.id AS student_id, ${NAME} AS name FROM transport_allocations ta
          JOIN students st ON st.id = ta.student_id AND st.status = 'active'
          JOIN student_guardians sg ON sg.student_id = st.id JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL
         WHERE ta.institution_id = ?1 AND ta.route_id = ?2 AND ta.drop_stop_id = ?3 AND ta.valid_from <= ?4 AND (ta.valid_to IS NULL OR ta.valid_to >= ?4)`)
        .bind(inst, route, stop, d).all<Target>()).results
    } else return
    if (!targets.length) return
    const stopName = (await db.prepare(`SELECT name FROM route_stops WHERE id = ?`).bind(stop).first<{ name: string }>())?.name ?? ''
    const school = (await db.prepare(`SELECT name FROM institutions WHERE id = ?`).bind(inst).first<{ name: string }>())?.name ?? ''
    await fanOut(env, db, inst, trip, template, key, targets, (t) => ({ student_name: t.name, stop_name: stopName, school_name: school }), 'arrival')
  } catch (e) { console.error('arrival notice', e) }
}

/** Crow-flies distance, as metresBetween. */
function metres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000, r = Math.PI / 180
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export async function notifyApproaching(env: Env, db: D1Database, inst: string, trip: string, route: string, direction: string,
  last: { lat: number; lon: number }, metresBetween: (a: number, b: number, c: number, d: number) => number = metres): Promise<void> {
  try {
    const d = today()
    const rows = (await db.prepare(`SELECT g.user_id, ta.student_id, ${NAME} AS name, rs.name AS stop, rs.latitude, rs.longitude,
          COALESCE(wp.proximity_m, wpall.proximity_m, ?3) AS distance
        FROM transport_allocations ta
        JOIN route_stops rs ON rs.id = CASE WHEN ?4 = 'drop' THEN ta.drop_stop_id ELSE ta.pickup_stop_id END
        JOIN students st ON st.id = ta.student_id
        JOIN student_guardians sg ON sg.student_id = ta.student_id JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL
        LEFT JOIN transport_watch_prefs wp ON wp.user_id = g.user_id AND wp.student_id = ta.student_id
        LEFT JOIN transport_watch_prefs wpall ON wpall.user_id = g.user_id AND wpall.student_id IS NULL
       WHERE ta.institution_id = ?1 AND ta.route_id = ?2 AND ta.valid_from <= ?5 AND (ta.valid_to IS NULL OR ta.valid_to >= ?5)
         AND rs.latitude IS NOT NULL AND rs.longitude IS NOT NULL AND COALESCE(wp.notify_approach, wpall.notify_approach, 0) = 1`)
      .bind(inst, route, 800, direction, d).all<Target & { latitude: string; longitude: string; distance: number }>()).results
    const due = rows.map((t) => ({ ...t, away: metresBetween(last.lat, last.lon, Number(t.latitude), Number(t.longitude)) }))
      .filter((t) => t.away <= Number(t.distance))
    if (!due.length) return
    const ms = new Messenger({ env, db, inst })
    for (const t of due) {
      try {
        await ms.queue({ channel: 'in_app', template_code: 'transport.bus_approaching', to_user_id: t.user_id, student_id: t.student_id,
          vars: { student_name: t.name, stop_name: t.stop, distance_m: Math.trunc(t.away) },
          source_kind: 'transport_trip', source_id: trip, occurrence_key: `approach:${trip}:${t.student_id}` })
      } catch (e) { console.warn('approach notice not queued', (e as Error).message, trip, t.student_id) }
    }
    await ms.kick()
  } catch (e) { console.error('approach notice', e) }
}
