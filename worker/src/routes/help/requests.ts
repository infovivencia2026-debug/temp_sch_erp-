/* The Help Centre's requests: any signed-in person of a school asks for help
   with the app, follows the answer as a conversation, reopens it, and says
   whether it helped.

   WHERE A REQUEST GOES. A parent's, a student's or a member of staff's goes
   to the school's own helpdesk (audience 'helpdesk'), which answers or passes
   it on (helpdesk.ts). A request from someone who IS the helpdesk
   (help.desk.write: the school's administrator) has nobody in the school to
   go to, so it goes to the vendor's desk (audience 'vendor'), and its text is
   refused if it names a student. */
import type { Ctx, Router } from '../../router'
import { reply } from '../../router'
import { badRequest, forbidden, notFound, now, uuid, uuidParam, readJSON } from '../../http'
import { can } from '../../identity'
import { isoZ } from '../comms/common'
import { REOPEN_DAYS, dueAt, ownAttachment, policyFor, ticketStage } from '../comms/concern_shared'
import { entitlementFor } from '../misc/shell'
import { cleanErrorRef } from '../../services/error_refs'
import { categoriesFor, contentOf, localise, slaPolicy, vendorHours, type HelpCategory } from './content'
import type { HelpArticle, HelpTip } from './content_articles'
import './content_articles'
import { incidentFor, openIncidents } from './incidents_match'
import {
  DESK_WRITE, HELP, TICKET_COLS, bell, cleanDiagnostics, deskLink, helpdeskStaff, messageBody, namedStudent, refuseNamedStudent,
  subjectFrom, thread, ticketSummary, updateStmt, type TicketRow,
} from './shared'
import type { HelpIncidentNote, HelpRequestInput } from '@shared/api/feature_helpdesk'

/** The caller as a person of a school. A platform account has no row in a school's users and raises nothing here. */
export function schoolUser(c: Ctx): { inst: string; userId: string } {
  if (!c.id.institution || c.id.platformAdmin) throw forbidden('the Help Centre is for a school account')
  return { inst: c.id.institution.id, userId: c.id.userId }
}

const lang = (c: Ctx) => ((c.url.searchParams.get('lang') ?? 'en').toLowerCase() === 'te' ? 'te' : 'en')

async function ownRequest(c: Ctx): Promise<TicketRow & { body: string; resolution: string | null; assigned_to: string | null; raised_by: string }> {
  const { userId } = schoolUser(c)
  const id = uuidParam(c.params.id)
  const t = await c.db.prepare(`SELECT ${TICKET_COLS}, t.body, t.resolution, t.assigned_to, t.raised_by, t.attachment_file_id, f.original_name AS attachment_name
      FROM support_tickets t LEFT JOIN files f ON f.id = t.attachment_file_id AND f.deleted_at IS NULL
      WHERE t.id = ? AND t.raised_by = ? AND t.origin = '${HELP}'`).bind(id, userId)
    .first<TicketRow & { body: string; resolution: string | null; assigned_to: string | null; raised_by: string }>()
  // One answer for "no such request" and "not yours".
  if (!t) throw notFound()
  return t
}

/** Whoever is working on a school-side request hears that its raiser wrote. */
async function tellHelpdesk(c: Ctx, t: { id: string; audience: string; assigned_to: string | null }, title: string, body: string): Promise<D1PreparedStatement[]> {
  if (t.audience !== 'helpdesk') return []
  const { inst, userId } = schoolUser(c)
  const to = t.assigned_to ? [t.assigned_to] : await helpdeskStaff(c.db)
  return to.filter((u) => u !== userId).map((u) => bell(c.db, inst, u, title, body, deskLink(t.id), t.id))
}

const forRoles = (roles: string[], mine: string[]) => !roles?.length || roles.some((r) => mine.includes(r))

export function registerHelpRequests(r: Router): void {
  r.typed('GET /help/articles', 'auth', async (c) => {
    schoolUser(c)
    const items = (await contentOf<HelpArticle>(c.env, 'article')).filter((a) => forRoles(a.roles, c.id.roles))
    return { items: items.map((a) => ({ key: a.key, title: a.title, topic: a.topic, body: a.body, route: a.route, anchor: a.anchor, keywords: a.keywords })) }
  })

  /* "What's new": short tips for the role, newest release first, less the ones this person put away. */
  r.typed('GET /help/tips', 'auth', async (c) => {
    const { userId } = schoolUser(c)
    const gone = await c.db.prepare(`SELECT tip_key FROM help_tip_dismissals WHERE user_id = ?`).bind(userId).all<{ tip_key: string }>()
    const away = new Set(gone.results.map((g) => g.tip_key))
    const tips = (await contentOf<HelpTip>(c.env, 'tip')).filter((t) => forRoles(t.roles, c.id.roles) && !away.has(t.key))
      .sort((a, b) => b.since.localeCompare(a.since) || a.sort - b.sort)
      .map((t) => localise(t as unknown as Record<string, unknown>, lang(c)) as unknown as HelpTip)
    return { items: tips.map((t) => ({ key: t.key, title: t.title, body: t.body, device: t.device, since: t.since })) }
  })

  r.typed('POST /help/tips/{key}/dismiss', 'auth', async (c) => {
    const { inst, userId } = schoolUser(c)
    const key = String(c.params.key ?? '')
    if (!/^[a-z0-9_]{1,60}$/.test(key)) throw badRequest('unknown tip')
    await c.db.prepare(`INSERT OR IGNORE INTO help_tip_dismissals (user_id, tip_key, institution_id, dismissed_at) VALUES (?, ?, ?, ?)`).bind(userId, key, inst, now()).run()
    return { dismissed: true as const }
  })

  r.typed('GET /help/categories', 'auth', async (c) => {
    schoolUser(c)
    const items = (await categoriesFor(c.env, c.id.roles)).map((x) => localise(x as unknown as Record<string, unknown>, lang(c)) as unknown as HelpCategory)
    return { items: items.map((x) => ({ key: x.key, label: x.label, hint: x.hint, troubleshooter: x.troubleshooter })) }
  })

  r.typed('GET /help/requests', 'auth', async (c) => {
    const { userId } = schoolUser(c)
    const [mine, following] = await Promise.all([
      c.db.prepare(`SELECT ${TICKET_COLS} FROM support_tickets t WHERE t.raised_by = ? AND t.origin = '${HELP}'
          ORDER BY t.status IN ('resolved', 'closed'), COALESCE(t.last_reply_at, t.created_at) DESC LIMIT 100`).bind(userId).all<TicketRow>(),
      c.db.prepare(`SELECT t.id, t.category, ${ticketStage('t')} AS stage, ${isoZ('t.created_at')} AS created_at
          FROM support_ticket_followers f JOIN support_tickets t ON t.id = f.ticket_id
          WHERE f.user_id = ? AND t.origin = '${HELP}' ORDER BY f.created_at DESC LIMIT 20`).bind(userId)
        .all<{ id: string; category: string; stage: string; created_at: string }>(),
    ])
    return { items: mine.results.map(ticketSummary), following: following.results }
  })

  r.typed('POST /help/requests', 'auth', async (c) => {
    const { inst, userId } = schoolUser(c)
    const req = await readJSON<HelpRequestInput>(c.req)
    const body = messageBody(req.body, 'what happened')
    const subject = subjectFrom(req.subject, body)
    const category = String(req.category ?? '').trim()
    const known = await contentOf<HelpCategory>(c.env, 'category')
    if (!known.some((k) => k.key === category)) throw badRequest('choose one of the listed topics')
    const route = typeof req.route === 'string' && req.route.startsWith('/') ? req.route.slice(0, 200) : null
    const role = typeof req.role === 'string' && c.id.roles.includes(req.role) ? req.role : (c.id.roles[0] ?? null)
    const diagnostics = cleanDiagnostics(req.diagnostics)
    const errorRef = cleanErrorRef(req.error_ref) ?? diagnostics.last_failed?.ref ?? null
    const attachment = await ownAttachment(c, req.attachment_file_id)
    const toVendor = can(c.id, DESK_WRITE)
    if (toVendor) {
      const named = await namedStudent(c.db, `${subject}\n${body}`)
      if (named) throw refuseNamedStudent(named)
      // The assistant's conversation can quote a record; it stays in the school.
      delete diagnostics.conversation
      delete diagnostics.checks
    }
    const t = now()
    const priority = req.urgent ? 'high' : 'normal'
    const sla = await slaPolicy(c.env)
    let respondDue: string | null = null, resolveDue: string
    if (toVendor) {
      resolveDue = dueAt(t, vendorHours(sla, (await entitlementFor(c)).planCode, priority))
    } else {
      // The school's own policy for help requests, where it has written one (Communication > Grievances > SLA); else the shared one.
      const own = await policyFor(c, 'help')
      respondDue = dueAt(t, own?.respond_hours ?? sla.respond_hours)
      resolveDue = dueAt(t, own?.resolve_hours ?? sla.resolve_hours)
    }
    const incident = incidentFor(await openIncidents(c.env), { institutionId: inst, category, route })
    const id = uuid()
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`INSERT INTO support_tickets (id, institution_id, raised_by, category, subject, body, priority, status, audience, origin, route, role_key,
            diagnostics, error_ref, attachment_file_id, respond_due_at, resolve_due_at, incident_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, '${HELP}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, inst, userId, category, subject, body, priority, toVendor ? 'vendor' : 'helpdesk', route, role,
          JSON.stringify(diagnostics), errorRef, attachment, respondDue, resolveDue, incident?.id ?? null, t, t),
    ]
    let note: HelpIncidentNote | undefined
    if (incident) {
      note = { id: incident.id, title: incident.title, workaround: incident.workaround }
      stmts.push(updateStmt(c.db, inst, id, { kind: 'known_issue', side: toVendor ? 'vendor' : 'school', authorId: null, authorName: 'Known issue',
        body: `${incident.title}\n${incident.workaround}`, visible: true }))
    }
    if (!toVendor) {
      for (const u of await helpdeskStaff(c.db)) if (u !== userId) stmts.push(bell(c.db, inst, u, 'A request for help', subject, deskLink(id), id))
    }
    await c.db.batch(stmts)
    if (incident) await c.env.CONTROL.prepare(`UPDATE help_incidents SET linked = linked + 1 WHERE id = ?`).bind(incident.id).run().catch(() => null)
    return reply({ id, with: toVendor ? 'vendor' as const : 'school' as const, incident: note }, 201)
  })

  r.typed('GET /help/requests/{id}', 'auth', async (c) => {
    const t = await ownRequest(c)
    const [tl, child, incidents] = await Promise.all([
      thread(c.db, t.id, 'public'),
      c.db.prepare(`SELECT 1 AS x FROM support_tickets WHERE parent_ticket_id = ? LIMIT 1`).bind(t.id).first(),
      t.incident_id ? openIncidents(c.env) : Promise.resolve([]),
    ])
    const inc = incidents.find((i) => i.id === t.incident_id)
    return {
      ...ticketSummary(t), body: t.body, resolution: t.resolution ?? undefined,
      attachment: t.attachment_name != null ? { id: String(t.attachment_file_id), name: String(t.attachment_name) } : undefined,
      escalated: !!child, incident: inc ? { id: inc.id, title: inc.title, workaround: inc.workaround } : undefined, thread: tl,
    }
  })

  r.typed('POST /help/requests/{id}/reply', 'auth', async (c) => {
    const t = await ownRequest(c)
    const { inst, userId } = schoolUser(c)
    const body = messageBody((await readJSON<{ body?: string }>(c.req)).body)
    if (t.status === 'resolved' || t.status === 'closed') throw badRequest('this request is closed. Reopen it to write again')
    if (t.audience === 'vendor') { const named = await namedStudent(c.db, body); if (named) throw refuseNamedStudent(named) }
    const n = now()
    await c.db.batch([
      c.db.prepare(`UPDATE support_tickets SET status = CASE WHEN status = 'waiting' THEN 'in_progress' ELSE status END,
          last_reply_at = ?, last_reply_side = 'raiser', updated_at = ? WHERE id = ?`).bind(n, n, t.id),
      updateStmt(c.db, inst, t.id, { kind: 'raiser_reply', body, side: 'raiser', authorId: userId, authorName: c.id.fullName, visible: true }),
      ...(await tellHelpdesk(c, t, 'A reply on a request for help', body)),
    ])
    return reply({ added: true as const }, 201)
  })

  r.typed('POST /help/requests/{id}/reopen', 'auth', async (c) => {
    const t = await ownRequest(c)
    const { inst, userId } = schoolUser(c)
    const reason = messageBody((await readJSON<{ reason?: string }>(c.req)).reason, 'why it is not solved')
    if (t.status !== 'resolved' && t.status !== 'closed') throw badRequest('this request is still open')
    if (!t.can_reopen) throw badRequest(`a request can be reopened within ${REOPEN_DAYS} days of being solved. Send a new one`)
    if (t.audience === 'vendor') { const named = await namedStudent(c.db, reason); if (named) throw refuseNamedStudent(named) }
    const n = now()
    const sla = await slaPolicy(c.env)
    const hours = t.audience === 'vendor' ? vendorHours(sla, (await entitlementFor(c)).planCode, t.priority) : sla.resolve_hours
    await c.db.batch([
      c.db.prepare(`UPDATE support_tickets SET status = 'open', resolved_at = NULL, resolved_by = NULL, solved_by = NULL, satisfaction = NULL, satisfaction_note = NULL,
          satisfaction_at = NULL, reopened_count = reopened_count + 1, resolve_due_at = ?, last_reply_at = ?, last_reply_side = 'raiser', updated_at = ? WHERE id = ?`)
        .bind(dueAt(n, hours), n, n, t.id),
      updateStmt(c.db, inst, t.id, { kind: 'reopened', body: reason, side: 'raiser', authorId: userId, authorName: c.id.fullName, visible: true, newStatus: 'open' }),
      ...(await tellHelpdesk(c, t, 'A request for help was reopened', reason)),
    ])
    return { status: 'open' }
  })

  r.typed('POST /help/requests/{id}/rating', 'auth', async (c) => {
    const t = await ownRequest(c)
    const req = await readJSON<{ helpful?: boolean; note?: string }>(c.req)
    if (typeof req.helpful !== 'boolean') throw badRequest('say whether the answer helped')
    if (!t.resolved_at) throw badRequest('this request has not been answered yet')
    if (t.satisfaction !== null && t.satisfaction !== undefined) throw badRequest('you have already said whether this helped')
    const n = now()
    // A thumbs up closes it; a thumbs down leaves it solved-but-unhappy, with Reopen beside it.
    const status = req.helpful ? 'closed' : t.status
    await c.db.prepare(`UPDATE support_tickets SET satisfaction = ?, satisfaction_note = NULLIF(?, ''), satisfaction_at = ?, status = ?, updated_at = ? WHERE id = ?`)
      .bind(req.helpful ? 5 : 1, String(req.note ?? '').trim().slice(0, 1000), n, status, n, t.id).run()
    return { recorded: true as const, status }
  })

  /* "ME TOO". Somebody else in the school has already reported this screen or
     topic. Nobody is shown another person's words (a parent's request can name
     their child): only that a report exists and where it stands. Adding
     yourself raises its count for the helpdesk and tells you when it is solved. */
  r.typed('GET /help/similar', 'auth', async (c) => {
    const { userId } = schoolUser(c)
    const category = (c.url.searchParams.get('category') ?? '').trim()
    const route = (c.url.searchParams.get('route') ?? '').trim()
    if (category === '' && route === '') return { count: 0 }
    const rows = await c.db.prepare(`SELECT t.id, ${ticketStage('t')} AS stage, t.me_too,
          EXISTS (SELECT 1 FROM support_ticket_followers f WHERE f.ticket_id = t.id AND f.user_id = ?1) AS following
        FROM support_tickets t
        WHERE t.origin = '${HELP}' AND t.raised_by <> ?1 AND t.status NOT IN ('resolved', 'closed') AND t.parent_ticket_id IS NULL
          AND t.created_at >= ?2 AND ((?3 <> '' AND t.route = ?3) OR (?3 = '' AND t.category = ?4))
        ORDER BY t.created_at DESC LIMIT 20`)
      .bind(userId, new Date(Date.now() - 14 * 86_400_000).toISOString(), route, category)
      .all<{ id: string; stage: string; me_too: number; following: number }>()
    const first = rows.results[0]
    if (!first) return { count: 0 }
    return { count: rows.results.length, ticket_id: first.id, stage: first.stage, me_too: Number(first.me_too ?? 0), already_following: !!first.following }
  })

  r.typed('POST /help/requests/{id}/me-too', 'auth', async (c) => {
    const { inst, userId } = schoolUser(c)
    const id = uuidParam(c.params.id)
    const t = await c.db.prepare(`SELECT id, raised_by, me_too FROM support_tickets WHERE id = ? AND origin = '${HELP}' AND status NOT IN ('resolved', 'closed')`)
      .bind(id).first<{ id: string; raised_by: string; me_too: number }>()
    if (!t) throw notFound()
    if (t.raised_by === userId) throw badRequest('this is your own request')
    const ins = await c.db.prepare(`INSERT OR IGNORE INTO support_ticket_followers (ticket_id, user_id, institution_id, created_at) VALUES (?, ?, ?, ?)`)
      .bind(id, userId, inst, now()).run()
    const added = (ins.meta.changes ?? 0) > 0
    if (added) await c.db.prepare(`UPDATE support_tickets SET me_too = me_too + 1, updated_at = ? WHERE id = ?`).bind(now(), id).run()
    return { added, me_too: Number(t.me_too ?? 0) + (added ? 1 : 0) }
  })
}
