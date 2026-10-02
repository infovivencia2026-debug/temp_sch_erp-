import type { Ctx } from '../../router'
import { HttpError, badRequest, bool, now, uuid } from '../../http'
import { isoZ } from '../comms/common'
import { canReopen, ticketStage } from '../comms/concern_shared'
import { cleanErrorRef } from '../../services/error_refs'

/* What the Help Centre, the school's helpdesk and the vendor's desk share.

   ONE TICKET MODEL. A help request is a support_tickets row with origin =
   'help'. Its audience says who answers it:

     'helpdesk'  a parent, student or member of staff asked; the school's own
                 helpdesk answers (Home > Help > Helpdesk).
     'vendor'    the school's administrator asked, or escalated a request; the
                 vendor's desk answers. Never carries a child (a trigger holds
                 that, tenant migration 0031) nor a family's own words.

   grievance_updates is the thread on both. visible_to_parent = 1 means "the
   person who raised it may read this"; 0 is a working note of whoever wrote
   it (author_side), which the other side never sees. */

export const HELP = 'help'
export const DESK_READ = 'help.desk.read'
export const DESK_WRITE = 'help.desk.write'
export const MAX_BODY = 4000

export type Side = 'raiser' | 'school' | 'vendor'

/** The columns every list and detail reads (alias t). */
export const TICKET_COLS = `t.id, t.subject, t.category, t.priority, t.status, ${ticketStage('t')} AS stage, t.audience, t.route, t.role_key,
  t.error_ref, t.me_too, t.parent_ticket_id, t.solved_by, t.satisfaction, t.incident_id, t.merged_into, t.reopened_count,
  ${isoZ('t.created_at')} AS created_at, ${isoZ('t.updated_at')} AS updated_at, ${isoZ('t.respond_due_at')} AS respond_due_at,
  ${isoZ('t.resolve_due_at')} AS resolve_due_at, ${isoZ('t.acknowledged_at')} AS acknowledged_at, ${isoZ('t.resolved_at')} AS resolved_at,
  ${isoZ('t.last_reply_at')} AS last_reply_at, t.last_reply_side,
  ${canReopen('t', "t.status IN ('resolved', 'closed')")} AS can_reopen`

export interface TicketRow {
  id: string; subject: string; category: string; priority: string; status: string; stage: string; audience: string
  route: string | null; role_key: string | null; error_ref: string | null; me_too: number; parent_ticket_id: string | null
  solved_by: string | null; satisfaction: number | null; incident_id: string | null; merged_into: string | null; reopened_count: number
  created_at: string; updated_at: string; respond_due_at: string | null; resolve_due_at: string | null
  acknowledged_at: string | null; resolved_at: string | null; last_reply_at: string | null; last_reply_side: string | null; can_reopen: number
  [k: string]: unknown
}

const und = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v)

/** A ticket as every screen lists it. */
export function ticketSummary(t: TicketRow) {
  return {
    id: t.id, subject: t.subject, category: t.category, priority: t.priority, status: t.status, stage: t.stage,
    /** Who answers it: the school's own helpdesk, or the vendor. */
    with: t.audience === 'vendor' ? 'vendor' as const : 'school' as const,
    route: und(t.route), role: und(t.role_key), error_ref: und(t.error_ref), me_too: Number(t.me_too ?? 0),
    created_at: t.created_at, updated_at: t.updated_at, respond_due_at: und(t.respond_due_at), resolve_due_at: und(t.resolve_due_at),
    acknowledged_at: und(t.acknowledged_at), resolved_at: und(t.resolved_at),
    last_reply_at: und(t.last_reply_at), last_reply_side: und(t.last_reply_side) as Side | undefined,
    helpful: t.satisfaction === null || t.satisfaction === undefined ? undefined : Number(t.satisfaction) >= 4,
    can_reopen: bool(t.can_reopen), reopened_count: Number(t.reopened_count ?? 0),
    incident_id: und(t.incident_id), merged_into: und(t.merged_into), solved_by: und(t.solved_by),
  }
}
export type TicketSummary = ReturnType<typeof ticketSummary>

export interface ThreadEntry {
  id: string; kind: string; body: string; side: Side; author: string; internal: boolean; new_status?: string; created_at: string
}

/** The thread of a ticket. `see`: which working notes this reader may see besides everything public. */
export async function thread(db: D1Database, ticketId: string, see: 'public' | 'school' | 'vendor'): Promise<ThreadEntry[]> {
  const where = see === 'public' ? 'g.visible_to_parent = 1'
    : see === 'school' ? `(g.visible_to_parent = 1 OR COALESCE(g.author_side, 'school') <> 'vendor')`
    : `(g.visible_to_parent = 1 OR g.author_side = 'vendor')`
  const rows = await db.prepare(`SELECT g.id, g.kind, g.body, g.new_status, g.visible_to_parent,
        COALESCE(g.author_side, CASE WHEN g.author_id = t.raised_by THEN 'raiser' ELSE 'school' END) AS side,
        COALESCE(g.author_name, u.full_name, '') AS author, ${isoZ('g.created_at')} AS created_at
      FROM grievance_updates g JOIN support_tickets t ON t.id = g.ticket_id LEFT JOIN users u ON u.id = g.author_id
      WHERE g.ticket_id = ? AND ${where} ORDER BY g.created_at, g.rowid`).bind(ticketId).all<Record<string, unknown>>()
  return rows.results.map((r) => ({
    id: String(r.id), kind: String(r.kind), body: String(r.body), side: String(r.side) as Side, author: String(r.author ?? ''),
    internal: !bool(r.visible_to_parent), new_status: und(r.new_status as string | null), created_at: String(r.created_at),
  }))
}

/** One thread entry. `authorId` is a user of this school, or null for a vendor agent (who is not one). */
export function updateStmt(db: D1Database, institutionId: string, ticketId: string, o: {
  kind: string; body: string; side: Side; authorId: string | null; authorName: string; visible: boolean; newStatus?: string | null }): D1PreparedStatement {
  return db.prepare(`INSERT INTO grievance_updates (id, institution_id, ticket_id, kind, body, new_status, visible_to_parent, author_id, author_name, author_side, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(uuid(), institutionId, ticketId, o.kind, o.body, o.newStatus ?? null, o.visible ? 1 : 0, o.authorId, o.authorName, o.side, now())
}

/** A bell notification; one per event, never folded into an earlier one (see concern_shared.notify). */
export function bell(db: D1Database, institutionId: string, userId: string, title: string, body: string | null, link: string, ticketId: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO notifications (id, institution_id, user_id, kind, title, body, link, source_kind, source_id, created_at)
      VALUES (?, ?, ?, 'help.request', ?, ?, ?, NULL, ?, ?)`)
    .bind(uuid(), institutionId, userId, title, body ? body.slice(0, 280) : null, link, ticketId, now())
}

/** Where the person who raised a request reads it. */
export const requestLink = (id: string) => `/help?request=${id}`
/** Where the school's helpdesk reads it. */
export const deskLink = (id: string) => `/go/help/helpdesk?id=${id}`

/** The school's helpdesk: active accounts holding help.desk.write, by role or by a direct grant. */
export async function helpdeskStaff(db: D1Database): Promise<string[]> {
  const rows = await db.prepare(`SELECT DISTINCT u.id FROM users u WHERE u.status = 'active' AND (
        EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = u.id AND rp.permission_key = ?1)
        OR EXISTS (SELECT 1 FROM user_permissions up WHERE up.user_id = u.id AND up.permission_key = ?1)) LIMIT 25`)
    .bind(DESK_WRITE).all<{ id: string }>()
  return rows.results.map((r) => r.id)
}

/* A TICKET FOR THE VENDOR NAMES NO CHILD.

   The schema refuses a student_id on a vendor ticket. Words are the other way
   a child reaches the vendor's screen, so the text is read against the
   school's own roll before it is stored: a full name, an admission number, or
   a first name written as a name. A match is refused with the word that
   matched, and the administrator rewrites it ("a student in Class 5 A").
   A first name that is also an ordinary word can be refused wrongly; that
   costs one rewording, and the other mistake costs a child's privacy. */
export async function namedStudent(db: D1Database, text: string): Promise<string | null> {
  const words = [...new Set((text.match(/[\p{L}\p{N}][\p{L}\p{N}/_-]*/gu) ?? []).map((w) => w.toLowerCase()))].slice(0, 600)
  if (!words.length) return null
  const rows = await db.prepare(`SELECT first_name, last_name, admission_no FROM students
      WHERE lower(first_name) IN (SELECT value FROM json_each(?1)) OR lower(admission_no) IN (SELECT value FROM json_each(?1)) LIMIT 200`)
    .bind(JSON.stringify(words)).all<{ first_name: string; last_name: string | null; admission_no: string | null }>()
  const lower = text.toLowerCase()
  const wordSet = new Set(words)
  for (const s of rows.results) {
    const adm = (s.admission_no ?? '').trim()
    if (adm.length >= 3 && wordSet.has(adm.toLowerCase())) return adm
    const first = (s.first_name ?? '').trim(), last = (s.last_name ?? '').trim()
    if (first && last && lower.includes(`${first} ${last}`.toLowerCase())) return `${first} ${last}`
    // A first name counts when it is written as a name: capitalised, a word of its own.
    if (first.length >= 3) {
      const cap = first[0].toUpperCase() + first.slice(1)
      if (new RegExp(`(^|[^\\p{L}])${cap.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(text)) return first
    }
  }
  return null
}

export function refuseNamedStudent(name: string): HttpError {
  return new HttpError(422, `This names a student (${name}). XULO support must not receive a child's name or admission number. Write "a student in Class 5 A" instead.`,
    { code: 'names_a_child', matched: name })
}

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined)

export interface Diagnostics {
  route?: string; role?: string; layout?: string; theme?: string; language?: string; app_version?: string
  browser?: string; os?: string; viewport?: string; online?: boolean; standalone?: boolean
  client_errors?: string[]
  last_failed?: { path?: string; status?: number; ref?: string; at?: string }
  /** The assistant conversation the person chose to attach. Never copied to the vendor. */
  conversation?: { role: string; text: string }[]
  /** What a troubleshooter found before the request was written (step 3). */
  checks?: { check: string; ok: boolean; detail: string }[]
}

/** Keeps the fields the form shows and nothing else, each cut to a sane length. */
export function cleanDiagnostics(raw: unknown): Diagnostics {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: Diagnostics = {
    route: str(d.route, 200), role: str(d.role, 60), layout: str(d.layout, 30), theme: str(d.theme, 60), language: str(d.language, 12),
    app_version: str(d.app_version, 40), browser: str(d.browser, 80), os: str(d.os, 60), viewport: str(d.viewport, 30),
  }
  if (typeof d.online === 'boolean') out.online = d.online
  if (typeof d.standalone === 'boolean') out.standalone = d.standalone
  if (Array.isArray(d.client_errors)) out.client_errors = d.client_errors.map((e) => str(e, 300)).filter((e): e is string => !!e).slice(0, 5)
  const lf = d.last_failed as Record<string, unknown> | undefined
  if (lf && typeof lf === 'object') {
    out.last_failed = { path: str(lf.path, 200), status: typeof lf.status === 'number' ? lf.status : undefined, ref: cleanErrorRef(lf.ref) ?? undefined, at: str(lf.at, 40) }
  }
  if (Array.isArray(d.conversation)) {
    out.conversation = d.conversation.slice(-20).map((m) => ({ role: str((m as Record<string, unknown>)?.role, 12) === 'user' ? 'user' : 'assistant',
      text: str((m as Record<string, unknown>)?.text, 2000) ?? '' })).filter((m) => m.text !== '')
  }
  if (Array.isArray(d.checks)) {
    out.checks = d.checks.slice(0, 20).map((k) => { const o = (k ?? {}) as Record<string, unknown>
      return { check: str(o.check, 120) ?? '', ok: o.ok === true, detail: str(o.detail, 400) ?? '' } }).filter((k) => k.check !== '')
  }
  for (const k of Object.keys(out) as (keyof Diagnostics)[]) if (out[k] === undefined) delete out[k]
  return out
}

/** What may go with an escalation: the device and the screen, not the conversation and not the troubleshooter's findings (they can name people). */
export function vendorSafeDiagnostics(d: Diagnostics): Diagnostics {
  const { conversation: _c, checks: _k, ...rest } = d
  return rest
}

export function parseDiagnostics(raw: unknown): Diagnostics {
  if (typeof raw !== 'string' || raw === '') return {}
  try { return JSON.parse(raw) as Diagnostics } catch { return {} }
}

/** The text of a request or a reply: required, bounded. */
export function messageBody(raw: unknown, what = 'a message'): string {
  const body = typeof raw === 'string' ? raw.trim() : ''
  if (body === '') throw badRequest(`write ${what} to send`)
  if (body.length > MAX_BODY) throw badRequest(`keep it under ${MAX_BODY} characters`)
  return body
}

/** A subject line from the first line of the text when none was given. */
export function subjectFrom(subject: unknown, body: string): string {
  const s = typeof subject === 'string' ? subject.trim() : ''
  if (s !== '') return s.slice(0, 140)
  const first = body.split(/\r?\n/)[0].trim()
  return first.length > 90 ? first.slice(0, 87).trimEnd() + '...' : first
}
