import type { Router, Ctx } from '../../router'
import { badRequest, notFound, ok } from '../../http'
import { can } from '../../identity'
import { institutionId } from './common'

/* Port of internal/api/metrics.go: GET /metrics and GET /metrics/{key}.
   Every query takes ?1 = from (inclusive) and ?2 = to (exclusive), both
   YYYY-MM-DD in the school's calendar. Timestamp columns (ISO-8601 UTC TEXT)
   are turned into an Indian calendar day with `date(col, '+330 minutes')`,
   the SQLite spelling of `(col AT TIME ZONE 'Asia/Kolkata')::date`. */

type Unit = 'count' | 'paise' | 'percent'
interface Metric { key: string; label: string; hint: string; needs: string; unit: Unit; asOf?: boolean; sql: string }

const ist = (col: string) => `date(${col}, '+330 minutes')`
const inWin = (col: string) => `${ist(col)} >= ?1 AND ${ist(col)} < ?2`

export const METRICS: Metric[] = [
  { key: 'fees.collected', label: 'Fees collected', hint: 'Money received at the counter and online.', needs: 'finance.payments.read', unit: 'paise',
    sql: `SELECT COALESCE(sum(amount_paise),0) AS v FROM payments WHERE status = 'success' AND mode <> 'adjustment' AND paid_on >= ?1 AND paid_on < ?2` },
  { key: 'fees.receipts', label: 'Receipts issued', hint: 'How many payments were taken.', needs: 'finance.payments.read', unit: 'count',
    sql: `SELECT count(*) AS v FROM payments WHERE status = 'success' AND mode <> 'adjustment' AND paid_on >= ?1 AND paid_on < ?2` },
  { key: 'fees.billed', label: 'Fees billed', hint: 'Demands raised, net of concessions.', needs: 'finance.invoices.read', unit: 'paise',
    sql: `SELECT COALESCE(sum(net_paise),0) AS v FROM invoices WHERE status <> 'cancelled' AND status <> 'draft' AND issued_on >= ?1 AND issued_on < ?2` },
  { key: 'fees.outstanding', label: 'Fees outstanding', hint: 'Still owed on bills issued by the end of the period.', needs: 'finance.invoices.read', unit: 'paise', asOf: true,
    sql: `SELECT COALESCE(sum(net_paise - paid_paise),0) AS v FROM invoices WHERE status IN ('unpaid','partial','overdue') AND issued_on < ?2 AND ?1 = ?1` },
  { key: 'fees.bounced', label: 'Cheques bounced', hint: 'Payments that came back.', needs: 'finance.payments.read', unit: 'count',
    sql: `SELECT count(*) AS v FROM payments WHERE status = 'bounced' AND paid_on >= ?1 AND paid_on < ?2` },
  { key: 'fees.refunds', label: 'Refunds processed', hint: 'Money returned to families.', needs: 'finance.payments.read', unit: 'paise',
    sql: `SELECT COALESCE(sum(amount_paise),0) AS v FROM refunds WHERE processed_on IS NOT NULL AND processed_on >= ?1 AND processed_on < ?2` },

  { key: 'admissions.enquiries', label: 'New enquiries', hint: 'Families who asked.', needs: 'admissions.read', unit: 'count',
    sql: `SELECT count(*) AS v FROM enquiries WHERE ${inWin('created_at')}` },
  { key: 'admissions.applications', label: 'Applications', hint: 'Forms filled, at the counter or online.', needs: 'admissions.read', unit: 'count',
    sql: `SELECT count(*) AS v FROM applications WHERE ${inWin('created_at')}` },
  { key: 'admissions.admitted', label: 'Children admitted', hint: 'New students on the roll.', needs: 'students.read', unit: 'count',
    sql: `SELECT count(*) AS v FROM students WHERE admission_date >= ?1 AND admission_date < ?2` },
  { key: 'admissions.lost', label: 'Leads lost', hint: 'Enquiries closed as lost.', needs: 'admissions.read', unit: 'count',
    sql: `SELECT count(*) AS v FROM enquiries WHERE lost_at IS NOT NULL AND ${inWin('lost_at')}` },

  { key: 'attendance.students', label: 'Student attendance', hint: 'Present or late, over the daily register.', needs: 'academics.attendance.read.all', unit: 'percent',
    sql: `SELECT COALESCE(round(100.0 * count(*) FILTER (WHERE status IN ('present','late')) / NULLIF(count(*),0), 1), 0) AS v
            FROM student_attendance WHERE period_id IS NULL AND status NOT IN ('holiday','leave') AND on_date >= ?1 AND on_date < ?2` },
  { key: 'attendance.absences', label: 'Absences', hint: 'Child-days marked absent.', needs: 'academics.attendance.read.all', unit: 'count',
    sql: `SELECT count(*) AS v FROM student_attendance WHERE period_id IS NULL AND status = 'absent' AND on_date >= ?1 AND on_date < ?2` },
  { key: 'attendance.late', label: 'Late arrivals', hint: 'Child-days marked late.', needs: 'academics.attendance.read.all', unit: 'count',
    sql: `SELECT count(*) AS v FROM student_attendance WHERE period_id IS NULL AND status = 'late' AND on_date >= ?1 AND on_date < ?2` },

  { key: 'staff.attendance', label: 'Staff attendance', hint: 'Present, late or half-day, over marked days.', needs: 'hr.employees.read', unit: 'percent',
    sql: `SELECT COALESCE(round(100.0 * count(*) FILTER (WHERE status IN ('present','late','half_day'))
            / NULLIF(count(*) FILTER (WHERE status NOT IN ('holiday','week_off','leave')),0), 1), 0) AS v
            FROM staff_attendance WHERE on_date >= ?1 AND on_date < ?2` },
  { key: 'staff.leave_requests', label: 'Leave requests', hint: 'Applications for leave.', needs: 'hr.employees.read', unit: 'count',
    sql: `SELECT count(*) AS v FROM leave_requests WHERE ${inWin('created_at')}` },
  { key: 'staff.joined', label: 'Staff joined', hint: 'New members of staff.', needs: 'hr.employees.read', unit: 'count',
    sql: `SELECT count(*) AS v FROM employees WHERE joined_on >= ?1 AND joined_on < ?2` },
  { key: 'staff.left', label: 'Staff left', hint: 'Relieved in the period.', needs: 'hr.employees.read', unit: 'count',
    sql: `SELECT count(*) AS v FROM employees WHERE relieved_on IS NOT NULL AND relieved_on >= ?1 AND relieved_on < ?2` },

  { key: 'academics.homework', label: 'Homework set', hint: 'Assignments given.', needs: 'academics.read', unit: 'count',
    sql: `SELECT count(*) AS v FROM homework WHERE assigned_on >= ?1 AND assigned_on < ?2` },
  { key: 'academics.marks_entered', label: 'Marks entered', hint: 'Mark rows saved by teachers.', needs: 'academics.exams.read', unit: 'count',
    sql: `SELECT count(*) AS v FROM marks WHERE ${inWin('entered_at')}` },

  { key: 'comms.sent', label: 'Messages sent', hint: 'SMS, WhatsApp and email that went out.', needs: 'comms.messages.read.all', unit: 'count',
    sql: `SELECT count(*) AS v FROM message_log WHERE status = 'sent' AND sent_at IS NOT NULL AND ${inWin('sent_at')}` },
  { key: 'comms.failed', label: 'Messages failed', hint: 'Sends that did not go.', needs: 'comms.messages.read.all', unit: 'count',
    sql: `SELECT count(*) AS v FROM message_log WHERE status = 'failed' AND ${inWin('queued_at')}` },
  { key: 'comms.tickets', label: 'Concerns raised', hint: 'Grievances and requests from families.', needs: 'office.front_desk.read', unit: 'count',
    sql: `SELECT count(*) AS v FROM support_tickets WHERE audience = 'school' AND ${inWin('created_at')}` },
  { key: 'comms.tickets_resolved', label: 'Concerns resolved', hint: 'Closed with a resolution.', needs: 'office.front_desk.read', unit: 'count',
    sql: `SELECT count(*) AS v FROM support_tickets WHERE audience = 'school' AND resolved_at IS NOT NULL AND ${inWin('resolved_at')}` },

  { key: 'library.loans', label: 'Books issued', hint: 'Loans made.', needs: 'operations.library.read', unit: 'count',
    sql: `SELECT count(*) AS v FROM library_loans WHERE issued_on >= ?1 AND issued_on < ?2` },
  { key: 'library.overdue', label: 'Books overdue', hint: 'Out past their due date at the end of the period.', needs: 'operations.library.read', unit: 'count', asOf: true,
    sql: `SELECT count(*) AS v FROM library_loans WHERE returned_on IS NULL AND due_on < ?2 AND ?1 = ?1` },
  { key: 'transport.trips', label: 'Bus trips', hint: 'Runs started by the fleet.', needs: 'operations.transport.read', unit: 'count',
    sql: `SELECT count(*) AS v FROM vehicle_trips WHERE ${inWin('started_at')}` },
  { key: 'hostel.outpasses', label: 'Outpasses', hint: 'Leave from the hostel requested.', needs: 'operations.hostel.read', unit: 'count',
    sql: `SELECT count(*) AS v FROM hostel_outpasses WHERE ${inWin('expected_out')}` },
]

const BY_KEY = new Map(METRICS.map((m) => [m.key, m]))
const PERIODS = ['today', 'yesterday', 'week', 'month', 'term', 'year', 'all']

interface Win { from: Date; to: Date; prev?: { from: Date; to: Date } }
const DAY = 86_400_000
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d))
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY)

/** windowFor in metrics.go, with dates as UTC-midnight stand-ins for Indian calendar days. */
async function windowFor(c: Ctx, period: string): Promise<Win | null> {
  const ist = new Date(Date.now() + 330 * 60_000)
  const today = utc(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate())
  const tomorrow = addDays(today, 1)
  const prevOf = (from: Date, to: Date) => {
    const n = Math.round((to.getTime() - from.getTime()) / DAY)
    return { from: addDays(from, -n), to: from }
  }
  switch (period) {
    case 'today': return { from: today, to: tomorrow, prev: prevOf(today, tomorrow) }
    case 'yesterday': { const y = addDays(today, -1); return { from: y, to: today, prev: prevOf(y, today) } }
    case 'week': {
      const monday = addDays(today, -((today.getUTCDay() + 6) % 7))
      return { from: monday, to: tomorrow, prev: { from: addDays(monday, -7), to: monday } }
    }
    case 'month': {
      const first = utc(today.getUTCFullYear(), today.getUTCMonth(), 1)
      return { from: first, to: tomorrow, prev: { from: utc(first.getUTCFullYear(), first.getUTCMonth() - 1, 1), to: first } }
    }
    case 'term': case 'year': {
      let row: { starts_on: string; ends_on: string } | null = null
      if (period === 'term') {
        row = await c.db.prepare(`SELECT t.starts_on, t.ends_on FROM terms t
            JOIN academic_years ay ON ay.id = t.academic_year_id AND ay.is_current = 1
           WHERE ? BETWEEN t.starts_on AND t.ends_on ORDER BY t.sequence LIMIT 1`).bind(ymd(today)).first()
      }
      if (!row) row = await c.db.prepare(`SELECT starts_on, ends_on FROM academic_years WHERE is_current = 1 LIMIT 1`).first()
      let starts: Date, ends: Date
      if (row) {
        starts = new Date(String(row.starts_on).slice(0, 10) + 'T00:00:00Z')
        ends = new Date(String(row.ends_on).slice(0, 10) + 'T00:00:00Z')
      } else {
        const y = today.getUTCMonth() < 3 ? today.getUTCFullYear() - 1 : today.getUTCFullYear()
        starts = utc(y, 3, 1); ends = utc(y + 1, 2, 31)
      }
      let to = addDays(ends, 1)
      if (to > tomorrow) to = tomorrow
      return { from: starts, to }
    }
    case 'all': return { from: utc(2000, 0, 1), to: tomorrow }
  }
  return null
}

export function registerMetrics(r: Router): void {
  r.get('/metrics', 'auth', (c) => {
    const items = METRICS.filter((m) => can(c.id, m.needs)).map((m) => ({
      key: m.key, label: m.label, hint: m.hint, unit: m.unit, as_of: !!m.asOf,
      group: m.key.split('.')[0], periods: PERIODS,
    }))
    return ok({ items })
  })

  r.get('/metrics/{key}', 'auth', async (c) => {
    institutionId(c)
    const m = BY_KEY.get(c.params.key)
    if (!m || !can(c.id, m.needs)) throw notFound()
    const period = (c.url.searchParams.get('period') ?? '').trim() || 'month'
    const win = await windowFor(c, period)
    if (!win) throw badRequest('period must be one of ' + PERIODS.join(', '))
    const run = async (from: Date, to: Date) =>
      Number((await c.db.prepare(m.sql).bind(ymd(from), ymd(to)).first<{ v: number }>())?.v ?? 0)
    const value = await run(win.from, win.to)
    const out: Record<string, unknown> = { key: m.key, label: m.label, unit: m.unit, as_of: !!m.asOf,
      period, from: ymd(win.from), to: ymd(win.to), value }
    if (win.prev && !m.asOf) out.previous = await run(win.prev.from, win.prev.to)
    return ok(out)
  })
}
