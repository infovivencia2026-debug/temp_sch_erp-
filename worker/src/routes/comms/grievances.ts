import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, created, forbidden, isUUID, notFound, now, ok, readJSON, uuid, bool } from '../../http'
import { institutionId, requirePerm } from '../teaching/common'
import { firstLast, hoursBetween, isoZ, omitNull, optBool, optInt, trim } from './common'

/* Port of the grievance hub in comms.go: the office's queue of family
   complaints (support_tickets with audience = 'school'), its timeline
   (grievance_updates) and the per-category SLA policy.

   The one rule every query keeps: a grievance about a member of staff is not
   shown to that member of staff. callerEmployeeID resolves the caller's
   employee row and every statement below carries the exclusion predicate.

   support_tickets_touch (BEFORE UPDATE -> updated_at) is re-implemented by
   setting updated_at on every UPDATE of support_tickets. */

const READ = 'office.front_desk.read'
const WRITE = 'office.front_desk.write'

export const CONCERN_CATEGORIES = new Set(['academic', 'fees', 'transport', 'hostel', 'discipline', 'safety', 'staff', 'facilities', 'other'])
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent'])
const OPEN_STATUSES = new Set(['open', 'in_progress', 'waiting'])
const SELF_ROUTE = 'this grievance is about that member of staff. It cannot be assigned to them'

/** callerEmployeeID: the employee row behind the caller, or null (a parent, a platform operator). */
async function callerEmployeeID(c: Ctx): Promise<string | null> {
  const r = await c.db.prepare(`SELECT id FROM employees WHERE user_id = ?`).bind(c.id.userId).first<{ id: string }>()
  return r?.id ?? null
}

/** The exclusion: `(me IS NULL OR subject IS NULL OR subject <> me)`, two binds. */
const notAboutMe = (col: string) => `(? IS NULL OR ${col} IS NULL OR ${col} <> ?)`

function ticketParam(c: Ctx): string {
  const v = c.params.id
  if (!isUUID(v)) throw badRequest('id must be a uuid')
  return v
}

/** The ticket, under the exclusion, or a 404. */
async function lockTicket(c: Ctx, ticket: string, me: string | null): Promise<{ category: string; subject_employee_id: string | null }> {
  const row = await c.db.prepare(`SELECT category, subject_employee_id FROM support_tickets
      WHERE id = ? AND audience = 'school' AND ${notAboutMe('subject_employee_id')}`)
    .bind(ticket, me, me).first<{ category: string; subject_employee_id: string | null }>()
  if (!row) throw notFound()
  return row
}

/** insertFeedbackUpdate: one timeline entry, as a statement for the caller's batch. */
export function feedbackUpdateStmt(c: Ctx, ticket: string, kind: string, body: string, newStatus: string | null,
  visible: boolean, author: string): D1PreparedStatement {
  return c.db.prepare(`INSERT INTO grievance_updates (id, institution_id, ticket_id, kind, body, new_status, visible_to_parent, author_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(uuid(), institutionId(c), ticket, kind, body, newStatus, visible ? 1 : 0, author || null, now())
}

const rowColumns = `
  t.id, NULLIF(${firstLast('st')}, '') AS student, COALESCE(ru.full_name, 'Unknown') AS raised_by,
  t.category, t.subject, t.priority, t.status, t.owner_department AS department, au.full_name AS assigned_to,
  t.subject_employee_id IS NOT NULL AS names_staff,
  ${isoZ('t.created_at')} AS created_at, ${isoZ('t.respond_due_at')} AS respond_due_at,
  ${isoZ('t.resolve_due_at')} AS resolve_due_at, ${isoZ('t.acknowledged_at')} AS acknowledged_at,
  ${isoZ('t.resolved_at')} AS resolved_at, t.escalated_at IS NOT NULL AS escalated,
  CASE WHEN t.resolve_due_at IS NULL THEN NULL
       ELSE ${hoursBetween(`COALESCE(t.resolved_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, 't.resolve_due_at')} END AS overdue_hours,
  CAST(julianday(COALESCE(t.resolved_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))) - julianday(t.created_at) AS INTEGER) AS open_days,
  t.satisfaction`

const rowJoins = `
  FROM support_tickets t
  LEFT JOIN students st ON st.id = t.student_id
  LEFT JOIN users ru ON ru.id = t.raised_by
  LEFT JOIN users au ON au.id = t.assigned_to`

function feedbackRow(v: Record<string, unknown>): Record<string, unknown> {
  return omitNull({
    id: v.id, student: v.student, raised_by: v.raised_by, category: v.category, subject: v.subject,
    priority: v.priority, status: v.status, department: v.department, assigned_to: v.assigned_to,
    names_staff: bool(v.names_staff), created_at: v.created_at, respond_due_at: v.respond_due_at,
    resolve_due_at: v.resolve_due_at, acknowledged_at: v.acknowledged_at, resolved_at: v.resolved_at,
    escalated: bool(v.escalated), overdue_hours: v.overdue_hours, open_days: Number(v.open_days ?? 0),
    satisfaction: v.satisfaction,
  })
}

export function feedbackUpdateRow(v: Record<string, unknown>): Record<string, unknown> {
  return omitNull({ id: v.id, kind: v.kind, body: v.body, new_status: v.new_status,
    visible_to_parent: bool(v.visible_to_parent), author: v.author, created_at: v.created_at })
}

async function listParentFeedback(c: Ctx): Promise<Response> {
  const q = c.url.searchParams
  const status = (q.get('status') ?? '').trim()
  const category = (q.get('category') ?? '').trim()
  const overdue = q.get('overdue') === 'true' ? 1 : 0
  const me = await callerEmployeeID(c)
  const rows = await c.db.prepare(`SELECT ${rowColumns} ${rowJoins}
      WHERE t.audience = 'school'
        AND ${notAboutMe('t.subject_employee_id')}
        AND (? = '' OR t.status = ?)
        AND (? = '' OR t.category = ?)
        AND (? = 0 OR (t.resolve_due_at IS NOT NULL AND t.resolved_at IS NULL AND julianday(t.resolve_due_at) < julianday('now')))
      ORDER BY t.resolve_due_at NULLS LAST, t.created_at
      LIMIT 300`)
    .bind(me, me, status, status, category, category, overdue).all<Record<string, unknown>>()
  return ok({ items: rows.results.map(feedbackRow) })
}

async function getParentFeedback(c: Ctx): Promise<Response> {
  const ticket = ticketParam(c)
  const me = await callerEmployeeID(c)
  const v = await c.db.prepare(`SELECT ${rowColumns}, t.body, t.resolution,
        NULLIF(${firstLast('se')}, '') AS subject_staff, t.satisfaction_note
      ${rowJoins}
      LEFT JOIN employees se ON se.id = t.subject_employee_id
      WHERE t.id = ? AND t.audience = 'school' AND ${notAboutMe('t.subject_employee_id')}`)
    .bind(ticket, me, me).first<Record<string, unknown>>()
  if (!v) throw notFound()
  return ok(omitNull({ ...feedbackRow(v), body: v.body, resolution: v.resolution, subject_staff: v.subject_staff,
    satisfaction_note: v.satisfaction_note }))
}

async function listFeedbackUpdates(c: Ctx): Promise<Response> {
  const ticket = ticketParam(c)
  const me = await callerEmployeeID(c)
  const rows = await c.db.prepare(`SELECT g.id, g.kind, g.body, g.new_status, g.visible_to_parent,
        u.full_name AS author, ${isoZ('g.created_at')} AS created_at
      FROM grievance_updates g
      JOIN support_tickets t ON t.id = g.ticket_id
      LEFT JOIN users u ON u.id = g.author_id
      WHERE g.ticket_id = ? AND t.audience = 'school' AND ${notAboutMe('t.subject_employee_id')}
      ORDER BY g.created_at`).bind(ticket, me, me).all<Record<string, unknown>>()
  return ok({ items: rows.results.map(feedbackUpdateRow) })
}

async function triageParentFeedback(c: Ctx): Promise<Response> {
  const ticket = ticketParam(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const reqCategory = trim(req.category)
  if (reqCategory !== '' && !CONCERN_CATEGORIES.has(reqCategory)) throw badRequest('choose one of the listed categories')
  const priority = typeof req.priority === 'string' ? req.priority : ''
  if (priority !== '' && !PRIORITIES.has(priority)) throw badRequest('priority must be low, normal, high or urgent')
  let assignee: string | null = null
  const a = trim(req.assigned_to)
  if (a !== '') {
    if (!isUUID(a)) throw badRequest('assigned_to must be a uuid')
    assignee = a
  }
  const subjRaw = trim(req.subject_employee_id)
  const clearSubject = subjRaw === 'none'
  let subjectEmp: string | null = null
  if (subjRaw !== '' && !clearSubject) {
    if (!isUUID(subjRaw)) throw badRequest('subject_employee_id must be a uuid, or "none" to clear it')
    subjectEmp = subjRaw
  }
  const restamp = optBool(req.restamp_sla) === true

  const me = await callerEmployeeID(c)
  const cur = await lockTicket(c, ticket, me)
  const category = reqCategory !== '' ? reqCategory : cur.category
  let effective = cur.subject_employee_id
  if (clearSubject) effective = null
  else if (subjectEmp) effective = subjectEmp

  const policy = await c.db.prepare(`SELECT respond_hours, resolve_hours, owner_department, default_owner_id
      FROM grievance_sla_policies WHERE lower(category) = lower(?) AND is_active = 1`).bind(category)
    .first<{ respond_hours: number | null; resolve_hours: number | null; owner_department: string | null; default_owner_id: string | null }>()
  let department = trim(req.department)
  if (department === '' && policy?.owner_department != null) department = policy.owner_department
  if (assignee === null && policy?.default_owner_id != null) assignee = policy.default_owner_id

  if (effective && assignee) {
    const same = await c.db.prepare(`SELECT 1 AS x FROM employees WHERE id = ? AND user_id = ?`).bind(effective, assignee).first()
    if (same) throw forbidden(SELF_ROUTE)
  }
  const respondH = policy?.respond_hours ?? null
  const resolveH = policy?.resolve_hours ?? null
  const due = (col: string) => `CASE WHEN ? IS NULL THEN ${col}
      WHEN ${col} IS NULL OR ? = 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at) + ? / 24.0)
      ELSE ${col} END`
  await c.db.batch([
    c.db.prepare(`UPDATE support_tickets
        SET category = ?, priority = COALESCE(NULLIF(?, ''), priority), owner_department = NULLIF(?, ''),
            assigned_to = COALESCE(?, assigned_to),
            subject_employee_id = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, subject_employee_id) END,
            respond_due_at = ${due('respond_due_at')},
            resolve_due_at = ${due('resolve_due_at')},
            updated_at = ?
        WHERE id = ? AND audience = 'school'`)
      .bind(category, priority, department, assignee, clearSubject ? 1 : 0, subjectEmp,
        respondH, restamp ? 1 : 0, respondH, resolveH, restamp ? 1 : 0, resolveH, now(), ticket),
    feedbackUpdateStmt(c, ticket, 'assignment', `Triaged as ${category}, owner ${department.trim() === '' ? 'unassigned' : department}`,
      null, false, c.id.userId),
  ])
  return ok({ triaged: true })
}

async function addFeedbackUpdate(c: Ctx): Promise<Response> {
  const ticket = ticketParam(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const body = trim(req.body)
  if (body === '') throw badRequest('an update needs something written in it')
  const newStatus = trim(req.new_status)
  if (newStatus !== '' && !OPEN_STATUSES.has(newStatus)) {
    throw badRequest('status must be open, in_progress or waiting. Use resolve to close a case')
  }
  const visible = optBool(req.visible_to_parent) === true
  const me = await callerEmployeeID(c)
  await lockTicket(c, ticket, me)
  let kind = visible ? 'reply' : 'note'
  const stmts: D1PreparedStatement[] = []
  if (newStatus !== '') {
    kind = 'status'
    stmts.push(c.db.prepare(`UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?`).bind(newStatus, now(), ticket))
  }
  if (visible) {
    stmts.push(c.db.prepare(`UPDATE support_tickets SET acknowledged_at = COALESCE(acknowledged_at, ?), updated_at = ? WHERE id = ?`)
      .bind(now(), now(), ticket))
  }
  stmts.push(feedbackUpdateStmt(c, ticket, kind, body, newStatus === '' ? null : newStatus, visible, c.id.userId))
  await c.db.batch(stmts)
  return created({ added: true })
}

async function acknowledgeParentFeedback(c: Ctx): Promise<Response> {
  const ticket = ticketParam(c)
  const me = await callerEmployeeID(c)
  await lockTicket(c, ticket, me)
  await c.db.batch([
    c.db.prepare(`UPDATE support_tickets
        SET acknowledged_at = COALESCE(acknowledged_at, ?),
            status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END, updated_at = ?
        WHERE id = ?`).bind(now(), now(), ticket),
    feedbackUpdateStmt(c, ticket, 'status', 'The school has picked this up and is looking into it.', 'in_progress', true, c.id.userId),
  ])
  return ok({ ok: true })
}

async function escalateParentFeedback(c: Ctx): Promise<Response> {
  const ticket = ticketParam(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const to = trim(req.to_user_id)
  if (!isUUID(to)) throw badRequest('to_user_id must be a uuid')
  const reason = trim(req.reason)
  if (reason === '') throw badRequest('say why this is being escalated. It is the record of the decision')
  const me = await callerEmployeeID(c)
  const cur = await lockTicket(c, ticket, me)
  if (cur.subject_employee_id) {
    const same = await c.db.prepare(`SELECT 1 AS x FROM employees WHERE id = ? AND user_id = ?`).bind(cur.subject_employee_id, to).first()
    if (same) throw forbidden(SELF_ROUTE)
  }
  await c.db.batch([
    c.db.prepare(`UPDATE support_tickets SET escalated_at = ?, escalated_to = ?, priority = 'high', updated_at = ? WHERE id = ?`)
      .bind(now(), to, now(), ticket),
    feedbackUpdateStmt(c, ticket, 'escalation', reason, null, false, c.id.userId),
  ])
  return ok({ escalated: true })
}

async function resolveParentFeedback(c: Ctx): Promise<Response> {
  const ticket = ticketParam(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const resolution = trim(req.resolution)
  if (resolution === '') throw badRequest('a resolution needs to say what was done')
  const status = req.status === 'closed' ? 'closed' : 'resolved'
  const me = await callerEmployeeID(c)
  await lockTicket(c, ticket, me)
  const t = now()
  await c.db.batch([
    c.db.prepare(`UPDATE support_tickets
        SET status = ?, resolution = ?, resolved_at = ?, resolved_by = ?,
            acknowledged_at = COALESCE(acknowledged_at, ?), updated_at = ?
        WHERE id = ?`).bind(status, resolution, t, c.id.userId || null, t, t, ticket),
    feedbackUpdateStmt(c, ticket, 'resolution', resolution, status, true, c.id.userId),
  ])
  return ok({ status })
}

/* getFeedbackSummary. percentile_cont and mode() have no SQLite form, so the
   year's tickets are read once and the three numbers are computed here. */
async function getFeedbackSummary(c: Ctx): Promise<Response> {
  const me = await callerEmployeeID(c)
  const rows = await c.db.prepare(`SELECT t.category, t.owner_department, t.satisfaction,
        t.resolved_at IS NULL AS open,
        (t.resolve_due_at IS NOT NULL AND julianday(COALESCE(t.resolved_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))) > julianday(t.resolve_due_at)) AS breached,
        CASE WHEN t.resolved_at IS NOT NULL THEN julianday(t.resolved_at) - julianday(t.created_at) END AS resolve_days,
        CASE WHEN t.acknowledged_at IS NOT NULL THEN (julianday(t.acknowledged_at) - julianday(t.created_at)) * 24 END AS first_hours
      FROM support_tickets t
      WHERE t.audience = 'school' AND ${notAboutMe('t.subject_employee_id')}
        AND julianday(t.created_at) >= julianday('now') - 365`)
    .bind(me, me).all<{ category: string; owner_department: string | null; satisfaction: number | null; open: number; breached: number;
      resolve_days: number | null; first_hours: number | null }>()
  interface Acc { total: number; open: number; breached: number; days: number[]; hours: number[]; depts: string[]; sat: number[] }
  const by = new Map<string, Acc>()
  for (const r of rows.results) {
    let a = by.get(r.category)
    if (!a) { a = { total: 0, open: 0, breached: 0, days: [], hours: [], depts: [], sat: [] }; by.set(r.category, a) }
    a.total++
    if (r.open) a.open++
    if (r.breached) a.breached++
    if (r.resolve_days !== null) a.days.push(r.resolve_days)
    if (r.first_hours !== null) a.hours.push(r.first_hours)
    if (r.owner_department !== null) a.depts.push(r.owner_department)
    if (r.satisfaction !== null) a.sat.push(Number(r.satisfaction))
  }
  const median = (xs: number[]): number | null => {
    if (!xs.length) return null
    const s = [...xs].sort((x, y) => x - y)
    const pos = (s.length - 1) * 0.5, lo = Math.floor(pos), hi = Math.ceil(pos)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)
  }
  const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((p, x) => p + x, 0) / xs.length : null)
  const mode = (xs: string[]): string | null => {
    if (!xs.length) return null
    const n = new Map<string, number>()
    for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1)
    let best: string | null = null, bn = 0
    for (const k of [...n.keys()].sort()) if (n.get(k)! > bn) { best = k; bn = n.get(k)! }
    return best
  }
  const out = [...by.entries()].map(([category, a]) => omitNull({
    category, total: a.total, open: a.open, breached: a.breached, median_days: median(a.days),
    avg_first_response_hours: mean(a.hours), department: mode(a.depts), avg_satisfaction: mean(a.sat),
  })).sort((x, y) => (y.total as number) - (x.total as number))
  return ok({ items: out })
}

async function listFeedbackSLA(c: Ctx): Promise<Response> {
  const rows = await c.db.prepare(`SELECT p.category, p.owner_department AS department, u.full_name AS default_owner,
        p.respond_hours, p.resolve_hours, p.is_sensitive, p.is_active
      FROM grievance_sla_policies p LEFT JOIN users u ON u.id = p.default_owner_id
      ORDER BY p.category`).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({ category: v.category, department: v.department, default_owner: v.default_owner,
    respond_hours: Number(v.respond_hours), resolve_hours: Number(v.resolve_hours), is_sensitive: bool(v.is_sensitive), is_active: bool(v.is_active) })) })
}

async function saveFeedbackSLA(c: Ctx): Promise<Response> {
  const req = await readJSON<Record<string, unknown>>(c.req)
  const category = trim(req.category)
  if (!CONCERN_CATEGORIES.has(category)) throw badRequest('choose one of the listed categories')
  let respond = optInt(req.respond_hours) ?? 0
  let resolve = optInt(req.resolve_hours) ?? 0
  if (respond <= 0) respond = 24
  if (resolve <= 0) resolve = 168
  if (resolve < respond) throw badRequest('the resolution deadline cannot be sooner than the first-response one')
  let owner: string | null = null
  const o = trim(req.default_owner_id)
  if (o !== '') {
    if (!isUUID(o)) throw badRequest('default_owner_id must be a uuid')
    owner = o
  }
  const active = optBool(req.is_active) ?? true
  const sensitive = optBool(req.is_sensitive) === true
  const dept = trim(req.department)
  const t = now()
  try {
    const existing = await c.db.prepare(`SELECT id FROM grievance_sla_policies WHERE lower(category) = lower(?)`).bind(category).first<{ id: string }>()
    if (existing) {
      await c.db.prepare(`UPDATE grievance_sla_policies
          SET owner_department = NULLIF(?, ''), default_owner_id = ?, respond_hours = ?, resolve_hours = ?,
              is_sensitive = ?, is_active = ?, updated_at = ? WHERE id = ?`)
        .bind(dept, owner, respond, resolve, sensitive ? 1 : 0, active ? 1 : 0, t, existing.id).run()
    } else {
      await c.db.prepare(`INSERT INTO grievance_sla_policies (id, institution_id, category, owner_department, default_owner_id,
            respond_hours, resolve_hours, is_sensitive, is_active, created_at, updated_at)
          VALUES (?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), institutionId(c), category, dept, owner, respond, resolve, sensitive ? 1 : 0, active ? 1 : 0, t, t).run()
    }
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw badRequest(e instanceof Error ? e.message : String(e))
  }
  return ok({ saved: true })
}

export function registerGrievances(r: Router): void {
  const write = (h: (c: Ctx) => Promise<Response>) => async (c: Ctx) => { requirePerm(c, READ); return h(c) }
  r.get('/comms/grievances', READ, listParentFeedback)
  r.get('/comms/grievances/summary', READ, getFeedbackSummary)
  r.get('/comms/grievances/{id}', READ, getParentFeedback)
  r.get('/comms/grievances/{id}/updates', READ, listFeedbackUpdates)
  r.put('/comms/grievances/{id}/triage', WRITE, write(triageParentFeedback))
  r.post('/comms/grievances/{id}/updates', WRITE, write(addFeedbackUpdate))
  r.post('/comms/grievances/{id}/acknowledge', WRITE, write(acknowledgeParentFeedback))
  r.post('/comms/grievances/{id}/escalate', WRITE, write(escalateParentFeedback))
  r.post('/comms/grievances/{id}/resolve', WRITE, write(resolveParentFeedback))

  r.get('/comms/grievance-sla', READ, listFeedbackSLA)
  r.put('/comms/grievance-sla', WRITE, write(saveFeedbackSLA))
}
