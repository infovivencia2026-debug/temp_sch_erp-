import type { Ctx } from '../../router'
import { badRequest } from '../../http'
import { tenantDb, type Institution } from '../../tenant'

/* Shared by the connectors, gateway, signal and index ports: the Go handlers
   read "AsPlatform" across every school in one Postgres; here each active
   school in CONTROL is opened by its own D1 binding. A school with no binding
   yet is returned with db = null so aggregate screens can still list it. */

export const VENDOR = 'platform.tenants.write'

export interface FleetSchool { inst: Institution; db: D1Database | null }

/** Every active school, ordered by name, with its database when it is provisioned. */
export async function fleetAll(c: Ctx): Promise<FleetSchool[]> {
  const insts = await c.env.CONTROL.prepare(`SELECT * FROM institutions WHERE status = 'active' ORDER BY name`).all<Institution>()
  return insts.results.map((inst) => {
    let db: D1Database | null = null
    try { db = tenantDb(c.env, inst) } catch { /* not provisioned */ }
    return { inst, db }
  })
}

/** Go's t.Format(time.RFC3339) over a stored ISO timestamp: second precision, UTC. */
export function rfc3339(s: unknown): string | undefined {
  if (typeof s !== 'string' || s === '') return undefined
  const t = Date.parse(s.includes('T') || s.length <= 10 ? s : s.replace(' ', 'T'))
  if (Number.isNaN(t)) return s
  return new Date(t).toISOString().slice(0, 19) + 'Z'
}

/** Today's date in India (the Go server's CURRENT_DATE), YYYY-MM-DD. */
export function indiaToday(): string {
  return new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10)
}

/** Midnight of an India date, as the UTC ISO instant stored timestamps compare against. */
export function indiaMidnightUTC(day: string): string {
  return new Date(Date.parse(day + 'T00:00:00+05:30')).toISOString()
}

/**
 * The database that holds the vendor-scoped rows (installation defaults with
 * a NULL institution_id included). Postgres had one shared table; here those
 * rows live in the acting school's database, the same choice statutory.ts
 * made for child_info_portal_connectors. With no school chosen there is no
 * database to read, which is said rather than guessed.
 */
export function actingDb(c: Ctx): D1Database {
  if (!c.id.institution) throw badRequest('choose the school to configure first')
  return c.db
}
