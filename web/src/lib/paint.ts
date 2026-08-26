import { useCallback, useSyncExternalStore } from 'react'
import { applyTheme } from './theme'

/* Painting parts of the interface.

   Nine appearance axes choose between designs somebody else decided. This is
   the other kind of customisation: pick a region, pick a channel, pick a
   colour, and the product takes it. Every combination is a CSS custom property
   on the root, and index.css consumes each one with the shipped token as its
   fallback — so an unpainted region is not "painted with the default", it is
   simply not painted, and the design keeps moving underneath it when the theme
   or the skin changes.

   That fallback is the whole architecture. Storing resolved colours for
   everything would freeze the product at the moment somebody opened this
   dialog: switch to dark afterwards and every surface would still be the light
   one they picked. Only what was deliberately chosen is stored. */

/* Twelve domains, not five.

   The palettes have always shipped all twelve — attendance, staff, admissions,
   communication, critical, warning and success as well as the five that were
   listed here — and every one of them tints cells on the boards. Seven of them
   simply had no region in the colour dialog, so those cards could not be
   recoloured at all, by anybody, ever. Together with the `-soft` bug below
   that is the whole of "I cannot change the colour of a few cells": five
   domains were paintable and broken, seven were not paintable at all. */
export type Region = 'workarea' | 'topbar' | 'sidebar' | 'bottombar' | 'cards'
  | 'students' | 'academics' | 'attendance' | 'finance' | 'staff' | 'admissions'
  | 'communication' | 'operations' | 'reports' | 'critical' | 'warning' | 'success'
export type Channel = 'bg' | 'text' | 'accent'

export const REGIONS: readonly Region[] = [
  'workarea', 'topbar', 'sidebar', 'bottombar', 'cards',
  'students', 'academics', 'attendance', 'finance', 'staff', 'admissions',
  'communication', 'operations', 'reports', 'critical', 'warning', 'success',
] as const
export const CHANNELS: readonly Channel[] = ['bg', 'text', 'accent'] as const

/** An HSL triple, kept unresolved so it can be written straight into a token
    that the rest of the stylesheet composes with alpha. */
export interface Hsl {
  h: number
  s: number
  l: number
}

export type Paint = Partial<Record<`${Region}.${Channel}`, Hsl>>

export interface Palette {
  name: string
  paint: Paint
}

const KEY = 'erp.paint'
const PALETTES_KEY = 'erp.palettes'

export function varName(region: Region, channel: Channel) {
  return `--paint-${region}-${channel}`
}

export function hslString({ h, s, l }: Hsl) {
  return `${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%`
}

export function hslCss(v: Hsl) {
  return `hsl(${hslString(v)})`
}

function readPaint(): Paint {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object') return {}
    const out: Paint = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const c = val as Hsl
      if (c && typeof c.h === 'number' && typeof c.s === 'number' && typeof c.l === 'number') {
        out[k as keyof Paint] = { h: c.h, s: c.s, l: c.l }
      }
    }
    return out
  } catch {
    return {}
  }
}

function readPalettes(): Palette[] {
  try {
    const raw = localStorage.getItem(PALETTES_KEY)
    const v: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? (v as Palette[]).filter((p) => p && typeof p.name === 'string') : []
  } catch {
    return []
  }
}

let paint: Paint = typeof window === 'undefined' ? {} : readPaint()

/* Which shipped palette is on, if any.

   Remembered, because a palette that is forgotten on reload is not a theme, it
   is a party trick. The hand-painted regions in `paint` are layered ON TOP of
   it, so somebody can take a shipped palette and then recolour one region
   without losing the other fifty-four tokens. */
const PALETTE_KEY = 'erp.palette'
let activePalette: string | null =
  typeof window === 'undefined' ? null : (() => {
    try { return localStorage.getItem(PALETTE_KEY) } catch { return null }
  })()

/** Every token this module has written, so the next repaint can take them all
    back. Removing exactly what was set is what stops a half-cleared palette
    leaving a few tokens from the old one behind. */
let written: string[] = []

function paletteByName(name: string | null) {
  return name ? BUILT_IN_PALETTES.find((x) => x.name === name) ?? null : null
}
let palettes: Palette[] = typeof window === 'undefined' ? [] : readPalettes()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Write the whole set to the root, removing what is no longer painted.

    Removal matters as much as setting: a property left behind after somebody
    clears a region would keep that region painted with no way to see why. */
export function applyPaint(next: Paint) {
  paint = next
  repaint()
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* private browsing: the paint lasts the session */
  }
  emit()
}

/* The bento tokens the paint has to reach.

   The `--paint-*` properties are read by index.css, which dresses the classic
   layout. Bento reads none of them — it composes from its own `--bento-*` and
   `--dom-*` set — so a palette applied while in bento repainted the chrome
   around the board and left every box exactly as it was. Which is what was
   asked about: the palettes were for the boxes.

   Mapped, not guessed: ground to ground, card to card, the raised shade to the
   hairline and to the five domain cards. `--bento-muted` is deliberately NOT
   mapped — the muted shade in these sets measures under 4.5:1 on its own card,
   and the theme's derived value clears it. */
const BENTO_MAP: [keyof Paint, string][] = [
  ['workarea.bg', '--bento-bg'],
  ['cards.bg', '--bento-card'],
  ['cards.text', '--bento-ink'],
  ['students.bg', '--bento-line'],
  /* The dock has its own two, falling back to the card. It reads
     `--bento-card` otherwise, so the bottombar region in the colour dialog
     moved nothing and the dock could not be recoloured at all. */
  ['bottombar.bg', '--bento-dock-bg'],
  ['bottombar.text', '--bento-dock-ink'],
]
const BENTO_DOMAINS = [
  'students', 'academics', 'attendance', 'finance', 'staff', 'admissions',
  'communication', 'operations', 'reports', 'critical', 'warning', 'success',
] as const

/* Wipe, lay the shipped palette down, then the hand-painted regions over it.

   Order is the whole design. Clearing first means a token the previous palette
   set and this one does not cannot survive the change. Applying the palette
   before the paint means a hand-painted region always wins over the shipped
   value for that one region, while the other fifty-four tokens stay. */
function repaint() {
  const root = document.documentElement
  for (const k of written) root.style.removeProperty(k)
  written = []
  const set = (k: string, v: string) => {
    root.style.setProperty(k, v)
    written.push(k)
  }

  const shipped = paletteByName(activePalette)
  if (shipped) for (const [k, v] of Object.entries(shipped.tokens)) set(k, v)

  /* WHICH REGIONS ARE ACTUALLY PAINTED, said out loud on the root.

     The rules in index.css read `--paint-sidebar-bg` with the shipped token as
     a fallback, which is correct and was not enough: the sidebar also carries
     Tailwind's `bg-sidebar`, and a class utility and an attribute selector have
     the same specificity, so the one that wins is the one that comes later —
     always the utilities layer. The paint was being written, and the sidebar
     was ignoring it.

     Raising the specificity needs something to raise it WITH, and it has to be
     conditional: `html [data-paint='sidebar']` unconditionally would beat
     bg-sidebar even when nobody has painted anything, which would make the
     fallback the permanent answer and the theme's own sidebar shade
     unreachable. So the root lists the region/channel pairs that have a value,
     and the stylesheet asks for the one it is about. */
  const painted: string[] = []
  for (const r of REGIONS) {
    for (const c of CHANNELS) {
      const v = paint[`${r}.${c}`]
      if (v) {
        set(varName(r, c), hslString(v))
        painted.push(`${r}-${c}`)
      }
    }
  }
  if (painted.length) root.dataset.painted = painted.join(' ')
  else delete root.dataset.painted
  for (const [key, token] of BENTO_MAP) {
    const v = paint[key]
    if (v) set(token, hslCss(v))
  }
  for (const d of BENTO_DOMAINS) {
    const bg = paint[`${d}.bg`]
    const text = paint[`${d}.text`]
    if (bg) {
      /* BOTH TOKENS, and the second one is the whole bug.

         A domain card's ground is `var(--dom-X-soft, var(--dom-X))` — soft
         first, the strong hue only as a fallback. Every shipped palette
         defines `-soft` for all twelve domains, so the fallback never fires,
         and painting only `--dom-X` changed a colour that nothing on the card
         was reading. The setting stored, the swatch updated, and the card did
         not move.

         It looked intermittent, which is what made it hard to believe: a
         domain the active palette happened not to define `-soft` for fell
         through to the strong token and DID recolour, so a few cells worked
         and most did not.

         Both are set to the picked colour now. `--dom-X` is what the dock and
         the launcher mix their accents from, and a school that has chosen a
         ground for Finance means that colour for Finance wherever it appears —
         those uses mix it against the local ink, so they stay legible. */
      set(`--dom-${d}`, hslCss(bg))
      set(`--dom-${d}-soft`, hslCss(bg))
    }
    if (text) set(`--dom-${d}-text`, hslCss(text))
  }
}

export function setPaint(region: Region, channel: Channel, value: Hsl | undefined) {
  const next: Paint = { ...paint }
  if (value) next[`${region}.${channel}`] = value
  else delete next[`${region}.${channel}`]
  applyPaint(next)
}

export function resetPaint() {
  activePalette = null
  remember()
  applyPaint({})
}

/** The shipped palettes: five for light, five for dark.

    Each sets FIFTY-FIVE tokens — every colour the bento surface composes from.
    The earlier version mapped five and let the rest fall through, which is how
    a palette left the muted text, the dock and seven of the twelve domain
    tints wearing the previous theme. A palette that dresses most of a screen
    is worse than none, because the parts it misses look broken rather than
    unstyled.

    Generated and measured rather than picked. Every pairing where text sits on
    a surface was checked against its own background: ink on card, muted on
    card, each of the four accents on card, the anchor's ink on its gradient,
    and all twelve domain inks on their own domain card. The worst pairing in
    any of the four is 4.60:1; nothing ships under 4.5:1. That is also why the
    muted shade is here at all — the hand-picked greys measured 2.7-3.2:1, so
    the honest fix was to compute one that reads, not to leave it out.

    The six added later were generated by the same measurement rather than
    picked by eye: each accent's lightness is walked until it clears 4.6:1 on
    the card it will sit on, and each domain ink until it clears 4.6:1 on its
    own tint. The worst pairing across all ten is 4.60:1, which is the same
    floor the first four were held to. A palette is a hue family and a ground;
    whether its text can be read is not a matter of taste and is not left to
    one. */
export interface BuiltInPalette {
  name: string
  mode: 'light' | 'dark'
  tokens: Record<string, string>
}

export const BUILT_IN_PALETTES: readonly BuiltInPalette[] = [
  {
    name: 'Sage Linen',
    mode: 'light',
    tokens: {
      '--bento-bg': '#eef0ec',
      '--bento-card': '#ffffff',
      '--bento-card-2': '#f5f7f3',
      '--bento-ink': '#000000',
      '--bento-muted': '#000000',
      '--bento-line': '#dee3da',
      '--bento-dock-bg': '#ffffff',
      '--bento-dock-ink': '#000000',
      '--bento-mint': '#1f8466',
      '--bento-mint-tint': '#e7f9f3',
      '--bento-purple': '#9851d6',
      '--bento-purple-tint': '#f0e7f9',
      '--bento-pink': '#d0396b',
      '--bento-pink-tint': '#f9e7ed',
      '--bento-orange': '#a96428',
      '--bento-orange-tint': '#f9efe7',
      '--bento-anchor-from': '#d9e3d2',
      '--bento-anchor-to': '#eef1ea',
      '--bento-anchor-ink': '#000000',
      '--dom-students': '#2e669e',
      '--dom-students-soft': '#dae6f1',
      '--dom-students-text': '#000000',
      '--dom-academics': '#773dc7',
      '--dom-academics-soft': '#e4daf1',
      '--dom-academics-text': '#000000',
      '--dom-finance': '#21735a',
      '--dom-finance-soft': '#daf1ea',
      '--dom-finance-text': '#000000',
      '--dom-operations': '#8e5829',
      '--dom-operations-soft': '#f1e5da',
      '--dom-operations-text': '#000000',
      '--dom-reports': '#276d86',
      '--dom-reports-soft': '#daebf1',
      '--dom-reports-text': '#000000',
      '--dom-staff': '#a22fa2',
      '--dom-staff-soft': '#f1daf1',
      '--dom-staff-text': '#000000',
      '--dom-admissions': '#4d4dcb',
      '--dom-admissions-soft': '#dadaf1',
      '--dom-admissions-text': '#000000',
      '--dom-attendance': '#21736c',
      '--dom-attendance-soft': '#daf1ef',
      '--dom-attendance-text': '#000000',
      '--dom-communication': '#aa316e',
      '--dom-communication-soft': '#f1dae6',
      '--dom-communication-text': '#000000',
      '--dom-critical': '#ae3732',
      '--dom-critical-soft': '#f1dbda',
      '--dom-critical-text': '#000000',
      '--dom-success': '#227745',
      '--dom-success-soft': '#daf1e4',
      '--dom-success-text': '#000000',
      '--dom-warning': '#7e6425',
      '--dom-warning-soft': '#f1eada',
      '--dom-warning-text': '#000000',
    },
  },
  {
    name: 'Rosewood Paper',
    mode: 'light',
    tokens: {
      '--bento-bg': '#f2eeee',
      '--bento-card': '#ffffff',
      '--bento-card-2': '#faf5f5',
      '--bento-ink': '#000000',
      '--bento-muted': '#000000',
      '--bento-line': '#e6dede',
      '--bento-dock-bg': '#ffffff',
      '--bento-dock-ink': '#000000',
      '--bento-mint': '#1f8466',
      '--bento-mint-tint': '#e7f9f3',
      '--bento-purple': '#9851d6',
      '--bento-purple-tint': '#f0e7f9',
      '--bento-pink': '#d0396b',
      '--bento-pink-tint': '#f9e7ed',
      '--bento-orange': '#a96428',
      '--bento-orange-tint': '#f9efe7',
      '--bento-anchor-from': '#eddada',
      '--bento-anchor-to': '#f6ecec',
      '--bento-anchor-ink': '#000000',
      '--dom-students': '#2e669e',
      '--dom-students-soft': '#dae6f1',
      '--dom-students-text': '#000000',
      '--dom-academics': '#773dc7',
      '--dom-academics-soft': '#e4daf1',
      '--dom-academics-text': '#000000',
      '--dom-finance': '#21735a',
      '--dom-finance-soft': '#daf1ea',
      '--dom-finance-text': '#000000',
      '--dom-operations': '#8e5829',
      '--dom-operations-soft': '#f1e5da',
      '--dom-operations-text': '#000000',
      '--dom-reports': '#276d86',
      '--dom-reports-soft': '#daebf1',
      '--dom-reports-text': '#000000',
      '--dom-staff': '#a22fa2',
      '--dom-staff-soft': '#f1daf1',
      '--dom-staff-text': '#000000',
      '--dom-admissions': '#4d4dcb',
      '--dom-admissions-soft': '#dadaf1',
      '--dom-admissions-text': '#000000',
      '--dom-attendance': '#21736c',
      '--dom-attendance-soft': '#daf1ef',
      '--dom-attendance-text': '#000000',
      '--dom-communication': '#aa316e',
      '--dom-communication-soft': '#f1dae6',
      '--dom-communication-text': '#000000',
      '--dom-critical': '#ae3732',
      '--dom-critical-soft': '#f1dbda',
      '--dom-critical-text': '#000000',
      '--dom-success': '#227745',
      '--dom-success-soft': '#daf1e4',
      '--dom-success-text': '#000000',
      '--dom-warning': '#7e6425',
      '--dom-warning-soft': '#f1eada',
      '--dom-warning-text': '#000000',
    },
  },
  {
    name: 'Slate Violet',
    mode: 'light',
    tokens: {
      '--bento-bg': '#eceef4',
      '--bento-card': '#ffffff',
      '--bento-card-2': '#f4f5fb',
      '--bento-ink': '#000000',
      '--bento-muted': '#000000',
      '--bento-line': '#dcdfe9',
      '--bento-dock-bg': '#ffffff',
      '--bento-dock-ink': '#000000',
      '--bento-mint': '#1f8466',
      '--bento-mint-tint': '#e7f9f3',
      '--bento-purple': '#9851d6',
      '--bento-purple-tint': '#f0e7f9',
      '--bento-pink': '#d0396b',
      '--bento-pink-tint': '#f9e7ed',
      '--bento-orange': '#a96428',
      '--bento-orange-tint': '#f9efe7',
      '--bento-anchor-from': '#dcd8ee',
      '--bento-anchor-to': '#eeecf6',
      '--bento-anchor-ink': '#000000',
      '--dom-students': '#2e669e',
      '--dom-students-soft': '#dae6f1',
      '--dom-students-text': '#000000',
      '--dom-academics': '#773dc7',
      '--dom-academics-soft': '#e4daf1',
      '--dom-academics-text': '#000000',
      '--dom-finance': '#21735a',
      '--dom-finance-soft': '#daf1ea',
      '--dom-finance-text': '#000000',
      '--dom-operations': '#8e5829',
      '--dom-operations-soft': '#f1e5da',
      '--dom-operations-text': '#000000',
      '--dom-reports': '#276d86',
      '--dom-reports-soft': '#daebf1',
      '--dom-reports-text': '#000000',
      '--dom-staff': '#a22fa2',
      '--dom-staff-soft': '#f1daf1',
      '--dom-staff-text': '#000000',
      '--dom-admissions': '#4d4dcb',
      '--dom-admissions-soft': '#dadaf1',
      '--dom-admissions-text': '#000000',
      '--dom-attendance': '#21736c',
      '--dom-attendance-soft': '#daf1ef',
      '--dom-attendance-text': '#000000',
      '--dom-communication': '#aa316e',
      '--dom-communication-soft': '#f1dae6',
      '--dom-communication-text': '#000000',
      '--dom-critical': '#ae3732',
      '--dom-critical-soft': '#f1dbda',
      '--dom-critical-text': '#000000',
      '--dom-success': '#227745',
      '--dom-success-soft': '#daf1e4',
      '--dom-success-text': '#000000',
      '--dom-warning': '#7e6425',
      '--dom-warning-soft': '#f1eada',
      '--dom-warning-text': '#000000',
    },
  },
  {
    name: 'Forest Nocturne',
    mode: 'dark',
    tokens: {
      '--bento-bg': '#0a0e0c',
      '--bento-card': '#161b18',
      '--bento-card-2': '#1e2521',
      '--bento-ink': '#ffffff',
      '--bento-muted': '#ffffff',
      '--bento-line': '#28312c',
      '--bento-dock-bg': '#161b18',
      '--bento-dock-ink': '#ffffff',
      '--bento-mint': '#239573',
      '--bento-mint-tint': '#154738',
      '--bento-purple': '#a76adc',
      '--bento-purple-tint': '#301547',
      '--bento-pink': '#d85a84',
      '--bento-pink-tint': '#471525',
      '--bento-orange': '#be702d',
      '--bento-orange-tint': '#472c15',
      '--bento-anchor-from': '#2f4a3a',
      '--bento-anchor-to': '#25352c',
      '--bento-anchor-ink': '#ffffff',
      '--dom-students': '#87a6c5',
      '--dom-students-soft': '#273849',
      '--dom-students-text': '#ffffff',
      '--dom-academics': '#a68dc8',
      '--dom-academics-soft': '#352749',
      '--dom-academics-text': '#ffffff',
      '--dom-finance': '#79bea9',
      '--dom-finance-soft': '#27493f',
      '--dom-finance-text': '#ffffff',
      '--dom-operations': '#c3a183',
      '--dom-operations-soft': '#493727',
      '--dom-operations-text': '#ffffff',
      '--dom-reports': '#80b0c2',
      '--dom-reports-soft': '#274049',
      '--dom-reports-text': '#ffffff',
      '--dom-staff': '#c78ac7',
      '--dom-staff-soft': '#492749',
      '--dom-staff-text': '#ffffff',
      '--dom-admissions': '#8d8dc8',
      '--dom-admissions-soft': '#272749',
      '--dom-admissions-text': '#ffffff',
      '--dom-attendance': '#79beb9',
      '--dom-attendance-soft': '#274946',
      '--dom-attendance-text': '#ffffff',
      '--dom-communication': '#c78aa8',
      '--dom-communication-soft': '#492738',
      '--dom-communication-text': '#ffffff',
      '--dom-critical': '#c78c8a',
      '--dom-critical-soft': '#492827',
      '--dom-critical-text': '#ffffff',
      '--dom-success': '#79be96',
      '--dom-success-soft': '#274935',
      '--dom-success-text': '#ffffff',
      '--dom-warning': '#c0ac7c',
      '--dom-warning-soft': '#493f27',
      '--dom-warning-text': '#ffffff',
    },
  },
  {
    name: 'Plum Nocturne',
    mode: 'dark',
    tokens: {
      '--bento-bg': '#0d0a10',
      '--bento-card': '#1a161d',
      '--bento-card-2': '#231e27',
      '--bento-ink': '#ffffff',
      '--bento-muted': '#ffffff',
      '--bento-line': '#302a34',
      '--bento-dock-bg': '#1a161d',
      '--bento-dock-ink': '#ffffff',
      '--bento-mint': '#239573',
      '--bento-mint-tint': '#154738',
      '--bento-purple': '#a566db',
      '--bento-purple-tint': '#301547',
      '--bento-pink': '#d75681',
      '--bento-pink-tint': '#471525',
      '--bento-orange': '#be702d',
      '--bento-orange-tint': '#472c15',
      '--bento-anchor-from': '#452f52',
      '--bento-anchor-to': '#2f2838',
      '--bento-anchor-ink': '#ffffff',
      '--dom-students': '#87a6c5',
      '--dom-students-soft': '#273849',
      '--dom-students-text': '#ffffff',
      '--dom-academics': '#a68dc8',
      '--dom-academics-soft': '#352749',
      '--dom-academics-text': '#ffffff',
      '--dom-finance': '#79bea9',
      '--dom-finance-soft': '#27493f',
      '--dom-finance-text': '#ffffff',
      '--dom-operations': '#c3a183',
      '--dom-operations-soft': '#493727',
      '--dom-operations-text': '#ffffff',
      '--dom-reports': '#80b0c2',
      '--dom-reports-soft': '#274049',
      '--dom-reports-text': '#ffffff',
      '--dom-staff': '#c78ac7',
      '--dom-staff-soft': '#492749',
      '--dom-staff-text': '#ffffff',
      '--dom-admissions': '#8d8dc8',
      '--dom-admissions-soft': '#272749',
      '--dom-admissions-text': '#ffffff',
      '--dom-attendance': '#79beb9',
      '--dom-attendance-soft': '#274946',
      '--dom-attendance-text': '#ffffff',
      '--dom-communication': '#c78aa8',
      '--dom-communication-soft': '#492738',
      '--dom-communication-text': '#ffffff',
      '--dom-critical': '#c78c8a',
      '--dom-critical-soft': '#492827',
      '--dom-critical-text': '#ffffff',
      '--dom-success': '#79be96',
      '--dom-success-soft': '#274935',
      '--dom-success-text': '#ffffff',
      '--dom-warning': '#c0ac7c',
      '--dom-warning-soft': '#493f27',
      '--dom-warning-text': '#ffffff',
    },
  },
  {
    name: 'Graphite Teal',
    mode: 'dark',
    tokens: {
      '--bento-bg': '#090c0d',
      '--bento-card': '#151a1c',
      '--bento-card-2': '#1d2426',
      '--bento-ink': '#ffffff',
      '--bento-muted': '#ffffff',
      '--bento-line': '#272f31',
      '--bento-dock-bg': '#151a1c',
      '--bento-dock-ink': '#ffffff',
      '--bento-mint': '#239573',
      '--bento-mint-tint': '#154738',
      '--bento-purple': '#a566db',
      '--bento-purple-tint': '#301547',
      '--bento-pink': '#d75681',
      '--bento-pink-tint': '#471525',
      '--bento-orange': '#be702d',
      '--bento-orange-tint': '#472c15',
      '--bento-anchor-from': '#264348',
      '--bento-anchor-to': '#233033',
      '--bento-anchor-ink': '#ffffff',
      '--dom-students': '#87a6c5',
      '--dom-students-soft': '#273849',
      '--dom-students-text': '#ffffff',
      '--dom-academics': '#a68dc8',
      '--dom-academics-soft': '#352749',
      '--dom-academics-text': '#ffffff',
      '--dom-finance': '#79bea9',
      '--dom-finance-soft': '#27493f',
      '--dom-finance-text': '#ffffff',
      '--dom-operations': '#c3a183',
      '--dom-operations-soft': '#493727',
      '--dom-operations-text': '#ffffff',
      '--dom-reports': '#80b0c2',
      '--dom-reports-soft': '#274049',
      '--dom-reports-text': '#ffffff',
      '--dom-staff': '#c78ac7',
      '--dom-staff-soft': '#492749',
      '--dom-staff-text': '#ffffff',
      '--dom-admissions': '#8d8dc8',
      '--dom-admissions-soft': '#272749',
      '--dom-admissions-text': '#ffffff',
      '--dom-attendance': '#79beb9',
      '--dom-attendance-soft': '#274946',
      '--dom-attendance-text': '#ffffff',
      '--dom-communication': '#c78aa8',
      '--dom-communication-soft': '#492738',
      '--dom-communication-text': '#ffffff',
      '--dom-critical': '#c78c8a',
      '--dom-critical-soft': '#492827',
      '--dom-critical-text': '#ffffff',
      '--dom-success': '#79be96',
      '--dom-success-soft': '#274935',
      '--dom-success-text': '#ffffff',
      '--dom-warning': '#c0ac7c',
      '--dom-warning-soft': '#493f27',
      '--dom-warning-text': '#ffffff',
    },
  },
  {
    name: 'Porcelain Amber',
    mode: 'light',
    tokens: {
      '--bento-bg': '#eceef2',
      '--bento-card': '#ffffff',
      '--bento-card-2': '#f4f6f9',
      '--bento-ink': '#000000',
      '--bento-muted': '#000000',
      '--bento-line': '#dde1e8',
      '--bento-dock-bg': '#ffffff',
      '--bento-dock-ink': '#000000',
      '--bento-mint': '#1f8452',
      '--bento-mint-tint': '#e5faf0',
      '--bento-purple': '#9451d6',
      '--bento-purple-tint': '#f0e5fa',
      '--bento-pink': '#d0396b',
      '--bento-pink-tint': '#fae5ec',
      '--bento-orange': '#ae6029',
      '--bento-orange-tint': '#faeee5',
      '--bento-anchor-from': '#eadecc',
      '--bento-anchor-to': '#f3eee8',
      '--bento-anchor-ink': '#000000',
      '--dom-students': '#070f18',
      '--dom-students-soft': '#d7e6f4',
      '--dom-students-text': '#000000',
      '--dom-academics': '#0e0718',
      '--dom-academics-soft': '#e3d7f4',
      '--dom-academics-text': '#000000',
      '--dom-finance': '#071812',
      '--dom-finance-soft': '#d7f4ea',
      '--dom-finance-text': '#000000',
      '--dom-operations': '#180f07',
      '--dom-operations-soft': '#f4e5d7',
      '--dom-operations-text': '#000000',
      '--dom-reports': '#071418',
      '--dom-reports-soft': '#d7edf4',
      '--dom-reports-text': '#000000',
      '--dom-staff': '#180718',
      '--dom-staff-soft': '#f4d7f4',
      '--dom-staff-text': '#000000',
      '--dom-admissions': '#070718',
      '--dom-admissions-soft': '#d7d7f4',
      '--dom-admissions-text': '#000000',
      '--dom-attendance': '#071816',
      '--dom-attendance-soft': '#d7f4f1',
      '--dom-attendance-text': '#000000',
      '--dom-communication': '#180712',
      '--dom-communication-soft': '#f4d7ea',
      '--dom-communication-text': '#000000',
      '--dom-critical': '#180707',
      '--dom-critical-soft': '#f4d8d7',
      '--dom-critical-text': '#000000',
      '--dom-success': '#07180e',
      '--dom-success-soft': '#d7f4e3',
      '--dom-success-text': '#000000',
      '--dom-warning': '#181207',
      '--dom-warning-soft': '#f4ead7',
      '--dom-warning-text': '#000000',
    },
  },
  {
    name: 'Daylight Azure',
    mode: 'light',
    tokens: {
      '--bento-bg': '#e9edf3',
      '--bento-card': '#ffffff',
      '--bento-card-2': '#f2f5fa',
      '--bento-ink': '#000000',
      '--bento-muted': '#000000',
      '--bento-line': '#d9e0ea',
      '--bento-dock-bg': '#ffffff',
      '--bento-dock-ink': '#000000',
      '--bento-mint': '#1f8452',
      '--bento-mint-tint': '#e5faf0',
      '--bento-purple': '#9451d6',
      '--bento-purple-tint': '#f0e5fa',
      '--bento-pink': '#d0396b',
      '--bento-pink-tint': '#fae5ec',
      '--bento-orange': '#ae6029',
      '--bento-orange-tint': '#faeee5',
      '--bento-anchor-from': '#ccdbea',
      '--bento-anchor-to': '#e8edf3',
      '--bento-anchor-ink': '#000000',
      '--dom-students': '#070f18',
      '--dom-students-soft': '#d7e6f4',
      '--dom-students-text': '#000000',
      '--dom-academics': '#0e0718',
      '--dom-academics-soft': '#e3d7f4',
      '--dom-academics-text': '#000000',
      '--dom-finance': '#071812',
      '--dom-finance-soft': '#d7f4ea',
      '--dom-finance-text': '#000000',
      '--dom-operations': '#180f07',
      '--dom-operations-soft': '#f4e5d7',
      '--dom-operations-text': '#000000',
      '--dom-reports': '#071418',
      '--dom-reports-soft': '#d7edf4',
      '--dom-reports-text': '#000000',
      '--dom-staff': '#180718',
      '--dom-staff-soft': '#f4d7f4',
      '--dom-staff-text': '#000000',
      '--dom-admissions': '#070718',
      '--dom-admissions-soft': '#d7d7f4',
      '--dom-admissions-text': '#000000',
      '--dom-attendance': '#071816',
      '--dom-attendance-soft': '#d7f4f1',
      '--dom-attendance-text': '#000000',
      '--dom-communication': '#180712',
      '--dom-communication-soft': '#f4d7ea',
      '--dom-communication-text': '#000000',
      '--dom-critical': '#180707',
      '--dom-critical-soft': '#f4d8d7',
      '--dom-critical-text': '#000000',
      '--dom-success': '#07180e',
      '--dom-success-soft': '#d7f4e3',
      '--dom-success-text': '#000000',
      '--dom-warning': '#181207',
      '--dom-warning-soft': '#f4ead7',
      '--dom-warning-text': '#000000',
    },
  },
  {
    name: 'Obsidian Amber',
    mode: 'dark',
    tokens: {
      '--bento-bg': '#0b0d10',
      '--bento-card': '#171a1f',
      '--bento-card-2': '#1f232a',
      '--bento-ink': '#ffffff',
      '--bento-muted': '#ffffff',
      '--bento-line': '#2a2f36',
      '--bento-dock-bg': '#171a1f',
      '--bento-dock-ink': '#ffffff',
      '--bento-mint': '#24995e',
      '--bento-mint-tint': '#15472e',
      '--bento-purple': '#a36adc',
      '--bento-purple-tint': '#2e1547',
      '--bento-pink': '#d85a84',
      '--bento-pink-tint': '#471525',
      '--bento-orange': '#c66e2f',
      '--bento-orange-tint': '#472a15',
      '--bento-anchor-from': '#5d4b32',
      '--bento-anchor-to': '#3f3527',
      '--bento-anchor-ink': '#ffffff',
      '--dom-students': '#e7f0f8',
      '--dom-students-soft': '#273849',
      '--dom-students-text': '#ffffff',
      '--dom-academics': '#eee7f8',
      '--dom-academics-soft': '#352749',
      '--dom-academics-text': '#ffffff',
      '--dom-finance': '#e7f8f3',
      '--dom-finance-soft': '#27493e',
      '--dom-finance-text': '#ffffff',
      '--dom-operations': '#f8efe7',
      '--dom-operations-soft': '#493727',
      '--dom-operations-text': '#ffffff',
      '--dom-reports': '#e7f4f8',
      '--dom-reports-soft': '#274149',
      '--dom-reports-text': '#ffffff',
      '--dom-staff': '#f8e7f8',
      '--dom-staff-soft': '#492749',
      '--dom-staff-text': '#ffffff',
      '--dom-admissions': '#e7e7f8',
      '--dom-admissions-soft': '#272749',
      '--dom-admissions-text': '#ffffff',
      '--dom-attendance': '#e7f8f7',
      '--dom-attendance-soft': '#274946',
      '--dom-attendance-text': '#ffffff',
      '--dom-communication': '#f8e7f3',
      '--dom-communication-soft': '#49273e',
      '--dom-communication-text': '#ffffff',
      '--dom-critical': '#f8e8e7',
      '--dom-critical-soft': '#492827',
      '--dom-critical-text': '#ffffff',
      '--dom-success': '#e7f8ee',
      '--dom-success-soft': '#274935',
      '--dom-success-text': '#ffffff',
      '--dom-warning': '#f8f3e7',
      '--dom-warning-soft': '#493e27',
      '--dom-warning-text': '#ffffff',
    },
  },
  {
    name: 'Midnight Azure',
    mode: 'dark',
    tokens: {
      '--bento-bg': '#080c14',
      '--bento-card': '#101827',
      '--bento-card-2': '#18202f',
      '--bento-ink': '#ffffff',
      '--bento-muted': '#ffffff',
      '--bento-line': '#1c293a',
      '--bento-dock-bg': '#101827',
      '--bento-dock-ink': '#ffffff',
      '--bento-mint': '#23955c',
      '--bento-mint-tint': '#15472e',
      '--bento-purple': '#a166db',
      '--bento-purple-tint': '#2e1547',
      '--bento-pink': '#d75681',
      '--bento-pink-tint': '#471525',
      '--bento-orange': '#c66e2f',
      '--bento-orange-tint': '#472a15',
      '--bento-anchor-from': '#32475d',
      '--bento-anchor-to': '#27333f',
      '--bento-anchor-ink': '#ffffff',
      '--dom-students': '#e7f0f8',
      '--dom-students-soft': '#273849',
      '--dom-students-text': '#ffffff',
      '--dom-academics': '#eee7f8',
      '--dom-academics-soft': '#352749',
      '--dom-academics-text': '#ffffff',
      '--dom-finance': '#e7f8f3',
      '--dom-finance-soft': '#27493e',
      '--dom-finance-text': '#ffffff',
      '--dom-operations': '#f8efe7',
      '--dom-operations-soft': '#493727',
      '--dom-operations-text': '#ffffff',
      '--dom-reports': '#e7f4f8',
      '--dom-reports-soft': '#274149',
      '--dom-reports-text': '#ffffff',
      '--dom-staff': '#f8e7f8',
      '--dom-staff-soft': '#492749',
      '--dom-staff-text': '#ffffff',
      '--dom-admissions': '#e7e7f8',
      '--dom-admissions-soft': '#272749',
      '--dom-admissions-text': '#ffffff',
      '--dom-attendance': '#e7f8f7',
      '--dom-attendance-soft': '#274946',
      '--dom-attendance-text': '#ffffff',
      '--dom-communication': '#f8e7f3',
      '--dom-communication-soft': '#49273e',
      '--dom-communication-text': '#ffffff',
      '--dom-critical': '#f8e8e7',
      '--dom-critical-soft': '#492827',
      '--dom-critical-text': '#ffffff',
      '--dom-success': '#e7f8ee',
      '--dom-success-soft': '#274935',
      '--dom-success-text': '#ffffff',
      '--dom-warning': '#f8f3e7',
      '--dom-warning-soft': '#493e27',
      '--dom-warning-text': '#ffffff',
    },
  },
] as const

export function savePalette(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return
  // Replace by name rather than accumulating duplicates: somebody saving
  // "Winter" twice means they revised it.
  palettes = [{ name: trimmed, paint: { ...paint } }, ...palettes.filter((p) => p.name !== trimmed)]
    .slice(0, 12)
  try {
    localStorage.setItem(PALETTES_KEY, JSON.stringify(palettes))
  } catch {
    /* nothing to do; the palette simply is not kept */
  }
  emit()
}

export function deletePalette(name: string) {
  palettes = palettes.filter((p) => p.name !== name)
  try {
    localStorage.setItem(PALETTES_KEY, JSON.stringify(palettes))
  } catch {
    /* ignored */
  }
  emit()
}

export function applyPalette(name: string) {
  /* Saved first: somebody who saved their own "Daylight Azure" meant theirs. */
  const own = palettes.find((x) => x.name === name)
  if (own) {
    activePalette = null
    remember()
    applyPaint({ ...own.paint })
    return
  }
  const shipped = BUILT_IN_PALETTES.find((x) => x.name === name)
  if (!shipped) return
  /* A shipped palette replaces the hand-painted regions rather than layering
     under them. Picking a whole palette is a decision about the whole surface,
     and leaving three regions from the last one on top of it is the mismatch
     this was meant to end. */
  activePalette = shipped.name
  remember()
  /* A dark palette must also put the app in dark mode.

     The 55 tokens dress the BENTO surface. Everything outside it — the dock's
     separators, persona-kit's labels, every `text-muted-foreground` — is
     coloured from the app's own Tailwind variables, and those follow the theme
     class, not this module. Setting a black board while the theme stayed light
     left those reading against the wrong ground: measured at 1.24:1 for the
     dock separators, and persona-kit's inverted-cell text at 1.00:1, which is
     invisible rather than merely poor.

     A palette IS a decision about light or dark. Applying one and leaving the
     theme behind was never a coherent state. */
  applyTheme(shipped.mode)
  applyPaint({})
}

/** Which shipped palette is active, for the dialog to mark. */
export function currentPalette(): string | null {
  return activePalette
}

function remember() {
  try {
    if (activePalette) localStorage.setItem(PALETTE_KEY, activePalette)
    else localStorage.removeItem(PALETTE_KEY)
  } catch {
    /* private browsing: the choice lasts the session */
  }
  emit()
}

function snapshot() {
  return paint
}
function serverSnapshot(): Paint {
  return {}
}
function palettesSnapshot() {
  return palettes
}
const NO_PALETTES: Palette[] = []
function palettesServerSnapshot() {
  return NO_PALETTES
}

export function usePaint() {
  const value = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  const set = useCallback(
    (r: Region, c: Channel, v: Hsl | undefined) => setPaint(r, c, v),
    [],
  )
  return { paint: value, set }
}

export function usePalettes() {
  return useSyncExternalStore(subscribe, palettesSnapshot, palettesServerSnapshot)
}

if (typeof document !== 'undefined') applyPaint(paint)
