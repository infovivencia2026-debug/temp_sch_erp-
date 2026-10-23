/* Connect your mailbox (communication.inbox): a member of staff's own
   password for the school's mail server, used to send as them over SMTP and
   to copy their old mail in over IMAP. Both servers are fakes behind
   globalThis.__erpDial (src/services/dial.ts), so nothing leaves the machine.
   The points: only the owner reaches a connection, the password never comes
   back from any route, sending signs in as the owner, and the copy stores,
   skips duplicates and carries on from the last UID. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { seed, api, E, IDS } from './fixture'
import { receiveMail } from '../../src/services/mail'
import { runImportChunk } from '../../src/services/mail_import'

const DOMAIN = 'connect.test-school.example'
const FARAH = `farah@${DOMAIN}`
const SECRET = 'mailbox pass "with" quotes\\'
const env = E as unknown as Record<string, unknown>
const g = globalThis as { __erpDial?: unknown }
const enc = new TextEncoder(), dec = new TextDecoder()

/* --- a fake socket: lines in, scripted replies out ----------------------- */

function fakeSocket(greeting: string, onData: (text: string, send: (s: string | Uint8Array) => void) => void): Socket {
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const readable = new ReadableStream<Uint8Array>({ start(c) { ctl = c } })
  const send = (s: string | Uint8Array) => { try { ctl.enqueue(typeof s === 'string' ? enc.encode(s) : s) } catch { /* closed */ } }
  const writable = new WritableStream<Uint8Array>({ write(chunk) { onData(dec.decode(chunk), send) } })
  send(greeting)
  const sock = {
    readable, writable, opened: Promise.resolve({}), closed: Promise.resolve(), upgraded: false, secureTransport: 'on',
    close: async () => { try { ctl.close() } catch { /* closed */ } },
    startTls: () => sock,
  }
  return sock as unknown as Socket
}

/** Splits written bytes into CRLF lines (an SMTP DATA body is kept whole). */
function lines(handle: (line: string, send: (s: string | Uint8Array) => void) => void) {
  let buf = ''
  return (text: string, send: (s: string | Uint8Array) => void) => {
    buf += text
    let i
    while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); handle(l, send) }
  }
}

/* --- fake IMAP ----------------------------------------------------------- */

const mime = (id: string, subject: string, from: string, to: string, attach = false) => [
  `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${id}>`, 'Date: Tue, 01 Jul 2025 10:00:00 +0530', 'MIME-Version: 1.0',
  ...(attach
    ? ['Content-Type: multipart/mixed; boundary="b"', '', '--b', 'Content-Type: text/plain', '', `Body of ${subject}`, '--b',
      'Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment; filename="a.pdf"', 'Content-Transfer-Encoding: base64', '',
      btoa('%PDF old'), '--b--', '']
    : ['Content-Type: text/plain', '', `Body of ${subject}`, '']),
].join('\r\n')

const DUP_ID = 'already-here@vendor.example'
const boxes: Record<string, { uidvalidity: number; msgs: Map<number, { raw: string; seen: boolean }> }> = {
  INBOX: { uidvalidity: 7, msgs: new Map([
    [1, { raw: mime('old-1@vendor.example', 'Old one', 'ravi@vendor.example', FARAH), seen: true }],
    [2, { raw: mime(DUP_ID, 'Already here', 'ravi@vendor.example', FARAH), seen: false }],
    [3, { raw: mime('old-3@vendor.example', 'Old three', 'ravi@vendor.example', FARAH), seen: false }],
  ]) },
  'INBOX.Sent': { uidvalidity: 9, msgs: new Map([[5, { raw: mime('sent-5@x', 'My old reply', FARAH, 'ravi@vendor.example', true), seen: true }]]) },
}
const imap = { logins: [] as string[][], fetched: [] as number[] }
const unq = (s: string) => s.replace(/\\(.)/g, '$1')

function imapSocket(): Socket {
  let selected = ''
  return fakeSocket('* OK fake IMAP ready\r\n', lines((l, send) => {
    const [tag, ...rest] = l.split(' ')
    const cmd = rest.join(' ')
    const ok = (what: string) => send(`${tag} OK ${what} done\r\n`)
    let m: RegExpExecArray | null
    if ((m = /^LOGIN "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/.exec(cmd))) {
      const [user, pass] = [unq(m[1]), unq(m[2])]
      imap.logins.push([user, pass])
      if (user === FARAH && pass === SECRET) ok('LOGIN')
      else send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`)
    } else if (cmd === 'LIST "" "*"') {
      send('* LIST (\\HasChildren) "." INBOX\r\n* LIST (\\HasNoChildren \\Sent) "." "INBOX.Sent"\r\n* LIST (\\HasNoChildren \\Drafts) "." "INBOX.Drafts"\r\n')
      ok('LIST')
    } else if ((m = /^EXAMINE "(.*)"$/.exec(cmd)) && boxes[m[1]]) {
      selected = m[1]
      send(`* ${boxes[selected].msgs.size} EXISTS\r\n* OK [UIDVALIDITY ${boxes[selected].uidvalidity}] UIDs valid\r\n`)
      ok('EXAMINE')
    } else if (cmd === 'UID SEARCH ALL') {
      send(`* SEARCH ${[...boxes[selected].msgs.keys()].join(' ')}\r\n`.replace(' \r\n', '\r\n'))
      ok('SEARCH')
    } else if ((m = /^UID FETCH (\d+) \(UID FLAGS BODY\.PEEK\[\]\)$/.exec(cmd))) {
      const uid = Number(m[1]), msg = boxes[selected].msgs.get(uid)
      imap.fetched.push(uid)
      if (msg) {
        const body = enc.encode(msg.raw)
        send(`* 1 FETCH (UID ${uid} FLAGS (${msg.seen ? '\\Seen' : ''}) BODY[] {${body.length}}\r\n`)
        send(body)
        send(')\r\n')
      }
      ok('FETCH')
    } else if (cmd === 'LOGOUT') { send('* BYE\r\n'); ok('LOGOUT') }
    else send(`${tag} BAD unknown command\r\n`)
  }))
}

/* --- fake SMTP ----------------------------------------------------------- */

const smtp = { auth: [] as string[], from: [] as string[], rcpt: [] as string[], data: [] as string[] }

function smtpSocket(): Socket {
  let inData = false, body = ''
  return fakeSocket('220 fake SMTP\r\n', lines((l, send) => {
    if (inData) {
      if (l === '.') { inData = false; smtp.data.push(body); body = ''; send('250 queued\r\n') } else body += l + '\r\n'
      return
    }
    if (l.startsWith('EHLO')) send('250-fake\r\n250 AUTH PLAIN\r\n')
    else if (l.startsWith('AUTH PLAIN ')) {
      const [, user, pass] = atob(l.slice(11)).split('\u0000')
      smtp.auth.push(`${user}|${pass}`)
      send(user === FARAH && pass === SECRET ? '235 ok\r\n' : '535 no\r\n')
    } else if (l.startsWith('MAIL FROM:')) { smtp.from.push(l.slice(10)); send('250 ok\r\n') }
    else if (l.startsWith('RCPT TO:')) { smtp.rcpt.push(l.slice(8)); send('250 ok\r\n') }
    else if (l === 'DATA') { inData = true; send('354 go\r\n') }
    else if (l === 'QUIT') send('221 bye\r\n')
    else send('500 what\r\n')
  }))
}

const SERVER = { imap_host: 'mail.connect.test-school.example', imap_port: 993, smtp_host: 'mail.connect.test-school.example', smtp_port: 465, smtp_security: 'tls' }

beforeAll(async () => {
  await seed()
  env.CREDENTIAL_KEY = 'integration-test-credential-key'
  g.__erpDial = (addr: SocketAddress) => {
    if (addr.hostname !== SERVER.imap_host) throw new Error('test dialled an unknown host ' + addr.hostname)
    return addr.port === 993 ? imapSocket() : smtpSocket()
  }
  expect((await api('admin', 'PUT', '/comms/mail-addresses/domain', { domain: DOMAIN })).status).toBe(200)
  expect((await api('admin', 'PUT', `/comms/mail-addresses/${IDS.finance}`, { local_part: 'farah' })).status).toBe(200)
  expect((await api('admin', 'PUT', `/comms/mail-addresses/${IDS.admin}`, { local_part: 'asha' })).status).toBe(200)
})
afterAll(() => { delete g.__erpDial; delete env.CREDENTIAL_KEY })

const noSecret = (body: unknown) => expect(JSON.stringify(body)).not.toContain('mailbox pass')

describe('the school mail server (admin)', () => {
  it('needs comms.mail.manage and checks what it is given', async () => {
    expect((await api('teacher', 'PUT', '/comms/mail-addresses/server', SERVER)).status).toBe(403)
    expect((await api('finance', 'GET', '/comms/mail-addresses/server')).status).toBe(403)
    expect((await api('admin', 'PUT', '/comms/mail-addresses/server', { ...SERVER, imap_host: 'not a host' })).status).toBe(400)
    expect((await api('admin', 'PUT', '/comms/mail-addresses/server', { ...SERVER, smtp_port: 70000 })).status).toBe(400)
    expect((await api('admin', 'PUT', '/comms/mail-addresses/server', { ...SERVER, smtp_security: 'none' })).status).toBe(400)
  })
  it('a person cannot connect before the server is set', async () => {
    const r = await api('finance', 'PUT', '/comms/mail/connection', { password: SECRET })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('mail_server_not_set')
  })
  it('saves and reads back the server', async () => {
    const r = await api('admin', 'PUT', '/comms/mail-addresses/server', SERVER)
    expect(r.status).toBe(200)
    expect((await api('admin', 'GET', '/comms/mail-addresses/server')).body).toEqual(SERVER)
  })
})

describe('connecting a mailbox', () => {
  it('refuses a wrong password and saves nothing', async () => {
    const r = await api('finance', 'PUT', '/comms/mail/connection', { password: 'wrong' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('mailbox_sign_in_refused')
    expect((await api('finance', 'GET', '/comms/mail/connection')).body.connected).toBe(false)
  })
  it('signs in as the owner\'s own address and keeps the password sealed', async () => {
    const r = await api('finance', 'PUT', '/comms/mail/connection', { password: SECRET })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ connected: true, server_ready: true, address: FARAH })
    noSecret(r.body)
    expect(imap.logins.at(-1)).toEqual([FARAH, SECRET])
    const row = await E.TENANT_TEST.prepare('SELECT secret FROM mail_connections WHERE user_id = ?').bind(IDS.finance).first<{ secret: ArrayBuffer }>()
    expect(dec.decode(new Uint8Array(row!.secret))).not.toContain('mailbox pass')
  })
  it('test signs in with the saved password, or a new one, and saves nothing', async () => {
    expect((await api('finance', 'POST', '/comms/mail/connection/test', {})).status).toBe(200)
    expect((await api('finance', 'POST', '/comms/mail/connection/test', { password: 'wrong' })).status).toBe(400)
    expect((await api('finance', 'POST', '/comms/mail/connection/test', {})).status).toBe(200)
  })
  it('no other person reaches it, the admin included, and no route returns the password', async () => {
    const mine = await api('admin', 'GET', '/comms/mail/connection')
    expect(mine.status).toBe(200)
    expect(mine.body).toMatchObject({ connected: false, address: `asha@${DOMAIN}` })
    expect((await api('admin', 'POST', '/comms/mail/connection/test', {})).status).toBe(400)
    expect((await api('admin', 'POST', '/comms/mail/connection/import')).status).toBe(409)
    expect((await api('parent', 'GET', '/comms/mail/connection')).status).toBe(403)
    expect((await api('parent', 'PUT', '/comms/mail/connection', { password: SECRET })).status).toBe(403)
    for (const path of ['/comms/mail/connection', '/comms/mail/box', '/comms/mail-addresses', '/comms/mail-addresses/server']) {
      noSecret((await api('finance', 'GET', path)).body)
      noSecret((await api('admin', 'GET', path)).body)
    }
    expect((await api('finance', 'GET', '/comms/mail/connection')).body.connected).toBe(true)
  })
})

describe('sending through the connected mailbox', () => {
  it('signs in to SMTP as the owner, From their own address, and keeps a copy in Sent', async () => {
    const r = await api('finance', 'POST', '/comms/mail/send', { to: ['ravi@vendor.example'], subject: 'Through my mailbox', text: 'Hello' })
    expect(r.status).toBe(201)
    expect(smtp.auth.at(-1)).toBe(`${FARAH}|${SECRET}`)
    expect(smtp.from.at(-1)).toBe(`<${FARAH}>`)
    expect(smtp.rcpt).toContain('<ravi@vendor.example>')
    expect(smtp.data.at(-1)).toContain(`From: Farah Finance <${FARAH}>`)
    expect((await api('finance', 'GET', `/comms/mail/${r.body.id}`)).body).toMatchObject({ folder: 'sent', subject: 'Through my mailbox' })
  })
})

describe('copying old mail', () => {
  it('copies Inbox and Sent in the background, skips a message already here, keeps attachments', async () => {
    const raw = mime(DUP_ID, 'Already here', 'ravi@vendor.example', FARAH)
    expect('stored' in await receiveMail(E, { to: FARAH, from: 'ravi@vendor.example', raw, rawSize: raw.length })).toBe(true)

    const start = await api('finance', 'POST', '/comms/mail/connection/import')
    expect(start.status).toBe(200)
    expect(['queued', 'running', 'done']).toContain(start.body.import.state)
    let s = start.body
    for (let i = 0; i < 100 && s.import.state !== 'done' && s.import.state !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 100))
      s = (await api('finance', 'GET', '/comms/mail/connection')).body
    }
    expect(s.import).toMatchObject({ state: 'done', done: 4, total: 4, error: null })

    const rows = (await E.TENANT_TEST.prepare('SELECT folder, subject, message_id, read_at, has_attachments, received_at FROM mail_messages WHERE user_id = ?')
      .bind(IDS.finance).all<any>()).results
    expect(rows.filter((x) => x.message_id === DUP_ID)).toHaveLength(1)
    const one = rows.find((x) => x.message_id === 'old-1@vendor.example')
    expect(one).toMatchObject({ folder: 'inbox', subject: 'Old one' })
    expect(one.read_at).not.toBeNull()
    expect(rows.find((x) => x.message_id === 'old-3@vendor.example').read_at).toBeNull()
    expect(one.received_at.slice(0, 10)).toBe('2025-07-01')
    const sent = rows.find((x) => x.message_id === 'sent-5@x')
    expect(sent).toMatchObject({ folder: 'sent', subject: 'My old reply', has_attachments: 1 })
    expect((await api('admin', 'GET', '/comms/mail?folder=sent')).body.items.some((m: any) => m.subject === 'My old reply')).toBe(false)
  })
  it('carries on from the last UID: a second run fetches only newer mail', async () => {
    boxes.INBOX.msgs.set(4, { raw: mime('old-4@vendor.example', 'Newer one', 'ravi@vendor.example', FARAH), seen: false })
    imap.fetched.length = 0
    await E.TENANT_TEST.prepare(`UPDATE mail_connections SET import_state = 'queued', import_done = 0 WHERE user_id = ?`).bind(IDS.finance).run()
    expect(await runImportChunk(E, E.TENANT_TEST, IDS.school, IDS.finance)).toBe(false)
    expect(imap.fetched).toEqual([4])
    const s = (await api('finance', 'GET', '/comms/mail/connection')).body
    expect(s.import).toMatchObject({ state: 'done', done: 1, total: 1 })
    const n = await E.TENANT_TEST.prepare('SELECT COUNT(*) AS n FROM mail_messages WHERE user_id = ? AND message_id = ?').bind(IDS.finance, 'old-4@vendor.example').first<{ n: number }>()
    expect(n!.n).toBe(1)
  })
  it('a refused sign-in during the copy is shown, without the password', async () => {
    await E.TENANT_TEST.prepare(`UPDATE mail_connections SET import_state = 'queued' WHERE user_id = ?`).bind(IDS.finance).run()
    const saved = (await E.TENANT_TEST.prepare('SELECT secret FROM mail_connections WHERE user_id = ?').bind(IDS.finance).first<{ secret: ArrayBuffer }>())!.secret
    const { sealSecretEnv } = await import('../../src/routes/comms/public_common')
    await E.TENANT_TEST.prepare('UPDATE mail_connections SET secret = ? WHERE user_id = ?').bind(await sealSecretEnv(E, 'stale'), IDS.finance).run()
    expect(await runImportChunk(E, E.TENANT_TEST, IDS.school, IDS.finance)).toBe(false)
    const s = (await api('finance', 'GET', '/comms/mail/connection')).body
    expect(s.import.state).toBe('failed')
    expect(s.import.error).toMatch(/refused the sign-in/)
    expect(s.import.error).not.toContain('stale')
    await E.TENANT_TEST.prepare('UPDATE mail_connections SET secret = ? WHERE user_id = ?').bind(saved, IDS.finance).run()
  })
})

describe('disconnecting', () => {
  it('forgets the password; mail already copied stays; sending falls back to the school channel', async () => {
    expect((await api('finance', 'DELETE', '/comms/mail/connection')).status).toBe(200)
    expect(await E.TENANT_TEST.prepare('SELECT 1 FROM mail_connections WHERE user_id = ?').bind(IDS.finance).first()).toBeNull()
    expect((await api('finance', 'GET', '/comms/mail/connection')).body.connected).toBe(false)
    const kept = await E.TENANT_TEST.prepare('SELECT COUNT(*) AS n FROM mail_messages WHERE user_id = ? AND message_id = ?').bind(IDS.finance, 'old-1@vendor.example').first<{ n: number }>()
    expect(kept!.n).toBe(1)
    const before = smtp.auth.length
    const r = await api('finance', 'POST', '/comms/mail/send', { to: ['ravi@vendor.example'], subject: 'x', text: 'x' })
    expect(r.body.code).toBe('mail_not_configured')
    expect(smtp.auth.length).toBe(before)
  })
})
