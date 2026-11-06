/* Yajur Connect (communication.yajur_connect): what parents send on WhatsApp is
   kept and matched to the family; replies and auto-replies only ever go into
   the message queue, where the recipient guard holds them. No test here
   reaches WhatsApp: the guard is on, and any request to graph.facebook.com
   fails the test. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { seed, api, as, E, IDS } from './fixture'
import { whatsappWebhook } from '../../src/routes/comms/message_webhooks'
import { dispatchMessages } from '../../src/services/messaging'

const SECRET = 'connect-test-secret'
const PNID = '555000111222'
const db = () => E.TENANT_TEST
const graphCalls: string[] = []
const realFetch = globalThis.fetch

async function hook(messages: unknown[], name = 'Pavan') {
  const body = JSON.stringify({ entry: [{ changes: [{ value: {
    metadata: { phone_number_id: PNID }, contacts: [{ wa_id: '919000000001', profile: { name } }], messages,
  } }] }] })
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const url = new URL('https://erp.test/api/v1/public/webhooks/whatsapp')
  const res = await whatsappWebhook({ ...E, WHATSAPP_APP_SECRET: SECRET } as typeof E, new Request(url, {
    method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=' + sig, 'content-type': 'application/json' },
  }), url)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}
const ts = (agoMs = 0) => String(Math.floor((Date.now() - agoMs) / 1000))

describe('communication.yajur_connect', () => {
  let convId = ''
  beforeAll(async () => {
    await seed()
    // Sign-ins hash a password: do them here, under the hook's longer timeout.
    for (const who of ['admin', 'teacher', 'parent'] as const) await as(who)
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (u.includes('graph.facebook.com') || u.includes('gateway.invalid')) { graphCalls.push(u); throw new Error('test must not reach WhatsApp') }
      return realFetch(input, init)
    }) as typeof fetch
    // The guard on, with an empty list: nothing queued here can be delivered.
    await db().prepare(`INSERT INTO messaging_recipient_policy (institution_id, mode) VALUES (?, 'allowlist')
        ON CONFLICT (institution_id) DO UPDATE SET mode = 'allowlist', unguarded_channels = '{}'`).bind(IDS.school).run()
    await db().prepare(`DELETE FROM messaging_allowed_recipients`).run()
    // A WhatsApp gateway that does not exist, so the queue accepts WhatsApp; nothing reaches it (guard on, fetch refused).
    await db().prepare(`INSERT INTO integrations (institution_id, provider, kind, config, enabled) VALUES (?, 'whatsapp', 'messaging', ?, 1)
        ON CONFLICT (institution_id, provider) DO UPDATE SET config = excluded.config, enabled = 1`)
      .bind(IDS.school, JSON.stringify({ endpoint: 'https://gateway.invalid/send', auth_header: 'X-Test: 1' })).run()
    // The school has written to this parent before: that is how a shared number's reply finds its school.
    await db().prepare(`INSERT INTO message_log (id, institution_id, channel, template_code, recipient, body, status, queued_at, attempts)
        VALUES (?, ?, 'whatsapp', 'messaging.direct', '+91 90000 00001', 'Earlier notice', 'sent', ?, 1)`)
      .bind(crypto.randomUUID(), IDS.school, new Date(Date.now() - 86_400_000).toISOString()).run()
  })
  afterAll(() => { globalThis.fetch = realFetch; expect(graphCalls).toEqual([]) })

  it('only holders of comms.connect.read open it; writes need comms.connect.write', async () => {
    expect((await api('teacher', 'GET', '/comms/yajur-connect')).status).toBe(403)
    expect((await api('parent', 'GET', '/comms/yajur-connect')).status).toBe(403)
    expect((await api('teacher', 'POST', '/comms/yajur-connect/autoreplies', { match_type: 'exact', keyword: 'hi', reply: 'x' })).status).toBe(403)
    const r = await api('admin', 'GET', '/comms/yajur-connect')
    expect(r.status).toBe(200)
    expect(r.body.guard_on).toBe(true)
    expect(r.body.can_write).toBe(true)
  })

  it('auto-replies: validated, listed in order, edited and deleted', async () => {
    expect((await api('admin', 'POST', '/comms/yajur-connect/autoreplies', { match_type: 'regex', keyword: 'fee', reply: 'x' })).status).toBe(400)
    expect((await api('admin', 'POST', '/comms/yajur-connect/autoreplies', { match_type: 'contains', keyword: ' ', reply: 'x' })).status).toBe(400)
    expect((await api('admin', 'POST', '/comms/yajur-connect/autoreplies', { match_type: 'contains', keyword: 'fee', reply: '' })).status).toBe(400)
    const a = await api('admin', 'POST', '/comms/yajur-connect/autoreplies', { match_type: 'contains', keyword: 'fee', reply: 'The fee office is open 9 to 4.' })
    expect(a.status).toBe(201)
    const b = await api('admin', 'POST', '/comms/yajur-connect/autoreplies', { match_type: 'exact', keyword: 'bus', reply: 'Old' })
    const u = await api('admin', 'PUT', `/comms/yajur-connect/autoreplies/${b.body.id}`, { reply: 'The bus leaves at 3.40.', enabled: false })
    expect(u.body).toMatchObject({ reply: 'The bus leaves at 3.40.', enabled: false, keyword: 'bus' })
    expect((await api('teacher', 'DELETE', `/comms/yajur-connect/autoreplies/${b.body.id}`)).status).toBe(403)
    const list = await api('admin', 'GET', '/comms/yajur-connect/autoreplies')
    expect(list.body.items.map((x: { keyword: string }) => x.keyword)).toEqual(['fee', 'bus'])
    expect((await api('admin', 'DELETE', `/comms/yajur-connect/autoreplies/${b.body.id}`)).status).toBe(200)
    expect((await api('admin', 'PUT', `/comms/yajur-connect/autoreplies/${b.body.id}`, { reply: 'x' })).status).toBe(404)
  })

  it('the webhook keeps the message, matches the guardian, and still answers statuses', async () => {
    const r = await hook([{ from: '919000000001', id: 'wamid.in1', timestamp: ts(), type: 'text', text: { body: 'When is the fee due?' } }])
    expect(r.status).toBe(200)
    expect(r.body.stored).toBe(1)
    const again = await hook([{ from: '919000000001', id: 'wamid.in1', timestamp: ts(), type: 'text', text: { body: 'When is the fee due?' } }])
    expect(again.body.stored).toBe(0)
    const l = await api('admin', 'GET', '/comms/yajur-connect?q=Pavan')
    expect(l.body.items).toHaveLength(1)
    const c = l.body.items[0]
    convId = c.id
    expect(c).toMatchObject({ phone: '919000000001', guardian_id: IDS.guardian, student_id: IDS.child, name: 'Pavan Parent', unread: 1, state: 'open' })
  })

  it('media and reactions are kept by reference; the auto-reply is only queued, and the guard suppresses it', async () => {
    await hook([
      { from: '919000000001', id: 'wamid.in2', timestamp: ts(), type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'Receipt' } },
      { from: '919000000001', id: 'wamid.in3', timestamp: ts(), type: 'reaction', reaction: { message_id: 'wamid.in1', emoji: '+' } },
    ])
    const t = await api('admin', 'GET', `/comms/yajur-connect/${convId}`)
    expect(t.status).toBe(200)
    const msgs = t.body.messages as { direction: string; kind: string; text: string; media_id: string; reply_to_wa_id: string; auto_reply: boolean; status: string }[]
    expect(msgs.find((m) => m.kind === 'image')).toMatchObject({ media_id: 'media-1', text: 'Receipt' })
    expect(msgs.find((m) => m.kind === 'reaction')).toMatchObject({ reply_to_wa_id: 'wamid.in1' })
    const auto = msgs.find((m) => m.auto_reply)!
    expect(auto).toMatchObject({ direction: 'out', text: 'The fee office is open 9 to 4.' })
    expect(t.body.contact.guardian.name).toBe('Pavan Parent')
    expect(t.body.sending).toMatchObject({ paused: true, window_open: true })
    const log = await db().prepare(`SELECT status FROM message_log WHERE source_kind = 'wa_connect'`).all<{ status: string }>()
    expect(log.results.length).toBeGreaterThan(0)
    await dispatchMessages(E, db(), IDS.school, 50)
    const after = await db().prepare(`SELECT status, error FROM message_log WHERE source_kind = 'wa_connect'`).all<{ status: string; error: string }>()
    for (const row of after.results) { expect(row.status).toBe('suppressed'); expect(row.error).toMatch(/allowlist/) }
  })

  it('a reply inside the window is queued; refusals for the rest', async () => {
    expect((await api('teacher', 'POST', `/comms/yajur-connect/${convId}/reply`, { text: 'Hello' })).status).toBe(403)
    expect((await api('admin', 'POST', `/comms/yajur-connect/${convId}/reply`, {})).status).toBe(400)
    expect((await api('admin', 'POST', `/comms/yajur-connect/${convId}/reply`, { template_code: 'no_such_template' })).status).toBe(400)
    expect((await api('admin', 'POST', '/comms/yajur-connect/not-an-id/reply', { text: 'x' })).status).toBe(400)
    expect((await api('admin', 'POST', '/comms/yajur-connect/00000000-0000-4000-8000-0000000000ff/reply', { text: 'x' })).status).toBe(404)
    const ok = await api('admin', 'POST', `/comms/yajur-connect/${convId}/reply`, { text: 'The fee is due on the 10th.' })
    expect(ok.status).toBe(201)
    expect(ok.body).toMatchObject({ direction: 'out', status: 'queued', text: 'The fee is due on the 10th.' })
    const row = await db().prepare(`SELECT channel, recipient FROM message_log WHERE source_kind = 'wa_connect' AND body = ?`).bind('The fee is due on the 10th.').first<{ channel: string; recipient: string }>()
    expect(row).toMatchObject({ channel: 'whatsapp', recipient: '+919000000001' })
    // After 24 hours, free text is refused.
    await db().prepare(`UPDATE wa_conversations SET last_inbound_at = ? WHERE id = ?`).bind(new Date(Date.now() - 25 * 3600_000).toISOString(), convId).run()
    const late = await api('admin', 'POST', `/comms/yajur-connect/${convId}/reply`, { text: 'Hello again' })
    expect(late.status).toBe(409)
    expect(late.body.code).toBe('window_closed')
  })

  it('assign, label, resolve and reopen; a new message reopens a resolved chat', async () => {
    expect((await api('teacher', 'PUT', `/comms/yajur-connect/${convId}`, { state: 'resolved' })).status).toBe(403)
    expect((await api('admin', 'PUT', `/comms/yajur-connect/${convId}`, { assigned_to: IDS.teacher })).status).toBe(400)
    expect((await api('admin', 'PUT', `/comms/yajur-connect/${convId}`, { state: 'closed' })).status).toBe(400)
    expect((await api('admin', 'PUT', `/comms/yajur-connect/${convId}`, { labels: ['x'.repeat(31)] })).status).toBe(400)
    const staff = await api('admin', 'GET', '/comms/yajur-connect/staff')
    expect(staff.body.items.map((s: { id: string }) => s.id)).toContain(IDS.admin)
    const u = await api('admin', 'PUT', `/comms/yajur-connect/${convId}`, { assigned_to: IDS.admin, labels: ['Fees', 'fees', 'Urgent'], state: 'resolved' })
    expect(u.status).toBe(200)
    expect(u.body).toMatchObject({ assigned_to: IDS.admin, labels: ['Fees', 'Urgent'], state: 'resolved' })
    expect((await api('admin', 'GET', '/comms/yajur-connect')).body.items.some((c: { id: string }) => c.id === convId)).toBe(false)
    expect((await api('admin', 'GET', '/comms/yajur-connect?state=resolved&mine=1')).body.items[0].id).toBe(convId)
    await hook([{ from: '919000000001', id: 'wamid.in4', timestamp: ts(), type: 'text', text: { body: 'One more question' } }])
    const back = await api('admin', 'GET', `/comms/yajur-connect/${convId}`)
    expect(back.body.conversation.state).toBe('open')
    const re = await api('admin', 'PUT', `/comms/yajur-connect/${convId}`, { assigned_to: null })
    expect(re.body.assigned_to).toBeNull()
  })
})
