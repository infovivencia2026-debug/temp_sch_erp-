import type { Env } from '../env'

/* D1 over the Cloudflare REST API.

   A Worker reaches a D1 database through a binding, and bindings are fixed
   at deploy time. A school the seller creates from the console (see
   src/services/provision.ts) has a database before it has a binding, so until
   the next `wrangler deploy` carries its TENANT_<SLUG> binding it is reached
   through https://api.cloudflare.com/.../d1/database/<id>/query instead.
   HttpD1 is enough of the D1Database interface (prepare/bind/first/all/run/
   raw, batch, exec) for every route to run unchanged on top of it.

   Needs the secrets CF_ACCOUNT_ID and CF_API_TOKEN (Account > D1 > Edit). */

export interface Stmt { sql: string; params: unknown[] }
export interface QueryResult { results: Record<string, unknown>[]; success: boolean; meta: Record<string, unknown> }

/** The slice of the Cloudflare API provisioning and HttpD1 use; tests pass a fake. */
export interface CfD1Api {
  /** The database's uuid, or null when no database has that exact name. */
  findDatabase(name: string): Promise<string | null>
  createDatabase(name: string): Promise<string>
  deleteDatabase(id: string): Promise<void>
  /** Runs the statements in order; more than one runs as one batch (a transaction). */
  query(databaseId: string, stmts: Stmt[]): Promise<QueryResult[]>
  /** Many statements in one SQL text, no parameters (schema chunks). */
  exec(databaseId: string, sql: string): Promise<void>
}

export class CfApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** The real API. `fetchFn` is injectable so it can be tested without the network. */
export function cloudflareD1Api(accountId: string, token: string, fetchFn: Fetch = (u, i) => fetch(u, i)): CfD1Api {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetchFn(base + path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
    let body: { success?: boolean; result?: T; errors?: { code?: number; message?: string }[] } = {}
    try { body = await res.json() } catch { /* not JSON */ }
    if (!res.ok || body.success === false) {
      const msg = body.errors?.map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ') || res.statusText
      throw new CfApiError(`Cloudflare API ${init.method ?? 'GET'} d1${path.split('?')[0]}: ${res.status} ${msg}`, res.status)
    }
    return body.result as T
  }
  return {
    async findDatabase(name) {
      const r = await call<{ uuid: string; name: string }[]>(`?name=${encodeURIComponent(name)}&per_page=100`)
      return (r ?? []).find((d) => d.name === name)?.uuid ?? null
    },
    async createDatabase(name) {
      const r = await call<{ uuid: string }>('', { method: 'POST', body: JSON.stringify({ name }) })
      return r.uuid
    },
    async deleteDatabase(id) {
      await call(`/${id}`, { method: 'DELETE' })
    },
    async query(id, stmts) {
      const body = stmts.length === 1 ? { sql: stmts[0].sql, params: stmts[0].params }
        : { batch: stmts.map((s) => ({ sql: s.sql, params: s.params })) }
      return call<QueryResult[]>(`/${id}/query`, { method: 'POST', body: JSON.stringify(body) })
    },
    async exec(id, sql) {
      await call(`/${id}/query`, { method: 'POST', body: JSON.stringify({ sql }) })
    },
  }
}

/** The API client from the Worker's secrets, or null when they are not set. */
export function cfApiFromEnv(env: Env): CfD1Api | null {
  const acc = env.CF_ACCOUNT_ID, tok = env.CF_API_TOKEN
  return typeof acc === 'string' && acc && typeof tok === 'string' && tok ? cloudflareD1Api(acc, tok) : null
}

/* D1 binds booleans as 0/1 and undefined as an error; the API takes JSON. */
function norm(v: unknown): unknown {
  if (v === undefined) throw new Error('D1_TYPE_ERROR: undefined is not a supported bind value')
  if (typeof v === 'boolean') return v ? 1 : 0
  return v
}

class HttpStatement {
  constructor(readonly db: HttpD1, readonly sql: string, readonly params: unknown[] = []) {}
  bind(...values: unknown[]): HttpStatement { return new HttpStatement(this.db, this.sql, values.map(norm)) }
  stmt(): Stmt { return { sql: this.sql, params: this.params } }
  private async one(): Promise<QueryResult> { return (await this.db.api.query(this.db.id, [this.stmt()]))[0] }
  async first<T = unknown>(col?: string): Promise<T | null> {
    const row = (await this.one()).results?.[0]
    if (!row) return null
    return (col ? (row[col] ?? null) : row) as T
  }
  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const r = await this.one()
    return { results: (r.results ?? []) as T[], success: true, meta: r.meta ?? {} } as unknown as D1Result<T>
  }
  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> { return this.all<T>() }
  async raw<T = unknown[]>(opts?: { columnNames?: boolean }): Promise<T[]> {
    const rows = (await this.one()).results ?? []
    const out = rows.map((r) => Object.values(r)) as unknown as T[]
    if (opts?.columnNames) out.unshift(Object.keys(rows[0] ?? {}) as unknown as T)
    return out
  }
}

export class HttpD1 {
  constructor(readonly api: CfD1Api, readonly id: string) {}
  prepare(sql: string): HttpStatement { return new HttpStatement(this, sql) }
  async batch<T = unknown>(stmts: HttpStatement[]): Promise<D1Result<T>[]> {
    if (stmts.length === 0) return []
    const r = await this.api.query(this.id, stmts.map((s) => s.stmt()))
    return r.map((x) => ({ results: x.results ?? [], success: true, meta: x.meta ?? {} })) as unknown as D1Result<T>[]
  }
  async exec(sql: string): Promise<D1ExecResult> {
    await this.api.exec(this.id, sql)
    return { count: 0, duration: 0 }
  }
  withSession(): this { return this }
  async dump(): Promise<ArrayBuffer> { throw new Error('dump is not available over the D1 HTTP API') }
}

/** A D1Database handle for a database the Worker has no binding for. */
export function httpD1(api: CfD1Api, databaseId: string): D1Database {
  return new HttpD1(api, databaseId) as unknown as D1Database
}

/** tenant.ts's fallback: the school's database over the API, or null without the secrets or an id. */
export function httpTenantDb(env: Env, databaseId: string | null | undefined): D1Database | null {
  if (!databaseId || databaseId.startsWith('local-')) return null
  const api = cfApiFromEnv(env)
  return api ? httpD1(api, databaseId) : null
}
