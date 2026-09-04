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

/* THE SHELL'S OWN CLICK, WHEN THERE IS A SHELL.

   Inside the Android app navigator.vibrate is two disappointments: Chromium
   refuses it until the document has been tapped once, so the first press
   after every load is silent, and what it does play is a bare 8 to 12ms
   motor pulse that a thumb on a modern handset cannot feel. Measured on a
   Galaxy S23: the call returned true and nothing perceptible happened. The
   shell exposes performHapticFeedback, which plays the phone's own tuned
   click and honours its touch-feedback setting, so it is asked first; the
   Vibration API remains for a browser, where there is nothing else. */
function shellHaptic(): ((kind: string) => void) | null {
  if (typeof window === 'undefined') return null
  const h = window.ErpShell?.haptic
  return typeof h === 'function' ? (kind) => h.call(window.ErpShell, kind) : null
}

function canBuzz(): boolean {
  if (quiet) return false
  if (shellHaptic()) return true
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
    const shell = shellHaptic()
    if (shell) {
      shell(kind)
      return
    }
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

/* EVERY OTHER BUTTON IN THE PRODUCT.

   The calls above are placed by hand at moments worth marking — the drawer
   committing, a page landing under the dots — and they cover the bento
   surfaces and nothing else. A Save at the foot of a form, a choice in a
   dialog, a row in a sheet: all silent, which is most of the buttons somebody
   presses in a day.

   Hand-placing the rest is not a real option. There are several hundred
   buttons across a hundred and sixty files, and a change that must be made in
   each of them is one that will be two thirds applied a month from now — this
   codebase has the Skeleton family, written and argued for and then imported
   by six files out of two hundred and ninety-one, as the proof.

   So one listener at the document, in the CAPTURE phase, because several
   menus here call stopPropagation and a bubbling listener would lose exactly
   the controls that need feedback most.

   `pointerdown`, not click: the confirmation belongs to the press. On a slow
   screen a pulse that waits for the click arrives after the action has run,
   which reads as a response to something else.

   Touch only and primary pointer only — a mouse has its own click, and a
   stylus hovering is not a press. Never on a disabled control: that is the
   one moment somebody needs to notice the thing is unavailable, and buzzing
   would say the opposite. */
export function startHaptics() {
  if (typeof document === 'undefined') return
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isPrimary || e.pointerType !== 'touch') return
      const el = (e.target as HTMLElement | null)?.closest?.(
        'button, [role="button"], [role="tab"], [role="menuitem"], [role="option"],' +
          ' [role="switch"], summary, label[for], input[type="checkbox"], input[type="radio"]',
      )
      if (!el) return
      if (el.matches('[disabled], [aria-disabled="true"]')) return
      buzz('tap')
    },
    { capture: true, passive: true },
  )
}
