import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'

/* A queue of registers taken while the browser could not reach the server.

   Read this before believing anything the feature name implies.

   WHAT THIS IS. A teacher who takes the register with no signal loses the
   entry entirely today: the request fails and the form is gone. What follows
   keeps the entry in localStorage, marks it pending, and posts it when the
   browser says it is back online — or when the teacher presses the button.
   Each batch carries a client_batch_ref, so a replay after a dropped response
   is safe: the server returns the original outcome rather than writing twice.

   WHAT THIS IS NOT. This is not an offline-first PWA. There is no service
   worker in this project, so the application shell and the bundle itself still
   come from the network: a teacher who navigates away, reloads, or opens the
   app cold with no connection gets nothing to type into. The queue survives a
   reload — it is in localStorage, not memory — but the page that reads it does
   not. Making that page reachable offline means a service worker, a precached
   shell and an install prompt, and none of those are here.

   So: a register taken on a school trip in a tab that is already open will not
   be lost, and will sync when the bus reaches the main road. A teacher who
   closes the tab in the car park is out of luck until the app has a service
   worker. Anything more than that would be a claim this code cannot back. */

/* The key carries the user. localStorage is per-origin, and the staffroom
   laptop is signed in and out of all day: a shared key flushes the registers
   one teacher took under the next teacher's session, posted as them and to a
   section they may not even be scoped for. */
const QUEUE_PREFIX = 'classroom-offline-register-queue'
const queueKeyFor = (userID?: string) =>
  userID ? `${QUEUE_PREFIX}:${userID}` : QUEUE_PREFIX

/* How many answered batches to keep for the teacher to look back at. Pending
   batches are NOT part of this cap — see trim. */
const SYNCED_KEEP = 50

/* A batch left pending is retried on this interval as well as on the online
   event. The event alone is not enough: the common school failure is a captive
   portal or a 502 with navigator.onLine still true, which fires nothing. */
const RETRY_MS = 60_000

export interface QueuedBatch {
  client_batch_ref: string
  section_id: string
  section_name: string
  on_date: string
  captured_at: string
  device_note?: string
  marks: { student_id: string; status: string; remarks?: string }[]
  diary: { kind: string; body: string; class_subject_id?: string }[]
  // Set once the server has answered. A batch keeps its place in the queue
  // with the outcome attached rather than vanishing, because the teacher needs
  // to see that the eleven o'clock register did in fact arrive.
  synced_at?: string
  accepted?: number
  conflicted?: number
  error?: string
}

function read(key: string): QueuedBatch[] {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as QueuedBatch[]) : []
  } catch {
    return []
  }
}

/* Drop answered batches, oldest first, and never a pending one.

   The obvious cap — keep the last N of everything — evicts from the front of
   the queue, and the front is where the oldest *unsynced* registers sit. That
   is the one thing this file exists to protect: a teacher offline long enough
   to fill the queue would have silently lost the registers that never arrived.
   A pending batch stays until the server has answered for it, however long the
   queue grows. */
function trim(items: QueuedBatch[]): QueuedBatch[] {
  const synced = items.filter((b) => b.synced_at)
  if (synced.length <= SYNCED_KEEP) return items
  const drop = new Set(synced.slice(0, synced.length - SYNCED_KEEP))
  return items.filter((b) => !drop.has(b))
}

/* True if the batches reached the disk. A false here means the tab is now the
   only copy, which the teacher has to be told — the previous version swallowed
   it and left a UI claiming the register was safely queued. */
function write(key: string, items: QueuedBatch[]): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(items))
    return true
  } catch {
    return false
  }
}

export function useOfflineRegisterQueue() {
  const session = useSession()
  const key = queueKeyFor(session.user?.id)

  const [queue, setQueue] = useState<QueuedBatch[]>(() => read(key))
  const [online, setOnline] = useState(() => navigator.onLine)
  const [syncing, setSyncing] = useState(false)
  /* Set when localStorage refused the write: the queue is in this tab only,
     and closing it loses the register. */
  const [storageFailed, setStorageFailed] = useState(false)

  // The queue belongs to whoever is signed in; a sign-out and back in on the
  // same laptop must not inherit the previous teacher's pending batches.
  useEffect(() => {
    setQueue(read(key))
  }, [key])

  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])

  const persist = useCallback(
    (next: QueuedBatch[]) => {
      const trimmed = trim(next)
      setStorageFailed(!write(key, trimmed))
      setQueue(trimmed)
      return trimmed
    },
    [key],
  )

  const enqueue = useCallback(
    (batch: Omit<QueuedBatch, 'client_batch_ref' | 'captured_at'>) => {
      const full: QueuedBatch = {
        ...batch,
        // The device clock, not the server's. It is what the teacher will be
        // asked about, and on a trip the two are hours apart.
        captured_at: new Date().toISOString(),
        client_batch_ref: crypto.randomUUID(),
      }
      persist([...read(key), full])
      return full
    },
    [persist, key],
  )

  /* Post every batch that has not been answered yet.

     Sequential rather than parallel on purpose: the batches are usually the
     same section on consecutive periods, and a burst of them arriving out of
     order makes the conflict list read backwards.

     Guarded against re-entry with a ref, not the syncing state: the reconnect
     effect and the teacher's button both call this, and two overlapping runs
     post the same batches twice. That the server dedupes on client_batch_ref
     makes it survivable, not correct. */
  const flushing = useRef(false)
  const flush = useCallback(async () => {
    if (flushing.current) return
    const pending = read(key).filter((b) => !b.synced_at)
    if (pending.length === 0) return
    flushing.current = true
    setSyncing(true)
    try {
      for (const batch of pending) {
        try {
          const res = await api.post<{ accepted: number; conflicted: number }>(
            '/api/v1/classroom/attendance/capture',
            {
              section_id: batch.section_id,
              on_date: batch.on_date,
              client_batch_ref: batch.client_batch_ref,
              captured_at: batch.captured_at,
              device_note: batch.device_note,
              marks: batch.marks,
              diary: batch.diary,
            },
          )
          persist(
            read(key).map((b) =>
              b.client_batch_ref === batch.client_batch_ref
                ? {
                    ...b,
                    synced_at: new Date().toISOString(),
                    accepted: res.accepted,
                    conflicted: res.conflicted,
                    error: undefined,
                  }
                : b,
            ),
          )
        } catch (e) {
          // Left pending deliberately. A failed post is retried on the next
          // reconnect and on the retry interval; only a refusal the server can
          // explain is worth showing, and it is shown against the batch rather
          // than as a toast that has gone by the time the teacher looks up.
          persist(
            read(key).map((b) =>
              b.client_batch_ref === batch.client_batch_ref
                ? { ...b, error: e instanceof Error ? e.message : 'Could not sync' }
                : b,
            ),
          )
        }
      }
    } finally {
      flushing.current = false
      setSyncing(false)
    }
  }, [persist, key])

  // Coming back online is the moment the queue exists for.
  useEffect(() => {
    if (online) void flush()
  }, [online, flush])

  const pending = queue.filter((b) => !b.synced_at)

  // The connection can come back without the browser noticing — a captive
  // portal, a gateway that was down. Keep trying while anything is pending.
  useEffect(() => {
    if (pending.length === 0) return
    const timer = window.setInterval(() => void flush(), RETRY_MS)
    return () => window.clearInterval(timer)
  }, [pending.length, flush])

  /* A register that has not reached the server yet is in this browser and
     nowhere else. Closing the tab on it is the loss the whole file is written
     to prevent, so it costs a confirmation. */
  useEffect(() => {
    if (pending.length === 0) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pending.length])

  const clearSynced = useCallback(() => {
    persist(read(key).filter((b) => !b.synced_at))
  }, [persist, key])

  return {
    queue,
    pending,
    online,
    syncing,
    /** True when localStorage refused the queue: this tab is the only copy. */
    storageFailed,
    enqueue,
    flush,
    clearSynced,
  }
}
