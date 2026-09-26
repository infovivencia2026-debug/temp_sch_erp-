import type { Ctx, Router } from '../../router'
import { clampInt, isUUID, ok } from '../../http'
import { can } from '../../identity'
import { nameOf } from '../exams/common'
import { resolveRange, todayIST } from '../admissions/util'
import {
  type Boundary, boundaryLabel, csvResponse, intCell, n, num0, numOrNull, omitNull, pctCell, rollupBoundary, round1, rupeesCell,
  scopePred, strCell, wantsCSV,
} from './common'

/* Port of admin_rollups.go (mountAdminRollups): the administrative roll-ups.
   Nothing here owns data; every figure is an aggregate over tables other
   modules write. Every list answers CSV from the same query (?format=csv). */

const REPORTS = 'admin.reports.read', INVOICES = 'finance.invoices.read', PAYMENTS = 'finance.payments.read', STAFF = 'hr.employees.read'

type Row = Record<string, unknown>

/** rollupRespond: {"items": [...]} or the CSV of the same rows. */
function respond<T>(c: Ctx, name: string, header: string[], items: T[], row: (v: T) => string[]): Response {
  if (!wantsCSV(c)) return ok({ items })
  return csvResponse(name, header, items.map(row))
}

const empName = (a: string) => `TRIM(COALESCE(${a}.first_name,'') || ' ' || COALESCE(${a}.last_name,''))`
const isoDow = (day: string) => { const d = new Date(day + 'T00:00:00Z').getUTCDay(); return d === 0 ? 7 : d }
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** A mark as a percentage of its paper, grace included (the rollups' one definition). */
const score = `(COALESCE(${n('m.marks_obtained')},0) + ${n('m.grace_marks')})`
const pctOfPaper = `100.0 * ${score} / NULLIF(${n('es.max_marks')},0)`
const avgPct = `round(avg(CASE WHEN NOT m.is_absent THEN ${pctOfPaper} END), 1)`
const passPct = `round(100.0 * count(CASE WHEN NOT m.is_absent AND ${score} >= ${n('es.pass_marks')} THEN 1 END)
                 / NULLIF(count(CASE WHEN NOT m.is_absent THEN 1 END), 0), 1)`

/** DISTINCT ON (class_subject_id) ... ORDER BY class_subject_id, department_id: one department per class-subject. */
const csDept = `SELECT sst.class_subject_id, MIN(e.department_id) AS department_id
      FROM section_subject_teachers sst JOIN employees e ON e.user_id = sst.teacher_user_id
     WHERE e.department_id IS NOT NULL GROUP BY sst.class_subject_id`

/** rollupYear: the ?year override, or the current (else latest) academic year. */
async function rollupYear(c: Ctx, override: string): Promise<string> {
  if (isUUID(override)) return override
  const row = await c.db.prepare(`SELECT id FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1`).first<{ id: string }>()
  if (!row) throw new Error('no rows in result set')
  return row.id
}

const dp = (b: Boundary, col: string) => scopePred(b, col, b.depts)
const sp = (b: Boundary, col: string) => scopePred(b, col, b.sections)

export function registerRollups(r: Router) {
  // ---------------------------------------------------------------- 1. today
  r.get('/rollups/today', REPORTS, async (c) => {
    const b = await rollupBoundary(c)
    const day = todayIST()
    const dow = isoDow(day)
    const out = {
      date: day, weekday: WEEKDAYS[new Date(day + 'T00:00:00Z').getUTCDay()], scope: boundaryLabel(b),
      staff_absent: [] as Row[], uncovered_periods: [] as Row[], money: undefined as Row | undefined,
      visitors_expected: [] as Row[], events: [] as Row[], decisions: [] as Row[],
    }
    if (can(c.id, 'hr.employees.read')) {
      const f = dp(b, 'e.department_id')
      const rows = await c.db.prepare(`
        SELECT u.id AS user_id, u.full_name, d.name AS department, sa.status,
               (SELECT count(*) FROM timetable_entries te JOIN periods p ON p.id = te.period_id AND NOT p.is_break
                 WHERE te.teacher_user_id = sa.user_id AND te.weekday = ?2) AS periods,
               (SELECT count(*) FROM timetable_entries te JOIN periods p ON p.id = te.period_id AND NOT p.is_break
                  JOIN substitutions su ON su.timetable_entry_id = te.id AND su.on_date = ?1
                 WHERE te.teacher_user_id = sa.user_id AND te.weekday = ?2) AS covered
          FROM staff_attendance sa
          JOIN users u ON u.id = sa.user_id
          LEFT JOIN employees e ON e.user_id = sa.user_id
          LEFT JOIN departments d ON d.id = e.department_id
         WHERE sa.on_date = ?1 AND sa.status IN ('absent','leave') AND ${f.sql}
         ORDER BY u.full_name`).bind(day, dow, ...f.args).all<Row>()
      out.staff_absent = rows.results.map((v) => omitNull({ user_id: v.user_id, full_name: v.full_name, department: v.department, status: v.status,
        periods_today: num0(v.periods), periods_covered: num0(v.covered), periods_uncovered: num0(v.periods) - num0(v.covered) }))
    }
    {
      const f = sp(b, 'te.section_id')
      const rows = await c.db.prepare(`
        SELECT p.name AS period, SUBSTR(time(p.starts_at),1,5) AS starts_at, c.name AS class_name, sec.name AS section_name, sub.name AS subject,
               CASE WHEN te.teacher_user_id IS NULL THEN 'No teacher assigned' ELSE 'Teacher away, no cover arranged' END AS reason
          FROM timetable_entries te
          JOIN periods p ON p.id = te.period_id AND NOT p.is_break
          JOIN sections sec ON sec.id = te.section_id
          JOIN classes c ON c.id = sec.class_id
          JOIN class_subjects cs ON cs.id = te.class_subject_id
          JOIN subjects sub ON sub.id = cs.subject_id
         WHERE te.weekday = ?2
           AND (te.teacher_user_id IS NULL
                OR (EXISTS (SELECT 1 FROM staff_attendance sa WHERE sa.user_id = te.teacher_user_id AND sa.on_date = ?1 AND sa.status IN ('absent','leave'))
                    AND NOT EXISTS (SELECT 1 FROM substitutions su WHERE su.timetable_entry_id = te.id AND su.on_date = ?1)))
           AND ${f.sql}
         ORDER BY p.sequence, c.level, sec.name`).bind(day, dow, ...f.args).all<Row>()
      out.uncovered_periods = rows.results
    }
    if (can(c.id, INVOICES)) {
      const m = await c.db.prepare(`
        SELECT COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices WHERE due_on = ?1 AND status IN ('unpaid','partial','overdue')), 0) AS due,
               COALESCE((SELECT sum(amount_paise) FROM payments WHERE status = 'success' AND SUBSTR(paid_on,1,10) = ?1 AND mode <> 'adjustment'), 0) AS coll,
               (SELECT count(*) FROM payments WHERE status = 'success' AND SUBSTR(paid_on,1,10) = ?1 AND mode <> 'adjustment') AS receipts,
               COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices WHERE status IN ('unpaid','partial','overdue') AND due_on IS NOT NULL AND due_on < ?1), 0) AS overdue,
               (SELECT count(DISTINCT student_id) FROM invoices WHERE status IN ('unpaid','partial','overdue') AND due_on IS NOT NULL AND due_on < ?1) AS students,
               COALESCE((SELECT sum(amount_paise) FROM payments WHERE status = 'pending' AND mode IN ('cheque','dd')), 0) AS chq`).bind(day).first<Row>()
      out.money = { due_today_paise: num0(m?.due), collected_today_paise: num0(m?.coll), receipts_today: num0(m?.receipts),
        overdue_as_of_today_paise: num0(m?.overdue), overdue_students: num0(m?.students), cheques_awaiting_clearance_paise: num0(m?.chq) }
    }
    const diary = (v: Row) => {
      const o: Row = {}
      if (v.at) o.at = v.at
      o.title = v.title ?? ''
      if (v.with) o.with = v.with
      if (v.kind) o.kind = v.kind
      return o
    }
    const [vis, ev] = await c.db.batch([
      c.db.prepare(`SELECT SUBSTR(time(a.starts_at),1,5) AS at, a.visitor_name AS title, COALESCE(${empName('e')},'') AS "with", a.purpose AS kind
          FROM appointments a LEFT JOIN employees e ON e.id = a.with_employee_id
         WHERE a.on_date = ? AND a.status = 'booked' ORDER BY a.starts_at`).bind(day),
      c.db.prepare(`SELECT at, title, "with", kind FROM (
          SELECT CASE WHEN starts_at IS NULL THEN '' ELSE SUBSTR(time(starts_at),1,5) END AS at, name AS title, COALESCE(venue,'') AS "with", kind
            FROM school_events WHERE is_published = 1 AND ?1 BETWEEN on_date AND COALESCE(ends_on, on_date)
          UNION ALL
          SELECT '', name, '', kind FROM holidays WHERE ?1 BETWEEN on_date AND COALESCE(to_date, on_date))
         ORDER BY 1, 2`).bind(day),
    ])
    out.visitors_expected = (vis.results as Row[]).map(diary)
    out.events = (ev.results as Row[]).map(diary)

    const add = (key: string, label: string, href: string, count: number) => { if (count > 0) out.decisions.push({ key, label, count, href }) }
    const count = async (sql: string, ...args: unknown[]) => num0((await c.db.prepare(sql).bind(...args).first<{ n: number }>())?.n)
    if (can(c.id, 'hr.leave.approve')) {
      add('leave.pending', 'staff leave requests starting within two days', 'approvals',
        await count(`SELECT count(*) AS n FROM leave_requests WHERE status = 'pending' AND subject_kind = 'staff' AND from_date <= date(?, '+2 days')`, day))
    }
    if (can(c.id, 'finance.fees.write')) {
      add('fees.concessions', 'fee concessions awaiting approval', 'approvals', await count(`SELECT count(*) AS n FROM fee_concessions WHERE status = 'pending'`))
    }
    if (can(c.id, 'academics.attendance.write.any')) {
      add('attendance.corrections', 'attendance corrections awaiting review', 'approvals',
        await count(`SELECT count(*) AS n FROM attendance_corrections WHERE status = 'pending'`))
    }
    if (can(c.id, 'admissions.read')) {
      add('admissions.pending', 'admission applications waiting on a decision', 'admissions',
        await count(`SELECT count(*) AS n FROM applications WHERE status IN ('submitted','under_review','test_scheduled','interviewed')`))
    }

    if (wantsCSV(c)) {
      const lines: string[][] = []
      for (const v of out.staff_absent) lines.push(['Staff away', String(v.full_name), strCell(v.department as string | undefined),
        `${v.status}, ${v.periods_uncovered} of ${v.periods_today} periods uncovered`])
      for (const v of out.uncovered_periods) lines.push(['Uncovered period', `${v.period} ${v.starts_at}`, `${v.class_name}-${v.section_name}`, `${v.subject} - ${v.reason}`])
      for (const v of out.visitors_expected) lines.push(['Visitor expected', String(v.at ?? ''), String(v.title ?? ''), String(v.with ?? '')])
      for (const v of out.events) lines.push(['Event', String(v.at ?? ''), String(v.title ?? ''), String(v.kind ?? '')])
      for (const v of out.decisions) lines.push(['Decision', String(v.count), String(v.label), ''])
      return csvResponse('today', ['Item', 'When / Who', 'Where', 'Detail'], lines)
    }
    return ok(omitNull(out))
  })

  // ---------------------------------------------------------------- 2. fees overview
  r.get('/rollups/fees/overview', INVOICES, async (c) => {
    const year = await rollupYear(c, c.url.searchParams.get('year') ?? '')
    const today = todayIST()
    const [yr, tot, cls] = await c.db.batch([
      c.db.prepare(`SELECT name FROM academic_years WHERE id = ?`).bind(year),
      c.db.prepare(`SELECT COALESCE(sum(i.net_paise),0) AS demanded, COALESCE(sum(i.paid_paise),0) AS collected,
          COALESCE(sum(i.net_paise - i.paid_paise),0) AS outstanding, COALESCE(sum(i.discount_paise),0) AS concession,
          COALESCE(sum(i.fine_paise),0) AS fine, count(DISTINCT i.student_id) AS students,
          count(DISTINCT CASE WHEN i.net_paise > i.paid_paise AND i.due_on IS NOT NULL AND i.due_on < ?2 THEN i.student_id END) AS defaulters
          FROM invoices i WHERE i.academic_year_id = ?1 AND i.status <> 'cancelled'`).bind(year, today),
      c.db.prepare(`SELECT c.name AS class_name, count(DISTINCT i.student_id) AS students, COALESCE(sum(i.net_paise),0) AS demanded,
          COALESCE(sum(i.paid_paise),0) AS collected, COALESCE(sum(i.net_paise - i.paid_paise),0) AS outstanding, COALESCE(sum(i.discount_paise),0) AS concession
          FROM invoices i
          JOIN enrollments en ON en.student_id = i.student_id AND en.academic_year_id = i.academic_year_id AND en.status <> 'moved'
          JOIN classes c ON c.id = en.class_id
         WHERE i.academic_year_id = ? AND i.status <> 'cancelled'
         GROUP BY c.id ORDER BY c.level, c.name`).bind(year),
    ])
    const yname = (yr.results[0] as { name?: string } | undefined)?.name
    if (yname === undefined) throw new Error('no rows in result set')
    const t = (tot.results[0] ?? {}) as Row
    const pct = (coll: number, dem: number) => (dem > 0 ? round1(100 * coll / dem) : null)
    const totals = omitNull({ demanded_paise: num0(t.demanded), collected_paise: num0(t.collected), outstanding_paise: num0(t.outstanding),
      concession_paise: num0(t.concession), fine_paise: num0(t.fine), students_billed: num0(t.students), defaulters: num0(t.defaulters),
      collected_pct: pct(num0(t.collected), num0(t.demanded)) })
    const byClass = (cls.results as Row[]).map((v) => omitNull({ class_name: v.class_name, students: num0(v.students), demanded_paise: num0(v.demanded),
      collected_paise: num0(v.collected), outstanding_paise: num0(v.outstanding), concession_paise: num0(v.concession),
      collected_pct: pct(num0(v.collected), num0(v.demanded)) }))
    if (wantsCSV(c)) {
      return csvResponse('fee-overview', ['Class', 'Students', 'Demanded (Rs)', 'Collected (Rs)', 'Outstanding (Rs)', 'Concession (Rs)', 'Collected %'],
        byClass.map((v) => [String(v.class_name), intCell(v.students), rupeesCell(v.demanded_paise), rupeesCell(v.collected_paise),
          rupeesCell(v.outstanding_paise), rupeesCell(v.concession_paise), pctCell(v.collected_pct)]))
    }
    return ok({ academic_year: yname, totals, by_class: byClass })
  })

  r.get('/rollups/fees/ageing', INVOICES, async (c) => {
    const rows = await c.db.prepare(`
      SELECT bucket, count(*) AS invoices, count(DISTINCT student_id) AS students, COALESCE(sum(balance),0) AS amount
        FROM (
          SELECT i.student_id, (i.net_paise - i.paid_paise) AS balance,
                 CASE WHEN i.due_on IS NULL THEN 5 WHEN i.due_on >= ?1 THEN 0
                      WHEN julianday(?1) - julianday(i.due_on) <= 30 THEN 1 WHEN julianday(?1) - julianday(i.due_on) <= 60 THEN 2
                      WHEN julianday(?1) - julianday(i.due_on) <= 90 THEN 3 ELSE 4 END AS ord,
                 CASE WHEN i.due_on IS NULL THEN 'No due date set' WHEN i.due_on >= ?1 THEN 'Not yet due'
                      WHEN julianday(?1) - julianday(i.due_on) <= 30 THEN '1-30 days' WHEN julianday(?1) - julianday(i.due_on) <= 60 THEN '31-60 days'
                      WHEN julianday(?1) - julianday(i.due_on) <= 90 THEN '61-90 days' ELSE 'Over 90 days' END AS bucket
            FROM invoices i WHERE i.status IN ('unpaid','partial','overdue') AND i.net_paise > i.paid_paise)
       GROUP BY bucket, ord ORDER BY ord`).bind(todayIST()).all<Row>()
    const items = rows.results.map((v) => ({ bucket: v.bucket, invoices: num0(v.invoices), students: num0(v.students), amount_paise: num0(v.amount) }))
    return respond(c, 'fee-ageing', ['Bucket', 'Invoices', 'Students', 'Amount (Rs)'], items,
      (v) => [String(v.bucket), intCell(v.invoices), intCell(v.students), rupeesCell(v.amount_paise)])
  })

  r.get('/rollups/fees/concessions', INVOICES, async (c) => {
    const rows = await c.db.prepare(`
      SELECT fc.kind, count(DISTINCT fc.student_id) AS students, count(*) AS awards, count(CASE WHEN fc.status = 'pending' THEN 1 END) AS pending,
             COALESCE(sum(fc.amount_paise), 0) AS granted, count(fc.percent) AS pct_awards
        FROM fee_concessions fc JOIN academic_years ay ON ay.id = fc.academic_year_id
       WHERE fc.academic_year_id = COALESCE((SELECT id FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1), fc.academic_year_id)
       GROUP BY fc.kind ORDER BY granted DESC, fc.kind`).all<Row>()
    const items = rows.results.map((v) => ({ kind: v.kind, students: num0(v.students), awards: num0(v.awards), pending_approval: num0(v.pending),
      granted_amount_paise: num0(v.granted), percent_awards: num0(v.pct_awards) }))
    return respond(c, 'fee-concessions', ['Kind', 'Students', 'Awards', 'Awaiting approval', 'Absolute awards (Rs)', 'Percentage awards'], items,
      (v) => [String(v.kind), intCell(v.students), intCell(v.awards), intCell(v.pending_approval), rupeesCell(v.granted_amount_paise), intCell(v.percent_awards)])
  })

  // ---------------------------------------------------------------- 3. collections
  r.get('/rollups/fees/collections/by-head', PAYMENTS, async (c) => {
    const rng = resolveRange(c.url.searchParams)
    const rows = await c.db.prepare(`
      WITH alloc AS (
          SELECT pa.invoice_id, pa.amount_paise FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
           WHERE p.status = 'success' AND p.mode <> 'adjustment' AND SUBSTR(p.paid_on,1,10) BETWEEN ?1 AND ?2
      ), lines AS (
          SELECT il.invoice_id, il.fee_head_id, (il.amount_paise - il.discount_paise) AS net,
                 sum(il.amount_paise - il.discount_paise) OVER (PARTITION BY il.invoice_id) AS invoice_net
            FROM invoice_lines il
      )
      SELECT fh.name AS fee_head, CAST(ROUND(COALESCE(sum(a.amount_paise * 1.0 * l.net / NULLIF(l.invoice_net,0)), 0)) AS INTEGER) AS amount
        FROM alloc a JOIN lines l ON l.invoice_id = a.invoice_id JOIN fee_heads fh ON fh.id = l.fee_head_id
       GROUP BY fh.id, fh.name ORDER BY amount DESC, fh.name`).bind(rng.from, rng.to).all<Row>()
    const items = rows.results.map((v) => ({ fee_head: v.fee_head, amount_paise: num0(v.amount) }))
    return respond(c, 'fee-collections-by-head', ['Fee head', 'Apportioned collection (Rs)'], items, (v) => [String(v.fee_head), rupeesCell(v.amount_paise)])
  })

  r.get('/rollups/fees/collections/by-collector', PAYMENTS, async (c) => {
    const rng = resolveRange(c.url.searchParams)
    const rows = await c.db.prepare(`
      SELECT COALESCE(u.full_name, 'Unattributed') AS collector, count(*) AS receipts,
             COALESCE(sum(CASE WHEN p.mode = 'cash' THEN p.amount_paise END), 0) AS cash,
             COALESCE(sum(CASE WHEN p.mode <> 'cash' THEN p.amount_paise END), 0) AS other,
             COALESCE(sum(p.amount_paise), 0) AS total, min(p.receipt_no) AS first_receipt, max(p.receipt_no) AS last_receipt
        FROM payments p LEFT JOIN users u ON u.id = p.collected_by
       WHERE p.status = 'success' AND p.mode <> 'adjustment' AND SUBSTR(p.paid_on,1,10) BETWEEN ?1 AND ?2
       GROUP BY u.id, u.full_name ORDER BY total DESC`).bind(rng.from, rng.to).all<Row>()
    const items = rows.results.map((v) => omitNull({ collector: v.collector, receipts: num0(v.receipts), cash_paise: num0(v.cash), other_paise: num0(v.other),
      total_paise: num0(v.total), first_receipt: v.first_receipt, last_receipt: v.last_receipt }))
    return respond(c, 'fee-collections-by-collector', ['Collected by', 'Receipts', 'Cash (Rs)', 'Other modes (Rs)', 'Total (Rs)', 'First receipt', 'Last receipt'],
      items, (v) => [String(v.collector), intCell(v.receipts), rupeesCell(v.cash_paise), rupeesCell(v.other_paise), rupeesCell(v.total_paise),
        strCell(v.first_receipt as string | undefined), strCell(v.last_receipt as string | undefined)])
  })

  r.get('/rollups/fees/collections/tie-out', PAYMENTS, async (c) => {
    const rng = resolveRange(c.url.searchParams)
    const t = await c.db.prepare(`
      SELECT COALESCE((SELECT sum(amount_paise) FROM payments WHERE status='success' AND mode <> 'adjustment' AND SUBSTR(paid_on,1,10) BETWEEN ?1 AND ?2), 0) AS receipts,
             COALESCE((SELECT sum(pa.amount_paise) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                        WHERE p.status='success' AND p.mode <> 'adjustment' AND SUBSTR(p.paid_on,1,10) BETWEEN ?1 AND ?2), 0) AS allocated,
             COALESCE((SELECT sum(amount_paise) FROM payments WHERE status='success' AND mode = 'adjustment' AND SUBSTR(paid_on,1,10) BETWEEN ?1 AND ?2), 0) AS adjustments,
             COALESCE((SELECT sum(amount_paise) FROM refunds WHERE status = 'processed' AND SUBSTR(processed_on,1,10) BETWEEN ?1 AND ?2), 0) AS refunds,
             COALESCE((SELECT sum(amount_paise) FROM payments WHERE status='pending' AND SUBSTR(paid_on,1,10) BETWEEN ?1 AND ?2), 0) AS pending,
             COALESCE((SELECT sum(amount_paise) FROM payments WHERE status='bounced' AND SUBSTR(paid_on,1,10) BETWEEN ?1 AND ?2), 0) AS bounced,
             (SELECT count(*) FROM payments WHERE status='failed' AND SUBSTR(paid_on,1,10) BETWEEN ?1 AND ?2) AS failed,
             (SELECT count(*) FROM payments WHERE status='success' AND receipt_no IS NULL AND SUBSTR(paid_on,1,10) BETWEEN ?1 AND ?2) AS missing`)
      .bind(rng.from, rng.to).first<Row>()
    const receipts = num0(t?.receipts), allocated = num0(t?.allocated)
    return ok({
      range: { label: rng.label, period: rng.period, from: rng.from, to: rng.to },
      receipts_paise: receipts, allocated_paise: allocated, unallocated_paise: receipts - allocated,
      adjustments_paise: num0(t?.adjustments), refunds_paise: num0(t?.refunds), pending_instruments_paise: num0(t?.pending),
      bounced_paise: num0(t?.bounced), failed_count: num0(t?.failed), receipts_without_number: num0(t?.missing),
      note: 'Receipts less allocated is money taken in advance and not yet applied to an invoice. Adjustments, refunds, uncleared instruments ' +
        'and bounced items are excluded from collection and shown separately.',
    })
  })

  // The day book: modes folded into the four columns a school's cash book has.
  r.get('/rollups/fees/collections', PAYMENTS, async (c) => {
    const rng = resolveRange(c.url.searchParams)
    const len = (c.url.searchParams.get('group') ?? '').toLowerCase() === 'month' ? 7 : 10
    const rows = await c.db.prepare(`
      SELECT SUBSTR(p.paid_on,1,${len}) AS bucket,
             count(CASE WHEN p.mode <> 'adjustment' THEN 1 END) AS receipts,
             COALESCE(sum(CASE WHEN p.mode = 'cash' THEN p.amount_paise END), 0) AS cash,
             COALESCE(sum(CASE WHEN p.mode IN ('cheque','dd') THEN p.amount_paise END), 0) AS cheque,
             COALESCE(sum(CASE WHEN p.mode IN ('upi','neft','netbanking','gateway') THEN p.amount_paise END), 0) AS online,
             COALESCE(sum(CASE WHEN p.mode = 'card' THEN p.amount_paise END), 0) AS card,
             COALESCE(sum(CASE WHEN p.mode = 'adjustment' THEN p.amount_paise END), 0) AS adjusted,
             COALESCE(sum(CASE WHEN p.mode <> 'adjustment' THEN p.amount_paise END), 0) AS total
        FROM payments p
       WHERE p.status = 'success' AND SUBSTR(p.paid_on,1,10) BETWEEN ?1 AND ?2
       GROUP BY 1 ORDER BY 1`).bind(rng.from, rng.to).all<Row>()
    const items = rows.results.map((v) => ({ bucket: v.bucket, receipts: num0(v.receipts), cash_paise: num0(v.cash), cheque_paise: num0(v.cheque),
      online_paise: num0(v.online), card_paise: num0(v.card), adjustment_paise: num0(v.adjusted), total_paise: num0(v.total) }))
    return respond(c, 'fee-collections', ['Period', 'Receipts', 'Cash (Rs)', 'Cheque/DD (Rs)', 'Online (Rs)', 'Card (Rs)', 'Adjustments (Rs)', 'Collected (Rs)'],
      items, (v) => [String(v.bucket), intCell(v.receipts), rupeesCell(v.cash_paise), rupeesCell(v.cheque_paise), rupeesCell(v.online_paise),
        rupeesCell(v.card_paise), rupeesCell(v.adjustment_paise), rupeesCell(v.total_paise)])
  })

  // ---------------------------------------------------------------- 4/5. departments
  r.get('/rollups/departments/academics', REPORTS, async (c) => {
    const b = await rollupBoundary(c)
    const f = dp(b, 'd.id')
    const rows = await c.db.prepare(`
      WITH cs_dept AS (${csDept}),
      teach AS (
          SELECT e.department_id, count(DISTINCT cs.subject_id) AS subjects, count(DISTINCT sst.section_id) AS sections
            FROM section_subject_teachers sst JOIN employees e ON e.user_id = sst.teacher_user_id JOIN class_subjects cs ON cs.id = sst.class_subject_id
           WHERE e.department_id IS NOT NULL GROUP BY e.department_id
      ), load AS (
          SELECT e.department_id, count(*) AS periods FROM timetable_entries te JOIN employees e ON e.user_id = te.teacher_user_id
           WHERE e.department_id IS NOT NULL GROUP BY e.department_id
      ), syll AS (
          SELECT cd.department_id, count(*) AS planned,
                 sum(CASE WHEN EXISTS (SELECT 1 FROM lesson_plan_units lpu JOIN lesson_plans lp ON lp.id = lpu.lesson_plan_id
                                        WHERE lpu.syllabus_unit_id = su.id AND lp.delivered_on IS NOT NULL) THEN 1 ELSE 0 END) AS delivered
            FROM cs_dept cd JOIN syllabus_units su ON su.class_subject_id = cd.class_subject_id
           WHERE su.is_active = 1 GROUP BY cd.department_id
      ), perf AS (
          SELECT cd.department_id, ${avgPct} AS avg_pct, ${passPct} AS pass_pct
            FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id JOIN cs_dept cd ON cd.class_subject_id = es.class_subject_id
           GROUP BY cd.department_id
      )
      SELECT d.id AS department_id, d.name, hu.full_name AS head,
             (SELECT count(*) FROM employees e WHERE e.department_id = d.id AND e.status = 'active') AS teachers,
             COALESCE(t.subjects,0) AS subjects, COALESCE(t.sections,0) AS sections, COALESCE(l.periods,0) AS periods,
             COALESCE(sy.planned,0) AS planned, COALESCE(sy.delivered,0) AS delivered, pf.avg_pct, pf.pass_pct
        FROM departments d
        LEFT JOIN users hu ON hu.id = d.head_user_id
        LEFT JOIN teach t ON t.department_id = d.id
        LEFT JOIN load l ON l.department_id = d.id
        LEFT JOIN syll sy ON sy.department_id = d.id
        LEFT JOIN perf pf ON pf.department_id = d.id
       WHERE ${f.sql} ORDER BY d.name`).bind(...f.args).all<Row>()
    const items = rows.results.map((v) => {
      const planned = num0(v.planned), done = num0(v.delivered)
      return omitNull({ department_id: v.department_id, name: v.name, head: v.head, teachers: num0(v.teachers), subjects: num0(v.subjects),
        sections: num0(v.sections), weekly_periods: num0(v.periods), syllabus_units_planned: planned, syllabus_units_delivered: done,
        syllabus_coverage_pct: planned > 0 ? round1(100 * done / planned) : null, avg_score_pct: numOrNull(v.avg_pct), pass_pct: numOrNull(v.pass_pct) })
    })
    return respond(c, 'department-academics', ['Department', 'Head', 'Teachers', 'Subjects', 'Sections', 'Weekly periods', 'Units planned', 'Units delivered',
      'Coverage %', 'Average score %', 'Pass %'], items, (v) => [String(v.name), strCell(v.head as string | undefined), intCell(v.teachers), intCell(v.subjects),
      intCell(v.sections), intCell(v.weekly_periods), intCell(v.syllabus_units_planned), intCell(v.syllabus_units_delivered), pctCell(v.syllabus_coverage_pct),
      pctCell(v.avg_score_pct), pctCell(v.pass_pct)])
  })

  r.get('/rollups/departments/reports', REPORTS, async (c) => {
    const b = await rollupBoundary(c)
    const rng = resolveRange(c.url.searchParams)
    const f = dp(b, 'd.id')
    const rows = await c.db.prepare(`
      WITH cs_dept AS (${csDept}),
      att AS (
          SELECT e.department_id,
                 round(100.0 * count(CASE WHEN sa.status IN ('present','late') THEN 1 END)
                       / NULLIF(count(CASE WHEN sa.status NOT IN ('week_off','holiday') THEN 1 END), 0), 1) AS pct,
                 count(CASE WHEN sa.status = 'absent' THEN 1 END) AS absent_days
            FROM staff_attendance sa JOIN employees e ON e.user_id = sa.user_id
           WHERE sa.on_date BETWEEN ?1 AND ?2 AND e.department_id IS NOT NULL GROUP BY e.department_id
      ), lv AS (
          SELECT e.department_id, sum(CASE WHEN lr.status = 'approved' THEN ${n('lr.days')} END) AS days,
                 count(CASE WHEN lr.status = 'pending' THEN 1 END) AS pending
            FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
           WHERE lr.subject_kind = 'staff' AND lr.from_date <= ?2 AND lr.to_date >= ?1 AND e.department_id IS NOT NULL GROUP BY e.department_id
      ), lp AS (
          SELECT cd.department_id, count(CASE WHEN l.delivered_on IS NOT NULL THEN 1 END) AS delivered, count(CASE WHEN l.delivered_on IS NULL THEN 1 END) AS pending
            FROM lesson_plans l JOIN cs_dept cd ON cd.class_subject_id = l.class_subject_id
           WHERE l.week_of BETWEEN date(?1, '-6 days') AND ?2 GROUP BY cd.department_id
      ), papers AS (
          SELECT cd.department_id, es.id AS exam_subject_id,
                 (SELECT count(*) FROM marks m WHERE m.exam_subject_id = es.id) AS entered,
                 (SELECT count(DISTINCT en.student_id) FROM class_subjects cs JOIN sections sec ON sec.class_id = cs.class_id
                    JOIN enrollments en ON en.section_id = sec.id AND en.status = 'active' WHERE cs.id = es.class_subject_id) AS expected
            FROM exam_subjects es JOIN cs_dept cd ON cd.class_subject_id = es.class_subject_id JOIN exams ex ON ex.id = es.exam_id
           WHERE COALESCE(es.exam_date, ex.starts_on) BETWEEN ?1 AND ?2
      ), mk AS (
          SELECT department_id, COALESCE(sum(entered),0) AS entered, COALESCE(sum(MAX(expected - entered, 0)),0) AS outstanding
            FROM papers GROUP BY department_id
      ), sched AS (
          SELECT e.department_id, count(*) AS periods FROM timetable_entries te JOIN employees e ON e.user_id = te.teacher_user_id
           WHERE e.department_id IS NOT NULL GROUP BY e.department_id
      )
      SELECT d.id AS department_id, d.name,
             (SELECT count(*) FROM employees e WHERE e.department_id = d.id AND e.status = 'active') AS teachers,
             att.pct, COALESCE(att.absent_days,0) AS absent_days, lv.days, COALESCE(sched.periods,0) AS periods,
             COALESCE(lp.delivered,0) AS delivered, COALESCE(lp.pending,0) AS lp_pending,
             COALESCE(mk.entered,0) AS entered, COALESCE(mk.outstanding,0) AS outstanding, COALESCE(lv.pending,0) AS leave_pending
        FROM departments d
        LEFT JOIN att ON att.department_id = d.id
        LEFT JOIN lv ON lv.department_id = d.id
        LEFT JOIN lp ON lp.department_id = d.id
        LEFT JOIN mk ON mk.department_id = d.id
        LEFT JOIN sched ON sched.department_id = d.id
       WHERE ${f.sql} ORDER BY d.name`).bind(rng.from, rng.to, ...f.args).all<Row>()
    const items = rows.results.map((v) => omitNull({ department_id: v.department_id, name: v.name, teachers: num0(v.teachers),
      staff_attendance_pct: numOrNull(v.pct), staff_absent_days: num0(v.absent_days), leave_days_taken: numOrNull(v.days),
      periods_scheduled: num0(v.periods), lessons_delivered: num0(v.delivered), lessons_not_delivered: num0(v.lp_pending),
      marks_entered: num0(v.entered), marks_outstanding: num0(v.outstanding), pending_leave_requests: num0(v.leave_pending) }))
    return respond(c, 'department-reports', ['Department', 'Teachers', 'Staff attendance %', 'Absent days', 'Leave days', 'Weekly periods', 'Lessons delivered',
      'Lessons pending', 'Marks entered', 'Marks outstanding', 'Leave awaiting decision'], items, (v) => [String(v.name), intCell(v.teachers),
      pctCell(v.staff_attendance_pct), intCell(v.staff_absent_days), pctCell(v.leave_days_taken), intCell(v.periods_scheduled), intCell(v.lessons_delivered),
      intCell(v.lessons_not_delivered), intCell(v.marks_entered), intCell(v.marks_outstanding), intCell(v.pending_leave_requests)])
  })

  // ---------------------------------------------------------------- 6. performance
  r.get('/rollups/performance/trend', REPORTS, async (c) => {
    const b = await rollupBoundary(c)
    const f = sp(b, 'sec.id')
    const rows = await c.db.prepare(`
      SELECT ex.id AS exam_id, ex.name AS exam_name, SUBSTR(ex.starts_on,1,10) AS exam_date, c.name AS class_name,
             count(DISTINCT m.student_id) AS students, ${avgPct} AS avg_pct, ${passPct} AS pass_pct
        FROM marks m
        JOIN exam_subjects es ON es.id = m.exam_subject_id
        JOIN exams ex ON ex.id = es.exam_id
        JOIN class_subjects cs ON cs.id = es.class_subject_id
        JOIN classes c ON c.id = cs.class_id
        JOIN enrollments en ON en.student_id = m.student_id AND en.academic_year_id = ex.academic_year_id AND en.status <> 'moved'
        JOIN sections sec ON sec.id = en.section_id AND sec.class_id = c.id
       WHERE ${f.sql}
       GROUP BY ex.id, c.id
       ORDER BY ex.starts_on IS NULL, ex.starts_on, c.level, c.name`).bind(...f.args).all<Row>()
    const items = rows.results.map((v) => omitNull({ exam_id: v.exam_id, exam_name: v.exam_name, exam_date: v.exam_date, class_name: v.class_name,
      students: num0(v.students), avg_pct: numOrNull(v.avg_pct), pass_pct: numOrNull(v.pass_pct) }))
    return respond(c, 'performance-trend', ['Exam', 'Date', 'Class', 'Students', 'Average %', 'Pass %'], items,
      (v) => [String(v.exam_name), strCell(v.exam_date as string | undefined), String(v.class_name), intCell(v.students), pctCell(v.avg_pct), pctCell(v.pass_pct)])
  })

  r.get('/rollups/performance/subjects', REPORTS, async (c) => {
    const b = await rollupBoundary(c)
    const f = dp(b, 'cd.department_id')
    const rows = await c.db.prepare(`
      WITH cd AS (${csDept})
      SELECT sub.name AS subject, sub.code, count(DISTINCT es.id) AS papers, count(DISTINCT m.student_id) AS students,
             ${avgPct} AS avg_pct, ${passPct} AS pass_pct,
             count(CASE WHEN NOT m.is_absent AND ${score} < ${n('es.pass_marks')} THEN 1 END) AS failing,
             round(100.0 * count(CASE WHEN m.is_absent THEN 1 END) / NULLIF(count(*),0), 1) AS absent_pct
        FROM marks m
        JOIN exam_subjects es ON es.id = m.exam_subject_id
        JOIN class_subjects cs ON cs.id = es.class_subject_id
        JOIN subjects sub ON sub.id = cs.subject_id
        LEFT JOIN cd ON cd.class_subject_id = cs.id
       WHERE ${f.sql}
       GROUP BY sub.id ORDER BY avg_pct IS NULL, avg_pct, sub.name`).bind(...f.args).all<Row>()
    const items = rows.results.map((v) => omitNull({ subject: v.subject, code: v.code ?? '', papers: num0(v.papers), students: num0(v.students),
      avg_pct: numOrNull(v.avg_pct), pass_pct: numOrNull(v.pass_pct), failing: num0(v.failing), absent_pct: numOrNull(v.absent_pct) }))
    return respond(c, 'performance-subjects', ['Subject', 'Code', 'Papers', 'Students', 'Average %', 'Pass %', 'Failing', 'Absent %'], items,
      (v) => [String(v.subject), String(v.code), intCell(v.papers), intCell(v.students), pctCell(v.avg_pct), pctCell(v.pass_pct), intCell(v.failing), pctCell(v.absent_pct)])
  })

  r.get('/rollups/performance/distribution', REPORTS, async (c) => {
    const b = await rollupBoundary(c)
    const f = sp(b, 'sec.id')
    const rows = await c.db.prepare(`
      WITH scored AS (
          SELECT m.student_id, ${pctOfPaper} AS pct
            FROM marks m
            JOIN exam_subjects es ON es.id = m.exam_subject_id
            JOIN exams ex ON ex.id = es.exam_id
            JOIN enrollments en ON en.student_id = m.student_id AND en.academic_year_id = ex.academic_year_id AND en.status <> 'moved'
            JOIN sections sec ON sec.id = en.section_id
           WHERE NOT m.is_absent AND ${f.sql}
      ), banded AS (
          SELECT student_id,
                 CASE WHEN pct >= 90 THEN 0 WHEN pct >= 75 THEN 1 WHEN pct >= 60 THEN 2 WHEN pct >= 45 THEN 3 WHEN pct >= 33 THEN 4 ELSE 5 END AS ord,
                 CASE WHEN pct >= 90 THEN '90-100% Distinction' WHEN pct >= 75 THEN '75-89% First' WHEN pct >= 60 THEN '60-74% Second'
                      WHEN pct >= 45 THEN '45-59% Third' WHEN pct >= 33 THEN '33-44% Pass' ELSE 'Below 33% Fail' END AS band
            FROM scored WHERE pct IS NOT NULL
      )
      SELECT band, count(DISTINCT student_id) AS students, count(*) AS marks FROM banded GROUP BY band, ord ORDER BY ord`).bind(...f.args).all<Row>()
    const total = rows.results.reduce((a, v) => a + num0(v.marks), 0)
    const items = rows.results.map((v) => omitNull({ band: v.band, students: num0(v.students), mark_entries: num0(v.marks),
      share_pct: total > 0 ? round1(100 * num0(v.marks) / total) : null }))
    return respond(c, 'performance-distribution', ['Band', 'Students', 'Mark entries', 'Share %'], items,
      (v) => [String(v.band), intCell(v.students), intCell(v.mark_entries), pctCell(v.share_pct)])
  })

  r.get('/rollups/performance/at-risk', REPORTS, async (c) => {
    const b = await rollupBoundary(c)
    const threshold = clampInt(c.url.searchParams.get('threshold'), 40, 1, 100)
    const f = sp(b, 'sec.id')
    const rows = await c.db.prepare(`
      WITH scored AS (
          SELECT m.student_id, en.section_id, ${pctOfPaper} AS pct, (${score} < ${n('es.pass_marks')}) AS failed, cs.subject_id
            FROM marks m
            JOIN exam_subjects es ON es.id = m.exam_subject_id
            JOIN class_subjects cs ON cs.id = es.class_subject_id
            JOIN enrollments en ON en.student_id = m.student_id AND en.status = 'active'
            JOIN sections sec ON sec.id = en.section_id
           WHERE NOT m.is_absent AND ${f.sql}
      ), agg AS (
          SELECT student_id, section_id, count(DISTINCT subject_id) AS subjects,
                 count(DISTINCT CASE WHEN failed THEN subject_id END) AS failing, round(avg(pct), 1) AS avg_pct
            FROM scored GROUP BY student_id, section_id
      )
      SELECT st.id AS student_id, st.admission_no, ${nameOf('st')} AS full_name, COALESCE(c.name,'') AS class_name, COALESCE(sec.name,'') AS section_name,
             a.subjects, a.failing, a.avg_pct,
             (SELECT round(100.0 * count(CASE WHEN sa.status IN ('present','late') THEN 1 END) / NULLIF(count(*),0), 1)
                FROM student_attendance sa WHERE sa.student_id = st.id AND sa.period_id IS NULL) AS attendance_pct
        FROM agg a JOIN students st ON st.id = a.student_id JOIN sections sec ON sec.id = a.section_id JOIN classes c ON c.id = sec.class_id
       WHERE a.avg_pct < ? OR a.failing > 0
       ORDER BY a.failing DESC, a.avg_pct IS NOT NULL, a.avg_pct LIMIT 200`).bind(...f.args, threshold).all<Row>()
    const items = rows.results.map((v) => omitNull({ student_id: v.student_id, admission_no: v.admission_no, full_name: v.full_name, class_name: v.class_name,
      section_name: v.section_name, subjects_assessed: num0(v.subjects), subjects_failing: num0(v.failing), avg_pct: numOrNull(v.avg_pct),
      attendance_pct: numOrNull(v.attendance_pct) }))
    return respond(c, 'performance-at-risk', ['Admission No', 'Student', 'Class', 'Section', 'Subjects assessed', 'Subjects failing', 'Average %', 'Attendance %'],
      items, (v) => [String(v.admission_no), String(v.full_name), String(v.class_name), String(v.section_name), intCell(v.subjects_assessed),
        intCell(v.subjects_failing), pctCell(v.avg_pct), pctCell(v.attendance_pct)])
  })

  // ---------------------------------------------------------------- 7. HR
  r.get('/rollups/hr/headcount', STAFF, async (c) => {
    const b = await rollupBoundary(c)
    const f = dp(b, 'e.department_id')
    const rows = await c.db.prepare(`
      SELECT COALESCE(d.name, 'Unassigned') AS department, count(*) AS total,
             count(CASE WHEN dg.category = 'teaching' THEN 1 END) AS teaching,
             count(CASE WHEN dg.category IS NOT 'teaching' THEN 1 END) AS non_teaching,
             count(CASE WHEN e.employment_type = 'permanent' THEN 1 END) AS permanent,
             count(CASE WHEN e.employment_type = 'contract' THEN 1 END) AS contract,
             count(CASE WHEN e.employment_type = 'probation' THEN 1 END) AS probation,
             count(CASE WHEN e.employment_type IN ('part_time','visiting') THEN 1 END) AS part_time,
             count(CASE WHEN e.gender = 'female' THEN 1 END) AS female,
             count(CASE WHEN e.gender = 'male' THEN 1 END) AS male,
             round(avg(${n('e.experience_years')}), 1) AS avg_exp,
             count(CASE WHEN EXISTS (SELECT 1 FROM staff_qualifications q WHERE q.employee_id = e.id AND q.level IN ('post_graduate','doctorate')) THEN 1 END) AS pg
        FROM employees e
        LEFT JOIN departments d ON d.id = e.department_id
        LEFT JOIN designations dg ON dg.id = e.designation_id
       WHERE e.status = 'active' AND ${f.sql}
       GROUP BY d.id ORDER BY total DESC, department`).bind(...f.args).all<Row>()
    const items = rows.results.map((v) => omitNull({ department: v.department, total: num0(v.total), teaching: num0(v.teaching), non_teaching: num0(v.non_teaching),
      permanent: num0(v.permanent), contract: num0(v.contract), probation: num0(v.probation), part_time: num0(v.part_time), female: num0(v.female),
      male: num0(v.male), avg_experience_years: numOrNull(v.avg_exp), post_graduate_or_above: num0(v.pg) }))
    return respond(c, 'hr-headcount', ['Department', 'Total', 'Teaching', 'Non-teaching', 'Permanent', 'Contract', 'Probation', 'Part-time/visiting', 'Female',
      'Male', 'Average experience (yrs)', 'PG or above'], items, (v) => [String(v.department), intCell(v.total), intCell(v.teaching), intCell(v.non_teaching),
      intCell(v.permanent), intCell(v.contract), intCell(v.probation), intCell(v.part_time), intCell(v.female), intCell(v.male),
      pctCell(v.avg_experience_years), intCell(v.post_graduate_or_above)])
  })

  r.get('/rollups/hr/movement', STAFF, async (c) => {
    const b = await rollupBoundary(c)
    const rng = resolveRange(c.url.searchParams)
    const f = dp(b, 'e.department_id')
    const left = `COALESCE(e.relieved_on, (SELECT se.last_working_day FROM staff_exits se WHERE se.employee_id = e.id ORDER BY se.created_at DESC LIMIT 1))`
    const rows = await c.db.prepare(`
      WITH moves AS (
          SELECT SUBSTR(e.joined_on,1,7) AS m, 1 AS j, 0 AS l FROM employees e WHERE e.joined_on BETWEEN ?1 AND ?2 AND ${f.sql}
          UNION ALL
          SELECT SUBSTR(${left},1,7), 0, 1 FROM employees e WHERE ${left} BETWEEN ?1 AND ?2 AND ${f.sql}
      )
      SELECT m, sum(j) AS joiners, sum(l) AS leavers, sum(j) - sum(l) AS net FROM moves GROUP BY m ORDER BY m`)
      .bind(rng.from, rng.to, ...f.args, ...f.args).all<Row>()
    const items = rows.results.map((v) => ({ month: v.m, joiners: num0(v.joiners), leavers: num0(v.leavers), net: num0(v.net) }))
    return respond(c, 'hr-movement', ['Month', 'Joiners', 'Leavers', 'Net'], items,
      (v) => [String(v.month), intCell(v.joiners), intCell(v.leavers), intCell(v.net)])
  })

  r.get('/rollups/hr/attendance', STAFF, async (c) => {
    const b = await rollupBoundary(c)
    const rng = resolveRange(c.url.searchParams)
    const f = dp(b, 'e.department_id')
    const rows = await c.db.prepare(`
      SELECT e.employee_code, ${empName('e')} AS full_name, d.name AS department,
             count(CASE WHEN sa.status NOT IN ('week_off','holiday') THEN sa.id END) AS marked,
             count(CASE WHEN sa.status IN ('present','late') THEN sa.id END) AS present,
             count(CASE WHEN sa.status = 'absent' THEN sa.id END) AS absent,
             count(CASE WHEN sa.status = 'late' THEN sa.id END) AS late,
             count(CASE WHEN sa.status = 'leave' THEN sa.id END) AS on_leave,
             round(100.0 * count(CASE WHEN sa.status IN ('present','late') THEN sa.id END)
                   / NULLIF(count(CASE WHEN sa.status NOT IN ('week_off','holiday') THEN sa.id END), 0), 1) AS pct,
             (SELECT sum(${n('lb.taken')}) FROM leave_balances lb WHERE lb.employee_id = e.id) AS taken,
             (SELECT sum(${n('lb.entitled')}) FROM leave_balances lb WHERE lb.employee_id = e.id) AS entitled,
             (SELECT count(*) FROM timetable_entries te WHERE te.teacher_user_id = e.user_id) AS weekly
        FROM employees e
        LEFT JOIN departments d ON d.id = e.department_id
        LEFT JOIN staff_attendance sa ON sa.user_id = e.user_id AND sa.on_date BETWEEN ?1 AND ?2
       WHERE e.status = 'active' AND ${f.sql}
       GROUP BY e.id ORDER BY pct IS NULL, pct, e.employee_code`).bind(rng.from, rng.to, ...f.args).all<Row>()
    const items = rows.results.map((v) => omitNull({ employee_code: v.employee_code, full_name: v.full_name, department: v.department,
      days_marked: num0(v.marked), days_present: num0(v.present), days_absent: num0(v.absent), days_late: num0(v.late), days_leave: num0(v.on_leave),
      attendance_pct: numOrNull(v.pct), leave_taken: numOrNull(v.taken), leave_entitled: numOrNull(v.entitled), weekly_periods: num0(v.weekly) }))
    return respond(c, 'hr-attendance', ['Code', 'Name', 'Department', 'Days marked', 'Present', 'Absent', 'Late', 'On leave', 'Attendance %', 'Leave taken',
      'Leave entitled', 'Weekly periods'], items, (v) => [String(v.employee_code), String(v.full_name), strCell(v.department as string | undefined),
      intCell(v.days_marked), intCell(v.days_present), intCell(v.days_absent), intCell(v.days_late), intCell(v.days_leave), pctCell(v.attendance_pct),
      pctCell(v.leave_taken), pctCell(v.leave_entitled), intCell(v.weekly_periods)])
  })

  r.get('/rollups/hr/workload', STAFF, async (c) => {
    const b = await rollupBoundary(c)
    const f = dp(b, 'e.department_id')
    const rows = await c.db.prepare(`
      WITH per_teacher AS (
          SELECT e.id, (SELECT count(*) FROM timetable_entries te WHERE te.teacher_user_id = e.user_id) AS periods
            FROM employees e WHERE e.status = 'active' AND e.user_id IS NOT NULL AND ${f.sql}
      ), banded AS (
          SELECT CASE WHEN periods = 0 THEN 0 WHEN periods <= 10 THEN 1 WHEN periods <= 20 THEN 2 WHEN periods <= 30 THEN 3 ELSE 4 END AS ord,
                 CASE WHEN periods = 0 THEN 'No timetabled periods' WHEN periods <= 10 THEN '1-10 periods' WHEN periods <= 20 THEN '11-20 periods'
                      WHEN periods <= 30 THEN '21-30 periods' ELSE 'Over 30 periods' END AS band
            FROM per_teacher
      )
      SELECT band, count(*) AS teachers FROM banded GROUP BY band, ord ORDER BY ord`).bind(...f.args).all<Row>()
    const total = rows.results.reduce((a, v) => a + num0(v.teachers), 0)
    const items = rows.results.map((v) => omitNull({ band: v.band, teachers: num0(v.teachers), share_pct: total > 0 ? round1(100 * num0(v.teachers) / total) : null }))
    return respond(c, 'hr-workload', ['Weekly load', 'Teachers', 'Share %'], items, (v) => [String(v.band), intCell(v.teachers), pctCell(v.share_pct)])
  })

  r.get('/rollups/hr/expiries', STAFF, async (c) => {
    const b = await rollupBoundary(c)
    const within = clampInt(c.url.searchParams.get('within_days'), 90, 1, 730)
    const f = dp(b, 'e.department_id')
    const today = todayIST()
    const rows = await c.db.prepare(`
      WITH ex AS (
          SELECT t.employee_id, 'Deputation / transfer' AS kind, COALESCE(t.order_no,'-') AS detail, t.effective_to AS expires_on
            FROM staff_transfers t WHERE t.effective_to IS NOT NULL
          UNION ALL
          SELECT se.employee_id, 'Notice served', COALESCE(se.kind,'exit'), se.last_working_day FROM staff_exits se WHERE se.last_working_day IS NOT NULL
          UNION ALL
          SELECT m.employee_id, 'Medical fitness', COALESCE(m.purpose,'-'), m.valid_until FROM medical_fitness_certificates m WHERE m.valid_until IS NOT NULL
          UNION ALL
          SELECT bv.employee_id, 'Background verification', COALESCE(bv.kind,'-'), bv.valid_until FROM background_verifications bv WHERE bv.valid_until IS NOT NULL
          UNION ALL
          SELECT q.employee_id, 'Qualification / registration', COALESCE(q.qualification,'-'), q.valid_until FROM staff_qualifications q WHERE q.valid_until IS NOT NULL
      )
      SELECT e.employee_code, ${empName('e')} AS full_name, d.name AS department, ex.kind, ex.detail, SUBSTR(ex.expires_on,1,10) AS expires_on,
             CAST(julianday(SUBSTR(ex.expires_on,1,10)) - julianday(?1) AS INTEGER) AS days_left
        FROM ex JOIN employees e ON e.id = ex.employee_id LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.status = 'active' AND SUBSTR(ex.expires_on,1,10) <= date(?1, '+' || ?2 || ' days') AND ${f.sql}
       ORDER BY ex.expires_on, e.employee_code`).bind(today, within, ...f.args).all<Row>()
    const items = rows.results.map((v) => omitNull({ employee_code: v.employee_code, full_name: v.full_name, department: v.department, kind: v.kind,
      detail: v.detail, expires_on: v.expires_on, days_left: num0(v.days_left) }))
    return respond(c, 'hr-expiries', ['Code', 'Name', 'Department', 'Renewal', 'Detail', 'Expires on', 'Days left'], items,
      (v) => [String(v.employee_code), String(v.full_name), strCell(v.department as string | undefined), String(v.kind), String(v.detail),
        String(v.expires_on), intCell(v.days_left)])
  })
}
