/* Cheap, reliable, non-spammy messaging (services/delivery.ts, messaging.ts,
   digest.ts, routes/comms/message_webhooks.ts): dedup, digest batching,
   quiet hours, the channel ladder's fallback, a provider webhook moving a
   status, and the honest channel status. Providers are stubbed: every
   fetch is answered here and nothing leaves the test. */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { seed, api, IDS, E } from './fixture'
import type { Env } from '../../src/env'
import { Messenger, dispatchMessages } from '../../src/services/messaging'
import { channelStatus } from '../../src/services/delivery'
import { runDigest } from '../../src/services/digest'
import { whatsappWebhook } from '../../src/routes/comms/message_webhooks'

beforeAll(seed)

const db = E.TENANT_TEST
const inst = IDS.school
const noQueue = { send: async () => {}, sendBatch: async () => {} } as unknown as Queue
const PROVIDERS = JSON.stringify({
  whatsapp: { phone_number_id: '1234567890', allow_free_text: true, secret: 'test-token' },
  sms: { endpoint: 'https://sms.invalid/send', params: { to: '{to}', text: '{text}' }, secret: 'test-key' },
})
/** A test env: stubbed providers, no real queue, no push. */
const envWith = (extra: Record<string, unknown> = {}) =>
  ({ ...E, JOBS: noQueue, FCM_SERVICE_ACCOUNT: '', PLATFORM_PROVIDERS: PROVIDERS, RESEND_API_KEY: '', ...extra }) as unknown as Env

let calls: { url: string; body: string }[] = []
let waAnswer: () => Response = () => Response.json({ messages: [{ id: 'wamid.TEST' + calls.length }] })

beforeEach(async () => {
  calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push({ url, body: String(init?.body ?? '') })
    if (url.includes('graph.facebook.com')) return waAnswer()
    if (url.startsWith('https://sms.invalid/')) return Response.json({ request_id: 'sms-' + calls.length })
    return new Response('blocked in tests', { status: 599 })
  })
  await db.batch([
    db.prepare(`DELETE FROM message_log`), db.prepare(`DELETE FROM message_digest_items`), db.prepare(`DELETE FROM message_events`),
    db.prepare(`DELETE FROM message_settings`), db.prepare(`DELETE FROM message_policies`), db.prepare(`DELETE FROM push_tokens`),
    db.prepare(`DELETE FROM messaging_recipient_policy`),
    db.prepare(`INSERT INTO message_settings (institution_id, digest_time, quiet_from, quiet_to, daily_cap, dedup_minutes) VALUES (?, '18:00', NULL, NULL, 0, 360)`).bind(inst),
    db.prepare(`UPDATE users SET phone = '9876543210' WHERE id = ?`).bind(IDS.parent),
    db.prepare(`INSERT INTO message_credits (institution_id, channel, balance, low_water) VALUES (?, 'whatsapp', 50, 0), (?, 'sms', 50, 0)
      ON CONFLICT (institution_id, channel) DO UPDATE SET balance = 50`).bind(inst, inst),
  ])
})
afterEach(() => { vi.restoreAllMocks(); waAnswer = () => Response.json({ messages: [{ id: 'wamid.TEST' + calls.length }] }) })

const rows = () => db.prepare(`SELECT id, channel, status, send_after, fallback_of, template_code, provider_msg_id FROM message_log ORDER BY queued_at, rowid`)
  .all<{ id: string; channel: string; status: string; send_after: string | null; fallback_of: string | null; template_code: string; provider_msg_id: string | null }>().then((r) => r.results)

describe('no spam', () => {
  it('drops the same alert to the same person inside the window', async () => {
    const ms = new Messenger({ env: envWith(), db, inst })
    const req = { channel: 'sms', template_code: 'fees.overdue', to_user_id: IDS.parent, vars: { student_name: 'Asha', amount_due: 'Rs 10', invoice_no: 'I1', due_on: 'today' } }
    const a = await ms.queue(req)
    const b = await ms.queue({ ...req, channel: 'email' })
    expect(a.duplicate).toBe(false)
    expect(b.duplicate).toBe(true)
    expect((await rows()).length).toBe(1)
  })

  it('bundles non-urgent notices into one digest message at the school time', async () => {
    const env = envWith()
    const ms = new Messenger({ env, db, inst })
    for (const title of ['Sports day', 'PTM moved']) {
      const r = await ms.queue({ channel: 'auto', template_code: 'announcement.published', to_user_id: IDS.parent, vars: { title, body: title + ' details' },
        source_kind: 'announcement', source_id: crypto.randomUUID() })
      expect(r.held).toBe('digest')
    }
    expect((await rows()).length).toBe(0)
    // Items were held "earlier today"; run the digest a minute after 18:00 IST tomorrow.
    await db.prepare(`UPDATE message_digest_items SET created_at = '2020-01-01T00:00:00.000Z'`).run()
    const at = Date.now() + 86_400_000
    const d = new Date(at + 330 * 60_000)
    const after = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 18, 1) - 330 * 60_000
    const out = await runDigest({ env, db, inst }, after)
    expect(out).toEqual({ digests: 1, items: 2 })
    const r = await rows()
    expect(r).toHaveLength(1)
    expect(r[0].template_code).toBe('digest.daily')
    const pending = await db.prepare(`SELECT count(*) AS n FROM message_digest_items WHERE bundled_at IS NULL`).first<{ n: number }>()
    expect(pending?.n).toBe(0)
  })

  it('holds non-urgent messages through quiet hours, not urgent ones', async () => {
    await db.prepare(`UPDATE message_settings SET quiet_from = '00:00', quiet_to = '23:59'`).run()
    const ms = new Messenger({ env: envWith(), db, inst })
    const fee = await ms.queue({ channel: 'auto', template_code: 'fees.overdue', to_user_id: IDS.parent, vars: { student_name: 'A', amount_due: '1', invoice_no: 'I', due_on: 'x' } })
    const abs = await ms.queue({ channel: 'sms', template_code: 'attendance.absent', to_user_id: IDS.parent, vars: { student_name: 'A', on_date: 'today' } })
    const byId = new Map((await rows()).map((x) => [x.id, x]))
    const nowIst = new Date(Date.now() + 330 * 60_000)
    const inside = nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes() < 23 * 60 + 59
    if (inside) expect(Date.parse(byId.get(fee.id!)!.send_after!)).toBeGreaterThan(Date.now())
    expect(byId.get(abs.id!)!.send_after).toBeNull()
  })

  it('sends over the daily cap to the digest', async () => {
    await db.prepare(`UPDATE message_settings SET daily_cap = 1`).run()
    const ms = new Messenger({ env: envWith(), db, inst })
    const a = await ms.queue({ channel: 'auto', template_code: 'ptm.reminder', to_user_id: IDS.parent, vars: { n: 1 } })
    const b = await ms.queue({ channel: 'auto', template_code: 'ptm.reminder', to_user_id: IDS.parent, vars: { n: 2 } })
    expect(a.id).toBeTruthy()
    expect(b.held).toBe('cap')
  })
})

describe('channel ladder', () => {
  it('goes in-app first, then WhatsApp, then SMS when WhatsApp fails', async () => {
    const env = envWith()
    const ms = new Messenger({ env, db, inst })
    const res = await ms.queue({ channel: 'sms', template_code: 'attendance.absent', to_user_id: IDS.parent, vars: { student_name: 'Asha', on_date: 'today' } })
    expect(res.channel).toBe('in_app')
    // No app push: the in-app row is sent to the bell and the ladder moves to WhatsApp.
    waAnswer = () => Response.json({ error: { message: 'undeliverable', code: 131026 } }, { status: 400 })
    await dispatchMessages(env, db, inst, 10)
    const r = await rows()
    expect(r.map((x) => [x.channel, x.status])).toEqual([['in_app', 'sent'], ['whatsapp', 'failed'], ['sms', 'sent']])
    expect(r[1].fallback_of).toBe(r[0].id)
    expect(r[2].fallback_of).toBe(r[1].id)
    expect(calls.some((c) => c.url.includes('graph.facebook.com') && c.body.includes(`"biz_opaque_callback_data":"${inst}:${r[1].id}"`))).toBe(true)
    expect(calls.filter((c) => c.url.startsWith('https://sms.invalid/'))).toHaveLength(1)
  })

  it('keeps OTP on SMS only', async () => {
    const ms = new Messenger({ env: envWith(), db, inst })
    const res = await ms.queue({ channel: 'auto', template_code: 'login.otp', to_user_id: IDS.parent, vars: {} }).catch((e) => e)
    // No OTP wording ships, so the refusal is about wording on sms, never another channel.
    expect(String(res.message ?? res.channel)).toMatch(/sms/)
  })
})

describe('delivery receipts', () => {
  it('moves a WhatsApp message to delivered then read from a signed webhook', async () => {
    const env = envWith({ WHATSAPP_APP_SECRET: 'app-secret' })
    const ms = new Messenger({ env, db, inst })
    await db.prepare(`UPDATE message_policies SET ladder = ladder`).run()
    await db.prepare(`INSERT INTO message_policies (institution_id, message_type, ladder, mode) VALUES (?, 'fees', '["whatsapp","sms"]', 'instant')`).bind(inst).run()
    const q = await ms.queue({ channel: 'auto', template_code: 'fees.overdue', to_user_id: IDS.parent, vars: { student_name: 'A', amount_due: '1', invoice_no: 'I', due_on: 'x' } })
    expect(q.channel).toBe('whatsapp')
    await dispatchMessages(env, db, inst, 5)
    const sent = (await rows())[0]
    expect(sent.status).toBe('sent')
    const hook = async (status: string, sig?: string) => {
      const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: sent.provider_msg_id, status, timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: `${inst}:${sent.id}` }] } }] }] })
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('app-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const mac = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('')
      const req = new Request('https://erp.test/api/v1/public/webhooks/whatsapp', { method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=' + (sig ?? mac) } })
      return whatsappWebhook(env, req, new URL(req.url))
    }
    expect((await hook('delivered', '00'.repeat(32))).status).toBe(401)
    expect(await (await hook('delivered')).json()).toMatchObject({ applied: 1 })
    expect((await rows())[0].status).toBe('delivered')
    await hook('read')
    await hook('delivered') // late and out of order: never moves back
    const final = await db.prepare(`SELECT status, delivered_at, read_at FROM message_log WHERE id = ?`).bind(sent.id).first<{ status: string; delivered_at: string; read_at: string }>()
    expect(final?.status).toBe('read')
    expect(final?.read_at).toBeTruthy()
    const events = await db.prepare(`SELECT count(*) AS n FROM message_events WHERE message_log_id = ?`).bind(sent.id).first<{ n: number }>()
    expect(events?.n).toBeGreaterThanOrEqual(3)
  })
})

describe('honest status', () => {
  it('shows a channel live only when set up and in credit', async () => {
    const bare = await channelStatus({ ...E, PLATFORM_PROVIDERS: '', RESEND_API_KEY: '', FCM_SERVICE_ACCOUNT: '' } as unknown as Env, db, inst)
    const by = (h: typeof bare) => Object.fromEntries(h.map((x) => [x.channel, x.state]))
    expect(by(bare)).toMatchObject({ in_app: 'live', push: 'not_configured', whatsapp: 'not_configured', sms: 'not_configured', email: 'not_configured' })
    await db.prepare(`UPDATE message_credits SET balance = 0 WHERE channel = 'sms'`).run()
    const set = by(await channelStatus(envWith(), db, inst))
    expect(set.whatsapp).toBe('live')
    expect(set.sms).toBe('no_credit')
  })

  it('does not call messaging Live when nothing outside the app can send', async () => {
    const { status, body } = await api('admin', 'GET', '/admin/messaging/recipients')
    expect(status).toBe(200)
    expect(body.mode).toBe('everyone')
    expect(body.sending).toBe(false)
    expect(body.explanation).not.toMatch(/^Live/)
    const h = await api('admin', 'GET', '/admin/messaging/health')
    expect(h.body.warnings.join(' ')).toMatch(/No outbound channel is live/)
  })
})
