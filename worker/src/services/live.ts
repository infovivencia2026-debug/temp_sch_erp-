/* Live updates: the Worker's replacement for internal/live (Postgres
   LISTEN/NOTIFY + the per-instance Broker) and the SSE handler in
   internal/api/live_stream.go.

   One LiveHub Durable Object per school (idFromName(institution_id)) holds
   every open GET /api/v1/live/stream of that school. A writer calls
   publish(env, institutionId, event); the hub writes the event to every
   stream held by a user the event names. As in Go an event is a hint (ids
   and short keys, never message bodies); the client refetches, and the 30s
   revision poll stays the fallback, so a dropped event costs staleness only.

   Wire format is Go's exactly:
     ": hello\n\n" on open, ": ping\n\n" every 20s,
     "id: <unix ms>\nevent: <type>\ndata: {type,scope,from,keys,at}\n\n". */

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'

export interface LiveEvent {
  /** Who should receive it (user ids). */
  users: string[]
  /** message | read | typing | notification */
  type: string
  /** staff | parent | counselor | '' */
  scope: string
  from: string
  keys?: Record<string, string>
  /** ISO time; defaults to now. */
  at?: string
}

const enc = new TextEncoder()

interface Sub { user: string; w: WritableStreamDefaultWriter<Uint8Array> }

export class LiveHub extends DurableObject<Env> {
  private subs = new Set<Sub>()
  private pinger: ReturnType<typeof setInterval> | null = null

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/stream') return this.stream(url.searchParams.get('user') ?? '', req)
    if (url.pathname === '/publish' && req.method === 'POST') {
      this.fan(await req.json<LiveEvent>())
      return new Response(null, { status: 204 })
    }
    return new Response('not found', { status: 404 })
  }

  private stream(user: string, req: Request): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const sub: Sub = { user, w: writable.getWriter() }
    this.subs.add(sub)
    // Something on the wire immediately, so the browser fires `open`.
    this.write(sub, ': hello\n\n')
    req.signal?.addEventListener('abort', () => this.drop(sub))
    if (!this.pinger) {
      this.pinger = setInterval(() => {
        for (const s of this.subs) this.write(s, ': ping\n\n')
        if (this.subs.size === 0 && this.pinger) { clearInterval(this.pinger); this.pinger = null }
      }, 20_000)
    }
    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    })
  }

  private write(sub: Sub, text: string): void {
    sub.w.write(enc.encode(text)).catch(() => this.drop(sub))
  }

  private drop(sub: Sub): void {
    if (!this.subs.delete(sub)) return
    sub.w.close().catch(() => {})
  }

  private fan(ev: LiveEvent): void {
    const at = ev.at ?? new Date().toISOString()
    const users = new Set(ev.users.map((u) => u.toLowerCase()))
    // Go formats `at` as RFC3339 (seconds); keep the same shape.
    const atOut = at.replace(/\.\d+Z$/, 'Z')
    const body = JSON.stringify({ type: ev.type, scope: ev.scope, from: ev.from, keys: ev.keys ?? null, at: atOut })
    const frame = `id: ${Date.parse(at)}\nevent: ${ev.type}\ndata: ${body}\n\n`
    for (const s of this.subs) if (users.has(s.user)) this.write(s, frame)
  }
}

function hub(env: Env, institutionId: string): DurableObjectStub {
  return env.LIVE.get(env.LIVE.idFromName(institutionId))
}

/** Opens a stream for this user on the school's hub. */
export function openLiveStream(env: Env, institutionId: string, userId: string, req: Request): Promise<Response> {
  const u = new URL('https://live/stream')
  u.searchParams.set('user', userId.toLowerCase())
  return hub(env, institutionId).fetch(u.toString(), { signal: req.signal })
}

/** Puts a hint on the school's hub. Never throws: a write whose hint did not
    go out is still a write, and the poll picks it up (publishLive in Go). */
export async function publish(env: Env, institutionId: string | undefined | null, ev: LiveEvent): Promise<void> {
  if (!institutionId || ev.users.length === 0) return
  try {
    await hub(env, institutionId).fetch('https://live/publish', { method: 'POST', body: JSON.stringify(ev) })
  } catch (err) {
    console.warn('live: publish failed', ev.type, String(err))
  }
}
