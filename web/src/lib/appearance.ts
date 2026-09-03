import { useCallback, useSyncExternalStore } from 'react'
import { typefaceById, ensureFont } from './typefaces'

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

/* FIVE STEPS, NOT THREE.

   The board's gutter unit went from 6px to 1px when the cells were made to butt
   together, and three named steps over that unit is too coarse to be a
   preference: 'compact' and 'comfortable' were a two-pixel difference nobody
   could see, and there was no step at all for the hairline sheet the board now
   defaults to. Five gives a person the two ends they actually want — a ruled
   sheet, and cards with real air between them — plus somewhere to stand in
   between. */
export type Density = 'hairline' | 'compact' | 'comfortable' | 'relaxed' | 'spacious'
export type Corners = 'sharp' | 'default' | 'round'
export type TextSize = 'small' | 'default' | 'large' | 'larger'
/** A typeface id from lib/typefaces. A string rather than a union because
    the list is data — adding a face should not be a type change. */
export type Typeface = string
export type Borders = 'none' | 'hairline' | 'strong'
export type Shadow = 'flat' | 'default' | 'lifted' | 'deep'
export type Pattern = 'none' | 'dots' | 'grid' | 'lines' | 'noise'
export type Contrast = 'normal' | 'medium' | 'high'
export type DockSize = 'compact' | 'default' | 'large'
export type IconSize = 'small' | 'default' | 'large'

/* HOW A TIME OF DAY IS WRITTEN.

   Every time in this product was rendered as the raw HH:MM the API sends, so a
   period beginning at half past two read "14:30". That is correct, unambiguous
   and not how anybody in an Indian school says it: a bell is at 2:30 pm, a
   parent is told to come at 11 am, and a teacher reading "14:30" translates
   before understanding it.

   Twelve-hour is the default for that reason, and it is a preference rather
   than a rule because a school that keeps its timetable in 24-hour notation
   should not have to re-learn its own day. */
export type Clock = '12h' | '24h'

export const DENSITIES: readonly Density[] = ['hairline', 'compact', 'comfortable', 'relaxed', 'spacious'] as const
export const CORNERS: readonly Corners[] = ['sharp', 'default', 'round'] as const
export const TEXT_SIZES: readonly TextSize[] = ['small', 'default', 'large', 'larger'] as const

export const BORDERS: readonly Borders[] = ['none', 'hairline', 'strong'] as const
export const SHADOWS: readonly Shadow[] = ['flat', 'default', 'lifted', 'deep'] as const
export const PATTERNS: readonly Pattern[] = ['none', 'dots', 'grid', 'lines', 'noise'] as const
export const CONTRASTS: readonly Contrast[] = ['normal', 'medium', 'high'] as const
export const DOCK_SIZES: readonly DockSize[] = ['compact', 'default', 'large'] as const
export const ICON_SIZES: readonly IconSize[] = ['small', 'default', 'large'] as const
export const CLOCKS: readonly Clock[] = ['12h', '24h'] as const

/* The continuous axes.

   Text size, density, corners, borders and depth used to be four or five named
   steps each. Named steps are honest for a thing with a small set of real
   states — a pattern is dots or it is not — and dishonest for a thing that is
   simply a number: "Larger" is a decision somebody else made about how large
   larger ought to be.

   These five are numbers now, and the named steps stay only as the fallback a
   stylesheet uses when no number has been chosen. Each is a MULTIPLIER on the
   shipped value, so 1 is the product as designed and there is always a way
   back to it.

   The ranges are wide enough to be useful and bounded only where a value stops
   meaning anything: a text scale of 0 is an invisible interface, and a corner
   radius beyond about 3 turns every card into a lozenge. Within those, nothing
   is capped to a step. */
export interface Scales {
  text: number
  /* The board's own type size. It followed --font-scale, so a person who
     wanted larger tables in the app got larger tiles with them and could not
     have one without the other. Two controls, two preferences. */
  boardText: number
  density: number
  corners: number
  borders: number
  shadow: number
}

export const SCALE_RANGE: Record<keyof Scales, { min: number; max: number; step: number }> = {
  /* Only text keeps a floor. At 0 the interface is not dense, it is invisible,
     and there would be no way to read the control that undoes it. Every other
     axis bottoms out at 0 because 0 is a look: no gap, no radius, no border,
     no shadow. */
  /* The base type doubled, so what used to read at 100% now sits at the MIDDLE
     of this axis rather than the bottom of it — and the top of the axis is
     genuinely large rather than merely legible. */
  text: { min: 0.5, max: 2.0, step: 0.01 },
  boardText: { min: 0.5, max: 2.0, step: 0.01 },
  /* 0 to 20, not 0 to 3.

     This slider multiplies --bento-density, and that variable's unit changed
     from 6px to 1px when the board became a sheet. Nobody moved the range with
     it, so a slider at maximum gave a 3px gutter while the named 'spacious'
     step gave 20 — the continuous control could not reach two thirds of the
     axis it was meant to control, and dragging it to the end looked broken.
     Twenty pixels is the airiest this board should ever be; the range now ends
     where the last named step does. */
  density: { min: 0, max: 20, step: 0.5 },
  corners: { min: 0, max: 3.5, step: 0.01 },
  borders: { min: 0, max: 5, step: 0.01 },
  shadow: { min: 0, max: 4, step: 0.01 },
}

export const SCALE_DEFAULTS: Scales = {
  text: 1, boardText: 1, density: 1, corners: 1, borders: 1, shadow: 1,
}

export interface Appearance {
  density: Density
  corners: Corners
  text: TextSize
  typeface: Typeface
  borders: Borders
  shadow: Shadow
  pattern: Pattern
  contrast: Contrast
  dockSize: DockSize
  iconSize: IconSize
  /** Comma-separated list of workspace names hidden from the dock */
  hiddenDockItems: string
  clock: Clock
  scales: Scales
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
  dockSize: 'default',
  iconSize: 'default',
  clock: '12h',
  scales: SCALE_DEFAULTS,
  hiddenDockItems: '',
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
  dockSize: 'erp.dockSize',
  iconSize: 'erp.iconSize',
  hiddenDockItems: 'erp.hiddenDockItems',
  clock: 'erp.clock',
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

function readScales(): Scales {
  const out = { ...SCALE_DEFAULTS }
  for (const k of Object.keys(SCALE_DEFAULTS) as (keyof Scales)[]) {
    const raw = readRaw(`erp.scale.${k}`)
    const n = raw === null ? NaN : Number(raw)
    const r = SCALE_RANGE[k]
    // Out of range is clamped rather than discarded: a value saved before a
    // range was narrowed is still a preference, just a more extreme one.
    if (Number.isFinite(n)) out[k] = Math.min(r.max, Math.max(r.min, n))
  }
  return out
}

function read(): Appearance {
  return {
    density: one(KEYS.density, DENSITIES, DEFAULTS.density),
    corners: one(KEYS.corners, CORNERS, DEFAULTS.corners),
    text: one(KEYS.text, TEXT_SIZES, DEFAULTS.text),
    /* Resolved through typefaceById rather than tested against the list.

       A face that is retired keeps its id in localStorage on every device that
       chose it. Testing membership sent those people to the default — a
       different typeface from the one they picked, with nothing said about it —
       and skipped the mapping that says where a retired face should land. */
    typeface: typefaceById(readRaw(KEYS.typeface) ?? DEFAULTS.typeface).id as Typeface,
    borders: one(KEYS.borders, BORDERS, DEFAULTS.borders),
    shadow: one(KEYS.shadow, SHADOWS, DEFAULTS.shadow),
    pattern: one(KEYS.pattern, PATTERNS, DEFAULTS.pattern),
    contrast: one(KEYS.contrast, CONTRASTS, DEFAULTS.contrast),
    dockSize: one(KEYS.dockSize, DOCK_SIZES, DEFAULTS.dockSize),
    iconSize: one(KEYS.iconSize, ICON_SIZES, DEFAULTS.iconSize),
    clock: one(KEYS.clock, CLOCKS, DEFAULTS.clock),
    hiddenDockItems: readRaw(KEYS.hiddenDockItems) ?? '',
    scales: readScales(),
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
  /* Stamped even though no stylesheet reads it: formatTime in lib/utils.ts
     does. A plain formatting function cannot call a hook, and reading the
     attribute is how it sees a preference that lives in this module -- the
     same route data-density takes to reach the CSS. Default removed like every
     other axis, so the absence of the attribute means twelve-hour. */
  stamp('data-clock', next.clock, '12h')
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

  /* The continuous scales, set inline on the root.

     Inline custom properties beat the html[data-*] rules that set the same
     variables, so the named steps survive untouched as the fallback for
     anybody who has never moved a slider — and moving one wins immediately
     without either mechanism having to know about the other. */
  const scaleVar = (prop: string, n: number) => {
    /* Removed at 1 rather than written as "1", and that is the whole trick.

       An inline custom property beats every stylesheet rule that sets the same
       variable — including the html[data-text] blocks the named steps rely on.
       Writing --font-scale:1 unconditionally would therefore not be a no-op:
       it would permanently override "Large" and "Larger" with 1 and silently
       kill the named axis. Absent means "nobody has moved this slider", which
       is exactly when the named step should be allowed to speak. */
    if (n === 1) root.style.removeProperty(prop)
    else root.style.setProperty(prop, String(n))
  }
  scaleVar('--font-scale', next.scales.text)
  scaleVar('--board-text', next.scales.boardText)
  scaleVar('--bento-density', next.scales.density)
  scaleVar('--radius-scale', next.scales.corners)
  scaleVar('--border-scale', next.scales.borders)
  scaleVar('--shadow-scale', next.scales.shadow)

  /* Dock sizing — CSS variables read directly by BentoDock. */
  const dockPad = { compact: '6px', default: '8px', large: '12px' }[next.dockSize]
  const dockBtn = { compact: '32px', default: '40px', large: '48px' }[next.dockSize]
  const iconPx  = { small: '14px', default: '17px', large: '22px' }[next.iconSize]
  root.style.setProperty('--dock-pad', dockPad)
  root.style.setProperty('--dock-btn', dockBtn)
  root.style.setProperty('--dock-icon', iconPx)
  root.style.setProperty('--dock-hidden', JSON.stringify(next.hiddenDockItems))

  try {
    // Density keeps its JSON spelling: index.html parses it before any of this
    // runs, and changing the format here would blank it for one paint.
    localStorage.setItem(KEYS.density, JSON.stringify(next.density))
    for (const k of ['corners', 'text', 'typeface', 'borders', 'shadow', 'pattern',
                     'contrast', 'dockSize', 'iconSize', 'hiddenDockItems',
                     'clock'] as const) {
      localStorage.setItem(KEYS[k], next[k])
    }
    /* The continuous scales, under the same keys readScales() looks for.
       They were stamped on the root and never written, so every slider moved
       on this screen was lost on the next reload while the named axes beside
       them survived — the one difference between the two being this loop. */
    for (const k of Object.keys(SCALE_DEFAULTS) as (keyof Scales)[]) {
      localStorage.setItem(`erp.scale.${k}`, String(next.scales[k]))
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
  /* One axis of the continuous scales, clamped to its range.

     Separate from `set` because the scales are a nested object: setting one
     through `set` would mean every caller reconstructing the other four, and
     the first one to forget would silently reset them. */
  const setScale = useCallback((axis: keyof Scales, n: number) => {
    const r = SCALE_RANGE[axis]
    const clamped = Math.min(r.max, Math.max(r.min, n))
    applyAppearance({ ...current, scales: { ...current.scales, [axis]: clamped } })
  }, [])

  return { appearance: value, set, setScale }
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
