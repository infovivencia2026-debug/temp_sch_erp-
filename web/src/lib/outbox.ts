/* WRITES THAT OUTLIVE THE CONNECTION.

   A school's network is not a data centre's. A teacher marks the register on a
   field trip, a driver ends a run in a basement car park. A write that failed
   because there was no network is not shown as an error: it is kept, and sent
   when the network comes back, the way a chat app holds a message with a clock
   beside it until it goes.

   WHY THIS IS SAFE. Every queued request carries an `Idempotency-Key`, minted
   once when the person pressed the button and reused by every retry of that
   press. The server stores the answer against that key and replays it rather
   than running the handler again (worker/src/idempotency.ts). The work happens
   once no matter how many times this file asks.

   WHAT IS QUEUED. Only writes that failed with no response at all, and only to
   paths lib/offline-policy.ts allows: never money, identity, publishing or
   admissions. A 4xx is the server having read the request and refused it; it
   is shown, not retried.

   STATES, as the list shows them:
     pending   clock   waiting for the network (or for its next try)
     sent      tick    the server took it
     failed    red     the server refused it; Retry or Discard
     conflict  red     the server's copy changed first; the server's version
                       stands and the row says what the server said

   ORDER. Strictly oldest first and one at a time: these are a person's actions
   in the order they took them. If one cannot go, nothing behind it goes. */

const KEY_PREFIX = 'erp-outbox'

/* Per account: the staffroom laptop signs in and out all day, and a queue
   flushed under the next person's session posts one teacher's work as
   somebody else. */
const keyFor = (userID?: string) => (userID ? `${KEY_PREFIX}:${userID}` : KEY_PREFIX)

/* The timer looks this often; whether it sends depends on the backoff. The
   `online` event alone is not enough: a captive portal leaves
   navigator.onLine true and fires no event at all. */
const TICK_MS = 5_000
const BACKOFF_BASE_MS = 5_000
const BACKOFF_MAX_MS = 5 * 60_000

/* A write nobody has managed to send in a week is not a network blip. */
export const GIVE_UP_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/* A sent row stays long enough for the tick to be seen, then goes. */
const SENT_KEEP_MS = 2 * 60_000

export type OutboxState = 'pending' | 'sent' | 'failed' | 'conflict'

export interface Queued {
  id: string
  /** The idempotency key. Minted once; never regenerated on retry. */
  key: string
  method: string
  path: string
  body?: string
  /** What the person was doing, in their words: "Register for 7 B". */
  label?: string
  queued_at: number
  attempts: number
  /** Earliest time the next automatic try may go. */
  next_at?: number
  last_error?: string
  /** Set when the server answered. */
  sent_at?: number
  status?: number
}

export function stateOf(r: Queued): OutboxState {
  if (!r.sent_at) return Date.now() - r.queued_at > GIVE_UP_AFTER_MS ? 'failed' : 'pending'
  if (r.status === 409) return 'conflict'
  if (r.status && r.status >= 400) return 'failed'
  return 'sent'
}

export function backoff(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))
}

let currentUser: string | undefined
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<(q: Queued[]) => void>()
const sentListeners = new Set<(r: Queued) => void>()

function read(): Queued[] {
  try {
    return JSON.parse(localStorage.getItem(keyFor(currentUser)) ?? '[]')
  } catch {
    try {
      localStorage.setItem(`${keyFor(currentUser)}:corrupt`, localStorage.getItem(keyFor(currentUser)) ?? '')
    } catch { /* storage full */ }
    return []
  }
}

function write(q: Queued[]) {
  const now = Date.now()
  const kept = q.filter((r) => stateOf(r) !== 'sent' || now - (r.sent_at ?? 0) < SENT_KEEP_MS)
  try {
    localStorage.setItem(keyFor(currentUser), JSON.stringify(kept))
  } catch { /* quota */ }
  listeners.forEach((fn) => fn(kept))
}

export function all(): Queued[] {
  return read()
}

export function pending(): Queued[] {
  return read().filter((r) => stateOf(r) === 'pending')
}

export function subscribe(fn: (q: Queued[]) => void) {
  listeners.add(fn)
  fn(read())
  return () => {
    listeners.delete(fn)
  }
}

/** Told when a queued write reaches the server (any answer), so the screens
    it touched can be refetched: the server's copy wins. */
export function onSent(fn: (r: Queued) => void) {
  sentListeners.add(fn)
  return () => {
    sentListeners.delete(fn)
  }
}

/* Told by the session layer, so the queue follows whoever is signed in. */
export function setOutboxUser(userID?: string) {
  if (userID === currentUser) return
  currentUser = userID
  listeners.forEach((fn) => fn(read()))
  if (userID) void flush()
}

export function enqueue(entry: Omit<Queued, 'id' | 'queued_at' | 'attempts'>) {
  const q = read()
  /* The same press queued twice (a double tap that both failed) is one write. */
  if (q.some((r) => r.key === entry.key)) return
  q.push({ ...entry, id: crypto.randomUUID(), queued_at: Date.now(), attempts: 0 })
  write(q)
  askForBackgroundSync()
}

/** Drop one: the person decided it is no longer wanted. */
export function discard(id: string) {
  write(read().filter((r) => r.id !== id))
}

/** Send a refused or stuck row again. */
export function retry(id: string) {
  const q = read()
  const r = q.find((x) => x.id === id)
  if (!r) return
  /* A refused row is answered: the server stored its refusal under the old
     key and would replay it. A retry is a new attempt, so a new key. */
  if (r.sent_at) r.key = crypto.randomUUID()
  delete r.sent_at
  delete r.status
  delete r.next_at
  r.queued_at = Date.now()
  r.attempts = 0
  write(q)
  void flush({ force: true })
}

/** Everything for every account on this device: a remote wipe. */
export function wipeOutbox() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && k.startsWith(KEY_PREFIX)) localStorage.removeItem(k)
    }
  } catch { /* no storage */ }
  listeners.forEach((fn) => fn([]))
}

let flushing: Promise<void> | undefined

/** Send what is waiting, oldest first. `force` ignores the backoff: the
    network just came back, or the person pressed Retry. */
export function flush(opts: { force?: boolean } = {}): Promise<void> {
  flushing ??= run(opts).finally(() => { flushing = undefined })
  return flushing
}

async function run({ force = false }: { force?: boolean }) {
  for (const row of read().filter((r) => stateOf(r) === 'pending')) {
    if (!force && row.next_at && Date.now() < row.next_at) return
    let res: Response
    try {
      res = await fetch(row.path, {
        method: row.method,
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Idempotency-Key': row.key,
          ...(row.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: row.body,
      })
    } catch {
      /* Still no network. Count the attempt and stop the pass: the order
         matters more than draining the queue. */
      later(row.id, 'No connection')
      return
    }
    /* A server that is up but failing (5xx) has stored nothing (the key is
       released on a 5xx); keep the row and try later. */
    if (res.status >= 500) {
      later(row.id, 'The server could not take it just now')
      return
    }
    const text = await res.text().catch(() => '')
    const q = read()
    const r = q.find((x) => x.id === row.id)
    if (r) {
      r.sent_at = Date.now()
      r.status = res.status
      if (!res.ok) r.last_error = serverMessage(text)
      else delete r.last_error
      write(q)
      sentListeners.forEach((fn) => fn(r))
    }
  }
}

function later(id: string, why: string) {
  const q = read()
  const r = q.find((x) => x.id === id)
  if (!r) return
  r.attempts += 1
  r.next_at = Date.now() + backoff(r.attempts)
  r.last_error = why
  write(q)
}

function serverMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: string; message?: string }
    return (j.error || j.message || '').slice(0, 200) || 'Not accepted'
  } catch {
    return text.slice(0, 200) || 'Not accepted'
  }
}

/* Background Sync: Chrome and Android WebView wake the service worker when
   the network returns even with the tab closed; the worker tells any open
   page to flush (sw-src.js). The native shells run their own background
   flush (docs/native-shell.md). Elsewhere the timer and events cover it. */
function askForBackgroundSync() {
  try {
    void navigator.serviceWorker?.ready
      .then((reg) => (reg as ServiceWorkerRegistration & { sync?: { register(t: string): Promise<void> } }).sync?.register('erp-outbox'))
      .catch(() => {})
  } catch { /* unsupported */ }
}

/** Started once, from main. Idempotent. */
export function startOutbox() {
  if (timer) return
  window.addEventListener('online', () => void flush({ force: true }))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flush()
  })
  try {
    navigator.serviceWorker?.addEventListener('message', (e) => {
      if ((e.data as { type?: string } | null)?.type === 'erp-outbox-flush') void flush({ force: true })
    })
  } catch { /* no worker */ }
  timer = setInterval(() => void flush(), TICK_MS)
  void flush()
}

/**
 * What `request()` calls when a write threw before any response.
 *
 * Returns true if it was taken; the caller then tells the screen it is saved
 * on the device. The key is the one the failed attempt already carried: the
 * request may have reached the server and only its reply been lost.
 */
export function takeOffline(
  method: string,
  path: string,
  body: unknown,
  key: string,
  label?: string,
  allowed: (method: string, path: string) => boolean = () => true,
): boolean {
  if (method === 'GET' || method === 'HEAD') return false
  /* A file upload (FormData) cannot be kept as text; it waits for the network. */
  if (typeof body !== 'undefined' && typeof body !== 'string') return false
  if (!allowed(method, path)) return false
  enqueue({ key, method, path, body: body as string | undefined, label })
  return true
}
