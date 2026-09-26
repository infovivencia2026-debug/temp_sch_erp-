import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, created, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { can } from '../../identity'
import {
  fullName, institutionId, marks, js, portalChild, requirePerm, resolveScope, shortName, todayIST,
} from '../teaching/common'

/* Port of the Learning and Campus-life halves of internal/api/student_learning.go
   (mountStudentLearning), plus markResourceSeen from media_library.go. All under
   /portal, gated by self.profile.read; the ownership check in each handler
   (whichChild / portalChild) is what actually narrows a caller to their own child.

   Postgres rendered every to_char over a timestamptz in the session timezone,
   which the resolver pins to Asia/Kolkata, so the day/minute renderings below
   shift the stored UTC ISO text by +05:30. */

const PERM = 'self.profile.read'

// ---------------------------------------------------------------------------
// helpers

type Body = Record<string, unknown>

/** IST calendar day of a UTC ISO timestamp column (to_char(ts,'YYYY-MM-DD')). */
const istDay = (col: string) => `strftime('%Y-%m-%d', ${col}, '+330 minutes')`
/** IST minute of a UTC ISO timestamp column (to_char(ts,'YYYY-MM-DD"T"HH24:MI')). */
const istMin = (col: string) => `strftime('%Y-%m-%dT%H:%M', ${col}, '+330 minutes')`
/** to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'. */
const utcSec = (col: string) => `strftime('%Y-%m-%dT%H:%M:%SZ', ${col})`

/** A raw (untrimmed) string field, '' when absent. */
const raw = (v: unknown): string => (typeof v === 'string' ? v : '')
/** Go's nullString: '' is NULL, anything else is kept as sent. */
const ns = (v: unknown): string | null => { const s = raw(v); return s === '' ? null : s }
const tr = (v: unknown): string => raw(v).trim()
const truthy = (v: unknown): boolean => v === true
const posInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && Math.trunc(v) > 0 ? Math.trunc(v) : null
const b01 = (v: unknown): boolean => v === 1 || v === true || v === '1'

/** Omits null/undefined keys (Go's omitempty on pointer fields). */
function omit(o: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  for (const k of keys) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}

/** httpx.Error with a machine code alongside the message. */
const codeErr = (status: number, code: string, msg: string) => new HttpError(status, msg, { code })

/** Body that the Go handler decoded only when ContentLength > 0. */
async function optionalBody(c: Ctx): Promise<Body> {
  const text = await c.req.text()
  if (text.trim() === '') return {}
  try {
    const v = JSON.parse(text)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error()
    return v as Body
  } catch { throw badRequest('malformed JSON body') }
}
async function body(c: Ctx): Promise<Body> {
  const v = await readJSON<unknown>(c.req)
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw badRequest('malformed JSON body')
  return v as Body
}

/** optionalDate: absent is fine, malformed is not. */
function optionalDate(v: unknown, msg: string): string | null {
  const s = tr(v)
  if (s === '') return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw badRequest(msg)
  const d = new Date(s + 'T00:00:00Z')
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw badRequest(msg)
  return s
}
/** optionalUUID: absent is fine, malformed is not. */
function optionalUUID(v: unknown, msg: string): string | null {
  const s = raw(v)
  if (s.trim() === '') return null
  if (!isUUID(s)) throw badRequest(msg)
  return s.toLowerCase()
}
/** Go's time.Parse(time.RFC3339, v), returned as UTC ISO text. */
function rfc3339(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.test(v)) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}
/** Path id; a malformed one is the Go handlers' 404. */
function pathId(c: Ctx): string {
  const v = c.params.id
  if (!isUUID(v)) throw notFound()
  return v.toLowerCase()
}

/** Port of whichChild (portal_family.go): ?student_id= or the first child; 404 otherwise. */
async function whichChild(c: Ctx): Promise<string> {
  const s = await resolveScope(c)
  if (s.studentIds.length === 0) throw notFound()
  const q = c.url.searchParams.get('student_id') ?? ''
  if (q !== '') {
    const hit = s.studentIds.find((sid) => sid === q)
    if (!hit) throw notFound()
    return hit
  }
  return s.studentIds[0]
}

interface Classroom {
  student_id: string; campus_id: string; class_id: string; section_id: string; year_id: string
  level: number; class_name: string; section_name: string; admission_no: string; student_name: string
}

/** Port of classroomOf: the active enrolment, else the most recent. Null when not enrolled. */
async function classroomOf(c: Ctx, student: string): Promise<Classroom | null> {
  return c.db.prepare(`
    SELECT st.id AS student_id, st.campus_id, e.class_id, e.section_id, e.academic_year_id AS year_id,
           cl.level, cl.name AS class_name, sec.name AS section_name, st.admission_no,
           ${fullName('st')} AS student_name
      FROM students st
      JOIN enrollments e  ON e.student_id = st.id
      JOIN classes     cl ON cl.id = e.class_id
      JOIN sections    sec ON sec.id = e.section_id
     WHERE st.id = ?
     ORDER BY (e.status = 'active') DESC, e.enrolled_on DESC
     LIMIT 1`).bind(student).first<Classroom>()
}

const notEnrolled = () => codeErr(409, 'not_enrolled',
  'this student has no enrolment on record; ask the office to complete the admission')

/** Port of myClassroom. */
async function myClassroom(c: Ctx): Promise<Classroom> {
  const student = await whichChild(c)
  const room = await classroomOf(c, student)
  if (!room) throw notEnrolled()
  return room
}

/** Eight characters from an alphabet without I, O, 0 and 1 (32 symbols, so a byte mod 32 is unbiased). */
function ticketCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

const isUniqueErr = (e: unknown) => e instanceof Error && /UNIQUE constraint/i.test(e.message)

// ---------------------------------------------------------------------------
// learning

async function listMyCourses(c: Ctx): Promise<Response> {
  const room = await myClassroom(c)
  const today = todayIST()
  const rows = await c.db.prepare(`
    SELECT cs.id AS class_subject_id, sub.name AS subject, sub.code, sub.is_scholastic,
           cs.is_elective, cs.max_marks, u.full_name AS teacher,
           (SELECT count(*) FROM timetable_entries te
             WHERE te.section_id = ? AND te.class_subject_id = cs.id) AS weekly_periods,
           (SELECT count(*) FROM study_materials sm
             WHERE sm.class_subject_id = cs.id AND sm.is_published = 1) AS resources,
           (SELECT min(es.exam_date) FROM exam_subjects es
             WHERE es.class_subject_id = cs.id AND es.exam_date >= ?) AS next_exam_on,
           (SELECT count(*) FROM homework h
             WHERE h.class_subject_id = cs.id AND h.section_id = ?
               AND h.is_published = 1
               AND (h.due_on IS NULL OR h.due_on >= ?)
               AND NOT EXISTS (SELECT 1 FROM homework_submissions hs
                                WHERE hs.homework_id = h.id AND hs.student_id = ?)) AS homework_pending
      FROM class_subjects cs
      JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN section_subject_teachers sst
             ON sst.class_subject_id = cs.id AND sst.section_id = ?
      LEFT JOIN users u ON u.id = sst.teacher_user_id
     WHERE cs.class_id = ?
     ORDER BY sub.is_scholastic DESC, sub.name`)
    .bind(room.section_id, today, room.section_id, today, room.student_id, room.section_id, room.class_id)
    .all<Record<string, unknown>>()
  const items = rows.results.map((r) => omit({
    class_subject_id: r.class_subject_id, subject: r.subject, code: r.code,
    is_scholastic: b01(r.is_scholastic), is_elective: b01(r.is_elective), max_marks: Number(r.max_marks),
    teacher: r.teacher, weekly_periods: Number(r.weekly_periods), resources: Number(r.resources),
    next_exam_on: r.next_exam_on, homework_pending: Number(r.homework_pending),
  }, 'teacher', 'next_exam_on'))
  return ok({ student_id: room.student_id, class_name: room.class_name, section_name: room.section_name, items })
}

async function listMyResources(c: Ctx): Promise<Response> {
  const student = await whichChild(c)
  const room = await classroomOf(c, student)
  if (!room) throw notEnrolled()
  const kind = ns((c.url.searchParams.get('kind') ?? '').trim())
  const reader = c.id.userId
  const rows = await c.db.prepare(`
    SELECT sm.id, sm.title, sm.description, sm.kind, sub.name AS subject,
           sm.external_url, sm.file_id, u.full_name AS uploaded_by,
           ${istDay('sm.created_at')} AS posted_on,
           ${utcSec('sm.created_at')} AS posted_at,
           f.original_name AS file_name, f.content_type, sm.audience,
           v.user_id IS NOT NULL AS seen,
           ${utcSec('sm.expires_at')} AS expires_at
      FROM study_materials sm
      LEFT JOIN class_subjects cs ON cs.id = sm.class_subject_id
      LEFT JOIN subjects      sub ON sub.id = cs.subject_id
      LEFT JOIN users           u ON u.id = sm.uploaded_by
      LEFT JOIN files           f ON f.id = sm.file_id
      LEFT JOIN study_material_views v ON v.material_id = sm.id AND v.user_id = ?
     WHERE sm.is_published = 1
       AND (sm.expires_at IS NULL OR sm.expires_at > ?)
       AND (? IS NULL OR sm.kind = ?)
       AND ((sm.audience <> 'students'
             AND (sm.section_id = ?
                  OR (sm.section_id IS NULL
                      AND (cs.class_id = ? OR sm.class_subject_id IS NULL))))
            OR EXISTS (SELECT 1 FROM study_material_targets t
                        WHERE t.material_id = sm.id AND t.student_id = ?))
     ORDER BY sm.created_at DESC
     LIMIT 300`)
    .bind(reader, now(), kind, kind, room.section_id, room.class_id, student)
    .all<Record<string, unknown>>()
  const items = rows.results.map((r) => omit({
    id: r.id, title: r.title, description: r.description, kind: r.kind, subject: r.subject,
    external_url: r.external_url, file_id: r.file_id, uploaded_by: r.uploaded_by,
    posted_on: r.posted_on, posted_at: r.posted_at, file_name: r.file_name, content_type: r.content_type,
    audience: r.audience, seen: b01(r.seen), expires_at: r.expires_at,
  }, 'description', 'subject', 'external_url', 'file_id', 'uploaded_by', 'file_name', 'content_type', 'expires_at'))
  return ok({ items })
}

/** Port of markResourceSeen (media_library.go). */
async function markResourceSeen(c: Ctx): Promise<Response> {
  const mID = c.params.id
  if (!isUUID(mID)) throw badRequest('invalid material id')
  const student = await whichChild(c)
  await c.db.prepare(`
    INSERT INTO study_material_views (institution_id, material_id, user_id, student_id, viewed_at)
    SELECT ?, sm.id, ?, ?, ?
      FROM study_materials sm
     WHERE sm.id = ? AND sm.is_published = 1
    ON CONFLICT (material_id, user_id) DO NOTHING`)
    .bind(institutionId(c), c.id.userId, student, now(), mID.toLowerCase()).run()
  return ok({ ok: true })
}

async function listStudyGroups(c: Ctx): Promise<Response> {
  const room = await myClassroom(c)
  const rows = await c.db.prepare(`
    SELECT x.*, (x.capacity IS NULL OR x.members < x.capacity) AS has_space FROM (
      SELECT g.id, g.name, g.topic, sub.name AS subject, g.meets_when, g.venue,
             g.capacity, g.is_open, g.created_at,
             ${shortName('o')} AS organiser,
             g.organiser_id = ? AS organised_by_me,
             (SELECT count(*) FROM study_group_members m
               WHERE m.group_id = g.id AND m.left_at IS NULL) AS members,
             (SELECT count(*) FROM study_group_members m
               WHERE m.group_id = g.id AND m.left_at IS NULL AND m.role = 'tutor') AS tutors,
             me.student_id IS NOT NULL AS joined,
             COALESCE(me.role, '') AS my_role,
             ${istDay('g.created_at')} AS created_on
        FROM study_groups g
        JOIN students o ON o.id = g.organiser_id
        LEFT JOIN class_subjects cs ON cs.id = g.class_subject_id
        LEFT JOIN subjects      sub ON sub.id = cs.subject_id
        LEFT JOIN study_group_members me
               ON me.group_id = g.id AND me.student_id = ? AND me.left_at IS NULL
       WHERE g.section_id = ?) x
     ORDER BY x.is_open DESC, x.created_at DESC
     LIMIT 200`)
    .bind(room.student_id, room.student_id, room.section_id).all<Record<string, unknown>>()
  const items = rows.results.map((r) => omit({
    id: r.id, name: r.name, topic: r.topic, subject: r.subject, meets_when: r.meets_when, venue: r.venue,
    capacity: r.capacity === null ? null : Number(r.capacity), is_open: b01(r.is_open),
    organiser: r.organiser, organised_by_me: b01(r.organised_by_me), members: Number(r.members),
    joined: b01(r.joined), my_role: r.my_role, has_space: b01(r.has_space), tutors: Number(r.tutors),
    created_on: r.created_on,
  }, 'topic', 'subject', 'meets_when', 'venue', 'capacity'))
  return ok({ items })
}

async function createStudyGroup(c: Ctx): Promise<Response> {
  const req = await body(c)
  const { studentId: student } = await portalChild(c, raw(req.student_id))
  if (tr(req.name) === '') throw badRequest('name is required')
  const room = await classroomOf(c, student)
  if (!room) throw codeErr(409, 'not_enrolled', 'you need an enrolment before you can start a group')
  let subject: string | null = null
  const sv = tr(req.class_subject_id)
  if (sv !== '') {
    if (!isUUID(sv)) throw badRequest('class_subject_id must be a uuid')
    subject = sv.toLowerCase()
  }
  const capacity = posInt(req.capacity)
  const role = truthy(req.offering_tutoring) ? 'tutor' : 'member'
  const inst = institutionId(c)
  const newID = uuid()
  const ts = now()
  const name = raw(req.name)
  // study_groups_one_open (section_id, lower(btrim(name))) WHERE is_open: enforced here.
  const [ins] = await c.db.batch([
    c.db.prepare(`
      INSERT INTO study_groups
          (id, institution_id, section_id, class_subject_id, organiser_id,
           name, topic, meets_when, venue, capacity, is_open, created_at)
      SELECT ?, ?, ?,
             (SELECT cs.id FROM class_subjects cs WHERE cs.id = ? AND cs.class_id = ?),
             ?, trim(?), ?, ?, ?, ?, 1, ?
       WHERE NOT EXISTS (SELECT 1 FROM study_groups g
                          WHERE g.section_id = ? AND g.is_open = 1
                            AND lower(trim(g.name)) = lower(trim(?)))`)
      .bind(newID, inst, room.section_id, subject, room.class_id, student, name,
        ns(req.topic), ns(req.meets_when), ns(req.venue), capacity, ts, room.section_id, name),
    c.db.prepare(`
      INSERT INTO study_group_members (id, institution_id, group_id, student_id, role, joined_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM study_groups WHERE id = ?)`)
      .bind(uuid(), inst, newID, student, role, ts, newID),
  ])
  if (!ins.meta.changes) throw codeErr(409, 'already_exists', 'your class already has an open group by that name')
  return created({ id: newID, role })
}

async function listStudyGroupMembers(c: Ctx): Promise<Response> {
  const student = await whichChild(c)
  const groupID = pathId(c)
  const rows = await c.db.prepare(`
    SELECT m.student_id, ${shortName('st')} AS name, m.role, ${istDay('m.joined_at')} AS joined_on
      FROM study_group_members m
      JOIN students st ON st.id = m.student_id
     WHERE m.group_id = ? AND m.left_at IS NULL
       AND EXISTS (SELECT 1 FROM study_group_members mine
                    WHERE mine.group_id = ? AND mine.student_id = ? AND mine.left_at IS NULL)
     ORDER BY m.role, st.first_name`)
    .bind(groupID, groupID, student).all<Record<string, unknown>>()
  if (rows.results.length === 0) throw notFound()
  return ok({ items: rows.results.map((r) => ({ student_id: r.student_id, name: r.name, role: r.role, joined_on: r.joined_on })) })
}

async function joinStudyGroup(c: Ctx): Promise<Response> {
  const req = await optionalBody(c)
  const { studentId: student } = await portalChild(c, raw(req.student_id))
  const groupID = pathId(c)
  const room = await classroomOf(c, student)
  if (!room) throw notFound()
  const role = truthy(req.offering_tutoring) ? 'tutor' : 'member'
  const newID = uuid()
  const cond = `g.id = ? AND g.section_id = ? AND g.is_open = 1
     AND (g.capacity IS NULL
          OR (SELECT count(*) FROM study_group_members m
               WHERE m.group_id = g.id AND m.left_at IS NULL) < g.capacity)`
  // study_group_members_one_live (group_id, student_id) WHERE left_at IS NULL: enforced here.
  const res = await c.db.prepare(`
    INSERT INTO study_group_members (id, institution_id, group_id, student_id, role, joined_at)
    SELECT ?, ?, g.id, ?, ?, ?
      FROM study_groups g
     WHERE ${cond}
       AND NOT EXISTS (SELECT 1 FROM study_group_members x
                        WHERE x.group_id = g.id AND x.student_id = ? AND x.left_at IS NULL)`)
    .bind(newID, institutionId(c), student, role, now(), groupID, room.section_id, student).run()
  if (!res.meta.changes) {
    const dup = await c.db.prepare(`
      SELECT 1 AS d FROM study_groups g
       WHERE ${cond}
         AND EXISTS (SELECT 1 FROM study_group_members x
                      WHERE x.group_id = g.id AND x.student_id = ? AND x.left_at IS NULL)`)
      .bind(groupID, room.section_id, student).first()
    if (dup) throw codeErr(409, 'already_joined', 'you are already in that group')
    throw codeErr(409, 'unavailable', 'that group is closed, full, or not one your class can join')
  }
  return created({ id: newID, role })
}

async function leaveStudyGroup(c: Ctx): Promise<Response> {
  const req = await optionalBody(c)
  const { studentId: student } = await portalChild(c, raw(req.student_id))
  const groupID = pathId(c)
  const row = await c.db.prepare(`
    UPDATE study_group_members
       SET left_at = ?
     WHERE group_id = ? AND student_id = ? AND left_at IS NULL
    RETURNING ${istMin('left_at')} AS left_at`)
    .bind(now(), groupID, student).first<{ left_at: string }>()
  if (!row) throw codeErr(409, 'not_a_member', 'you are not in that group')
  return ok({ left_at: row.left_at })
}

// --- portfolio

async function getPortfolio(c: Ctx): Promise<Response> {
  const student = await whichChild(c)
  const [items, awards] = await c.db.batch([
    c.db.prepare(`
      SELECT p.id, p.kind, p.title, p.description, sub.name AS subject, p.subject_id,
             p.happened_on, p.evidence_url, p.file_id, p.is_shared,
             ${istDay('p.created_at')} AS added_on
        FROM student_portfolio_items p
        LEFT JOIN subjects sub ON sub.id = p.subject_id
       WHERE p.student_id = ?
       ORDER BY p.happened_on DESC NULLS LAST, p.created_at DESC`).bind(student),
    c.db.prepare(`
      SELECT a.id, a.kind, a.title, a.level, a.position, a.awarded_on, a.description
        FROM student_achievements a
       WHERE a.student_id = ?
       ORDER BY a.awarded_on DESC NULLS LAST`).bind(student),
  ])
  return ok({
    student_id: student,
    items: (items.results as Record<string, unknown>[]).map((r) => omit({
      id: r.id, kind: r.kind, title: r.title, description: r.description, subject: r.subject,
      subject_id: r.subject_id, happened_on: r.happened_on, evidence_url: r.evidence_url,
      file_id: r.file_id, is_shared: b01(r.is_shared), added_on: r.added_on,
    }, 'description', 'subject', 'subject_id', 'happened_on', 'evidence_url', 'file_id')),
    school_awards: (awards.results as Record<string, unknown>[]).map((r) => omit({
      id: r.id, kind: r.kind, title: r.title, level: r.level, position: r.position,
      awarded_on: r.awarded_on, description: r.description,
    }, 'level', 'position', 'awarded_on', 'description')),
  })
}

async function addPortfolioItem(c: Ctx): Promise<Response> {
  const req = await body(c)
  const { studentId: student } = await portalChild(c, raw(req.student_id))
  if (tr(req.title) === '') throw badRequest('title is required')
  const kind = tr(req.kind) || 'project'
  const on = optionalDate(req.happened_on, 'happened_on must be YYYY-MM-DD')
  const subject = optionalUUID(req.subject_id, 'subject_id must be a uuid')
  const newID = uuid()
  const ts = now()
  const title = raw(req.title)
  // student_portfolio_items_no_duplicates (student_id, lower(btrim(title)), COALESCE(happened_on, '0001-01-01')).
  const res = await c.db.prepare(`
    INSERT INTO student_portfolio_items
        (id, institution_id, student_id, kind, title, description, subject_id,
         happened_on, evidence_url, is_shared, created_at, updated_at)
    SELECT ?, ?, ?, ?, trim(?), ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM student_portfolio_items p
                        WHERE p.student_id = ? AND lower(trim(p.title)) = lower(trim(?))
                          AND COALESCE(p.happened_on, '0001-01-01') = COALESCE(?, '0001-01-01'))`)
    .bind(newID, institutionId(c), student, kind, title, ns(req.description), subject, on,
      ns(req.evidence_url), truthy(req.is_shared) ? 1 : 0, ts, ts, student, title, on).run()
  if (!res.meta.changes) throw codeErr(409, 'already_added', 'that entry is already in your portfolio')
  return created({ id: newID })
}

async function updatePortfolioItem(c: Ctx): Promise<Response> {
  const req = await body(c)
  const { studentId: student } = await portalChild(c, raw(req.student_id))
  const itemID = pathId(c)
  const on = optionalDate(req.happened_on, 'happened_on must be YYYY-MM-DD')
  const subject = optionalUUID(req.subject_id, 'subject_id must be a uuid')
  const row = await c.db.prepare(`
    UPDATE student_portfolio_items
       SET kind        = COALESCE(nullif(trim(?), ''), kind),
           title       = COALESCE(nullif(trim(?), ''), title),
           description = ?,
           subject_id  = ?,
           happened_on = ?,
           evidence_url = ?,
           is_shared   = ?,
           updated_at  = ?
     WHERE id = ? AND student_id = ?
    RETURNING id`)
    .bind(raw(req.kind), raw(req.title), ns(req.description), subject, on, ns(req.evidence_url),
      truthy(req.is_shared) ? 1 : 0, now(), itemID, student).first<{ id: string }>()
  if (!row) throw notFound()
  return ok({ id: row.id })
}

async function deletePortfolioItem(c: Ctx): Promise<Response> {
  const student = await whichChild(c)
  const itemID = pathId(c)
  const row = await c.db.prepare(`DELETE FROM student_portfolio_items WHERE id = ? AND student_id = ? RETURNING id`)
    .bind(itemID, student).first<{ id: string }>()
  if (!row) throw notFound()
  return ok({ deleted: row.id })
}

// --- university shortlist

async function listUniversityShortlist(c: Ctx): Promise<Response> {
  const student = await whichChild(c)
  const rows = await c.db.prepare(`
    SELECT u.id, u.university, u.country, u.course, u.intake, u.application_deadline,
           u.entrance_exams, u.annual_fee_paise, u.scholarship_sought, u.status, u.notes,
           CAST(julianday(u.application_deadline) - julianday(?) AS INTEGER) AS days_to_deadline,
           ${istDay('u.created_at')} AS added_on
      FROM university_shortlist_entries u
     WHERE u.student_id = ?
     ORDER BY u.application_deadline ASC NULLS LAST, u.university`)
    .bind(todayIST(), student).all<Record<string, unknown>>()
  const items = rows.results.map((r) => omit({
    id: r.id, university: r.university, country: r.country, course: r.course, intake: r.intake,
    application_deadline: r.application_deadline, entrance_exams: r.entrance_exams,
    annual_fee_paise: r.annual_fee_paise === null ? null : Number(r.annual_fee_paise),
    scholarship_sought: b01(r.scholarship_sought), status: r.status, notes: r.notes,
    days_to_deadline: r.days_to_deadline === null ? null : Number(r.days_to_deadline), added_on: r.added_on,
  }, 'course', 'intake', 'application_deadline', 'entrance_exams', 'annual_fee_paise', 'notes', 'days_to_deadline'))
  return ok({ items })
}

async function addUniversityEntry(c: Ctx): Promise<Response> {
  const req = await body(c)
  const { studentId: student } = await portalChild(c, raw(req.student_id))
  if (tr(req.university) === '' || tr(req.country) === '') throw badRequest('university and country are required')
  const deadline = optionalDate(req.application_deadline, 'application_deadline must be YYYY-MM-DD')
  const status = tr(req.status) || 'researching'
  const fee = posInt(req.annual_fee_paise)
  const course = ns(req.course)
  const newID = uuid()
  const ts = now()
  // university_shortlist_entries_once (student_id, lower(btrim(university)), lower(btrim(COALESCE(course, '')))).
  const res = await c.db.prepare(`
    INSERT INTO university_shortlist_entries
        (id, institution_id, student_id, university, country, course, intake,
         application_deadline, entrance_exams, annual_fee_paise,
         scholarship_sought, status, notes, created_at, updated_at)
    SELECT ?, ?, ?, trim(?), trim(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM university_shortlist_entries u
                        WHERE u.student_id = ? AND lower(trim(u.university)) = lower(trim(?))
                          AND lower(trim(COALESCE(u.course, ''))) = lower(trim(COALESCE(?, ''))))`)
    .bind(newID, institutionId(c), student, raw(req.university), raw(req.country), course, ns(req.intake),
      deadline, ns(req.entrance_exams), fee, truthy(req.scholarship_sought) ? 1 : 0, status, ns(req.notes),
      ts, ts, student, raw(req.university), course).run()
  if (!res.meta.changes) throw codeErr(409, 'already_shortlisted', 'that university and course are already on your list')
  return created({ id: newID })
}

async function updateUniversityEntry(c: Ctx): Promise<Response> {
  const req = await body(c)
  const { studentId: student } = await portalChild(c, raw(req.student_id))
  const entryID = pathId(c)
  const deadline = optionalDate(req.application_deadline, 'application_deadline must be YYYY-MM-DD')
  const fee = typeof req.annual_fee_paise === 'number' && Number.isFinite(req.annual_fee_paise) ? Math.trunc(req.annual_fee_paise) : 0
  const row = await c.db.prepare(`
    UPDATE university_shortlist_entries
       SET status = COALESCE(nullif(trim(?), ''), status),
           course = COALESCE(nullif(trim(?), ''), course),
           intake = COALESCE(nullif(trim(?), ''), intake),
           application_deadline = COALESCE(?, application_deadline),
           entrance_exams = COALESCE(nullif(trim(?), ''), entrance_exams),
           annual_fee_paise = COALESCE(nullif(?, 0), annual_fee_paise),
           scholarship_sought = ?,
           notes = COALESCE(nullif(trim(?), ''), notes),
           updated_at = ?
     WHERE id = ? AND student_id = ?
    RETURNING id, status`)
    .bind(raw(req.status), raw(req.course), raw(req.intake), deadline, raw(req.entrance_exams), fee,
      truthy(req.scholarship_sought) ? 1 : 0, raw(req.notes), now(), entryID, student)
    .first<{ id: string; status: string }>()
  if (!row) throw notFound()
  return ok({ id: row.id, status: row.status })
}

async function deleteUniversityEntry(c: Ctx): Promise<Response> {
  const student = await whichChild(c)
  const entryID = pathId(c)
  const row = await c.db.prepare(`DELETE FROM university_shortlist_entries WHERE id = ? AND student_id = ? RETURNING id`)
    .bind(entryID, student).first<{ id: string }>()
  if (!row) throw notFound()
  return ok({ deleted: row.id })
}

// ---------------------------------------------------------------------------
// campus life

async function listLostFound(c: Ctx): Promise<Response> {
  const room = await myClassroom(c)
  const kind = ns((c.url.searchParams.get('kind') ?? '').trim())
  const status = ns((c.url.searchParams.get('status') ?? '').trim())
  const rows = await c.db.prepare(`
    SELECT lf.id, lf.kind, lf.title, lf.description, lf.category, lf.place, lf.on_date,
           u.full_name AS reported_by,
           CASE WHEN rs.id IS NOT NULL THEN COALESCE(
             (SELECT cl.name || '-' || sec.name
                FROM enrollments e
                JOIN classes  cl  ON cl.id = e.class_id
                JOIN sections sec ON sec.id = e.section_id
               WHERE e.student_id = rs.id ORDER BY e.enrolled_on DESC LIMIT 1), '') END AS reporter_class,
           lf.status, lf.reported_by = ? AS reported_by_me,
           ${istDay('lf.resolved_at')} AS resolved_on, lf.resolution_note
      FROM lost_found_items lf
      JOIN users u ON u.id = lf.reported_by
      LEFT JOIN students rs ON rs.id = lf.reporter_student_id
     WHERE lf.campus_id = ?
       AND (? IS NULL OR lf.kind = ?)
       AND (? IS NULL OR lf.status = ?)
     ORDER BY (lf.status = 'open') DESC, lf.on_date DESC, lf.created_at DESC
     LIMIT 300`)
    .bind(c.id.userId, room.campus_id, kind, kind, status, status).all<Record<string, unknown>>()
  const items = rows.results.map((r) => omit({
    id: r.id, kind: r.kind, title: r.title, description: r.description, category: r.category,
    place: r.place, on_date: r.on_date, reported_by: r.reported_by, reporter_class: r.reporter_class,
    status: r.status, reported_by_me: b01(r.reported_by_me), resolved_on: r.resolved_on,
    resolution_note: r.resolution_note,
  }, 'description', 'category', 'place', 'reporter_class', 'resolved_on', 'resolution_note'))
  return ok({ items })
}

async function reportLostFound(c: Ctx): Promise<Response> {
  const req = await body(c)
  const { studentId: student } = await portalChild(c, raw(req.student_id))
  const room = await classroomOf(c, student)
  if (!room) throw codeErr(409, 'not_enrolled', 'you need an enrolment before you can post to the board')
  const kind = tr(req.kind)
  if (kind !== 'lost' && kind !== 'found') throw badRequest('kind must be lost or found')
  if (tr(req.title) === '') throw badRequest('title is required')
  const on = optionalDate(req.on_date, 'on_date must be YYYY-MM-DD') ?? todayIST()
  const newID = uuid()
  await c.db.prepare(`
    INSERT INTO lost_found_items
        (id, institution_id, campus_id, kind, title, description, category,
         place, on_date, reported_by, reporter_student_id, status, created_at)
    VALUES (?, ?, ?, ?, trim(?), ?, ?, ?, ?, ?, ?, 'open', ?)`)
    .bind(newID, institutionId(c), room.campus_id, kind, raw(req.title), ns(req.description),
      ns(req.category), ns(req.place), on, c.id.userId, student, now()).run()
  return created({ id: newID })
}

async function resolveLostFound(c: Ctx): Promise<Response> {
  const req = await optionalBody(c)
  const itemID = pathId(c)
  const status = tr(req.status) || 'returned'
  if (status !== 'returned' && status !== 'closed' && status !== 'claimed') {
    throw badRequest('status must be claimed, returned or closed')
  }
  const staff = can(c.id, 'office.front_desk.write') ? 1 : 0
  const settles = status === 'returned' || status === 'closed'
  const row = await c.db.prepare(`
    UPDATE lost_found_items
       SET status = ?,
           resolved_at = ?,
           resolved_by = ?,
           resolution_note = COALESCE(nullif(trim(?), ''), resolution_note)
     WHERE id = ?
       AND status IN ('open','claimed')
       AND (reported_by = ? OR ? = 1)
    RETURNING id`)
    .bind(status, settles ? now() : null, settles ? c.id.userId : null, raw(req.note), itemID, c.id.userId, staff)
    .first<{ id: string }>()
  if (!row) throw notFound()
  return ok({ id: row.id, status })
}

async function getMyLocker(c: Ctx): Promise<Response> {
  const student = await whichChild(c)
  const locker = await c.db.prepare(`
    SELECT l.id, l.locker_no, l.location, l.assigned_on, l.combination IS NOT NULL AS has_combination
      FROM student_lockers l
     WHERE l.student_id = ? AND l.released_on IS NULL
     LIMIT 1`).bind(student)
    .first<{ id: string; locker_no: string; location: string | null; assigned_on: string | null; has_combination: number }>()
  let log: Record<string, unknown>[] = []
  if (locker) {
    const rows = await c.db.prepare(`
      SELECT ev.action, ${istMin('ev.happened_at')} AS happened_at, u.full_name AS actor, ev.note
        FROM locker_access_events ev
        LEFT JOIN users u ON u.id = ev.actor_user_id
       WHERE ev.locker_id = ?
       ORDER BY ev.happened_at DESC
       LIMIT 100`).bind(locker.id).all<Record<string, unknown>>()
    log = rows.results.map((r) => omit({ action: r.action, happened_at: r.happened_at, actor: r.actor, note: r.note }, 'actor', 'note'))
  }
  return ok({
    student_id: student,
    assigned: !!locker,
    locker_id: locker?.id ?? null, locker_no: locker?.locker_no ?? null, location: locker?.location ?? null,
    assigned_on: locker?.assigned_on ?? null, has_combination: locker ? b01(locker.has_combination) : false,
    access_log: log,
  })
}

async function revealLockerCombination(c: Ctx): Promise<Response> {
  const req = await optionalBody(c)
  const { studentId: student } = await portalChild(c, raw(req.student_id))
  // The read and the audit row go in one batch so no path returns the number without logging it.
  const [sel, ins] = await c.db.batch([
    c.db.prepare(`SELECT id, locker_no, combination FROM student_lockers
                   WHERE student_id = ? AND released_on IS NULL LIMIT 1`).bind(student),
    c.db.prepare(`
      INSERT INTO locker_access_events (id, institution_id, locker_id, student_id, actor_user_id, action, happened_at)
      SELECT ?, ?, l.id, ?, ?, 'combination_viewed', ?
        FROM (SELECT id FROM student_lockers WHERE student_id = ? AND released_on IS NULL LIMIT 1) l`)
      .bind(uuid(), institutionId(c), student, c.id.userId, now(), student),
  ])
  const row = (sel.results as { id: string; locker_no: string; combination: string | null }[])[0]
  if (!row || !ins.meta.changes) throw notFound()
  return ok({ locker_no: row.locker_no, combination: row.combination })
}

async function logLockerAccess(c: Ctx): Promise<Response> {
  const req = await body(c)
  const { studentId: student } = await portalChild(c, raw(req.student_id))
  const action = tr(req.action)
  if (!['opened', 'closed', 'reported_jammed', 'reported_tampered'].includes(action)) {
    throw badRequest('action must be opened, closed, reported_jammed or reported_tampered')
  }
  const newID = uuid()
  const res = await c.db.prepare(`
    INSERT INTO locker_access_events (id, institution_id, locker_id, student_id, actor_user_id, action, note, happened_at)
    SELECT ?, ?, l.id, ?, ?, ?, ?, ?
      FROM (SELECT id FROM student_lockers WHERE student_id = ? AND released_on IS NULL LIMIT 1) l`)
    .bind(newID, institutionId(c), student, c.id.userId, action, ns(req.note), now(), student).run()
  if (!res.meta.changes) throw notFound()
  return created({ id: newID, action })
}

/* Office allotment. Postgres upserted on student_lockers_number
   (institution, campus, lower(btrim(locker_no))) and refused a second live
   locker per child via student_lockers_one_live; neither index exists in the
   D1 schema, so both are enforced here. */
async function assignLocker(c: Ctx): Promise<Response> {
  requirePerm(c, 'students.write')
  const req = await body(c)
  const sid = tr(req.student_id)
  if (!isUUID(sid)) throw badRequest('student_id must be a uuid')
  if (tr(req.locker_no) === '') throw badRequest('locker_no is required')
  const inst = institutionId(c)
  const st = await c.db.prepare(`SELECT id, campus_id FROM students WHERE id = ?`).bind(sid.toLowerCase())
    .first<{ id: string; campus_id: string }>()
  if (!st) throw notFound()
  const lockerNo = raw(req.locker_no)
  const existing = await c.db.prepare(`
    SELECT id FROM student_lockers
     WHERE institution_id = ? AND campus_id = ? AND lower(trim(locker_no)) = lower(trim(?))`)
    .bind(inst, st.campus_id, lockerNo).first<{ id: string }>()
  const other = await c.db.prepare(`
    SELECT 1 AS x FROM student_lockers
     WHERE institution_id = ? AND student_id = ? AND released_on IS NULL AND id <> ?`)
    .bind(inst, st.id, existing?.id ?? '').first()
  if (other) throw codeErr(409, 'already_allotted', 'that student already holds a locker; release it first')
  const today = todayIST()
  const location = ns(req.location)
  const combination = ns(req.combination)
  if (existing) {
    await c.db.prepare(`
      UPDATE student_lockers
         SET student_id  = ?,
             location    = COALESCE(?, location),
             combination = COALESCE(?, combination),
             assigned_on = ?,
             released_on = NULL
       WHERE id = ?`).bind(st.id, location, combination, today, existing.id).run()
    return created({ id: existing.id })
  }
  const newID = uuid()
  await c.db.prepare(`
    INSERT INTO student_lockers
        (id, institution_id, campus_id, locker_no, location, student_id, combination, assigned_on, created_at)
    VALUES (?, ?, ?, trim(?), ?, ?, ?, ?, ?)`)
    .bind(newID, inst, st.campus_id, lockerNo, location, st.id, combination, today, now()).run()
  return created({ id: newID })
}

async function listClubEvents(c: Ctx): Promise<Response> {
  const room = await myClassroom(c)
  const ts = now()
  const rows = await c.db.prepare(`
    SELECT x.*,
           CASE WHEN x.capacity IS NOT NULL THEN max(x.capacity - x.booked, 0) END AS seats_left,
           (x.status = 'open'
             AND (x.closes_raw IS NULL OR x.closes_raw > ?)
             AND x.starts_raw > ?
             AND (x.capacity IS NULL OR x.booked < x.capacity)
             AND x.ticket_id IS NULL) AS can_book
      FROM (
        SELECT ev.id, ev.club_name, ev.title, ev.description, ev.venue,
               ev.starts_at AS starts_raw, ev.booking_closes_at AS closes_raw,
               ${istMin('ev.starts_at')} AS starts_at,
               ${istMin('ev.ends_at')} AS ends_at,
               ev.capacity, ev.ticket_price_paise,
               ${istMin('ev.booking_closes_at')} AS booking_closes_at,
               ev.status,
               (SELECT count(*) FROM club_event_tickets ct
                 WHERE ct.event_id = ev.id AND ct.status <> 'cancelled') AS booked,
               t.id AS ticket_id, t.code AS ticket_code, t.status AS ticket_status,
               ${istMin('t.checked_in_at')} AS checked_in_at
          FROM club_events ev
          LEFT JOIN club_event_tickets t
                 ON t.event_id = ev.id AND t.student_id = ? AND t.status <> 'cancelled'
         WHERE ev.campus_id = ?
           AND ev.status <> 'draft'
           AND (ev.min_class_level IS NULL OR ev.min_class_level <= ?)
           AND (ev.max_class_level IS NULL OR ev.max_class_level >= ?)) x
     ORDER BY x.starts_raw
     LIMIT 200`)
    .bind(ts, ts, room.student_id, room.campus_id, room.level, room.level).all<Record<string, unknown>>()
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  const items = rows.results.map((r) => omit({
    id: r.id, club_name: r.club_name, title: r.title, description: r.description, venue: r.venue,
    starts_at: r.starts_at, ends_at: r.ends_at, capacity: n(r.capacity),
    ticket_price_paise: Number(r.ticket_price_paise), booking_closes_at: r.booking_closes_at,
    status: r.status, tickets_booked: Number(r.booked), seats_left: n(r.seats_left),
    ticket_id: r.ticket_id, ticket_code: r.ticket_code, ticket_status: r.ticket_status,
    checked_in_at: r.checked_in_at, can_book: b01(r.can_book),
  }, 'description', 'venue', 'ends_at', 'capacity', 'booking_closes_at', 'seats_left',
  'ticket_id', 'ticket_code', 'ticket_status', 'checked_in_at'))
  return ok({ items })
}

async function bookEventTicket(c: Ctx): Promise<Response> {
  const req = await optionalBody(c)
  const { studentId: student } = await portalChild(c, raw(req.student_id))
  const eventID = pathId(c)
  const room = await classroomOf(c, student)
  if (!room) throw notFound()
  const code = ticketCode()
  const ts = now()
  const newID = uuid()
  const cond = `ev.id = ? AND ev.campus_id = ? AND ev.status = 'open'
     AND ev.starts_at > ?
     AND (ev.booking_closes_at IS NULL OR ev.booking_closes_at > ?)
     AND (ev.min_class_level IS NULL OR ev.min_class_level <= ?)
     AND (ev.max_class_level IS NULL OR ev.max_class_level >= ?)
     AND (ev.capacity IS NULL
          OR (SELECT count(*) FROM club_event_tickets ct
               WHERE ct.event_id = ev.id AND ct.status <> 'cancelled') < ev.capacity)`
  const condArgs = [eventID, room.campus_id, ts, ts, room.level, room.level]
  const live = `EXISTS (SELECT 1 FROM club_event_tickets x
                        WHERE x.event_id = ev.id AND x.student_id = ? AND x.status <> 'cancelled')`
  // club_event_tickets_one_live (event_id, student_id) WHERE status <> 'cancelled': enforced here.
  let changes = 0
  try {
    const res = await c.db.prepare(`
      INSERT INTO club_event_tickets (id, institution_id, event_id, student_id, code, booked_at, status)
      SELECT ?, ?, ev.id, ?, ?, ?, 'booked'
        FROM club_events ev
       WHERE ${cond} AND NOT ${live}`)
      .bind(newID, institutionId(c), student, code, ts, ...condArgs, student).run()
    changes = res.meta.changes
  } catch (e) {
    if (isUniqueErr(e)) throw codeErr(409, 'already_booked', 'you already have a ticket for that event')
    throw e
  }
  if (!changes) {
    const dup = await c.db.prepare(`SELECT 1 AS d FROM club_events ev WHERE ${cond} AND ${live}`)
      .bind(...condArgs, student).first()
    if (dup) throw codeErr(409, 'already_booked', 'you already have a ticket for that event')
    throw codeErr(409, 'unavailable', 'that event is full, closed, or not open to your class')
  }
  return created({ id: newID, code })
}

async function cancelEventTicket(c: Ctx): Promise<Response> {
  const req = await optionalBody(c)
  const { scope } = await portalChild(c, raw(req.student_id))
  const ticketID = pathId(c)
  const ids = scope.studentIds
  const row = ids.length === 0 ? null : await c.db.prepare(`
    UPDATE club_event_tickets
       SET status = 'cancelled', cancelled_at = ?
     WHERE id = ? AND student_id IN (${marks(ids)}) AND status = 'booked'
    RETURNING id`).bind(now(), ticketID, js(ids)).first<{ id: string }>()
  if (!row) throw codeErr(409, 'not_cancellable', 'that ticket is not yours, or has already been used or cancelled')
  return ok({ id: row.id, status: 'cancelled' })
}

async function checkInEventTicket(c: Ctx): Promise<Response> {
  requirePerm(c, 'office.front_desk.write')
  const req = await body(c)
  const code = tr(req.code).toUpperCase()
  if (code === '') throw badRequest('code is required')
  const inst = institutionId(c)
  const [sel, upd] = await c.db.batch([
    c.db.prepare(`
      SELECT ${shortName('st')} AS student, ev.club_name, ev.title, ct.status <> 'booked' AS already
        FROM club_event_tickets ct
        JOIN students    st ON st.id = ct.student_id
        JOIN club_events ev ON ev.id = ct.event_id
       WHERE ct.institution_id = ? AND ct.code = ?`).bind(inst, code),
    c.db.prepare(`
      UPDATE club_event_tickets
         SET status = 'checked_in', checked_in_at = ?, checked_in_by = ?
       WHERE institution_id = ? AND code = ? AND status = 'booked'`).bind(now(), c.id.userId, inst, code),
  ])
  void upd
  const row = (sel.results as { student: string; club_name: string; title: string; already: number }[])[0]
  if (!row) throw notFound()
  if (b01(row.already)) {
    throw codeErr(409, 'already_used', `that code has already been used or cancelled (${row.student})`)
  }
  return ok({ student_name: row.student, club_name: row.club_name, title: row.title, status: 'checked_in' })
}

async function createClubEvent(c: Ctx): Promise<Response> {
  requirePerm(c, 'comms.announcements.write')
  const req = await body(c)
  if (tr(req.club_name) === '' || tr(req.title) === '') throw badRequest('club_name and title are required')
  const starts = rfc3339(tr(req.starts_at))
  if (!starts) throw badRequest('starts_at must be RFC3339, for example 2026-09-01T16:00:00+05:30')
  let ends: string | null = null
  let closes: string | null = null
  if (tr(req.ends_at) !== '') {
    ends = rfc3339(tr(req.ends_at))
    if (!ends) throw badRequest('ends_at must be RFC3339')
  }
  if (tr(req.booking_closes_at) !== '') {
    closes = rfc3339(tr(req.booking_closes_at))
    if (!closes) throw badRequest('booking_closes_at must be RFC3339')
  }
  const inst = institutionId(c)
  let campus = optionalUUID(req.campus_id, 'campus_id must be a uuid')
  if (!campus) {
    // A single-campus school should not have to name its campus on every form.
    const first = await c.db.prepare(`SELECT id FROM campuses WHERE institution_id = ? ORDER BY created_at LIMIT 1`)
      .bind(inst).first<{ id: string }>()
    if (!first) throw badRequest('no campus on record')
    campus = first.id
  }
  const price = typeof req.ticket_price_paise === 'number' && Number.isFinite(req.ticket_price_paise)
    ? Math.trunc(req.ticket_price_paise) : 0
  const newID = uuid()
  const club = raw(req.club_name), title = raw(req.title)
  // club_events_once (institution_id, campus_id, lower(btrim(club_name)), lower(btrim(title)), starts_at): enforced here.
  const res = await c.db.prepare(`
    INSERT INTO club_events
        (id, institution_id, campus_id, club_name, title, description, venue,
         starts_at, ends_at, capacity, ticket_price_paise,
         booking_closes_at, min_class_level, max_class_level, status, created_by, created_at)
    SELECT ?, ?, ?, trim(?), trim(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM club_events e
                        WHERE e.institution_id = ? AND e.campus_id = ?
                          AND lower(trim(e.club_name)) = lower(trim(?))
                          AND lower(trim(e.title)) = lower(trim(?))
                          AND e.starts_at = ?)`)
    .bind(newID, inst, campus, club, title, ns(req.description), ns(req.venue), starts, ends,
      posInt(req.capacity), price, closes, posInt(req.min_class_level), posInt(req.max_class_level),
      c.id.userId, now(), inst, campus, club, title, starts).run()
  if (!res.meta.changes) throw codeErr(409, 'already_listed', 'that club already has an event by that name at that time')
  return created({ id: newID })
}

// ---------------------------------------------------------------------------

export function registerPortalLearning(r: Router): void {
  // Learning.
  r.get('/portal/learning/courses', PERM, listMyCourses)
  r.get('/portal/learning/resources', PERM, listMyResources)
  r.post('/portal/learning/resources/{id}/seen', PERM, markResourceSeen)
  r.get('/portal/learning/study-groups', PERM, listStudyGroups)
  r.post('/portal/learning/study-groups', PERM, createStudyGroup)
  r.get('/portal/learning/study-groups/{id}/members', PERM, listStudyGroupMembers)
  r.post('/portal/learning/study-groups/{id}/join', PERM, joinStudyGroup)
  r.post('/portal/learning/study-groups/{id}/leave', PERM, leaveStudyGroup)
  r.get('/portal/learning/portfolio', PERM, getPortfolio)
  r.post('/portal/learning/portfolio', PERM, addPortfolioItem)
  r.post('/portal/learning/portfolio/{id}', PERM, updatePortfolioItem)
  r.del('/portal/learning/portfolio/{id}', PERM, deletePortfolioItem)
  r.get('/portal/learning/universities', PERM, listUniversityShortlist)
  r.post('/portal/learning/universities', PERM, addUniversityEntry)
  r.post('/portal/learning/universities/{id}', PERM, updateUniversityEntry)
  r.del('/portal/learning/universities/{id}', PERM, deleteUniversityEntry)

  // Campus life. Literal paths before {id} paths.
  r.get('/portal/campus/lost-found', PERM, listLostFound)
  r.post('/portal/campus/lost-found', PERM, reportLostFound)
  r.post('/portal/campus/lost-found/{id}/resolve', PERM, resolveLostFound)
  r.get('/portal/campus/locker', PERM, getMyLocker)
  r.post('/portal/campus/locker/reveal', PERM, revealLockerCombination)
  r.post('/portal/campus/locker/access', PERM, logLockerAccess)
  r.post('/portal/campus/lockers', PERM, assignLocker)
  r.get('/portal/campus/events', PERM, listClubEvents)
  r.post('/portal/campus/events/check-in', PERM, checkInEventTicket)
  r.post('/portal/campus/events', PERM, createClubEvent)
  r.post('/portal/campus/events/{id}/ticket', PERM, bookEventTicket)
  r.post('/portal/campus/tickets/{id}/cancel', PERM, cancelEventTicket)
}
