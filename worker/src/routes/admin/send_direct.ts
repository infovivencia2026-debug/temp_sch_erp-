import type { Ctx, Router } from '../../router'
import { HttpError, badRequest, ok, readJSON } from '../../http'
import { dispatchMessages, queueMessage, scopeOf } from '../../services/messaging'

/* Port of messaging_direct.go: POST /messaging/send-direct (comms.messages.send).
   Queues "messaging.direct" through services/messaging.ts and dispatches the
   school's queue at once, as Go did. */

const tr = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export async function sendDirect(c: Ctx): Promise<Response> {
  const req = await readJSON<Record<string, unknown>>(c.req)
  const to = tr(req.to), text = tr(req.text)
  const channel = tr(req.channel) || 'sms'
  if (channel !== 'sms' && channel !== 'email' && channel !== 'whatsapp') throw badRequest('channel must be sms, email or whatsapp')
  if (to === '') throw badRequest('a recipient is required')
  if (text === '') throw badRequest('a message is required')
  if (channel === 'sms' && new TextEncoder().encode(text).length > 480) throw badRequest('message is too long -- keep it under 480 characters')
  const subject = tr(req.subject) || 'Message from school'
  const m = scopeOf(c)
  let id: string | null
  try {
    id = (await queueMessage(m, { channel, template_code: 'messaging.direct', vars: { text, subject }, recipient: to })).id
  } catch (e) {
    throw new HttpError(409, (e as Error).message, { code: 'not_sent' })
  }
  const out: Record<string, unknown> = { id: id ?? '00000000-0000-0000-0000-000000000000', sent: 0, failed: 0 }
  try {
    const r = await dispatchMessages(m.env, m.db, m.inst, 25)
    out.sent = r.sent; out.failed = r.failed
  } catch (e) { out.dispatch_error = (e as Error).message }
  return ok(out)
}

export function registerSendDirect(r: Router): void {
  r.post('/messaging/send-direct', 'comms.messages.send', sendDirect)
}
