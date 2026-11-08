/* Yajur Connect: staff as a broadcast audience, and the Log tab. Every send
   only enters the queue, where the recipient guard (on, empty list)
   suppresses it. Any request to graph.facebook.com fails the test. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { seed, api, as, E, IDS } from './fixture'
import { dispatchMessages } from '../../src/services/messaging'

const db = () => E.TENANT_TEST
const graphCalls: string[] = []
const realFetch = globalThis.fetch
const CODE = 'connect.staff_notice'
const DEPT = '00000000-0000-4000-8000-0000000005d1'
const OTHER = '00000000-0000-4000-8000-0000000005d2'
const aud = { scope: 'departments', ids: [DEPT], relation: 'both' }
const body = (extra: Record<string, unknown> = {}) => ({ name: 'Staff meeting', template_code: CODE, values: { note: 'Meeting at 4, {{staff_name}}.' }, audience: aud, ...extra })

describe('communication.yajur_connect staff audience and log', () => {
  beforeAll(async () => {
    await seed()
    await as('admin')
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
    await db().prepare(`INSERT INTO message_templates (id, institution_id, code, channel, body, wa_template_name, wa_language, wa_params, is_active)
        VALUES (?, ?, ?, 'whatsapp', ?, 'staff_notice', 'en', '["staff_name","note"]', 1)`)
      .bind(crypto.randomUUID(), IDS.school, CODE, 'Dear {{staff_name}}: {{note}}').run()
    const campus = await db().prepare(`SELECT id FROM campuses LIMIT 1`).first<{ id: string }>()
    for (const [id, name] of [[DEPT, 'Science'], [OTHER, 'Transport']]) {
      await db().prepare(`INSERT INTO departments (id, institution_id, name) VALUES (?, ?, ?)`).bind(id, IDS.school, name).run()
    }
    const staff: [string, string, string | null, string, string][] = [
      ['Asha', 'Rao', '9811100001', DEPT, 'active'], ['Bala', 'K', '9811100002', DEPT, 'active'],
      ['Chitra', 'M', '9811100003', DEPT, 'active'], // opted out below
      ['Dev', 'S', null, DEPT, 'active'], ['Esha', 'P', '9811100005', DEPT, 'left'], ['Farid', 'Q', '9811100006', OTHER, 'active'],
    ]
    let n = 0
    for (const [f, l, phone, dept, status] of staff) {
      await db().prepare(`INSERT INTO employees (id, institution_id, campus_id, employee_code, first_name, last_name, phone, department_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), IDS.school, campus!.id, 'YCS' + ++n, f, l, phone, dept, status).run()
    }
    await db().prepare(`INSERT INTO message_opt_outs (institution_id, contact, scope, source, created_at) VALUES (?, 'phone:919811100003', 'all', 'stop_reply', ?)`)
      .bind(IDS.school, new Date().toISOString()).run()
  }, 120_000)
  afterAll(() => { globalThis.fetch = realFetch; expect(graphCalls).toEqual([]) })

  it('lists departments; counts staff after opt-outs and fills {{staff_name}}', async () => {
    const o = await api('admin', 'GET', '/comms/yajur-connect/send/audiences')
    expect(o.body.departments.map((d: { name: string }) => d.name)).toEqual(expect.arrayContaining(['Science', 'Transport']))
    expect((await api('admin', 'POST', '/comms/yajur-connect/send/preview', body({ audience: { scope: 'departments', ids: [], relation: 'both' } }))).status).toBe(400)
    const p = await api('admin', 'POST', '/comms/yajur-connect/send/preview', body())
    expect(p.status).toBe(200)
    expect(p.body).toMatchObject({ count: 2, opted_out: 1, no_phone: 1, audience_label: 'Staff: Science' })
    expect(p.body.sample).toBe('Dear Asha Rao: Meeting at 4, Asha Rao.')
    const all = await api('admin', 'POST', '/comms/yajur-connect/send/preview', body({ audience: { scope: 'staff', ids: [], relation: 'both' } }))
    expect(all.body.count).toBeGreaterThanOrEqual(3)
    expect(all.body.audience_label).toBe('All staff')
  })

  it('a staff broadcast keeps a staff snapshot, and every send is suppressed by the guard', async () => {
    const c = await api('admin', 'POST', '/comms/yajur-connect/campaigns', body())
    expect(c.status).toBe(201)
    expect(c.body).toMatchObject({ recipient_count: 2, audience: aud, audience_label: 'Staff: Science' })
    await db().prepare(`UPDATE message_log SET send_after = NULL WHERE status = 'queued'`).run()
    await dispatchMessages(E, db(), IDS.school, 200)
    const rows = await db().prepare(`SELECT status, recipient, template_vars FROM message_log WHERE source_id = ?`).bind(c.body.id).all<{ status: string; recipient: string; template_vars: string }>()
    expect(rows.results.length).toBe(2)
    for (const r of rows.results) expect(r.status).toBe('suppressed')
    expect(rows.results.map((r) => JSON.parse(r.template_vars).staff_name).sort()).toEqual(['Asha Rao', 'Bala K'])
  })

  it('the log lists WhatsApp messages newest first with names, filters, and pages', async () => {
    expect((await api('admin', 'GET', '/comms/yajur-connect/log?status=nope')).status).toBe(400)
    expect((await api('admin', 'GET', '/comms/yajur-connect/log?from=yesterday')).status).toBe(400)
    const l = await api('admin', 'GET', '/comms/yajur-connect/log?status=blocked&q=Asha')
    expect(l.status).toBe(200)
    expect(l.body.total).toBe(1)
    expect(l.body.items[0]).toMatchObject({ name: 'Asha Rao', template_code: CODE, status: 'blocked' })
    expect(l.body.items[0].error).toBeTruthy()
    const today = new Date().toISOString().slice(0, 10)
    const all = await api('admin', 'GET', `/comms/yajur-connect/log?from=${today}&to=${today}`)
    expect(all.body.total).toBeGreaterThanOrEqual(2)
    const times = all.body.items.map((x: { queued_at: string }) => x.queued_at)
    expect([...times].sort().reverse()).toEqual(times)
    expect((await api('admin', 'GET', '/comms/yajur-connect/log?to=2000-01-01')).body.total).toBe(0)
    expect((await api('admin', 'GET', '/comms/yajur-connect/log?page=5')).body.items).toEqual([])
    expect((await api(null, 'GET', '/comms/yajur-connect/log')).status).toBe(401)
  })
})
