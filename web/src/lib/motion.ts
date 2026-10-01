import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/* EVERYTHING ARRIVES AND LEAVES THE SAME WAY.

   A React surface -- a menu, a sheet, a dialog, a record opened in place --
   is unmounted in the frame its state flips, so it vanished with no leaving
   at all while the next thing faded in. The owner asked that every
   transition, on every element, go naturally, the way it does on a phone.

   The View Transitions API is the one mechanism that can animate something
   that no longer exists: it snapshots the document, commits the change, and
   crosses the two snapshots on the compositor. index.css shapes the crossing
   (see the ::view-transition rules beside route-enter). App.tsx hands it
   every navigation; this hands it every open/close state in the product.

   `useOpenState` is `useState` with the setter routed through a view
   transition. Sixty-odd surfaces hold their visibility in a state called
   `open`; swapping their hook is what makes the rule global rather than a
   thing each screen remembers to do. flushSync inside the callback is what
   the API needs: the DOM must be in its new state when the callback returns.
   A setter called during render or an effect cannot flushSync; it falls back
   to a plain update, as do browsers without the API and people who asked for
   reduced motion. */
type VT = { ready?: Promise<unknown>; finished?: Promise<unknown>; updateCallbackDone?: Promise<unknown> }
type Doc = Document & { startViewTransition?: (cb: () => void) => VT | undefined }

/** Whether motion has been asked away: by the system setting, or by the
    account's own "Reduce motion" (stamped on <html> as data-reduce-motion). */
export function motionReduced(): boolean {
  try {
    if (document.documentElement.hasAttribute('data-reduce-motion')) return true
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return true
  }
}

function commitNow(commit: () => void) {
  try {
    flushSync(commit)
  } catch {
    commit()
  }
}

let fading = false

/* A WHOLE-SCREEN CHANGE OF SHAPE CROSSES OVER; IT DOES NOT CUT.

   Focus <-> Work swaps the entire chrome: the dock for the sidebar, one
   ground for another. Committed bare, the old shell vanished and the new one
   painted in pieces over a frame or two -- the flash the owner saw.

   With the View Transitions API (Chrome/Edge 111+, Safari 18+) the two
   states are snapshotted and crossed on the compositor: the old one fades,
   the new one fades in settling from 1.2% larger (index.css, html[data-vt]).
   Elsewhere, the app root fades out over 120ms onto the page ground (never
   white -- body keeps its colour), the change commits behind it, and it fades
   back in. Engines without CSS transitions, and anyone who asked for reduced
   motion, get the change instantly. A second press during a fallback fade
   commits straight away rather than queueing another fade. */
export function crossfade(commit: () => void, name = 'layout') {
  const doc = document as Doc
  const root = document.documentElement
  if (motionReduced() || fading) {
    commitNow(commit)
    return
  }
  if (doc.startViewTransition) {
    root.setAttribute('data-vt', name)
    let vt: VT | undefined
    try {
      vt = doc.startViewTransition(() => commitNow(commit))
    } catch {
      root.removeAttribute('data-vt')
      commitNow(commit)
      return
    }
    const done = () => root.removeAttribute('data-vt')
    if (vt?.finished) vt.finished.then(done, done)
    else done()
    for (const pr of [vt?.ready, vt?.updateCallbackDone]) pr?.catch(() => {})
    return
  }
  if (!('transition' in root.style)) {
    commitNow(commit)
    return
  }
  fading = true
  root.setAttribute('data-fade', 'out')
  window.setTimeout(() => {
    commitNow(commit)
    requestAnimationFrame(() => {
      root.setAttribute('data-fade', 'in')
      window.setTimeout(() => {
        root.removeAttribute('data-fade')
        fading = false
      }, 180)
    })
  }, 120)
}

export function transitioned(commit: () => void) {
  const doc = document as Doc
  if (!doc.startViewTransition || motionReduced()) {
    commit()
    return
  }
  const vt = doc.startViewTransition(() => {
    try {
      flushSync(commit)
    } catch {
      commit()
    }
  })
  // Overtaken by the next transition (a menu closing as a route changes),
  // these reject "Transition was skipped" as unhandled page errors; the
  // commit already ran, so the rejection is not an error.
  for (const pr of [vt?.ready, vt?.finished, vt?.updateCallbackDone]) pr?.catch(() => {})
}

export function useOpenState<T>(initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [value, set] = useState<T>(initial)
  /* Directly, not through a view transition. A pop-up has its own slide and
     fade; wrapping it in a whole-screen crossfade made the workspace blink on
     every open and close, and kept the sidebar bright above the dim layer
     until the crossfade finished. */
  const setOpen = useCallback<Dispatch<SetStateAction<T>>>((next) => set(next), [])
  return [value, setOpen]
}

/* THE ACCOUNT'S "REDUCE MOTION" REACHES THE WHOLE APP.

   It used to be read only by the Focus board (data-reduce-motion on
   .bento-board). Stamped on <html> here, index.css turns every transition and
   animation in the product instant under it, the same as the system setting,
   and crossfade()/transitioned() skip their crossings. One reader, on the
   shared ['display-preferences'] query the layout switch already warms. */
export function useRootReduceMotion() {
  const prefs = useQuery({
    queryKey: ['display-preferences'],
    queryFn: () => api.get<{ preference?: { reduce_motion?: boolean } }>('/api/v1/portal/preferences/display'),
    staleTime: 5 * 60_000,
  })
  const on = (prefs.data as { preference?: { reduce_motion?: boolean } } | undefined)?.preference?.reduce_motion === true
  useEffect(() => {
    const root = document.documentElement
    if (on) root.setAttribute('data-reduce-motion', '')
    else root.removeAttribute('data-reduce-motion')
  }, [on])
}

/** Keep a surface mounted for `ms` after it is closed, flagged as closing,
    so its exit can play (index.css [data-closing]). Instant under reduced
    motion. Returns [mounted, closing]. */
export function usePresence(open: boolean, ms = 180): [boolean, boolean] {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    if (!mounted) return
    if (motionReduced()) {
      setMounted(false)
      return
    }
    const t = window.setTimeout(() => setMounted(false), ms)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ms])
  return [open || mounted, !open && mounted]
}
