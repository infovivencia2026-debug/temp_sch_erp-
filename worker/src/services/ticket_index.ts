import type { Env } from '../env'
import type { Ctx, Handler, Router } from '../router'
import { tenantDb, type Institution } from '../tenant'
import { registerJob } from './jobs'
import { businessSeconds, slaPolicy, vendorHours, vendorResponseHours, type SlaPolicy } from '../routes/help/content'

/* THE VENDOR'S TICKET INDEX (CONTROL support_ticket_index, migration 0056).

   The queue used to open every school's database on every request and drop
   any school that failed without a word. Now each write to a vendor ticket
   copies that school's changed tickets here (withTicketIndex, below, and
   syncSchoolTickets where a route touches a school it does not name), a
   nightly job copies them all again, and a school never copied is copied the
   first time the queue is read. The queue reads this table, paged.

   The copy also keeps what the school's own row cannot: how long the ticket
   has waited on the school (waiting_since, waiting_seconds, in business
   seconds), which the SLA clock leaves out. */

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface SchoolTicket {
  id: string; subject: string; category: string; priority: string; status: string; raised_by: string | null; assigned_to: string | null
  vendor_agent_id: string | null; last_reply_side: string | null; last_reply_at: string | null; parent_ticket_id: string | null; merged_into: string | null
  route: string | null; error_ref: string | null; body: string | null; created_at: string; updated_at: string; acknowledged_at: string | null; resolved_at: string | null
}
interface Prior { ticket_id: string; status: string; waiting_since: string | null; waiting_seconds: number }

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN)

/** Copies the school's vendor tickets changed since its last copy (all of them with full). Records the outcome. */
export async function syncSchoolTickets(env: Env, inst: Institution, opts: { full?: boolean; policy?: SlaPolicy } = {}): Promise<{ ok: boolean; error?: string; copied: number }> {
  const C = env.CONTROL
  const tried = new Date().toISOString()
  try {
    const last = opts.full ? null : await C.prepare(`SELECT synced_at FROM support_index_sync WHERE institution_id = ?`).bind(inst.id).first<{ synced_at: string | null }>()
    // A minute of overlap: a write stamped just before the last copy finished is copied again, never missed.
    const since = last?.synced_at ? new Date(Date.parse(last.synced_at) - 60_000).toISOString() : null
    const db = tenantDb(env, inst)
    const rows = (await db.prepare(`SELECT t.id, t.subject, t.category, t.priority, t.status, u.full_name AS raised_by, COALESCE(t.vendor_agent_name, a.full_name) AS assigned_to,
        t.vendor_agent_id, t.last_reply_side, t.last_reply_at, t.parent_ticket_id, t.merged_into, t.route, t.error_ref, substr(t.body, 1, 600) AS body,
        t.created_at, t.updated_at, t.acknowledged_at, t.resolved_at
      FROM support_tickets t LEFT JOIN users u ON u.id = t.raised_by LEFT JOIN users a ON a.id = t.assigned_to
      WHERE t.audience = 'vendor' AND (?1 IS NULL OR t.updated_at >= ?1)`).bind(since).all<SchoolTicket>()).results
    const policy = rows.length ? (opts.policy ?? await slaPolicy(env)) : null
    const prior = new Map<string, Prior>()
    for (let i = 0; i < rows.length; i += 80) {
      const ids = rows.slice(i, i + 80).map((r) => r.id)
      const got = await C.prepare(`SELECT ticket_id, status, waiting_since, waiting_seconds FROM support_ticket_index WHERE institution_id = ? AND ticket_id IN (${ids.map(() => '?').join(',')})`)
        .bind(inst.id, ...ids).all<Prior>()
      for (const p of got.results) prior.set(p.ticket_id, p)
    }
    const stmts = rows.map((t) => {
      const p = prior.get(t.id)
      let since: string | null = p?.waiting_since ?? null
      let secs = p?.waiting_seconds ?? 0
      if (t.status === 'waiting') since = p?.status === 'waiting' && since ? since : t.updated_at
      else if (since) { secs += businessSeconds(policy!, ms(since), ms(t.updated_at)); since = null }
      return C.prepare(`INSERT INTO support_ticket_index (institution_id, ticket_id, school, subject, category, priority, status, raised_by, assigned_to, agent_id, last_reply_side, last_reply_at,
          parent_ticket_id, merged_into, route, error_ref, body, created_at, updated_at, acknowledged_at, resolved_at, waiting_since, waiting_seconds)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (institution_id, ticket_id) DO UPDATE SET school = excluded.school, subject = excluded.subject, category = excluded.category, priority = excluded.priority,
            status = excluded.status, raised_by = excluded.raised_by, assigned_to = excluded.assigned_to, agent_id = excluded.agent_id, last_reply_side = excluded.last_reply_side,
            last_reply_at = excluded.last_reply_at, parent_ticket_id = excluded.parent_ticket_id, merged_into = excluded.merged_into, route = excluded.route, error_ref = excluded.error_ref,
            body = excluded.body, updated_at = excluded.updated_at, acknowledged_at = excluded.acknowledged_at, resolved_at = excluded.resolved_at,
            waiting_since = excluded.waiting_since, waiting_seconds = excluded.waiting_seconds`)
        .bind(inst.id, t.id, inst.name, t.subject, t.category, t.priority, t.status, t.raised_by, t.assigned_to, t.vendor_agent_id, t.last_reply_side, t.last_reply_at,
          t.parent_ticket_id, t.merged_into, t.route, t.error_ref, t.body, t.created_at, t.updated_at, t.acknowledged_at, t.resolved_at, since, secs)
    })
    for (let i = 0; i < stmts.length; i += 50) await C.batch(stmts.slice(i, i + 50))
    await C.prepare(`INSERT INTO support_index_sync (institution_id, synced_at, error, tried_at) VALUES (?, ?, NULL, ?)
        ON CONFLICT (institution_id) DO UPDATE SET synced_at = excluded.synced_at, error = NULL, tried_at = excluded.tried_at`).bind(inst.id, tried, tried).run()
    return { ok: true, copied: rows.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('ticket index: school not copied', inst.id, err)
    await C.prepare(`INSERT INTO support_index_sync (institution_id, synced_at, error, tried_at) VALUES (?, NULL, ?, ?)
        ON CONFLICT (institution_id) DO UPDATE SET error = excluded.error, tried_at = excluded.tried_at`).bind(inst.id, msg.slice(0, 300), tried).run().catch(() => undefined)
    return { ok: false, error: msg, copied: 0 }
  }
}

export async function syncSchoolById(env: Env, institutionId: string): Promise<void> {
  const inst = await env.CONTROL.prepare(`SELECT * FROM institutions WHERE id = ?`).bind(institutionId).first<Institution>()
  if (inst) await syncSchoolTickets(env, inst)
}

/** Copies every active school never copied (or last failed over five minutes ago). Returns the schools that could not be read. */
export async function ensureIndexed(env: Env): Promise<{ institution_id: string; school: string; error: string }[]> {
  const pending = await env.CONTROL.prepare(`SELECT i.* FROM institutions i LEFT JOIN support_index_sync s ON s.institution_id = i.id
      WHERE i.status = 'active' AND (s.institution_id IS NULL OR (s.error IS NOT NULL AND s.tried_at < ?)) ORDER BY i.name`)
    .bind(new Date(Date.now() - 5 * 60_000).toISOString()).all<Institution>()
  const policy = await slaPolicy(env)
  for (const inst of pending.results) await syncSchoolTickets(env, inst, { full: true, policy })
  const failed = await env.CONTROL.prepare(`SELECT s.institution_id, i.name AS school, s.error FROM support_index_sync s JOIN institutions i ON i.id = s.institution_id
      WHERE i.status = 'active' AND s.error IS NOT NULL ORDER BY i.name`).all<{ institution_id: string; school: string; error: string }>()
  return failed.results
}

/* --- the SLA clock --- */

export interface IndexRow {
  institution_id: string; ticket_id: string; school: string; subject: string; category: string; priority: string; status: string
  raised_by: string | null; assigned_to: string | null; agent_id: string | null; last_reply_side: string | null; last_reply_at: string | null
  parent_ticket_id: string | null; merged_into: string | null; route: string | null; error_ref: string | null; body: string | null
  created_at: string; updated_at: string; acknowledged_at: string | null; resolved_at: string | null
  waiting_since: string | null; waiting_seconds: number; response_alerted_at: string | null; breach_alerted_at: string | null
}

export interface Clock {
  /** Business hours on the clock: created to now (or solved), less the time waiting on the school. */
  sla_hours: number
  promised_hours: number
  breached: boolean
  /** Business hours to the first reply (so far, while there is none). */
  response_hours: number
  response_promised_hours: number
  response_breached: boolean
  waiting_hours: number
}

/** The clock for one ticket. Pure: the tests drive it with a fixed now. */
export function clockOf(t: Pick<IndexRow, 'created_at' | 'status' | 'priority' | 'acknowledged_at' | 'resolved_at' | 'waiting_since' | 'waiting_seconds'>,
  policy: SlaPolicy, plan: { code: string; tier: number | null }, nowMs: number): Clock {
  const settled = t.status === 'resolved' || t.status === 'closed'
  const end = settled && t.resolved_at ? ms(t.resolved_at) : nowMs
  const start = ms(t.created_at)
  const waiting = t.waiting_seconds + (t.waiting_since && !settled ? businessSeconds(policy, ms(t.waiting_since), end) : 0)
  const run = Math.max(0, businessSeconds(policy, start, end) - waiting)
  const promised = vendorHours(policy, plan.code, t.priority, plan.tier)
  const respPromised = vendorResponseHours(policy, plan.code, t.priority, plan.tier)
  const respEnd = t.acknowledged_at ? ms(t.acknowledged_at) : end
  const resp = businessSeconds(policy, start, respEnd)
  return {
    sla_hours: Math.floor(run / 3600), promised_hours: promised, breached: !settled && run > promised * 3600,
    response_hours: Math.floor(resp / 3600), response_promised_hours: respPromised,
    response_breached: resp > respPromised * 3600 && (!!t.acknowledged_at || !settled),
    waiting_hours: Math.floor(waiting / 3600),
  }
}

/** Each school's plan code and the tier stored on that plan. */
export async function plansBySchool(env: Env): Promise<Map<string, { code: string; tier: number | null; name: string | null }>> {
  const r = await env.CONTROL.prepare(`SELECT sub.institution_id, sub.plan_code, p.name, p.sla_tier FROM subscriptions sub LEFT JOIN plans p ON p.code = sub.plan_code
      WHERE sub.status IN ('active','trial')`).all<{ institution_id: string; plan_code: string; name: string | null; sla_tier: number | null }>()
  return new Map(r.results.map((s) => [s.institution_id, { code: s.plan_code ?? '', tier: s.sla_tier ?? null, name: s.name }]))
}

/* --- the copy after each write --- */

/** Routes that write vendor tickets. A write that succeeds copies the school it touched. */
const TICKET_ROUTES = /^\/(help\/|admin\/platform\/(desk\/|seller\/tickets|support\/tickets|help))/

/** Wraps the router once, like withSellerAudit: after a successful write on a ticket route, the school's changed tickets are copied. */
export function withTicketIndex(r: Router): Router {
  const on = r.on.bind(r)
  r.on = (method, pattern, perm, handler: Handler) => {
    if (method === 'GET' || !TICKET_ROUTES.test(pattern)) return on(method, pattern, perm, handler)
    const wrapped: Handler = async (c: Ctx) => {
      const res = await handler(c)
      if (res.status < 400) {
        const school = UUIDISH.test(c.params.school ?? '') ? c.params.school : c.id?.institution?.id
        if (school) await syncSchoolById(c.env, school).catch((err) => console.error('ticket index', err))
      }
      return res
    }
    return on(method, pattern, perm, wrapped)
  }
  return r
}

/* --- the breach alert, every 15 minutes (services/cron.ts) --- */

/** Who is told about a ticket: the agent who holds it, else every active support and seller-admin account. */
async function recipients(env: Env, agentId: string | null): Promise<string[]> {
  if (agentId) {
    const a = await env.CONTROL.prepare(`SELECT id FROM platform_users WHERE id = ? AND status = 'active'`).bind(agentId).first<{ id: string }>()
    if (a) return [a.id]
  }
  const r = await env.CONTROL.prepare(`SELECT DISTINCT u.id FROM platform_users u JOIN platform_user_roles ur ON ur.user_id = u.id
      WHERE u.status = 'active' AND ur.role_key IN ('support_admin', 'seller_admin') LIMIT 25`).all<{ id: string }>()
  return r.results.map((x) => x.id)
}

/** One note per person per ticket per kind of breach: source_key is unique per person, and the index row remembers it was sent. */
export async function alertBreaches(env: Env, nowMs = Date.now()): Promise<number> {
  const policy = await slaPolicy(env)
  const plans = await plansBySchool(env)
  const rows = (await env.CONTROL.prepare(`SELECT * FROM support_ticket_index WHERE status NOT IN ('resolved','closed') AND (breach_alerted_at IS NULL OR (response_alerted_at IS NULL AND acknowledged_at IS NULL))`)
    .all<IndexRow>()).results
  let sent = 0
  const at = new Date(nowMs).toISOString()
  for (const t of rows) {
    const k = clockOf(t, policy, plans.get(t.institution_id) ?? { code: '', tier: null }, nowMs)
    const kinds: ('response' | 'resolve')[] = []
    if (!t.acknowledged_at && !t.response_alerted_at && k.response_breached) kinds.push('response')
    if (!t.breach_alerted_at && k.breached) kinds.push('resolve')
    if (!kinds.length) continue
    const to = await recipients(env, t.agent_id)
    const stmts: D1PreparedStatement[] = []
    for (const kind of kinds) {
      const title = kind === 'response' ? `No first reply in time: ${t.school}` : `Past the promised time: ${t.school}`
      const body = kind === 'response' ? `"${t.subject}" was promised a first reply within ${k.response_promised_hours} working hours.` : `"${t.subject}" was promised an answer within ${k.promised_hours} working hours.`
      for (const u of to) {
        stmts.push(env.CONTROL.prepare(`INSERT OR IGNORE INTO platform_notifications (id, user_id, kind, title, body, link, source_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), u, `support.sla.${kind}`, title, body, '/go/support/support', `sla:${kind}:${t.institution_id}:${t.ticket_id}`, at))
      }
      stmts.push(env.CONTROL.prepare(`UPDATE support_ticket_index SET ${kind === 'response' ? 'response_alerted_at' : 'breach_alerted_at'} = ? WHERE institution_id = ? AND ticket_id = ?`)
        .bind(at, t.institution_id, t.ticket_id))
      sent++
    }
    await env.CONTROL.batch(stmts)
  }
  return sent
}

registerJob('support:sla_breach', async (env) => { await alertBreaches(env) })
registerJob('support:index_resync', async (env) => {
  const insts = await env.CONTROL.prepare(`SELECT * FROM institutions WHERE status = 'active' ORDER BY name`).all<Institution>()
  const policy = await slaPolicy(env)
  for (const inst of insts.results) await syncSchoolTickets(env, inst, { full: true, policy })
})
