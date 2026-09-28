import { useEffect } from 'react'

/* Telling the server which screen this session is on.

   One small POST per navigation, carrying the feature key and nothing else.
   It feeds session_screens, which is what lets a principal see that a login
   opened Payroll at 9pm -- see internal/api/session_activity.go.

   Sent with fetch directly rather than through api.post: that wrapper mints
   an idempotency key and queues writes for replay when offline, and a
   "you were on this screen" note is not worth replaying tomorrow. keepalive
   lets it complete when the tab is closing. Every failure is ignored. */
export function useScreenBeacon(screen: string | undefined) {
  useEffect(() => {
    if (!screen) return
    try {
      void fetch('/api/v1/session/activity', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ screen }),
      }).catch(() => undefined)
    } catch {
      /* an old browser without fetch, or one that refuses keepalive: nothing to do */
    }
  }, [screen])
}

/* SESSION ACTIVITY: screens visited and the time spent on each.

   Only when the school has switched recording on (module_settings
   'session_activity', which arrives with the session as a module). Off, this
   does nothing at all -- no timers, no listeners, no requests.

   Light by construction: a visit is a few numbers kept in memory; they are
   sent together, with navigator.sendBeacon, when the tab is hidden or closed,
   when five have piled up, or every two minutes if anything is waiting. The
   time counted is time the tab was visible. The server drops everything if
   recording is off by the time a batch arrives. */
interface Visit { screen: string; path: string; at: string; seconds: number }
let current: { screen: string; path: string; at: string; ms: number; since: number | null } | null = null
const queue: Visit[] = []
let wired = false
let timer: ReturnType<typeof setInterval> | undefined

function sendQueued() {
  if (!queue.length) return
  const body = JSON.stringify({ views: queue.splice(0, queue.length) })
  const url = '/api/v1/session/activity/batch'
  try {
    if (navigator.sendBeacon?.(url, new Blob([body], { type: 'application/json' }))) return
  } catch { /* fall through to fetch */ }
  try {
    void fetch(url, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body })
      .catch(() => undefined)
  } catch { /* nothing to do */ }
}

/** Moves the visible time so far into the queue; `keep` leaves the visit open (the tab was only hidden). */
function settle(keep: boolean) {
  if (!current) return
  if (current.since !== null) current.ms += Date.now() - current.since
  const seconds = Math.round(current.ms / 1000)
  if (seconds >= 1) queue.push({ screen: current.screen, path: current.path, at: current.at, seconds })
  if (keep) { current.ms = 0; current.since = null; current.at = new Date().toISOString() } else current = null
}

function onVisibility() {
  if (document.visibilityState === 'hidden') { settle(true); sendQueued() }
  else if (current && current.since === null) { current.since = Date.now(); current.at = new Date().toISOString() }
}
function onPageHide() { settle(false); sendQueued() }

function wire() {
  if (wired) return
  wired = true
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  timer = setInterval(() => { if (queue.length) sendQueued() }, 120_000)
}
function unwire() {
  if (!wired) return
  wired = false
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('pagehide', onPageHide)
  clearInterval(timer)
}

export function useActivityTracker(screen: string | undefined, on: boolean) {
  useEffect(() => {
    if (!on || !screen) return
    wire()
    const visible = document.visibilityState !== 'hidden'
    current = { screen, path: window.location.pathname, at: new Date().toISOString(), ms: 0, since: visible ? Date.now() : null }
    return () => {
      settle(false)
      if (queue.length >= 5) sendQueued()
    }
  }, [screen, on])
  useEffect(() => {
    if (on) return
    queue.length = 0
    current = null
    unwire()
  }, [on])
}
