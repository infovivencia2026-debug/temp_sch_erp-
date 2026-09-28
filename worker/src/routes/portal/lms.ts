import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, forbidden, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { fullName, institutionId, resolveScope, todayIST } from '../teaching/common'
import { notifyMany, parseRubric } from '../teaching/lms'

/* The child's side of the LMS (the teacher's is teaching/lms.ts).

   Every read names one child: ?student_id= when the caller has several (a
   parent), otherwise their only one. A child that is not the caller's own is
   a 404, the same answer as a child that does not exist. Writes that are the
   child's own work (finishing a lesson, handing in, taking a quiz) are only
   for the child's own login: a parent can read, not do the work for them. */

const PERM = 'self.profile.read'
type Body = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const GRACE_MS = 60_000

async function child(c: Ctx, raw?: string | null): Promise<string> {
  const s = await resolveScope(c)
  if (!s.studentIds.length) throw notFound()
  const q = (raw ?? c.url.searchParams.get('student_id') ?? '').trim()
  if (q) {
    if (!s.studentIds.includes(q.toLowerCase())) throw notFound()
    return q.toLowerCase()
  }
  /* The child's own record first, when the account is a student's. */
  const own = await c.db.prepare(`SELECT id FROM students WHERE user_id = ?`).bind(c.id.userId).first<{ id: string }>()
  return own && s.studentIds.includes(own.id) ? own.id : s.studentIds[0]
}

/** The caller's own student record, for work only the child does. */
async function self(c: Ctx): Promise<{ id: string; name: string }> {
  const own = await c.db.prepare(`SELECT id, ${fullName('students')} AS name FROM students WHERE user_id = ? AND status = 'active'`).bind(c.id.userId).first<{ id: string; name: string }>()
  if (!own) throw forbidden('only the student can do this, from their own login')
  return own
}

async function classroom(c: Ctx, studentId: string) {
  const r = await c.db.prepare(`SELECT e.section_id, e.class_id, cl.name AS class_name, sec.name AS section_name FROM enrollments e
      JOIN classes cl ON cl.id = e.class_id JOIN sections sec ON sec.id = e.section_id WHERE e.student_id = ? AND e.status = 'active' ORDER BY e.enrolled_on DESC LIMIT 1`)
    .bind(studentId).first<{ section_id: string; class_id: string; class_name: string; section_name: string }>()
  if (!r) throw new HttpError(409, 'this child is not in a class this year', { code: 'not_enrolled' })
  return r
}

const lessonVisible = `l.is_published = 1 AND su.is_active = 1 AND (l.section_id IS NULL OR l.section_id = ?)`

async function todo(c: Ctx, sid: string, section: string, classId: string) {
  const today = todayIST()
  const [hw, quizzes, lessons, returned] = await c.db.batch([
    c.db.prepare(`SELECT h.id, h.title, h.kind, h.due_on, sub.name AS subject, h.class_subject_id, COALESCE(hs.status, 'pending') AS status,
        (h.due_on IS NOT NULL AND h.due_on < ?) AS overdue
        FROM homework h LEFT JOIN class_subjects cs ON cs.id = h.class_subject_id LEFT JOIN subjects sub ON sub.id = cs.subject_id
        LEFT JOIN homework_submissions hs ON hs.homework_id = h.id AND hs.student_id = ?
        WHERE h.section_id = ? AND h.is_published = 1 AND h.allow_submission = 1
          AND (hs.id IS NULL OR hs.status IN ('pending','resubmit') OR hs.submitted_at IS NULL AND hs.status <> 'graded')
          AND (h.due_on IS NULL OR h.due_on >= date(?, '-14 days'))
        ORDER BY h.due_on IS NULL, h.due_on LIMIT 30`).bind(today, sid, section, today),
    c.db.prepare(`SELECT t.id, t.title, t.closes_at, t.duration_minutes, sub.name AS subject, t.class_subject_id
        FROM online_tests t JOIN class_subjects cs ON cs.id = t.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
        WHERE t.section_id = ? AND t.status = 'published' AND (t.opens_at IS NULL OR t.opens_at <= ?) AND (t.closes_at IS NULL OR t.closes_at > ?)
          AND (SELECT count(*) FROM online_test_attempts a WHERE a.test_id = t.id AND a.student_id = ? AND a.status <> 'in_progress') < t.max_attempts
          AND NOT EXISTS (SELECT 1 FROM online_test_attempts a WHERE a.test_id = t.id AND a.student_id = ? AND a.status <> 'in_progress')
        ORDER BY t.closes_at IS NULL, t.closes_at LIMIT 20`).bind(section, now(), now(), sid, sid),
    c.db.prepare(`SELECT l.id, l.title, l.kind, sub.name AS subject, su.class_subject_id, su.title AS unit
        FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id JOIN class_subjects cs ON cs.id = su.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
        WHERE cs.class_id = ? AND ${lessonVisible} AND NOT EXISTS (SELECT 1 FROM lms_lesson_progress p WHERE p.lesson_id = l.id AND p.student_id = ?)
        ORDER BY su.sequence, l.sequence LIMIT 8`).bind(classId, section, sid),
    c.db.prepare(`SELECT h.id, h.title, sub.name AS subject, h.class_subject_id, CAST(hs.marks AS REAL) AS marks, CAST(h.max_marks AS REAL) AS max_marks, hs.feedback, hs.status, hs.returned_at
        FROM homework_submissions hs JOIN homework h ON h.id = hs.homework_id LEFT JOIN class_subjects cs ON cs.id = h.class_subject_id LEFT JOIN subjects sub ON sub.id = cs.subject_id
        WHERE hs.student_id = ? AND hs.returned_at IS NOT NULL ORDER BY hs.returned_at DESC LIMIT 5`).bind(sid),
  ])
  return {
    assignments: (hw.results as Record<string, unknown>[]).map((h) => ({ ...h, overdue: !!h.overdue })),
    quizzes: quizzes.results, lessons: lessons.results, returned: returned.results,
  }
}

export function registerPortalLMS(r: Router) {
  /* Every subject of the child's class, with progress. */
  r.get('/portal/lms/courses', PERM, async (c) => {
    const sid = await child(c)
    const k = await classroom(c, sid)
    const rows = await c.db.prepare(`SELECT cs.id AS class_subject_id, sub.name AS subject, sub.code,
        (SELECT u.full_name FROM section_subject_teachers t JOIN users u ON u.id = t.teacher_user_id WHERE t.section_id = ? AND t.class_subject_id = cs.id LIMIT 1) AS teacher,
        (SELECT count(*) FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id WHERE su.class_subject_id = cs.id AND ${lessonVisible}) AS lessons,
        (SELECT count(*) FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id JOIN lms_lesson_progress p ON p.lesson_id = l.id AND p.student_id = ?
          WHERE su.class_subject_id = cs.id AND ${lessonVisible}) AS completed,
        (SELECT count(*) FROM homework h LEFT JOIN homework_submissions hs ON hs.homework_id = h.id AND hs.student_id = ?
          WHERE h.section_id = ? AND h.class_subject_id = cs.id AND h.is_published = 1 AND h.allow_submission = 1
            AND (hs.id IS NULL OR hs.status IN ('pending','resubmit'))) AS to_do,
        (SELECT count(*) FROM online_tests t WHERE t.section_id = ? AND t.class_subject_id = cs.id AND t.status = 'published'
            AND (t.closes_at IS NULL OR t.closes_at > ?) AND NOT EXISTS (SELECT 1 FROM online_test_attempts a WHERE a.test_id = t.id AND a.student_id = ? AND a.status <> 'in_progress')) AS quizzes_open
        FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id WHERE cs.class_id = ? ORDER BY sub.name`)
      .bind(k.section_id, k.section_id, sid, k.section_id, sid, k.section_id, k.section_id, now(), sid, k.class_id).all()
    return ok({ student_id: sid, class_name: k.class_name, section_name: k.section_name, items: rows.results })
  })

  /* One subject: units and lessons (with done), assignments (with my work), quizzes (with my attempts). */
  r.get('/portal/lms/course', PERM, async (c) => {
    const sid = await child(c)
    const k = await classroom(c, sid)
    const cs = str(c.url.searchParams.get('class_subject_id'))
    if (!isUUID(cs)) throw notFound()
    const co = await c.db.prepare(`SELECT cs.id AS class_subject_id, sub.name AS subject,
        (SELECT u.full_name FROM section_subject_teachers t JOIN users u ON u.id = t.teacher_user_id WHERE t.section_id = ? AND t.class_subject_id = cs.id LIMIT 1) AS teacher
        FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id WHERE cs.id = ? AND cs.class_id = ?`).bind(k.section_id, cs, k.class_id).first()
    if (!co) throw notFound()
    const [units, lessons, hw, quizzes] = await c.db.batch([
      c.db.prepare(`SELECT id, title, description, sequence FROM syllabus_units WHERE class_subject_id = ? AND is_active = 1 ORDER BY sequence, created_at`).bind(cs),
      c.db.prepare(`SELECT l.id, l.unit_id, l.title, l.kind, l.body, l.file_id, f.original_name AS file_name, l.url, l.sequence, p.completed_at
          FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id LEFT JOIN files f ON f.id = l.file_id AND f.deleted_at IS NULL
          LEFT JOIN lms_lesson_progress p ON p.lesson_id = l.id AND p.student_id = ?
          WHERE su.class_subject_id = ? AND ${lessonVisible} ORDER BY l.sequence, l.created_at`).bind(sid, cs, k.section_id),
      c.db.prepare(`SELECT h.id, h.kind, h.title, h.instructions, h.assigned_on, h.due_on, CAST(h.max_marks AS REAL) AS max_marks, h.rubric, h.allow_submission,
          COALESCE(hs.status, 'pending') AS status, hs.submitted_at, hs.text_answer, hs.file_id, f.original_name AS file_name, hs.returned_at,
          CASE WHEN hs.returned_at IS NOT NULL THEN CAST(hs.marks AS REAL) END AS marks,
          CASE WHEN hs.returned_at IS NOT NULL THEN hs.feedback END AS feedback,
          CASE WHEN hs.returned_at IS NOT NULL THEN hs.rubric_scores END AS rubric_scores,
          COALESCE((SELECT json_group_array(json_object('file_id', af.id, 'name', af.original_name)) FROM homework_attachments ha JOIN files af ON af.id = ha.file_id AND af.deleted_at IS NULL WHERE ha.homework_id = h.id), '[]') AS files
          FROM homework h LEFT JOIN homework_submissions hs ON hs.homework_id = h.id AND hs.student_id = ? LEFT JOIN files f ON f.id = hs.file_id AND f.deleted_at IS NULL
          WHERE h.section_id = ? AND h.class_subject_id = ? AND h.is_published = 1 ORDER BY h.due_on IS NULL, h.due_on DESC, h.assigned_on DESC`).bind(sid, k.section_id, cs),
      c.db.prepare(`SELECT t.id, t.title, t.instructions, t.opens_at, t.closes_at, t.duration_minutes, t.max_attempts,
          (SELECT count(*) FROM online_test_questions q WHERE q.test_id = t.id) AS questions,
          (SELECT sum(CAST(q.marks AS REAL)) FROM online_test_questions q WHERE q.test_id = t.id) AS max_score,
          (SELECT count(*) FROM online_test_attempts a WHERE a.test_id = t.id AND a.student_id = ? AND a.status <> 'in_progress') AS attempts,
          (SELECT max(CAST(a.score AS REAL)) FROM online_test_attempts a WHERE a.test_id = t.id AND a.student_id = ? AND a.status <> 'in_progress') AS best,
          (SELECT a.id FROM online_test_attempts a WHERE a.test_id = t.id AND a.student_id = ? AND a.status = 'in_progress' LIMIT 1) AS open_attempt
          FROM online_tests t WHERE t.section_id = ? AND t.class_subject_id = ? AND t.status IN ('published','closed') ORDER BY t.created_at DESC`).bind(sid, sid, sid, k.section_id, cs),
    ])
    const today = todayIST(), t = now()
    const ls = lessons.results as Record<string, unknown>[]
    return ok({
      student_id: sid, course: co, today,
      units: (units.results as Record<string, unknown>[]).map((u) => ({ ...u, lessons: ls.filter((l) => l.unit_id === u.id).map((l) => ({ ...l, done: !!l.completed_at })) }))
        .filter((u) => u.lessons.length > 0),
      assignments: (hw.results as Record<string, unknown>[]).map((h) => {
        let files: unknown[] = [], rs: unknown = null
        try { files = JSON.parse(String(h.files)) } catch { files = [] }
        try { rs = h.rubric_scores ? JSON.parse(String(h.rubric_scores)) : null } catch { rs = null }
        const submitted = !!h.submitted_at && h.status !== 'resubmit'
        return { ...h, files, rubric: parseRubric(h.rubric), rubric_scores: rs, allow_submission: !!h.allow_submission,
          overdue: !submitted && !!h.due_on && String(h.due_on) < today, late: h.status === 'late' }
      }),
      quizzes: (quizzes.results as Record<string, unknown>[]).map((q) => ({ ...q,
        open: (!q.opens_at || String(q.opens_at) <= t) && (!q.closes_at || String(q.closes_at) > t) && Number(q.attempts) < Number(q.max_attempts) })),
    })
  })

  r.get('/portal/lms/todo', PERM, async (c) => {
    const sid = await child(c)
    const k = await classroom(c, sid)
    return ok({ student_id: sid, ...(await todo(c, sid, k.section_id, k.class_id)) })
  })

  /* The student home's second row: to-do, recent marks, notices and library loans. */
  r.get('/portal/lms/home', PERM, async (c) => {
    const sid = await child(c)
    const k = await classroom(c, sid)
    const t = now()
    const [marks, notices, loans] = await c.db.batch([
      c.db.prepare(`SELECT ex.name AS exam, sub.name AS subject, CAST(m.marks_obtained AS REAL) + COALESCE(CAST(m.grace_marks AS REAL), 0) AS obtained,
          CAST(es.max_marks AS REAL) AS max_marks, m.grade, m.is_absent, ex.published_at
          FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id JOIN exams ex ON ex.id = es.exam_id AND ex.is_published = 1
          JOIN class_subjects cs ON cs.id = es.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
          WHERE m.student_id = ? ORDER BY ex.published_at DESC, sub.name LIMIT 8`).bind(sid),
      c.db.prepare(`SELECT a.id, a.title, substr(a.body, 1, 240) AS body, a.publish_at, a.kind FROM announcements a
          WHERE a.audience_role IN ('all','students') AND a.publish_at <= ? AND (a.expires_at IS NULL OR a.expires_at > ?)
            AND (NOT EXISTS (SELECT 1 FROM announcement_sections s WHERE s.announcement_id = a.id)
                 OR EXISTS (SELECT 1 FROM announcement_sections s WHERE s.announcement_id = a.id AND s.section_id = ?))
          ORDER BY a.publish_at DESC LIMIT 5`).bind(t, t, k.section_id),
      c.db.prepare(`SELECT lt.title, l.issued_on, l.due_on, (l.due_on < ?) AS overdue FROM library_loans l JOIN library_copies lc ON lc.id = l.copy_id
          JOIN library_titles lt ON lt.id = lc.title_id WHERE l.student_id = ? AND l.returned_on IS NULL ORDER BY l.due_on`).bind(todayIST(), sid),
    ])
    return ok({ student_id: sid, class_name: k.class_name, section_name: k.section_name,
      todo: await todo(c, sid, k.section_id, k.class_id), marks: marks.results, notices: notices.results,
      library: (loans.results as Record<string, unknown>[]).map((l) => ({ ...l, overdue: !!l.overdue })) })
  })

  r.post('/portal/lms/lessons/{id}/complete', PERM, async (c) => {
    const me = await self(c)
    const k = await classroom(c, me.id)
    const id = str(c.params.id)
    if (!isUUID(id)) throw notFound()
    const l = await c.db.prepare(`SELECT l.id FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id JOIN class_subjects cs ON cs.id = su.class_subject_id
        WHERE l.id = ? AND cs.class_id = ? AND ${lessonVisible}`).bind(id, k.class_id, k.section_id).first<{ id: string }>()
    if (!l) throw notFound()
    const b = await readJSON<Body>(c.req).catch(() => ({} as Body))
    if (b.done === false) {
      await c.db.prepare(`DELETE FROM lms_lesson_progress WHERE lesson_id = ? AND student_id = ?`).bind(l.id, me.id).run()
      return ok({ id: l.id, done: false })
    }
    await c.db.prepare(`INSERT OR IGNORE INTO lms_lesson_progress (institution_id, lesson_id, student_id, completed_at) VALUES (?, ?, ?, ?)`)
      .bind(institutionId(c), l.id, me.id, now()).run()
    return ok({ id: l.id, done: true })
  })

  /* Hand in: text, a file, or both. Late when handed in after the due date. */
  r.post('/portal/lms/assignments/{id}/submit', PERM, async (c) => {
    const me = await self(c)
    const k = await classroom(c, me.id)
    const id = str(c.params.id)
    if (!isUUID(id)) throw notFound()
    const h = await c.db.prepare(`SELECT id, title, due_on, allow_submission, created_by FROM homework WHERE id = ? AND section_id = ? AND is_published = 1`)
      .bind(id, k.section_id).first<{ id: string; title: string; due_on: string | null; allow_submission: number; created_by: string | null }>()
    if (!h) throw notFound()
    if (!h.allow_submission) throw badRequest('this work is done in class or in the notebook, not handed in here')
    const b = await readJSON<Body>(c.req)
    const text = typeof b.text_answer === 'string' ? b.text_answer.trim().slice(0, 20_000) : ''
    const fileId = str(b.file_id)
    if (fileId && !isUUID(fileId)) throw badRequest('file_id must be a uuid')
    if (!text && !fileId) throw badRequest('write an answer or attach a file')
    if (fileId) {
      const f = await c.db.prepare(`SELECT 1 AS x FROM files WHERE id = ? AND deleted_at IS NULL`).bind(fileId).first()
      if (!f) throw badRequest('that file is not there any more; attach it again')
    }
    const prev = await c.db.prepare(`SELECT status, returned_at FROM homework_submissions WHERE homework_id = ? AND student_id = ?`).bind(h.id, me.id).first<{ status: string; returned_at: string | null }>()
    if (prev?.status === 'graded') throw new HttpError(409, 'this work has already been marked; ask your teacher if you need to hand it in again', { code: 'already_graded' })
    const late = !!h.due_on && todayIST() > h.due_on
    const status = late ? 'late' : 'submitted'
    const t = now()
    const stmts: D1PreparedStatement[] = [c.db.prepare(`INSERT INTO homework_submissions (id, institution_id, homework_id, student_id, submitted_at, text_answer, file_id, status, submitted_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (homework_id, student_id) DO UPDATE SET submitted_at = excluded.submitted_at, text_answer = excluded.text_answer, file_id = excluded.file_id,
          status = excluded.status, submitted_by = excluded.submitted_by, returned_at = NULL`)
      .bind(uuid(), institutionId(c), h.id, me.id, t, text || null, fileId || null, status, c.id.userId)]
    if (h.created_by) stmts.push(...notifyMany(c, [{ user: h.created_by, student: me.id }], 'homework_submitted', `${me.name} handed in ${h.title}`, late ? 'Handed in after the due date.' : 'Ready to mark.', '/go/assignments_submissions', 'homework_submitted', h.id))
    await c.db.batch(stmts)
    return ok({ id: h.id, status, late, submitted_at: t })
  })

  /* Start (or resume) a quiz attempt. The questions come without their answers. */
  r.post('/portal/lms/quizzes/{id}/start', PERM, async (c) => {
    const me = await self(c)
    const k = await classroom(c, me.id)
    const id = str(c.params.id)
    if (!isUUID(id)) throw notFound()
    const q = await c.db.prepare(`SELECT id, title, instructions, opens_at, closes_at, duration_minutes, max_attempts, shuffle_questions, status FROM online_tests WHERE id = ? AND section_id = ?`)
      .bind(id, k.section_id).first<{ id: string; title: string; instructions: string | null; opens_at: string | null; closes_at: string | null; duration_minutes: number | null; max_attempts: number; shuffle_questions: number; status: string }>()
    if (!q || q.status === 'draft') throw notFound()
    const t = now()
    let a = await c.db.prepare(`SELECT id, started_at, attempt_no FROM online_test_attempts WHERE test_id = ? AND student_id = ? AND status = 'in_progress' ORDER BY started_at DESC LIMIT 1`)
      .bind(q.id, me.id).first<{ id: string; started_at: string; attempt_no: number }>()
    if (!a) {
      if (q.status !== 'published') throw new HttpError(409, 'this quiz is closed', { code: 'quiz_closed' })
      if (q.opens_at && q.opens_at > t) throw new HttpError(409, 'this quiz has not opened yet', { code: 'quiz_not_open' })
      if (q.closes_at && q.closes_at <= t) throw new HttpError(409, 'this quiz has closed', { code: 'quiz_closed' })
      const done = await c.db.prepare(`SELECT count(*) AS n FROM online_test_attempts WHERE test_id = ? AND student_id = ?`).bind(q.id, me.id).first<{ n: number }>()
      if ((done?.n ?? 0) >= q.max_attempts) throw new HttpError(409, 'you have used every attempt at this quiz', { code: 'no_attempts_left' })
      const aid = uuid()
      await c.db.prepare(`INSERT INTO online_test_attempts (id, institution_id, test_id, student_id, attempt_no, source, status, started_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'online', 'in_progress', ?, ?, ?)`).bind(aid, institutionId(c), q.id, me.id, (done?.n ?? 0) + 1, t, t, t).run()
      a = { id: aid, started_at: t, attempt_no: (done?.n ?? 0) + 1 }
    }
    let deadline: string | null = q.duration_minutes ? new Date(Date.parse(a.started_at) + q.duration_minutes * 60_000).toISOString() : null
    if (q.closes_at && (!deadline || q.closes_at < deadline)) deadline = q.closes_at
    const rows = await c.db.prepare(`SELECT tq.id AS test_question_id, tq.sequence, CAST(tq.marks AS REAL) AS marks, qq.stem,
        (SELECT json_group_array(json_object('id', o.id, 'body', o.body)) FROM (SELECT id, body FROM question_bank_options WHERE question_id = qq.id ORDER BY sequence) o) AS options
        FROM online_test_questions tq JOIN question_bank_questions qq ON qq.id = tq.question_id WHERE tq.test_id = ? ORDER BY tq.sequence`).bind(q.id).all<Record<string, unknown>>()
    let questions = rows.results.map((r) => ({ ...r, options: JSON.parse(String(r.options ?? '[]')) as unknown[] }))
    if (q.shuffle_questions) {
      /* Stable per attempt, so a reload does not reorder the page under the child. */
      const seed = [...a.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)
      questions = questions.map((x, i) => ({ x, k: (seed ^ (i * 2654435761)) >>> 0 })).sort((p1, p2) => p1.k - p2.k).map((y) => y.x)
    }
    return ok({ attempt_id: a.id, attempt_no: a.attempt_no, started_at: a.started_at, deadline, server_now: t,
      quiz: { id: q.id, title: q.title, instructions: q.instructions, duration_minutes: q.duration_minutes }, questions })
  })

  /* Hand in a quiz: marked at once. After the time limit (plus a minute's grace) the answers are not accepted. */
  r.post('/portal/lms/quizzes/{id}/submit', PERM, async (c) => {
    const me = await self(c)
    const id = str(c.params.id)
    if (!isUUID(id)) throw notFound()
    const b = await readJSON<Body>(c.req)
    const aid = str(b.attempt_id)
    if (!isUUID(aid)) throw badRequest('attempt_id is required')
    const a = await c.db.prepare(`SELECT a.id, a.started_at, a.status, t.duration_minutes, t.closes_at, t.max_attempts,
        (SELECT count(*) FROM online_test_attempts x WHERE x.test_id = t.id AND x.student_id = a.student_id) AS used FROM online_test_attempts a JOIN online_tests t ON t.id = a.test_id
        WHERE a.id = ? AND a.test_id = ? AND a.student_id = ?`).bind(aid, id, me.id)
      .first<{ id: string; started_at: string; status: string; duration_minutes: number | null; closes_at: string | null; max_attempts: number; used: number }>()
    if (!a) throw notFound()
    if (a.status !== 'in_progress') throw new HttpError(409, 'this attempt has already been handed in', { code: 'already_submitted' })
    let deadline = a.duration_minutes ? Date.parse(a.started_at) + a.duration_minutes * 60_000 : Infinity
    if (a.closes_at) deadline = Math.min(deadline, Date.parse(a.closes_at))
    const timedOut = Date.now() > deadline + GRACE_MS
    const key = await c.db.prepare(`SELECT tq.id, CAST(tq.marks AS REAL) AS marks, CAST(tq.negative_marks AS REAL) AS neg,
        (SELECT o.id FROM question_bank_options o WHERE o.question_id = tq.question_id AND o.is_correct = 1 ORDER BY o.sequence LIMIT 1) AS correct
        FROM online_test_questions tq WHERE tq.test_id = ?`).bind(id).all<{ id: string; marks: number; neg: number; correct: string | null }>()
    const answers = (!timedOut && b.answers && typeof b.answers === 'object') ? b.answers as Record<string, unknown> : {}
    let score = 0, max = 0
    const t = now(), inst = institutionId(c)
    const stmts: D1PreparedStatement[] = []
    const review: { test_question_id: string; chosen: string | null; correct: string | null; right: boolean }[] = []
    for (const k of key.results) {
      max += k.marks
      const chosen = typeof answers[k.id] === 'string' && isUUID(answers[k.id] as string) ? answers[k.id] as string : null
      const right = !!chosen && chosen === k.correct
      const got = right ? k.marks : chosen ? -k.neg : 0
      score += got
      review.push({ test_question_id: k.id, chosen, correct: k.correct, right })
      if (chosen) stmts.push(c.db.prepare(`INSERT INTO online_test_responses (id, institution_id, attempt_id, test_question_id, selected_option_ids, is_correct, marks_awarded, answered_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst, a.id, k.id, JSON.stringify([chosen]), right ? 1 : 0, String(got), t))
    }
    score = Math.max(0, score)
    stmts.push(c.db.prepare(`UPDATE online_test_attempts SET status = ?, submitted_at = ?, score = ?, max_score = ?, graded_at = ?, updated_at = ? WHERE id = ? AND status = 'in_progress'`)
      .bind(timedOut ? 'timed_out' : 'graded', t, String(score), String(max), t, t, a.id))
    await c.db.batch(stmts)
    return ok({ attempt_id: a.id, score, max_score: max, timed_out: timedOut, /* The answers are shown only once no attempt is left, or a retake would be a copy. */
      review: timedOut || a.used < a.max_attempts ? [] : review })
  })
}
