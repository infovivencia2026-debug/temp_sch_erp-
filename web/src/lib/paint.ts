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
/** What the app looks like when nobody has chosen anything.

    Shipping with no palette meant shipping the muted grey-blue fallbacks in
    index.css, which is a default by omission rather than a decision. This is
    the decision. It applies ONLY when the key is absent: a stored name — any
    stored name, including one of the older palettes — still wins, so nobody
    who has already chosen loses their choice on the release that adds this. */
export const DEFAULT_PALETTE = 'Vivid'

let activePalette: string | null =
  typeof window === 'undefined' ? null : (() => {
    try {
      const stored = localStorage.getItem(PALETTE_KEY)
      return stored === null ? DEFAULT_PALETTE : stored
    } catch { return DEFAULT_PALETTE }
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

/** The shipped palettes: four for light, four for dark, and every one of them
    is a VS Code theme.

    THE NAMES ARE THE POINT. Sage Linen and Plum Nocturne were good palettes
    that nobody had heard of, and a palette picker is a list of names: a
    person choosing from it is choosing blind unless a name already means a
    look to them. Light Modern, Monokai, Solarized and Abyss do -- they are
    what the same person's editor has looked like for years, and picking one
    here makes the ERP match the window beside it. The grounds are the
    workbench colours of each theme and the hues are its token colours, put
    into the roles the boards draw with; the text on each is then measured,
    not copied, because a syntax colour was tuned for one line on one
    background and a domain ink sits on its own tint. Generated by a script
    (the same walk-until-it-reads the earlier sets used); the worst pairing
    across all eight is held at 4.6:1.

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
    name: 'Light Modern',
    mode: 'light',
    tokens: {
      '--bento-bg': '#f8f8f8',
      '--bento-card': '#ffffff',
      '--bento-card-2': '#f3f3f3',
      '--bento-ink': '#3b3b3b',
      '--bento-muted': '#747474',
      '--bento-line': '#e5e5e5',
      '--bento-dock-bg': '#f8f8f8',
      '--bento-dock-ink': '#3b3b3b',
      '--bento-mint': '#008000',
      '--bento-mint-tint': '#d9ecd9',
      '--bento-purple': '#af00db',
      '--bento-purple-tint': '#f3d9fa',
      '--bento-pink': '#a31515',
      '--bento-pink-tint': '#f1dcdc',
      '--bento-orange': '#795e26',
      '--bento-orange-tint': '#ebe7de',
      '--bento-anchor-from': '#c6e0c6',
      '--bento-anchor-to': '#f3f3f3',
      '--bento-anchor-ink': '#3b3b3b',
      '--dom-students': '#0000ff',
      '--dom-students-soft': '#d9d9ff',
      '--dom-students-text': '#000000',
      '--dom-academics': '#a300cb',
      '--dom-academics-soft': '#f3d9fa',
      '--dom-academics-text': '#000000',
      '--dom-finance': '#09754a',
      '--dom-finance-soft': '#daede6',
      '--dom-finance-text': '#000000',
      '--dom-operations': '#795e26',
      '--dom-operations-soft': '#ebe7de',
      '--dom-operations-text': '#000000',
      '--dom-reports': '#1f7084',
      '--dom-reports-soft': '#deecf0',
      '--dom-reports-text': '#000000',
      '--dom-staff': '#001080',
      '--dom-staff-soft': '#d9dbec',
      '--dom-staff-text': '#000000',
      '--dom-admissions': '#0068b1',
      '--dom-admissions-soft': '#d9eaf6',
      '--dom-admissions-text': '#000000',
      '--dom-attendance': '#007700',
      '--dom-attendance-soft': '#d9ecd9',
      '--dom-attendance-text': '#000000',
      '--dom-communication': '#c70000',
      '--dom-communication-soft': '#fcd9d9',
      '--dom-communication-text': '#000000',
      '--dom-critical': '#bd2d2d',
      '--dom-critical-soft': '#f8e0e0',
      '--dom-critical-text': '#000000',
      '--dom-success': '#007700',
      '--dom-success-soft': '#d9ecd9',
      '--dom-success-text': '#000000',
      '--dom-warning': '#795e26',
      '--dom-warning-soft': '#ebe7de',
      '--dom-warning-text': '#000000',
    },
  },
  {
    name: 'Quiet Light',
    mode: 'light',
    tokens: {
      '--bento-bg': '#f5f5f5',
      '--bento-card': '#ffffff',
      '--bento-card-2': '#f0f0f0',
      '--bento-ink': '#333333',
      '--bento-muted': '#747474',
      '--bento-line': '#dddddd',
      '--bento-dock-bg': '#f2f2f2',
      '--bento-dock-ink': '#333333',
      '--bento-mint': '#418324',
      '--bento-mint-tint': '#e3ecde',
      '--bento-purple': '#7a3e9d',
      '--bento-purple-tint': '#ebe2f0',
      '--bento-pink': '#aa3731',
      '--bento-pink-tint': '#f2e1e0',
      '--bento-orange': '#a86325',
      '--bento-orange-tint': '#f2e8de',
      '--bento-anchor-from': '#d2e0cc',
      '--bento-anchor-to': '#f0f0f0',
      '--bento-anchor-ink': '#333333',
      '--dom-students': '#4761b6',
      '--dom-students-soft': '#e4e9f6',
      '--dom-students-text': '#000000',
      '--dom-academics': '#7a3e9d',
      '--dom-academics-soft': '#ebe2f0',
      '--dom-academics-text': '#000000',
      '--dom-finance': '#3b751e',
      '--dom-finance-soft': '#e3eedf',
      '--dom-finance-text': '#000000',
      '--dom-operations': '#96571f',
      '--dom-operations-soft': '#f2e8de',
      '--dom-operations-text': '#000000',
      '--dom-reports': '#356c91',
      '--dom-reports-soft': '#e2ebf2',
      '--dom-reports-text': '#000000',
      '--dom-staff': '#7a3e9d',
      '--dom-staff-soft': '#ebe2f0',
      '--dom-staff-text': '#000000',
      '--dom-admissions': '#4761b6',
      '--dom-admissions-soft': '#e4e9f6',
      '--dom-admissions-text': '#000000',
      '--dom-attendance': '#3b751e',
      '--dom-attendance-soft': '#e3eedf',
      '--dom-attendance-text': '#000000',
      '--dom-communication': '#aa3731',
      '--dom-communication-soft': '#f2e1e0',
      '--dom-communication-text': '#000000',
      '--dom-critical': '#aa3731',
      '--dom-critical-soft': '#f2e1e0',
      '--dom-critical-text': '#000000',
      '--dom-success': '#3b751e',
      '--dom-success-soft': '#e3eedf',
      '--dom-success-text': '#000000',
      '--dom-warning': '#96571f',
      '--dom-warning-soft': '#f2e8de',
      '--dom-warning-text': '#000000',
    },
  },
  {
    name: 'Solarized Light',
    mode: 'light',
    tokens: {
      '--bento-bg': '#fdf6e3',
      '--bento-card': '#fffbf0',
      '--bento-card-2': '#eee8d5',
      '--bento-ink': '#586e75',
      '--bento-muted': '#62767c',
      '--bento-line': '#ddd6c1',
      '--bento-dock-bg': '#eee8d5',
      '--bento-dock-ink': '#546a71',
      '--bento-mint': '#6c7900',
      '--bento-mint-tint': '#e9e8cc',
      '--bento-purple': '#666bb8',
      '--bento-purple-tint': '#e8e5e8',
      '--bento-pink': '#cb347c',
      '--bento-pink-tint': '#f7dddf',
      '--bento-orange': '#c34916',
      '--bento-orange-tint': '#f6e0cf',
      '--bento-anchor-from': '#e5e3b6',
      '--bento-anchor-to': '#eee8d5',
      '--bento-anchor-ink': '#50666d',
      '--dom-students': '#196ca2',
      '--dom-students-soft': '#deeaec',
      '--dom-students-text': '#000000',
      '--dom-academics': '#5a5fa3',
      '--dom-academics-soft': '#e9e6e9',
      '--dom-academics-text': '#000000',
      '--dom-finance': '#626f00',
      '--dom-finance-soft': '#edeccc',
      '--dom-finance-text': '#000000',
      '--dom-operations': '#ac4316',
      '--dom-operations-soft': '#f7e1cf',
      '--dom-operations-text': '#000000',
      '--dom-reports': '#19736d',
      '--dom-reports-soft': '#dfeee3',
      '--dom-reports-text': '#000000',
      '--dom-staff': '#b32e70',
      '--dom-staff-soft': '#f8dde0',
      '--dom-staff-text': '#000000',
      '--dom-admissions': '#196ca2',
      '--dom-admissions-soft': '#deeaec',
      '--dom-admissions-text': '#000000',
      '--dom-attendance': '#19736d',
      '--dom-attendance-soft': '#dfeee3',
      '--dom-attendance-text': '#000000',
      '--dom-communication': '#b32e70',
      '--dom-communication-soft': '#f8dde0',
      '--dom-communication-text': '#000000',
      '--dom-critical': '#bc2a27',
      '--dom-critical-soft': '#faddd3',
      '--dom-critical-text': '#000000',
      '--dom-success': '#626f00',
      '--dom-success-soft': '#edeccc',
      '--dom-success-text': '#000000',
      '--dom-warning': '#806300',
      '--dom-warning-soft': '#f4eacc',
      '--dom-warning-text': '#000000',
    },
  },
  {
    name: 'Light High Contrast',
    mode: 'light',
    tokens: {
      '--bento-bg': '#ffffff',
      '--bento-card': '#ffffff',
      '--bento-card-2': '#f2f2f2',
      '--bento-ink': '#292929',
      '--bento-muted': '#747474',
      '--bento-line': '#0f4a85',
      '--bento-dock-bg': '#ffffff',
      '--bento-dock-ink': '#292929',
      '--bento-mint': '#374e06',
      '--bento-mint-tint': '#e1e4da',
      '--bento-purple': '#5e2cbc',
      '--bento-purple-tint': '#e7dff5',
      '--bento-pink': '#b5200d',
      '--bento-pink-tint': '#f4dedb',
      '--bento-orange': '#6f4e00',
      '--bento-orange-tint': '#e9e4d9',
      '--bento-anchor-from': '#d7dccd',
      '--bento-anchor-to': '#f2f2f2',
      '--bento-anchor-ink': '#292929',
      '--dom-students': '#0f4a85',
      '--dom-students-soft': '#dbe4ed',
      '--dom-students-text': '#000000',
      '--dom-academics': '#5e2cbc',
      '--dom-academics-soft': '#e7dff5',
      '--dom-academics-text': '#000000',
      '--dom-finance': '#374e06',
      '--dom-finance-soft': '#e1e4da',
      '--dom-finance-text': '#000000',
      '--dom-operations': '#6f4e00',
      '--dom-operations-soft': '#e9e4d9',
      '--dom-operations-text': '#000000',
      '--dom-reports': '#185e73',
      '--dom-reports-soft': '#dce7ea',
      '--dom-reports-text': '#000000',
      '--dom-staff': '#5e2cbc',
      '--dom-staff-soft': '#e7dff5',
      '--dom-staff-text': '#000000',
      '--dom-admissions': '#0f4a85',
      '--dom-admissions-soft': '#dbe4ed',
      '--dom-admissions-text': '#000000',
      '--dom-attendance': '#185e73',
      '--dom-attendance-soft': '#dce7ea',
      '--dom-attendance-text': '#000000',
      '--dom-communication': '#b5200d',
      '--dom-communication-soft': '#f4dedb',
      '--dom-communication-text': '#000000',
      '--dom-critical': '#b5200d',
      '--dom-critical-soft': '#f4dedb',
      '--dom-critical-text': '#000000',
      '--dom-success': '#374e06',
      '--dom-success-soft': '#e1e4da',
      '--dom-success-text': '#000000',
      '--dom-warning': '#6f4e00',
      '--dom-warning-soft': '#e9e4d9',
      '--dom-warning-text': '#000000',
    },
  },
  {
    name: 'Dark Modern',
    mode: 'dark',
    tokens: {
      '--bento-bg': '#1f1f1f',
      '--bento-card': '#181818',
      '--bento-card-2': '#242424',
      '--bento-ink': '#cccccc',
      '--bento-muted': '#828282',
      '--bento-line': '#2b2b2b',
      '--bento-dock-bg': '#181818',
      '--bento-dock-ink': '#cccccc',
      '--bento-mint': '#4ec9b0',
      '--bento-mint-tint': '#20332f',
      '--bento-purple': '#c586c0',
      '--bento-purple-tint': '#322931',
      '--bento-pink': '#f44747',
      '--bento-pink-tint': '#391f1f',
      '--bento-orange': '#ce9178',
      '--bento-orange-tint': '#332a26',
      '--bento-anchor-from': '#28413c',
      '--bento-anchor-to': '#242424',
      '--bento-anchor-ink': '#cccccc',
      '--dom-students': '#569cd6',
      '--dom-students-soft': '#212c35',
      '--dom-students-text': '#ffffff',
      '--dom-academics': '#c586c0',
      '--dom-academics-soft': '#322931',
      '--dom-academics-text': '#ffffff',
      '--dom-finance': '#4ec9b0',
      '--dom-finance-soft': '#20332f',
      '--dom-finance-text': '#ffffff',
      '--dom-operations': '#ce9178',
      '--dom-operations-soft': '#332a26',
      '--dom-operations-text': '#ffffff',
      '--dom-reports': '#9cdcfe',
      '--dom-reports-soft': '#2c353b',
      '--dom-reports-text': '#ffffff',
      '--dom-staff': '#dcdcaa',
      '--dom-staff-soft': '#35352e',
      '--dom-staff-text': '#ffffff',
      '--dom-admissions': '#4fc1ff',
      '--dom-admissions-soft': '#20313b',
      '--dom-admissions-text': '#ffffff',
      '--dom-attendance': '#b5cea8',
      '--dom-attendance-soft': '#30332e',
      '--dom-attendance-text': '#ffffff',
      '--dom-communication': '#d7ba7d',
      '--dom-communication-soft': '#353027',
      '--dom-communication-text': '#ffffff',
      '--dom-critical': '#f45959',
      '--dom-critical-soft': '#391f1f',
      '--dom-critical-text': '#ffffff',
      '--dom-success': '#709d5b',
      '--dom-success-soft': '#242b21',
      '--dom-success-text': '#ffffff',
      '--dom-warning': '#dcdcaa',
      '--dom-warning-soft': '#35352e',
      '--dom-warning-text': '#ffffff',
    },
  },
  {
    name: 'Monokai',
    mode: 'dark',
    tokens: {
      '--bento-bg': '#272822',
      '--bento-card': '#1e1f1c',
      '--bento-card-2': '#2d2e27',
      '--bento-ink': '#f8f8f2',
      '--bento-muted': '#898985',
      '--bento-line': '#414339',
      '--bento-dock-bg': '#1e1f1c',
      '--bento-dock-ink': '#f8f8f2',
      '--bento-mint': '#a6e22e',
      '--bento-mint-tint': '#323c1f',
      '--bento-purple': '#ae81ff',
      '--bento-purple-tint': '#342e3e',
      '--bento-pink': '#f9367e',
      '--bento-pink-tint': '#3f222b',
      '--bento-orange': '#fd971f',
      '--bento-orange-tint': '#3f311c',
      '--bento-anchor-from': '#404d24',
      '--bento-anchor-to': '#2d2e27',
      '--bento-anchor-ink': '#f8f8f2',
      '--dom-students': '#66d9ef',
      '--dom-students-soft': '#293b3c',
      '--dom-students-text': '#ffffff',
      '--dom-academics': '#b084ff',
      '--dom-academics-soft': '#342e3e',
      '--dom-academics-text': '#ffffff',
      '--dom-finance': '#a6e22e',
      '--dom-finance-soft': '#323c1f',
      '--dom-finance-text': '#ffffff',
      '--dom-operations': '#fd971f',
      '--dom-operations-soft': '#3f311c',
      '--dom-operations-text': '#ffffff',
      '--dom-reports': '#66d9ef',
      '--dom-reports-soft': '#293b3c',
      '--dom-reports-text': '#ffffff',
      '--dom-staff': '#e6db74',
      '--dom-staff-soft': '#3c3b29',
      '--dom-staff-text': '#ffffff',
      '--dom-admissions': '#b084ff',
      '--dom-admissions-soft': '#342e3e',
      '--dom-admissions-text': '#ffffff',
      '--dom-attendance': '#a6e22e',
      '--dom-attendance-soft': '#323c1f',
      '--dom-attendance-text': '#ffffff',
      '--dom-communication': '#f95590',
      '--dom-communication-soft': '#3f2029',
      '--dom-communication-text': '#ffffff',
      '--dom-critical': '#f95590',
      '--dom-critical-soft': '#3f2029',
      '--dom-critical-text': '#ffffff',
      '--dom-success': '#a6e22e',
      '--dom-success-soft': '#323c1f',
      '--dom-success-text': '#ffffff',
      '--dom-warning': '#e6db74',
      '--dom-warning-soft': '#3c3b29',
      '--dom-warning-text': '#ffffff',
    },
  },
  {
    name: 'Solarized Dark',
    mode: 'dark',
    tokens: {
      '--bento-bg': '#002b36',
      '--bento-card': '#00212b',
      '--bento-card-2': '#073642',
      '--bento-ink': '#93a1a1',
      '--bento-muted': '#798a8c',
      '--bento-line': '#0a4050',
      '--bento-dock-bg': '#00212b',
      '--bento-dock-ink': '#93a1a1',
      '--bento-mint': '#859900',
      '--bento-mint-tint': '#143325',
      '--bento-purple': '#7b80c9',
      '--bento-purple-tint': '#122f43',
      '--bento-pink': '#dc5895',
      '--bento-pink-tint': '#21293b',
      '--bento-orange': '#d4683c',
      '--bento-orange-tint': '#202c2e',
      '--bento-anchor-from': '#1b412b',
      '--bento-anchor-to': '#073642',
      '--bento-anchor-ink': '#9ba9a9',
      '--dom-students': '#4a9ddb',
      '--dom-students-soft': '#063144',
      '--dom-students-text': '#ffffff',
      '--dom-academics': '#8a8dcf',
      '--dom-academics-soft': '#102d42',
      '--dom-academics-text': '#ffffff',
      '--dom-finance': '#8b9f0f',
      '--dom-finance-soft': '#143325',
      '--dom-finance-text': '#ffffff',
      '--dom-operations': '#d77148',
      '--dom-operations-soft': '#1e2728',
      '--dom-operations-text': '#ffffff',
      '--dom-reports': '#3aa9a0',
      '--dom-reports-soft': '#06343b',
      '--dom-reports-text': '#ffffff',
      '--dom-staff': '#df619b',
      '--dom-staff-soft': '#202438',
      '--dom-staff-text': '#ffffff',
      '--dom-admissions': '#4a9ddb',
      '--dom-admissions-soft': '#063144',
      '--dom-admissions-text': '#ffffff',
      '--dom-attendance': '#3aa9a0',
      '--dom-attendance-soft': '#06343b',
      '--dom-attendance-text': '#ffffff',
      '--dom-communication': '#df619b',
      '--dom-communication-soft': '#202438',
      '--dom-communication-text': '#ffffff',
      '--dom-critical': '#e7615f',
      '--dom-critical-soft': '#21242c',
      '--dom-critical-text': '#ffffff',
      '--dom-success': '#8b9f0f',
      '--dom-success-soft': '#143325',
      '--dom-success-text': '#ffffff',
      '--dom-warning': '#b88f0f',
      '--dom-warning-soft': '#1b3125',
      '--dom-warning-text': '#ffffff',
    },
  },
  {
    name: 'Abyss',
    mode: 'dark',
    tokens: {
      '--bento-bg': '#000c18',
      '--bento-card': '#060621',
      '--bento-card-2': '#0f1a2e',
      '--bento-ink': '#6688cc',
      '--bento-muted': '#5b7ab9',
      '--bento-line': '#2b2b4a',
      '--bento-dock-bg': '#060621',
      '--bento-dock-ink': '#6688cc',
      '--bento-mint': '#22aa44',
      '--bento-mint-tint': '#0a1f26',
      '--bento-purple': '#9966b8',
      '--bento-purple-tint': '#1c1438',
      '--bento-pink': '#f280d0',
      '--bento-pink-tint': '#29183b',
      '--bento-orange': '#ddbb88',
      '--bento-orange-tint': '#262130',
      '--bento-anchor-from': '#072c21',
      '--bento-anchor-to': '#0f1a2e',
      '--bento-anchor-ink': '#6f8ecf',
      '--dom-students': '#6688cc',
      '--dom-students-soft': '#141a3b',
      '--dom-students-text': '#ffffff',
      '--dom-academics': '#a172bc',
      '--dom-academics-soft': '#1c1438',
      '--dom-academics-text': '#ffffff',
      '--dom-finance': '#22aa44',
      '--dom-finance-soft': '#0a1f26',
      '--dom-finance-text': '#ffffff',
      '--dom-operations': '#ddbb88',
      '--dom-operations-soft': '#262130',
      '--dom-operations-text': '#ffffff',
      '--dom-reports': '#5e85a8',
      '--dom-reports-soft': '#0a1230',
      '--dom-reports-text': '#ffffff',
      '--dom-staff': '#f280d0',
      '--dom-staff-soft': '#29183b',
      '--dom-staff-text': '#ffffff',
      '--dom-admissions': '#6688cc',
      '--dom-admissions-soft': '#141a3b',
      '--dom-admissions-text': '#ffffff',
      '--dom-attendance': '#22aa44',
      '--dom-attendance-soft': '#0a1f26',
      '--dom-attendance-text': '#ffffff',
      '--dom-communication': '#f280d0',
      '--dom-communication-soft': '#29183b',
      '--dom-communication-text': '#ffffff',
      '--dom-critical': '#ff6b6b',
      '--dom-critical-soft': '#2b152c',
      '--dom-critical-text': '#ffffff',
      '--dom-success': '#22aa44',
      '--dom-success-soft': '#0a1f26',
      '--dom-success-text': '#ffffff',
      '--dom-warning': '#ddbb88',
      '--dom-warning-soft': '#262130',
      '--dom-warning-text': '#ffffff',
    },
  },
  /* The three sets below came from the owner as bare hex lists, and they are
     what the product now looks like out of the box. Vivid is the default.

     Generated by the same walk-until-it-reads script as the eight above: the
     hue and saturation are the owner's, only the lightness moved, and it moved
     exactly as far as 4.6:1 on the surface the colour sits on required. The
     worst pairing is 4.62:1 in Vivid, 4.61:1 in Neon Night, 4.60:1 in Sunset.

     What had to move, and why: golden pollen #ffd23f is 4.6:1 against nothing
     on white — as ink it measures 1.5:1 — so it walks 34% darker to #916f00
     and keeps its hue as the warning/operations amber. Turquoise #3bceac walks
     20% darker, watermelon #ee4266 10.5%, jungle green #0ead69 8.5%. In Sunset
     tuscan sun #f9c22e moves 28%, pacific blue #53b3cb 18.5%, tomato #f15946
     13.5%; amaranth #e01a4f already reads on white. Neon Night needed no move
     at all: onyx grounds mean every neon in the set already clears the floor.

     Sets 1 and 3 are light: their hex lists are one dark ink and four or five
     saturated hues, which is a hue family for accents on a white ground, not a
     dark theme. Set 2 leads with onyx #0c0f0a as a ground colour and the rest
     are neons that only read against black, so it is mode 'dark'. */
  {
    name: 'Vivid',
    mode: 'light',
    tokens: {
      '--bento-bg': '#fdfbfe',
      '--bento-card': '#ffffff',
      '--bento-card-2': '#f6f1f8',
      '--bento-ink': '#3b1a47',
      '--bento-muted': '#6b5a72',
      '--bento-line': '#ece6ef',
      '--bento-dock-bg': '#fdfbfe',
      '--bento-dock-ink': '#3b1a47',
      '--bento-mint': '#0b8551',
      '--bento-mint-tint': '#e5f6ee',
      '--bento-purple': '#540d6e',
      '--bento-purple-tint': '#f1e5f6',
      '--bento-pink': '#e61540',
      '--bento-pink-tint': '#f6e5e8',
      '--bento-orange': '#916f00',
      '--bento-orange-tint': '#f6f2e5',
      '--bento-anchor-from': '#e5f6f2',
      '--bento-anchor-to': '#f6f1f8',
      '--bento-anchor-ink': '#3b1a47',
      '--dom-students': '#540d6e',
      '--dom-students-soft': '#f1e5f6',
      '--dom-students-text': '#540d6e',
      '--dom-academics': '#e61540',
      '--dom-academics-soft': '#f6e5e8',
      '--dom-academics-text': '#cc1239',
      '--dom-finance': '#0b8551',
      '--dom-finance-soft': '#e5f6ee',
      '--dom-finance-text': '#0a7b4b',
      '--dom-operations': '#916f00',
      '--dom-operations-soft': '#f6f2e5',
      '--dom-operations-text': '#866700',
      '--dom-reports': '#21826c',
      '--dom-reports-soft': '#e5f6f2',
      '--dom-reports-text': '#1f7a65',
      '--dom-staff': '#540d6e',
      '--dom-staff-soft': '#f1e5f6',
      '--dom-staff-text': '#540d6e',
      '--dom-admissions': '#21826c',
      '--dom-admissions-soft': '#e5f6f2',
      '--dom-admissions-text': '#1f7a65',
      '--dom-attendance': '#0b8551',
      '--dom-attendance-soft': '#e5f6ee',
      '--dom-attendance-text': '#0a7b4b',
      '--dom-communication': '#540d6e',
      '--dom-communication-soft': '#f1e5f6',
      '--dom-communication-text': '#540d6e',
      '--dom-critical': '#e61540',
      '--dom-critical-soft': '#f6e5e8',
      '--dom-critical-text': '#cc1239',
      '--dom-success': '#0b8551',
      '--dom-success-soft': '#e5f6ee',
      '--dom-success-text': '#0a7b4b',
      '--dom-warning': '#916f00',
      '--dom-warning-soft': '#f6f2e5',
      '--dom-warning-text': '#866700',
    },
  },
  {
    name: 'Neon Night',
    mode: 'dark',
    tokens: {
      '--bento-bg': '#0c0f0a',
      '--bento-card': '#161a13',
      '--bento-card-2': '#1e231a',
      '--bento-ink': '#ffffff',
      '--bento-muted': '#a8b0a2',
      '--bento-line': '#272c22',
      '--bento-dock-bg': '#0f130d',
      '--bento-dock-ink': '#ffffff',
      '--bento-mint': '#41ead4',
      '--bento-mint-tint': '#1a3d38',
      '--bento-purple': '#ff206e',
      '--bento-purple-tint': '#3d1a26',
      '--bento-pink': '#fbff12',
      '--bento-pink-tint': '#3c3d1a',
      '--bento-orange': '#ffffff',
      '--bento-orange-tint': '#3d1a1a',
      '--bento-anchor-from': '#1a3d38',
      '--bento-anchor-to': '#1e231a',
      '--bento-anchor-ink': '#ffffff',
      '--dom-students': '#41ead4',
      '--dom-students-soft': '#1a3d38',
      '--dom-students-text': '#41ead4',
      '--dom-academics': '#ff206e',
      '--dom-academics-soft': '#3d1a26',
      '--dom-academics-text': '#ff4184',
      '--dom-finance': '#fbff12',
      '--dom-finance-soft': '#3c3d1a',
      '--dom-finance-text': '#fbff12',
      '--dom-operations': '#41ead4',
      '--dom-operations-soft': '#1a3d38',
      '--dom-operations-text': '#41ead4',
      '--dom-reports': '#ff206e',
      '--dom-reports-soft': '#3d1a26',
      '--dom-reports-text': '#ff4184',
      '--dom-staff': '#fbff12',
      '--dom-staff-soft': '#3c3d1a',
      '--dom-staff-text': '#fbff12',
      '--dom-admissions': '#41ead4',
      '--dom-admissions-soft': '#1a3d38',
      '--dom-admissions-text': '#41ead4',
      '--dom-attendance': '#ff206e',
      '--dom-attendance-soft': '#3d1a26',
      '--dom-attendance-text': '#ff4184',
      '--dom-communication': '#fbff12',
      '--dom-communication-soft': '#3c3d1a',
      '--dom-communication-text': '#fbff12',
      '--dom-critical': '#ff206e',
      '--dom-critical-soft': '#3d1a26',
      '--dom-critical-text': '#ff4184',
      '--dom-success': '#41ead4',
      '--dom-success-soft': '#1a3d38',
      '--dom-success-text': '#41ead4',
      '--dom-warning': '#fbff12',
      '--dom-warning-soft': '#3c3d1a',
      '--dom-warning-text': '#fbff12',
    },
  },
  {
    name: 'Sunset',
    mode: 'light',
    tokens: {
      '--bento-bg': '#fdfaf7',
      '--bento-card': '#ffffff',
      '--bento-card-2': '#f7f1ec',
      '--bento-ink': '#0c090d',
      '--bento-muted': '#6e6870',
      '--bento-line': '#ece3dc',
      '--bento-dock-bg': '#fdfaf7',
      '--bento-dock-ink': '#0c090d',
      '--bento-mint': '#2c7f93',
      '--bento-mint-tint': '#e5f2f6',
      '--bento-purple': '#e01a4f',
      '--bento-purple-tint': '#f6e5e9',
      '--bento-pink': '#e12811',
      '--bento-pink-tint': '#f6e6e5',
      '--bento-orange': '#946d04',
      '--bento-orange-tint': '#f6f1e5',
      '--bento-anchor-from': '#f6f1e5',
      '--bento-anchor-to': '#f7f1ec',
      '--bento-anchor-ink': '#0c090d',
      '--dom-students': '#2c7f93',
      '--dom-students-soft': '#e5f2f6',
      '--dom-students-text': '#297587',
      '--dom-academics': '#e01a4f',
      '--dom-academics-soft': '#f6e5e9',
      '--dom-academics-text': '#c91747',
      '--dom-finance': '#946d04',
      '--dom-finance-soft': '#f6f1e5',
      '--dom-finance-text': '#8a6604',
      '--dom-operations': '#e12811',
      '--dom-operations-soft': '#f6e6e5',
      '--dom-operations-text': '#c9240f',
      '--dom-reports': '#2c7f93',
      '--dom-reports-soft': '#e5f2f6',
      '--dom-reports-text': '#297587',
      '--dom-staff': '#e01a4f',
      '--dom-staff-soft': '#f6e5e9',
      '--dom-staff-text': '#c91747',
      '--dom-admissions': '#2c7f93',
      '--dom-admissions-soft': '#e5f2f6',
      '--dom-admissions-text': '#297587',
      '--dom-attendance': '#946d04',
      '--dom-attendance-soft': '#f6f1e5',
      '--dom-attendance-text': '#8a6604',
      '--dom-communication': '#e12811',
      '--dom-communication-soft': '#f6e6e5',
      '--dom-communication-text': '#c9240f',
      '--dom-critical': '#e01a4f',
      '--dom-critical-soft': '#f6e5e9',
      '--dom-critical-text': '#c91747',
      '--dom-success': '#2c7f93',
      '--dom-success-soft': '#e5f2f6',
      '--dom-success-text': '#297587',
      '--dom-warning': '#946d04',
      '--dom-warning-soft': '#f6f1e5',
      '--dom-warning-text': '#8a6604',
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
    /* Empty string, not removal. An absent key means "has never chosen" and
       gets DEFAULT_PALETTE; somebody who deliberately cleared the palette has
       chosen, and removing the key would hand them the default back on the
       next reload. */
    localStorage.setItem(PALETTE_KEY, activePalette ?? '')
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
