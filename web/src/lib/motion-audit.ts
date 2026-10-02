/* THE MOTION AUDIT. Development only (main.tsx loads it under import.meta.env.DEV).

   "It looked smooth when I tried it" is not a measurement. This watches every
   animation and transition the page runs and writes down the five ways one
   can break part-way:

     cancelled   an animationcancel / transitioncancel event: something
                 re-rendered, re-classed or hid the element before it finished
     cut         the element left the document while still animating, so its
                 exit (or its entrance) was never seen to the end
     jump        opacity, position or scale moved further between two frames
                 than the animation's own pace allows: a restart or an end snap
     replay      the same entrance played more than once on one element
     layout      a transition on a property that reflows (height, top, margin)
     long        a finite animation longer than 600ms

   `window.__motionAudit()` prints and returns the report;
   `window.__motionAudit.reset()` empties it. Loops (skeleton sweep, spinner)
   are counted but not sampled. */

import { JUMP_FLOOR, isJump, type Sample } from './motion'

type Row = { kind: string; what: string; el: string; detail?: string; at: number }
type Tracked = { s: Sample; t: number; dur: number; seenDur?: number; live: boolean; names: string }

/** A skeleton or spinner: replaced the moment the data lands, by design. */
const loops = (el: Element) => el.classList.contains('skeleton') || el.classList.contains('ring-loader')

const LAYOUT_PROPS = /^(height|width|top|left|right|bottom|margin|padding|max-height|min-height|max-width|inset)/
const LONG_MS = 600

function describe(el: Element | null): string {
  if (!el) return '(none)'
  const role = el.getAttribute('role')
  const label = el.getAttribute('aria-label')
  const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : ''
  return `${el.tagName.toLowerCase()}${role ? `[role=${role}]` : ''}${cls ? `.${cls}` : ''}${label ? `"${label.slice(0, 24)}"` : ''}`
}

function sample(el: Element): Sample {
  const c = getComputedStyle(el)
  const r = (el as HTMLElement).getBoundingClientRect()
  let m = { a: 1, d: 1, e: 0, f: 0 }
  try {
    if (c.transform && c.transform !== 'none') {
      const x = new DOMMatrixReadOnly(c.transform)
      m = { a: x.a, d: x.d, e: x.e, f: x.f }
    }
  } catch { /* an engine without DOMMatrix reads as untransformed */ }
  return { opacity: Number(c.opacity), x: m.e, y: m.f, sx: m.a, sy: m.d, w: Math.max(1, r.width), h: Math.max(1, r.height) }
}

export function installMotionAudit() {
  if (typeof window === 'undefined' || typeof document.getAnimations !== 'function') return
  const rows: Row[] = []
  const tracked = new Map<Element, Tracked>()
  const played = new WeakMap<Element, Map<string, number>>()
  const ids = new WeakMap<Element, number>()
  let seq = 0
  let raf = 0
  const push = (kind: string, what: string, el: Element | null, detail?: string) => {
    if (rows.length < 2000) rows.push({ kind, what, el: describe(el), detail, at: Math.round(performance.now()) })
  }

  const frame = () => {
    raf = 0
    const now = performance.now()
    const seen = new Set<Element>()
    for (const a of document.getAnimations()) {
      const eff = a.effect as KeyframeEffect | null
      const el = eff?.target
      if (!el || eff.pseudoElement || el.closest('[data-ghost]')) continue
      const t = eff.getComputedTiming()
      if (t.iterations === Infinity || a.playState !== 'running') continue
      // Driven by the scroll position, not by time: there is no pace to judge.
      if (a.timeline && a.timeline !== document.timeline) continue
      seen.add(el)
      const name = (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? 'script'
      const dur = Math.max(1, Number(t.duration) || 0)
      const prev = tracked.get(el)
      if (prev) { prev.live = true; prev.names = name; prev.dur = Math.min(prev.seenDur ?? dur, dur); prev.seenDur = prev.dur }
      else tracked.set(el, { s: sample(el), t: now, dur, live: true, names: name })
    }
    for (const [el, tr] of tracked) {
      if (!el.isConnected) {
        if (tr.live && !loops(el)) push('cut', tr.names, el, 'removed from the document while animating')
        tracked.delete(el)
        continue
      }
      const s = sample(el)
      // One frame is never less than a 60Hz frame: rAF can fire twice inside one.
      const why = isJump(tr.s, s, Math.max(17, now - tr.t) / tr.dur)
      if (why) push('jump', tr.names, el, `${why} in ${Math.round(now - tr.t)}ms of ${Math.round(tr.dur)}ms`)
      tr.seenDur = undefined
      if (!seen.has(el)) {
        // One more frame after the end, to catch an end snap; then let go.
        if (!tr.live) { tracked.delete(el); continue }
        tr.live = false
      }
      tr.s = s
      tr.t = now
    }
    if (tracked.size) raf = requestAnimationFrame(frame)
  }
  const wake = () => { if (!raf) raf = requestAnimationFrame(frame) }

  const onStart = (e: Event) => {
    const el = e.target as Element
    const name = (e as AnimationEvent).animationName
    if (name) {
      const m = played.get(el) ?? new Map<string, number>()
      const n = (m.get(name) ?? 0) + 1
      m.set(name, n)
      played.set(el, m)
      const loops = getComputedStyle(el).animationIterationCount.includes('infinite')
      if (n > 1 && !loops) push('replay', name, el, `played ${n} times on one element`)
      for (const a of el.getAnimations()) {
        const t = a.effect?.getComputedTiming()
        if (!t || t.iterations === Infinity) continue
        if (a.timeline && a.timeline !== document.timeline) continue
        const total = Number(t.duration) * Number(t.iterations ?? 1)
        if ((a as CSSAnimation).animationName === name && total > LONG_MS) push('long', name, el, `${Math.round(total)}ms`)
      }
    } else {
      const prop = (e as TransitionEvent).propertyName
      rerun.add(key(el, prop))
      requestAnimationFrame(() => requestAnimationFrame(() => rerun.delete(key(el, prop))))
      if (LAYOUT_PROPS.test(prop) && !(el as HTMLElement).hasAttribute('data-motion-layout-ok')) push('layout', prop, el, 'a transition on a property that reflows')
    }
    wake()
  }
  /* A transition retargeted mid-way (hover off, a second tab pressed) reports
     transitioncancel and then starts again from where it was: smooth, and not
     a break. Only a cancel with no new run in the same frame is recorded. */
  const rerun = new Set<string>()
  const key = (el: Element, prop: string) => `${ids.get(el) ?? (ids.set(el, ++seq), seq)}:${prop}`
  const onCancel = (e: Event) => {
    const el = e.target as Element
    if (el.closest('[data-ghost]') || loops(el)) return
    const name = (e as AnimationEvent).animationName
    if (name) { push('cancelled', name, el, e.type); return }
    const prop = (e as TransitionEvent).propertyName
    const k = key(el, prop)
    requestAnimationFrame(() => {
      if (!rerun.delete(k) && el.isConnected) push('cancelled', prop, el, e.type)
    })
  }
  document.addEventListener('animationstart', onStart, true)
  document.addEventListener('transitionrun', onStart, true)
  document.addEventListener('animationcancel', onCancel, true)
  document.addEventListener('transitioncancel', onCancel, true)

  const report = () => {
    const by: Record<string, Row[]> = {}
    for (const r of rows) (by[r.kind] ??= []).push(r)
    const out = {
      floor: JUMP_FLOOR,
      cancelled: by.cancelled ?? [],
      cut: by.cut ?? [],
      jump: by.jump ?? [],
      replay: by.replay ?? [],
      layout: by.layout ?? [],
      long: by.long ?? [],
    }
    // eslint-disable-next-line no-console
    if (rows.length) console.table(rows)
    return out
  }
  ;(window as unknown as { __motionAudit: (() => unknown) & { reset: () => void } }).__motionAudit = Object.assign(report, {
    reset: () => { rows.length = 0 },
  })
}
