/* Inbox (communication.inbox): a member of staff's own school email.

   Every query here is keyed by c.id.userId and no route takes a user id, so
   a person can only ever reach their own mailbox: another person's message
   id answers 404, the same as one that does not exist. Admins hold no route
   into mail_messages (mail_addresses.ts assigns addresses only), and a
   platform account has no mailbox in a school.

   Mail arrives through services/mail.ts receiveMail (the Worker's email()
   handler) and leaves through the person's connected mailbox on the school's
   mail server, else the school's email channel. */
import type { Ctx, Router } from '../../router'
import { reply } from '../../router'
import { HttpError, badRequest, clampInt, conflict, forbidden, like, notFound, readJSON, uuid } from '../../http'
import type { MailConnection, MailFolder, MailImportStatus, MailMessage, MailPerson, MailSummary, MailSendInput } from '@shared/api/feature_inbox'
import { MAX_TEXT, angle, domainOf, isAddress, mailProvider, newMessageId, snippetOf } from '../../services/mail'
import { IMPORT_JOB, loginProblem, mailServer, mailboxPassword, testLogin, type MailServer } from '../../services/mail_import'
import { enqueue } from '../../services/jobs'
import { sendSMTP } from '../../services/smtp'
import { sealSecret } from '../admin/providers'

/* Every member of staff has an inbox, like notifications (owner, 2026-10-21):
   no role grant is needed, only a staff role. Families and students have none. */
const READ = 'auth'
const WRITE = 'auth'
const NOT_STAFF = new Set(['parent', 'student'])
const FOLDERS: MailFolder[] = ['inbox', 'sent', 'trash']
const MAX_RECIPIENTS = 50

interface Row {
  id: string; folder: MailFolder; from_address: string; from_name: string; to_list: string; cc_list: string
  subject: string; snippet: string; text_body: string; html_body: string | null; message_id: string | null
  in_reply_to: string | null; references_list: string | null; thread_key: string | null
  read_at: string | null; starred: number; has_attachments: number; received_at: string
}

/** The signed-in person; a platform account acting in a school has no mailbox there. */
function owner(c: Ctx): string {
  if (c.id.platformAdmin) throw forbidden('a platform account has no mailbox in a school')
  if (!c.id.roles.some((r) => !NOT_STAFF.has(r))) throw forbidden('only staff have a school mailbox')
  return c.id.userId
}

const people = (raw: string): MailPerson[] => { try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] } catch { return [] } }

const summary = (r: Row): MailSummary => ({
  id: r.id, folder: r.folder, from: { name: r.from_name, address: r.from_address }, to: people(r.to_list),
  subject: r.subject, snippet: r.snippet, received_at: r.received_at, read: r.read_at !== null,
  starred: !!r.starred, has_attachments: !!r.has_attachments,
})

async function mine(c: Ctx, user: string): Promise<Row> {
  const row = await c.db.prepare('SELECT * FROM mail_messages WHERE id = ? AND user_id = ?').bind(c.params.id, user).first<Row>()
  if (!row) throw notFound('message not found')
  return row
}

const recipients = (v: unknown, what: string): string[] => {
  const list = (Array.isArray(v) ? v : []).map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean)
  for (const a of list) if (!isAddress(a)) throw badRequest(`${a} is not an email address (${what})`)
  return [...new Set(list)]
}

async function connection(c: Ctx, user: string): Promise<MailConnection> {
  const [server, box, row] = await Promise.all([
    mailServer(c.db),
    c.db.prepare('SELECT address FROM mail_addresses WHERE user_id = ?').bind(user).first<{ address: string }>(),
    c.db.prepare(`SELECT connected_at, import_state, import_done, import_total, import_error, import_updated_at
        FROM mail_connections WHERE user_id = ?`).bind(user).first<{ connected_at: string; import_state: MailImportStatus['state']
        import_done: number; import_total: number; import_error: string | null; import_updated_at: string | null }>(),
  ])
  return {
    server_ready: !!server.imap_host && !!server.smtp_host,
    address: box?.address ?? null,
    connected: !!row,
    connected_at: row?.connected_at ?? null,
    import: {
      state: row?.import_state ?? 'none', done: Number(row?.import_done ?? 0), total: Number(row?.import_total ?? 0),
      error: row?.import_error ?? null, updated_at: row?.import_updated_at ?? null,
    },
  }
}

/** The server and the address to sign in with, or why there is none. */
async function connectable(c: Ctx, user: string): Promise<{ server: MailServer; address: string }> {
  const [server, box] = await Promise.all([
    mailServer(c.db),
    c.db.prepare('SELECT address, status FROM mail_addresses WHERE user_id = ?').bind(user).first<{ address: string; status: string }>(),
  ])
  if (!box) throw new HttpError(409, 'you have no school email address yet. The office gives one on Communication > Mail addresses.', { code: 'no_mail_address' })
  if (!server.imap_host || !server.smtp_host) throw new HttpError(409, 'the school has not set its mail server yet. The office sets it on Communication > Mail addresses.', { code: 'mail_server_not_set' })
  return { server, address: box.address }
}

async function signIn(server: MailServer, address: string, password: string): Promise<void> {
  try { await testLogin(server, address, password) } catch (e) {
    const p = loginProblem(e)
    throw new HttpError(p.status, p.message, { code: p.status === 400 ? 'mailbox_sign_in_refused' : 'mail_server_unreachable' })
  }
}

export function registerInbox(r: Router): void {
  r.typed('GET /comms/mail/box', READ, async (c) => {
    const user = owner(c)
    const [box, unread] = await Promise.all([
      c.db.prepare('SELECT address, status FROM mail_addresses WHERE user_id = ?').bind(user).first<{ address: string; status: 'active' | 'disabled' }>(),
      c.db.prepare(`SELECT COUNT(*) AS n FROM mail_messages WHERE user_id = ? AND folder = 'inbox' AND read_at IS NULL`).bind(user).first<{ n: number }>(),
    ])
    return { address: box?.address ?? null, status: box?.status ?? null, unread: Number(unread?.n ?? 0) }
  })

  /* "Connect your mailbox": the person's own password for the school's mail
     server. Only its owner reaches a connection; the password goes in once,
     sealed, and no route sends it back. */
  r.typed('GET /comms/mail/connection', READ, async (c) => connection(c, owner(c)))

  r.typed('POST /comms/mail/connection/test', WRITE, async (c) => {
    const user = owner(c)
    const b = await readJSON<{ password?: unknown }>(c.req)
    const { server, address } = await connectable(c, user)
    const password = typeof b.password === 'string' && b.password !== '' ? b.password : await mailboxPassword(c.env, c.db, user)
    if (!password) throw badRequest('enter your mailbox password')
    await signIn(server, address, password)
    return { ok: true as const }
  })

  r.typed('PUT /comms/mail/connection', WRITE, async (c) => {
    const user = owner(c)
    const b = await readJSON<{ password?: unknown }>(c.req)
    const password = typeof b.password === 'string' ? b.password : ''
    if (!password) throw badRequest('enter your mailbox password')
    if (password.length > 1000) throw badRequest('that password is too long')
    const { server, address } = await connectable(c, user)
    await signIn(server, address, password)
    const sealed = await sealSecret(c, password)
    await c.db.prepare(`INSERT INTO mail_connections (user_id, secret, connected_at) VALUES (?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET secret = excluded.secret, connected_at = excluded.connected_at`)
      .bind(user, sealed, new Date().toISOString()).run()
    return connection(c, user)
  })

  r.typed('DELETE /comms/mail/connection', WRITE, async (c) => {
    const user = owner(c)
    await c.db.prepare('DELETE FROM mail_connections WHERE user_id = ?').bind(user).run()
    return { ok: true as const }
  })

  r.typed('POST /comms/mail/connection/import', WRITE, async (c) => {
    const user = owner(c)
    const row = await c.db.prepare('SELECT import_state, import_updated_at FROM mail_connections WHERE user_id = ?').bind(user)
      .first<{ import_state: string; import_updated_at: string | null }>()
    if (!row) throw conflict('connect your mailbox first')
    await connectable(c, user)
    // A copy that has said nothing for 15 minutes has stopped (a job lost); it may start again.
    const busy = (row.import_state === 'queued' || row.import_state === 'running')
      && Date.now() - Date.parse(row.import_updated_at ?? '') < 15 * 60_000
    if (busy) throw conflict('your old mail is being copied already')
    await c.db.prepare(`UPDATE mail_connections SET import_state = 'queued', import_done = 0, import_total = 0, import_error = NULL,
        import_updated_at = ? WHERE user_id = ?`).bind(new Date().toISOString(), user).run()
    await enqueue(c.env, IMPORT_JOB, { user_id: user }, { institution_id: c.id.institution!.id })
    return connection(c, user)
  })

  r.typed('GET /comms/mail', READ, async (c) => {
    const user = owner(c)
    const sp = c.url.searchParams
    const folder = (sp.get('folder') || 'inbox') as MailFolder
    if (!FOLDERS.includes(folder)) throw badRequest('folder is inbox, sent or trash')
    const limit = clampInt(sp.get('limit'), 50, 1, 100), offset = clampInt(sp.get('offset'), 0, 0, 1_000_000)
    const q = (sp.get('q') ?? '').trim()
    const where = ['user_id = ?', 'folder = ?']
    const args: unknown[] = [user, folder]
    if (sp.get('starred') === 'true') where.push('starred = 1')
    if (q) {
      where.push(`(subject LIKE ? ESCAPE '\\' OR from_address LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\' OR to_list LIKE ? ESCAPE '\\' OR text_body LIKE ? ESCAPE '\\')`)
      args.push(...Array(5).fill(like(q)))
    }
    const w = where.join(' AND ')
    const [rows, total] = await Promise.all([
      c.db.prepare(`SELECT id, folder, from_address, from_name, to_list, subject, snippet, read_at, starred, has_attachments, received_at
          FROM mail_messages WHERE ${w} ORDER BY received_at DESC, id LIMIT ? OFFSET ?`).bind(...args, limit, offset).all<Row>(),
      c.db.prepare(`SELECT COUNT(*) AS n FROM mail_messages WHERE ${w}`).bind(...args).first<{ n: number }>(),
    ])
    return { items: rows.results.map(summary), total: Number(total?.n ?? 0), limit, offset }
  })

  r.typed('GET /comms/mail/{id}', READ, async (c) => {
    const user = owner(c)
    const row = await mine(c, user)
    if (row.read_at === null) {
      row.read_at = new Date().toISOString()
      await c.db.prepare('UPDATE mail_messages SET read_at = ? WHERE id = ? AND user_id = ?').bind(row.read_at, row.id, user).run()
    }
    const atts = await c.db.prepare('SELECT id, filename, content_type, size_bytes FROM mail_attachments WHERE message_id = ? AND user_id = ? ORDER BY created_at, id')
      .bind(row.id, user).all<{ id: string; filename: string; content_type: string; size_bytes: number }>()
    const out: MailMessage = { ...summary(row), cc: people(row.cc_list), text: row.text_body, html: row.html_body, message_id: row.message_id,
      attachments: atts.results.map((a) => ({ ...a, size_bytes: Number(a.size_bytes) })) }
    return out
  })

  r.typed('PATCH /comms/mail/{id}', READ, async (c) => {
    const user = owner(c)
    const b = await readJSON<{ read?: unknown; starred?: unknown }>(c.req)
    const row = await mine(c, user)
    const sets: string[] = [], args: unknown[] = []
    if (typeof b.read === 'boolean') { sets.push('read_at = ?'); args.push(b.read ? row.read_at ?? new Date().toISOString() : null) }
    if (typeof b.starred === 'boolean') { sets.push('starred = ?'); args.push(b.starred ? 1 : 0) }
    if (!sets.length) throw badRequest('nothing to change: send read or starred')
    await c.db.prepare(`UPDATE mail_messages SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...args, row.id, user).run()
    return { ok: true as const }
  })

  r.typed('POST /comms/mail/{id}/trash', WRITE, async (c) => {
    const user = owner(c)
    const row = await mine(c, user)
    if (row.folder !== 'trash') {
      await c.db.prepare(`UPDATE mail_messages SET folder = 'trash', trashed_from = ? WHERE id = ? AND user_id = ?`).bind(row.folder, row.id, user).run()
    }
    return { ok: true as const }
  })

  r.typed('POST /comms/mail/{id}/restore', WRITE, async (c) => {
    const user = owner(c)
    const row = await mine(c, user)
    if (row.folder !== 'trash') throw conflict('only a message in Trash can be restored')
    await c.db.prepare(`UPDATE mail_messages SET folder = COALESCE(trashed_from, 'inbox'), trashed_from = NULL WHERE id = ? AND user_id = ?`).bind(row.id, user).run()
    return { ok: true as const }
  })

  r.typed('DELETE /comms/mail/{id}', WRITE, async (c) => {
    const user = owner(c)
    const row = await mine(c, user)
    if (row.folder !== 'trash') throw conflict('move the message to Trash first; only Trash deletes for good')
    const keys = await c.db.prepare('SELECT r2_key FROM mail_attachments WHERE message_id = ? AND user_id = ?').bind(row.id, user).all<{ r2_key: string }>()
    await c.db.batch([
      c.db.prepare('DELETE FROM mail_attachments WHERE message_id = ? AND user_id = ?').bind(row.id, user),
      c.db.prepare('DELETE FROM mail_messages WHERE id = ? AND user_id = ?').bind(row.id, user),
    ])
    if (keys.results.length) await c.env.FILES_WRITE.delete(keys.results.map((k) => k.r2_key))
    return { ok: true as const }
  })

  // An attachment of one of my messages. Always a download: an HTML file must never render on the app's origin.
  r.get('/comms/mail/{id}/attachments/{aid}', READ, async (c) => {
    const user = owner(c)
    const a = await c.db.prepare('SELECT filename, content_type, r2_key FROM mail_attachments WHERE id = ? AND message_id = ? AND user_id = ?')
      .bind(c.params.aid, c.params.id, user).first<{ filename: string; content_type: string; r2_key: string }>()
    if (!a) throw notFound('attachment not found')
    const obj = await c.env.FILES_WRITE.get(a.r2_key)
    if (!obj) throw notFound('attachment not found')
    const name = a.filename.replace(/["\r\n\\]/g, '') || 'attachment'
    return new Response(obj.body, { headers: {
      'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"`,
      'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store',
    } })
  })

  r.typed('POST /comms/mail/send', WRITE, async (c) => {
    const user = owner(c)
    const b = await readJSON<Partial<MailSendInput>>(c.req)
    const to = recipients(b.to, 'To'), cc = recipients(b.cc, 'Cc').filter((a) => !to.includes(a))
    if (!to.length) throw badRequest('add at least one address in To')
    if (to.length + cc.length > MAX_RECIPIENTS) throw badRequest(`at most ${MAX_RECIPIENTS} recipients in one message`)
    const subject = String(b.subject ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 998)
    const text = String(b.text ?? '')
    if (!subject && !text.trim()) throw badRequest('write a subject or a message')
    if (text.length > MAX_TEXT) throw badRequest('the message is too long')

    const box = await c.db.prepare('SELECT address, status FROM mail_addresses WHERE user_id = ?').bind(user).first<{ address: string; status: string }>()
    if (!box) throw new HttpError(409, 'you have no school email address yet. The office gives one on Communication > Mail addresses.', { code: 'no_mail_address' })
    if (box.status !== 'active') throw new HttpError(409, 'your school email address is switched off. Ask the office to switch it on.', { code: 'mail_address_disabled' })

    let parent: Row | null = null
    if (b.reply_to_id) {
      parent = await c.db.prepare('SELECT * FROM mail_messages WHERE id = ? AND user_id = ?').bind(String(b.reply_to_id), user).first<Row>()
      if (!parent) throw notFound('the message being answered was not found')
    }
    const messageId = newMessageId(domainOf(box.address))
    const headers: Record<string, string> = { 'Message-ID': angle(messageId) }
    let refs: string[] = []
    if (parent?.message_id) {
      refs = [...(parent.references_list ?? '').split(' ').filter(Boolean), parent.message_id]
      headers['In-Reply-To'] = angle(parent.message_id)
      headers['References'] = refs.map(angle).join(' ')
    }

    const out = { to: to[0], subject, body: text, dlt: '', mail: { from: box.address, fromName: c.id.fullName, to, cc, headers } }
    // A connected mailbox sends through the school's mail server as its owner;
    // otherwise the school's email channel sends with the address in From.
    try {
      const [server, password] = await Promise.all([mailServer(c.db), mailboxPassword(c.env, c.db, user)])
      if (password !== null && server.smtp_host) {
        await sendSMTP({ host: server.smtp_host, port: server.smtp_port, username: box.address, password,
          fromAddress: box.address, fromName: c.id.fullName, security: server.smtp_security }, out)
      } else {
        const provider = await mailProvider(c.env, c.db, c.id.institution!.id)
        if (!provider.configured) throw new HttpError(409, `mail cannot be sent yet: the school's email channel is ${provider.why}. Set it up on Communication > Message Channels, or connect your mailbox.`, { code: 'mail_not_configured' })
        await provider.send(out)
      }
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new HttpError(422, 'the mail was not sent: ' + (err as Error).message, { code: 'mail_send_failed' })
    }

    const id = uuid(), at = new Date().toISOString()
    const list = (xs: string[]) => JSON.stringify(xs.map((address) => ({ name: '', address })))
    await c.db.prepare(`INSERT INTO mail_messages (id, user_id, folder, from_address, from_name, to_list, cc_list, subject, snippet, text_body,
        message_id, in_reply_to, references_list, thread_key, read_at, send_status, received_at, created_at)
        VALUES (?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)`)
      .bind(id, user, box.address, c.id.fullName, list(to), list(cc), subject, snippetOf(text), text, messageId,
        parent?.message_id ?? null, refs.length ? refs.join(' ') : null, parent?.thread_key ?? parent?.message_id ?? messageId, at, at, at).run()
    return reply({ id }, 201)
  })
}
