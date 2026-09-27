import type { Env } from '../../env'
import { tenantDb, type Institution } from '../../tenant'
import { registerJob } from '../jobs'
import { setupStatus } from '../../routes/setup/academics'

/* School health board and usage alerts (Seller → Instance Health).
   The board reads CONTROL.school_health, a snapshot this module rewrites
   every 15 minutes (seller:health_snapshot); the fan-out over school
   databases runs at most FANOUT at a time. seller:usage_alerts (nightly)
   compares use with plan limits and raises 80% / 100% alerts. */

const FANOUT = 6
const DAY = 86400_000

/** Runs fn over items, at most `limit` at once; a failure yields null for that item. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      try { out[i] = await fn(items[i]) } catch (e) { console.error('health fan-out', e) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Called for every 5xx the Worker answers; never throws. */
export async function recordServerError(env: Env, institutionId: string | null | undefined, path: string): Promise<void> {
  if (!institutionId) return
  const at = new Date().toISOString()
  try {
    await env.CONTROL.prepare(`INSERT INTO school_errors (institution_id, hour, count, last_path, last_at) VALUES (?, ?, 1, ?, ?)
        ON CONFLICT (institution_id, hour) DO UPDATE SET count = count + 1, last_path = excluded.last_path, last_at = excluded.last_at`)
      .bind(institutionId, at.slice(0, 13), path.slice(0, 200), at).run()
  } catch (e) { console.error('school_errors not recorded', e) }
}

export interface Problem { key: string; label: string; count: number; link: string; hint: string }

const PROBLEMS: { key: string; label: string; link: string; hint: string; sql: string }[] = [
  { key: 'users_no_role', label: 'Active users with no role', link: '/go/staff/logins_access', hint: 'They can sign in but see nothing. Give each a role or deactivate them.',
    sql: `SELECT COUNT(*) AS n FROM users u WHERE u.status = 'active' AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)` },
  { key: 'parents_unlinked', label: 'Parent logins not linked to any child', link: '/go/staff/logins_access', hint: 'The parent app is empty for them. Link the guardian to the child.',
    sql: `SELECT COUNT(*) AS n FROM users u WHERE u.status = 'active'
      AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.key = 'parent')
      AND NOT EXISTS (SELECT 1 FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id WHERE g.user_id = u.id)` },
  { key: 'students_no_section', label: 'Students with no section', link: '/go/academics/class_setup', hint: 'Missing from registers, timetables and fee runs. Enrol them in a section.',
    sql: `SELECT COUNT(*) AS n FROM students s WHERE s.status = 'active' AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = s.id AND e.status = 'active')` },
  { key: 'invoices_overdue_90', label: 'Invoices overdue more than 90 days', link: '/go/fees/fee_default', hint: 'Chase, write off or cancel them.',
    sql: `SELECT COUNT(*) AS n FROM invoices WHERE status IN ('unpaid','partial','overdue') AND due_on IS NOT NULL AND due_on < date('now', '-90 days')` },
  { key: 'staff_no_employee', label: 'Staff logins with no employee record', link: '/go/staff/logins_access', hint: 'Payroll, leave and attendance cannot see them. Create the employee record.',
    sql: `SELECT COUNT(*) AS n FROM users u WHERE u.status = 'active'
      AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.key NOT IN ('parent','student','board_member'))
      AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.user_id = u.id)` },
  { key: 'sections_no_class_teacher', label: 'Sections with no class teacher', link: '/go/academics/teacher_assignment', hint: 'Attendance and report cards have nobody responsible. Assign a class teacher.',
    sql: `SELECT COUNT(*) AS n FROM sections s JOIN academic_years y ON y.id = s.academic_year_id AND y.is_current = 1 WHERE s.class_teacher_id IS NULL` },
]

export interface SchoolHealth {
  id: string; name: string; slug: string; reachable: boolean
  last_activity_at: string | null; signins_today: number
  active_7d: Record<string, number>; active_30d: Record<string, number>
  setup: { completed: number; total: number; ready: boolean } | null
  errors_24h: number; jobs_failed_24h: number
  subscription: { plan_code: string; status: string; renews_on: string | null; trial_ends_on: string | null } | null
  problems: Problem[]; problem_total: number
  alerts: UsageAlert[]
}
export interface UsageAlert { metric: string; level: number; used: number; lim: number; pct: number; message: string; raised_at: string }

const istMidnight = () => {
  const d = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10)
  return new Date(Date.parse(d + 'T00:00:00+05:30')).toISOString()
}

async function activeByRole(db: D1Database, ids: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = { total: ids.length }
  if (!ids.length) return out
  const r = await db.prepare(`SELECT COALESCE(r.key, 'no_role') AS role, COUNT(DISTINCT u.value) AS n FROM json_each(?) u
      LEFT JOIN user_roles ur ON ur.user_id = u.value LEFT JOIN roles r ON r.id = ur.role_id GROUP BY 1`).bind(JSON.stringify(ids)).all<{ role: string; n: number }>()
  for (const x of r.results) out[x.role] = Number(x.n)
  return out
}

/** One school's row, computed live from CONTROL and its own database. */
export async function computeSchoolHealth(env: Env, inst: Institution): Promise<SchoolHealth> {
  const since24 = new Date(Date.now() - DAY).toISOString()
  const since7 = new Date(Date.now() - 7 * DAY).toISOString()
  const since30 = new Date(Date.now() - 30 * DAY).toISOString()
  const C = env.CONTROL
  const [sess, users, errs, jobs, sub, alerts] = await Promise.all([
    C.prepare(`SELECT MAX(last_seen_at) AS last, SUM(created_at >= ?) AS today FROM sessions WHERE institution_id = ?`).bind(istMidnight(), inst.id).first<{ last: string | null; today: number | null }>(),
    C.prepare(`SELECT user_id, MAX(last_seen_at) AS seen FROM sessions WHERE institution_id = ? AND last_seen_at >= ? GROUP BY user_id`).bind(inst.id, since30).all<{ user_id: string; seen: string }>(),
    C.prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM school_errors WHERE institution_id = ? AND hour >= ?`).bind(inst.id, since24.slice(0, 13)).first<{ n: number }>(),
    C.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE institution_id = ? AND state IN ('archived','retry') AND last_error IS NOT NULL AND updated_at >= ?`).bind(inst.id, since24).first<{ n: number }>(),
    C.prepare(`SELECT plan_code, status, renews_on, trial_ends_on FROM subscriptions WHERE institution_id = ?`).bind(inst.id).first<SchoolHealth['subscription']>(),
    C.prepare(`SELECT metric, level, used, lim, pct, message, raised_at FROM usage_alerts WHERE institution_id = ? ORDER BY level DESC`).bind(inst.id).all<UsageAlert>(),
  ])
  const h: SchoolHealth = {
    id: inst.id, name: inst.name, slug: inst.slug, reachable: false,
    last_activity_at: sess?.last ?? null, signins_today: Number(sess?.today ?? 0),
    active_7d: { total: 0 }, active_30d: { total: 0 }, setup: null,
    errors_24h: Number(errs?.n ?? 0), jobs_failed_24h: Number(jobs?.n ?? 0),
    subscription: sub ?? null, problems: [], problem_total: 0, alerts: alerts.results,
  }
  let db: D1Database
  try { db = tenantDb(env, inst) } catch { return h }
  const ids30 = users.results.map((u) => u.user_id)
  const ids7 = users.results.filter((u) => u.seen >= since7).map((u) => u.user_id)
  const [a7, a30, setup, probs] = await Promise.all([
    activeByRole(db, ids7), activeByRole(db, ids30), setupStatus(db, inst.id),
    db.batch(PROBLEMS.map((p) => db.prepare(p.sql))),
  ])
  h.reachable = true
  h.active_7d = a7; h.active_30d = a30
  h.setup = { completed: setup.completed, total: setup.total, ready: setup.ready }
  h.problems = PROBLEMS.map((p, i) => ({ key: p.key, label: p.label, link: p.link, hint: p.hint,
    count: Number((probs[i].results[0] as { n?: number } | undefined)?.n ?? 0) }))
  h.problem_total = h.problems.reduce((s, p) => s + p.count, 0)
  return h
}

async function schools(env: Env): Promise<Institution[]> {
  return (await env.CONTROL.prepare(`SELECT * FROM institutions WHERE status = 'active' ORDER BY name`).all<Institution>()).results
}

/** Recomputes every school's row (bounded fan-out) and stores the snapshot. */
export async function refreshHealthSnapshot(env: Env): Promise<number> {
  const list = await schools(env)
  const rows = await mapLimit(list, FANOUT, (i) => computeSchoolHealth(env, i))
  const at = new Date().toISOString()
  const stmts = rows.filter((r): r is SchoolHealth => !!r).map((r) => env.CONTROL.prepare(
    `INSERT INTO school_health (institution_id, data, computed_at) VALUES (?, ?, ?)
     ON CONFLICT (institution_id) DO UPDATE SET data = excluded.data, computed_at = excluded.computed_at`).bind(r.id, JSON.stringify(r), at))
  if (stmts.length) await env.CONTROL.batch(stmts)
  return stmts.length
}

/* ---- usage against plan limits ---- */

interface Usage { metric: string; used: number; lim: number; pct: number; message: string }

async function usageOf(env: Env, inst: Institution): Promise<Usage[]> {
  const lim = await env.CONTROL.prepare(`SELECT COALESCE(s.licensed_students, p.max_students) AS students, COALESCE(s.storage_gb, p.max_storage_gb) AS storage_gb
      FROM subscriptions s LEFT JOIN plans p ON p.code = s.plan_code WHERE s.institution_id = ?`).bind(inst.id).first<{ students: number | null; storage_gb: number | null }>()
  const db = tenantDb(env, inst)
  const v = await db.prepare(`SELECT (SELECT COUNT(*) FROM students WHERE status = 'active') AS students,
      COALESCE((SELECT SUM(size_bytes) FROM files WHERE deleted_at IS NULL), 0) AS bytes,
      (SELECT balance FROM message_credits WHERE channel = 'sms') AS sms, (SELECT low_water FROM message_credits WHERE channel = 'sms') AS low`).first<{ students: number; bytes: number; sms: number | null; low: number | null }>()
  const out: Usage[] = []
  if (!v) return out
  if (lim?.students) {
    const pct = Math.round((100 * v.students) / lim.students)
    out.push({ metric: 'students', used: v.students, lim: lim.students, pct, message: `${v.students} of ${lim.students} licensed students enrolled (${pct}%).` })
  }
  if (lim?.storage_gb) {
    const gb = v.bytes / 1024 ** 3
    const pct = Math.round((100 * gb) / lim.storage_gb)
    out.push({ metric: 'storage', used: Math.round(gb * 100) / 100, lim: lim.storage_gb, pct, message: `${gb.toFixed(2)} GB of ${lim.storage_gb} GB storage used (${pct}%).` })
  }
  if (v.sms !== null) {
    // Credits: 80% when the balance reaches the low-water mark, 100% when it is gone.
    const low = Math.max(1, Number(v.low ?? 100))
    const pct = v.sms <= 0 ? 100 : v.sms <= low ? 80 : 0
    out.push({ metric: 'sms', used: v.sms, lim: low, pct, message: v.sms <= 0 ? 'SMS credits are used up; messages will not send.' : `${v.sms} SMS credits left (low-water mark ${low}).` })
  }
  return out
}

/** Nightly: raise, update or clear each school's alerts; tell admins when a level is first reached. */
export async function runUsageAlerts(env: Env): Promise<void> {
  const list = await schools(env)
  const at = new Date().toISOString()
  await mapLimit(list, FANOUT, async (inst) => {
    const usage = await usageOf(env, inst)
    const prev = new Map((await env.CONTROL.prepare(`SELECT metric, notified_level FROM usage_alerts WHERE institution_id = ?`).bind(inst.id)
      .all<{ metric: string; notified_level: number }>()).results.map((r) => [r.metric, r.notified_level]))
    const stmts: D1PreparedStatement[] = []
    const notify: Usage[] = []
    for (const u of usage) {
      const level = u.pct >= 100 ? 100 : u.pct >= 80 ? 80 : 0
      if (!level) { stmts.push(env.CONTROL.prepare(`DELETE FROM usage_alerts WHERE institution_id = ? AND metric = ?`).bind(inst.id, u.metric)); continue }
      const told = prev.get(u.metric) ?? 0
      if (level > told) notify.push(u)
      stmts.push(env.CONTROL.prepare(`INSERT INTO usage_alerts (institution_id, metric, level, used, lim, pct, message, notified_level, raised_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (institution_id, metric) DO UPDATE SET
          raised_at = CASE WHEN usage_alerts.level = excluded.level THEN usage_alerts.raised_at ELSE excluded.raised_at END,
          level = excluded.level, used = excluded.used, lim = excluded.lim, pct = excluded.pct, message = excluded.message,
          notified_level = MAX(usage_alerts.notified_level, excluded.notified_level), updated_at = excluded.updated_at`)
        .bind(inst.id, u.metric, level, u.used, u.lim, u.pct, u.message, Math.max(level, told), at, at))
    }
    if (notify.length) {
      const db = tenantDb(env, inst)
      const admins = await db.prepare(`SELECT DISTINCT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
          WHERE r.key = 'institution_admin' AND u.status = 'active'`).all<{ user_id: string }>()
      const ins = admins.results.flatMap((a) => notify.map((u) => db.prepare(`INSERT INTO notifications (id, institution_id, user_id, kind, title, body, link, source_kind, source_id, created_at)
          VALUES (?, ?, ?, 'usage_alert', ?, ?, '/go/getting_started/school_setup', 'usage_alert', ?, ?)`)
        .bind(crypto.randomUUID(), inst.id, a.user_id, `Plan limit: ${u.metric} at ${u.pct >= 100 ? '100' : '80'}%`, u.message, `${u.metric}:${u.pct >= 100 ? 100 : 80}`, at)))
      if (ins.length) await db.batch(ins)
    }
    if (stmts.length) await env.CONTROL.batch(stmts)
  })
}

registerJob('seller:health_snapshot', async (env) => { await refreshHealthSnapshot(env) })
registerJob('seller:usage_alerts', async (env) => { await runUsageAlerts(env) })
