import type { Router, Ctx } from '../../router'
import { badRequest, bool, created, isUUID, notFound, now, ok, readJSON } from '../../http'
import { resolveScope } from '../teaching/common'
import { classDash, firstLast, isoZ, omitNull, optInt, trim, ymdOf } from '../comms/common'
import { feedbackUpdateRow, feedbackUpdateStmt } from '../comms/grievances'
import { REOPEN_DAYS, canReopen, dueAt, notify, ticketStage } from '../comms/concern_shared'
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
  const v = await c.db.prepare(`SELECT t.id, t.category, t.subject, t.body, t.status, ${ticketStage('t')} AS stage,
        t.owner_department AS department,
        ${isoZ('t.created_at')} AS created_at, ${isoZ('t.respond_due_at')} AS respond_due_at,
        ${isoZ('t.resolve_due_at')} AS resolve_due_at, ${isoZ('t.resolved_at')} AS resolved_at,
        ${isoZ('t.acknowledged_at')} AS acknowledged_at,
        t.resolution, t.satisfaction, t.satisfaction_note, t.reopened_count,
        ${canReopen('t', "t.status IN ('resolved', 'closed')")} AS can_reopen,
        t.attachment_file_id, f.original_name AS attachment_name
      FROM support_tickets t LEFT JOIN files f ON f.id = t.attachment_file_id AND f.deleted_at IS NULL
      WHERE t.id = ? AND t.raised_by = ? AND t.audience = 'school'`)
    .bind(ticket, me).first<Record<string, unknown>>()
  if (!v) throw notFound()
  /* Internal notes never leave the school: visible_to_parent = 1 is the only
     filter between the office's working notes and the family. The raiser's
     own replies are shown as theirs, not by name. */
  const tl = await c.db.prepare(`SELECT g.id, g.kind, g.body, g.new_status, g.visible_to_parent,
        CASE WHEN g.author_id = t.raised_by THEN 'You' ELSE u.full_name END AS author,
        g.author_id = t.raised_by AS mine, ${isoZ('g.created_at')} AS created_at
      FROM grievance_updates g
      JOIN support_tickets t ON t.id = g.ticket_id
      LEFT JOIN users u ON u.id = g.author_id
      WHERE g.ticket_id = ? AND g.visible_to_parent = 1 AND t.raised_by = ? AND t.audience = 'school'
      ORDER BY g.created_at`).bind(ticket, me).all<Record<string, unknown>>()
  return ok({ ...omitNull({ id: v.id, category: v.category, subject: v.subject, body: v.body, status: v.status, stage: v.stage,
    department: v.department, created_at: v.created_at, respond_due_at: v.respond_due_at, resolve_due_at: v.resolve_due_at,
    acknowledged_at: v.acknowledged_at, resolved_at: v.resolved_at, resolution: v.resolution, satisfaction: v.satisfaction,
    satisfaction_note: v.satisfaction_note,
    attachment: v.attachment_name != null ? { id: v.attachment_file_id, name: v.attachment_name } : undefined }),
    reopened_count: Number(v.reopened_count ?? 0), can_reopen: bool(v.can_reopen),
    timeline: tl.results.map((r) => ({ ...feedbackUpdateRow(r), mine: bool(r.mine) })) })
}

async function ownTicket(c: Ctx): Promise<{ id: string; status: string; assigned_to: string | null; escalated_to: string | null; subject: string; can_reopen: number }> {
  const ticket = c.params.id
  if (!isUUID(ticket)) throw badRequest('id must be a uuid')
  const v = await c.db.prepare(`SELECT t.id, t.status, t.assigned_to, t.escalated_to, t.subject,
        ${canReopen('t', "t.status IN ('resolved', 'closed')")} AS can_reopen
      FROM support_tickets t WHERE t.id = ? AND t.raised_by = ? AND t.audience = 'school'`)
    .bind(ticket, c.id.userId).first<{ id: string; status: string; assigned_to: string | null; escalated_to: string | null; subject: string; can_reopen: number }>()
  if (!v) throw notFound()
  return v
}

/** Whoever is working on it hears that the family wrote back. */
function tellOwners(c: Ctx, t: { id: string; assigned_to: string | null; escalated_to: string | null }, title: string, body: string): D1PreparedStatement[] {
  const to = new Set([t.assigned_to, t.escalated_to].filter((x): x is string => !!x && x !== c.id.userId))
  return [...to].map((u) => notify(c, u, title, body, `/institution_admin/communication/grievances?id=${t.id}`, 'support_ticket', t.id))
}

/** The raiser writes back. A case waiting on the family moves back to in progress. */
async function replyToFeedback(c: Ctx): Promise<Response> {
  const t = await ownTicket(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const body = trim(req.body)
  if (body === '') throw badRequest('write something to send')
  if (body.length > 4000) throw badRequest('keep a reply under 4000 characters')
  if (t.status === 'resolved' || t.status === 'closed') throw badRequest('this concern is closed. Reopen it to write again')
  await c.db.batch([
    c.db.prepare(`UPDATE support_tickets SET status = CASE WHEN status = 'waiting' THEN 'in_progress' ELSE status END, updated_at = ? WHERE id = ?`)
      .bind(now(), t.id),
    feedbackUpdateStmt(c, t.id, 'raiser_reply', body, null, true, c.id.userId),
    ...tellOwners(c, t, 'A family replied on a concern', body),
  ])
  return created({ added: true })
}

/** Reopen within the window: the answer did not settle it. */
async function reopenFeedback(c: Ctx): Promise<Response> {
  const t = await ownTicket(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const reason = trim(req.reason)
  if (reason === '') throw badRequest('say why it is not settled')
  if (!t.can_reopen) throw badRequest(`a concern can be reopened within ${REOPEN_DAYS} days of being resolved`)
  const policy = await c.db.prepare(`SELECT p.resolve_hours FROM grievance_sla_policies p JOIN support_tickets t ON lower(p.category) = lower(t.category)
      WHERE t.id = ? AND p.is_active = 1`).bind(t.id).first<{ resolve_hours: number }>()
  const n = now()
  await c.db.batch([
    c.db.prepare(`UPDATE support_tickets SET status = 'open', resolved_at = NULL, resolved_by = NULL,
        satisfaction = NULL, satisfaction_note = NULL, reopened_count = reopened_count + 1,
        resolve_due_at = COALESCE(?, resolve_due_at), escalated_at = NULL, updated_at = ? WHERE id = ?`)
      .bind(policy ? dueAt(n, policy.resolve_hours) : null, n, t.id),
    feedbackUpdateStmt(c, t.id, 'reopened', reason, 'open', true, c.id.userId),
    ...tellOwners(c, t, 'A concern was reopened', reason),
  ])
  return ok({ status: 'open' })
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
  r.post('/portal/comms/grievances/{id}/reply', P, replyToFeedback)
  r.post('/portal/comms/grievances/{id}/reopen', P, reopenFeedback)
  r.get('/portal/comms/achievements', P, listPortalShowcase)
}
