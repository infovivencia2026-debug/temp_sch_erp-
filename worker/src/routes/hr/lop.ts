import { addDays, parseJSON, round2 } from '../admissions/util'

/* Port of the plpgsql function staff_lop_register (migrations/00244): the
   month's loss of pay per employee, from the attendance register, the leave
   requests that explain a 'leave' mark, each person's shift and the policy.
   Computed in JS because D1 has no stored functions. */

export interface LopRow { absent: number; halves: number; unpaid: number; quotaLop: number; marks: number; lop: number; expected: number }

interface Policy {
  half_day_fraction: number; shift_starts_at: string; grace_minutes: number; late_marks_per_lop_day: number; late_half_day_after_minutes: number | null
  lop_on_absent: boolean; lop_on_unpaid_leave: boolean; lop_on_exhausted_quota: boolean; lop_rounding: string; max_lop_days_per_month: number | null
}

const clockMinutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return (h || 0) * 60 + (m || 0) }
/** Wall-clock minutes in India of a stored UTC timestamp. */
const istMinutesOf = (ts: string) => { const d = new Date(Date.parse(ts) + 330 * 60_000); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const isoDow = (day: string) => { const d = new Date(day + 'T00:00:00Z').getUTCDay(); return d === 0 ? 7 : d }

export async function lopRegister(db: D1Database, inst: string, year: number, month: number): Promise<Map<string, LopRow>> {
  const firstDay = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = addDays(`${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`, -1)
  const daysInMonth = Number(lastDay.slice(8, 10))

  const p = await db.prepare(`SELECT * FROM leave_policy WHERE institution_id = ?`).bind(inst).first<Record<string, unknown>>()
  const pol: Policy = p ? {
    half_day_fraction: Number(p.half_day_fraction), shift_starts_at: String(p.shift_starts_at).slice(0, 5), grace_minutes: Number(p.grace_minutes),
    late_marks_per_lop_day: Number(p.late_marks_per_lop_day), late_half_day_after_minutes: p.late_half_day_after_minutes === null ? null : Number(p.late_half_day_after_minutes),
    lop_on_absent: !!p.lop_on_absent, lop_on_unpaid_leave: !!p.lop_on_unpaid_leave, lop_on_exhausted_quota: !!p.lop_on_exhausted_quota,
    lop_rounding: String(p.lop_rounding), max_lop_days_per_month: p.max_lop_days_per_month === null ? null : Number(p.max_lop_days_per_month),
  } : { half_day_fraction: 0.5, shift_starts_at: '09:00', grace_minutes: 10, late_marks_per_lop_day: 3, late_half_day_after_minutes: null,
    lop_on_absent: true, lop_on_unpaid_leave: true, lop_on_exhausted_quota: true, lop_rounding: 'half', max_lop_days_per_month: null }

  const ay = await db.prepare(`SELECT starts_on FROM academic_years WHERE institution_id = ? AND ? BETWEEN starts_on AND ends_on ORDER BY is_current DESC LIMIT 1`).bind(inst, firstDay).first<{ starts_on: string }>()
  const yearFrom = ay?.starts_on ?? `${year}-01-01`

  // Each person's own hours: their own pattern, then their department's, then the school's default, then the policy.
  const shifts = await db.prepare(`
    SELECT e.id AS eid, e.user_id AS uid,
           COALESCE(p1.starts_at, p2.starts_at, p3.starts_at, ?) AS starts_at,
           COALESCE(p1.grace_minutes, p2.grace_minutes, p3.grace_minutes, ?) AS grace,
           COALESCE(p1.working_days, p2.working_days, p3.working_days, '[1,2,3,4,5,6]') AS working_days
      FROM employees e LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN work_patterns p1 ON p1.id = e.work_pattern_id LEFT JOIN work_patterns p2 ON p2.id = d.work_pattern_id
      LEFT JOIN work_patterns p3 ON p3.institution_id = e.institution_id AND p3.is_default = 1
     WHERE e.institution_id = ?`).bind(pol.shift_starts_at, pol.grace_minutes, inst).all<{ eid: string; uid: string | null; starts_at: string; grace: number; working_days: string }>()
  const byUser = new Map<string, { eid: string; starts: number; grace: number; days: number[] }>()
  for (const s of shifts.results) {
    let days = parseJSON<number[]>(s.working_days, [1, 2, 3, 4, 5, 6])
    if (!Array.isArray(days)) days = String(s.working_days).replace(/[{}[\]]/g, '').split(',').map(Number).filter((n) => n > 0)
    if (s.uid) byUser.set(s.uid, { eid: s.eid, starts: clockMinutes(s.starts_at.slice(0, 5)), grace: s.grace, days })
  }
  const holidays = await db.prepare(`SELECT on_date, COALESCE(to_date, on_date) AS to_date FROM holidays WHERE institution_id = ? AND kind IN ('holiday','vacation') AND applies_to IN ('all','staff') AND on_date <= ? AND COALESCE(to_date, on_date) >= ?`)
    .bind(inst, lastDay, firstDay).all<{ on_date: string; to_date: string }>()
  const isHoliday = (day: string) => holidays.results.some((h) => day >= h.on_date && day <= h.to_date)

  // Approved staff leave covering any day of the year so far, with its type.
  const leaves = await db.prepare(`SELECT r.employee_id, r.from_date, r.to_date, r.is_half_day, r.leave_type_id, lt.is_paid, lt.annual_quota
      FROM leave_requests r LEFT JOIN leave_types lt ON lt.id = r.leave_type_id
     WHERE r.institution_id = ? AND r.subject_kind = 'staff' AND r.status = 'approved' AND r.from_date <= ? AND r.to_date >= ?`).bind(inst, lastDay, yearFrom)
    .all<{ employee_id: string; from_date: string; to_date: string; is_half_day: number; leave_type_id: string | null; is_paid: number | null; annual_quota: string | null }>()
  const leaveFor = (eid: string, day: string) => leaves.results.filter((l) => l.employee_id === eid && day >= l.from_date && day <= l.to_date).sort((a, b) => b.from_date.localeCompare(a.from_date))[0] ?? null
  const balances = await db.prepare(`SELECT employee_id, leave_type_id, entitled FROM leave_balances WHERE institution_id = ? ORDER BY academic_year_id`).bind(inst).all<{ employee_id: string; leave_type_id: string; entitled: string }>()
  const entitledFor = (eid: string, ltid: string) => balances.results.find((b) => b.employee_id === eid && b.leave_type_id === ltid)?.entitled

  const att = await db.prepare(`SELECT sa.user_id, sa.on_date, sa.status, sa.check_in FROM staff_attendance sa WHERE sa.institution_id = ? AND sa.on_date BETWEEN ? AND ? ORDER BY sa.on_date`)
    .bind(inst, yearFrom, lastDay).all<{ user_id: string; on_date: string; status: string; check_in: string | null }>()

  // Running leave per (employee, type) over the year, to find what fell past the quota.
  const cum = new Map<string, number>()
  const excess = new Map<string, number>() // `${eid}|${day}`
  for (const a of att.results) {
    if (a.status !== 'leave') continue
    const sh = byUser.get(a.user_id)
    if (!sh) continue
    const lr = leaveFor(sh.eid, a.on_date)
    if (!lr || !lr.leave_type_id) continue
    const d = lr.is_half_day ? 0.5 : 1
    const key = `${sh.eid}|${lr.leave_type_id}`
    const c = (cum.get(key) ?? 0) + d
    cum.set(key, c)
    const paid = lr.is_paid === null ? true : !!lr.is_paid
    const ent = entitledFor(sh.eid, lr.leave_type_id) ?? lr.annual_quota
    if (paid && ent !== null && ent !== undefined) excess.set(`${sh.eid}|${a.on_date}`, Math.max(0, Math.min(d, c - Number(ent))))
  }

  const tally = new Map<string, { absent: number; halves: number; unpaid: number; quota: number; marks: number; charged: number }>()
  for (const a of att.results) {
    if (a.on_date < firstDay) continue
    const sh = byUser.get(a.user_id)
    if (!sh) continue
    const t = tally.get(sh.eid) ?? { absent: 0, halves: 0, unpaid: 0, quota: 0, marks: 0, charged: 0 }
    const lr = a.status === 'leave' ? leaveFor(sh.eid, a.on_date) : null
    const halfLeave = !!lr?.is_half_day
    const paidLeave = !!(lr && lr.is_paid)
    const quotaExcess = excess.get(`${sh.eid}|${a.on_date}`) ?? 0
    const lateMinutes = a.check_in ? Math.max(0, istMinutesOf(a.check_in) - sh.starts) : null
    const halfAfter = pol.late_half_day_after_minutes
    let charged = 0
    if (a.status === 'absent') charged = pol.lop_on_absent ? 1 : 0
    else if (a.status === 'half_day') charged = pol.half_day_fraction
    else if (a.status === 'leave') {
      if (pol.lop_on_unpaid_leave && !paidLeave) charged = halfLeave ? pol.half_day_fraction : 1
      else if (pol.lop_on_exhausted_quota) charged = quotaExcess
    } else if (halfAfter !== null && (lateMinutes ?? 0) >= halfAfter) charged = pol.half_day_fraction
    let lateMark = 0
    if (['absent', 'half_day', 'leave', 'holiday', 'week_off'].includes(a.status)) lateMark = 0
    else if (halfAfter !== null && (lateMinutes ?? 0) >= halfAfter) lateMark = 0
    else if (a.status === 'late' || (lateMinutes ?? 0) > sh.grace) lateMark = 1
    if (a.status === 'absent') t.absent++
    if (a.status === 'half_day') t.halves++
    if (a.status === 'leave' && !paidLeave) t.unpaid += halfLeave ? 0.5 : 1
    if (a.status === 'leave' && paidLeave) t.quota += quotaExcess
    t.marks += lateMark
    t.charged += charged
    tally.set(sh.eid, t)
  }

  const out = new Map<string, LopRow>()
  for (const [eid, t] of tally) {
    const gross = t.charged + Math.floor(t.marks / pol.late_marks_per_lop_day)
    let v = gross
    if (pol.lop_rounding === 'up') v = Math.ceil(gross)
    else if (pol.lop_rounding === 'half') v = Math.round(gross * 2) / 2
    if (pol.max_lop_days_per_month !== null) v = Math.min(v, pol.max_lop_days_per_month)
    v = Math.min(v, daysInMonth)
    const sh = [...byUser.values()].find((s) => s.eid === eid)
    let expected = 0
    if (sh) for (let d = firstDay; d <= lastDay; d = addDays(d, 1)) if (sh.days.includes(isoDow(d)) && !isHoliday(d)) expected++
    out.set(eid, { absent: t.absent, halves: t.halves, unpaid: t.unpaid, quotaLop: round2(t.quota), marks: t.marks, lop: round2(v), expected })
  }
  return out
}
