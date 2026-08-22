import { useCallback, useSyncExternalStore } from 'react'

/* The dashboard as something a person arranges.

   Four sizes, chosen to match the grid rather than to sound generous. The
   board is four columns, so the only widths that tile without leaving holes
   are 1, 2 and 4 — a 3-wide cell strands a column on every row it appears in.
   Height is 1 or 2 for the same reason: taller than two rows and a card cannot
   share a row with anything, which is a layout decision disguised as a size.

     small   1x1   a figure and its label
     medium  2x1   a figure with a meter or a note beside it
     large   2x2   the hero: a big number, a chart and two actions
     full    4x1   a strip across the board, for a chart that needs the width

   Stored per dashboard and per device. Not on the account row: a layout is
   bound to the screen somebody arranged it on, and a principal who tidies
   their laptop dashboard should not find their desk monitor rearranged to
   match a narrower board. */

export type WidgetSize = 'small' | 'medium' | 'large' | 'full'

export const SIZES: readonly WidgetSize[] = ['small', 'medium', 'large', 'full'] as const

/** What a placed widget carries. Order is the array position. */
export interface Placed {
  id: string
  size: WidgetSize
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
      placed: Array.isArray(v.placed)
        ? v.placed.filter((p): p is Placed =>
            !!p && typeof p.id === 'string' && (SIZES as readonly string[]).includes(p.size))
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
    (id: string, size: WidgetSize) => {
      const l = current(dashboard)
      write(dashboard, {
        placed: l.placed.some((p) => p.id === id) ? l.placed : [...l.placed, { id, size }],
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
    (id: string, size: WidgetSize, fallback: WidgetSize) => {
      const l = current(dashboard)
      const has = l.placed.some((p) => p.id === id)
      write(dashboard, {
        // A widget resized before it was ever explicitly placed is placed now.
        // Otherwise the first drag on a default card would do nothing.
        placed: has
          ? l.placed.map((p) => (p.id === id ? { ...p, size } : p))
          : [...l.placed, { id, size: size ?? fallback }],
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
        (x) => l.placed.find((p) => p.id === x.id) ?? { id: x.id, size: x.size },
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

  const reset = useCallback(() => write(dashboard, EMPTY), [dashboard])

  return { layout, place, remove, resize, move, reset }
}

/** The size a widget should render at: what the person chose, else its own
    default. */
export function sizeOf(layout: Layout, id: string, fallback: WidgetSize): WidgetSize {
  return layout.placed.find((p) => p.id === id)?.size ?? fallback
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
