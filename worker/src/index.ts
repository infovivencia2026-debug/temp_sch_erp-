import type { Env } from './env'
import { runBatch, type Job } from './services/jobs'
import './services/job-registry'
import { tick } from './services/cron'
import { json } from './env'
import { clearCookie, currentSession, revokeSession } from './auth/session'
import { login, showLogin } from './routes/login'
import { getSession } from './routes/session'
import { buildRouter } from './routes/index'
import { identityFrom, can } from './identity'
import { errorResponse, forbidden, unauthorized } from './http'
import { tenantDb } from './tenant'
import { handleSMSGatewayDevice } from './routes/comms/sms_gateway'
import { handleBusTrackerDevice } from './routes/scheduling/bus_tracker'
import { handlePublic } from './routes/comms/public'
import { handlePages } from './pages/index'
import { groupGate, passwordGate, subscriptionGate } from './gates'
import { idempotent } from './idempotency'

export { LiveHub } from './services/live'

const router = buildRouter()

/* The Worker that replaces the Go server on Cloud Run. Every path the Pages
   proxy (web/functions/[[path]].ts) forwards lands here. Routes are added as
   they are ported; anything not yet ported answers 501 so a missing route is
   loud rather than a silent 404. */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const { pathname } = url
    const m = req.method

    try {
      if (pathname === '/healthz') return new Response('ok')
      if (pathname === '/login' && m === 'GET') return showLogin(env, req)
      if (pathname === '/login' && m === 'POST') return login(env, req)
      /* Public server-rendered pages: password reset, pricing, signup, apps,
         and the second sign-in step. See pages/index.ts. */
      const pageRes = await handlePages(env, req, url)
      if (pageRes) return pageRes
      if (pathname === '/logout') {
        const s = await currentSession(env, req)
        if (s) await revokeSession(env, s.id, 'signed_out')
        return new Response(null, { status: 303, headers: { location: '/login', 'set-cookie': clearCookie(env) } })
      }
      if (pathname === '/api/v1/session' && m === 'GET') return getSession(env, req)
      /* Callers with no session cookie: the Android SMS gateway authenticates
         with its own device token. Checked before the session router. */
      const device = await handleSMSGatewayDevice(env, req, url)
      if (device) return device
      const busTracker = await handleBusTrackerDevice(env, req, url)
      if (busTracker) return busTracker
      const pub = await handlePublic(env, req, url)
      if (pub) return pub
      const hit = router.match(m, pathname)
      if (hit) {
        const id = await identityFrom(env, req)
        if (!id) throw unauthorized()
        if (hit.route.perm !== 'auth' && !can(id, hit.route.perm)) throw forbidden()
        // Go's group-level RequirePermission, password gate and paywall; see gates.ts.
        groupGate(id, pathname)
        passwordGate(id, m, pathname)
        await subscriptionGate(env, id, pathname)
        let db: D1Database | null = null
        const ctx = { req, env, url, params: hit.params, id,
          get db() { if (!db) { if (!id.institution) throw forbidden('no school in scope'); db = tenantDb(env, id.institution) } return db } }
        // Go's Idempotent middleware sits after the gates, around the handler.
        return await idempotent(req, id, () => ctx.db, async (r) => { ctx.req = r; return hit.route.handler(ctx) })
      }
      if (pathname.startsWith('/api/')) return json({ error: 'not ported to Workers yet', path: pathname }, 501)
      return new Response('Not Found', { status: 404 })
    } catch (err) {
      return errorResponse(err)
    }
  },

  /* Background jobs: see src/services/jobs.ts. */
  async queue(batch: MessageBatch<Job>, env: Env): Promise<void> {
    await runBatch(batch, env)
  },

  /* Cron Trigger, every minute: replaces Cloud Scheduler's call to
     /api/v1/cron. See src/services/cron.ts. */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tick(env, new Date(event.scheduledTime)).then(() => undefined))
  },
} satisfies ExportedHandler<Env, Job>
