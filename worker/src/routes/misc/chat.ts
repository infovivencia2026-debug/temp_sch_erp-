import type { Router, Ctx } from '../../router'
import { badRequest, created, forbidden, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { can } from '../../identity'
import { inList, institutionId, parseJSON, resolveScope } from '../admin/common'
import { publish } from '../../services/live'

/* Port of chat_ops.go, staff_messages.go, staff_remarks.go and attachments.go.

   The live hints (publishLive) go through services/live.ts after the write. In-app notifications are rows and
   are written exactly as notify() in portal_school_life.go wrote them. */

export interface Attachment { file_id: string; name: string; size_bytes: number; content_type: string; url: string }

const MAX_ATTACHMENTS = 10

/** resolveAttachments: the ids must be files this school holds; names and sizes come from the files table. */
export async function resolveAttachments(c: Ctx, input: Attachment[] | undefined): Promise<Attachment[]> {
  const bad = badRequest("one of the attached files is missing or is not this school's; upload it again")
  if (!input || input.length === 0) return []
  if (input.length > MAX_ATTACHMENTS) throw bad
  const ids = input.map((a) => (a.file_id ?? '').trim())
  if (ids.some((i) => !isUUID(i))) throw bad
  const q = inList(ids)
  const rows = await c.db.prepare(`SELECT id, original_name, size_bytes, content_type FROM files WHERE id IN ${q.sql} AND institution_id = ? AND deleted_at IS NULL`)
    .bind(...q.args, institutionId(c)).all<{ id: string; original_name: string; size_bytes: number; content_type: string }>()
  const byId = new Map(rows.results.map((f) => [f.id, { file_id: f.id, name: f.original_name, size_bytes: f.size_bytes, content_type: f.content_type, url: '/api/v1/files/' + f.id }]))
  const out: Attachment[] = []
  for (const id of ids) {
    const a = byId.get(id)
    if (!a) throw bad
    out.push(a)
  }
  return out
}

export const scanAttachments = (raw: unknown): Attachment[] => {
  const v = parseJSON<Attachment[] | null>(raw, null)
  return Array.isArray(v) ? v : []
}

/** notify() in portal_school_life.go: one feed row, deduplicated on (user, kind, source, student) when a source is named. */
export async function notifyStmt(c: Ctx, userId: string, studentId: string | null, kind: string, title: string, body: string,
  link: string, sourceKind: string | null, sourceId: string | null): Promise<D1PreparedStatement | null> {
  if (sourceKind !== null) {
    const dup = await c.db.prepare(`SELECT 1 AS x FROM notifications WHERE user_id = ? AND kind = ? AND source_kind IS NOT NULL
        AND COALESCE(source_id, '00000000-0000-0000-0000-000000000000') = COALESCE(?, '00000000-0000-0000-0000-000000000000')
        AND COALESCE(student_id, '00000000-0000-0000-0000-000000000000') = COALESCE(?, '00000000-0000-0000-0000-000000000000')`)
      .bind(userId, kind, sourceId, studentId).first()
    if (dup) return null
  }
  return c.db.prepare(`INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, source_kind, source_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(uuid(), institutionId(c), userId, studentId, kind, title, body, link, sourceKind, sourceId, now())
}

const clip240 = (s: string) => (s.length > 240 ? s.slice(0, 237) + '…' : s)
const least = (a: string, b: string) => (a < b ? a : b)
const greatest = (a: string, b: string) => (a < b ? b : a)

const EDIT_WINDOW_MS = 15 * 60_000

async function amendMessage(c: Ctx, unsend: boolean): Promise<Response> {
  if (!isUUID(c.params.id)) throw badRequest('message id must be a uuid')
  const mid = c.params.id
  const table = c.url.searchParams.get('channel') === 'parent' ? 'parent_teacher_messages' : 'staff_messages'
  let body = ''
  if (!unsend) {
    const req = await readJSON<{ body?: string }>(c.req)
    body = (req.body ?? '').trim()
    if (body === '') throw badRequest('an edited message still needs some words; use unsend to withdraw it')
  }
  const row = await c.db.prepare(`SELECT sender_user_id, sent_at, deleted_at FROM ${table} WHERE id = ?`).bind(mid)
    .first<{ sender_user_id: string; sent_at: string; deleted_at: string | null }>()
  if (!row) throw notFound('resource not found')
  if (row.sender_user_id !== c.id.userId) throw forbidden('missing permission: the author of this message')
  const tooOld = badRequest('a message can be edited for fifteen minutes after it is sent; after that it can only be withdrawn')
  if (row.deleted_at !== null) throw tooOld
  if (!unsend && Date.now() - Date.parse(row.sent_at) > EDIT_WINDOW_MS) throw tooOld
  if (unsend) {
    await c.db.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`).bind(now(), mid).run()
  } else {
    await c.db.prepare(`UPDATE ${table} SET body = ?, edited_at = ? WHERE id = ?`).bind(body, now(), mid).run()
  }
  return ok({ ok: true })
}

/** The "is this person staff" test both the address book and the send use. */
const STAFF_ROLE_SQL = `EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id WHERE ur.user_id = u.id AND ro.key NOT IN ('student','parent'))`

export function registerChat(r: Router): void {
  // --- chat_ops.go ------------------------------------------------------------
  r.put('/chat/messages/{id}', 'auth', (c) => amendMessage(c, false))
  r.del('/chat/messages/{id}', 'auth', (c) => amendMessage(c, true))

  r.post('/chat/parent-thread/read', 'auth', async (c) => {
    const q = c.url.searchParams
    const sid = q.get('student_id'), pid = q.get('parent_user_id'), tid = q.get('teacher_user_id')
    if (!isUUID(sid) || !isUUID(pid) || !isUUID(tid)) throw badRequest('student_id, parent_user_id and teacher_user_id must be uuids')
    const party = c.id.userId === pid || c.id.userId === tid
    if (!party && !can(c.id, 'comms.messages.read.all')) throw forbidden('missing permission: a party to this conversation')
    const notFrom = party ? c.id.userId : tid
    const res = await c.db.prepare(`UPDATE parent_teacher_messages SET read_at = ? WHERE student_id = ? AND parent_user_id = ? AND teacher_user_id = ?
        AND sender_user_id <> ? AND read_at IS NULL`).bind(now(), sid, pid, tid, notFrom).run()
    if (res.meta.changes) await publish(c.env, c.id.institution?.id, { users: [c.id.userId === pid ? tid : pid], type: 'read', scope: 'parent',
      from: c.id.userId, keys: { student: sid, parent: pid, teacher: tid } })
    return ok({ ok: true })
  })

  r.post('/chat/staff-thread/read', 'auth', async (c) => {
    const other = c.url.searchParams.get('with')
    if (!isUUID(other)) throw badRequest('with must be the uuid of a colleague')
    const res = await c.db.prepare(`UPDATE staff_messages SET read_at = ? WHERE party_a = ? AND party_b = ? AND sender_user_id = ? AND read_at IS NULL`)
      .bind(now(), least(c.id.userId, other), greatest(c.id.userId, other), other).run()
    if (res.meta.changes) await publish(c.env, c.id.institution?.id, { users: [other], type: 'read', scope: 'staff',
      from: c.id.userId, keys: { peer: c.id.userId, to: other } })
    return ok({ ok: true })
  })

  // --- staff_messages.go -----------------------------------------------------
  r.get('/staff-messages/threads', 'auth', async (c) => {
    institutionId(c)
    const me = c.id.userId
    const rows = await c.db.prepare(`
      SELECT u.id AS user_id, u.full_name, d.name AS designation, e.photo_file_id AS photo,
             (SELECT count(*) FROM staff_messages m WHERE m.sender_user_id = u.id AND (m.party_a = ?1 OR m.party_b = ?1)
                AND (m.party_a = u.id OR m.party_b = u.id) AND m.read_at IS NULL) AS unread,
             (SELECT substr(m.body, 1, 90) FROM staff_messages m WHERE m.party_a = min(?1, u.id) AND m.party_b = max(?1, u.id) ORDER BY m.sent_at DESC LIMIT 1) AS last_message,
             (SELECT m.sent_at FROM staff_messages m WHERE m.party_a = min(?1, u.id) AND m.party_b = max(?1, u.id) ORDER BY m.sent_at DESC LIMIT 1) AS last_at
        FROM users u
        LEFT JOIN employees e ON e.user_id = u.id
        LEFT JOIN designations d ON d.id = e.designation_id
       WHERE u.id <> ?1 AND (e.id IS NULL OR e.status = 'active') AND ${STAFF_ROLE_SQL}
       ORDER BY 5 DESC, (last_at IS NULL), last_at DESC, u.full_name`).bind(me)
      .all<{ user_id: string; full_name: string; designation: string | null; photo: string | null; unread: number; last_message: string | null; last_at: string | null }>()
    return ok({ items: rows.results.map((v) => ({ user_id: v.user_id, full_name: v.full_name, designation: v.designation ?? undefined, photo: v.photo ?? undefined,
      unread: v.unread, last_message: v.last_message ?? undefined, last_at: v.last_at ?? undefined })) })
  })

  r.get('/staff-messages', 'auth', async (c) => {
    institutionId(c)
    const other = c.url.searchParams.get('with')
    if (!isUUID(other)) throw badRequest('with must be the uuid of a colleague')
    const pageSize = 40
    const before = (c.url.searchParams.get('before') ?? '').trim()
    const me = c.id.userId
    const rows = await c.db.prepare(`
      SELECT m.id, CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END AS body, m.sent_at,
             m.sender_user_id = ?1 AS mine, u.full_name AS sender_name,
             CASE WHEN m.deleted_at IS NULL THEN m.attachments ELSE NULL END AS attachments,
             m.reply_to_id,
             (SELECT substr(q.body, 1, 120) FROM staff_messages q WHERE q.id = m.reply_to_id) AS reply_body,
             (SELECT qu.full_name FROM staff_messages q JOIN users qu ON qu.id = q.sender_user_id WHERE q.id = m.reply_to_id) AS reply_sender,
             m.edited_at IS NOT NULL AS edited, m.deleted_at IS NOT NULL AS deleted, m.read_at
        FROM staff_messages m JOIN users u ON u.id = m.sender_user_id
       WHERE m.party_a = ?2 AND m.party_b = ?3 AND (?4 = '' OR m.sent_at < ?4)
       ORDER BY m.sent_at DESC LIMIT ?5`).bind(me, least(me, other), greatest(me, other), before, pageSize + 1)
      .all<{ id: string; body: string; sent_at: string; mine: number; sender_name: string; attachments: string | null; reply_to_id: string | null; reply_body: string | null; reply_sender: string | null; edited: number; deleted: number; read_at: string | null }>()
    let items = rows.results
    const more = items.length > pageSize
    if (more) items = items.slice(0, pageSize)
    items.reverse()
    const out = items.map((v) => ({ id: v.id, body: v.body, sent_at: v.sent_at, mine: !!v.mine, sender_name: v.sender_name,
      attachments: scanAttachments(v.attachments), cursor: v.sent_at, reply_to_id: v.reply_to_id ?? undefined,
      reply_body: v.reply_body ?? undefined, reply_sender: v.reply_sender ?? undefined, edited: !!v.edited, deleted: !!v.deleted, read_at: v.read_at ?? undefined }))
    return ok({ items: out, has_more: more, cursor: out.length ? out[0].cursor : '' })
  })

  r.post('/staff-messages', 'auth', async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ to?: string; body?: string; attachments?: Attachment[]; reply_to_id?: string }>(c.req)
    const other = (req.to ?? '').trim()
    if (!isUUID(other)) throw badRequest('to must be the uuid of a colleague')
    const files = await resolveAttachments(c, req.attachments)
    const body = (req.body ?? '').trim()
    if (body === '' && files.length === 0) throw badRequest('an empty message says nothing')
    if (other === c.id.userId) throw badRequest('you cannot message yourself')
    const colleague = await c.db.prepare(`SELECT (EXISTS (SELECT 1 FROM employees e WHERE e.user_id = u.id AND e.status = 'active') OR ${STAFF_ROLE_SQL}) AS ok
        FROM users u WHERE u.id = ?`).bind(other).first<{ ok: number }>()
    if (!colleague?.ok) throw badRequest('that person is not a member of staff at this school')
    const newId = uuid()
    const from = c.id.fullName
    const reply = (req.reply_to_id ?? '').trim()
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`INSERT INTO staff_messages (id, institution_id, party_a, party_b, sender_user_id, body, attachments, reply_to_id, sent_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(newId, inst, least(c.id.userId, other), greatest(c.id.userId, other), c.id.userId, body, JSON.stringify(files), reply === '' ? null : reply, now()),
    ]
    const n = await notifyStmt(c, other, null, 'staff_message', 'Message from ' + from, clip240(body),
      '/go/communication/messages?with=' + c.id.userId, 'staff_message', newId)
    if (n) stmts.push(n)
    await c.db.batch(stmts)
    await publish(c.env, inst, { users: [other, c.id.userId], type: 'message', scope: 'staff', from: c.id.userId,
      keys: { peer: c.id.userId, to: other, from_name: from } })
    return created({ id: newId })
  })

  // --- staff_remarks.go ------------------------------------------------------
  const broad = (c: Ctx) => can(c.id, 'hr.employees.write') || can(c.id, 'access.users.write') || can(c.id, 'hr.leave.approve')

  r.get('/staff-remarks/teachers', 'auth', async (c) => {
    institutionId(c)
    const sc = await resolveScope(c)
    if (broad(c)) {
      const rows = await c.db.prepare(`SELECT u.id AS user_id, u.full_name FROM employees e JOIN users u ON u.id = e.user_id
          WHERE e.status = 'active' AND u.id <> ? ORDER BY u.full_name`).bind(c.id.userId).all<{ user_id: string; full_name: string }>()
      return ok({ items: rows.results.map((v) => ({ user_id: v.user_id, full_name: v.full_name, relation: 'staff' })) })
    }
    if (sc.studentIds.length === 0) throw forbidden('missing permission: the list of teachers you may write about')
    const q = inList(sc.studentIds)
    const rows = await c.db.prepare(`
      SELECT u.id AS user_id, u.full_name, NULL AS subject,
             CASE WHEN sec.class_teacher_id = u.id THEN 'class teacher' ELSE 'subject teacher' END AS relation
        FROM enrollments e JOIN sections sec ON sec.id = e.section_id JOIN users u ON u.id = sec.class_teacher_id
       WHERE e.student_id IN ${q.sql} AND e.status = 'active'
      UNION
      SELECT u.id, u.full_name, sub.name, 'subject teacher'
        FROM enrollments e JOIN timetable_entries te ON te.section_id = e.section_id JOIN users u ON u.id = te.teacher_user_id
        JOIN class_subjects cs ON cs.id = te.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id
       WHERE e.student_id IN ${q.sql} AND e.status = 'active'`).bind(...q.args, ...q.args)
      .all<{ user_id: string; full_name: string; subject: string | null; relation: string }>()
    // DISTINCT ON (u.id) in each half: keep the first row per teacher in each half.
    const seen = new Set<string>()
    const out: unknown[] = []
    for (const v of rows.results) {
      const k = v.user_id + '|' + v.relation
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ user_id: v.user_id, full_name: v.full_name, subject: v.subject ?? undefined, relation: v.relation })
    }
    return ok(out)
  })

  r.get('/staff-remarks', 'auth', async (c) => {
    institutionId(c)
    const subject = c.url.searchParams.get('subject_user_id') || null
    const where = broad(c) ? '1' : '(sr.subject_user_id = ?1 OR sr.author_user_id = ?1)'
    const rows = await c.db.prepare(`
      SELECT sr.id, sr.subject_user_id, su.full_name AS subject_name, au.full_name AS author_name, sr.author_role, sr.kind, sr.body,
             sr.observed_on, substr(sr.created_at, 1, 16) AS recorded_at,
             trim(st.first_name || ' ' || COALESCE(st.last_name,'')) AS student_name, sr.author_user_id = ?1 AS mine
        FROM staff_remarks sr JOIN users su ON su.id = sr.subject_user_id JOIN users au ON au.id = sr.author_user_id
        LEFT JOIN students st ON st.id = sr.student_id
       WHERE (?2 IS NULL OR sr.subject_user_id = ?2) AND ${where}
       ORDER BY sr.observed_on DESC, sr.created_at DESC LIMIT 200`).bind(c.id.userId, subject)
      .all<{ id: string; subject_user_id: string; subject_name: string; author_name: string; author_role: string; kind: string; body: string; observed_on: string; recorded_at: string; student_name: string | null; mine: number }>()
    return ok({ items: rows.results.map((v) => ({ id: v.id, subject_user_id: v.subject_user_id, subject_name: v.subject_name, author_name: v.author_name,
      author_role: v.author_role, kind: v.kind, body: v.body, observed_on: v.observed_on, recorded_at: v.recorded_at,
      student_name: v.student_name ?? undefined, mine: !!v.mine })) })
  })

  r.post('/staff-remarks', 'auth', async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ subject_user_id?: string; kind?: string; body?: string; student_id?: string }>(c.req)
    const subject = req.subject_user_id ?? ''
    if (!isUUID(subject)) throw badRequest('subject_user_id must be a uuid')
    const body = (req.body ?? '').trim()
    if (body === '') throw badRequest('a remark with no words in it says nothing')
    if (subject === c.id.userId) throw badRequest('you cannot write a remark about yourself')
    const kind = req.kind || 'feedback'
    const sc = await resolveScope(c)
    let role: string
    if (can(c.id, 'hr.employees.write') || can(c.id, 'access.users.write')) role = 'principal'
    else if (can(c.id, 'hr.leave.approve') || can(c.id, 'academics.timetable.write')) role = 'hod'
    else if (sc.studentIds.length > 0) role = 'parent'
    else throw forbidden('missing permission: writing remarks about staff')

    const refuse = forbidden("you may write about your own department's staff, or about a teacher who teaches your child")
    let student: string | null = null
    if (role === 'parent') {
      const q = inList(sc.studentIds)
      const t = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM enrollments e JOIN sections sec ON sec.id = e.section_id
          WHERE e.student_id IN ${q.sql} AND e.status = 'active'
            AND (sec.class_teacher_id = ?
                 OR EXISTS (SELECT 1 FROM section_subject_teachers sst WHERE sst.section_id = sec.id AND sst.teacher_user_id = ?)
                 OR EXISTS (SELECT 1 FROM timetable_entries te WHERE te.section_id = sec.id AND te.teacher_user_id = ?))) AS teaches`)
        .bind(...q.args, subject, subject, subject).first<{ teaches: number }>()
      if (!t?.teaches) throw refuse
      if (req.student_id) {
        if (!isUUID(req.student_id) || !sc.studentIds.includes(req.student_id)) throw refuse
        student = req.student_id
      }
    }
    const newId = uuid()
    const stmts = [
      c.db.prepare(`INSERT INTO staff_remarks (id, institution_id, subject_user_id, author_user_id, author_role, student_id, kind, body, observed_on, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, date('now'), ?)`).bind(newId, inst, subject, c.id.userId, role, student, kind, body, now()),
    ]
    const n = await notifyStmt(c, subject, null, 'staff_remark', 'A remark about your work', clip240(body) + ' - ' + c.id.fullName,
      '/faculty/my_profile/remarks_about_me', 'staff_remark', newId)
    if (n) stmts.push(n)
    await c.db.batch(stmts)
    return created({ id: newId, author_role: role })
  })

}
