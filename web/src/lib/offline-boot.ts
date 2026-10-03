/* OPENING THE APP WITH NO SIGNAL.

   Every screen waits behind GET /session, and the menu and class scope
   behind it are deliberately kept out of the persisted query cache (App.tsx:
   a just-granted permission must not be hidden by a stale copy). So with no
   network the app could not get past its opening, however much it had saved.

   This keeps one sealed copy of those few answers in the local store, and
   uses it ONLY when the network is unreachable. Online, the server's answer
   is always the one used, and the copy is refreshed from it. Offline, the
   person sees what they last saw; anything they change goes to the outbox,
   and the server checks it with their real, current permissions when it
   arrives.

   The copy goes with everything else on sign-out and on a remote wipe. */
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { localStore } from './local-store'
import { wipeOutbox } from './outbox'

/* The authority queries App.tsx keeps out of the persisted cache. */
export const BOOT_KEYS = ['session', 'catalog', 'sections', 'user-permissions']
const PREFIX = 'boot:'

interface Saved { key: QueryKey; data: unknown; at: number }

let offlineBoot = false
/** True when this run of the app started from the saved copy. */
export function bootedOffline(): boolean {
  return offlineBoot
}

/** Keeps the saved copy in step with every successful answer. */
export function rememberBootQueries(client: QueryClient) {
  const store = localStore()
  if (!store) return () => {}
  return client.getQueryCache().subscribe((ev) => {
    if (ev.type !== 'updated' || ev.action.type !== 'success') return
    const key = ev.query.queryKey
    if (!BOOT_KEYS.includes(String(key[0]))) return
    const data = ev.query.state.data
    if (key[0] === 'session' && !(data as { authenticated?: boolean } | undefined)?.authenticated) return
    void store.set(PREFIX + JSON.stringify(key), { key, data, at: ev.query.state.dataUpdatedAt } satisfies Saved)
      .catch(() => {})
  })
}

/** The saved session, with the menu and scope put back into the cache. Only
    called when the network could not be reached. */
export async function savedSession<T>(client: QueryClient): Promise<T | undefined> {
  const store = localStore()
  if (!store) return undefined
  try {
    const session = await store.get<Saved>(PREFIX + JSON.stringify(['session']))
    if (!session) return undefined
    for (const k of await store.keys()) {
      if (!k.startsWith(PREFIX) || k === PREFIX + JSON.stringify(['session'])) continue
      const s = await store.get<Saved>(k)
      /* Marked as old as it is, so it is refetched the moment there is a network. */
      if (s) client.setQueryData(s.key, s.data, { updatedAt: s.at })
    }
    offlineBoot = true
    return session.data as T
  } catch {
    return undefined
  }
}

/** The server said the session was ended from elsewhere: delete everything
    this device kept for the person, including what has not been sent. */
export async function wipeDevice() {
  wipeOutbox()
  try {
    await localStore()?.wipe()
  } catch { /* nothing kept */ }
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && (k.startsWith('erp-') || k.startsWith('erp.'))) localStorage.removeItem(k)
    }
  } catch { /* no storage */ }
  try {
    window.ErpShell?.wipe?.()
  } catch { /* older app */ }
}
