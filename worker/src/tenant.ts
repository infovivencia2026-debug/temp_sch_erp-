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
  country: string
  accent_color: string | null
  tagline: string | null
  login_headline: string | null
  login_message: string | null
  support_email: string | null
  support_phone: string | null
  custom_domain: string | null
  teacher_day_code_secret: ArrayBuffer | null
  d1_database_id: string
  d1_binding: string
}

/** The school's row in CONTROL, or null. Small and read on every request. */
export async function institutionById(env: Env, id: string): Promise<Institution | null> {
  return env.CONTROL.prepare('SELECT * FROM institutions WHERE id = ?').bind(id).first<Institution>()
}

/** The school at /<country>/<slug>, the address its sign-in page lives at. */
export async function institutionByPath(env: Env, country: string, slug: string): Promise<Institution | null> {
  return env.CONTROL.prepare('SELECT * FROM institutions WHERE country = ? AND slug = ?')
    .bind(country.toLowerCase(), slug).first<Institution>()
}

/** The school whose own domain this is, or null on the shared hosts. */
export async function institutionByHost(env: Env, host: string | null): Promise<Institution | null> {
  if (!host) return null
  return env.CONTROL.prepare('SELECT * FROM institutions WHERE custom_domain = ? COLLATE NOCASE')
    .bind(host.toLowerCase().replace(/:\d+$/, '')).first<Institution>()
}

/** Where a school's sign-in page lives on the shared host. */
export const schoolPath = (i: Pick<Institution, 'country' | 'slug'>) => `/${i.country}/${i.slug}`

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
