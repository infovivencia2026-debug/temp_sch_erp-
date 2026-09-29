import type { Router, Ctx } from '../../router'
import { badRequest, isUUID, now, ok, readJSON } from '../../http'
import { institutionId, requireAny } from '../admin/common'
import { Messenger, scopeOf, MessagingError } from '../../services/messaging'
import {
  MESSAGE_TYPES, channelStatus, cleanLadder, loadPolicies, loadSettings, looksEmail, phoneOf, pricesOf, validClock,
  type ChannelHealth,
} from '../../services/delivery'
import { circularRecipients } from '../payroll'
import { smsReportKey } from './message_webhooks'

/* The school's delivery rules, the honest channel status, cost estimates,
   and delivery receipts per notice with "resend by another channel".
   Policy itself lives in services/delivery.ts; sending in messaging.ts. */

const READ = 'institution.read'
const CONFIG = 'institution.settings.write'
const CREDS = 'institution.integrations.write'
const SEND = 'comms.messages.send'
const ANNOUNCE = 'comms.announcements.write'
const AUDIT = 'admin.audit.read'

type Row = Record<string, unknown>

/** Warnings a person should read before relying on messaging. */
export function healthWarnings(ch: ChannelHealth[]): string[] {
  const out: string[] = []
  const by = Object.fromEntries(ch.map((c) => [c.channel, c]))
  if (!by.push?.live) out.push('App push notifications are off: families see messages only when they open the app.')
  for (const k of ['whatsapp', 'sms', 'email']) {
    const c = by[k]
    if (c && !c.live) out.push(`${c.label} is not live: ${c.reason}.`)
  }
  if (!['push', 'whatsapp', 'sms', 'email'].some((k) => by[k]?.live)) {
    out.unshift('No outbound channel is live. Families receive messages only inside the app, and only when they open it.')
  }
  return out
}

async function health(c: Ctx) {
  const channels = await channelStatus(c.env, c.db, institutionId(c))
  return { channels, warnings: healthWarnings(channels), reaching_outside_app: channels.some((x) => x.channel !== 'in_app' && x.live) }
}

async function rules(c: Ctx) {
  const settings = await loadSettings(c.db)
  const policies = await loadPolicies(c.db)
  const types = MESSAGE_TYPES.map((t) => ({ key: t.key, label: t.label, example: t.example, urgent: t.urgent, digestible: t.digestible,
    default_ladder: t.ladder, default_mode: t.mode, ladder: policies[t.key].ladder, mode: policies[t.key].mode }))
  return { settings, types, ...(await health(c)) }
}

/** Who a notice would reach and on which rung, and what it would cost. */
async function estimate(c: Ctx) {
  requireAny(c, SEND, ANNOUNCE)
  const req = await readJSON<{ message_type?: string; audience_role?: string; section_ids?: string[]; user_ids?: string[] }>(c.req)
  const typeKey = MESSAGE_TYPES.some((t) => t.key === req.message_type) ? req.message_type! : 'notice'
  let users: string[] = []
  if (Array.isArray(req.user_ids) && req.user_ids.length) {
    users = req.user_ids.filter(isUUID).slice(0, 5000)
  } else {
    const audience = req.audience_role || 'parents'
    if (!['all', 'parents', 'students', 'staff', 'everyone'].includes(audience)) throw badRequest('unknown audience')
    const rc = circularRecipients((req.section_ids ?? []).filter(isUUID))
    users = (await c.db.prepare(rc.sql).bind(audience, ...rc.args).all<{ user_id: string }>()).results.map((r) => r.user_id).filter(Boolean)
  }
  const channels = await channelStatus(c.env, c.db, institutionId(c))
  const live = Object.fromEntries(channels.map((x) => [x.channel, x.live]))
  const prices = pricesOf(c.env)
  const pol = (await loadPolicies(c.db))[typeKey]
  const contacts = new Map<string, { phone: string; email: string; token: boolean }>()
  for (let i = 0; i < users.length; i += 90) {
    const part = JSON.stringify(users.slice(i, i + 90))
    const rows = (await c.db.prepare(`SELECT u.id, u.phone, u.email, EXISTS (SELECT 1 FROM push_tokens pt WHERE pt.user_id = u.id) AS token
        FROM users u WHERE u.id IN (SELECT value FROM json_each(?))`).bind(part).all<{ id: string; phone: string | null; email: string | null; token: number }>()).results
    for (const r of rows) contacts.set(r.id, { phone: r.phone ?? '', email: r.email ?? '', token: !!r.token })
  }
  const by: Record<string, number> = { push: 0, in_app_only: 0, whatsapp: 0, sms: 0, email: 0 }
  let cost = 0
  for (const u of users) {
    const ct = contacts.get(u)
    if (!ct) continue
    let reached = ''
    for (const ch of pol.ladder) {
      if (ch === 'in_app') { if (live.push && ct.token) { reached = 'push'; break } continue }
      if (ch === 'email') { if (live.email && looksEmail(ct.email)) { reached = 'email'; break } continue }
      if (live[ch] && phoneOf(ct.phone)) { reached = ch; break }
    }
    if (!reached) reached = 'in_app_only'
    by[reached]++
    cost += prices[reached] ?? 0
  }
  const warnings = healthWarnings(channels)
  if (by.in_app_only) warnings.unshift(`${by.in_app_only} of ${contacts.size} will only see this in the app: no live channel on the ladder reaches them.`)
  return {
    message_type: typeKey, mode: pol.mode, ladder: pol.ladder, recipients: contacts.size, by_channel: by,
    estimated_cost_paise: cost, prices_paise: prices,
    note: pol.mode === 'digest' ? 'Non-urgent: this goes in each family’s daily digest, so it shares one message with the rest of the day’s notices. The estimate is the most it could add.' : undefined,
    channels, warnings,
  }
}

// --- delivery receipts per notice ------------------------------------------

const RANK: Record<string, number> = { suppressed: 0, failed: 1, held: 2, queued: 3, sent: 4, delivered: 5, read: 6 }
const received = (s: string) => s === 'sent' || s === 'delivered' || s === 'read'

interface Attempt { id: string; channel: string; status: string; error: string | null; at: string | null; template_code: string | null; template_vars: string | null; recipient: string }

async function recipientsOf(c: Ctx, kind: string, id: string) {
  const rows = (await c.db.prepare(`SELECT m.id, m.user_id, m.recipient, m.channel, m.status, m.error, m.template_code, m.template_vars,
        COALESCE(m.read_at, m.delivered_at, m.failed_at, m.sent_at, m.queued_at) AS at,
        (SELECT n.read_at FROM notifications n WHERE n.source_kind = 'message' AND n.source_id = m.id LIMIT 1) AS app_read
      FROM message_log m WHERE m.source_kind = ? AND m.source_id = ? ORDER BY m.queued_at`).bind(kind, id).all<Row>()).results
  const held = (await c.db.prepare(`SELECT d.user_id, d.recipient, d.title, d.body, d.template_code, d.created_at, d.digest_message_id, d.reason
      FROM message_digest_items d WHERE d.source_kind = ? AND d.source_id = ?`).bind(kind, id).all<Row>()).results
  // A digest's rows: the digest message and its fallbacks share its dedup key.
  const digestIds = [...new Set(held.map((h) => h.digest_message_id).filter(Boolean) as string[])]
  const digestRows = new Map<string, Row[]>()
  if (digestIds.length) {
    const dr = (await c.db.prepare(`SELECT m1.id AS root, m2.id, m2.channel, m2.status, m2.error, m2.recipient,
          COALESCE(m2.read_at, m2.delivered_at, m2.failed_at, m2.sent_at, m2.queued_at) AS at,
          (SELECT n.read_at FROM notifications n WHERE n.source_kind = 'message' AND n.source_id = m2.id LIMIT 1) AS app_read
        FROM message_log m1 JOIN message_log m2 ON m2.id = m1.id OR (m1.dedup_key IS NOT NULL AND m2.dedup_key = m1.dedup_key)
        WHERE m1.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(digestIds)).all<Row>()).results
    for (const r of dr) digestRows.set(String(r.root), [...(digestRows.get(String(r.root)) ?? []), r])
  }
  const people = new Map<string, { key: string; user_id: string | null; address: string; attempts: Attempt[]; title?: string; body?: string; digest?: string }>()
  const get = (user: unknown, addr: unknown) => {
    const key = String(user ?? addr)
    let p = people.get(key)
    if (!p) { p = { key, user_id: (user as string | null) ?? null, address: user ? '' : String(addr ?? ''), attempts: [] }; people.set(key, p) }
    return p
  }
  const asAttempt = (r: Row): Attempt => ({ id: String(r.id), channel: String(r.channel), status: r.channel === 'in_app' && r.app_read ? 'read' : String(r.status),
    error: (r.error as string | null) ?? null, at: (r.at as string | null) ?? null, template_code: (r.template_code as string | null) ?? null,
    template_vars: (r.template_vars as string | null) ?? null, recipient: String(r.recipient ?? '') })
  for (const r of rows) {
    const p = get(r.user_id, r.recipient)
    if (r.channel !== 'in_app' && !p.address) p.address = String(r.recipient)
    p.attempts.push(asAttempt(r))
  }
  for (const h of held) {
    const p = get(h.user_id, h.recipient)
    p.title = String(h.title ?? ''); p.body = String(h.body ?? '')
    if (!h.digest_message_id) { p.attempts.push({ id: '', channel: 'digest', status: 'held', error: null, at: String(h.created_at), template_code: String(h.template_code ?? ''), template_vars: null, recipient: String(h.recipient) }); continue }
    p.digest = String(h.digest_message_id)
    for (const r of digestRows.get(String(h.digest_message_id)) ?? []) p.attempts.push({ ...asAttempt(r), template_code: 'digest.daily' })
  }
  const users = [...people.values()].map((p) => p.user_id).filter(Boolean) as string[]
  const names = new Map<string, string>()
  for (let i = 0; i < users.length; i += 90) {
    const rs = (await c.db.prepare(`SELECT id, COALESCE(full_name, email, phone, '') AS name, phone, email FROM users WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(users.slice(i, i + 90))).all<{ id: string; name: string; phone: string | null; email: string | null }>()).results
    for (const r of rs) names.set(r.id, r.name)
  }
  return [...people.values()].map((p) => {
    const best = p.attempts.reduce((a, b) => (RANK[b.status] ?? 0) > (RANK[a] ?? 0) ? b.status : a, p.attempts[0]?.status ?? 'queued')
    return { ...p, name: p.user_id ? names.get(p.user_id) ?? '' : p.address, status: best }
  })
}

async function titleOf(c: Ctx, kind: string, id: string): Promise<string> {
  if (kind === 'announcement') {
    const r = await c.db.prepare(`SELECT title FROM announcements WHERE id = ?`).bind(id).first<{ title: string }>()
    if (r) return r.title
  }
  const r = await c.db.prepare(`SELECT COALESCE(subject, template_code, '') AS t FROM message_log WHERE source_kind = ? AND source_id = ? LIMIT 1`).bind(kind, id).first<{ t: string }>()
  return r?.t || kind
}

export function registerDelivery(r: Router): void {
  r.get('/admin/messaging/health', READ, async (c) => ok(await health(c)))
  r.get('/admin/messaging/delivery-rules', READ, async (c) => ok(await rules(c)))

  r.put('/admin/messaging/delivery-rules', CONFIG, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ settings?: Partial<Record<string, unknown>>; types?: { key?: string; ladder?: unknown; mode?: string }[] }>(c.req)
    const stmts: D1PreparedStatement[] = []
    const at = now()
    if (req.settings) {
      const cur = await loadSettings(c.db)
      const s = req.settings
      const next = { ...cur }
      if (s.digest_time !== undefined) { if (!validClock(s.digest_time)) throw badRequest('digest time must be HH:MM'); next.digest_time = String(s.digest_time) }
      for (const k of ['quiet_from', 'quiet_to'] as const) {
        if (s[k] === undefined) continue
        if (s[k] === null || s[k] === '') next[k] = null
        else if (!validClock(s[k])) throw badRequest('quiet hours must be HH:MM')
        else next[k] = String(s[k])
      }
      if ((next.quiet_from === null) !== (next.quiet_to === null)) throw badRequest('set both ends of quiet hours, or neither')
      if (s.daily_cap !== undefined) {
        const n = Number(s.daily_cap)
        if (!Number.isInteger(n) || n < 0 || n > 100) throw badRequest('daily cap must be a whole number from 0 (no cap) to 100')
        next.daily_cap = n
      }
      if (s.dedup_minutes !== undefined) {
        const n = Number(s.dedup_minutes)
        if (!Number.isInteger(n) || n < 0 || n > 10080) throw badRequest('the repeat window must be 0 to 10080 minutes')
        next.dedup_minutes = n
      }
      stmts.push(c.db.prepare(`INSERT INTO message_settings (institution_id, digest_time, quiet_from, quiet_to, daily_cap, dedup_minutes, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (institution_id) DO UPDATE SET digest_time = excluded.digest_time, quiet_from = excluded.quiet_from,
          quiet_to = excluded.quiet_to, daily_cap = excluded.daily_cap, dedup_minutes = excluded.dedup_minutes, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .bind(inst, next.digest_time, next.quiet_from, next.quiet_to, next.daily_cap, next.dedup_minutes, at, c.id.platformAdmin ? null : c.id.userId))
    }
    for (const t of req.types ?? []) {
      const def = MESSAGE_TYPES.find((x) => x.key === t.key)
      if (!def) throw badRequest(`unknown message type "${t.key}"`)
      const ladder = cleanLadder(t.ladder)
      if (!ladder.length) throw badRequest(`${def.label}: choose at least one channel`)
      const mode = t.mode === 'digest' ? 'digest' : 'instant'
      if (mode === 'digest' && !def.digestible) throw badRequest(`${def.label} cannot wait for the digest`)
      stmts.push(c.db.prepare(`INSERT INTO message_policies (institution_id, message_type, ladder, mode, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (institution_id, message_type) DO UPDATE SET ladder = excluded.ladder, mode = excluded.mode, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .bind(inst, def.key, JSON.stringify(ladder), mode, at, c.id.platformAdmin ? null : c.id.userId))
    }
    if (stmts.length) await c.db.batch(stmts)
    return ok(await rules(c))
  })

  r.post('/admin/messaging/estimate', 'auth', async (c) => ok(await estimate(c)))

  r.get('/admin/messaging/webhooks', CREDS, async (c) => {
    const inst = institutionId(c)
    const origin = new URL(c.req.url).origin
    const key = await smsReportKey(c.env, inst)
    const set = (n: string) => typeof c.env[n] === 'string' && String(c.env[n]).trim() !== ''
    return ok({
      whatsapp: { url: `${origin}/api/v1/public/webhooks/whatsapp`, ready: set('WHATSAPP_APP_SECRET') && set('WHATSAPP_VERIFY_TOKEN'),
        note: 'In Meta’s App Dashboard → WhatsApp → Configuration, set this as the callback URL with the verify token the platform gave you, and subscribe to "messages".' },
      email: { url: `${origin}/api/v1/public/webhooks/email`, ready: set('RESEND_WEBHOOK_SECRET'),
        note: 'In Resend → Webhooks, add this endpoint for email.sent, delivered, opened, bounced and complained.' },
      sms: { url: key ? `${origin}/api/v1/public/webhooks/sms/${inst}/${key}` : '', ready: !!key,
        note: 'Paste this as the delivery-report (DLR) URL in your SMS vendor’s panel. Keep it private: it is keyed to this school.' },
    })
  })

  r.get('/admin/messaging/deliveries', 'auth', async (c) => {
    requireAny(c, SEND, AUDIT, ANNOUNCE)
    const lim = Math.min(Math.max(Number(c.url.searchParams.get('limit')) || 30, 1), 100)
    const srcs = (await c.db.prepare(`SELECT source_kind AS kind, source_id AS id, max(at) AS at FROM (
          SELECT source_kind, source_id, queued_at AS at FROM message_log WHERE source_kind IN ('announcement','trigger_rule','transport_trip','payroll_run','report_digest','ai_brief','campaign_step') AND source_id IS NOT NULL
          UNION ALL SELECT source_kind, source_id, created_at FROM message_digest_items WHERE source_kind IS NOT NULL AND source_id IS NOT NULL)
        GROUP BY source_kind, source_id ORDER BY at DESC LIMIT ?`).bind(lim).all<{ kind: string; id: string; at: string }>()).results
    const items = []
    for (const s of srcs) {
      const people = await recipientsOf(c, s.kind, s.id)
      const counts: Record<string, number> = { total: people.length, queued: 0, held: 0, sent: 0, delivered: 0, read: 0, failed: 0, suppressed: 0 }
      for (const p of people) counts[p.status] = (counts[p.status] ?? 0) + 1
      items.push({ kind: s.kind, id: s.id, title: await titleOf(c, s.kind, s.id), at: s.at, counts,
        not_received: people.filter((p) => !received(p.status) && p.status !== 'queued' && p.status !== 'held').length })
    }
    return ok({ items })
  })

  r.get('/admin/messaging/deliveries/{kind}/{id}', 'auth', async (c) => {
    requireAny(c, SEND, AUDIT, ANNOUNCE)
    const { kind, id } = c.params
    if (!isUUID(id)) throw badRequest('malformed id')
    const people = await recipientsOf(c, kind, id)
    const counts: Record<string, number> = { total: people.length, queued: 0, held: 0, sent: 0, delivered: 0, read: 0, failed: 0, suppressed: 0 }
    for (const p of people) counts[p.status] = (counts[p.status] ?? 0) + 1
    const live = Object.fromEntries((await channelStatus(c.env, c.db, institutionId(c))).map((x) => [x.channel, x.live]))
    return ok({ kind, id, title: await titleOf(c, kind, id), counts, live,
      people: people.map((p) => ({ key: p.key, name: p.name, user_id: p.user_id ?? undefined, status: p.status, received: received(p.status),
        attempts: p.attempts.map((a) => ({ channel: a.channel, status: a.status, error: a.error ?? undefined, at: a.at ?? undefined })) })) })
  })

  r.post('/admin/messaging/deliveries/{kind}/{id}/resend', SEND, async (c) => {
    const { kind, id } = c.params
    if (!isUUID(id)) throw badRequest('malformed id')
    const req = await readJSON<{ keys?: string[]; channel?: string }>(c.req)
    const people = await recipientsOf(c, kind, id)
    const only = Array.isArray(req.keys) && req.keys.length ? new Set(req.keys) : null
    const ms = new Messenger(scopeOf(c))
    const live = await ms.liveChannels()
    const out = { queued: 0, skipped: 0, reasons: [] as string[] }
    for (const p of people) {
      if (only ? !only.has(p.key) : received(p.status)) continue
      const tried = new Set(p.attempts.map((a) => a.channel))
      let contact = { phone: '', email: '' }
      if (p.user_id) {
        const u = await c.db.prepare(`SELECT phone, email FROM users WHERE id = ?`).bind(p.user_id).first<{ phone: string | null; email: string | null }>()
        contact = { phone: u?.phone ?? '', email: u?.email ?? '' }
      } else if (looksEmail(p.address)) contact.email = p.address
      else contact.phone = p.address
      const order = req.channel ? [req.channel] : ['whatsapp', 'sms', 'email']
      const ch = order.find((x) => live[x] && (req.channel || !tried.has(x)) && (x === 'email' ? looksEmail(contact.email) : !!phoneOf(contact.phone)))
      if (!ch) { out.skipped++; if (out.reasons.length < 5) out.reasons.push(`${p.name || p.key}: no other live channel reaches them`); continue }
      const src = p.attempts.find((a) => a.template_code && a.template_code !== 'digest.daily' && a.template_vars)
      let vars: Record<string, unknown> = {}
      try { const v = JSON.parse(src?.template_vars ?? 'null'); if (v && typeof v === 'object') vars = v } catch { /* none */ }
      delete vars.__media
      const code = src?.template_code ?? 'messaging.direct'
      if (!src) vars = { subject: p.title || (await titleOf(c, kind, id)), text: p.body || p.title || '' }
      try {
        const res = await ms.queue({ channel: ch, template_code: code, vars, to_user_id: p.user_id, recipient: ch === 'email' ? contact.email : contact.phone,
          source_kind: kind, source_id: id, occurrence_key: `resend:${p.key}:${ch}`, exact_channel: true, force: true,
          idempotency_key: `resend:${kind}:${id}:${p.key}:${ch}` })
        if (res.id && !res.duplicate) out.queued++
        else out.skipped++
      } catch (e) {
        out.skipped++
        if (out.reasons.length < 5) out.reasons.push(`${p.name || p.key}: ${e instanceof MessagingError ? e.message : 'not queued'}`)
      }
    }
    await ms.kick()
    return ok(out)
  })

  // Platform: jobs that failed every retry (services/dead_letters.ts).
  r.get('/seller/dead-letters', 'platform.tenants.write', async (c) => {
    const rows = (await c.env.CONTROL.prepare(`SELECT id, job_id, type, institution_id, error, attempts, created_at, alerted_at, resolved_at
        FROM dead_letters ORDER BY created_at DESC LIMIT 200`).all<Row>()).results
    return ok({ items: rows })
  })
  r.post('/seller/dead-letters/{id}/resolve', 'platform.tenants.write', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed id')
    await c.env.CONTROL.prepare(`UPDATE dead_letters SET resolved_at = ? WHERE id = ?`).bind(now(), c.params.id).run()
    return ok({ ok: true })
  })
}

