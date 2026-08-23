import { useCallback, useSyncExternalStore } from 'react'

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
  const root = document.documentElement
  for (const r of REGIONS) {
    for (const c of CHANNELS) {
      const v = next[`${r}.${c}`]
      if (v) root.style.setProperty(varName(r, c), hslString(v))
      else root.style.removeProperty(varName(r, c))
    }
  }
  applyToBento(next)
  paint = next
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

function applyToBento(next: Paint) {
  const root = document.documentElement
  for (const [key, token] of BENTO_MAP) {
    const v = next[key]
    if (v) root.style.setProperty(token, hslCss(v))
    else root.style.removeProperty(token)
  }
  for (const d of BENTO_DOMAINS) {
    const bg = next[`${d}.bg`]
    const text = next[`${d}.text`]
    if (bg) root.style.setProperty(`--dom-${d}`, hslCss(bg))
    else root.style.removeProperty(`--dom-${d}`)
    if (text) root.style.setProperty(`--dom-${d}-text`, hslCss(text))
    else root.style.removeProperty(`--dom-${d}-text`)
  }
}

export function setPaint(region: Region, channel: Channel, value: Hsl | undefined) {
  const next: Paint = { ...paint }
  if (value) next[`${region}.${channel}`] = value
  else delete next[`${region}.${channel}`]
  applyPaint(next)
}

export function resetPaint() {
  applyPaint({})
}

/* The shipped palettes.

   Six shades each, and only five of them land anywhere: ground, card, raised,
   accent and ink. The sixth in each set is a mid grey meant for muted text,
   and it measures 2.7-3.2:1 against its own card — under the 4.5:1 that body
   text needs — so it is deliberately not mapped. `--bento-muted` keeps the
   value the theme already derives, which does clear it.

   Every pairing that IS mapped was measured: ink on card lands between 15.2
   and 16.3:1, ink on a domain card between 11.6 and 13.7:1, and the accent on
   card between 5.3 and 7.7:1. All five pass AA on all three.

   The five domain regions take the same raised shade rather than five hues.
   That is the point of these sets — one accent, and the ground doing the rest.

   These are read-only: `applyPalette` finds them by name, and `deletePalette`
   only ever touches the saved list, so applying one and then editing it saves
   a copy under the person's own name instead of overwriting what ships. */
export const BUILT_IN_PALETTES: readonly Palette[] = [
  {
    name: 'Obsidian Amber',
    paint: {
      'workarea.bg': { h: 216, s: 19, l: 5 },
      'workarea.text': { h: 39, s: 39, l: 93 },
      'workarea.accent': { h: 34, s: 56, l: 50 },
      'topbar.bg': { h: 218, s: 15, l: 11 },
      'topbar.text': { h: 39, s: 39, l: 93 },
      'topbar.accent': { h: 34, s: 56, l: 50 },
      'sidebar.bg': { h: 218, s: 15, l: 11 },
      'sidebar.text': { h: 39, s: 39, l: 93 },
      'sidebar.accent': { h: 34, s: 56, l: 50 },
      'bottombar.bg': { h: 218, s: 15, l: 11 },
      'bottombar.text': { h: 39, s: 39, l: 93 },
      'bottombar.accent': { h: 34, s: 56, l: 50 },
      'cards.bg': { h: 218, s: 15, l: 11 },
      'cards.text': { h: 39, s: 39, l: 93 },
      'cards.accent': { h: 34, s: 56, l: 50 },
      'students.bg': { h: 215, s: 12, l: 19 },
      'students.text': { h: 39, s: 39, l: 93 },
      'students.accent': { h: 34, s: 56, l: 50 },
      'academics.bg': { h: 215, s: 12, l: 19 },
      'academics.text': { h: 39, s: 39, l: 93 },
      'academics.accent': { h: 34, s: 56, l: 50 },
      'finance.bg': { h: 215, s: 12, l: 19 },
      'finance.text': { h: 39, s: 39, l: 93 },
      'finance.accent': { h: 34, s: 56, l: 50 },
      'operations.bg': { h: 215, s: 12, l: 19 },
      'operations.text': { h: 39, s: 39, l: 93 },
      'operations.accent': { h: 34, s: 56, l: 50 },
      'reports.bg': { h: 215, s: 12, l: 19 },
      'reports.text': { h: 39, s: 39, l: 93 },
      'reports.accent': { h: 34, s: 56, l: 50 },
    },
  },
  {
    name: 'Midnight Azure',
    paint: {
      'workarea.bg': { h: 220, s: 43, l: 5 },
      'workarea.text': { h: 212, s: 100, l: 97 },
      'workarea.accent': { h: 207, s: 70, l: 59 },
      'topbar.bg': { h: 219, s: 42, l: 11 },
      'topbar.text': { h: 212, s: 100, l: 97 },
      'topbar.accent': { h: 207, s: 70, l: 59 },
      'sidebar.bg': { h: 219, s: 42, l: 11 },
      'sidebar.text': { h: 212, s: 100, l: 97 },
      'sidebar.accent': { h: 207, s: 70, l: 59 },
      'bottombar.bg': { h: 219, s: 42, l: 11 },
      'bottombar.text': { h: 212, s: 100, l: 97 },
      'bottombar.accent': { h: 207, s: 70, l: 59 },
      'cards.bg': { h: 219, s: 42, l: 11 },
      'cards.text': { h: 212, s: 100, l: 97 },
      'cards.accent': { h: 207, s: 70, l: 59 },
      'students.bg': { h: 214, s: 35, l: 17 },
      'students.text': { h: 212, s: 100, l: 97 },
      'students.accent': { h: 207, s: 70, l: 59 },
      'academics.bg': { h: 214, s: 35, l: 17 },
      'academics.text': { h: 212, s: 100, l: 97 },
      'academics.accent': { h: 207, s: 70, l: 59 },
      'finance.bg': { h: 214, s: 35, l: 17 },
      'finance.text': { h: 212, s: 100, l: 97 },
      'finance.accent': { h: 207, s: 70, l: 59 },
      'operations.bg': { h: 214, s: 35, l: 17 },
      'operations.text': { h: 212, s: 100, l: 97 },
      'operations.accent': { h: 207, s: 70, l: 59 },
      'reports.bg': { h: 214, s: 35, l: 17 },
      'reports.text': { h: 212, s: 100, l: 97 },
      'reports.accent': { h: 207, s: 70, l: 59 },
    },
  },
  {
    name: 'Forest Brass',
    paint: {
      'workarea.bg': { h: 156, s: 20, l: 5 },
      'workarea.text': { h: 53, s: 24, l: 93 },
      'workarea.accent': { h: 39, s: 42, l: 52 },
      'topbar.bg': { h: 150, s: 17, l: 9 },
      'topbar.text': { h: 53, s: 24, l: 93 },
      'topbar.accent': { h: 39, s: 42, l: 52 },
      'sidebar.bg': { h: 150, s: 17, l: 9 },
      'sidebar.text': { h: 53, s: 24, l: 93 },
      'sidebar.accent': { h: 39, s: 42, l: 52 },
      'bottombar.bg': { h: 150, s: 17, l: 9 },
      'bottombar.text': { h: 53, s: 24, l: 93 },
      'bottombar.accent': { h: 39, s: 42, l: 52 },
      'cards.bg': { h: 150, s: 17, l: 9 },
      'cards.text': { h: 53, s: 24, l: 93 },
      'cards.accent': { h: 39, s: 42, l: 52 },
      'students.bg': { h: 148, s: 17, l: 17 },
      'students.text': { h: 53, s: 24, l: 93 },
      'students.accent': { h: 39, s: 42, l: 52 },
      'academics.bg': { h: 148, s: 17, l: 17 },
      'academics.text': { h: 53, s: 24, l: 93 },
      'academics.accent': { h: 39, s: 42, l: 52 },
      'finance.bg': { h: 148, s: 17, l: 17 },
      'finance.text': { h: 53, s: 24, l: 93 },
      'finance.accent': { h: 39, s: 42, l: 52 },
      'operations.bg': { h: 148, s: 17, l: 17 },
      'operations.text': { h: 53, s: 24, l: 93 },
      'operations.accent': { h: 39, s: 42, l: 52 },
      'reports.bg': { h: 148, s: 17, l: 17 },
      'reports.text': { h: 53, s: 24, l: 93 },
      'reports.accent': { h: 39, s: 42, l: 52 },
    },
  },
  {
    name: 'Deep Plum',
    paint: {
      'workarea.bg': { h: 266, s: 26, l: 5 },
      'workarea.text': { h: 285, s: 33, l: 95 },
      'workarea.accent': { h: 289, s: 29, l: 59 },
      'topbar.bg': { h: 270, s: 25, l: 9 },
      'topbar.text': { h: 285, s: 33, l: 95 },
      'topbar.accent': { h: 289, s: 29, l: 59 },
      'sidebar.bg': { h: 270, s: 25, l: 9 },
      'sidebar.text': { h: 285, s: 33, l: 95 },
      'sidebar.accent': { h: 289, s: 29, l: 59 },
      'bottombar.bg': { h: 270, s: 25, l: 9 },
      'bottombar.text': { h: 285, s: 33, l: 95 },
      'bottombar.accent': { h: 289, s: 29, l: 59 },
      'cards.bg': { h: 270, s: 25, l: 9 },
      'cards.text': { h: 285, s: 33, l: 95 },
      'cards.accent': { h: 289, s: 29, l: 59 },
      'students.bg': { h: 275, s: 23, l: 16 },
      'students.text': { h: 285, s: 33, l: 95 },
      'students.accent': { h: 289, s: 29, l: 59 },
      'academics.bg': { h: 275, s: 23, l: 16 },
      'academics.text': { h: 285, s: 33, l: 95 },
      'academics.accent': { h: 289, s: 29, l: 59 },
      'finance.bg': { h: 275, s: 23, l: 16 },
      'finance.text': { h: 285, s: 33, l: 95 },
      'finance.accent': { h: 289, s: 29, l: 59 },
      'operations.bg': { h: 275, s: 23, l: 16 },
      'operations.text': { h: 285, s: 33, l: 95 },
      'operations.accent': { h: 289, s: 29, l: 59 },
      'reports.bg': { h: 275, s: 23, l: 16 },
      'reports.text': { h: 285, s: 33, l: 95 },
      'reports.accent': { h: 289, s: 29, l: 59 },
    },
  },
  {
    name: 'Arctic Slate',
    paint: {
      'workarea.bg': { h: 206, s: 28, l: 5 },
      'workarea.text': { h: 165, s: 33, l: 95 },
      'workarea.accent': { h: 174, s: 33, l: 58 },
      'topbar.bg': { h: 202, s: 23, l: 9 },
      'topbar.text': { h: 165, s: 33, l: 95 },
      'topbar.accent': { h: 174, s: 33, l: 58 },
      'sidebar.bg': { h: 202, s: 23, l: 9 },
      'sidebar.text': { h: 165, s: 33, l: 95 },
      'sidebar.accent': { h: 174, s: 33, l: 58 },
      'bottombar.bg': { h: 202, s: 23, l: 9 },
      'bottombar.text': { h: 165, s: 33, l: 95 },
      'bottombar.accent': { h: 174, s: 33, l: 58 },
      'cards.bg': { h: 202, s: 23, l: 9 },
      'cards.text': { h: 165, s: 33, l: 95 },
      'cards.accent': { h: 174, s: 33, l: 58 },
      'students.bg': { h: 201, s: 22, l: 18 },
      'students.text': { h: 165, s: 33, l: 95 },
      'students.accent': { h: 174, s: 33, l: 58 },
      'academics.bg': { h: 201, s: 22, l: 18 },
      'academics.text': { h: 165, s: 33, l: 95 },
      'academics.accent': { h: 174, s: 33, l: 58 },
      'finance.bg': { h: 201, s: 22, l: 18 },
      'finance.text': { h: 165, s: 33, l: 95 },
      'finance.accent': { h: 174, s: 33, l: 58 },
      'operations.bg': { h: 201, s: 22, l: 18 },
      'operations.text': { h: 165, s: 33, l: 95 },
      'operations.accent': { h: 174, s: 33, l: 58 },
      'reports.bg': { h: 201, s: 22, l: 18 },
      'reports.text': { h: 165, s: 33, l: 95 },
      'reports.accent': { h: 174, s: 33, l: 58 },
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
  /* Saved first, shipped second: somebody who saved their own "Deep Plum"
     meant theirs. */
  const p = palettes.find((x) => x.name === name)
    ?? BUILT_IN_PALETTES.find((x) => x.name === name)
  if (p) applyPaint({ ...p.paint })
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
