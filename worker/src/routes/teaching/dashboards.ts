import type { Router, Ctx } from '../../router'
import { ok, badRequest, notFound, clampInt, isUUID } from '../../http'
import { can } from '../../identity'
import {
  resolveScope, marks, js, inList, studentPredicate, resolveRange, rangeJSON,
  todayIST, nowInIndia, weekdayIST, ymd, addDays,
} from './common'

/* Dashboards and roll-ups: the principal's KPIs (role_principal.go), the
   department head's numbers (role_scoped.go, hod_dashboard.go), the teacher's
   day and to-do list (role_scoped.go, faculty_work.go), the teacher's side of
   the parent conversation (teacher_parent_inbox.go) and the class teacher's
   roster roll-up (my_classes.go listStudentProgress). */

// ---------------------------------------------------------------------------
// small helpers the Go side had in other files

const itoa = (n: number): string => String(n)
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
/** Port of pct1: a whole number prints without a decimal. */
const pct1 = (v: number): string => (v === Math.trunc(v) ? `${Math.trunc(v)}%` : `${v.toFixed(1)}%`)
/** Port of indianRupees: 12,34,567. */
function indianRupees(n: number): string {
  const s = String(Math.trunc(n))
  if (s.length <= 3) return s
  let head = s.slice(0, -3)
  const tail = s.slice(-3)
  const parts: string[] = []
  while (head.length > 2) { parts.unshift(head.slice(-2)); head = head.slice(0, -2) }
  if (head !== '') parts.unshift(head)
  return parts.join(',') + ',' + tail
}
/** Postgres isodow: Monday 1 .. Sunday 7, in Indian time. */
const isodowIST = (): number => { const w = weekdayIST(); return w === 0 ? 7 : w }
/** `HH:MI` of a stored time-of-day. */
const hhmm = (t: string | null): string => (t ?? '').slice(0, 5)
/** Go's `DD Mon` of a YYYY-MM-DD. */
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const ddMon = (d: string | null): string => {
  if (!d || d.length < 10) return d ?? ''
  return `${d.slice(8, 10)} ${MON[Number(d.slice(5, 7)) - 1] ?? ''}`
}
/** ISO seconds with a Z, the shape the Go side printed for sent_at/read_at. */
const isoZ = (t: string | null): string | null => {
  if (!t) return null
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return t
  return d.toISOString().slice(0, 19) + 'Z'
}
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))
const scalar = async <T = number>(c: Ctx, sql: string, ...args: (string | number | null)[]): Promise<T | null> => {
  const r = await c.db.prepare(sql).bind(...args).first<{ v: T }>()
  return r ? r.v : null
}

// ---------------------------------------------------------------------------
// principal (role_principal.go)

const APP_STAGES = ['draft', 'submitted', 'under_review', 'documents_pending', 'test_scheduled', 'interviewed', 'waitlisted', 'offered']

async function getPrincipalDashboard(c: Ctx) {
  const rng = resolveRange(c)
  const today = todayIST()
  const CUR_YEAR = `(SELECT id FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1)`
  const [scalars, byStatus, byLeave, byClass, ageing] = await c.db.batch([
    c.db.prepare(`
      SELECT
        (SELECT count(*) FROM students  WHERE status = 'active') AS students,
        (SELECT count(*) FROM employees WHERE status = 'active') AS staff,
        (SELECT count(*) FROM sections) AS sections,
        COALESCE((SELECT ROUND(100.0 * SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) / NULLIF(count(*), 0))
                    FROM student_attendance WHERE on_date = ?1), 0) AS att_today,
        (SELECT count(*) FROM student_attendance WHERE on_date = ?1) AS marked_today,
        (SELECT ROUND(100.0 * SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) / NULLIF(count(*), 0))
           FROM student_attendance WHERE on_date BETWEEN ?2 AND ?3) AS range_pct,
        (SELECT NULLIF(count(*), 0) FROM student_attendance WHERE on_date BETWEEN ?2 AND ?3) AS range_marked,
        COALESCE((SELECT sum(amount_paise) FROM payments
                   WHERE status = 'success' AND mode <> 'adjustment'
                     AND substr(paid_on, 1, 10) BETWEEN ?2 AND ?3), 0) AS collected,
        COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices
                   WHERE status IN ('unpaid','partial','overdue')), 0) AS outstanding,
        (SELECT count(DISTINCT student_id) FROM invoices
          WHERE status IN ('unpaid','partial','overdue') AND due_on IS NOT NULL AND due_on < ?1) AS defaulters,
        (SELECT count(*) FROM leave_requests WHERE status = 'pending') AS pending_leave,
        (SELECT count(*) FROM applications WHERE status NOT IN ('accepted','rejected','withdrawn')) AS open_apps,
        (SELECT count(*) FROM class_subjects cs
          WHERE NOT EXISTS (SELECT 1 FROM section_subject_teachers sst WHERE sst.class_subject_id = cs.id)) AS unassigned,
        COALESCE((SELECT sum(i.net_paise) FROM invoices i WHERE i.status <> 'cancelled' AND i.academic_year_id = ${CUR_YEAR}), 0) AS billed,
        COALESCE((SELECT sum(i.paid_paise) FROM invoices i WHERE i.status <> 'cancelled' AND i.academic_year_id = ${CUR_YEAR}), 0) AS collected_year,
        COALESCE((SELECT sum(i.net_paise - i.paid_paise) FROM invoices i WHERE i.status <> 'cancelled' AND i.academic_year_id = ${CUR_YEAR}), 0) AS outstanding_year,
        (SELECT count(*) FROM invoices i WHERE i.status <> 'cancelled' AND i.academic_year_id = ${CUR_YEAR}) AS year_invoices,
        (SELECT NULLIF(count(*), 0) FROM class_subjects) AS class_subjects_total
    `).bind(today, rng.fromS, rng.toS),
    c.db.prepare(`
      SELECT a.status AS status, count(*) AS applications
        FROM applications a
       WHERE a.status NOT IN ('accepted','rejected','withdrawn')
       GROUP BY a.status`),
    c.db.prepare(`
      SELECT COALESCE(lt.name, 'Not recorded') AS leave_type, lr.subject_kind AS subject_kind,
             d.name AS department, count(*) AS requests, SUM(CAST(lr.days AS REAL)) AS days
        FROM leave_requests lr
        LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
        LEFT JOIN employees e    ON e.id  = lr.employee_id
        LEFT JOIN departments d  ON d.id  = e.department_id
       WHERE lr.status = 'pending'
       GROUP BY lt.name, lr.subject_kind, d.name
       ORDER BY count(*) DESC, 1`),
    c.db.prepare(`
      SELECT c.id AS class_id, COALESCE(c.name, 'Not enrolled') AS class_name, count(*) AS students
        FROM students st
        LEFT JOIN classes c ON c.id = (
            SELECT en.class_id FROM enrollments en
             WHERE en.student_id = st.id AND en.status = 'active'
             ORDER BY en.enrolled_on DESC LIMIT 1)
       WHERE st.status = 'active'
       GROUP BY c.id, c.name, c.level
       ORDER BY c.level IS NULL, c.level, c.name`),
    c.db.prepare(`
      SELECT count(*) AS cnt,
        COALESCE(SUM(CASE WHEN i.due_on > ?1 THEN i.net_paise - i.paid_paise END), 0) AS not_due,
        COALESCE(SUM(CASE WHEN i.due_on IS NOT NULL AND CAST(julianday(?1) - julianday(i.due_on) AS INTEGER) BETWEEN 0 AND 30 THEN i.net_paise - i.paid_paise END), 0) AS d0,
        COALESCE(SUM(CASE WHEN i.due_on IS NOT NULL AND CAST(julianday(?1) - julianday(i.due_on) AS INTEGER) BETWEEN 31 AND 60 THEN i.net_paise - i.paid_paise END), 0) AS d31,
        COALESCE(SUM(CASE WHEN i.due_on IS NOT NULL AND CAST(julianday(?1) - julianday(i.due_on) AS INTEGER) BETWEEN 61 AND 90 THEN i.net_paise - i.paid_paise END), 0) AS d61,
        COALESCE(SUM(CASE WHEN i.due_on IS NOT NULL AND CAST(julianday(?1) - julianday(i.due_on) AS INTEGER) > 90 THEN i.net_paise - i.paid_paise END), 0) AS d90,
        COALESCE(SUM(CASE WHEN i.due_on IS NULL THEN i.net_paise - i.paid_paise END), 0) AS undated
        FROM invoices i WHERE i.status IN ('unpaid','partial','overdue')`).bind(today),
  ])
  const s = scalars.results[0] as Record<string, unknown>
  const k: Record<string, unknown> = {
    students: n(s.students), staff: n(s.staff), sections: n(s.sections),
    attendance_today_pct: n(s.att_today), attendance_marked_today: n(s.marked_today),
  }
  if (s.range_pct !== null && s.range_pct !== undefined) k.attendance_range_pct = n(s.range_pct)
  if (s.range_marked !== null && s.range_marked !== undefined) k.attendance_range_marked = n(s.range_marked)
  k.collected_paise = n(s.collected)
  k.outstanding_paise = n(s.outstanding)
  k.defaulters = n(s.defaulters)
  k.billed_paise = n(s.billed)
  k.collected_year_paise = n(s.collected_year)
  k.outstanding_year_paise = n(s.outstanding_year)
  k.year_invoice_count = n(s.year_invoices)
  k.pending_leave = n(s.pending_leave)
  k.open_applications = n(s.open_apps)
  k.unassigned_subjects = n(s.unassigned)
  if (s.class_subjects_total !== null && s.class_subjects_total !== undefined) k.class_subjects_total = n(s.class_subjects_total)

  const stages = (byStatus.results as { status: string; applications: number }[])
    .sort((a, b) => {
      const ia = APP_STAGES.indexOf(a.status), ib = APP_STAGES.indexOf(b.status)
      // array_position returns NULL for an unknown status, which Postgres sorts last.
      const ka = ia < 0 ? Infinity : ia, kb = ib < 0 ? Infinity : ib
      return ka !== kb ? ka - kb : a.status.localeCompare(b.status)
    })
    .map((r) => ({ status: r.status, applications: n(r.applications) }))
  if (stages.length) k.open_applications_by_status = stages

  const leave = (byLeave.results as Record<string, unknown>[]).map((r) => {
    const o: Record<string, unknown> = { leave_type: r.leave_type, subject_kind: r.subject_kind }
    if (r.department !== null && r.department !== undefined) o.department = r.department
    o.requests = n(r.requests); o.days = n(r.days)
    return o
  })
  if (leave.length) k.pending_leave_by_type = leave

  const roll = (byClass.results as Record<string, unknown>[]).map((r) => {
    const o: Record<string, unknown> = {}
    if (r.class_id !== null && r.class_id !== undefined) o.class_id = r.class_id
    o.class_name = r.class_name; o.students = n(r.students)
    return o
  })
  if (roll.length) k.students_by_class = roll

  const ag = ageing.results[0] as Record<string, unknown> | undefined
  if (ag && n(ag.cnt) > 0) {
    k.outstanding_ageing = {
      not_due_paise: n(ag.not_due), days_0_30_paise: n(ag.d0), days_31_60_paise: n(ag.d31),
      days_61_90_paise: n(ag.d61), days_90_plus_paise: n(ag.d90), undated_paise: n(ag.undated),
    }
  }
  k.range = rangeJSON(rng)
  k.as_of_now = ['attendance_today_pct', 'attendance_marked_today',
    'outstanding_paise', 'defaulters', 'pending_leave',
    'open_applications', 'unassigned_subjects', 'students', 'staff', 'sections',
    'class_subjects_total', 'open_applications_by_status',
    'pending_leave_by_type', 'students_by_class', 'outstanding_ageing']
  return ok(k)
}

async function getAttendanceTrend(c: Ctx) {
  const rows = await c.db.prepare(`
    SELECT on_date AS date,
           SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS present,
           SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent,
           count(*) AS total,
           COALESCE(ROUND(100.0 * SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) / NULLIF(count(*), 0)), 0) AS pct
      FROM student_attendance
     WHERE on_date >= date(?, '-30 days')
     GROUP BY on_date
     ORDER BY on_date`).bind(todayIST()).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((r) => ({ date: r.date, present: n(r.present), absent: n(r.absent), total: n(r.total), pct: n(r.pct) })) })
}

async function getAttendanceShortage(c: Ctx) {
  const threshold = clampInt(c.url.searchParams.get('threshold'), 75, 1, 100)
  const rows = await c.db.prepare(`
    SELECT st.id AS student_id, st.admission_no,
           st.first_name || COALESCE(' ' || st.middle_name, '') || COALESCE(' ' || st.last_name, '') AS full_name,
           COALESCE(c.name, '-') AS class_name, COALESCE(sec.name, '-') AS section_name,
           SUM(CASE WHEN sa.status IN ('present','late') THEN 1 ELSE 0 END) AS present,
           count(*) AS total,
           ROUND(100.0 * SUM(CASE WHEN sa.status IN ('present','late') THEN 1 ELSE 0 END) / NULLIF(count(*), 0)) AS pct
      FROM student_attendance sa
      JOIN academic_years ay ON ay.is_current = 1
      JOIN students st ON st.id = sa.student_id
      LEFT JOIN sections sec ON sec.id = sa.section_id
      LEFT JOIN classes  c   ON c.id = sec.class_id
     WHERE sa.period_id IS NULL
       AND sa.status NOT IN ('holiday','leave')
       AND sa.on_date BETWEEN ay.starts_on AND ay.ends_on
     GROUP BY st.id, c.name, sec.name
    HAVING ROUND(100.0 * SUM(CASE WHEN sa.status IN ('present','late') THEN 1 ELSE 0 END) / NULLIF(count(*), 0)) < ?
     ORDER BY 8`).bind(threshold).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((r) => ({
    student_id: r.student_id, admission_no: r.admission_no, full_name: r.full_name,
    class_name: r.class_name, section_name: r.section_name,
    present: n(r.present), total: n(r.total), pct: n(r.pct),
  })) })
}

async function getStaffWorkload(c: Ctx) {
  const rows = await c.db.prepare(`
    SELECT u.id AS user_id, u.full_name, e.employee_code, d.name AS department,
           (SELECT count(*) FROM timetable_entries te WHERE te.teacher_user_id = u.id) AS periods,
           (SELECT count(DISTINCT cs.subject_id) FROM section_subject_teachers sst
              JOIN class_subjects cs ON cs.id = sst.class_subject_id
             WHERE sst.teacher_user_id = u.id) AS subjects,
           (SELECT count(DISTINCT sst.section_id) FROM section_subject_teachers sst
             WHERE sst.teacher_user_id = u.id) AS sections
      FROM employees e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN departments d ON d.id = e.department_id
     WHERE e.status = 'active'
     ORDER BY 5 DESC, u.full_name`).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((r) => {
    const o: Record<string, unknown> = { user_id: r.user_id, full_name: r.full_name, employee_code: r.employee_code }
    if (r.department !== null) o.department = r.department
    o.weekly_periods = n(r.periods); o.subjects = n(r.subjects); o.sections = n(r.sections)
    return o
  }) })
}

// ---------------------------------------------------------------------------
// department (role_scoped.go)

async function getDeptDashboard(c: Ctx) {
  const s = await resolveScope(c)
  const ids = s.departmentIds
  if (ids.length === 0) return ok({ departments: 0, faculty: 0, students: 0, sections: 0, pending_approvals: 0 })
  const m = marks(ids)
  const r = await c.db.prepare(`
    SELECT
      (SELECT count(*) FROM employees WHERE department_id IN (${m}) AND status = 'active') AS faculty,
      (SELECT count(DISTINCT e.student_id) FROM enrollments e
        WHERE e.section_id IN (
            SELECT DISTINCT te.section_id FROM timetable_entries te
              JOIN employees emp ON emp.user_id = te.teacher_user_id
             WHERE emp.department_id IN (${m}))) AS students,
      (SELECT count(DISTINCT te.section_id) FROM timetable_entries te
         JOIN employees emp ON emp.user_id = te.teacher_user_id
        WHERE emp.department_id IN (${m})) AS sections,
      (SELECT count(*) FROM leave_requests lr
         JOIN employees emp ON emp.id = lr.employee_id
        WHERE lr.status = 'pending' AND emp.department_id IN (${m})) AS pending`)
    .bind(js(ids), js(ids), js(ids), js(ids)).first<Record<string, unknown>>()
  return ok({ departments: ids.length, faculty: n(r?.faculty), students: n(r?.students), sections: n(r?.sections), pending_approvals: n(r?.pending) })
}

async function listDeptFaculty(c: Ctx) {
  const s = await resolveScope(c)
  const f = inList('e.department_id', s.departmentIds)
  const rows = await c.db.prepare(`
    SELECT u.id AS user_id, u.full_name, e.employee_code, d.name AS department, dg.name AS designation,
           (SELECT count(*) FROM timetable_entries te WHERE te.teacher_user_id = u.id) AS periods
      FROM employees e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN departments  d  ON d.id = e.department_id
      LEFT JOIN designations dg ON dg.id = e.designation_id
     WHERE e.status = 'active' AND ${f.sql}`).bind(...f.args).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((r) => {
    const o: Record<string, unknown> = { user_id: r.user_id, full_name: r.full_name, employee_code: r.employee_code }
    if (r.department !== null) o.department = r.department
    if (r.designation !== null) o.designation = r.designation
    o.weekly_periods = n(r.periods)
    return o
  }) })
}

// ---------------------------------------------------------------------------
// teaching: today and my classes (role_scoped.go)

async function listMyClasses(c: Ctx) {
  const s = await resolveScope(c)
  const f = inList('sec.id', s.sectionIds)
  const rows = await c.db.prepare(`
    SELECT sec.id AS section_id, sec.name AS section_name, c.name AS class_name, sec.room,
           (SELECT count(*) FROM enrollments e WHERE e.section_id = sec.id AND e.status = 'active') AS enrolled,
           EXISTS (SELECT 1 FROM student_attendance sa WHERE sa.section_id = sec.id AND sa.on_date = ?) AS marked
      FROM sections sec
      JOIN classes c ON c.id = sec.class_id
     WHERE ${f.sql}
     ORDER BY c.level, sec.name`).bind(todayIST(), ...f.args).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((r) => {
    const o: Record<string, unknown> = { section_id: r.section_id, section_name: r.section_name, class_name: r.class_name }
    if (r.room !== null) o.room = r.room
    o.enrolled = n(r.enrolled); o.marked_today = n(r.marked) === 1
    return o
  }) })
}

async function listTodaysClasses(c: Ctx) {
  // The Go query read the institution's timezone; the Worker resolves "today"
  // in Asia/Kolkata like every other date helper here.
  const rows = await c.db.prepare(`
    SELECT te.id AS entry_id, te.section_id, sec.name AS section_name, c.name AS class_name, sub.name AS subject_name,
           p.name AS period_name, p.starts_at, p.ends_at, te.room,
           EXISTS (SELECT 1 FROM student_attendance sa
                    WHERE sa.section_id = te.section_id AND sa.on_date = ?
                      AND (sa.period_id = te.period_id OR sa.period_id IS NULL)) AS marked
      FROM timetable_entries te
      JOIN sections sec      ON sec.id = te.section_id
      JOIN classes  c        ON c.id = sec.class_id
      JOIN periods  p        ON p.id = te.period_id
      JOIN class_subjects cs ON cs.id = te.class_subject_id
      JOIN subjects sub      ON sub.id = cs.subject_id
     WHERE te.teacher_user_id = ? AND te.weekday = ?
     ORDER BY p.sequence`).bind(todayIST(), c.id.userId, isodowIST()).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((r) => {
    const o: Record<string, unknown> = {
      entry_id: r.entry_id, section_id: r.section_id, section_name: r.section_name, class_name: r.class_name,
      subject_name: r.subject_name, period_name: r.period_name,
      starts_at: hhmm(r.starts_at as string | null), ends_at: hhmm(r.ends_at as string | null),
    }
    if (r.room !== null) o.room = r.room
    o.attendance_marked = n(r.marked) === 1
    return o
  }) })
}

// ---------------------------------------------------------------------------
// teaching: my work (faculty_work.go)

interface WorkItem { kind: string; title: string; detail: string; count: number; due?: string; overdue: boolean; link?: string }

async function getMyWork(c: Ctx) {
  const s = await resolveScope(c)
  const sections = s.sectionIds
  const items: WorkItem[] = []
  const today = todayIST()
  const nowIso = new Date().toISOString()
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString()
  const fortnightAgo = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const u = c.id.userId

  // 1. Homework handed in and not yet marked.
  if (sections.length > 0) {
    const r = await c.db.prepare(`
      SELECT count(*) AS pending,
             SUM(CASE WHEN hs.submitted_at < ? THEN 1 ELSE 0 END) AS overdue
        FROM homework_submissions hs
        JOIN homework h ON h.id = hs.homework_id
       WHERE h.section_id IN (${marks(sections)})
         AND hs.status = 'submitted' AND hs.graded_at IS NULL`)
      .bind(threeDaysAgo, js(sections)).first<{ pending: number; overdue: number | null }>()
    const pending = n(r?.pending), overdue = n(r?.overdue)
    if (pending > 0) {
      items.push({
        kind: 'submissions', count: pending,
        title: plural(pending, 'submission', 'submissions') + ' to mark',
        detail: overdue > 0 ? itoa(overdue) + ' handed in more than three days ago' : 'All handed in within the last three days',
        overdue: overdue > 0,
      })
    }
  }

  // 2. Papers where marks are missing.
  if (sections.length > 0) {
    const rows = await c.db.prepare(`
      SELECT ex.name AS exam, sub.name AS subject, c.name || '-' || sec.name AS class,
             count(DISTINCT e.student_id) AS expected,
             count(DISTINCT m.student_id) AS entered,
             ex.ends_on AS due,
             (ex.ends_on IS NOT NULL AND ex.ends_on < ?) AS late
        FROM exam_subjects es
        JOIN exams          ex ON ex.id = es.exam_id
        JOIN class_subjects cs ON cs.id = es.class_subject_id
        JOIN subjects      sub ON sub.id = cs.subject_id
        JOIN classes         c ON c.id = cs.class_id
        JOIN sections      sec ON sec.class_id = c.id
        JOIN enrollments     e ON e.section_id = sec.id AND e.status = 'active'
        LEFT JOIN marks      m ON m.exam_subject_id = es.id AND m.student_id = e.student_id
       WHERE sec.id IN (${marks(sections)})
         AND EXISTS (SELECT 1 FROM section_subject_teachers t
                      WHERE t.section_id = sec.id AND t.class_subject_id = cs.id AND t.teacher_user_id = ?)
       GROUP BY ex.name, sub.name, c.name, sec.name, ex.ends_on
      HAVING count(DISTINCT m.student_id) < count(DISTINCT e.student_id)
       ORDER BY ex.ends_on IS NULL, ex.ends_on
       LIMIT 100`).bind(today, js(sections), u).all<Record<string, unknown>>()
    for (const r of rows.results) {
      const expected = n(r.expected), entered = n(r.entered)
      const it: WorkItem = {
        kind: 'marks', count: expected - entered,
        title: 'Enter marks - ' + r.class + ' ' + r.subject + ', ' + r.exam,
        detail: itoa(entered) + ' of ' + itoa(expected) + ' marks entered',
        overdue: n(r.late) === 1,
      }
      if (r.due !== null) it.due = r.due as string
      items.push(it)
    }
  } else {
    // The Go query ran with an empty array and matched nothing; same here.
  }

  // 3. Cover this teacher has been given.
  const subs = await c.db.prepare(`
    SELECT sb.on_date AS on_date, c.name AS class, sec.name AS section, p.name AS period,
           COALESCE(sb.reason, '') AS reason, (sb.on_date = ?) AS today
      FROM substitutions sb
      JOIN timetable_entries te ON te.id = sb.timetable_entry_id
      JOIN sections sec ON sec.id = te.section_id
      JOIN classes    c ON c.id = sec.class_id
      JOIN periods    p ON p.id = te.period_id
     WHERE sb.substitute_user_id = ? AND sb.on_date >= ?
     ORDER BY sb.on_date, p.sequence
     LIMIT 10`).bind(today, u, today).all<Record<string, string | number>>()
  for (const r of subs.results) {
    let detail = `${r.period}, ${r.class}-${r.section}`
    if (r.reason !== '') detail += ' · ' + r.reason
    items.push({
      kind: 'substitution', count: 1,
      title: `Covering ${r.class}-${r.section}`,
      detail, due: r.on_date as string, overdue: n(r.today) === 1,
    })
  }

  // 4. Leave applied for: every pending one, plus the single latest decision.
  const leave = await c.db.prepare(`
    SELECT status, from_date, to_date, days, reason, created_at FROM (
      SELECT lr.status, lr.from_date, lr.to_date, lr.days, lr.reason, lr.created_at
        FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
       WHERE e.user_id = ?1 AND lr.status = 'pending'
      UNION ALL
      SELECT * FROM (
        SELECT lr.status, lr.from_date, lr.to_date, lr.days, lr.reason, lr.created_at
          FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
         WHERE e.user_id = ?1 AND lr.status <> 'pending' AND lr.decided_at >= ?2
         ORDER BY lr.decided_at DESC LIMIT 1))
     ORDER BY created_at DESC`).bind(u, fortnightAgo).all<Record<string, string>>()
  for (const r of leave.results) {
    const span = ddMon(r.from_date) + ' to ' + ddMon(r.to_date)
    items.push({
      kind: 'leave', count: 1,
      title: 'Leave ' + r.status + ' - ' + span,
      detail: String(r.days) + ' day(s). ' + r.reason,
      overdue: r.status === 'pending',
    })
  }

  // 5. Notices requiring an acknowledgement this teacher has not given.
  const notices = n(await scalar(c, `
    SELECT count(*) AS v FROM announcements a
     WHERE a.requires_ack = 1 AND a.publish_at <= ?1
       AND (a.expires_at IS NULL OR a.expires_at > ?1)
       AND NOT EXISTS (SELECT 1 FROM announcement_acks ack
                        WHERE ack.announcement_id = a.id AND ack.user_id = ?2)`, nowIso, u))
  if (notices > 0) {
    items.push({
      kind: 'announcement', count: notices,
      title: plural(notices, 'notice', 'notices') + ' to acknowledge',
      detail: 'The office is waiting on your confirmation', overdue: false,
    })
  }

  let outstanding = 0
  for (const it of items) if (it.kind !== 'leave' || it.overdue) outstanding += it.count
  return ok({ items, outstanding, sections: sections.length })
}

// ---------------------------------------------------------------------------
// teaching: HOD dashboard (hod_dashboard.go)

async function getHODDashboard(c: Ctx) {
  const s = await resolveScope(c)
  const deptIDs = s.departmentIds
  const sectionIDs = s.sectionIds
  const today = todayIST()
  const dow = isodowIST()
  // `$1::uuid[] IS NULL OR e.department_id = ANY($1)`: no narrowing when the HOD heads nothing.
  const deptPred = deptIDs.length ? `e.department_id IN (${marks(deptIDs)})` : '1'
  const deptArgs = deptIDs.length ? [js(deptIDs)] : []

  const out: Record<string, unknown> = {
    departments: 0, department_names: [] as string[], teachers: 0, sections: sectionIDs.length,
    absent_today: 0, periods_uncovered: 0, registers_not_taken: 0,
    leave_to_decide: 0, subs_to_approve: 0, papers_to_approve: 0, marks_to_moderate: 0,
    absent: [] as { name: string; reason: string; periods: number; uncovered: number }[],
  }

  if (deptIDs.length) {
    const d = await c.db.prepare(`SELECT name FROM departments WHERE id IN (${marks(deptIDs)}) ORDER BY name`)
      .bind(js(deptIDs)).all<{ name: string }>()
    out.departments = d.results.length
    out.department_names = d.results.map((r) => r.name)
  }

  out.teachers = n(await scalar(c, `SELECT count(*) AS v FROM employees e WHERE e.status = 'active' AND ${deptPred}`, ...deptArgs))

  // ?1 today, ?2 isodow, ?3.. the department ids.
  const numbered = deptIDs.length ? 'e.department_id IN (SELECT value FROM json_each(?3))' : '1'
  const absentRows = await c.db.prepare(`
    WITH mine AS (
      SELECT u.id AS user_id, u.full_name
        FROM users u JOIN employees e ON e.user_id = u.id
       WHERE e.status IN ('active','on_leave') AND ${numbered}
    ), absent AS (
      SELECT m.user_id, m.full_name,
             CASE WHEN sa.status IS NOT NULL THEN sa.status ELSE 'leave' END AS reason
        FROM mine m
        LEFT JOIN staff_attendance sa
               ON sa.user_id = m.user_id AND sa.on_date = ?1 AND sa.status IN ('absent','leave')
       WHERE sa.id IS NOT NULL
          OR EXISTS (SELECT 1 FROM leave_requests lr
                       JOIN employees e2 ON e2.id = lr.employee_id
                      WHERE e2.user_id = m.user_id AND lr.status = 'approved'
                        AND ?1 BETWEEN lr.from_date AND lr.to_date)
    )
    SELECT a.full_name AS name, a.reason,
           (SELECT count(*) FROM timetable_entries te
             WHERE te.teacher_user_id = a.user_id AND te.weekday = ?2) AS periods,
           (SELECT count(*) FROM timetable_entries te
             WHERE te.teacher_user_id = a.user_id AND te.weekday = ?2
               AND NOT EXISTS (SELECT 1 FROM substitutions sb
                                WHERE sb.timetable_entry_id = te.id AND sb.on_date = ?1)) AS uncovered
      FROM absent a
     ORDER BY a.full_name`).bind(today, dow, ...(deptIDs.length ? [js(deptIDs)] : [])).all<Record<string, unknown>>()
  const absentees = out.absent as { name: string; reason: string; periods: number; uncovered: number }[]
  for (const r of absentRows.results) {
    const a = { name: r.name as string, reason: r.reason as string, periods: n(r.periods), uncovered: n(r.uncovered) }
    absentees.push(a)
    out.absent_today = n(out.absent_today) + 1
    out.periods_uncovered = n(out.periods_uncovered) + a.uncovered
  }

  if (sectionIDs.length > 0) {
    out.registers_not_taken = n(await scalar(c, `
      SELECT count(*) AS v FROM sections s
       WHERE s.id IN (${marks(sectionIDs)})
         AND NOT EXISTS (SELECT 1 FROM student_attendance a WHERE a.section_id = s.id AND a.on_date = ?)`,
      js(sectionIDs), today))
  }

  if (can(c.id, 'hr.leave.approve')) {
    out.leave_to_decide = n(await scalar(c, `SELECT count(*) AS v FROM leave_requests lr WHERE lr.status = 'pending' AND lr.subject_kind = 'staff'`))
  }
  out.subs_to_approve = n(await scalar(c, `SELECT count(*) AS v FROM substitution_requests sr WHERE sr.status = 'pending'`))
  out.papers_to_approve = n(await scalar(c, `SELECT count(*) AS v FROM question_papers qp WHERE qp.status = 'submitted'`))
  out.marks_to_moderate = n(await scalar(c, `
    SELECT count(*) AS v FROM exam_subjects es
     WHERE EXISTS (SELECT 1 FROM marks m WHERE m.exam_subject_id = es.id)
       AND NOT EXISTS (SELECT 1 FROM mark_moderations mm WHERE mm.exam_subject_id = es.id)`))
  return ok(out)
}

// ---------------------------------------------------------------------------
// teaching: the parent conversation, teacher's side (teacher_parent_inbox.go)

async function mayReadTeachersThreads(c: Ctx, teacher: string): Promise<boolean> {
  const s = await resolveScope(c)
  if (s.departmentIds.length === 0) return true
  const v = await scalar(c, `
    SELECT EXISTS (SELECT 1 FROM employees emp
                    WHERE emp.user_id = ? AND emp.department_id IN (${marks(s.departmentIds)})) AS v`,
    teacher, js(s.departmentIds))
  return n(v) === 1
}

async function listTeacherParentThreads(c: Ctx) {
  const me = c.id.userId
  let whose = 'm.teacher_user_id = ?'
  const args: string[] = [me]
  if (can(c.id, 'comms.messages.read.all')) {
    const s = await resolveScope(c)
    if (s.departmentIds.length > 0) {
      whose = `m.teacher_user_id IN (SELECT emp.user_id FROM employees emp
                 WHERE emp.department_id IN (${marks(s.departmentIds)}) AND emp.user_id IS NOT NULL)`
      args.splice(0, 1, js(s.departmentIds))
    } else {
      whose = '1'
      args.length = 0
    }
  }
  const rows = await c.db.prepare(`
    SELECT * FROM (
      SELECT m.student_id,
             st.first_name || COALESCE(' ' || st.last_name, '') AS student_name,
             COALESCE(c.name, '') || COALESCE('-' || sec.name, '') AS class_name,
             m.parent_user_id, pu.full_name AS parent_name,
             m.body AS last_message, m.sent_at AS last_at,
             m.teacher_user_id, tu.full_name AS teacher_name,
             st.photo_file_id AS student_photo,
             (SELECT count(*) FROM parent_teacher_messages un
               WHERE un.student_id = m.student_id AND un.parent_user_id = m.parent_user_id
                 AND un.teacher_user_id = m.teacher_user_id
                 -- Unread is the FAMILY'S words nobody at the school has read
                 -- (teacher_parent_inbox.go, b0ca2cd4/a76b2839 on main).
                 AND un.sender_user_id = un.parent_user_id AND un.read_at IS NULL) AS unread,
             ROW_NUMBER() OVER (PARTITION BY m.student_id, m.parent_user_id, m.teacher_user_id ORDER BY m.sent_at DESC) AS rn
        FROM parent_teacher_messages m
        JOIN users pu ON pu.id = m.parent_user_id
        LEFT JOIN users tu ON tu.id = m.teacher_user_id
        JOIN students st ON st.id = m.student_id
        LEFT JOIN enrollments en ON en.id = (
            SELECT e.id FROM enrollments e WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
        LEFT JOIN classes c ON c.id = en.class_id
        LEFT JOIN sections sec ON sec.id = en.section_id
       WHERE ${whose})
     WHERE rn = 1
     ORDER BY student_id, parent_user_id, teacher_user_id
     LIMIT 200`).bind(...args).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((r) => {
    const o: Record<string, unknown> = {
      student_id: r.student_id, student_name: r.student_name, class_name: r.class_name,
      parent_user_id: r.parent_user_id, parent_name: r.parent_name,
      last_message: r.last_message, last_at: isoZ(r.last_at as string) ?? '', unread: n(r.unread),
    }
    if (r.student_photo !== null) o.student_photo = r.student_photo
    if (r.teacher_user_id !== null) o.teacher_user_id = r.teacher_user_id
    if (r.teacher_name !== null) o.teacher_name = r.teacher_name
    return o
  }) })
}

interface Attachment { file_id: string; name: string; size_bytes: number; content_type: string; url: string }
function scanAttachments(raw: unknown): Attachment[] {
  if (typeof raw !== 'string' || raw === '') return []
  try { const v = JSON.parse(raw); return Array.isArray(v) ? (v as Attachment[]) : [] } catch { return [] }
}

async function listTeacherParentMessages(c: Ctx) {
  const q = c.url.searchParams
  const sid = (q.get('student_id') ?? '').trim()
  if (!isUUID(sid)) throw badRequest('student_id must be a uuid')
  const parentID = (q.get('parent_user_id') ?? '').trim()
  if (!isUUID(parentID)) throw badRequest('parent_user_id must be a uuid')

  let teacher = c.id.userId
  const asked = (q.get('teacher_user_id') ?? '').trim()
  if (asked !== '' && can(c.id, 'comms.messages.read.all')) {
    if (!isUUID(asked)) throw badRequest('teacher_user_id must be a uuid')
    if (!(await mayReadTeachersThreads(c, asked))) throw notFound()
    teacher = asked
  }
  const before = (q.get('before') ?? '').trim()

  const rows = await c.db.prepare(`
    SELECT m.id,
           CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END AS body,
           m.sent_at, u.full_name AS sender,
           (m.sender_user_id = ?4) AS mine,
           CASE WHEN m.sender_user_id = m.parent_user_id THEN 'parent'
                WHEN m.sender_user_id = m.teacher_user_id THEN 'teacher'
                ELSE COALESCE((SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                                WHERE ur.user_id = m.sender_user_id AND r.key <> 'parent'
                                ORDER BY r.name LIMIT 1), 'school') END AS sender_side,
           m.read_at,
           CASE WHEN m.deleted_at IS NULL THEN m.attachments ELSE NULL END AS attachments,
           m.reply_to_id,
           (SELECT substr(q.body, 1, 120) FROM parent_teacher_messages q WHERE q.id = m.reply_to_id) AS reply_body,
           (SELECT qu.full_name FROM parent_teacher_messages q JOIN users qu ON qu.id = q.sender_user_id
             WHERE q.id = m.reply_to_id) AS reply_sender,
           (m.edited_at IS NOT NULL) AS edited, (m.deleted_at IS NOT NULL) AS deleted
      FROM parent_teacher_messages m
      JOIN users u ON u.id = m.sender_user_id
     WHERE m.student_id = ?1 AND m.parent_user_id = ?2 AND m.teacher_user_id = ?3
       AND (?5 = '' OR m.sent_at < ?5)
     ORDER BY m.sent_at DESC
     LIMIT 41`).bind(sid, parentID, teacher, c.id.userId, before).all<Record<string, unknown>>()

  let items = rows.results.map((r) => {
    const o: Record<string, unknown> = {
      id: r.id, body: r.body, sent_at: isoZ(r.sent_at as string) ?? '', sender_name: r.sender,
      attachments: scanAttachments(r.attachments), mine: n(r.mine) === 1,
    }
    if (r.sender_side !== null && r.sender_side !== '') o.sender_side = r.sender_side
    if (r.read_at !== null) o.read_at = isoZ(r.read_at as string)
    // The cursor is the stored send time at full precision; `before` compares against it directly.
    if (r.sent_at !== null && r.sent_at !== '') o.cursor = r.sent_at
    if (r.reply_to_id !== null) o.reply_to_id = r.reply_to_id
    if (r.reply_body !== null) o.reply_body = r.reply_body
    if (r.reply_sender !== null) o.reply_sender = r.reply_sender
    o.edited = n(r.edited) === 1; o.deleted = n(r.deleted) === 1
    return o
  })
  const more = items.length > 40
  if (more) items = items.slice(0, 40)
  items.reverse()
  const cursor = items.length > 0 ? ((items[0].cursor as string | undefined) ?? '') : ''
  return ok({ items, has_more: more, cursor })
}

// ---------------------------------------------------------------------------
// teaching: student progress (my_classes.go listStudentProgress)

interface ProgressRow {
  student_id: string; admission_no: string; full_name: string; section: string; class_name: string
  attendance_present: number; attendance_marked: number; attendance_percent?: number
  homework_set: number; homework_submitted: number; section_submission_rate?: number
  marks_percent?: number; papers_marked: number
  fees_due_paise: number
  is_cwsn: boolean; cwsn_type?: string; has_support_plan: boolean; notes_of_concern: number; commendations: number
  risks: string[]; risk_band: string
}

function score(v: ProgressRow): void {
  v.risks = []
  if (v.attendance_marked >= 10) {
    const pct = 100 * v.attendance_present / v.attendance_marked
    v.attendance_percent = pct
    if (pct < 75) v.risks.push('Attendance ' + pct1(pct) + ', below the 75% needed to sit the board exam')
  }
  if (v.marks_percent !== undefined && v.marks_percent < 35 && v.papers_marked >= 2) {
    v.risks.push('Averaging ' + pct1(v.marks_percent) + ' across ' + plural(v.papers_marked, 'paper', 'papers'))
  }
  if (v.homework_set >= 4 && v.section_submission_rate !== undefined && v.section_submission_rate >= 0.3) {
    const mine = v.homework_submitted / v.homework_set
    if (mine < v.section_submission_rate / 2) {
      v.risks.push('Turned in ' + itoa(v.homework_submitted) + ' of ' + plural(v.homework_set, 'homework', 'homeworks') +
        ', against ' + pct1(v.section_submission_rate * 100) + ' for the section')
    }
  }
  if (v.notes_of_concern >= 3) v.risks.push(plural(v.notes_of_concern, 'conduct note', 'conduct notes') + ' this year')
  if (v.fees_due_paise > 0) v.risks.push('₹' + indianRupees(Math.trunc(v.fees_due_paise / 100)) + ' outstanding')
  let academic = v.risks.length
  if (v.fees_due_paise > 0) academic--
  v.risk_band = academic >= 2 ? 'at_risk' : academic === 1 ? 'watch' : 'none'
}

async function listStudentProgress(c: Ctx) {
  const s = await resolveScope(c)
  const rng = resolveRange(c)
  const where = studentPredicate(s, 'st')
  const rows = await c.db.prepare(`
    SELECT st.id AS student_id, st.admission_no,
           st.first_name || COALESCE(' ' || st.last_name, '') AS full_name,
           COALESCE(sec.name, '-') AS section, COALESCE(cl.name, '-') AS class_name,
           (SELECT SUM(CASE WHEN sa.status IN ('present','late') THEN 1 ELSE 0 END) FROM student_attendance sa
             WHERE sa.student_id = st.id AND sa.on_date BETWEEN ?1 AND ?2) AS present,
           (SELECT count(*) FROM student_attendance sa
             WHERE sa.student_id = st.id AND sa.on_date BETWEEN ?1 AND ?2) AS marked,
           (SELECT count(*) FROM homework h
             WHERE h.section_id = en.section_id AND h.is_published = 1 AND h.assigned_on BETWEEN ?1 AND ?2) AS set_count,
           (SELECT count(sub.id) FROM homework h
             LEFT JOIN homework_submissions sub ON sub.homework_id = h.id AND sub.student_id = st.id
             WHERE h.section_id = en.section_id AND h.is_published = 1 AND h.assigned_on BETWEEN ?1 AND ?2) AS submitted,
           (SELECT count(*) FROM enrollments e2 WHERE e2.section_id = en.section_id AND e2.status = 'active') AS roll,
           (SELECT count(*) FROM homework_submissions s2 JOIN homework h2 ON h2.id = s2.homework_id
             WHERE h2.section_id = en.section_id AND h2.is_published = 1 AND h2.assigned_on BETWEEN ?1 AND ?2) AS handed_in,
           (SELECT SUM(CAST(m.marks_obtained AS REAL)) FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id
             WHERE m.student_id = st.id AND m.is_absent = 0 AND m.marks_obtained IS NOT NULL) AS obtained,
           (SELECT SUM(CAST(es.max_marks AS REAL)) FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id
             WHERE m.student_id = st.id AND m.is_absent = 0 AND m.marks_obtained IS NOT NULL) AS max_marks,
           (SELECT count(*) FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id
             WHERE m.student_id = st.id AND m.is_absent = 0 AND m.marks_obtained IS NOT NULL) AS papers,
           COALESCE((SELECT sum(i.net_paise - i.paid_paise) FROM invoices i
             WHERE i.student_id = st.id AND i.status NOT IN ('cancelled','paid')), 0) AS due,
           st.is_cwsn, st.cwsn_type,
           EXISTS (SELECT 1 FROM student_support_plans sp WHERE sp.student_id = st.id AND sp.status <> 'closed') AS has_plan,
           (SELECT SUM(CASE WHEN dr.is_positive = 0 THEN 1 ELSE 0 END) FROM discipline_records dr WHERE dr.student_id = st.id) AS concerns,
           (SELECT SUM(CASE WHEN dr.is_positive = 1 THEN 1 ELSE 0 END) FROM discipline_records dr WHERE dr.student_id = st.id) AS commends
      FROM students st
      LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
      LEFT JOIN sections sec ON sec.id = en.section_id
      LEFT JOIN classes cl ON cl.id = sec.class_id
     WHERE st.status = 'active' AND ${where.sql}
     ORDER BY cl.name, sec.name, st.first_name
     LIMIT 600`).bind(rng.fromS, rng.toS, ...where.args).all<Record<string, unknown>>()

  const items = rows.results.map((r) => {
    const v: ProgressRow = {
      student_id: r.student_id as string, admission_no: r.admission_no as string, full_name: r.full_name as string,
      section: r.section as string, class_name: r.class_name as string,
      attendance_present: n(r.present), attendance_marked: n(r.marked),
      homework_set: n(r.set_count), homework_submitted: n(r.submitted),
      papers_marked: n(r.papers), fees_due_paise: n(r.due),
      is_cwsn: n(r.is_cwsn) === 1, has_support_plan: n(r.has_plan) === 1,
      notes_of_concern: n(r.concerns), commendations: n(r.commends),
      risks: [], risk_band: 'none',
    }
    // The section's own rate on the same pieces: handed_in / (set * roll), null when nothing was set or nobody is on the roll.
    const set = n(r.set_count), roll = n(r.roll)
    if (set > 0 && roll > 0) v.section_submission_rate = n(r.handed_in) / (set * roll)
    const max = n(r.max_marks)
    if (max > 0) v.marks_percent = Math.round(100 * n(r.obtained) / max * 10) / 10
    if (r.cwsn_type !== null && r.cwsn_type !== undefined) v.cwsn_type = r.cwsn_type as string
    score(v)
    return v
  })
  return ok({ items })
}

// ---------------------------------------------------------------------------

export function registerDashboards(r: Router): void {
  r.get('/principal/dashboard', 'admin.reports.read', getPrincipalDashboard)
  r.get('/principal/attendance-trend', 'admin.reports.read', getAttendanceTrend)
  r.get('/principal/attendance-shortage', 'admin.reports.read', getAttendanceShortage)
  r.get('/principal/staff-workload', 'admin.reports.read', getStaffWorkload)

  r.get('/department/dashboard', 'hr.employees.read', getDeptDashboard)
  r.get('/department/faculty', 'hr.employees.read', listDeptFaculty)

  r.get('/teaching/today', 'academics.timetable.read', listTodaysClasses)
  r.get('/teaching/my-work', 'academics.timetable.read', getMyWork)
  r.get('/teaching/classes', 'academics.timetable.read', listMyClasses)
  r.get('/teaching/hod-dashboard', 'academics.timetable.read', getHODDashboard)
  r.get('/teaching/parent-messages', 'academics.timetable.read', listTeacherParentThreads)
  r.get('/teaching/parent-messages/thread', 'academics.timetable.read', listTeacherParentMessages)
  r.get('/teaching/progress', 'academics.timetable.read', listStudentProgress)
}
