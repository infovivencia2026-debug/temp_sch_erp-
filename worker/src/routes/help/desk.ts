/* The vendor's support desk, on the ticket queue that was already here
   (admin/platform_config.ts: GET/POST /admin/platform/seller/tickets, with the
   SLA by plan and the agent who holds each ticket, tenant migration 0024).
   This file adds what a desk needs on top of the list: the conversation, the
   reply, working notes, and what the ticket knows about the fault.

   Every route is the desk's own (SUPPORT_DESK, platform staff only) and names
   the school in the path, so the ticket is read from that school's database
   and from nowhere else. Only audience = 'vendor' is ever read: a request the
   school kept for its own helpdesk is not the vendor's to see. */
import type { Ctx, Router } from '../../router'
import { badRequest, created, isUUID, notFound, now, ok, readJSON } from '../../http'
import { SUPPORT_DESK } from '../../identity'
import { tenantDb, type Institution } from '../../tenant'
import { platformOnly } from '../admin/common'
import { auditDetail } from '../../services/seller_audit'
import { errorRef } from '../../services/error_refs'
import { openIncidents } from './incidents_match'
import { TICKET_COLS, bell, deskLink, messageBody, parseDiagnostics, requestLink, thread, ticketSummary, updateStmt, type TicketRow } from './shared'

export interface DeskSchool { inst: Institution; db: D1Database }

/** The school named in the path, opened. Unknown, suspended and unprovisioned all answer 404. */
export async function deskSchool(c: Ctx): Promise<DeskSchool> {
  platformOnly(c)
  const iid = c.params.school
  if (!isUUID(iid)) throw badRequest('school must be a uuid')
  const inst = await c.env.CONTROL.prepare(`SELECT * FROM institutions WHERE id = ?`).bind(iid).first<Institution>()
  if (!inst) throw notFound()
  try { return { inst, db: tenantDb(c.env, inst) } } catch { throw notFound() }
}

export type VendorRow = TicketRow & { body: string; resolution: string | null; diagnostics: string | null; raised_by: string; raised_by_name: string | null
  vendor_agent_id: string | null; vendor_agent_name: string | null; attachment_file_id: string | null; attachment_name: string | null }

export async function vendorTicket(s: DeskSchool, id: string): Promise<VendorRow> {
  if (!isUUID(id)) throw badRequest('id must be a uuid')
  const t = await s.db.prepare(`SELECT ${TICKET_COLS}, t.body, t.resolution, t.diagnostics, t.raised_by, u.full_name AS raised_by_name,
        t.vendor_agent_id, t.vendor_agent_name, t.attachment_file_id, f.original_name AS attachment_name
      FROM support_tickets t LEFT JOIN users u ON u.id = t.raised_by LEFT JOIN files f ON f.id = t.attachment_file_id AND f.deleted_at IS NULL
      WHERE t.id = ? AND t.audience = 'vendor'`).bind(id).first<VendorRow>()
  if (!t) throw notFound()
  return t
}

/** Where the school's administrator reads the vendor's answer: beside the request it came from, or among their own. */
const schoolLink = (t: { id: string; parent_ticket_id: string | null }) => (t.parent_ticket_id ? deskLink(t.id) : requestLink(t.id))

export function registerSupportDesk(r: Router): void {
  r.get('/admin/platform/desk/{school}/tickets/{id}', SUPPORT_DESK, async (c) => {
    const s = await deskSchool(c)
    const t = await vendorTicket(s, c.params.id)
    const [tl, err, incidents] = await Promise.all([
      thread(s.db, t.id, 'vendor'),
      t.error_ref ? errorRef(c.env, t.error_ref) : Promise.resolve(null),
      t.incident_id ? openIncidents(c.env) : Promise.resolve([]),
    ])
    const inc = incidents.find((i) => i.id === t.incident_id)
    return ok({
      ...ticketSummary(t), school: { id: s.inst.id, name: s.inst.name }, body: t.body, resolution: t.resolution ?? undefined,
      raised_by: t.raised_by_name ?? undefined, agent: t.vendor_agent_name ?? undefined, agent_id: t.vendor_agent_id ?? undefined,
      /** Passed on by the school's helpdesk: the text is the administrator's summary, not the family's words. */
      escalated: !!t.parent_ticket_id,
      attachment: t.attachment_name ? { id: t.attachment_file_id, name: t.attachment_name } : undefined,
      diagnostics: parseDiagnostics(t.diagnostics),
      /* The logged error behind the reference, while it is kept (14 days). Only when it happened in this school. */
      error: err && (!err.institution_id || err.institution_id === s.inst.id)
        ? { code: err.code, at: err.at, method: err.method, route: err.route, message: err.message, role: err.role ?? undefined, user: err.user_name ?? undefined, release: err.release ?? undefined }
        : undefined,
      error_expired: !!t.error_ref && !err,
      incident: inc ? { id: inc.id, title: inc.title, workaround: inc.workaround } : undefined,
      thread: tl,
    })
  })

  r.post('/admin/platform/desk/{school}/tickets/{id}/reply', SUPPORT_DESK, async (c) => {
    const s = await deskSchool(c)
    const t = await vendorTicket(s, c.params.id)
    const req = await readJSON<{ body?: string; internal?: boolean; waiting?: boolean }>(c.req)
    const body = messageBody(req.body)
    if (t.status === 'closed') throw badRequest('this ticket is closed')
    const internal = !!req.internal
    const n = now()
    const stmts: D1PreparedStatement[] = [
      // A vendor agent is not a user of the school: no author_id, the name and the side carry it.
      updateStmt(s.db, s.inst.id, t.id, { kind: internal ? 'note' : 'reply', body, side: 'vendor', authorId: null, authorName: c.id.fullName, visible: !internal }),
    ]
    if (internal) {
      stmts.push(s.db.prepare(`UPDATE support_tickets SET vendor_agent_id = COALESCE(vendor_agent_id, ?), vendor_agent_name = COALESCE(vendor_agent_name, ?), updated_at = ? WHERE id = ?`)
        .bind(c.id.userId, c.id.fullName, n, t.id))
    } else {
      stmts.push(s.db.prepare(`UPDATE support_tickets SET acknowledged_at = COALESCE(acknowledged_at, ?), vendor_agent_id = COALESCE(vendor_agent_id, ?),
          vendor_agent_name = COALESCE(vendor_agent_name, ?), status = CASE WHEN status IN ('resolved') THEN status WHEN ? = 1 THEN 'waiting' ELSE 'in_progress' END,
          last_reply_at = ?, last_reply_side = 'vendor', updated_at = ? WHERE id = ?`)
        .bind(n, c.id.userId, c.id.fullName, req.waiting ? 1 : 0, n, n, t.id))
      stmts.push(bell(s.db, s.inst.id, t.raised_by, 'XULO support replied', body, schoolLink(t), t.id))
    }
    await s.db.batch(stmts)
    auditDetail(c, { action: internal ? 'desk.note' : 'desk.reply', institution_id: s.inst.id, institution_name: s.inst.name, target: t.id, after: { internal, waiting: !!req.waiting } })
    return created({ added: true })
  })

  r.post('/admin/platform/desk/{school}/tickets/{id}/resolve', SUPPORT_DESK, async (c) => {
    const s = await deskSchool(c)
    const t = await vendorTicket(s, c.params.id)
    const resolution = messageBody((await readJSON<{ resolution?: string }>(c.req)).resolution, 'what solved it')
    if (t.status === 'resolved' || t.status === 'closed') throw badRequest('this ticket is already solved')
    const n = now()
    await s.db.batch([
      s.db.prepare(`UPDATE support_tickets SET status = 'resolved', resolution = ?, resolved_at = ?, solved_by = 'vendor',
          acknowledged_at = COALESCE(acknowledged_at, ?), vendor_agent_id = COALESCE(vendor_agent_id, ?), vendor_agent_name = COALESCE(vendor_agent_name, ?),
          last_reply_at = ?, last_reply_side = 'vendor', updated_at = ? WHERE id = ?`).bind(resolution, n, n, c.id.userId, c.id.fullName, n, n, t.id),
      updateStmt(s.db, s.inst.id, t.id, { kind: 'resolved', body: resolution, side: 'vendor', authorId: null, authorName: c.id.fullName, visible: true, newStatus: 'resolved' }),
      bell(s.db, s.inst.id, t.raised_by, 'XULO support has an answer', resolution, schoolLink(t), t.id),
    ])
    auditDetail(c, { action: 'desk.resolve', institution_id: s.inst.id, institution_name: s.inst.name, target: t.id })
    return ok({ status: 'resolved' })
  })
}
