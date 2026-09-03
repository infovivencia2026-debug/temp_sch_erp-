/* WRITES THAT OUTLIVE THE CONNECTION.

   A school's network is not a data centre's. A teacher marks the register on a
   field trip, a clerk takes a fee at a counter behind a concrete wall, a driver
   ends a run in a basement car park. Before this, every one of those was the
   same event: the request threw, a red box appeared, and whatever had been
   typed was gone. The person's answer was to do it again later, from memory, if
   they remembered at all.

   So a write that failed because there was no network is not shown as an error.
   It is kept, and sent when the network comes back.

   WHY THIS IS SAFE, WHICH IS THE ONLY INTERESTING PART.

   Retrying a write is normally dangerous, because a client cannot tell a
   request that never arrived from one that arrived, ran, and whose reply was
   lost on the way back. Both look identical from here: no response. Resending
   the first is required; resending the second charges the family twice.

   Every queued request therefore carries an `Idempotency-Key`, minted once when
   the person pressed the button and reused by every retry of that press. The
   server stores the answer against that key and replays it rather than running
   the handler again — see internal/api/idempotency.go. The work happens once no
   matter how many times this file asks.

   WHAT IS DELIBERATELY NOT QUEUED.

   Only requests that failed with no response at all. A 4xx is the server having
   read the request and refused it, and queueing that would retry a refusal
   forever; a 5xx is a server that is reachable, which is not this problem. Both
   are thrown to the caller as they always were.

   Reads are not queued either. A GET that fails offline has nothing to preserve
   — nobody typed it — and replaying stale reads later would repaint a screen
   with answers to questions the person stopped asking. */

const KEY_PREFIX = 'erp-outbox'

/* Per account, for the reason the register queue is per account: the staffroom
   laptop signs in and out all day, and a queue flushed under the next person's
   session posts one teacher's work as somebody else. */
const keyFor = (userID?: string) => (userID ? `${KEY_PREFIX}:${userID}` : KEY_PREFIX)

/* A queued write is retried on this interval as well as on the `online` event.
   The event alone is not enough, and school networks are exactly where that
   shows: a captive portal, or a router that answers DHCP but routes nothing,
   leaves `navigator.onLine` true and fires no event at all. */
const RETRY_MS = 20_000

/* A write nobody has managed to send in this long is not a network blip, it is
   a person who has moved on. Kept as a failure to show rather than retried
   forever against a body that may no longer make sense. */
const GIVE_UP_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export interface Queued {
  id: string
  /** The idempotency key. Minted once; never regenerated on retry — that is
      the entire safety property. */
  key: string
  method: string
  path: string
  body?: string
  /** What the person was doing, in their words, for the screen that lists
      these. "Fee receipt for Aarav" beats "POST /api/v1/payments". */
  label?: string
  queued_at: number
  attempts: number
  last_error?: string
  /** Set when the server finally answered. Kept briefly so the screen can say
      it went through rather than having the row vanish. */
  sent_at?: number
  status?: number
}

let currentUser: string | undefined
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<(q: Queued[]) => void>()

function read(): Queued[] {
  try {
    return JSON.parse(localStorage.getItem(keyFor(currentUser)) ?? '[]')
  } catch {
    /* A corrupted queue is not worth crashing the app over, but it is worth
       not silently discarding either — so it stays on disk under its own key
       for anybody investigating, and the app carries on with an empty one. */
    try {
      localStorage.setItem(`${keyFor(currentUser)}:corrupt`, localStorage.getItem(keyFor(currentUser)) ?? '')
    } catch { /* storage full; nothing useful left to do */ }
    return []
  }
}

function write(q: Queued[]) {
  try {
    localStorage.setItem(keyFor(currentUser), JSON.stringify(q))
  } catch { /* quota. The in-memory copy still flushes this session. */ }
  listeners.forEach((fn) => fn(q))
}

export function pending(): Queued[] {
  return read().filter((r) => !r.sent_at)
}

export function subscribe(fn: (q: Queued[]) => void) {
  listeners.add(fn)
  fn(read())
  return () => {
    listeners.delete(fn)
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
  q.push({ ...entry, id: crypto.randomUUID(), queued_at: Date.now(), attempts: 0 })
  write(q)
}

/** Drop one — the person decided it is no longer wanted. */
export function discard(id: string) {
  write(read().filter((r) => r.id !== id))
}

let flushing = false

/**
 * Send what is waiting, oldest first.
 *
 * Strictly in order and one at a time, because these are a person's actions in
 * the order they took them: a payment against an invoice raised two entries
 * earlier has to arrive after it. Parallelism would be faster and wrong.
 */
export async function flush(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    for (const row of read().filter((r) => !r.sent_at)) {
      if (Date.now() - row.queued_at > GIVE_UP_AFTER_MS) continue
      try {
        const res = await fetch(row.path, {
          method: row.method,
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Idempotency-Key': row.key,
            ...(row.body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: row.body,
        })
        /* Answered is answered, even when the answer is no. A 4xx queued
           forever is a retry loop against a request the server has already
           read and refused; the row is marked settled and the screen shows
           what it said. */
        const q = read()
        const r = q.find((x) => x.id === row.id)
        if (r) {
          r.sent_at = Date.now()
          r.status = res.status
          if (!res.ok) r.last_error = await res.text().then((t) => t.slice(0, 200)).catch(() => '')
          write(q)
        }
      } catch {
        /* Still no network. Count the attempt and stop the pass: if this one
           could not go, neither can the ones behind it, and the order matters
           more than draining the queue. */
        const q = read()
        const r = q.find((x) => x.id === row.id)
        if (r) {
          r.attempts += 1
          r.last_error = 'no connection'
          write(q)
        }
        return
      }
    }
  } finally {
    flushing = false
  }
}

/** Started once, from main. Idempotent. */
export function startOutbox() {
  if (timer) return
  window.addEventListener('online', () => void flush())
  /* Coming back to the tab is the other moment worth trying: a phone that was
     asleep in a pocket fires no `online` event on waking. */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flush()
  })
  timer = setInterval(() => void flush(), RETRY_MS)
  void flush()
}

/**
 * What `request()` calls when a mutation threw before any response.
 *
 * Returns true if it was taken. The caller then resolves rather than throwing,
 * because from the person's point of view the thing they asked for is going to
 * happen — and telling them it failed, when it is queued and will be sent, is
 * the lie this whole file exists to stop telling.
 */
export function takeOffline(
  method: string,
  path: string,
  body: string | undefined,
  /* The key the failed attempt already carried. Reused, never regenerated:
     the request may in fact have reached the server and only its reply been
     lost, in which case the retry must be recognisable as the same intent.
     A fresh key here would make every queued write a second write. */
  key: string,
  label?: string,
): boolean {
  if (method === 'GET' || method === 'HEAD') return false
  enqueue({ key, method, path, body, label })
  return true
}

