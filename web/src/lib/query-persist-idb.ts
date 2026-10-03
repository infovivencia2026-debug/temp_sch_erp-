/* THE WHOLE QUERY CACHE, KEPT IN INDEXEDDB, PER USER AND PER SCHOOL.
 *
 * This is the general half of persistence: every signed-in person, every
 * role, in the Electron desktop wrapper and in a mobile browser, gets the
 * screens they last saw painted from IndexedDB the instant the app boots,
 * with react-query revalidating in the background (stale-while-revalidate).
 * It sits under @tanstack/react-query-persist-client's
 * PersistQueryClientProvider; the wiring is in App.tsx.
 *
 * SCOPED BY USER *AND* INSTITUTION -- THE SECURITY INVARIANT.
 *
 * The IndexedDB key, and the persist `buster`, both include the signed-in
 * user id and their institution id:
 *
 *     rq-cache:v1:<userId>:<institutionId>
 *
 * A different account signing in on the same shared device -- a staffroom
 * laptop, a shared Windows tablet at the front desk -- derives a different
 * key and therefore reads a completely separate store. Account B can never
 * be handed account A's cached rows, not for a single frame, because it
 * never looks at account A's key. Switching accounts remounts the provider
 * (App.tsx keys it on `userId:institutionId`), so the old namespace is
 * dropped and the new one restored cleanly.
 *
 * The store is KEPT across logout on purpose (the product wants a returning
 * user's screens instant), not wiped -- namespacing is what keeps that safe,
 * not deletion.
 *
 * OLD-BROWSER / PRIVATE-MODE SAFETY.
 *
 * IndexedDB can be absent or throw outright (private mode, disabled storage,
 * an old Android WebView under storage pressure). Every access is wrapped in
 * try/catch and `indexedDbAvailable()` is checked before the provider is even
 * mounted; when it is unavailable the app falls back to a plain in-memory
 * QueryClientProvider and simply runs without persistence. A storage failure
 * never crashes the app and never surfaces a raw error.
 */

import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import { localStore } from './local-store'

/** Seven days: a returning user's screens survive a relaunch, a weekend, or
 *  a sign-out and back in, while anything genuinely old is refetched the
 *  moment its screen mounts. */
export const PERSIST_MAX_AGE = 7 * 24 * 60 * 60 * 1000

/** Best-effort synchronous feature test. `indexedDB` access itself can throw
 *  (some locked-down WebViews), hence the try/catch. Returning false makes
 *  App.tsx skip persistence entirely and mount the plain provider. */
export function indexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

/* The values go through the encrypted, size-capped local store
   (lib/local-store.ts). Every method tolerates a missing or throwing store:
   a failed read looks like "no cache" (null), a failed write is dropped, and
   the app carries on as it would with persistence switched off. */
const asyncStorage = {
  getItem: async (key: string): Promise<string | null> => {
    try {
      return (await localStore()?.get<string>(key)) ?? null
    } catch {
      return null
    }
  },
  setItem: async (key: string, value: string): Promise<void> => {
    try {
      await localStore()?.set(key, value)
    } catch {
      /* Quota, private mode, storage disabled -- the app still works. */
    }
  },
  removeItem: async (key: string): Promise<void> => {
    try {
      await localStore()?.del(key)
    } catch {
      /* Nothing was ever written. */
    }
  },
}

/** The IndexedDB key (and the persist buster) for one user in one school.
 *  This is the security boundary: change either id and you get a different
 *  store. `institutionId` is optional because platform staff hold no
 *  institution of their own -- they still get a stable, isolated bucket. */
export function persistNamespace(userId: string, institutionId: string | undefined): string {
  // Bump the version to discard every previously-persisted offline cache: after
  // the authority queries (identity, menu, sections) were excluded, an old blob
  // could still restore a stale copy once. v2 flushes them so everyone loads
  // fresh, then persists only the allowed queries going forward.
  return `rq-cache:v2:${userId}:${institutionId ?? 'none'}`
}

/** An async-storage persister bound to this user+institution's namespace. */
export function perUserPersister(userId: string, institutionId: string | undefined) {
  return createAsyncStoragePersister({
    storage: asyncStorage,
    key: persistNamespace(userId, institutionId),
    /* Batches the burst of cache events a screen mount fires into one write. */
    throttleTime: 1000,
  })
}

/* CLEARED ON SIGN-OUT, AND ONE PERSON AT A TIME.

   The key already keeps two people's answers apart. These make sure the
   device does not keep them at all once they are not the one signed in:
   sign-out empties the store (called from forgetPersistedQueries, on the
   /logout click and again when a session comes back signed out, in case the
   navigation cut the first one short), and a sign-in removes every other
   person's store. Best effort: a failure leaves the keyed isolation in place. */
export function forgetAllPersisted() {
  try {
    void localStore()?.wipe().catch(() => {})
    /* The store before encryption, left by older builds. */
    if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase('erp-rq-cache')
  } catch {
    /* no IndexedDB: nothing stored */
  }
}

export function forgetOtherPersisted(namespace: string) {
  const s = localStore()
  if (!s) return
  // rq-cache:v2:<user>:<school> -- another school of the same person stays.
  const user = namespace.split(':')[2]
  void s.keys()
    .then((all) => Promise.all(all.filter((k) => k.startsWith('rq-cache:') && k.split(':')[2] !== user).map((k) => s.del(k))))
    .catch(() => {})
}
