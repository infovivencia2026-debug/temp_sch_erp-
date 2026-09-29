import type { Env } from './env'
import type { Identity } from './identity'

/* THE IDENTITY CACHE.

   Resolving who is calling costs several D1 round trips: the session and the
   school in CONTROL, the user, roles and permissions in the school's
   database, then the subscription and feature overrides in CONTROL for the
   gates. None of it changes between one click and the next, so each isolate
   keeps the result for up to TTL_MS, keyed by the session token's hash and
   the school acted in (X-Acting-Institution).

   Every request still reads its session row, in one CONTROL batch together
   with the cache versions (identity.ts), so a signed-out or expired session
   is refused at once on every isolate. The versions are counters in CONTROL
   (cache_versions): one per school, bumped when a request changes users,
   roles or permissions in that school's database (watchAuthWrites, called
   from index.ts), and one for the platform ('*'), bumped by any write a
   platform account makes (plans, subscriptions, overrides, school status,
   board memberships). A cached identity whose versions differ is thrown
   away. Writes that bypass a request (background jobs) are bounded by the
   TTL. */

export const TTL_MS = 45_000

/** IDENTITY_CACHE_TTL_SECONDS overrides the lifetime; "0" turns the cache off (the integration tests, which edit roles straight in D1). */
export function cacheTtl(env: Env): number {
  const v = env.IDENTITY_CACHE_TTL_SECONDS
  if (typeof v !== 'string' || v.trim() === '') return TTL_MS
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 60) * 1000 : TTL_MS
}
const MAX_ENTRIES = 1000

export const PLATFORM_SCOPE = '*'

interface Entry {
  at: number
  /** "<platform version>/<school version>/<acting school version>", as read with the session. */
  versions: string
  sessionId: string
  id: Identity
}

const entries = new Map<string, Entry>()

export const cacheKey = (tokenHash: string, acting: string | null) => tokenHash + '|' + (acting ?? '')

export function cached(key: string, versions: string, sessionId: string, ttl = TTL_MS): Identity | null {
  const e = entries.get(key)
  if (!e) return null
  if (Date.now() - e.at > ttl || e.versions !== versions || e.sessionId !== sessionId) {
    entries.delete(key)
    return null
  }
  // Least recently used goes first: re-inserting moves the key to the end.
  entries.delete(key)
  entries.set(key, e)
  return e.id
}

export function remember(key: string, versions: string, id: Identity): void {
  entries.delete(key)
  entries.set(key, { at: Date.now(), versions, sessionId: id.sessionId, id })
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string)
}

/** Drops every cached identity of a session (sign-out, idle expiry) in this isolate. */
export function forgetSession(sessionId: string): void {
  for (const [k, e] of entries) if (e.sessionId === sessionId) entries.delete(k)
}

/** Drops every cached identity in this isolate (tests). */
export function forgetAll(): void {
  entries.clear()
}

/* --- per-identity memo: entitlement and feature overrides ------------------------
   Stored on the Identity object itself (a cached identity is reused across
   requests), so the gates' CONTROL reads happen once per cache lifetime. */

const memo = new WeakMap<Identity, Map<string, Promise<unknown>>>()

export function memoFor<T>(id: Identity | null | undefined, key: string, load: () => Promise<T>): Promise<T> {
  if (!id || typeof id !== 'object') return load()
  let m = memo.get(id)
  if (!m) { m = new Map(); memo.set(id, m) }
  let p = m.get(key) as Promise<T> | undefined
  if (!p) {
    p = load()
    m.set(key, p)
    p.catch(() => m!.delete(key))
  }
  return p
}

/* --- versions ---------------------------------------------------------------------- */

const CREATE = `CREATE TABLE IF NOT EXISTS cache_versions (scope TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, updated_at TEXT)`

/** The statement reading the versions a cached identity depends on (batched with the session). */
export function versionsStmt(env: Env, tokenHash: string, acting: string | null): D1PreparedStatement {
  return env.CONTROL.prepare(`SELECT scope, version FROM cache_versions
      WHERE scope = ?1 OR scope = (SELECT institution_id FROM sessions WHERE token_hash = ?2) OR scope = ?3`)
    .bind(PLATFORM_SCOPE, tokenHash, acting ?? '')
}

/** The versions row set as the string an entry is compared by. */
export function versionString(rows: { scope: string; version: number }[], home: string | null, acting: string | null): string {
  const v = (s: string | null) => (s ? rows.find((r) => r.scope === s)?.version ?? 0 : 0)
  return `${v(PLATFORM_SCOPE)}/${v(home)}/${v(acting)}`
}

let tableReady = false

/** Creates cache_versions if this CONTROL database predates it (migrations/control adds it too). */
export async function ensureVersionsTable(env: Env): Promise<void> {
  if (tableReady) return
  await env.CONTROL.prepare(CREATE).run()
  tableReady = true
}

/** Invalidates every cached identity of a school ('*': of every school) on every isolate. */
export async function bumpVersion(env: Env, scope: string): Promise<void> {
  entries.clear()
  const up = () => env.CONTROL.prepare(`INSERT INTO cache_versions (scope, version, updated_at) VALUES (?1, 1, ?2)
      ON CONFLICT(scope) DO UPDATE SET version = version + 1, updated_at = ?2`).bind(scope, new Date().toISOString()).run()
  try { await up() } catch { await ensureVersionsTable(env); await up() }
}

/* --- noticing writes that change who may do what ----------------------------------- */

const AUTH_WRITE = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?(?:users|user_roles|roles|role_permissions|user_permissions)["`]?(?:\s|\(|$)/i

export const touchesAuth = (sql: string) => AUTH_WRITE.test(sql)

/** The school database with its writes watched: dirty() is true once a statement changed users, roles or permissions. */
export function watchAuthWrites(db: D1Database): { db: D1Database; dirty: () => boolean } {
  let dirty = false
  const note = (sql: string) => { if (!dirty && touchesAuth(sql)) dirty = true }
  // A plain object, not a Proxy: the D1 binding is a native object whose methods need their own receiver.
  const wrapped = Object.create(db) as D1Database & Record<string | symbol, unknown>
  for (const k of Object.getOwnPropertySymbols(db)) wrapped[k] = (db as unknown as Record<symbol, unknown>)[k]
  wrapped.prepare = (sql: string) => { note(sql); return db.prepare(sql) }
  wrapped.batch = <T = unknown>(stmts: D1PreparedStatement[]) => db.batch<T>(stmts)
  wrapped.exec = (sql: string) => { note(sql); return db.exec(sql) }
  wrapped.dump = () => db.dump()
  if (typeof (db as { withSession?: unknown }).withSession === 'function') wrapped.withSession = ((c?: string) => db.withSession(c)) as D1Database['withSession']
  return { db: wrapped, dirty: () => dirty }
}
