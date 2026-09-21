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
import { get, set, del, createStore, type UseStore } from 'idb-keyval'

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

/* A single IndexedDB database/store shared by every namespace; the per-user
   isolation is in the KEY, not in separate databases. Created lazily and
   guarded so that a throwing `createStore` cannot take the app down. */
let store: UseStore | undefined
function getStore(): UseStore | undefined {
  if (store) return store
  try {
    store = createStore('erp-rq-cache', 'keyval')
    return store
  } catch {
    return undefined
  }
}

/* The AsyncStorage adapter react-query's persister expects. Every method
   tolerates a missing or throwing IndexedDB: a failed read looks like "no
   cache" (null), a failed write is dropped silently, and the app carries on
   exactly as it would with persistence switched off. */
const asyncStorage = {
  getItem: async (key: string): Promise<string | null> => {
    try {
      const s = getStore()
      if (!s) return null
      const value = await get<string>(key, s)
      return value ?? null
    } catch {
      return null
    }
  },
  setItem: async (key: string, value: string): Promise<void> => {
    try {
      const s = getStore()
      if (!s) return
      await set(key, value, s)
    } catch {
      /* Quota, private mode, storage disabled -- the app still works. */
    }
  },
  removeItem: async (key: string): Promise<void> => {
    try {
      const s = getStore()
      if (!s) return
      await del(key, s)
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
  return `rq-cache:v1:${userId}:${institutionId ?? 'none'}`
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
