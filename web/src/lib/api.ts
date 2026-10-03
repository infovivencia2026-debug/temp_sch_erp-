// Thin fetch wrapper around the Go API.
//
// Everything is same-origin: nginx serves this bundle and proxies /api to the
// Go process, so there is no base URL to configure and cookies are sent
// automatically. The one thing worth centralising is the error envelope, which
// the server guarantees is always {error:{code,message,request_id}}.

import type { Api } from '@shared/api'
import type { PathParams, QueryValue } from '@shared/api/contract'
import { takeOffline } from './outbox'
import { noteWrite } from './save-feedback'
import { bootstrapped } from './bootstrap'
import { noteFailedRequest } from './diagnostics'
import type { BootstrapResponse } from '@shared/api'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    /* The rest of the refusal.
     *
     * Some rejections carry the facts a person needs to act: which periods
     * clashed, how many staff have no attendance marked. Throwing away
     * everything but the message forced each screen to ask a second time for
     * something the server had already said, so they mostly did not ask and
     * showed a sentence where a list belonged. */
    readonly body?: unknown,
    /** The six-character reference of an unexpected server error (worker/src/services/error_refs.ts). */
    readonly ref?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/* The school a platform operator is working on.

   super_admin holds no institution of their own — that absence is what marks
   them as platform staff — so the school they are setting up has to travel
   with each request. Kept in sessionStorage rather than a module variable so a
   refresh mid-setup does not silently drop them back to "no school chosen",
   and per-tab so an operator can have two schools open side by side.

   Ignored by the server for everyone else: an ordinary user's institution
   comes from their session and no header may widen it. */

const ACTING_KEY = 'acting-institution'

export function actingInstitution(): string | null {
  try {
    return sessionStorage.getItem(ACTING_KEY)
  } catch {
    return null
  }
}

export function setActingInstitution(id: string | null) {
  try {
    if (id) sessionStorage.setItem(ACTING_KEY, id)
    else sessionStorage.removeItem(ACTING_KEY)
  } catch {
    /* private browsing; the operator picks again after a refresh */
  }
}

/* Read-your-writes on D1 read replicas (worker/src/tenant.ts tenantSession).
 * Every answer from the school's database carries X-D1-Bookmark; the newest
 * one goes back on the next request so that request reads from a copy at
 * least as new as what this person last saw or wrote. Kept for the tab only. */
const BOOKMARK = 'X-D1-Bookmark'
let d1Bookmark: string | null = (() => {
  try { return sessionStorage.getItem('d1-bookmark') } catch { return null }
})()
function noteBookmark(res: Response) {
  const bm = res.headers.get(BOOKMARK)
  if (!bm || bm === d1Bookmark) return
  d1Bookmark = bm
  try { sessionStorage.setItem('d1-bookmark', bm) } catch { /* private mode */ }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  /* The first read of each first-screen path is answered from GET /bootstrap
     when it can be (lib/bootstrap.ts); everything else goes to the network. */
  if (!init?.method || init.method.toUpperCase() === 'GET') {
    const hit = await bootstrapped<T>(
      path,
      () => send<BootstrapResponse>('/api/v1/bootstrap'),
      (e) => (e instanceof ApiError ? e.status : undefined),
    )
    if (hit !== undefined) return hit
  }
  return send<T>(path, init)
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const acting = actingInstitution()
  const method = (init?.method ?? 'GET').toUpperCase()

  /* THE KEY IS MINTED HERE, ONCE PER PRESS.
   *
   * Not inside the retry, which is the mistake that makes an idempotency key
   * decorative: a key regenerated on each attempt names the attempt rather
   * than the intent, and the server has nothing to recognise. Minted before
   * the first send and reused by the outbox for every later one, it names
   * what the person asked for, which is the thing that must happen once. */
  const idem = method === 'GET' || method === 'HEAD' ? undefined : crypto.randomUUID()

  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(acting ? { 'X-Acting-Institution': acting } : {}),
        ...(idem ? { 'Idempotency-Key': idem } : {}),
        ...(d1Bookmark ? { [BOOKMARK]: d1Bookmark } : {}),
        ...init?.headers,
      },
    })
    noteBookmark(res)
  } catch (e) {
    /* fetch rejects only when nothing came back at all: no route to the host,
       DNS gone, the radio off, the tab killed mid-flight. Every answered
       request, including every error status, resolves. So this branch is
       exactly "there is no connection" and nothing else — which is why it is
       safe to treat it as one.
     *
     * A write is kept and sent later. A read is not: nobody typed it, there is
     * nothing to preserve, and replaying it after the fact would repaint a
     * screen with the answer to a question the person has stopped asking. */
    if (idem && takeOffline(method, path, init?.body as string | undefined, idem)) {
      throw new ApiError(
        0,
        'queued_offline',
        'Saved on this device. It will be sent as soon as there is a connection.',
      )
    }
    throw new ApiError(0, 'offline', 'No connection. This screen needs the network to load.')
  }

  // The server took the write. If the screen says nothing about it within a
  // beat, a plain "Saved" is said for it; see lib/save-feedback.ts.
  if (res.ok && idem) noteWrite(method, path)

  if (res.status === 204) return undefined as T

  const text = await res.text()
  /* NOT EVERYTHING THAT ANSWERS IS JSON.
   *
   * A request to a path the router does not have gets chi's plain
   * "404 page not found", and JSON.parse of that throws
   * "Unexpected non-whitespace character after JSON at position 4" -- it
   * parses the 404 as a number and chokes on the space. That string was
   * shown to a person trying to delete a class, and it says nothing about a
   * missing route, a wrong path or anything they could act on.
   *
   * Same for a proxy's HTML error page or an empty 500. A body we cannot read
   * becomes an error about the request, which is what it is. */
  let body: any = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      throw new ApiError(
        res.status,
        res.ok ? 'bad_response' : 'unexpected_response',
        res.ok
          ? 'The server answered in a form this screen cannot read.'
          : `The server said: ${text.trim().slice(0, 120)}`,
      )
    }
  }

  if (!res.ok) {
    /* TWO SHAPES OF REFUSAL, AND THE CLIENT ONLY UNDERSTOOD ONE.

       Go answered with a nested object -- {"error":{"code":..,"message":..}} --
       and this read body.error.code. The Worker answers flat:

           {"error":"you have no staff record in this school","code":"not_staff"}

       so body.error is a STRING, `.code` on it is undefined, and every refusal
       since the migration has arrived as code 'unknown' with no message.

       That is not cosmetic. Every branch in this product that asks WHY a
       request was refused has been dead: the staff panels that hide themselves
       on 'not_staff' stayed on a parent's account page, the prompt that
       re-asks for a password on 'reauth_required' never appeared, a school
       switch that is no longer valid was never forgotten. And because the
       message was undefined too, FormNotice drew a red bar with no words in
       it -- which I patched in FormNotice as though the bar were the fault.

       Both shapes are read now. Flat wins where it is present, because that is
       what the live server sends; the nested form is kept so a Go deployment
       or a cached response is not suddenly illegible. */
    const nested = body?.error
    const e = nested && typeof nested === 'object'
      ? nested
      : { code: body?.code, message: typeof nested === 'string' ? nested : body?.message }
    /* The school this tab was switched into is no longer one this person
       oversees (a board grant or group membership was removed). Forget it so
       the next request is back at home instead of every screen failing. */
    if (acting && ['not_a_board_member', 'no_such_school'].includes(e?.code ?? body?.code)) setActingInstitution(null)
    /* A money action on a sign-in older than fifteen minutes. The prompt
       that asks for the password again listens for this; see
       components/ReauthPrompt.tsx. The error still reaches the caller so the
       screen says why the button did nothing. */
    if (e?.code === 'reauth_required') {
      try {
        window.dispatchEvent(new CustomEvent('erp:reauth'))
      } catch {
        /* an old browser without CustomEvent: the message below still shows */
      }
    }
    const ref = typeof body?.ref === 'string' ? body.ref : res.headers.get('X-Error-Ref') ?? undefined
    noteFailedRequest(path, res.status, ref)
    /* An unexpected error says so in words and carries its reference, so
       every toast and error line that prints the message shows it too. */
    const message = ref && (e?.message === 'internal' || !e?.message)
      ? `Something went wrong on our side. Ref: ${ref}`
      : e?.message ?? res.statusText
    throw new ApiError(res.status, e?.code ?? 'unknown', message, e?.request_id, body, ref)
  }
  /* The worker's mark, carried through to whoever reads the answer.

     sw-src.js answers a read it could not make from its cache and sets
     X-From-Cache on the way back, "so the app can say 'this is what we last
     saw' rather than presenting yesterday's balance as today's". Nothing read
     the header: the body was returned bare and every screen painted it as
     live. The body object is remembered here so a screen can ask
     `servedFromCache(data)` and write "no connection" under its title. */
  if (body && typeof body === 'object' && res.headers.get('X-From-Cache')) {
    cachedBodies.add(body)
    // A bootstrap answer from the cache: each part it hands out is cached too.
    if (path === '/api/v1/bootstrap') {
      for (const v of Object.values(body)) if (v && typeof v === 'object') cachedBodies.add(v)
    }
  }
  return body as T
}

/* A WeakSet so a body held by nothing else costs nothing here either; the
   query cache holds the same object, so as long as a screen can show it, it
   can be asked about. */
const cachedBodies = new WeakSet<object>()

/** True if this answer came from the service worker's offline fallback,
    not the server: the network was unreachable when it was asked for. */
export function servedFromCache(data: unknown): boolean {
  return !!data && typeof data === 'object' && cachedBodies.has(data as object)
}

export const api = {
  /** A route on the contract (shared/api), typed end to end. See `call` below. */
  call,
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  /* PATCH, for an edit that names only what changes.

     PUT replaces, which means a caller has to send back every field it does
     not want cleared — and a caller that forgets one clears it silently. An
     endpoint that distinguishes "not mentioned" from "set to empty" needs the
     verb that says so. */
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  /* A body on a DELETE, which is unusual and here on purpose: erasing a
     child's record asks for the name to be typed back, and that confirmation
     belongs in the request rather than in a query string that lands in every
     access log beside the id it identifies. */
  del: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'DELETE', body: body ? JSON.stringify(body) : undefined }),
}

/* THE CONTRACT, ON THE WEB SIDE.

   `api.call('GET /students', { query })` names an endpoint as shared/api does,
   and returns exactly the type the Worker is compiled against (its handler is
   registered with `r.typed` under the same name). Path placeholders are
   filled from `params`: `api.call('GET /students/{id}', { params: { id } })`.
   Query values that are undefined, null or '' are left out.

   Prefer this to api.get<T>() for anything on the contract: there the T is a
   promise nobody checks. */
export type ApiRoute = keyof Api & string
type Field<K extends ApiRoute, F extends string> = F extends keyof Api[K] ? Api[K][F] : undefined
type NeedsBody<K extends ApiRoute> = 'body' extends keyof Api[K] ? (undefined extends Field<K, 'body'> ? false : true) : false
type CallArgs<K extends ApiRoute> =
  & (keyof PathParams<K> extends never ? { params?: undefined } : { params: PathParams<K> })
  & { query?: Field<K, 'query'> }
  & (NeedsBody<K> extends true ? { body: Field<K, 'body'> } : { body?: Field<K, 'body'> })
type OptionalIfEmpty<K extends ApiRoute> =
  keyof PathParams<K> extends never ? (NeedsBody<K> extends true ? [args: CallArgs<K>] : [args?: CallArgs<K>]) : [args: CallArgs<K>]

/** Builds the URL for a contract route: fills {placeholders}, appends the query. */
export function apiPath(route: string, params?: Record<string, string>, query?: Record<string, QueryValue>): string {
  const sp = route.indexOf(' ')
  let path = '/api/v1' + route.slice(sp + 1).replace(/\{([a-zA-Z_]+)\}/g, (_, k: string) => {
    const v = params?.[k]
    if (v === undefined) throw new Error(`api.call ${route}: missing path parameter ${k}`)
    return encodeURIComponent(v)
  })
  if (query) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue
      qs.set(k, String(v))
    }
    const s = qs.toString()
    if (s) path += '?' + s
  }
  return path
}

async function call<K extends ApiRoute>(route: K, ...rest: OptionalIfEmpty<K>): Promise<Api[K]['res']> {
  const args = (rest[0] ?? {}) as { params?: Record<string, string>; query?: Record<string, QueryValue>; body?: unknown }
  const method = route.slice(0, route.indexOf(' '))
  const path = apiPath(route, args.params, args.query)
  if (method === 'GET') return request(path)
  return request(path, { method, body: args.body !== undefined ? JSON.stringify(args.body) : undefined })
}

// --- types mirroring the Go response structs --------------------------------

/* The contract's types (shared/api), re-exported so screens keep importing
   them from here. Edit them in shared/api, never here. */
export type {
  List, Page, SessionResponse, Subscription, Student, Period, TimetableEntry, Teacher, AttendanceRow,
} from '@shared/api'

export interface AcademicYear { id: string; name: string; starts_on: string; ends_on: string; is_current: boolean }
export interface Klass { id: string; name: string; level: number; stream?: string }
export interface Section {
  id: string; class_id: string; class_name: string; academic_year_id: string
  name: string; capacity: number; room?: string; class_teacher?: string; enrolled: number
  /* What the setup sheet declared this section holds. Never the roll --
     `enrolled` is the roll. Kept so the two can be compared after an
     import, and absent where nobody declared anything. */
  stated_strength?: number
}
export interface Subject { id: string; name: string; code: string; is_scholastic: boolean }

export interface QueueStat {
  size: number; pending: number; active: number; scheduled: number; retry: number
  archived: number; completed: number; processed: number; failed: number
  paused: boolean; priority: number
}
export interface JobStatus {
  id: string; type: string; state: string; queue: string
  retried: number; max_retry: number; last_error?: string
}
export interface EnqueueResponse {
  job_id: string; task_id: string; type: string; queue: string; accepted_at: string; poll_url: string
}
