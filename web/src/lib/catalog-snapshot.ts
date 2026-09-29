import type { CatalogResponse } from '@shared/api'

/* THE MENU THIS PERSON HAD LAST TIME, SHOWN WHILE THE REAL ONE IS ASKED FOR.

   The catalogue is the whole navigation, and nothing past the opening screen
   can draw until it arrives -- one more round trip after /session on every
   load. It was kept out of the offline cache so a just-granted feature is
   never hidden by an old copy, and that reason still holds, so this is not a
   cache in that sense: it is the pattern features/portal/use-children.ts uses.
   The last answer for THIS user at THIS school is painted at once, marked as
   already stale, so the query refetches immediately and the fresh menu
   replaces it a moment later. A grant made since shows up on that refetch,
   not days later.

   Read only after /session has named the user (CatalogProvider sits inside
   SessionProvider), and keyed by user and school, so one person's menu is
   never painted for another. Cleared on sign-out with the parent cache
   (lib/query-persist.ts forgetPersistedQueries), and a different person
   signing in removes every other person's copy on the first write. */

const PREFIX = 'erp.catalog.v1:'
const MAX_AGE_MS = 7 * 24 * 60 * 60_000

export function catalogSnapshotKey(userId: string | undefined, institutionId: string | undefined, allRoles: boolean): string {
  return userId ? `${PREFIX}${userId}:${institutionId ?? 'none'}:${allRoles ? 1 : 0}` : ''
}

export function readCatalogSnapshot(key: string): CatalogResponse | undefined {
  if (!key) return undefined
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return undefined
    const { at, data } = JSON.parse(raw) as { at: number; data: CatalogResponse }
    if (!at || Date.now() - at > MAX_AGE_MS) return undefined
    return data
  } catch {
    return undefined
  }
}

export function writeCatalogSnapshot(key: string, data: CatalogResponse) {
  if (!key) return
  try {
    const user = key.slice(PREFIX.length).split(':')[0]
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && k.startsWith(PREFIX) && k.slice(PREFIX.length).split(':')[0] !== user) localStorage.removeItem(k)
    }
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), data }))
  } catch {
    /* Quota or private mode: the next load simply waits for the network. */
  }
}

export function forgetCatalogSnapshots() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && k.startsWith(PREFIX)) localStorage.removeItem(k)
    }
  } catch {
    /* nothing was written */
  }
}
