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

export function cssHsl({ h, s, l }: Hsl): string {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`
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

function write(dashboard: string, next: Layout) {
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

  return { layout, place, remove, resize, recolour, move, reset }
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
