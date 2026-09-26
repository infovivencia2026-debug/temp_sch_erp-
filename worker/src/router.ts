import type { Env } from './env'
import type { Identity } from './identity'

export interface Ctx {
  req: Request
  env: Env
  url: URL
  params: Record<string, string>
  /** Present on every route registered with a permission or `auth`. */
  id: Identity
  /** The school's D1 database. Throws for a platform admin who is not acting as a school. */
  db: D1Database
}

export type Handler = (c: Ctx) => Promise<Response> | Response
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface Route { method: Method; re: RegExp; keys: string[]; perm: string | 'auth'; handler: Handler }

/* Chi-style patterns: "/students/{id}/profile". A trailing "*" matches the rest. */
function compile(pattern: string): { re: RegExp; keys: string[] } {
  const keys: string[] = []
  const src = pattern.replace(/\{([a-zA-Z_]+)\}/g, (_, k) => { keys.push(k); return '([^/]+)' }).replace(/\*$/, '(.*)')
  return { re: new RegExp('^' + src + '/?$'), keys }
}

export class Router {
  private routes: Route[] = []
  constructor(private prefix = '/api/v1') {}

  /** Registers a route. `perm` is an rbac permission key, or 'auth' for any signed-in user. */
  on(method: Method, pattern: string, perm: string | 'auth', handler: Handler): this {
    const { re, keys } = compile(this.prefix + pattern)
    this.routes.push({ method, re, keys, perm, handler })
    return this
  }
  get(p: string, perm: string | 'auth', h: Handler) { return this.on('GET', p, perm, h) }
  post(p: string, perm: string | 'auth', h: Handler) { return this.on('POST', p, perm, h) }
  put(p: string, perm: string | 'auth', h: Handler) { return this.on('PUT', p, perm, h) }
  patch(p: string, perm: string | 'auth', h: Handler) { return this.on('PATCH', p, perm, h) }
  del(p: string, perm: string | 'auth', h: Handler) { return this.on('DELETE', p, perm, h) }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue
      const m = route.re.exec(pathname)
      if (!m) continue
      const params: Record<string, string> = {}
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]) })
      return { route, params }
    }
    return null
  }
}
