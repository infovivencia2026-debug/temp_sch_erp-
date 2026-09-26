import type { Router, Ctx } from '../../router'
import { badRequest, conflict, created, isUUID, notFound, ok, readJSON, now, uuid, bool } from '../../http'
import { can } from '../../identity'
import {
  addDays, fullName, inList, institutionId, parseYMD, portalChild, requireAny, requirePerm,
  resolveScope, shortName, todayIST, ymd, type Scope,
} from '../teaching/common'

/* Port of internal/api/student_life.go (mountStudentLife: lost-property claims,
   the student wall, the diary, display preferences, live-class hand raises)
   and internal/api/student_growth.go (mountStudentGrowth: streak, badges, hall
   of fame). Mounted under /portal; group perm self.profile.read.

   Postgres ran every to_char in Asia/Kolkata (database/resolver.go), so every
   timestamp rendered here is shifted by +330 minutes before formatting. */

const PERM = 'self.profile.read'
const FRONT_DESK_WRITE = 'office.front_desk.write'
const ANNOUNCEMENTS_WRITE = 'comms.announcements.write'
const HOMEWORK_WRITE = 'academics.homework.write'
const FEAT_STREAK = 'student.learning.gamified_learning_streak_counter'
const FEAT_BADGES = 'student.learning.gamified_learning_badge_showcase'
const FEAT_HALL_OF_FAME = 'student.campus_life.digital_hall_of_fame'

// ---------------------------------------------------------------------------
// helpers

/** to_char(col, fmt) in Indian time; NULL stays NULL. */
const ist = (col: string, fmt = '%Y-%m-%dT%H:%M') => `strftime('${fmt}', ${col}, '+330 minutes')`
/** Postgres concat_ws: joins the non-NULL arguments, '' when all are NULL. */
const cws = (sep: string, ...exprs: string[]) =>
  `substr(${exprs.map((e) => `COALESCE('${sep}' || (${e}), '')`).join(' || ')}, ${[...sep].length + 1})`
/** Latest enrolment of a student alias, as LEFT JOIN target (port of the LATERAL joins). */
const latestEnrollment = (alias: string, studentAlias: string) =>
  `LEFT JOIN enrollments ${alias} ON ${alias}.id = (SELECT e.id FROM enrollments e WHERE e.student_id = ${studentAlias}.id ORDER BY e.enrolled_on DESC LIMIT 1)`
const blen = (s: string) => new TextEncoder().encode(s).length
const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const omitNull = <T extends Record<string, unknown>>(o: T): T => { for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined) delete o[k]; return o }

/** pathUUID: anything but a uuid is a 404, indistinguishable from "not yours". */
function pathUUID(c: Ctx, key = 'id'): string {
  const v = c.params[key]
  if (!isUUID(v)) throw notFound('resource not found')
  return v
}
/** Go's optionalDate. */
function optionalDate(raw: unknown, msg: string): string | null {
  const v = s(raw).trim()
  if (v === '') return null
  const d = parseYMD(v)
  if (!d || ymd(d) !== v) throw badRequest(msg)
  return v
}
/** Body decoded only when present (Go's `r.ContentLength > 0 && Decode`). */
async function optionalJSON(c: Ctx): Promise<Record<string, unknown>> {
  const text = await c.req.text()
  if (text.trim() === '') return {}
  try { return JSON.parse(text) as Record<string, unknown> } catch { throw badRequest('malformed JSON body') }
}
const inScope = (st: Scope) => (col: string) => inList(col, st.studentIds)

/** whichChild (portal_family.go): named child must be the caller's; default the first. */
async function whichChild(c: Ctx): Promise<string> {
  const sc = await resolveScope(c)
  if (sc.studentIds.length === 0) throw notFound('resource not found')
  const q = c.url.searchParams.get('student_id')
  if (q) {
    if (sc.studentIds.includes(q)) return q
    throw notFound('resource not found')
  }
  return sc.studentIds[0]
}

interface Classroom {
  studentId: string; campusId: string; classId: string; sectionId: string; yearId: string
  level: number; className: string; sectionName: string; admissionNo: string; studentName: string
}
/** classroomOf (student_learning.go): active enrolment first, else the latest. */
async function classroomOf(c: Ctx, student: string): Promise<Classroom | null> {
  const r = await c.db.prepare(`
      SELECT st.campus_id, e.class_id, e.section_id, e.academic_year_id, cl.level, cl.name AS class_name,
             sec.name AS section_name, st.admission_no, ${fullName('st')} AS student_name
        FROM students st
        JOIN enrollments e ON e.student_id = st.id
        JOIN classes cl ON cl.id = e.class_id
        JOIN sections sec ON sec.id = e.section_id
       WHERE st.id = ?
       ORDER BY (e.status = 'active') DESC, e.enrolled_on DESC
       LIMIT 1`).bind(student).first<Record<string, string | number>>()
  if (!r) return null
  return {
    studentId: student, campusId: String(r.campus_id), classId: String(r.class_id), sectionId: String(r.section_id),
    yearId: String(r.academic_year_id), level: Number(r.level), className: String(r.class_name),
    sectionName: String(r.section_name), admissionNo: String(r.admission_no), studentName: String(r.student_name),
  }
}
async function myClassroom(c: Ctx): Promise<Classroom> {
  const student = await whichChild(c)
  const room = await classroomOf(c, student)
  if (!room) throw conflict('this student has no enrolment on record; ask the office to complete the admission')
  return room
}

/** logStudentContent: one row of the takedown trail, as a batch statement. */
const logStudentContent = (c: Ctx, kind: string, id: string, action: string, reason: string) =>
  c.db.prepare(`INSERT INTO student_content_moderation (id, institution_id, content_kind, content_id, action, actor_user_id, reason, created_at)
                VALUES (?, ?, ?, ?, ?, ?, nullif(trim(?), ''), ?)`)
    .bind(uuid(), institutionId(c), kind, id, action, c.id.userId, reason, now())

// ---------------------------------------------------------------------------
// lost and found: photo and claims

async function attachLostFoundPhoto(c: Ctx) {
  const itemID = pathUUID(c)
  const req = await readJSON(c.req)
  const externalURL = s(req.external_url).trim()
  const claimPrompt = s(req.claim_prompt).trim()
  const fileRef = s(req.file_id).trim()
  if ((fileRef === '') === (externalURL === '')) throw badRequest('attach exactly one of file_id (upload it first) or external_url')
  if (fileRef !== '' && !isUUID(fileRef)) throw badRequest('file_id must be a uuid')
  const staff = can(c.id, FRONT_DESK_WRITE) ? 1 : 0
  const item = await c.db.prepare(`SELECT id FROM lost_found_items WHERE id = ? AND status IN ('open','claimed') AND (reported_by = ? OR ?)`)
    .bind(itemID, c.id.userId, staff).first()
  if (!item) throw notFound('resource not found')
  const out = await c.db.prepare(`
      UPDATE lost_found_items
         SET file_id = nullif(?, ''), photo_url = nullif(?, ''), claim_prompt = COALESCE(nullif(?, ''), claim_prompt)
       WHERE id = ? AND status IN ('open','claimed') AND (reported_by = ? OR ?)
      RETURNING id`).bind(fileRef, externalURL, claimPrompt, itemID, c.id.userId, staff).first<{ id: string }>()
  if (!out) throw notFound('resource not found')
  return ok({ id: out.id })
}

async function claimLostFoundItem(c: Ctx) {
  const itemID = pathUUID(c)
  const req = await readJSON(c.req)
  const { studentId: student } = await portalChild(c, s(req.student_id))
  const answer = s(req.answer).trim()
  if (blen(answer) < 10) throw badRequest('describe something about the item the photo does not show. A few words is not enough to tell one bottle from another')
  const item = await c.db.prepare(`SELECT reported_by, reporter_student_id, status FROM lost_found_items WHERE id = ? AND status IN ('open','claimed')`)
    .bind(itemID).first<{ reporter_student_id: string | null }>()
  if (!item) throw notFound('resource not found')
  if (item.reporter_student_id !== null && item.reporter_student_id === student) throw badRequest('this is your own notice')
  const id = uuid()
  // lost_found_claims_one_open: one pending or approved claim per child per item.
  const res = await c.db.prepare(`
      INSERT INTO lost_found_claims (id, institution_id, item_id, claimant_student_id, claimed_by, answer, status, created_at)
      SELECT ?, ?, ?, ?, ?, ?, 'pending', ?
       WHERE NOT EXISTS (SELECT 1 FROM lost_found_claims WHERE item_id = ? AND claimant_student_id = ? AND status IN ('pending','approved'))`)
    .bind(id, institutionId(c), itemID, student, c.id.userId, answer, now(), itemID, student).run()
  if (!res.meta.changes) throw conflict('you have already claimed this item; wait for it to be decided')
  return created({ id, status: 'pending' })
}

async function listLostFoundClaims(c: Ctx) {
  const itemID = pathUUID(c)
  const sc = await resolveScope(c)
  const staff = can(c.id, FRONT_DESK_WRITE) ? 1 : 0
  const mine = inList('c.claimant_student_id', sc.studentIds)
  const u = c.id.userId
  const see = `(lf.reported_by = ? OR ? OR c.claimed_by = ?)`
  const rows = await c.db.prepare(`
      SELECT c.id, c.item_id, lf.title AS item_title, c.claimant_student_id,
             ${cws(' ', 'st.first_name', 'st.last_name')} AS claimant_name,
             ${cws('-', 'cl.name', 'sec.name')} AS claimant_class,
             CASE WHEN ${see} THEN c.answer END AS answer,
             c.status, u.full_name AS decided_by, ${ist('c.decided_at')} AS decided_at, c.decision_note,
             date(c.created_at, '+330 minutes') AS claimed_on,
             (c.claimed_by = ?) AS claimed_by_me,
             ((lf.reported_by = ? OR ?) AND c.status = 'pending') AS can_decide,
             CASE WHEN ${see} THEN lf.claim_prompt END AS claim_prompt
        FROM lost_found_claims c
        JOIN lost_found_items lf ON lf.id = c.item_id
        JOIN students st ON st.id = c.claimant_student_id
        LEFT JOIN users u ON u.id = c.decided_by
        ${latestEnrollment('en', 'st')}
        LEFT JOIN classes cl ON cl.id = en.class_id
        LEFT JOIN sections sec ON sec.id = en.section_id
       WHERE c.item_id = ?
         AND (lf.reported_by = ? OR ? OR ${mine.sql})
       ORDER BY c.created_at`)
    .bind(u, staff, u, u, u, staff, u, staff, u, itemID, u, staff, ...mine.args).all<Record<string, unknown>>()
  const items = rows.results.map((r) => omitNull({
    id: r.id, item_id: r.item_id, item_title: r.item_title, claimant_student_id: r.claimant_student_id,
    claimant_name: r.claimant_name, claimant_class: r.claimant_class, answer: r.answer, status: r.status,
    decided_by: r.decided_by, decided_at: r.decided_at, decision_note: r.decision_note, claimed_on: r.claimed_on,
    claimed_by_me: bool(r.claimed_by_me), can_decide: bool(r.can_decide), claim_prompt: r.claim_prompt,
  }))
  return ok({ items })
}

async function decideLostFoundClaim(c: Ctx) {
  const claimID = pathUUID(c)
  const req = await readJSON(c.req)
  const decision = s(req.decision).trim()
  if (decision !== 'approved' && decision !== 'rejected') throw badRequest('decision must be approved or rejected')
  const note = s(req.note)
  const staff = can(c.id, FRONT_DESK_WRITE) ? 1 : 0
  const row = await c.db.prepare(`
      SELECT c.item_id, c.claimant_student_id, lf.title
        FROM lost_found_claims c JOIN lost_found_items lf ON lf.id = c.item_id
       WHERE c.id = ? AND c.status = 'pending' AND (lf.reported_by = ? OR ?)`)
    .bind(claimID, c.id.userId, staff).first<{ item_id: string; claimant_student_id: string; title: string }>()
  if (!row) throw notFound('resource not found')
  const t = now()
  const stmts = [
    c.db.prepare(`UPDATE lost_found_claims SET status = ?, decided_by = ?, decided_at = ?, decision_note = nullif(trim(?), '')
                   WHERE id = ? AND status = 'pending'`).bind(decision, c.id.userId, t, note, claimID),
  ]
  if (decision === 'approved') {
    stmts.push(
      c.db.prepare(`UPDATE lost_found_claims SET status = 'rejected', decided_by = ?, decided_at = ?,
                           decision_note = 'the item was released to another claimant'
                     WHERE item_id = ? AND id <> ? AND status = 'pending'`).bind(c.id.userId, t, row.item_id, claimID),
      c.db.prepare(`UPDATE lost_found_items
                       SET status = 'returned', resolved_at = COALESCE(resolved_at, ?), resolved_by = COALESCE(resolved_by, ?),
                           released_to_student_id = ?, released_by = ?, released_at = ?,
                           resolution_note = COALESCE(nullif(trim(?), ''), resolution_note)
                     WHERE id = ?`).bind(t, c.id.userId, row.claimant_student_id, c.id.userId, t, note, row.item_id),
    )
  }
  const [first] = await c.db.batch(stmts)
  if (!first.meta.changes) throw notFound('resource not found')
  return ok({ id: claimID, status: decision, item: row.title })
}

async function withdrawLostFoundClaim(c: Ctx) {
  const claimID = pathUUID(c)
  const out = await c.db.prepare(`UPDATE lost_found_claims SET status = 'withdrawn'
                                   WHERE id = ? AND claimed_by = ? AND status = 'pending' RETURNING id`)
    .bind(claimID, c.id.userId).first<{ id: string }>()
  if (!out) throw notFound('resource not found')
  return ok({ id: out.id, status: 'withdrawn' })
}

// ---------------------------------------------------------------------------
// the student wall

const WALL_DAILY_LIMIT = 3
const WALL_CATEGORIES = ['helped_with_work', 'returned_something', 'kindness', 'teamwork', 'courage', 'looked_after_someone']

const wallSelect = (mineSql: string, aboutSql: string) => `
    SELECT p.id, p.category, p.body,
           ${cws(' ', 'a.first_name', 'a.last_name')} AS author_name,
           ${cws('-', 'acl.name', 'asec.name')} AS author_class,
           ${cws(' ', 't.first_name', 't.last_name')} AS subject_name,
           ${cws('-', 'tcl.name', 'tsec.name')} AS subject_class,
           p.status, ${mineSql} AS written_by_me, ${aboutSql} AS about_me,
           p.posted_on, p.moderation_note, mu.full_name AS moderated_by
      FROM student_wall_posts p
      JOIN students a ON a.id = p.author_student_id
      JOIN students t ON t.id = p.subject_student_id
      LEFT JOIN users mu ON mu.id = p.moderated_by
      ${latestEnrollment('ae', 'a')}
      LEFT JOIN classes acl ON acl.id = ae.class_id
      LEFT JOIN sections asec ON asec.id = ae.section_id
      ${latestEnrollment('te', 't')}
      LEFT JOIN classes tcl ON tcl.id = te.class_id
      LEFT JOIN sections tsec ON tsec.id = te.section_id`

const wallJSON = (r: Record<string, unknown>) => omitNull({
  id: r.id, category: r.category, body: r.body, author_name: r.author_name, author_class: r.author_class,
  subject_name: r.subject_name, subject_class: r.subject_class, status: r.status,
  written_by_me: bool(r.written_by_me), about_me: bool(r.about_me), posted_on: r.posted_on,
  moderation_note: r.moderation_note, moderated_by: r.moderated_by,
})

async function listWallPosts(c: Ctx) {
  const room = await myClassroom(c)
  const sc = await resolveScope(c)
  const own = inScope(sc)
  const mine = own('p.author_student_id'), about = own('p.subject_student_id'), mine2 = own('p.author_student_id')
  const cat = (c.url.searchParams.get('category') ?? '').trim() || null
  const rows = await c.db.prepare(`${wallSelect(mine.sql, about.sql)}
     WHERE p.campus_id = ?
       AND (p.status = 'published' OR (p.status <> 'published' AND ${mine2.sql}))
       AND (? IS NULL OR p.category = ?)
     ORDER BY (p.status = 'published') DESC, p.created_at DESC
     LIMIT 200`).bind(...mine.args, ...about.args, room.campusId, ...mine2.args, cat, cat).all<Record<string, unknown>>()
  return ok({ items: rows.results.map(wallJSON), daily_limit: WALL_DAILY_LIMIT, moderation: 'pre' })
}

async function postToWall(c: Ctx) {
  const req = await readJSON(c.req)
  const { studentId: author } = await portalChild(c, s(req.student_id))
  const room = await classroomOf(c, author)
  if (!room) throw conflict('you need an enrolment before you can post to the wall')
  const subject = s(req.subject_student_id).trim()
  if (!isUUID(subject)) throw badRequest('subject_student_id must be a uuid')
  if (subject.toLowerCase() === author.toLowerCase()) throw badRequest('you cannot recognise yourself')
  const body = s(req.body).trim()
  if (blen(body) < 10) throw badRequest('say what they actually did. A wall of one-word compliments is a popularity contest')
  if (blen(body) > 500) throw badRequest('keep it under 500 characters')
  const category = s(req.category).trim()
  if (category === '') throw badRequest('category is required')
  // Postgres enforced this with a CHECK; tenant.sql carries none.
  if (!WALL_CATEGORIES.includes(category)) throw badRequest(`category must be one of ${WALL_CATEGORIES.join(', ')}`)

  const today = todayIST()
  const [onCampus, used] = await c.db.batch([
    c.db.prepare(`SELECT EXISTS (SELECT 1 FROM students WHERE id = ? AND campus_id = ?) AS ok`).bind(subject, room.campusId),
    c.db.prepare(`SELECT count(*) AS n FROM student_wall_posts WHERE author_student_id = ? AND posted_on = ?`).bind(author, today),
  ])
  if (!(onCampus.results[0] as { ok: number }).ok) throw notFound('resource not found')
  if (((used.results[0] as { n: number }).n ?? 0) >= WALL_DAILY_LIMIT) throw conflict('you have written your posts for today; the wall is not a feed')
  const id = uuid()
  await c.db.batch([
    c.db.prepare(`INSERT INTO student_wall_posts (id, institution_id, campus_id, author_student_id, author_user_id,
                    subject_student_id, category, body, status, posted_on, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .bind(id, institutionId(c), room.campusId, author, c.id.userId, subject, category, body, today, now()),
    logStudentContent(c, 'wall_post', id, 'submitted', ''),
  ])
  return created({ id, status: 'pending', message: 'a teacher will read it before it goes up' })
}

async function listWallQueue(c: Ctx) {
  requirePerm(c, ANNOUNCEMENTS_WRITE)
  const status = (c.url.searchParams.get('status') ?? '').trim() || 'pending'
  const rows = await c.db.prepare(`${wallSelect('0', '0')}
     WHERE p.status = ?
     ORDER BY p.created_at
     LIMIT 300`).bind(status).all<Record<string, unknown>>()
  return ok({ items: rows.results.map(wallJSON) })
}

async function moderateWallPost(c: Ctx) {
  requirePerm(c, ANNOUNCEMENTS_WRITE)
  const postID = pathUUID(c)
  const req = await readJSON(c.req)
  const action = s(req.action).trim()
  const reason = s(req.reason).trim()
  const status = ({ approve: 'published', reject: 'rejected', remove: 'removed', restore: 'published' } as Record<string, string>)[action]
  if (!status) throw badRequest('action must be approve, reject, remove or restore')
  if ((action === 'reject' || action === 'remove') && reason === '') {
    throw badRequest('give a reason. A takedown a child cannot be told the reason for is one nobody will defend')
  }
  const exists = await c.db.prepare(`SELECT id FROM student_wall_posts WHERE id = ?`).bind(postID).first()
  if (!exists) throw notFound('resource not found')
  const logged = ({ approve: 'approved', reject: 'rejected', remove: 'removed', restore: 'restored' } as Record<string, string>)[action]
  await c.db.batch([
    c.db.prepare(`UPDATE student_wall_posts SET status = ?, moderated_by = ?, moderated_at = ?, moderation_note = nullif(trim(?), '')
                   WHERE id = ?`).bind(status, c.id.userId, now(), reason, postID),
    logStudentContent(c, 'wall_post', postID, logged, reason),
  ])
  return ok({ id: postID, status })
}

async function reportWallPost(c: Ctx) {
  const postID = pathUUID(c)
  const req = await optionalJSON(c)
  const reason = s(req.reason)
  if (reason.trim() === '') throw badRequest('say what is wrong with it')
  const exists = await c.db.prepare(`SELECT 1 AS ok FROM student_wall_posts WHERE id = ? AND status = 'published'`).bind(postID).first()
  if (!exists) throw notFound('resource not found')
  await logStudentContent(c, 'wall_post', postID, 'reported', reason).run()
  return ok({ reported: true })
}

async function listWallModeration(c: Ctx) {
  requirePerm(c, ANNOUNCEMENTS_WRITE)
  const postID = pathUUID(c)
  const rows = await c.db.prepare(`
      SELECT m.action, u.full_name AS actor, m.reason, ${ist('m.created_at')} AS at
        FROM student_content_moderation m
        LEFT JOIN users u ON u.id = m.actor_user_id
       WHERE m.content_kind = 'wall_post' AND m.content_id = ?
       ORDER BY m.created_at`).bind(postID).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((r) => omitNull({ action: r.action, actor: r.actor, reason: r.reason, at: r.at })) })
}

// ---------------------------------------------------------------------------
// digital diary

const DIARY_KINDS = ['note', 'reminder', 'homework', 'revision', 'personal']
const isoDow = (col: string) => `(CASE strftime('%w', ${col}) WHEN '0' THEN 7 ELSE CAST(strftime('%w', ${col}) AS INTEGER) END)`

async function getStudentDiary(c: Ctx) {
  const room = await myClassroom(c)
  const q = c.url.searchParams
  let from = optionalDate(q.get('from'), 'from must be YYYY-MM-DD')
  let to = optionalDate(q.get('to'), 'to must be YYYY-MM-DD')
  const today = parseYMD(todayIST())!
  if (from === null) from = ymd(today)
  if (to === null) to = ymd(addDays(today, 6))
  // bounds: f = from, t = LEAST(to, from + 60)
  const cap = ymd(addDays(parseYMD(from)!, 60))
  const f = from, t = to < cap ? to : cap

  const rows = await c.db.prepare(`
      WITH RECURSIVE days(on_date) AS (
          SELECT ? WHERE ? <= ?
          UNION ALL SELECT date(on_date, '+1 day') FROM days WHERE on_date < ?
      )
      SELECT * FROM (
          SELECT * FROM (
          SELECT d.on_date AS on_date, 'period' AS kind,
                 ${cws(' · ', 'p.name', 'sub.name')} AS title,
                 ${cws(' · ', "nullif(te.room, '')", 'tu.full_name')} AS detail,
                 substr(p.starts_at, 1, 5) AS starts_at, substr(p.ends_at, 1, 5) AS ends_at,
                 NULL AS ref_id, 0 AS done
            FROM days d
            JOIN timetable_entries te ON te.section_id = ? AND te.academic_year_id = ? AND te.weekday = ${isoDow('d.on_date')}
            JOIN periods p ON p.id = te.period_id
            JOIN class_subjects cs ON cs.id = te.class_subject_id
            JOIN subjects sub ON sub.id = cs.subject_id
            LEFT JOIN users tu ON tu.id = te.teacher_user_id
           WHERE p.is_break = 0
             AND NOT EXISTS (
                 SELECT 1 FROM holidays h
                  WHERE h.applies_to IN ('all','students') AND h.kind IN ('holiday','vacation')
                    AND (h.campus_id IS NULL OR h.campus_id = ?)
                    AND d.on_date BETWEEN h.on_date AND COALESCE(h.to_date, h.on_date))
          UNION ALL
          SELECT hw.due_on, 'homework', hw.title, sub.name, NULL, NULL, hw.id, 0
            FROM homework hw
            LEFT JOIN class_subjects cs ON cs.id = hw.class_subject_id
            LEFT JOIN subjects sub ON sub.id = cs.subject_id
           WHERE hw.section_id = ? AND hw.is_published = 1 AND hw.due_on BETWEEN ? AND ?
          UNION ALL
          SELECT es.exam_date, 'exam', ex.name || ' · ' || sub.name,
                 ${cws(' · ', "CASE WHEN es.duration_minutes IS NOT NULL THEN es.duration_minutes || ' min' END", "'max ' || es.max_marks")},
                 substr(es.starts_at, 1, 5), NULL, es.id, 0
            FROM exam_subjects es
            JOIN exams ex ON ex.id = es.exam_id
            JOIN class_subjects cs ON cs.id = es.class_subject_id
            JOIN subjects sub ON sub.id = cs.subject_id
           WHERE cs.class_id = ? AND es.exam_date BETWEEN ? AND ?
          -- D1 allows at most five terms in one compound SELECT, so the six
          -- sources are two compounds of three.
          ) UNION ALL SELECT * FROM (
          SELECT h.on_date, h.kind, h.name, h.description, NULL, NULL, NULL, 0
            FROM holidays h
           WHERE h.on_date BETWEEN ? AND ? AND h.applies_to IN ('all','students')
             AND (h.campus_id IS NULL OR h.campus_id = ?)
          UNION ALL
          SELECT date(ev.starts_at, '+330 minutes'), 'club_event', ev.club_name || ' · ' || ev.title, ev.venue,
                 ${ist('ev.starts_at', '%H:%M')}, NULL, ev.id, 0
            FROM club_events ev
           WHERE ev.campus_id = ? AND ev.status IN ('open','closed','done')
             AND date(ev.starts_at, '+330 minutes') BETWEEN ? AND ?
          UNION ALL
          SELECT n.on_date, 'note', n.body, n.kind, NULL, NULL, n.id, (n.done_at IS NOT NULL)
            FROM student_diary_notes n
           WHERE n.student_id = ? AND n.on_date BETWEEN ? AND ?
          )
      ) diary
      ORDER BY on_date, starts_at NULLS LAST, kind, title`)
    .bind(f, f, t, t,
      room.sectionId, room.yearId, room.campusId,
      room.sectionId, f, t,
      room.classId, f, t,
      f, t, room.campusId,
      room.campusId, f, t,
      room.studentId, f, t).all<Record<string, unknown>>()
  const items = rows.results.map((r) => omitNull({
    on_date: r.on_date, kind: r.kind, title: r.title, detail: r.detail, starts_at: r.starts_at,
    ends_at: r.ends_at, ref_id: r.ref_id, done: bool(r.done),
  }))
  return ok({
    student_id: room.studentId, class_name: room.className, section_name: room.sectionName,
    from, to, items,
  })
}

async function listDiaryNotes(c: Ctx) {
  const room = await myClassroom(c)
  const q = c.url.searchParams
  const from = optionalDate(q.get('from'), 'from must be YYYY-MM-DD')
  const to = optionalDate(q.get('to'), 'to must be YYYY-MM-DD')
  const rows = await c.db.prepare(`
      SELECT id, on_date, kind, body, ${ist('done_at')} AS done_at
        FROM student_diary_notes
       WHERE student_id = ? AND (? IS NULL OR on_date >= ?) AND (? IS NULL OR on_date <= ?)
       ORDER BY on_date DESC, created_at
       LIMIT 500`).bind(room.studentId, from, from, to, to).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((r) => omitNull({ id: r.id, on_date: r.on_date, kind: r.kind, body: r.body, done_at: r.done_at })) })
}

/** ($4::date + $7::time) read in Asia/Kolkata, stored as UTC ISO. */
function remindAt(onDate: string, raw: string): string | null {
  if (raw === '') return null
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw)
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3] ?? 0) > 59) throw badRequest('remind_at must be HH:MM')
  const d = parseYMD(onDate)!
  const ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(m[1]), Number(m[2]), Number(m[3] ?? 0)) - 330 * 60_000
  return new Date(ms).toISOString()
}

async function createDiaryNote(c: Ctx) {
  const req = await readJSON(c.req)
  const { studentId: student } = await portalChild(c, s(req.student_id))
  const body = s(req.body).trim()
  if (body === '') throw badRequest('write something')
  if (blen(body) > 2000) throw badRequest('keep a note under 2000 characters')
  const on = optionalDate(req.on_date, 'on_date must be YYYY-MM-DD') ?? todayIST()
  const kind = s(req.kind).trim() || 'note'
  if (!DIARY_KINDS.includes(kind)) throw badRequest(`kind must be one of ${DIARY_KINDS.join(', ')}`)
  const remind = remindAt(on, s(req.remind_at).trim())
  const id = uuid(), t = now()
  await c.db.prepare(`INSERT INTO student_diary_notes (id, institution_id, student_id, author_user_id, on_date, kind, body, remind_at, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, institutionId(c), student, c.id.userId, on, kind, body, remind, t, t).run()
  return created({ id })
}

async function updateDiaryNote(c: Ctx) {
  const noteID = pathUUID(c)
  const req = await readJSON(c.req)
  const sc = await resolveScope(c)
  const body = s(req.body)
  if (blen(body) > 2000) throw badRequest('keep a note under 2000 characters')
  const on = optionalDate(req.on_date, 'on_date must be YYYY-MM-DD')
  const kind = s(req.kind).trim()
  if (kind !== '' && !DIARY_KINDS.includes(kind)) throw badRequest(`kind must be one of ${DIARY_KINDS.join(', ')}`)
  const done = req.done === true ? 1 : req.done === false ? 0 : null
  const own = inList('student_id', sc.studentIds)
  const t = now()
  const out = await c.db.prepare(`
      UPDATE student_diary_notes
         SET body = COALESCE(nullif(trim(?), ''), body),
             kind = COALESCE(nullif(?, ''), kind),
             on_date = COALESCE(?, on_date),
             done_at = CASE WHEN ? IS NULL THEN done_at WHEN ? = 1 THEN COALESCE(done_at, ?) ELSE NULL END,
             updated_at = ?
       WHERE id = ? AND ${own.sql}
      RETURNING id`).bind(body, kind, on, done, done, t, t, noteID, ...own.args).first<{ id: string }>()
  if (!out) throw notFound('resource not found')
  return ok({ id: out.id })
}

async function deleteDiaryNote(c: Ctx) {
  const noteID = pathUUID(c)
  const sc = await resolveScope(c)
  const own = inList('student_id', sc.studentIds)
  const out = await c.db.prepare(`DELETE FROM student_diary_notes WHERE id = ? AND ${own.sql} RETURNING id`)
    .bind(noteID, ...own.args).first<{ id: string }>()
  if (!out) throw notFound('resource not found')
  return ok({ deleted: out.id })
}

// ---------------------------------------------------------------------------
// display preferences

const THEME_CHOICES = ['system', 'light', 'dark']
const DENSITY_CHOICES = ['compact', 'comfortable', 'relaxed']
const LAYOUT_CHOICES = ['classic', 'bento']
const LOCALE_CHOICES = ['en', 'te']
const DEFAULT_LOCALE = 'en'
const DEFAULT_LAYOUT = 'bento'

async function getDisplayPreferences(c: Ctx) {
  const pref = { theme: 'system', density: 'comfortable', reduce_motion: false, locale: DEFAULT_LOCALE, high_contrast: false, layout: DEFAULT_LAYOUT }
  const r = await c.db.prepare(`SELECT theme, density, reduce_motion, locale, high_contrast, layout FROM user_display_preferences WHERE user_id = ?`)
    .bind(c.id.userId).first<Record<string, unknown>>()
  if (r) {
    pref.theme = String(r.theme); pref.density = String(r.density); pref.reduce_motion = bool(r.reduce_motion)
    pref.locale = String(r.locale); pref.high_contrast = bool(r.high_contrast); pref.layout = String(r.layout)
  }
  return ok({
    preference: pref, theme_choices: THEME_CHOICES, density_choices: DENSITY_CHOICES,
    default_theme: 'system', default_density: 'comfortable', locale_choices: LOCALE_CHOICES,
    default_locale: DEFAULT_LOCALE, layout_choices: LAYOUT_CHOICES, default_layout: DEFAULT_LAYOUT,
  })
}

async function saveDisplayPreferences(c: Ctx) {
  if (!c.id.institution) {
    throw badRequest('this screen belongs to a school. Sign in against one, or pick a school first - a platform operator\'s account is not attached to any.')
  }
  const req = await readJSON(c.req)
  const theme = s(req.theme).trim() || 'system'
  const density = s(req.density).trim() || 'comfortable'
  if (!THEME_CHOICES.includes(theme)) throw badRequest('theme must be one of system, light, dark')
  if (!DENSITY_CHOICES.includes(density)) throw badRequest('density must be one of compact, comfortable, relaxed')
  const locale = s(req.locale).trim() || DEFAULT_LOCALE
  if (!LOCALE_CHOICES.includes(locale)) throw badRequest('locale is not one this build has strings for')
  let layout = s(req.layout).trim()
  if (layout !== '' && !LAYOUT_CHOICES.includes(layout)) throw badRequest('layout must be one of classic, bento')
  const reduceMotion = req.reduce_motion === true, highContrast = req.high_contrast === true
  const t = now()
  await c.db.prepare(`
      INSERT INTO user_display_preferences (user_id, institution_id, theme, density, reduce_motion, locale, high_contrast, layout, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(NULLIF(?, ''), 'classic'), ?)
      ON CONFLICT (user_id) DO UPDATE
         SET theme = excluded.theme, density = excluded.density, reduce_motion = excluded.reduce_motion,
             locale = excluded.locale, high_contrast = excluded.high_contrast,
             layout = COALESCE(NULLIF(?, ''), user_display_preferences.layout),
             updated_at = excluded.updated_at`)
    .bind(c.id.userId, institutionId(c), theme, density, reduceMotion ? 1 : 0, locale, highContrast ? 1 : 0, layout, t, layout).run()
  if (layout === '') {
    layout = DEFAULT_LAYOUT
    try {
      const r = await c.db.prepare(`SELECT layout FROM user_display_preferences WHERE user_id = ?`).bind(c.id.userId).first<{ layout: string }>()
      if (r) layout = r.layout
    } catch { /* Go ignores this error too */ }
  }
  return ok({ preference: { theme, density, reduce_motion: reduceMotion, locale, high_contrast: highContrast, layout } })
}

// ---------------------------------------------------------------------------
// virtual classroom hand raise

const secondsSince = (endExpr: string, startExpr: string) =>
  `CAST(ROUND((julianday(${endExpr}) - julianday(${startExpr})) * 86400) AS INTEGER)`

async function listMyLiveClasses(c: Ctx) {
  const room = await myClassroom(c)
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString()
  const rows = await c.db.prepare(`
      SELECT v.id, v.topic, sub.name AS subject, ${ist('v.scheduled_at')} AS scheduled_at,
             v.duration_minutes, v.status, v.join_url, u.full_name AS teacher,
             EXISTS (SELECT 1 FROM virtual_class_hand_raises h WHERE h.session_id = v.id AND h.student_id = ?
                       AND h.lowered_at IS NULL AND h.answered_at IS NULL) AS hand_up,
             (SELECT count(*) FROM virtual_class_hand_raises h WHERE h.session_id = v.id AND h.student_id = ?) AS my_raises,
             (SELECT count(*) FROM virtual_class_hand_raises h WHERE h.session_id = v.id AND h.student_id = ?
                AND h.answered_at IS NOT NULL) AS my_times_called
        FROM virtual_class_sessions v
        LEFT JOIN class_subjects cs ON cs.id = v.class_subject_id
        LEFT JOIN subjects sub ON sub.id = cs.subject_id
        LEFT JOIN users u ON u.id = v.created_by
       WHERE v.section_id = ? AND v.scheduled_at >= ?
       ORDER BY v.scheduled_at DESC
       LIMIT 100`).bind(room.studentId, room.studentId, room.studentId, room.sectionId, since).all<Record<string, unknown>>()
  return ok({
    items: rows.results.map((r) => omitNull({
      id: r.id, topic: r.topic, subject: r.subject, scheduled_at: r.scheduled_at, duration_minutes: Number(r.duration_minutes),
      status: r.status, join_url: r.join_url, teacher: r.teacher, hand_up: bool(r.hand_up),
      my_raises: Number(r.my_raises), my_times_called: Number(r.my_times_called),
    })),
  })
}

async function raiseHand(c: Ctx) {
  const sessionID = pathUUID(c)
  const req = await optionalJSON(c)
  const { studentId: student } = await portalChild(c, s(req.student_id))
  const room = await classroomOf(c, student)
  if (!room) throw conflict('you need an enrolment to join a class')
  const sess = await c.db.prepare(`SELECT status FROM virtual_class_sessions WHERE id = ? AND section_id = ?`)
    .bind(sessionID, room.sectionId).first<{ status: string }>()
  if (!sess) throw notFound('resource not found')
  if (sess.status !== 'live') throw badRequest('that class is not live')
  const id = uuid()
  // virtual_class_hand_raises_one_up: one hand up per child per session.
  const res = await c.db.prepare(`
      INSERT INTO virtual_class_hand_raises (id, institution_id, session_id, student_id, raised_by, raised_at, note)
      SELECT ?, ?, ?, ?, ?, ?, nullif(trim(?), '')
       WHERE NOT EXISTS (SELECT 1 FROM virtual_class_hand_raises WHERE session_id = ? AND student_id = ?
                           AND lowered_at IS NULL AND answered_at IS NULL)`)
    .bind(id, institutionId(c), sessionID, student, c.id.userId, now(), s(req.note), sessionID, student).run()
  if (!res.meta.changes) throw conflict('your hand is already up')
  return created({ id, hand_up: true })
}

async function lowerHand(c: Ctx) {
  const sessionID = pathUUID(c)
  const req = await optionalJSON(c)
  const { studentId: student } = await portalChild(c, s(req.student_id))
  const out = await c.db.prepare(`
      UPDATE virtual_class_hand_raises SET lowered_at = ?
       WHERE session_id = ? AND student_id = ? AND lowered_at IS NULL AND answered_at IS NULL
      RETURNING id`).bind(now(), sessionID, student).first<{ id: string }>()
  if (!out) throw notFound('resource not found')
  return ok({ id: out.id, hand_up: false })
}

const handJSON = (r: Record<string, unknown>) => omitNull({
  id: r.id, student_id: r.student_id, student_name: r.student_name, raised_at: r.raised_at,
  waiting_seconds: Number(r.waiting_seconds ?? 0), answered_at: r.answered_at, lowered_at: r.lowered_at, note: r.note,
})

async function listRaisedHands(c: Ctx) {
  requirePerm(c, HOMEWORK_WRITE)
  const sessionID = pathUUID(c)
  const sc = await resolveScope(c)
  const sec = inList('v.section_id', sc.sectionIds)
  const rows = await c.db.prepare(`
      SELECT h.id, h.student_id, ${cws(' ', 'st.first_name', 'st.last_name')} AS student_name,
             ${ist('h.raised_at', '%Y-%m-%dT%H:%M:%S')} AS raised_at,
             ${secondsSince('COALESCE(h.answered_at, h.lowered_at, ?)', 'h.raised_at')} AS waiting_seconds,
             ${ist('h.answered_at', '%H:%M:%S')} AS answered_at, ${ist('h.lowered_at', '%H:%M:%S')} AS lowered_at, h.note
        FROM virtual_class_hand_raises h
        JOIN virtual_class_sessions v ON v.id = h.session_id
        JOIN students st ON st.id = h.student_id
       WHERE h.session_id = ? AND (? OR ${sec.sql})
       ORDER BY (h.answered_at IS NULL AND h.lowered_at IS NULL) DESC, h.raised_at`)
    .bind(now(), sessionID, sc.allStudents ? 1 : 0, ...sec.args).all<Record<string, unknown>>()
  return ok({ items: rows.results.map(handJSON) })
}

async function callOnRaisedHand(c: Ctx) {
  requirePerm(c, HOMEWORK_WRITE)
  const handID = pathUUID(c)
  const sc = await resolveScope(c)
  const sec = inList('v.section_id', sc.sectionIds)
  const out = await c.db.prepare(`
      UPDATE virtual_class_hand_raises SET answered_at = ?, answered_by = ?
       WHERE id = ? AND answered_at IS NULL AND lowered_at IS NULL
         AND EXISTS (SELECT 1 FROM virtual_class_sessions v WHERE v.id = virtual_class_hand_raises.session_id AND (? OR ${sec.sql}))
      RETURNING id`).bind(now(), c.id.userId, handID, sc.allStudents ? 1 : 0, ...sec.args).first<{ id: string }>()
  if (!out) throw notFound('resource not found')
  return ok({ id: out.id, answered: true })
}

async function getHandRaiseTelemetry(c: Ctx) {
  requirePerm(c, HOMEWORK_WRITE)
  const sc = await resolveScope(c)
  if (sc.sectionIds.length === 0 && !sc.allStudents) return ok({ items: [] })
  const q = c.url.searchParams
  let days = 90
  const rawDays = (q.get('days') ?? '').trim()
  if (rawDays !== '') {
    const v = /^[+-]?\d+$/.test(rawDays) ? Number(rawDays) : NaN
    if (!Number.isInteger(v) || v < 1 || v > 365) throw badRequest('days must be between 1 and 365')
    days = v
  }
  let section: string | null = null
  const rawSec = (q.get('section_id') ?? '').trim()
  if (rawSec !== '') {
    if (!isUUID(rawSec)) throw badRequest('section_id must be a uuid')
    if (!(sc.allStudents || sc.sectionIds.includes(rawSec))) throw notFound('resource not found')
    section = rawSec
  }
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const sec = inList('v.section_id', sc.sectionIds)
  const name = shortName('st')
  const rows = await c.db.prepare(`
      WITH sess AS (
          SELECT v.id, v.section_id FROM virtual_class_sessions v
           WHERE v.status IN ('live','ended') AND v.scheduled_at >= ?
             AND (? OR ${sec.sql}) AND (? IS NULL OR v.section_id = ?)
      ),
      held AS (SELECT section_id, count(*) AS n FROM sess GROUP BY section_id),
      roll AS (
          SELECT DISTINCT e.student_id, e.section_id FROM enrollments e
            JOIN held h ON h.section_id = e.section_id
           WHERE e.status = 'active'
      )
      SELECT r.student_id, ${name} AS student_name, ${cws('-', 'cl.name', 'sec.name')} AS section, h.n AS sessions,
             count(DISTINCT hr.session_id) AS sessions_with_hand, count(hr.id) AS raises,
             count(hr.answered_at) AS times_called,
             SUM(CASE WHEN hr.id IS NOT NULL AND hr.answered_at IS NULL AND hr.lowered_at IS NULL THEN 1 ELSE 0 END) AS unanswered,
             CAST(ROUND(avg((julianday(hr.answered_at) - julianday(hr.raised_at)) * 86400)) AS INTEGER) AS avg_wait_seconds,
             ${ist('max(hr.raised_at)')} AS last_raised_at
        FROM roll r
        JOIN held h ON h.section_id = r.section_id
        JOIN students st ON st.id = r.student_id
        JOIN sections sec ON sec.id = r.section_id
        JOIN classes cl ON cl.id = sec.class_id
        LEFT JOIN sess s ON s.section_id = r.section_id
        LEFT JOIN virtual_class_hand_raises hr ON hr.session_id = s.id AND hr.student_id = r.student_id
       GROUP BY r.student_id, st.first_name, st.last_name, cl.name, sec.name, h.n
       ORDER BY count(hr.id), ${name}
       LIMIT 600`).bind(since, sc.allStudents ? 1 : 0, ...sec.args, section, section).all<Record<string, unknown>>()
  const items = rows.results.map((r) => omitNull({
    student_id: r.student_id, student_name: r.student_name, section: r.section, sessions: Number(r.sessions),
    sessions_with_hand: Number(r.sessions_with_hand), raises: Number(r.raises), times_called: Number(r.times_called),
    unanswered: Number(r.unanswered ?? 0), avg_wait_seconds: r.avg_wait_seconds === null ? null : Number(r.avg_wait_seconds),
    last_raised_at: r.last_raised_at,
  }))
  return ok({ items, days })
}

async function getMyHandRaiseHistory(c: Ctx) {
  const room = await myClassroom(c)
  const rows = await c.db.prepare(`
      SELECT h.id, h.student_id, v.topic AS student_name, ${ist('h.raised_at')} AS raised_at,
             ${secondsSince('COALESCE(h.answered_at, h.lowered_at, ?)', 'h.raised_at')} AS waiting_seconds,
             ${ist('h.answered_at')} AS answered_at, ${ist('h.lowered_at')} AS lowered_at, h.note
        FROM virtual_class_hand_raises h
        JOIN virtual_class_sessions v ON v.id = h.session_id
       WHERE h.student_id = ?
       ORDER BY h.raised_at DESC
       LIMIT 200`).bind(now(), room.studentId).all<Record<string, unknown>>()
  return ok({ items: rows.results.map(handJSON) })
}

// ---------------------------------------------------------------------------
// streaks and badges (student_growth.go)

interface StreakBadge { key: string; title: string; detail: string; group: string; earned: boolean; on?: string }
interface HomeworkMark { due: string; submitted: string | null }

function streakOf(days: string[], today: string): { current: number; longest: number } {
  const set = new Set(days)
  if (set.size === 0) return { current: 0, longest: 0 }
  const keys = [...set].sort()
  let run = 0, longest = 0, prev: string | null = null
  for (const k of keys) {
    if (prev !== null && ymd(addDays(parseYMD(prev)!, 1)) === k) run++
    else run = 1
    if (run > longest) longest = run
    prev = k
  }
  const y = ymd(addDays(parseYMD(today)!, -1))
  let start = today
  if (!set.has(today)) {
    if (!set.has(y)) return { current: 0, longest }
    start = y
  }
  let current = 0
  let d = parseYMD(start)!
  while (set.has(ymd(d))) { current++; d = addDays(d, -1) }
  return { current, longest }
}

function onTimeStreak(marks: HomeworkMark[], today: string): { streak: number; onTime: number; due: number } {
  const sorted = [...marks].sort((a, b) => (a.due < b.due ? 1 : a.due > b.due ? -1 : 0))
  let alive = true, streak = 0, onTime = 0, due = 0
  for (const m of sorted) {
    if (m.due > today) continue
    due++
    const okay = m.submitted !== null && m.submitted <= m.due
    if (okay) onTime++
    if (alive) { if (okay) streak++; else alive = false }
  }
  return { streak, onTime, due }
}

const OPEN_MILESTONES = [3, 7, 14, 30, 60, 100]
const HOMEWORK_MILESTONES = [5, 10, 25, 50]
function streakBadges(openLongest: number, homeworkStreak: number): StreakBadge[] {
  const out: StreakBadge[] = []
  for (const m of OPEN_MILESTONES) {
    out.push({ key: `open_${m}`, title: `${m} days in a row`, detail: `Opened the app every day for ${m} days`, group: 'streaks', earned: openLongest >= m })
  }
  for (const m of HOMEWORK_MILESTONES) {
    out.push({ key: `homework_${m}`, title: `${m} on time`, detail: `${m} pieces of homework handed in by the due date, in a row`, group: 'streaks', earned: homeworkStreak >= m })
  }
  return out
}

async function loadStreak(c: Ctx, student: string) {
  const today = todayIST()
  const yearAgo = ymd(addDays(parseYMD(today)!, -365))
  const [, dayRows, hwRows] = await c.db.batch([
    c.db.prepare(`INSERT OR IGNORE INTO student_activity_days (institution_id, student_id, day) VALUES (?, ?, ?)`)
      .bind(institutionId(c), student, today),
    c.db.prepare(`SELECT day FROM student_activity_days WHERE student_id = ?
                  UNION
                  SELECT date(se.created_at) FROM sessions se JOIN students st ON st.user_id = se.user_id WHERE st.id = ?`)
      .bind(student, student),
    c.db.prepare(`SELECT h.due_on,
                         (SELECT date(min(hs.submitted_at), '+330 minutes') FROM homework_submissions hs
                           WHERE hs.homework_id = h.id AND hs.student_id = ? AND hs.submitted_at IS NOT NULL) AS submitted_on
                    FROM homework h
                   WHERE h.is_published = 1 AND h.due_on IS NOT NULL
                     AND h.section_id IN (SELECT e.section_id FROM enrollments e WHERE e.student_id = ?)
                     AND h.assigned_on >= ?`).bind(student, student, yearAgo),
  ])
  const days = (dayRows.results as { day: string | null }[]).map((r) => r.day).filter((d): d is string => !!d).map((d) => d.slice(0, 10))
  const marks: HomeworkMark[] = (hwRows.results as { due_on: string; submitted_on: string | null }[])
    .map((r) => ({ due: r.due_on.slice(0, 10), submitted: r.submitted_on }))
  const { current, longest } = streakOf(days, today)
  const hw = onTimeStreak(marks, today)
  const set = new Set(days)
  const recent: { day: string; opened: boolean }[] = []
  let daysThisMonth = 0
  const t = parseYMD(today)!
  for (let d = addDays(t, -34); d <= t; d = addDays(d, 1)) {
    const k = ymd(d)
    recent.push({ day: k, opened: set.has(k) })
    if (d.getUTCMonth() === t.getUTCMonth() && set.has(k)) daysThisMonth++
  }
  let pending = 0
  for (const m of marks) if (m.due <= today && m.submitted === null) pending++
  return {
    student_id: student, today, open_streak: current, open_longest: longest, opened_today: set.has(today),
    days_this_month: daysThisMonth, homework_streak: hw.streak, homework_on_time: hw.onTime, homework_due: hw.due,
    homework_pending: pending, recent, badges: streakBadges(longest, hw.streak),
  }
}

async function getMyStreak(c: Ctx) {
  const student = await whichChild(c)
  return ok(await loadStreak(c, student))
}

async function getMyBadges(c: Ctx) {
  const student = await whichChild(c)
  const rows = await c.db.prepare(`
      SELECT 'conduct_' || dr.id AS key, dr.category AS title, dr.description AS detail, 'behaviour' AS grp, dr.occurred_on AS on_date
        FROM discipline_records dr
       WHERE dr.student_id = ? AND dr.is_positive = 1 AND dr.visible_to_student = 1
      UNION ALL
      SELECT 'achievement_' || sa.id, sa.title,
             ${cws(' · ', "nullif(sa.level, '')", "nullif(sa.\"position\", '')", 'sa.description')},
             CASE WHEN sa.kind IN ('sport','club','activity') THEN 'activities' ELSE 'academic' END,
             COALESCE(sa.awarded_on, date(sa.created_at, '+330 minutes'))
        FROM student_achievements sa
       WHERE sa.student_id = ?
      UNION ALL
      SELECT 'remark_' || sr.id, 'Commended', sr.body, 'academic', sr.observed_on
        FROM student_remarks sr
       WHERE sr.student_id = ? AND sr.kind = 'achievement' AND sr.visible_to_family = 1
      ORDER BY 5 DESC`).bind(student, student, student).all<{ key: string; title: string; detail: string; grp: string; on_date: string }>()
  const badges: StreakBadge[] = rows.results.map((r) => ({
    key: r.key, title: r.title, detail: r.detail, group: r.grp, earned: true, on: r.on_date,
  }))
  const streak = await loadStreak(c, student)
  badges.push(...streak.badges)
  return ok({ student_id: student, earned: badges.filter((b) => b.earned).length, badges })
}

// ---------------------------------------------------------------------------
// hall of fame

const HOF_CATEGORIES = new Set(['academic', 'sports', 'arts', 'service', 'other'])

async function listHallOfFame(c: Ctx) {
  requireAny(c, FEAT_HALL_OF_FAME, ANNOUNCEMENTS_WRITE)
  const rows = await c.db.prepare(`
      SELECT e.id, e.category, e.title, e.holder, e.year, e.detail, 'board' AS source
        FROM hall_of_fame_entries e
       WHERE e.retired_at IS NULL
      UNION ALL
      SELECT sa.id,
             CASE WHEN sa.kind IN ('sport') THEN 'sports' WHEN sa.kind IN ('club','activity') THEN 'arts' ELSE 'academic' END,
             sa.title, ${fullName('st')},
             CAST(strftime('%Y', COALESCE(sa.awarded_on, datetime(sa.created_at, '+330 minutes'))) AS INTEGER),
             ${cws(' · ', "upper(substr(sa.level, 1, 1)) || lower(substr(sa.level, 2))", "nullif(sa.\"position\", '')", 'sa.description')},
             'achievement'
        FROM student_achievements sa
        JOIN students st ON st.id = sa.student_id
       WHERE sa.level IN ('state','national','international')
      ORDER BY 5 DESC NULLS LAST, 3`).all<Record<string, unknown>>()
  return ok({
    items: rows.results.map((r) => omitNull({
      id: r.id, category: r.category, title: r.title, holder: r.holder,
      year: r.year === null ? null : Number(r.year), detail: r.detail, source: r.source,
    })),
  })
}

async function addHallOfFameEntry(c: Ctx) {
  const req = await readJSON(c.req)
  const category = s(req.category).toLowerCase().trim() || 'academic'
  if (!HOF_CATEGORIES.has(category)) throw badRequest('category must be academic, sports, arts, service or other')
  const title = s(req.title).trim(), holder = s(req.holder).trim()
  if (title === '' || blen(title) > 160) throw badRequest('title is required, up to 160 characters')
  if (holder === '' || blen(holder) > 160) throw badRequest('say whose it is, up to 160 characters')
  let year: number | null = null
  if (req.year !== undefined && req.year !== null) {
    if (typeof req.year !== 'number' || !Number.isInteger(req.year)) throw badRequest('malformed JSON body')
    if (req.year < 1800 || req.year > 2200) throw badRequest('year must be a four-digit year')
    year = req.year
  }
  const detail = s(req.detail).trim()
  if (blen(detail) > 1000) throw badRequest('keep the detail under 1000 characters')
  const studentId = s(req.student_id).trim(), campusId = s(req.campus_id).trim()
  if (studentId !== '' && !isUUID(studentId)) throw badRequest('student_id must be a uuid')
  if (campusId !== '' && !isUUID(campusId)) throw badRequest('campus_id must be a uuid')
  const id = uuid()
  await c.db.prepare(`INSERT INTO hall_of_fame_entries (id, institution_id, campus_id, category, title, holder, student_id, year, detail, added_by, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, nullif(?, ''), ?, ?)`)
    .bind(id, institutionId(c), campusId || null, category, title, holder, studentId || null, year, detail, c.id.userId, now()).run()
  return created({ id })
}

async function retireHallOfFameEntry(c: Ctx) {
  const entry = pathUUID(c)
  const res = await c.db.prepare(`UPDATE hall_of_fame_entries SET retired_at = ? WHERE id = ? AND retired_at IS NULL`)
    .bind(now(), entry).run()
  if (!res.meta.changes) throw notFound('resource not found')
  return ok({ id: entry, retired: true })
}

// ---------------------------------------------------------------------------

export function registerPortalLife(r: Router): void {
  // lost and found: literal claims/... paths before {id}
  r.post('/portal/campus/lost-found/claims/{id}/withdraw', PERM, withdrawLostFoundClaim)
  r.post('/portal/campus/lost-found/claims/{id}/decide', PERM, decideLostFoundClaim)
  r.post('/portal/campus/lost-found/{id}/photo', PERM, attachLostFoundPhoto)
  r.get('/portal/campus/lost-found/{id}/claims', PERM, listLostFoundClaims)
  r.post('/portal/campus/lost-found/{id}/claims', PERM, claimLostFoundItem)

  // the wall
  r.get('/portal/campus/wall/queue', PERM, listWallQueue)
  r.get('/portal/campus/wall', PERM, listWallPosts)
  r.post('/portal/campus/wall', PERM, postToWall)
  r.post('/portal/campus/wall/{id}/report', PERM, reportWallPost)
  r.post('/portal/campus/wall/{id}/moderate', PERM, moderateWallPost)
  r.get('/portal/campus/wall/{id}/history', PERM, listWallModeration)

  // diary
  r.get('/portal/diary', PERM, getStudentDiary)
  r.get('/portal/diary/notes', PERM, listDiaryNotes)
  r.post('/portal/diary/notes', PERM, createDiaryNote)
  r.post('/portal/diary/notes/{id}', PERM, updateDiaryNote)
  r.del('/portal/diary/notes/{id}', PERM, deleteDiaryNote)

  // display preferences
  r.get('/portal/preferences/display', PERM, getDisplayPreferences)
  r.put('/portal/preferences/display', PERM, saveDisplayPreferences)

  // live classes: literal paths before {id}
  r.get('/portal/live-classes', PERM, listMyLiveClasses)
  r.get('/portal/live-classes/my-engagement', PERM, getMyHandRaiseHistory)
  r.get('/portal/live-classes/engagement', PERM, getHandRaiseTelemetry)
  r.post('/portal/live-classes/hands/{id}/call-on', PERM, callOnRaisedHand)
  r.post('/portal/live-classes/{id}/hand', PERM, raiseHand)
  r.post('/portal/live-classes/{id}/hand/lower', PERM, lowerHand)
  r.get('/portal/live-classes/{id}/hands', PERM, listRaisedHands)

  // growth
  r.get('/portal/learning/streak', FEAT_STREAK, getMyStreak)
  r.get('/portal/learning/badges', FEAT_BADGES, getMyBadges)
  r.get('/portal/campus/hall-of-fame', 'auth', listHallOfFame)
  r.post('/portal/campus/hall-of-fame', ANNOUNCEMENTS_WRITE, addHallOfFameEntry)
  r.post('/portal/campus/hall-of-fame/{id}/retire', ANNOUNCEMENTS_WRITE, retireHallOfFameEntry)
}
