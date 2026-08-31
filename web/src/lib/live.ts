import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

/* Keeping every open screen current, without anybody pressing reload.

   A teacher marks the register at 9:05 and the parent's tab, open since
   breakfast, still showed yesterday: react-query holds what it fetched,
   refetchOnWindowFocus was off, and nothing on the page ever asked again. That
   was true of every screen in the product, and the answer people were given
   was "reload it".

   ONE POLL, NOT ONE PER SCREEN

   Putting refetchInterval on each query would mean a dozen requests a minute
   from a page showing a dozen cards, most of them fetching something that has
   not moved. This asks a single question — "has anything you can see changed?"
   — and only when the answer changes does it invalidate the cache, at which
   point every mounted query refetches itself because that is what react-query
   already does with a stale cache.

   So the cost of nothing happening is one small request every ten seconds, and
   the cost of something happening is exactly the screens that are on show.

   NOT WHILE NOBODY IS LOOKING

   A tab in the background is a tab nobody is reading. Polling it wastes a
   phone's battery and a school's bandwidth for a screen that will be refreshed
   the moment it is looked at again — which the visibility handler below does,
   immediately, so coming back to a tab shows the current answer rather than
   one up to ten seconds old.
*/

const EVERY = 10_000

export function useLiveUpdates() {
  const qc = useQueryClient()
  /* The last revision seen. A ref rather than state: nothing renders from it,
     and setting state here would re-run the effect and restart the timer on
     every tick. */
  const seen = useRef<string | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    let stopped = false

    async function check() {
      if (stopped || document.hidden) return
      try {
        const r = await api.get<{ rev: string }>('/api/v1/portal/live')
        if (stopped) return
        if (seen.current === null) {
          // The first answer is the baseline, not a change. Without this every
          // page load would throw away a cache it had just filled.
          seen.current = r.rev
          return
        }
        if (r.rev !== seen.current) {
          seen.current = r.rev
          /* Everything, rather than guessing which screens care.

             The revision says something moved, not what — and a list of which
             query keys each kind of change touches is a list that goes stale
             the first time somebody adds a screen and forgets. Invalidating
             refetches only what is mounted, so the breadth costs nothing. */
          qc.invalidateQueries()
        }
      } catch {
        /* A failed poll is not worth a message. The next one is ten seconds
           away, and a signed-out session is about to be redirected anyway. */
      }
    }

    const tick = () => {
      void check()
      timer.current = window.setTimeout(tick, EVERY)
    }
    timer.current = window.setTimeout(tick, EVERY)

    // Back to the tab: answer now, not on the next tick.
    const onVisible = () => { if (!document.hidden) void check() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)

    return () => {
      stopped = true
      if (timer.current) window.clearTimeout(timer.current)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [qc])
}
