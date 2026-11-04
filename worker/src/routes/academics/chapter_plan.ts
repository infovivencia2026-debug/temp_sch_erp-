import type { Ctx, Router } from '../../router'
import { HttpError, badRequest, isUUID, ok, readJSON, uuid, now } from '../../http'
import { can, forbiddenMsg, inst, isDate, workingYear } from '../students/common'
import { STATUSES, type Status } from './lesson_register'

/* THE LESSON PLAN BY CHAPTER (owner, 2026-11-04): pick a class-section and a
   subject, see every chapter of its syllabus with the days it should take and
   how far it has got. A chapter opens to its sub-topics, each with from and to
   dates and a status that only moves forward; the teacher may add and rename
   sub-topics, and leave a note on the chapter.

   Chapters and sub-topics are syllabus_units (a sub-topic has parent_unit_id);
   a section's progress on either is chapter_progress. The principal and
   academics read and write every class; a teacher only the class-subjects the
   timetable gives them. */

const seesAll = (c: Ctx) => can(c, 'academics.write') || can(c, 'hr.leave.approve')
const RANK: Record<Status, number> = { not_completed: 0, ongoing: 1, completed: 2 }

async function mayWrite(c: Ctx, sectionID: string, classSubjectID: string) {
  if (seesAll(c)) return
  const year = await workingYear(c)
  const t = await c.db.prepare(`SELECT 1 AS ok FROM timetable_entries WHERE academic_year_id = ? AND section_id = ? AND class_subject_id = ? AND teacher_user_id = ? LIMIT 1`)
    .bind(year, sectionID, classSubjectID, c.id.userId).first()
  if (!t) throw forbiddenMsg('only the teacher of this class and subject can change its plan')
}

/** The unit, with the class-subject it belongs to, or 404. */
async function unitOf(c: Ctx, unitID: string) {
  if (!isUUID(unitID)) throw badRequest('invalid unit id')
  const u = await c.db.prepare(`SELECT id, class_subject_id, parent_unit_id FROM syllabus_units WHERE id = ? AND is_active = 1`)
    .bind(unitID).first<{ id: string; class_subject_id: string; parent_unit_id: string | null }>()
  if (!u) throw new HttpError(404, 'that chapter or sub-topic is not in the syllabus')
  return u
}

export function registerChapterPlan(r: Router) {
  r.get('/academics/chapter-plan', 'auth', async (c) => {
    const section = c.url.searchParams.get('section_id') ?? '', cs = c.url.searchParams.get('class_subject_id') ?? ''
    if (!isUUID(section) || !isUUID(cs)) throw badRequest('choose a class and a subject')
    if (!seesAll(c)) await mayWrite(c, section, cs)
    const rows = await c.db.prepare(`
      SELECT u.id, u.parent_unit_id, u.sequence, u.title, u.planned_periods,
             p.status, p.from_date, p.to_date, p.note
        FROM syllabus_units u
        LEFT JOIN chapter_progress p ON p.unit_id = u.id AND p.section_id = ?
       WHERE u.class_subject_id = ? AND u.is_active = 1
       ORDER BY u.sequence, u.title`).bind(section, cs)
      .all<{ id: string; parent_unit_id: string | null; sequence: number; title: string; planned_periods: number; status: Status | null; from_date: string | null; to_date: string | null; note: string | null }>()
    const subs = new Map<string, unknown[]>()
    for (const v of rows.results) if (v.parent_unit_id) {
      const l = subs.get(v.parent_unit_id) ?? []
      l.push({ id: v.id, title: v.title, status: v.status ?? 'not_completed', from_date: v.from_date ?? '', to_date: v.to_date ?? '' })
      subs.set(v.parent_unit_id, l)
    }
    const chapters = rows.results.filter((v) => !v.parent_unit_id).map((v) => {
      const st = subs.get(v.id) as { status: Status }[] | undefined ?? []
      const status: Status = v.status ?? 'not_completed'
      /* Progress: the share of sub-topics completed, an ongoing one counting
         half; a chapter marked completed is 100 whatever its sub-topics say. */
      const pct = status === 'completed' ? 100
        : st.length ? Math.round(100 * st.reduce((n, s) => n + RANK[s.status] / 2, 0) / st.length)
        : status === 'ongoing' ? 50 : 0
      return { id: v.id, title: v.title, days: v.planned_periods, status, note: v.note ?? '', progress: pct, subtopics: subs.get(v.id) ?? [] }
    })
    return ok({ items: chapters, may_write: true })
  })

  /* A chapter's or sub-topic's progress in one section. Status moves forward
     only; dates and the note may change. */
  r.put('/academics/chapter-plan/progress', 'auth', async (c) => {
    const req = await readJSON(c.req)
    const section = String(req.section_id ?? '')
    if (!isUUID(section)) throw badRequest('invalid section')
    const u = await unitOf(c, String(req.unit_id ?? ''))
    await mayWrite(c, section, u.class_subject_id)
    const from = req.from_date === undefined ? undefined : String(req.from_date ?? '')
    const to = req.to_date === undefined ? undefined : String(req.to_date ?? '')
    if (from && !isDate(from)) throw badRequest('from date is not a date')
    if (to && !isDate(to)) throw badRequest('to date is not a date')
    const prev = await c.db.prepare(`SELECT status, from_date, to_date, note FROM chapter_progress WHERE section_id = ? AND unit_id = ?`)
      .bind(section, u.id).first<{ status: Status; from_date: string | null; to_date: string | null; note: string | null }>()
    let status: Status = prev?.status ?? 'not_completed'
    if (req.status !== undefined) {
      const s = String(req.status) as Status
      if (!STATUSES.includes(s)) throw badRequest('status must be not_completed, ongoing or completed')
      if (RANK[s] < RANK[status]) throw new HttpError(409, 'status only moves forward', { code: 'status_backward' })
      status = s
    }
    const f = from === undefined ? prev?.from_date ?? null : from || null
    const t = to === undefined ? prev?.to_date ?? null : to || null
    if (f && t && f > t) throw badRequest('the to date is before the from date')
    const note = req.note === undefined ? prev?.note ?? null : String(req.note ?? '').trim() || null
    await c.db.prepare(`INSERT INTO chapter_progress (institution_id, section_id, unit_id, status, from_date, to_date, note, updated_by, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT (section_id, unit_id) DO UPDATE SET status = excluded.status, from_date = excluded.from_date, to_date = excluded.to_date,
          note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(inst(c), section, u.id, status, f, t, note, c.id.userId, now()).run()
    return ok({ unit_id: u.id, status, from_date: f ?? '', to_date: t ?? '', note: note ?? '' })
  })

  /* A new sub-topic under a chapter. It belongs to the subject's syllabus, so
     every section of the class sees it. */
  r.post('/academics/chapter-plan/subtopics', 'auth', async (c) => {
    const req = await readJSON(c.req)
    const title = String(req.title ?? '').trim()
    if (!title) throw badRequest('write the sub-topic')
    if (title.length > 200) throw badRequest('keep the sub-topic under 200 characters')
    const section = String(req.section_id ?? '')
    const ch = await unitOf(c, String(req.chapter_id ?? ''))
    if (ch.parent_unit_id) throw badRequest('a sub-topic goes under a chapter')
    await mayWrite(c, section, ch.class_subject_id)
    const seq = await c.db.prepare(`SELECT COALESCE(max(sequence), 0) + 1 AS n FROM syllabus_units WHERE parent_unit_id = ?`).bind(ch.id).first<{ n: number }>()
    const id = uuid()
    await c.db.prepare(`INSERT INTO syllabus_units (id, institution_id, class_subject_id, sequence, title, planned_periods, parent_unit_id) VALUES (?,?,?,?,?,1,?)`)
      .bind(id, inst(c), ch.class_subject_id, seq?.n ?? 1, title, ch.id).run()
    return ok({ id, title })
  })

  r.patch('/academics/chapter-plan/subtopics/{id}', 'auth', async (c) => {
    const req = await readJSON(c.req)
    const title = String(req.title ?? '').trim()
    if (!title) throw badRequest('write the sub-topic')
    if (title.length > 200) throw badRequest('keep the sub-topic under 200 characters')
    const u = await unitOf(c, c.params.id)
    if (!u.parent_unit_id) throw badRequest('only a sub-topic can be renamed here')
    await mayWrite(c, String(req.section_id ?? ''), u.class_subject_id)
    await c.db.prepare(`UPDATE syllabus_units SET title = ? WHERE id = ?`).bind(title, u.id).run()
    return ok({ id: u.id, title })
  })
}
