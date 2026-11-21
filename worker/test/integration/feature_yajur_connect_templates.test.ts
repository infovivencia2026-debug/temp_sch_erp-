/* Yajur Connect → Templates: the list merges Meta's templates with the
   school's mappings; making, editing and deleting go to a MOCKED Graph API
   (nothing reaches graph.facebook.com); Meta's rules are checked before
   anything is sent; readers cannot write. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { env } from 'cloudflare:workers'
import { seed, api, as, E, IDS } from './fixture'

const db = () => E.TENANT_TEST
const realFetch = globalThis.fetch
const calls: { method: string; url: string; body: string }[] = []
const META = [
  { id: '111111', name: 'fee_reminder', status: 'APPROVED', category: 'UTILITY', language: 'en', components: [
    { type: 'BODY', text: 'Dear {{1}}, the {{2}} fee is due on {{3}}. Kindly pay before the due date.', example: { body_text: [['Mr. Suresh', 'Term-2', '30 Jun 2026']] } },
    { type: 'FOOTER', text: 'Yajur Public School' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Already paid' }] }] },
  { id: '222222', name: 'admission_promo', status: 'REJECTED', category: 'MARKETING', language: 'en', rejected_reason: 'INVALID_FORMAT', components: [{ type: 'BODY', text: 'Admissions open now.' }] },
]

describe('communication.yajur_connect templates', () => {
  beforeAll(async () => {
    await seed()
    for (const who of ['admin', 'teacher'] as const) await as(who)
    ;(env as unknown as { CREDENTIAL_KEY: string }).CREDENTIAL_KEY = 'integration-test-credential-key'
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.includes('graph.facebook.com')) return realFetch(input as RequestInfo, init)
      const method = (init?.method ?? 'GET').toUpperCase()
      calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : '' })
      if (method === 'GET' && url.includes('/message_templates')) return new Response(JSON.stringify({ data: META }), { status: 200 })
      if (method === 'POST' && url.includes('/message_templates')) return new Response(JSON.stringify({ id: '333333', status: 'PENDING', category: 'UTILITY' }), { status: 200 })
      if (method === 'POST') return new Response(JSON.stringify({ success: true }), { status: 200 })
      if (method === 'DELETE') return new Response(JSON.stringify({ success: true }), { status: 200 })
      return new Response('{}', { status: 404 })
    }) as typeof fetch
    await db().prepare(`INSERT INTO message_templates (id, institution_id, code, channel, body, wa_template_name, wa_language, wa_params, is_active)
        VALUES (?, ?, 'connect_fee_reminder', 'whatsapp', 'Dear {{parent_name}}, the {{fee_term}} fee is due on {{due_on}}. Kindly pay before the due date.', 'fee_reminder', 'en', '["parent_name","fee_term","due_on"]', 1),
               (?, ?, 'fees.overdue', 'whatsapp', 'x', 'fee_reminder', 'en', '[]', 1)`)
      .bind(crypto.randomUUID(), IDS.school, crypto.randomUUID(), IDS.school).run()
  })
  afterAll(() => { globalThis.fetch = realFetch })

  it('without the WhatsApp account: lists the school mappings and says why the live status is missing', async () => {
    const r = await api('admin', 'GET', '/comms/yajur-connect/templates')
    expect(r.status).toBe(200)
    expect(r.body.live).toBe(false)
    expect(r.body.reason).toMatch(/not connected/)
    expect(r.body.items.map((x: { name: string }) => x.name)).toEqual(['fee_reminder'])
    expect((await api('admin', 'POST', '/comms/yajur-connect/templates', { name: 'x_y', category: 'UTILITY', body: 'Hello parent, all good.' })).status).toBe(409)
  })

  it('with the account: Meta status, friendly fields, samples and what the ERP uses it for', async () => {
    expect((await api('admin', 'PUT', '/admin/whatsapp/settings', { phone_number_id: '1234567', waba_id: '7654321', token: 'test-token', enabled: false })).status).toBe(200)
    const r = await api('admin', 'GET', '/comms/yajur-connect/templates')
    expect(r.body.live).toBe(true)
    const fee = r.body.items.find((x: { name: string }) => x.name === 'fee_reminder')
    expect(fee).toMatchObject({ status: 'APPROVED', category: 'UTILITY', code: 'connect_fee_reminder', sendable: true, footer: 'Yajur Public School' })
    expect(fee.fields).toEqual([
      { key: 'parent_name', label: "Parent's name", sample: 'Mr. Suresh' }, { key: 'fee_term', label: 'Fee term', sample: 'Term-2' }, { key: 'due_on', label: 'Due on', sample: '30 Jun 2026' },
    ])
    expect(fee.used_for).toEqual(['Fee reminder'])
    expect(fee.buttons).toEqual([{ type: 'QUICK_REPLY', text: 'Already paid' }])
    const rej = r.body.items.find((x: { name: string }) => x.name === 'admission_promo')
    expect(rej).toMatchObject({ status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', sendable: false })
  })

  it('refuses readers, and checks Meta rules before calling Meta', async () => {
    const good = { name: 'ptm_invite', category: 'UTILITY', language: 'en', body: 'Dear {{1}}, the PTM for {{2}} is on {{3}}. Please attend.',
      fields: [{ name: 'Parent name', sample: 'Mrs. Lakshmi' }, { name: 'Class', sample: 'Class 6-B' }, { name: 'Meeting date', sample: '5 Jul 2026' }],
      footer: 'Yajur Public School', buttons: [{ type: 'QUICK_REPLY', text: 'I will attend' }, { type: 'PHONE_NUMBER', text: 'Call school', phone_number: '+918886663636' }] }
    expect((await api('teacher', 'POST', '/comms/yajur-connect/templates', good)).status).toBe(403)
    expect((await api('teacher', 'DELETE', '/comms/yajur-connect/templates/fee_reminder')).status).toBe(403)
    const before = calls.length
    const bad = async (patch: Record<string, unknown>) => (await api('admin', 'POST', '/comms/yajur-connect/templates', { ...good, ...patch })).status
    expect(await bad({ name: 'Bad Name' })).toBe(400)
    expect(await bad({ category: 'PROMO' })).toBe(400)
    expect(await bad({ body: 'Dear {{1}}, PTM on {{3}}. Please attend.' })).toBe(400) // gap
    expect(await bad({ body: '{{1}} please attend the PTM.' })).toBe(400) // starts with a variable
    expect(await bad({ fields: [{ name: 'Parent name', sample: '' }] })).toBe(400)
    expect(await bad({ footer: 'Thanks {{1}}' })).toBe(400)
    expect(await bad({ body: 'Dear {{1}}, admissions open with a discount for {{2}} on {{3}}. Hurry.' })).toBe(400) // promo in utility
    expect(await bad({ buttons: [{ type: 'URL', text: 'Pay', url: 'http://x.test' }] })).toBe(400)
    expect(calls.length).toBe(before)
  })

  it('makes a template on Meta and saves it for the Send tab with named fields', async () => {
    const body = { name: 'ptm_invite', category: 'UTILITY', language: 'en', body: 'Dear {{1}}, the PTM for {{2}} is on {{3}}. Please attend.',
      fields: [{ name: 'Parent name', sample: 'Mrs. Lakshmi' }, { name: 'Class', sample: 'Class 6-B' }, { name: 'Meeting date', sample: '5 Jul 2026' }],
      footer: 'Yajur Public School', header: { type: 'text', text: 'Parent-Teacher Meeting' }, buttons: [{ type: 'QUICK_REPLY', text: 'I will attend' }] }
    const r = await api('admin', 'POST', '/comms/yajur-connect/templates', body)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: '333333', code: 'connect_ptm_invite', status: 'PENDING' })
    const sent = calls.filter((x) => x.method === 'POST' && x.url.includes('/7654321/message_templates')).pop()!
    const payload = JSON.parse(sent.body)
    expect(payload).toMatchObject({ name: 'ptm_invite', language: 'en', category: 'UTILITY' })
    expect(payload.components.map((x: { type: string }) => x.type)).toEqual(['HEADER', 'BODY', 'FOOTER', 'BUTTONS'])
    expect(payload.components[1].example.body_text).toEqual([['Mrs. Lakshmi', 'Class 6-B', '5 Jul 2026']])
    const row = await db().prepare(`SELECT body, wa_params FROM message_templates WHERE code = 'connect_ptm_invite'`).first<{ body: string; wa_params: string }>()
    expect(row!.body).toBe('Dear {{parent_name}}, the PTM for {{class}} is on {{meeting_date}}. Please attend.')
    expect(JSON.parse(row!.wa_params)).toEqual(['parent_name', 'class', 'meeting_date'])
  })

  it('edits by id and deletes by name on Meta; a deleted template is no longer offered', async () => {
    const edit = await api('admin', 'PUT', '/comms/yajur-connect/templates/111111', { name: 'fee_reminder', category: 'UTILITY', language: 'en',
      body: 'Dear {{1}}, the {{2}} fee is due on {{3}}. Please pay on time.', fields: [{ name: 'Parent name', sample: 'Mr. Suresh' }, { name: 'Fee term', sample: 'Term-2' }, { name: 'Due on', sample: '30 Jun' }] })
    expect(edit.status).toBe(200)
    expect(calls.some((x) => x.method === 'POST' && /\/111111$/.test(x.url))).toBe(true)
    expect((await api('admin', 'PUT', '/comms/yajur-connect/templates/abc', {})).status).toBe(400)
    const del = await api('admin', 'DELETE', '/comms/yajur-connect/templates/ptm_invite?id=333333')
    expect(del.status).toBe(200)
    expect(calls.some((x) => x.method === 'DELETE' && x.url.includes('name=ptm_invite') && x.url.includes('hsm_id=333333'))).toBe(true)
    const send = await api('admin', 'GET', '/comms/yajur-connect/send/templates')
    expect(send.body.items.map((x: { code: string }) => x.code)).not.toContain('connect_ptm_invite')
  })
})
