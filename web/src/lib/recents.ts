import { useSyncExternalStore } from 'react'

/* What this person actually opens.

   A launcher listing sixty-five features in workspace order is a filing
   cabinet: correct, complete, and no faster to use on the hundredth visit
   than the first. Almost nobody uses sixty-five. A principal opens the same
   four or five screens every morning, and the whole value of a library over a
   menu is that it can notice.

   Device-local, deliberately. This is not a preference and it does not belong
   on user_display_preferences: it is a usage trace, it changes several times
   an hour, and PUTting the account row on every navigation to store "opened
   the fee dashboard" would be a write per click for something nobody would
   miss on a new machine. It also means one person's habits never follow them
   onto a shared front-office terminal, which is the right default for a trace
   of what somebody looked at.

   Keys only. The catalogue is already client-side and is the authority on what
   a feature is called and whether this account may still open it, so storing a
   name here would be a second copy that goes stale the moment a label changes
   or a permission is withdrawn. */

const KEY = 'erp.recents'

/** Kept short on purpose. A "recent" list long enough to need scanning is just
    the full list again with a worse order. */
const LIMIT = 8

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, LIMIT) : []
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

/** Move a feature to the front. Idempotent: opening the same screen twice in a
    row leaves the list, and the array identity, unchanged — otherwise every
    re-render of a route would publish a new snapshot and re-render every
    subscriber for nothing. */
export function recordRecent(key: string) {
  if (!key) return
  if (current[0] === key) return
  current = [key, ...current.filter((k) => k !== key)].slice(0, LIMIT)
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* private browsing: the list is simply per-session, which is still better
       than no list */
  }
  for (const l of listeners) l()
}

export function useRecents(): string[] {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}
