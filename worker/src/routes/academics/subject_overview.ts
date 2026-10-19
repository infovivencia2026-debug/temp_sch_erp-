import type { Ctx, Router } from '../../router'
import { ok, badRequest, forbidden, notFound, readJSON, isUUID, uuid, now } from '../../http'
import { can } from '../../identity'
import { institutionId } from '../admin/common'
import { notifyStmt } from '../misc/chat'

/* A HEAD FOR EACH SUBJECT (owner, 2026-10-16: "different subject hod for
   different persons and they should see all their subject teachers from
   grade 1 -- performance overview, notices, meetings, time table of those
   subjects only").

   Departments already had one head each, but a department is a staff list
   somebody keeps by hand; a subject head wants whoever teaches the subject,
   in any class, this year -- read from the subject teachers and the
   timetable, so it never goes stale. The office picks the head per subject;
   the head sees only the subjects they head. */

/* The office: the principal's catalogue key. A HOD also holds academics.write, so that cannot be the test. */
const OFFICE = 'institution_admin.academics.subject_overview'

const all = async <T>(s: D1PreparedStatement) => (await s.all<T>()).results

/** Subjects this caller may look at: the ones they head, or every headed one for the office. */
async function viewableSubjects(c: Ctx): Promise<{ id: string; name: string }[]> {
  if (can(c.id, OFFICE)) {
    // Every subject the school teaches, headed or not (owner, 2026-10-19: "show all subjects").
    return all(c.db.prepare(`SELECT s.id, s.name FROM subjects s WHERE EXISTS (SELECT 1 FROM class_subjects cs WHERE cs.subject_id = s.id) ORDER BY s.name`))
  }
  return all(c.db.prepare(`SELECT s.id, s.name FROM subject_heads h JOIN subjects s ON s.id = h.subject_id WHERE h.head_user_id = ? ORDER BY s.name`).bind(c.id.userId))
}

async function mayHead(c: Ctx, subjectId: string): Promise<boolean> {
  if (can(c.id, OFFICE)) return true
  return !!(await c.db.prepare(`SELECT 1 AS x FROM subject_heads WHERE subject_id = ? AND head_user_id = ?`).bind(subjectId, c.id.userId).first())
}

const currentYear = `(SELECT id FROM academic_years WHERE is_current = 1 LIMIT 1)`

/** Everyone teaching this subject this year: subject teachers plus whoever the timetable puts in front of it. */
export async function subjectTeachers(c: Ctx, subjectId: string): Promise<string[]> {
  const r = await all<{ u: string }>(c.db.prepare(`
      SELECT sst.teacher_user_id AS u FROM section_subject_teachers sst
        JOIN class_subjects cs ON cs.id = sst.class_subject_id JOIN sections sec ON sec.id = sst.section_id
       WHERE cs.subject_id = ?1 AND sec.academic_year_id = ${currentYear}
      UNION
      SELECT te.teacher_user_id FROM timetable_entries te JOIN class_subjects cs ON cs.id = te.class_subject_id
       WHERE cs.subject_id = ?1 AND te.teacher_user_id IS NOT NULL AND te.academic_year_id = ${currentYear}
      UNION
      SELECT user_id FROM subject_head_members WHERE subject_id = ?1 AND mode = 'add'
      EXCEPT
      SELECT user_id FROM subject_head_members WHERE subject_id = ?1 AND mode = 'remove'`).bind(subjectId))
  return r.map((x) => x.u)
}

/* WHAT A SUBJECT HEAD IS GIVEN, PER SCHOOL (owner, 2026-10-19: "all changes
   are generic... let us change according to school"). Every part is on until
   the school turns it off on the Subject heads tab. */
export const PARTS = ['performance', 'classes', 'timetable', 'notices', 'meetings', 'approvals', 'homework'] as const
export type Parts = Record<(typeof PARTS)[number], boolean>
export async function headParts(c: Ctx): Promise<Parts> {
  const r = await c.db.prepare(`SELECT config FROM module_settings WHERE module = 'subject_heads'`).first<{ config: string }>()
  let cfg: Record<string, unknown> = {}
  try { cfg = JSON.parse(r?.config ?? '{}') } catch { /* keep defaults */ }
  const parts = (cfg.parts ?? {}) as Record<string, unknown>
  return Object.fromEntries(PARTS.map((k) => [k, parts[k] !== false])) as Parts
}

async function getSettings(c: Ctx) { return ok({ parts: await headParts(c) }) }

async function saveSettings(c: Ctx) {
  const b = await readJSON<{ parts?: Record<string, boolean> }>(c.req)
  const parts = Object.fromEntries(PARTS.map((k) => [k, b.parts?.[k] !== false]))
  await c.db.prepare(`INSERT INTO module_settings (institution_id, module, enabled, config) VALUES (?, 'subject_heads', 1, ?)
      ON CONFLICT (institution_id, module) DO UPDATE SET config = json_set(config, '$.parts', json(?))`)
    .bind(institutionId(c), JSON.stringify({ parts }), JSON.stringify(parts)).run()
  return ok({ parts })
}

/** A teacher under a head: 'add' someone who does not teach it, 'remove' someone who does, null to undo. */
async function setMember(c: Ctx) {
  const b = await readJSON<{ subject_id?: string; user_id?: string; mode?: string | null }>(c.req)
  if (!isUUID(b.subject_id) || !isUUID(b.user_id)) throw badRequest('pick a subject and a teacher')
  if (!b.mode) await c.db.prepare(`DELETE FROM subject_head_members WHERE subject_id = ? AND user_id = ?`).bind(b.subject_id, b.user_id).run()
  else {
    if (b.mode !== 'add' && b.mode !== 'remove') throw badRequest('mode is add or remove')
    await c.db.prepare(`INSERT INTO subject_head_members (subject_id, user_id, institution_id, mode) VALUES (?, ?, ?, ?)
        ON CONFLICT (subject_id, user_id) DO UPDATE SET mode = excluded.mode`).bind(b.subject_id, b.user_id, institutionId(c), b.mode).run()
  }
  return ok()
}

/* The Subject Head role follows the headship: given with the first subject,
   taken away when the person heads nothing. */
async function syncHeadRole(c: Ctx, userId: string | null) {
  if (!userId) return
  const role = await c.db.prepare(`SELECT id FROM roles WHERE key = 'subject_head' LIMIT 1`).first<{ id: string }>()
  if (!role) return
  const heads = await c.db.prepare(`SELECT 1 AS x FROM subject_heads WHERE head_user_id = ? LIMIT 1`).bind(userId).first()
  if (heads) {
    await c.db.prepare(`INSERT OR IGNORE INTO user_roles (id, institution_id, user_id, role_id, campus_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)`)
      .bind(uuid(), institutionId(c), userId, role.id, now()).run()
  } else {
    await c.db.prepare(`DELETE FROM user_roles WHERE user_id = ? AND role_id = ?`).bind(userId, role.id).run()
  }
}

// ---- the office: who heads which subject --------------------------------

async function listHeads(c: Ctx) {
  const subjects = await all(c.db.prepare(`SELECT s.id, s.name, s.code, h.head_user_id, u.full_name AS head_name
      FROM subjects s LEFT JOIN subject_heads h ON h.subject_id = s.id LEFT JOIN users u ON u.id = h.head_user_id ORDER BY s.name`))
  const staff = await all(c.db.prepare(`SELECT u.id, u.full_name AS name, e.employee_code AS code FROM employees e JOIN users u ON u.id = e.user_id
      WHERE e.status = 'active' ORDER BY u.full_name`))
  return ok({ subjects, staff })
}

async function setHead(c: Ctx) {
  const b = await readJSON<{ subject_id?: string; head_user_id?: string | null }>(c.req)
  if (!isUUID(b.subject_id)) throw badRequest('pick a subject')
  const before = await c.db.prepare(`SELECT head_user_id FROM subject_heads WHERE subject_id = ?`).bind(b.subject_id).first<{ head_user_id: string }>()
  if (!b.head_user_id) {
    await c.db.prepare(`DELETE FROM subject_heads WHERE subject_id = ?`).bind(b.subject_id).run()
    await syncHeadRole(c, before?.head_user_id ?? null)
    return ok()
  }
  if (!isUUID(b.head_user_id)) throw badRequest('pick a member of staff')
  await c.db.prepare(`INSERT INTO subject_heads (subject_id, institution_id, head_user_id) VALUES (?, ?, ?)
      ON CONFLICT (subject_id) DO UPDATE SET head_user_id = excluded.head_user_id`).bind(b.subject_id, institutionId(c), b.head_user_id).run()
  await syncHeadRole(c, b.head_user_id)
  if (before && before.head_user_id !== b.head_user_id) await syncHeadRole(c, before.head_user_id)
  return ok()
}

// ---- the head: one subject at a time ------------------------------------

async function overview(c: Ctx) {
  const subjects = await viewableSubjects(c)
  const want = c.url.searchParams.get('subject')
  const subject = subjects.find((s) => s.id === want) ?? subjects[0]
  const parts = await headParts(c)
  if (!subject) return ok({ subjects, subject: null, teachers: [], timetable: [], notices: [], meetings: [], sections: [], can_assign: false, staff: [], parts, pending_plans: [], removed: [] })
  const sid = subject.id
  const ids = await subjectTeachers(c, sid)
  const idj = JSON.stringify(ids)

  const people = await all<{ id: string; name: string; phone: string | null }>(c.db.prepare(
    `SELECT id, full_name AS name, phone FROM users WHERE id IN (SELECT value FROM json_each(?)) ORDER BY full_name`).bind(idj))

  // Classes each teacher takes in this subject, with periods a week.
  const classes = await all<{ teacher: string; section_id: string; label: string; level: number; periods: number }>(c.db.prepare(`
      SELECT t.teacher, t.section_id, cl.name || ' ' || sec.name AS label, cl.level,
             (SELECT count(*) FROM timetable_entries te WHERE te.section_id = t.section_id AND te.class_subject_id = t.cs AND te.teacher_user_id = t.teacher) AS periods
        FROM (SELECT sst.teacher_user_id AS teacher, sst.section_id, sst.class_subject_id AS cs FROM section_subject_teachers sst
               JOIN class_subjects x ON x.id = sst.class_subject_id WHERE x.subject_id = ?1
              UNION
              SELECT te.teacher_user_id, te.section_id, te.class_subject_id FROM timetable_entries te
               JOIN class_subjects x ON x.id = te.class_subject_id WHERE x.subject_id = ?1 AND te.teacher_user_id IS NOT NULL) t
        JOIN sections sec ON sec.id = t.section_id JOIN classes cl ON cl.id = sec.class_id
       WHERE sec.academic_year_id = ${currentYear}
       ORDER BY cl.level, sec.name`).bind(sid))

  // Average mark (%) in this subject, per teacher and class, over exams that have marks.
  const scores = await all<{ teacher: string; section_id: string; avg: number | null; papers: number }>(c.db.prepare(`
      SELECT sst.teacher_user_id AS teacher, sst.section_id,
             round(avg(CAST(m.marks_obtained AS REAL) * 100.0 / NULLIF(CAST(es.max_marks AS REAL), 0)), 1) AS avg,
             count(DISTINCT es.id) AS papers
        FROM section_subject_teachers sst
        JOIN class_subjects cs ON cs.id = sst.class_subject_id
        JOIN exam_subjects es ON es.class_subject_id = cs.id
        JOIN marks m ON m.exam_subject_id = es.id AND m.is_absent = 0 AND m.marks_obtained IS NOT NULL AND m.marks_obtained <> ''
        JOIN enrollments en ON en.student_id = m.student_id AND en.section_id = sst.section_id
       WHERE cs.subject_id = ? GROUP BY sst.teacher_user_id, sst.section_id`).bind(sid))

  // Lesson plans in this subject over the last 30 days.
  const plans = await all<{ teacher: string; total: number; submitted: number; delivered: number }>(c.db.prepare(`
      SELECT lp.teacher_user_id AS teacher, count(*) AS total,
             sum(CASE WHEN lp.status <> 'draft' THEN 1 ELSE 0 END) AS submitted,
             sum(CASE WHEN lp.delivered_on IS NOT NULL THEN 1 ELSE 0 END) AS delivered
        FROM lesson_plans lp JOIN class_subjects cs ON cs.id = lp.class_subject_id
       WHERE cs.subject_id = ? AND lp.week_of >= date('now', '-30 days') GROUP BY lp.teacher_user_id`).bind(sid))

  // The teacher's own month: homework set in this subject, days present, days on leave.
  const hw = await all<{ teacher: string; n: number }>(c.db.prepare(`SELECT h.created_by AS teacher, count(*) AS n FROM homework h
      JOIN class_subjects cs ON cs.id = h.class_subject_id WHERE cs.subject_id = ? AND h.assigned_on >= date('now', '-30 days') GROUP BY h.created_by`).bind(sid))
  const att = await all<{ teacher: string; present: number; marked: number }>(c.db.prepare(`SELECT user_id AS teacher,
        sum(CASE WHEN status IN ('present','late','half_day','on_duty') THEN 1 ELSE 0 END) AS present, count(*) AS marked
      FROM staff_attendance WHERE user_id IN (SELECT value FROM json_each(?)) AND on_date >= date('now', '-30 days') GROUP BY user_id`).bind(idj))
  const lv = await all<{ teacher: string; days: number }>(c.db.prepare(`SELECT e.user_id AS teacher, sum(CAST(l.days AS REAL)) AS days FROM leave_requests l
      JOIN employees e ON e.id = l.employee_id WHERE e.user_id IN (SELECT value FROM json_each(?)) AND l.status = 'approved' AND l.to_date >= date('now', '-30 days')
      GROUP BY e.user_id`).bind(idj))
  const teachers = people.map((p) => {
    const mine = classes.filter((k) => k.teacher === p.id)
    const sc = scores.filter((s) => s.teacher === p.id && s.avg !== null)
    const lp = plans.find((x) => x.teacher === p.id)
    return {
      ...p,
      classes: mine.map((k) => ({ label: k.label, periods: k.periods, avg: scores.find((s) => s.teacher === p.id && s.section_id === k.section_id)?.avg ?? null })),
      periods_week: mine.reduce((n, k) => n + k.periods, 0),
      avg: sc.length ? Math.round((sc.reduce((n, s) => n + (s.avg ?? 0), 0) / sc.length) * 10) / 10 : null,
      plans_30d: lp?.total ?? 0, plans_submitted: lp?.submitted ?? 0, plans_delivered: lp?.delivered ?? 0,
      homework_30d: hw.find((x) => x.teacher === p.id)?.n ?? 0,
      present_30d: att.find((x) => x.teacher === p.id)?.present ?? null, marked_30d: att.find((x) => x.teacher === p.id)?.marked ?? 0,
      leave_30d: lv.find((x) => x.teacher === p.id)?.days ?? 0,
    }
  })

  // This subject's timetable, every class.
  const timetable = await all(c.db.prepare(`
      SELECT te.weekday, te.period_id, te.teacher_user_id, p.name AS period, p.sequence, p.starts_at, p.ends_at, cl.name || ' ' || sec.name AS class, cl.level, u.full_name AS teacher, te.room
        FROM timetable_entries te JOIN class_subjects cs ON cs.id = te.class_subject_id
        JOIN periods p ON p.id = te.period_id JOIN sections sec ON sec.id = te.section_id JOIN classes cl ON cl.id = sec.class_id
        LEFT JOIN users u ON u.id = te.teacher_user_id
       WHERE cs.subject_id = ? AND te.academic_year_id = ${currentYear}
       ORDER BY te.weekday, p.sequence, cl.level, sec.name`).bind(sid))

  // Notices these teachers posted in the last 60 days.
  const notices = await all(c.db.prepare(`
      SELECT a.id, a.title, a.body, a.kind, a.publish_at, u.full_name AS by_name FROM announcements a JOIN users u ON u.id = a.created_by
       WHERE a.created_by IN (SELECT value FROM json_each(?)) AND a.publish_at >= date('now', '-60 days')
       ORDER BY a.publish_at DESC LIMIT 50`).bind(idj))

  const meetings = await all<Record<string, unknown>>(c.db.prepare(`SELECT m.id, m.title, m.agenda, m.meets_at, m.place, m.minutes, u.full_name AS by_name,
        (SELECT json_group_array(json_object('name', ru.full_name, 'reply', r.reply, 'note', r.note))
           FROM subject_meeting_replies r JOIN users ru ON ru.id = r.user_id WHERE r.meeting_id = m.id) AS replies
      FROM subject_meetings m LEFT JOIN users u ON u.id = m.created_by WHERE m.subject_id = ? ORDER BY m.meets_at DESC LIMIT 50`).bind(sid))
  for (const m of meetings) m.replies = JSON.parse(String(m.replies ?? '[]'))

  /* EVERY CLASS OF THE SUBJECT, SIDE BY SIDE (owner, 2026-10-19: "which
     section is behind", "syllabus progress per class", and the subject
     teacher per class, set here rather than hunted for elsewhere). */
  const secs = await all<{ section_id: string; class_subject_id: string; label: string; level: number; teacher_user_id: string | null; teacher: string | null; students: number }>(c.db.prepare(`
      SELECT sec.id AS section_id, cs.id AS class_subject_id, cl.name || ' ' || sec.name AS label, cl.level,
             sst.teacher_user_id, u.full_name AS teacher,
             (SELECT count(*) FROM enrollments en WHERE en.section_id = sec.id AND en.status = 'active') AS students
        FROM class_subjects cs JOIN classes cl ON cl.id = cs.class_id
        JOIN sections sec ON sec.class_id = cl.id AND sec.academic_year_id = ${currentYear}
        LEFT JOIN section_subject_teachers sst ON sst.section_id = sec.id AND sst.class_subject_id = cs.id
        LEFT JOIN users u ON u.id = sst.teacher_user_id
       WHERE cs.subject_id = ? ORDER BY cl.level, sec.name`).bind(sid))
  const secMarks = await all<{ section_id: string; avg: number; pass: number; papers: number }>(c.db.prepare(`
      SELECT section_id, round(avg(pct), 1) AS avg, round(100.0 * sum(CASE WHEN pct >= 33 THEN 1 ELSE 0 END) / count(*), 1) AS pass, count(DISTINCT es) AS papers
        FROM (SELECT en.section_id, es.id AS es, CAST(m.marks_obtained AS REAL) * 100.0 / NULLIF(CAST(es.max_marks AS REAL), 0) AS pct
                FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id JOIN class_subjects cs ON cs.id = es.class_subject_id
                JOIN enrollments en ON en.student_id = m.student_id AND en.class_id = cs.class_id AND en.status = 'active'
               WHERE cs.subject_id = ? AND m.is_absent = 0 AND m.marks_obtained IS NOT NULL AND m.marks_obtained <> '')
       WHERE pct IS NOT NULL GROUP BY section_id`).bind(sid))
  const units = await all<{ class_subject_id: string; total: number; due: number }>(c.db.prepare(`
      SELECT u.class_subject_id, count(*) AS total, sum(CASE WHEN u.ends_on IS NOT NULL AND u.ends_on <= date('now') THEN 1 ELSE 0 END) AS due
        FROM syllabus_units u JOIN class_subjects cs ON cs.id = u.class_subject_id
       WHERE cs.subject_id = ? AND u.is_active = 1 GROUP BY u.class_subject_id`).bind(sid))
  const done = await all<{ section_id: string; class_subject_id: string; done: number }>(c.db.prepare(`
      SELECT lp.section_id, lp.class_subject_id, count(DISTINCT lpu.syllabus_unit_id) AS done
        FROM lesson_plans lp JOIN lesson_plan_units lpu ON lpu.lesson_plan_id = lp.id JOIN class_subjects cs ON cs.id = lp.class_subject_id
       WHERE cs.subject_id = ? AND lp.delivered_on IS NOT NULL GROUP BY lp.section_id, lp.class_subject_id`).bind(sid))
  const sections = secs.map((s) => {
    const mk = secMarks.find((x) => x.section_id === s.section_id)
    const u = units.find((x) => x.class_subject_id === s.class_subject_id)
    return {
      ...s, avg: mk?.avg ?? null, pass: mk?.pass ?? null, papers: mk?.papers ?? 0,
      units_total: u?.total ?? 0, units_due: u?.due ?? 0,
      units_done: done.find((x) => x.section_id === s.section_id && x.class_subject_id === s.class_subject_id)?.done ?? 0,
    }
  })
  const office = can(c.id, OFFICE)
  const staff = office ? await all(c.db.prepare(`SELECT u.id, u.full_name AS name FROM employees e JOIN users u ON u.id = e.user_id
      WHERE e.status = 'active' ORDER BY u.full_name`)) : []

  // Lesson plans of this subject waiting for a decision.
  const pending_plans = parts.approvals ? await all(c.db.prepare(`SELECT lp.id, lp.week_of, lp.objectives, lp.activities, lp.homework, lp.submitted_at,
        u.full_name AS teacher, cl.name || ' ' || sec.name AS class
      FROM lesson_plans lp JOIN class_subjects cs ON cs.id = lp.class_subject_id JOIN sections sec ON sec.id = lp.section_id
      JOIN classes cl ON cl.id = sec.class_id LEFT JOIN users u ON u.id = lp.teacher_user_id
     WHERE cs.subject_id = ? AND lp.status = 'submitted' ORDER BY lp.submitted_at`).bind(sid)) : []
  // Teachers the principal took out from under this head, so they can be put back.
  const removed = await all(c.db.prepare(`SELECT m.user_id AS id, u.full_name AS name FROM subject_head_members m JOIN users u ON u.id = m.user_id
      WHERE m.subject_id = ? AND m.mode = 'remove' ORDER BY u.full_name`).bind(sid))
  return ok({ subjects, subject, teachers, timetable, notices, meetings, sections, can_assign: office, staff, parts, pending_plans, removed })
}

async function createMeeting(c: Ctx) {
  const b = await readJSON<{ subject_id?: string; title?: string; agenda?: string; meets_at?: string; place?: string }>(c.req)
  if (!isUUID(b.subject_id)) throw badRequest('pick a subject')
  if (!(await mayHead(c, b.subject_id))) throw forbidden('you do not head this subject')
  const title = (b.title ?? '').trim()
  if (!title) throw badRequest('give the meeting a title')
  if (!b.meets_at || isNaN(Date.parse(b.meets_at))) throw badRequest('pick a date and time')
  const id = uuid()
  const stmts: D1PreparedStatement[] = [c.db.prepare(`INSERT INTO subject_meetings (id, institution_id, subject_id, title, agenda, meets_at, place, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, institutionId(c), b.subject_id, title, b.agenda?.trim() || null, b.meets_at, b.place?.trim() || null, c.id.userId, now())]
  const subj = await c.db.prepare(`SELECT name FROM subjects WHERE id = ?`).bind(b.subject_id).first<{ name: string }>()
  const when = new Date(b.meets_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
  let sent = 0
  for (const t of await subjectTeachers(c, b.subject_id)) {
    if (t === c.id.userId) continue
    const s = await notifyStmt(c, t, null, 'meeting', `${subj?.name ?? 'Subject'} meeting: ${title}`,
      `${when}${b.place ? ' · ' + b.place.trim() : ''}${b.agenda ? '\n' + b.agenda.trim() : ''}`, '/go/subject_meetings', 'subject_meeting', id)
    if (s) { stmts.push(s); sent++ }
  }
  await c.db.batch(stmts)
  return ok({ id, sent })
}

async function updateMeeting(c: Ctx) {
  if (!isUUID(c.params.id)) throw badRequest('meeting id must be a uuid')
  const m = await c.db.prepare(`SELECT subject_id FROM subject_meetings WHERE id = ?`).bind(c.params.id).first<{ subject_id: string }>()
  if (!m) throw notFound('meeting not found')
  if (!(await mayHead(c, m.subject_id))) throw forbidden('you do not head this subject')
  const b = await readJSON<{ minutes?: string }>(c.req)
  await c.db.prepare(`UPDATE subject_meetings SET minutes = ? WHERE id = ?`).bind(b.minutes?.trim() || null, c.params.id).run()
  return ok()
}

async function deleteMeeting(c: Ctx) {
  if (!isUUID(c.params.id)) throw badRequest('meeting id must be a uuid')
  const m = await c.db.prepare(`SELECT subject_id FROM subject_meetings WHERE id = ?`).bind(c.params.id).first<{ subject_id: string }>()
  if (!m) throw notFound('meeting not found')
  if (!(await mayHead(c, m.subject_id))) throw forbidden('you do not head this subject')
  await c.db.prepare(`DELETE FROM subject_meetings WHERE id = ?`).bind(c.params.id).run()
  return ok()
}

/** A subject head approves or returns a lesson plan of their subject (owner, 2026-10-19: approvals). */
async function decidePlan(c: Ctx) {
  if (!isUUID(c.params.id)) throw badRequest('invalid lesson plan id')
  const lp = await c.db.prepare(`SELECT cs.subject_id FROM lesson_plans lp JOIN class_subjects cs ON cs.id = lp.class_subject_id WHERE lp.id = ?`)
    .bind(c.params.id).first<{ subject_id: string }>()
  if (!lp) throw notFound('lesson plan not found')
  if (!(await mayHead(c, lp.subject_id))) throw forbidden('you do not head this subject')
  if (!(await headParts(c)).approvals) throw forbidden('this school has not given subject heads lesson plan approval')
  const b = await readJSON<{ decision?: string; remarks?: string }>(c.req)
  if (b.decision !== 'approved' && b.decision !== 'returned') throw badRequest('decision must be approved or returned')
  if (b.decision === 'returned' && !(b.remarks ?? '').trim()) throw badRequest('say why it is being returned')
  await c.db.prepare(`UPDATE lesson_plans SET status = ?, remarks = COALESCE(NULLIF(?, ''), remarks), reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`)
    .bind(b.decision, (b.remarks ?? '').trim(), c.id.userId, now(), now(), c.params.id).run()
  return ok()
}

/* EVERY SUBJECT HEAD AT ONCE, FOR THE PRINCIPAL (owner, 2026-10-19: "all
   hods performance will be there for institution admin"). One row a subject:
   its head, teachers, average, chapters done against due, plans waiting,
   meetings held. */
async function summary(c: Ctx) {
  const rows = await all<Record<string, unknown>>(c.db.prepare(`
    SELECT s.id, s.name, u.full_name AS head,
      (SELECT count(DISTINCT sst.teacher_user_id) FROM section_subject_teachers sst JOIN class_subjects cs ON cs.id = sst.class_subject_id
         JOIN sections sec ON sec.id = sst.section_id WHERE cs.subject_id = s.id AND sec.academic_year_id = ${currentYear}) AS teachers,
      (SELECT round(avg(CAST(m.marks_obtained AS REAL) * 100.0 / NULLIF(CAST(es.max_marks AS REAL), 0)), 1)
         FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id JOIN class_subjects cs ON cs.id = es.class_subject_id
        WHERE cs.subject_id = s.id AND m.is_absent = 0 AND m.marks_obtained IS NOT NULL AND m.marks_obtained <> '') AS avg,
      (SELECT count(*) FROM syllabus_units su JOIN class_subjects cs ON cs.id = su.class_subject_id WHERE cs.subject_id = s.id AND su.is_active = 1) AS units,
      (SELECT count(*) FROM syllabus_units su JOIN class_subjects cs ON cs.id = su.class_subject_id
        WHERE cs.subject_id = s.id AND su.is_active = 1 AND su.ends_on IS NOT NULL AND su.ends_on <= date('now')) AS due,
      (SELECT count(DISTINCT lpu.syllabus_unit_id) FROM lesson_plan_units lpu JOIN lesson_plans lp ON lp.id = lpu.lesson_plan_id
         JOIN class_subjects cs ON cs.id = lp.class_subject_id WHERE cs.subject_id = s.id AND lp.delivered_on IS NOT NULL) AS done,
      (SELECT count(*) FROM lesson_plans lp JOIN class_subjects cs ON cs.id = lp.class_subject_id WHERE cs.subject_id = s.id AND lp.status = 'submitted') AS plans_waiting,
      (SELECT count(*) FROM subject_meetings m WHERE m.subject_id = s.id AND m.meets_at >= date('now', '-90 days')) AS meetings
    FROM subjects s LEFT JOIN subject_heads h ON h.subject_id = s.id LEFT JOIN users u ON u.id = h.head_user_id
   WHERE EXISTS (SELECT 1 FROM class_subjects cs WHERE cs.subject_id = s.id)
   ORDER BY (h.head_user_id IS NULL), s.name`))
  return ok({ items: rows })
}

export function registerSubjectOverview(r: Router): void {
  r.get('/academics/subject-heads/settings', OFFICE, getSettings)
  r.put('/academics/subject-heads/settings', OFFICE, saveSettings)
  r.put('/academics/subject-heads/members', OFFICE, setMember)
  r.get('/academics/subject-heads/summary', OFFICE, summary)
  r.post('/teaching/my-subjects/lesson-plans/{id}/decide', 'academics.timetable.read', decidePlan)
  r.get('/academics/subject-heads', OFFICE, listHeads)
  r.put('/academics/subject-heads', OFFICE, setHead)
  r.get('/teaching/my-subjects', 'academics.timetable.read', overview)
  r.post('/teaching/my-subjects/meetings', 'academics.timetable.read', createMeeting)
  r.patch('/teaching/my-subjects/meetings/{id}', 'academics.timetable.read', updateMeeting)
  r.del('/teaching/my-subjects/meetings/{id}', 'academics.timetable.read', deleteMeeting)
}
