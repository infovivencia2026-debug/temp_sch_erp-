import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, created, forbidden, isUUID, notFound, now, ok, readJSON, uuid, bool } from '../../http'
import { can } from '../../identity'
import { institutionId, notifyStmt, portalChild } from '../teaching/common'
import { resolveAttachments, scanAttachments, type Attachment } from '../misc/chat'
import { firstLast, isoZ, omitNull, trim } from './common'
import { publish } from '../../services/live'

/* Port of the private counsellor channel in comms.go. The gate on every
   route is self.profile.read; the access control is a live row in
   counselor_thread_participants, checked by threadRole in every handler.
   "No such thread" and "not in it" are the same 404.

   postCounselorMessage's live hint goes through services/live.ts; the in-app
   notification rows are written. */

const P = 'self.profile.read'
const COUNSELING_READ = 'welfare.counseling.read'
const OBSERVER_MUTE = 'an observer may read this conversation but not write in it'

/** threadRole: the caller's role in the thread, or the one 404 for absent and not-yours alike. */
async function threadRole(c: Ctx, thread: string): Promise<string> {
  const r = await c.db.prepare(`SELECT p.role_in_thread FROM counselor_thread_participants p
      JOIN counselor_threads t ON t.id = p.thread_id
      WHERE p.thread_id = ? AND p.user_id = ? AND p.removed_at IS NULL`).bind(thread, c.id.userId).first<{ role_in_thread: string }>()
  if (!r) throw notFound()
  return r.role_in_thread
}

function logAccess(c: Ctx, thread: string, target: string | null, action: string, reason: string): D1PreparedStatement {
  return c.db.prepare(`INSERT INTO counselor_access_events (id, institution_id, thread_id, actor_id, target_id, action, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?)`)
    .bind(uuid(), institutionId(c), thread, c.id.userId || null, target, action, reason, now())
}

function threadParam(c: Ctx): string {
  if (!isUUID(c.params.id)) throw badRequest('id must be a uuid')
  return c.params.id
}

/** answerCounselor: anything that is not a 404/403 is a 400 carrying the error's text. */
function handle(h: (c: Ctx) => Promise<Response>) {
  return async (c: Ctx): Promise<Response> => {
    try { return await h(c) } catch (e) {
      if (e instanceof HttpError) throw e
      throw badRequest(e instanceof Error ? e.message : String(e))
    }
  }
}

function threadRow(v: Record<string, unknown>, myRole: string, unread: number): Record<string, unknown> {
  return omitNull({ id: v.id, student_id: v.student_id, student: v.student, subject: v.subject, status: v.status,
    urgency: v.urgency, my_role: myRole, opened_by: v.opened_by, created_at: v.created_at,
    last_message_at: v.last_message_at, unread, participants: Number(v.participants ?? 0) })
}

async function listCounselorThreads(c: Ctx): Promise<Response> {
  const rows = await c.db.prepare(`SELECT t.id, t.student_id, ${firstLast('st')} AS student, t.subject, t.status, t.urgency,
        p.role_in_thread, COALESCE(ou.full_name, 'Unknown') AS opened_by,
        ${isoZ('t.created_at')} AS created_at, ${isoZ('t.last_message_at')} AS last_message_at,
        (SELECT count(*) FROM counselor_messages m WHERE m.thread_id = t.id
           AND (p.last_read_at IS NULL OR julianday(m.created_at) > julianday(p.last_read_at))
           AND m.sender_id <> p.user_id) AS unread,
        (SELECT count(*) FROM counselor_thread_participants p2 WHERE p2.thread_id = t.id AND p2.removed_at IS NULL) AS participants
      FROM counselor_thread_participants p
      JOIN counselor_threads t ON t.id = p.thread_id
      JOIN students st ON st.id = t.student_id
      LEFT JOIN users ou ON ou.id = t.opened_by
      WHERE p.user_id = ? AND p.removed_at IS NULL
      ORDER BY COALESCE(t.last_message_at, t.created_at) DESC
      LIMIT 200`).bind(c.id.userId).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => threadRow(v, String(v.role_in_thread), Number(v.unread ?? 0))) })
}

async function listCounselorContacts(c: Ctx): Promise<Response> {
  const rows = await c.db.prepare(`SELECT DISTINCT u.id AS user_id, u.full_name, r.name AS role
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
      JOIN role_permissions rp ON rp.role_id = r.id
      WHERE u.institution_id = ? AND u.status = 'active' AND rp.permission_key = ?
      ORDER BY u.full_name`).bind(institutionId(c), COUNSELING_READ).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({ user_id: v.user_id, full_name: v.full_name, role: v.role })) })
}

async function openCounselorThread(c: Ctx): Promise<Response> {
  const req = await readJSON<Record<string, unknown>>(c.req)
  const subject = trim(req.subject)
  if (subject === '') throw badRequest('give the conversation a subject')
  let urgency = typeof req.urgency === 'string' ? req.urgency : ''
  if (urgency === '') urgency = 'normal'
  if (!['routine', 'normal', 'urgent'].includes(urgency)) throw badRequest('urgency must be routine, normal or urgent')
  const counselor = trim(req.counselor_id)
  if (!isUUID(counselor)) throw badRequest('counselor_id must be a uuid')

  const counsellorLed = can(c.id, COUNSELING_READ) && counselor === c.id.userId
  let studentId: string, parentUser: string
  if (counsellorLed) {
    const sid = trim(req.student_id)
    if (!isUUID(sid)) throw badRequest('student_id must be a uuid')
    const guardian = trim(req.guardian_user_id)
    if (!isUUID(guardian)) throw badRequest('guardian_user_id must be a uuid. A counselling thread has a parent in it')
    studentId = sid; parentUser = guardian
  } else {
    const pc = await portalChild(c, typeof req.student_id === 'string' ? req.student_id : '')
    studentId = pc.studentId; parentUser = c.id.userId
  }

  const inst = institutionId(c)
  const eligible = await c.db.prepare(`SELECT 1 AS x FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE u.id = ? AND u.institution_id = ? AND u.status = 'active' AND rp.permission_key = ? LIMIT 1`)
    .bind(counselor, inst, COUNSELING_READ).first()
  if (!eligible) throw badRequest('that member of staff is not a counsellor')
  if (counsellorLed) {
    const linked = await c.db.prepare(`SELECT 1 AS x FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
        WHERE sg.student_id = ? AND g.user_id = ? LIMIT 1`).bind(studentId, parentUser).first()
    if (!linked) throw badRequest('that user is not a guardian of this child')
  }

  const thread = uuid(), t = now()
  const stmts: D1PreparedStatement[] = [
    c.db.prepare(`INSERT INTO counselor_threads (id, institution_id, student_id, opened_by, subject, urgency, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(thread, inst, studentId, c.id.userId, subject, urgency, t, t),
  ]
  for (const [user, role] of [[parentUser, 'parent'], [counselor, 'counselor']] as const) {
    // ON CONFLICT DO NOTHING against counselor_participants_one_live.
    stmts.push(c.db.prepare(`INSERT INTO counselor_thread_participants (id, institution_id, thread_id, user_id, role_in_thread, added_by, added_at)
        SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM counselor_thread_participants WHERE thread_id = ? AND user_id = ? AND removed_at IS NULL)`)
      .bind(uuid(), inst, thread, user, role, c.id.userId || null, t, thread, user))
  }
  stmts.push(logAccess(c, thread, counselor, 'opened', subject))
  const body = trim(req.message)
  if (body !== '') {
    stmts.push(c.db.prepare(`INSERT INTO counselor_messages (id, institution_id, thread_id, sender_id, body, attachments, created_at)
        VALUES (?, ?, ?, ?, ?, '[]', ?)`).bind(uuid(), inst, thread, c.id.userId, body, t))
    stmts.push(c.db.prepare(`UPDATE counselor_threads SET last_message_at = ?, updated_at = ? WHERE id = ?`).bind(t, t, thread))
  }
  await c.db.batch(stmts)
  return created({ id: thread })
}

async function getCounselorThread(c: Ctx): Promise<Response> {
  const thread = threadParam(c)
  const role = await threadRole(c, thread)
  const v = await c.db.prepare(`SELECT t.id, t.student_id, ${firstLast('st')} AS student, t.subject, t.status, t.urgency,
        COALESCE(ou.full_name, 'Unknown') AS opened_by, ${isoZ('t.created_at')} AS created_at,
        ${isoZ('t.last_message_at')} AS last_message_at,
        (SELECT count(*) FROM counselor_thread_participants p2 WHERE p2.thread_id = t.id AND p2.removed_at IS NULL) AS participants
      FROM counselor_threads t
      JOIN students st ON st.id = t.student_id
      LEFT JOIN users ou ON ou.id = t.opened_by
      WHERE t.id = ?`).bind(thread).first<Record<string, unknown>>()
  if (!v) throw notFound()
  // Go never fills unread on the single-thread read; it is always 0 here.
  return ok(threadRow(v, role, 0))
}

async function listCounselorMessages(c: Ctx): Promise<Response> {
  const thread = threadParam(c)
  await threadRole(c, thread)
  const rows = await c.db.prepare(`SELECT m.id, COALESCE(u.full_name, 'Unknown') AS sender, m.sender_id,
        m.sender_id = ? AS mine, m.body, ${isoZ('m.created_at')} AS created_at, m.attachments
      FROM counselor_messages m LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.thread_id = ? ORDER BY m.created_at`).bind(c.id.userId, thread).all<Record<string, unknown>>()
  await c.db.prepare(`UPDATE counselor_thread_participants SET last_read_at = ? WHERE thread_id = ? AND user_id = ? AND removed_at IS NULL`)
    .bind(now(), thread, c.id.userId).run()
  return ok({ items: rows.results.map((v) => ({ id: v.id, sender: v.sender, sender_id: v.sender_id, mine: bool(v.mine),
    body: v.body, created_at: v.created_at, attachments: scanAttachments(v.attachments) })) })
}

async function postCounselorMessage(c: Ctx): Promise<Response> {
  const thread = threadParam(c)
  const req = await readJSON<{ body?: unknown; attachments?: Attachment[] }>(c.req)
  const files = await resolveAttachments(c, Array.isArray(req.attachments) ? req.attachments : undefined)
  const body = trim(req.body)
  if (body === '' && files.length === 0) throw badRequest('write something, or attach a file')
  const role = await threadRole(c, thread)
  if (role === 'observer') throw forbidden(OBSERVER_MUTE)
  const st = await c.db.prepare(`SELECT status FROM counselor_threads WHERE id = ?`).bind(thread).first<{ status: string }>()
  if (!st) throw notFound()
  if (st.status === 'closed') throw badRequest('this conversation has been closed')
  const others = await c.db.prepare(`SELECT user_id FROM counselor_thread_participants
      WHERE thread_id = ? AND removed_at IS NULL AND user_id <> ?`).bind(thread, c.id.userId).all<{ user_id: string }>()
  const id = uuid(), t = now()
  const stmts: D1PreparedStatement[] = [
    c.db.prepare(`INSERT INTO counselor_messages (id, institution_id, thread_id, sender_id, body, attachments, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, institutionId(c), thread, c.id.userId, body, JSON.stringify(files), t),
    c.db.prepare(`UPDATE counselor_threads SET last_message_at = ?, updated_at = ? WHERE id = ?`).bind(t, t, thread),
  ]
  for (const o of others.results) {
    stmts.push(notifyStmt(c, o.user_id, null, 'counselor_message', 'New message in a counselling conversation', body,
      '/go/counselling/family_conversations?thread=' + thread, 'counselor_message', id))
  }
  await c.db.batch(stmts)
  await publish(c.env, institutionId(c), { users: others.results.map((o) => o.user_id), type: 'message', scope: 'counselor',
    from: c.id.userId, keys: { thread, from_name: 'Counselling conversation' } })
  return created({ id })
}

async function listCounselorParticipants(c: Ctx): Promise<Response> {
  const thread = threadParam(c)
  await threadRole(c, thread)
  const rows = await c.db.prepare(`SELECT p.user_id, COALESCE(u.full_name, 'Unknown') AS full_name, p.role_in_thread,
        au.full_name AS added_by, p.added_reason, ${isoZ('p.added_at')} AS added_at, ${isoZ('p.removed_at')} AS removed_at
      FROM counselor_thread_participants p
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN users au ON au.id = p.added_by
      WHERE p.thread_id = ? ORDER BY p.added_at`).bind(thread).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({ user_id: v.user_id, full_name: v.full_name, role_in_thread: v.role_in_thread,
    added_by: v.added_by, added_reason: v.added_reason, added_at: v.added_at, removed_at: v.removed_at })) })
}

async function addCounselorParticipant(c: Ctx): Promise<Response> {
  const thread = threadParam(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const target = trim(req.user_id)
  if (!isUUID(target)) throw badRequest('user_id must be a uuid')
  const reason = trim(req.reason)
  if (reason === '') throw badRequest('say why this person is being given sight of a confidential conversation')
  const role = req.role_in_thread
  if (role !== 'counselor' && role !== 'observer') throw badRequest('role_in_thread must be counselor or observer')

  const mine = await threadRole(c, thread)
  if (mine !== 'counselor') {
    // Written before the refusal is answered so the attempt is on record.
    await logAccess(c, thread, target, 'access_refused', 'only the counsellor may widen this thread').run()
    throw badRequest('only the counsellor in this conversation may add somebody to it')
  }
  const staff = await c.db.prepare(`SELECT 1 AS x FROM employees e WHERE e.user_id = ? AND e.institution_id = ? LIMIT 1`)
    .bind(target, institutionId(c)).first()
  if (!staff) throw badRequest('only a member of staff may be added to a counselling thread')
  const live = await c.db.prepare(`SELECT 1 AS x FROM counselor_thread_participants WHERE thread_id = ? AND user_id = ? AND removed_at IS NULL`)
    .bind(thread, target).first()
  if (live) throw badRequest('that person is already in this conversation')
  try {
    await c.db.batch([
      c.db.prepare(`INSERT INTO counselor_thread_participants (id, institution_id, thread_id, user_id, role_in_thread, added_by, added_reason, added_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), institutionId(c), thread, target, role, c.id.userId || null, reason, now()),
      logAccess(c, thread, target, 'participant_added', reason),
    ])
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/UNIQUE constraint/i.test(msg)) throw badRequest('that person is already in this conversation')
    throw e
  }
  return created({ added: true })
}

async function removeCounselorParticipant(c: Ctx): Promise<Response> {
  const thread = threadParam(c)
  const target = c.params.userID
  if (!isUUID(target)) throw badRequest('userID must be a uuid')
  let reason = ''
  try { const b = (await c.req.json()) as Record<string, unknown>; reason = trim(b?.reason) } catch { /* optional body */ }
  const role = await threadRole(c, thread)
  if (target !== c.id.userId && role !== 'counselor') throw badRequest('only the counsellor in this conversation may remove somebody from it')
  const t = now()
  const [upd] = await c.db.batch([
    c.db.prepare(`UPDATE counselor_thread_participants SET removed_at = ?, removed_by = ?
        WHERE thread_id = ? AND user_id = ? AND removed_at IS NULL AND role_in_thread <> 'parent'`)
      .bind(t, c.id.userId || null, thread, target),
    c.db.prepare(`INSERT INTO counselor_access_events (id, institution_id, thread_id, actor_id, target_id, action, reason, created_at)
        SELECT ?, ?, ?, ?, ?, 'participant_removed', NULLIF(?, ''), ?
         WHERE changes() > 0`).bind(uuid(), institutionId(c), thread, c.id.userId || null, target, reason, t),
  ])
  if (!upd.meta.changes) throw badRequest('that person is not a removable participant of this conversation')
  return ok({ removed: true })
}

async function closeCounselorThread(c: Ctx): Promise<Response> {
  const thread = threadParam(c)
  const role = await threadRole(c, thread)
  if (role === 'observer') throw forbidden(OBSERVER_MUTE)
  const t = now()
  await c.db.batch([
    c.db.prepare(`UPDATE counselor_threads SET status = 'closed', closed_at = ?, closed_by = ?, updated_at = ?
        WHERE id = ? AND status = 'open'`).bind(t, c.id.userId || null, t, thread),
    logAccess(c, thread, null, 'thread_closed', ''),
  ])
  return ok({ closed: true })
}

export function registerCounselor(r: Router): void {
  r.get('/comms/counselor/contacts', P, listCounselorContacts)
  r.get('/comms/counselor/threads', P, listCounselorThreads)
  r.post('/comms/counselor/threads', P, handle(openCounselorThread))
  r.get('/comms/counselor/threads/{id}', P, handle(getCounselorThread))
  r.get('/comms/counselor/threads/{id}/messages', P, handle(listCounselorMessages))
  r.post('/comms/counselor/threads/{id}/messages', P, handle(postCounselorMessage))
  r.get('/comms/counselor/threads/{id}/participants', P, handle(listCounselorParticipants))
  r.post('/comms/counselor/threads/{id}/participants', P, handle(addCounselorParticipant))
  r.post('/comms/counselor/threads/{id}/participants/{userID}/remove', P, handle(removeCounselorParticipant))
  r.post('/comms/counselor/threads/{id}/close', P, handle(closeCounselorThread))
}
