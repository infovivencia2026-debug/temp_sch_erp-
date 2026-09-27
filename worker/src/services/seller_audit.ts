import type { Env } from '../env'
import type { Ctx, Handler, Router } from '../router'
import { HttpError } from '../http'

/* The register of what the vendor's people did: every write by a seller,
   support or platform account (seller routes, /admin/platform, anything done
   inside a school while acting as it, restores, feature switches, billing).
   CONTROL.seller_audit is append-only: nothing here updates or deletes, no
   route does, and triggers in the schema refuse it.

   Recorded in two ways:
   - withSellerAudit(router) wraps every route once, at registration. A write
     (not GET) by a platform account records one row after the handler runs,
     whatever the outcome, with the request body (secrets redacted) as the
     "after" summary and the school taken from the path or the acting header.
   - auditDetail(c, ...) lets a handler that knows more (the real target
     school, the state before) enrich that same row, and recordSellerAction()
     writes a row directly where no request is involved (jobs). */

export interface AuditEntry {
  actor_id: string
  actor_name?: string | null
  actor_roles?: string[]
  acting_as?: boolean
  method: string
  path: string
  route?: string | null
  action: string
  institution_id?: string | null
  institution_name?: string | null
  target?: string | null
  before?: unknown
  after?: unknown
  status?: number | null
  ip?: string | null
}

export interface AuditDetail {
  action?: string
  institution_id?: string | null
  institution_name?: string | null
  target?: string | null
  before?: unknown
  after?: unknown
}

const SECRET = /pass(word)?|secret|token|api_?key|private|pepper|credential|otp|pin$/i
const MAX_SUMMARY = 4000

/** Drops secrets and caps the size: the register is for reading, not replaying. */
export function redact(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '…' : v
  if (typeof v !== 'object') return v
  if (depth > 4) return '…'
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET.test(k) ? '[redacted]' : redact(x, depth + 1)
  return out
}

function summary(v: unknown): string | null {
  if (v === undefined || v === null) return null
  const s = typeof v === 'string' ? v : JSON.stringify(redact(v))
  return s.length > MAX_SUMMARY ? s.slice(0, MAX_SUMMARY) + '…' : s
}

export async function recordSellerAction(env: Env, e: AuditEntry): Promise<void> {
  try {
    let name = e.institution_name ?? null
    if (e.institution_id && !name) {
      const r = await env.CONTROL.prepare(`SELECT name FROM institutions WHERE id = ?`).bind(e.institution_id).first<{ name: string }>()
      name = r?.name ?? null
    }
    await env.CONTROL.prepare(`INSERT INTO seller_audit (id, at, actor_id, actor_name, actor_roles, acting_as, method, path, route, action,
        institution_id, institution_name, target, before_summary, after_summary, status, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), new Date().toISOString(), e.actor_id, e.actor_name ?? null, (e.actor_roles ?? []).join(','),
        e.acting_as ? 1 : 0, e.method, e.path, e.route ?? null, e.action, e.institution_id ?? null, name, e.target ?? null,
        summary(e.before), summary(e.after), e.status ?? null, e.ip ?? null).run()
  } catch (err) {
    // Never lose the action because the register failed; say so loudly.
    console.error('seller audit: not recorded', e.action, err)
  }
}

const details = new WeakMap<Ctx, AuditDetail>()

/** Called by a handler to tell the router-level recorder what it knows. Merged into the one row. */
export function auditDetail(c: Ctx, d: AuditDetail): void {
  details.set(c, { ...(details.get(c) ?? {}), ...d })
}

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Paths whose {id}/{instID} is a school. */
const SCHOOL_PARAM: [RegExp, string][] = [
  [/^\/seller\/tenants\/\{id\}/, 'id'],
  [/\{instID\}/, 'instID'],
]

/** "PUT /seller/tenants/{id}/subscription" -> "seller.tenants.subscription.put". */
function actionName(method: string, pattern: string): string {
  const parts = pattern.split('/').filter((p) => p && !p.startsWith('{'))
  return [...parts, method.toLowerCase()].join('.')
}

async function bodySummary(req: Request): Promise<unknown> {
  const type = req.headers.get('content-type') ?? ''
  const len = Number(req.headers.get('content-length') ?? '0')
  if (!type.includes('json')) return type ? { content_type: type.split(';')[0], bytes: len || undefined } : null
  if (len > 64 * 1024) return { bytes: len }
  try {
    const t = await req.clone().text()
    return t ? JSON.parse(t) : null
  } catch { return null }
}

/** The router-level recorder. Call once on the Router before anything registers. */
export function withSellerAudit(r: Router): Router {
  const on = r.on.bind(r)
  r.on = (method, pattern, perm, handler: Handler) => {
    if (method === 'GET') return on(method, pattern, perm, handler)
    const wrapped: Handler = async (c) => {
      if (!c.id?.platformAdmin) return handler(c)
      const body = await bodySummary(c.req)
      let status = 500
      try {
        const res = await handler(c)
        status = res.status
        return res
      } catch (err) {
        status = err instanceof HttpError ? err.status : 500
        throw err
      } finally {
        const d = details.get(c) ?? {}
        let inst = d.institution_id
        if (inst === undefined) {
          for (const [re, key] of SCHOOL_PARAM) if (re.test(pattern) && UUIDISH.test(c.params[key] ?? '')) { inst = c.params[key]; break }
        }
        const acting = !!c.id.institution && !pattern.startsWith('/seller') && !pattern.startsWith('/admin/platform')
        if (inst === undefined && c.id.institution) inst = c.id.institution.id
        await recordSellerAction(c.env, {
          actor_id: c.id.userId, actor_name: c.id.fullName, actor_roles: c.id.roles, acting_as: acting,
          method, path: c.url.pathname, route: pattern, action: d.action ?? (acting ? 'acting_as.' : '') + actionName(method, pattern),
          institution_id: inst ?? null, institution_name: d.institution_name ?? (inst && c.id.institution?.id === inst ? c.id.institution.name : null),
          target: d.target ?? (Object.keys(c.params).length ? JSON.stringify(c.params) : null),
          before: d.before, after: d.after !== undefined ? d.after : body, status,
          ip: c.req.headers.get('cf-connecting-ip'),
        })
      }
    }
    return on(method, pattern, perm, wrapped)
  }
  return r
}

// --- reading ---------------------------------------------------------------------

export interface AuditFilter {
  institution_id?: string | null
  actor?: string | null
  action?: string | null
  from?: string | null
  to?: string | null
  q?: string | null
  limit: number
  offset: number
}

export async function listSellerAudit(env: Env, f: AuditFilter): Promise<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number }> {
  const where: string[] = []
  const args: unknown[] = []
  if (f.institution_id) { where.push('institution_id = ?'); args.push(f.institution_id) }
  if (f.actor) { where.push('(actor_id = ? OR actor_name LIKE ?)'); args.push(f.actor, `%${f.actor}%`) }
  if (f.action) { where.push('action LIKE ?'); args.push(`${f.action}%`) }
  if (f.from) { where.push('at >= ?'); args.push(f.from) }
  if (f.to) { where.push('at < ?'); args.push(f.to.length === 10 ? f.to + 'T23:59:59.999Z' : f.to) }
  if (f.q) { where.push('(path LIKE ? OR target LIKE ? OR after_summary LIKE ? OR institution_name LIKE ?)'); const q = `%${f.q}%`; args.push(q, q, q, q) }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const [rows, total] = await Promise.all([
    env.CONTROL.prepare(`SELECT * FROM seller_audit ${w} ORDER BY at DESC LIMIT ? OFFSET ?`).bind(...args, f.limit, f.offset).all<Record<string, unknown>>(),
    env.CONTROL.prepare(`SELECT count(*) AS n FROM seller_audit ${w}`).bind(...args).first<{ n: number }>(),
  ])
  const items = (rows.results ?? []).map((r) => ({ ...r, acting_as: r.acting_as === 1 }))
  return { items, total: total?.n ?? 0, limit: f.limit, offset: f.offset }
}
