import { useSyncExternalStore } from 'react'

/* The features somebody has put on their own dashboard.
 *
 * A third list beside recents and pins, and deliberately not either of them.
 * Recents (lib/recents.ts) are what the launcher NOTICES. Pins (lib/pins.ts)
 * are what somebody says should sit at the top OF THE LAUNCHER. This is what
 * they want on the page they land on, which is a different question: a
 * registrar pins Admissions because that is where they work all day, and puts
 * Fee Collection on the dashboard because they want to see it on the way past
 * without opening the launcher at all.
 *
 * Device-local, for the reason pins are: a front-office terminal shared by
 * three people must not carry one person's dashboard onto the next login, and
 * the account row is not the place for a per-browser list.
 *
 * Keys only. The catalogue stays the authority on the name and on whether this
 * account may still open the feature, so a shortcut to something withdrawn
 * stops appearing rather than 404ing on tap. Order is the order they were
 * added, oldest first, so a new one lands at the end rather than shoving the
 * others along.
 */

export const SHORTCUTS_KEY = 'erp.dashboard.shortcuts'

/** Past a dozen this has stopped being a dashboard and become the launcher
    again, which the reader already has one of. */
export const SHORTCUTS_LIMIT = 12

/* The DOM-free core, so the rules can be tested without a document and the
   hook below is only a subscription around them. */

export function withShortcut(list: readonly string[], key: string): string[] {
  if (!key || list.includes(key)) return [...list]
  return [...list, key].slice(-SHORTCUTS_LIMIT)
}

export function withoutShortcut(list: readonly string[], key: string): string[] {
  return list.filter((k) => k !== key)
}

export function toggledShortcut(list: readonly string[], key: string): string[] {
  return list.includes(key) ? withoutShortcut(list, key) : withShortcut(list, key)
}

/** Anything that is not an array of non-empty strings is treated as no list at
    all: a half-written value in storage must not take the dashboard down. */
export function parseShortcuts(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: string[] = []
    for (const v of parsed) {
      if (typeof v === 'string' && v && !out.includes(v)) out.push(v)
    }
    return out.slice(0, SHORTCUTS_LIMIT)
  } catch {
    return []
  }
}

let cache: string[] | null = null
const listeners = new Set<() => void>()

function read(): string[] {
  if (cache) return cache
  try {
    cache = parseShortcuts(localStorage.getItem(SHORTCUTS_KEY))
  } catch {
    /* Private browsing throws on access rather than returning nothing. A
       dashboard with no shortcuts is a working dashboard. */
    cache = []
  }
  return cache
}

function write(next: string[]) {
  cache = next
  try {
    localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(next))
  } catch {
    /* Kept in memory for the session, which still beats losing the gesture. */
  }
  listeners.forEach((fn) => fn())
}

export function reloadShortcuts(): string[] {
  cache = null
  const next = read()
  listeners.forEach((fn) => fn())
  return next
}

export function isOnDashboard(key: string): boolean {
  return read().includes(key)
}

export function addToDashboard(key: string) {
  write(withShortcut(read(), key))
}

export function removeFromDashboard(key: string) {
  write(withoutShortcut(read(), key))
}

/** Returns the state AFTER the toggle, so a caller can announce what it did. */
export function toggleDashboard(key: string): boolean {
  const next = toggledShortcut(read(), key)
  write(next)
  return next.includes(key)
}

export function useShortcuts(): string[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    read,
    () => [],
  )
}
