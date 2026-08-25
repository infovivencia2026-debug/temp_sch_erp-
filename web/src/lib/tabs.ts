import { useCallback, useSyncExternalStore } from 'react'

/* Several screens open at once, the way a browser keeps several pages.

   WHY THIS EXISTS. The work in a school office is not one screen at a time. A
   clerk taking a fee has the student's profile open, the fee structure open and
   the day book open, and moves between them for one transaction. With a single
   pane every move is a fresh navigation: the list re-fetches, the scroll
   position is gone, and any half-typed filter with it.

   WHAT A TAB IS. A remembered path and the name it had when it was opened.
   Nothing more — no cached component, no frozen data. Switching tabs is a
   normal navigation, so a screen shows what is true now rather than what was
   true when it was last looked at. That is the right trade for an ERP: a stale
   fee balance in a background tab is worse than a re-fetch.

   DESKTOP ONLY, and that is a real decision rather than a layout convenience.
   A tab strip needs room for several legible labels; on a phone it becomes a
   row of truncated stubs that costs a line of vertical space and returns
   nothing. The store still runs — it is the strip that is hidden — so nothing
   depends on viewport width being read in JS.

   Session-scoped, not persisted. Tabs describe what somebody is doing right
   now. Restoring yesterday's eight tabs on a shared office machine tells the
   next person what the last one was working on.

   AND sessionStorage ALONE DOES NOT ACHIEVE THAT, which is what the paragraph
   above assumed. It is scoped to the browser TAB, not to the login: signing
   out and signing in as somebody else in the same tab keeps every key. Walking
   the roles found it immediately — after signing in as operations, the strip
   still carried the librarian's eight tabs, Fines and all.

   So the owner is stored beside them. A different user id empties the strip
   before it can be read, which works even though sign-out is a server redirect
   with no chance for JavaScript to tidy up on the way past. */

export interface Tab {
  /** The full in-app path, including any query string. */
  path: string
  /** What to show on the tab. Captured at open time. */
  title: string
}

/** Above this, the strip stops being readable and starts being a row of
    stubs. Opening beyond it drops the OLDEST tab that is not the active one —
    never the one being looked at. */
export const MAX_TABS = 8

const KEY = 'erp.tabs'
const OWNER = 'erp.tabs.owner'

function read(): Tab[] {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return []
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    return v
      .filter((t): t is Tab =>
        !!t && typeof (t as Tab).path === 'string' && typeof (t as Tab).title === 'string')
      .slice(0, MAX_TABS)
  } catch {
    return []
  }
}

let tabs: Tab[] = typeof window === 'undefined' ? [] : read()
const listeners = new Set<() => void>()

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function write(next: Tab[]) {
  tabs = next
  try {
    if (next.length === 0) sessionStorage.removeItem(KEY)
    else sessionStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* private browsing: the tabs last the page's life */
  }
  for (const l of listeners) l()
}

/** Whose tabs these are.

    Called once the session is known. A different user id — including the first
    id after a sign-out that left the previous person's strip behind — empties
    it. The same id is a no-op, so a reload does not lose anybody's tabs.

    Nothing is remembered about the previous owner beyond the comparison: the
    id replaces the old one and the tabs go. */
export function claimTabs(userID: string) {
  if (!userID) return
  let previous: string | null = null
  try {
    previous = sessionStorage.getItem(OWNER)
    sessionStorage.setItem(OWNER, userID)
  } catch {
    /* private browsing: the strip lasts the page's life and belongs to
       whoever is looking at it, which is the behaviour wanted anyway */
    return
  }
  if (previous !== null && previous !== userID) write([])
}

/** Open a path, or bring it forward if it is already open.

    Matching is on the whole path INCLUDING the query, because two students in
    Student 360 are two different screens and collapsing them into one tab is
    the opposite of what somebody opening both wants. */
export function openTab(path: string, title: string, activePath: string) {
  const at = tabs.findIndex((t) => t.path === path)
  if (at >= 0) {
    // Already open: refresh its title, which may have loaded since.
    if (tabs[at].title !== title) {
      const next = [...tabs]
      next[at] = { path, title }
      write(next)
    }
    return
  }
  const next = [...tabs, { path, title }]
  if (next.length > MAX_TABS) {
    /* Drop the oldest tab that is NOT the one being looked at. Dropping the
       active tab because it happened to be oldest would close the screen
       somebody is reading. */
    const victim = next.findIndex((t) => t.path !== activePath && t.path !== path)
    if (victim >= 0) next.splice(victim, 1)
    else next.shift()
  }
  write(next)
}

export function closeTab(path: string) {
  write(tabs.filter((t) => t.path !== path))
}

export function closeOthers(path: string) {
  write(tabs.filter((t) => t.path === path))
}

export function closeAll() {
  write([])
}

/** Where to go after closing the tab being looked at: its right-hand
    neighbour, else its left. Browsers do this, and it is what a hand expects
    when it closes the tab under the cursor. */
export function neighbourOf(path: string): string | null {
  const at = tabs.findIndex((t) => t.path === path)
  if (at < 0) return null
  return tabs[at + 1]?.path ?? tabs[at - 1]?.path ?? null
}

export function useTabs() {
  const value = useSyncExternalStore(subscribe, () => tabs, () => [])
  const open = useCallback(openTab, [])
  return { tabs: value, open, close: closeTab, closeOthers, closeAll }
}
