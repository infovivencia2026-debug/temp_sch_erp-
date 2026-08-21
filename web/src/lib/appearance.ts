import { useCallback, useSyncExternalStore } from 'react'
import { TYPEFACES as FACES, typefaceById, ensureFont } from './typefaces'

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
export type TextSize = 'small' | 'default' | 'large' | 'larger'
/** A typeface id from lib/typefaces. A string rather than a union because
    the list is data — adding a face should not be a type change. */
export type Typeface = string
export type Borders = 'none' | 'hairline' | 'strong'
export type Shadow = 'flat' | 'default' | 'lifted' | 'deep'
export type Pattern = 'none' | 'dots' | 'grid' | 'lines' | 'noise'
export type Contrast = 'normal' | 'medium' | 'high'

export const DENSITIES: readonly Density[] = ['compact', 'comfortable', 'relaxed'] as const
export const CORNERS: readonly Corners[] = ['sharp', 'default', 'round'] as const
export const TEXT_SIZES: readonly TextSize[] = ['small', 'default', 'large', 'larger'] as const

export const BORDERS: readonly Borders[] = ['none', 'hairline', 'strong'] as const
export const SHADOWS: readonly Shadow[] = ['flat', 'default', 'lifted', 'deep'] as const
export const PATTERNS: readonly Pattern[] = ['none', 'dots', 'grid', 'lines', 'noise'] as const
export const CONTRASTS: readonly Contrast[] = ['normal', 'medium', 'high'] as const

export interface Appearance {
  density: Density
  corners: Corners
  text: TextSize
  typeface: Typeface
  borders: Borders
  shadow: Shadow
  pattern: Pattern
  contrast: Contrast
}

const DEFAULTS: Appearance = {
  density: 'comfortable',
  corners: 'default',
  text: 'default',
  typeface: 'inter',
  borders: 'hairline',
  shadow: 'default',
  pattern: 'none',
  contrast: 'normal',
}

const KEYS = {
  density: 'erp.density',
  corners: 'erp.corners',
  text: 'erp.text',
  typeface: 'erp.typeface',
  borders: 'erp.borders',
  shadow: 'erp.shadow',
  pattern: 'erp.pattern',
  contrast: 'erp.contrast',
} as const

function readRaw(key: string): string | undefined {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return undefined
    return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw
  } catch {
    return undefined
  }
}

function typefaceIds(): string[] {
  return FACES.map((f) => f.id)
}

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
    typeface: typefaceIds().includes(readRaw(KEYS.typeface) ?? '')
      ? (readRaw(KEYS.typeface) as Typeface)
      : DEFAULTS.typeface,
    borders: one(KEYS.borders, BORDERS, DEFAULTS.borders),
    shadow: one(KEYS.shadow, SHADOWS, DEFAULTS.shadow),
    pattern: one(KEYS.pattern, PATTERNS, DEFAULTS.pattern),
    contrast: one(KEYS.contrast, CONTRASTS, DEFAULTS.contrast),
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

  /* Every axis stamps its attribute, and every default removes it. A
     stylesheet asking html[data-shadow] should never be asking about the
     ordinary case: it keeps the DOM honest about what has actually been
     changed, and it keeps the selectors from having to name a default. */
  const stamp = (attr: string, value: string, dflt: string) => {
    if (value === dflt) root.removeAttribute(attr)
    else root.setAttribute(attr, value)
  }
  stamp('data-corners', next.corners, 'default')
  stamp('data-text', next.text, 'default')
  /* The face is applied as a stack rather than an attribute, because the list
     lives in data and a stylesheet cannot carry a rule per family. ensureFont
     is called on every apply, including the one at load, so a choice restored
     from storage fetches its file before the first paint that needs it. */
  ensureFont(next.typeface)
  root.style.setProperty('--font-ui', typefaceById(next.typeface).stack)
  stamp('data-borders', next.borders, 'hairline')
  stamp('data-shadow', next.shadow, 'default')
  stamp('data-pattern', next.pattern, 'none')
  stamp('data-contrast', next.contrast, 'normal')

  try {
    // Density keeps its JSON spelling: index.html parses it before any of this
    // runs, and changing the format here would blank it for one paint.
    localStorage.setItem(KEYS.density, JSON.stringify(next.density))
    for (const k of ['corners', 'text', 'typeface', 'borders', 'shadow', 'pattern',
                     'contrast'] as const) {
      localStorage.setItem(KEYS[k], next[k])
    }
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


/** Back to the shipped design, in one call. Nine axes is enough that somebody
    will end up somewhere they cannot retrace, and a settings panel with no way
    out of itself is a trap. */
export function resetAppearance() {
  applyAppearance(DEFAULTS)
}

export const APPEARANCE_DEFAULTS = DEFAULTS
