/* School activity (activity.school_activity): everything students, parents
   and staff do on the platform, newest first, on one timeline, for the
   principal (owner, 2026-10-23: "all time line should be seen with good
   visual, for student, parent, staff action on the platform, add filters").

   The same pager as Student 360 and Staff 360 (routes/timeline.ts), over the
   whole school instead of one record. Each source names who acted
   (actor_id); whether that was a student, a parent or staff is read from
   their account. Never the words of a family's message, as on the 360s: who
   wrote to whom, and when. Filters: who, what, from and to (school days),
   and part of a name. */
import type { Router } from '../../router'
import { badRequest, clampInt } from '../../http'
import type { Ctx } from '../../router'
import type { SchoolActivityEvent, SchoolActivityPage } from '@shared/api/feature_school_activity'
import { day, page, who as nameOf, type Narrow, type Part } from '../timeline'

export const ACTIVITY_TYPES = ['signin', 'concern', 'leave', 'attendance', 'fee', 'homework', 'message', 'notice', 'remark', 'behaviour', 'change'] as const
const WHO = ['student', 'parent', 'staff', 'system'] as const
const DATE = /^\d{4}-\d{2}-\d{2}$/

const p = (type: string, sql: string): Part => ({ type, sql, args: [] })

/* Every part selects: id, type, at, title, detail, actor, link, amount, actor_id. */
const PARTS: Part[] = [
  p('concern', `
    SELECT 'concern:' || t.id || ':raised', 'concern', t.created_at, 'Concern raised: ' || t.subject, substr(t.body, 1, 160),
           ${nameOf('t.raised_by')}, '/go/parent_concerns?id=' || t.id, NULL, t.raised_by
      FROM support_tickets t WHERE t.audience = 'school'
    UNION ALL
    SELECT 'concern:' || t.id || ':resolved', 'concern', t.resolved_at, 'Concern resolved: ' || t.subject, substr(COALESCE(t.resolution, ''), 1, 160),
           ${nameOf('t.resolved_by')}, '/go/parent_concerns?id=' || t.id, NULL, t.resolved_by
      FROM support_tickets t WHERE t.audience = 'school' AND t.resolved_at IS NOT NULL`),
  p('leave', `
    SELECT 'leave:' || l.id || ':asked', 'leave', l.created_at,
           'Leave asked: ' || l.from_date || ' to ' || l.to_date || CASE WHEN l.subject_kind = 'student' THEN ' (student)' ELSE '' END,
           substr(l.reason, 1, 160), ${nameOf('l.applied_by')}, CASE WHEN l.subject_kind = 'student' THEN '/go/student_leave_requests' ELSE '/go/leave/leave' END, NULL, l.applied_by
      FROM leave_requests l
    UNION ALL
    SELECT 'leave:' || l.id || ':decided', 'leave', l.decided_at, 'Leave ' || l.status || ': ' || l.from_date || ' to ' || l.to_date,
           substr(COALESCE(l.decision_note, ''), 1, 160), ${nameOf('l.decided_by')},
           CASE WHEN l.subject_kind = 'student' THEN '/go/student_leave_requests' ELSE '/go/leave/leave' END, NULL, l.decided_by
      FROM leave_requests l WHERE l.decided_at IS NOT NULL`),
  /* One line per register taken (a section on a day), not one per child. */
  p('attendance', `
    SELECT 'register:' || g.section_id || ':' || g.on_date, 'attendance', g.at,
           'Attendance taken: ' || COALESCE((SELECT c.name || ' ' || s.name FROM sections s JOIN classes c ON c.id = s.class_id WHERE s.id = g.section_id), 'a class'),
           g.absent || ' absent, ' || g.late || ' late, of ' || g.n,
           ${nameOf('g.by_user')}, '/go/attendance/take_attendance', NULL, g.by_user
      FROM (SELECT a.section_id, a.on_date, MAX(COALESCE(a.marked_at, ${day('a.on_date')})) AS at, MAX(a.marked_by) AS by_user,
                   SUM(a.status = 'absent') AS absent, SUM(a.status = 'late') AS late, COUNT(*) AS n
              FROM student_attendance a WHERE a.period_id IS NULL GROUP BY a.section_id, a.on_date) g`),
  p('fee', `
    SELECT 'fee:' || f.id, 'fee', f.created_at,
           CASE WHEN f.collected_by IS NULL THEN 'Fee paid online' ELSE 'Fee collected' END,
           trim(COALESCE('Receipt ' || f.receipt_no, '') || ' · ' || f.mode, ' ·'),
           COALESCE(NULLIF(${nameOf('f.collected_by')}, ''), f.payer_name, ''), '/go/fee_receipts', f.amount_paise, f.collected_by
      FROM payments f WHERE f.status = 'success'`),
  p('homework', `
    SELECT 'homework:' || h.id || ':set', 'homework', h.created_at, 'Homework set: ' || h.title, COALESCE('Due ' || h.due_on, ''),
           ${nameOf('h.created_by')}, '/go/homework', NULL, h.created_by
      FROM homework h WHERE h.is_published = 1
    UNION ALL
    SELECT 'homework:' || x.id || ':in', 'homework', x.submitted_at, 'Homework handed in: ' || COALESCE((SELECT title FROM homework WHERE id = x.homework_id), ''),
           '', ${nameOf('x.submitted_by')}, '/go/homework', NULL, x.submitted_by
      FROM homework_submissions x WHERE x.submitted_at IS NOT NULL`),
  p('message', `
    SELECT 'message:' || m.id, 'message', m.sent_at,
           CASE WHEN m.sender_user_id = m.parent_user_id THEN 'Parent wrote to ' || ${nameOf('m.teacher_user_id')}
                ELSE 'Wrote to ' || ${nameOf('m.parent_user_id')} END,
           '', ${nameOf('m.sender_user_id')}, '/go/communication/messages', NULL, m.sender_user_id
      FROM parent_teacher_messages m WHERE m.deleted_at IS NULL`),
  p('notice', `
    SELECT 'notice:' || an.id, 'notice', an.publish_at, 'Notice sent: ' || an.title, substr(an.body, 1, 160),
           ${nameOf('an.created_by')}, '/go/circulars', NULL, an.created_by
      FROM announcements an WHERE an.publish_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')`),
  p('remark', `
    SELECT 'remark:' || r.id, 'remark', r.created_at, 'Remark (' || r.kind || ')', substr(r.body, 1, 160),
           ${nameOf('r.recorded_by')}, '/go/remarks', NULL, r.recorded_by
      FROM student_remarks r`),
  p('behaviour', `
    SELECT 'behaviour:' || d.id, 'behaviour', d.created_at,
           CASE WHEN d.is_positive THEN 'Commended: ' ELSE 'Behaviour note: ' END || d.category, substr(d.description, 1, 160),
           ${nameOf('d.recorded_by')}, '/go/behaviour', NULL, d.recorded_by
      FROM discipline_records d`),
  /* Changes the audit log keeps, its method and path read as a sentence. */
  p('change', `
    SELECT 'change:' || l.id, 'change', l.created_at,
           CASE substr(l.action, 1, instr(l.action, ' ') - 1) WHEN 'DELETE' THEN 'Removed' WHEN 'POST' THEN 'Added' ELSE 'Changed' END || ' ' ||
             trim(replace(replace(replace(substr(l.action, instr(l.action, '/api/v1/') + 8), '/', ' '), '_', ' '), '-', ' ')),
           l.entity_type, ${nameOf('l.actor_user_id')}, NULL, NULL, l.actor_user_id
      FROM audit_log l`),
]

export function registerSchoolActivity(r: Router): void {
  r.typed('GET /admin/activity', 'admin.audit.read', async (c) => {
    const q = c.url.searchParams
    const whos = (q.get('who') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (whos.some((w) => !(WHO as readonly string[]).includes(w))) throw badRequest('who is student, parent, staff or system')
    const from = (q.get('from') ?? '').trim(), to = (q.get('to') ?? '').trim()
    if ((from && !DATE.test(from)) || (to && !DATE.test(to))) throw badRequest('dates are YYYY-MM-DD')
    if (from && to && from > to) throw badRequest('the start date is after the end date')
    const name = (q.get('q') ?? '').trim().slice(0, 80).replace(/[%_]/g, '')
    /* A school day runs on India time: 'from' and 'to' are whole days there. */
    const narrow: Narrow = {
      where: `(? = '' OR who IN (SELECT value FROM json_each(?)))
        AND (? = '' OR datetime(at, '+330 minutes') >= ?)
        AND (? = '' OR datetime(at, '+330 minutes') < date(?, '+1 day'))
        AND (? = '' OR actor LIKE '%' || ? || '%' OR title LIKE '%' || ? || '%')`,
      args: [whos.length ? 'x' : '', JSON.stringify(whos), from, from, to, to, name, name, name],
    }
    const types = (q.get('types') ?? '').split(',').map((t) => t.trim()).filter(Boolean)
    const wantSignins = !types.length || types.includes('signin')
    const school = (await page(c, PARTS, ACTIVITY_TYPES, narrow)) as SchoolActivityPage
    // A filter for sign-ins alone reads none of the school's own tables.
    const fromSchool = !types.length || types.some((t) => t !== 'signin') ? school.items : []
    if (!wantSignins) return { ...school, types: [...ACTIVITY_TYPES] }
    const limit = clampInt(q.get('limit'), 30, 1, 100)
    const signins = await signinsPage(c, { cursor: q.get('cursor') ?? '', from, to, whos, name, limit })
    const merged = [...fromSchool, ...signins.items]
      .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
    const items = merged.slice(0, limit)
    const last = items[items.length - 1]
    const more = merged.length > limit || (school.next !== null && fromSchool.length > 0) || signins.more
    return { items, next: more && last ? `${last.at}|${last.id}` : null, types: [...ACTIVITY_TYPES] }
  })
}

/* Sign-ins are kept by the platform (CONTROL sessions), one row per sign-in.
   Who they were (student, parent, staff) and their name come from the
   school's own records; the name filter and who filter are applied after, so
   a page is read a little wider than it is shown. */
async function signinsPage(c: Ctx, o: { cursor: string; from: string; to: string; whos: string[]; name: string; limit: number }) {
  const bar = o.cursor.lastIndexOf('|')
  const cAt = bar > 0 ? o.cursor.slice(0, bar) : null
  const cId = bar > 0 ? o.cursor.slice(bar + 1) : null
  const wide = o.name || o.whos.length ? o.limit * 4 : o.limit + 1
  const rows = (await c.env.CONTROL.prepare(`SELECT 'signin:' || s.id AS id, s.created_at AS at, s.user_id, s.via FROM sessions s
     WHERE s.institution_id = ? AND s.user_id IS NOT NULL
       AND (? IS NULL OR s.created_at < ? OR (s.created_at = ? AND 'signin:' || s.id < ?))
       AND (? = '' OR datetime(s.created_at, '+330 minutes') >= ?)
       AND (? = '' OR datetime(s.created_at, '+330 minutes') < date(?, '+1 day'))
     ORDER BY s.created_at DESC, s.id DESC LIMIT ?`)
    .bind(c.id.institution!.id, cAt, cAt, cAt, cId, o.from, o.from, o.to, o.to, wide)
    .all<{ id: string; at: string; user_id: string; via: string | null }>()).results
  const ids = [...new Set(rows.map((r) => r.user_id))]
  const people = new Map((await c.db.prepare(`SELECT u.id, u.full_name,
       CASE WHEN EXISTS (SELECT 1 FROM students s WHERE s.user_id = u.id) THEN 'student'
            WHEN EXISTS (SELECT 1 FROM guardians g WHERE g.user_id = u.id) THEN 'parent' ELSE 'staff' END AS who
       FROM users u WHERE u.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids))
    .all<{ id: string; full_name: string; who: SchoolActivityEvent['who'] }>()).results.map((p) => [p.id, p]))
  const needle = o.name.toLowerCase()
  const items: SchoolActivityEvent[] = rows.flatMap((r) => {
    const p = people.get(r.user_id)
    if (!p) return []
    if (o.whos.length && !o.whos.includes(p.who)) return []
    if (needle && !p.full_name.toLowerCase().includes(needle)) return []
    return [{ id: r.id, type: 'signin', at: r.at, title: 'Signed in', detail: r.via ? `By ${r.via}` : '', by: p.full_name, link: null, who: p.who }]
  })
  return { items, more: rows.length >= wide }
}
