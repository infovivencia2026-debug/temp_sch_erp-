import { useSyncExternalStore } from 'react'

/* What this person has chosen to keep at the top of the launcher.

   Recents (lib/recents.ts) are what the launcher NOTICES; pins are what the
   person SAYS. The two are kept apart on purpose: a recents list is a trace
   that rewrites itself several times an hour, while a pin is a decision that
   should survive a week of not opening the thing. Mixing them — say, a pin
   that is just a recent that never expires — would mean a curated row that
   quietly reorders itself, which is the one thing a curated row must not do.

   Device-local, like recents, for the same reason: a front-office terminal
   shared by three people should not carry one person's favourites onto the
   next login, and the account row is not the place for a per-browser list.

   Keys only. The catalogue remains the authority on the name and on whether
   the account may still open the feature; the launcher filters this list
   through it, so a pin to a withdrawn feature simply stops appearing rather
   than 404ing on tap. Order is the order of pinning, oldest first, so a new
   pin lands at the end of the row rather than shoving the others along. */

export const PINS_KEY = 'erp.launcher.pins'

/** A row is a row: a curated list longer than one line of tiles has stopped
    being a shortcut and become a second catalogue. */
export const PINS_LIMIT = 16

/* The DOM-free core. Everything below the hook is a pure function of a list
   and a key, so the rules can be tested without a document and the hook is
   only a subscription around them. */

/** The list with `key` added at the end, or unchanged when already there or
    when the row is full. */
export function withPin(list: readonly string[], key: string): string[] {
  if (!key || list.includes(key) || list.length >= PINS_LIMIT) return [...list]
  return [...list, key]
}

/** The list without `key`. */
export function withoutPin(list: readonly string[], key: string): string[] {
  return list.filter((k) => k !== key)
}

/** Flip one key's membership. */
export function toggled(list: readonly string[], key: string): string[] {
  return list.includes(key) ? withoutPin(list, key) : withPin(list, key)
}

/** Only strings, only so many, and never the same one twice — whatever a
    hand-edited or older localStorage value holds. */
export function parsePins(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    const out: string[] = []
    for (const x of v) {
      if (typeof x === 'string' && x && !out.includes(x)) out.push(x)
      if (out.length >= PINS_LIMIT) break
    }
    return out
  } catch {
    return []
  }
}

function read(): string[] {
  try {
    return parsePins(localStorage.getItem(PINS_KEY))
  } catch {
    return []
  }
}

let current: string[] = typeof window === 'undefined' ? [] : read()
const listeners = new Set<() => void>()

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function snapshot(): string[] {
  return current
}

/** Stable identity, so useSyncExternalStore does not loop on the server. */
const EMPTY: string[] = []
function serverSnapshot(): string[] {
  return EMPTY
}

function publish(next: string[]) {
  current = next
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(current))
  } catch {
    /* private browsing: pins last the session, which still beats none */
  }
  for (const l of listeners) l()
}

/** Re-read storage. The store caches its list for the life of the page, so a
    test that clears localStorage between cases — or another tab that changed
    the list — needs a way to say so. */
export function reloadPins(): string[] {
  current = read()
  for (const l of listeners) l()
  return current
}

export function isPinned(key: string): boolean {
  return current.includes(key)
}

export function pin(key: string) {
  const next = withPin(current, key)
  if (next.length !== current.length) publish(next)
}

export function unpin(key: string) {
  const next = withoutPin(current, key)
  if (next.length !== current.length) publish(next)
}

/** Flip it, and say which way it went. */
export function togglePin(key: string): boolean {
  if (current.includes(key)) {
    unpin(key)
    return false
  }
  pin(key)
  return isPinned(key)
}

export function usePins(): string[] {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}
