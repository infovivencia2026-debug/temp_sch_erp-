import type { Env } from './env'

export interface Institution {
  id: string
  name: string
  short_name: string
  slug: string
  status: string
  timezone: string
  locale: string
  primary_color: string
  logo_key: string | null
  teacher_day_code_secret: ArrayBuffer | null
  d1_database_id: string
  d1_binding: string
}

/** The school's row in CONTROL, or null. Small and read on every request. */
export async function institutionById(env: Env, id: string): Promise<Institution | null> {
  return env.CONTROL.prepare('SELECT * FROM institutions WHERE id = ?').bind(id).first<Institution>()
}

/**
 * The school's own database. Isolation is the database boundary: a query on
 * this handle cannot reach another school's rows, so no WHERE institution_id
 * can be forgotten. The binding name is stored on the school's row so the
 * Worker does not have to derive it.
 */
export function tenantDb(env: Env, inst: Institution): D1Database {
  const db = env[inst.d1_binding]
  if (!db || typeof db !== 'object' || !('prepare' in db)) {
    throw new Error(`no D1 binding ${inst.d1_binding} for school ${inst.slug}; run scripts/provision-school.sh and redeploy`)
  }
  return db as D1Database
}
