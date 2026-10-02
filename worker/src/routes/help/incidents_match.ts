import type { Env } from '../../env'
import { routeShape } from '../../services/error_refs'

/* Known issues (CONTROL.help_incidents): a fault the desk already knows about,
   with what to do until it is fixed. A new request that matches an open one
   by route or category, in a school it affects, is given the workaround at
   once and linked to it. The desk marks and resolves them (incidents.ts). */

export interface Incident {
  id: string; title: string; workaround: string; routes: string[]; categories: string[]; institution_ids: string[]
  status: string; broadcast_id: string | null; linked: number; created_at: string; created_by_name: string | null; resolved_at: string | null
}

const list = (raw: unknown): string[] => {
  try { const v = JSON.parse(String(raw ?? '[]')); return Array.isArray(v) ? v.map(String) : [] } catch { return [] }
}

export function incidentRow(r: Record<string, unknown>): Incident {
  return { id: String(r.id), title: String(r.title), workaround: String(r.workaround), routes: list(r.routes), categories: list(r.categories),
    institution_ids: list(r.institution_ids), status: String(r.status), broadcast_id: (r.broadcast_id as string | null) ?? null,
    linked: Number(r.linked ?? 0), created_at: String(r.created_at), created_by_name: (r.created_by_name as string | null) ?? null,
    resolved_at: (r.resolved_at as string | null) ?? null }
}

export async function openIncidents(env: Env): Promise<Incident[]> {
  try {
    const rows = await env.CONTROL.prepare(`SELECT * FROM help_incidents WHERE status = 'open' ORDER BY created_at DESC LIMIT 50`).all<Record<string, unknown>>()
    return rows.results.map(incidentRow)
  } catch (e) {
    if (/no such table/.test(String(e))) return []
    throw e
  }
}

/** A screen path matches a pattern when it is the pattern or sits under it; ids are ignored. */
export function routeMatches(route: string | null | undefined, patterns: string[]): boolean {
  if (!route) return false
  const r = routeShape(route.split('?')[0])
  return patterns.some((p) => { const s = routeShape(p.trim().replace(/\/+$/, '')); return s !== '' && (r === s || r.startsWith(s + '/')) })
}

/** The open incident a new request belongs to, if any. A route or a category must match; a school list, when given, must include the school. */
export function incidentFor(incidents: Incident[], o: { institutionId: string; category: string; route?: string | null }): Incident | null {
  for (const i of incidents) {
    if (i.institution_ids.length && !i.institution_ids.includes(o.institutionId)) continue
    if (routeMatches(o.route, i.routes) || i.categories.includes(o.category)) return i
  }
  return null
}
