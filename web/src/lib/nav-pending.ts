import { useEffect, useSyncExternalStore } from 'react'
import { useLocation } from 'react-router-dom'
import './nav-pending.css'

/* "WHEN I OPEN ANYTHING IT GETS STUCK" (owner, 2026-11-23).

   The router navigates inside a transition (App.tsx, v7_startTransition), so
   the screen you are on stays on view, and stays usable, until the next one
   can render. What that needs alongside it is an immediate sign that the tap
   was taken. This is that sign: pending from the moment a link is pressed or
   the URL changes (a link, navigate(), the back button) until the router has
   committed that URL, shown as the top bar (App.tsx FetchBar). Bounded, so a
   navigation that never settles can never leave the bar running. */

let pending = false
let committed = typeof window === 'undefined' ? '' : here()
let safety: number | undefined
const subs = new Set<() => void>()

function here() {
  return window.location.pathname + window.location.search
}

function set(on: boolean) {
  if (safety) window.clearTimeout(safety)
  safety = on ? window.setTimeout(() => set(false), 12_000) : undefined
  if (pending === on) return
  pending = on
  subs.forEach((f) => f())
}

function urlMoved() {
  if (here() !== committed) set(true)
}

if (typeof window !== 'undefined' && !(window as { __navPending?: boolean }).__navPending) {
  ;(window as { __navPending?: boolean }).__navPending = true
  for (const k of ['pushState', 'replaceState'] as const) {
    const orig = history[k].bind(history)
    history[k] = (...args: Parameters<History['pushState']>) => {
      orig(...args)
      urlMoved()
    }
  }
  window.addEventListener('popstate', urlMoved)
  /* The press itself, before the click: on a throttled phone the click and the
     router's own work can be 100ms+ behind the finger. Only for a same-site
     link to somewhere else; if no navigation follows, it lets go. */
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0) return
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return
      let url: URL
      try { url = new URL(a.href, window.location.href) } catch { return }
      if (url.origin !== window.location.origin || url.pathname + url.search === committed) return
      set(true)
      window.setTimeout(() => { if (here() === committed) set(false) }, 1500)
    },
    { capture: true, passive: true },
  )
}

/** The same, outside React. */
export function isNavPending(): boolean {
  return pending
}

/** True while a navigation has been asked for and not yet drawn. */
export function useNavPending(): boolean {
  return useSyncExternalStore(
    (f) => { subs.add(f); return () => subs.delete(f) },
    () => pending,
    () => false,
  )
}

/** Inside the router: marks the URL the router has actually rendered. */
export function NavSettled() {
  const loc = useLocation()
  useEffect(() => {
    committed = loc.pathname + loc.search
    if (here() === committed) set(false)
  }, [loc.pathname, loc.search])
  return null
}
