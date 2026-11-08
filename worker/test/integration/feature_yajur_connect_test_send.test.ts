/* Yajur Connect test sends: only to a number on the school's recipient
   allowlist, re-checked by the server, and only queued. Any request to
   graph.facebook.com fails the test. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { seed, api, as, E, IDS } from './fixture'

const db = () => E.TENANT_TEST
const graphCalls: string[] = []
const realFetch = globalThis.fetch
const CODE = 'connect_testsend'
const ALLOWED = '+919000000077'

describe('communication.yajur_connect test send', () => {
  beforeAll(async () => {
    await seed()
    for (const who of ['admin', 'teacher'] as const) await as(who)
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (u.includes('graph.facebook.com') || u.includes('gateway.invalid')) { graphCalls.push(u); throw new Error('test must not reach WhatsApp') }
      return realFetch(input, init)
    }) as typeof fetch
    await db().prepare(`INSERT INTO messaging_recipient_policy (institution_id, mode) VALUES (?, 'allowlist')
        ON CONFLICT (institution_id) DO UPDATE SET mode = 'allowlist', unguarded_channels = '{}'`).bind(IDS.school).run()
    await db().prepare(`DELETE FROM messaging_allowed_recipients`).run()
    await db().prepare(`INSERT INTO messaging_allowed_recipients (id, institution_id, kind, raw, normalised, label, created_at)
        VALUES (?, ?, 'phone', ?, '919000000077', 'Office phone', ?)`).bind(crypto.randomUUID(), IDS.school, ALLOWED, new Date().toISOString()).run()
    await db().prepare(`INSERT INTO integrations (institution_id, provider, kind, config, enabled) VALUES (?, 'whatsapp', 'messaging', ?, 1)
        ON CONFLICT (institution_id, provider) DO UPDATE SET config = excluded.config, enabled = 1`)
      .bind(IDS.school, JSON.stringify({ endpoint: 'https://gateway.invalid/send', auth_header: 'X-Test: 1' })).run()
    await db().prepare(`INSERT INTO message_templates (id, institution_id, code, channel, body, wa_template_name, wa_language, wa_params, is_active)
        VALUES (?, ?, ?, 'whatsapp', ?, 'connect_testsend', 'en', '["parent_name","student_name","class","note"]', 1)`)
      .bind(crypto.randomUUID(), IDS.school, CODE, 'Dear {{parent_name}}, about {{student_name}} of {{class}}: {{note}}').run()
  })
  afterAll(() => { globalThis.fetch = realFetch; expect(graphCalls).toEqual([]) })

  const body = (phone: string) => ({ phone, template_code: CODE, values: { note: 'Checking the wording.' } })

  it('refuses without comms.connect.write (403)', async () => {
    expect((await api('teacher', 'GET', '/comms/yajur-connect/send/test-numbers')).status).toBe(403)
    expect((await api('teacher', 'POST', '/comms/yajur-connect/send/test', body(ALLOWED))).status).toBe(403)
  })

  it('refuses a number not on the allowlist (400) and queues nothing', async () => {
    expect((await api('admin', 'POST', '/comms/yajur-connect/send/test', body('+919000000001'))).status).toBe(400)
    expect((await api('admin', 'POST', '/comms/yajur-connect/send/test', body('abc'))).status).toBe(400)
    const n = await db().prepare(`SELECT count(*) AS n FROM message_log WHERE source_kind = 'connect_test'`).first<{ n: number }>()
    expect(n!.n).toBe(0)
  })

  it('lists the allowlist and queues a test to an allowlisted number with Test fields', async () => {
    const l = await api('admin', 'GET', '/comms/yajur-connect/send/test-numbers')
    expect(l.body.items).toEqual([expect.objectContaining({ label: 'Office phone', phone: ALLOWED })])
    const r = await api('admin', 'POST', '/comms/yajur-connect/send/test', body('9000000077'))
    expect(r.status).toBe(201)
    const log = await db().prepare(`SELECT recipient, body, student_id FROM message_log WHERE source_kind = 'connect_test'`).all<{ recipient: string; body: string; student_id: string | null }>()
    expect(log.results).toHaveLength(1)
    expect(log.results[0]).toMatchObject({ recipient: ALLOWED, student_id: null, body: 'Dear Test, about Test of Test: Checking the wording.' })
  })
  it('refuses a header picture for a template without one (400); the template list says which have one', async () => {
    const t = await api('admin', 'GET', '/comms/yajur-connect/send/templates')
    expect(t.body.items.find((x: { code: string }) => x.code === CODE).has_image_header).toBe(false)
    expect(typeof t.body.school_name).toBe('string')
    const img = { header_image_url: 'https://cdn.test/a.jpg' }
    expect((await api('admin', 'POST', '/comms/yajur-connect/send/test', { ...body(ALLOWED), ...img })).status).toBe(400)
    expect((await api('admin', 'POST', '/comms/yajur-connect/send', { guardian_id: IDS.guardian, template_code: CODE, values: { note: 'x' }, ...img })).status).toBe(400)
    expect((await api('admin', 'POST', '/comms/yajur-connect/send/preview', {
      name: 'x', template_code: CODE, values: { note: 'x' }, audience: { scope: 'school', ids: [], relation: 'both' }, ...img })).status).toBe(400)
  })

  it('never uses a typed value for a field filled per recipient', async () => {
    const r = await api('admin', 'POST', '/comms/yajur-connect/send/test', { ...body(ALLOWED), values: { note: 'Second.', parent_name: '12/11/2026', student_name: 'x', class: 'y' } })
    expect(r.status).toBe(201)
    const row = await db().prepare(`SELECT body FROM message_log WHERE id = ?`).bind(r.body.message_log_id).first<{ body: string }>()
    expect(row!.body).toBe('Dear Test, about Test of Test: Second.')
    const p = await api('admin', 'POST', '/comms/yajur-connect/send/preview', {
      name: 'x', template_code: CODE, values: { note: 'Hi', parent_name: '12/11/2026' }, audience: { scope: 'school', ids: [], relation: 'both' } })
    expect(p.status).toBe(200)
    expect(p.body.sample ?? '').not.toContain('12/11/2026')
  })
})
