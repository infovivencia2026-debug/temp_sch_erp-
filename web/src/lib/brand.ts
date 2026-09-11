import { contrast, hslTriplet, mix } from './personality'

/* THE SCHOOL'S OWN COLOUR, PAINTED ONTO THE PRODUCT.

   A school sets a primary colour on the Branding screen and, until now, saw it
   nowhere: the theme's `--primary` — the colour of every primary button, link,
   focus ring and active nav row — comes from the *reader's* personality choice,
   and the school colour was wired only to the header avatar tile, which a
   school with a logo never sees. So "I entered a colour and nothing changed"
   was the literal truth.

   This sets the `--primary` family inline on the root from the school's colour.
   Inline beats the personality stylesheet's selector rules, so the school's
   colour wins wherever a reader has not deliberately chosen a personality, and
   still loses to nothing a personality needs for legibility because the derived
   contrast colour is computed here, not assumed.

   Only the primary family is touched. The neutral surfaces (ground, card, ink)
   are left to the theme, because a school's brand red is a colour for the one
   thing you press, not for the paper behind everything. */

const KEYS = [
  '--primary',
  '--ring',
  '--primary-hover',
  '--primary-soft',
  '--primary-foreground',
] as const

const HEX = /^#[0-9a-fA-F]{6}$/

let written = false

/** Paint the school's primary colour, or clear it back to the theme's. */
export function applyBrand(primary?: string | null) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const hex = (primary ?? '').trim()

  // Anything that is not a six-digit hex is refused rather than rendered as
  // black — the same contract the Branding field states to the user.
  if (!HEX.test(hex)) {
    if (written) {
      for (const k of KEYS) root.style.removeProperty(k)
      written = false
    }
    return
  }

  // Derived, not assumed: a hover a shade darker, a soft tint for the pressed
  // and selected grounds, and a foreground chosen for contrast on the colour
  // itself so text on a primary button is never the unreadable half.
  const hover = mix(hex, '#000000', 0.18)
  const soft = mix(hex, '#ffffff', 0.86)
  const fg = contrast(hex, '#ffffff') >= contrast(hex, '#111111') ? '#ffffff' : '#111111'

  root.style.setProperty('--primary', hslTriplet(hex))
  root.style.setProperty('--ring', hslTriplet(hex))
  root.style.setProperty('--primary-hover', hslTriplet(hover))
  root.style.setProperty('--primary-soft', hslTriplet(soft))
  root.style.setProperty('--primary-foreground', hslTriplet(fg))
  written = true
}
