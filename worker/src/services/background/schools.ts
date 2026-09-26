import type { Env } from '../../env'
import { institutionById, tenantDb, type Institution } from '../../tenant'
import type { Job } from '../jobs'
import { SkipRetry } from '../jobs'

/* Shared by the background jobs: which schools exist, and the one a
   per-school job belongs to. The Go jobs ran "AsPlatform" across every
   institution in one query; here every school is its own D1 database, so a
   global sweep is a loop over CONTROL.institutions. */

/** Active schools, oldest first (the Go cron's order: the oldest school's
    timezone is the clock for global entries). */
export async function activeSchools(env: Env): Promise<Institution[]> {
  const r = await env.CONTROL.prepare(
    `SELECT * FROM institutions WHERE status = 'active' ORDER BY created_at`).all<Institution>()
  return r.results ?? []
}

/** Runs fn for every active school; one school failing does not stop the
    others, and the first error is rethrown at the end so the job retries. */
export async function forEachSchool(env: Env, fn: (inst: Institution, db: D1Database) => Promise<void>): Promise<void> {
  let first: unknown = null
  for (const inst of await activeSchools(env)) {
    try {
      await fn(inst, tenantDb(env, inst))
    } catch (err) {
      console.error('sweep failed for school', inst.slug, err)
      first ??= err
    }
  }
  if (first) throw first
}

/** The school a per-institution job runs for: job.institution_id, or the
    Go envelope's payload.institution_id. */
export async function jobSchool(env: Env, job: Job<any>): Promise<{ inst: Institution; db: D1Database }> {
  const id = job.institution_id ?? job.payload?.institution_id
  if (!id) throw new SkipRetry(`${job.type}: no institution_id`)
  const inst = await institutionById(env, id)
  if (!inst) throw new SkipRetry(`${job.type}: unknown institution ${id}`)
  return { inst, db: tenantDb(env, inst) }
}

/** ISO instant `days` ago. */
export const daysAgo = (days: number, from = Date.now()) => new Date(from - days * 86400_000).toISOString()

/** The calendar date (YYYY-MM-DD) in a timezone, `offsetDays` from now. */
export function localDate(tz: string, offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400_000)
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  } catch {
    return d.toISOString().slice(0, 10)
  }
}
