import type { Router, Ctx } from '../../router'
import { badRequest, isUUID, notFound, now, ok, readJSON } from '../../http'
import { resolveScope } from '../teaching/common'
import { classDash, firstLast, isoZ, omitNull, optInt, trim, ymdOf } from '../comms/common'
import { feedbackUpdateRow } from '../comms/grievances'
import { mediaRow } from '../comms/showcase'

/* The /portal/comms routes of comms.go: a family's view of a grievance it
   raised, its rating of the answer, and the published achievements wall.
   All on self.profile.read; ownership is raised_by = the caller for a
   grievance, and publication alone for the wall (it is school-wide by design). */

const P = 'self.profile.read'

async function getPortalFeedback(c: Ctx): Promise<Response> {
  const ticket = c.params.id
  if (!isUUID(ticket)) throw badRequest('id must be a uuid')
  const me = c.id.userId
  const v = await c.db.prepare(`SELECT t.id, t.category, t.subject, t.body, t.status, t.owner_department AS department,
        ${isoZ('t.created_at')} AS created_at, ${isoZ('t.respond_due_at')} AS respond_due_at,
        ${isoZ('t.resolve_due_at')} AS resolve_due_at, ${isoZ('t.resolved_at')} AS resolved_at,
        t.resolution, t.satisfaction
      FROM support_tickets t WHERE t.id = ? AND t.raised_by = ? AND t.audience = 'school'`)
    .bind(ticket, me).first<Record<string, unknown>>()
  if (!v) throw notFound()
  const tl = await c.db.prepare(`SELECT g.id, g.kind, g.body, g.new_status, g.visible_to_parent,
        u.full_name AS author, ${isoZ('g.created_at')} AS created_at
      FROM grievance_updates g
      JOIN support_tickets t ON t.id = g.ticket_id
      LEFT JOIN users u ON u.id = g.author_id
      WHERE g.ticket_id = ? AND g.visible_to_parent = 1 AND t.raised_by = ? AND t.audience = 'school'
      ORDER BY g.created_at`).bind(ticket, me).all<Record<string, unknown>>()
  return ok({ ...omitNull({ id: v.id, category: v.category, subject: v.subject, body: v.body, status: v.status,
    department: v.department, created_at: v.created_at, respond_due_at: v.respond_due_at, resolve_due_at: v.resolve_due_at,
    resolved_at: v.resolved_at, resolution: v.resolution, satisfaction: v.satisfaction }), timeline: tl.results.map(feedbackUpdateRow) })
}

async function rateFeedbackResolution(c: Ctx): Promise<Response> {
  const ticket = c.params.id
  if (!isUUID(ticket)) throw badRequest('id must be a uuid')
  const req = await readJSON<Record<string, unknown>>(c.req)
  const rating = optInt(req.rating) ?? 0
  if (rating < 1 || rating > 5) throw badRequest('rating must be between 1 and 5')
  let changes = 0
  try {
    const res = await c.db.prepare(`UPDATE support_tickets
        SET satisfaction = ?, satisfaction_note = NULLIF(?, ''), satisfaction_at = ?, updated_at = ?
        WHERE id = ? AND raised_by = ? AND audience = 'school' AND resolved_at IS NOT NULL AND satisfaction IS NULL`)
      .bind(rating, trim(req.note), now(), now(), ticket, c.id.userId).run()
    changes = res.meta.changes
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : String(e))
  }
  // One answer for "not yours", "not resolved" and "already rated".
  if (!changes) throw notFound()
  return ok({ recorded: true })
}

async function listPortalShowcase(c: Ctx): Promise<Response> {
  const scope = await resolveScope(c)
  const mine = JSON.stringify(scope.studentIds)
  const rows = await c.db.prepare(`SELECT a.id, ${firstLast('st')} AS student, ${classDash('c', 'sec')} AS class,
        a.kind, a.title, COALESCE(a.showcase_note, a.description) AS note, a.level, a."position" AS position,
        ${ymdOf('a.awarded_on')} AS awarded_on,
        a.student_id IN (SELECT value FROM json_each(?)) AS is_mine
      FROM student_achievements a
      JOIN students st ON st.id = a.student_id
      LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
      LEFT JOIN sections sec ON sec.id = en.section_id
      LEFT JOIN classes c ON c.id = sec.class_id
      WHERE a.is_published = 1
      ORDER BY a.awarded_on DESC NULLS LAST, a.published_at DESC
      LIMIT 200`).bind(mine).all<Record<string, unknown>>()
  const out = rows.results.map((v) => ({ ...omitNull({ id: v.id, student: v.student, class: v.class, kind: v.kind, title: v.title,
    note: v.note, level: v.level, position: v.position, awarded_on: v.awarded_on }), is_mine: !!v.is_mine, media: [] as Record<string, unknown>[] }))
  if (out.length) {
    const byId = new Map(out.map((v) => [v.id as string, v]))
    const media = await c.db.prepare(`SELECT m.achievement_id, m.id, m.file_id, f.original_name AS file_name, m.external_url, m.caption, m.sort_order
        FROM achievement_media m
        LEFT JOIN files f ON f.id = m.file_id
        WHERE m.achievement_id IN (SELECT value FROM json_each(?))
          AND (m.file_id IS NULL OR f.deleted_at IS NULL)
        ORDER BY m.sort_order, m.created_at`).bind(JSON.stringify([...byId.keys()])).all<Record<string, unknown>>()
    for (const m of media.results) byId.get(m.achievement_id as string)?.media.push(mediaRow(m))
  }
  return ok({ items: out })
}

export function registerPortalExtra(r: Router): void {
  r.get('/portal/comms/grievances/{id}', P, getPortalFeedback)
  r.post('/portal/comms/grievances/{id}/satisfaction', P, rateFeedbackResolution)
  r.get('/portal/comms/achievements', P, listPortalShowcase)
}
