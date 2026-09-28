import type { Ctx } from '../../router'
import { badRequest, isUUID, now, uuid } from '../../http'
import { institutionId } from '../teaching/common'

/* What the two concern pipelines share: families' concerns (support_tickets)
   and staff concerns (staff_grievances). Both move through the same five
   stages, new -> acknowledged -> in progress -> resolved or closed, derived
   from the stored status so the office's Today count (status IN open,
   in_progress, waiting) keeps meaning "not yet answered". */

export const STAGES = ['new', 'acknowledged', 'in_progress', 'resolved', 'closed'] as const
export type Stage = (typeof STAGES)[number]

/** A resolved or closed concern may be reopened by its raiser for this many days. */
export const REOPEN_DAYS = 14

export const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`

/** The stage of a support_tickets row (alias t). */
export const ticketStage = (t: string) => `CASE WHEN ${t}.status = 'closed' THEN 'closed'
  WHEN ${t}.status = 'resolved' THEN 'resolved'
  WHEN ${t}.status IN ('in_progress', 'waiting') THEN 'in_progress'
  WHEN ${t}.acknowledged_at IS NOT NULL THEN 'acknowledged'
  ELSE 'new' END`

/** The stage of a staff_grievances row (alias g). 'investigating' is the older word for in progress. */
export const staffStage = (g: string) => `CASE WHEN ${g}.status IN ('closed', 'withdrawn') THEN 'closed'
  WHEN ${g}.status = 'resolved' THEN 'resolved'
  WHEN ${g}.status IN ('in_progress', 'investigating') THEN 'in_progress'
  WHEN ${g}.acknowledged_at IS NOT NULL THEN 'acknowledged'
  ELSE 'new' END`

/** First response missed: not acknowledged by the respond deadline. */
export const respondBreached = (a: string) => `(${a}.respond_due_at IS NOT NULL
  AND julianday(COALESCE(${a}.acknowledged_at, ${NOW_SQL})) > julianday(${a}.respond_due_at))`
/** Resolution missed: not resolved by the resolve deadline. */
export const resolveBreached = (a: string) => `(${a}.resolve_due_at IS NOT NULL
  AND julianday(COALESCE(${a}.resolved_at, ${NOW_SQL})) > julianday(${a}.resolve_due_at))`
/** Whether the raiser may still reopen it. */
export const canReopen = (a: string, settled: string) => `(${settled} AND ${a}.resolved_at IS NOT NULL
  AND julianday(${NOW_SQL}) - julianday(${a}.resolved_at) <= ${REOPEN_DAYS})`

export interface Policy { respond_hours: number; resolve_hours: number; owner_department: string | null; default_owner_id: string | null }

/** The active SLA policy for a category key, or null. */
export async function policyFor(c: Ctx, key: string): Promise<Policy | null> {
  return c.db.prepare(`SELECT respond_hours, resolve_hours, owner_department, default_owner_id
      FROM grievance_sla_policies WHERE lower(category) = lower(?) AND is_active = 1`).bind(key).first<Policy>()
}

export const dueAt = (fromIso: string, hours: number) => new Date(Date.parse(fromIso) + hours * 3600_000).toISOString()

/** A file the caller uploaded, to attach to what they are raising; null when none was given. */
export async function ownAttachment(c: Ctx, raw: unknown): Promise<string | null> {
  if (raw === undefined || raw === null || raw === '') return null
  if (!isUUID(raw)) throw badRequest('attachment_file_id must be a uuid')
  const f = await c.db.prepare(`SELECT 1 AS x FROM files WHERE id = ? AND uploaded_by = ? AND deleted_at IS NULL`)
    .bind(raw, c.id.userId).first()
  if (!f) throw badRequest('attach a file you have uploaded')
  return raw
}

/** One notification, never de-duplicated: every reply and stage change is its own.
    source_kind stays NULL on purpose: notifications_one_per_source keeps one row per
    (user, kind, source) whenever source_kind is set, which would swallow the second reply.
    The case id is still recorded in source_id. */
export function notify(c: Ctx, userId: string, title: string, body: string | null, link: string,
  sourceKind: string, sourceId: string, studentId: string | null = null): D1PreparedStatement {
  return c.db.prepare(`INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, source_kind, source_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
    .bind(uuid(), institutionId(c), userId, studentId, `concern.${sourceKind}`, title, body ? body.slice(0, 280) : null, link, sourceId, now())
}

export const STAGE_LABEL: Record<string, string> = {
  new: 'New', acknowledged: 'Acknowledged', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed',
  open: 'Open', waiting: 'Waiting on you',
}

/** Count per stage, every stage present. */
export function stageCounts(rows: { stage: string; n: number }[]): Record<Stage, number> {
  const out = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>
  for (const r of rows) if (r.stage in out) out[r.stage as Stage] = Number(r.n)
  return out
}

/** The raiser's link: one route that shows a family or a member of staff their own concerns. */
export const raiserLink = (id: string) => `/concerns?id=${id}`
