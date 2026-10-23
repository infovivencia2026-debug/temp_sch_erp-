/* SUBJECT GROUP CHAT (owner, 2026-10-19): the subject head and every teacher
   under them in one thread per subject. The principal reads every thread.
   Who belongs is the same list the head's overview uses (subjectTeachers),
   plus the head, so adding or removing a teacher there changes who can talk
   here. */
import type { Ctx, Router } from '../../router'
import { ok, badRequest, forbidden, readJSON, isUUID, uuid, now } from '../../http'
import { can } from '../../identity'
import { institutionId } from '../admin/common'
import { subjectTeachers } from './subject_overview'

const OFFICE = 'institution_admin.academics.subject_overview'

async function isMember(c: Ctx, subjectId: string): Promise<boolean> {
  const head = await c.db.prepare(`SELECT 1 AS x FROM subject_heads WHERE subject_id = ? AND head_user_id = ?`).bind(subjectId, c.id.userId).first()
  return !!head || (await subjectTeachers(c, subjectId)).includes(c.id.userId)
}

/** The subjects whose chat this person is in (the principal: every subject with a head). */
async function mine(c: Ctx) {
  const subs = await c.db.prepare(`SELECT s.id, s.name, h.head_user_id FROM subjects s LEFT JOIN subject_heads h ON h.subject_id = s.id
      WHERE EXISTS (SELECT 1 FROM class_subjects cs WHERE cs.subject_id = s.id) ORDER BY s.name`).all<{ id: string; name: string; head_user_id: string | null }>()
  const office = can(c.id, OFFICE)
  const items: { id: string; name: string; read_only: boolean }[] = []
  for (const s of subs.results) {
    if (!s.head_user_id) continue
    const member = s.head_user_id === c.id.userId || (await subjectTeachers(c, s.id)).includes(c.id.userId)
    if (member) items.push({ id: s.id, name: s.name, read_only: false })
    else if (office) items.push({ id: s.id, name: s.name, read_only: true })
  }
  return ok({ items })
}

async function list(c: Ctx) {
  const sid = c.url.searchParams.get('subject')
  if (!isUUID(sid)) throw badRequest('pick a subject')
  if (!can(c.id, OFFICE) && !(await isMember(c, sid))) throw forbidden('this chat is for the teachers of another subject')
  const r = await c.db.prepare(`SELECT m.id, m.body, m.sent_at, m.sender_user_id, u.full_name AS sender,
        (SELECT 1 FROM subject_heads h WHERE h.subject_id = m.subject_id AND h.head_user_id = m.sender_user_id) AS is_head
      FROM subject_chat_messages m JOIN users u ON u.id = m.sender_user_id
     WHERE m.subject_id = ? ORDER BY m.sent_at DESC LIMIT 200`).bind(sid).all()
  return ok({ items: r.results.reverse(), me: c.id.userId })
}

async function send(c: Ctx) {
  const b = await readJSON<{ subject_id?: string; body?: string }>(c.req)
  if (!isUUID(b.subject_id)) throw badRequest('pick a subject')
  const body = (b.body ?? '').trim()
  if (!body) throw badRequest('write a message')
  if (body.length > 4000) throw badRequest('keep a message under 4000 characters')
  if (!(await isMember(c, b.subject_id))) throw forbidden('only the subject head and its teachers write here')
  const id = uuid()
  await c.db.prepare(`INSERT INTO subject_chat_messages (id, institution_id, subject_id, sender_user_id, body, sent_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, institutionId(c), b.subject_id, c.id.userId, body, now()).run()
  return ok({ id })
}

export function registerSubjectChat(r: Router): void {
  r.get('/teaching/subject-chat/mine', 'academics.timetable.read', mine)
  r.get('/teaching/subject-chat', 'academics.timetable.read', list)
  r.post('/teaching/subject-chat', 'academics.timetable.read', send)
}
