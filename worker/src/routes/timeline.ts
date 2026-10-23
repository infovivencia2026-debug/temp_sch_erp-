import type { Ctx, Router } from '../router'
import { badRequest, clampInt, isUUID, notFound, ok } from '../http'
import { can } from '../identity'
import { resolveScope, studentPredicate } from './students/common'
import { employeeFilter, growthReach } from './hr/reach'

/* EVERYTHING THAT HAPPENED TO ONE PERSON, NEWEST FIRST (owner, 2026-10-22).

   Student 360 and Staff 360 each answer "what is going on with them" from a
   dozen tables: a concern raised by a parent, a remark, a leave request and
   its decision, an absence, a receipt, a result published. This unions those
   tables into one list of events, read through the same scope the record
   itself is read through: a teacher sees the children they reach, a head of
   department their department, the principal everybody.

   One page is `limit` events. The cursor is the last event's time and id, so
   "Load more" continues exactly where the page stopped even when two events
   share a second. Each source is filtered by subject before the union, so a
   page reads only this person's rows. */

export interface TimelineEvent {
  id: string
  type: string
  at: string
  title: string
  detail: string
  by: string
  link: string | null
  /** School activity only: whether a student, a parent, staff or the system did it. */
  who?: 'student' | 'parent' | 'staff' | 'system'
}

export interface Part { type: string; sql: string; args: unknown[] }

/* What the school-wide list adds: every part also selects actor_id (the user
   who did it), and the page may be narrowed by who, when and by name. */
export interface Narrow { where: string; args: unknown[] }

/* Every part selects the same seven columns in this order:
   id, type, at, title, detail, by, link. `amount` rides along for fee rows
   and is folded into the title here, where Intl can format rupees. */
export const who = (col: string) => `COALESCE((SELECT full_name FROM users WHERE id = ${col}), '')`
export const day = (col: string) => `(${col} || 'T00:00:00.000Z')`

export const STUDENT_TYPES = ['concern', 'remark', 'behaviour', 'leave', 'attendance', 'fee', 'marks', 'notice', 'message'] as const
export const STAFF_TYPES = ['concern', 'remark', 'leave', 'attendance', 'payroll', 'role', 'appraisal', 'task', 'notice'] as const

function studentParts(c: Ctx, sid: string): Part[] {
  const p = (type: string, sql: string, n: number): Part => ({ type, sql, args: Array(n).fill(sid) })
  return [
    p('concern', `
      SELECT 'concern:' || t.id || ':raised' AS id, 'concern' AS type, t.created_at AS at,
             'Concern raised: ' || t.subject AS title, substr(t.body, 1, 160) AS detail, ${who('t.raised_by')} AS actor,
             '/go/parent_concerns?id=' || t.id AS link, NULL AS amount
        FROM support_tickets t WHERE t.student_id = ? AND t.audience = 'school'
      UNION ALL
      SELECT 'concern:' || t.id || ':passed', 'concern', t.escalated_at, 'Concern passed on: ' || t.subject,
             COALESCE('To ' || (SELECT full_name FROM users WHERE id = t.escalated_to), ''), '', '/go/parent_concerns?id=' || t.id, NULL
        FROM support_tickets t WHERE t.student_id = ? AND t.audience = 'school' AND t.escalated_at IS NOT NULL
      UNION ALL
      SELECT 'concern:' || t.id || ':resolved', 'concern', t.resolved_at, 'Concern resolved: ' || t.subject,
             substr(COALESCE(t.resolution, ''), 1, 160), ${who('t.resolved_by')}, '/go/parent_concerns?id=' || t.id, NULL
        FROM support_tickets t WHERE t.student_id = ? AND t.audience = 'school' AND t.resolved_at IS NOT NULL`, 3),
    p('remark', `
      SELECT 'remark:' || r.id, 'remark', r.created_at,
             'Remark (' || r.kind || CASE WHEN r.visible_to_family = 0 THEN ', staff only' ELSE '' END || ')',
             substr(r.body, 1, 160), ${who('r.recorded_by')}, '/go/remarks', NULL
        FROM student_remarks r WHERE r.student_id = ?`, 1),
    p('behaviour', `
      SELECT 'behaviour:' || d.id, 'behaviour', d.created_at,
             CASE WHEN d.is_positive THEN 'Commended: ' ELSE 'Behaviour note: ' END || d.category,
             substr(d.description, 1, 160), ${who('d.recorded_by')}, '/go/behaviour', NULL
        FROM discipline_records d WHERE d.student_id = ?`, 1),
    p('leave', `
      SELECT 'leave:' || l.id || ':asked', 'leave', l.created_at, 'Leave asked: ' || l.from_date || ' to ' || l.to_date,
             substr(l.reason, 1, 160), ${who('l.applied_by')}, '/go/student_leave_requests', NULL
        FROM leave_requests l WHERE l.student_id = ? AND l.subject_kind = 'student'
      UNION ALL
      SELECT 'leave:' || l.id || ':decided', 'leave', l.decided_at, 'Leave ' || l.status || ': ' || l.from_date || ' to ' || l.to_date,
             substr(COALESCE(l.decision_note, ''), 1, 160), ${who('l.decided_by')}, '/go/student_leave_requests', NULL
        FROM leave_requests l WHERE l.student_id = ? AND l.subject_kind = 'student' AND l.decided_at IS NOT NULL`, 2),
    p('attendance', `
      SELECT 'attendance:' || a.id, 'attendance', ${day('a.on_date')},
             CASE a.status WHEN 'absent' THEN 'Absent' ELSE 'Late' END || ' on ' || a.on_date,
             COALESCE(a.remarks, CASE WHEN a.minutes_late THEN a.minutes_late || ' minutes late' ELSE '' END),
             ${who('a.marked_by')}, '/go/attendance/take_attendance', NULL
        FROM student_attendance a WHERE a.student_id = ? AND a.period_id IS NULL AND a.status IN ('absent', 'late')`, 1),
    p('fee', `
      SELECT 'fee:' || f.id, 'fee', f.created_at, 'Fee paid',
             trim(COALESCE('Receipt ' || f.receipt_no, '') || ' · ' || f.mode, ' ·'), ${who('f.collected_by')}, '/go/fee_receipts', f.amount_paise
        FROM payments f WHERE f.student_id = ? AND f.status = 'success'`, 1),
    p('marks', `
      SELECT 'marks:' || ex.id, 'marks', ex.published_at, 'Results published: ' || ex.name, '', ${who('ex.published_by')}, '/go/report_cards', NULL
        FROM exams ex WHERE ex.is_published = 1 AND ex.published_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM exam_subjects es JOIN marks m ON m.exam_subject_id = es.id WHERE es.exam_id = ex.id AND m.student_id = ?)`, 1),
    p('notice', `
      SELECT 'notice:' || an.id, 'notice', an.publish_at, 'Notice: ' || an.title, substr(an.body, 1, 160), ${who('an.created_by')}, '/go/circulars', NULL
        FROM announcements an
       WHERE an.publish_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
         AND (EXISTS (SELECT 1 FROM announcement_students x WHERE x.announcement_id = an.id AND x.student_id = ?)
           OR EXISTS (SELECT 1 FROM announcement_sections x JOIN enrollments en ON en.section_id = x.section_id
                       WHERE x.announcement_id = an.id AND en.student_id = ?))`, 2),
    /* Who wrote to whom, and when; never the words. A family's conversation
       with a teacher is theirs, and this list is read by the whole office. */
    p('message', `
      SELECT 'message:' || m.id, 'message', m.sent_at,
             CASE WHEN m.sender_user_id = m.parent_user_id THEN 'Parent wrote to ' || ${who('m.teacher_user_id')}
                  ELSE ${who('m.sender_user_id')} || ' wrote to the parent' END,
             '', ${who('m.sender_user_id')}, '/go/communication/messages', NULL
        FROM parent_teacher_messages m WHERE m.student_id = ? AND m.deleted_at IS NULL`, 1),
  ]
}

function staffParts(c: Ctx, empId: string, userId: string | null): Part[] {
  const e = (type: string, sql: string, n: number): Part => ({ type, sql, args: Array(n).fill(empId) })
  const u = (type: string, sql: string, n: number): Part | null => (userId ? { type, sql, args: Array(n).fill(userId) } : null)
  const parts: (Part | null)[] = [
    e('concern', `
      SELECT 'concern:' || t.id || ':raised' AS id, 'concern' AS type, t.created_at AS at,
             'Concern about them: ' || t.subject AS title, substr(t.body, 1, 160) AS detail, ${who('t.raised_by')} AS actor,
             '/go/parent_concerns?id=' || t.id AS link, NULL AS amount
        FROM support_tickets t WHERE t.subject_employee_id = ?
      UNION ALL
      SELECT 'concern:' || t.id || ':resolved', 'concern', t.resolved_at, 'Concern resolved: ' || t.subject,
             substr(COALESCE(t.resolution, ''), 1, 160), ${who('t.resolved_by')}, '/go/parent_concerns?id=' || t.id, NULL
        FROM support_tickets t WHERE t.subject_employee_id = ? AND t.resolved_at IS NOT NULL`, 2),
    e('leave', `
      SELECT 'leave:' || l.id || ':asked', 'leave', l.created_at,
             'Leave asked: ' || l.from_date || ' to ' || l.to_date || ' (' || l.days || ' days)',
             substr(l.reason, 1, 160), ${who('l.applied_by')}, '/go/leave/leave', NULL
        FROM leave_requests l WHERE l.employee_id = ?
      UNION ALL
      SELECT 'leave:' || l.id || ':decided', 'leave', l.decided_at, 'Leave ' || l.status || ': ' || l.from_date || ' to ' || l.to_date,
             substr(COALESCE(l.decision_note, ''), 1, 160), ${who('l.decided_by')}, '/go/leave/leave', NULL
        FROM leave_requests l WHERE l.employee_id = ? AND l.decided_at IS NOT NULL`, 2),
    e('attendance', `
      SELECT 'attendance:' || r.id, 'attendance', r.created_at, 'Asked to correct attendance on ' || r.on_date,
             r.status || ' · ' || substr(r.reason, 1, 140), ${who('r.decided_by')}, '/go/staff_attendance_register', NULL
        FROM staff_attendance_requests r WHERE r.employee_id = ?`, 1),
    e('appraisal', `
      SELECT 'appraisal:' || a.id || ':reviewed', 'appraisal', a.reviewed_at, 'Appraisal reviewed',
             substr(COALESCE(a.reviewer_comments, ''), 1, 160), ${who('a.reviewer_user_id')}, '/go/appraisals', NULL
        FROM appraisals a WHERE a.employee_id = ? AND a.reviewed_at IS NOT NULL
      UNION ALL
      SELECT 'appraisal:' || a.id || ':published', 'appraisal', a.published_at,
             'Appraisal published' || COALESCE(': ' || a.final_band, ''), COALESCE('Score ' || a.final_score, ''), '', '/go/appraisals', NULL
        FROM appraisals a WHERE a.employee_id = ? AND a.published_at IS NOT NULL
      UNION ALL
      SELECT 'appraisal:' || g.id || ':award', 'appraisal', g.created_at, 'Recognised: ' || g.title,
             substr(COALESCE(g.citation, ''), 1, 160), ${who('g.nominated_by')}, '/go/appraisals', NULL
        FROM staff_recognitions g WHERE g.employee_id = ? AND g.published = 1`, 3),
    e('task', `
      SELECT 'task:' || k.id || ':given', 'task', k.created_at, 'Task given: ' || k.title,
             COALESCE('Due ' || k.due_on, ''), ${who('k.assigned_by')}, '/go/staff_tasks', NULL
        FROM staff_tasks k WHERE k.assigned_to = ?
      UNION ALL
      SELECT 'task:' || k.id || ':done', 'task', k.done_at, 'Task done: ' || k.title,
             substr(COALESCE(k.done_note, ''), 1, 160), '', '/go/staff_tasks', NULL
        FROM staff_tasks k WHERE k.assigned_to = ? AND k.done_at IS NOT NULL`, 2),
    u('attendance', `
      SELECT 'punch:' || s.id, 'attendance', ${day('s.on_date')},
             CASE s.status WHEN 'absent' THEN 'Absent' WHEN 'late' THEN 'Late' ELSE 'Half day' END || ' on ' || s.on_date,
             trim(COALESCE('In ' || substr(s.check_in, 1, 5), '') || ' ' || COALESCE('out ' || substr(s.check_out, 1, 5), '') || ' ' || COALESCE(s.remarks, '')),
             ${who('s.marked_by')}, '/go/staff_attendance_register', NULL
        FROM staff_attendance s WHERE s.user_id = ? AND s.status IN ('absent', 'late', 'half_day')`, 1),
    /* The roles screen writes the whole new set to the audit log; the title
       reads it back as the set they hold from that moment. */
    u('role', `
      SELECT 'role:' || l.id, 'role', l.created_at,
             CASE WHEN l.action LIKE '%/roles' THEN 'Roles set: ' || COALESCE((SELECT group_concat(value, ', ') FROM json_each(json_extract(l.after, '$.roles'))), 'none')
                  ELSE 'Permissions changed' END,
             '', ${who('l.actor_user_id')}, '/go/roles_permissions', NULL
        FROM audit_log l WHERE l.action IN ('PUT /api/v1/admin/users/' || ? || '/roles', 'PUT /api/v1/admin/users/' || ? || '/permissions')
         AND json_valid(COALESCE(l.after, '{}'))`, 2),
    u('notice', `
      SELECT 'notice:' || an.id, 'notice', an.publish_at, 'Sent notice: ' || an.title, substr(an.body, 1, 160), '', '/go/circulars', NULL
        FROM announcements an WHERE an.created_by = ?`, 1),
  ]
  /* Remarks about a member of staff are read by the people the staff-remarks
     screen lets read them all; payslips by payroll. */
  if (userId && (can(c.id, 'hr.employees.write') || can(c.id, 'access.users.write') || can(c.id, 'hr.leave.approve'))) {
    parts.push({ type: 'remark', args: [userId], sql: `
      SELECT 'remark:' || r.id, 'remark', r.created_at, 'Remark (' || r.kind || ')', substr(r.body, 1, 160), ${who('r.author_user_id')}, NULL, NULL
        FROM staff_remarks r WHERE r.subject_user_id = ?` })
  }
  if (can(c.id, 'hr.employees.write')) {
    parts.push({ type: 'concern', args: [empId], sql: `
      SELECT 'grievance:' || g.id, 'concern', g.created_at, 'Concern raised: ' || g.subject, substr(g.description, 1, 160),
             ${who('g.raised_by')}, '/go/grievances', NULL
        FROM staff_grievances g WHERE g.employee_id = ? AND g.is_anonymous = 0` })
  }
  if (can(c.id, 'hr.payroll.read')) {
    parts.push({ type: 'payroll', args: [empId], sql: `
      SELECT 'payslip:' || ps.id, 'payroll', pr.published_at,
             'Payslip for ' || substr('JanFebMarAprMayJunJulAugSepOctNovDec', pr.period_month * 3 - 2, 3) || ' ' || pr.period_year,
             ps.paid_days || ' paid days' || CASE WHEN CAST(ps.lop_days AS REAL) > 0 THEN ', ' || ps.lop_days || ' without pay' ELSE '' END,
             ${who('pr.run_by')}, '/go/monthly_payroll', ps.net_paise
        FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
       WHERE ps.employee_id = ? AND pr.published_at IS NOT NULL` })
  }
  return parts.filter((x): x is Part => x !== null)
}

const rupees = (paise: number) =>
  '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })

/** Reads one page of the union. `types` narrows it; an unknown type is ignored. */
export async function page(c: Ctx, all: Part[], known: readonly string[], narrow?: Narrow): Promise<{ items: TimelineEvent[]; next: string | null; types: string[] }> {
  const q = c.url.searchParams
  const limit = clampInt(q.get('limit'), 30, 1, 100)
  const want = new Set((q.get('types') ?? '').split(',').map((s) => s.trim()).filter((s) => known.includes(s)))
  const parts = want.size ? all.filter((p) => want.has(p.type)) : all
  const types = known.filter((t) => all.some((p) => p.type === t))
  if (!parts.length) return { items: [], next: null, types }

  const cursor = q.get('cursor') ?? ''
  const bar = cursor.lastIndexOf('|')
  const cAt = bar > 0 ? cursor.slice(0, bar) : null
  const cId = bar > 0 ? cursor.slice(bar + 1) : null
  if (cursor && !cAt) throw badRequest('cursor is not one this list handed out')

  /* One query per source, in one batch, merged here. D1 caps a compound
     SELECT at a handful of terms, so the sources cannot be one UNION; each
     returns at most a page past the cursor, and the newest `limit` of all of
     them is the page. */
  type Row = Omit<TimelineEvent, 'by'> & { actor: string | null; amount: number | null }
  /* A school-wide part also names who acted; whether that is a student, a
     parent or staff is read from their account, once, here. */
  const stmts = parts.map((p) => (narrow
    ? c.db.prepare(`WITH ev (id, type, at, title, detail, actor, link, amount, actor_id) AS (${p.sql}),
         ew AS (SELECT ev.*, CASE WHEN actor_id IS NULL THEN 'system'
                  WHEN EXISTS (SELECT 1 FROM students s WHERE s.user_id = ev.actor_id) THEN 'student'
                  WHEN EXISTS (SELECT 1 FROM guardians g WHERE g.user_id = ev.actor_id) THEN 'parent'
                  ELSE 'staff' END AS who FROM ev)
       SELECT id, type, at, title, detail, actor, link, amount, who FROM ew
       WHERE at IS NOT NULL AND (? IS NULL OR at < ? OR (at = ? AND id < ?)) AND ${narrow.where}
       ORDER BY at DESC, id DESC LIMIT ?`).bind(...p.args, cAt, cAt, cAt, cId, ...narrow.args, limit + 1)
    : c.db.prepare(`WITH ev (id, type, at, title, detail, actor, link, amount) AS (${p.sql})
       SELECT id, type, at, title, detail, actor, link, amount FROM ev
       WHERE at IS NOT NULL AND (? IS NULL OR at < ? OR (at = ? AND id < ?))
       ORDER BY at DESC, id DESC LIMIT ?`).bind(...p.args, cAt, cAt, cAt, cId, limit + 1)))
  const rows = (await c.db.batch<Row>(stmts)).flatMap((res) => res.results)
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
  const more = rows.length > limit
  const items: TimelineEvent[] = rows.slice(0, limit).map(({ amount, actor, ...ev }) => ({
    ...ev,
    title: amount != null ? `${ev.title} ${rupees(Number(amount))}` : ev.title,
    detail: ev.detail ?? '',
    by: actor ?? '',
  }))
  const last = items[items.length - 1]
  return { items, next: more && last ? `${last.at}|${last.id}` : null, types }
}

export function registerTimeline(r: Router): void {
  r.get('/students/{id}/timeline', 'students.read', async (c) => {
    const sid = c.params.id
    if (!isUUID(sid)) throw badRequest('invalid student id')
    const pred = studentPredicate(await resolveScope(c), 'st')
    const seen = await c.db.prepare(`SELECT 1 AS ok FROM students st WHERE st.id = ? AND ${pred.sql}`).bind(sid, ...pred.args).first()
    if (!seen) throw notFound('resource not found')
    return ok(await page(c, studentParts(c, sid), STUDENT_TYPES))
  })

  r.get('/hr/employees/{id}/timeline', 'hr.employees.read', async (c) => {
    const eid = c.params.id
    if (!isUUID(eid)) throw badRequest('invalid employee id')
    const mine = employeeFilter(await growthReach(c.db, c.id), 'e')
    const emp = await c.db.prepare(`SELECT e.user_id FROM employees e WHERE e.id = ? AND ${mine.sql}`)
      .bind(eid, ...mine.args).first<{ user_id: string | null }>()
    if (!emp) throw notFound('resource not found')
    return ok(await page(c, staffParts(c, eid, emp.user_id), STAFF_TYPES))
  })
}
