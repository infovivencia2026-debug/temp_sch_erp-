import { useEffect, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

/* THE OTHER END OF THE LIVE BUS.

   One EventSource per tab on /api/v1/live/stream. The server sends a hint —
   "a message landed in this thread", "this person is typing", "you have a
   notification" — and this file turns each hint into the smallest refetch
   that shows it: the exact query keys the messaging screens use, not the
   blanket invalidate the 30s revision poll does. The poll stays; this is
   what makes the gap between the two ends of a conversation a second rather
   than half a minute.

   Cookie-authenticated like every other call, through the same Pages proxy.
   Closed while the tab is hidden and reopened when it is seen again, exactly
   as the poll pauses; the browser reconnects on its own if the server cuts
   the request, and a missed hint costs nothing but a poll's worth of delay. */

type LiveEvent = {
  type: 'message' | 'typing' | 'notification'
  scope?: 'staff' | 'parent' | 'counselor' | ''
  from: string
  keys?: Record<string, string>
  at: string
}

/* Who is typing to me, keyed by conversation. Entries expire on their own so a
   tab that closed mid-word never leaves "typing…" on the screen. */
const TYPING_TTL_MS = 5000
const typing = new Map<string, number>()
const listeners = new Set<() => void>()
function emit() { for (const l of listeners) l() }

/** The key a conversation is known by, on both sides of the bus. */
export function typingKey(t: TypingTarget): string {
  switch (t.scope) {
    case 'staff': return `staff:${t.peer}`
    case 'parent': return `parent:${t.student}:${t.parent}:${t.teacher}`
    case 'counselor': return `counselor:${t.thread}`
  }
}

export type TypingTarget =
  | { scope: 'staff'; peer: string }
  | { scope: 'parent'; student: string; parent: string; teacher: string }
  | { scope: 'counselor'; thread: string }

function keyFromEvent(ev: LiveEvent): string | null {
  const k = ev.keys ?? {}
  switch (ev.scope) {
    case 'staff': return k.peer ? `staff:${k.peer}` : null
    case 'parent': return k.student && k.parent && k.teacher ? `parent:${k.student}:${k.parent}:${k.teacher}` : null
    case 'counselor': return k.thread ? `counselor:${k.thread}` : null
    default: return null
  }
}

/** Whether the other party in this conversation is typing right now. */
export function useTyping(target: TypingTarget | undefined): boolean {
  const key = target ? typingKey(target) : ''
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      // Expiry is time-based, so re-read once a second while anyone listens.
      const t = window.setInterval(cb, 1000)
      return () => { listeners.delete(cb); window.clearInterval(t) }
    },
    () => (key ? (typing.get(key) ?? 0) > Date.now() : false),
    () => false,
  )
}

/* "I am typing to you." Throttled per conversation so a fast typist sends one
   post every few seconds rather than one per keystroke; the server validates
   that the caller is a party to the conversation and fans it to the other. */
const lastSent = new Map<string, number>()
export function sendTyping(target: TypingTarget) {
  const key = typingKey(target)
  const now = Date.now()
  if ((lastSent.get(key) ?? 0) > now - 3000) return
  lastSent.set(key, now)
  void api.post('/api/v1/live/typing', target).catch(() => { /* a hint; never surfaced */ })
}

export function useLiveStream() {
  const qc = useQueryClient()
  useEffect(() => {
    if (typeof window === 'undefined' || !('EventSource' in window)) return
    let es: EventSource | null = null

    const onEvent = (raw: MessageEvent) => {
      let ev: LiveEvent
      try { ev = JSON.parse(raw.data) } catch { return }
      const k = ev.keys ?? {}
      switch (ev.type) {
        case 'message':
          // The principal's All messages desk lists every channel; any
          // message anywhere may change what is waiting there.
          qc.invalidateQueries({ queryKey: ['admin-inbox'] })
          qc.invalidateQueries({ queryKey: ['admin-inbox-thread'] })
          /* Only what this hint touches. The staff screen keys its thread by
             the OTHER person's id: for the recipient that is `from`, for the
             sender's own echo it is `to`. */
          if (ev.scope === 'staff') {
            qc.invalidateQueries({ queryKey: ['staff-threads'] })
            qc.invalidateQueries({ queryKey: ['staff-messages', k.peer] })
            if (k.to) qc.invalidateQueries({ queryKey: ['staff-messages', k.to] })
          } else if (ev.scope === 'parent') {
            qc.invalidateQueries({ queryKey: ['parent-threads'] })
            qc.invalidateQueries({ queryKey: ['parent-messages', k.student] })
            qc.invalidateQueries({ queryKey: ['portal-thread', k.student, k.teacher] })
            qc.invalidateQueries({ queryKey: ['portal-teachers', k.student] })
          } else if (ev.scope === 'counselor') {
            qc.invalidateQueries({ queryKey: ['comms', 'counselor'] })
          }
          // A message is also a notification; the bell should not lag it.
          qc.invalidateQueries({ queryKey: ['notifications'] })
          break
        case 'notification':
          qc.invalidateQueries({ queryKey: ['notifications'] })
          qc.invalidateQueries({ queryKey: ['attention'] })
          break
        case 'typing': {
          const key = keyFromEvent(ev)
          if (key) { typing.set(key, Date.now() + TYPING_TTL_MS); emit() }
          break
        }
      }
    }

    const open = () => {
      if (es || document.hidden) return
      es = new EventSource('/api/v1/live/stream')
      for (const name of ['message', 'notification', 'typing']) es.addEventListener(name, onEvent as EventListener)
      // On error the browser retries by itself; nothing to do but stay quiet.
    }
    const close = () => { es?.close(); es = null }
    const onVisibility = () => { if (document.hidden) close(); else open() }

    open()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      close()
    }
  }, [qc])
}
