import { notifyHoldersStmts, notifyStmt } from '../notify_holders'
/* Yajur Connect: the WhatsApp chat store (wa_conversations, wa_messages,
   wa_autoreplies).

   The webhook hands each inbound message here. It is kept against the
   sender's number, matched to a guardian (or a student's emergency number),
   and checked against the school's keyword auto-replies. An auto-reply, like
   every reply typed on the Connect screen, is only ever queued through
   queueMessage: dispatch applies the recipient guard and opt-outs, so nothing
   here sends anything itself. Media is kept as WhatsApp's media id; the file
   is not downloaded. */
import type { Env } from '../env'
import { normalisePhone } from '../routes/admin/msg_guard'
import { isStartKeyword, isStopKeyword } from './delivery'
import { MessagingError, queueMessage, type MsgScope } from './messaging'

export interface WaInboundMessage {
  from?: string
  id?: string
  timestamp?: string
  type?: string
  text?: { body?: string }
  button?: { text?: string; payload?: string }
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } }
  reaction?: { message_id?: string; emoji?: string }
  location?: { name?: string; address?: string; latitude?: number; longitude?: number }
  context?: { id?: string }
  image?: WaMedia; video?: WaMedia; audio?: WaMedia; document?: WaMedia; sticker?: WaMedia
}
interface WaMedia { id?: string; mime_type?: string; caption?: string; filename?: string }

export const CONNECT_SOURCE = 'wa_connect'
export const last10 = (v: string) => v.replace(/[^0-9]/g, '').slice(-10)
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/** What a message says, as one line of text (reactions as the emoji, locations as their name). */
export function inboundText(m: WaInboundMessage): string {
  if (m.type === 'reaction') return m.reaction?.emoji ?? ''
  if (m.type === 'location' && m.location) {
    const where = [m.location.name, m.location.address].filter(Boolean).join(', ')
    return where || (m.location.latitude !== undefined ? `${m.location.latitude}, ${m.location.longitude}` : 'Location')
  }
  const media = m.image ?? m.video ?? m.document ?? m.audio ?? m.sticker
  return m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? media?.caption ?? ''
}

/** The guardian (and their primary child) whose number this is, else a student whose emergency number it is. */
export async function matchContact(db: D1Database, phone: string): Promise<{ guardian_id: string | null; student_id: string | null }> {
  const tail = last10(phone)
  if (tail.length < 10) return { guardian_id: null, student_id: null }
  const g = await db.prepare(`SELECT g.id AS guardian_id,
        (SELECT sg.student_id FROM student_guardians sg JOIN students s ON s.id = sg.student_id
          WHERE sg.guardian_id = g.id ORDER BY s.status = 'active' DESC, sg.is_primary DESC LIMIT 1) AS student_id
      FROM guardians g WHERE substr(replace(replace(replace(replace(g.phone,'+',''),' ',''),'-',''),'(',''), -10) = ?
      ORDER BY g.user_id IS NULL, g.created_at LIMIT 1`).bind(tail).first<{ guardian_id: string; student_id: string | null }>()
  if (g) return g
  const s = await db.prepare(`SELECT id FROM students WHERE substr(replace(replace(replace(emergency_contact_phone,'+',''),' ',''),'-',''), -10) = ?
      ORDER BY status = 'active' DESC LIMIT 1`).bind(tail).first<{ id: string }>()
  return { guardian_id: null, student_id: s?.id ?? null }
}

/** The chat for a number, opened (and matched) on first contact. */
export async function conversationFor(db: D1Database, inst: string, phone: string, profileName: string | null, at: string): Promise<string> {
  const ex = await db.prepare(`SELECT id FROM wa_conversations WHERE phone = ?`).bind(phone).first<{ id: string }>()
  if (ex) {
    if (profileName) await db.prepare(`UPDATE wa_conversations SET profile_name = ? WHERE id = ?`).bind(trunc(profileName, 120), ex.id).run()
    return ex.id
  }
  const who = await matchContact(db, phone)
  const id = crypto.randomUUID()
  await db.prepare(`INSERT INTO wa_conversations (id, institution_id, phone, profile_name, guardian_id, student_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (phone) DO NOTHING`)
    .bind(id, inst, phone, profileName ? trunc(profileName, 120) : null, who.guardian_id, who.student_id, at, at).run()
  return (await db.prepare(`SELECT id FROM wa_conversations WHERE phone = ?`).bind(phone).first<{ id: string }>())!.id
}

export interface AutoReply { id: string; match_type: 'exact' | 'starts' | 'contains'; keyword: string; reply: string; enabled: number; position: number }

/** The first enabled rule the text matches (case and surrounding spaces ignored). */
export function matchRule(rules: AutoReply[], text: string): AutoReply | null {
  const t = text.trim().toLowerCase()
  if (!t) return null
  for (const r of rules) {
    if (!r.enabled) continue
    const k = r.keyword.trim().toLowerCase()
    if (!k) continue
    if (r.match_type === 'exact' && t === k) return r
    if (r.match_type === 'starts' && t.startsWith(k)) return r
    if (r.match_type === 'contains' && t.includes(k)) return r
  }
  return null
}

/** Queue a free-text WhatsApp to a chat and record it in the thread. Throws MessagingError when it cannot be queued. */
export async function queueChatText(m: MsgScope, conv: { id: string; phone: string; student_id: string | null }, text: string,
  by: { user?: string | null; autoReply?: string | null }): Promise<{ id: string; message_log_id: string | null; status: string; at: string }> {
  const res = await queueMessage(m, {
    channel: 'whatsapp', template_code: 'messaging.direct', vars: { text, subject: '' }, recipient: '+' + conv.phone,
    student_id: conv.student_id, exact_channel: true, force: true, source_kind: CONNECT_SOURCE, source_id: conv.id,
    // Each chat message is its own occurrence: without a key the queue would take the second reply as a repeat.
    occurrence_key: crypto.randomUUID(),
  })
  return recordOutbound(m.db, m.inst, conv.id, 'text', text, res.id, by)
}

export async function recordOutbound(db: D1Database, inst: string, convId: string, kind: string, text: string, logId: string | null,
  by: { user?: string | null; autoReply?: string | null }) {
  const id = crypto.randomUUID(), at = new Date().toISOString(), status = logId ? 'queued' : 'duplicate'
  await db.batch([
    db.prepare(`INSERT INTO wa_messages (id, institution_id, conversation_id, direction, kind, text, message_log_id, status, sent_by, auto_reply_id, at)
        VALUES (?,?,?,'out',?,?,?,?,?,?,?)`).bind(id, inst, convId, kind, text, logId, status, by.user ?? null, by.autoReply ?? null, at),
    db.prepare(`UPDATE wa_conversations SET last_message_at = ?, last_preview = ?, updated_at = ? WHERE id = ?`).bind(at, trunc(text, 140), at, convId),
  ])
  return { id, message_log_id: logId, status, at }
}

const PREVIEW_WORD: Record<string, string> = { image: 'Sent a photo', video: 'Sent a video', audio: 'Sent a voice note', document: 'Sent a document', sticker: 'Sent a sticker', location: 'Sent a location' }

/** Store one inbound message in a school; run the auto-replies. Returns false for a repeat delivery. */
export async function recordInbound(env: Env, db: D1Database, inst: string, msg: WaInboundMessage, profileName: string | null): Promise<boolean> {
  const phone = normalisePhone(msg.from ?? '')
  if (!phone) return false
  const at = msg.timestamp && /^\d+$/.test(msg.timestamp) ? new Date(Number(msg.timestamp) * 1000).toISOString() : new Date().toISOString()
  const convId = await conversationFor(db, inst, phone, profileName, at)
  const text = inboundText(msg)
  const media = msg.image ?? msg.video ?? msg.document ?? msg.audio ?? msg.sticker
  const kind = (msg.type ?? 'text').slice(0, 20)
  const replyTo = msg.type === 'reaction' ? msg.reaction?.message_id ?? null : msg.context?.id ?? null
  const ins = await db.prepare(`INSERT INTO wa_messages (id, institution_id, conversation_id, direction, kind, text, media_id, media_mime, media_name,
        reply_to_wa_id, wa_id, status, at) VALUES (?,?,?,'in',?,?,?,?,?,?,?,'received',?) ON CONFLICT (wa_id) DO NOTHING`)
    .bind(crypto.randomUUID(), inst, convId, kind, text ? trunc(text, 4096) : null, media?.id ?? null, media?.mime_type ?? null,
      media?.filename ?? null, replyTo, msg.id ?? null, at).run()
  if (!ins.meta.changes) return false
  const preview = text || `[${kind}]`
  // A reaction is not a new question: it does not reopen a resolved chat or count as unread.
  const reaction = msg.type === 'reaction'
  await db.prepare(`UPDATE wa_conversations SET last_inbound_at = max(coalesce(last_inbound_at, ''), ?), last_message_at = max(coalesce(last_message_at, ''), ?),
      last_preview = ?, unread = unread + ?, state = CASE WHEN ? THEN state ELSE 'open' END, updated_at = ? WHERE id = ?`)
    .bind(at, at, trunc(preview, 140), reaction ? 0 : 1, reaction ? 1 : 0, new Date().toISOString(), convId).run()

  if (!reaction) {
    // A bell for the staff: the chat's owner if it has one, else everyone who can answer (owner, 2026-11-10).
    try {
      const cv = await db.prepare(`SELECT c.assigned_to, COALESCE(g.full_name, c.profile_name, '+' || c.phone) AS who
          FROM wa_conversations c LEFT JOIN guardians g ON g.id = c.guardian_id WHERE c.id = ?`).bind(convId).first<{ assigned_to: string | null; who: string }>()
      const title = `WhatsApp: ${cv?.who ?? '+' + phone}`
      const body = trunc(PREVIEW_WORD[kind] && !text ? PREVIEW_WORD[kind] : preview, 200)
      const link = `/go/communication/yajur_connect?c=${convId}`
      const stmts = cv?.assigned_to
        ? [notifyStmt(db, inst, cv.assigned_to, 'whatsapp_message', title, body, link, 'wa_conversation', convId)]
        : await notifyHoldersStmts(db, inst, 'comms.connect.write', null, 'whatsapp_message', title, body, link, 'wa_conversation', convId)
      if (stmts.length) await db.batch(stmts)
    } catch (e) { console.warn('connect notify failed', inst, e instanceof Error ? e.message : String(e)) }
  }

  if (reaction || !text || isStopKeyword(text) || isStartKeyword(text)) return true
  const rules = (await db.prepare(`SELECT * FROM wa_autoreplies WHERE enabled = 1 ORDER BY position, created_at`).all<AutoReply>()).results
  const rule = matchRule(rules, text)
  if (!rule) return true
  const conv = (await db.prepare(`SELECT id, phone, student_id FROM wa_conversations WHERE id = ?`).bind(convId).first<{ id: string; phone: string; student_id: string | null }>())!
  try {
    await queueChatText({ env, db, inst }, conv, rule.reply, { autoReply: rule.id })
  } catch (e) {
    // Not set up, no wording, out of credits: the parent's message is kept; the reply is not.
    if (!(e instanceof MessagingError)) throw e
    console.warn('connect auto-reply not queued', inst, e.message)
  }
  return true
}
