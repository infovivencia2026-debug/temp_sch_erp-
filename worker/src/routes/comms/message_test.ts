import { json, type Env } from '../../env'
import { queueMessage } from '../../services/messaging'
import { allTenants, constantTimeEqual, decodeStrict, goBadRequest, goNotFound, rateLimited, type Tenant } from './public_common'

/* Port of sendPublicTestMessage (message_test_link.go): POST
   /api/v1/public/message-test, a keyed link with no session. Every guard is
   ported: the key (HMAC of the institution id under SESSION_SECRET, as
   admin/whatsapp.ts mints it), the ten-an-hour limit per key, the field
   checks, and the 404 on a school whose recipient guard is not in allowlist
   mode. The send goes through services/messaging.ts queueMessage. */

const WINDOW_S = 3600, BURST = 10 // messageTestLinkPolicy

async function hmacHex(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)))
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** messageTestKey: '' when SESSION_SECRET is not set. */
async function messageTestKey(env: Env, inst: string): Promise<string> {
  const secret = env.SESSION_SECRET
  if (typeof secret !== 'string' || secret.trim() === '') return ''
  return (await hmacHex(secret, 'message-test:' + inst)).slice(0, 32)
}

interface TestSend { key?: string; channel?: string; to?: string; body?: string }

export async function sendPublicTestMessage(env: Env, req: Request): Promise<Response> {
  const body = await decodeStrict<TestSend>(req, { key: 'string', channel: 'string', to: 'string', body: 'string' })
  if (body instanceof Response) return body
  const key = (body.key ?? '').trim()
  if (key === '') return goNotFound()

  // Every school is checked, in constant time, rather than the id riding in the URL.
  let found: Tenant | null = null
  for (const t of await allTenants(env)) {
    const k = await messageTestKey(env, t.inst.id)
    if (k !== '' && constantTimeEqual(k, key)) found = t
  }
  if (!found) return goNotFound()

  const limited = await rateLimited(env, 'message_test_link', WINDOW_S, BURST, key, 'ten test messages an hour is the limit on this link')
  if (limited) return limited

  const channel = (body.channel ?? '').trim(), to = (body.to ?? '').trim()
  if (channel === '' || to === '') return goBadRequest('a channel and an address are required')

  const g = await found.db.prepare(`SELECT COALESCE(mode, 'allowlist') AS mode FROM messaging_recipient_policy WHERE institution_id = ?`)
    .bind(found.inst.id).first<{ mode: string }>()
  const guard = g?.mode ?? ''
  // 404, not 403: a 403 confirms the link is real to somebody who should not know that.
  if (guard !== '' && guard !== 'allowlist') return goNotFound()

  const text = (body.body ?? '').trim() || 'This is a test message from the school office.'
  const res = await queueMessage({ env, db: found.db, inst: found.inst.id }, {
    channel, template_code: 'messaging.test', vars: { school_name: 'your school', body: text }, recipient: to, source_kind: 'test_link',
  })
  return json({ queued: true, id: res.id ?? '00000000-0000-0000-0000-000000000000', duplicate: res.duplicate,
    note: 'Queued. The recipient allowlist still applies, so an address ' +
      'that is not on it is recorded and held rather than sent.' })
}
