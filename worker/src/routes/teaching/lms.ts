import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, forbidden, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { fullName, institutionId, marks, js, requirePerm, resolveScope, todayIST, type Scope } from './common'
import { reachesSection } from './classwork'
import { AI_MODEL, aiConfigured, aiGenerate, NOT_CONFIGURED_MSG, parseJsonObject } from '../../services/ai/llm'
import { assistantRateLimit } from './gemini'
import { checkLessonVideo } from './videos'
import { asSection, computeSteps, dayName, loadProgress, loadStructure, stepKey } from './lms_progress'

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
/* A lesson is a module's "source". image, audio and doc (slides or an Office
   document) came with 0011; like file and pdf they are an upload or a link. */
export const LESSON_KINDS = new Set(['text', 'file', 'pdf', 'video', 'link', 'image', 'audio', 'doc'])
const FILE_KINDS = new Set(['file', 'pdf', 'image', 'audio', 'doc'])
const isoDate = (v: unknown, what: string) => {
  const x = str(v)
  if (!x) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x)) throw badRequest(`${what} must be YYYY-MM-DD`)
  return x
}

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
  /* OR IGNORE: one notification per person per source (notifications_one_per_source), so marking the
     same work again, or a second reminder, does not fail the whole batch with a 409. */
  return rows.map((r) => c.db.prepare(`INSERT OR IGNORE INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, source_kind, source_id, created_at)
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

/* Modules nest: a module, its sub-modules, theirs, and so on, this many levels in all. */
export const MAX_DEPTH = 4

/** The modules above this one, nearest first (a guard stops a loop in bad data). */
async function ancestors(c: Ctx, unitId: string): Promise<string[]> {
  const out: string[] = []
  let at: string | null = unitId
  while (at && out.length <= 16) {
    const row: { parent_unit_id: string | null } | null = await c.db.prepare(`SELECT parent_unit_id FROM syllabus_units WHERE id = ?`).bind(at).first<{ parent_unit_id: string | null }>()
    at = row?.parent_unit_id ?? null
    if (at) { if (out.includes(at)) break; out.push(at) }
  }
  return out
}

/** How many levels a module and what is inside it take up (1 for one with no sub-modules). */
async function subtreeDepth(c: Ctx, unitId: string): Promise<number> {
  const rows = await c.db.prepare(`SELECT id, parent_unit_id FROM syllabus_units WHERE class_subject_id = (SELECT class_subject_id FROM syllabus_units WHERE id = ?)`).bind(unitId).all<{ id: string; parent_unit_id: string | null }>()
  const kids = (id: string) => rows.results.filter((r) => r.parent_unit_id === id).map((r) => r.id)
  const depth = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0
    seen.add(id)
    return 1 + Math.max(0, ...kids(id).map((k) => depth(k, seen)))
  }
  return depth(unitId, new Set())
}

async function assignmentInReach(c: Ctx, s: Scope, id: string) {
  if (!isUUID(id)) throw notFound()
  const h = await c.db.prepare(`SELECT h.id, h.section_id, h.class_subject_id, h.title, h.due_on, h.max_marks, h.rubric, h.kind, h.allow_submission,
      sub.name AS subject FROM homework h LEFT JOIN class_subjects cs ON cs.id = h.class_subject_id LEFT JOIN subjects sub ON sub.id = cs.subject_id WHERE h.id = ?`)
    .bind(id).first<{ id: string; section_id: string; class_subject_id: string | null; title: string; due_on: string | null; max_marks: string | null; rubric: string | null; kind: string; allow_submission: number; subject: string | null }>()
  if (!h || !reachesSection(s, h.section_id)) throw notFound()
  return h
}

/** The next place at the end of a module, over its sources, assignments and quizzes (binds the unit id three times). */
const NEXT_IN_MODULE = `(SELECT max(COALESCE((SELECT max(sequence) FROM lms_lessons WHERE unit_id = ?), 0),
  COALESCE((SELECT max(lms_sequence) FROM homework WHERE lms_unit_id = ?), 0), COALESCE((SELECT max(lms_sequence) FROM online_tests WHERE lms_unit_id = ?), 0)) + 1)`

/** A day number (1-366) or null. */
function dayOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const d = Math.trunc(Number(v))
  if (!Number.isFinite(d) || d < 1 || d > 366) throw badRequest('day must be a whole number from 1')
  return d
}
/** How a course is built: topics with days (the default), days only, or topics only. */
function layoutOf(v: unknown): 'topic_day' | 'day' | 'topic' {
  const x = str(v) || 'topic_day'
  if (x !== 'topic_day' && x !== 'day' && x !== 'topic') throw badRequest('layout must be topic_day, day or topic')
  return x
}
/** A pass mark as a percentage (1-100) or null. */
function passOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n < 1 || n > 100) throw badRequest('the pass mark must be a percentage from 1 to 100')
  return n
}

/** An optional module id for an assignment or quiz: in reach and of the same subject, or null. */
async function moduleOf(c: Ctx, s: Scope, v: unknown, classSubjectId: string): Promise<string | null> {
  if (v === null || v === undefined || v === '') return null
  const u = await unitInReach(c, s, needUUID(v, 'unit_id'))
  if (u.class_subject_id !== classSubjectId) throw badRequest('that module is not part of this course')
  return u.id
}

export function registerLMS(r: Router) {
  /* Every course the caller can teach, with what is in it. */
  r.get('/lms/courses', P, async (c) => {
    const s = await resolveScope(c)
    if (!s.allStudents && !s.sectionIds.length) return ok({ items: [] })
    const mineOnly = !s.allStudents || c.url.searchParams.get('mine') === '1'
    /* A teacher sees the subjects they are allocated; a class teacher also every subject of their own section. */
    const rows = await c.db.prepare(`
      SELECT sec.id AS section_id, sec.name AS section_name, cl.id AS class_id, cl.name AS class_name, cl.level, cs.id AS class_subject_id, sub.name AS subject,
        COALESCE(lc.layout, 'topic_day') AS layout,
        (SELECT u.full_name FROM section_subject_teachers t JOIN users u ON u.id = t.teacher_user_id WHERE t.section_id = sec.id AND t.class_subject_id = cs.id LIMIT 1) AS teacher,
        (SELECT count(*) FROM syllabus_units su WHERE su.class_subject_id = cs.id AND su.is_active = 1) AS units,
        (SELECT count(*) FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id WHERE su.class_subject_id = cs.id AND su.is_active = 1 AND (l.section_id IS NULL OR l.section_id = sec.id)) AS lessons,
        (SELECT count(*) FROM homework h WHERE h.section_id = sec.id AND h.class_subject_id = cs.id) AS assignments,
        (SELECT count(*) FROM homework h JOIN homework_submissions hs ON hs.homework_id = h.id WHERE h.section_id = sec.id AND h.class_subject_id = cs.id AND hs.status IN ('submitted','late')) AS to_mark,
        (SELECT count(*) FROM online_tests t WHERE t.section_id = sec.id AND t.class_subject_id = cs.id) AS quizzes,
        (SELECT count(*) FROM enrollments e WHERE e.section_id = sec.id AND e.status = 'active') AS roll
      FROM sections sec JOIN classes cl ON cl.id = sec.class_id JOIN class_subjects cs ON cs.class_id = cl.id JOIN subjects sub ON sub.id = cs.subject_id
      ${mineOnly ? 'LEFT ' : ''}JOIN lms_courses lc ON lc.section_id = sec.id AND lc.class_subject_id = cs.id
      WHERE ${mineOnly ? `(EXISTS (SELECT 1 FROM section_subject_teachers t WHERE t.section_id = sec.id AND t.class_subject_id = cs.id AND t.teacher_user_id = ?)
                 OR sec.class_teacher_id = ? ${s.allStudents ? '' : `OR (sec.id IN (${marks()}) AND NOT EXISTS (SELECT 1 FROM section_subject_teachers t2 WHERE t2.teacher_user_id = ?))`})` : '1'}
      ORDER BY cl.level, cl.name, sec.name, sub.name LIMIT 400`)
      .bind(...(mineOnly ? [s.userId, s.userId, ...(s.allStudents ? [] : [js(s.sectionIds), s.userId])] : []))
      .all<Record<string, unknown>>()
    return ok({ items: rows.results })
  })

  /* What a course can be added to: every class with its sections and subjects (the LMS Admin). */
  r.get('/lms/courses/options', P, async (c) => {
    const s = await resolveScope(c)
    if (!s.allStudents) throw forbidden('only the LMS Admin adds courses')
    const [cls, secs, subs] = await c.db.batch([
      c.db.prepare(`SELECT id, name FROM classes ORDER BY level, name`),
      c.db.prepare(`SELECT id, class_id, name FROM sections ORDER BY name`),
      c.db.prepare(`SELECT cs.id, cs.class_id, sub.name FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id ORDER BY sub.name`),
    ])
    return ok({ classes: cls.results, sections: secs.results, subjects: subs.results })
  })

  /* Add a subject as a course to one or more sections of its class. */
  r.post('/lms/courses', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    if (!s.allStudents) throw forbidden('only the LMS Admin adds courses')
    const b = await readJSON<Body>(c.req)
    const cs = needUUID(b.class_subject_id, 'class_subject_id')
    const layout = layoutOf(b.layout)
    const ids = Array.isArray(b.section_ids) ? b.section_ids.map((x) => needUUID(x, 'section_ids')) : []
    if (!ids.length) throw badRequest('pick at least one section')
    const ok1 = await c.db.prepare(`SELECT count(*) AS n FROM sections sec JOIN class_subjects cs ON cs.class_id = sec.class_id WHERE cs.id = ? AND sec.id IN (${marks()})`)
      .bind(cs, js(ids)).first<{ n: number }>()
    if (!ok1 || ok1.n !== new Set(ids).size) throw badRequest('that subject is not taught in every section picked')
    const t = now(), inst = institutionId(c)
    await c.db.batch(ids.map((sec) => c.db.prepare(`INSERT INTO lms_courses (institution_id, section_id, class_subject_id, layout, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (section_id, class_subject_id) DO UPDATE SET layout = excluded.layout`).bind(inst, sec, cs, layout, s.userId, t)))
    return ok({ added: ids.length })
  })

  /* Take a course off the list. Nothing in it is deleted; adding it again brings it all back. */
  r.del('/lms/courses', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    if (!s.allStudents) throw forbidden('only the LMS Admin removes courses')
    const q = c.url.searchParams
    await c.db.prepare(`DELETE FROM lms_courses WHERE section_id = ? AND class_subject_id = ?`).bind(needUUID(q.get('section_id'), 'section_id'), needUUID(q.get('class_subject_id'), 'class_subject_id')).run()
    return ok({ removed: true })
  })

  /* One course: units and lessons with completion, assignments and quizzes. */
  r.get('/lms/course', P, async (c) => {
    const s = await resolveScope(c)
    const q = c.url.searchParams
    const co = await course(c, s, needUUID(q.get('section_id'), 'section_id'), needUUID(q.get('class_subject_id'), 'class_subject_id'))
    const [units, lessons, hw, quizzes, roll, days, gate, lay] = await c.db.batch([
      c.db.prepare(`SELECT id, title, description, sequence, starts_on, ends_on, is_active, parent_unit_id FROM syllabus_units WHERE class_subject_id = ? ORDER BY sequence, created_at`).bind(co.class_subject_id),
      c.db.prepare(`SELECT l.id, l.unit_id, l.section_id, l.title, l.kind, l.body, l.file_id, f.original_name AS file_name, f.size_bytes AS file_size, f.content_type AS file_type,
          l.url, l.sequence, l.is_published, l.created_at, l.day, l.publish_at, l.duration_minutes, COALESCE(l.section, 'resources') AS section, l.is_optional,
          l.yt_video_id, l.yt_playlist_id, l.yt_channel, l.key_points,
          l.video_id, v.title AS video_title, v.duration_seconds AS video_duration, (v.thumb_key IS NOT NULL) AS video_thumb, v.content_type AS video_type,
          (SELECT count(*) FROM lms_lesson_progress p JOIN enrollments e ON e.student_id = p.student_id AND e.section_id = ? AND e.status = 'active' WHERE p.lesson_id = l.id) AS completed
          FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id LEFT JOIN files f ON f.id = l.file_id LEFT JOIN lms_videos v ON v.id = l.video_id
          WHERE su.class_subject_id = ? AND (l.section_id IS NULL OR l.section_id = ?) ORDER BY l.day IS NULL, l.day, l.sequence, l.created_at`).bind(co.section_id, co.class_subject_id, co.section_id),
      c.db.prepare(`SELECT h.id, h.kind, h.title, h.instructions, h.assigned_on, h.due_on, CAST(h.max_marks AS REAL) AS max_marks, h.rubric, h.allow_submission, h.lms_unit_id, h.lms_sequence, h.lms_day, h.lms_pass_percent,
          (SELECT count(*) FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.status IN ('submitted','late','graded')) AS submitted,
          (SELECT count(*) FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.status IN ('submitted','late')) AS to_mark,
          (SELECT count(*) FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.status = 'graded') AS graded,
          (SELECT count(*) FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.returned_at IS NOT NULL) AS returned
          FROM homework h WHERE h.section_id = ? AND h.class_subject_id = ? ORDER BY h.assigned_on DESC, h.created_at DESC`).bind(co.section_id, co.class_subject_id),
      c.db.prepare(`SELECT t.id, t.title, t.instructions, t.status, t.opens_at, t.closes_at, t.duration_minutes, t.max_attempts, t.lms_unit_id, t.lms_sequence, t.lms_day, t.lms_pass_percent,
          (SELECT count(*) FROM online_test_questions q WHERE q.test_id = t.id) AS questions,
          (SELECT count(DISTINCT a.student_id) FROM online_test_attempts a WHERE a.test_id = t.id AND a.status IN ('submitted','graded','timed_out')) AS attempted
          FROM online_tests t WHERE t.section_id = ? AND t.class_subject_id = ? ORDER BY t.created_at DESC`).bind(co.section_id, co.class_subject_id),
      c.db.prepare(`SELECT count(*) AS n FROM enrollments WHERE section_id = ? AND status = 'active'`).bind(co.section_id),
      c.db.prepare(`SELECT d.unit_id, d.day, d.label FROM lms_unit_days d JOIN syllabus_units su ON su.id = d.unit_id WHERE su.class_subject_id = ? ORDER BY d.unit_id, d.day`).bind(co.class_subject_id),
      c.db.prepare(`SELECT gating FROM lms_course_settings WHERE section_id = ? AND class_subject_id = ?`).bind(co.section_id, co.class_subject_id),
      c.db.prepare(`SELECT layout FROM lms_courses WHERE section_id = ? AND class_subject_id = ?`).bind(co.section_id, co.class_subject_id),
    ])
    const ls = lessons.results as Record<string, unknown>[]
    return ok({
      course: co, roll: (roll.results[0] as { n: number }).n, today: todayIST(),
      gating: (gate.results[0] as { gating?: string } | undefined)?.gating === 'open' ? 'open' : 'sequential',
      days: days.results,
      layout: (lay.results[0] as { layout?: string } | undefined)?.layout ?? 'topic_day',
      /* Archived modules come too (is_active false), so they can be brought back. */
      units: (units.results as Record<string, unknown>[]).map((u) => ({ ...u, is_active: !!u.is_active, lessons: ls.filter((l) => l.unit_id === u.id).map((l) => ({ ...l, is_published: !!l.is_published, is_optional: !!l.is_optional })) })),
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
    const starts = isoDate(b.starts_on, 'starts_on'), ends = isoDate(b.ends_on, 'ends_on')
    if (starts && ends && ends < starts) throw badRequest('the module must end on or after the day it starts')
    /* A sub-module: inside a module of this course, nested up to MAX_DEPTH levels. */
    let parent: string | null = null
    if (str(b.parent_unit_id)) {
      const pu = await unitInReach(c, s, needUUID(b.parent_unit_id, 'parent_unit_id'))
      if (pu.class_subject_id !== co.class_subject_id) throw badRequest('that module is not part of this course')
      const chain = await ancestors(c, pu.id)
      if (chain.length + 1 >= MAX_DEPTH) throw badRequest(`modules go ${MAX_DEPTH} levels deep at most`)
      parent = pu.id
    }
    const id = uuid()
    await c.db.prepare(`INSERT INTO syllabus_units (id, institution_id, class_subject_id, sequence, title, description, planned_periods, is_active, created_at, starts_on, ends_on, parent_unit_id)
        VALUES (?, ?, ?, (SELECT COALESCE(max(sequence), 0) + 1 FROM syllabus_units WHERE class_subject_id = ?), ?, ?, 1, 1, ?, ?, ?, ?)`)
      .bind(id, institutionId(c), co.class_subject_id, co.class_subject_id, title.slice(0, 200), optStr(b.description), now(), starts, ends, parent).run()
    return ok({ id })
  })

  r.put('/lms/units/{id}', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const u = await unitInReach(c, s, needUUID(c.params.id, 'id'))
    const b = await readJSON<Body>(c.req)
    const title = str(b.title)
    if (b.title !== undefined && !title) throw badRequest('a unit needs a title')
    const dates = b.starts_on !== undefined || b.ends_on !== undefined
    const starts = isoDate(b.starts_on, 'starts_on'), ends = isoDate(b.ends_on, 'ends_on')
    if (starts && ends && ends < starts) throw badRequest('the module must end on or after the day it starts')
    /* parent_unit_id moves the module (and everything in it) inside another
       module of the same course, or to the top level with null; never inside itself. */
    if (b.parent_unit_id !== undefined) {
      let to: string | null = null
      if (str(b.parent_unit_id)) {
        const pu = await unitInReach(c, s, needUUID(b.parent_unit_id, 'parent_unit_id'))
        if (pu.class_subject_id !== u.class_subject_id) throw badRequest('that module is not part of this course')
        const chain = await ancestors(c, pu.id)
        if (pu.id === u.id || chain.includes(u.id)) throw badRequest('a module cannot go inside itself')
        if (chain.length + 1 + (await subtreeDepth(c, u.id)) > MAX_DEPTH) throw badRequest(`modules go ${MAX_DEPTH} levels deep at most`)
        to = pu.id
      }
      await c.db.prepare(`UPDATE syllabus_units SET parent_unit_id = ? WHERE id = ?`).bind(to, u.id).run()
    }
    /* is_active true brings an archived module back. */
    await c.db.prepare(`UPDATE syllabus_units SET title = COALESCE(?, title), description = CASE WHEN ? THEN ? ELSE description END,
        starts_on = CASE WHEN ? THEN ? ELSE starts_on END, ends_on = CASE WHEN ? THEN ? ELSE ends_on END,
        is_active = CASE WHEN ? THEN 1 ELSE is_active END WHERE id = ?`)
      .bind(title || null, b.description !== undefined ? 1 : 0, optStr(b.description), dates ? 1 : 0, starts, dates ? 1 : 0, ends, b.is_active === true ? 1 : 0, u.id).run()
    return ok({ id: u.id })
  })

  /* Modules in the order given (every id must be a module of this course). */
  r.post('/lms/units/reorder', P, async (c) => {
    requirePerm(c, HW)
    const b = await readJSON<Body>(c.req)
    const s = await resolveScope(c)
    const co = await course(c, s, needUUID(b.section_id, 'section_id'), needUUID(b.class_subject_id, 'class_subject_id'))
    const ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map((x) => needUUID(x, 'ids')) : []
    if (!ids.length || ids.length > 200) throw badRequest('give the modules in their new order')
    const have = await c.db.prepare(`SELECT id FROM syllabus_units WHERE class_subject_id = ? AND id IN (${marks()})`).bind(co.class_subject_id, js(ids)).all<{ id: string }>()
    if (have.results.length !== new Set(ids).size) throw badRequest('a module in that list is not part of this course')
    await c.db.batch(ids.map((id, i) => c.db.prepare(`UPDATE syllabus_units SET sequence = ? WHERE id = ?`).bind(i + 1, id)))
    return ok({ ordered: ids.length })
  })

  /* A module's sources, assignments and quizzes in the order given:
     items [{type: 'lesson'|'assignment'|'quiz', id}]. Anything left out keeps its place. */
  r.post('/lms/units/{id}/order', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const u = await unitInReach(c, s, needUUID(c.params.id, 'id'))
    const b = await readJSON<Body>(c.req)
    const items = Array.isArray(b.items) ? (b.items as Body[]) : []
    if (!items.length || items.length > 500) throw badRequest('give the items in their new order')
    const stmts: D1PreparedStatement[] = []
    items.forEach((it, i) => {
      const id = needUUID(it?.id, 'id'), type = str(it?.type)
      if (type === 'lesson') stmts.push(c.db.prepare(`UPDATE lms_lessons SET sequence = ?, updated_at = ? WHERE id = ? AND unit_id = ?`).bind(i + 1, now(), id, u.id))
      else if (type === 'assignment') stmts.push(c.db.prepare(`UPDATE homework SET lms_sequence = ? WHERE id = ? AND lms_unit_id = ?`).bind(i + 1, id, u.id))
      else if (type === 'quiz') stmts.push(c.db.prepare(`UPDATE online_tests SET lms_sequence = ? WHERE id = ? AND lms_unit_id = ?`).bind(i + 1, id, u.id))
      else throw badRequest('type must be lesson, assignment or quiz')
    })
    const res = await c.db.batch(stmts)
    const moved = res.reduce((a, r) => a + (r.meta?.changes ?? 0), 0)
    if (moved !== items.length) throw badRequest('an item in that list is not in this module')
    return ok({ ordered: moved })
  })

  /* Who has finished a module: per child on the section's roll, the sources
     done (of those the class can see now), work handed in and quizzes taken. */
  r.get('/lms/units/{id}/progress', P, async (c) => {
    const s = await resolveScope(c)
    const u = await unitInReach(c, s, needUUID(c.params.id, 'id'))
    const sec = needUUID(c.url.searchParams.get('section_id'), 'section_id')
    if (!reachesSection(s, sec)) throw forbidden('this section is not one you teach')
    const vis = `l.unit_id = ? AND l.is_published = 1 AND (l.section_id IS NULL OR l.section_id = ?) AND (l.publish_at IS NULL OR l.publish_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    const [tot, rows] = await c.db.batch([
      c.db.prepare(`SELECT (SELECT count(*) FROM lms_lessons l WHERE ${vis}) AS sources,
          (SELECT count(*) FROM homework h WHERE h.lms_unit_id = ? AND h.section_id = ? AND h.is_published = 1 AND h.allow_submission = 1) AS assignments,
          (SELECT count(*) FROM online_tests t WHERE t.lms_unit_id = ? AND t.section_id = ? AND t.status IN ('published','closed')) AS quizzes`)
        .bind(u.id, sec, u.id, sec, u.id, sec),
      c.db.prepare(`SELECT st.id AS student_id, ${fullName('st')} AS full_name, e.roll_no,
          (SELECT count(*) FROM lms_lessons l JOIN lms_lesson_progress p ON p.lesson_id = l.id AND p.student_id = st.id WHERE ${vis}) AS sources_done,
          (SELECT count(*) FROM homework h JOIN homework_submissions hs ON hs.homework_id = h.id AND hs.student_id = st.id
            WHERE h.lms_unit_id = ? AND h.section_id = ? AND h.is_published = 1 AND h.allow_submission = 1 AND (hs.status = 'graded' OR (hs.submitted_at IS NOT NULL AND hs.status <> 'resubmit'))) AS assignments_done,
          (SELECT count(*) FROM online_tests t WHERE t.lms_unit_id = ? AND t.section_id = ? AND t.status IN ('published','closed')
            AND EXISTS (SELECT 1 FROM online_test_attempts a WHERE a.test_id = t.id AND a.student_id = st.id AND a.status <> 'in_progress')) AS quizzes_done,
          (SELECT max(v.last_at) FROM lms_lesson_views v JOIN lms_lessons l ON l.id = v.lesson_id WHERE v.student_id = st.id AND l.unit_id = ?) AS last_seen
          FROM enrollments e JOIN students st ON st.id = e.student_id WHERE e.section_id = ? AND e.status = 'active' ORDER BY e.roll_no IS NULL, e.roll_no, st.first_name`)
        .bind(u.id, sec, u.id, sec, u.id, sec, u.id, sec),
    ])
    const t = tot.results[0] as { sources: number; assignments: number; quizzes: number }
    const total = t.sources + t.assignments + t.quizzes
    const items = (rows.results as Record<string, number | string | null>[]).map((r) => {
      const done = Number(r.sources_done) + Number(r.assignments_done) + Number(r.quizzes_done)
      return { ...r, done, total, complete: total > 0 && done >= total }
    })
    return ok({ totals: { ...t, total }, items, complete: items.filter((i) => i.complete).length, roll: items.length })
  })

  /* A unit (module) is archived, not deleted: the syllabus tracker and question
     bank may point at it, and PUT with is_active true brings it back. */
  r.del('/lms/units/{id}', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const u = await unitInReach(c, s, needUUID(c.params.id, 'id'))
    await c.db.prepare(`UPDATE syllabus_units SET is_active = 0 WHERE id = ?`).bind(u.id).run()
    return ok({ id: u.id, retired: true })
  })

  /* YOUTUBE, FROM WHATEVER THE TEACHER PASTED.

     A teacher copies the address out of the browser bar, and that address
     comes in five shapes: youtu.be/ID, /watch?v=ID, /watch?v=ID&list=PL,
     /playlist?list=PL, /embed/ID and /shorts/ID. All of them are the same
     two facts -- a video id, a playlist id, or both -- and the player needs
     only those.

     The ID IS ALL THAT IS KEPT. Not the title, not the thumbnail, not the
     duration: YouTube's terms cap how long its metadata may be cached, and
     a school database quietly mirroring somebody's catalogue is what those
     terms exist to stop. The lesson keeps the teacher's own title, as it
     always has, and the player fetches the rest from YouTube at the moment
     of watching.

     Ids are checked against their own alphabet rather than trusted. A video
     id is eleven characters of [A-Za-z0-9_-]; a playlist id is longer and
     from the same set. Anything else and this is not a YouTube link, and
     the lesson stays the plain link it already was -- no error, because a
     teacher pasting a Khan Academy page has done nothing wrong. */
  const YT_ID = /^[A-Za-z0-9_-]{11}$/
  const YT_LIST = /^[A-Za-z0-9_-]{12,64}$/
  const parseYouTube = (url: string | null): { video: string | null; list: string | null } => {
    if (!url) return { video: null, list: null }
    let u: URL
    try { u = new URL(url) } catch { return { video: null, list: null } }
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    const isYT = host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be'
    if (!isYT) return { video: null, list: null }
    let video: string | null = null
    if (host === 'youtu.be') video = u.pathname.slice(1).split('/')[0] || null
    else if (u.pathname === '/watch') video = u.searchParams.get('v')
    else {
      const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([^/?#]+)/)
      if (m) video = m[2]
    }
    const list = u.searchParams.get('list')
    return {
      video: video && YT_ID.test(video) ? video : null,
      list: list && YT_LIST.test(list) ? list : null,
    }
  }

  const lessonFields = (b: Body) => {
    const kind = str(b.kind) || 'text'
    if (!LESSON_KINDS.has(kind)) throw badRequest('kind must be text, file, pdf, video, link, image, audio or doc')
    const url = optStr(b.url)
    if (url && !/^https?:\/\//i.test(url)) throw badRequest('a link must start with http:// or https://')
    const yt = parseYouTube(url)
    /* Attribution, not metadata: the channel's name is shown beside the
       player so the uploader is credited. The teacher types it; nothing
       scrapes it, and it is allowed to be empty. */
    const ytChannel = (optStr(b.yt_channel) ?? '').slice(0, 120) || null
    /* THE TEACHER'S OWN WORDS. Not a summary of the video -- a summary
       derived from somebody else's recording, or from its captions, is
       derived from their work. This is what the teacher wants their class
       to take away, written by the teacher. */
    const keyPoints = (optStr(b.key_points) ?? '').slice(0, 4000) || null
    const fileId = optStr(b.file_id)
    if (fileId && !isUUID(fileId)) throw badRequest('file_id must be a uuid')
    const videoId = kind === 'video' ? optStr(b.video_id) : null
    if (videoId && !isUUID(videoId)) throw badRequest('video_id must be a uuid')
    if (kind === 'video' && !url && !videoId) throw badRequest('pick a video from the library, or give its address')
    if (kind === 'link' && !url) throw badRequest('a link lesson needs its address')
    if (FILE_KINDS.has(kind) && !fileId && !url) throw badRequest('attach the file, or give a link to it')
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
    let minutes: number | null = null
    if (b.duration_minutes !== null && b.duration_minutes !== undefined && b.duration_minutes !== '') {
      minutes = Math.trunc(Number(b.duration_minutes))
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 600) throw badRequest('duration_minutes must be from 1 to 600')
    }
    if (b.section !== undefined && b.section !== null && b.section !== '' && !asSection(b.section)) throw badRequest('section must be prereq, resources, tools or assessment')
    return { kind, url: videoId ? null : url, fileId, videoId: videoId ? videoId.toLowerCase() : null, day, publishAt, minutes, body: typeof b.body === 'string' ? b.body.slice(0, 50_000) : null,
      section: asSection(b.section) ?? 'resources', optional: b.is_optional === true ? 1 : 0,
      /* Null when the library video wins: a lesson is one thing to watch,
         and a lesson carrying both a file in our own library and somebody
         else's embed is two lessons wearing one title. */
      ytVideo: videoId ? null : yt.video, ytList: videoId ? null : yt.list, ytChannel, keyPoints }
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
    if (f.videoId) f.videoId = await checkLessonVideo(c, f.videoId)
    const published = b.is_published === false ? 0 : 1
    const id = uuid(), t = now()
    /* At the end of the module, after its sources, assignments and quizzes. */
    const stmts = [c.db.prepare(`INSERT INTO lms_lessons (id, institution_id, unit_id, section_id, title, kind, body, file_id, url, sequence, is_published, created_by, created_at, updated_at, day, publish_at, video_id, duration_minutes, section, is_optional, yt_video_id, yt_playlist_id, yt_channel, key_points)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT max(COALESCE((SELECT max(sequence) FROM lms_lessons WHERE unit_id = ?), 0), COALESCE((SELECT max(lms_sequence) FROM homework WHERE lms_unit_id = ?), 0),
          COALESCE((SELECT max(lms_sequence) FROM online_tests WHERE lms_unit_id = ?), 0)) + 1), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, institutionId(c), u.id, sectionId, title.slice(0, 200), f.kind, f.body, f.fileId, f.url, u.id, u.id, u.id, published, c.id.userId, t, t, f.day, f.publishAt, f.videoId, f.minutes, f.section, f.optional,
        f.ytVideo, f.ytList, f.ytChannel, f.keyPoints)]
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
    /* Keeping a video the lesson already has needs no library check (a colleague's lesson). */
    const had = await c.db.prepare(`SELECT video_id FROM lms_lessons WHERE id = ?`).bind(l.id).first<{ video_id: string | null }>()
    if (f.videoId && f.videoId !== had?.video_id) f.videoId = await checkLessonVideo(c, f.videoId)
    await c.db.prepare(`UPDATE lms_lessons SET title = ?, kind = ?, body = ?, file_id = ?, url = ?, video_id = ?, day = ?, publish_at = ?, is_published = COALESCE(?, is_published),
        sequence = COALESCE(?, sequence), duration_minutes = ?, section = COALESCE(?, section), is_optional = COALESCE(?, is_optional),
        yt_video_id = ?, yt_playlist_id = ?, yt_channel = ?,
        /* Key points are only replaced when the editor sent the field.
           A screen that saves a lesson without the notes box on it must not
           wipe what the teacher wrote on another screen. */
        key_points = CASE WHEN ? THEN ? ELSE key_points END, updated_at = ? WHERE id = ?`)
      .bind(title.slice(0, 200), f.kind, f.body, f.fileId, f.url, f.videoId, f.day, f.publishAt, typeof b.is_published === 'boolean' ? (b.is_published ? 1 : 0) : null,
        typeof b.sequence === 'number' ? Math.trunc(b.sequence) : null, f.minutes, b.section === undefined ? null : f.section, typeof b.is_optional === 'boolean' ? f.optional : null,
        f.ytVideo, f.ytList, f.ytChannel, b.key_points === undefined ? 0 : 1, f.keyPoints, now(), l.id).run()
    return ok({ id: l.id })
  })

  /* Publish, unpublish or schedule a source without resending all of it. */
  r.post('/lms/lessons/{id}/publish', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const l = await lessonInReach(c, s, needUUID(c.params.id, 'id'))
    const b = await readJSON<Body>(c.req)
    if (typeof b.is_published !== 'boolean') throw badRequest('is_published must be true or false')
    let publishAt: string | null = null
    if (str(b.publish_at)) {
      const t = Date.parse(str(b.publish_at))
      if (Number.isNaN(t)) throw badRequest('publish_at is not a date and time')
      publishAt = new Date(t).toISOString()
    }
    await c.db.prepare(`UPDATE lms_lessons SET is_published = ?, publish_at = ?, updated_at = ? WHERE id = ?`).bind(b.is_published ? 1 : 0, publishAt, now(), l.id).run()
    return ok({ id: l.id, is_published: b.is_published, publish_at: publishAt })
  })

  /* Move a source to another module of the same subject; it goes to the end there. */
  r.post('/lms/lessons/{id}/move', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const l = await lessonInReach(c, s, needUUID(c.params.id, 'id'))
    const b = await readJSON<Body>(c.req)
    const to = str(b.unit_id) ? await unitInReach(c, s, needUUID(b.unit_id, 'unit_id')) : await unitInReach(c, s, l.unit_id)
    const from = await unitInReach(c, s, l.unit_id)
    if (to.class_subject_id !== from.class_subject_id) throw badRequest('a source can only move to another module of the same subject')
    /* Also to a day (null: no day) and a section, when given. */
    const day = b.day === undefined ? undefined : dayOf(b.day)
    if (b.section !== undefined && !asSection(b.section)) throw badRequest('section must be prereq, resources, tools or assessment')
    await c.db.prepare(`UPDATE lms_lessons SET unit_id = ?, day = CASE WHEN ? THEN ? ELSE day END, section = COALESCE(?, section),
        sequence = CASE WHEN unit_id = ? THEN sequence ELSE (SELECT max(COALESCE((SELECT max(sequence) FROM lms_lessons WHERE unit_id = ?), 0),
        COALESCE((SELECT max(lms_sequence) FROM homework WHERE lms_unit_id = ?), 0), COALESCE((SELECT max(lms_sequence) FROM online_tests WHERE lms_unit_id = ?), 0)) + 1) END, updated_at = ? WHERE id = ?`)
      .bind(to.id, day === undefined ? 0 : 1, day ?? null, asSection(b.section), to.id, to.id, to.id, to.id, now(), l.id).run()
    return ok({ id: l.id, unit_id: to.id })
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
    const unitId = await moduleOf(c, s, b.unit_id, co.class_subject_id)
    const lmsDay = unitId ? dayOf(b.day) : null, pass = passOf(b.pass_percent)
    const fileIds = Array.isArray(b.file_ids) ? (b.file_ids as unknown[]).map(str).filter(isUUID) : []
    const id = uuid(), t = now(), inst = institutionId(c)
    const stmts: D1PreparedStatement[] = [c.db.prepare(`INSERT INTO homework (id, institution_id, section_id, class_subject_id, kind, title, instructions, assigned_on, due_on, max_marks,
        is_published, allow_submission, created_by, created_at, updated_at, rubric, lms_day, lms_pass_percent, lms_unit_id, lms_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ${unitId ? NEXT_IN_MODULE : 'NULL'})`)
      .bind(id, inst, co.section_id, co.class_subject_id, kind, title.slice(0, 200), optStr(b.instructions), todayIST(), due,
        max === null ? null : String(max), b.allow_submission === false ? 0 : 1, c.id.userId, t, t, rubric ? JSON.stringify(rubric) : null, lmsDay, pass, unitId, ...(unitId ? [unitId, unitId, unitId] : []))]
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
    const unitId = await moduleOf(c, s, b.unit_id, co.class_subject_id)
    const lmsDay = unitId ? dayOf(b.day) : null, pass = passOf(b.pass_percent)
    const inst = institutionId(c), t = now(), testId = uuid()
    const publish = b.publish !== false
    const stmts: D1PreparedStatement[] = [c.db.prepare(`INSERT INTO online_tests (id, institution_id, section_id, class_subject_id, title, instructions, opens_at, closes_at, duration_minutes,
        max_attempts, shuffle_questions, status, published_at, created_by, created_at, updated_at, lms_day, lms_pass_percent, lms_unit_id, lms_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${unitId ? NEXT_IN_MODULE : 'NULL'})`)
      .bind(testId, inst, co.section_id, co.class_subject_id, title.slice(0, 200), optStr(b.instructions), opens, closes, dur, attempts, b.shuffle === true ? 1 : 0,
        publish ? 'published' : 'draft', publish ? t : null, c.id.userId, t, t, lmsDay, pass, unitId, ...(unitId ? [unitId, unitId, unitId] : []))]
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

  /* Put an assignment or a quiz into a module (at its end), or take it out (unit_id null). */
  r.post('/lms/assignments/{id}/module', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const h = await assignmentInReach(c, s, c.params.id)
    const b = await readJSON<Body>(c.req)
    const cur = await c.db.prepare(`SELECT lms_unit_id, lms_day, lms_pass_percent FROM homework WHERE id = ?`).bind(h.id).first<{ lms_unit_id: string | null; lms_day: number | null; lms_pass_percent: number | null }>()
    const unitId = b.unit_id === undefined ? cur?.lms_unit_id ?? null : await moduleOf(c, s, b.unit_id, h.class_subject_id ?? '')
    const day = !unitId ? null : b.day === undefined ? cur?.lms_day ?? null : dayOf(b.day)
    const pass = b.pass_percent === undefined ? cur?.lms_pass_percent ?? null : passOf(b.pass_percent)
    const same = unitId === (cur?.lms_unit_id ?? null)
    await c.db.prepare(`UPDATE homework SET lms_unit_id = ?, lms_day = ?, lms_pass_percent = ?, lms_sequence = ${same ? 'lms_sequence' : unitId ? NEXT_IN_MODULE : 'NULL'}, updated_at = ? WHERE id = ?`)
      .bind(unitId, day, pass, ...(!same && unitId ? [unitId, unitId, unitId] : []), now(), h.id).run()
    return ok({ id: h.id, unit_id: unitId, day, pass_percent: pass })
  })

  r.post('/lms/quizzes/{id}/module', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const t0 = await c.db.prepare(`SELECT id, section_id, class_subject_id FROM online_tests WHERE id = ?`).bind(needUUID(c.params.id, 'id')).first<{ id: string; section_id: string; class_subject_id: string }>()
    if (!t0 || !reachesSection(s, t0.section_id)) throw notFound()
    const b = await readJSON<Body>(c.req)
    const cur = await c.db.prepare(`SELECT lms_unit_id, lms_day, lms_pass_percent FROM online_tests WHERE id = ?`).bind(t0.id).first<{ lms_unit_id: string | null; lms_day: number | null; lms_pass_percent: number | null }>()
    const unitId = b.unit_id === undefined ? cur?.lms_unit_id ?? null : await moduleOf(c, s, b.unit_id, t0.class_subject_id)
    const day = !unitId ? null : b.day === undefined ? cur?.lms_day ?? null : dayOf(b.day)
    const pass = b.pass_percent === undefined ? cur?.lms_pass_percent ?? null : passOf(b.pass_percent)
    const same = unitId === (cur?.lms_unit_id ?? null)
    await c.db.prepare(`UPDATE online_tests SET lms_unit_id = ?, lms_day = ?, lms_pass_percent = ?, lms_sequence = ${same ? 'lms_sequence' : unitId ? NEXT_IN_MODULE : 'NULL'}, updated_at = ? WHERE id = ?`)
      .bind(unitId, day, pass, ...(!same && unitId ? [unitId, unitId, unitId] : []), now(), t0.id).run()
    return ok({ id: t0.id, unit_id: unitId, day, pass_percent: pass })
  })

  /* ─── Days, gating, the progress grid and unlocks (0012) ─── */

  /* A new day at the end of a module (optionally labelled). */
  r.post('/lms/units/{id}/days', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const u = await unitInReach(c, s, needUUID(c.params.id, 'id'))
    const b = await readJSON<Body>(c.req).catch(() => ({} as Body))
    const top = await c.db.prepare(`SELECT max(d) AS d FROM (SELECT max(day) AS d FROM lms_unit_days WHERE unit_id = ?1 UNION ALL SELECT max(day) FROM lms_lessons WHERE unit_id = ?1
        UNION ALL SELECT max(lms_day) FROM homework WHERE lms_unit_id = ?1 UNION ALL SELECT max(lms_day) FROM online_tests WHERE lms_unit_id = ?1)`).bind(u.id).first<{ d: number | null }>()
    const day = (top?.d ?? 0) + 1
    if (day > 366) throw badRequest('a module holds at most 366 days')
    await c.db.prepare(`INSERT INTO lms_unit_days (institution_id, unit_id, day, label) VALUES (?, ?, ?, ?)`).bind(institutionId(c), u.id, day, str(b.label).slice(0, 120)).run()
    return ok({ unit_id: u.id, day })
  })

  /* Name a day ("Fractions on a line"); an empty label is plain "Day N". */
  r.put('/lms/units/{id}/days/{day}', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const u = await unitInReach(c, s, needUUID(c.params.id, 'id'))
    const day = dayOf(c.params.day)
    if (day === null) throw badRequest('which day?')
    const b = await readJSON<Body>(c.req)
    await c.db.prepare(`INSERT INTO lms_unit_days (institution_id, unit_id, day, label) VALUES (?, ?, ?, ?) ON CONFLICT (unit_id, day) DO UPDATE SET label = excluded.label`)
      .bind(institutionId(c), u.id, day, str(b.label).slice(0, 120)).run()
    return ok({ unit_id: u.id, day, label: str(b.label).slice(0, 120) })
  })

  /* Remove an empty day. One with anything on it is refused: move or delete its sources first. */
  r.del('/lms/units/{id}/days/{day}', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const u = await unitInReach(c, s, needUUID(c.params.id, 'id'))
    const day = dayOf(c.params.day)
    const used = await c.db.prepare(`SELECT (SELECT count(*) FROM lms_lessons WHERE unit_id = ?1 AND day = ?2) + (SELECT count(*) FROM homework WHERE lms_unit_id = ?1 AND lms_day = ?2)
        + (SELECT count(*) FROM online_tests WHERE lms_unit_id = ?1 AND lms_day = ?2) AS n`).bind(u.id, day).first<{ n: number }>()
    if ((used?.n ?? 0) > 0) throw new HttpError(409, 'this day still has sources on it; move or delete them first', { code: 'day_not_empty' })
    await c.db.prepare(`DELETE FROM lms_unit_days WHERE unit_id = ? AND day = ?`).bind(u.id, day).run()
    return ok({ unit_id: u.id, day, deleted: true })
  })

  /* Days in a new order: days [3, 1, 2] makes the old Day 3 the new Day 1, and so on, with everything on them. */
  r.post('/lms/units/{id}/days/order', P, async (c) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const u = await unitInReach(c, s, needUUID(c.params.id, 'id'))
    const b = await readJSON<Body>(c.req)
    const days = Array.isArray(b.days) ? (b.days as unknown[]).map((x) => dayOf(x)) : []
    if (!days.length || days.some((d) => d === null) || new Set(days).size !== days.length) throw badRequest('give every day once, in its new order')
    const OFF = 10_000
    const stmts: D1PreparedStatement[] = []
    /* Two passes through a high offset, so no two days collide on the way. */
    days.forEach((old, i) => {
      const to = OFF + i + 1
      stmts.push(c.db.prepare(`UPDATE lms_unit_days SET day = ? WHERE unit_id = ? AND day = ?`).bind(to, u.id, old))
      stmts.push(c.db.prepare(`UPDATE lms_lessons SET day = ? WHERE unit_id = ? AND day = ?`).bind(to, u.id, old))
      stmts.push(c.db.prepare(`UPDATE homework SET lms_day = ? WHERE lms_unit_id = ? AND lms_day = ?`).bind(to, u.id, old))
      stmts.push(c.db.prepare(`UPDATE online_tests SET lms_day = ? WHERE lms_unit_id = ? AND lms_day = ?`).bind(to, u.id, old))
      stmts.push(c.db.prepare(`UPDATE lms_unlocks SET day = ? WHERE unit_id = ? AND day = ?`).bind(to, u.id, old))
    })
    for (const [t, col, key] of [['lms_unit_days', 'day', 'unit_id'], ['lms_lessons', 'day', 'unit_id'], ['homework', 'lms_day', 'lms_unit_id'], ['online_tests', 'lms_day', 'lms_unit_id'], ['lms_unlocks', 'day', 'unit_id']]) {
      stmts.push(c.db.prepare(`UPDATE ${t} SET ${col} = ${col} - ? WHERE ${key} = ? AND ${col} > ?`).bind(OFF, u.id, OFF))
    }
    await c.db.batch(stmts)
    return ok({ unit_id: u.id, ordered: days.length })
  })

  /* One by one (the default) or open, per course. */
  r.put('/lms/course/settings', P, async (c) => {
    requirePerm(c, HW)
    const b = await readJSON<Body>(c.req)
    const s = await resolveScope(c)
    const co = await course(c, s, needUUID(b.section_id, 'section_id'), needUUID(b.class_subject_id, 'class_subject_id'))
    if (b.layout !== undefined) {
      await c.db.prepare(`INSERT INTO lms_courses (institution_id, section_id, class_subject_id, layout, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (section_id, class_subject_id) DO UPDATE SET layout = excluded.layout`).bind(institutionId(c), co.section_id, co.class_subject_id, layoutOf(b.layout), s.userId, now()).run()
      if (b.gating === undefined) return ok({ layout: layoutOf(b.layout) })
    }
    const gating = str(b.gating)
    if (gating !== 'sequential' && gating !== 'open') throw badRequest('gating must be sequential or open')
    await c.db.prepare(`INSERT INTO lms_course_settings (institution_id, section_id, class_subject_id, gating, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (section_id, class_subject_id) DO UPDATE SET gating = excluded.gating, updated_at = excluded.updated_at`)
      .bind(institutionId(c), co.section_id, co.class_subject_id, gating, now()).run()
    return ok({ gating })
  })

  /* Every child against every day: done, open or locked, where each is stuck, and the unlocks given. */
  r.get('/lms/course/progress', P, async (c) => {
    const s = await resolveScope(c)
    const q = c.url.searchParams
    const co = await course(c, s, needUUID(q.get('section_id'), 'section_id'), needUUID(q.get('class_subject_id'), 'class_subject_id'))
    const st = await loadStructure(c, co.section_id, co.class_subject_id, true)
    const roll = await c.db.prepare(`SELECT st.id AS student_id, ${fullName('st')} AS full_name, e.roll_no FROM enrollments e JOIN students st ON st.id = e.student_id
        WHERE e.section_id = ? AND e.status = 'active' ORDER BY e.roll_no IS NULL, e.roll_no, st.first_name`).bind(co.section_id).all<{ student_id: string; full_name: string; roll_no: number | null }>()
    const prog = await loadProgress(c, st, roll.results.map((r) => r.student_id))
    const unitTitle = new Map(st.units.map((u) => [u.id, u.title]))
    return ok({
      gating: st.gating,
      steps: st.steps.map((x) => ({ key: x.key, unit_id: x.unit_id, day: x.day, label: dayName(x.day, x.label), module: unitTitle.get(x.unit_id) ?? '', items: x.items.filter((i) => i.required).length })),
      students: roll.results.map((r) => {
        const p = prog.get(r.student_id)!
        const states = computeSteps(st, p)
        const cur = states.findIndex((x) => x.state !== 'done')
        return { ...r, states: states.map((x) => ({ state: x.state, done: x.done, total: x.total })), days_done: states.filter((x) => x.state === 'done').length,
          at: cur < 0 ? null : st.steps[cur].key, unlocks: [...p.unlocks] }
      }),
    })
  })

  /* Open one day early for one child (or take that back). */
  const unlockTarget = async (c: Ctx) => {
    requirePerm(c, HW)
    const s = await resolveScope(c)
    const b = await readJSON<Body>(c.req)
    const u = await unitInReach(c, s, needUUID(b.unit_id, 'unit_id'))
    const sid = needUUID(b.student_id, 'student_id')
    const on = await c.db.prepare(`SELECT e.section_id FROM enrollments e WHERE e.student_id = ? AND e.status = 'active' AND e.class_id = ?`).bind(sid, u.class_id).first<{ section_id: string }>()
    if (!on || !reachesSection(s, on.section_id)) throw notFound('that child is not in a class you teach')
    return { u, sid, day: dayOf(b.day) }
  }
  r.post('/lms/unlocks', P, async (c) => {
    const { u, sid, day } = await unlockTarget(c)
    await c.db.prepare(`INSERT OR IGNORE INTO lms_unlocks (institution_id, student_id, unit_id, day, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(institutionId(c), sid, u.id, day ?? 0, c.id.userId, now()).run()
    return ok({ key: stepKey(u.id, day), unlocked: true })
  })
  r.del('/lms/unlocks', P, async (c) => {
    const { u, sid, day } = await unlockTarget(c)
    await c.db.prepare(`DELETE FROM lms_unlocks WHERE student_id = ? AND unit_id = ? AND day = ?`).bind(sid, u.id, day ?? 0).run()
    return ok({ key: stepKey(u.id, day), unlocked: false })
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
    if (!(await aiConfigured(c.env))) return ok({ configured: false, message: NOT_CONFIGURED_MSG, questions: [], label: 'AI draft' })
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

