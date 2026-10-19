/* Staff Inbox (communication.inbox, communication.mail_addresses).
   Incoming mail goes through receiveMail (what the Worker's email() handler
   calls); outgoing through the platform's Resend fallback, with Resend a
   stubbed fetch so nothing leaves the machine. The point of most cases is the
   wall between mailboxes: one person never reaches another's mail, and the
   admin who hands out addresses cannot read any. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { seed, api, E, IDS } from './fixture'
import { receiveMail } from '../../src/services/mail'

const DOMAIN = 'mail.test-school.example'
const env = E as unknown as Record<string, unknown>
const realFetch = globalThis.fetch
const sent: Record<string, any>[] = []

const mime = (to: string, subject: string, body: string, extra = '') => [
  'From: "Ravi Vendor" <ravi@vendor.example>',
  `To: ${to}`,
  `Subject: ${subject}`,
  `Message-ID: <${crypto.randomUUID()}@vendor.example>`,
  extra,
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  body,
  '--b1',
  'Content-Type: text/html; charset=utf-8',
  '',
  `<p>${body}</p><script>alert(1)</script>`,
  '--b1',
  'Content-Type: application/pdf; name="quote.pdf"',
  'Content-Disposition: attachment; filename="quote.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  btoa('%PDF-1.4 test'),
  '--b1--',
  '',
].filter((l, i) => l !== '' || i > 4).join('\r\n')

const deliver = (to: string, subject: string, body = 'Hello there', extra = '') => {
  const raw = mime(to, subject, body, extra)
  return receiveMail(E, { to, from: 'ravi@vendor.example', raw, rawSize: raw.length })
}

let farahMsg = ''

beforeAll(async () => {
  await seed()
  env.RESEND_API_KEY = 'test-resend-key'
  env.PLATFORM_MAIL_FROM = 'noreply@platform.example'
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith('https://api.resend.com/')) return realFetch(input as RequestInfo, init)
    sent.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ id: 'resend-' + sent.length }), { status: 200 })
  }) as typeof fetch
})
afterAll(() => { globalThis.fetch = realFetch; delete env.RESEND_API_KEY; delete env.PLATFORM_MAIL_FROM })

describe('addresses (admin)', () => {
  it('only an admin manages addresses', async () => {
    expect((await api('finance', 'GET', '/comms/mail-addresses')).status).toBe(403)
    expect((await api('teacher', 'PUT', '/comms/mail-addresses/domain', { domain: DOMAIN })).status).toBe(403)
  })
  it('refuses an address before the domain is set, then sets the domain', async () => {
    const before = await api('admin', 'GET', '/comms/mail-addresses')
    expect(before.status).toBe(200)
    if (!before.body.domain) {
      expect((await api('admin', 'PUT', `/comms/mail-addresses/${IDS.finance}`, { local_part: 'farah' })).status).toBe(409)
    }
    expect((await api('admin', 'PUT', '/comms/mail-addresses/domain', { domain: 'not a domain' })).status).toBe(400)
    const d = await api('admin', 'PUT', '/comms/mail-addresses/domain', { domain: DOMAIN.toUpperCase() })
    expect(d.status).toBe(200)
    expect(d.body.domain).toBe(DOMAIN)
  })
  it('assigns addresses, refuses a taken one and a parent', async () => {
    const f = await api('admin', 'PUT', `/comms/mail-addresses/${IDS.finance}`, { local_part: 'Farah' })
    expect(f.status).toBe(200)
    expect(f.body).toMatchObject({ address: `farah@${DOMAIN}`, status: 'active' })
    expect((await api('admin', 'PUT', `/comms/mail-addresses/${IDS.admin}`, { local_part: 'asha' })).status).toBe(200)
    expect((await api('admin', 'PUT', `/comms/mail-addresses/${IDS.admin}`, { local_part: 'farah' })).status).toBe(409)
    expect((await api('admin', 'PUT', `/comms/mail-addresses/${IDS.admin}`, { local_part: '.bad.' })).status).toBe(400)
    expect((await api('admin', 'PUT', `/comms/mail-addresses/${IDS.parent}`, { local_part: 'pavan' })).status).toBe(404)
    const list = await api('admin', 'GET', '/comms/mail-addresses')
    expect(list.body.items.find((x: any) => x.user_id === IDS.finance).address).toBe(`farah@${DOMAIN}`)
    expect(list.body.items.some((x: any) => x.user_id === IDS.parent)).toBe(false)
  })
})

describe('incoming mail', () => {
  it('stores mail for a known address, plus-tags included, with its attachment in R2', async () => {
    const r = await deliver(`farah+fees@${DOMAIN}`, 'Quote for chairs')
    expect('stored' in r).toBe(true)
    if (!('stored' in r)) return
    farahMsg = r.stored
    expect(r.user_id).toBe(IDS.finance)
    const row = await E.TENANT_TEST.prepare('SELECT * FROM mail_messages WHERE id = ?').bind(farahMsg).first<any>()
    expect(row).toMatchObject({ folder: 'inbox', from_address: 'ravi@vendor.example', subject: 'Quote for chairs', has_attachments: 1 })
    const att = await E.TENANT_TEST.prepare('SELECT r2_key FROM mail_attachments WHERE message_id = ?').bind(farahMsg).first<{ r2_key: string }>()
    expect(await (await E.FILES_WRITE.get(att!.r2_key))!.text()).toBe('%PDF-1.4 test')
  })
  it('refuses unknown domains and addresses', async () => {
    expect(await deliver('someone@unknown.example', 'x')).toEqual({ reject: 'No such domain here' })
    expect(await deliver(`nobody@${DOMAIN}`, 'x')).toEqual({ reject: 'No such mailbox' })
  })
  it('refuses a switched-off address and accepts again once switched on', async () => {
    expect((await api('admin', 'PUT', `/comms/mail-addresses/${IDS.admin}`, { status: 'disabled' })).body.status).toBe('disabled')
    expect(await deliver(`asha@${DOMAIN}`, 'x')).toEqual({ reject: 'No such mailbox' })
    await api('admin', 'PUT', `/comms/mail-addresses/${IDS.admin}`, { status: 'active' })
    expect('stored' in await deliver(`asha@${DOMAIN}`, 'For Asha')).toBe(true)
  })
})

describe('one mailbox each', () => {
  it('the owner lists, opens (marks read) and downloads', async () => {
    const box = await api('finance', 'GET', '/comms/mail/box')
    expect(box.body.address).toBe(`farah@${DOMAIN}`)
    expect(box.body.unread).toBeGreaterThanOrEqual(1)
    const list = await api('finance', 'GET', '/comms/mail?folder=inbox&q=chairs')
    expect(list.body.items.map((m: any) => m.id)).toContain(farahMsg)
    const open = await api('finance', 'GET', `/comms/mail/${farahMsg}`)
    expect(open.status).toBe(200)
    expect(open.body.read).toBe(true)
    expect(open.body.text).toContain('Hello there')
    expect(open.body.attachments).toHaveLength(1)
    const after = await api('finance', 'GET', '/comms/mail/box')
    expect(after.body.unread).toBe(box.body.unread - 1)
    const file = await api('finance', 'GET', `/comms/mail/${farahMsg}/attachments/${open.body.attachments[0].id}`)
    expect(file.status).toBe(200)
  })
  it('another member of staff, the admin included, cannot reach it', async () => {
    const list = await api('admin', 'GET', '/comms/mail?folder=inbox')
    expect(list.status).toBe(200)
    expect(list.body.items.map((m: any) => m.id)).not.toContain(farahMsg)
    expect((await api('admin', 'GET', `/comms/mail/${farahMsg}`)).status).toBe(404)
    expect((await api('admin', 'PATCH', `/comms/mail/${farahMsg}`, { starred: true })).status).toBe(404)
    expect((await api('admin', 'POST', `/comms/mail/${farahMsg}/trash`)).status).toBe(404)
    expect((await api('admin', 'DELETE', `/comms/mail/${farahMsg}`)).status).toBe(404)
    const atts = await E.TENANT_TEST.prepare('SELECT id FROM mail_attachments WHERE message_id = ?').bind(farahMsg).first<{ id: string }>()
    expect((await api('admin', 'GET', `/comms/mail/${farahMsg}/attachments/${atts!.id}`)).status).toBe(404)
    const row = await E.TENANT_TEST.prepare('SELECT folder, starred FROM mail_messages WHERE id = ?').bind(farahMsg).first<any>()
    expect(row).toEqual({ folder: 'inbox', starred: 0 })
  })
  it('a parent has no inbox', async () => {
    expect((await api('parent', 'GET', '/comms/mail')).status).toBe(403)
    expect((await api('parent', 'POST', '/comms/mail/send', { to: ['a@b.example'], subject: 'x', text: 'x' })).status).toBe(403)
  })
  it('star, unread, trash, restore, delete for good', async () => {
    expect((await api('finance', 'PATCH', `/comms/mail/${farahMsg}`, { starred: true, read: false })).status).toBe(200)
    const starred = await api('finance', 'GET', '/comms/mail?starred=true')
    expect(starred.body.items.find((m: any) => m.id === farahMsg)).toMatchObject({ starred: true, read: false })
    expect((await api('finance', 'DELETE', `/comms/mail/${farahMsg}`)).status).toBe(409)
    expect((await api('finance', 'POST', `/comms/mail/${farahMsg}/trash`)).status).toBe(200)
    expect((await api('finance', 'GET', '/comms/mail?folder=trash')).body.items.map((m: any) => m.id)).toContain(farahMsg)
    expect((await api('finance', 'POST', `/comms/mail/${farahMsg}/restore`)).status).toBe(200)
    expect((await api('finance', 'GET', '/comms/mail?folder=inbox')).body.items.map((m: any) => m.id)).toContain(farahMsg)
  })
})

describe('sending', () => {
  it('replies from the person\'s own address with threading headers and keeps a copy in Sent', async () => {
    sent.length = 0
    const r = await api('finance', 'POST', '/comms/mail/send', {
      to: ['ravi@vendor.example'], cc: ['RAVI@vendor.example', 'office@vendor.example'], subject: 'Re: Quote for chairs', text: 'Thanks, approved.', reply_to_id: farahMsg,
    })
    expect(r.status).toBe(201)
    expect(sent).toHaveLength(1)
    expect(sent[0].from).toBe(`Farah Finance <farah@${DOMAIN}>`)
    expect(sent[0].to).toEqual(['ravi@vendor.example'])
    expect(sent[0].cc).toEqual(['office@vendor.example'])
    const parent = await E.TENANT_TEST.prepare('SELECT message_id FROM mail_messages WHERE id = ?').bind(farahMsg).first<{ message_id: string }>()
    expect(sent[0].headers['In-Reply-To']).toBe(`<${parent!.message_id}>`)
    expect(sent[0].headers['Message-ID']).toMatch(new RegExp(`@${DOMAIN.replace(/\./g, '\\.')}>$`))
    const copy = await api('finance', 'GET', `/comms/mail/${r.body.id}`)
    expect(copy.body).toMatchObject({ folder: 'sent', subject: 'Re: Quote for chairs', text: 'Thanks, approved.' })
    expect((await api('admin', 'GET', `/comms/mail/${r.body.id}`)).status).toBe(404)
  })
  it('refuses bad recipients, a reply to someone else\'s mail, and a person with no address', async () => {
    expect((await api('finance', 'POST', '/comms/mail/send', { to: ['not-an-address'], subject: 'x', text: 'x' })).status).toBe(400)
    expect((await api('finance', 'POST', '/comms/mail/send', { to: [], subject: 'x', text: 'x' })).status).toBe(400)
    const asha = await E.TENANT_TEST.prepare(`SELECT id FROM mail_messages WHERE user_id = ? AND folder = 'inbox' LIMIT 1`).bind(IDS.admin).first<{ id: string }>()
    expect((await api('finance', 'POST', '/comms/mail/send', { to: ['a@b.example'], subject: 'x', text: 'x', reply_to_id: asha!.id })).status).toBe(404)
    await E.TENANT_TEST.prepare('DELETE FROM mail_addresses WHERE user_id = ?').bind(IDS.admin).run()
    const none = await api('admin', 'POST', '/comms/mail/send', { to: ['a@b.example'], subject: 'x', text: 'x' })
    expect(none.status).toBe(409)
    expect(none.body.code).toBe('no_mail_address')
  })
  it('says so when no email channel is set up', async () => {
    delete env.RESEND_API_KEY
    try {
      const r = await api('finance', 'POST', '/comms/mail/send', { to: ['a@b.example'], subject: 'x', text: 'x' })
      expect(r.status).toBe(409)
      expect(r.body.code).toBe('mail_not_configured')
    } finally { env.RESEND_API_KEY = 'test-resend-key' }
  })
})
