import { registerJob } from '../jobs'
import { daysAgo, forEachSchool } from './schools'

/* Bus-tracker sweeps from internal/api/bus_tracker_jobs.go:
   transport:trip_timeout closes trips nothing has been heard from, and
   transport:position_retention drops breadcrumbs past each school's
   retain_days. Both were one global pass in Go; here, one pass per school. */

const DEFAULT_TRIP_TIMEOUT_MINS = 20
const DEFAULT_RETAIN_DAYS = 90
const RETENTION_BATCH = 5000
const RETENTION_MAX_LOOPS = 200   // per school
const RETENTION_MAX_RUN = 60      // per run, all schools
const RETENTION_BUDGET_MS = 4 * 60_000

/** The policy's timeout, kept inside the schema's CHECK range (5..240). */
export function clampTripTimeoutMins(mins: number | null | undefined): number {
  if (!mins || mins <= 0) return DEFAULT_TRIP_TIMEOUT_MINS
  return Math.min(240, Math.max(5, mins))
}

registerJob('transport:trip_timeout', async (env) => {
  let trips = 0, events = 0
  await forEachSchool(env, async (inst, db) => {
    const open = await db.prepare(`
      SELECT t.id, t.vehicle_id, t.started_at,
             (SELECT max(p.recorded_at) FROM vehicle_positions p WHERE p.trip_id = t.id) AS last_fix,
             (SELECT pol.trip_timeout_mins FROM transport_tracking_policy pol WHERE pol.institution_id = t.institution_id) AS mins
        FROM vehicle_trips t WHERE t.ended_at IS NULL`)
      .all<{ id: string; vehicle_id: string; started_at: string; last_fix: string | null; mins: number | null }>()
    const nowMs = Date.now()
    const stmts: D1PreparedStatement[] = []
    for (const t of open.results ?? []) {
      // Last heard: the latest fix, or started_at when there is none (or it predates the start).
      const startMs = Date.parse(t.started_at)
      const fixMs = t.last_fix ? Date.parse(t.last_fix) : NaN
      const lastHeard = !isNaN(fixMs) && fixMs > startMs ? t.last_fix! : t.started_at
      const deadline = Date.parse(lastHeard) + clampTripTimeoutMins(t.mins) * 60_000
      if (!(nowMs > deadline)) continue
      // ended_at is the last moment the trip was known alive, not now.
      stmts.push(db.prepare(`UPDATE vehicle_trips SET ended_at = ?, ended_reason = 'timeout' WHERE id = ? AND ended_at IS NULL`)
        .bind(lastHeard, t.id))
      // An open safety episode ends with its trip (never before it started).
      stmts.push(db.prepare(`UPDATE transport_safety_events
          SET ended_at = CASE WHEN julianday(started_at) > julianday(?) THEN started_at ELSE ? END
        WHERE trip_id = ? AND ended_at IS NULL`).bind(lastHeard, lastHeard, t.id))
      console.log('trip closed on timeout', { trip_id: t.id, institution_id: inst.id, vehicle_id: t.vehicle_id, ended_at: lastHeard })
    }
    if (!stmts.length) return
    const res = await db.batch(stmts)
    for (let i = 0; i < res.length; i += 2) {
      trips += res[i].meta.changes
      events += res[i + 1].meta.changes
    }
  })
  if (trips > 0 || events > 0) console.log('trip timeout sweep', { trips_closed: trips, safety_events_closed: events })
})

registerJob('transport:position_retention', async (env) => {
  const deadline = Date.now() + RETENTION_BUDGET_MS
  let runLoops = 0, deleted = 0, paused = false
  await forEachSchool(env, async (inst, db) => {
    if (paused) return
    const pol = await db.prepare(`SELECT retain_days FROM transport_tracking_policy WHERE institution_id = ?`)
      .bind(inst.id).first<{ retain_days: number }>()
    let days = pol?.retain_days ?? DEFAULT_RETAIN_DAYS
    if (days < 7) days = DEFAULT_RETAIN_DAYS
    const cutoff = daysAgo(days)
    let instDeleted = 0
    for (let loop = 0; loop < RETENTION_MAX_LOOPS; loop++) {
      if (runLoops >= RETENTION_MAX_RUN || Date.now() > deadline) {
        console.log('position retention sweep paused for today', { batches: runLoops, rows_deleted: deleted, institution_id: inst.id, reason: 'run budget' })
        paused = true
        break
      }
      runLoops++
      // Oldest rows first, bounded, so stopping halfway leaves the rest for tomorrow.
      const r = await db.prepare(`DELETE FROM vehicle_positions WHERE id IN (
          SELECT id FROM vehicle_positions WHERE institution_id = ? AND recorded_at < ?
           ORDER BY recorded_at LIMIT ?)`).bind(inst.id, cutoff, RETENTION_BATCH).run()
      const n = r.meta.changes
      instDeleted += n
      deleted += n
      if (n < RETENTION_BATCH) break
    }
    if (instDeleted > 0) console.log('position history pruned', { institution_id: inst.id, rows: instDeleted, retain_days: days, cutoff })
  })
  console.log('position retention sweep', { rows_deleted: deleted })
})
