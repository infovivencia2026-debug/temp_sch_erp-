import { useEffect, useState } from 'react'

/* POLL ONLY WHILE SOMEBODY IS LOOKING.

   A dozen screens kept a refetchInterval running with the tab hidden. The
   shared revision poll in lib/live.ts and the bus screen already stop when
   the page is not visible; the rest did not, and a parent who left the app
   open in the background cost ~600 requests an hour for nothing anyone saw.
   On a server that bills per request and sleeps when idle, that is the whole
   bill; on the one we have it is a third of the day's traffic.

   Two hooks, one fact. `useTabVisible()` is the hook the bus screen wrote
   (moved here so every screen shares it); `useVisibleInterval(ms)` is the
   shape React Query wants: the interval while visible, `false` while hidden,
   so `refetchInterval: useVisibleInterval(30_000)` is the whole change at a
   call site. The query resumes on the next visibility change, and React
   Query refetches a stale query when its interval comes back, so the screen
   is current within one tick of being looked at again. */

export function useTabVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : !document.hidden,
  )
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

/** `ms` while the tab is visible, `false` while it is hidden. */
export function useVisibleInterval(ms: number): number | false {
  const visible = useTabVisible()
  return visible ? ms : false
}

/* A CODE THAT EXPIRES SAYS WHEN TO ASK AGAIN.

   The ID card screens polled every sixty seconds. Almost nothing on that
   screen moves — a child's name and photograph are the same in a minute — but
   the gate pass printed under the card is derived from a rolling 150-second
   window, and a code older than its window is refused at the gate. A fixed
   minute therefore asked two or three times inside every window and still
   could not promise a fresh code at the moment of the scan.

   The answer carries `expires_in_seconds`, so the screen asks again a second
   after the code it is holding runs out, and not before: roughly one request
   every two and a half minutes instead of three. If the field is missing the
   old minute stands. */
export function passRefetch(visible: boolean) {
  return (query: { state: { data?: unknown } }): number | false => {
    if (!visible) return false
    const data = query.state.data as { pass?: { expires_in_seconds?: number } } | undefined
    const left = data?.pass?.expires_in_seconds
    return typeof left === 'number' && left > 0 ? (left + 1) * 1000 : 60_000
  }
}
