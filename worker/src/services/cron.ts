import type { Env } from '../env'
import type { Institution } from '../tenant'
import { tenantDb } from '../tenant'
import { enqueueMany } from './jobs'
import { activeSchools } from './background/schools'

/* The schedule from internal/queue/cron.go (plus the bus-tracker and
   login-security entries internal/api appended), driven by one Cron Trigger
   that fires every minute (wrangler.jsonc "triggers"). Each tick asks, per
   entry, "has an occurrence passed since this last ran?" in the school's own
   timezone, enqueues what has come due, and remembers the run in cron_runs:
   the school's own cron_runs for per-school entries, CONTROL.cron_runs for
   global ones. First sight records a baseline without running; missed
   occurrences collapse into one run -- both exactly as the Go Tick did. */

interface Schedule {
  name: string
  spec: string
  kind: string
  perInstitution: boolean
  /** Per-school filter: false skips the school this tick (Go's Only). */
  only?: (db: D1Database) => Promise<boolean>
  payload: (inst: Institution | null, jobId: string) => Record<string, unknown>
}

const env0 = (inst: Institution | null, job_id: string) => ({ institution_id: inst?.id ?? null, job_id })

export const SCHEDULES: Schedule[] = [
  { name: 'attendance_rollup', spec: '30 0 * * *', kind: 'attendance:rollup', perInstitution: true, payload: env0 },
  { name: 'fee_reminders', spec: '0 9 * * *', kind: 'fee:reminder_fanout', perInstitution: true,
    payload: (i, j) => ({ ...env0(i, j), template_key: 'fee.overdue', overdue_since: new Date().toISOString() }) },
  { name: 'session_prune', spec: '0 3 * * 0', kind: 'session:prune', perInstitution: false, payload: () => ({}) },
  { name: 'diary_reminders', spec: '*/5 * * * *', kind: 'diary:reminders', perInstitution: false, payload: () => ({}) },
  // Go's message:dispatch; the messaging port's drain job is 'message.send'.
  { name: 'message_dispatch', spec: '* * * * *', kind: 'message.send', perInstitution: true,
    only: async (db) => !!(await db.prepare(`SELECT 1 AS x FROM message_log WHERE status = 'queued'
        AND (send_after IS NULL OR julianday(send_after) <= julianday('now')) LIMIT 1`).first()),
    payload: (i) => ({ institution_id: i!.id }) },
  // Go's RunPushPump (push_tokens.go): pushOnce every 5 s, materialise family alerts every minute.
  // Per minute here, for schools where somebody holds a push token; a no-op without FCM_SERVICE_ACCOUNT.
  { name: 'push_pump', spec: '* * * * *', kind: 'push.pump', perInstitution: true,
    only: async (db) => !!(await db.prepare(`SELECT 1 AS x FROM push_tokens LIMIT 1`).first()),
    payload: (i) => ({ institution_id: i!.id, materialise: true }) },
  { name: 'message_plans', spec: '*/15 * * * *', kind: 'message:plans', perInstitution: true, payload: env0 },
  { name: 'report_digest_daily', spec: '0 7 * * *', kind: 'report:digest_daily', perInstitution: true, payload: env0 },
  { name: 'report_digest_weekly', spec: '0 7 * * 1', kind: 'report:digest_weekly', perInstitution: true, payload: env0 },
  { name: 'transport_trip_timeout', spec: '*/5 * * * *', kind: 'transport:trip_timeout', perInstitution: false, payload: () => ({}) },
  { name: 'transport_position_retention', spec: '20 3 * * *', kind: 'transport:position_retention', perInstitution: false, payload: () => ({}) },
  { name: 'security_retention', spec: '40 3 * * *', kind: 'security:retention', perInstitution: false, payload: () => ({}) },
]

// ---- five-field cron matching ------------------------------------------------

type Fields = { min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }
const parsed = new Map<string, Fields>()

function field(expr: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>()
  for (const part of expr.split(',')) {
    const [range, stepS] = part.split('/')
    const step = stepS ? parseInt(stepS, 10) : 1
    let a = lo, b = hi
    if (range !== '*') {
      const [x, y] = range.split('-')
      a = parseInt(x, 10); b = y !== undefined ? parseInt(y, 10) : (stepS ? hi : a)
    }
    if (isNaN(a) || isNaN(b) || isNaN(step) || step < 1) throw new Error('bad cron field ' + expr)
    for (let v = a; v <= b; v += step) out.add(v === 7 && hi === 7 ? 0 : v)
  }
  return out
}

function parse(spec: string): Fields {
  let f = parsed.get(spec)
  if (f) return f
  const [m, h, dom, mon, dow] = spec.trim().split(/\s+/)
  f = { min: field(m, 0, 59), hour: field(h, 0, 23), dom: field(dom, 1, 31), mon: field(mon, 1, 12), dow: field(dow, 0, 7),
    domStar: dom.startsWith('*'), dowStar: dow.startsWith('*') }
  parsed.set(spec, f)
  return f
}

/** Local wall clock as a UTC-fielded Date, for minute ms `t` at offset `off` ms. */
function matches(f: Fields, t: number, off: number): boolean {
  const d = new Date(t + off)
  if (!f.min.has(d.getUTCMinutes()) || !f.hour.has(d.getUTCHours()) || !f.mon.has(d.getUTCMonth() + 1)) return false
  const domOk = f.dom.has(d.getUTCDate()), dowOk = f.dow.has(d.getUTCDay())
  // robfig/cron: when either day field is '*', both must match; else either.
  return f.domStar || f.dowStar ? domOk && dowOk : domOk || dowOk
}

/** UTC offset (ms) of a timezone at an instant; UTC when the zone is unusable. */
function offsetOf(tz: string, at: number): number {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(at)).map((x) => [x.type, x.value]))
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at / 1000) * 1000
  } catch {
    console.error('institution timezone unusable; scheduling in UTC', tz)
    return 0
  }
}

const MAX_LOOKBACK_MIN = 8 * 24 * 60

/** Has an occurrence of spec passed in (last, now]? (Go's due(), in minute steps.) */
export function due(spec: string, lastIso: string, now: number, tz: string): boolean {
  const f = parse(spec)
  const off = offsetOf(tz, now)
  const last = Date.parse(lastIso)
  if (isNaN(last)) return true
  let t = Math.floor(last / 60_000) * 60_000 + 60_000
  const stop = Math.max(t, now - MAX_LOOKBACK_MIN * 60_000)
  if (t < stop) t = Math.ceil(stop / 60_000) * 60_000
  for (; t <= now; t += 60_000) if (matches(f, t, off)) return true
  return false
}

// ---- the tick ----------------------------------------------------------------

export interface TickResult { checked: number; enqueued: number; started: number; institutions: number; kinds: Record<string, number>; at: string }

async function lastRuns(db: D1Database): Promise<Map<string, string>> {
  const r = await db.prepare('SELECT name, last_run_at FROM cron_runs').all<{ name: string; last_run_at: string }>()
  return new Map((r.results ?? []).map((x) => [x.name, x.last_run_at]))
}

export async function tick(env: Env, at: Date = new Date()): Promise<TickResult> {
  const now = at.getTime()
  const nowIso = at.toISOString()
  const schools = await activeSchools(env)
  const res: TickResult = { checked: 0, enqueued: 0, started: 0, institutions: schools.length, kinds: {}, at: nowIso }
  const jobs: { type: string; payload: Record<string, unknown>; institution_id?: string | null }[] = []

  const evaluate = async (db: D1Database, inst: Institution | null, tz: string, entries: Schedule[]) => {
    const last = await lastRuns(db)
    const record: D1PreparedStatement[] = []
    for (const s of entries) {
      if (s.only && !(await s.only(db))) continue
      res.checked++
      const prev = last.get(s.name)
      const fire = prev !== undefined && due(s.spec, prev, now, tz)
      if (prev === undefined) res.started++
      if (fire || prev === undefined) {
        record.push(db.prepare(`INSERT INTO cron_runs (name, last_run_at) VALUES (?, ?)
          ON CONFLICT (name) DO UPDATE SET last_run_at = excluded.last_run_at`).bind(s.name, nowIso))
      }
      if (!fire) continue
      jobs.push({ type: s.kind, payload: s.payload(inst, crypto.randomUUID()), institution_id: inst?.id ?? null })
      res.enqueued++
      res.kinds[s.kind] = (res.kinds[s.kind] ?? 0) + 1
    }
    return record
  }

  // Global entries follow the oldest school's clock.
  const globalTz = schools[0]?.timezone ?? 'UTC'
  const globalRecord = await evaluate(env.CONTROL, null, globalTz, SCHEDULES.filter((s) => !s.perInstitution))
  const perSchool = SCHEDULES.filter((s) => s.perInstitution)
  const schoolRecords: [D1Database, D1PreparedStatement[]][] = []
  for (const inst of schools) {
    try {
      const db = tenantDb(env, inst)
      schoolRecords.push([db, await evaluate(db, inst, inst.timezone, perSchool)])
    } catch (err) {
      console.error('cron: school skipped', inst.slug, err)
    }
  }

  // Enqueue first, then remember: a failed record re-runs a sweep (harmless,
  // every entry is idempotent); the reverse order could lose a run.
  if (jobs.length) await enqueueMany(env, jobs)
  if (globalRecord.length) await env.CONTROL.batch(globalRecord)
  for (const [db, rec] of schoolRecords) if (rec.length) await db.batch(rec)

  if (res.enqueued > 0 || res.started > 0) console.log('cron tick', res)
  return res
}
