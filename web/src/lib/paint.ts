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

export type Region = 'workarea' | 'topbar' | 'sidebar' | 'bottombar' | 'cards' | 'students' | 'academics' | 'finance' | 'operations' | 'reports'
export type Channel = 'bg' | 'text' | 'accent'

export const REGIONS: readonly Region[] = ['workarea', 'topbar', 'sidebar', 'bottombar', 'cards', 'students', 'academics', 'finance', 'operations', 'reports'] as const
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
const BENTO_DOMAINS = ['students', 'academics', 'finance', 'operations', 'reports'] as const

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

  for (const r of REGIONS) {
    for (const c of CHANNELS) {
      const v = paint[`${r}.${c}`]
      if (v) set(varName(r, c), hslString(v))
    }
  }
  for (const [key, token] of BENTO_MAP) {
    const v = paint[key]
    if (v) set(token, hslCss(v))
  }
  for (const d of BENTO_DOMAINS) {
    const bg = paint[`${d}.bg`]
    const text = paint[`${d}.text`]
    if (bg) set(`--dom-${d}`, hslCss(bg))
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

/** The shipped palettes: two for light, two for dark.

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
    the honest fix was to compute one that reads, not to leave it out. */
export interface BuiltInPalette {
  name: string
  mode: 'light' | 'dark'
  tokens: Record<string, string>
}

export const BUILT_IN_PALETTES: readonly BuiltInPalette[] = [
  {
    name: 'Porcelain Amber',
    mode: 'light',
    tokens: {
      '--bento-bg': '#eceef2',
      '--bento-card': '#ffffff',
      '--bento-card-2': '#f4f6f9',
      '--bento-ink': '#12151a',
      '--bento-muted': '#6c7684',
      '--bento-line': '#dde1e8',
      '--bento-dock-bg': '#ffffff',
      '--bento-dock-ink': '#12151a',
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
      '--bento-anchor-ink': '#0d0f12',
      '--dom-students': '#070f18',
      '--dom-students-soft': '#d7e6f4',
      '--dom-students-text': '#070f18',
      '--dom-academics': '#0e0718',
      '--dom-academics-soft': '#e3d7f4',
      '--dom-academics-text': '#0e0718',
      '--dom-finance': '#071812',
      '--dom-finance-soft': '#d7f4ea',
      '--dom-finance-text': '#071812',
      '--dom-operations': '#180f07',
      '--dom-operations-soft': '#f4e5d7',
      '--dom-operations-text': '#180f07',
      '--dom-reports': '#071418',
      '--dom-reports-soft': '#d7edf4',
      '--dom-reports-text': '#071418',
      '--dom-staff': '#180718',
      '--dom-staff-soft': '#f4d7f4',
      '--dom-staff-text': '#180718',
      '--dom-admissions': '#070718',
      '--dom-admissions-soft': '#d7d7f4',
      '--dom-admissions-text': '#070718',
      '--dom-attendance': '#071816',
      '--dom-attendance-soft': '#d7f4f1',
      '--dom-attendance-text': '#071816',
      '--dom-communication': '#180712',
      '--dom-communication-soft': '#f4d7ea',
      '--dom-communication-text': '#180712',
      '--dom-critical': '#180707',
      '--dom-critical-soft': '#f4d8d7',
      '--dom-critical-text': '#180707',
      '--dom-success': '#07180e',
      '--dom-success-soft': '#d7f4e3',
      '--dom-success-text': '#07180e',
      '--dom-warning': '#181207',
      '--dom-warning-soft': '#f4ead7',
      '--dom-warning-text': '#181207',
    },
  },
  {
    name: 'Daylight Azure',
    mode: 'light',
    tokens: {
      '--bento-bg': '#e9edf3',
      '--bento-card': '#ffffff',
      '--bento-card-2': '#f2f5fa',
      '--bento-ink': '#12151a',
      '--bento-muted': '#6c7684',
      '--bento-line': '#d9e0ea',
      '--bento-dock-bg': '#ffffff',
      '--bento-dock-ink': '#12151a',
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
      '--bento-anchor-ink': '#0d0f12',
      '--dom-students': '#070f18',
      '--dom-students-soft': '#d7e6f4',
      '--dom-students-text': '#070f18',
      '--dom-academics': '#0e0718',
      '--dom-academics-soft': '#e3d7f4',
      '--dom-academics-text': '#0e0718',
      '--dom-finance': '#071812',
      '--dom-finance-soft': '#d7f4ea',
      '--dom-finance-text': '#071812',
      '--dom-operations': '#180f07',
      '--dom-operations-soft': '#f4e5d7',
      '--dom-operations-text': '#180f07',
      '--dom-reports': '#071418',
      '--dom-reports-soft': '#d7edf4',
      '--dom-reports-text': '#071418',
      '--dom-staff': '#180718',
      '--dom-staff-soft': '#f4d7f4',
      '--dom-staff-text': '#180718',
      '--dom-admissions': '#070718',
      '--dom-admissions-soft': '#d7d7f4',
      '--dom-admissions-text': '#070718',
      '--dom-attendance': '#071816',
      '--dom-attendance-soft': '#d7f4f1',
      '--dom-attendance-text': '#071816',
      '--dom-communication': '#180712',
      '--dom-communication-soft': '#f4d7ea',
      '--dom-communication-text': '#180712',
      '--dom-critical': '#180707',
      '--dom-critical-soft': '#f4d8d7',
      '--dom-critical-text': '#180707',
      '--dom-success': '#07180e',
      '--dom-success-soft': '#d7f4e3',
      '--dom-success-text': '#07180e',
      '--dom-warning': '#181207',
      '--dom-warning-soft': '#f4ead7',
      '--dom-warning-text': '#181207',
    },
  },
  {
    name: 'Obsidian Amber',
    mode: 'dark',
    tokens: {
      '--bento-bg': '#0b0d10',
      '--bento-card': '#171a1f',
      '--bento-card-2': '#1f232a',
      '--bento-ink': '#f4f7fb',
      '--bento-muted': '#7b8593',
      '--bento-line': '#2a2f36',
      '--bento-dock-bg': '#171a1f',
      '--bento-dock-ink': '#f4f7fb',
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
      '--dom-students-text': '#e7f0f8',
      '--dom-academics': '#eee7f8',
      '--dom-academics-soft': '#352749',
      '--dom-academics-text': '#eee7f8',
      '--dom-finance': '#e7f8f3',
      '--dom-finance-soft': '#27493e',
      '--dom-finance-text': '#e7f8f3',
      '--dom-operations': '#f8efe7',
      '--dom-operations-soft': '#493727',
      '--dom-operations-text': '#f8efe7',
      '--dom-reports': '#e7f4f8',
      '--dom-reports-soft': '#274149',
      '--dom-reports-text': '#e7f4f8',
      '--dom-staff': '#f8e7f8',
      '--dom-staff-soft': '#492749',
      '--dom-staff-text': '#f8e7f8',
      '--dom-admissions': '#e7e7f8',
      '--dom-admissions-soft': '#272749',
      '--dom-admissions-text': '#e7e7f8',
      '--dom-attendance': '#e7f8f7',
      '--dom-attendance-soft': '#274946',
      '--dom-attendance-text': '#e7f8f7',
      '--dom-communication': '#f8e7f3',
      '--dom-communication-soft': '#49273e',
      '--dom-communication-text': '#f8e7f3',
      '--dom-critical': '#f8e8e7',
      '--dom-critical-soft': '#492827',
      '--dom-critical-text': '#f8e8e7',
      '--dom-success': '#e7f8ee',
      '--dom-success-soft': '#274935',
      '--dom-success-text': '#e7f8ee',
      '--dom-warning': '#f8f3e7',
      '--dom-warning-soft': '#493e27',
      '--dom-warning-text': '#f8f3e7',
    },
  },
  {
    name: 'Midnight Azure',
    mode: 'dark',
    tokens: {
      '--bento-bg': '#080c14',
      '--bento-card': '#101827',
      '--bento-card-2': '#18202f',
      '--bento-ink': '#f4f7fb',
      '--bento-muted': '#788391',
      '--bento-line': '#1c293a',
      '--bento-dock-bg': '#101827',
      '--bento-dock-ink': '#f4f7fb',
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
      '--dom-students-text': '#e7f0f8',
      '--dom-academics': '#eee7f8',
      '--dom-academics-soft': '#352749',
      '--dom-academics-text': '#eee7f8',
      '--dom-finance': '#e7f8f3',
      '--dom-finance-soft': '#27493e',
      '--dom-finance-text': '#e7f8f3',
      '--dom-operations': '#f8efe7',
      '--dom-operations-soft': '#493727',
      '--dom-operations-text': '#f8efe7',
      '--dom-reports': '#e7f4f8',
      '--dom-reports-soft': '#274149',
      '--dom-reports-text': '#e7f4f8',
      '--dom-staff': '#f8e7f8',
      '--dom-staff-soft': '#492749',
      '--dom-staff-text': '#f8e7f8',
      '--dom-admissions': '#e7e7f8',
      '--dom-admissions-soft': '#272749',
      '--dom-admissions-text': '#e7e7f8',
      '--dom-attendance': '#e7f8f7',
      '--dom-attendance-soft': '#274946',
      '--dom-attendance-text': '#e7f8f7',
      '--dom-communication': '#f8e7f3',
      '--dom-communication-soft': '#49273e',
      '--dom-communication-text': '#f8e7f3',
      '--dom-critical': '#f8e8e7',
      '--dom-critical-soft': '#492827',
      '--dom-critical-text': '#f8e8e7',
      '--dom-success': '#e7f8ee',
      '--dom-success-soft': '#274935',
      '--dom-success-text': '#e7f8ee',
      '--dom-warning': '#f8f3e7',
      '--dom-warning-soft': '#493e27',
      '--dom-warning-text': '#f8f3e7',
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
