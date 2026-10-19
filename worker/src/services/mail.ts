import PostalMime, { type Address } from 'postal-mime'
import type { Env } from '../env'
import { institutionById, tenantDb } from '../tenant'
import { loadProviders, platformProviders, type Provider } from './messaging'
import { uuid } from '../http'

/* STAFF INBOX: a real email address per member of staff.

   In: Cloudflare Email Routing delivers every message for a school's mail
   domain to the Worker's email() handler (src/index.ts). The recipient's
   domain names the school (CONTROL mail_domains), the address names the
   person (the school's mail_addresses); anything else is refused at the SMTP
   stage, so the sender gets a bounce rather than silence.

   Out: the school's email channel (Communication > Message Channels: SMTP or
   Resend), else the platform's, with the person's own address in From. The
   provider must be allowed to send for the domain (Resend: the domain
   verified; SMTP: an account that may send as any address on it).

   Privacy: every mailbox query is keyed by the signed-in user's id; the
   admin's routes (routes/comms/mail_addresses.ts) never read mail_messages. */

export const MAX_TEXT = 200_000
export const MAX_HTML = 500_000
const MAX_ATTACHMENT = 15 << 20
const MAX_ATTACHMENTS = 20

const ADDRESS_RE = /^[^\s@<>(),;:"[\]\\]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i
const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/
const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

export const isAddress = (s: string) => ADDRESS_RE.test(s)
export const isLocalPart = (s: string) => LOCAL_RE.test(s) && !s.includes('..')
export const isDomain = (s: string) => DOMAIN_RE.test(s)
export const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase()

/** "ana+fees@school.in" is delivered to "ana@school.in". */
export function mailboxAddress(rcpt: string): string {
  const a = rcpt.trim().toLowerCase()
  const at = a.lastIndexOf('@')
  if (at < 1) return a
  const local = a.slice(0, at).split('+')[0]
  return `${local}@${a.slice(at + 1)}`
}

/** The school's mail domain, or null. */
export async function schoolDomain(env: Env, institutionId: string): Promise<string | null> {
  const r = await env.CONTROL.prepare('SELECT domain FROM mail_domains WHERE institution_id = ?').bind(institutionId).first<{ domain: string }>()
  return r?.domain ?? null
}

export interface Person { name: string; address: string }

function flatten(list: Address[] | Address | undefined): Person[] {
  const out: Person[] = []
  for (const a of list ? (Array.isArray(list) ? list : [list]) : []) {
    if (a.group) for (const g of a.group) out.push({ name: g.name ?? '', address: (g.address ?? '').toLowerCase() })
    else if (a.address) out.push({ name: a.name ?? '', address: a.address.toLowerCase() })
  }
  return out
}

/** Readable text of an HTML-only message, for the snippet, search and the plain view. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim()
}

export const snippetOf = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 160)

/** "<a@b>" -> "a@b"; Message-IDs are kept bare. */
const bareId = (v: string | undefined | null) => (v ?? '').trim().replace(/^<|>$/g, '') || null
export const angle = (id: string) => `<${id}>`
const refIds = (v: string | undefined | null) => (v ?? '').match(/<[^<>\s]+>/g)?.map((x) => x.slice(1, -1)) ?? []

export interface Inbound { to: string; from: string; raw: ReadableStream | ArrayBuffer | string; rawSize: number }
export type InboundResult = { stored: string; user_id: string } | { duplicate: true } | { reject: string }

/** Where an address lands: the school and the person, or why it is refused. */
async function routeOf(env: Env, rcpt: string) {
  const address = mailboxAddress(rcpt)
  if (!isAddress(address)) return { reject: 'Address not accepted' } as const
  const dom = await env.CONTROL.prepare('SELECT institution_id FROM mail_domains WHERE domain = ?').bind(domainOf(address)).first<{ institution_id: string }>()
  if (!dom) return { reject: 'No such domain here' } as const
  const inst = await institutionById(env, dom.institution_id)
  if (!inst || inst.status === 'suspended') return { reject: 'Mailbox unavailable' } as const
  const db = tenantDb(env, inst)
  const box = await db.prepare(`SELECT ma.user_id, ma.status FROM mail_addresses ma JOIN users u ON u.id = ma.user_id
      WHERE ma.address = ? AND u.status = 'active'`).bind(address).first<{ user_id: string; status: string }>()
  if (!box || box.status !== 'active') return { reject: 'No such mailbox' } as const
  return { inst, db, user: box.user_id } as const
}

/** One incoming message into its owner's inbox. The email() handler and the tests call this. */
export async function receiveMail(env: Env, m: Inbound): Promise<InboundResult> {
  const route = await routeOf(env, m.to)
  if ('reject' in route) return { reject: route.reject! }
  const { inst, db, user } = route
  if (m.rawSize > 30 << 20) return { reject: 'Message too large' }

  const mail = await PostalMime.parse(m.raw, { attachmentEncoding: 'arraybuffer' })
  const messageId = bareId(mail.messageId)
  if (messageId) {
    const dup = await db.prepare(`SELECT 1 AS x FROM mail_messages WHERE user_id = ? AND message_id = ? AND folder <> 'sent'`).bind(user, messageId).first()
    if (dup) return { duplicate: true }
  }
  const from = flatten(mail.from)[0] ?? { name: '', address: m.from.toLowerCase() }
  const html = mail.html && mail.html.length <= MAX_HTML ? mail.html : null
  const text = (mail.text?.trim() ? mail.text : mail.html ? htmlToText(mail.html) : '').slice(0, MAX_TEXT)
  const refs = refIds(mail.references)
  const inReplyTo = bareId(mail.inReplyTo)
  const thread = refs[0] ?? inReplyTo ?? messageId
  const id = uuid()
  const at = new Date().toISOString()

  const files = mail.attachments.filter((a) => a.content && !(a.related && a.contentId)).slice(0, MAX_ATTACHMENTS)
  const rows: D1PreparedStatement[] = []
  const put: Promise<unknown>[] = []
  for (const a of files) {
    const bytes = typeof a.content === 'string' ? new TextEncoder().encode(a.content) : new Uint8Array(a.content)
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT) continue
    const aid = uuid()
    const key = `${inst.id}/mail/${user}/${id}/${aid}`
    const type = a.mimeType || 'application/octet-stream'
    put.push(env.FILES_WRITE.put(key, bytes, { httpMetadata: { contentType: type } }))
    rows.push(db.prepare(`INSERT INTO mail_attachments (id, message_id, user_id, filename, content_type, size_bytes, r2_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(aid, id, user, (a.filename ?? 'attachment').slice(0, 255), type, bytes.byteLength, key, at))
  }
  await Promise.all(put)
  await db.batch([
    db.prepare(`INSERT INTO mail_messages (id, user_id, folder, from_address, from_name, to_list, cc_list, subject, snippet, text_body, html_body,
        message_id, in_reply_to, references_list, thread_key, has_attachments, received_at, created_at)
        VALUES (?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, user, from.address, from.name, JSON.stringify(flatten(mail.to)), JSON.stringify(flatten(mail.cc)),
        (mail.subject ?? '').slice(0, 998), snippetOf(text), text, html, messageId, inReplyTo, refs.length ? refs.join(' ') : null, thread,
        rows.length ? 1 : 0, at, at),
    ...rows,
  ])
  return { stored: id, user_id: user }
}

/** The Worker's email() entry: unknown or disabled addresses are refused at the SMTP stage. */
export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  let res: InboundResult
  try {
    res = await receiveMail(env, { to: message.to, from: message.from, raw: message.raw, rawSize: message.rawSize })
  } catch (err) {
    // Not stored: refuse, so the sending server reports it rather than the mail vanishing.
    console.error('mail inbound', err)
    message.setReject('Could not be delivered, send it again later')
    return
  }
  if ('reject' in res) message.setReject(res.reject)
}

/** The email channel a person's mail leaves through: the school's own, else the platform's. */
export async function mailProvider(env: Env, db: D1Database, institutionId: string): Promise<Provider> {
  const own = (await loadProviders(env, db, institutionId)).email
  if (own.configured) return own
  const platform = (await platformProviders(env, db)).email
  return platform.configured ? platform : own
}

/** A Message-ID on the school's domain. */
export const newMessageId = (domain: string) => `${uuid()}@${domain}`
