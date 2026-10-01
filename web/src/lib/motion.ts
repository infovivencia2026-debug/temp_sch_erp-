import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
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

/* ======================================================================
   THE MOTION KIT -- styles/motion.css is the other half; docs/motion-kit.md
   lists each pattern, where it is used and how to apply it. Every helper
   here is a no-op under reduced motion and on an engine without the API it
   needs; the CSS it drives is written so the thing is simply there.
   ====================================================================== */

/** Staggered entrance, first paint only. Put the returned ref on the list
    or grid that carries `.m-stagger`; once the last child's entrance has
    played (or at once, under reduced motion) the list is marked settled and
    a later re-key of its children does not play the entrance again. */
export function useStaggerOnce<T extends HTMLElement = HTMLElement>() {
  const ref = useRef<T>(null)
  const armed = useRef<Element | null>(null)
  /* No dependency list, on purpose: a list that draws nothing until its
     query answers has no element on the first effect, so this looks again
     after each render until there is one, and arms exactly once per element. */
  useEffect(() => {
    const el = ref.current
    if (!el || armed.current === el) return
    armed.current = el
    if (motionReduced()) {
      el.setAttribute('data-settled', '')
      return
    }
    // Twelve steps of the stagger plus one entrance, with slack. Not cleared
    // on re-render: the timer belongs to the element, not to the render.
    window.setTimeout(() => el.setAttribute('data-settled', ''), 12 * 24 + 200 + 120)
  })
  return ref
}

/** Container transform / shared element. Names `from` as the hero, commits
    the change inside a view transition, and -- once the new state is in --
    names `to()` (looked up after the commit) as the same hero so the two are
    morphed between. The name is cleared from both when the crossing ends.
    Without the API, or under reduced motion, this is `commit()`. */
export function containerTransform(from: Element | null | undefined, commit: () => void, to?: () => Element | null | undefined) {
  const doc = document as Doc
  const root = document.documentElement
  if (!doc.startViewTransition || motionReduced() || !from) {
    commit()
    return
  }
  const fromEl = from as HTMLElement
  fromEl.style.viewTransitionName = 'm-hero'
  root.setAttribute('data-vt', 'hero')
  let toEl: HTMLElement | null = null
  let vt: VT | undefined
  try {
    vt = doc.startViewTransition(() => {
      commitNow(commit)
      fromEl.style.viewTransitionName = ''
      toEl = (to?.() as HTMLElement | null | undefined) ?? null
      if (toEl) toEl.style.viewTransitionName = 'm-hero'
    })
  } catch {
    fromEl.style.viewTransitionName = ''
    root.removeAttribute('data-vt')
    commitNow(commit)
    return
  }
  const done = () => {
    fromEl.style.viewTransitionName = ''
    if (toEl) toEl.style.viewTransitionName = ''
    if (root.getAttribute('data-vt') === 'hero') root.removeAttribute('data-vt')
  }
  for (const pr of [vt?.ready, vt?.updateCallbackDone]) pr?.catch(() => {})
  vt?.finished?.then(done, done) ?? done()
}

type DragOpts = {
  /** Called once the sheet has been sent away. */
  onDismiss: () => void
  /** Travel, in px, past which a release dismisses. Default 96. */
  threshold?: number
  /** Only drags that begin on this element (default: the sheet itself)
      start a dismiss -- so the scrolling list inside a sheet scrolls. */
  handle?: () => HTMLElement | null
}

/** Bottom sheet drag-to-dismiss. Put the returned ref on a `.m-sheet`; its
    `.m-scrim` sibling is found through `scrim`. The sheet follows the finger
    downward (never up), the scrim thins with it, and a release past the
    threshold -- or a quick flick -- sends it off the bottom edge before
    onDismiss fires. Pointer events, so mouse and pen behave the same. */
export function useDragDismiss<T extends HTMLElement = HTMLElement>(opts: DragOpts, scrim?: () => HTMLElement | null) {
  const ref = useRef<T>(null)
  const latest = useRef(opts)
  latest.current = opts
  useEffect(() => {
    const el = ref.current
    if (!el || typeof window.PointerEvent === 'undefined') return
    let startY = 0, startT = 0, dy = 0, id = -1, active = false
    const h = () => latest.current.handle?.() ?? el
    const sc = () => scrim?.() ?? null
    const set = (y: number) => {
      el.style.setProperty('--m-drag', `${y}px`)
      const s = sc()
      if (s) s.style.setProperty('--m-drag-f', String(Math.min(1, y / Math.max(1, el.offsetHeight))))
    }
    const down = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      const target = e.target as HTMLElement
      const handle = h()
      if (handle !== el && !handle?.contains(target)) return
      // A scrolled list inside the sheet scrolls; the sheet moves only from the top of it.
      const scroller = target.closest<HTMLElement>('.scroll-y, [data-sheet-scroll]')
      if (scroller && el.contains(scroller) && scroller.scrollTop > 0) return
      startY = e.clientY; startT = e.timeStamp; dy = 0; id = e.pointerId; active = true
      el.setAttribute('data-dragging', '')
      sc()?.setAttribute('data-dragging', '')
    }
    const move = (e: PointerEvent) => {
      if (!active || e.pointerId !== id) return
      dy = Math.max(0, e.clientY - startY)
      if (dy > 6) { try { el.setPointerCapture(id) } catch { /* already captured, or gone */ } }
      set(dy)
    }
    const up = (e: PointerEvent) => {
      if (!active || e.pointerId !== id) return
      active = false
      el.removeAttribute('data-dragging')
      const s = sc()
      s?.removeAttribute('data-dragging')
      const v = dy / Math.max(1, e.timeStamp - startT)   // px per ms
      const go = dy > (latest.current.threshold ?? 96) || (dy > 24 && v > 0.6)
      if (go) {
        el.style.setProperty('--m-drag', '0px')
        el.setAttribute('data-closing', '')
        s?.style.setProperty('--m-drag-f', '1')
        // A sheet that stays mounted while hidden must not keep the flag, or
        // it would refuse to come back up the next time it is shown.
        const fire = () => {
          latest.current.onDismiss()
          requestAnimationFrame(() => { el.removeAttribute('data-closing'); el.style.removeProperty('--m-drag'); s?.style.removeProperty('--m-drag-f') })
        }
        if (motionReduced()) fire()
        else window.setTimeout(fire, 200)
      } else {
        set(0)
        s?.style.removeProperty('--m-drag-f')
      }
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
  }, [scrim])
  return ref
}

/** Swipe-to-dismiss, sideways. Put the returned ref on a `.m-swipe` (a
    toast, a notification row). A horizontal drag past the threshold, or a
    flick, sends it off that edge and calls onDismiss; anything less springs
    back. Vertical movement is left to the scroller. */
export function useSwipeDismiss<T extends HTMLElement = HTMLElement>(onDismiss: () => void, opts: { threshold?: number; enabled?: boolean } = {}) {
  const ref = useRef<T>(null)
  const cb = useRef(onDismiss)
  cb.current = onDismiss
  const { threshold = 72, enabled = true } = opts
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled || typeof window.PointerEvent === 'undefined') return
    let x0 = 0, y0 = 0, t0 = 0, dx = 0, id = -1, mode: 'idle' | 'maybe' | 'swipe' = 'idle'
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return   // a mouse clicks the X; dragging a toast with it is a surprise
      x0 = e.clientX; y0 = e.clientY; t0 = e.timeStamp; dx = 0; id = e.pointerId; mode = 'maybe'
    }
    const move = (e: PointerEvent) => {
      if (mode === 'idle' || e.pointerId !== id) return
      const mx = e.clientX - x0, my = e.clientY - y0
      if (mode === 'maybe') {
        if (Math.abs(my) > 8 && Math.abs(my) > Math.abs(mx)) { mode = 'idle'; return }
        if (Math.abs(mx) < 8) return
        mode = 'swipe'
        el.setAttribute('data-swiping', '')
        try { el.setPointerCapture(id) } catch { /* fine */ }
      }
      dx = mx
      el.style.setProperty('--m-swipe', `${dx}px`)
      el.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / (el.offsetWidth || 320)))
    }
    const up = (e: PointerEvent) => {
      if (mode === 'idle' || e.pointerId !== id) return
      const was = mode
      mode = 'idle'
      el.removeAttribute('data-swiping')
      if (was !== 'swipe') return
      const v = Math.abs(dx) / Math.max(1, e.timeStamp - t0)
      if (Math.abs(dx) > threshold || (Math.abs(dx) > 20 && v > 0.5)) {
        el.style.setProperty('--m-swipe', `${Math.sign(dx) * (el.offsetWidth || 320) * 1.2}px`)
        el.style.opacity = ''
        el.setAttribute('data-dismissed', '')
        const fire = () => cb.current()
        if (motionReduced()) fire()
        else window.setTimeout(fire, 220)
      } else {
        el.style.setProperty('--m-swipe', '0px')
        el.style.opacity = ''
      }
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
  }, [threshold, enabled])
  return ref
}

/** Collapsing large title. Put the returned ref on the block that holds a
    `.m-large-title`; it writes --m-collapse (0..1) there as the nearest
    scroller moves through the first `range` px. Where the engine has
    scroll-driven animations the stylesheet does this itself and the hook
    does nothing. */
export function useCollapsingTitle<T extends HTMLElement = HTMLElement>(range = 96) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || motionReduced()) return
    try {
      if (typeof CSS !== 'undefined' && CSS.supports?.('animation-timeline: scroll()')) return
    } catch { /* fall through to the listener */ }
    const scroller = (() => {
      let p: HTMLElement | null = el.parentElement
      while (p && p !== document.body) {
        const o = getComputedStyle(p).overflowY
        if (o === 'auto' || o === 'scroll') return p
        p = p.parentElement
      }
      return null
    })()
    const read = () => scroller ? scroller.scrollTop : window.scrollY
    let raf = 0
    const on = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        el.style.setProperty('--m-collapse', String(Math.max(0, Math.min(1, read() / range))))
      })
    }
    const target: EventTarget = scroller ?? window
    target.addEventListener('scroll', on, { passive: true })
    on()
    return () => {
      target.removeEventListener('scroll', on)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [range])
  return ref
}
