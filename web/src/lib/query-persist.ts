/* THE PARENT'S LAST-SEEN ANSWERS, KEPT ON THE PHONE.

   Every parent screen used to open on a spinner -- "Finding your child's
   bus…", "Checking what needs doing…" -- and stay on it for as long as the
   round trip took, which on a school-gate connection is one to four seconds.
   The data it then drew was, nearly always, the data it drew the last time:
   the same child, the same stop, the same fee balance. A native app paints
   what it saw last and quietly fetches; a web page waits. The parent's own
   words for the difference were "it feels ugly" and "I should not sense it as
   a web page", and the wait is most of what they were sensing.

   The service worker in sw-src.js already keeps every API answer, but only
   as a fallback for a request that could not be made at all: it is
   network-first, so a screen still waits on the wire before it can paint.
   This is the other half. The TanStack cache is written to storage as it
   changes and put back before the first parent screen mounts, so the screen
   finds its query already in the `success` state and draws at once; the
   ordinary staleness rules then refetch in the background and the
   `Freshness` line under the title says "updating" and then "updated just
   now".

   SCOPED TO THE PARENT, AND ONLY THE PARENT.

   Nothing is written for a staff role. A teacher's register, a clerk's fee
   ledger and the principal's dashboard are the whole school's data, and the
   staffroom laptop signs in and out all day; keeping any of it in storage
   would be the leak that sw-data.ts already argues against for the worker's
   cache. A parent's phone is a parent's phone, and what is kept is their own
   family's answers. The role test is exact: an account holding parent AND a
   staff role is staff for this purpose.

   Scoped by user, and hydrated only after the live session names that user.
   The blob carries the user id it was written for and is thrown away the
   moment the session reports anyone else, including nobody; it is never put
   into the cache before /session has answered, so a different person opening
   the same phone cannot be painted the previous family's screens for even one
   frame. The session query itself is therefore never persisted -- it is the
   gate, and the gate must be asked.

   CLEARED ON SIGN-OUT, THREE WAYS.

   Sign-out is a full navigation to the Go binary's /logout, so no React code
   runs on the way out; the worker catches that navigation for its own caches
   and cannot touch localStorage. So: a click on any link to /logout clears the
   blob synchronously before the navigation begins; a session that comes back
   unauthenticated clears it before redirecting to /login; and a session that
   names a different user clears it. Any one of the three is enough, and the
   three together mean there is no path out of a signed-in parent app that
   leaves the answers behind.

   localStorage rather than IndexedDB, deliberately. IndexedDB is asynchronous,
   which means either a frame with nothing in the cache before the restore
   lands -- the spinner this exists to remove, shortened rather than gone --
   or gating the whole render on the restore. localStorage is synchronous, and
   at the size of a family's answers (a few hundred kilobytes at most) the
   read costs a millisecond or two on a phone. It is also what the Android
   shell's WebView is known to keep; IndexedDB has been seen wiped by the
   system's storage pressure on the same handset.

   A write is a merge, not a snapshot. The cache garbage-collects a query five
   minutes after its last observer leaves, and a snapshot taken after that
   would silently drop the screen a parent had just been on -- the one they
   are most likely to open next. So each write lays the live cache over what
   was stored and keeps stored entries the cache no longer holds, up to the
   age limit below. */

import { dehydrate, hydrate, type QueryClient, type DehydratedState } from '@tanstack/react-query'

const KEY = 'erp.parent-cache.v1'
/* Three days. Long enough for a weekend; short enough that a term's fee
   change or a route reassignment is not painted from a fortnight ago. Every
   restored query is also marked invalidated, so anything old enough to be
   wrong is being refetched the moment its screen mounts. */
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000
/* Above this the blob stops being written rather than being trimmed. It is a
   guard against something unexpected -- a gallery answer with a thousand
   rows -- filling the quota and throwing on every write. */
const MAX_BYTES = 2_500_000

/* The first element of every parent query key, by prefix. The list is the
   keys the screens under features/portal and the parent's home board use,
   plus the two shared pieces they draw -- what needs attention and the
   catalogue -- and nothing a staff screen reads. */
const PARENT_KEY_PREFIXES = [
  'portal-',
  'parent-',
  'my-students',
  'me-child-bus',
  'child-bus',
  'attention',
  'catalog',
  'notifications',
  'student-id-card',
  'gallery-',
  'event-passes',
  'ptm-',
  'outpasses',
  'transport-prefs',
]

export function isParentQueryKey(key: readonly unknown[]): boolean {
  const head = key[0]
  if (typeof head !== 'string') return false
  return PARENT_KEY_PREFIXES.some((p) => (p.endsWith('-') ? head.startsWith(p) : head === p))
}

/** The one role that earns persistence. Exact, see the header. */
export function isParentOnly(roles: readonly string[] | undefined): boolean {
  return !!roles && roles.length > 0 && roles.every((r) => r === 'parent')
}

interface Blob {
  v: 1
  user: string
  at: number
  state: DehydratedState
}

let seenUser: string | undefined | null = null
let unsubscribe: (() => void) | undefined
let timer: ReturnType<typeof setTimeout> | undefined

function read(): Blob | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const blob = JSON.parse(raw) as Blob
    if (blob?.v !== 1 || typeof blob.user !== 'string' || !blob.state?.queries) return null
    return blob
  } catch {
    return null
  }
}

/** Throws the blob away. Safe to call from anywhere, any number of times. */
export function forgetPersistedQueries() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* Private mode, or storage disabled: nothing was ever written. */
  }
}

function write(client: QueryClient, user: string) {
  const now = Date.now()
  const live = dehydrate(client, {
    shouldDehydrateQuery: (q) =>
      q.state.status === 'success' && isParentQueryKey(q.queryKey),
  })
  /* Merge: stored entries the live cache has let go of are kept, so the
     screen a parent left five minutes ago is still instant when they come
     back to it tomorrow. */
  const kept = new Map<string, DehydratedState['queries'][number]>()
  const previous = read()
  if (previous?.user === user) {
    for (const q of previous.state.queries) {
      if (now - q.state.dataUpdatedAt <= MAX_AGE_MS) kept.set(q.queryHash, q)
    }
  }
  for (const q of live.queries) kept.set(q.queryHash, q)
  const blob: Blob = {
    v: 1,
    user,
    at: now,
    state: { mutations: [], queries: [...kept.values()] },
  }
  try {
    const raw = JSON.stringify(blob)
    if (raw.length > MAX_BYTES) return
    localStorage.setItem(KEY, raw)
  } catch {
    /* Quota, or storage disabled. The screen still works; it just waits
       like it used to. */
  }
}

function stopPersisting() {
  unsubscribe?.()
  unsubscribe = undefined
  if (timer) clearTimeout(timer)
  timer = undefined
}

function startPersisting(client: QueryClient, user: string) {
  stopPersisting()
  /* Debounced, because a screen mounting fires a burst of cache events --
     one per query, then one per answer -- and each write serialises the
     whole blob. Half a second groups a screen's worth into one write and is
     still well inside the time it takes to put the phone away. */
  unsubscribe = client.getQueryCache().subscribe(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      write(client, user)
    }, 500)
  })
  /* And once on the way in, so the first session on a new phone is written
     even if nothing changes after the catalogue lands. */
  write(client, user)
}

/**
 * Called by SessionProvider during render, the moment /session has answered,
 * before any screen has mounted. Decides, for this user, whether there is a
 * blob to put back, whether to keep writing one, or whether what is stored
 * belongs to somebody else and must go.
 *
 * Idempotent per user: React's strict-mode double render and every later
 * re-render of the provider return at the first line.
 */
export function adoptPersistedQueries(
  client: QueryClient,
  user: { id: string; roles: string[] } | undefined,
) {
  const id = user?.id
  if (seenUser !== null && seenUser === id) return
  seenUser = id

  if (!user || !isParentOnly(user.roles)) {
    /* Nobody, or staff. Whatever is stored is a previous parent's, or should
       never be written: gone either way. */
    stopPersisting()
    forgetPersistedQueries()
    return
  }

  const blob = read()
  if (blob && blob.user === user.id) {
    const now = Date.now()
    const fresh: DehydratedState = {
      mutations: [],
      queries: blob.state.queries.filter((q) => now - q.state.dataUpdatedAt <= MAX_AGE_MS),
    }
    hydrate(client, fresh)
    /* Restored data is what was true when the phone was last open, and the
       five-minute staleTime would otherwise trust it for five minutes. Marked
       invalidated so every screen refetches as it mounts, with the restored
       answer on screen while it does. `refetchType: 'none'` because nothing
       is mounted yet; the mount is what refetches. */
    void client.invalidateQueries({
      predicate: (q) => isParentQueryKey(q.queryKey),
      refetchType: 'none',
    })
  } else if (blob) {
    forgetPersistedQueries()
  }
  startPersisting(client, user.id)
}

/* The sign-out link, caught on the way out.

   Every sign-out in the product is `<a href="/logout">` -- session.tsx, the
   shell header, the Bento appearance dialog -- and a full navigation, so this
   is the only React-side moment that exists. A click listener at the document
   runs before the browser follows the link, and localStorage.removeItem is
   synchronous, so the blob is gone before /logout is even requested. Capture
   phase, so a handler on the link that stops propagation cannot skip it. */
export function clearPersistedQueriesOnSignOut() {
  if (typeof document === 'undefined') return
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]')
      if (!a) return
      let path = ''
      try {
        path = new URL((a as HTMLAnchorElement).href, location.href).pathname
      } catch {
        return
      }
      if (path === '/logout') {
        stopPersisting()
        forgetPersistedQueries()
      }
    },
    true,
  )
}
