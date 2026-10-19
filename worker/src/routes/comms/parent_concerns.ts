/* Parent concerns through the front desk (owner, 2026-10-20, Yajur):
   parents write only to the front desk; the desk filters by class, section
   or student, passes a concern to that class's class teacher or one of its
   subject teachers, sees which the teacher has marked resolved, and tells
   the parent. A school turns it on with module_settings
   'concerns_via_front_desk'. Concerns stay rows of support_tickets, so the
   principal's Grievances screen still sees every one.

   "Resolved by the teacher" is a grievance_updates row of kind
   'teacher_resolved' newer than the last time the desk passed it on; the
   ticket itself stays open until the desk tells the parent. */
import type { Ctx, Router } from '../../router'
import { badRequest, forbidden, isUUID, notFound, now, ok, readJSON } from '../../http'
import { notify, raiserLink } from './concern_shared'
import { feedbackUpdateStmt } from './grievances'

const READ = 'office.front_desk.read'
const WRITE = 'office.front_desk.write'

/** Whether this school sends parents' concerns through the front desk. */
export async function frontDeskMode(c: Ctx): Promise<boolean> {
  const r = await c.db.prepare(`SELECT enabled FROM module_settings WHERE module = 'concerns_via_front_desk'`).first<{ enabled: number }>()
  return !!r?.enabled
}

/** The front desk staff a parent may write to, by name. */
export async function frontDeskPeople(c: Ctx): Promise<{ user_id: string; full_name: string; role: string }[]> {
  const r = await c.db.prepare(`SELECT DISTINCT u.id AS user_id, u.full_name, ro.name AS role FROM users u
      JOIN user_roles ur ON ur.user_id = u.id JOIN roles ro ON ro.id = ur.role_id
     WHERE u.status = 'active' AND ro.key IN ('front_office', 'admissions') ORDER BY u.full_name`).all<{ user_id: string; full_name: string; role: string }>()
  return r.results
}

/** The section a ticket's student is in now. */
const SECTION_OF = `(SELECT en.section_id FROM enrollments en WHERE en.student_id = t.student_id AND en.status = 'active' ORDER BY en.created_at DESC LIMIT 1)`
const LAST_SENT = `(SELECT max(gu.created_at) FROM grievance_updates gu WHERE gu.ticket_id = t.id AND gu.kind = 'assignment')`
const TEACHER_DONE = `(SELECT gu.body FROM grievance_updates gu WHERE gu.ticket_id = t.id AND gu.kind = 'teacher_resolved'
                        AND gu.created_at >= COALESCE(${LAST_SENT}, '') ORDER BY gu.created_at DESC LIMIT 1)`

async function list(c: Ctx) {
  const q = c.url.searchParams
  const state = q.get('state') ?? 'open'
  const cls = q.get('class_id') ?? '', sec = q.get('section_id') ?? '', stu = q.get('student_id') ?? ''
  const search = (q.get('q') ?? '').trim().toLowerCase()
  const r = await c.db.prepare(`
    SELECT * FROM (
      SELECT t.id, t.subject, t.body, t.category, t.status, t.created_at, t.resolved_at, t.resolution, t.student_id,
             trim(COALESCE(st.first_name, '') || ' ' || COALESCE(st.last_name, '')) AS student,
             cl.id AS class_id, cl.name AS class_name, sec.id AS section_id, sec.name AS section_name,
             ru.full_name AS parent, au.full_name AS sent_to, t.assigned_to,
             ${TEACHER_DONE} AS teacher_note
        FROM support_tickets t
        LEFT JOIN students st ON st.id = t.student_id
        LEFT JOIN sections sec ON sec.id = ${SECTION_OF}
        LEFT JOIN classes cl ON cl.id = sec.class_id
        LEFT JOIN users ru ON ru.id = t.raised_by
        LEFT JOIN users au ON au.id = t.assigned_to
       WHERE t.audience = 'school')
     WHERE (? = '' OR class_id = ?) AND (? = '' OR section_id = ?) AND (? = '' OR student_id = ?)
       AND (? = '' OR instr(lower(subject || ' ' || body || ' ' || COALESCE(student, '') || ' ' || COALESCE(parent, '')), ?) > 0)
       AND CASE ?
             WHEN 'open' THEN status NOT IN ('resolved', 'closed') AND teacher_note IS NULL
             WHEN 'teacher_resolved' THEN status NOT IN ('resolved', 'closed') AND teacher_note IS NOT NULL
             WHEN 'resolved' THEN status IN ('resolved', 'closed')
             ELSE 1 END
     ORDER BY created_at DESC LIMIT 300`)
    .bind(cls, cls, sec, sec, stu, stu, search, search, state).all()
  return ok({ items: r.results })
}

/** Classes, sections and students for the filters. */
async function options(c: Ctx) {
  const sections = await c.db.prepare(`SELECT sec.id, sec.name, cl.id AS class_id, cl.name AS class_name FROM sections sec JOIN classes cl ON cl.id = sec.class_id
      WHERE sec.academic_year_id = (SELECT id FROM academic_years WHERE is_current = 1 LIMIT 1) ORDER BY cl.level, sec.name`).all()
  const students = await c.db.prepare(`SELECT DISTINCT st.id, trim(COALESCE(st.first_name, '') || ' ' || COALESCE(st.last_name, '')) AS name
      FROM support_tickets t JOIN students st ON st.id = t.student_id WHERE t.audience = 'school' ORDER BY name`).all()
  return ok({ sections: sections.results, students: students.results })
}

/** The class teacher and the subject teachers of the concern's class. */
async function teachers(c: Ctx) {
  if (!isUUID(c.params.id)) throw badRequest('invalid concern')
  const t = await c.db.prepare(`SELECT ${SECTION_OF} AS section_id FROM support_tickets t WHERE t.id = ? AND t.audience = 'school'`)
    .bind(c.params.id).first<{ section_id: string | null }>()
  if (!t) throw notFound('concern not found')
  if (!t.section_id) return ok({ items: [] })
  const r = await c.db.prepare(`
    SELECT u.id AS user_id, u.full_name, 'Class teacher' AS role, 0 AS ord FROM sections sec JOIN users u ON u.id = sec.class_teacher_id WHERE sec.id = ?1
    UNION
    SELECT u.id, u.full_name, s.name || ' teacher', 1 FROM section_subject_teachers sst
      JOIN class_subjects cs ON cs.id = sst.class_subject_id JOIN subjects s ON s.id = cs.subject_id
      JOIN users u ON u.id = sst.teacher_user_id WHERE sst.section_id = ?1
    ORDER BY ord, full_name`).bind(t.section_id).all()
  return ok({ items: r.results })
}

/** Pass the concern to one of that class's teachers. */
async function send(c: Ctx) {
  if (!isUUID(c.params.id)) throw badRequest('invalid concern')
  const b = await readJSON<{ user_id?: string; note?: string }>(c.req)
  if (!isUUID(b.user_id)) throw badRequest('pick a teacher')
  const ok_ = (await (await teachers(c)).clone().json<{ items: { user_id: string; full_name: string }[] }>()).items.find((x) => x.user_id === b.user_id)
  if (!ok_) throw forbidden("pick the class teacher or a subject teacher of this student's class")
  const t = await c.db.prepare(`SELECT subject FROM support_tickets WHERE id = ?`).bind(c.params.id).first<{ subject: string }>()
  const note = (b.note ?? '').trim()
  await c.db.batch([
    c.db.prepare(`UPDATE support_tickets SET assigned_to = ?, status = 'in_progress', acknowledged_at = COALESCE(acknowledged_at, ?), updated_at = ? WHERE id = ?`)
      .bind(b.user_id, now(), now(), c.params.id),
    feedbackUpdateStmt(c, c.params.id, 'assignment', `Sent to ${ok_.full_name}${note ? ': ' + note : ''}`, 'in_progress', false, c.id.userId),
    notify(c, b.user_id, 'A parent concern for you', t?.subject ?? null, `/go/concerns_from_parents?id=${c.params.id}`, 'support_ticket', c.params.id),
  ])
  return ok()
}

/** Tell the parent it is resolved: closes the concern and notifies them. */
async function tellParent(c: Ctx) {
  if (!isUUID(c.params.id)) throw badRequest('invalid concern')
  const b = await readJSON<{ message?: string }>(c.req)
  const msg = (b.message ?? '').trim()
  if (!msg) throw badRequest('write what to tell the parent')
  const t = await c.db.prepare(`SELECT raised_by, subject, student_id FROM support_tickets WHERE id = ? AND audience = 'school'`)
    .bind(c.params.id).first<{ raised_by: string; subject: string; student_id: string | null }>()
  if (!t) throw notFound('concern not found')
  const at = now()
  await c.db.batch([
    c.db.prepare(`UPDATE support_tickets SET status = 'resolved', resolution = ?, resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?`)
      .bind(msg, at, c.id.userId, at, c.params.id),
    feedbackUpdateStmt(c, c.params.id, 'resolution', msg, 'resolved', true, c.id.userId),
    notify(c, t.raised_by, 'Your concern has been resolved', msg, raiserLink(c.params.id), 'support_ticket', c.params.id, t.student_id),
  ])
  return ok()
}

export function registerParentConcerns(r: Router): void {
  r.get('/comms/parent-concerns-desk', READ, list)
  r.get('/comms/parent-concerns-desk/options', READ, options)
  r.get('/comms/parent-concerns-desk/{id}/teachers', READ, teachers)
  r.post('/comms/parent-concerns-desk/{id}/send', WRITE, send)
  r.post('/comms/parent-concerns-desk/{id}/tell-parent', WRITE, tellParent)
}
