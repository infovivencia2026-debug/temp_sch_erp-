/* Subject meetings (academics.subject_meetings): the teacher's side of the
   meetings a subject head calls (owner, 2026-10-19: teachers say "attending"
   or "can't come"). A teacher sees the meetings of every subject they teach
   this year, and answers each one; the head sees the answers on the
   overview's Meetings tab. */
import type { Ctx, Router } from '../../router'
import { ok, badRequest, forbidden, notFound, readJSON, isUUID, now } from '../../http'
import { institutionId } from '../admin/common'
import { subjectTeachers } from './subject_overview'

async function myMeetings(c: Ctx) {
  const subs = await c.db.prepare(`SELECT DISTINCT subject_id FROM subject_meetings WHERE meets_at >= date('now', '-30 days')`).all<{ subject_id: string }>()
  const mine: string[] = []
  const headed = new Set((await c.db.prepare(`SELECT subject_id FROM subject_heads WHERE head_user_id = ?`).bind(c.id.userId).all<{ subject_id: string }>()).results.map((x) => x.subject_id))
  // A head sees the meetings they called too, not only the ones of subjects they teach.
  for (const s of subs.results) if (headed.has(s.subject_id) || (await subjectTeachers(c, s.subject_id)).includes(c.id.userId)) mine.push(s.subject_id)
  if (!mine.length) return ok({ items: [] })
  const r = await c.db.prepare(`SELECT m.id, m.title, m.agenda, m.meets_at, m.place, m.minutes, s.name AS subject, u.full_name AS by_name, r.reply, r.note
      FROM subject_meetings m JOIN subjects s ON s.id = m.subject_id LEFT JOIN users u ON u.id = m.created_by
      LEFT JOIN subject_meeting_replies r ON r.meeting_id = m.id AND r.user_id = ?
     WHERE m.subject_id IN (SELECT value FROM json_each(?)) AND m.meets_at >= date('now', '-30 days')
     ORDER BY m.meets_at`).bind(c.id.userId, JSON.stringify(mine)).all()
  return ok({ items: r.results })
}

async function reply(c: Ctx) {
  if (!isUUID(c.params.id)) throw badRequest('meeting id must be a uuid')
  const m = await c.db.prepare(`SELECT subject_id FROM subject_meetings WHERE id = ?`).bind(c.params.id).first<{ subject_id: string }>()
  if (!m) throw notFound('meeting not found')
  if (!(await subjectTeachers(c, m.subject_id)).includes(c.id.userId)) throw forbidden('this meeting is for the teachers of another subject')
  const b = await readJSON<{ reply?: string; note?: string }>(c.req)
  if (b.reply !== 'yes' && b.reply !== 'no') throw badRequest('answer attending or can\'t come')
  if (b.reply === 'no' && !(b.note ?? '').trim()) throw badRequest('say why you can\'t come')
  await c.db.prepare(`INSERT INTO subject_meeting_replies (meeting_id, user_id, institution_id, reply, note, replied_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (meeting_id, user_id) DO UPDATE SET reply = excluded.reply, note = excluded.note, replied_at = excluded.replied_at`)
    .bind(c.params.id, c.id.userId, institutionId(c), b.reply, b.note?.trim() || null, now()).run()
  return ok()
}

export function registerSubjectMeetings(r: Router): void {
  r.get('/teaching/subject-meetings', 'academics.timetable.read', myMeetings)
  r.post('/teaching/subject-meetings/{id}/reply', 'academics.timetable.read', reply)
}
