// Thin fetch wrapper around the Go API.
//
// Everything is same-origin: nginx serves this bundle and proxies /api to the
// Go process, so there is no base URL to configure and cookies are sent
// automatically. The one thing worth centralising is the error envelope, which
// the server guarantees is always {error:{code,message,request_id}}.

import { takeOffline } from './outbox'

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
        ...init?.headers,
      },
    })
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
    const e = body?.error
    throw new ApiError(res.status, e?.code ?? 'unknown', e?.message ?? res.statusText,
      e?.request_id, body)
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

// --- types mirroring the Go response structs --------------------------------

export interface SessionResponse {
  authenticated: boolean
  user?: {
    id: string
    full_name: string
    roles: string[]
    platform_admin: boolean
    /** Still on the password the office issued — their own phone number. */
    must_change_password?: boolean
    /** The file id of their photograph, absent if they have none. Carried on
        the session so every surface that shows who is signed in can draw it,
        rather than each one fetching /profile for a single string. */
    avatar_key?: string
  }
  institution?: {
    id: string; name: string; short_name: string; slug: string
    primary_color: string; timezone: string; locale: string
  }
  permissions: string[]
  modules?: { module: string; enabled: boolean }[]
  /** What the school has bought, and whether it is paid up. Absent for
   *  platform staff, who are not customers and have nothing to buy. */
  subscription?: Subscription
}

export interface Subscription {
  active: boolean
  /** none | expired | past_due | suspended | cancelled — for branching on the
   *  reason without parsing the prose in `reason`. */
  code?: string
  reason?: string
  plan_code?: string
  plan_name?: string
  status?: string
  trial_ends_on?: string
  modules: string[]
  /** Whether this pack may link the school's own SMS/WhatsApp vendor account.
   *  Decides what the messaging screen offers; the gate is on the server. */
  custom_integration?: boolean
}

export interface Student {
  id: string; admission_no: string; full_name: string
  first_name: string; middle_name?: string; last_name?: string
  gender?: string; date_of_birth?: string; status: string; admission_date: string
  class_name?: string; section_name?: string; roll_no?: number
  primary_phone?: string
}

export interface Page<T> { items: T[]; total: number; limit: number; offset: number; has_more: boolean }
export interface List<T> { items: T[] }

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

export interface Period {
  id: string; name: string; sequence: number; starts_at: string; ends_at: string; is_break: boolean
}
export interface TimetableEntry {
  id: string; section_id: string; section_name: string; class_name: string
  period_id: string; period_name: string; weekday: number
  subject_name: string; subject_code: string
  teacher_id?: string; teacher_name?: string; room?: string
}
export interface Teacher {
  user_id: string
  full_name: string
  employee_code: string

  /* Absent unless the caller plans the timetable. The whole staff's weekly
     load is a league table of colleagues; the server omits it rather than
     sending a zero that would say something false about everybody. */
  weekly_periods?: number
}

export interface AttendanceRow {
  id: string; student_id: string; student_name: string; admission_no: string
  section_id: string; on_date: string; status: string; minutes_late?: number; remarks?: string
}

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
