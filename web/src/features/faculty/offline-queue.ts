import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

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

const QUEUE_KEY = 'classroom-offline-register-queue'

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

function read(): QueuedBatch[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    return raw ? (JSON.parse(raw) as QueuedBatch[]) : []
  } catch {
    return []
  }
}

function write(items: QueuedBatch[]) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(-50)))
  } catch {
    /* storage full or blocked; the in-memory copy still posts this session */
  }
}

export function useOfflineRegisterQueue() {
  const [queue, setQueue] = useState<QueuedBatch[]>(read)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [syncing, setSyncing] = useState(false)

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

  const persist = useCallback((next: QueuedBatch[]) => {
    write(next)
    setQueue(next)
    return next
  }, [])

  const enqueue = useCallback(
    (batch: Omit<QueuedBatch, 'client_batch_ref' | 'captured_at'>) => {
      const full: QueuedBatch = {
        ...batch,
        // The device clock, not the server's. It is what the teacher will be
        // asked about, and on a trip the two are hours apart.
        captured_at: new Date().toISOString(),
        client_batch_ref: crypto.randomUUID(),
      }
      persist([...read(), full])
      return full
    },
    [persist],
  )

  /* Post every batch that has not been answered yet.

     Sequential rather than parallel on purpose: the batches are usually the
     same section on consecutive periods, and a burst of them arriving out of
     order makes the conflict list read backwards. */
  const flush = useCallback(async () => {
    const pending = read().filter((b) => !b.synced_at)
    if (pending.length === 0) return
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
            read().map((b) =>
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
          // reconnect; only a refusal the server can explain is worth showing,
          // and it is shown against the batch rather than as a toast that has
          // gone by the time the teacher looks up.
          persist(
            read().map((b) =>
              b.client_batch_ref === batch.client_batch_ref
                ? { ...b, error: e instanceof Error ? e.message : 'Could not sync' }
                : b,
            ),
          )
        }
      }
    } finally {
      setSyncing(false)
    }
  }, [persist])

  // Coming back online is the moment the queue exists for.
  useEffect(() => {
    if (online) void flush()
  }, [online, flush])

  const clearSynced = useCallback(() => {
    persist(read().filter((b) => !b.synced_at))
  }, [persist])

  return {
    queue,
    pending: queue.filter((b) => !b.synced_at),
    online,
    syncing,
    enqueue,
    flush,
    clearSynced,
  }
}
