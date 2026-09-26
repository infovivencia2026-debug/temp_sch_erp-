import type { Ctx, Router } from '../../router'
import { can } from '../../identity'
import { HttpError, badRequest, conflict, created, isUUID, noContent, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { registerMetrics } from './metrics'
import { openLiveStream, publish } from '../../services/live'
import { registerExport } from './export'
import { resolveRange } from '../misc/shell'
import { requireInstitution } from '../setup/common'
import { pgArray } from '../growth/common'
import {
  addDays, indiaToday, isodow, resolveScope, shortNameSQL, fullNameSQL, studentPredicate,
  type Pred, type Scope,
} from '../students/common'
import { school } from '../school'

/* The loose top-level routes of internal/api/api.go that belong to no module:
   /api-keys, /attention, /board/money, /metrics, /platform-notices, /tour,
   /export and /live. Ported from api_keys.go, attention.go, board_money.go,
   platform_broadcast.go, seller.go (tour) and live_stream.go.
   /metrics and /export live in metrics.ts and export.ts. */

const notImplemented = (what: string) => new HttpError(501, `not implemented in the worker: ${what}`, { code: 'not_implemented' })

/** A list bound as one JSON parameter. */
const inJSON = (col: string) => `${col} IN (SELECT value FROM json_each(?))`
/** Today in the school's calendar, as SQL. */
const TODAY = `date('now','+330 minutes')`
/** A timestamptz column as the school's calendar day. */
const istDay = (col: string) => `date(${col}, '+330 minutes')`
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ddMon = (d: string | null) => (d ? `${d.slice(8, 10)} ${MON[Number(d.slice(5, 7)) - 1]}` : null)
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// ============================================================================
// /tour (seller.go)
// ============================================================================

async function getTour(c: Ctx): Promise<Response> {
  /* A platform operator outside a school has no users row in a tenant database
     and no tour column in CONTROL: answered as Go answers "no users row". */
  if (!c.id.institution) return ok({ seen: false, role: '', school_name: '', is_first_user: false })
  const row = await c.db.prepare(`
    SELECT u.tour_completed_at IS NOT NULL AS seen,
           strftime('%Y-%m-%dT%H:%M:%SZ', u.tour_completed_at) AS completed_at,
           COALESCE((SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                      WHERE ur.user_id = u.id ORDER BY r.key LIMIT 1), '') AS role,
           COALESCE(u.id = (SELECT u2.id FROM users u2 WHERE u2.institution_id IS u.institution_id
                             ORDER BY u2.created_at LIMIT 1), 0) AS first
      FROM users u WHERE u.id = ?`).bind(c.id.userId)
    .first<{ seen: number; completed_at: string | null; role: string; first: number }>()
  if (!row) return ok({ seen: false, role: '', school_name: '', is_first_user: false })
  const out: Record<string, unknown> = { seen: !!row.seen }
  if (row.completed_at) out.completed_at = row.completed_at
  out.role = row.role
  out.school_name = c.id.institution.name ?? ''
  out.is_first_user = !!row.first
  return ok(out)
}

async function setTour(c: Ctx): Promise<Response> {
  let replay = false
  const text = await c.req.text()
  if (text.length > 0) {
    let body: { replay?: unknown }
    try { body = JSON.parse(text) } catch { throw badRequest('malformed JSON body') }
    replay = body?.replay === true
  }
  if (c.id.institution) {
    await c.db.prepare(`UPDATE users SET tour_completed_at = ? WHERE id = ?`).bind(replay ? null : now(), c.id.userId).run()
  }
  return ok({ seen: !replay })
}

// ============================================================================
// /platform-notices (platform_broadcast.go listLiveBroadcasts), from CONTROL
// ============================================================================

async function listLiveBroadcasts(c: Ctx): Promise<Response> {
  const t = now()
  const { results } = await c.env.CONTROL.prepare(`
    SELECT id, severity, title, body, substr(starts_at,1,16) AS starts_at, substr(ends_at,1,16) AS ends_at
      FROM platform_broadcasts
     WHERE retired_at IS NULL AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, starts_at DESC
     LIMIT 5`).bind(t, t).all<{ id: string; severity: string; title: string; body: string; starts_at: string; ends_at: string | null }>()
  const items = results.map((v) => {
    const o: Record<string, unknown> = { id: v.id, severity: v.severity, title: v.title }
    if (v.body) o.body = v.body
    o.starts_at = v.starts_at
    if (v.ends_at !== null) o.ends_at = v.ends_at
    o.live = true
    return o
  })
  return ok({ items })
}

// ============================================================================
// /board/money (board_money.go)
// ============================================================================

async function getBoardMoney(c: Ctx): Promise<Response> {
  // Go stacks RequirePermission(InvoicesRead) and RequirePermission(PayrollRead).
  if (!can(c.id, 'hr.payroll.read')) throw new HttpError(403, 'missing permission: hr.payroll.read', { code: 'forbidden' })
  const rng = resolveRange(c)
  const today = indiaToday()
  const { results } = await c.db.prepare(`
    WITH c AS (SELECT id, name FROM campuses UNION ALL SELECT NULL, 'Unassigned')
    SELECT c.id AS campus_id, c.name AS campus,
      COALESCE((SELECT sum(p.amount_paise) FROM payments p
                 WHERE p.campus_id IS c.id AND p.status = 'success' AND p.mode <> 'adjustment'
                   AND date(p.paid_on) BETWEEN ?1 AND ?2), 0) AS collected,
      COALESCE((SELECT sum(i.net_paise - i.paid_paise) FROM invoices i
                 WHERE i.campus_id IS c.id AND i.status IN ('unpaid','partial','overdue')), 0) AS outstanding,
      COALESCE((SELECT sum(i.net_paise - i.paid_paise) FROM invoices i
                 WHERE i.campus_id IS c.id AND i.status IN ('unpaid','partial','overdue')
                   AND i.due_on IS NOT NULL AND i.due_on < ?3), 0) AS overdue,
      COALESCE((SELECT sum(ps.net_paise) FROM payslips ps
                 JOIN employees e ON e.id = ps.employee_id
                 JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
                 WHERE e.campus_id IS c.id
                   AND printf('%04d-%02d-01', pr.period_year, pr.period_month)
                       BETWEEN substr(?1,1,7) || '-01' AND substr(?2,1,7) || '-01'), 0) AS payroll,
      (SELECT count(*) FROM students st WHERE st.campus_id IS c.id AND st.status = 'active') AS students,
      (SELECT count(*) FROM employees e WHERE e.campus_id IS c.id AND e.status = 'active') AS staff
    FROM c ORDER BY c.id IS NULL, c.name`).bind(rng.from, rng.to, today).all<Record<string, unknown>>()
  const campuses: Record<string, unknown>[] = []
  const total = { campus_id: null as string | null, campus: 'All campuses', collected_paise: 0, outstanding_paise: 0, overdue_paise: 0, payroll_paise: 0, students: 0, staff: 0 }
  for (const r of results) {
    const m = {
      campus_id: (r.campus_id as string | null) ?? null, campus: String(r.campus),
      collected_paise: Number(r.collected), outstanding_paise: Number(r.outstanding), overdue_paise: Number(r.overdue),
      payroll_paise: Number(r.payroll), students: Number(r.students), staff: Number(r.staff),
    }
    if (m.campus_id === null && !m.collected_paise && !m.outstanding_paise && !m.payroll_paise && !m.students && !m.staff) continue
    campuses.push(m)
    total.collected_paise += m.collected_paise; total.outstanding_paise += m.outstanding_paise
    total.overdue_paise += m.overdue_paise; total.payroll_paise += m.payroll_paise
    total.students += m.students; total.staff += m.staff
  }
  return ok({ range: { label: rng.label, period: rng.period, from: rng.from, to: rng.to }, campuses, total })
}

// ============================================================================
// /attention (attention.go)
// ============================================================================

function rupees(paise: number): string {
  const r = paise / 100
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(2)}Cr`
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(2)}L`
  if (r >= 1000) return `₹${(r / 1000).toFixed(1)}K`
  return `₹${r.toFixed(0)}`
}

/** scope.AttendancePredicate. */
function attendancePredicate(s: Scope, alias: string): Pred {
  if (s.allAttendance) return { sql: '1', args: [] }
  const clauses: string[] = [], args: unknown[] = []
  if (s.sectionIds.length) { clauses.push(inJSON(`${alias}.section_id`)); args.push(JSON.stringify(s.sectionIds)) }
  if (s.studentIds.length) { clauses.push(inJSON(`${alias}.student_id`)); args.push(JSON.stringify(s.studentIds)) }
  if (!clauses.length) return { sql: '0', args: [] }
  return { sql: '(' + clauses.join(' OR ') + ')', args }
}

interface ProbeResult { count: number; amount?: number; detail?: string }
interface Probe {
  key: string; needs: string; daily?: boolean; severity: 'critical' | 'warning' | 'info'; action: string; href: string
  headline: (n: number, amount: number) => string
  run: (c: Ctx, sc: Scope, today: string) => Promise<ProbeResult>
}

const count = async (c: Ctx, sql: string, ...args: unknown[]): Promise<number> => {
  const r = await c.db.prepare(sql).bind(...args).raw<[number]>()
  return Number(r[0]?.[0] ?? 0)
}

const PROBES: Probe[] = [
  { key: 'attendance.unmarked', needs: 'academics.attendance.write', daily: true, severity: 'warning', action: 'Mark attendance', href: 'attendance',
    headline: (n) => plural(n, 'section', 'sections') + ' without attendance today',
    run: async (c, sc, today) => {
      const pred = sc.anySection ? '1' : inJSON('s.id')
      const args: unknown[] = sc.anySection ? [] : [JSON.stringify(sc.sectionIds)]
      return { count: await count(c, `
        SELECT count(*) FROM sections s WHERE ${pred}
           AND NOT EXISTS (SELECT 1 FROM student_attendance sa WHERE sa.section_id = s.id AND sa.on_date = ?)
           AND EXISTS (SELECT 1 FROM enrollments e WHERE e.section_id = s.id AND e.status = 'active')`, ...args, today) }
    } },
  { key: 'attendance.absent_today', needs: 'academics.attendance.read', daily: true, severity: 'info', action: 'View register', href: 'attendance',
    headline: (n) => plural(n, 'student', 'students') + ' absent today',
    run: async (c, sc, today) => {
      const p = attendancePredicate(sc, 'sa')
      return { count: await count(c, `SELECT count(*) FROM student_attendance sa WHERE sa.on_date = ? AND sa.status IN ('absent','leave') AND ${p.sql}`, today, ...p.args) }
    } },
  { key: 'attendance.corrections', needs: 'academics.attendance.write.any', severity: 'warning', action: 'Review', href: 'approvals',
    headline: (n) => plural(n, 'attendance correction', 'attendance corrections') + ' awaiting review',
    run: async (c) => ({ count: await count(c, `SELECT count(*) FROM attendance_corrections WHERE status = 'pending'`) }) },
  { key: 'staff.absent_today', needs: 'academics.timetable.write', daily: true, severity: 'warning', action: 'Arrange substitute', href: 'staff',
    headline: (n) => plural(n, 'teacher', 'teachers') + ' absent today',
    run: async (c, _sc, today) => ({ count: await count(c, `
      SELECT count(*) FROM staff_attendance sa
       WHERE sa.on_date = ?1 AND sa.status IN ('absent','leave')
         AND NOT EXISTS (SELECT 1 FROM substitutions su JOIN timetable_entries te ON te.id = su.timetable_entry_id
                          WHERE su.on_date = ?1 AND te.teacher_user_id = sa.user_id)`, today) }) },
  { key: 'fees.overdue', needs: 'finance.invoices.read', severity: 'critical', action: 'Review', href: 'unpaid_fees_reminders student_dues fees',
    headline: (n, amount) => rupees(amount) + ' overdue across ' + plural(n, 'student', 'students'),
    run: async (c, sc, today) => {
      const p = studentPredicate(sc, 'st')
      const r = await c.db.prepare(`
        SELECT count(DISTINCT i.student_id) AS n, COALESCE(sum(i.net_paise - i.paid_paise), 0) AS amount
          FROM invoices i JOIN students st ON st.id = i.student_id
         WHERE i.status IN ('unpaid','partial','overdue') AND i.due_on < ? AND ${p.sql}`).bind(today, ...p.args)
        .first<{ n: number; amount: number }>()
      return { count: Number(r?.n ?? 0), amount: Number(r?.amount ?? 0) }
    } },
  { key: 'payments.failed', needs: 'finance.payments.read', severity: 'critical', action: 'Retry or reconcile', href: 'payments',
    headline: (n) => plural(n, 'payment', 'payments') + ' failed in the last week',
    run: async (c, _sc, today) => ({ count: await count(c, `SELECT count(*) FROM payments WHERE status = 'failed' AND created_at >= ?`, addDays(today, -7)) }) },
  { key: 'payments.bounced', needs: 'finance.payments.read', severity: 'critical', action: 'Raise fine', href: 'payments',
    headline: (n) => plural(n, 'cheque', 'cheques') + ' bounced',
    run: async (c) => ({ count: await count(c, `SELECT count(*) FROM payments WHERE status = 'bounced'`) }) },
  { key: 'fees.concessions_pending', needs: 'finance.fees.write', severity: 'warning', action: 'Approve', href: 'approvals',
    headline: (n) => plural(n, 'concession request', 'concession requests') + ' awaiting approval',
    run: async (c) => ({ count: await count(c, `SELECT count(*) FROM fee_concessions WHERE status = 'pending'`) }) },
  { key: 'admissions.applications', needs: 'admissions.read', severity: 'warning', action: 'Review', href: 'admissions',
    headline: (n) => plural(n, 'admission application', 'admission applications') + ' waiting on a decision',
    run: async (c) => ({ count: await count(c, `SELECT count(*) FROM applications WHERE status IN ('submitted','under_review','test_scheduled','interviewed')`) }) },
  { key: 'admissions.documents', needs: 'admissions.read', severity: 'warning', action: 'Chase documents', href: 'admissions',
    headline: (n) => plural(n, 'applicant', 'applicants') + ' stuck on missing documents',
    run: async (c) => ({ count: await count(c, `SELECT count(*) FROM applications WHERE status = 'documents_pending'`) }) },
  { key: 'admissions.followups', needs: 'admissions.read', severity: 'warning', action: 'Call', href: 'admissions',
    headline: (n) => plural(n, 'follow-up', 'follow-ups') + ' overdue',
    run: async (c, _sc, today) => ({ count: await count(c, `
      SELECT count(*) FROM enquiries WHERE next_follow_up IS NOT NULL AND next_follow_up <= ? AND status NOT IN ('applied','lost')`, today) }) },
  { key: 'leave.pending', needs: 'hr.leave.approve', severity: 'warning', action: 'Approve', href: 'approvals',
    headline: (n) => plural(n, 'leave request', 'leave requests') + ' pending',
    run: async (c) => ({ count: await count(c, `SELECT count(*) FROM leave_requests WHERE status = 'pending'`) }) },
  { key: 'reportcards.unpublished', needs: 'academics.reportcards.generate', severity: 'warning', action: 'Review and publish', href: 'report_cards exams_results marks',
    headline: (n) => plural(n, 'report card', 'report cards') + ' awaiting publication',
    run: async (c, sc) => {
      const p = studentPredicate(sc, 'st')
      return { count: await count(c, `SELECT count(*) FROM report_cards rc JOIN students st ON st.id = rc.student_id WHERE rc.is_published = 0 AND ${p.sql}`, ...p.args) }
    } },
  { key: 'marks.pending', needs: 'academics.marks.write', severity: 'warning', action: 'Enter marks', href: 'marks',
    headline: (n) => plural(n, 'exam paper', 'exam papers') + ' without marks',
    run: async (c, sc, today) => {
      const pred = sc.allStudents ? '1' : `EXISTS (SELECT 1 FROM sections sn WHERE sn.class_id = cs.class_id AND ${inJSON('sn.id')})`
      const args: unknown[] = sc.allStudents ? [] : [JSON.stringify(sc.sectionIds)]
      return { count: await count(c, `
        SELECT count(*) FROM exam_subjects es JOIN class_subjects cs ON cs.id = es.class_subject_id
         WHERE es.exam_date IS NOT NULL AND es.exam_date < ? AND ${pred}
           AND NOT EXISTS (SELECT 1 FROM marks m WHERE m.exam_subject_id = es.id)`, today, ...args) }
    } },
  { key: 'certificates.requested', needs: 'institution_admin.students.certificates_transfers admissions.applications.certificates_transfers',
    severity: 'info', action: 'Issue', href: 'certificates_transfers certificates students',
    headline: (n) => plural(n, 'certificate request', 'certificate requests') + ' to issue',
    run: async (c) => ({ count: await count(c, `SELECT count(*) FROM issued_certificates WHERE status = 'requested'`) }) },
  { key: 'self.fees_due', needs: 'self.fees.read', severity: 'critical', action: 'Open', href: 'fees',
    headline: (_n, amount) => `${rupees(amount)} due`,
    run: async (c, sc) => {
      if (!sc.studentIds.length) return { count: 0 }
      const r = await c.db.prepare(`
        SELECT count(*) AS n, COALESCE(sum(net_paise - paid_paise), 0) AS amount, min(due_on) AS due
          FROM invoices WHERE ${inJSON('student_id')} AND status IN ('unpaid','partial','overdue')`)
        .bind(JSON.stringify(sc.studentIds)).first<{ n: number; amount: number; due: string | null }>()
      const due = ddMon(r?.due ?? null)
      return { count: Number(r?.n ?? 0), amount: Number(r?.amount ?? 0), detail: due ? 'Due by ' + due : '' }
    } },
  { key: 'self.homework_due', needs: 'self.profile.read', severity: 'warning', action: 'Open homework', href: 'homework',
    headline: (n) => plural(n, 'piece', 'pieces') + ' of homework still to hand in',
    run: async (c, sc, today) => {
      if (!sc.studentIds.length) return { count: 0 }
      const r = await c.db.prepare(`
        SELECT count(*) AS n, min(h.due_on) AS soonest
          FROM homework h
          JOIN enrollments e ON e.section_id = h.section_id AND ${inJSON('e.student_id')} AND e.status = 'active'
         WHERE h.is_published = 1 AND h.due_on >= ?
           AND NOT EXISTS (SELECT 1 FROM homework_submissions sub WHERE sub.homework_id = h.id AND sub.student_id = e.student_id)`)
        .bind(JSON.stringify(sc.studentIds), today).first<{ n: number; soonest: string | null }>()
      const s = ddMon(r?.soonest ?? null)
      return { count: Number(r?.n ?? 0), detail: s ? 'Soonest due ' + s : '' }
    } },
]
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 }
const canAny = (c: Ctx, needs: string) => needs.split(/\s+/).filter(Boolean).some((k) => can(c.id, k))

/** schoolOpenToday: the weekly work pattern, overridden both ways by the holiday calendar. */
async function schoolOpenToday(c: Ctx, today: string): Promise<boolean> {
  const r = await c.db.prepare(`
    SELECT ((NOT EXISTS (SELECT 1 FROM work_patterns)
             OR EXISTS (SELECT 1 FROM work_patterns wp, json_each(wp.working_days) d WHERE CAST(d.value AS INTEGER) = ?2))
            AND NOT EXISTS (SELECT 1 FROM holidays h WHERE h.kind <> 'working_day' AND ?1 BETWEEN h.on_date AND COALESCE(h.to_date, h.on_date)))
        OR EXISTS (SELECT 1 FROM holidays h WHERE h.kind = 'working_day' AND ?1 BETWEEN h.on_date AND COALESCE(h.to_date, h.on_date)) AS open`)
    .bind(today, isodow(today)).first<{ open: number }>()
  return !!r?.open
}

function greeting(): string {
  const h = new Date(Date.now() + 5.5 * 3_600_000).getUTCHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

async function todaySummary(c: Ctx, sc: Scope, today: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  if (can(c.id, 'students.read')) {
    const p = studentPredicate(sc, 'st')
    const total = await count(c, `SELECT count(*) FROM students st WHERE st.id IN (SELECT e.student_id FROM enrollments e WHERE e.status = 'active') AND ${p.sql}`, ...p.args)
    if (total > 0) out.push({ label: 'Students', value: String(total) })
  }
  if (can(c.id, 'academics.attendance.read')) {
    const p = attendancePredicate(sc, 'sa')
    const r = await c.db.prepare(`SELECT count(*) FILTER (WHERE sa.status IN ('present','late')) AS present, count(*) AS marked
      FROM student_attendance sa WHERE sa.on_date = ? AND ${p.sql}`).bind(today, ...p.args).first<{ present: number; marked: number }>()
    const present = Number(r?.present ?? 0), marked = Number(r?.marked ?? 0)
    if (marked > 0) out.push({ label: 'Present today', value: `${((present * 100) / marked).toFixed(1)}%`, hint: `${present} of ${marked} marked` })
  }
  if (can(c.id, 'academics.timetable.read')) {
    const r = await c.db.prepare(`SELECT count(*) AS periods, count(DISTINCT te.section_id) AS sections FROM timetable_entries te
      WHERE te.teacher_user_id = ? AND te.weekday = ?`).bind(c.id.userId, isodow(today)).first<{ periods: number; sections: number }>()
    const periods = Number(r?.periods ?? 0), sections = Number(r?.sections ?? 0)
    if (periods > 0) out.push({ label: 'Classes today', value: String(periods), hint: `${sections} section${sections !== 1 ? 's' : ''}` })
  }
  if (can(c.id, 'academics.attendance.write') && !sc.anySection && sc.sectionIds.length > 0) {
    const marked = await count(c, `SELECT count(DISTINCT sa.section_id) FROM student_attendance sa WHERE sa.on_date = ? AND ${inJSON('sa.section_id')}`,
      today, JSON.stringify(sc.sectionIds))
    const total = sc.sectionIds.length
    const done = marked >= total
    const s: Record<string, unknown> = { label: 'Registers taken', value: `${marked} of ${total}`, hint: done ? 'All done' : 'Still to mark' }
    if (done) s.tone = 'good'
    out.push(s)
  }
  if (can(c.id, 'finance.payments.read')) {
    const collected = await count(c, `SELECT COALESCE(sum(amount_paise), 0) FROM payments WHERE status = 'success' AND paid_on = ?`, today)
    out.push({ label: 'Collected today', value: rupees(collected) })
  }
  if (can(c.id, 'admissions.read')) {
    const n = await count(c, `SELECT count(*) FROM enquiries WHERE ${istDay('created_at')} = ?`, today)
    out.push({ label: 'New enquiries', value: String(n) })
  }
  if (can(c.id, 'hr.employees.read')) {
    const r = await c.db.prepare(`SELECT count(*) FILTER (WHERE status IN ('present','late','half_day')) AS present, count(*) AS marked
      FROM staff_attendance WHERE on_date = ?`).bind(today).first<{ present: number; marked: number }>()
    const present = Number(r?.present ?? 0), marked = Number(r?.marked ?? 0)
    if (marked > 0) out.push({ label: 'Staff present', value: `${((present * 100) / marked).toFixed(0)}%` })
  }
  return out
}

async function getAttention(c: Ctx): Promise<Response> {
  const sc = await resolveScope(c)
  const today = indiaToday()
  const items: Record<string, unknown>[] = []
  let openToday: boolean | null = null
  for (const p of PROBES) {
    if (!canAny(c, p.needs)) continue
    if (p.daily) {
      if (openToday === null) openToday = await schoolOpenToday(c, today)
      if (!openToday) continue
    }
    const res = await p.run(c, sc, today)
    if (res.count === 0) continue
    const amount = res.amount ?? 0
    const item: Record<string, unknown> = { key: p.key, severity: p.severity, count: res.count, headline: p.headline(res.count, amount) }
    if (res.detail) item.detail = res.detail
    item.action = p.action
    if (p.href) item.href = p.href
    if (amount) item.amount_paise = amount
    items.push(item)
  }
  const summary = await todaySummary(c, sc, today)
  items.sort((a, b) => SEVERITY_RANK[a.severity as keyof typeof SEVERITY_RANK] - SEVERITY_RANK[b.severity as keyof typeof SEVERITY_RANK])
  return ok({ role: c.url.searchParams.get('role') ?? '', items, summary, greeting: greeting() })
}

// ============================================================================
// /api-keys (api_keys.go)
// ============================================================================

const API_KEY_PREFIX = 'erpk'
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
const apiKeyHint = (token: string) => {
  const head = API_KEY_PREFIX.length + 1 + 36
  return token.length > head ? token.slice(0, head) + '.…' : token
}

async function listAPIKeys(c: Ctx): Promise<Response> {
  requireInstitution(c)
  const { results } = await c.db.prepare(`
    SELECT k.id, k.name, k.token_hint, k.permissions, k.rate_per_minute, COALESCE(u.full_name, '') AS created_by,
           k.created_at, k.last_used_at, k.expires_at, k.revoked_at
      FROM api_keys k LEFT JOIN users u ON u.id = k.created_by
     WHERE k.institution_id = ?
     ORDER BY k.revoked_at IS NOT NULL, k.revoked_at, k.created_at DESC`).bind(school(c).id).all<Record<string, unknown>>()
  const api_keys = results.map((k) => ({
    id: k.id, name: k.name, hint: k.token_hint, permissions: pgArray(k.permissions).sort(), rate_per_minute: Number(k.rate_per_minute),
    created_by: k.created_by, created_at: k.created_at, last_used_at: k.last_used_at ?? null, expires_at: k.expires_at ?? null, revoked_at: k.revoked_at ?? null,
  }))
  return ok({ api_keys })
}

async function issueAPIKey(c: Ctx): Promise<Response> {
  requireInstitution(c)
  let req: { name?: unknown; permissions?: unknown; rate_per_minute?: unknown; expires_at?: unknown }
  try { req = await c.req.json() } catch { throw badRequest('body must be json') }
  const name = typeof req.name === 'string' ? req.name.trim() : ''
  if (!name) throw badRequest('name is required; it is the only thing that says what the key is for')
  const asked = Array.isArray(req.permissions) ? req.permissions.map(String) : []
  if (asked.length === 0) throw badRequest('permissions is required; a key with no permissions can do nothing')
  let rate = 120
  if (req.rate_per_minute !== undefined && req.rate_per_minute !== null) {
    rate = Number(req.rate_per_minute)
    if (!Number.isInteger(rate) || rate < 1 || rate > 6000) throw badRequest('rate_per_minute must be between 1 and 6000')
  }
  let expires: string | null = null
  if (req.expires_at !== undefined && req.expires_at !== null) {
    const t = typeof req.expires_at === 'string' ? Date.parse(req.expires_at) : NaN
    if (Number.isNaN(t)) throw badRequest('body must be json')
    if (t < Date.now()) throw badRequest('expires_at is in the past')
    expires = new Date(t).toISOString()
  }
  const wanted = [...new Set(asked.map((p) => p.trim()).filter(Boolean))].sort()
  // rbac.All by module: a key that is not a permission, or is a platform one, is refused.
  const known = await c.db.prepare(`SELECT key, module FROM permissions WHERE ${inJSON('key')}`).bind(JSON.stringify(wanted)).all<{ key: string; module: string }>()
  const moduleOf = new Map(known.results.map((r) => [r.key, r.module]))
  for (const p of wanted) {
    const mod = moduleOf.get(p)
    if (mod === undefined || mod === 'platform') {
      throw badRequest(`${JSON.stringify(p)} cannot be given to an API key: it is either not a permission at all or one only the platform operator holds`)
    }
  }
  const instId = school(c).id
  const granted = await c.db.prepare(`SELECT DISTINCT rp.permission_key AS k FROM roles ro JOIN role_permissions rp ON rp.role_id = ro.id WHERE ro.institution_id = ?`)
    .bind(instId).all<{ k: string }>()
  const have = new Set(granted.results.map((r) => r.k))
  for (const p of wanted) {
    if (!have.has(p)) throw new HttpError(400, `this school does not grant ${JSON.stringify(p)} to any role, so a key cannot carry it`, { code: 'invalid' })
  }
  const id = uuid()
  const secret = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const token = `${API_KEY_PREFIX}.${id}.${secret}`
  try {
    await c.db.prepare(`
      INSERT INTO api_keys (id, institution_id, name, token_hash, token_hint, permissions, rate_per_minute, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, instId, name, await sha256(secret), apiKeyHint(token), JSON.stringify(wanted), rate, c.id.userId, now(), expires).run()
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      throw conflict('a live key of that name already exists; revoke it or choose another name')
    }
    throw e
  }
  return created({
    id, name, token, permissions: wanted, rate_per_minute: rate,
    note: 'This is the only time this key is shown. Store it now; if it is lost, revoke it and issue another.',
  })
}

async function revokeAPIKey(c: Ctx): Promise<Response> {
  requireInstitution(c)
  const keyId = uuidParam(c.params.id)
  const r = await c.db.prepare(`UPDATE api_keys SET revoked_at = ?, revoked_by = ? WHERE id = ? AND institution_id = ? AND revoked_at IS NULL`)
    .bind(now(), c.id.userId, keyId, school(c).id).run()
  if (!r.meta.changes) throw notFound()
  return ok({ revoked: true })
}

// ============================================================================
// /live (live_stream.go)
// ============================================================================

interface TypingRequest { scope?: string; peer?: string; student?: string; parent?: string; teacher?: string; thread?: string }

/** POST /live/seen: marks the bell entries pointing at an open conversation read. */
async function liveSeen(c: Ctx): Promise<Response> {
  const req = await readJSON<TypingRequest>(c.req)
  let kind: string, pattern: string
  switch ((req.scope ?? '').trim().toLowerCase()) {
    case 'staff':
      if (!isUUID(req.peer)) throw badRequest('peer must be a uuid')
      kind = 'staff_message'; pattern = `%with=${req.peer.toLowerCase()}%`
      break
    case 'parent': {
      if (!isUUID(req.student) || !isUUID(req.parent) || !isUUID(req.teacher)) throw badRequest('student, parent and teacher must be uuids')
      const sid = req.student.toLowerCase(), pid = req.parent.toLowerCase(), tid = req.teacher.toLowerCase()
      kind = 'parent_message'
      pattern = c.id.userId === pid ? `%student_id=${sid}&teacher_user_id=${tid}%` : `%child=${sid}&with=${pid}%`
      break
    }
    case 'counselor':
      if (!isUUID(req.thread)) throw badRequest('thread must be a uuid')
      kind = 'counselor_message'; pattern = `%thread=${req.thread.toLowerCase()}%`
      break
    default:
      throw badRequest('scope must be staff, parent or counselor')
  }
  await c.db.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND kind = ? AND link LIKE ?`)
    .bind(now(), c.id.userId, kind, pattern).run()
  return noContent()
}

/* POST /live/typing: validated against the conversation it claims, as Go does,
   then the typing hint goes to the other party through the school's LiveHub. */
async function liveTyping(c: Ctx): Promise<Response> {
  const req = await readJSON<TypingRequest>(c.req)
  const bad = () => badRequest('that is not a conversation you are part of')
  const me = c.id.userId
  const scope = (req.scope ?? '').trim().toLowerCase()
  let recipients: string[] = []
  const keys: Record<string, string> = {}
  switch (scope) {
    case 'staff': {
      if (!isUUID(req.peer)) throw bad()
      if (!(await c.db.prepare(`SELECT 1 FROM users WHERE id = ?`).bind(req.peer.toLowerCase()).first())) throw bad()
      recipients = [req.peer.toLowerCase()]
      keys.peer = me
      break
    }
    case 'parent': {
      if (!isUUID(req.student) || !isUUID(req.parent) || !isUUID(req.teacher)) throw bad()
      const sid = req.student.toLowerCase(), pid = req.parent.toLowerCase(), tid = req.teacher.toLowerCase()
      if (me !== pid && me !== tid) throw bad()
      const row = await c.db.prepare(`SELECT 1 FROM parent_teacher_messages WHERE student_id = ? AND parent_user_id = ? AND teacher_user_id = ? LIMIT 1`)
        .bind(sid, pid, tid).first()
      if (!row) throw bad()
      recipients = [me === pid ? tid : pid]
      Object.assign(keys, { student: sid, parent: pid, teacher: tid })
      break
    }
    case 'counselor': {
      if (!isUUID(req.thread)) throw bad()
      const { results } = await c.db.prepare(`SELECT user_id FROM counselor_thread_participants WHERE thread_id = ? AND removed_at IS NULL`)
        .bind(req.thread.toLowerCase()).all<{ user_id: string }>()
      if (!results.some((r) => r.user_id === me)) throw bad()
      recipients = results.map((r) => r.user_id).filter((u) => u !== me)
      keys.thread = req.thread.toLowerCase()
      break
    }
    default:
      throw bad()
  }
  await publish(c.env, c.id.institution?.id, { users: recipients, type: 'typing', scope, from: me, keys })
  return noContent()
}

/* GET /live/stream: Server-Sent Events, held by the school's LiveHub Durable
   Object (services/live.ts). Session cookie only, as in Go (EventSource sends
   nothing else; no token query parameter). A platform operator has no school
   on this request (no X-Acting-Institution), so, like Go, gets a stream that
   carries nothing: they are held on a hub no writer publishes to. */
function liveStream(c: Ctx): Promise<Response> {
  return openLiveStream(c.env, c.id.institution?.id ?? 'platform:none', c.id.userId, c.req)
}

export function registerLoose(r: Router): void {
  r.get('/tour', 'auth', getTour)
  r.post('/tour', 'auth', setTour)
  r.get('/platform-notices', 'auth', listLiveBroadcasts)
  r.get('/board/money', 'finance.invoices.read', getBoardMoney)
  r.get('/attention', 'auth', getAttention)
  registerMetrics(r)
  r.get('/api-keys', 'access.users.read', listAPIKeys)
  r.post('/api-keys', 'access.users.write', issueAPIKey)
  r.post('/api-keys/{id}/revoke', 'access.users.write', revokeAPIKey)
  registerExport(r)
  r.get('/live/stream', 'auth', liveStream)
  r.post('/live/typing', 'auth', liveTyping)
  r.post('/live/seen', 'auth', liveSeen)
}

