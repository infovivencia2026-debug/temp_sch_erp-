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

export function markLaunch(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const cs = getComputedStyle(root)
  root.style.setProperty('--launch-x', cs.getPropertyValue('--tap-x').trim() || '50vw')
  root.style.setProperty('--launch-y', cs.getPropertyValue('--tap-y').trim() || '50vh')
}

export function playClose(el: Element | null | undefined, then: () => void, extra?: Element | null): void {
  let done = false
  const finish = () => { if (done) return; done = true; endLaunch(); then() }
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (!el || reduced) { finish(); return }
  el.setAttribute('data-closing', '')
  extra?.setAttribute('data-closing', '')
  el.addEventListener('animationend', finish, { once: true })
  window.setTimeout(finish, 380)
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
export function endLaunchIfGone(): void {
  window.setTimeout(() => {
    if (!document.querySelector('[data-appearance-dialog], .settings-screen')) endLaunch()
  }, 2500)
}
