import type { Router } from '../../router'
import { ok } from '../../http'
import { platformOnly } from './common'
import { PERM_VENDOR, fleetDbs } from './connectors_common'

/* Port of internal/api/platform_signals.go: dropout risk and cash-flow
   outlook, arithmetic rules run across every school. Go ran one query over
   all tenants; here the same per-school query runs against each school's D1
   and the rows are combined in JS. Dates are UTC, as the Go server's
   CURRENT_DATE was on a UTC host. */

const TH = { attendance_below_pct: 75, attendance_min_days: 5, window_days: 30, fees_overdue_days: 30, signals_for_at_risk: 2 }

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)
const firstOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 1))
/** The billed amount: net_paise, or what the Postgres generated column computed. */
const NET = 'COALESCE(net_paise, gross_paise - discount_paise + fine_paise)'

export function registerPlatformSignals(r: Router): void {
  // getDropoutRisk
  r.get('/admin/signals/dropout-risk', PERM_VENDOR, async (c) => {
    platformOnly(c)
    const today = new Date()
    const attFrom = ymd(addDays(today, -TH.window_days))
    const feeBefore = ymd(addDays(today, -TH.fees_overdue_days))
    type School = { institution_id: string; school: string; students: number; attendance: number; fees: number; marks: number; at_risk: number; all_three: number; coverage: number }
    const schools: School[] = []
    for (const { inst, db } of await fleetDbs(c)) {
      const v = await db.prepare(`
        WITH att AS (
          SELECT student_id, count(*) AS marked, sum(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS present
            FROM student_attendance WHERE on_date > ? AND status NOT IN ('holiday','leave') GROUP BY student_id
        ),
        fee AS (
          SELECT DISTINCT student_id FROM invoices
           WHERE status IN ('unpaid','partial','overdue') AND due_on IS NOT NULL AND due_on < ?
        ),
        ranked AS (
          SELECT m.student_id, e.id AS exam_id,
                 row_number() OVER (PARTITION BY m.student_id ORDER BY COALESCE(e.ends_on, e.starts_on, substr(e.created_at, 1, 10)) DESC) AS rn
            FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id JOIN exams e ON e.id = es.exam_id
           WHERE m.is_absent = 0 AND m.marks_obtained IS NOT NULL
        ),
        mk AS (
          SELECT m.student_id,
                 (sum(CAST(m.marks_obtained AS REAL) + CAST(m.grace_marks AS REAL)) < sum(CAST(es.pass_marks AS REAL))) AS failing
            FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id
            JOIN ranked le ON le.student_id = m.student_id AND le.exam_id = es.exam_id AND le.rn = 1
           WHERE m.is_absent = 0 AND m.marks_obtained IS NOT NULL
           GROUP BY m.student_id
        ),
        per_child AS (
          SELECT st.id, (att.marked IS NOT NULL) AS covered,
                 (att.marked >= ? AND 100.0 * att.present / att.marked < ?) AS a,
                 (fee.student_id IS NOT NULL) AS f,
                 COALESCE(mk.failing, 0) AS k
            FROM students st
            LEFT JOIN att ON att.student_id = st.id
            LEFT JOIN fee ON fee.student_id = st.id
            LEFT JOIN mk ON mk.student_id = st.id
           WHERE st.status = 'active'
        )
        SELECT count(id) AS students,
               sum(CASE WHEN a THEN 1 ELSE 0 END) AS attendance,
               sum(CASE WHEN f THEN 1 ELSE 0 END) AS fees,
               sum(CASE WHEN k THEN 1 ELSE 0 END) AS marks,
               sum(CASE WHEN (a + f + k) >= ? THEN 1 ELSE 0 END) AS at_risk,
               sum(CASE WHEN a AND f AND k THEN 1 ELSE 0 END) AS all_three,
               sum(CASE WHEN covered THEN 1 ELSE 0 END) AS coverage
          FROM per_child`)
        .bind(attFrom, feeBefore, TH.attendance_min_days, TH.attendance_below_pct, TH.signals_for_at_risk)
        .first<Record<string, number | null>>()
      const n = (k: string) => Number(v?.[k] ?? 0)
      schools.push({ institution_id: inst.id, school: inst.name, students: n('students'), attendance: n('attendance'), fees: n('fees'),
        marks: n('marks'), at_risk: n('at_risk'), all_three: n('all_three'), coverage: n('coverage') })
    }
    schools.sort((a, b) => b.at_risk - a.at_risk || a.school.localeCompare(b.school))
    const total: School = { institution_id: '', school: 'All schools', students: 0, attendance: 0, fees: 0, marks: 0, at_risk: 0, all_three: 0, coverage: 0 }
    for (const s of schools) {
      total.students += s.students; total.attendance += s.attendance; total.fees += s.fees; total.marks += s.marks
      total.at_risk += s.at_risk; total.all_three += s.all_three; total.coverage += s.coverage
    }
    return ok({
      as_of: ymd(today), thresholds: TH, schools, total,
      method: 'Rules, not a model. A child is counted once per rule they trip and ' +
        'is at risk on two of three. Names are read inside the school.',
    })
  })

  // getCashFlowOutlook
  r.get('/admin/signals/cash-flow', PERM_VENDOR, async (c) => {
    platformOnly(c)
    const now = new Date()
    const y = now.getUTCFullYear(), m = now.getUTCMonth()
    const months = [1, 2, 3].map((i) => firstOfMonth(y, m + i).toISOString().slice(0, 7))
    const from = ymd(firstOfMonth(y, m + 1)), to = ymd(firstOfMonth(y, m + 4)), basisFrom = ymd(firstOfMonth(y - 1, m))
    const today = ymd(now)
    type Month = { month: string; due_paise: number; expected_paise: number }
    type School = { institution_id: string; school: string; rate_pct: number | null; basis_paise: number; backlog_paise: number; months: Month[]; due_paise: number; expected_paise: number }
    const schools: School[] = []
    for (const { inst, db } of await fleetDbs(c)) {
      const [basis, backlog, due] = await db.batch<Record<string, string | number | null>>([
        db.prepare(`SELECT COALESCE(sum(${NET}), 0) AS billed, COALESCE(sum(paid_paise), 0) AS paid FROM invoices
            WHERE status NOT IN ('draft','cancelled') AND due_on >= ? AND due_on < ?`).bind(basisFrom, from),
        db.prepare(`SELECT COALESCE(sum(${NET} - paid_paise), 0) AS owed FROM invoices
            WHERE status IN ('unpaid','partial','overdue') AND due_on IS NOT NULL AND due_on < ?`).bind(today),
        db.prepare(`SELECT substr(due_on, 1, 7) AS month, sum(${NET} - paid_paise) AS owed FROM invoices
            WHERE status IN ('unpaid','partial','overdue') AND due_on >= ? AND due_on < ? GROUP BY 1`).bind(from, to),
      ])
      const billed = Number(basis.results[0]?.billed ?? 0), paid = Number(basis.results[0]?.paid ?? 0)
      const byMonth = new Map(due.results.map((x) => [String(x.month), Number(x.owed ?? 0)]))
      const v: School = { institution_id: inst.id, school: inst.name, rate_pct: null, basis_paise: billed,
        backlog_paise: Number(backlog.results[0]?.owed ?? 0), months: [], due_paise: 0, expected_paise: 0 }
      let rate = 0
      if (billed > 0) {
        rate = Math.min(1, paid / billed)
        v.rate_pct = Math.floor(rate * 100 + 0.5)
      }
      for (const mo of months) {
        const d = byMonth.get(mo) ?? 0
        const exp = Math.floor(d * rate + 0.5)
        v.months.push({ month: mo, due_paise: d, expected_paise: exp })
        v.due_paise += d; v.expected_paise += exp
      }
      schools.push(v)
    }
    const total: School = { institution_id: '', school: 'All schools', rate_pct: null, basis_paise: 0, backlog_paise: 0,
      months: months.map((mo) => ({ month: mo, due_paise: 0, expected_paise: 0 })), due_paise: 0, expected_paise: 0 }
    let billed = 0, paid = 0
    for (const sc of schools) {
      total.backlog_paise += sc.backlog_paise; total.due_paise += sc.due_paise; total.expected_paise += sc.expected_paise
      total.basis_paise += sc.basis_paise; billed += sc.basis_paise
      if (sc.rate_pct !== null) paid += Math.trunc(sc.basis_paise * sc.rate_pct / 100)
      sc.months.forEach((mo, k) => { total.months[k].due_paise += mo.due_paise; total.months[k].expected_paise += mo.expected_paise })
    }
    if (billed > 0) total.rate_pct = Math.floor(paid / billed * 100 + 0.5)
    return ok({
      as_of: today, months, schools, total,
      method: "Expected = what falls due in the month × the share of the last twelve " +
        "months' demand the school has actually collected. No model.",
    })
  })
}
