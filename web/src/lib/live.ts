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

   So the cost of nothing happening is one small request every thirty seconds,
   and the cost of something happening is exactly the screens that are on show.

   NOT WHILE NOBODY IS LOOKING

   A tab in the background is a tab nobody is reading. Polling it wastes a
   phone's battery and a school's bandwidth for a screen that will be refreshed
   the moment it is looked at again — which the visibility handler below does,
   immediately, so coming back to a tab shows the current answer rather than a
   stale one. That claim was only half true until this file stopped merely
   skipping the work on a hidden tab and started stopping the timer as well.
*/

/* Thirty seconds, not ten.

   Ten was chosen when this was the only poll in the product; it was not, and
   the pair of them cost twelve requests a minute from every open tab, all day,
   for a school where most tabs are open and nobody is looking at them. What
   this poll actually buys is "the register a colleague marked appears without
   anybody reloading", and nobody notices the difference between hearing that
   ten seconds late and thirty. Coming back to a tab is still immediate, since
   the visibility handler asks straight away rather than waiting for a tick. */
const EVERY = 30_000

/* A tab open across a deploy is running yesterday's app.

   This is the other half of "why do I have to reload". The poll below keeps
   the DATA current, and it cannot keep the CODE current: a tab opened before
   a deploy carries the JavaScript of that moment for as long as it stays open,
   so a fix shipped at noon reaches somebody's open phone at bedtime, if ever.
   Every "you need to reload once" in this product's life has been this.

   THERE WERE TWO MECHANISMS FOR THIS, AND ONLY ONE OF THEM CAN WIN.

   This function used to fetch `/` on every focus, read the hashed bundle name
   out of the returned index.html, compare it to its own, and call
   `location.reload()` itself — while main.tsx was independently reloading on
   the service worker's `controllerchange`. Two reloads, two session flags,
   racing over the same event, and an extra document fetch every time anybody
   alt-tabbed back. Worse, the reload here could land while the old worker was
   still the controller, which serves the page the old build again and burns
   the guard flag on a reload that fixed nothing.

   So the deciding is left where it belongs — the worker knows what it has
   installed, and main.tsx owns the single reload — and all this does is give
   the browser the nudge it would otherwise not get: an open tab never asks for
   sw.js again on its own, which is exactly why a long-lived tab used to sit on
   an old build for ever. `update()` re-fetches the worker; if it is byte-
   different a new one installs, main.tsx tells it to take over, and its
   controllerchange handler does the one reload. If it is the same build, this
   costs one conditional request and nothing happens. */
function checkForNewBuild() {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker
    .getRegistration()
    .then((reg) => reg?.update())
    .catch(() => {
      /* Offline, or the server is mid-restart. The next focus asks again. */
    })
}

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
        /* A failed poll is not worth a message. The next one is thirty seconds
           away, and a signed-out session is about to be redirected anyway. */
      }
    }

    /* THE TIMER NOW ACTUALLY STOPS WHEN NOBODY IS LOOKING.

       The comment at the top of this file has always said a background tab is
       not polled, and `check` did return early on document.hidden — but the
       timer it returned into went on rescheduling itself for ever, so a tab
       left open overnight still woke up every ten seconds to decide to do
       nothing. On a phone that is the timer keeping the radio and the process
       alive, which is most of what the claim was meant to avoid. So the chain
       ends on hide and is started again on show, and the visibility handler
       asks its question immediately rather than waiting out a full interval. */
    const stop = () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
    }
    const tick = () => {
      timer.current = null
      if (stopped || document.hidden) return
      void check()
      timer.current = window.setTimeout(tick, EVERY)
    }
    const start = () => {
      if (stopped || document.hidden || timer.current !== null) return
      timer.current = window.setTimeout(tick, EVERY)
    }
    start()

    // Back to the tab: answer now, not on the next tick — and take the
    // opportunity to notice that the app itself has moved on.
    const onVisible = () => {
      if (document.hidden) {
        stop()
        return
      }
      void check()
      checkForNewBuild()
      start()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)

    return () => {
      stopped = true
      stop()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [qc])
}
