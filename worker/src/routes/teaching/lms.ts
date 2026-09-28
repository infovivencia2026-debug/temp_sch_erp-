import type { Router, Ctx } from '../../router'
import { badRequest, forbidden, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { fullName, institutionId, marks, js, requirePerm, resolveScope, todayIST, type Scope } from './common'
import { reachesSection } from './classwork'
import { AI_MODEL, aiConfigured, aiGenerate, NOT_CONFIGURED_MSG, parseJsonObject } from '../../services/ai/llm'
import { assistantRateLimit } from './gemini'

/* The teacher's side of the LMS. A course is one subject in one section
   (class_subjects x sections). It is built from what the school already
   records:
     units        syllabus_units (per class subject, shared by its sections)
     lessons      lms_lessons (0007), optionally for one section only
     assignments  homework + homework_submissions, with a rubric (0007)
     quizzes      online_tests over question_bank_questions / _options
   Reach is the same as classwork.ts: a section the caller teaches, is class
   teacher of or heads (Scope.sectionIds), or every section for a caller with
   students.read.all. Writes also need academics.homework.write. */

const P = 'academics.timetable.read'
const HW = 'academics.homework.write'
const LESSON_KINDS = new Set(['text', 'file', 'pdf', 'video', 'link'])

type Body = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const optStr = (v: unknown) => { const s = str(v); return s === '' ? null : s }
const needUUID = (v: unknown, what: string) => { const s = str(v); if (!isUUID(s)) throw badRequest(`${what} must be a uuid`); return s.toLowerCase() }
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

export interface RubricRow { criterion: string; max: number }
export function parseRubric(v: unknown): RubricRow[] | null {
  if (v === null || v === undefined || v === '') return null
  let a: unknown = v
  if (typeof v === 'string') { try { a = JSON.parse(v) } catch { return null } }
  if (!Array.isArray(a)) return null
  const out: RubricRow[] = []
  for (const r of a) {
    const o = r as Record<string, unknown>
    const criterion = str(o?.criterion)
    const max = Number(o?.max)
    if (!criterion || !Number.isFinite(max) || max <= 0) continue
    out.push({ criterion: criterion.slice(0, 80), max })
  }
  return out.length ? out.slice(0, 12) : null
}

/** A notification to each user, one statement per person. */
export function notifyMany(c: Ctx, rows: { user: string; student: string | null }[], kind: string, title: string, body: string, link: string, sourceKind: string, sourceId: string) {
  const inst = institutionId(c), t = now()
  return rows.map((r) => c.db.prepare(`INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, source_kind, source_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst, r.user, r.student, kind, title.slice(0, 200), body.slice(0, 400), link, sourceKind, sourceId, t))
}

/** The accounts to tell about a set of students: the child's own login and/or each guardian's. */
export async function recipients(c: Ctx, studentIds: string[], who: 'students' | 'parents' | 'both'): Promise<{ user: string; student: string | null }[]> {
  if (!studentIds.length) return []
  const out: { user: string; student: string | null }[] = []
  if (who !== 'parents') {
    const r = await c.db.prepare(`SELECT id, user_id FROM students WHERE id IN (${marks()}) AND user_id IS NOT NULL`).bind(js(studentIds)).all<{ id: string; user_id: string }>()
    for (const x of r.results) out.push({ user: x.user_id, student: x.id })
  }
  if (who !== 'students') {
    const r = await c.db.prepare(`SELECT DISTINCT sg.student_id, g.user_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
        WHERE sg.student_id IN (${marks()}) AND g.user_id IS NOT NULL AND sg.portal_blocked = 0
          AND (sg.access_until IS NULL OR sg.access_until >= date('now'))`).bind(js(studentIds)).all<{ student_id: string; user_id: string }>()
    for (const x of r.results) out.push({ user: x.user_id, student: x.student_id })
  }
  return out
}

async function sectionRoll(c: Ctx, sectionId: string): Promise<string[]> {
  const r = await c.db.prepare(`SELECT student_id FROM enrollments WHERE section_id = ? AND status = 'active'`).bind(sectionId).all<{ student_id: string }>()
  return r.results.map((x) => x.student_id)
}

/** The course a section and class subject make, or 404/403. */
async function course(c: Ctx, s: Scope, sectionId: string, csId: string) {
  const row = await c.db.prepare(`SELECT sec.id AS section_id, sec.name AS section_name, cl.id AS class_id, cl.name AS class_name, cs.id AS class_subject_id,
      sub.name AS subject, cs.max_marks FROM sections sec JOIN classes cl ON cl.id = sec.class_id JOIN class_subjects cs ON cs.class_id = cl.id
      JOIN subjects sub ON sub.id = cs.subject_id WHERE sec.id = ? AND cs.id = ?`).bind(sectionId, csId)
    .first<{ section_id: string; section_name: string; class_id: string; class_name: string; class_subject_id: string; subject: string }>()
  if (!row) throw notFound('no such course')
  if (!reachesSection(s, sectionId)) throw forbidden('this section is not one you teach')
  return row
}

async function unitInReach(c: Ctx, s: Scope, unitId: string) {
  const u = await c.db.prepare(`SELECT su.id, su.class_subject_id, cs.class_id FROM syllabus_units su JOIN class_subjects cs ON cs.id = su.class_subject_id WHERE su.id = ?`)
    .bind(unitId).first<{ id: string; class_subject_id: string; class_id: string }>()
  if (!u) throw notFound('no such unit')
  if (!s.allStudents) {
    const hit = await c.db.prepare(`SELECT 1 AS x FROM sections WHERE class_id = ? AND id IN (${marks()}) LIMIT 1`).bind(u.class_id, js(s.sectionIds)).first()
    if (!hit) throw forbidden('this unit is for a class you do not teach')
  }
  return u
}

async function assignmentInReach(c: Ctx, s: Scope, id: string) {
  if (!isUUID(id)) throw notFound()
  const h = await c.db.prepare(`SELECT h.id, h.section_id, h.class_subject_id, h.title, h.due_on, h.max_marks, h.rubric, h.kind, h.allow_submission,
      sub.name AS subject FROM homework h LEFT JOIN class_subjects cs ON cs.id = h.class_subject_id LEFT JOIN subjects sub ON sub.id = cs.subject_id WHERE h.id = ?`)
    .bind(id).first<{ id: string; section_id: string; class_subject_id: string | null; title: string; due_on: string | null; max_marks: string | null; rubric: string | null; kind: string; allow_submission: number; subject: string | null }>()
  if (!h || !reachesSection(s, h.section_id)) throw notFound()
  return h
}

export function registerLMS(r: Router) {
  /* Every course the caller can teach, with what is in it. */
  r.get('/lms/courses', P, async (c) => {
    const s = await resolveScope(c)
    if (!s.allStudents && !s.sectionIds.length) return ok({ items: [] })
    const mineOnly = !s.allStudents || c.url.searchParams.get('mine') === '1'
    /* A teacher sees the subjects they are allocated; a class teacher also every subject of their own section. */
    const rows = await c.db.prepare(`
      SELECT sec.id AS section_id, sec.name AS section_name, cl.name AS class_name, cl.level, cs.id AS class_subject_id, sub.name AS subject,
        (SELECT u.full_name FROM section_subject_teachers t JOIN users u ON u.id = t.teacher_user_id WHERE t.section_id = sec.id AND t.class_subject_id = cs.id LIMIT 1) AS teacher,
        (SELECT count(*) FROM syllabus_units su WHERE su.class_subject_id = cs.id AND su.is_active = 1) AS units,
        (SELECT count(*) FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id WHERE su.class_subject_id = cs.id AND su.is_active = 1 AND (l.section_id IS NULL OR l.section_id = sec.id)) AS lessons,
        (SELECT count(*) FROM homework h WHERE h.section_id = sec.id AND h.class_subject_id = cs.id) AS assignments,
        (SELECT count(*) FROM homework h JOIN homework_submissions hs ON hs.homework_id = h.id WHERE h.section_id = sec.id AND h.class_subject_id = cs.id AND hs.status IN ('submitted','late')) AS to_mark,
        (SELECT count(*) FROM online_tests t WHERE t.section_id = sec.id AND t.class_subject_id = cs.id) AS quizzes,
        (SELECT count(*) FROM enrollments e WHERE e.section_id = sec.id AND e.status = 'active') AS roll
      FROM sections sec JOIN classes cl ON cl.id = sec.class_id JOIN class_subjects cs ON cs.class_id = cl.id JOIN subjects sub ON sub.id = cs.subject_id
      WHERE ${mineOnly ? `(EXISTS (SELECT 1 FROM section_subject_teachers t WHERE t.section_id = sec.id AND t.class_subject_id = cs.id AND t.teacher_user_id = ?)
                 OR sec.class_teacher_id = ? ${s.allStudents ? '' : `OR (sec.id IN (${marks()}) AND NOT EXISTS (SELECT 1 FROM section_subject_teachers t2 WHERE t2.teacher_user_id = ?))`})` : '1'}
      ORDER BY cl.level, cl.name, sec.name, sub.name LIMIT 400`)
      .bind(...(mineOnly ? [s.userId, s.userId, ...(s.allStudents ? [] : [js(s.sectionIds), s.userId])] : []))
      .all<Record<string, unknown>>()
    return ok({ items: rows.results })
  })

  /* One course: units and lessons with completion, assignments and quizzes. */
  r.get('/lms/course', P, async (c) => {
    const s = await resolveScope(c)
    const q = c.url.searchParams
    const co = await course(c, s, needUUID(q.get('section_id'), 'section_id'), needUUID(q.get('class_subject_id'), 'class_subject_id'))
    const [units, lessons, hw, quizzes, roll] = await c.db.batch([
      c.db.prepare(`SELECT id, title, description, sequence FROM syllabus_units WHERE class_subject_id = ? AND is_active = 1 ORDER BY sequence, created_at`).bind(co.class_subject_id),
      c.db.prepare(`SELECT l.id, l.unit_id, l.section_id, l.title, l.kind, l.body, l.file_id, f.original_name AS file_name, l.url, l.sequence, l.is_published, l.created_at, l.day, l.publish_at,
          (SELECT count(*) FROM lms_lesson_progress p JOIN enrollments e ON e.student_id = p.student_id AND e.section_id = ? AND e.status = 'active' WHERE p.lesson_id = l.id) AS completed
          FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id LEFT JOIN files f ON f.id = l.file_id
          WHERE su.class_subject_id = ? AND (l.section_id IS NULL OR l.section_id = ?) ORDER BY l.day IS NULL, l.day, l.sequence, l.created_at`).bind(co.section_id, co.class_subject_id, co.section_id),
      c.db.prepare(`SELECT h.id, h.kind, h.title, h.instructions, h.assigned_on, h.due_on, CAST(h.max_marks AS REAL) AS max_marks, h.rubric, h.allow_submission,
          (SELECT count(*) FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.status IN ('submitted','late','graded')) AS submitted,
          (SELECT count(*) FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.status IN ('submitted','late')) AS to_mark,
          (SELECT count(*) FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.status = 'graded') AS graded,
          (SELECT count(*) FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.returned_at IS NOT NULL) AS returned
          FROM homework h WHERE h.section_id = ? AND h.class_subject_id = ? ORDER BY h.assigned_on DESC, h.created_at DESC`).bind(co.section_id, co.class_subject_id),
      c.db.prepare(`SELECT t.id, t.title, t.instructions, t.status, t.opens_at, t.closes_at, t.duration_minutes, t.max_attempts,
          (SELECT count(*) FROM online_test_questions q WHERE q.test_id = t.id) AS questions,
          (SELECT count(DISTINCT a.student_id) FROM online_test_attempts a WHERE a.test_id = t.id AND a.status IN ('submitted','graded','timed_out')) AS attempted
          FROM online_tests t WHERE t.section_id = ? AND t.class_subject_id = ? ORDER BY t.created_at DESC`).bind(co.section_id, co.class_subject_id),
      c.db.prepare(`SELECT count(*) AS n FROM enrollments WHERE section_id = ? AND status = 'active'`).bind(co.section_id),
    ])
    const ls = lessons.results as Record<string, unknown>[]
    return ok({
      course: co, roll: (roll.results[0] as { n: number }).n, today: todayIST(),
      units: (units.results as Record<string, unknown>[]).map((u) => ({ ...u, lessons: ls.filter((l) => l.unit_id === u.id).map((l) => ({ ...l, is_published: !!l.is_published })) })),
      assignments: (hw.results as Record<string, unknown>[]).map((h) => ({ ...h, rubric: parseRubric(h.rubric), allow_submission: !!h.allow_submission })),
      quizzes: quizzes.results,
    })
  })

  r.post('/lms/units', P, async (c) => {
    requirePerm(c, HW)
    const b = await readJSON<Body>(c.req)
    const s = await resolveScope(c)
    const co = await course(c, s, needUUID(b.section_id, 'section_id'), needUUID(b.class_subject_id, 'class_subject_id'))
    const title = str(b.title)
    if (!title) throw badRequest('give the unit a title')
    const id = uuid()
    await c.db.prepare(`INSERT INTO syllabus_units (id, institution_id, class_subject_id, sequence, title, description, planned_periods, is_active, created_at)
        VALUES (?, ?, ?, (SELECT COALESCE(max(sequence), 0) + 1 FROM syllabus_units WHERE class_subject_id = ?), ?, ?, 1, 1, ?)`)
      .bind(id, institutionId(c), co.class_subject_id, co.class_subject_id, title.slice(0, 200), optStr(b.description), now()).run()
    return ok({ id })
  })

  r.put('/lms/units/{id}', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const u = await unitInReach(c, s, needUUID(c.params.id, 'id'))
    const b = await readJSON<Body>(c.req)
    const title = str(b.title)
    if (b.title !== undefined && !title) throw badRequest('a unit needs a title')
    await c.db.prepare(`UPDATE syllabus_units SET title = COALESCE(?, title), description = CASE WHEN ? THEN ? ELSE description END WHERE id = ?`)
      .bind(title || null, b.description !== undefined ? 1 : 0, optStr(b.description), u.id).run()
    return ok({ id: u.id })
  })

  /* A unit is retired, not deleted: the syllabus tracker and question bank may point at it. */
  r.del('/lms/units/{id}', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const u = await unitInReach(c, s, needUUID(c.params.id, 'id'))
    await c.db.prepare(`UPDATE syllabus_units SET is_active = 0 WHERE id = ?`).bind(u.id).run()
    return ok({ id: u.id, retired: true })
  })

  const lessonFields = (b: Body) => {
    const kind = str(b.kind) || 'text'
    if (!LESSON_KINDS.has(kind)) throw badRequest('kind must be text, file, pdf, video or link')
    const url = optStr(b.url)
    if (url && !/^https?:\/\//i.test(url)) throw badRequest('a link must start with http:// or https://')
    const fileId = optStr(b.file_id)
    if (fileId && !isUUID(fileId)) throw badRequest('file_id must be a uuid')
    if ((kind === 'video' || kind === 'link') && !url) throw badRequest('a video or link lesson needs its address')
    if ((kind === 'file' || kind === 'pdf') && !fileId && !url) throw badRequest('attach the file, or give a link to it')
    if (kind === 'text' && !str(b.body)) throw badRequest('write the lesson text')
    let day: number | null = null
    if (b.day !== null && b.day !== undefined && b.day !== '') {
      day = Math.trunc(Number(b.day))
      if (!Number.isFinite(day) || day < 1 || day > 366) throw badRequest('day must be a whole number from 1')
    }
    let publishAt: string | null = null
    if (str(b.publish_at)) {
      const t = Date.parse(str(b.publish_at))
      if (Number.isNaN(t)) throw badRequest('publish_at is not a date and time')
      publishAt = new Date(t).toISOString()
    }
    return { kind, url, fileId, day, publishAt, body: typeof b.body === 'string' ? b.body.slice(0, 50_000) : null }
  }

  r.post('/lms/lessons', P, async (c) => {
    requirePerm(c, HW)
    const b = await readJSON<Body>(c.req)
    const s = await resolveScope(c)
    const u = await unitInReach(c, s, needUUID(b.unit_id, 'unit_id'))
    const title = str(b.title)
    if (!title) throw badRequest('give the lesson a title')
    let sectionId: string | null = null
    if (str(b.section_id)) {
      sectionId = needUUID(b.section_id, 'section_id')
      const ok2 = await c.db.prepare(`SELECT 1 AS x FROM sections WHERE id = ? AND class_id = ?`).bind(sectionId, u.class_id).first()
      if (!ok2 || !reachesSection(s, sectionId)) throw forbidden('that section is not one you teach in this class')
    }
    const f = lessonFields(b)
    const published = b.is_published === false ? 0 : 1
    const id = uuid(), t = now()
    const stmts = [c.db.prepare(`INSERT INTO lms_lessons (id, institution_id, unit_id, section_id, title, kind, body, file_id, url, sequence, is_published, created_by, created_at, updated_at, day, publish_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(max(sequence), 0) + 1 FROM lms_lessons WHERE unit_id = ?), ?, ?, ?, ?, ?, ?)`)
      .bind(id, institutionId(c), u.id, sectionId, title.slice(0, 200), f.kind, f.body, f.fileId, f.url, u.id, published, c.id.userId, t, t, f.day, f.publishAt)]
    /* A scheduled lesson is announced by nobody: the child finds it on the day. */
    if (published && (!f.publishAt || f.publishAt <= t)) {
      const secs = sectionId ? [sectionId] : (await c.db.prepare(`SELECT id FROM sections WHERE class_id = ?`).bind(u.class_id).all<{ id: string }>()).results.map((x) => x.id)
      const kids: string[] = []
      for (const sec of secs) if (reachesSection(s, sec)) kids.push(...await sectionRoll(c, sec))
      const subj = await c.db.prepare(`SELECT sub.name FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id WHERE cs.id = ?`).bind(u.class_subject_id).first<{ name: string }>()
      stmts.push(...notifyMany(c, await recipients(c, kids, 'students'), 'lms_lesson', `New lesson in ${subj?.name ?? 'your course'}`, title, '/go/courses_subjects', 'lms_lesson', id))
    }
    await c.db.batch(stmts)
    return ok({ id })
  })

  async function lessonInReach(c: Ctx, s: Scope, id: string) {
    const l = await c.db.prepare(`SELECT id, unit_id, section_id FROM lms_lessons WHERE id = ?`).bind(id).first<{ id: string; unit_id: string; section_id: string | null }>()
    if (!l) throw notFound('no such lesson')
    await unitInReach(c, s, l.unit_id)
    if (l.section_id && !reachesSection(s, l.section_id)) throw notFound('no such lesson')
    return l
  }

  r.put('/lms/lessons/{id}', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const l = await lessonInReach(c, s, needUUID(c.params.id, 'id'))
    const b = await readJSON<Body>(c.req)
    const title = str(b.title)
    if (!title) throw badRequest('a lesson needs a title')
    const f = lessonFields(b)
    await c.db.prepare(`UPDATE lms_lessons SET title = ?, kind = ?, body = ?, file_id = ?, url = ?, day = ?, publish_at = ?, is_published = COALESCE(?, is_published),
        sequence = COALESCE(?, sequence), updated_at = ? WHERE id = ?`)
      .bind(title.slice(0, 200), f.kind, f.body, f.fileId, f.url, f.day, f.publishAt, typeof b.is_published === 'boolean' ? (b.is_published ? 1 : 0) : null,
        typeof b.sequence === 'number' ? Math.trunc(b.sequence) : null, now(), l.id).run()
    return ok({ id: l.id })
  })

  r.del('/lms/lessons/{id}', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const l = await lessonInReach(c, s, needUUID(c.params.id, 'id'))
    await c.db.prepare(`DELETE FROM lms_lessons WHERE id = ?`).bind(l.id).run()
    return ok({ id: l.id, deleted: true })
  })

  /* Who has finished a lesson, and who has not. */
  r.get('/lms/lessons/{id}/progress', P, async (c) => {
    const s = await resolveScope(c)
    const l = await lessonInReach(c, s, needUUID(c.params.id, 'id'))
    const sec = needUUID(c.url.searchParams.get('section_id'), 'section_id')
    if (!reachesSection(s, sec)) throw forbidden('this section is not one you teach')
    const rows = await c.db.prepare(`SELECT st.id AS student_id, ${fullName('st')} AS full_name, e.roll_no, p.completed_at FROM enrollments e JOIN students st ON st.id = e.student_id
        LEFT JOIN lms_lesson_progress p ON p.lesson_id = ? AND p.student_id = st.id WHERE e.section_id = ? AND e.status = 'active' ORDER BY e.roll_no IS NULL, e.roll_no, st.first_name`)
      .bind(l.id, sec).all()
    return ok({ items: rows.results })
  })

  /* Set work: homework with an optional rubric, told to the children and their parents. */
  r.post('/lms/assignments', P, async (c) => {
    requirePerm(c, HW)
    const b = await readJSON<Body>(c.req)
    const s = await resolveScope(c)
    const co = await course(c, s, needUUID(b.section_id, 'section_id'), needUUID(b.class_subject_id, 'class_subject_id'))
    const title = str(b.title)
    if (!title) throw badRequest('give the assignment a title')
    const due = optStr(b.due_on)
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw badRequest('due_on must be YYYY-MM-DD')
    if (due && due < todayIST()) throw badRequest('the due date has already passed')
    const rubric = parseRubric(b.rubric)
    let max = num(b.max_marks)
    if (max !== null && (!Number.isFinite(max) || max < 0 || max > 1000)) throw badRequest('max_marks must be between 0 and 1000')
    if (rubric) max = rubric.reduce((a, r) => a + r.max, 0)
    const kind = str(b.kind) === 'classwork' ? 'classwork' : 'homework'
    const fileIds = Array.isArray(b.file_ids) ? (b.file_ids as unknown[]).map(str).filter(isUUID) : []
    const id = uuid(), t = now(), inst = institutionId(c)
    const stmts: D1PreparedStatement[] = [c.db.prepare(`INSERT INTO homework (id, institution_id, section_id, class_subject_id, kind, title, instructions, assigned_on, due_on, max_marks,
        is_published, allow_submission, created_by, created_at, updated_at, rubric) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
      .bind(id, inst, co.section_id, co.class_subject_id, kind, title.slice(0, 200), optStr(b.instructions), todayIST(), due,
        max === null ? null : String(max), b.allow_submission === false ? 0 : 1, c.id.userId, t, t, rubric ? JSON.stringify(rubric) : null)]
    for (const f of fileIds) {
      stmts.push(c.db.prepare(`INSERT INTO homework_attachments (id, institution_id, homework_id, file_id) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM files WHERE id = ? AND deleted_at IS NULL)`)
        .bind(uuid(), inst, id, f, f))
    }
    const kids = await sectionRoll(c, co.section_id)
    const label = kind === 'classwork' ? 'Classwork' : 'Assignment'
    stmts.push(...notifyMany(c, await recipients(c, kids, 'students'), 'homework', `${label} set in ${co.subject}`, `${title}${due ? `, due ${due}` : ''}`, '/go/courses_subjects', 'homework', id))
    stmts.push(...notifyMany(c, await recipients(c, kids, 'parents'), 'homework', `${label} set in ${co.subject}`, `${title}${due ? `, due ${due}` : ''}`, '/go/homework', 'homework', id))
    await c.db.batch(stmts)
    return ok({ id, told: kids.length })
  })

  /* The gradebook for one assignment: every child on the roll, with or without work. */
  r.get('/lms/assignments/{id}/gradebook', P, async (c) => {
    const s = await resolveScope(c)
    const h = await assignmentInReach(c, s, c.params.id)
    const rows = await c.db.prepare(`SELECT st.id AS student_id, ${fullName('st')} AS full_name, st.admission_no, e.roll_no, (st.user_id IS NOT NULL) AS has_login,
        COALESCE(hs.status, 'pending') AS status, hs.submitted_at, hs.text_answer, hs.file_id, f.original_name AS file_name,
        CAST(hs.marks AS REAL) AS marks, hs.feedback, hs.rubric_scores, hs.graded_at, hs.returned_at
        FROM enrollments e JOIN students st ON st.id = e.student_id
        LEFT JOIN homework_submissions hs ON hs.homework_id = ? AND hs.student_id = st.id LEFT JOIN files f ON f.id = hs.file_id AND f.deleted_at IS NULL
        WHERE e.section_id = ? AND e.status = 'active' ORDER BY e.roll_no IS NULL, e.roll_no, st.first_name`).bind(h.id, h.section_id).all<Record<string, unknown>>()
    const items = rows.results.map((v) => {
      let rs: unknown = null
      try { rs = v.rubric_scores ? JSON.parse(String(v.rubric_scores)) : null } catch { rs = null }
      const submitted = ['submitted', 'late', 'graded', 'resubmit'].includes(String(v.status)) && !!v.submitted_at
      return { ...v, status: String(v.status), returned_at: (v.returned_at as string | null) ?? null, has_login: !!v.has_login, rubric_scores: rs, missing: !submitted && String(v.status) !== 'graded',
        late: String(v.status) === 'late' || (!!v.submitted_at && !!h.due_on && String(v.submitted_at).slice(0, 10) > h.due_on) }
    })
    const overdue = !!h.due_on && h.due_on < todayIST()
    return ok({
      assignment: { ...h, rubric: parseRubric(h.rubric), max_marks: num(h.max_marks), allow_submission: !!h.allow_submission, overdue },
      items,
      summary: {
        roll: items.length, submitted: items.filter((i) => !i.missing).length, missing: items.filter((i) => i.missing).length,
        late: items.filter((i) => i.late).length, graded: items.filter((i) => i.status === 'graded').length,
        returned: items.filter((i) => !!i.returned_at).length,
      },
    })
  })

  /* Mark one child's work: a single mark or rubric scores, comments, and optionally hand it back. */
  r.post('/lms/assignments/{id}/grade', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const h = await assignmentInReach(c, s, c.params.id)
    const b = await readJSON<Body>(c.req)
    const sid = needUUID(b.student_id, 'student_id')
    const onRoll = await c.db.prepare(`SELECT ${fullName('st')} AS name FROM enrollments e JOIN students st ON st.id = e.student_id WHERE e.student_id = ? AND e.section_id = ? AND e.status = 'active'`)
      .bind(sid, h.section_id).first<{ name: string }>()
    if (!onRoll) throw notFound('that child is not on this section\'s roll')
    const rubric = parseRubric(h.rubric)
    const max = num(h.max_marks)
    let marksVal: number | null = null
    let scores: Record<string, number> | null = null
    if (rubric && b.rubric_scores && typeof b.rubric_scores === 'object') {
      scores = {}
      for (const r of rubric) {
        const v = Number((b.rubric_scores as Record<string, unknown>)[r.criterion])
        if (!Number.isFinite(v)) continue
        if (v < 0 || v > r.max) throw badRequest(`${r.criterion} is out of ${r.max}`)
        scores[r.criterion] = v
      }
      marksVal = Object.values(scores).reduce((a, x) => a + x, 0)
    } else if (b.marks !== null && b.marks !== undefined && b.marks !== '') {
      marksVal = Number(b.marks)
      if (!Number.isFinite(marksVal) || marksVal < 0) throw badRequest('marks must be a number, zero or more')
    }
    if (marksVal !== null && max !== null && marksVal > max) throw badRequest(`a mark may not exceed the maximum of ${max}`)
    const status = str(b.status) === 'resubmit' ? 'resubmit' : 'graded'
    const give = b.return === true || status === 'resubmit'
    const t = now()
    const stmts: D1PreparedStatement[] = [c.db.prepare(`INSERT INTO homework_submissions (id, institution_id, homework_id, student_id, status, marks, feedback, rubric_scores, graded_by, graded_at, returned_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (homework_id, student_id) DO UPDATE SET status = excluded.status, marks = excluded.marks, feedback = excluded.feedback,
          rubric_scores = excluded.rubric_scores, graded_by = excluded.graded_by, graded_at = excluded.graded_at,
          returned_at = COALESCE(excluded.returned_at, homework_submissions.returned_at)`)
      .bind(uuid(), institutionId(c), h.id, sid, status, marksVal === null ? null : String(marksVal), optStr(b.feedback),
        scores ? JSON.stringify(scores) : null, c.id.userId, t, give ? t : null)]
    if (give) {
      const title = status === 'resubmit' ? `Please redo: ${h.title}` : `Marked: ${h.title}`
      const body = marksVal !== null ? `${marksVal}${max !== null ? ` / ${max}` : ''}${optStr(b.feedback) ? `. ${str(b.feedback)}` : ''}` : (str(b.feedback) || 'Your teacher has looked at your work.')
      stmts.push(...notifyMany(c, await recipients(c, [sid], 'students'), 'homework_graded', title, body, '/go/courses_subjects', 'homework_graded', h.id))
      stmts.push(...notifyMany(c, await recipients(c, [sid], 'parents'), 'homework_graded', `${title} (${onRoll.name})`, body, '/go/homework', 'homework_graded', h.id))
    }
    await c.db.batch(stmts)
    return ok({ student_id: sid, marks: marksVal, status, returned: give })
  })

  /* Hand back everything marked and not yet returned. */
  r.post('/lms/assignments/{id}/return', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const h = await assignmentInReach(c, s, c.params.id)
    const rows = await c.db.prepare(`SELECT student_id, marks FROM homework_submissions WHERE homework_id = ? AND status = 'graded' AND returned_at IS NULL`).bind(h.id).all<{ student_id: string; marks: string | null }>()
    if (!rows.results.length) return ok({ returned: 0 })
    const t = now()
    const ids = rows.results.map((x) => x.student_id)
    const stmts: D1PreparedStatement[] = [c.db.prepare(`UPDATE homework_submissions SET returned_at = ? WHERE homework_id = ? AND status = 'graded' AND returned_at IS NULL`).bind(t, h.id)]
    stmts.push(...notifyMany(c, await recipients(c, ids, 'students'), 'homework_graded', `Marked: ${h.title}`, 'Your marked work and your teacher\'s comments are ready.', '/go/courses_subjects', 'homework_graded', h.id))
    stmts.push(...notifyMany(c, await recipients(c, ids, 'parents'), 'homework_graded', `Marked: ${h.title}`, 'Marked work and the teacher\'s comments are ready.', '/go/homework', 'homework_graded', h.id))
    await c.db.batch(stmts)
    return ok({ returned: ids.length })
  })

  /* A reminder to the children who have not handed in, their parents, or both. */
  r.post('/lms/assignments/{id}/nudge', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const h = await assignmentInReach(c, s, c.params.id)
    const b = await readJSON<Body>(c.req)
    const to = str(b.to) === 'parents' ? 'parents' : str(b.to) === 'both' ? 'both' : 'students'
    const missing = await c.db.prepare(`SELECT e.student_id FROM enrollments e WHERE e.section_id = ? AND e.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM homework_submissions hs WHERE hs.homework_id = ? AND hs.student_id = e.student_id AND hs.submitted_at IS NOT NULL AND hs.status <> 'resubmit')
        AND NOT EXISTS (SELECT 1 FROM homework_submissions hs WHERE hs.homework_id = ? AND hs.student_id = e.student_id AND hs.status = 'graded')`)
      .bind(h.section_id, h.id, h.id).all<{ student_id: string }>()
    const ids = missing.results.map((x) => x.student_id)
    const who = await recipients(c, ids, to)
    const msg = str(b.message) || `${h.title}${h.subject ? ` (${h.subject})` : ''} has not been handed in yet${h.due_on ? `; it was due ${h.due_on}` : ''}.`
    const stmts = notifyMany(c, who, 'homework_nudge', 'Reminder: work not handed in', msg.slice(0, 400), '/go/courses_subjects', 'homework_nudge', h.id)
    if (stmts.length) await c.db.batch(stmts)
    const reached = new Set(who.map((w) => w.student))
    return ok({ missing: ids.length, told: who.length, unreachable: ids.filter((i) => !reached.has(i)).length })
  })

  /* A quiz: MCQ questions written here go into the question bank, then the test. */
  r.post('/lms/quizzes', P, async (c) => {
    requirePerm(c, HW)
    const b = await readJSON<Body>(c.req)
    const s = await resolveScope(c)
    const co = await course(c, s, needUUID(b.section_id, 'section_id'), needUUID(b.class_subject_id, 'class_subject_id'))
    const title = str(b.title)
    if (!title) throw badRequest('give the quiz a title')
    const qs = Array.isArray(b.questions) ? b.questions as Body[] : []
    if (!qs.length) throw badRequest('add at least one question')
    if (qs.length > 100) throw badRequest('a quiz holds at most 100 questions')
    const dur = b.duration_minutes === null || b.duration_minutes === undefined || b.duration_minutes === '' ? null : Math.trunc(Number(b.duration_minutes))
    if (dur !== null && (!Number.isFinite(dur) || dur < 1 || dur > 300)) throw badRequest('the time limit must be between 1 and 300 minutes')
    const iso = (v: unknown, what: string) => { const x = str(v); if (!x) return null; const t = Date.parse(x); if (Number.isNaN(t)) throw badRequest(`${what} is not a date and time`); return new Date(t).toISOString() }
    const opens = iso(b.opens_at, 'opens_at'), closes = iso(b.closes_at, 'closes_at')
    if (opens && closes && closes <= opens) throw badRequest('the quiz must close after it opens')
    const attempts = Math.max(1, Math.min(5, Math.trunc(Number(b.max_attempts ?? 1)) || 1))
    const inst = institutionId(c), t = now(), testId = uuid()
    const publish = b.publish !== false
    const stmts: D1PreparedStatement[] = [c.db.prepare(`INSERT INTO online_tests (id, institution_id, section_id, class_subject_id, title, instructions, opens_at, closes_at, duration_minutes,
        max_attempts, shuffle_questions, status, published_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(testId, inst, co.section_id, co.class_subject_id, title.slice(0, 200), optStr(b.instructions), opens, closes, dur, attempts, b.shuffle === true ? 1 : 0,
        publish ? 'published' : 'draft', publish ? t : null, c.id.userId, t, t)]
    qs.forEach((q, i) => {
      const stem = str(q.stem)
      const options = Array.isArray(q.options) ? (q.options as unknown[]).map(str).filter(Boolean) : []
      const correct = Math.trunc(Number(q.correct))
      const m = q.marks === undefined ? 1 : Number(q.marks)
      if (!stem) throw badRequest(`question ${i + 1} has no text`)
      if (options.length < 2 || options.length > 6) throw badRequest(`question ${i + 1} needs between two and six options`)
      if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) throw badRequest(`question ${i + 1}: mark which option is correct`)
      if (!Number.isFinite(m) || m <= 0 || m > 20) throw badRequest(`question ${i + 1}: marks must be between 0 and 20`)
      const qid = uuid()
      stmts.push(c.db.prepare(`INSERT INTO question_bank_questions (id, institution_id, class_subject_id, kind, difficulty, bloom_level, stem, default_marks, explanation, is_active, created_by, created_at, updated_at)
          VALUES (?, ?, ?, 'mcq', 'medium', 'understand', ?, ?, ?, 1, ?, ?, ?)`).bind(qid, inst, co.class_subject_id, stem.slice(0, 2000), String(m), optStr(q.explanation), c.id.userId, t, t))
      options.forEach((o, j) => stmts.push(c.db.prepare(`INSERT INTO question_bank_options (id, institution_id, question_id, sequence, body, is_correct) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), inst, qid, j + 1, o.slice(0, 500), j === correct ? 1 : 0)))
      stmts.push(c.db.prepare(`INSERT INTO online_test_questions (id, institution_id, test_id, question_id, sequence, marks, negative_marks) VALUES (?, ?, ?, ?, ?, ?, '0')`)
        .bind(uuid(), inst, testId, qid, i + 1, String(m)))
    })
    if (publish) {
      const kids = await sectionRoll(c, co.section_id)
      stmts.push(...notifyMany(c, await recipients(c, kids, 'students'), 'quiz', `New quiz in ${co.subject}`, `${title}${dur ? `, ${dur} minutes` : ''}`, '/go/courses_subjects', 'quiz', testId))
    }
    await c.db.batch(stmts)
    return ok({ id: testId, questions: qs.length })
  })

  r.post('/lms/quizzes/{id}/status', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const b = await readJSON<Body>(c.req)
    const st = str(b.status)
    if (!['published', 'closed', 'draft'].includes(st)) throw badRequest('status must be published, closed or draft')
    const t0 = await c.db.prepare(`SELECT section_id FROM online_tests WHERE id = ?`).bind(needUUID(c.params.id, 'id')).first<{ section_id: string }>()
    if (!t0 || !reachesSection(s, t0.section_id)) throw notFound()
    await c.db.prepare(`UPDATE online_tests SET status = ?, published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END, updated_at = ? WHERE id = ?`)
      .bind(st, st, now(), now(), c.params.id).run()
    return ok({ id: c.params.id, status: st })
  })

  /* Every child's best attempt at a quiz. */
  r.get('/lms/quizzes/{id}/results', P, async (c) => {
    const s = await resolveScope(c)
    const t0 = await c.db.prepare(`SELECT id, section_id, title, duration_minutes, (SELECT sum(CAST(marks AS REAL)) FROM online_test_questions q WHERE q.test_id = online_tests.id) AS max_score
        FROM online_tests WHERE id = ?`).bind(needUUID(c.params.id, 'id')).first<{ id: string; section_id: string; title: string; duration_minutes: number | null; max_score: number | null }>()
    if (!t0 || !reachesSection(s, t0.section_id)) throw notFound()
    const rows = await c.db.prepare(`SELECT st.id AS student_id, ${fullName('st')} AS full_name, e.roll_no,
        (SELECT max(CAST(a.score AS REAL)) FROM online_test_attempts a WHERE a.test_id = ? AND a.student_id = st.id AND a.status IN ('submitted','graded','timed_out')) AS best,
        (SELECT count(*) FROM online_test_attempts a WHERE a.test_id = ? AND a.student_id = st.id) AS attempts,
        (SELECT max(a.submitted_at) FROM online_test_attempts a WHERE a.test_id = ? AND a.student_id = st.id) AS last_at,
        (SELECT a.status FROM online_test_attempts a WHERE a.test_id = ? AND a.student_id = st.id ORDER BY a.started_at DESC LIMIT 1) AS last_status
        FROM enrollments e JOIN students st ON st.id = e.student_id WHERE e.section_id = ? AND e.status = 'active' ORDER BY e.roll_no IS NULL, e.roll_no, st.first_name`)
      .bind(t0.id, t0.id, t0.id, t0.id, t0.section_id).all()
    return ok({ quiz: t0, items: rows.results })
  })

  /* Optional, and labelled as such: draft MCQs from a lesson's text for the teacher to check. Nothing is saved. */
  r.post('/lms/ai/quiz-draft', P, async (c) => {
    requirePerm(c, HW)
    const b = await readJSON<Body>(c.req)
    const s = await resolveScope(c)
    let text = str(b.text).slice(0, 8000), title = ''
    if (str(b.lesson_id)) {
      const l = await lessonInReach(c, s, needUUID(b.lesson_id, 'lesson_id'))
      const row = await c.db.prepare(`SELECT title, body FROM lms_lessons WHERE id = ?`).bind(l.id).first<{ title: string; body: string | null }>()
      title = row?.title ?? ''
      text = `${title}\n\n${row?.body ?? ''}`.slice(0, 8000)
    }
    if (text.trim().length < 40) throw badRequest('give the AI some lesson text to work from, a paragraph at least')
    const n = Math.max(1, Math.min(10, Math.trunc(Number(b.count ?? 5)) || 5))
    if (!aiConfigured(c.env)) return ok({ configured: false, message: NOT_CONFIGURED_MSG, questions: [], label: 'AI draft' })
    await assistantRateLimit(c)
    const system = ['You write multiple-choice questions for a school teacher in India, from the lesson text given. The teacher checks every question before a child sees it.',
      'Use only facts in the text. Four options each, exactly one correct. Plain text, no markdown.',
      `Return JSON only: {"questions": [{"stem": "...", "options": ["...","...","...","..."], "correct": <index 0-3>, "explanation": "..."}]} with exactly ${n} questions.`].join('\n')
    const raw = await aiGenerate(c.env, c.db, system, `Lesson:\n"""${text}"""`, { maxTokens: 3000 })
    const o = parseJsonObject<{ questions?: unknown }>(raw)
    const questions = (Array.isArray(o?.questions) ? o!.questions as Body[] : []).map((q) => ({
      stem: str(q.stem), options: Array.isArray(q.options) ? (q.options as unknown[]).map(str).filter(Boolean).slice(0, 6) : [],
      correct: Math.trunc(Number(q.correct)), explanation: str(q.explanation),
    })).filter((q) => q.stem && q.options.length >= 2 && q.correct >= 0 && q.correct < q.options.length)
    return ok({ configured: true, label: 'AI draft', model: AI_MODEL, questions })
  })
}

