import { useEffect, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'

/* THE OTHER END OF THE LIVE BUS.

   One EventSource per tab on /api/v1/live/stream. The server sends a hint —
   "a message landed in this thread", "this person is typing", "you have a
   notification" — and this file turns each hint into the smallest refetch
   that shows it: the exact query keys the messaging screens use, not the
   blanket invalidate the 30s revision poll does. The poll stays; this is
   what makes the gap between the two ends of a conversation a second rather
   than half a minute.

   AND THE RULE EVERY PHONE FOLLOWS. A message that lands in the conversation
   you are looking at just appears. A message that lands anywhere else gets a
   notification — a card in the corner naming who wrote, and the phone's own
   notification where the person has allowed it — and tapping either opens
   that conversation. Whether "you are looking at it" is decided here, from
   which threads have a ChatThread mounted and whether the tab is visible.

   Cookie-authenticated like every other call, through the same Pages proxy.
   Closed while the tab is hidden and reopened when it is seen again, exactly
   as the poll pauses; the browser reconnects on its own if the server cuts
   the request, and a missed hint costs nothing but a poll's worth of delay. */

type LiveEvent = {
  type: 'message' | 'typing' | 'notification' | 'read'
  scope?: 'staff' | 'parent' | 'counselor' | ''
  from: string
  keys?: Record<string, string>
  at: string
}

export type TypingTarget =
  | { scope: 'staff'; peer: string }
  | { scope: 'parent'; student: string; parent: string; teacher: string }
  | { scope: 'counselor'; thread: string }

/** The key a conversation is known by, on both sides of the bus. */
export function typingKey(t: TypingTarget): string {
  switch (t.scope) {
    case 'staff': return `staff:${t.peer}`
    case 'parent': return `parent:${t.student}:${t.parent}:${t.teacher}`
    case 'counselor': return `counselor:${t.thread}`
  }
}

/* Which conversations are on screen right now. A ChatThread registers its
   target through useTyping while it is mounted; a message for one of these
   is drawn in place and not announced. */
const openConversations = new Map<string, number>()

/* Who is typing to me, keyed by conversation. Entries expire on their own so a
   tab that closed mid-word never leaves "typing…" on the screen. */
const TYPING_TTL_MS = 5000
const typing = new Map<string, number>()
const listeners = new Set<() => void>()
function emit() { for (const l of listeners) l() }

function keyFromEvent(ev: LiveEvent): string | null {
  const k = ev.keys ?? {}
  switch (ev.scope) {
    case 'staff': return k.peer ? `staff:${k.peer}` : null
    case 'parent': return k.student && k.parent && k.teacher ? `parent:${k.student}:${k.parent}:${k.teacher}` : null
    case 'counselor': return k.thread ? `counselor:${k.thread}` : null
    default: return null
  }
}

/* SEEN. Opening a conversation is reading it: the bell entries that pointed
   at it are marked read on the server, the corner card for it goes, and the
   bell count refetches — so a person who has just read the messages is not
   also told about them. Throttled per conversation; the server call is one
   UPDATE. */
const lastSeen = new Map<string, number>()
let invalidateNotifications: (() => void) | null = null
function markSeen(target: TypingTarget) {
  const key = typingKey(target)
  const idOf = target.scope === 'staff' ? target.peer : target.scope === 'parent' ? target.student : target.thread
  toasts = toasts.filter((t) => !t.href.includes(idOf))
  emitToasts()
  const now = Date.now()
  if ((lastSeen.get(key) ?? 0) > now - 15000) return
  lastSeen.set(key, now)
  void api.post('/api/v1/live/seen', target)
    .then(() => invalidateNotifications?.())
    .catch(() => { /* a courtesy; the bell's own read-on-open still applies */ })
}

/** Whether the other party in this conversation is typing right now. Also
    marks the conversation as open on this screen for as long as it is used,
    and as seen. */
export function useTyping(target: TypingTarget | undefined): boolean {
  const key = target ? typingKey(target) : ''
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      if (key && target) {
        openConversations.set(key, (openConversations.get(key) ?? 0) + 1)
        markSeen(target)
      }
      // Expiry is time-based, so re-read once a second while anyone listens.
      const t = window.setInterval(cb, 1000)
      return () => {
        listeners.delete(cb)
        window.clearInterval(t)
        if (key) {
          const n = (openConversations.get(key) ?? 1) - 1
          if (n <= 0) openConversations.delete(key)
          else openConversations.set(key, n)
        }
      }
    },
    () => (key ? (typing.get(key) ?? 0) > Date.now() : false),
    () => false,
  )
}

/* "I am typing to you." Throttled per conversation so a fast typist sends one
   post every few seconds rather than one per keystroke; the server validates
   that the caller is a party to the conversation and fans it to the other.
   A keystroke is also the one user gesture the browser accepts for asking
   permission to show notifications, so the first one asks — once. */
const lastSent = new Map<string, number>()
export function sendTyping(target: TypingTarget) {
  askNotificationPermission()
  const key = typingKey(target)
  const now = Date.now()
  if ((lastSent.get(key) ?? 0) > now - 3000) return
  lastSent.set(key, now)
  void api.post('/api/v1/live/typing', target).catch(() => { /* a hint; never surfaced */ })
}

let asked = false
function askNotificationPermission() {
  if (asked || typeof Notification === 'undefined') return
  asked = true
  if (Notification.permission === 'default') {
    try { void Notification.requestPermission() } catch { /* older browsers */ }
  }
}

/* ---- The in-app notification cards ------------------------------------- */

export interface LiveToast {
  id: number
  title: string
  body: string
  href: string
  at: number
}
let toasts: LiveToast[] = []
const toastListeners = new Set<() => void>()
function emitToasts() { for (const l of toastListeners) l() }
let toastSeq = 1

export function useLiveToasts(): LiveToast[] {
  return useSyncExternalStore(
    (cb) => { toastListeners.add(cb); return () => { toastListeners.delete(cb) } },
    () => toasts,
    () => toasts,
  )
}
export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emitToasts()
}
function pushToast(t: Omit<LiveToast, 'id' | 'at'>) {
  const toast = { ...t, id: toastSeq++, at: Date.now() }
  // One card per conversation: a second message replaces the first rather
  // than stacking a column of them.
  toasts = [...toasts.filter((x) => x.href !== t.href), toast].slice(-4)
  emitToasts()
  window.setTimeout(() => dismissToast(toast.id), 9000)
}

/** SPA navigation without a component: push the URL and tell the router. */
export function goTo(href: string) {
  window.history.pushState({}, '', href)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/* Where a tap should land, from the recipient's side of the conversation. */
function hrefFor(ev: LiveEvent, me: string | undefined): string | null {
  const k = ev.keys ?? {}
  switch (ev.scope) {
    case 'staff':
      return `/go/communication/messages?with=${ev.from}`
    case 'parent':
      if (!k.student || !k.parent || !k.teacher) return null
      return me === k.parent
        ? `/go/messages/communication?tab=teacher&student_id=${k.student}&teacher_user_id=${k.teacher}`
        : `/go/messages?box=parents&child=${k.student}&with=${k.parent}`
    case 'counselor':
      return k.thread ? `/go/counselling/family_conversations?thread=${k.thread}` : null
    default:
      return null
  }
}

function announce(ev: LiveEvent, me: string | undefined) {
  const key = keyFromEvent(ev)
  // Looking at it already: it appears in place, and that is the notification.
  // Mark it seen too, so the bell entry this message just created goes with it.
  if (key && openConversations.has(key) && document.visibilityState === 'visible') {
    const t = targetFromEvent(ev)
    if (t) { lastSeen.delete(key); markSeen(t) }
    return
  }
  const href = hrefFor(ev, me)
  if (!href) return
  const who = ev.keys?.from_name || 'Someone'
  const about = ev.keys?.child ? ` about ${ev.keys.child}` : ''
  const title = ev.scope === 'counselor' ? who : `New message from ${who}`
  const body = ev.scope === 'counselor' ? 'A new message in the conversation' : `Tap to open the conversation${about}`
  pushToast({ title, body, href })
  // The phone's own notification too, where allowed — so a message reaches a
  // person whose screen is on another app, which is how WhatsApp is read.
  void showSystemNotification(title, body, key ?? href, href)
}

/* THE PHONE'S OWN BANNER.

   `new Notification()` is the desktop way and it throws on Android Chrome --
   "Illegal constructor" -- which is exactly the phone every parent here
   holds. On a phone a notification is shown by the service worker, with the
   link carried in `data`, and the worker's notificationclick opens it (see
   sw-src.js). The constructor stays as the fallback for a browser with no
   worker, and a failure of either is silent: the in-app card is already up. */
async function showSystemNotification(title: string, body: string, tag: string, href: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
    if (reg && 'showNotification' in reg) {
      await reg.showNotification(title, { body, tag, data: { href }, icon: '/app/icon-192.png', badge: '/app/icon-192.png' })
      return
    }
  } catch { /* fall through to the constructor */ }
  try {
    const n = new Notification(title, { body, tag })
    n.onclick = () => { window.focus(); goTo(href); n.close() }
  } catch { /* not available here */ }
}

/* A tap on the worker's banner arrives here as a message; the page then
   navigates the way the in-app card does. Installed once per page. */
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; href?: string } | null
    if (d?.type === 'erp-open' && typeof d.href === 'string' && d.href.startsWith('/')) goTo(d.href)
  })
}

/* The conversation an event belongs to, as a target — so a message that
   lands in an OPEN thread can be marked seen the moment it is drawn. */
function targetFromEvent(ev: LiveEvent): TypingTarget | null {
  const k = ev.keys ?? {}
  switch (ev.scope) {
    case 'staff': return { scope: 'staff', peer: ev.from }
    case 'parent': return k.student && k.parent && k.teacher
      ? { scope: 'parent', student: k.student, parent: k.parent, teacher: k.teacher } : null
    case 'counselor': return k.thread ? { scope: 'counselor', thread: k.thread } : null
    default: return null
  }
}

export function useLiveStream() {
  const qc = useQueryClient()
  const me = useSession().user?.id
  useEffect(() => {
    invalidateNotifications = () => {
      qc.invalidateQueries({ queryKey: ['notifications'] })
      qc.invalidateQueries({ queryKey: ['attention'] })
    }
    return () => { invalidateNotifications = null }
  }, [qc])
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
          qc.invalidateQueries({ queryKey: ['admin-inbox-staff-thread'] })
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
          qc.invalidateQueries({ queryKey: ['attention'] })
          // Announce it unless it is our own echo or the thread is on screen.
          if (ev.from && ev.from !== me) announce(ev, me)
          break
        case 'read':
          /* The other side has seen it: the sender's thread refetches so the
             tick turns blue now rather than on the next poll. Nothing else
             changes, so nothing else is invalidated and nothing is announced
             -- being read is not an event anybody needs told about. */
          if (ev.scope === 'staff') {
            qc.invalidateQueries({ queryKey: ['staff-messages', k.peer] })
            if (k.to) qc.invalidateQueries({ queryKey: ['staff-messages', k.to] })
            qc.invalidateQueries({ queryKey: ['staff-threads'] })
          } else if (ev.scope === 'parent') {
            qc.invalidateQueries({ queryKey: ['parent-messages', k.student] })
            qc.invalidateQueries({ queryKey: ['portal-thread', k.student, k.teacher] })
            qc.invalidateQueries({ queryKey: ['parent-threads'] })
          }
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
      for (const name of ['message', 'read', 'notification', 'typing']) es.addEventListener(name, onEvent as EventListener)
      // On error the browser retries by itself; nothing to do but stay quiet.
    }
    const close = () => { es?.close(); es = null }
    /* KEPT OPEN WHILE THE TAB IS HIDDEN — that is the whole point.

       The message a person needs told about is the one that lands while they
       are in another app. Closing the stream on hide (as the poll pauses) would
       silence exactly that case; the phone's notification can only fire if the
       hint arrives. One held connection per tab is the price, and it is the
       price every chat app pays. On becoming visible, reconnect if the browser
       let it drop. */
    const onVisibility = () => { if (!document.hidden) open() }

    open()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      close()
    }
  }, [qc, me])
}
