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
  '--primary-hover',
  '--primary-soft',
  '--primary-foreground',
] as const

/* The school's SECOND colour, on its own tokens.

   accent_color was a branding field a school could fill in and see nowhere: it
   was stored, editable, and never written to the DOM. It is deliberately NOT
   mapped onto the theme's `--accent`, which is a neutral hover surface (and the
   assistant's bubble) -- painting a brand colour there would turn every hover
   row and secondary surface saturated and, in dark mode, illegible.

   Instead it gets its own family, `--brand-accent`, that components opt into
   (the assistant's action chips, for one). A school that sets no accent leaves
   these unset and nothing changes. */
const ACCENT_KEYS = [
  '--brand-accent',
  '--brand-accent-soft',
  '--brand-accent-foreground',
] as const

const HEX = /^#[0-9a-fA-F]{6}$/

let written = false
let accentWritten = false

/* THE SAME COLOUR, READABLE IN THE DARK.

   The school's colour is written inline on the root, so it applies in both
   themes, and a deep brand blue (#1e40af) used as link and label ink on a dark
   card measured 2:1. In dark the colour is lifted toward white just until it
   reads on the dark card (4.5:1), its soft tint is mixed into the dark ground
   rather than into white (a pale chip on a dark page), and the ink on it is
   chosen again. Light is untouched. Re-painted whenever the theme flips. */
const DARK_CARD = '#171717'
let lastPrimary: string | null = null
let watching = false

function paintPrimary(root: HTMLElement, hex: string) {
  const dark = root.classList.contains('dark')
  let base = hex
  if (dark) {
    for (let t = 0.1; contrast(base, DARK_CARD) < 4.5 && t <= 0.9; t += 0.1) base = mix(hex, '#ffffff', t)
  }
  // Derived, not assumed: a hover a shade darker, a soft tint for the pressed
  // and selected grounds, and a foreground chosen for contrast on the colour
  // itself so text on a primary button is never the unreadable half.
  const hover = dark ? mix(base, '#ffffff', 0.12) : mix(base, '#000000', 0.18)
  const soft = dark ? mix(base, '#141418', 0.8) : mix(base, '#ffffff', 0.86)
  const fg = contrast(base, '#ffffff') >= contrast(base, '#111111') ? '#ffffff' : '#111111'
  root.style.setProperty('--primary', hslTriplet(base))
  /* NOT --ring. A school whose colour is red had every focused box
     outlined in red, which is what an error looks like. The focus ring
     stays the product's neutral blue whatever the brand is. */
  root.style.setProperty('--primary-hover', hslTriplet(hover))
  root.style.setProperty('--primary-soft', hslTriplet(soft))
  root.style.setProperty('--primary-foreground', hslTriplet(fg))
}

function watchTheme(root: HTMLElement) {
  if (watching || typeof MutationObserver === 'undefined') return
  watching = true
  let wasDark = root.classList.contains('dark')
  new MutationObserver(() => {
    const isDark = root.classList.contains('dark')
    if (isDark === wasDark) return
    wasDark = isDark
    if (lastPrimary) paintPrimary(root, lastPrimary)
  }).observe(root, { attributes: true, attributeFilter: ['class'] })
}

/** Paint the school's colours, or clear them back to the theme's. */
export function applyBrand(primary?: string | null, accent?: string | null) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const hex = (primary ?? '').trim()

  // Anything that is not a six-digit hex is refused rather than rendered as
  // black — the same contract the Branding field states to the user.
  if (!HEX.test(hex)) {
    lastPrimary = null
    if (written) {
      for (const k of KEYS) root.style.removeProperty(k)
      written = false
    }
  } else {
    paintPrimary(root, hex)
    written = true
    lastPrimary = hex
    watchTheme(root)
  }

  const acc = (accent ?? '').trim()
  if (!HEX.test(acc)) {
    if (accentWritten) {
      for (const k of ACCENT_KEYS) root.style.removeProperty(k)
      accentWritten = false
    }
    return
  }
  const accSoft = mix(acc, '#ffffff', 0.86)
  const accFg = contrast(acc, '#ffffff') >= contrast(acc, '#111111') ? '#ffffff' : '#111111'
  root.style.setProperty('--brand-accent', hslTriplet(acc))
  root.style.setProperty('--brand-accent-soft', hslTriplet(accSoft))
  root.style.setProperty('--brand-accent-foreground', hslTriplet(accFg))
  accentWritten = true
}

/* THE SCHOOL'S MARK FOR THE OPENING SCREEN.

   The opening (components/WorkspaceLoading.tsx) is on screen before the
   session answers, so it cannot ask whose school this is. The last session
   on this device leaves the school's name and logo here, the logo as a data
   URL so it paints on the first frame with no request. White label: the
   opening shows the school, never the product's name; with nothing stored it
   shows no name at all. */
export interface SchoolMark { name: string; logo?: string; key?: string }
const MARK_KEY = 'erp.schoolMark'

export function readSchoolMark(): SchoolMark | null {
  try {
    const raw = localStorage.getItem(MARK_KEY)
    const m = raw ? (JSON.parse(raw) as SchoolMark) : null
    return m && typeof m.name === 'string' && m.name ? m : null
  } catch { return null }
}

export function rememberSchoolMark(name: string | undefined, logoKey: string | undefined) {
  if (!name) return
  const prev = readSchoolMark()
  const key = logoKey || ''
  if (prev && prev.name === name && (prev.key || '') === key) return
  const save = (logo?: string) => {
    try { localStorage.setItem(MARK_KEY, JSON.stringify({ name, key, ...(logo ? { logo } : {}) })) } catch { /* private mode */ }
  }
  save(prev && (prev.key || '') === key ? prev.logo : undefined)
  if (!key) return
  fetch(`/api/v1/files/${key}?inline=1`, { credentials: 'include' })
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => {
      if (!b || b.size > 150_000 || !b.type.startsWith('image/')) return
      const fr = new FileReader()
      fr.onload = () => { if (typeof fr.result === 'string') save(fr.result) }
      fr.readAsDataURL(b)
    })
    .catch(() => {})
}
