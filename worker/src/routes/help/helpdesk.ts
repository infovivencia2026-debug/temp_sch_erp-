/* Helpdesk (help.helpdesk): the school's own first line. Requests for help
   from this school's families and staff are answered here, or passed to the
   vendor with a summary the administrator has confirmed names no child.

   Catalogue key institution_admin.help.helpdesk. Read help.desk.read, write
   help.desk.write. Scaffolded by `npm run feature:new`; the routes are typed
   against shared/api/feature_helpdesk.ts.

   WHAT THE VENDOR IS GIVEN ON AN ESCALATION: the administrator's summary, the
   category, the screen, the role, the error reference and the device details.
   NOT the family's words, the screenshot, the assistant conversation, the
   raiser's name or any student. The original stays here and its raiser is told
   only that it was passed on. */
import type { Ctx, Router } from '../../router'
import { reply } from '../../router'
import { HttpError, badRequest, bool, conflict, like, notFound, now, readJSON, uuid, uuidParam } from '../../http'
import { isoZ } from '../comms/common'
import { dueAt, resolveBreached, respondBreached, ticketStage } from '../comms/concern_shared'
import { entitlementFor } from '../misc/shell'
import { getObject, serveObject, dispositionHeaders } from '../../services/files'
import { slaPolicy, vendorHours } from './content'
import { openIncidents } from './incidents_match'
import {
  DESK_READ, DESK_WRITE, HELP, TICKET_COLS, bell, deskLink, messageBody, namedStudent, parseDiagnostics, refuseNamedStudent, requestLink,
  subjectFrom, thread, ticketSummary, updateStmt, vendorSafeDiagnostics, type TicketRow,
} from './shared'
import { schoolUser } from './requests'
import type { DeskCounts, DeskTicket, EscalateInput } from '@shared/api/feature_helpdesk'

type DeskRow = TicketRow & { raised_by_name: string | null; raised_by: string; assigned_to: string | null; assigned_name: string | null
  respond_breached: number; resolve_breached: number; esc_id: string | null; esc_stage: string | null; esc_status: string | null }

const DESK_COLS = `${TICKET_COLS}, t.raised_by, ru.full_name AS raised_by_name, t.assigned_to, au.full_name AS assigned_name,
  ${respondBreached('t')} AS respond_breached, ${resolveBreached('t')} AS resolve_breached,
  e.id AS esc_id, e.status AS esc_status, CASE WHEN e.id IS NULL THEN NULL ELSE ${ticketStage('e')} END AS esc_stage`
/* The newest escalation of a request (there is at most one open at a time). */
const DESK_FROM = `FROM support_tickets t
  LEFT JOIN users ru ON ru.id = t.raised_by
  LEFT JOIN users au ON au.id = t.assigned_to
  LEFT JOIN support_tickets e ON e.id = (SELECT x.id FROM support_tickets x WHERE x.parent_ticket_id = t.id ORDER BY x.created_at DESC LIMIT 1)`

const OPEN = `t.status NOT IN ('resolved', 'closed')`

function deskTicket(t: DeskRow): DeskTicket {
  return {
    ...ticketSummary(t), raised_by: t.raised_by_name ?? 'Unknown',
    assigned_to: t.assigned_name ?? undefined, assigned_to_id: t.assigned_to ?? undefined,
    escalation: t.esc_id ? { id: t.esc_id, stage: String(t.esc_stage), status: String(t.esc_status) } : undefined,
    respond_breached: bool(t.respond_breached), resolve_breached: bool(t.resolve_breached),
  }
}

async function deskRow(c: Ctx, extra = ''): Promise<DeskRow & { body: string; resolution: string | null; diagnostics: string | null; attachment_file_id: string | null; attachment_name: string | null; object_key: string | null; content_type: string | null }> {
  schoolUser(c)
  const id = uuidParam(c.params.id)
  const t = await c.db.prepare(`SELECT ${DESK_COLS}, t.body, t.resolution, t.diagnostics, t.attachment_file_id, f.original_name AS attachment_name,
        f.object_key, f.content_type
      ${DESK_FROM} LEFT JOIN files f ON f.id = t.attachment_file_id AND f.deleted_at IS NULL
      WHERE t.id = ? AND t.origin = '${HELP}' AND t.audience IN ('helpdesk', 'vendor') ${extra}`).bind(id)
    .first<DeskRow & { body: string; resolution: string | null; diagnostics: string | null; attachment_file_id: string | null; attachment_name: string | null; object_key: string | null; content_type: string | null }>()
  if (!t) throw notFound()
  return t
}

const BOXES: Record<string, string> = {
  open: `t.audience = 'helpdesk' AND ${OPEN}`,
  mine: `t.audience = 'helpdesk' AND ${OPEN} AND t.assigned_to = ?1`,
  unassigned: `t.audience = 'helpdesk' AND ${OPEN} AND t.assigned_to IS NULL`,
  waiting: `t.audience = 'helpdesk' AND t.status = 'waiting'`,
  overdue: `t.audience = 'helpdesk' AND ${OPEN} AND ${resolveBreached('t')}`,
  vendor: `t.audience = 'vendor'`,
  solved: `t.audience = 'helpdesk' AND NOT ${OPEN}`,
}

export function registerHelpdesk(r: Router): void {
  r.typed('GET /help/desk', DESK_READ, async (c) => {
    const { userId } = schoolUser(c)
    const box = c.url.searchParams.get('box') ?? 'open'
    const where = BOXES[box]
    if (!where) throw badRequest('unknown list')
    const q = (c.url.searchParams.get('q') ?? '').trim()
    const [rows, n] = await Promise.all([
      c.db.prepare(`SELECT ${DESK_COLS} ${DESK_FROM}
          WHERE t.origin = '${HELP}' AND ${where}
            AND (?2 = '' OR t.subject LIKE ?3 ESCAPE '\\' OR t.body LIKE ?3 ESCAPE '\\' OR ru.full_name LIKE ?3 ESCAPE '\\' OR t.error_ref = upper(?2))
          ORDER BY ${OPEN} DESC, CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
            t.resolve_due_at IS NULL, t.resolve_due_at, t.created_at DESC LIMIT 200`).bind(userId, q, like(q)).all<DeskRow>(),
      c.db.prepare(`SELECT
            sum(${BOXES.open}) AS open, sum(${BOXES.mine}) AS mine, sum(${BOXES.unassigned}) AS unassigned, sum(${BOXES.waiting}) AS waiting,
            sum(${BOXES.overdue}) AS overdue, sum(t.audience = 'vendor' AND ${OPEN}) AS with_vendor, sum(${BOXES.solved}) AS solved
          FROM support_tickets t WHERE t.origin = '${HELP}'`).bind(userId).first<Record<keyof DeskCounts, number | null>>(),
    ])
    const counts = Object.fromEntries((['open', 'mine', 'unassigned', 'waiting', 'overdue', 'with_vendor', 'solved'] as const)
      .map((k) => [k, Number(n?.[k] ?? 0)])) as unknown as DeskCounts
    return { items: rows.results.map(deskTicket), counts }
  })

  r.typed('GET /help/desk/{id}', DESK_READ, async (c) => {
    const t = await deskRow(c)
    const mine = t.audience === 'helpdesk'
    const [tl, escTl, incidents] = await Promise.all([
      // A vendor ticket's working notes are the vendor's; the school reads what was said to it.
      thread(c.db, t.id, mine ? 'school' : 'public'),
      t.esc_id ? thread(c.db, t.esc_id, 'public') : Promise.resolve(undefined),
      t.incident_id ? openIncidents(c.env) : Promise.resolve([]),
    ])
    const inc = incidents.find((i) => i.id === t.incident_id)
    return {
      ...deskTicket(t), body: t.body, resolution: t.resolution ?? undefined,
      attachment: t.attachment_name ? { id: String(t.attachment_file_id), name: t.attachment_name } : undefined,
      diagnostics: parseDiagnostics(t.diagnostics), incident: inc ? { id: inc.id, title: inc.title, workaround: inc.workaround } : undefined,
      thread: tl, escalation_thread: escTl,
    }
  })

  /* The screenshot on a request. The file route lets the uploader and the
     office read a generic upload; the helpdesk reads it through the ticket. */
  r.get('/help/desk/{id}/attachment', DESK_READ, async (c) => {
    const t = await deskRow(c)
    if (!t.object_key) throw notFound()
    const obj = await getObject(c.env, t.object_key, c.req.headers.has('range') ? c.req.headers : undefined)
    if (!obj) throw notFound()
    return serveObject(c.req, obj, { 'content-type': t.content_type ?? 'application/octet-stream', 'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=300', ...dispositionHeaders(t.attachment_name ?? 'screenshot', t.content_type ?? '', true) })
  })

  r.typed('POST /help/desk/{id}/reply', DESK_WRITE, async (c) => {
    const t = await deskRow(c)
    const { inst, userId } = schoolUser(c)
    const req = await readJSON<{ body?: string; internal?: boolean; waiting?: boolean }>(c.req)
    const body = messageBody(req.body)
    if (t.status === 'resolved' || t.status === 'closed') throw badRequest('this request is closed. The person who raised it can reopen it')
    const n = now()
    if (t.audience === 'vendor') {
      // The school writing to the vendor: no working notes of its own there, and no child's name.
      if (req.internal) throw badRequest('a note for your own office belongs on the request it came from, not on the one sent to XULO support')
      const named = await namedStudent(c.db, body)
      if (named) throw refuseNamedStudent(named)
      await c.db.batch([
        c.db.prepare(`UPDATE support_tickets SET status = CASE WHEN status = 'waiting' THEN 'in_progress' ELSE status END,
            last_reply_at = ?, last_reply_side = 'raiser', updated_at = ? WHERE id = ?`).bind(n, n, t.id),
        updateStmt(c.db, inst, t.id, { kind: 'raiser_reply', body, side: 'raiser', authorId: userId, authorName: c.id.fullName, visible: true }),
      ])
      return reply({ added: true as const }, 201)
    }
    const internal = !!req.internal
    const stmts: D1PreparedStatement[] = [
      updateStmt(c.db, inst, t.id, { kind: internal ? 'note' : 'reply', body, side: 'school', authorId: userId, authorName: c.id.fullName, visible: !internal }),
    ]
    if (internal) {
      stmts.push(c.db.prepare(`UPDATE support_tickets SET updated_at = ? WHERE id = ?`).bind(n, t.id))
    } else {
      // A reply is the first response: it acknowledges, and the request is in hand (or waiting on its raiser, when asked).
      stmts.push(c.db.prepare(`UPDATE support_tickets SET acknowledged_at = COALESCE(acknowledged_at, ?), assigned_to = COALESCE(assigned_to, ?),
          status = ?, last_reply_at = ?, last_reply_side = 'school', updated_at = ? WHERE id = ?`)
        .bind(n, userId, req.waiting ? 'waiting' : 'in_progress', n, n, t.id))
      if (t.raised_by !== userId) stmts.push(bell(c.db, inst, t.raised_by, 'A reply to your request for help', body, requestLink(t.id), t.id))
    }
    await c.db.batch(stmts)
    return reply({ added: true as const }, 201)
  })

  r.typed('POST /help/desk/{id}/take', DESK_WRITE, async (c) => {
    const t = await deskRow(c, `AND t.audience = 'helpdesk'`)
    const { inst, userId } = schoolUser(c)
    const n = now()
    await c.db.batch([
      c.db.prepare(`UPDATE support_tickets SET assigned_to = ?, acknowledged_at = COALESCE(acknowledged_at, ?),
          status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END, updated_at = ? WHERE id = ?`).bind(userId, n, n, t.id),
      updateStmt(c.db, inst, t.id, { kind: 'assignment', body: `Taken by ${c.id.fullName}`, side: 'school', authorId: userId, authorName: c.id.fullName, visible: false }),
    ])
    return { assigned_to: c.id.fullName }
  })

  r.typed('POST /help/desk/{id}/resolve', DESK_WRITE, async (c) => {
    const t = await deskRow(c, `AND t.audience = 'helpdesk'`)
    const { inst, userId } = schoolUser(c)
    const resolution = messageBody((await readJSON<{ resolution?: string }>(c.req)).resolution, 'what solved it')
    if (t.status === 'resolved' || t.status === 'closed') throw badRequest('this request is already solved')
    const n = now()
    const followers = await c.db.prepare(`SELECT user_id FROM support_ticket_followers WHERE ticket_id = ?`).bind(t.id).all<{ user_id: string }>()
    await c.db.batch([
      // Solved by the vendor when it went there and came back; by the school otherwise (the reports' deflection rate reads this).
      c.db.prepare(`UPDATE support_tickets SET status = 'resolved', resolution = ?, resolved_at = ?, resolved_by = ?, solved_by = ?,
          acknowledged_at = COALESCE(acknowledged_at, ?), last_reply_at = ?, last_reply_side = 'school', updated_at = ? WHERE id = ?`)
        .bind(resolution, n, userId, t.esc_id ? 'vendor' : 'school', n, n, n, t.id),
      updateStmt(c.db, inst, t.id, { kind: 'resolved', body: resolution, side: 'school', authorId: userId, authorName: c.id.fullName, visible: true, newStatus: 'resolved' }),
      ...(t.raised_by !== userId ? [bell(c.db, inst, t.raised_by, 'Your request for help has an answer', resolution, requestLink(t.id), t.id)] : []),
      ...followers.results.filter((f) => f.user_id !== userId).map((f) =>
        bell(c.db, inst, f.user_id, 'A problem you reported is solved', null, '/help?tab=requests', t.id)),
    ])
    return { status: 'resolved' }
  })

  r.typed('POST /help/desk/{id}/escalate', DESK_WRITE, async (c) => {
    const t = await deskRow(c, `AND t.audience = 'helpdesk'`)
    const { inst, userId } = schoolUser(c)
    const req = await readJSON<EscalateInput>(c.req)
    const summary = messageBody(req.summary, 'a summary for XULO support')
    if (t.status === 'resolved' || t.status === 'closed') throw badRequest('this request is already solved')
    if (t.esc_id && t.esc_status !== 'resolved' && t.esc_status !== 'closed') throw conflict('this request is already with XULO support')
    if (req.confirmed !== true) throw new HttpError(400, 'confirm that the summary names no child before sending it', { code: 'confirm_no_child' })
    const subject = subjectFrom(req.subject, summary)
    const named = await namedStudent(c.db, `${subject}\n${summary}`)
    if (named) throw refuseNamedStudent(named)
    const n = now()
    const priority = req.urgent ? 'high' : t.priority
    const due = dueAt(n, vendorHours(await slaPolicy(c.env), (await entitlementFor(c)).planCode, priority))
    const full = await c.db.prepare(`SELECT diagnostics FROM support_tickets WHERE id = ?`).bind(t.id).first<{ diagnostics: string | null }>()
    const id = uuid()
    await c.db.batch([
      c.db.prepare(`INSERT INTO support_tickets (id, institution_id, raised_by, category, subject, body, priority, status, audience, origin, route, role_key,
            diagnostics, error_ref, parent_ticket_id, resolve_due_at, incident_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 'vendor', '${HELP}', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, inst, userId, t.category, subject, summary, priority, t.route, t.role_key,
          JSON.stringify(vendorSafeDiagnostics(parseDiagnostics(full?.diagnostics))), t.error_ref, t.id, due, t.incident_id, n, n),
      c.db.prepare(`UPDATE support_tickets SET escalated_at = ?, acknowledged_at = COALESCE(acknowledged_at, ?), assigned_to = COALESCE(assigned_to, ?),
          status = 'in_progress', updated_at = ? WHERE id = ?`).bind(n, n, userId, n, t.id),
      updateStmt(c.db, inst, t.id, { kind: 'escalated', side: 'school', authorId: userId, authorName: c.id.fullName, visible: true,
        body: 'Passed to the support team of the software. Your school will answer here when they reply.' }),
      updateStmt(c.db, inst, t.id, { kind: 'note', side: 'school', authorId: userId, authorName: c.id.fullName, visible: false,
        body: `Sent to XULO support:\n${summary}` }),
      ...(t.raised_by !== userId ? [bell(c.db, inst, t.raised_by, 'Your request was passed to the support team', null, requestLink(t.id), t.id)] : []),
    ])
    return reply({ id }, 201)
  })
}

/** Used by the vendor's desk when it answers an escalation: the administrator who sent it is told. */
export const escalationLink = deskLink
