/* HAPTICS: the phone answers a press.

   A home screen that opens a drawer or turns a page without a tick under
   the thumb reads as a web page; the same motion with a 10ms pulse reads as
   the phone. The Vibration API is the whole mechanism -- Android WebView
   honours it when the shell app holds the VIBRATE permission, iOS ignores it
   entirely, and a desktop has nothing to shake -- so every call here is a
   suggestion the platform is free to decline.

   Kept to moments that are already a decision: a card opening, the drawer
   snapping up or back, a page landing, a destructive confirmation. Never on
   hover, scroll, or anything that fires on a timer, because a phone that
   buzzes while nobody is touching it is a phone somebody puts down.

   Respects reduced motion: a person who has asked the OS for less movement
   has asked for less of this too. */

export type Haptic = 'tap' | 'select' | 'open' | 'snap' | 'warn'

const PATTERNS: Record<Haptic, number | number[]> = {
  /* A card, a dock button: barely there. */
  tap: 8,
  /* A page landing under the dots. */
  select: 12,
  /* The drawer committing; a screen opening. */
  open: [10, 30, 14],
  /* The drawer sliding back down: a shorter, single answer. */
  snap: 10,
  /* Something about to be lost. Two, so it cannot be read as a tap. */
  warn: [20, 40, 20],
}

let quiet = false

function canBuzz(): boolean {
  if (quiet) return false
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false
  } catch {
    /* no matchMedia: assume motion is welcome */
  }
  return true
}

/** Fire one pattern. Safe to call anywhere; a no-op off a phone. */
export function buzz(kind: Haptic) {
  if (!canBuzz()) return
  try {
    navigator.vibrate(PATTERNS[kind])
  } catch {
    /* A browser that has the function and refuses it: the page is not
       responsible for the phone's mood. */
  }
}

/** Switch every pulse off for this session, for a screen that must be silent. */
export function silenceHaptics(on: boolean) {
  quiet = on
}
