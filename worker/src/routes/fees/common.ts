import type { Ctx } from '../../router'
import { HttpError, badRequest, forbidden, now, uuid } from '../../http'
import { can } from '../../identity'

/* Helpers shared by every finance route file. Nothing here talks to a
   network other than D1. Money is integer paise throughout: the Go code used
   int64 paise and the SQLite columns are INTEGER, so JS arithmetic stays exact
   well past any school's turnover (2^53 paise is ninety trillion rupees). */

/** A side effect that leaves the database (SMS, PDF, gateway, R2). Not ported. */
export const notImplemented = (what: string): never => { throw new HttpError(501, `${what}: not implemented in the worker`) }

/** Unique-constraint failures from D1 surface as a message, not a code. */
export const isUniqueViolation = (e: unknown): boolean => e instanceof Error && /UNIQUE constraint failed/i.test(e.message)
export const isForeignKeyViolation = (e: unknown): boolean => e instanceof Error && /FOREIGN KEY constraint failed/i.test(e.message)

/** Integer paise from a JSON number or a numeric string. Fractions and NaN are rejected. */
export function paise(v: unknown, name = 'amount_paise'): number {
  if (v === null || v === undefined || v === '') return 0
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN
  if (!Number.isSafeInteger(n)) throw badRequest(`${name} must be a whole number of paise`)
  return n
}
/** A column value read back from D1 as integer paise. */
export const p = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))

export const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
export const optStr = (v: unknown): string | null => { const s = str(v).trim(); return s === '' ? null : s }
export const items = <T>(rows: T[]) => ({ items: rows })

/* ------------------------------------------------------------------------- */
/* Dates. Every date in this product is resolved in Asia/Kolkata (daterange.go). */

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000
/** The current wall-clock moment in India, as a Date whose UTC fields read as IST. */
export function nowIST(): Date { return new Date(Date.now() + IST_OFFSET_MS) }
export function ymd(d: Date): string { return d.toISOString().slice(0, 10) }
/** Today's date in India, YYYY-MM-DD. The SQL CURRENT_DATE the Go handlers used, in the right zone. */
export const today = (): string => ymd(nowIST())
export function addDays(s: string, n: number): string { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d) }
export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
/** Whole days from a to b (b - a). */
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000)

export interface DateRange { from: string; to: string; label: string; period: string }
export const rangeJSON = (r: DateRange) => ({ label: r.label, period: r.period, from: r.from, to: r.to })

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const fmtLong = (s: string) => { const d = new Date(s + 'T00:00:00Z'); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}` }
const mkDate = (y: number, m: number, d: number) => ymd(new Date(Date.UTC(y, m, d)))

/** Port of resolveRange: ?period= or ?from=&to=, defaulting to this month. */
export function resolveRange(c: Ctx): DateRange {
  const q = c.url.searchParams
  const n = nowIST(); const Y = n.getUTCFullYear(); const M = n.getUTCMonth()
  const t = ymd(n)
  let period = q.get('period') ?? ''
  const f = q.get('from'); const to = q.get('to')
  if (f && to && isDate(f) && isDate(to)) {
    const [a, b] = to < f ? [to, f] : [f, to]
    return { from: a, to: b, period: 'custom', label: `${fmtLong(a)} to ${fmtLong(b)}` }
  }
  const acadStart = (yy: number, mm: number) => mkDate(mm < 5 ? yy - 1 : yy, 5, 1)
  const finStart = mkDate(M < 3 ? Y - 1 : Y, 3, 1)
  const yr = (s: string) => `${s.slice(0, 4)}-${String(Number(s.slice(0, 4)) + 1).slice(2)}`
  switch (period) {
    case 'today': return { from: t, to: t, label: 'Today', period }
    case 'yesterday': { const y = addDays(t, -1); return { from: y, to: y, label: 'Yesterday', period } }
    case 'last_7': return { from: addDays(t, -6), to: t, label: 'Last 7 days', period }
    case 'last_30': return { from: addDays(t, -29), to: t, label: 'Last 30 days', period }
    case 'this_week': { const off = (n.getUTCDay() + 6) % 7; return { from: addDays(t, -off), to: t, label: 'This week', period } }
    case 'last_month': { const first = mkDate(Y, M - 1, 1); const last = mkDate(Y, M, 0); const d = new Date(first + 'T00:00:00Z')
      return { from: first, to: last, label: `Last month - ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`, period } }
    case 'this_quarter': { const qm = Math.floor(M / 3) * 3; return { from: mkDate(Y, qm, 1), to: t, label: 'This quarter', period } }
    case 'this_term': return { from: acadStart(Y, M), to: t, label: 'This term', period }
    case 'this_year': { const s = acadStart(Y, M); return { from: s, to: t, label: `This academic year - ${yr(s)}`, period } }
    case 'last_year': { const s0 = acadStart(Y, M); const s = mkDate(Number(s0.slice(0, 4)) - 1, 5, 1); const e = mkDate(Number(s0.slice(0, 4)), 4, 31)
      return { from: s, to: e, label: `Last academic year - ${yr(s)}`, period } }
    case 'fin_year': return { from: finStart, to: t, label: `Financial year ${yr(finStart)}`, period }
  }
  period = 'this_month'
  const first = mkDate(Y, M, 1)
  return { from: first, to: t, label: `This month - ${MONTHS[M]} ${Y}`, period }
}

/* ------------------------------------------------------------------------- */
/* SQL fragments. */

/** concat_ws(' ', first, middle, last) for a students alias. */
export const nameSQL = (a = 'st') =>
  `TRIM(${a}.first_name || COALESCE(' ' || ${a}.middle_name, '') || COALESCE(' ' || ${a}.last_name, ''))`

/** A `col IN (?, ?, ...)` predicate, or FALSE for an empty set (scope.anyOf). */
export function inList(col: string, ids: readonly string[]): { sql: string; args: string[] } {
  if (ids.length === 0) return { sql: 'FALSE', args: [] }
  return { sql: `${col} IN (SELECT value FROM json_each(?))`, args: [JSON.stringify(ids)] }
}

/* ------------------------------------------------------------------------- */
/* Scope (internal/scope): which students this caller may reach. */

export interface StudentScope {
  /** true when the caller reads the whole institution (back office, platform admin). */
  all: boolean
  /** Own record plus linked children, when not `all`. */
  studentIds: string[]
}

/** Own student record plus children linked through unblocked guardian rows. */
export async function ownStudentIds(c: Ctx): Promise<string[]> {
  const rows = await c.db.prepare(`
    SELECT id FROM students WHERE user_id = ?1
    UNION
    SELECT sg.student_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
     WHERE g.user_id = ?1 AND NOT sg.portal_blocked
       AND (sg.access_until IS NULL OR sg.access_until >= ?2)`).bind(c.id.userId, today()).all<{ id: string }>()
  return rows.results.map((r) => r.id)
}

/**
 * The fee counter's rule: a holder of the finance permission reaches any
 * student; anybody else (a parent, a student) reaches only their own.
 */
export async function studentScope(c: Ctx, wholeSchoolPerm: string): Promise<StudentScope> {
  if (can(c.id, wholeSchoolPerm) || can(c.id, 'students.read.all')) return { all: true, studentIds: [] }
  return { all: false, studentIds: await ownStudentIds(c) }
}

/** Throws 404 (not 403: the Go handlers hide existence) when the student is outside scope. */
export function assertInScope(sc: StudentScope, studentId: string): void {
  if (!sc.all && !sc.studentIds.includes(studentId)) throw new HttpError(404, 'student not found')
}

/* ------------------------------------------------------------------------- */
/* RequireFresh (login_security.go): a money action needs a password typed in
   the last fifteen minutes. The control sessions table carries created_at and
   via; there is no reauth_at column in the worker's schema, so the age of the
   sign-in itself is what is measured. */
const FRESH_FOR_MS = 15 * 60 * 1000
export async function requireFresh(c: Ctx): Promise<void> {
  if (c.id.platformAdmin) return
  const s = await c.env.CONTROL.prepare(`SELECT created_at, via FROM sessions WHERE id = ?`).bind(c.id.sessionId)
    .first<{ created_at: string; via: string }>()
  if (!s) return
  const dayCode = s.via === 'day_code' || s.via === 'daycode'
  /* POST /session/reauth (misc/profile.ts) cannot stamp sessions.reauth_at, which CONTROL lacks; it
     writes a 'reauth_ok' login event instead. The latest one for this user since this session began
     is the freshness mark, so confirming the password actually reopens the window. */
  let last = Date.parse(s.created_at)
  if (!dayCode) {
    const r = await c.env.CONTROL.prepare(`SELECT max(at) AS at FROM login_events WHERE user_id = ? AND outcome = 'reauth_ok' AND at >= ?`)
      .bind(c.id.userId, s.created_at).first<{ at: string | null }>()
    if (r?.at) last = Math.max(last, Date.parse(r.at))
  }
  if (dayCode || Date.now() - last > FRESH_FOR_MS) {
    throw new HttpError(403, 'Confirm your password to continue: this action moves money and your sign-in is older than fifteen minutes.', { code: 'reauth_required' })
  }
}

/** Go's RequireAnyPermission for routes whose gate was a pair. */
export function requireAny(c: Ctx, ...perms: string[]): void {
  if (!perms.some((p) => can(c.id, p))) throw forbidden()
}

/* ------------------------------------------------------------------------- */
/* Triggers re-implemented. Each returns prepared statements to append to the
   same c.db.batch as the write that would have fired the trigger. */

/**
 * sync_invoice_paid (00001 baseline): after any change to payment_allocations,
 * paid_paise = sum(allocations) and status is recomputed. invoices_touch is
 * folded in as updated_at.
 */
export function syncInvoice(c: Ctx, invoiceId: string): D1PreparedStatement[] {
  const t = today()
  return [
    c.db.prepare(`UPDATE invoices SET paid_paise = COALESCE((SELECT sum(amount_paise) FROM payment_allocations WHERE invoice_id = ?1), 0),
                      updated_at = ?2 WHERE id = ?1`).bind(invoiceId, now()),
    c.db.prepare(`UPDATE invoices SET status = CASE
        WHEN status = 'cancelled' THEN 'cancelled'
        WHEN paid_paise >= net_paise AND net_paise > 0 THEN 'paid'
        WHEN paid_paise > 0 THEN 'partial'
        WHEN due_on IS NOT NULL AND due_on < ?2 THEN 'overdue'
        ELSE 'unpaid' END WHERE id = ?1`).bind(invoiceId, t),
  ]
}

/** sync_payment_allocated (00002): allocated_paise = sum(allocations). */
export function syncPayment(c: Ctx, paymentId: string): D1PreparedStatement {
  return c.db.prepare(`UPDATE payments SET allocated_paise = COALESCE((SELECT sum(amount_paise) FROM payment_allocations WHERE payment_id = ?1), 0) WHERE id = ?1`).bind(paymentId)
}

/**
 * sync_wallet_balance (00322): balance_paise = sum(delta). The "cannot go
 * negative" RAISE is a precondition the caller must test before the batch,
 * because a batch cannot raise; `walletBalance` reads it.
 */
export function syncWallet(c: Ctx, walletId: string): D1PreparedStatement {
  return c.db.prepare(`UPDATE wallet_accounts SET balance_paise = COALESCE((SELECT sum(delta_paise) FROM wallet_transactions WHERE wallet_id = ?1), 0), updated_at = ?2 WHERE id = ?1`).bind(walletId, now())
}

/* ------------------------------------------------------------------------- */
/* The /finance group carried r.Use(RequirePermission(InvoicesRead)) on top of
   each route's own permission. The worker router takes one key per route, so
   every /finance handler is wrapped in this to keep the group gate. */
import type { Handler } from '../../router'
import { school } from '../school'
export const FINANCE_GROUP = 'finance.invoices.read'
export const fin = (h: Handler): Handler => (c) => {
  if (!can(c.id, FINANCE_GROUP)) throw forbidden()
  return h(c)
}

/* ------------------------------------------------------------------------- */
/* Batch-time assertions. A D1 batch is one transaction but cannot RAISE, so a
   precondition that must hold at write time (a counter nobody else advanced,
   a wallet that stays above zero) is expressed as a statement that fails a
   constraint when the condition is false: re-inserting the institution's own
   row violates its primary key, and the failure rolls back the whole batch. */
export function assertInBatch(c: Ctx, cond: string, args: unknown[] = []): D1PreparedStatement {
  return c.db.prepare(`INSERT INTO institutions SELECT * FROM institutions WHERE NOT (${cond}) LIMIT 1`).bind(...args)
}

/** Postgres error from a failed batch guard or constraint, mapped to what the Go handler answered. */
export const isBatchGuardFailure = (e: unknown): boolean => e instanceof Error && /constraint failed/i.test(e.message)

/* ------------------------------------------------------------------------- */
/* Period locks (period_close.go). */

export const periodClosed = (msg: string) => new HttpError(409, msg, { code: 'period_closed' })

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** requireOpenPeriod(kind='month'): refuses a write dated inside a closed month or closed year. */
export async function requireOpenPeriod(c: Ctx, on: string, kind: 'month' | 'year' = 'month'): Promise<void> {
  const key = on.slice(0, 7)
  const row = await c.db.prepare(`
    SELECT (?3 = 'month' AND EXISTS (SELECT 1 FROM period_closes WHERE kind = 'month' AND period_key = ?1 AND reopened_at IS NULL)) AS month_closed,
           (SELECT name FROM academic_years WHERE closed_at IS NOT NULL AND ?2 BETWEEN starts_on AND ends_on ORDER BY starts_on DESC LIMIT 1) AS year_name`)
    .bind(key, on, kind).first<{ month_closed: number; year_name: string | null }>()
  if (row?.month_closed) {
    const d = new Date(on + 'T00:00:00Z')
    throw periodClosed(`${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()} is closed; ask the principal to reopen it`)
  }
  if (row?.year_name) throw periodClosed(`The year ${row.year_name} is closed; ask the principal to reopen it`)
}

/** requireOpenYear: the same refusal for a write that knows its academic year by id. */
export async function requireOpenYear(c: Ctx, yearId: string): Promise<void> {
  const row = await c.db.prepare(`SELECT name, closed_at IS NOT NULL AS closed FROM academic_years WHERE id = ?`).bind(yearId)
    .first<{ name: string; closed: number }>()
  if (row && row.closed) throw periodClosed(`The year ${row.name} is closed; ask the principal to reopen it`)
}

/** workingYearIn (working_year.go): explicit id, else the caller's chosen year, else the current/latest. */
export async function workingYear(c: Ctx, explicit = ''): Promise<string | null> {
  explicit = explicit.trim() || (c.url.searchParams.get('academic_year_id') ?? '').trim()
  if (explicit) {
    if (!/^[0-9a-f-]{36}$/i.test(explicit)) throw badRequest('academic_year_id must be a uuid')
    const r = await c.db.prepare(`SELECT id FROM academic_years WHERE id = ?`).bind(explicit).first<{ id: string }>()
    if (!r) throw badRequest('no academic year with that id')
    return r.id
  }
  const chosen = await c.db.prepare(`SELECT y.id FROM user_working_years w JOIN academic_years y ON y.id = w.academic_year_id WHERE w.user_id = ?`)
    .bind(c.id.userId).first<{ id: string }>()
  if (chosen) return chosen.id
  const latest = await c.db.prepare(`SELECT id FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1`).first<{ id: string }>()
  return latest?.id ?? null
}

/* ------------------------------------------------------------------------- */
/* In-app alerts (notify in portal_school_life.go). The Postgres partial unique
   index on (user_id, kind, source_id, student_id) is a NOT EXISTS here. */
export function notifyStmt(c: Ctx, userId: string, studentId: string | null, kind: string, title: string, body: string,
  link: string, sourceKind: string, sourceId: string | null): D1PreparedStatement {
  return c.db.prepare(`
    INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, source_kind, source_id, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
     WHERE NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = ?3 AND n.kind = ?5 AND n.source_kind IS NOT NULL
                        AND COALESCE(n.source_id, '') = COALESCE(?10, '') AND COALESCE(n.student_id, '') = COALESCE(?4, ''))`)
    .bind(uuid(), school(c).id, userId, studentId, kind, title, body, link, sourceKind, sourceId, now())
}

/** Everyone in the household with an account: linked guardians and the child's own login. */
export async function householdUserIds(c: Ctx, studentId: string): Promise<string[]> {
  const rows = await c.db.prepare(`
    SELECT g.user_id AS id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ?1 AND g.user_id IS NOT NULL
    UNION
    SELECT st.user_id FROM students st WHERE st.id = ?1 AND st.user_id IS NOT NULL`).bind(studentId).all<{ id: string }>()
  return rows.results.map((r) => r.id)
}

/* ------------------------------------------------------------------------- */
/* Money rendering. */

/** buy.go indianRupees: 1234567 -> "12,34,567" (no symbol, integer input). */
export function indianGroup(n: number): string {
  const neg = n < 0; let s = String(Math.abs(n))
  if (s.length > 3) {
    let head = s.slice(0, -3); const tail = s.slice(-3); const parts: string[] = []
    while (head.length > 2) { parts.unshift(head.slice(-2)); head = head.slice(0, -2) }
    if (head) parts.unshift(head)
    s = parts.join(',') + ',' + tail
  }
  return (neg ? '-' : '') + s
}
/** "₹1234.50" as strconv.FormatFloat(paise/100, 'f', 2) rendered it. */
export const rupeesFixed = (paise: number): string => (paise < 0 ? '-' : '') + Math.floor(Math.abs(paise) / 100) + '.' + String(Math.abs(paise) % 100).padStart(2, '0')

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
const two = (n: number): string => (n === 0 ? '' : n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''))
const three = (n: number): string => { const parts: string[] = []; const h = Math.floor(n / 100); if (h) parts.push(ONES[h] + ' Hundred'); const t = two(n % 100); if (t) parts.push(t); return parts.join(' ') }
function indianWords(n: number): string {
  if (n >= 1_00_00_000 * 100) return String(n)
  const parts: string[] = []
  const crore = Math.floor(n / 1_00_00_000); if (crore) { parts.push(three(crore) + ' Crore'); n %= 1_00_00_000 }
  const lakh = Math.floor(n / 1_00_000); if (lakh) { parts.push(two(lakh) + ' Lakh'); n %= 1_00_000 }
  const th = Math.floor(n / 1000); if (th) { parts.push(two(th) + ' Thousand'); n %= 1000 }
  const rest = three(n); if (rest) parts.push(rest)
  return parts.join(' ')
}
/** fees.RupeesInWords: Indian lakh/crore grouping, the receipt's tamper check. */
export function rupeesInWords(paise: number): string {
  if (paise < 0) return 'Minus ' + rupeesInWords(-paise)
  const rupees = Math.floor(paise / 100); const rem = paise % 100
  let s = (rupees === 0 ? 'Zero' : indianWords(rupees)) + ' Rupees'
  if (rem > 0) s += ' and ' + indianWords(rem) + ' Paise'
  return s + ' Only'
}

/** fees.FinancialYear: "2026-27" for a YYYY-MM-DD date. */
export function financialYear(on: string): string {
  let y = Number(on.slice(0, 4)); const m = Number(on.slice(5, 7))
  if (m < 4) y--
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`
}

/** invoices.net_paise was GENERATED in Postgres; here it is written whenever its inputs change. */
export const NET_SQL = `net_paise = gross_paise - discount_paise + fine_paise`
export const recomputeNet = (c: Ctx, invoiceId: string): D1PreparedStatement =>
  c.db.prepare(`UPDATE invoices SET ${NET_SQL}, updated_at = ?2 WHERE id = ?1`).bind(invoiceId, now())

/* ------------------------------------------------------------------------- */
/* scope.Resolved.StudentPredicate: TRUE for students.read.all, else the
   union of "enrolled in a section I reach" (taught, class-teacher-of, or my
   department's) and "is me / my child". An empty reach is FALSE, never TRUE. */
export async function studentPredicate(c: Ctx, alias: string): Promise<{ sql: string; args: unknown[] }> {
  if (can(c.id, 'students.read.all')) return { sql: 'TRUE', args: [] }
  const uid = c.id.userId
  const [secs, own] = await Promise.all([
    c.db.prepare(`
      SELECT section_id AS id FROM section_subject_teachers WHERE teacher_user_id = ?1
      UNION SELECT section_id FROM timetable_entries WHERE teacher_user_id = ?1
      UNION SELECT id FROM sections WHERE class_teacher_id = ?1
      UNION SELECT DISTINCT te.section_id FROM timetable_entries te JOIN employees emp ON emp.user_id = te.teacher_user_id
             WHERE emp.department_id IN (SELECT id FROM departments WHERE head_user_id = ?1)`).bind(uid).all<{ id: string }>(),
    ownStudentIds(c),
  ])
  const clauses: string[] = []; const args: unknown[] = []
  const sectionIds = secs.results.map((r) => r.id)
  if (sectionIds.length) {
    clauses.push(`EXISTS (SELECT 1 FROM enrollments se WHERE se.student_id = ${alias}.id AND se.section_id IN (SELECT value FROM json_each(?)))`)
    args.push(JSON.stringify(sectionIds))
  }
  if (own.length) { clauses.push(`${alias}.id IN (SELECT value FROM json_each(?))`); args.push(JSON.stringify(own)) }
  if (!clauses.length) return { sql: 'FALSE', args: [] }
  return { sql: '(' + clauses.join(' OR ') + ')', args }
}

/** Drops keys whose value is null, for structs whose pointer fields carry omitempty. */
export function omitNulls<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}

/** The latest enrolment's class and section names, as the LEFT JOIN LATERAL the Go queries used. */
export const CLASS_SQL = (a = 'st') => `(SELECT c.name FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = ${a}.id ORDER BY e.enrolled_on DESC LIMIT 1)`
export const SECTION_SQL = (a = 'st') => `(SELECT sec.name FROM enrollments e JOIN sections sec ON sec.id = e.section_id WHERE e.student_id = ${a}.id ORDER BY e.enrolled_on DESC LIMIT 1)`
