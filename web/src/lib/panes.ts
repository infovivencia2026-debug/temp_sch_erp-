import { useCallback, useSyncExternalStore } from 'react'

/* Several screens open SIDE BY SIDE, where tabs put them one behind another.

   WHY THIS EXISTS, given tabs already do. A tab is for work you return to; a
   pane is for work you read ACROSS. The clerk reconciling a fee against the
   day book is not switching between two screens, they are comparing them, and
   every switch makes them hold a number in their head that the screen could
   have been holding for them. Tabs made that cheaper than navigation. Panes
   make it free.

   WHAT A PANE IS. A path, rendered by the ordinary router at that path. Same
   substance as a tab — no cached tree, no frozen data — so a pane shows what
   is true now. The difference is only where it is drawn.

   WHICH PANE THE ADDRESS BAR MEANS. Exactly one: the focused one. Navigating
   — the sidebar, the palette, a tab, a link inside a screen — changes the
   focused pane and nothing else, so the browser's own back button keeps
   working the way it always did. Clicking into another pane focuses it and
   makes the URL say so.

   FOUR, and the fourth is already a squint. Beyond that a pane is narrower
   than the tables most of these screens carry, and a table that scrolls
   sideways is worse than a tab. */

export type Side = 'left' | 'right' | 'up' | 'down'

/** A home board cannot be a pane.

    In the Focus layout, Home is not a screen among screens — it is the board
    the whole window is measured against: its rows are sized from the viewport
    height, its cells shed their supporting text as they narrow, and the
    arranger refuses any layout needing a fourth row. Half a window is not a
    smaller version of that, it is the same board with every one of those
    decisions made against the wrong number. It is the home screen; a phone
    does not put its home screen in a split either.

    Matched on the path rather than on the catalogue, because a tab has only a
    path to offer at the moment somebody right-clicks it. Every role's board is
    catalogued at `home/dashboard`. */
export function isHomeBoard(path: string): boolean {
  const [, , sectionSlug, featureSlug] = path.split('?')[0].split('/')
  return sectionSlug === 'home' && (!featureSlug || featureSlug === 'dashboard')
}

/** The work area splits into at most this many. See above for why four. */
export const MAX_PANES = 4

export interface Panes {
  /** Visual order, left-to-right then top-to-bottom. */
  paths: string[]
  /** Index into `paths`: the pane the address bar is describing. */
  focus: number
  /** How a two-pane split is arranged. Ignored at three or four, which are
      always a 2×2 grid — three panes in a row are each too narrow to use. */
  dir: 'row' | 'col'
}

const KEY = 'erp.panes'
const EMPTY: Panes = { paths: [], focus: 0, dir: 'row' }

function read(): Panes {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return EMPTY
    const v = JSON.parse(raw) as Panes
    if (!v || !Array.isArray(v.paths)) return EMPTY
    const paths = v.paths.filter((p) => typeof p === 'string').slice(0, MAX_PANES)
    if (paths.length < 2) return EMPTY
    return {
      paths,
      focus: Math.min(Math.max(v.focus | 0, 0), paths.length - 1),
      dir: v.dir === 'col' ? 'col' : 'row',
    }
  } catch {
    return EMPTY
  }
}

let state: Panes = typeof window === 'undefined' ? EMPTY : read()
const listeners = new Set<() => void>()

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function write(next: Panes) {
  state = next
  try {
    if (next.paths.length < 2) sessionStorage.removeItem(KEY)
    else sessionStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* private browsing: the split lasts the page's life */
  }
  for (const l of listeners) l()
}

/** True once the work area is actually divided. One pane is not a split, it
    is the ordinary screen, and it must render with no pane chrome at all. */
export function isSplit() {
  return state.paths.length > 1
}

/** Put `path` beside the focused pane.

    `from` is the path that was already on screen — the first split has to
    seed BOTH panes, since until now there were none to seed from. Returns
    false when the work area is full, so the caller can say so rather than
    silently doing nothing. */
export function splitTo(side: Side, path: string, from: string): boolean {
  // Refused here as well as hidden in the menu: the menu is one caller, and a
  // rule worth stating is worth holding at the store.
  if (isHomeBoard(path)) return false
  const base = state.paths.length > 1 ? state.paths : [from]
  if (base.length >= MAX_PANES) return false
  const at = state.paths.length > 1 ? state.focus : 0
  const before = side === 'left' || side === 'up'
  const index = before ? at : at + 1
  const paths = [...base]
  paths.splice(index, 0, path)
  write({
    paths,
    focus: index,
    // The direction is set by the first split and kept: flipping the axis
    // under somebody because their second split went the other way moves
    // every pane they had already placed.
    dir: base.length === 1 ? (side === 'up' || side === 'down' ? 'col' : 'row') : state.dir,
  })
  return true
}

/** Close one pane. Dropping to a single pane collapses the split entirely —
    a lone pane with a close button on it is just a screen wearing chrome. */
export function closePane(index: number) {
  const paths = state.paths.filter((_, i) => i !== index)
  if (paths.length < 2) {
    write(EMPTY)
    return
  }
  write({ ...state, paths, focus: Math.min(state.focus, paths.length - 1) })
}

export function closeSplit() {
  write(EMPTY)
}

export function focusPane(index: number) {
  if (index === state.focus || index >= state.paths.length) return
  write({ ...state, focus: index })
}

/** Point the focused pane at a path. This is how ordinary navigation reaches
    the split: the router moved, so the pane the router speaks for moved. */
export function setFocusedPath(path: string) {
  if (state.paths.length < 2) return
  /* Going Home leaves the arrangement, the way a phone's home button does.
     The alternative — drawing the board into whichever quarter happened to be
     focused — is the thing this refuses to do anywhere else, and refusing it
     at the split menu while allowing it through the sidebar would just be the
     same board in the same wrong place by a longer route. */
  if (isHomeBoard(path)) {
    write(EMPTY)
    return
  }
  if (state.paths[state.focus] === path) return
  const paths = [...state.paths]
  paths[state.focus] = path
  write({ ...state, paths })
}

export function usePanes() {
  const value = useSyncExternalStore(subscribe, () => state, () => EMPTY)
  return {
    ...value,
    split: useCallback(splitTo, []),
    close: useCallback(closePane, []),
    closeSplit: useCallback(closeSplit, []),
    focusPane: useCallback(focusPane, []),
  }
}
