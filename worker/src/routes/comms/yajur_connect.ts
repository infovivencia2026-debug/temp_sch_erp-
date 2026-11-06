/* Yajur Connect (communication.yajur_connect): two-way WhatsApp chat with
   parents. Read comms.connect.read (the list, a thread, the auto-replies);
   write comms.connect.write (reply, assign, label, resolve, auto-replies).

   What parents send arrives through the WhatsApp webhook
   (comms/message_webhooks.ts -> services/wa_connect.ts). A reply is never
   sent from here: it is queued with queueMessage, and dispatch applies the
   school's recipient guard and opt-outs like any other message. Free text is
   accepted only within 24 hours of the parent's last message (WhatsApp's
   service window); after that, only an approved template. */
import type { Ctx, Router } from '../../router'
import { reply } from '../../router'
import { can } from '../../identity'
import { HttpError, badRequest, isUUID, like, now, readJSON, uuid } from '../../http'
import { loadGuard, permits } from '../admin/msg_guard'
import { MessagingError, queueMessage, scopeOf } from '../../services/messaging'
import { CONNECT_SOURCE, queueChatText, recordOutbound } from '../../services/wa_connect'
import { registerYajurConnectSend } from './yajur_connect_send'
import type {
  ConnectAutoReply, ConnectAutoReplyBody, ConnectContact, ConnectConversation, ConnectMatch, ConnectMessage, ConnectState, ConnectTemplate,
} from '@shared/api/feature_yajur_connect'

const READ = 'comms.connect.read', WRITE = 'comms.connect.write'
const WINDOW_MS = 24 * 3600_000
const MATCHES: ConnectMatch[] = ['exact', 'starts', 'contains']

interface ConvRow {
  id: string; phone: string; profile_name: string | null; guardian_id: string | null; student_id: string | null; assigned_to: string | null
  labels: string; state: ConnectState; unread: number; last_inbound_at: string | null; last_message_at: string | null; last_preview: string | null
  guardian_name: string | null; student_name: string | null; assigned_name: string | null
}

const CONV_SELECT = `SELECT c.*, g.full_name AS guardian_name,
    trim(s.first_name || ' ' || coalesce(s.last_name, '')) AS student_name, u.full_name AS assigned_name
  FROM wa_conversations c
  LEFT JOIN guardians g ON g.id = c.guardian_id
  LEFT JOIN students s ON s.id = c.student_id
  LEFT JOIN users u ON u.id = c.assigned_to`

function labelsOf(raw: string): string[] {
  try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] } catch { return [] }
}

const viewConv = (r: ConvRow): ConnectConversation => ({
  id: r.id, phone: r.phone, name: r.guardian_name || r.student_name || r.profile_name || '+' + r.phone, profile_name: r.profile_name,
  guardian_id: r.guardian_id, student_id: r.student_id, student_name: r.student_name || null, assigned_to: r.assigned_to,
  assigned_name: r.assigned_name, labels: labelsOf(r.labels), state: r.state, unread: r.unread, last_inbound_at: r.last_inbound_at,
  last_message_at: r.last_message_at, last_preview: r.last_preview,
})

async function convOr404(c: Ctx): Promise<ConvRow> {
  const id = c.params.id
  if (!isUUID(id)) throw badRequest('invalid conversation id')
  const r = await c.db.prepare(`${CONV_SELECT} WHERE c.id = ?`).bind(id).first<ConvRow>()
  if (!r) throw new HttpError(404, 'that conversation does not exist')
  return r
}

interface MsgRow {
  id: string; direction: 'in' | 'out'; kind: string; text: string | null; media_id: string | null; media_mime: string | null; media_name: string | null
  reply_to_wa_id: string | null; wa_id: string | null; status: string | null; log_status: string | null; log_error: string | null
  sent_by_name: string | null; auto_reply_id: string | null; at: string
}
const viewMsg = (m: MsgRow): ConnectMessage => ({
  id: m.id, direction: m.direction, kind: m.kind, text: m.text, media_id: m.media_id, media_mime: m.media_mime, media_name: m.media_name,
  reply_to_wa_id: m.reply_to_wa_id, wa_id: m.wa_id, status: m.log_status ?? m.status ?? '', error: m.log_error,
  sent_by_name: m.sent_by_name, auto_reply: !!m.auto_reply_id, at: m.at,
})
const MSG_SELECT = `SELECT m.*, ml.status AS log_status, ml.error AS log_error, u.full_name AS sent_by_name
  FROM wa_messages m LEFT JOIN message_log ml ON ml.id = m.message_log_id LEFT JOIN users u ON u.id = m.sent_by`

const windowEnds = (lastIn: string | null) => (lastIn ? Date.parse(lastIn) + WINDOW_MS : 0)

/** The guard and opt-outs are applied at dispatch; this only says whether the guard will hold this number. */
async function guardHolds(c: Ctx, phone: string): Promise<boolean> {
  return !permits(await loadGuard(c), 'whatsapp', '+' + phone)[0]
}

async function templates(c: Ctx): Promise<ConnectTemplate[]> {
  const r = await c.db.prepare(`SELECT code, wa_template_name FROM message_templates WHERE channel = 'whatsapp' AND is_active = 1
      AND trim(coalesce(wa_template_name, '')) <> '' ORDER BY code`).all<{ code: string; wa_template_name: string }>()
  return r.results.map((t) => ({ code: t.code, name: t.wa_template_name }))
}

async function contactOf(c: Ctx, conv: ConvRow): Promise<ConnectContact> {
  const g = conv.guardian_id ? await c.db.prepare(`SELECT id, full_name, relation, phone, email FROM guardians WHERE id = ?`).bind(conv.guardian_id)
    .first<{ id: string; full_name: string; relation: string; phone: string | null; email: string | null }>() : null
  const s = conv.student_id ? await c.db.prepare(`SELECT st.id, trim(st.first_name || ' ' || coalesce(st.last_name, '')) AS name, st.admission_no,
        (SELECT cl.name || ' ' || se.name FROM enrollments en JOIN classes cl ON cl.id = en.class_id JOIN sections se ON se.id = en.section_id
          WHERE en.student_id = st.id AND en.status = 'active' ORDER BY en.enrolled_on DESC LIMIT 1) AS class_section
      FROM students st WHERE st.id = ?`).bind(conv.student_id).first<{ id: string; name: string; admission_no: string; class_section: string | null }>() : null
  return {
    guardian: g ? { id: g.id, name: g.full_name, relation: g.relation, phone: g.phone, email: g.email } : null,
    student: s ? { id: s.id, name: s.name, admission_no: s.admission_no, class_section: s.class_section } : null,
  }
}

function cleanRule(b: Partial<ConnectAutoReplyBody>, partial: boolean): Partial<ConnectAutoReplyBody> {
  const out: Partial<ConnectAutoReplyBody> = {}
  if (!partial || b.match_type !== undefined) {
    if (!MATCHES.includes(b.match_type as ConnectMatch)) throw badRequest('match must be exact, starts or contains')
    out.match_type = b.match_type
  }
  if (!partial || b.keyword !== undefined) {
    const k = String(b.keyword ?? '').trim()
    if (!k) throw badRequest('give the keyword the parent types')
    if (k.length > 60) throw badRequest('a keyword is at most 60 characters')
    out.keyword = k
  }
  if (!partial || b.reply !== undefined) {
    const r = String(b.reply ?? '').trim()
    if (!r) throw badRequest('write the reply to send')
    if (r.length > 1000) throw badRequest('a reply is at most 1000 characters')
    out.reply = r
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') throw badRequest('enabled is true or false')
    out.enabled = b.enabled
  }
  return out
}

interface RuleRow { id: string; match_type: ConnectMatch; keyword: string; reply: string; enabled: number; position: number }
const viewRule = (r: RuleRow): ConnectAutoReply => ({ id: r.id, match_type: r.match_type, keyword: r.keyword, reply: r.reply, enabled: r.enabled === 1, position: r.position })

async function ruleOr404(c: Ctx): Promise<RuleRow> {
  if (!isUUID(c.params.id)) throw badRequest('invalid auto-reply id')
  const r = await c.db.prepare(`SELECT * FROM wa_autoreplies WHERE id = ?`).bind(c.params.id).first<RuleRow>()
  if (!r) throw new HttpError(404, 'that auto-reply does not exist')
  return r
}

const notQueued = (e: unknown): never => {
  if (e instanceof MessagingError) throw new HttpError(409, e.message, { code: e.code })
  throw e
}

export function registerYajurConnect(r: Router): void {
  // Sending first: its fixed paths (send, campaigns, schedules) must win over /{id}.
  registerYajurConnectSend(r)
  r.typed('GET /comms/yajur-connect', READ, async (c) => {
    const q = (c.url.searchParams.get('q') ?? '').trim().slice(0, 80)
    const state = c.url.searchParams.get('state') ?? 'open'
    if (!['open', 'resolved', 'all'].includes(state)) throw badRequest('state must be open, resolved or all')
    const where: string[] = [], args: unknown[] = []
    if (state !== 'all') { where.push('c.state = ?'); args.push(state) }
    if (c.url.searchParams.get('mine') === '1') { where.push('c.assigned_to = ?'); args.push(c.id.userId) }
    if (q) {
      const digits = q.replace(/[^0-9]/g, '')
      where.push(`(g.full_name LIKE ? ESCAPE '\\' OR s.first_name || ' ' || coalesce(s.last_name, '') LIKE ? ESCAPE '\\' OR c.profile_name LIKE ? ESCAPE '\\'
        OR c.labels LIKE ? ESCAPE '\\' OR c.last_preview LIKE ? ESCAPE '\\'${digits.length >= 3 ? ' OR c.phone LIKE ?' : ''}
        OR EXISTS (SELECT 1 FROM wa_messages m WHERE m.conversation_id = c.id AND m.text LIKE ? ESCAPE '\\'))`)
      const l = like(q)
      args.push(l, l, l, l, l)
      if (digits.length >= 3) args.push(`%${digits}%`)
      args.push(l)
    }
    const rows = await c.db.prepare(`${CONV_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY coalesce(c.last_message_at, c.created_at) DESC LIMIT 300`).bind(...args).all<ConvRow>()
    const g = await loadGuard(c)
    return { items: rows.results.map(viewConv), guard_on: g.mode !== 'everyone' && !g.unguarded.has('whatsapp'), can_write: can(c.id, WRITE) }
  })

  r.typed('GET /comms/yajur-connect/staff', READ, async (c) => {
    const rows = await c.db.prepare(`SELECT u.id, u.full_name AS name FROM users u WHERE u.status = 'active' AND (
        EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = u.id AND rp.permission_key = ?1)
        OR EXISTS (SELECT 1 FROM user_permissions up WHERE up.user_id = u.id AND up.permission_key = ?1)) ORDER BY u.full_name LIMIT 500`)
      .bind(READ).all<{ id: string; name: string }>()
    return { items: rows.results }
  })

  r.typed('GET /comms/yajur-connect/autoreplies', READ, async (c) => {
    const rows = await c.db.prepare(`SELECT * FROM wa_autoreplies ORDER BY position, created_at`).all<RuleRow>()
    return { items: rows.results.map(viewRule) }
  })

  r.typed('POST /comms/yajur-connect/autoreplies', WRITE, async (c) => {
    const b = cleanRule(await readJSON<Partial<ConnectAutoReplyBody>>(c.req), false) as ConnectAutoReplyBody
    const id = uuid(), t = now()
    const pos = (await c.db.prepare(`SELECT coalesce(max(position), -1) + 1 AS p FROM wa_autoreplies`).first<{ p: number }>())?.p ?? 0
    await c.db.prepare(`INSERT INTO wa_autoreplies (id, institution_id, match_type, keyword, reply, enabled, position, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).bind(id, c.id.institution!.id, b.match_type, b.keyword, b.reply, b.enabled === false ? 0 : 1, pos, t, t).run()
    return reply(viewRule((await c.db.prepare(`SELECT * FROM wa_autoreplies WHERE id = ?`).bind(id).first<RuleRow>())!), 201)
  })

  r.typed('PUT /comms/yajur-connect/autoreplies/{id}', WRITE, async (c) => {
    const cur = await ruleOr404(c)
    const b = cleanRule(await readJSON<Partial<ConnectAutoReplyBody>>(c.req), true)
    await c.db.prepare(`UPDATE wa_autoreplies SET match_type = ?, keyword = ?, reply = ?, enabled = ?, updated_at = ? WHERE id = ?`)
      .bind(b.match_type ?? cur.match_type, b.keyword ?? cur.keyword, b.reply ?? cur.reply, b.enabled === undefined ? cur.enabled : b.enabled ? 1 : 0, now(), cur.id).run()
    return viewRule((await c.db.prepare(`SELECT * FROM wa_autoreplies WHERE id = ?`).bind(cur.id).first<RuleRow>())!)
  })

  r.typed('DELETE /comms/yajur-connect/autoreplies/{id}', WRITE, async (c) => {
    const cur = await ruleOr404(c)
    await c.db.prepare(`DELETE FROM wa_autoreplies WHERE id = ?`).bind(cur.id).run()
    return { ok: true as const }
  })

  r.typed('GET /comms/yajur-connect/{id}', READ, async (c) => {
    const conv = await convOr404(c)
    const rows = await c.db.prepare(`${MSG_SELECT} WHERE m.conversation_id = ? ORDER BY m.at DESC LIMIT 500`).bind(conv.id).all<MsgRow>()
    if (conv.unread > 0 && can(c.id, WRITE)) await c.db.prepare(`UPDATE wa_conversations SET unread = 0 WHERE id = ?`).bind(conv.id).run()
    const ends = windowEnds(conv.last_inbound_at)
    return {
      conversation: viewConv({ ...conv, unread: can(c.id, WRITE) ? 0 : conv.unread }),
      messages: rows.results.reverse().map(viewMsg),
      contact: await contactOf(c, conv),
      sending: { paused: await guardHolds(c, conv.phone), window_open: ends > Date.now(), window_ends_at: ends ? new Date(ends).toISOString() : null },
      templates: await templates(c),
    }
  })

  r.typed('PUT /comms/yajur-connect/{id}', WRITE, async (c) => {
    const conv = await convOr404(c)
    const b = await readJSON<{ assigned_to?: string | null; labels?: unknown; state?: string }>(c.req)
    let assigned = conv.assigned_to, labels = labelsOf(conv.labels), state = conv.state
    if (b.assigned_to !== undefined) {
      if (b.assigned_to === null || b.assigned_to === '') assigned = null
      else {
        if (!isUUID(b.assigned_to)) throw badRequest('invalid staff id')
        const ok = await c.db.prepare(`SELECT 1 AS x FROM users u WHERE u.id = ?2 AND u.status = 'active' AND (
            EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = u.id AND rp.permission_key = ?1)
            OR EXISTS (SELECT 1 FROM user_permissions up WHERE up.user_id = u.id AND up.permission_key = ?1))`).bind(READ, b.assigned_to).first()
        if (!ok) throw badRequest('that person cannot open Yajur Connect, so the chat cannot be assigned to them')
        assigned = b.assigned_to
      }
    }
    if (b.labels !== undefined) {
      if (!Array.isArray(b.labels)) throw badRequest('labels must be a list')
      const seen = new Set<string>()
      labels = []
      for (const x of b.labels) {
        const l = String(x ?? '').trim()
        if (!l) continue
        if (l.length > 30) throw badRequest('a label is at most 30 characters')
        if (!seen.has(l.toLowerCase())) { seen.add(l.toLowerCase()); labels.push(l) }
      }
      if (labels.length > 10) throw badRequest('a chat can have at most 10 labels')
    }
    if (b.state !== undefined) {
      if (b.state !== 'open' && b.state !== 'resolved') throw badRequest('state must be open or resolved')
      state = b.state
    }
    await c.db.prepare(`UPDATE wa_conversations SET assigned_to = ?, labels = ?, state = ?, updated_at = ? WHERE id = ?`)
      .bind(assigned, JSON.stringify(labels), state, now(), conv.id).run()
    return viewConv((await c.db.prepare(`${CONV_SELECT} WHERE c.id = ?`).bind(conv.id).first<ConvRow>())!)
  })

  r.typed('POST /comms/yajur-connect/{id}/reply', WRITE, async (c) => {
    const conv = await convOr404(c)
    const b = await readJSON<{ text?: string; template_code?: string }>(c.req)
    const text = String(b.text ?? '').trim(), code = String(b.template_code ?? '').trim()
    if (!text && !code) throw badRequest('write a reply or choose a template')
    if (text && code) throw badRequest('send either text or a template, not both')
    let out: { id: string }
    if (text) {
      if (text.length > 4096) throw badRequest('a WhatsApp message is at most 4096 characters')
      if (windowEnds(conv.last_inbound_at) <= Date.now()) {
        throw new HttpError(409, 'more than 24 hours since the parent last wrote: WhatsApp accepts only an approved template now', { code: 'window_closed' })
      }
      out = await queueChatText(scopeOf(c), conv, text, { user: c.id.userId }).catch(notQueued)
    } else {
      if (!(await templates(c)).some((t) => t.code === code)) throw badRequest('that is not an approved WhatsApp template of this school')
      const contact = await contactOf(c, conv)
      const res = await queueMessage(scopeOf(c), {
        channel: 'whatsapp', template_code: code, recipient: '+' + conv.phone, student_id: conv.student_id, exact_channel: true, force: true,
        source_kind: CONNECT_SOURCE, source_id: conv.id, occurrence_key: uuid(),
        vars: { parent_name: contact.guardian?.name ?? conv.profile_name ?? '', student_name: contact.student?.name ?? '' },
      }).catch(notQueued)
      const body = res.id ? (await c.db.prepare(`SELECT body FROM message_log WHERE id = ?`).bind(res.id).first<{ body: string | null }>())?.body : null
      out = await recordOutbound(c.db, c.id.institution!.id, conv.id, 'template', body || code, res.id, { user: c.id.userId })
    }
    const m = await c.db.prepare(`${MSG_SELECT} WHERE m.id = ?`).bind(out.id).first<MsgRow>()
    return reply(viewMsg(m!), 201)
  })
}
