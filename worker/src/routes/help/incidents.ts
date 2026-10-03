/* KNOWN ISSUES AND REPORTS, at the desk.

   A known issue (CONTROL.help_incidents) is a fault the desk already knows
   about: a title, the routes and request topics it touches, the schools it
   affects (none listed: every school) and what to do until it is fixed.
   Marking one links the open help requests that match it, gives each the
   workaround in its thread, and, when asked, puts a banner in front of the
   affected schools through the existing Announcements (platform_broadcasts).
   New requests that match are linked as they arrive (requests.ts).

   Reports read every school's tickets for a window: per school, top topics
   and screens, first-reply and answer times, satisfaction, deflection (help
   requests answered without reaching the vendor), and error references per
   school and screen by release. ?format=csv gives the per-school table. */
import type { Ctx, Router } from '../../router'
import { badRequest, created, notFound, now, ok, readJSON, uuid } from '../../http'
import { SUPPORT_DESK } from '../../identity'
import { tenantDb, type Institution } from '../../tenant'
import { platformOnly } from '../admin/common'
import { auditDetail } from '../../services/seller_audit'
import { incidentFor, incidentRow, type Incident } from './incidents_match'
import { HELP, updateStmt } from './shared'

async function schools(c: Ctx): Promise<{ inst: Institution; db: D1Database }[]> {
  const rows = await c.env.CONTROL.prepare(`SELECT * FROM institutions WHERE status = 'active' ORDER BY name`).all<Institution>()
  const out: { inst: Institution; db: D1Database }[] = []
  for (const inst of rows.results) { try { out.push({ inst, db: tenantDb(c.env, inst) }) } catch { /* not provisioned */ } }
  return out
}

const strings = (v: unknown, max = 30): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, max) : [])

/** Links the open requests matching an incident and writes the workaround into each; returns how many. */
async function linkOpen(c: Ctx, inc: Incident): Promise<number> {
  let n = 0
  for (const s of await schools(c)) {
    if (inc.institution_ids.length && !inc.institution_ids.includes(s.inst.id)) continue
    const rows = await s.db.prepare(`SELECT id, category, route, audience FROM support_tickets WHERE origin = '${HELP}' AND incident_id IS NULL AND status NOT IN ('resolved', 'closed')`)
      .all<{ id: string; category: string; route: string | null; audience: string }>()
    const hit = rows.results.filter((t) => incidentFor([inc], { institutionId: s.inst.id, category: t.category, route: t.route }))
    if (!hit.length) continue
    await s.db.batch(hit.flatMap((t) => [
      s.db.prepare(`UPDATE support_tickets SET incident_id = ?, updated_at = ? WHERE id = ?`).bind(inc.id, now(), t.id),
      updateStmt(s.db, s.inst.id, t.id, { kind: 'known_issue', side: t.audience === 'vendor' ? 'vendor' : 'school', authorId: null, authorName: 'Known issue', body: `${inc.title}\n${inc.workaround}`, visible: true }),
    ]))
    n += hit.length
  }
  return n
}

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const hoursBetween = (a: string, b: string) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 3_600_000)
const round1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10)

export function registerIncidents(r: Router): void {
  r.get('/admin/platform/incidents', SUPPORT_DESK, async (c) => {
    platformOnly(c)
    const rows = await c.env.CONTROL.prepare(`SELECT * FROM help_incidents ORDER BY status = 'open' DESC, created_at DESC LIMIT 100`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(incidentRow) })
  })

  r.post('/admin/platform/incidents', SUPPORT_DESK, async (c) => {
    platformOnly(c)
    const req = await readJSON<{ title?: string; workaround?: string; routes?: string[]; categories?: string[]; institution_ids?: string[]; banner?: boolean }>(c.req)
    const title = String(req.title ?? '').trim(), workaround = String(req.workaround ?? '').trim()
    if (!title || !workaround) throw badRequest('a known issue needs a title and what to do until it is fixed')
    const routes = strings(req.routes).filter((x) => x.startsWith('/')), categories = strings(req.categories), ids = strings(req.institution_ids, 200)
    if (!routes.length && !categories.length) throw badRequest('name at least one screen or one request topic it affects')
    const id = uuid(), t = now()
    let broadcast: string | null = null
    const stmts = [c.env.CONTROL.prepare(`INSERT INTO help_incidents (id, title, workaround, routes, categories, institution_ids, status, created_at, created_by, created_by_name) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
      .bind(id, title, workaround, JSON.stringify(routes), JSON.stringify(categories), JSON.stringify(ids), t, c.id.userId, c.id.fullName)]
    if (req.banner) {
      broadcast = uuid()
      stmts.push(
        c.env.CONTROL.prepare(`INSERT INTO platform_broadcasts (id, severity, title, body, starts_at, created_by, created_at) VALUES (?, 'warning', ?, ?, ?, ?, ?)`).bind(broadcast, title, workaround, t, c.id.userId, t),
        c.env.CONTROL.prepare(`INSERT INTO platform_broadcast_targets (broadcast_id, target_kind, target_ids, updated_at) VALUES (?, ?, ?, ?)`).bind(broadcast, ids.length ? 'schools' : 'all', JSON.stringify(ids), t),
        c.env.CONTROL.prepare(`UPDATE help_incidents SET broadcast_id = ? WHERE id = ?`).bind(broadcast, id),
      )
    }
    await c.env.CONTROL.batch(stmts)
    const inc = incidentRow((await c.env.CONTROL.prepare(`SELECT * FROM help_incidents WHERE id = ?`).bind(id).first<Record<string, unknown>>())!)
    const linked = await linkOpen(c, inc)
    if (linked) await c.env.CONTROL.prepare(`UPDATE help_incidents SET linked = linked + ? WHERE id = ?`).bind(linked, id).run()
    auditDetail(c, { action: 'incident.open', target: id, after: { title, linked, banner: !!broadcast } })
    return created({ id, linked, broadcast_id: broadcast ?? undefined })
  })

  r.post('/admin/platform/incidents/{id}/resolve', SUPPORT_DESK, async (c) => {
    platformOnly(c)
    const inc = await c.env.CONTROL.prepare(`SELECT * FROM help_incidents WHERE id = ? AND status = 'open'`).bind(c.params.id).first<Record<string, unknown>>()
    if (!inc) throw notFound()
    const t = now()
    await c.env.CONTROL.batch([
      c.env.CONTROL.prepare(`UPDATE help_incidents SET status = 'resolved', resolved_at = ? WHERE id = ?`).bind(t, c.params.id),
      ...(inc.broadcast_id ? [c.env.CONTROL.prepare(`UPDATE platform_broadcasts SET retired_at = ? WHERE id = ? AND retired_at IS NULL`).bind(t, inc.broadcast_id)] : []),
    ])
    auditDetail(c, { action: 'incident.resolve', target: c.params.id })
    return ok({ status: 'resolved' })
  })

  r.get('/admin/platform/help-reports', SUPPORT_DESK, async (c) => {
    platformOnly(c)
    const days = Math.min(365, Math.max(1, Number(c.url.searchParams.get('days')) || 30))
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    const per: Record<string, unknown>[] = []
    const cats = new Map<string, number>(), routes = new Map<string, number>()
    const firsts: number[] = [], answers: number[] = []
    let helpful = 0, rated = 0, fromPeople = 0, keptInSchool = 0
    for (const s of await schools(c)) {
      const rows = await s.db.prepare(`SELECT t.id, t.audience, t.category, t.route, t.created_at, t.acknowledged_at, t.resolved_at, t.satisfaction, t.solved_by, t.parent_ticket_id,
          EXISTS (SELECT 1 FROM support_tickets e WHERE e.parent_ticket_id = t.id) AS escalated
        FROM support_tickets t WHERE t.origin = '${HELP}' AND t.created_at >= ?`).bind(since)
        .all<{ id: string; audience: string; category: string; route: string | null; created_at: string; acknowledged_at: string | null; resolved_at: string | null; satisfaction: number | null; solved_by: string | null; parent_ticket_id: string | null; escalated: number }>()
        .catch(() => ({ results: [] as never[] }))
      let n = 0, toVendor = 0, open = 0
      for (const t of rows.results) {
        if (t.parent_ticket_id) continue // an escalation is the same request, counted once
        n++
        if (t.audience === 'vendor') toVendor++
        if (!t.resolved_at) open++
        cats.set(t.category, (cats.get(t.category) ?? 0) + 1)
        if (t.route) routes.set(t.route, (routes.get(t.route) ?? 0) + 1)
        if (t.acknowledged_at) firsts.push(hoursBetween(t.created_at, t.acknowledged_at))
        if (t.resolved_at) answers.push(hoursBetween(t.created_at, t.resolved_at))
        if (t.satisfaction !== null) { rated++; if (t.satisfaction >= 4) helpful++ }
        if (t.audience === 'helpdesk') { fromPeople++; if (t.escalated) toVendor++; else if (t.resolved_at) keptInSchool++ }
      }
      per.push({ school: s.inst.name, institution_id: s.inst.id, requests: n, reached_vendor: toVendor, open })
    }
    // Error references per school and screen, by release, in the window (kept 14 days).
    const errs = await c.env.CONTROL.prepare(`SELECT e.institution_id, i.name AS school, e.route, COALESCE(e.release, 'unknown') AS release, count(*) AS n, max(e.at) AS last_at
        FROM error_refs e LEFT JOIN institutions i ON i.id = e.institution_id WHERE e.at >= ? GROUP BY 1, 2, 3, 4 ORDER BY n DESC LIMIT 30`).bind(since)
      .all<Record<string, unknown>>().catch(() => ({ results: [] }))
    const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([key, count]) => ({ key, count }))
    const body = {
      days, schools: per,
      top_categories: top(cats), top_routes: top(routes),
      first_reply_hours_median: round1(median(firsts)), resolve_hours_median: round1(median(answers)),
      satisfaction: rated ? { helpful, rated, percent: Math.round((helpful * 100) / rated) } : null,
      /* Of the requests families and staff raised, how many the school answered without passing them on. */
      deflection: fromPeople ? { solved_in_school: keptInSchool, raised: fromPeople, percent: Math.round((keptInSchool * 100) / fromPeople) } : null,
      error_spikes: errs.results,
    }
    if (c.url.searchParams.get('format') === 'csv') {
      const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
      const csv = ['School,Requests,Reached XULO support,Still open', ...per.map((p) => [p.school, p.requests, p.reached_vendor, p.open].map(q).join(','))].join('\r\n')
      return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="help-requests-${days}-days.csv"`, 'cache-control': 'no-store' } })
    }
    return ok(body)
  })
}
