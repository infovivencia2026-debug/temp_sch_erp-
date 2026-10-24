/* Concerns from parents, the teacher's side (owner, 2026-10-20, Yajur): the
   concerns the front desk passed to this teacher. The teacher reads them and
   marks each one resolved with a line on what was done; the front desk sees
   that under "Resolved by teacher" and tells the parent. See
   parent_concerns.ts. */
import type { Ctx, Router } from '../../router'
import { clearDoneWork } from '../../services/notification_done'
import { badRequest, forbidden, isUUID, ok, readJSON } from '../../http'
import { notify } from './concern_shared'
import { feedbackUpdateStmt } from './grievances'
import { frontDeskPeople } from './parent_concerns'

const SECTION_OF = `(SELECT en.section_id FROM enrollments en WHERE en.student_id = t.student_id AND en.status = 'active' ORDER BY en.created_at DESC LIMIT 1)`

async function mine(c: Ctx) {
  const r = await c.db.prepare(`
    SELECT t.id, t.subject, t.body, t.created_at, t.status,
           trim(COALESCE(st.first_name, '') || ' ' || COALESCE(st.last_name, '')) AS student,
           cl.name || ' ' || sec.name AS class,
           (SELECT gu.body FROM grievance_updates gu WHERE gu.ticket_id = t.id AND gu.kind = 'assignment' ORDER BY gu.created_at DESC LIMIT 1) AS desk_note,
           (SELECT gu.body FROM grievance_updates gu WHERE gu.ticket_id = t.id AND gu.kind = 'teacher_resolved' AND gu.author_id = ?1
              ORDER BY gu.created_at DESC LIMIT 1) AS my_note
      FROM support_tickets t
      LEFT JOIN students st ON st.id = t.student_id
      LEFT JOIN sections sec ON sec.id = ${SECTION_OF}
      LEFT JOIN classes cl ON cl.id = sec.class_id
     WHERE t.audience = 'school' AND t.assigned_to = ?1
     ORDER BY (t.status IN ('resolved', 'closed')), t.created_at DESC LIMIT 200`).bind(c.id.userId).all()
  return ok({ items: r.results })
}

async function resolved(c: Ctx) {
  if (!isUUID(c.params.id)) throw badRequest('invalid concern')
  const t = await c.db.prepare(`SELECT subject FROM support_tickets WHERE id = ? AND audience = 'school' AND assigned_to = ?`)
    .bind(c.params.id, c.id.userId).first<{ subject: string }>()
  if (!t) throw forbidden('this concern was not passed to you')
  const b = await readJSON<{ note?: string }>(c.req)
  const note = (b.note ?? '').trim()
  if (!note) throw badRequest('say what was done')
  const stmts = [feedbackUpdateStmt(c, c.params.id, 'teacher_resolved', note, null, false, c.id.userId)]
  for (const p of await frontDeskPeople(c)) {
    stmts.push(notify(c, p.user_id, 'A teacher resolved a parent concern', t.subject, `/go/parent_concerns?id=${c.params.id}`, 'support_ticket', c.params.id))
  }
  await c.db.batch(stmts)
  await clearDoneWork(c, 'concern.support_ticket', c.params.id)
  return ok()
}

export function registerConcernsFromParents(r: Router): void {
  r.get('/teaching/parent-concerns', 'academics.timetable.read', mine)
  r.post('/teaching/parent-concerns/{id}/resolved', 'academics.timetable.read', resolved)
}
