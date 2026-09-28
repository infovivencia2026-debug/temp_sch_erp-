import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, bool, created, forbidden, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { can } from '../../identity'
import { fullName, istMinuteT, nextNumber, str } from '../admissions/util'
import { grievanceFilter, growthReach } from './reach'
import { school } from '../school'
import { isoZ, omitNull, optBool, optInt, trim } from '../comms/common'
import {
  REOPEN_DAYS, STAGE_LABEL, canReopen, dueAt, notify, ownAttachment, policyFor, raiserLink,
  resolveBreached, respondBreached, stageCounts, staffStage,
} from '../comms/concern_shared'

/* Staff concerns: the grievance cell (staff_grievances).

   Two sides. /me/concerns is the member of staff's own: raise one, follow it,
   write back, reopen it within the window, rate the answer. /hr/grievances is
   the cell's pipeline, for HR and the principal (hr.employees.write), plus
   whoever a case has been assigned to.

   Anonymity is real. An anonymous concern stores neither the employee nor the
   account: employee_id and raised_by are NULL, and the raiser follows it
   through raiser_hash, an HMAC of their account id under the server's session
   key, which nobody reading the table can reverse. Nothing the raiser writes
   afterwards carries their account either (author_id NULL, from_raiser 1), an
   attached file loses its uploader, and no notification is ever addressed to
   them (a notifications row would name them). They see progress on their own
   list instead. No response of this module returns raised_by or raiser_hash. */

const READ = 'hr.employees.read', WRITE = 'hr.employees.write', SELF = 'self.profile.read'
export const STAFF_CATEGORIES = new Set(['harassment', 'pay', 'workload', 'facilities', 'discrimination', 'safety', 'management', 'other'])
const SEVERITIES = new Set(['low', 'medium', 'high'])
/** When the cell has set no promise for a category: by severity, respond / resolve hours. */
const DEFAULT_SLA: Record<string, [number, number]> = { high: [24, 72], medium: [48, 168], low: [72, 336] }
const SETTLED = `g.status IN ('resolved', 'closed', 'withdrawn')`
const HR_LINK = (id: string) => `/hr/welfare/staff_welfare?tab=grievances&id=${id}`

async function raiserHash(c: Ctx): Promise<string> {
  const secret = c.env.SESSION_SECRET || 'school-erp-concerns'
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`staff-concern:${school(c).id}:${c.id.userId}`))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function staffPolicy(c: Ctx, category: string, severity: string): Promise<{ respond: number; resolve: number; owner: string | null }> {
  const p = await policyFor(c, `staff:${category}`)
  if (p) return { respond: p.respond_hours, resolve: p.resolve_hours, owner: p.default_owner_id }
  const [respond, resolve] = DEFAULT_SLA[severity] ?? DEFAULT_SLA.medium
  return { respond, resolve, owner: null }
}

function updateStmt(c: Ctx, gid: string, kind: string, body: string, newStatus: string | null, visible: boolean,
  author: string | null, fromRaiser = false): D1PreparedStatement {
  return c.db.prepare(`INSERT INTO staff_grievance_updates (id, institution_id, grievance_id, kind, body, new_status, visible_to_raiser, author_id, from_raiser, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(uuid(), school(c).id, gid, kind, body, newStatus, visible ? 1 : 0, author, fromRaiser ? 1 : 0, now())
}

async function newReference(c: Ctx): Promise<string> {
  const inst = school(c).id
  const scheme = await c.db.prepare(`SELECT 1 FROM numbering_schemes WHERE institution_id = ? AND kind = 'grievance' AND campus_id IS NULL`).bind(inst).first()
  if (!scheme) await c.db.prepare(`INSERT INTO numbering_schemes (id, institution_id, kind, prefix, padding, next_value, reset_yearly, updated_at) VALUES (?,?,'grievance','GRV/',4,1,1,?)`).bind(uuid(), inst, now()).run()
  return nextNumber(c.db, inst, 'grievance')
}

function readCategory(req: Record<string, unknown>): { category: string; severity: string } {
  let category = str(req.category), severity = str(req.severity)
  if (category === '') category = 'other'
  if (severity === '') severity = 'medium'
  if (!STAFF_CATEGORIES.has(category)) throw badRequest('choose one of the listed categories')
  if (!SEVERITIES.has(severity)) throw badRequest('severity must be low, medium or high')
  return { category, severity }
}

/* ---------------------------------------------------------------- the raiser */

async function myEmployee(c: Ctx): Promise<{ id: string; name: string }> {
  const e = await c.db.prepare(`SELECT id, ${fullName('first_name', 'last_name')} AS name FROM employees WHERE user_id = ? LIMIT 1`)
    .bind(c.id.userId).first<{ id: string; name: string }>()
  if (!e) throw forbidden('staff concerns are for members of staff. Families raise a concern from the portal')
  return e
}

const mine = `(g.raiser_hash = ? OR (g.is_anonymous = 0 AND g.raised_by = ?))`

const selfColumns = `g.id, g.reference_no, g.is_anonymous, g.category, g.severity, g.subject, g.description, g.status,
  ${staffStage('g')} AS stage, g.resolution, g.satisfaction, g.satisfaction_note, g.reopened_count,
  ${isoZ('g.created_at')} AS created_at, ${isoZ('g.acknowledged_at')} AS acknowledged_at,
  ${isoZ('g.resolved_at')} AS resolved_at, ${isoZ('g.resolve_due_at')} AS resolve_due_at,
  ${canReopen('g', SETTLED)} AS can_reopen,
  (SELECT count(*) FROM staff_grievance_updates u WHERE u.grievance_id = g.id AND u.visible_to_raiser = 1 AND u.from_raiser = 0) AS replies,
  (SELECT ${isoZ('max(u.created_at)')} FROM staff_grievance_updates u WHERE u.grievance_id = g.id AND u.visible_to_raiser = 1) AS last_update_at`

function selfRow(v: Record<string, unknown>) {
  return omitNull({ id: v.id, reference_no: v.reference_no, is_anonymous: bool(v.is_anonymous), category: v.category, severity: v.severity,
    subject: v.subject, description: v.description, status: v.status, stage: v.stage, resolution: v.resolution,
    satisfaction: v.satisfaction, satisfaction_note: v.satisfaction_note, reopened_count: Number(v.reopened_count ?? 0),
    created_at: v.created_at, acknowledged_at: v.acknowledged_at, resolved_at: v.resolved_at, resolve_due_at: v.resolve_due_at,
    can_reopen: bool(v.can_reopen), replies: Number(v.replies ?? 0), last_update_at: v.last_update_at })
}

async function listMine(c: Ctx): Promise<Response> {
  await myEmployee(c)
  const h = await raiserHash(c)
  const rows = await c.db.prepare(`SELECT ${selfColumns} FROM staff_grievances g WHERE ${mine}
      ORDER BY ${SETTLED}, g.created_at DESC LIMIT 100`).bind(h, c.id.userId).all<Record<string, unknown>>()
  return ok({ items: rows.results.map(selfRow) })
}

async function raiseMine(c: Ctx): Promise<Response> {
  const emp = await myEmployee(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const subject = trim(req.subject), description = trim(req.description)
  if (subject === '' || description === '') throw badRequest('a concern needs a subject and what happened')
  const { category, severity } = readCategory(req)
  const anonymous = req.is_anonymous === true
  const attachment = await ownAttachment(c, req.attachment_file_id)
  const [ref, h, sla] = await Promise.all([newReference(c), raiserHash(c), staffPolicy(c, category, severity)])
  const id = uuid(), t = now()
  const stmts = [
    c.db.prepare(`INSERT INTO staff_grievances (id, institution_id, reference_no, employee_id, raised_by, is_anonymous, raiser_hash,
          category, severity, subject, description, attachment_file_id, assigned_to, respond_due_at, resolve_due_at, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, school(c).id, ref, anonymous ? null : emp.id, anonymous ? null : c.id.userId, anonymous ? 1 : 0, h,
        category, severity, subject, description, attachment, sla.owner, dueAt(t, sla.respond), dueAt(t, sla.resolve), t, t),
    updateStmt(c, id, 'created', anonymous ? 'Concern raised anonymously.' : 'Concern raised.', 'open', true, anonymous ? null : c.id.userId, true),
  ]
  // The file would otherwise name its uploader.
  if (anonymous && attachment) stmts.push(c.db.prepare(`UPDATE files SET uploaded_by = NULL WHERE id = ?`).bind(attachment))
  if (sla.owner && sla.owner !== c.id.userId) stmts.push(notify(c, sla.owner, 'A staff concern has been raised', `${ref}: ${subject}`, HR_LINK(id), 'staff_grievance', id))
  await c.db.batch(stmts)
  return created({ id, reference_no: ref, resolve_due_at: dueAt(t, sla.resolve) })
}

async function ownGrievance(c: Ctx): Promise<Record<string, unknown>> {
  const gid = c.params.id
  if (!isUUID(gid)) throw badRequest('id must be a uuid')
  const h = await raiserHash(c)
  const v = await c.db.prepare(`SELECT ${selfColumns}, g.assigned_to AS owner_id, g.escalated_to AS escalated_id,
        g.attachment_file_id, f.original_name AS attachment_name
      FROM staff_grievances g LEFT JOIN files f ON f.id = g.attachment_file_id AND f.deleted_at IS NULL
      WHERE g.id = ? AND ${mine}`).bind(gid, h, c.id.userId).first<Record<string, unknown>>()
  if (!v) throw notFound()
  return v
}

async function getMine(c: Ctx): Promise<Response> {
  const v = await ownGrievance(c)
  const tl = await c.db.prepare(`SELECT u.id, u.kind, u.body, u.new_status, u.from_raiser,
        CASE WHEN u.from_raiser = 1 THEN 'You' ELSE a.full_name END AS author, ${isoZ('u.created_at')} AS created_at
      FROM staff_grievance_updates u LEFT JOIN users a ON a.id = u.author_id
      WHERE u.grievance_id = ? AND u.visible_to_raiser = 1 ORDER BY u.created_at`).bind(v.id).all<Record<string, unknown>>()
  return ok({ ...selfRow(v),
    ...(v.attachment_name != null ? { attachment: { id: v.attachment_file_id, name: v.attachment_name } } : {}),
    timeline: tl.results.map((u) => omitNull({ id: u.id, kind: u.kind, body: u.body, new_status: u.new_status, author: u.author,
      mine: bool(u.from_raiser), created_at: u.created_at })) })
}

function tellCell(c: Ctx, v: Record<string, unknown>, title: string, body: string): D1PreparedStatement[] {
  const to = new Set([v.owner_id, v.escalated_id].filter((x): x is string => typeof x === 'string' && x !== c.id.userId))
  return [...to].map((u) => notify(c, u, title, body, HR_LINK(String(v.id)), 'staff_grievance', String(v.id)))
}

async function replyMine(c: Ctx): Promise<Response> {
  const v = await ownGrievance(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const body = trim(req.body)
  if (body === '') throw badRequest('write something to send')
  if (body.length > 4000) throw badRequest('keep a reply under 4000 characters')
  if (['resolved', 'closed', 'withdrawn'].includes(String(v.status))) throw badRequest('this concern is closed. Reopen it to write again')
  const anon = bool(v.is_anonymous)
  await c.db.batch([
    updateStmt(c, String(v.id), 'raiser_reply', body, null, true, anon ? null : c.id.userId, true),
    c.db.prepare(`UPDATE staff_grievances SET updated_at = ? WHERE id = ?`).bind(now(), v.id),
    ...tellCell(c, v, `Reply on ${v.reference_no}`, body),
  ])
  return created({ added: true })
}

async function reopenMine(c: Ctx): Promise<Response> {
  const v = await ownGrievance(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const reason = trim(req.reason)
  if (reason === '') throw badRequest('say why it is not settled')
  if (!bool(v.can_reopen)) throw badRequest(`a concern can be reopened within ${REOPEN_DAYS} days of being resolved`)
  const sla = await staffPolicy(c, String(v.category), String(v.severity))
  const t = now()
  const anon = bool(v.is_anonymous)
  await c.db.batch([
    c.db.prepare(`UPDATE staff_grievances SET status = 'open', resolved_at = NULL, satisfaction = NULL, satisfaction_note = NULL,
        reopened_count = reopened_count + 1, resolve_due_at = ?, escalated_at = NULL, updated_at = ? WHERE id = ?`)
      .bind(dueAt(t, sla.resolve), t, v.id),
    updateStmt(c, String(v.id), 'reopened', reason, 'open', true, anon ? null : c.id.userId, true),
    ...tellCell(c, v, `${v.reference_no} was reopened`, reason),
  ])
  return ok({ status: 'open' })
}

async function rateMine(c: Ctx): Promise<Response> {
  const v = await ownGrievance(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const rating = optInt(req.rating) ?? 0
  if (rating < 1 || rating > 5) throw badRequest('rating must be between 1 and 5')
  if (v.resolved_at == null || v.satisfaction != null) throw notFound()
  await c.db.prepare(`UPDATE staff_grievances SET satisfaction = ?, satisfaction_note = NULLIF(?, ''), updated_at = ? WHERE id = ?`)
    .bind(rating, trim(req.note), now(), v.id).run()
  return ok({ recorded: true })
}

/* ---------------------------------------------------------------- the cell */

const cellColumns = `g.id, g.reference_no, g.is_anonymous,
  CASE WHEN g.is_anonymous = 1 THEN NULL ELSE ${fullName('e.first_name', 'e.last_name')} END AS full_name,
  g.category, g.severity, g.subject, g.description, g.status, ${staffStage('g')} AS stage,
  u.full_name AS assigned_to, g.assigned_to AS assigned_to_id, x.full_name AS escalated_to, g.escalated_at IS NOT NULL AS escalated,
  g.resolution, g.satisfaction, g.reopened_count, g.attachment_file_id IS NOT NULL AS has_attachment,
  ${istMinuteT('g.created_at')} AS raised_at, ${istMinuteT('g.resolved_at')} AS resolved_at,
  ${isoZ('g.created_at')} AS created_at, ${isoZ('g.acknowledged_at')} AS acknowledged_at,
  ${isoZ('g.respond_due_at')} AS respond_due_at, ${isoZ('g.resolve_due_at')} AS resolve_due_at,
  ${respondBreached('g')} AS respond_breached, ${resolveBreached('g')} AS resolve_breached,
  CAST(julianday(COALESCE(g.resolved_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))) - julianday(g.created_at) AS INTEGER) AS open_days,
  (SELECT count(*) FROM staff_grievance_updates r WHERE r.grievance_id = g.id AND r.from_raiser = 1 AND r.kind = 'raiser_reply'
     AND julianday(r.created_at) > julianday(COALESCE((SELECT max(r2.created_at) FROM staff_grievance_updates r2
       WHERE r2.grievance_id = g.id AND r2.from_raiser = 0), g.created_at))) AS unanswered`
const cellJoins = `FROM staff_grievances g LEFT JOIN employees e ON e.id = g.employee_id
  LEFT JOIN users u ON u.id = g.assigned_to LEFT JOIN users x ON x.id = g.escalated_to`

function cellRow(v: Record<string, unknown>) {
  return omitNull({ id: v.id, reference_no: v.reference_no, is_anonymous: bool(v.is_anonymous), full_name: v.full_name,
    category: v.category, severity: v.severity, subject: v.subject, description: v.description, status: v.status, stage: v.stage,
    assigned_to: v.assigned_to, assigned_to_id: v.assigned_to_id, escalated_to: v.escalated_to, escalated: bool(v.escalated),
    resolution: v.resolution, satisfaction: v.satisfaction, reopened_count: Number(v.reopened_count ?? 0), has_attachment: bool(v.has_attachment),
    raised_at: v.raised_at, resolved_at: v.resolved_at, created_at: v.created_at, acknowledged_at: v.acknowledged_at,
    respond_due_at: v.respond_due_at, resolve_due_at: v.resolve_due_at,
    respond_breached: bool(v.respond_breached), resolve_breached: bool(v.resolve_breached),
    open_days: Number(v.open_days ?? 0), unanswered_replies: Number(v.unanswered ?? 0) })
}

async function listCell(c: Ctx): Promise<Response> {
  const q = c.url.searchParams
  const re = await growthReach(c.db, c.id)
  const reach = grievanceFilter(re, 'g')
  const stage = (q.get('stage') ?? '').trim()
  const category = (q.get('category') ?? '').trim()
  const openOnly = q.get('open') === 'true' ? 1 : 0
  const overdue = q.get('overdue') === 'true' ? 1 : 0
  const mineOnly = q.get('mine') === 'true' ? 1 : 0
  const where = `${reach.sql} AND (? = '' OR g.category = ?) AND (? IS NOT 1 OR NOT ${SETTLED})
    AND (? = 0 OR (g.resolved_at IS NULL AND ${resolveBreached('g')})) AND (? = 0 OR g.assigned_to = ?)`
  const binds = [...reach.args, category, category, openOnly, overdue, mineOnly, c.id.userId]
  const [rows, counts] = await Promise.all([
    c.db.prepare(`SELECT ${cellColumns} ${cellJoins} WHERE ${where} AND (? = '' OR ${staffStage('g')} = ?)
      ORDER BY ${SETTLED}, CASE g.severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, g.created_at LIMIT 300`)
      .bind(...binds, stage, stage).all<Record<string, unknown>>(),
    c.db.prepare(`SELECT ${staffStage('g')} AS stage, count(*) AS n FROM staff_grievances g WHERE ${where} GROUP BY 1`)
      .bind(...binds).all<{ stage: string; n: number }>(),
  ])
  return ok({ items: rows.results.map(cellRow), counts: stageCounts(counts.results) })
}

/** HR raising one on somebody's behalf (a complaint made in person, or on paper). */
async function raiseForSomebody(c: Ctx): Promise<Response> {
  const req = await readJSON<Record<string, unknown>>(c.req)
  if (str(req.subject).trim() === '' || str(req.description).trim() === '') throw badRequest('a grievance needs a subject and what happened')
  const { category, severity } = readCategory(req)
  const anonymous = req.is_anonymous === true
  const emp = str(req.employee_id)
  if (!anonymous && emp === '') throw badRequest('name the employee, or raise it anonymously')
  if (!anonymous && !isUUID(emp)) throw badRequest('employee_id must be a uuid')
  const [ref, sla] = await Promise.all([newReference(c), staffPolicy(c, category, severity)])
  const id = uuid(), t = now()
  try {
    await c.db.batch([
      c.db.prepare(`INSERT INTO staff_grievances (id, institution_id, reference_no, employee_id, raised_by, is_anonymous, category, severity,
          subject, description, assigned_to, respond_due_at, resolve_due_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, school(c).id, ref, anonymous ? null : emp, anonymous ? null : c.id.userId, anonymous ? 1 : 0, category, severity,
          str(req.subject).trim(), str(req.description).trim(), sla.owner, dueAt(t, sla.respond), dueAt(t, sla.resolve), t, t),
      updateStmt(c, id, 'created', 'Recorded by HR.', 'open', true, c.id.userId),
    ])
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw badRequest(e instanceof Error ? e.message : String(e))
  }
  return created({ id, reference_no: ref })
}

interface CellCase { id: string; reference_no: string; subject: string; status: string; employee_id: string | null; raised_by: string | null;
  is_anonymous: number; assigned_to: string | null; category: string; severity: string }

/** The case, if the caller may see it; `work` also demands they may act on it (HR, or it is theirs to handle). */
async function cellCase(c: Ctx, work: boolean): Promise<CellCase> {
  const gid = c.params.id
  if (!isUUID(gid)) throw badRequest('id must be a uuid')
  const re = await growthReach(c.db, c.id)
  const reach = grievanceFilter(re, 'g')
  const v = await c.db.prepare(`SELECT g.id, g.reference_no, g.subject, g.status, g.employee_id, g.raised_by, g.is_anonymous, g.assigned_to,
        g.category, g.severity FROM staff_grievances g WHERE g.id = ? AND ${reach.sql}`).bind(gid, ...reach.args).first<CellCase>()
  if (!v) throw notFound()
  if (work && !re.all && v.assigned_to !== c.id.userId) throw forbidden('only HR, the principal or the person handling this concern can act on it')
  return v
}

/** Tell the raiser, unless they are anonymous: a notification addressed to them would name them. */
async function tellRaiser(c: Ctx, v: CellCase, title: string, body: string): Promise<D1PreparedStatement[]> {
  if (v.is_anonymous) return []
  let to = v.raised_by
  if (v.employee_id) {
    const e = await c.db.prepare(`SELECT user_id FROM employees WHERE id = ?`).bind(v.employee_id).first<{ user_id: string | null }>()
    to = e?.user_id ?? to
  }
  if (!to || to === c.id.userId) return []
  return [notify(c, to, title, body, raiserLink(v.id), 'staff_grievance', v.id)]
}

async function getCell(c: Ctx): Promise<Response> {
  const v0 = await cellCase(c, false)
  const v = await c.db.prepare(`SELECT ${cellColumns}, g.satisfaction_note, g.attachment_file_id, f.original_name AS attachment_name
      ${cellJoins} LEFT JOIN files f ON f.id = g.attachment_file_id AND f.deleted_at IS NULL WHERE g.id = ?`).bind(v0.id).first<Record<string, unknown>>()
  if (!v) throw notFound()
  return ok({ ...cellRow(v), ...omitNull({ satisfaction_note: v.satisfaction_note }),
    ...(v.attachment_name != null ? { attachment: { id: v.attachment_file_id, name: v.attachment_name } } : {}) })
}

async function listCellUpdates(c: Ctx): Promise<Response> {
  const v = await cellCase(c, true)
  const rows = await c.db.prepare(`SELECT u.id, u.kind, u.body, u.new_status, u.visible_to_raiser, u.from_raiser,
        CASE WHEN u.from_raiser = 1 AND ? = 1 THEN 'Raiser (anonymous)' ELSE a.full_name END AS author, ${isoZ('u.created_at')} AS created_at
      FROM staff_grievance_updates u LEFT JOIN users a ON a.id = u.author_id
      WHERE u.grievance_id = ? ORDER BY u.created_at`).bind(v.is_anonymous ? 1 : 0, v.id).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((u) => omitNull({ id: u.id, kind: u.kind, body: u.body, new_status: u.new_status,
    visible_to_raiser: bool(u.visible_to_raiser), from_raiser: bool(u.from_raiser), author: u.author ?? (bool(u.from_raiser) ? 'Raiser' : null),
    created_at: u.created_at })) })
}

async function addCellUpdate(c: Ctx): Promise<Response> {
  const v = await cellCase(c, true)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const body = trim(req.body)
  if (body === '') throw badRequest('an update needs something written in it')
  const newStatus = trim(req.new_status)
  if (newStatus !== '' && newStatus !== 'open' && newStatus !== 'in_progress') throw badRequest('status must be open or in_progress. Use resolve to close a case')
  const visible = optBool(req.visible_to_raiser) === true
  const t = now()
  const stmts: D1PreparedStatement[] = []
  if (newStatus !== '') stmts.push(c.db.prepare(`UPDATE staff_grievances SET status = ?, updated_at = ? WHERE id = ?`).bind(newStatus, t, v.id))
  if (visible) stmts.push(c.db.prepare(`UPDATE staff_grievances SET acknowledged_at = COALESCE(acknowledged_at, ?), updated_at = ? WHERE id = ?`).bind(t, t, v.id))
  stmts.push(updateStmt(c, v.id, visible ? 'reply' : 'note', body, null, visible, c.id.userId))
  if (newStatus !== '') stmts.push(updateStmt(c, v.id, 'status', `Status changed to ${STAGE_LABEL[newStatus] ?? newStatus}.`, newStatus, true, c.id.userId))
  if (visible) stmts.push(...await tellRaiser(c, v, `HR replied on ${v.reference_no}`, body))
  else if (newStatus !== '') stmts.push(...await tellRaiser(c, v, `${v.reference_no} is now: ${STAGE_LABEL[newStatus] ?? newStatus}`, v.subject))
  await c.db.batch(stmts)
  return created({ added: true })
}

async function acknowledgeCell(c: Ctx): Promise<Response> {
  const v = await cellCase(c, true)
  await c.db.batch([
    c.db.prepare(`UPDATE staff_grievances SET acknowledged_at = COALESCE(acknowledged_at, ?), updated_at = ? WHERE id = ?`).bind(now(), now(), v.id),
    updateStmt(c, v.id, 'status', 'HR has received this concern and will look into it.', null, true, c.id.userId),
    ...await tellRaiser(c, v, `${v.reference_no} has been acknowledged`, v.subject),
  ])
  return ok({ ok: true })
}

async function startCell(c: Ctx): Promise<Response> {
  const v = await cellCase(c, true)
  const t = now()
  await c.db.batch([
    c.db.prepare(`UPDATE staff_grievances SET status = 'in_progress', acknowledged_at = COALESCE(acknowledged_at, ?),
        assigned_to = COALESCE(assigned_to, ?), updated_at = ? WHERE id = ? AND status IN ('open', 'investigating')`).bind(t, c.id.userId, t, v.id),
    updateStmt(c, v.id, 'status', 'HR is working on this now.', 'in_progress', true, c.id.userId),
    ...await tellRaiser(c, v, `${v.reference_no} is now: In progress`, v.subject),
  ])
  return ok({ status: 'in_progress' })
}

/** Handing a case to somebody. Only HR or the principal assign; the assignee then sees it. */
async function assignCell(c: Ctx): Promise<Response> {
  if (!can(c.id, WRITE)) throw forbidden()
  const v = await cellCase(c, true)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const to = trim(req.assigned_to)
  if (!isUUID(to)) throw badRequest('assigned_to must be a uuid')
  const who = await c.db.prepare(`SELECT u.full_name, e.id AS emp FROM users u JOIN employees e ON e.user_id = u.id WHERE u.id = ? LIMIT 1`)
    .bind(to).first<{ full_name: string; emp: string }>()
  if (!who) throw badRequest('choose a member of staff')
  if (who.emp === v.employee_id || (!v.is_anonymous && v.raised_by === to)) throw badRequest('a concern cannot be assigned to the person who raised it')
  await c.db.batch([
    c.db.prepare(`UPDATE staff_grievances SET assigned_to = ?, updated_at = ? WHERE id = ?`).bind(to, now(), v.id),
    updateStmt(c, v.id, 'assignment', `Assigned to ${who.full_name}`, null, false, c.id.userId),
    ...(to !== c.id.userId ? [notify(c, to, `Staff concern ${v.reference_no} has been given to you`, v.subject, HR_LINK(v.id), 'staff_grievance', v.id)] : []),
  ])
  return ok({ assigned: true, assigned_to: who.full_name })
}

async function escalateCell(c: Ctx): Promise<Response> {
  const v = await cellCase(c, true)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const to = trim(req.to_user_id)
  if (!isUUID(to)) throw badRequest('to_user_id must be a uuid')
  const reason = trim(req.reason)
  if (reason === '') throw badRequest('say why this is being escalated. It is the record of the decision')
  const t = now()
  await c.db.batch([
    c.db.prepare(`UPDATE staff_grievances SET escalated_at = ?, escalated_to = ?, severity = 'high', updated_at = ? WHERE id = ?`).bind(t, to, t, v.id),
    updateStmt(c, v.id, 'escalation', reason, null, false, c.id.userId),
    ...(to !== c.id.userId ? [notify(c, to, `Staff concern ${v.reference_no} has been escalated to you`, reason, HR_LINK(v.id), 'staff_grievance', v.id)] : []),
  ])
  return ok({ escalated: true })
}

async function escalateOverdueCell(c: Ctx): Promise<Response> {
  const req = await readJSON<Record<string, unknown>>(c.req)
  const to = trim(req.to_user_id)
  if (!isUUID(to)) throw badRequest('to_user_id must be a uuid')
  const rows = await c.db.prepare(`SELECT g.id, g.reference_no FROM staff_grievances g
      WHERE g.resolved_at IS NULL AND NOT ${SETTLED} AND g.escalated_at IS NULL AND ${resolveBreached('g')} LIMIT 100`).all<{ id: string; reference_no: string }>()
  if (!rows.results.length) return ok({ escalated: 0 })
  const t = now()
  const stmts: D1PreparedStatement[] = []
  for (const r of rows.results) {
    stmts.push(c.db.prepare(`UPDATE staff_grievances SET escalated_at = ?, escalated_to = ?, severity = 'high', updated_at = ? WHERE id = ?`).bind(t, to, t, r.id))
    stmts.push(updateStmt(c, r.id, 'escalation', 'Escalated: past its resolution deadline.', null, false, c.id.userId))
  }
  if (to !== c.id.userId) stmts.push(notify(c, to, `${rows.results.length} overdue staff concern${rows.results.length === 1 ? '' : 's'} escalated to you`,
    rows.results.map((r) => r.reference_no).join(', '), '/hr/welfare/staff_welfare?tab=grievances', 'staff_grievance', rows.results[0].id))
  await c.db.batch(stmts)
  return ok({ escalated: rows.results.length })
}

/** Resolve, close or withdraw; 'investigating' is kept for older clients and means in progress. */
async function decideCell(c: Ctx): Promise<Response> {
  const v = await cellCase(c, true)
  const req = await readJSON<Record<string, unknown>>(c.req)
  let status = str(req.status)
  if (status === 'investigating') status = 'in_progress'
  if (!['in_progress', 'resolved', 'closed', 'withdrawn'].includes(status)) throw badRequest('say what the grievance has moved to')
  const resolution = trim(req.resolution)
  if ((status === 'resolved' || status === 'closed') && resolution === '') throw badRequest('closing a grievance needs a note saying what was done')
  const t = now()
  const settled = status !== 'in_progress'
  await c.db.batch([
    c.db.prepare(`UPDATE staff_grievances SET status = ?, resolution = COALESCE(NULLIF(?, ''), resolution),
        acknowledged_at = COALESCE(acknowledged_at, ?),
        resolved_at = CASE WHEN ? = 1 THEN COALESCE(resolved_at, ?) END, updated_at = ? WHERE id = ?`)
      .bind(status, resolution, t, settled ? 1 : 0, t, t, v.id),
    updateStmt(c, v.id, settled ? 'resolution' : 'status', resolution || `Status changed to ${STAGE_LABEL[status] ?? status}.`, status, true, c.id.userId),
    ...await tellRaiser(c, v, `${v.reference_no} is now: ${STAGE_LABEL[status] ?? status}`, resolution || v.subject),
  ])
  return ok({ status })
}

async function listStaffSLA(c: Ctx): Promise<Response> {
  const rows = await c.db.prepare(`SELECT substr(p.category, 7) AS category, u.full_name AS default_owner, p.default_owner_id,
        p.respond_hours, p.resolve_hours, p.is_active
      FROM grievance_sla_policies p LEFT JOIN users u ON u.id = p.default_owner_id
      WHERE p.category LIKE 'staff:%' ORDER BY p.category`).all<Record<string, unknown>>()
  return ok({ items: rows.results.map((v) => omitNull({ category: v.category, default_owner: v.default_owner, default_owner_id: v.default_owner_id,
    respond_hours: Number(v.respond_hours), resolve_hours: Number(v.resolve_hours), is_active: bool(v.is_active) })),
    defaults: Object.fromEntries(Object.entries(DEFAULT_SLA).map(([k, [a, b]]) => [k, { respond_hours: a, resolve_hours: b }])) })
}

async function saveStaffSLA(c: Ctx): Promise<Response> {
  const req = await readJSON<Record<string, unknown>>(c.req)
  const category = trim(req.category)
  if (!STAFF_CATEGORIES.has(category)) throw badRequest('choose one of the listed categories')
  const respond = optInt(req.respond_hours) ?? 0, resolve = optInt(req.resolve_hours) ?? 0
  if (respond <= 0 || resolve <= 0) throw badRequest('both deadlines need a number of hours')
  if (resolve < respond) throw badRequest('the resolution deadline cannot be sooner than the first-response one')
  const o = trim(req.default_owner_id)
  if (o !== '' && !isUUID(o)) throw badRequest('default_owner_id must be a uuid')
  const key = `staff:${category}`, t = now()
  const existing = await c.db.prepare(`SELECT id FROM grievance_sla_policies WHERE lower(category) = lower(?)`).bind(key).first<{ id: string }>()
  if (existing) {
    await c.db.prepare(`UPDATE grievance_sla_policies SET default_owner_id = ?, respond_hours = ?, resolve_hours = ?, is_active = 1, is_sensitive = 1, updated_at = ? WHERE id = ?`)
      .bind(o || null, respond, resolve, t, existing.id).run()
  } else {
    await c.db.prepare(`INSERT INTO grievance_sla_policies (id, institution_id, category, default_owner_id, respond_hours, resolve_hours, is_sensitive, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`).bind(uuid(), school(c).id, key, o || null, respond, resolve, t, t).run()
  }
  return ok({ saved: true })
}

export function registerStaffConcerns(r: Router): void {
  r.get('/me/concerns', SELF, listMine)
  r.post('/me/concerns', SELF, raiseMine)
  r.get('/me/concerns/{id}', SELF, getMine)
  r.post('/me/concerns/{id}/reply', SELF, replyMine)
  r.post('/me/concerns/{id}/reopen', SELF, reopenMine)
  r.post('/me/concerns/{id}/rate', SELF, rateMine)

  r.get('/hr/grievances', READ, listCell)
  r.post('/hr/grievances', WRITE, raiseForSomebody)
  r.get('/hr/grievance-sla', WRITE, listStaffSLA)
  r.put('/hr/grievance-sla', WRITE, saveStaffSLA)
  r.post('/hr/grievances/escalate-overdue', WRITE, escalateOverdueCell)
  r.get('/hr/grievances/assignees', WRITE, async (c) => {
    const rows = await c.db.prepare(`SELECT u.id, u.full_name AS name, d.name AS designation
        FROM employees e JOIN users u ON u.id = e.user_id LEFT JOIN designations d ON d.id = e.designation_id
        WHERE e.status = 'active' AND u.status = 'active' ORDER BY u.full_name LIMIT 500`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ id: v.id, name: v.name, designation: v.designation })) })
  })
  r.get('/hr/grievances/{id}', READ, getCell)
  r.get('/hr/grievances/{id}/updates', READ, listCellUpdates)
  r.post('/hr/grievances/{id}/updates', READ, addCellUpdate)
  r.post('/hr/grievances/{id}/acknowledge', READ, acknowledgeCell)
  r.post('/hr/grievances/{id}/start', READ, startCell)
  r.put('/hr/grievances/{id}/assign', READ, assignCell)
  r.post('/hr/grievances/{id}/escalate', READ, escalateCell)
  r.post('/hr/grievances/{id}/decide', READ, decideCell)
}
