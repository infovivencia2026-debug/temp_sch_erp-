import { useCallback, useSyncExternalStore } from 'react'

/* The look preferences that are not the palette.

   Density, corner radius and text size: three axes the reference interfaces
   expose and this product had one of, half-wired. They live together because
   they are one decision — "make this comfortable for me" — and because a
   person who wants larger text usually wants looser rows with it.

   Each is a root attribute read by index.css rather than a class threaded
   through components, so a preference costs one stamp and no re-render of the
   tree. That is also what lets index.html apply them before React exists.

   Device-local, like the skin. Density already has an account column and an
   API that has accepted it since long before this file; the appearance screen
   still owns that. What this store adds is the two that have no column yet,
   and it deliberately does not invent one — a migration for a radius
   multiplier is a migration to regret. */

export type Density = 'compact' | 'comfortable' | 'relaxed'
export type Corners = 'sharp' | 'default' | 'round'
export type TextSize = 'default' | 'large' | 'larger'

export const DENSITIES: readonly Density[] = ['compact', 'comfortable', 'relaxed'] as const
export const CORNERS: readonly Corners[] = ['sharp', 'default', 'round'] as const
export const TEXT_SIZES: readonly TextSize[] = ['default', 'large', 'larger'] as const

export interface Appearance {
  density: Density
  corners: Corners
  text: TextSize
}

const DEFAULTS: Appearance = { density: 'comfortable', corners: 'default', text: 'default' }

const KEYS = {
  density: 'erp.density',
  corners: 'erp.corners',
  text: 'erp.text',
} as const

function one<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    // density is stored as JSON by the appearance screen and index.html; the
    // two new ones are plain. Accept both rather than migrating a value people
    // already have on disk.
    const v = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw
    return (allowed as readonly string[]).includes(v) ? (v as T) : fallback
  } catch {
    return fallback
  }
}

function read(): Appearance {
  return {
    density: one(KEYS.density, DENSITIES, DEFAULTS.density),
    corners: one(KEYS.corners, CORNERS, DEFAULTS.corners),
    text: one(KEYS.text, TEXT_SIZES, DEFAULTS.text),
  }
}

let current: Appearance = typeof window === 'undefined' ? DEFAULTS : read()
const listeners = new Set<() => void>()

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function snapshot(): Appearance {
  return current
}

function serverSnapshot(): Appearance {
  return DEFAULTS
}

/** Stamp the root. The default value removes its attribute rather than setting
    it, so the ordinary case leaves no trace in the DOM and a stylesheet asking
    html[data-corners] is never asking about it. */
export function applyAppearance(next: Appearance) {
  const root = document.documentElement
  root.dataset.density = next.density
  if (next.corners === 'default') root.removeAttribute('data-corners')
  else root.setAttribute('data-corners', next.corners)
  if (next.text === 'default') root.removeAttribute('data-text')
  else root.setAttribute('data-text', next.text)

  try {
    // Density keeps its JSON spelling: index.html parses it before any of this
    // runs, and changing the format here would blank it for one paint.
    localStorage.setItem(KEYS.density, JSON.stringify(next.density))
    localStorage.setItem(KEYS.corners, next.corners)
    localStorage.setItem(KEYS.text, next.text)
  } catch {
    /* private browsing: the choice lasts the session */
  }
  current = next
  for (const l of listeners) l()
}

export function useAppearance() {
  const value = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  const set = useCallback(<K extends keyof Appearance>(key: K, v: Appearance[K]) => {
    applyAppearance({ ...current, [key]: v })
  }, [])
  return { appearance: value, set }
}

/** Reconcile from the account row, which today carries density only. */
export function reconcileAppearance(density: unknown) {
  if (typeof density === 'string' && (DENSITIES as readonly string[]).includes(density)) {
    applyAppearance({ ...current, density: density as Density })
  }
}

if (typeof document !== 'undefined') applyAppearance(current)
