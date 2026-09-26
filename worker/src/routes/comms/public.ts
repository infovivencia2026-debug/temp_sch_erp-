import type { Env } from '../../env'
import { handleSMSGatewayPublic } from './sms_gateway_public'
import { sendPublicTestMessage } from './message_test'
import { publicErrorResponse } from './public_common'
import { handlePublicAdmissionForms } from '../admissions/public_forms'

/**
 * The sessionless /api/v1/public/... routes: the SMS gateway's claim and
 * enrol, the keyed message-test link, and the public admission form. Returns
 * null for any other request. Wire it in index.ts before router.match:
 *   const pub = await handlePublic(env, req, url); if (pub) return pub
 */
export async function handlePublic(env: Env, req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname.replace(/\/$/, '')
  if (!p.startsWith('/api/v1/public/')) return null
  const gw = await handleSMSGatewayPublic(env, req, p)
  if (gw) return gw
  if (p === '/api/v1/public/message-test' && req.method === 'POST') {
    try { return await sendPublicTestMessage(env, req) } catch (err) { return publicErrorResponse(err) }
  }
  return handlePublicAdmissionForms(env, req, p)
}
