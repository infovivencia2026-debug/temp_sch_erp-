import type { BootstrapResponse } from '@shared/api'

/* THE FIRST SCREEN IN ONE REQUEST.

   Opening the app used to cost six separate reads before anything useful was
   on screen — /session, /catalog, /portal/preferences/display, /working-year,
   /attention, /rollups/today — each paying its own round trip and its own
   Worker start, on a school's 4G. GET /bootstrap (worker/src/routes/
   bootstrap.ts) answers all six at once, each part in exactly the shape of the
   endpoint it stands for.

   It is wired in underneath the queries rather than beside them: api.ts asks
   `bootstrapped(path)` before a GET goes out, and for one of the six paths the
   answer comes from the single bootstrap response. So every screen keeps its
   own query, key and fetcher; nothing about invalidation changes; and a part
   the server withheld (null: no permission, no school in scope) simply falls
   through to the ordinary request, which refuses exactly as it always did.

   Each part is handed out ONCE, and only while it is fresh. The second reader
   of /attention, or a refetch after a save, is a real request — bootstrap is
   the start of the page's life, not a second cache.

   Until the Worker serving this build has the route (a 404 or 501), the app
   notes that for an hour and makes the six ordinary calls without waiting
   on it. */

type Part = Exclude<keyof BootstrapResponse, never>

const PATHS: Record<string, Part> = {
  '/api/v1/session': 'session',
  '/api/v1/catalog': 'catalog',
  '/api/v1/portal/preferences/display': 'display_preferences',
  '/api/v1/working-year': 'working_year',
  '/api/v1/attention': 'attention',
  '/api/v1/rollups/today': 'today',
}

/** A part is only served this long after the bootstrap answer arrived. */
const FRESH_MS = 20_000
const OFF_KEY = 'erp-bootstrap-off'
const OFF_MS = 60 * 60_000

let pending: Promise<BootstrapResponse | null> | null = null
let answer: BootstrapResponse | null = null
let answeredAt = 0
let started = false
const used = new Set<Part>()

function knownMissing(): boolean {
  try {
    const at = Number(localStorage.getItem(OFF_KEY) || 0)
    return at > 0 && Date.now() - at < OFF_MS
  } catch {
    return false
  }
}

function noteMissing(on: boolean) {
  try {
    if (on) localStorage.setItem(OFF_KEY, String(Date.now()))
    else localStorage.removeItem(OFF_KEY)
  } catch {
    /* private mode: the next load asks again, which is harmless */
  }
}

/** For a GET of one of the six paths, the bootstrap part, or undefined when
    the ordinary request should be made. `fetchBootstrap` is the api layer's
    own request function, so the call carries the same headers as any other. */
export async function bootstrapped<T>(
  path: string,
  fetchBootstrap: () => Promise<BootstrapResponse>,
  status: (e: unknown) => number | undefined,
): Promise<T | undefined> {
  const part = PATHS[path]
  if (!part || used.has(part)) return undefined
  if (!started) {
    started = true
    if (knownMissing()) return undefined
    pending = fetchBootstrap().then(
      (res) => {
        noteMissing(false)
        answer = res
        answeredAt = Date.now()
        return res
      },
      (e) => {
        const s = status(e)
        if (s === 404 || s === 405 || s === 501) noteMissing(true)
        return null
      },
    )
  }
  if (!pending) return undefined
  const res = answer ?? (await pending)
  if (!res || used.has(part) || Date.now() - answeredAt > FRESH_MS) return undefined
  const value = res[part]
  used.add(part)
  if (value === null || value === undefined) return undefined
  return value as T
}

/** Forget any unserved parts: a different person, or a sign-out. */
export function resetBootstrap() {
  answer = null
  pending = null
  for (const p of Object.values(PATHS)) used.add(p)
}
