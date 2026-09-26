import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { entitlementFor } from '../misc/shell'
import { institutionId, notImplemented, parseJSON, requireAny } from './common'
import { runOps, tr } from './ops_common'
import { BUILTIN_TEMPLATES } from './msg_templates'
import { json } from '../../env'
import { MessagingError, dispatchMessages, loadProviders as loadSendingProviders, queueMessage, renderTemplate, scopeOf } from '../../services/messaging'
import { sendDirect } from './send_direct'
import { KNOWN_EVENTS, emitMessageEvent, runTriggerRules } from '../../services/message_rules'
import { CHANNELS, CHANNEL_LABELS, integrationRows, isoZ, knownChannel, loadProviders, sealSecret } from './providers'

/* /admin/messaging of internal/api/messaging.go, message_credits.go,
   message_recharge.go, messaging_direct.go and sms_presets.go.

   Sending (send, send-direct, dispatch, providers/{channel}/test and
   triggers/run) goes through services/messaging.ts and message_rules.ts. The
   configuration those use - providers, templates, rules, credits, routing,
   recharge requests and the log - is ported in full.

   The platform's own providers (integrations rows with institution_id NULL,
   used when a platform operator works outside any school) have no database
   on the Worker; a caller without a school gets the usual "no school in
   scope" refusal from c.db. */

const READ = 'institution.read'
const CREDS = 'institution.integrations.write'
const CONFIG = 'institution.settings.write'
const SEND = 'comms.messages.send'
const AUDIT = 'admin.audit.read'

const metered = (ch: string) => ch === 'sms' || ch === 'whatsapp'
const routable = (ch: string) => metered(ch) || ch === 'email'
type Row = Record<string, unknown>

/** RequireCustomIntegration: linking an own vendor is the top pack's; 402 otherwise. */
async function requireCustomIntegration(c: Ctx): Promise<void> {
  const st = await entitlementFor(c)
  if (!st.customIntegration) {
    throw new HttpError(402, 'Linking your own SMS or WhatsApp account is part of the Complete pack. ' +
      'On this pack messages send through us and are paid for with credits.')
  }
}

/** planAllowsCustomIntegration, read from CONTROL where the subscription lives. */
async function planAllowsCustomIntegration(c: Ctx): Promise<boolean> {
  const r = await c.env.CONTROL.prepare(`SELECT p.custom_integration FROM subscriptions s LEFT JOIN plans p ON p.code = s.plan_code
      WHERE s.institution_id = ? ORDER BY s.started_on DESC LIMIT 1`).bind(institutionId(c)).first<{ custom_integration: number | null }>()
  return !!r && !!Number(r.custom_integration ?? 0)
}

/** routeFor: which account a channel leaves by. */
async function routeFor(c: Ctx, ch: string, custom?: boolean): Promise<string> {
  if (!routable(ch)) return 'own'
  if (!(custom ?? await planAllowsCustomIntegration(c))) return 'edu_cloud'
  const stored = await c.db.prepare(`SELECT route FROM message_routing WHERE channel = ?`).bind(ch).first<{ route: string }>()
  if (stored) return stored.route
  const conf = await c.db.prepare(`SELECT count(*) AS n FROM integrations WHERE institution_id IS NOT NULL AND kind = 'messaging' AND provider = ? AND enabled = 1`).bind(ch).first<{ n: number }>()
  return Number(conf?.n ?? 0) > 0 ? 'own' : 'edu_cloud'
}

/** creditBalance's "is this channel metered" half. */
async function isMetered(c: Ctx, ch: string, hasRow: boolean, custom: boolean): Promise<boolean> {
  if (!metered(ch)) return false
  if (hasRow) return true
  return (await routeFor(c, ch, custom)) === 'edu_cloud'
}

async function listProviders(c: Ctx): Promise<Response> {
  const rows = await integrationRows(c)
  const set = await loadProviders(c, rows)
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString()
  const counts = await c.db.prepare(`SELECT channel,
      sum(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS q,
      sum(CASE WHEN status IN ('sent','delivered') AND sent_at > ?1 THEN 1 ELSE 0 END) AS s,
      sum(CASE WHEN status = 'failed' AND queued_at > ?1 THEN 1 ELSE 0 END) AS f
    FROM message_log GROUP BY channel`).bind(since).all<{ channel: string; q: number; s: number; f: number }>()
  const cm = new Map(counts.results.map((x) => [x.channel, x]))
  const stored = new Map(rows.map((r) => [r.provider, r]))
  const items = CHANNELS.map((ch) => {
    const r = stored.get(ch)
    const p = set[ch]
    const cnt = cm.get(ch)
    const creds = r?.credentials as unknown as ArrayLike<number> | null | undefined
    return {
      channel: ch, label: CHANNEL_LABELS[ch], provider: p?.name ?? '', configured: p?.configured ?? false, reason: p?.why || undefined,
      enabled: !!r?.enabled, has_secret: !!creds && creds.length > 0,
      settings: parseJSON<unknown>(r?.config ?? null, {}), last_ok_at: r?.last_ok_at ?? undefined, last_error: r?.last_error ?? undefined,
      queued: Number(cnt?.q ?? 0), sent_today: Number(cnt?.s ?? 0), failed_today: Number(cnt?.f ?? 0),
    }
  })
  return ok({ items })
}

/** The integrations upsert: an omitted secret keeps the stored one. */
export async function upsertIntegration(c: Ctx, provider: string, config: string, sealed: Uint8Array | null, enabled: boolean): Promise<void> {
  const inst = institutionId(c)
  await runOps(c, [c.db.prepare(`INSERT INTO integrations (id, institution_id, provider, kind, config, credentials, enabled)
      VALUES (?, ?, ?, 'messaging', ?, ?, ?)
      ON CONFLICT (institution_id, provider) DO UPDATE SET config = excluded.config,
        credentials = COALESCE(excluded.credentials, integrations.credentials), enabled = excluded.enabled, kind = 'messaging'`)
    .bind(uuid(), inst, provider, config, sealed ? sealed.buffer : null, enabled ? 1 : 0)])
}

const TRIGGER_EVENTS: Record<string, { description: string; facts: string }> = {
  'announcement.published': { description: 'A circular was published to parents in the last week.', facts: 'days_ago' },
  'invoice.overdue': { description: 'An invoice is past its due date and not settled.', facts: 'days_overdue, amount_due_paise' },
  'ptm.upcoming': { description: 'A booked parent-teacher meeting is coming up.', facts: 'days_ahead' },
  'student.absent': { description: 'A child was marked absent, within the last fortnight.', facts: 'days_ago' },
}

export function registerMessaging(r: Router): void {
  // --- providers ---------------------------------------------------------------
  r.get('/admin/messaging/providers', READ, listProviders)

  r.put('/admin/messaging/providers/{channel}', CREDS, async (c) => {
    await requireCustomIntegration(c)
    const ch = c.params.channel
    if (ch === 'in_app') throw badRequest('in-app delivery needs no credentials')
    if (ch !== 'email' && ch !== 'sms' && ch !== 'whatsapp') throw badRequest('channel must be email, sms or whatsapp')
    const req = await readJSON<{ enabled?: boolean; settings?: unknown; secret?: string | null }>(c.req)
    const settings = req.settings === undefined || req.settings === null ? '{}' : JSON.stringify(req.settings)
    const sealed = typeof req.secret === 'string' && req.secret !== '' ? await sealSecret(c, req.secret) : null
    await upsertIntegration(c, ch, settings, sealed, !!req.enabled)
    return listProviders(c)
  })

  r.del('/admin/messaging/providers/{channel}', CREDS, async (c) => {
    await requireCustomIntegration(c)
    await runOps(c, [c.db.prepare(`DELETE FROM integrations WHERE institution_id IS NOT NULL AND provider = ? AND kind = 'messaging'`).bind(c.params.channel)])
    return listProviders(c)
  })

  r.post('/admin/messaging/providers/{channel}/test', CREDS, async (c) => {
    await requireCustomIntegration(c)
    const req = await readJSON<{ to?: string }>(c.req)
    if (tr(req.to) === '') throw badRequest('an address to test against is required')
    const set = await loadProviders(c)
    const p = set[c.params.channel]
    if (!p) throw badRequest('unknown channel')
    if (!p.configured) throw new HttpError(409, p.why, { code: 'provider_not_configured' })
    const live = (await loadSendingProviders(c.env, c.db, institutionId(c)))[c.params.channel]
    const school = (await c.db.prepare(`SELECT name FROM institutions WHERE id = ?`).bind(institutionId(c)).first<{ name: string }>())?.name ?? ''
    const t = BUILTIN_TEMPLATES['messaging.test'], vars = { school_name: school }
    let sendErr: Error | null = null
    try { await live.send({ to: tr(req.to), subject: renderTemplate(t.subject, vars), body: renderTemplate(t.body, vars), dlt: '' }) }
    catch (e) { sendErr = e as Error }
    if (sendErr) await c.db.prepare(`UPDATE integrations SET last_error = ? WHERE institution_id IS NOT NULL AND provider = ?`).bind(sendErr.message.trim().slice(0, 500), c.params.channel).run()
    else await c.db.prepare(`UPDATE integrations SET last_ok_at = ?, last_error = NULL WHERE institution_id IS NOT NULL AND provider = ?`).bind(now(), c.params.channel).run()
    if (sendErr) throw new HttpError(502, sendErr.message.trim().slice(0, 300), { code: 'provider_rejected' })
    return ok({ ok: true, channel: c.params.channel, to: req.to, message: 'the provider accepted the message' })
  })

  r.get('/admin/messaging/sms-presets', READ, () => ok({ items: SMS_PRESETS }))

  // --- templates -----------------------------------------------------------------
  r.get('/admin/messaging/templates', READ, async (c) => {
    const rows = await c.db.prepare(`SELECT code, channel, COALESCE(subject,'') AS subject, body, COALESCE(dlt_template_id,'') AS dlt, is_active
        FROM message_templates ORDER BY code, channel`).all<Row>()
    const seen = new Set<string>()
    const items: Record<string, unknown>[] = rows.results.map((v) => {
      seen.add(`${v.code}|${v.channel}`)
      return { code: v.code, channel: v.channel, subject: v.subject, body: v.body, dlt_template_id: v.dlt, is_active: !!v.is_active, built_in: false, editable: true }
    })
    for (const code of Object.keys(BUILTIN_TEMPLATES).sort()) {
      const t = BUILTIN_TEMPLATES[code]
      for (const ch of CHANNELS) {
        if (seen.has(`${code}|${ch}`)) continue
        items.push({ code, channel: ch, subject: t.subject, body: t.body, dlt_template_id: '', is_active: true, built_in: true, editable: true })
      }
    }
    return ok({ items })
  })

  r.put('/admin/messaging/templates', CONFIG, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ code?: string; channel?: string; subject?: string; body?: string; dlt_template_id?: string; is_active?: boolean }>(c.req)
    if (tr(req.code) === '' || tr(req.body) === '') throw badRequest('a template needs a code and a body')
    if (!knownChannel(req.channel)) throw badRequest('channel must be email, sms, whatsapp or in_app')
    const nz = (s: string | undefined) => (s === undefined || s === '' ? null : s)
    await runOps(c, [c.db.prepare(`INSERT INTO message_templates (id, institution_id, code, channel, subject, body, dlt_template_id, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (institution_id, code, channel) DO UPDATE SET subject = excluded.subject, body = excluded.body,
          dlt_template_id = excluded.dlt_template_id, is_active = excluded.is_active`)
      .bind(uuid(), inst, tr(req.code), req.channel, nz(req.subject), req.body, nz(req.dlt_template_id), req.is_active ? 1 : 0)])
    return ok({ ok: true })
  })

  // --- trigger rules -------------------------------------------------------------
  r.get('/admin/messaging/triggers', READ, async (c) => {
    const set = await loadProviders(c)
    const rows = await c.db.prepare(`SELECT id, name, event, condition, audience, channel, template_code, lead_minutes,
        COALESCE(quiet_from,'') AS quiet_from, COALESCE(quiet_to,'') AS quiet_to, is_active, ${isoZ('last_run_at')} AS last_run_at, last_queued, last_error
      FROM message_trigger_rules WHERE plan_kind IS NULL ORDER BY event, name`).all<Row>()
    const items = rows.results.map((v) => {
      const p = set[String(v.channel)]
      return { id: v.id, name: v.name, event: v.event, condition: parseJSON<Record<string, unknown>>(v.condition, {}), audience: v.audience,
        channel: v.channel, template_code: v.template_code, lead_minutes: Number(v.lead_minutes), quiet_from: v.quiet_from, quiet_to: v.quiet_to,
        is_active: !!v.is_active, last_run_at: v.last_run_at ?? undefined, last_queued: Number(v.last_queued), last_error: v.last_error ?? undefined,
        channel_ready: p ? p.configured : false, channel_reason: p ? (p.why || undefined) : 'unknown channel' }
    })
    const total = new Map<string, number>(), active = new Map<string, number>()
    for (const v of items) {
      total.set(String(v.event), (total.get(String(v.event)) ?? 0) + 1)
      if (v.is_active) active.set(String(v.event), (active.get(String(v.event)) ?? 0) + 1)
    }
    const events = Object.keys(TRIGGER_EVENTS).sort().map((name) => ({ event: name, description: TRIGGER_EVENTS[name].description,
      facts: TRIGGER_EVENTS[name].facts, swept: true, rules: total.get(name) ?? 0, active_rules: active.get(name) ?? 0 }))
    return ok({ items, events, audiences: ['guardians', 'student', 'staff'], channels: CHANNELS })
  })

  r.post('/admin/messaging/triggers/run', SEND, async (c) => {
    const text = await c.req.text()
    let req: { rule_id?: string; event?: string; dispatch?: boolean } = {}
    if (text.trim() !== '') {
      try { req = JSON.parse(text) } catch { throw badRequest('malformed JSON body') }
      if (req.rule_id && !isUUID(req.rule_id)) throw badRequest('malformed rule id')
    }
    const dispatch = req.dispatch ?? true
    const m = scopeOf(c)
    let body: Record<string, unknown>
    if (req.event) {
      const find = KNOWN_EVENTS[req.event]
      if (!find) throw badRequest('no sweep can find that event on its own. It fires when the feature that owns it reports it')
      const subs = await find(m.db)
      body = { event: req.event, occurrences: subs.length, queued: await emitMessageEvent(m, req.event, subs) }
    } else {
      body = { results: await runTriggerRules(m, req.rule_id || null) }
    }
    if (dispatch) {
      const d = await dispatchMessages(m.env, m.db, m.inst, 50)
      body.sent = d.sent; body.failed = d.failed
    }
    return ok(body)
  })

  r.post('/admin/messaging/triggers', CONFIG, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ id?: string; name?: string; event?: string; condition?: Record<string, unknown> | null; audience?: string; channel?: string;
      template_code?: string; lead_minutes?: number; quiet_from?: string; quiet_to?: string; is_active?: boolean }>(c.req)
    const name = tr(req.name), event = tr(req.event), tpl = tr(req.template_code)
    const lead = req.lead_minutes ?? 0, qf = req.quiet_from ?? '', qt = req.quiet_to ?? ''
    if (name === '') throw badRequest('a rule needs a name. It is how the school finds it again')
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(event)) throw badRequest('event must look like student.absent')
    if (!/^(guardians|student|staff|role:[a-z_]+)$/.test(req.audience ?? '')) throw badRequest('audience must be guardians, student, staff or role:<key>')
    if (!knownChannel(req.channel)) throw badRequest('channel must be email, sms, whatsapp or in_app')
    if (tpl === '') throw badRequest('a rule needs a template code')
    if (lead < 0 || lead > 20160) throw badRequest('lead time must be between zero and a fortnight')
    if ((qf === '') !== (qt === '')) throw badRequest('quiet hours need both a start and an end')
    const cond = JSON.stringify(req.condition ?? {})
    const t = now()
    try {
      if (req.id) {
        if (!isUUID(req.id)) throw badRequest('malformed rule id')
        const res = await c.db.prepare(`UPDATE message_trigger_rules SET name = ?, event = ?, condition = ?, audience = ?, channel = ?, template_code = ?,
            lead_minutes = ?, quiet_from = ?, quiet_to = ?, is_active = ?, updated_at = ? WHERE id = ?`)
          .bind(name, event, cond, req.audience, req.channel, tpl, lead, qf || null, qt || null, req.is_active ? 1 : 0, t, req.id).run()
        if ((res.meta.changes ?? 0) === 0) throw notFound()
        return ok({ id: req.id })
      }
      const id = uuid()
      await c.db.prepare(`INSERT INTO message_trigger_rules (id, institution_id, name, event, condition, audience, channel, template_code, lead_minutes,
          quiet_from, quiet_to, is_active, last_queued, repeat_days, max_attempts, skip_explained, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, 1, ?, ?)`)
        .bind(id, inst, name, event, cond, req.audience, req.channel, tpl, lead, qf || null, qt || null, req.is_active ? 1 : 0, t, t).run()
      return ok({ id })
    } catch (e) {
      if (e instanceof Error && /message_trigger_rules_one_per_name|UNIQUE constraint failed/i.test(e.message)) throw badRequest('a rule with that name already exists')
      throw e
    }
  })

  r.del('/admin/messaging/triggers/{id}', CONFIG, async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('malformed rule id')
    const res = await c.db.prepare(`DELETE FROM message_trigger_rules WHERE id = ?`).bind(c.params.id).run()
    if ((res.meta.changes ?? 0) === 0) throw notFound()
    return ok({ ok: true })
  })

  // --- credits and routing --------------------------------------------------------
  r.get('/admin/messaging/credits', READ, async (c) => {
    const rows = await c.db.prepare(`SELECT channel, balance, low_water FROM message_credits`).all<{ channel: string; balance: number; low_water: number }>()
    const seen = new Map(rows.results.map((v) => [v.channel, v]))
    const custom = await planAllowsCustomIntegration(c)
    const items = []
    for (const ch of ['sms', 'whatsapp']) {
      const v = seen.get(ch)
      const balance = Number(v?.balance ?? 0), low = Number(v?.low_water ?? 0)
      const m = await isMetered(c, ch, !!v, custom)
      const empty = m && balance <= 0
      items.push({ channel: ch, metered: m, balance, low_water: low, low: m && !empty && low > 0 && balance <= low, empty })
    }
    return ok({ items })
  })

  r.get('/admin/messaging/credits/{channel}/entries', READ, async (c) => {
    const ch = c.params.channel
    if (!metered(ch)) throw badRequest('channel must be sms or whatsapp')
    const rows = await c.db.prepare(`SELECT e.id, e.delta, e.reason, e.note, u.full_name AS actor, e.created_at FROM message_credit_entries e
        LEFT JOIN users u ON u.id = e.actor_id WHERE e.channel = ? ORDER BY e.created_at DESC LIMIT 200`).bind(ch).all<Row>()
    return ok({ items: rows.results.map((v) => ({ id: v.id, delta: Number(v.delta), reason: v.reason, note: v.note ?? undefined, actor: v.actor ?? undefined, created_at: v.created_at })) })
  })

  r.post('/admin/messaging/credits/{channel}', CREDS, async (c) => {
    const inst = institutionId(c)
    const ch = c.params.channel
    if (!metered(ch)) throw badRequest('channel must be sms or whatsapp')
    let body: { delta?: number | null; low_water?: number | null; note?: string; reason?: string }
    try { body = await c.req.json() } catch { throw badRequest('body must be json') }
    if (body.delta !== undefined && body.delta !== null && (body.delta > 1_000_000 || body.delta < -1_000_000)) throw badRequest('delta must be between -1000000 and 1000000')
    const reason = tr(body.reason) || 'topup'
    const delta = body.delta ?? 0
    const t = now()
    const stmts: D1PreparedStatement[] = [c.db.prepare(`INSERT INTO message_credits (institution_id, channel, balance, low_water, updated_at) VALUES (?1, ?2, max(?3, 0), 100, ?4)
        ON CONFLICT (institution_id, channel) DO UPDATE SET balance = max(message_credits.balance + ?3, 0), updated_at = ?4`).bind(inst, ch, delta, t)]
    if (delta !== 0) stmts.push(c.db.prepare(`INSERT INTO message_credit_entries (id, institution_id, channel, delta, reason, actor_id, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst, ch, delta, reason, c.id.platformAdmin ? null : c.id.userId, tr(body.note) || null, t))
    if (body.low_water !== undefined && body.low_water !== null && body.low_water >= 0) {
      stmts.push(c.db.prepare(`UPDATE message_credits SET low_water = ?, updated_at = ? WHERE channel = ?`).bind(body.low_water, t, ch))
    }
    stmts.push(c.db.prepare(`SELECT balance FROM message_credits WHERE channel = ?`).bind(ch))
    let res: D1Result[]
    try { res = await c.db.batch(stmts) } catch { throw new HttpError(500, 'Could not change the message credits.') }
    const balance = Number((res[res.length - 1].results[0] as { balance?: number } | undefined)?.balance ?? 0)
    return ok({ channel: ch, balance })
  })

  r.del('/admin/messaging/credits/{channel}', CREDS, async (c) => {
    const inst = institutionId(c)
    const ch = c.params.channel
    if (!metered(ch)) throw badRequest('channel must be sms or whatsapp')
    const cur = await c.db.prepare(`SELECT balance FROM message_credits WHERE channel = ?`).bind(ch).first<{ balance: number }>()
    if (!cur) return ok({ channel: ch, metered: false })
    const stmts = [c.db.prepare(`DELETE FROM message_credits WHERE channel = ?`).bind(ch)]
    if (cur.balance > 0) stmts.push(c.db.prepare(`INSERT INTO message_credit_entries (id, institution_id, channel, delta, reason, actor_id, note, created_at)
        VALUES (?, ?, ?, ?, 'adjustment', ?, 'metering switched off', ?)`).bind(uuid(), inst, ch, -cur.balance, c.id.platformAdmin ? null : c.id.userId, now()))
    try { await c.db.batch(stmts) } catch { throw new HttpError(500, 'Could not switch metering off.') }
    return ok({ channel: ch, metered: false })
  })

  r.get('/admin/messaging/routing', READ, async (c) => {
    const custom = await planAllowsCustomIntegration(c)
    const items = []
    for (const ch of ['email', 'sms', 'whatsapp']) items.push({ channel: ch, route: await routeFor(c, ch, custom), may_choose: custom })
    return ok({ items })
  })

  r.put('/admin/messaging/routing/{channel}', CREDS, async (c) => {
    const inst = institutionId(c)
    const ch = c.params.channel
    if (!routable(ch)) throw badRequest('channel must be email, sms or whatsapp')
    let body: { route?: string }
    try { body = await c.req.json() } catch { throw badRequest('body must be json') }
    const route = tr(body.route)
    if (route !== 'own' && route !== 'edu_cloud') throw badRequest('route must be own or edu_cloud')
    if (route === 'own' && !await planAllowsCustomIntegration(c)) throw new HttpError(402, 'Sending on your own vendor account is part of the Complete pack.')
    await c.db.prepare(`INSERT INTO message_routing (institution_id, channel, route, updated_at) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT (institution_id, channel) DO UPDATE SET route = excluded.route, updated_at = ?4`).bind(inst, ch, route, now()).run()
    return ok({ channel: ch, route })
  })

  // --- recharge requests --------------------------------------------------------------
  r.get('/admin/messaging/recharges', READ, async (c) => {
    const rows = await c.db.prepare(`SELECT q.id, q.channel, q.messages, q.status, q.note, q.response, u.full_name AS requested_by, q.requested_at, q.granted, q.decided_at
        FROM message_credit_requests q LEFT JOIN users u ON u.id = q.requested_by ORDER BY q.requested_at DESC LIMIT 50`).all<Row>()
    return ok({ items: rows.results.map((v) => ({ id: v.id, channel: v.channel, messages: Number(v.messages), status: v.status, note: v.note ?? undefined,
      response: v.response ?? undefined, requested_by: v.requested_by ?? undefined, requested_at: v.requested_at,
      granted: v.granted === null ? undefined : Number(v.granted), decided_at: v.decided_at ?? undefined })) })
  })

  r.get('/admin/messaging/recharge-sizes', READ, () => ok({ items: [1000, 5000, 10000, 25000, 50000] }))

  r.post('/admin/messaging/recharges/{channel}', CREDS, async (c) => {
    const inst = institutionId(c)
    const ch = c.params.channel
    if (!metered(ch)) throw badRequest('channel must be sms or whatsapp')
    let body: { messages?: number; note?: string }
    try { body = await c.req.json() } catch { throw badRequest('body must be json') }
    const n = body.messages ?? 0
    if (!(n > 0) || n > 1_000_000) throw badRequest('messages must be between 1 and 1000000')
    const res = await c.db.prepare(`INSERT INTO message_credit_requests (id, institution_id, channel, messages, status, note, requested_by, requested_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT DO NOTHING`)
      .bind(uuid(), inst, ch, n, tr(body.note) || null, c.id.platformAdmin ? null : c.id.userId, now()).run()
    if ((res.meta.changes ?? 0) === 0) throw new HttpError(409, 'There is already a recharge request waiting for this channel.')
    return ok({ ok: true })
  })

  r.del('/admin/messaging/recharges/{id}', CREDS, async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('id must be a uuid')
    await c.db.prepare(`UPDATE message_credit_requests SET status = 'cancelled', decided_at = ? WHERE id = ? AND status = 'pending'`).bind(now(), c.params.id).run()
    return ok({ ok: true })
  })

  // --- the log and the sends --------------------------------------------------------------
  r.get('/admin/messaging/log', 'auth', async (c) => {
    requireAny(c, SEND, AUDIT)
    const q = c.url.searchParams
    const n = Number(q.get('limit'))
    const limit = Number.isInteger(n) && n > 0 && n <= 500 ? n : 200
    const rows = await c.db.prepare(`SELECT m.id, m.channel, m.recipient, m.subject, m.status, m.provider, m.template_code, m.source_kind, tr.name AS rule,
        m.occurrence_key, m.error, m.attempts, ${isoZ('m.queued_at')} AS queued_at, ${isoZ('m.sent_at')} AS sent_at, ${isoZ('m.send_after')} AS send_after
      FROM message_log m LEFT JOIN message_trigger_rules tr ON tr.id = m.source_id AND m.source_kind = 'trigger_rule'
     WHERE (?1 IS NULL OR m.channel = ?1) AND (?2 IS NULL OR m.status = ?2)
     ORDER BY m.queued_at DESC LIMIT ?3`).bind(q.get('channel') || null, q.get('status') || null, limit).all<Row>()
    const u = <T>(v: T | null) => (v === null ? undefined : v)
    return ok({ items: rows.results.map((v) => ({ id: v.id, channel: v.channel, recipient: v.recipient, subject: u(v.subject), status: v.status,
      provider: u(v.provider), template_code: u(v.template_code), source_kind: u(v.source_kind), rule: u(v.rule), occurrence_key: u(v.occurrence_key),
      error: u(v.error), attempts: Number(v.attempts), queued_at: v.queued_at, sent_at: u(v.sent_at), send_after: u(v.send_after) })) })
  })

  r.post('/admin/messaging/send', SEND, async (c) => {
    const req = await readJSON<{ channel?: string; template_code?: string; to?: string; to_user_id?: string; student_id?: string; source_id?: string; source_kind?: string; occurrence_key?: string; vars?: Record<string, unknown>; dispatch?: boolean }>(c.req)
    if (!knownChannel(req.channel)) throw badRequest('channel must be email, sms, whatsapp or in_app')
    if (tr(req.template_code) === '') throw badRequest('a template code is required')
    if (req.to_user_id && !isUUID(req.to_user_id)) throw badRequest('malformed to_user_id')
    if (req.student_id && !isUUID(req.student_id)) throw badRequest('malformed student_id')
    if (req.source_id && !isUUID(req.source_id)) throw badRequest('malformed source_id')
    if (tr(req.to) === '' && !req.to_user_id) throw badRequest('name a recipient: either to or to_user_id')
    const m = scopeOf(c)
    let res: { id: string | null; duplicate: boolean }
    try {
      res = await queueMessage(m, { channel: req.channel, template_code: tr(req.template_code), vars: req.vars ?? undefined,
        recipient: tr(req.to), to_user_id: req.to_user_id || null, student_id: req.student_id || null, source_id: req.source_id || null,
        source_kind: req.source_kind || null, occurrence_key: req.occurrence_key || null })
    } catch (e) {
      if (e instanceof MessagingError && e.code === 'provider_not_configured') throw new HttpError(409, e.message, { code: 'provider_not_configured' })
      if (e instanceof MessagingError && e.code === 'no_recipient') throw badRequest('that recipient has no address on file for this channel')
      throw e
    }
    const body: Record<string, unknown> = { queued: !res.duplicate, duplicate: res.duplicate }
    if (res.id) body.id = res.id
    if (req.dispatch && !res.duplicate) {
      const d = await dispatchMessages(m.env, m.db, m.inst, 10)
      body.sent = d.sent; body.failed = d.failed
    }
    return json(body, 202)
  })

  r.post('/admin/messaging/dispatch', SEND, async (c) => {
    const text = await c.req.text()
    let limit = 0
    if (text.trim() !== '') {
      try { limit = Number((JSON.parse(text) as { limit?: number }).limit ?? 0) || 0 } catch { throw badRequest('malformed JSON body') }
    }
    const m = scopeOf(c)
    const d = await dispatchMessages(m.env, m.db, m.inst, limit)
    return ok({ sent: d.sent, failed: d.failed })
  })

  r.post('/admin/messaging/send-direct', SEND, sendDirect)

}

/** smsPresets in sms_presets.go. */
const SMS_PRESETS = [
  {
    id: 'fast2sms', label: 'Fast2SMS',
    note: 'Uses the API key from Dev API as the API key. Sender is your six-character DLT header; the template id and the entity id ride with every message on the DLT manual route, so both must be approved on the DLT portal and added under Fast2SMS → DLT.',
    endpoint: 'https://www.fast2sms.com/dev/bulkV2', method: 'POST', encoding: 'form',
    params: { authorization: '{key}', entity_id: '{entity}', flash: '0', message: '{text}', numbers: '{to}', route: 'dlt_manual', sender_id: '{sender}', template_id: '{dlt}' },
    needs: ['API key', 'sender header', 'DLT entity id', 'DLT template id'],
  },
  {
    id: 'msg91', label: 'MSG91',
    note: 'Uses the authkey as the API key. Sender is your six-character header, and the DLT template id is required for transactional traffic. The DLT entity (PE) id is bound on the MSG91 account itself, not sent per message: add MSG91 as a telemarketer on the DLT portal and register the header and templates there.',
    endpoint: 'https://api.msg91.com/api/sendhttp.php', method: 'GET', encoding: 'form',
    params: { DLT_TE_ID: '{dlt}', authkey: '{key}', country: '91', message: '{text}', mobiles: '{to}', route: '4', sender: '{sender}' },
    needs: ['authkey', 'sender header', 'DLT entity id', 'DLT template id'],
  },
  {
    id: 'gupshup', label: 'Gupshup (Enterprise SMS)',
    note: 'Uses the account password as the API key and the user id as a parameter. The mask is your approved sender header.',
    endpoint: 'https://enterprise.smsgupshup.com/GatewayAPI/rest', method: 'GET', encoding: 'form',
    params: { auth_scheme: 'plain', dltTemplateId: '{dlt}', format: 'text', mask: '{sender}', method: 'SendMessage', msg: '{text}', msg_type: 'TEXT',
      password: '{key}', principalEntityId: '{entity}', send_to: '{to}', userid: '', v: '1.1' },
    needs: ['user id', 'password', 'approved mask', 'DLT template id'],
  },
]
