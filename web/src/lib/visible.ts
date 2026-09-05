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
