import { useCallback, useSyncExternalStore } from 'react'

/* The skin: which frame the Bento surfaces wear.

   A skin is not a theme and the distinction is the whole reason this is its
   own preference. The theme decides whether the product is light or dark; the
   skin decides whether a card has a hairline and a whisper of shadow or a 2px
   black edge and a hard offset. They compose — brutalist has a dark mode, and
   it is not the same thing as premium dark — so folding one into the other
   would give four values with two meanings and no way to say "dark, and keep
   my frame".

   Deliberately NOT on user_display_preferences. That row is validated against
   a CHECK in the database and served by student_life.go, so adding a column
   means a migration, an API change and a generated-catalogue round trip for a
   visual experiment that may not survive the week. Device-local until it earns
   an account row, exactly as the launcher's recents are.

   Modelled on lib/theme.ts and lib/layout.tsx down to the shape, because a
   third preference that behaves differently from the first two is a third
   thing to learn for no reason. */

export type Skin = 'premium' | 'focus'

export const SKINS: readonly Skin[] = ['premium', 'focus'] as const

export const DEFAULT_SKIN: Skin = 'focus'

const KEY = 'erp.skin'

export function isSkin(v: unknown): v is Skin {
  return typeof v === 'string' && (SKINS as readonly string[]).includes(v)
}

function readStored(): Skin {
  try {
    const raw = localStorage.getItem(KEY)
    if (isSkin(raw)) return raw
  } catch {
    /* private browsing; the default is the honest answer */
  }
  return DEFAULT_SKIN
}

let current: Skin = typeof window === 'undefined' ? DEFAULT_SKIN : readStored()
const listeners = new Set<() => void>()

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function snapshot(): Skin {
  return current
}

function serverSnapshot(): Skin {
  return DEFAULT_SKIN
}

/** Stamp the attribute and re-render. The premium skin removes the attribute
    rather than setting it: the default should leave no trace in the DOM, so a
    stylesheet reading html[data-skin] is never asking about the ordinary case. */
export function applySkin(next: Skin) {
  const root = document.documentElement
  if (next === DEFAULT_SKIN) root.removeAttribute('data-skin')
  else root.setAttribute('data-skin', next)
  try {
    localStorage.setItem(KEY, next)
  } catch {
    /* the choice lasts the session, which is enough for a device preference */
  }
  if (current === next) return
  current = next
  for (const l of listeners) l()
}

export function currentSkin(): Skin {
  return current
}

export function useSkin(): { skin: Skin; setSkin: (next: Skin) => void } {
  const skin = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  const setSkin = useCallback((next: Skin) => {
    if (isSkin(next)) applySkin(next)
  }, [])
  return { skin, setSkin }
}

// Stamped before React's first paint, so a reload into the brutalist skin does
// not show a frame of hairline borders and then snap to black.
if (typeof document !== 'undefined') applySkin(current)
