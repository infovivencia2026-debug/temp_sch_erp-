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
import { subscriptionsByInstitution } from '../seller/tenants'
import { contentEntries, forgetContent, type ContentKind } from './content'
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

/* --- the context panel, bulk actions, and the content kept once for every school --- */

const KINDS = new Set<ContentKind>(['article', 'tip', 'canned', 'category', 'sla'])

export function registerSupportDeskMore(r: Router): void {
  /* What the desk reads beside a ticket: the school (plan, health, switches),
     the person who raised it (role, last sign-in), what changed in the school
     lately, and the troubleshooter results that came with it. Changes are
     listed by action and kind of record only, never their contents. */
  r.get('/admin/platform/desk/{school}/tickets/{id}/context', SUPPORT_DESK, async (c) => {
    const s = await deskSchool(c)
    const t = await vendorTicket(s, c.params.id)
    const [subs, health, switches, person, audit] = await Promise.all([
      subscriptionsByInstitution(c.env),
      c.env.CONTROL.prepare(`SELECT data, computed_at FROM school_health WHERE institution_id = ?`).bind(s.inst.id).first<{ data: string; computed_at: string }>().catch(() => null),
      c.env.CONTROL.prepare(`SELECT feature_id, enabled, ends_at FROM school_feature_overrides WHERE institution_id = ? ORDER BY feature_id`).bind(s.inst.id).all<{ feature_id: string; enabled: number; ends_at: string | null }>().catch(() => ({ results: [] })),
      s.db.prepare(`SELECT u.last_login_at, (SELECT group_concat(r.name, ', ') FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS roles
          FROM users u WHERE u.id = ?`).bind(t.raised_by).first<{ last_login_at: string | null; roles: string | null }>(),
      s.db.prepare(`SELECT created_at AS at, action, entity_type FROM audit_log ORDER BY id DESC LIMIT 8`).all<{ at: string; action: string; entity_type: string }>().catch(() => ({ results: [] })),
    ])
    const sub = subs.get(s.inst.id)
    let h: Record<string, unknown> | null = null
    try { h = health ? JSON.parse(health.data) : null } catch { h = null }
    return ok({
      school: { id: s.inst.id, name: s.inst.name, status: s.inst.status, plan: sub?.plan_name ?? sub?.plan_code ?? undefined, subscription: sub?.status ?? undefined },
      health: h ? { computed_at: health!.computed_at, errors_24h: h.errors_24h, jobs_failed_24h: h.jobs_failed_24h, last_activity_at: h.last_activity_at,
        problems: Array.isArray(h.problems) ? (h.problems as { label: string; count: number }[]).filter((p) => p.count > 0).map((p) => ({ label: p.label, count: p.count })) : [] } : undefined,
      switches: switches.results.map((x) => ({ feature: x.feature_id, on: !!x.enabled, ends_at: x.ends_at ?? undefined })),
      raised_by: { roles: person?.roles ?? undefined, last_sign_in: person?.last_login_at ?? undefined },
      recent_changes: audit.results,
    })
  })

  /* Bulk: take (yourself), close, or merge into one ticket of the same school. */
  r.post('/admin/platform/desk/bulk', SUPPORT_DESK, async (c) => {
    platformOnly(c)
    const req = await readJSON<{ action?: string; items?: { school: string; id: string }[]; into?: { school: string; id: string }; note?: string }>(c.req)
    const items = Array.isArray(req.items) ? req.items.slice(0, 100) : []
    if (!items.length) throw badRequest('choose at least one ticket')
    if (!['take', 'close', 'merge'].includes(String(req.action))) throw badRequest('unknown action')
    if (req.action === 'merge' && (!req.into || items.some((i) => i.school !== req.into!.school))) throw badRequest('tickets can be merged only within one school')
    let done = 0
    const n = now()
    for (const it of items) {
      c.params.school = it.school
      const s = await deskSchool(c)
      const t = await vendorTicket(s, it.id)
      if (req.action === 'take') {
        await s.db.prepare(`UPDATE support_tickets SET vendor_agent_id = ?, vendor_agent_name = ?, status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END, updated_at = ? WHERE id = ?`)
          .bind(c.id.userId, c.id.fullName, n, t.id).run()
      } else if (req.action === 'close') {
        if (t.status === 'closed') continue
        await s.db.batch([
          s.db.prepare(`UPDATE support_tickets SET status = 'closed', resolved_at = COALESCE(resolved_at, ?), solved_by = COALESCE(solved_by, 'vendor'), updated_at = ? WHERE id = ?`).bind(n, n, t.id),
          updateStmt(s.db, s.inst.id, t.id, { kind: 'closed', body: String(req.note ?? '').trim() || 'Closed by XULO support.', side: 'vendor', authorId: null, authorName: c.id.fullName, visible: true, newStatus: 'closed' }),
        ])
      } else {
        if (it.id === req.into!.id) continue
        const into = await vendorTicket(s, req.into!.id)
        await s.db.batch([
          s.db.prepare(`UPDATE support_tickets SET status = 'closed', merged_into = ?, updated_at = ? WHERE id = ?`).bind(into.id, n, t.id),
          s.db.prepare(`UPDATE support_tickets SET me_too = me_too + 1, updated_at = ? WHERE id = ?`).bind(n, into.id),
          updateStmt(s.db, s.inst.id, t.id, { kind: 'merged', body: `The same fault as "${into.subject}". Follow that one for the answer.`, side: 'vendor', authorId: null, authorName: c.id.fullName, visible: true, newStatus: 'closed' }),
          bell(s.db, s.inst.id, t.raised_by, 'Your ticket was joined to another', into.subject, schoolLink(into), into.id),
        ])
      }
      done++
    }
    auditDetail(c, { action: `desk.bulk.${req.action}`, after: { count: done } })
    return ok({ done })
  })

  // --- help content: articles, tips, canned replies, categories, the SLA policy ---
  r.get('/admin/platform/help-content/{kind}', SUPPORT_DESK, async (c) => {
    platformOnly(c)
    const kind = c.params.kind as ContentKind
    if (!KINDS.has(kind)) throw notFound()
    return ok({ items: await contentEntries(c.env, kind) })
  })
  r.put('/admin/platform/help-content/{kind}/{key}', SUPPORT_DESK, async (c) => {
    platformOnly(c)
    const kind = c.params.kind as ContentKind
    const key = c.params.key
    if (!KINDS.has(kind)) throw notFound()
    if (!/^[a-z0-9_]{2,60}$/.test(key)) throw badRequest('a key is 2 to 60 lowercase letters, digits or underscores')
    const req = await readJSON<{ data?: Record<string, unknown>; hidden?: boolean }>(c.req)
    const data = req.data && typeof req.data === 'object' ? req.data : null
    if (!data) throw badRequest('nothing to save')
    const text = (k: string) => typeof data[k] === 'string' && (data[k] as string).trim() !== ''
    if (kind === 'article' && !(text('title') && text('body') && text('topic'))) throw badRequest('an article needs a title, a topic and a body')
    if (kind === 'tip' && !(text('title') && text('body') && text('since'))) throw badRequest('a tip needs a title, a body and the release it starts from')
    if (kind === 'canned' && !(text('title') && text('body'))) throw badRequest('a canned reply needs a title and a body')
    if (kind === 'category' && !(text('label') && text('hint'))) throw badRequest('a category needs a label and a hint')
    if (kind === 'sla') {
      const ok1 = Number(data.respond_hours) > 0 && Number(data.resolve_hours) >= Number(data.respond_hours)
      if (!ok1) throw badRequest('the hours must be positive, and the answer no sooner than the first reply')
    }
    const body = JSON.stringify({ ...data, key: undefined })
    await c.env.CONTROL.prepare(`INSERT INTO help_content (kind, key, data, status, updated_at, updated_by, updated_by_name) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (kind, key) DO UPDATE SET data = excluded.data, status = excluded.status, updated_at = excluded.updated_at, updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name`)
      .bind(kind, key, body, req.hidden ? 'hidden' : 'published', now(), c.id.userId, c.id.fullName).run()
    forgetContent()
    auditDetail(c, { action: `help_content.${kind}.save`, target: key })
    return ok({ saved: true })
  })
  /* Back to the shipped text (or gone, for one the desk added). */
  r.del('/admin/platform/help-content/{kind}/{key}', SUPPORT_DESK, async (c) => {
    platformOnly(c)
    const res = await c.env.CONTROL.prepare(`DELETE FROM help_content WHERE kind = ? AND key = ?`).bind(c.params.kind, c.params.key).run()
    forgetContent()
    if (!(res.meta.changes ?? 0)) throw notFound()
    auditDetail(c, { action: `help_content.${c.params.kind}.reset`, target: c.params.key })
    return ok({ reset: true })
  })
}
