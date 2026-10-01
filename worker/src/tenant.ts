import type { Env } from './env'
import { httpTenantDb } from './services/d1http'
import { SCHOOL, invalidateRef, noteFeaturesVersion } from './services/refcache'

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
  app_id: string | null
  teacher_day_code_secret: ArrayBuffer | null
  d1_database_id: string
  d1_binding: string
  /** Bumped by CONTROL triggers on any feature-switch change (control migration 0013). */
  features_version?: number
}

/** Every institutions row the Worker reads passes here: the switch version it carries is noted (refcache.ts). */
export function noteInstitution<T extends Institution | null | undefined>(inst: T): T {
  if (inst) noteFeaturesVersion(inst.id, inst.features_version)
  return inst
}

/** The school's row in CONTROL, or null. Small and read on every request. */
export async function institutionById(env: Env, id: string): Promise<Institution | null> {
  return noteInstitution(await env.CONTROL.prepare('SELECT * FROM institutions WHERE id = ?').bind(id).first<Institution>())
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

/** The store id a school's apps get unless the seller sets another: com.wisen.<slug>. */
export const defaultAppId = (i: Pick<Institution, 'slug'>) => `com.wisen.${i.slug.replace(/[^a-z0-9]/g, '')}`.replace(/\.(\d)/, '.s$1')

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
    // A school created from the seller console before a deploy carried its
    // binding: reach it over the D1 HTTP API (services/provision.ts).
    const viaApi = httpTenantDb(env, inst.d1_database_id)
    if (viaApi) return viaApi
    throw new Error(`no D1 binding ${inst.d1_binding} for school ${inst.slug}; run scripts/provision-school.sh and redeploy`)
  }
  return db as D1Database
}

/* --- read replicas and read-after-write ----------------------------------------

   D1 read replication serves reads from a copy near the Worker. A copy can
   lag the primary, so every request runs in a D1 Session
   (db.withSession): reads go to any replica at least as new as the
   bookmark the session starts from, and the session's bookmark after the
   request is handed back to the client in the X-D1-Bookmark header. The web
   app sends the last one it got on its next request (web/src/lib/api.ts), so
   a person always reads their own writes, even on a replica.

   The header carries "<school id>:<bookmark>"; a bookmark for another school
   (the person switched school) is ignored. Without a bookmark a GET starts
   'first-unconstrained' (any replica) and a write 'first-primary'. When
   replication is off for a database, sessions simply read the primary. */

export const BOOKMARK_HEADER = 'X-D1-Bookmark'

export interface TenantSession {
  /** The school's database for this request: reads and writes through the session. */
  db: D1Database
  /** The session's bookmark now, or null (HTTP-API schools, old runtimes). */
  bookmark(): string | null
  /** Adds the bookmark header, and drops this isolate's reference cache after a write. */
  finish(res: Response): Response
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** The bookmark the client sent for this school, or null. */
export function bookmarkFrom(req: Request, schoolId: string): string | null {
  const v = req.headers.get(BOOKMARK_HEADER)
  if (!v) return null
  const i = v.indexOf(':')
  if (i <= 0 || v.slice(0, i) !== schoolId) return null
  const bm = v.slice(i + 1).trim()
  return bm && bm.length <= 512 ? bm : null
}

/** tenantDb for one request, inside a D1 Session that honours the client's bookmark. */
export function tenantSession(env: Env, inst: Institution, req: Request): TenantSession {
  const raw = tenantDb(env, inst)
  const read = READS.has(req.method)
  const constraint = bookmarkFrom(req, inst.id) ?? (read ? 'first-unconstrained' : 'first-primary')
  const withSession = (raw as { withSession?: D1Database['withSession'] }).withSession
  let session: D1DatabaseSession | null = null
  if (typeof withSession === 'function') {
    try { session = withSession.call(raw, constraint) as D1DatabaseSession } catch { session = null }
    // HttpD1 (schools reached over the API) returns itself: no session there.
    if ((session as unknown) === raw) session = null
  }
  const via = session ?? raw
  const db = {
    prepare: (sql: string) => via.prepare(sql),
    batch: <T = unknown>(stmts: D1PreparedStatement[]) => via.batch<T>(stmts),
    exec: (sql: string) => raw.exec(sql),
    dump: () => raw.dump(),
    withSession: (c?: string) => raw.withSession(c),
    [SCHOOL]: inst.id,
  } as unknown as D1Database
  const bookmark = () => {
    try { return session?.getBookmark() ?? null } catch { return null }
  }
  return {
    db,
    bookmark,
    finish(res) {
      if (!read) invalidateRef(inst.id)
      const bm = bookmark()
      if (!bm) return res
      try { res.headers.set(BOOKMARK_HEADER, `${inst.id}:${bm}`); return res } catch {
        const out = new Response(res.body, res) // immutable headers (a fetched Response)
        out.headers.set(BOOKMARK_HEADER, `${inst.id}:${bm}`)
        return out
      }
    },
  }
}
