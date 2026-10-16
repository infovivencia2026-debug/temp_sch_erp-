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
    return all(c.db.prepare(`SELECT s.id, s.name FROM subject_heads h JOIN subjects s ON s.id = h.subject_id ORDER BY s.name`))
  }
  return all(c.db.prepare(`SELECT s.id, s.name FROM subject_heads h JOIN subjects s ON s.id = h.subject_id WHERE h.head_user_id = ? ORDER BY s.name`).bind(c.id.userId))
}

async function mayHead(c: Ctx, subjectId: string): Promise<boolean> {
  if (can(c.id, OFFICE)) return true
  return !!(await c.db.prepare(`SELECT 1 AS x FROM subject_heads WHERE subject_id = ? AND head_user_id = ?`).bind(subjectId, c.id.userId).first())
}

const currentYear = `(SELECT id FROM academic_years WHERE is_current = 1 LIMIT 1)`

/** Everyone teaching this subject this year: subject teachers plus whoever the timetable puts in front of it. */
async function subjectTeachers(c: Ctx, subjectId: string): Promise<string[]> {
  const r = await all<{ u: string }>(c.db.prepare(`
      SELECT sst.teacher_user_id AS u FROM section_subject_teachers sst
        JOIN class_subjects cs ON cs.id = sst.class_subject_id JOIN sections sec ON sec.id = sst.section_id
       WHERE cs.subject_id = ?1 AND sec.academic_year_id = ${currentYear}
      UNION
      SELECT te.teacher_user_id FROM timetable_entries te JOIN class_subjects cs ON cs.id = te.class_subject_id
       WHERE cs.subject_id = ?1 AND te.teacher_user_id IS NOT NULL AND te.academic_year_id = ${currentYear}`).bind(subjectId))
  return r.map((x) => x.u)
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
  if (!b.head_user_id) {
    await c.db.prepare(`DELETE FROM subject_heads WHERE subject_id = ?`).bind(b.subject_id).run()
    return ok()
  }
  if (!isUUID(b.head_user_id)) throw badRequest('pick a member of staff')
  await c.db.prepare(`INSERT INTO subject_heads (subject_id, institution_id, head_user_id) VALUES (?, ?, ?)
      ON CONFLICT (subject_id) DO UPDATE SET head_user_id = excluded.head_user_id`).bind(b.subject_id, institutionId(c), b.head_user_id).run()
  return ok()
}

// ---- the head: one subject at a time ------------------------------------

async function overview(c: Ctx) {
  const subjects = await viewableSubjects(c)
  const want = c.url.searchParams.get('subject')
  const subject = subjects.find((s) => s.id === want) ?? subjects[0]
  if (!subject) return ok({ subjects, subject: null, teachers: [], timetable: [], notices: [], meetings: [] })
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
    }
  })

  // This subject's timetable, every class.
  const timetable = await all(c.db.prepare(`
      SELECT te.weekday, p.name AS period, p.sequence, p.starts_at, p.ends_at, cl.name || ' ' || sec.name AS class, cl.level, u.full_name AS teacher, te.room
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

  const meetings = await all(c.db.prepare(`SELECT m.id, m.title, m.agenda, m.meets_at, m.place, m.minutes, u.full_name AS by_name
      FROM subject_meetings m LEFT JOIN users u ON u.id = m.created_by WHERE m.subject_id = ? ORDER BY m.meets_at DESC LIMIT 50`).bind(sid))

  return ok({ subjects, subject, teachers, timetable, notices, meetings })
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
      `${when}${b.place ? ' · ' + b.place.trim() : ''}${b.agenda ? '\n' + b.agenda.trim() : ''}`, '', 'subject_meeting', id)
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

export function registerSubjectOverview(r: Router): void {
  r.get('/academics/subject-heads', OFFICE, listHeads)
  r.put('/academics/subject-heads', OFFICE, setHead)
  r.get('/teaching/my-subjects', 'academics.timetable.read', overview)
  r.post('/teaching/my-subjects/meetings', 'academics.timetable.read', createMeeting)
  r.patch('/teaching/my-subjects/meetings/{id}', 'academics.timetable.read', updateMeeting)
  r.del('/teaching/my-subjects/meetings/{id}', 'academics.timetable.read', deleteMeeting)
}
