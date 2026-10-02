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

/* ONE CROSSING AT A TIME.

   The browser runs a single view transition per document. Starting a second
   while one is in flight does not queue it: the first is skipped to its end
   in one frame -- the cut the owner saw when Focus/Work was pressed twice, or
   Back was pressed while a card was still opening. So while a crossing runs,
   the next change is committed plainly inside it: the arriving snapshot is
   live, so the new state shows through the crossing already under way and
   nothing is aborted. */
let crossing = false
/** Whether a view transition started by the kit is still running. */
export function crossingNow(): boolean { return crossing }

/** Runs `commit` inside a view transition when one can be started, and
    plainly otherwise (no API, reduced motion, or a crossing already running).
    Returns the transition, or null when the commit was plain. */
function cross(commit: () => void, before?: () => void, after?: () => void): VT | null {
  const doc = document as Doc
  if (!doc.startViewTransition || motionReduced() || crossing) {
    commitNow(commit)
    return null
  }
  before?.()
  let vt: VT | undefined
  try {
    vt = doc.startViewTransition(() => commitNow(commit))
  } catch {
    after?.()
    commitNow(commit)
    return null
  }
  crossing = true
  const done = () => { crossing = false; after?.() }
  // Overtaken or skipped, these reject "Transition was skipped"; the commit
  // already ran, so the rejection is not an error.
  for (const pr of [vt?.ready, vt?.updateCallbackDone]) pr?.catch(() => {})
  if (vt?.finished) vt.finished.then(done, done)
  else done()
  return vt ?? null
}

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
   motion, get the change instantly. A second press during either kind of
   crossing commits inside it rather than starting another. */
export function crossfade(commit: () => void, name = 'layout') {
  const doc = document as Doc
  const root = document.documentElement
  if (motionReduced() || fading || crossing) {
    commitNow(commit)
    return
  }
  if (typeof doc.startViewTransition === 'function') {
    cross(commit, () => root.setAttribute('data-vt', name), () => root.removeAttribute('data-vt'))
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
  cross(commit)
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

/** How long a closed surface stays mounted for its exit. Longer than the
    longest exit in index.css (the phone sheet, --motion-exit-sheet, 220ms):
    an exit that outlives its element is cut off part-way. */
export const EXIT_MS = 240

/** Keep a surface mounted for `ms` after it is closed, flagged as closing,
    so its exit can play (index.css [data-closing]). Reopened during the exit,
    the timer is dropped and the surface stays; the guard below carries the
    entrance on from where the exit had got to. Instant under reduced motion.
    Returns [mounted, closing]. */
export function usePresence(open: boolean, ms = EXIT_MS): [boolean, boolean] {
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

/** Calls `done` once, when `el` finishes the transition or animation it is
    running, or after `max` ms if no end event comes (nothing was running, the
    element was hidden, the engine dropped the event). Returns a cancel. */
export function afterMotion(el: HTMLElement, done: () => void, max = 600): () => void {
  let over = false
  const end = (e?: Event) => {
    if (over || (e && e.target !== el)) return
    over = true
    window.clearTimeout(t)
    el.removeEventListener('transitionend', end)
    el.removeEventListener('animationend', end)
    if (e || el.isConnected) done()
  }
  const t = window.setTimeout(() => end(), max)
  el.addEventListener('transitionend', end)
  el.addEventListener('animationend', end)
  return () => { over = true; window.clearTimeout(t); el.removeEventListener('transitionend', end); el.removeEventListener('animationend', end) }
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
  const root = document.documentElement
  if (!from) {
    commit()
    return
  }
  const fromEl = from as HTMLElement
  let toEl: HTMLElement | null = null
  cross(
    () => {
      commit()
      fromEl.style.viewTransitionName = ''
      toEl = (to?.() as HTMLElement | null | undefined) ?? null
      if (toEl) toEl.style.viewTransitionName = 'm-hero'
    },
    () => {
      fromEl.style.viewTransitionName = 'm-hero'
      root.setAttribute('data-vt', 'hero')
    },
    () => {
      fromEl.style.viewTransitionName = ''
      if (toEl) toEl.style.viewTransitionName = ''
      if (root.getAttribute('data-vt') === 'hero') root.removeAttribute('data-vt')
    },
  )
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
        // When the sheet has finished leaving, not at a guessed time: a timer
        // shorter than the spring unmounted it part-way down.
        if (motionReduced()) fire()
        else afterMotion(el, fire, 500)
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
        else afterMotion(el, fire, 400)
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

/* ======================================================================
   WHAT COUNTS AS A BREAK. Shared by the dev audit (lib/motion-audit.ts) and
   the tests: one frame's computed opacity and transform against the next.
   ====================================================================== */
export type Sample = { opacity: number; x: number; y: number; sx: number; sy: number; w: number; h: number }

/** A change between two frames smaller than this share of the whole is never
    called a jump, however slow the animation. */
export const JUMP_FLOOR = 0.15

/** Says why two consecutive frames are a jump, or '' when the change is what
    the animation could cover. `share` is how much of the animation's own
    timeline passed between the two frames (0..1). A curve's steepest stretch
    runs at a few times its average pace (the kit's springs up to 6x), so
    that much is allowed; a restart or an end snap moves further. */
export function isJump(a: Sample, b: Sample, share: number, travel?: { x: number; y: number }): string {
  const allow = Math.max(JUMP_FLOOR, 6 * Math.max(0, share))
  const dO = Math.abs(b.opacity - a.opacity)
  if (dO > allow) return `opacity ${a.opacity.toFixed(2)} to ${b.opacity.toFixed(2)}`
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y)
  // Measured against the distance the animation travels when that is known
  // (a thumb crossing four tabs moves further per frame than its own width).
  const span = (d: number, own: number) => Math.max(own, d)
  if (dx > 4 && dx / span(travel?.x ?? 0, a.w) > allow) return `x ${Math.round(a.x)} to ${Math.round(b.x)}px`
  if (dy > 4 && dy / span(travel?.y ?? 0, a.h) > allow) return `y ${Math.round(a.y)} to ${Math.round(b.y)}px`
  const dS = Math.max(Math.abs(b.sx - a.sx), Math.abs(b.sy - a.sy))
  if (dS > allow) return `scale ${a.sx.toFixed(2)} to ${b.sx.toFixed(2)}`
  return ''
}

/* ======================================================================
   THE GUARD: NOTHING IS CUT OFF PART-WAY.  installMotionGuard(), once, from
   main.tsx.

   Three things broke an animation in the middle, and none of them is the
   fault of the screen that happened to show it, so they are mended here for
   every screen at once.

   1. CLOSED WHILE STILL OPENING (or reopened while still closing). An exit
      is a different @keyframes from the entrance, and a keyframe animation
      always starts at its own first frame: a menu 40% faded in jumped to
      full, then faded out. When [data-closing] flips on an element, the
      guard works out where the interrupted animation had got to and rewrites
      the first frame of the one that replaced it, so it carries on from there.

   2. UNMOUNTED WITH NO EXIT. Most menus, popovers and dialogs are rendered
      as `{open && <Menu/>}`: React removes them in the frame the state flips
      and there is nothing left to animate. When such a surface leaves the
      document, the guard puts an inert copy back where it was for the length
      of the exit (styles/motion.css, [data-ghost]) and removes it after. The
      copy cannot be pressed, focused or read by a screen reader. A surface
      that manages its own exit says so with [data-closing] (usePresence) and
      is left alone; so is one swapped for another of the same kind in the
      same update.

   3. LOOPS RUNNING WHERE NOBODY IS LOOKING. html[data-tab-hidden] pauses
      every animation while the tab is in the background (motion.css).

   Skipped under reduced motion, and on an engine without MutationObserver or
   the Web Animations API: there the surface is simply gone, as before. */

const OVERLAY = '[role="menu"],[role="listbox"],[role="dialog"],[role="alertdialog"],[role="tooltip"],.scrim,.motion-enter,[data-exit]'
const NO_COPY = 'iframe,object,embed,video,canvas'
/** Longest a ghost may stay: its exit plus slack. */
const GHOST_MAX_MS = 420

type Played = { a: Animation; t0: number }

/** Where an animation that began `elapsed` ms ago had got to: null when it
    had already finished (or never ran), so there is nothing to carry on from. */
export function interruptedAt(elapsed: number, delay: number, duration: number): number | null {
  if (!(duration > 0)) return null
  const t = elapsed - delay
  if (t >= duration) return null
  return Math.max(0, t)
}

/** The first frame of the replacing animation, rewritten to start from the
    values the interrupted one had reached. `frames` is getKeyframes() output. */
export function carryOn(frames: ComputedKeyframe[], from: { opacity: string; transform: string }): Keyframe[] {
  const clean = frames.map((f) => {
    const { computedOffset: _c, ...rest } = f
    return rest as Keyframe
  })
  const start = { opacity: from.opacity, transform: from.transform }
  if (clean.length && clean[0].offset === 0) clean[0] = { ...clean[0], ...start }
  else clean.unshift({ offset: 0, ...start })
  return clean
}

let guardOn = false
/** Surfaces the guard gave an exit to after React removed them. */
export const ghosted = new WeakSet<Element>()
export function installMotionGuard() {
  if (guardOn || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
  if (typeof document.getAnimations !== 'function') return
  guardOn = true
  const root = document.documentElement

  // -- 3. the tab in the background
  const vis = () => {
    if (document.hidden) root.setAttribute('data-tab-hidden', '')
    else root.removeAttribute('data-tab-hidden')
  }
  document.addEventListener('visibilitychange', vis)
  vis()

  // Every finite animation that is running, and when it began.
  const playing = new Map<Element, Played>()
  document.addEventListener('animationstart', (e) => {
    const el = e.target as Element
    if (!(el instanceof HTMLElement) || el.closest('[data-ghost]')) return
    const a = el.getAnimations().find((x) => (x as CSSAnimation).animationName === e.animationName)
    const t = a?.effect?.getComputedTiming()
    if (!a || !t || t.iterations === Infinity) return
    playing.set(el, { a, t0: performance.now() - Math.max(0, Number(a.currentTime) || 0) })
  }, true)
  const forget = (e: Event) => {
    const p = playing.get(e.target as Element)
    if (p && (p.a as CSSAnimation).animationName === (e as AnimationEvent).animationName) playing.delete(e.target as Element)
  }
  document.addEventListener('animationend', forget, true)
  document.addEventListener('animationcancel', forget, true)

  // Where things inside overlays were scrolled to, for the ghost.
  const scrolled = new Map<Element, [number, number]>()
  document.addEventListener('scroll', (e) => {
    const el = e.target
    if (!(el instanceof HTMLElement)) return
    if (scrolled.size > 40) for (const k of scrolled.keys()) { if (!k.isConnected) scrolled.delete(k) }
    if (scrolled.size > 80) scrolled.clear()
    scrolled.set(el, [el.scrollLeft, el.scrollTop])
  }, { capture: true, passive: true })

  /** The values `el` would show `at` ms into the animation that was playing
      on it, read by replaying that animation on `on` (el itself, or its copy). */
  const valuesAt = (p: Played, at: number, on: HTMLElement): { opacity: string; transform: string } | null => {
    try {
      const eff = p.a.effect as KeyframeEffect
      const t = eff.getComputedTiming()
      const frames = eff.getKeyframes().map((f) => { const { computedOffset: _c, ...rest } = f; return rest as Keyframe })
      if (!frames.length) return null
      const probe = on.animate(frames, { duration: Number(t.duration), easing: t.easing, fill: 'both' })
      probe.pause()
      probe.currentTime = at
      const c = getComputedStyle(on)
      const out = { opacity: c.opacity, transform: c.transform }
      probe.cancel()
      return out
    } catch {
      return null
    }
  }
  const cutShort = (el: Element, now: number): { p: Played; at: number } | null => {
    const p = playing.get(el)
    if (!p) return null
    const t = p.a.effect?.getComputedTiming()
    if (!t) return null
    const at = interruptedAt(now - p.t0, Number(t.delay) || 0, Number(t.duration) || 0)
    return at === null ? null : { p, at }
  }

  // -- 1. [data-closing] flipped on a surface that was still moving
  const retarget = (host: HTMLElement, now: number) => {
    const hit: { el: HTMLElement; p: Played; at: number }[] = []
    for (const el of playing.keys()) {
      if (!(el instanceof HTMLElement) || !host.contains(el)) continue
      const c = cutShort(el, now)
      if (c) hit.push({ el, ...c })
    }
    if (!hit.length) return
    void getComputedStyle(host).opacity   // the flip takes effect: old animations cancel, new ones start
    for (const { el, p, at } of hit) {
      if (p.a.playState === 'running') continue   // not replaced: it was not interrupted
      const next = el.getAnimations().filter((a) => a !== p.a && typeof (a as CSSAnimation).animationName === 'string' && a.playState === 'running')
      if (!next.length) { playing.delete(el); continue }
      const from = valuesAt(p, at, el)
      if (!from) continue
      for (const a of next) {
        try {
          const eff = a.effect as KeyframeEffect
          eff.setKeyframes(carryOn(eff.getKeyframes(), from))
        } catch { /* the plain restart, as before */ }
      }
      playing.set(el, { a: next[0], t0: now })
    }
  }

  // -- 2. an overlay removed with no exit
  const ghostOf = (node: HTMLElement): HTMLElement | null => {
    if (node.matches(OVERLAY)) return node
    const only = node.childElementCount === 1 ? node.firstElementChild : null
    if (only instanceof HTMLElement && only.matches(OVERLAY)) return node
    return null
  }
  const sameKind = (a: HTMLElement, b: HTMLElement) => {
    const ra = a.matches(OVERLAY) ? a : (a.firstElementChild as HTMLElement | null)
    const rb = b.matches?.(OVERLAY) ? b : (b.firstElementChild as HTMLElement | null)
    if (!ra || !rb || !rb.matches?.(OVERLAY)) return false
    return ra.getAttribute('role') === rb.getAttribute('role') && ra.getAttribute('aria-label') === rb.getAttribute('aria-label')
  }
  const pathTo = (from: Node, to: Node): number[] | null => {
    const path: number[] = []
    let n: Node | null = to
    while (n && n !== from) {
      const parent: Node | null = n.parentNode
      if (!parent) return null
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, n))
      n = parent
    }
    return n === from ? path : null
  }
  const follow = (from: Node, path: number[]): Node | null => {
    let n: Node | null = from
    for (const i of path) n = n?.childNodes[i] ?? null
    return n
  }
  const leaveGhost = (node: HTMLElement, parent: Node, before: Node | null, now: number) => {
    if (node.querySelector(NO_COPY)) return
    const copy = node.cloneNode(true) as HTMLElement
    copy.setAttribute('data-ghost', '')
    ghosted.add(node)
    copy.setAttribute('aria-hidden', 'true')
    copy.setAttribute('inert', '')
    copy.removeAttribute('id')
    for (const el of copy.querySelectorAll('[id]')) el.removeAttribute('id')
    for (const el of copy.querySelectorAll('img')) el.setAttribute('decoding', 'sync')
    // What was typed and ticked: a clone carries attributes, not live values.
    const live = node.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')
    const dead = copy.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')
    live.forEach((el, i) => {
      const c = dead[i]
      if (!c) return
      try {
        c.value = el.value
        if ('checked' in el && 'checked' in c) (c as HTMLInputElement).checked = (el as HTMLInputElement).checked
      } catch { /* a file input refuses; it is fading anyway */ }
    })
    const mid: { path: number[]; p: Played; at: number }[] = []
    for (const el of playing.keys()) {
      if (!node.contains(el)) continue
      const c = cutShort(el, now)
      const path = c && pathTo(node, el)
      if (c && path) mid.push({ path, ...c })
      playing.delete(el)
    }
    const scrolls: { path: number[]; xy: [number, number] }[] = []
    for (const [el, xy] of scrolled) {
      if (!node.contains(el)) continue
      const path = pathTo(node, el)
      if (path) scrolls.push({ path, xy })
      scrolled.delete(el)
    }
    try {
      parent.insertBefore(copy, before && before.parentNode === parent ? before : null)
    } catch {
      return
    }
    const cs = getComputedStyle(copy)
    const inner = copy.matches(OVERLAY) ? cs : getComputedStyle(copy.firstElementChild as Element)
    const floats = (c: CSSStyleDeclaration) => c.position === 'fixed' || c.position === 'absolute'
    if (cs.display === 'none' || !(floats(cs) || floats(inner))) {
      copy.remove()   // in the flow of the page: holding it would hold the layout
      return
    }
    for (const { path, xy } of scrolls) {
      const el = follow(copy, path)
      if (el instanceof HTMLElement) { el.scrollLeft = xy[0]; el.scrollTop = xy[1] }
    }
    // Still arriving when it was removed: leave from where it had got to.
    for (const { path, p, at } of mid) {
      const el = follow(copy, path)
      if (!(el instanceof HTMLElement)) continue
      const v = valuesAt(p, at, el)
      if (!v) continue
      el.style.opacity = v.opacity
      el.style.transform = v.transform
    }
    let gone = false
    const drop = () => { if (!gone) { gone = true; copy.remove() } }
    copy.addEventListener('animationend', (e) => { if (e.target === copy) drop() })
    window.setTimeout(drop, GHOST_MAX_MS)
  }

  const mo = new MutationObserver((records) => {
    const now = performance.now()
    const reduced = motionReduced()
    let added: HTMLElement[] | null = null
    for (const r of records) {
      if (r.type === 'attributes') {
        if (!reduced && r.target instanceof HTMLElement && r.target.isConnected && !r.target.hasAttribute('data-ghost')) retarget(r.target, now)
        continue
      }
      if (reduced || crossing || !r.removedNodes.length) continue
      for (const n of r.removedNodes) {
        if (!(n instanceof HTMLElement) || n.isConnected) continue
        if (n.hasAttribute('data-ghost') || n.hasAttribute('data-closing') || n.hasAttribute('data-no-exit')) continue
        if (!r.target.isConnected) continue
        const g = ghostOf(n)
        if (!g) continue
        if (!added) {
          added = []
          for (const x of records) for (const a of x.addedNodes) if (a instanceof HTMLElement && a.isConnected) added.push(a)
        }
        if (added.some((a) => sameKind(g, a))) continue
        leaveGhost(g, r.target, r.nextSibling, now)
      }
    }
  })
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-closing'] })
}
