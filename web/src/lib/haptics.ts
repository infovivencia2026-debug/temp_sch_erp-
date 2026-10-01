/* HAPTICS: the phone answers a decision, not a touch.

   The Vibration API is the whole mechanism -- Android WebView honours it when
   the shell app holds the VIBRATE permission, iOS ignores it entirely, and a
   desktop has nothing to shake -- so every call here is a suggestion the
   platform is free to decline.

   There used to be one document-level listener that pulsed on EVERY press of
   any button, tab, row or checkbox in the product. On a phone that is a buzz
   for opening a card, a buzz for switching a tab, a buzz for ticking a box,
   several hundred a day, and the owner's verdict was "unnecessary vibrations,
   for all". It is gone. Every pulse is now placed by hand, and the list is
   short enough to print:

     event                                            kind     why
     ------------------------------------------------ -------- ----------------------------------------
     chat: long-press confirms, menu appears          select   a hold has no visible press; this is it
     bento: long-press enters edit (arrange) mode     select   same: the hold is confirmed, not the tap
     bento: long-press on a launcher tile, menu       select   same
     bento: card picked up (held until it lifts)      select   the thumb now carries something
     bento: card dropped into a NEW slot              snap     the board accepted the move
     arrange sheet: handle picked up                  select   as above
     arrange sheet: row dropped at a new position     snap     as above
     board page lands under the dots                  select   once per landing, never per pixel
     launcher sheet commits open / closed             open/snap the drawer settled; the drag stays silent
     "Saved" tile the app shows after a submit        tap      one short tick with the confirmation
     "Removed" tile after a DELETE the server took    warn     something is gone; two pulses, not a tap
     Sign out pressed                                 warn     destructive; it cannot be read as a tap

   Nothing on: plain button taps, tab switches, opening a card or screen,
   picking from a dropdown, typing, scrolling, hover, keyboard moves, or
   anything on a timer. A phone that buzzes while nobody is deciding anything
   is a phone somebody puts down.

   Two gates, both honoured before any pattern plays:
     - the person's own switch, Settings > Appearance > Haptics (lib/appearance);
     - the OS's reduced-motion preference, for the Vibration API path. The
       Android shell's performHapticFeedback follows the phone's own
       touch-feedback setting instead, which is the same preference by its
       native name. */

import { getAppearance } from './appearance'

export type Haptic = 'tap' | 'select' | 'open' | 'snap' | 'warn'

const PATTERNS: Record<Haptic, number | number[]> = {
  /* The "Saved" tick: barely there. */
  tap: 8,
  /* A hold confirmed, a card lifted, a page landing under the dots. */
  select: 12,
  /* The drawer committing open. */
  open: [10, 30, 14],
  /* The drawer sliding back down, a card dropped: a shorter, single answer. */
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

/** The person's own switch. Read on every call rather than cached: the
    setting changes from a row in Settings and must take effect on the next
    pulse, not the next load. */
function wanted(): boolean {
  try {
    return getAppearance().haptics !== 'off'
  } catch {
    return true
  }
}

function canBuzz(): boolean {
  if (quiet) return false
  if (!wanted()) return false
  if (shellHaptic()) return true
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false
  } catch {
    /* no matchMedia: assume motion is welcome */
  }
  return true
}

/** Fire one pattern. Safe to call anywhere; a no-op off a phone, when the
    person has switched haptics off, or when the OS asks for reduced motion. */
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
