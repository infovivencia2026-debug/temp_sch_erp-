import type { Env } from './env'
import { runBatch, type Job } from './services/jobs'
import './services/job-registry'
import { tick } from './services/cron'
import { json } from './env'
import { clearCookie, currentSession, revokeSession } from './auth/session'
import { homeOf, login, schoolAppConfig, schoolLogin, schoolLogo, showLogin } from './routes/login'
import { getSession } from './routes/session'
import { getBootstrap } from './routes/bootstrap'
import { buildRouter } from './routes/index'
import { identityFrom, can, type Identity } from './identity'
import { HttpError, errorResponse, forbidden, unauthorized, unexpectedError } from './http'
import { newErrorRef, recordErrorRef } from './services/error_refs'
import { tenantSession, type TenantSession } from './tenant'
import { handleSMSGatewayDevice } from './routes/comms/sms_gateway'
import { handleBusTrackerDevice } from './routes/scheduling/bus_tracker'
import { handlePublic } from './routes/comms/public'
import { handlePages } from './pages/index'
import { groupGate, passwordGate, subscriptionGate } from './gates'
import { idempotent } from './idempotency'
import { recordServerError } from './services/background/health'
import { consumeDeadLetters } from './services/dead_letters'
import { normalizeRequest, originRefused } from './origin'
import { PLATFORM_SCOPE, bumpVersion, watchAuthWrites } from './idcache'

export { LiveHub } from './services/live'

const router = buildRouter()
const SCHOOL_ROUTE = /^\/([a-z]{2})\/([a-z0-9][a-z0-9-]{0,62})(\/logo|\/app\.json)?\/?$/

/* The Worker that replaces the Go server on Cloud Run. Every path the Pages
   proxy (web/functions/[[path]].ts) forwards lands here. Routes are added as
   they are ported; anything not yet ported answers 501 so a missing route is
   loud rather than a silent 404. */
export default {
  async fetch(incoming: Request, env: Env, ectx?: ExecutionContext): Promise<Response> {
    // The caller's address settled and the origin secret checked (origin.ts).
    const { req, verified } = normalizeRequest(env, incoming)
    const url = new URL(req.url)
    const { pathname } = url
    const m = req.method
    let schoolId: string | undefined
    let who: Identity | null = null

    try {
      if (pathname === '/healthz') return new Response('ok')
      if (originRefused(env, pathname, verified)) return new Response('Not Found', { status: 404 })
      if (pathname === '/login' && m === 'GET') return showLogin(env, req)
      if (pathname === '/login' && m === 'POST') return login(env, req)
      /* Public server-rendered pages: password reset, pricing, signup, apps,
         and the second sign-in step. See pages/index.ts. */
      const pageRes = await handlePages(env, req, url)
      if (pageRes) return pageRes
      if (pathname === '/logout') {
        const s = await currentSession(env, req)
        if (s) await revokeSession(env, s.id, 'signed_out')
        return new Response(null, { status: 303, headers: { location: homeOf(req) ?? '/login', 'set-cookie': clearCookie(env) } })
      }
      /* A school's own address: /<country>/<slug> is its sign-in page and
         /<country>/<slug>/logo its logo and
         /<country>/<slug>/app.json what its own apps are built from. See routes/login.ts. */
      const school = SCHOOL_ROUTE.exec(pathname)
      if (school) {
        const res = !school[3] ? await schoolLogin(env, req, school[1], school[2])
          : m !== 'GET' ? null
          : school[3] === '/logo' ? await schoolLogo(env, school[1], school[2])
          : await schoolAppConfig(env, req, school[1], school[2])
        if (res) return res
      }
      if (pathname === '/api/v1/session' && m === 'GET') return getSession(env, req)
      if (pathname === '/api/v1/bootstrap' && m === 'GET') return getBootstrap(env, req, router, ectx)
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
        const id = await identityFrom(env, req, ectx)
        if (!id) throw unauthorized()
        schoolId = id.institution?.id
        who = id
        // A Quick Assist session reads and does nothing else; ending it is the one write it may make.
        if (id.readOnly && m !== 'GET' && m !== 'HEAD' && !/\/impersonation\/[^/]+\/end$/.test(pathname)) {
          throw new HttpError(403, 'this support session can only look. Nothing can be changed during it.', { code: 'read_only_session' })
        }
        if (hit.route.perm !== 'auth' && !can(id, hit.route.perm)) throw forbidden()
        // Go's group-level RequirePermission, password gate and paywall; see gates.ts.
        groupGate(id, pathname)
        passwordGate(id, m, pathname)
        await subscriptionGate(env, id, pathname)
        // The school's database opens lazily, in a D1 Session (tenant.ts tenantSession: replicas + bookmark).
        let tx: TenantSession | null = null
        let watch: ReturnType<typeof watchAuthWrites> | null = null
        const ctx = { req, env, url, params: hit.params, id,
          get db() { if (!tx) { if (!id.institution) throw forbidden('no school in scope'); tx = tenantSession(env, id.institution, req); watch = watchAuthWrites(tx.db) } return watch!.db } }
        // Go's Idempotent middleware sits after the gates, around the handler.
        const res = await idempotent(req, id, () => ctx.db, async (r) => { ctx.req = r; return hit.route.handler(ctx) })
        if (res.status >= 500 && res.status !== 501) await recordServerError(env, schoolId, pathname)
        /* Who may do what changed: every isolate's cached identities of this
           school (or, for a platform account's write, of every school) go. */
        if (m !== 'GET' && m !== 'HEAD' && res.status < 400) {
          const w = watch as ReturnType<typeof watchAuthWrites> | null
          if (w?.dirty() && id.institution) await bumpVersion(env, id.institution.id)
          if (id.platformAdmin) await bumpVersion(env, PLATFORM_SCOPE)
        }
        return (tx as TenantSession | null)?.finish(res) ?? res
      }
      if (pathname.startsWith('/api/')) return json({ error: 'not ported to Workers yet', path: pathname }, 501)
      return new Response('Not Found', { status: 404 })
    } catch (err) {
      /* An unexpected error gets a reference the person can read out; what
         happened is kept under it for the desk (services/error_refs.ts). */
      const ref = unexpectedError(err) ? newErrorRef() : undefined
      const res = errorResponse(err, ref)
      if (ref) await recordErrorRef(env, ref, req, pathname, who, err)
      if (res.status >= 500 && res.status !== 501) await recordServerError(env, schoolId, pathname)
      return res
    }
  },

  /* Background jobs: see src/services/jobs.ts. */
  async queue(batch: MessageBatch<Job>, env: Env): Promise<void> {
    // The dead-letter queue: record, alert, ack (src/services/dead_letters.ts).
    if (batch.queue.endsWith('-dlq')) return consumeDeadLetters(batch, env)
    await runBatch(batch, env)
  },

  /* Cron Trigger, every minute: replaces Cloud Scheduler's call to
     /api/v1/cron. See src/services/cron.ts. */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tick(env, new Date(event.scheduledTime)).then(() => undefined))
  },
} satisfies ExportedHandler<Env, Job>
