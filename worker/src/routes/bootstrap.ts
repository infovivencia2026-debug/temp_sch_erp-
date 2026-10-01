import type { Env } from '../env'
import { json } from '../env'
import type { BootstrapResponse } from '@shared/api'
import type { Ctx, Router } from '../router'
import { can, identityFrom } from '../identity'
import { HttpError, forbidden } from '../http'
import { groupGate, passwordGate, subscriptionGate } from '../gates'
import { tenantSession, type TenantSession } from '../tenant'
import { sessionBody } from './session'
import { getCatalog, workingYearBody } from './misc/shell'
import { displayPreferencesBody } from './portal/life'
import { attentionBody } from './admin/loose'
import { rollupsTodayBody } from './growth/rollups'
import { omitNull } from './growth/common'

/* GET /api/v1/bootstrap: the first screen's six calls in one response
   (shared/api/bootstrap.ts). Each part is built by the helper its own
   endpoint uses, and is let through exactly the gates that endpoint is:
   the route's permission as registered in the router, the group
   permission, the password gate and the subscription and feature gates.
   A part its endpoint would refuse is null. Answered before the router
   (like GET /session) so a visitor with no session still gets
   { session: { authenticated: false } }. */

const API = '/api/v1'

export async function getBootstrap(env: Env, req: Request, router: Router, ectx?: ExecutionContext): Promise<Response> {
  const url = new URL(req.url)
  const id = await identityFrom(env, req, ectx)
  const session = sessionBody(env, req)
  if (!id) {
    return json({ session: await session, catalog: null, display_preferences: null, working_year: null, attention: null, today: null } satisfies BootstrapResponse)
  }

  let tx: TenantSession | null = null
  const c: Ctx = {
    req, env, url, params: {}, id,
    get db() { if (!tx) { if (!id.institution) throw forbidden('no school in scope'); tx = tenantSession(env, id.institution, req) } return tx.db },
  }

  /** One part: null when GET <path> would have been refused. */
  const part = async <T>(path: string, build: (c: Ctx) => Promise<T>): Promise<T | null> => {
    const full = API + path
    try {
      const hit = router.match('GET', full)
      if (!hit) return null
      if (hit.route.perm !== 'auth' && !can(id, hit.route.perm)) return null
      groupGate(id, full)
      passwordGate(id, 'GET', full)
      await subscriptionGate(env, id, full)
      return await build(c)
    } catch (err) {
      if (err instanceof HttpError) return null
      console.error('bootstrap part failed', path, err)
      return null
    }
  }

  const [s, catalog, display, working, attention, today] = await Promise.all([
    session,
    part('/catalog', getCatalog),
    part('/portal/preferences/display', displayPreferencesBody),
    part('/working-year', workingYearBody),
    part('/attention', (c) => attentionBody(c, '')),
    part('/rollups/today', (c) => rollupsTodayBody(c) as unknown as Promise<BootstrapResponse['today']>),
  ])
  const body: BootstrapResponse = {
    session: s, catalog, display_preferences: display, working_year: working, attention,
    today: today ? (omitNull(today as unknown as Record<string, unknown>) as unknown as BootstrapResponse['today']) : null,
  }
  const res = json(body)
  return (tx as TenantSession | null)?.finish(res) ?? res
}
