import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, forbidden, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { fullName, institutionId, resolveScope, todayIST } from '../teaching/common'
import { notifyMany, parseRubric } from '../teaching/lms'
import { bucketFor, mergeWatched } from '../teaching/videos'
import { assertOpen, computeSteps, dayName, loadProgress, loadStructure, lockedItems, satisfied, type PItem } from '../teaching/lms_progress'

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

/** A lesson that is a video: from the library, or YouTube (by id or by its address). */
function isVideoLesson(l: { kind: string; video_id: string | null; yt_video_id: string | null; url: string | null }): boolean {
  return l.kind === 'video' || !!l.video_id || !!l.yt_video_id || /(^|\/\/)(www\.|m\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(l.url ?? '')
}
/** Watched to the end, with room for the gaps a real watch leaves.
 *
 * ONE DROPPED SECOND USED TO COST THE WHOLE LESSON (tester, 2026-10-10:
 * played a video to its end, "no tick, course still shows 0 of 3 done").
 *
 * The rule was EVERY stretch but the last. The player marks a stretch only
 * when its once-a-second reading moved forward by about a second's worth, so
 * a tab switch, a buffer, a locked phone or a slow frame leaves a permanent
 * hole -- and a hole could never be filled, because going back over it is
 * allowed but the clock only marks what plays. A child who watched the whole
 * thing was left on a lesson that could not be finished, in front of a
 * sentence promising it would tick itself, with no button to say otherwise.
 * A gated course then locks for good: the next day never opens.
 *
 * So: nearly all of it, and the end of it. Ninety per cent of the stretches
 * -- which is the rule this file has claimed in prose all along -- plus the
 * last few actually played, so somebody who stops halfway cannot pass by
 * scrubbing about. The protection against a forged map is not this rule: it
 * is the check that the lesson was opened at least half the video's length
 * ago, which no amount of skipping can shorten. */
function fullyWatched(w: string): boolean {
  if (!w.length) return false
  /* The last stretch is left out of the reckoning entirely, as it always was:
     players stop a moment early, so it is routinely never played. */
  const body = w.slice(0, -1)
  if (!body.length) return w === '1'
  const seen = [...body].filter((x) => x === '1').length
  if (seen < Math.ceil(body.length * 0.9)) return false
  /* And the end has to have been reached: the last two stretches before that
     final one were played. Ninety per cent on its own would pass somebody who
     watched the opening and scrubbed off. */
  return !body.slice(-2).includes('0')
}

const lessonVisible = `l.is_published = 1 AND su.is_active = 1 AND (l.section_id IS NULL OR l.section_id = ?)
  AND (l.publish_at IS NULL OR l.publish_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

/** Whether a lesson's day is open for this child (the video stream asks this). */
export async function lessonOpenFor(c: Ctx, studentId: string, lessonId: string): Promise<boolean> {
  try {
    const room = await classroom(c, studentId)
    await gate(c, studentId, room.section_id, 'lesson', lessonId)
    return true
  } catch { return false }
}

/** One by one: refuse a child's work on a source, quiz or assignment whose day is still locked (403, code 'locked'). */
async function gate(c: Ctx, sid: string, section: string, type: PItem['type'], id: string) {
  const row = type === 'lesson'
    ? await c.db.prepare(`SELECT su.class_subject_id AS cs FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id WHERE l.id = ?`).bind(id).first<{ cs: string }>()
    : await c.db.prepare(`SELECT class_subject_id AS cs FROM ${type === 'quiz' ? 'online_tests' : 'homework'} WHERE id = ? AND lms_unit_id IS NOT NULL`).bind(id).first<{ cs: string }>()
  if (!row?.cs) return
  const st = await loadStructure(c, section, row.cs, true)
  const p = (await loadProgress(c, st, [sid])).get(sid)!
  assertOpen(st, computeSteps(st, p), type, id, p)
}

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
        WHERE cs.class_id = ? AND ${lessonVisible} AND EXISTS (SELECT 1 FROM lms_courses lc WHERE lc.section_id = ? AND lc.class_subject_id = cs.id)
          AND NOT EXISTS (SELECT 1 FROM lms_lesson_progress p WHERE p.lesson_id = l.id AND p.student_id = ?)
        ORDER BY su.sequence, l.day IS NULL, l.day, l.sequence LIMIT 8`).bind(classId, section, section, sid),
    c.db.prepare(`SELECT h.id, h.title, sub.name AS subject, h.class_subject_id, CAST(hs.marks AS REAL) AS marks, CAST(h.max_marks AS REAL) AS max_marks, hs.feedback, hs.status, hs.returned_at
        FROM homework_submissions hs JOIN homework h ON h.id = hs.homework_id LEFT JOIN class_subjects cs ON cs.id = h.class_subject_id LEFT JOIN subjects sub ON sub.id = cs.subject_id
        WHERE hs.student_id = ? AND hs.returned_at IS NOT NULL ORDER BY hs.returned_at DESC LIMIT 5`).bind(sid),
  ])
  /* One by one: "up next" leaves out what is on a locked day. */
  const ls = lessons.results as { id: string; class_subject_id: string }[]
  const hidden = new Set<string>()
  for (const cs of new Set(ls.map((l) => l.class_subject_id))) {
    const st = await loadStructure(c, section, cs, true)
    const pr = (await loadProgress(c, st, [sid])).get(sid)!
    const states = computeSteps(st, pr)
    const behind = lockedItems(st, states, pr)
    st.steps.forEach((x, i) => { for (const it of x.items) if (it.type === 'lesson' && (states[i].state === 'locked' || behind.has(`lesson:${it.id}`))) hidden.add(it.id) })
  }
  return {
    assignments: (hw.results as Record<string, unknown>[]).map((h) => ({ ...h, overdue: !!h.overdue })),
    quizzes: quizzes.results, lessons: ls.filter((l) => !hidden.has(l.id)), returned: returned.results,
  }
}

export function registerPortalLMS(r: Router) {
  /* Every subject of the child's class, with progress. */
  r.get('/portal/lms/courses', PERM, async (c) => {
    const sid = await child(c)
    const k = await classroom(c, sid)
    const rows = await c.db.prepare(`SELECT cs.id AS class_subject_id, sub.name AS subject, sub.code,
        EXISTS (SELECT 1 FROM lms_courses lc WHERE lc.section_id = ? AND lc.class_subject_id = cs.id) AS added,
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
      .bind(k.section_id, k.section_id, k.section_id, sid, k.section_id, sid, k.section_id, k.section_id, now(), sid, k.class_id).all()
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
      c.db.prepare(`SELECT id, title, description, sequence, starts_on, ends_on FROM syllabus_units WHERE class_subject_id = ? AND is_active = 1 ORDER BY sequence, created_at`).bind(cs),
      c.db.prepare(`SELECT l.id, l.unit_id, l.title, l.kind, l.body, l.file_id, f.original_name AS file_name, f.size_bytes AS file_size, f.content_type AS file_type,
          l.url, l.sequence, l.day, l.duration_minutes, COALESCE(l.section, 'resources') AS section, l.is_optional, l.publish_at, p.completed_at, vw.last_at AS viewed_at, max(COALESCE(l.publish_at, l.created_at), l.created_at) AS released_at,
          l.yt_video_id, l.yt_playlist_id, l.yt_channel, l.key_points,
          l.video_id, v.title AS video_title, v.duration_seconds AS video_duration, (v.thumb_key IS NOT NULL) AS video_thumb, v.content_type AS video_type,
          vp.position_seconds AS video_position, vp.percent AS video_percent, vp.watched AS video_watched, vp.bucket_seconds AS video_bucket
          FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id LEFT JOIN files f ON f.id = l.file_id AND f.deleted_at IS NULL
          LEFT JOIN lms_videos v ON v.id = l.video_id AND v.status = 'ready' LEFT JOIN lms_video_progress vp ON vp.lesson_id = l.id AND vp.student_id = ?
          LEFT JOIN lms_lesson_progress p ON p.lesson_id = l.id AND p.student_id = ? LEFT JOIN lms_lesson_views vw ON vw.lesson_id = l.id AND vw.student_id = ?
          WHERE su.class_subject_id = ? AND l.is_published = 1 AND su.is_active = 1 AND (l.section_id IS NULL OR l.section_id = ?)
          ORDER BY l.sequence, l.created_at`).bind(sid, sid, sid, cs, k.section_id),
      c.db.prepare(`SELECT h.id, h.kind, h.title, h.instructions, h.assigned_on, h.due_on, CAST(h.max_marks AS REAL) AS max_marks, h.rubric, h.allow_submission,
          h.lms_unit_id, h.lms_sequence, COALESCE(hs.status, 'pending') AS status, hs.submitted_at, hs.text_answer, hs.file_id, f.original_name AS file_name, hs.returned_at,
          CASE WHEN hs.returned_at IS NOT NULL THEN CAST(hs.marks AS REAL) END AS marks,
          CASE WHEN hs.returned_at IS NOT NULL THEN hs.feedback END AS feedback,
          CASE WHEN hs.returned_at IS NOT NULL THEN hs.rubric_scores END AS rubric_scores,
          COALESCE((SELECT json_group_array(json_object('file_id', af.id, 'name', af.original_name)) FROM homework_attachments ha JOIN files af ON af.id = ha.file_id AND af.deleted_at IS NULL WHERE ha.homework_id = h.id), '[]') AS files
          FROM homework h LEFT JOIN homework_submissions hs ON hs.homework_id = h.id AND hs.student_id = ? LEFT JOIN files f ON f.id = hs.file_id AND f.deleted_at IS NULL
          WHERE h.section_id = ? AND h.class_subject_id = ? AND h.is_published = 1 ORDER BY h.due_on IS NULL, h.due_on DESC, h.assigned_on DESC`).bind(sid, k.section_id, cs),
      c.db.prepare(`SELECT t.id, t.title, t.instructions, t.opens_at, t.closes_at, t.duration_minutes, t.max_attempts, t.lms_unit_id, t.lms_sequence,
          (SELECT count(*) FROM online_test_questions q WHERE q.test_id = t.id) AS questions,
          (SELECT sum(CAST(q.marks AS REAL)) FROM online_test_questions q WHERE q.test_id = t.id) AS max_score,
          (SELECT count(*) FROM online_test_attempts a WHERE a.test_id = t.id AND a.student_id = ? AND a.status <> 'in_progress') AS attempts,
          (SELECT max(CAST(a.score AS REAL)) FROM online_test_attempts a WHERE a.test_id = t.id AND a.student_id = ? AND a.status <> 'in_progress') AS best,
          (SELECT a.id FROM online_test_attempts a WHERE a.test_id = t.id AND a.student_id = ? AND a.status = 'in_progress' LIMIT 1) AS open_attempt
          FROM online_tests t WHERE t.section_id = ? AND t.class_subject_id = ? AND t.status IN ('published','closed') ORDER BY t.created_at DESC`).bind(sid, sid, sid, k.section_id, cs),
    ])
    const today = todayIST(), t = now()
    /* One by one: every day's state for this child (lms_progress.ts). */
    const st = await loadStructure(c, k.section_id, cs, true)
    const prog = (await loadProgress(c, st, [sid])).get(sid)!
    const states = computeSteps(st, prog)
    const stepOf = new Map<string, number>()
    st.steps.forEach((x, i) => x.items.forEach((it) => stepOf.set(`${it.type}:${it.id}`, i)))
    const behind = lockedItems(st, states, prog)
    const lockedOf = (type: string, id: string) => { const i = stepOf.get(`${type}:${id}`); return (i !== undefined && states[i].state === 'locked') || behind.has(`${type}:${id}`) }
    /* "New": out in the last week and not opened yet. */
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const lessonRows = new Map<string, Record<string, unknown>>((lessons.results as Record<string, unknown>[]).map((l) => {
      const locked = lockedOf('lesson', String(l.id)), scheduled = !!l.publish_at && String(l.publish_at) > t
      /* Locked or not out yet: the title and kind only, never the content. */
      const hide = locked || scheduled
      return [String(l.id), { ...l, is_optional: !!l.is_optional, done: !!l.completed_at, locked, scheduled,
        is_new: !hide && !l.viewed_at && !l.completed_at && String(l.released_at) >= weekAgo,
        ...(hide ? { body: null, url: null, file_id: null, video_id: null, video_watched: null } : {}) }]
    }))
    const hwRows = new Map<string, Record<string, unknown>>((hw.results as Record<string, unknown>[]).map((h) => {
      let files: unknown[] = [], rs: unknown = null
      try { files = JSON.parse(String(h.files)) } catch { files = [] }
      try { rs = h.rubric_scores ? JSON.parse(String(h.rubric_scores)) : null } catch { rs = null }
      const submitted = !!h.submitted_at && h.status !== 'resubmit'
      const locked = lockedOf('assignment', String(h.id))
      return [String(h.id), { ...h, files: locked ? [] : files, instructions: locked ? null : h.instructions, rubric: parseRubric(h.rubric), rubric_scores: rs, allow_submission: !!h.allow_submission,
        overdue: !submitted && !!h.due_on && String(h.due_on) < today, late: h.status === 'late', locked }]
    }))
    const qRows = new Map<string, Record<string, unknown>>((quizzes.results as Record<string, unknown>[]).map((q) => {
      const locked = lockedOf('quiz', String(q.id))
      return [String(q.id), { ...q, locked, instructions: locked ? null : q.instructions,
        open: !locked && (!q.opens_at || String(q.opens_at) <= t) && (!q.closes_at || String(q.closes_at) > t) && Number(q.attempts) < Number(q.max_attempts) }]
    }))
    const itemOut = (i: PItem, state: string) => ({ type: i.type, id: i.id, section: i.section, required: i.required, done: satisfied(i, prog),
      pass_percent: i.pass_percent, locked: state === 'locked' || behind.has(`${i.type}:${i.id}`),
      ...(i.type === 'lesson' ? { lesson: lessonRows.get(i.id) ?? null } : {}) })
    let modules = st.units.map((u) => {
      const idx = st.steps.map((x, i) => (x.unit_id === u.id ? i : -1)).filter((i) => i >= 0)
      const days = idx.map((i) => {
        const x = st.steps[i], ss = states[i]
        return { key: x.key, day: x.day, label: x.label, name: dayName(x.day, x.label), state: ss.state, reason: ss.reason, done: ss.done, total: ss.total,
          opens_at: ss.opens_at, items: x.items.map((it) => itemOut(it, ss.state)).filter((it) => it.type !== 'lesson' || it.lesson) }
      })
      const done = days.filter((d) => d.state === 'done').length
      return { id: u.id, title: u.title, description: u.description, starts_on: u.starts_on, ends_on: u.ends_on, parent_unit_id: u.parent_unit_id,
        state: !days.length ? 'empty' : done === days.length ? 'done' : days[0].state === 'locked' ? 'locked' : 'open', days_done: done, days: days }
    })
    /* A module is shown when it, or a module somewhere inside it, has something on it. */
    const hasDays = new Map(modules.map((m) => [m.id, m.days.length > 0]))
    const shown = (id: string, seen = new Set<string>()): boolean => {
      if (seen.has(id)) return false
      seen.add(id)
      return !!hasDays.get(id) || st.units.some((x) => x.parent_unit_id === id && shown(x.id, seen))
    }
    modules = modules.filter((m) => shown(m.id))
    /* Continue: the open source opened last and not done, else the first open one not done. */
    const flat = modules.flatMap((m) => m.days.flatMap((d) => d.items.map((it) => ({ m, d, it }))))
    const todoItems = flat.filter((x) => !x.it.locked && !x.it.done && !(x.it.lesson && (x.it.lesson as { scheduled?: boolean }).scheduled))
    const seen = todoItems.filter((x) => x.it.lesson && (x.it.lesson as { viewed_at?: string | null }).viewed_at)
      .sort((a, b) => String((b.it.lesson as { viewed_at: string }).viewed_at).localeCompare(String((a.it.lesson as { viewed_at: string }).viewed_at)))[0]
    const nx = seen ?? todoItems[0]
    const titleOf = (x: typeof flat[number]) => x.it.type === 'lesson' ? String((x.it.lesson as { title: string }).title)
      : String((x.it.type === 'quiz' ? qRows.get(x.it.id) : hwRows.get(x.it.id))?.title ?? '')
    const kindOf = (x: typeof flat[number]) => x.it.type === 'lesson' ? String((x.it.lesson as { kind: string }).kind) : x.it.type
    return ok({
      student_id: sid, course: co, today, gating: st.gating,
      resume: nx ? { type: nx.it.type, id: nx.it.id, unit_id: nx.m.id, day_key: nx.d.key, day_name: nx.d.name, section: nx.it.section, title: titleOf(nx), kind: kindOf(nx), started: !!seen } : null,
      modules,
      assignments: [...hwRows.values()],
      quizzes: [...qRows.values()],
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

  /* The child opened a source: for "new" and "continue where you left off".
     Only the child's own login records it; a parent reading is not the child. */
  r.post('/portal/lms/lessons/{id}/view', PERM, async (c) => {
    const own = await c.db.prepare(`SELECT id FROM students WHERE user_id = ? AND status = 'active'`).bind(c.id.userId).first<{ id: string }>()
    if (!own) return ok({ recorded: false })
    const k = await classroom(c, own.id)
    const id = str(c.params.id)
    if (!isUUID(id)) throw notFound()
    const l = await c.db.prepare(`SELECT l.id FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id JOIN class_subjects cs ON cs.id = su.class_subject_id
        WHERE l.id = ? AND cs.class_id = ? AND ${lessonVisible}`).bind(id, k.class_id, k.section_id).first<{ id: string }>()
    if (!l) throw notFound()
    await gate(c, own.id, k.section_id, 'lesson', l.id)
    const t = now()
    await c.db.prepare(`INSERT INTO lms_lesson_views (institution_id, lesson_id, student_id, first_at, last_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (lesson_id, student_id) DO UPDATE SET last_at = excluded.last_at`).bind(institutionId(c), l.id, own.id, t, t).run()
    return ok({ recorded: true })
  })

  /* A CHILD'S OWN NOTES ON A LESSON.

     Private by construction. Every statement below filters on
     `user_id = c.id.userId` as well as the lesson, so there is no shape of
     request -- not another child's id, not a parent's -- that returns
     somebody else's writing. A parent reading their child's course can see
     the lesson; these are the child's own words and they cannot.

     The lesson is checked for visibility the same way as /view and
     /complete before anything is read or written: a note against a lesson
     this account cannot open would be a way to confirm that lesson exists.

     at_seconds pins a note to the second of the video it was taken at. It
     is optional, because a note about the whole lesson is as real as one
     about 4:12, and it is clamped to a sane range rather than trusted. */
  const noteLesson = async (c: Ctx) => {
    const id = str(c.params.id)
    if (!isUUID(id)) throw notFound()
    const own = await c.db.prepare(`SELECT id FROM students WHERE user_id = ? AND status = 'active'`)
      .bind(c.id.userId).first<{ id: string }>()
    if (!own) throw notFound()
    const k = await classroom(c, own.id)
    const l = await c.db.prepare(`SELECT l.id FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id JOIN class_subjects cs ON cs.id = su.class_subject_id
        WHERE l.id = ? AND cs.class_id = ? AND ${lessonVisible}`).bind(id, k.class_id, k.section_id).first<{ id: string }>()
    if (!l) throw notFound()
    return l.id
  }
  /** Whole seconds inside a day, or nothing. */
  const atSeconds = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null
    const n = Math.floor(Number(v))
    return Number.isFinite(n) && n >= 0 && n < 86_400 ? n : null
  }
  const noteBody = (v: unknown): string => {
    const t = typeof v === 'string' ? v.trim() : ''
    if (!t) throw badRequest('a note needs something in it')
    // Long enough for a paragraph a child actually writes, short enough that
    // the column is not a dumping ground.
    return t.slice(0, 4000)
  }

  r.get('/portal/lms/lessons/{id}/notes', PERM, async (c) => {
    const lessonId = await noteLesson(c)
    const rows = await c.db.prepare(`SELECT id, at_seconds, body, created_at, updated_at
        FROM lms_lesson_notes WHERE lesson_id = ? AND user_id = ?
        ORDER BY at_seconds IS NULL, at_seconds, created_at`)
      .bind(lessonId, c.id.userId).all()
    return ok({ items: rows.results })
  })

  r.post('/portal/lms/lessons/{id}/notes', PERM, async (c) => {
    const lessonId = await noteLesson(c)
    const b = await readJSON<Body>(c.req)
    const id = uuid()
    const t = now()
    await c.db.prepare(`INSERT INTO lms_lesson_notes (id, institution_id, lesson_id, user_id, at_seconds, body, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, institutionId(c), lessonId, c.id.userId, atSeconds(b.at_seconds), noteBody(b.body), t, t).run()
    return ok({ id, at_seconds: atSeconds(b.at_seconds), body: noteBody(b.body), created_at: t, updated_at: t })
  })

  r.patch('/portal/lms/lessons/{id}/notes/{noteId}', PERM, async (c) => {
    const lessonId = await noteLesson(c)
    const noteId = str(c.params.noteId)
    if (!isUUID(noteId)) throw notFound()
    const b = await readJSON<Body>(c.req)
    const t = now()
    const res = await c.db.prepare(`UPDATE lms_lesson_notes SET body = ?, updated_at = ?
        WHERE id = ? AND lesson_id = ? AND user_id = ?`)
      .bind(noteBody(b.body), t, noteId, lessonId, c.id.userId).run()
    if (!res.meta.changes) throw notFound()
    return ok({ id: noteId, updated_at: t })
  })

  r.del('/portal/lms/lessons/{id}/notes/{noteId}', PERM, async (c) => {
    const lessonId = await noteLesson(c)
    const noteId = str(c.params.noteId)
    if (!isUUID(noteId)) throw notFound()
    const res = await c.db.prepare(`DELETE FROM lms_lesson_notes WHERE id = ? AND lesson_id = ? AND user_id = ?`)
      .bind(noteId, lessonId, c.id.userId).run()
    if (!res.meta.changes) throw notFound()
    return ok({ deleted: true })
  })

  r.post('/portal/lms/lessons/{id}/complete', PERM, async (c) => {
    const me = await self(c)
    const k = await classroom(c, me.id)
    const id = str(c.params.id)
    if (!isUUID(id)) throw notFound()
    const l = await c.db.prepare(`SELECT l.id, l.kind, l.video_id, l.yt_video_id, l.url FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id JOIN class_subjects cs ON cs.id = su.class_subject_id
        WHERE l.id = ? AND cs.class_id = ? AND ${lessonVisible}`).bind(id, k.class_id, k.section_id).first<{ id: string; kind: string; video_id: string | null; yt_video_id: string | null; url: string | null }>()
    if (!l) throw notFound()
    /* A VIDEO IS FINISHED BY WATCHING IT, NOT BY A BUTTON (owner, 2026-10-10:
       "complete only when they watch the full video, not by clicking done").
       Library videos finish through video-progress, YouTube ones through
       youtube-watched; neither can be ticked or unticked by hand. */
    if (isVideoLesson(l)) throw badRequest('a video counts as done once it has been watched to the end')
    await gate(c, me.id, k.section_id, 'lesson', l.id)
    const b = await readJSON<Body>(c.req).catch(() => ({} as Body))
    if (b.done === false) {
      await c.db.prepare(`DELETE FROM lms_lesson_progress WHERE lesson_id = ? AND student_id = ?`).bind(l.id, me.id).run()
      return ok({ id: l.id, done: false })
    }
    await c.db.prepare(`INSERT OR IGNORE INTO lms_lesson_progress (institution_id, lesson_id, student_id, completed_at) VALUES (?, ?, ?, ?)`)
      .bind(institutionId(c), l.id, me.id, now()).run()
    return ok({ id: l.id, done: true })
  })

  /* Where the child is in a lesson's library video. `watched` is the stretches
     played this time ('1' per bucket); it is merged with what was saved, and
     at 90% watched the lesson counts as finished. Only the child's own login. */
  /* The saved place, read fresh by the player (the course page may come from a cache). */
  r.get('/portal/lms/lessons/{id}/video-progress', PERM, async (c) => {
    const sid = await child(c)
    const id = str(c.params.id)
    if (!isUUID(id)) throw notFound()
    const p = await c.db.prepare(`SELECT position_seconds AS position, percent, watched, bucket_seconds FROM lms_video_progress WHERE lesson_id = ? AND student_id = ?`)
      .bind(id, sid).first()
    return ok(p ?? { position: 0, percent: 0, watched: '', bucket_seconds: null })
  })

  r.post('/portal/lms/lessons/{id}/video-progress', PERM, async (c) => {
    const me = await self(c)
    const k = await classroom(c, me.id)
    const id = str(c.params.id)
    if (!isUUID(id)) throw notFound()
    const l = await c.db.prepare(`SELECT l.id, v.id AS video_id, v.duration_seconds FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id JOIN class_subjects cs ON cs.id = su.class_subject_id
        JOIN lms_videos v ON v.id = l.video_id AND v.status = 'ready' WHERE l.id = ? AND cs.class_id = ? AND ${lessonVisible}`)
      .bind(id, k.class_id, k.section_id).first<{ id: string; video_id: string; duration_seconds: number | null }>()
    if (!l) throw notFound()
    await gate(c, me.id, k.section_id, 'lesson', l.id)
    const b = await readJSON<Body>(c.req)
    const dur = l.duration_seconds && l.duration_seconds > 0 ? l.duration_seconds : Number(b.duration)
    if (!(dur > 0)) throw badRequest('duration is required')
    const bucket = bucketFor(dur), n = Math.ceil(dur / bucket)
    const sent = typeof b.watched === 'string' ? b.watched.slice(0, n).replace(/[^01]/g, '0') : ''
    const pos = Math.max(0, Math.min(dur, Number(b.position) || 0))
    const prev = await c.db.prepare(`SELECT watched, bucket_seconds FROM lms_video_progress WHERE lesson_id = ? AND student_id = ?`).bind(l.id, me.id)
      .first<{ watched: string; bucket_seconds: number }>()
    const watched = mergeWatched(prev && prev.bucket_seconds === bucket ? prev.watched : '', sent, n)
    const percent = Math.min(100, Math.round((100 * [...watched].filter((x) => x === '1').length) / n))
    const t = now(), inst = institutionId(c)
    const stmts = [c.db.prepare(`INSERT INTO lms_video_progress (institution_id, lesson_id, student_id, video_id, position_seconds, bucket_seconds, watched, percent, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (lesson_id, student_id) DO UPDATE SET video_id = excluded.video_id, position_seconds = excluded.position_seconds,
          bucket_seconds = excluded.bucket_seconds, watched = excluded.watched, percent = excluded.percent, updated_at = excluded.updated_at`)
      .bind(inst, l.id, me.id, l.video_id, pos, bucket, watched, percent, t)]
    const done = fullyWatched(watched)
    if (done) stmts.push(c.db.prepare(`INSERT OR IGNORE INTO lms_lesson_progress (institution_id, lesson_id, student_id, completed_at) VALUES (?, ?, ?, ?)`).bind(inst, l.id, me.id, t))
    await c.db.batch(stmts)
    return ok({ id: l.id, position: pos, percent, bucket_seconds: bucket, watched, done })
  })

  /* A YouTube lesson, watched to the end. The player (YouTubeLesson.tsx) sends
     which stretches were actually played, in the same buckets as a library
     video; every one of them must be there, and the child must have opened
     the lesson at least half the video's length ago (2x is the fastest
     YouTube plays), so a forged map from a fresh page does not count. */
  r.post('/portal/lms/lessons/{id}/youtube-watched', PERM, async (c) => {
    const me = await self(c)
    const k = await classroom(c, me.id)
    const id = str(c.params.id)
    if (!isUUID(id)) throw notFound()
    const l = await c.db.prepare(`SELECT l.id, l.kind, l.video_id, l.yt_video_id, l.url FROM lms_lessons l JOIN syllabus_units su ON su.id = l.unit_id JOIN class_subjects cs ON cs.id = su.class_subject_id
        WHERE l.id = ? AND cs.class_id = ? AND ${lessonVisible}`).bind(id, k.class_id, k.section_id).first<{ id: string; kind: string; video_id: string | null; yt_video_id: string | null; url: string | null }>()
    if (!l || l.video_id || !isVideoLesson(l)) throw notFound()
    await gate(c, me.id, k.section_id, 'lesson', l.id)
    const b = await readJSON<Body>(c.req)
    const dur = Number(b.duration)
    if (!(dur > 0) || dur > 6 * 3600) throw badRequest('duration is required')
    const bucket = bucketFor(dur), n = Math.ceil(dur / bucket)
    const watched = typeof b.watched === 'string' ? b.watched.slice(0, n).replace(/[^01]/g, '0').padEnd(n, '0') : ''.padEnd(n, '0')
    const percent = Math.min(100, Math.round((100 * [...watched].filter((x) => x === '1').length) / n))
    if (!fullyWatched(watched)) return ok({ id: l.id, percent, done: false })
    const seen = await c.db.prepare(`SELECT first_at FROM lms_lesson_views WHERE lesson_id = ? AND student_id = ?`).bind(l.id, me.id).first<{ first_at: string }>()
    if (!seen || Date.now() - Date.parse(seen.first_at) < (dur / 2) * 1000) return ok({ id: l.id, percent, done: false })
    await c.db.prepare(`INSERT OR IGNORE INTO lms_lesson_progress (institution_id, lesson_id, student_id, completed_at) VALUES (?, ?, ?, ?)`)
      .bind(institutionId(c), l.id, me.id, now()).run()
    return ok({ id: l.id, percent, done: true })
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
    await gate(c, me.id, k.section_id, 'assignment', h.id)
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
    await gate(c, me.id, k.section_id, 'quiz', q.id)
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

  /* Check one answer the moment it is chosen, so a quiz plays one question at
     a time with instant feedback. The answer is LOCKED: it is written as the
     response now and hand-in keeps it, so checking cannot be used to try every
     option. The right option is named only once no attempt is left (the same
     rule as the review at hand-in), otherwise the child learns right or wrong. */
  r.post('/portal/lms/quizzes/{id}/check', PERM, async (c) => {
    const me = await self(c)
    const id = str(c.params.id)
    if (!isUUID(id)) throw notFound()
    const b = await readJSON<Body>(c.req)
    const aid = str(b.attempt_id), qid = str(b.test_question_id), opt = str(b.option_id)
    if (!isUUID(aid) || !isUUID(qid) || !isUUID(opt)) throw badRequest('attempt_id, test_question_id and option_id are required')
    const a = await c.db.prepare(`SELECT a.id, a.started_at, a.status, t.duration_minutes, t.closes_at, t.max_attempts,
        (SELECT count(*) FROM online_test_attempts x WHERE x.test_id = t.id AND x.student_id = a.student_id) AS used FROM online_test_attempts a JOIN online_tests t ON t.id = a.test_id
        WHERE a.id = ? AND a.test_id = ? AND a.student_id = ?`).bind(aid, id, me.id)
      .first<{ id: string; started_at: string; status: string; duration_minutes: number | null; closes_at: string | null; max_attempts: number; used: number }>()
    if (!a) throw notFound()
    if (a.status !== 'in_progress') throw new HttpError(409, 'this attempt has already been handed in', { code: 'already_submitted' })
    let deadline = a.duration_minutes ? Date.parse(a.started_at) + a.duration_minutes * 60_000 : Infinity
    if (a.closes_at) deadline = Math.min(deadline, Date.parse(a.closes_at))
    if (Date.now() > deadline + GRACE_MS) throw new HttpError(409, 'the time is up', { code: 'time_up' })
    const k = await c.db.prepare(`SELECT tq.id, CAST(tq.marks AS REAL) AS marks, CAST(tq.negative_marks AS REAL) AS neg,
        (SELECT o.id FROM question_bank_options o WHERE o.question_id = tq.question_id AND o.is_correct = 1 ORDER BY o.sequence LIMIT 1) AS correct,
        EXISTS (SELECT 1 FROM question_bank_options o WHERE o.question_id = tq.question_id AND o.id = ?) AS valid,
        (SELECT selected_option_ids FROM online_test_responses r WHERE r.attempt_id = ? AND r.test_question_id = tq.id LIMIT 1) AS locked
        FROM online_test_questions tq WHERE tq.id = ? AND tq.test_id = ?`).bind(opt, a.id, qid, id)
      .first<{ id: string; marks: number; neg: number; correct: string | null; valid: number; locked: string | null }>()
    if (!k) throw notFound()
    let chosen = opt
    if (k.locked) {
      try { chosen = (JSON.parse(k.locked) as string[])[0] ?? opt } catch { /* keep opt */ }
    } else {
      if (!k.valid) throw badRequest('that option is not on this question')
      const right0 = opt === k.correct
      await c.db.prepare(`INSERT INTO online_test_responses (id, institution_id, attempt_id, test_question_id, selected_option_ids, is_correct, marks_awarded, answered_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), institutionId(c), a.id, k.id, JSON.stringify([opt]), right0 ? 1 : 0, String(right0 ? k.marks : -k.neg), now()).run()
    }
    const right = !!k.correct && chosen === k.correct
    return ok({ test_question_id: k.id, chosen, right, locked: !!k.locked, correct: a.used >= a.max_attempts ? k.correct : null })
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
    const answers: Record<string, unknown> = { ...((!timedOut && b.answers && typeof b.answers === 'object') ? b.answers as Record<string, unknown> : {}) }
    /* Answers already checked one at a time are locked: they were given in
       time, they stand, and they are not written twice. */
    const lockedRows = await c.db.prepare(`SELECT test_question_id, selected_option_ids FROM online_test_responses WHERE attempt_id = ?`).bind(a.id).all<{ test_question_id: string; selected_option_ids: string | null }>()
    const locked = new Set<string>()
    for (const l of lockedRows.results) {
      try { const v = (JSON.parse(l.selected_option_ids ?? '[]') as string[])[0]; if (v) answers[l.test_question_id] = v } catch { /* unreadable: leave the body's answer */ }
      locked.add(l.test_question_id)
    }
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
      if (chosen && !locked.has(k.id)) stmts.push(c.db.prepare(`INSERT INTO online_test_responses (id, institution_id, attempt_id, test_question_id, selected_option_ids, is_correct, marks_awarded, answered_at)
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
