import { useCallback, useSyncExternalStore } from 'react'
import type { Hsl } from './paint'

/* The dashboard as something a person arranges.

   Four sizes, chosen to match the grid rather than to sound generous. The
   board is four columns, so the only widths that tile without leaving holes
   are 1, 2 and 4 — a 3-wide cell strands a column on every row it appears in.
   Height is 1 or 2 for the same reason: taller than two rows and a card cannot
   share a row with anything, which is a layout decision disguised as a size.

   That leaves five shapes worth offering, and they are all five here.

     small   1x1   a figure and its label
     tall    1x2   a column: a short list that wants depth, not width
     medium  2x1   a figure with a meter or a note beside it
     large   2x2   the hero: a big number, a chart and two actions
     full    4x1   a strip across the board, for a chart that needs the width

   Stored per dashboard and per device. Not on the account row: a layout is
   bound to the screen somebody arranged it on, and a principal who tidies
   their laptop dashboard should not find their desk monitor rearranged to
   match a narrower board. */

export type WidgetSize = 'small' | 'tall' | 'medium' | 'large' | 'full'

export const SIZES: readonly WidgetSize[] = ['small', 'tall', 'medium', 'large', 'full'] as const

/* Two axes, five steps each, because that is what a person actually decides.

   The named sizes below are still how a dashboard DECLARES its default — a
   cell says size="large" and means it — but once somebody starts arranging,
   they are choosing a width and a height, and a fixed menu of five named
   shapes cannot express "three wide and one tall". Storing w/h rather than a
   name also means a later size costs no migration. */
export const WIDTHS = [1, 2, 3, 4, 5] as const
export const HEIGHTS = [1, 2, 3, 4, 5] as const

/** What a placed widget carries. Order is the array position. */
export interface Placed {
  id: string
  w: number
  h: number
  /** The colour chosen from the wheel, or absent for the colour the dashboard
      gave it.

      Stored as HSL rather than hex because the two things that have to be
      derived from it — a readable ink, and the softer wash behind a badge —
      are both trivial in HSL and fiddly in hex.

      This DOES mean a tinted card no longer follows the theme: it stays the
      colour it was picked as when everything around it goes dark. That is the
      cost of an open colour wheel over a palette of names, and it is the right
      trade only because a person picked this colour deliberately for this card.
      The default — no tint — still follows the theme completely. */
  tint?: Hsl
}

/** A few places to start from, so the wheel does not open on nothing. Not a
    fixed menu — every one of them is a starting point you then move. */
/** The layouts somebody picks instead of building one. */
export type Preset = 'default' | 'compact' | 'spotlight' | 'banner' | 'even' | 'columns'

export const PRESETS: readonly Preset[] =
  ['default', 'compact', 'spotlight', 'banner', 'even', 'columns'] as const

export const TINT_STARTS: Hsl[] = [
  { h: 217, s: 91, l: 60 },
  { h: 163, s: 70, l: 38 },
  { h: 262, s: 72, l: 52 },
  { h: 32, s: 88, l: 45 },
  { h: 344, s: 76, l: 50 },
]

function validHsl(v: unknown): Hsl | null {
  const t = v as { h?: unknown; s?: unknown; l?: unknown }
  if (!t || typeof t.h !== 'number' || typeof t.s !== 'number' || typeof t.l !== 'number') return null
  if (!Number.isFinite(t.h) || !Number.isFinite(t.s) || !Number.isFinite(t.l)) return null
  return { h: ((t.h % 360) + 360) % 360, s: Math.min(100, Math.max(0, t.s)), l: Math.min(100, Math.max(0, t.l)) }
}

/** Ink that stays readable on a chosen colour.

    Relative luminance by the WCAG formula rather than a lightness threshold:
    HSL lightness is not perceptual, so a fully saturated yellow at l=50 is far
    brighter than a blue at the same l, and a naive `l > 55` test puts white
    text on it. */
export function inkFor({ h, s, l }: Hsl): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
  const ch = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const lum = 0.2126 * ch(0) + 0.7152 * ch(8) + 0.0722 * ch(4)
  // 0.179 is where white and black draw level against a mid grey.
  return lum > 0.179 ? '#101114' : '#ffffff'
}

/** A colour written the way people paste it: #rgb or #rrggbb, with or without
    the hash. Returns null for anything that is not one, so a half-typed value
    leaves the card alone instead of flashing through every colour on the way. */
export function hexToHsl(raw: string): Hsl | null {
  const t = raw.trim().replace(/^#/, '')
  const full = t.length === 3 ? t.split('').map((c) => c + c).join('') : t
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  const r = parseInt(full.slice(0, 2), 16) / 255
  const g = parseInt(full.slice(2, 4), 16) / 255
  const b = parseInt(full.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l: l * 100 }
  const sat = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s: sat * 100, l: l * 100 }
}

/** The same colour written back out, so the field shows what was picked on the
    wheel rather than going blank the moment somebody uses it. */
export function hslToHex({ h, s, l }: Hsl): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
  const ch = (n: number) => {
    const k = (n + h / 30) % 12
    const v = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * v).toString(16).padStart(2, '0')
  }
  return `#${ch(0)}${ch(8)}${ch(4)}`
}

export function cssHsl({ h, s, l }: Hsl): string {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`
}

/** The chosen hue as a QUIET PANEL, not a fill.

    A card tint was painted at full chroma — the brand colour used as the card's
    background — which is the loudest thing a school's home can do and the whole
    reason the board reads as five competing signals. The person still gets the
    colour they chose: the hue is preserved exactly. What changes is its volume.

    `color-mix` over `--bento-card` is what lets one declaration behave in both
    themes without the JS knowing which is active. On light the card is white, so
    the hue lands as a pale wash; on dark the card is #1c1e26, so the same hue
    lands as a dim tint — soft in both, never a flooded cell. And because the
    panel is mostly the card, the card's OWN ink keeps its measured contrast on
    top of it: no per-tint ink calculation, no rainbow of coloured figures.

    THE MIX IS A THEME TOKEN, NOT A NUMBER HERE. 16% was tried first and the
    user's verdict was "too soft and dull" — it optimised for the contrast floor
    and not for the colour still meaning something. The loudest mix at which the
    card's FULL ink clears 4.5:1 on every text element, worst case over the
    whole hue wheel at full saturation, is 55% on light (5.61:1) and 40% on dark
    (4.69:1); 70% fails both (3.80 / 2.05). Those two values live in
    bento-theme.css as `--tint-mix`, so one inline declaration paints the right
    strength for whichever theme is active. Faded text (the 0.6 / 0.7 opacity
    runs) fails above 28% at ANY mix, so a tinted card lifts every text fade to
    full ink instead of giving up chroma — see `[data-tinted]` in the theme.

    Old saved tints stored at full strength flow through here too, so a board
    someone already coloured takes the same measured strength without touching
    their saved choice. */
export function softTintBg(tint: Hsl): string {
  /* Mixed against --bento-card-base, NOT --bento-card.

     A tinted card sets --bento-card to this very expression so that a card
     with no domain follows the colour too. Mixing against --bento-card would
     therefore make the token reference itself, and a cyclic custom property
     is invalid at computed-value time: the background resolves to nothing and
     the card comes out its untinted colour, which is exactly what it looked
     like. --bento-card-base is the theme's own card colour and nothing
     rewrites it. */
  return `color-mix(in srgb, ${cssHsl(tint)} var(--tint-mix, 40%), var(--bento-card-base, #fff))`
}

/** The columns and rows a named default occupies. */
export const DIMS: Record<WidgetSize, { w: number; h: number }> = {
  small: { w: 1, h: 1 },
  tall: { w: 1, h: 2 },
  medium: { w: 2, h: 1 },
  large: { w: 2, h: 2 },
  full: { w: 5, h: 1 },
}

function clamp(n: unknown, hi: number): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= hi ? n : null
}

/** A layout is the placed list plus the ids explicitly taken off the board.

    Removed is stored rather than inferred from absence, and that distinction
    matters: a widget the product adds later must appear for everybody who has
    never touched it, and must stay away from anybody who removed it. Inferring
    "not in the list means removed" would hide every new widget from every
    existing user, permanently and silently. */
export interface Layout {
  placed: Placed[]
  removed: string[]
}

const EMPTY: Layout = { placed: [], removed: [] }

function key(dashboard: string) {
  return `erp.widgets.${dashboard}`
}

function read(dashboard: string): Layout {
  try {
    const raw = localStorage.getItem(key(dashboard))
    if (!raw) return EMPTY
    const v = JSON.parse(raw) as Partial<Layout>
    return {
      /* Anything unreadable is dropped rather than repaired. A layout is a
         convenience; a half-understood one that throws on render is not.

         A row saved under the old named-size scheme is translated instead of
         discarded, so nobody who arranged a board before this change opens it
         to find their arrangement gone. */
      placed: Array.isArray(v.placed)
        ? (v.placed as unknown[]).flatMap((raw) => {
            const p = raw as { id?: unknown; w?: unknown; h?: unknown; size?: unknown; tint?: unknown }
            if (!p || typeof p.id !== 'string') return []
            const w = clamp(p.w, WIDTHS.length)
            const h = clamp(p.h, HEIGHTS.length)
            /* A tint saved when colours were palette NAMES is dropped rather
               than guessed at: the card returns to the colour its dashboard
               gives it, which is a visible, correct state — unlike a name
               interpolated into var(--dom-NAME) that resolves to nothing and
               leaves the card with no background at all. */
            const hsl = validHsl(p.tint)
            const tint = hsl ? { tint: hsl } : {}
            if (w && h) return [{ id: p.id, w, h, ...tint }]
            if (typeof p.size === 'string' && p.size in DIMS) {
              const d = DIMS[p.size as WidgetSize]
              return [{ id: p.id, w: d.w, h: d.h, ...tint }]
            }
            return []
          })
        : [],
      removed: Array.isArray(v.removed) ? v.removed.filter((x): x is string => typeof x === 'string') : [],
    }
  } catch {
    return EMPTY
  }
}

const cache = new Map<string, Layout>()

/* One step of history, kept in memory only.

   Arranging is the one place in this product where somebody can wreck a
   screen in a single click — remove the card they meant to resize, or drop one
   somewhere unexpected — and "Reset layout" is far too blunt an answer,
   because it throws away every deliberate change alongside the accident.

   Deliberately NOT persisted. Undo is for the mistake you just made, and an
   undo that survives a reload is an invitation to undo something you decided
   on last week and have forgotten. */
const history = new Map<string, Layout>()
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

function current(dashboard: string): Layout {
  if (!cache.has(dashboard)) {
    cache.set(dashboard, typeof window === 'undefined' ? EMPTY : read(dashboard))
  }
  return cache.get(dashboard)!
}

function write(dashboard: string, next: Layout, remember = true) {
  if (remember) history.set(dashboard, current(dashboard))
  cache.set(dashboard, next)
  try {
    // An untouched dashboard stores nothing, so "never arranged" and "arranged
    // back to the default" stay different states — the second keeps following
    // the product's default as it changes, the first does not need a row at all.
    if (next.placed.length === 0 && next.removed.length === 0) {
      localStorage.removeItem(key(dashboard))
    } else {
      localStorage.setItem(key(dashboard), JSON.stringify(next))
    }
  } catch {
    /* private browsing: the arrangement lasts the session */
  }
  emit()
}

export function useLayout(dashboard: string) {
  const layout = useSyncExternalStore(
    subscribe,
    () => current(dashboard),
    () => EMPTY,
  )

  const place = useCallback(
    (id: string, w: number, h: number) => {
      const l = current(dashboard)
      write(dashboard, {
        placed: l.placed.some((p) => p.id === id) ? l.placed : [...l.placed, { id, w, h }],
        removed: l.removed.filter((r) => r !== id),
      })
    },
    [dashboard],
  )

  const remove = useCallback(
    (id: string) => {
      const l = current(dashboard)
      write(dashboard, {
        placed: l.placed.filter((p) => p.id !== id),
        removed: l.removed.includes(id) ? l.removed : [...l.removed, id],
      })
    },
    [dashboard],
  )

  const resize = useCallback(
    (id: string, w: number, h: number) => {
      const l = current(dashboard)
      const has = l.placed.some((p) => p.id === id)
      write(dashboard, {
        // A widget resized before it was ever explicitly placed is placed now.
        // Otherwise the first choice on a default card would do nothing.
        placed: has
          ? l.placed.map((p) => (p.id === id ? { ...p, w, h } : p))
          : [...l.placed, { id, w, h }],
        removed: l.removed.filter((r) => r !== id),
      })
    },
    [dashboard],
  )

  const move = useCallback(
    (id: string, to: number, all: Placed[]) => {
      const l = current(dashboard)
      /* Ordering needs every visible widget in the list, not only the ones
         somebody has already touched, or moving a default card would jump it
         to the front of a list of one.

         Each untouched widget must be seeded at ITS OWN default size, which is
         why this takes sizes and not just ids. Seeding them all at 'small'
         meant the first drag quietly shrank every card that had never been
         resized — the hero included. Reordering must not be a resize. */
      const seed: Placed[] = all.map(
        (x) => l.placed.find((p) => p.id === x.id) ?? { id: x.id, w: x.w, h: x.h },
      )
      const from = seed.findIndex((p) => p.id === id)
      if (from < 0 || to < 0 || to >= seed.length) return
      const next = [...seed]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      write(dashboard, { placed: next, removed: l.removed })
    },
    [dashboard],
  )

  /* Colour is stored on the placement, so choosing one places the widget the
     same way choosing a size does. Passing null returns it to the colour the
     dashboard gave it rather than storing a "default" that would stop tracking
     the dashboard if that colour ever changed. */
  const recolour = useCallback(
    (id: string, tint: Hsl | null, w: number, h: number) => {
      const l = current(dashboard)
      const at = l.placed.find((p) => p.id === id)
      const next: Placed = at ? { ...at } : { id, w, h }
      if (tint) next.tint = tint
      else delete next.tint
      write(dashboard, {
        placed: at ? l.placed.map((p) => (p.id === id ? next : p)) : [...l.placed, next],
        removed: l.removed.filter((r) => r !== id),
      })
    },
    [dashboard],
  )

  const reset = useCallback(() => write(dashboard, EMPTY), [dashboard])

  /* Pick a layout instead of building one.

     Arrows, sizes, colours and drag between them make a capable editor, and a
     capable editor is still an editor — most people opening a dashboard do not
     want to design one, they want a good one and the ability to nudge it. Every
     control added to make arranging easier made arranging bigger.

     So the ordinary path is four buttons. Each is a RULE over whatever the
     board happens to declare, not a stored list of ids, which is what lets the
     same four work on all six dashboards and keep working when a card is added
     later. Nobody has to maintain a preset per screen. */
  const applyPreset = useCallback(
    (preset: Preset, all: BoardWidget[]) => {
      const l = current(dashboard)
      const keep = all.filter((x) => !l.removed.includes(x.id))
      const tint = (id: string) => {
        const p = l.placed.find((q) => q.id === id)
        return p?.tint ? { tint: p.tint } : {}
      }

      let placed: Placed[]
      switch (preset) {
        case 'compact':
          // Everything at one unit: the whole board at a glance, nothing
          // claiming more attention than anything else.
          placed = keep.map((x) => ({ id: x.id, w: 1, h: 1, ...tint(x.id) }))
          break
        case 'spotlight': {
          // The first card the dashboard declares is the one it considers most
          // important — that ordering is a decision somebody already made, and
          // it is better than asking again.
          placed = keep.map((x, i) =>
            i === 0
              ? { id: x.id, w: 3, h: 2, ...tint(x.id) }
              : { id: x.id, w: 1, h: 1, ...tint(x.id) },
          )
          break
        }
        case 'banner':
          // The first card as a band across the whole board, the rest in a
          // row of units beneath it: a headline and its supporting figures.
          placed = keep.map((x, i) =>
            i === 0
              ? { id: x.id, w: 5, h: 1, ...tint(x.id) }
              : { id: x.id, w: 1, h: 1, ...tint(x.id) },
          )
          break
        case 'even':
          placed = keep.map((x) => ({ id: x.id, w: 2, h: 1, ...tint(x.id) }))
          break
        case 'columns':
          // Every card tall and narrow: five columns read top to bottom, the
          // shape for a board of lists rather than of figures.
          placed = keep.map((x) => ({ id: x.id, w: 1, h: 2, ...tint(x.id) }))
          break
        case 'default':
        default:
          // Back to the sizes each card was designed at, keeping colours and
          // keeping removals: "as designed" is not the same as "as shipped".
          placed = keep.map((x) => ({ id: x.id, w: DIMS[x.size].w, h: DIMS[x.size].h, ...tint(x.id) }))
          break
      }
      write(dashboard, { placed, removed: l.removed })
    },
    [dashboard],
  )

  /* Undo the last change, once.

     The undone state is not itself remembered, so undo cannot be undone into a
     loop — press it twice and the second press does nothing rather than
     restoring the mistake. */
  const undo = useCallback(() => {
    const prev = history.get(dashboard)
    if (!prev) return
    history.delete(dashboard)
    write(dashboard, prev, false)
  }, [dashboard])

  const canUndo = history.has(dashboard)

  /* Put the board in a sensible order without anybody having to drag anything.

     Largest first, then by the order the dashboard declared. That is not an
     aesthetic preference: dense packing fills holes with whatever comes next,
     so a big card arriving late has to start a new row and leaves a gap behind
     it. Sorting big-to-small is what makes the packing come out without
     holes — the same reason a mason lays the large stones first.

     Sizes and colours are untouched. This answers "I have made a mess of the
     order", which is a different problem from "I have made a mess". */
  const tidy = useCallback(
    (all: BoardWidget[]) => {
      const l = current(dashboard)
      const sized = all.map((x) => {
        const p = l.placed.find((q) => q.id === x.id)
        return p ?? { id: x.id, w: x.w, h: x.h }
      })
      const declared = new Map(all.map((x, i) => [x.id, i]))
      const ordered = [...sized].sort((a, b) => {
        const area = b.w * b.h - a.w * a.h
        if (area !== 0) return area
        return (declared.get(a.id) ?? 0) - (declared.get(b.id) ?? 0)
      })
      write(dashboard, { placed: ordered, removed: l.removed })
    },
    [dashboard],
  )

  return { layout, place, remove, resize, recolour, move, reset, undo, canUndo, tidy, applyPreset }
}

/** The width and height a widget should render at: what the person chose,
    else the dimensions of the size it declared. */
export function dimsOf(layout: Layout, id: string, fallback: WidgetSize): { w: number; h: number } {
  const p = layout.placed.find((x) => x.id === id)
  return p ? { w: p.w, h: p.h } : DIMS[fallback]
}

/** The colour a widget was given, if any. */
export function tintOf(layout: Layout, id: string): Hsl | null {
  return layout.placed.find((p) => p.id === id)?.tint ?? null
}

export function isRemoved(layout: Layout, id: string): boolean {
  return layout.removed.includes(id)
}

/** Where a widget sits. Untouched widgets keep their declared order by sorting
    after everything explicitly placed. */
export function orderOf(layout: Layout, id: string, declared: number): number {
  const i = layout.placed.findIndex((p) => p.id === id)
  return i >= 0 ? i : layout.placed.length + declared
}

/* ─────────────────────────────────────────────────────────────────────────
   The board on screen, published so the settings dialog can reach it.

   Arranging is entered from Settings > Dashboard Widgets, which lives in the
   dock — outside the dashboard's React tree entirely. So "which board is on
   screen, what is on it, and are we arranging it" cannot be component state
   in the layer; it has to be somewhere both ends can see.

   It is deliberately a single board, not a map. Exactly one dashboard is
   mounted at a time, and keeping a map would raise a question the product
   never asks: which of several boards does the settings panel mean?
   ───────────────────────────────────────────────────────────────────────── */

/** A widget as the board reports it: what it is called and how big it is by
    default, which is what the settings panel needs to list and restore it. */
export interface BoardWidget {
  id: string
  label: string
  index: number
  /** Its declared default, which is what "restore" and "add back" mean. */
  size: WidgetSize
  w: number
  h: number
  /** Declared but NOT placed by default: it waits in the add tray.

      The board is a fixed fifteen slots. A dashboard with more cells worth
      offering than slots to hold them has to choose, and the honest choice is
      to ship the core board full and let the rest be added deliberately —
      rather than placing everything and letting the overflow squash every row
      until the text inside clips. */
  optional?: boolean
}

interface Board {
  dashboard: string | null
  widgets: BoardWidget[]
}

const NO_BOARD: Board = { dashboard: null, widgets: [] }

let board: Board = NO_BOARD
let arranging = false
const boardListeners = new Set<() => void>()

function subscribeBoard(fn: () => void) {
  boardListeners.add(fn)
  return () => {
    boardListeners.delete(fn)
  }
}

function emitBoard() {
  for (const l of boardListeners) l()
}

/** Called by the layer when the board it renders changes. Identity is only
    replaced when the contents actually differ, because the snapshot is read by
    useSyncExternalStore and a fresh array every render is an infinite loop. */
export function publishBoard(dashboard: string, widgets: BoardWidget[]) {
  const same =
    board.dashboard === dashboard &&
    board.widgets.length === widgets.length &&
    board.widgets.every((w, i) => w.id === widgets[i].id && w.label === widgets[i].label && w.w === widgets[i].w && w.h === widgets[i].h)
  if (same) return
  board = { dashboard, widgets }
  if (arrangeWanted) {
    arrangeWanted = false
    arranging = true
  }
  emitBoard()
}

/** Called when a board unmounts. Guarded by dashboard name so a screen that is
    already gone cannot clear the board its successor has just published. */
export function clearBoard(dashboard: string) {
  if (board.dashboard !== dashboard) return
  board = NO_BOARD
  // Leaving arrange mode armed would drop the next dashboard straight into an
  // editing state nobody asked for.
  arranging = false
  emitBoard()
}

/* Arrange the board that is ABOUT to be on screen.

   `setArranging(true)` only works if the board is already mounted: the tab
   menu can be used on a Home tab somebody is not currently looking at, and
   navigating there unmounts the old board — whose `clearBoard` deliberately
   drops arrange mode, so a flag set before the move is cleared by the move.

   So the intent is parked instead, and the next board to publish picks it up.
   One-shot: it is consumed on use, or a single "rearrange" would put every
   dashboard opened afterwards into edit mode. */
let arrangeWanted = false

export function requestArrange() {
  if (board.dashboard) {
    setArranging(true)
    return
  }
  arrangeWanted = true
}

export function setArranging(v: boolean) {
  if (arranging === v) return
  arranging = v
  emitBoard()
}

/** What is on screen and whether it is being arranged. */
export function useBoard() {
  const b = useSyncExternalStore(subscribeBoard, () => board, () => NO_BOARD)
  const on = useSyncExternalStore(subscribeBoard, () => arranging, () => false)
  return { dashboard: b.dashboard, widgets: b.widgets, arranging: on, setArranging }
}

/* ─────────────────────────────────────────────────────────────────────────
   WILL IT STILL FIT?

   The board is allowed to be arranged into any shape, EXCEPT one that runs off
   the bottom of the screen. Letting somebody choose a size and then quietly
   breaking the dashboard is worse than refusing the choice and saying why.

   That means knowing how many rows a layout needs, which means packing it the
   way CSS grid does. There is no way to ask the browser this before the fact,
   so it is simulated: same column count, same dense flow, same order.
   ───────────────────────────────────────────────────────────────────────── */

/** How many rows this set of widgets occupies at the given column count.

    Mirrors `grid-auto-flow: dense`: each item takes the first position it fits
    in, scanning left to right and top to bottom, so a later small card may
    back-fill a gap an earlier wide one left behind. */
export function rowsNeeded(items: { w: number; h: number }[], cols = 5): number {
  const taken = new Set<string>()
  const at = (r: number, c: number) => `${r}:${c}`
  const fits = (r: number, c: number, w: number, h: number) => {
    if (c + w > cols) return false
    for (let y = r; y < r + h; y++) {
      for (let x = c; x < c + w; x++) if (taken.has(at(y, x))) return false
    }
    return true
  }

  let rows = 0
  for (const item of items) {
    // A card wider than the board is placed at full width rather than refused;
    // the caller decides what to do about it, and pretending it fits would
    // under-count the rows.
    const w = Math.min(item.w, cols)
    const h = Math.max(1, item.h)
    let placed = false
    for (let r = 0; !placed && r < 200; r++) {
      for (let c = 0; c <= cols - w; c++) {
        if (!fits(r, c, w, h)) continue
        for (let y = r; y < r + h; y++) {
          for (let x = c; x < c + w; x++) taken.add(at(y, x))
        }
        rows = Math.max(rows, r + h)
        placed = true
        break
      }
    }
  }
  return rows
}

/** The board is a fixed five columns by three rows. Both are here rather than
    inferred, because the arranger and the stylesheet have to agree about them
    and a number that lives in one place cannot drift from the other. */
export const BOARD_COLS = 5
export const BOARD_ROWS = 3

/* THE SAME BOARD, AT PHONE PROPORTIONS: ONE COLUMN, THREE ROWS.

   Stated here beside BOARD_COLS/BOARD_ROWS and for the same reason: the packer
   below and the `max-width: 767px` block in bento-theme.css both have to
   believe the same two numbers, and a number that lives in one place cannot
   drift from the other. It had drifted anyway -- the comment that stood here
   argued for three rows and the constant underneath it said four.

   ONE COLUMN, not two. Two columns meant a card was either half the width of a
   phone or all of it, and the ones that were all of it kept their content in
   the left half, so a board read as a column of tiles with a column of empty
   space beside it. Nothing on a card here wants a neighbour: a figure, a name
   and a sentence are a single measure, and at 182px the sentence was the first
   thing to break. A phone is a column. This is the shape it was always going
   to be.

   THREE ROWS, which is what the old comment already asked for. Four gives
   tiles about 80px tall on a 390x844 device once the dock and the page dots
   are taken out, which is shorter than the text inside them. Three leaves a
   card tall enough to hold its own sentence.

   TWO COLUMNS AGAIN, BY REQUEST. The paragraph above chose one column, and
   the owner, having lived with it, asked for the two shapes a phone home
   screen actually has: a small tile and a wide one. So the page is two
   columns by three rows, a card is 1x1 or 2x1, and the sizes a card was
   drawn at are clamped to that by paginate(). The argument about a sentence
   breaking at half width still stands and is answered the other way round:
   a card that needs the width is set Wide, and Small is for the ones that
   are a figure and a name. */
export const PHONE_COLS = 2
export const PHONE_ROWS = 3

/** Where one widget ended up: which page, and where on it. */
export interface Spot {
  id: string
  /** The size it is DRAWN at, after clamping to the page. */
  w: number
  h: number
  /** Zero-based. Page 0 is the one you land on. */
  page: number
  /** Zero-based, from the top-left of that page. */
  row: number
  col: number
}

/* PAST THE CEILING, A PHONE ADDS A PAGE INSTEAD OF DROPPING A CARD.

   This is the one behavioural difference between the two boards, and it is the
   whole idea. The desktop board is a fixed fifteen slots and something has to
   give when a layout wants a sixteenth: what gives there is the widget, which
   is dropped to the add tray, because the board's promise is that everything
   on it is visible at once and a sixteenth slot would break that promise.

   A phone makes the same promise per PAGE and keeps it by paging, which is
   what a home screen is. So nothing is ever dropped here — a widget somebody
   placed exists, it is simply on page two — and the page count is not a
   setting, it is the remainder of the pack.

   Dense first-fit, scanning left to right and top to bottom, which is the same
   rule `rowsNeeded` simulates for the desktop board: a later 1x1 back-fills a
   gap an earlier 2x1 left behind rather than starting a hole that runs the
   height of the page. Written out rather than delegated to `rowsNeeded`
   because that function answers "how tall" and this one needs to know "where",
   and inferring positions from a row count is guessing at an answer the
   simulation already had.

   Both dimensions are clamped to the page rather than refused. A stored 5 —
   from a layout saved before the 2x2 ceiling existed, or from the `spotlight`
   preset — must still load, and a card that cannot be placed anywhere would
   make this loop non-terminating. Clamped, every item fits an empty page, so
   the worst case is one page per widget and the function always ends. */
export function paginate(
  items: { id: string; w: number; h: number }[],
  cols = PHONE_COLS,
  rows = PHONE_ROWS,
  /** The ids whose height was chosen by a person, not declared by the
      dashboard. Only those may take a second row — see below. */
  tallOk?: Set<string>,
): Spot[] {
  const out: Spot[] = []
  let page = 0
  let taken = new Set<string>()
  const at = (r: number, c: number) => `${r}:${c}`
  const free = (r: number, c: number, w: number, h: number) => {
    if (c + w > cols || r + h > rows) return false
    for (let y = r; y < r + h; y++) {
      for (let x = c; x < c + w; x++) if (taken.has(at(y, x))) return false
    }
    return true
  }
  const claim = (r: number, c: number, w: number, h: number) => {
    for (let y = r; y < r + h; y++) {
      for (let x = c; x < c + w; x++) taken.add(at(y, x))
    }
  }

  for (const item of items) {
    const w = Math.min(Math.max(1, item.w), cols)
    /* HEIGHT IS ALWAYS ONE ROW ON A PHONE.

       A widget that asks for two rows was given two, so a 2x2 card filled half
       a 844px screen on its own and a page held two cards. Screenshot at
       390x844: one card 470px tall with its figure, a five-word sentence and
       620px of nothing under it, and a second card below the fold.

       A card is not improved by being 470px tall. Its type scale is a fraction
       of its own height, so everything in it inflated at the same time — a
       26px title reading at 40 — and the drawing, sized to what is left, had
       more room than any drawing on this board is designed to use.

       Four rows of one, then: four cards a page at ~200px each, which is the
       height these cards are built for and roughly what an iPhone home screen
       gives a widget. The stored layout is untouched — this is how the phone
       READS it, and the desktop board still honours every two-row card. */
    /* TWO ROWS, WHEN ASKED FOR, AND NEVER MORE.

       The paragraph above was written against a 2x2 that nobody chose: the
       card's DECLARED size, read on a phone that draws one column. That is
       still refused — a phone reads a declared 'large' as one row. What it
       now honours is a height somebody picked on the phone itself: the edit
       sheet offers Small and Tall, and Tall means two of the page's three
       rows, which is where a list card gets to show its list. Capped at two
       so a card can never take a whole page and leave the pager with nothing
       to page. `tallOk` is how the caller says which heights were chosen here
       rather than declared elsewhere. */
    const h = tallOk?.has(item.id) ? Math.min(2, Math.max(1, item.h), rows) : 1
    let spot: { row: number; col: number } | null = null
    for (let r = 0; !spot && r <= rows - h; r++) {
      for (let c = 0; c <= cols - w; c++) {
        if (!free(r, c, w, h)) continue
        spot = { row: r, col: c }
        break
      }
    }
    if (!spot) {
      // Nothing left on this page. Turn it, and start the new one at its
      // top-left — which is always free, because w and h were clamped to a
      // page above.
      page += 1
      taken = new Set<string>()
      spot = { row: 0, col: 0 }
    }
    claim(spot.row, spot.col, w, h)
    out.push({ id: item.id, w, h, page, row: spot.row, col: spot.col })
  }
  return out
}

/** How many pages that pack came to. Zero widgets is zero pages, so a caller
    can ask this before deciding whether a pager is worth drawing at all. */
export function pageCount(spots: Spot[]): number {
  return spots.length === 0 ? 0 : spots[spots.length - 1].page + 1
}
