import type { Router } from '../../router'
import { badRequest, isUUID, notFound, ok } from '../../http'
import { can } from '../../identity'
import { employeeFilter, growthReach } from './reach'
import { todayIST } from '../admissions/util'

/* The tabs of Staff 360 that the detail and overview calls do not carry:
   the register and punches, leave, pay, the week's timetable and open tasks.
   One call, read through the same reach as the timeline: HR and the
   principal see everybody, a head of department their department, anyone
   else their own row. Pay comes back only to someone who holds payroll. */

export function registerStaffRecord(r: Router): void {
  r.get('/hr/employees/{id}/summary', 'hr.employees.read', async (c) => {
    const eid = c.params.id
    if (!isUUID(eid)) throw badRequest('invalid employee id')
    const mine = employeeFilter(await growthReach(c.db, c.id), 'e')
    const emp = await c.db.prepare(`SELECT e.user_id FROM employees e WHERE e.id = ? AND ${mine.sql}`)
      .bind(eid, ...mine.args).first<{ user_id: string | null }>()
    if (!emp) throw notFound('resource not found')
    const uid = emp.user_id
    const year = await c.db.prepare(`SELECT id, starts_on FROM academic_years WHERE is_current = 1 ORDER BY starts_on DESC LIMIT 1`)
      .first<{ id: string; starts_on: string }>()
    const today = todayIST()
    const from = year?.starts_on ?? today.slice(0, 4) + '-04-01'

    const att = uid ? await c.db.prepare(`SELECT COUNT(*) AS marked,
          SUM(CASE WHEN status IN ('present','late','half_day','on_duty') THEN 1 ELSE 0 END) AS present,
          SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent,
          SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late,
          SUM(CASE WHEN status = 'leave' THEN 1 ELSE 0 END) AS on_leave
        FROM staff_attendance WHERE user_id = ? AND on_date BETWEEN ? AND ?`).bind(uid, from, today)
      .first<{ marked: number; present: number | null; absent: number | null; late: number | null; on_leave: number | null }>() : null
    const recent = uid ? (await c.db.prepare(`SELECT on_date, status, check_in, check_out, source, COALESCE(remarks, '') AS remarks
        FROM staff_attendance WHERE user_id = ? AND on_date <= ? ORDER BY on_date DESC LIMIT 30`).bind(uid, today).all()).results : []

    const balances = year ? (await c.db.prepare(`SELECT lt.name AS type, CAST(lb.entitled AS REAL) AS entitled, CAST(lb.taken AS REAL) AS taken
        FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id
       WHERE lb.employee_id = ? AND lb.academic_year_id = ? ORDER BY lt.name`).bind(eid, year.id).all()).results : []
    const requests = (await c.db.prepare(`SELECT l.id, COALESCE(lt.name, l.kind) AS type, l.from_date, l.to_date, CAST(l.days AS TEXT) AS days,
          l.status, l.reason, COALESCE(l.decision_note, '') AS decision_note
        FROM leave_requests l LEFT JOIN leave_types lt ON lt.id = l.leave_type_id
       WHERE l.employee_id = ? ORDER BY l.from_date DESC LIMIT 20`).bind(eid).all()).results

    const pay = can(c.id, 'hr.payroll.read') ? (await c.db.prepare(`SELECT pr.period_year AS year, pr.period_month AS month,
          CAST(ps.paid_days AS TEXT) AS paid_days, CAST(ps.lop_days AS TEXT) AS lop_days, ps.gross_paise, ps.deduction_paise, ps.net_paise,
          pr.published_at IS NOT NULL AS published
        FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
       WHERE ps.employee_id = ? ORDER BY pr.period_year DESC, pr.period_month DESC LIMIT 6`).bind(eid).all()).results : null

    /* The week as the timetable holds it this year, and the school day it is
       laid on: every period of the bell schedules their lessons sit in. */
    const entries = uid && year ? (await c.db.prepare(`SELECT te.weekday, te.period_id, c.name || '-' || sec.name AS class, sub.name AS subject, te.room
        FROM timetable_entries te JOIN sections sec ON sec.id = te.section_id JOIN classes c ON c.id = sec.class_id
        JOIN class_subjects cs ON cs.id = te.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
       WHERE te.teacher_user_id = ? AND te.academic_year_id = ?`).bind(uid, year.id).all()).results : []
    const periods = entries.length ? (await c.db.prepare(`SELECT p.id, p.name, p.starts_at, p.ends_at, p.is_break FROM periods p
       WHERE p.bell_schedule_id IN (SELECT p2.bell_schedule_id FROM timetable_entries te JOIN periods p2 ON p2.id = te.period_id
                                     WHERE te.teacher_user_id = ? AND te.academic_year_id = ?)
       ORDER BY p.sequence`).bind(uid, year!.id).all()).results : []

    const tasks = (await c.db.prepare(`SELECT k.id, k.title, k.due_on, k.priority, k.status,
          COALESCE((SELECT full_name FROM users WHERE id = k.assigned_by), '') AS assigned_by
        FROM staff_tasks k WHERE k.assigned_to = ? AND k.status <> 'done' ORDER BY k.due_on IS NULL, k.due_on LIMIT 20`).bind(eid).all()).results

    return ok({
      attendance: {
        marked: att?.marked ?? 0, present: att?.present ?? 0, absent: att?.absent ?? 0, late: att?.late ?? 0, on_leave: att?.on_leave ?? 0,
        recent,
      },
      leave: { balances, requests },
      pay,
      timetable: { periods, entries },
      tasks,
    })
  })
}
