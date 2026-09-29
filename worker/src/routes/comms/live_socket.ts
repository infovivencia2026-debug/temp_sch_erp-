import type { Router } from '../../router'
import { openLiveSocket, LIVE_TOPICS } from '../../services/live'

/* GET /live/socket: the WebSocket side of the school's LiveHub
   (services/live.ts), accepted with hibernation. Same hints as
   /live/stream, plus topics a screen asks for with ?topics=transport (the
   bus map refetches when a bus reports instead of polling). Session cookie
   only, as the stream. A platform operator with no school is held on a hub
   nobody publishes to. */
export function registerLiveSocket(r: Router): void {
  r.get('/live/socket', 'auth', async (c) => {
    const topics = (c.url.searchParams.get('topics') ?? '').split(',').filter((t) => (LIVE_TOPICS as readonly string[]).includes(t))
    return openLiveSocket(c.env, c.id.institution?.id ?? 'platform:none', c.id.userId, topics, c.req)
  })
}
