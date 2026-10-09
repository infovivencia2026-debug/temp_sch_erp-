/* THE iOS LAUNCH, BOTH WAYS (owner, 2026-10-08: "very smooth, and closing
   should be like that too").

   Opening: the surface grows out of the point that was pressed (bento-theme.css,
   ios-launch). The press point is recorded on every pointerdown (Shell.tsx,
   --tap-x/--tap-y); markLaunch() freezes it as the surface's home, so the
   close goes back into the button that opened it rather than into the close
   button.

   Closing: playClose() runs the same motion in reverse on the element, then
   calls `then` -- the real close or navigation. Guarded so `then` runs once
   whether the animation ends, is skipped (reduced motion), or never starts. */

/* TWO SCALES, NOT ONE (owner's sample, 2026-10-09: `scale(sx, sy)` from
   btnRect.width / winRect.width and btnRect.height / winRect.height).

   One number for both axes was the thing that still did not feel like the
   sample. The gear is a 40x40 square and the window is 920x760, so a single
   gear-width-over-panel-width scale of 0.043 starts the window as a 40px
   wide, 33px tall sliver: a letterbox unfolding, not an icon opening. Each
   axis against its own measurement starts it as the gear's own square and
   the whole motion reads as the one object growing.

   Measured against the real panel when there is one on screen -- on the way
   out there always is -- and against what the panel is about to be when
   there is not: 920px or 92vw across, and the min(88vh, 760px) its own class
   sets. */
function setVectors(panel?: { width: number; height: number } | null): void {
  const root = document.documentElement
  const cs = getComputedStyle(root)
  root.style.setProperty('--launch-x', cs.getPropertyValue('--tap-x').trim() || '50vw')
  root.style.setProperty('--launch-y', cs.getPropertyValue('--tap-y').trim() || '50vh')
  /* offsetWidth/offsetHeight, never getBoundingClientRect: the rect is the
     element's VISUAL box and includes the transform, so measuring the panel
     a frame into its own launch returned the 35px it was scaled down to and
     the next scale came out at 1.0 -- a window that starts at full size and
     only slides. Measured live: sx 1.0092. The layout size is what the
     ratio needs and it is what these two properties report.

     A panel narrower than 200px is one being measured mid-flight anyway;
     the estimate below is better than a number that would make the motion
     disappear. */
  const measured = panel && panel.width > 200 && panel.height > 200 ? panel : null
  const pw = measured?.width || Math.min(920, window.innerWidth * 0.92)
  const ph = measured?.height || Math.min(window.innerHeight * 0.88, 760)
  /* The gear itself, when it can be found: its centre and its size. */
  const gear = [...document.querySelectorAll<HTMLElement>('button[aria-label="Settings"]')].find((b) => b.getBoundingClientRect().width > 0)
  const g = gear?.getBoundingClientRect()
  if (g) {
    root.style.setProperty('--launch-x', `${g.left + g.width / 2}px`)
    root.style.setProperty('--launch-y', `${g.top + g.height / 2}px`)
  }
  const gw = g?.width || 40
  const gh = g?.height || 40
  const sx = Math.max(0.02, gw / pw)
  const sy = Math.max(0.02, gh / ph)
  root.style.setProperty('--launch-sx', sx.toFixed(4))
  root.style.setProperty('--launch-sy', sy.toFixed(4))
  /* Kept for anything still reading the single-axis name. */
  root.style.setProperty('--launch-scale', sx.toFixed(4))
}

export function markLaunch(): void {
  if (typeof document === 'undefined') return
  const open = document.querySelector<HTMLElement>('[data-appearance-dialog]')
  setVectors(open ? { width: open.offsetWidth, height: open.offsetHeight } : null)
}

export function playClose(el: Element | null | undefined, then: () => void, extra?: Element | null): void {
  let done = false
  const finish = () => { if (done) return; done = true; endLaunch(); then() }
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (!el || reduced) { finish(); return }
  /* Re-measured against the panel as it actually stands: the window may
     have been resized, and the dock the gear sits in moves between layouts.
     The sample reads the same geometry afresh on both halves of the trip. */
  if (typeof document !== 'undefined') {
    const h = el as HTMLElement
    setVectors(h.offsetWidth ? { width: h.offsetWidth, height: h.offsetHeight } : null)
  }
  el.setAttribute('data-closing', '')
  extra?.setAttribute('data-closing', '')
  const onEnd = (e: Event) => { if (e.target === el && /t-out|close/.test((e as AnimationEvent).animationName)) { el.removeEventListener('animationend', onEnd); finish() } }
  el.addEventListener('animationend', onEnd)
  window.setTimeout(finish, 520)
}

/* ONLY WHEN SETTINGS IS OPENED (owner, 2026-10-08: switching Work/Focus, or
   any change inside, replayed the launch). The surface remounts when the
   layout changes, so "first render" is not "opened". A flag stays up from
   the open until a real close; a remount while it is up does not launch. */
const w = () => (typeof window === 'undefined' ? {} : window) as { __settingsOpen?: boolean }
export function shouldLaunch(): boolean {
  if (w().__settingsOpen) return false
  w().__settingsOpen = true
  return true
}
export function endLaunch(): void {
  w().__settingsOpen = false
}
/** Lower the flag a moment after a surface goes away, if no settings surface
    replaced it (the phone's back gesture closes without playClose). */
export function endLaunchIfGone(ms = 2500): void {
  window.setTimeout(() => {
    if (!document.querySelector('[data-appearance-dialog], .settings-screen')) endLaunch()
  }, ms)
}
