/* Yajur Connect sending: a template to one parent, broadcasts kept as
   campaigns, and schedules. Everything only enters the message queue, where
   the recipient guard (on, with an empty list) suppresses it. Any request to
   graph.facebook.com fails the test. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { seed, api, as, E, IDS } from './fixture'
import { dispatchMessages } from '../../src/services/messaging'
import { runDueSchedules } from '../../src/services/wa_send'

const db = () => E.TENANT_TEST
const graphCalls: string[] = []
const realFetch = globalThis.fetch
const CODE = 'connect_notice'
const audience = { scope: 'school', ids: [], relation: 'both' }
const body = (extra: Record<string, unknown> = {}) => ({ name: 'Sports day', template_code: CODE, values: { note: 'Sports day for {{student_name}} is on Friday.' }, audience, ...extra })

describe('communication.yajur_connect sending', () => {
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
    await db().prepare(`INSERT INTO integrations (institution_id, provider, kind, config, enabled) VALUES (?, 'whatsapp', 'messaging', ?, 1)
        ON CONFLICT (institution_id, provider) DO UPDATE SET config = excluded.config, enabled = 1`)
      .bind(IDS.school, JSON.stringify({ endpoint: 'https://gateway.invalid/send', auth_header: 'X-Test: 1' })).run()
    await db().prepare(`INSERT INTO message_templates (id, institution_id, code, channel, body, wa_template_name, wa_language, wa_params, is_active, has_image_header)
        VALUES (?, ?, ?, 'whatsapp', ?, 'connect_notice', 'en', '["parent_name","student_name","class","note"]', 1, 1)`)
      .bind(crypto.randomUUID(), IDS.school, CODE, 'Dear {{parent_name}}, about {{student_name}} of {{class}}: {{note}}').run()
    // The second family replied STOP.
    await db().prepare(`INSERT INTO message_opt_outs (institution_id, contact, scope, source, created_at) VALUES (?, 'phone:919000000002', 'all', 'stop_reply', ?)`)
      .bind(IDS.school, new Date().toISOString()).run()
  })
  afterAll(() => { globalThis.fetch = realFetch; expect(graphCalls).toEqual([]) })

  it('refuses without comms.connect.write (403) and refuses bad input (400)', async () => {
    expect((await api('teacher', 'GET', '/comms/yajur-connect/send/templates')).status).toBe(403)
    expect((await api('teacher', 'POST', '/comms/yajur-connect/campaigns', body())).status).toBe(403)
    expect((await api('teacher', 'POST', '/comms/yajur-connect/send/preview', body())).status).toBe(403)
    expect((await api('teacher', 'GET', '/comms/yajur-connect/schedules')).status).toBe(403)
    expect((await api('teacher', 'POST', '/comms/yajur-connect/send', { guardian_id: IDS.guardian, template_code: CODE, values: { note: 'x' } })).status).toBe(403)
    expect((await api('admin', 'POST', '/comms/yajur-connect/campaigns', body({ name: '' }))).status).toBe(400)
    expect((await api('admin', 'POST', '/comms/yajur-connect/campaigns', body({ template_code: 'nope' }))).status).toBe(400)
    expect((await api('admin', 'POST', '/comms/yajur-connect/campaigns', body({ values: {} }))).status).toBe(400)
    expect((await api('admin', 'POST', '/comms/yajur-connect/campaigns', body({ audience: { scope: 'classes', ids: [], relation: 'both' } }))).status).toBe(400)
    expect((await api('admin', 'POST', '/comms/yajur-connect/campaigns', body({ audience: { scope: 'school', ids: [], relation: 'uncle' } }))).status).toBe(400)
    expect((await api('admin', 'POST', '/comms/yajur-connect/campaigns', body({ header_image_url: 'http://x.test/a.png' }))).status).toBe(400)
    expect((await api('admin', 'POST', '/comms/yajur-connect/send', { guardian_id: 'x', template_code: CODE, values: { note: 'x' } })).status).toBe(400)
    expect((await api('admin', 'POST', '/comms/yajur-connect/schedules', { ...body(), repeat: 'hourly', run_at: new Date(Date.now() + 3600_000).toISOString() })).status).toBe(400)
    expect((await api('admin', 'POST', '/comms/yajur-connect/schedules', { ...body(), repeat: 'once', run_at: '2020-01-01T00:00:00Z' })).status).toBe(400)
    expect((await api('admin', 'PUT', '/comms/yajur-connect/schedules/00000000-0000-4000-8000-0000000000ff', { active: false })).status).toBe(404)
    expect((await api('admin', 'GET', '/comms/yajur-connect/campaigns/not-an-id')).status).toBe(400)
  })

  it('lists the template fields; the preview counts recipients after opt-outs and fills the merge fields', async () => {
    const t = await api('admin', 'GET', '/comms/yajur-connect/send/templates')
    expect(t.body.items.find((x: { code: string }) => x.code === CODE).fields).toEqual(['parent_name', 'student_name', 'class', 'note'])
    const p = await api('admin', 'POST', '/comms/yajur-connect/send/preview', body())
    expect(p.status).toBe(200)
    expect(p.body).toMatchObject({ count: 1, opted_out: 1, no_phone: 0 })
    expect(p.body.sample).toBe('Dear Pavan Parent, about Chirag Test of Class 5 A: Sports day for Chirag Test is on Friday.')
    const mothers = await api('admin', 'POST', '/comms/yajur-connect/send/preview', body({ audience: { scope: 'sections', ids: [IDS.section], relation: 'mother' } }))
    expect(mothers.body.count).toBe(0)
  })

  let campaignId = ''
  it('a broadcast is queued per recipient with its own values and saved as a snapshot', async () => {
    const r = await api('admin', 'POST', '/comms/yajur-connect/campaigns', body({ header_image_url: 'https://cdn.test/sports.jpg', audience: { scope: 'classes', ids: [IDS.klass], relation: 'father' } }))
    expect(r.status).toBe(201)
    campaignId = r.body.id
    expect(r.body).toMatchObject({ name: 'Sports day', template_code: CODE, recipient_count: 1, opted_out: 1, header_image_url: 'https://cdn.test/sports.jpg',
      audience: { scope: 'classes', ids: [IDS.klass], relation: 'father' }, audience_label: 'Class 5, fathers', counts: { queued: 1 } })
    expect(r.body.values).toEqual({ note: 'Sports day for {{student_name}} is on Friday.' })
    expect(r.body.rendered).toBe('Dear {{parent_name}}, about {{student_name}} of {{class}}: Sports day for {{student_name}} is on Friday.')
    const log = await db().prepare(`SELECT recipient, body, template_vars FROM message_log WHERE source_kind = 'wa_campaign' AND source_id = ?`).bind(campaignId).all<{ recipient: string; body: string; template_vars: string }>()
    expect(log.results).toHaveLength(1)
    expect(log.results[0].recipient).toBe('+919000000001')
    expect(log.results[0].body).toBe('Dear Pavan Parent, about Chirag Test of Class 5 A: Sports day for Chirag Test is on Friday.')
    expect(JSON.parse(log.results[0].template_vars).__media).toEqual({ kind: 'image', url: 'https://cdn.test/sports.jpg' })
    const list = await api('admin', 'GET', '/comms/yajur-connect/campaigns')
    expect(list.body.items[0].id).toBe(campaignId)
  })

  it('a template to one parent is queued and shows in their chat', async () => {
    const r = await api('admin', 'POST', '/comms/yajur-connect/send', { guardian_id: IDS.guardian, template_code: CODE, values: { note: 'Please meet the class teacher.' } })
    expect(r.status).toBe(201)
    expect(r.body.message).toMatchObject({ direction: 'out', kind: 'template', status: 'queued' })
    expect(r.body.message.text).toBe('Dear Pavan Parent, about Chirag Test of Class 5 A: Please meet the class teacher.')
    const t = await api('admin', 'GET', `/comms/yajur-connect/${r.body.conversation_id}`)
    expect(t.body.conversation.phone).toBe('919000000001')
    expect(t.body.messages.some((m: { id: string }) => m.id === r.body.message.id)).toBe(true)
    const people = await api('admin', 'GET', '/comms/yajur-connect/send/people?q=Diya')
    expect(people.body.items[0]).toMatchObject({ guardian_id: IDS.otherGuardian, opted_out: true })
  })

  it('a schedule fires once, not twice; it can be paused and deleted', async () => {
    const s = await api('admin', 'POST', '/comms/yajur-connect/schedules', { ...body({ name: 'Reminder' }), repeat: 'once', run_at: new Date(Date.now() + 3600_000).toISOString() })
    expect(s.status).toBe(201)
    expect(s.body).toMatchObject({ repeat: 'once', active: true, audience_label: 'Whole school, parents' })
    await db().prepare(`UPDATE wa_schedules SET next_run_at = ? WHERE id = ?`).bind(new Date(Date.now() - 60_000).toISOString(), s.body.id).run()
    const scope = { env: E, db: db(), inst: IDS.school }
    const [a, b] = await Promise.all([runDueSchedules(scope), runDueSchedules(scope)])
    expect(a + b).toBe(1)
    expect(await runDueSchedules(scope)).toBe(0)
    const made = await db().prepare(`SELECT count(*) AS n FROM wa_campaigns WHERE schedule_id = ?`).bind(s.body.id).first<{ n: number }>()
    expect(made!.n).toBe(1)
    const list = await api('admin', 'GET', '/comms/yajur-connect/schedules')
    expect(list.body.items.find((x: { id: string }) => x.id === s.body.id)).toMatchObject({ active: false, next_run_at: null })
    expect((await api('admin', 'PUT', `/comms/yajur-connect/schedules/${s.body.id}`, { active: true })).status).toBe(400)

    const d = await api('admin', 'POST', '/comms/yajur-connect/schedules', { ...body({ name: 'Daily' }), repeat: 'daily', run_at: new Date(Date.now() + 3600_000).toISOString() })
    expect((await api('admin', 'PUT', `/comms/yajur-connect/schedules/${d.body.id}`, { active: false })).body.active).toBe(false)
    await db().prepare(`UPDATE wa_schedules SET next_run_at = ? WHERE id = ?`).bind(new Date(Date.now() - 60_000).toISOString(), d.body.id).run()
    expect(await runDueSchedules(scope)).toBe(0)
    expect((await api('admin', 'DELETE', `/comms/yajur-connect/schedules/${d.body.id}`)).status).toBe(200)
    expect((await api('admin', 'GET', '/comms/yajur-connect/schedules')).body.items.some((x: { id: string }) => x.id === d.body.id)).toBe(false)
  })

  it('every send ends suppressed by the recipient guard, and the campaign shows it as blocked', async () => {
    // Quiet hours may hold a send until morning: release them so dispatch sees every row.
    await db().prepare(`UPDATE message_log SET send_after = NULL WHERE status = 'queued'`).run()
    await dispatchMessages(E, db(), IDS.school, 200)
    const rows = await db().prepare(`SELECT status, error FROM message_log WHERE source_kind IN ('wa_campaign', 'wa_connect_new')`).all<{ status: string; error: string }>()
    expect(rows.results.length).toBe(3)
    for (const r of rows.results) { expect(r.status).toBe('suppressed'); expect(r.error).toMatch(/allowlist/) }
    const d = await api('admin', 'GET', `/comms/yajur-connect/campaigns/${campaignId}`)
    expect(d.body.campaign.counts).toEqual({ blocked: 1 })
    expect(d.body.recipients[0]).toMatchObject({ recipient: '+919000000001', parent_name: 'Pavan Parent', student_name: 'Chirag Test', class: 'Class 5 A', status: 'blocked' })
    expect(graphCalls).toEqual([])
  })
})
