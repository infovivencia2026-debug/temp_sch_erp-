// Thin fetch wrapper around the Go API.
//
// Everything is same-origin: nginx serves this bundle and proxies /api to the
// Go process, so there is no base URL to configure and cookies are sent
// automatically. The one thing worth centralising is the error envelope, which
// the server guarantees is always {error:{code,message,request_id}}.

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
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(acting ? { 'X-Acting-Institution': acting } : {}),
      ...init?.headers,
    },
  })

  if (res.status === 204) return undefined as T

  const text = await res.text()
  const body = text ? JSON.parse(text) : null

  if (!res.ok) {
    const e = body?.error
    throw new ApiError(res.status, e?.code ?? 'unknown', e?.message ?? res.statusText,
      e?.request_id, body)
  }
  return body as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

// --- types mirroring the Go response structs --------------------------------

export interface SessionResponse {
  authenticated: boolean
  user?: { id: string; full_name: string; roles: string[]; platform_admin: boolean }
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
}

export interface Student {
  id: string; admission_no: string; full_name: string
  first_name: string; middle_name?: string; last_name?: string
  gender?: string; date_of_birth?: string; status: string; admission_date: string
  class_name?: string; section_name?: string; roll_no?: number
}

export interface Page<T> { items: T[]; total: number; limit: number; offset: number; has_more: boolean }
export interface List<T> { items: T[] }

export interface AcademicYear { id: string; name: string; starts_on: string; ends_on: string; is_current: boolean }
export interface Klass { id: string; name: string; level: number; stream?: string }
export interface Section {
  id: string; class_id: string; class_name: string; academic_year_id: string
  name: string; capacity: number; room?: string; class_teacher?: string; enrolled: number
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
