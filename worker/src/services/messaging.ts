import type { Env } from '../env'
import type { Ctx } from '../router'
import { institutionById, tenantDb } from '../tenant'
import { enqueue, enqueueMany, registerJob, type Job } from './jobs'
import { BUILTIN_TEMPLATES } from '../routes/admin/msg_templates'
import { loadGuard, normalisePhone, permits } from '../routes/admin/msg_guard'
import { PROVIDER as PHONE_PROVIDER, isPhoneGatewayConfig, smsGatewayReason } from '../routes/comms/sms_gateway'
import { sendSMTP } from './smtp'
import { sendPush, pushConfigured } from './push'
import { deliverFamilyAlerts } from '../routes/portal/school_life'

/* The message pipeline of internal/api/messaging.go on the Worker:
   QueueMessage (queueWith), DispatchMessages, the provider adapters (SMTP,
   HTTP gateway, WhatsApp Cloud, the paired office phone, in-app), the
   recipient guard, credits and routing (message_credits.go), and the FCM push
   pump (push_tokens.go pushOnce).

   Queueing writes the message_log row exactly as Go did and enqueues a
   'message.send' job for the school. The job is DispatchMessages for that
   school: it claims one due row at a time (a lease on send_after in place of
   FOR UPDATE SKIP LOCKED), sends it, and marks it sent / queued-for-retry /
   failed / suppressed with Go's sentences. A retry enqueues its own delayed
   job, so nothing depends on a cron.

   The platform's own providers (Go: integrations rows with institution_id
   NULL) have no table on the Worker. They come from Worker secrets instead:
   PLATFORM_PROVIDERS (JSON, same shape as a school's integration config plus
   "secret", keyed by channel) and, for email, RESEND_API_KEY + PLATFORM_MAIL_FROM
   as a shorthand. */

// ---------------------------------------------------------------------------
// errors

export class MessagingError extends Error {
  constructor(public code: 'provider_not_configured' | 'no_recipient' | 'no_template' | 'unknown_channel' | 'no_credits', message: string) {
    super(message)
  }
}
export const ERR_NOT_CONFIGURED = 'messaging provider is not configured'
export const ERR_NO_RECIPIENT = 'no address on file for this recipient'
export const ERR_NO_CREDITS = 'out of message credits for this channel, top up to resume sending'

// ---------------------------------------------------------------------------
// providers

export interface Attachment { filename: string; content_type: string; data: Uint8Array }
export interface WATemplateSend { name: string; language: string; params: string[] }
export interface Outbound { to: string; subject: string; body: string; dlt: string; wa?: WATemplateSend | null; attachments?: Attachment[] }

export interface Provider {
  channel: string
  name: string
  configured: boolean
  why: string
  /** Returns the provider's message id ('' when it has none). Throws on failure. */
  send(m: Outbound): Promise<string>
}
export type ProviderSet = Record<string, Provider>

const CHANNELS = ['email', 'sms', 'whatsapp', 'in_app']
export const knownChannel = (c: string) => CHANNELS.includes(c)

const notConfigured = (ch: string, why: string) => new MessagingError('provider_not_configured', `${ch}: ${ERR_NOT_CONFIGURED}: ${why}`)

function unconfigured(channel: string, reason: string): Provider {
  return { channel, name: channel + ':unconfigured', configured: false, why: reason, send: async () => { throw notConfigured(channel, reason) } }
}
const inApp: Provider = { channel: 'in_app', name: 'in_app', configured: true, why: '', send: async () => '' }

const s = (v: unknown) => (typeof v === 'string' ? v : '')
const trunc = (v: string, n: number) => { v = v.trim(); return v.length <= n ? v : v.slice(0, n) }
const hostOf = (raw: string) => { try { return new URL(raw).hostname } catch { return '' } }
const timeout = () => AbortSignal.timeout(15_000)

/** smtpProvider. The TCP conversation lives in ./smtp.ts (cloudflare:sockets). */
function smtpProvider(cfg: Record<string, unknown>, password: string): Provider {
  let why = ''
  if (s(cfg.host).trim() === '') why = 'no SMTP host set'
  else if (!(Number(cfg.port) > 0)) why = 'no SMTP port set'
  else if (s(cfg.from_address).trim() === '') why = 'no From address set. A message with no sender is rejected by every recipient'
  return {
    channel: 'email', name: 'smtp', configured: why === '', why,
    send: async (m) => {
      if (why) throw notConfigured('email', why)
      await sendSMTP({
        host: s(cfg.host), port: Number(cfg.port), username: s(cfg.username), password,
        fromAddress: s(cfg.from_address), fromName: s(cfg.from_name), security: s(cfg.security),
      }, m)
      return ''
    },
  }
}

/** Resend (platform email only; not a Go provider, the Worker's stand-in for the seller's mail server). */
function resendProvider(apiKey: string, from: string, fromName: string): Provider {
  let why = ''
  if (apiKey.trim() === '') why = 'no Resend API key set'
  else if (from.trim() === '') why = 'no From address set. A message with no sender is rejected by every recipient'
  return {
    channel: 'email', name: 'email:resend', configured: why === '', why,
    send: async (m) => {
      if (why) throw notConfigured('email', why)
      const body: Record<string, unknown> = {
        from: fromName.trim() ? `${fromName.replace(/[\r\n]/g, ' ')} <${from}>` : from,
        to: [m.to], subject: m.subject.replace(/[\r\n]/g, ' '), text: m.body,
      }
      if (m.attachments?.length) body.attachments = m.attachments.map((a) => ({ filename: a.filename, content: b64(a.data), content_type: a.content_type || 'application/octet-stream' }))
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST', signal: timeout(),
        headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const raw = (await res.text()).slice(0, 2048)
      if (res.status >= 300) throw new Error(`resend ${res.status}: ${raw.trim()}`)
      try { return s((JSON.parse(raw) as { id?: unknown }).id) } catch { return '' }
    },
  }
}

/** gatewayProvider: a vendor's HTTPS send endpoint described by configuration (MSG91, Fast2SMS, Gupshup presets). */
function gatewayProvider(channel: string, cfg: Record<string, unknown>, apiKey: string): Provider {
  const endpoint = s(cfg.endpoint), h = hostOf(endpoint)
  let why = ''
  if (endpoint.trim() === '') why = 'no gateway endpoint set. Blocked on a vendor account'
  else if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) why = 'gateway endpoint must be an http or https URL'
  else if (apiKey === '' && s(cfg.auth_header).trim() === '') why = 'no API key stored. Blocked on a vendor account'
  return {
    channel, name: h ? `${channel}:${h}` : channel, configured: why === '', why,
    send: async (m) => {
      if (why) throw notConfigured(channel, why)
      const subs: Record<string, string> = { '{to}': m.to, '{text}': m.body, '{sender}': s(cfg.sender_id), '{key}': apiKey, '{dlt}': m.dlt, '{entity}': s(cfg.dlt_entity_id) }
      const sub = (v: string) => v.replace(/\{(to|text|sender|key|dlt|entity)\}/g, (k) => subs[k])
      const params = (cfg.params && typeof cfg.params === 'object' ? cfg.params : {}) as Record<string, unknown>
      const fields: Record<string, string> = {}
      for (const [k, v] of Object.entries(params)) fields[k] = sub(s(v))
      const form = () => { const q = new URLSearchParams(); for (const k of Object.keys(fields).sort()) q.set(k, fields[k]); return q.toString() }
      const method = (s(cfg.method).trim().toUpperCase()) || 'POST'
      const headers: Record<string, string> = {}
      let url = endpoint, body: string | undefined
      if (method === 'GET') url = endpoint + (endpoint.includes('?') ? '&' : '?') + form()
      else if (s(cfg.encoding).toLowerCase() === 'json') { body = JSON.stringify(fields); headers['content-type'] = 'application/json' }
      else { body = form(); headers['content-type'] = 'application/x-www-form-urlencoded' }
      const ah = s(cfg.auth_header).trim()
      if (ah) headers[s(cfg.auth_header_name).trim() || 'Authorization'] = sub(ah)
      const res = await fetch(url, { method, headers, body, signal: timeout() })
      const raw = (await res.text()).slice(0, 2048)
      if (res.status >= 300) throw new Error(`gateway ${res.status} ${res.statusText}: ${raw.trim()}`)
      return raw.trim()
    },
  }
}

// --- WhatsApp Cloud API (whatsapp.go) -------------------------------------

const META_ADVICE: Record<number, string> = {
  0: 'the request was malformed. This is a fault in the product, not in the account',
  4: "the app's request quota for this hour is spent. Sends will resume automatically; reduce the dispatch rate if it recurs",
  10: 'this app does not hold the whatsapp_business_messaging permission. Grant it to the System User in Business Settings',
  33: 'the phone number id is not one this token can see. Check the id and that the token belongs to the same business',
  100: 'a parameter was rejected. Usually the phone number id or the recipient number',
  190: 'the access token is not valid or has been revoked: generate a new long-lived System User token and paste it in',
  200: 'the token lacks permission on this WhatsApp Business Account. Grant the System User access to the WABA',
  368: "the account is temporarily blocked for a policy violation, Meta's Business Support decides when it lifts",
  80007: 'the rate limit for this account has been hit. The queue will drain more slowly',
  130429: "the number's throughput limit has been hit. Messages are being sent faster than the tier allows",
  131005: 'access denied to this resource',
  131008: 'a required parameter is missing from the request',
  131009: 'a parameter value is not accepted. Check the template parameter values for newlines or tabs, which WhatsApp rejects',
  131016: "the service is temporarily unavailable at Meta's end",
  131021: 'the recipient number is the same as the sender number',
  131026: 'the message cannot be delivered. The recipient may not have WhatsApp, or the number may be wrong',
  131031: 'this WhatsApp Business Account has been locked or restricted',
  131042: 'the business account has no valid payment method. Add one in Business Settings or nothing will send',
  131047: 'outside the 24-hour window, so free text was refused. Send an approved template instead',
  131048: "the number's spam rate is too high and sending is restricted, Meta lifts this as the rating recovers",
  131049: 'Meta withheld this message to protect user engagement. A marketing-category send throttled by policy',
  131051: 'this message type is not supported',
  131052: 'a media file could not be downloaded',
  131056: 'too many messages to this same recipient in a short time',
  132000: 'the number of parameters sent does not match the approved template. Check the stored parameter mapping',
  132001: 'no such approved template in that language. Check the template name and the language code in WhatsApp Manager',
  132005: 'the hydrated template text is too long. Shorten the parameter values',
  132007: 'the template text violates the format policy. Usually a newline, tab or four consecutive spaces in a parameter',
  132012: 'a template parameter format does not match what was approved',
  132015: 'the template is paused for poor quality and cannot be sent until it recovers',
  132016: 'the template has been disabled for quality reasons and must be re-created',
  132068: 'the flow this template uses is blocked',
  133004: 'the WhatsApp Business Account server is temporarily unavailable',
  133005: 'the two-step verification PIN is wrong',
  133006: 'the phone number needs to be verified before it can send',
  133008: 'too many wrong two-step PIN attempts, wait before retrying',
  133009: 'the two-step PIN was entered too quickly after the last attempt',
  133010: 'this phone number is not registered on the WhatsApp Business platform. Register it in WhatsApp Manager',
  133015: 'the number is being deregistered or moved and cannot send',
}

export function explainMetaError(status: number, raw: string): Error {
  let e: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string }; fbtrace_id?: string } | undefined
  try { e = (JSON.parse(raw) as { error?: typeof e }).error } catch { /* below */ }
  if (!e || !e.message) return new Error(`whatsapp: HTTP ${status} from the Cloud API, and the answer was not an error object: ${trunc(raw, 200)}`)
  const code = Number(e.code ?? 0)
  const advice = META_ADVICE[code] ?? "unrecognised error code. See Meta's cloud API error reference"
  let out = `whatsapp: ${advice} (code ${code}`
  if (e.error_subcode) out += `/${e.error_subcode}`
  out += '): ' + e.message
  const d = (e.error_data?.details ?? '').trim()
  if (d && d !== e.message) out += ' - ' + d
  if (e.fbtrace_id) out += ' [trace ' + e.fbtrace_id + ']'
  return new Error(trunc(out, 480))
}

function whatsappCloudProvider(cfg: Record<string, unknown>, token: string): Provider {
  const pn = s(cfg.phone_number_id).trim()
  let why = ''
  if (pn === '') why = "no WhatsApp phone number id set. Copy it from Meta's WhatsApp Manager"
  else if (!/^[0-9]+$/.test(pn)) why = 'the WhatsApp phone number id must be the numeric id, not the phone number'
  else if (token.trim() === '') why = 'no access token stored. Paste a long-lived System User token'
  return {
    channel: 'whatsapp', name: 'whatsapp:cloud', configured: why === '', why,
    send: async (m) => {
      if (why) throw notConfigured('whatsapp', why)
      const to = normalisePhone(m.to)
      if (to === '') throw new MessagingError('no_recipient', `whatsapp: ${ERR_NO_RECIPIENT}: "${redact(m.to)}" is not a phone number`)
      let payload: Record<string, unknown>
      if (m.wa && m.wa.name.trim() !== '') {
        const lang = m.wa.language.trim() || s(cfg.default_language).trim() || 'en'
        const tmpl: Record<string, unknown> = { name: m.wa.name.trim(), language: { code: lang } }
        if (m.wa.params.length) tmpl.components = [{ type: 'body', parameters: m.wa.params.map((v) => ({ type: 'text', text: v })) }]
        payload = { messaging_product: 'whatsapp', to, type: 'template', template: tmpl }
      } else if (cfg.allow_free_text === true) {
        payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: m.body, preview_url: false } }
      } else {
        throw new MessagingError('provider_not_configured', `whatsapp: ${ERR_NOT_CONFIGURED}: no approved template is mapped for this message, ` +
          'and WhatsApp accepts free text only inside a 24-hour window opened by the ' +
          "parent's own reply. Which this product cannot observe, having no inbound " +
          'webhook. Map this template to an approved WhatsApp template name')
      }
      const v = s(cfg.api_version).trim() || 'v21.0'
      let res: Response
      try {
        res = await fetch(`https://graph.facebook.com/${v}/${pn}/messages`, {
          method: 'POST', signal: timeout(),
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(payload),
        })
      } catch (err) { throw new Error('whatsapp: could not reach graph.facebook.com: ' + String((err as Error).message ?? err)) }
      const answer = (await res.text()).slice(0, 8192)
      if (res.status >= 300) throw explainMetaError(res.status, answer)
      let id = ''
      try { id = s((JSON.parse(answer) as { messages?: { id?: string }[] }).messages?.[0]?.id) } catch { /* below */ }
      if (!id) throw new Error('whatsapp: the API answered 200 with no message id. The send cannot be confirmed')
      return id
    },
  }
}

function redact(v: string): string { v = v.trim(); return v === '' ? '' : '…' + v.slice(-4) }

/** The paired office phone: success means "available to a handset"; the outbox selects rows marked sent by 'sms:phone'. */
function phoneProvider(reason: string): Provider {
  return {
    channel: 'sms', name: PHONE_PROVIDER, configured: reason === '', why: reason,
    send: async () => { if (reason) throw notConfigured('sms', reason); return '' },
  }
}

function parseCfg(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined || raw === '') return {}
  try { const v = JSON.parse(String(raw)); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null } catch { return null }
}

/** buildProvider in messaging.go (+ buildWhatsAppProvider). */
export function buildProvider(channel: string, rawCfg: unknown, secret: string): Provider {
  const cfg = parseCfg(rawCfg)
  if (!cfg) return unconfigured(channel, 'stored settings are not readable')
  switch (channel) {
    case 'email':
      if (s(cfg.kind).toLowerCase() === 'resend') return resendProvider(secret, s(cfg.from_address), s(cfg.from_name))
      return smtpProvider(cfg, secret)
    case 'whatsapp':
      return s(cfg.phone_number_id).trim() !== '' ? whatsappCloudProvider(cfg, secret) : gatewayProvider(channel, cfg, secret)
    case 'sms': return gatewayProvider(channel, cfg, secret)
    case 'in_app': return inApp
  }
  return unconfigured(channel, 'unknown channel')
}

// --- sealed credentials (same format as routes/admin/providers.ts) --------

async function openSecretEnv(env: Env, sealed: unknown): Promise<string> {
  if (!sealed) return ''
  const bytes = sealed instanceof Uint8Array ? sealed : new Uint8Array(sealed as ArrayBuffer | number[])
  if (bytes.length === 0) return ''
  const key = env.CREDENTIAL_KEY
  if (typeof key !== 'string' || key.trim() === '') throw new Error('CREDENTIAL_KEY is not set')
  if (bytes.length < 12) throw new Error('stored credential is truncated')
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  const k = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt'])
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, k, bytes.slice(12)))
  } catch { throw new Error('stored credential will not decrypt, CREDENTIAL_KEY may have changed') }
}

/** loadProviders for a school: every channel present, configured or not. */
export async function loadProviders(env: Env, db: D1Database, inst: string): Promise<ProviderSet> {
  // Go: institution_id IS NOT DISTINCT FROM $1. The school's D1 also holds the platform's (NULL) rows.
  const rows = (await db.prepare(`SELECT provider, config, credentials, enabled FROM integrations
      WHERE kind = 'messaging' AND ${inst ? 'institution_id IS NOT NULL' : 'institution_id IS NULL'}`)
    .all<{ provider: string; config: string | null; credentials: ArrayBuffer | null; enabled: number }>()).results
  const stored = new Map(rows.map((r) => [r.provider, r]))
  const set: ProviderSet = { in_app: inApp }
  for (const ch of ['email', 'sms', 'whatsapp']) {
    const row = stored.get(ch)
    if (!row) { set[ch] = unconfigured(ch, ch === 'email' ? 'not set up yet' : 'not set up. Awaiting a vendor account and its credentials'); continue }
    if (!Number(row.enabled)) { set[ch] = unconfigured(ch, 'configured but switched off'); continue }
    if (ch === 'sms' && isPhoneGatewayConfig(row.config) && inst) {
      try { set[ch] = phoneProvider(await smsGatewayReason(db, inst)) } catch (e) { set[ch] = unconfigured('sms', 'could not read the paired phones: ' + (e as Error).message) }
      continue
    }
    let secret: string
    try { secret = await openSecretEnv(env, row.credentials) } catch (e) { set[ch] = unconfigured(ch, (e as Error).message); continue }
    set[ch] = buildProvider(ch, row.config, secret)
  }
  return set
}

/**
 * platformProviders: the seller's channels. As Go, these are the messaging
 * integrations rows with institution_id NULL (sealed with CREDENTIAL_KEY),
 * which the D1 converter copies into every school's database; `db` is the
 * school database to read them from. A channel with no such row falls back
 * to the Worker secrets PLATFORM_PROVIDERS / RESEND_API_KEY, last.
 */
export async function platformProviders(env: Env, db: D1Database | null): Promise<ProviderSet> {
  const set: ProviderSet = db ? await loadProviders(env, db, '') : { in_app: inApp }
  const stored = db ? new Set((await db.prepare(`SELECT provider FROM integrations WHERE kind = 'messaging' AND institution_id IS NULL`)
    .all<{ provider: string }>()).results.map((r) => r.provider)) : new Set<string>()
  let conf: Record<string, Record<string, unknown>> = {}
  try { const v = JSON.parse(s(env.PLATFORM_PROVIDERS) || '{}'); if (v && typeof v === 'object') conf = v } catch { /* unreadable: nothing configured */ }
  for (const ch of ['email', 'sms', 'whatsapp']) {
    if (stored.has(ch)) continue
    const c = conf[ch]
    if (c && typeof c === 'object') { set[ch] = buildProvider(ch, JSON.stringify(c), s(c.secret)); continue }
    if (ch === 'email' && s(env.RESEND_API_KEY) !== '') { set[ch] = resendProvider(s(env.RESEND_API_KEY), s(env.PLATFORM_MAIL_FROM), s(env.PLATFORM_MAIL_FROM_NAME)); continue }
    set[ch] = unconfigured(ch, ch === 'email' ? 'not set up yet' : 'not set up. Awaiting a vendor account and its credentials')
  }
  return set
}

/** Codes the platform sends on a school's behalf, through its own channels. */
export const SENT_BY_PLATFORM: Record<string, boolean> = { password_reset: true, 'credits.low': true, 'credits.empty': true }

// ---------------------------------------------------------------------------
// templates

const TEMPLATE_VAR = /\{\{\s*([a-z0-9_]+)\s*\}\}/g

export function renderTemplate(body: string, vars: Record<string, unknown>): string {
  return body.replace(TEMPLATE_VAR, (m, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? goSprint(vars[name]) : m))
}
function goSprint(v: unknown): string {
  if (v === null || v === undefined) return '<nil>'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export async function resolveTemplate(db: D1Database, code: string, channel: string):
  Promise<{ subject: string; body: string; dlt: string } | null> {
  const r = await db.prepare(`SELECT subject, body, dlt_template_id FROM message_templates WHERE code = ? AND channel = ? AND is_active = 1`)
    .bind(code, channel).first<{ subject: string | null; body: string | null; dlt_template_id: string | null }>()
  if (r) return { subject: r.subject ?? '', body: r.body ?? '', dlt: r.dlt_template_id ?? '' }
  const b = BUILTIN_TEMPLATES[code]
  return b ? { subject: b.subject, body: b.body, dlt: '' } : null
}

// ---------------------------------------------------------------------------
// queueing

export interface SendRequest {
  channel: string
  template_code: string
  vars?: Record<string, unknown>
  to_user_id?: string | null
  student_id?: string | null
  recipient?: string | null
  source_kind?: string | null
  source_id?: string | null
  occurrence_key?: string | null
  /** ISO timestamp; held until then. */
  send_after?: string | null
  attachments?: Attachment[]
}
export interface SendResult { id: string | null; duplicate: boolean }

/** Where to queue: the school's database and id. */
export interface MsgScope { env: Env; db: D1Database; inst: string }

export const scopeOf = (c: Ctx): MsgScope => ({ env: c.env, db: c.db, inst: c.id.institution!.id })

async function addressFor(db: D1Database, user: string, channel: string): Promise<string> {
  const u = await db.prepare(`SELECT email, phone FROM users WHERE id = ?`).bind(user).first<{ email: string | null; phone: string | null }>()
  if (!u) throw new MessagingError('no_recipient', ERR_NO_RECIPIENT)
  if (channel === 'email' && u.email) return u.email
  if ((channel === 'sms' || channel === 'whatsapp') && u.phone) return u.phone
  if (channel === 'in_app') return user
  throw new MessagingError('no_recipient', ERR_NO_RECIPIENT)
}

/**
 * A batch of queueMessage calls that share one provider-set read, and one
 * dispatch kick at the end (Go's queueWith for fan-outs). Call kick() once
 * the rows are written.
 */
export class Messenger {
  private schoolSet: ProviderSet | null = null
  private platformSet: ProviderSet | null = null
  private schoolName: string | null = null
  private kicks = false
  constructor(public m: MsgScope) {}

  async providers(code: string): Promise<ProviderSet> {
    if (SENT_BY_PLATFORM[code]) return (this.platformSet ??= await platformProviders(this.m.env, this.m.db))
    return (this.schoolSet ??= await loadProviders(this.m.env, this.m.db, this.m.inst))
  }

  /** QueueMessage. Throws MessagingError for the refusals Go returned as errors. */
  async queue(req: SendRequest): Promise<SendResult> {
    const { db, inst } = this.m
    if (!knownChannel(req.channel)) throw new MessagingError('unknown_channel', `unknown channel "${req.channel}"`)
    const set = await this.providers(req.template_code)
    let p = set[req.channel]
    if (!p || !p.configured) {
      if (!SENT_BY_PLATFORM[req.template_code]) throw notConfigured(req.channel, p ? p.why : 'not set up yet')
      if (!p) p = unconfigured(req.channel, 'platform channel not set up yet')
    }
    let recipient = (req.recipient ?? '').trim()
    if (recipient === '' && req.to_user_id) recipient = await addressFor(db, req.to_user_id, req.channel)
    if (recipient === '') throw new MessagingError('no_recipient', ERR_NO_RECIPIENT)

    const vars: Record<string, unknown> = { ...(req.vars ?? {}) }
    if (inst && !Object.prototype.hasOwnProperty.call(vars, 'school_name')) {
      if (this.schoolName === null) {
        const r = await db.prepare(`SELECT name FROM institutions WHERE id = ?`).bind(inst).first<{ name: string }>()
        this.schoolName = r?.name ?? ''
      }
      if (this.schoolName) vars.school_name = this.schoolName
    }
    const t = await resolveTemplate(db, req.template_code, req.channel)
    if (!t) {
      throw new MessagingError('no_template', `there is no ${req.channel} wording for "${req.template_code}" yet, add it under Communication → ` +
        'Message channels → Wording')
    }
    const subject = renderTemplate(t.subject, vars), body = renderTemplate(t.body, vars)
    const id = crypto.randomUUID(), at = new Date().toISOString()
    const sk = (req.source_kind ?? '').trim() === '' ? null : req.source_kind!
    const ok = (req.occurrence_key ?? '') === '' ? null : req.occurrence_key!
    const r = await db.prepare(`INSERT INTO message_log (id, institution_id, channel, template_code, recipient, user_id, student_id,
          subject, body, status, provider, source_kind, source_id, occurrence_key, send_after, template_vars, queued_at, attempts)
        VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,0)
        ON CONFLICT DO NOTHING RETURNING id`)
      .bind(id, inst, req.channel, req.template_code, recipient, req.to_user_id ?? null, req.student_id ?? null,
        subject.trim() === '' ? null : subject, body, p.name, sk, req.source_id ?? null, ok, req.send_after ?? null,
        JSON.stringify(req.vars === undefined && Object.keys(vars).length === 0 ? null : vars), at)
      .first<{ id: string }>()
    if (!r) return { id: null, duplicate: true }
    if (req.channel === 'email' && req.attachments?.length) {
      await db.batch(req.attachments.map((a) => db.prepare(`INSERT INTO message_attachments (id, institution_id, message_log_id, filename, content_type, bytes, created_at)
          VALUES (?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), inst, id, a.filename, a.content_type, a.data, at)))
    }
    if (!req.send_after || Date.parse(req.send_after) <= Date.now()) this.kicks = true
    return { id, duplicate: false }
  }

  /** Enqueue the dispatch job(s) for everything queued through this messenger. */
  async kick(): Promise<void> {
    if (!this.kicks) return
    this.kicks = false
    await kickDispatch(this.m.env, this.m.inst)
  }
}

/** QueueMessage for a single message, with its own dispatch kick. */
export async function queueMessage(m: MsgScope, req: SendRequest): Promise<SendResult> {
  const ms = new Messenger(m)
  const res = await ms.queue(req)
  await ms.kick()
  return res
}

/** Enqueue a dispatch sweep for a school. Held and retried rows are picked up
    by the every-minute cron sweep (services/cron.ts, 'message.send'). */
export async function kickDispatch(env: Env, inst: string): Promise<void> {
  await enqueue(env, 'message.send', { institution_id: inst }, { institution_id: inst })
}

// ---------------------------------------------------------------------------
// credits and routing (message_credits.go)

const metered = (ch: string) => ch === 'sms' || ch === 'whatsapp'
const routable = (ch: string) => metered(ch) || ch === 'email'

async function planAllowsCustomIntegration(env: Env, inst: string): Promise<boolean> {
  const r = await env.CONTROL.prepare(`SELECT p.custom_integration FROM subscriptions s LEFT JOIN plans p ON p.code = s.plan_code
      WHERE s.institution_id = ? ORDER BY s.started_on DESC LIMIT 1`).bind(inst).first<{ custom_integration: number | null }>()
  return !!r && !!Number(r.custom_integration ?? 0)
}

export async function routeFor(env: Env, db: D1Database, inst: string, ch: string): Promise<string> {
  if (!routable(ch)) return 'own'
  if (!await planAllowsCustomIntegration(env, inst)) return 'edu_cloud'
  const stored = await db.prepare(`SELECT route FROM message_routing WHERE channel = ?`).bind(ch).first<{ route: string }>()
  if (stored) return stored.route
  const conf = await db.prepare(`SELECT count(*) AS n FROM integrations WHERE institution_id IS NOT NULL AND kind = 'messaging' AND provider = ? AND enabled = 1`).bind(ch).first<{ n: number }>()
  return Number(conf?.n ?? 0) > 0 ? 'own' : 'edu_cloud'
}

async function creditBalance(env: Env, db: D1Database, inst: string, ch: string, route: string): Promise<[number, boolean]> {
  if (!metered(ch)) return [0, false]
  const r = await db.prepare(`SELECT balance FROM message_credits WHERE channel = ?`).bind(ch).first<{ balance: number }>()
  if (!r) return [0, route === 'edu_cloud']
  return [Number(r.balance), true]
}

function channelLabel(ch: string): string { return ch === 'sms' ? 'SMS' : ch === 'whatsapp' ? 'WhatsApp' : ch }

/** spendCredit: after the row is marked sent. Conditional decrement, then the ledger, then the low/empty alert. */
async function spendCredit(m: MsgScope, ch: string, msgId: string): Promise<void> {
  if (!metered(ch)) return
  const { db, inst } = m
  const at = new Date().toISOString()
  const res = await db.prepare(`UPDATE message_credits SET balance = balance - 1, updated_at = ? WHERE channel = ? AND balance > 0`).bind(at, ch).run()
  if (!res.meta.changes) return
  try { await alertIfCrossed(m, ch) } catch (e) { console.warn('credit alert not queued', ch, e) }
  await db.prepare(`INSERT INTO message_credit_entries (id, institution_id, channel, delta, reason, message_id, created_at)
      VALUES (?, ?, ?, -1, 'send', ?, ?)`).bind(crypto.randomUUID(), inst, ch, msgId || null, at).run()
}

async function alertIfCrossed(m: MsgScope, ch: string): Promise<void> {
  const { db, inst, env } = m
  const r = await db.prepare(`SELECT balance, low_water FROM message_credits WHERE channel = ?`).bind(ch).first<{ balance: number; low_water: number }>()
  if (!r) return
  const balance = Number(r.balance), low = Number(r.low_water)
  let code = ''
  if (balance === 0) code = 'credits.empty'
  else if (low > 0 && balance === low) code = 'credits.low'
  else return
  const school = (await db.prepare(`SELECT name FROM institutions WHERE id = ?`).bind(inst).first<{ name: string }>())?.name ?? ''
  const vars = { school_name: school, channel: channelLabel(ch), balance, low_water: low }
  const day = new Date().toISOString().slice(0, 10)
  const ms = new Messenger(m)
  const admins = (await db.prepare(`SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE u.status = 'active' AND u.email IS NOT NULL AND r.key = 'institution_admin'`).all<{ id: string }>()).results
  for (const a of admins) {
    await ms.queue({ channel: 'email', template_code: code, vars, to_user_id: a.id, source_kind: 'credits', occurrence_key: `${code}:${ch}:${day}` })
  }
  // The seller, by address: platform staff live in CONTROL.
  const sellers = (await env.CONTROL.prepare(`SELECT DISTINCT u.email FROM platform_users u JOIN platform_user_roles ur ON ur.user_id = u.id
      WHERE u.status = 'active' AND u.email IS NOT NULL AND ur.role_key = 'seller_admin'`).all<{ email: string }>().catch(() => ({ results: [] as { email: string }[] }))).results
  for (const s2 of sellers) {
    await ms.queue({ channel: 'email', template_code: code, vars, recipient: s2.email, source_kind: 'credits', occurrence_key: `${code}:${ch}:seller:${s2.email}:${day}` })
  }
  await ms.kick()
}

// ---------------------------------------------------------------------------
// dispatch

const RETRY_ATTEMPTS = 5
export function retrySchedule(attempt: number): [boolean, number] {
  if (attempt >= RETRY_ATTEMPTS) return [false, 0]
  let delay = 300
  for (let i = 1; i < attempt; i++) delay *= 3
  return [true, Math.min(delay, 3600)]
}

const waWhitespace = /[\s\p{Zs}]+/gu
const waCleanParam = (v: string) => v.replace(waWhitespace, ' ').trim()

export async function whatsappSendFor(db: D1Database, code: string, vars: Record<string, unknown>): Promise<WATemplateSend | null> {
  if (code.trim() === '') return null
  const r = await db.prepare(`SELECT wa_template_name, wa_language, wa_params FROM message_templates WHERE code = ? AND channel = 'whatsapp' AND is_active = 1`)
    .bind(code).first<{ wa_template_name: string | null; wa_language: string | null; wa_params: string | null }>()
  if (!r || (r.wa_template_name ?? '').trim() === '') return null
  let params: string[] = []
  if (r.wa_params) {
    try { const v = JSON.parse(r.wa_params); if (!Array.isArray(v)) throw new Error(); params = v.map(String) } catch { throw new Error(`template "${code}": stored parameter mapping is not a list`) }
  }
  const out: WATemplateSend = { name: r.wa_template_name!, language: r.wa_language ?? '', params: [] }
  for (const name of params) {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new Error(`whatsapp template "${out.name}" expects a value for "${name}" and this message carries none - the stored parameter mapping and the template body disagree`)
    }
    const text = waCleanParam(goSprint(vars[name]))
    if (text === '') throw new Error(`whatsapp template "${out.name}" would be sent with "${name}" empty, which WhatsApp rejects`)
    out.params.push(text)
  }
  return out
}

const LEASE_SECONDS = 120

/** DispatchMessages for one school. Returns counts; throws only on database errors. */
export async function dispatchMessages(env: Env, db: D1Database, inst: string, limit = 50): Promise<{ sent: number; failed: number; more: boolean }> {
  if (limit <= 0 || limit > 200) limit = 50
  const m: MsgScope = { env, db, inst }
  let sent = 0, failed = 0, inAppSent = 0
  let loaded = false
  let guard: Awaited<ReturnType<typeof loadGuard>> | null = null
  let schoolSet: ProviderSet = {}
  let platformSet: ProviderSet | null = null
  const routes: Record<string, string> = {}
  const guardCtx = { db } as unknown as Ctx

  for (let i = 0; i < limit; i++) {
    const at = new Date().toISOString()
    const row = await db.prepare(`SELECT id, channel, recipient, subject, body, template_code, attempts, template_vars, send_after
        FROM message_log WHERE status = 'queued' AND (send_after IS NULL OR send_after <= ?)
        ORDER BY queued_at LIMIT 1`).bind(at)
      .first<{ id: string; channel: string; recipient: string; subject: string | null; body: string | null; template_code: string | null; attempts: number; template_vars: string | null; send_after: string | null }>()
    if (!row) return { sent, failed, more: false }
    // Claim it: a lease on send_after stands in for FOR UPDATE SKIP LOCKED.
    const lease = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString()
    const claim = await db.prepare(`UPDATE message_log SET send_after = ? WHERE id = ? AND status = 'queued' AND send_after IS ?`)
      .bind(lease, row.id, row.send_after).run()
    if (!claim.meta.changes) continue

    if (!loaded) {
      guard = await loadGuard(guardCtx)
      schoolSet = await loadProviders(env, db, inst)
      loaded = true
    }
    const [allowed, why] = permits(guard!, row.channel, row.recipient)
    if (!allowed) {
      await db.prepare(`UPDATE message_log SET status = 'suppressed', error = ?, send_after = NULL WHERE id = ?`).bind(trunc(why, 500), row.id).run()
      continue
    }
    if (!(row.channel in routes)) routes[row.channel] = await routeFor(env, db, inst, row.channel)
    const route = routes[row.channel]
    let set = schoolSet
    if (route === 'edu_cloud' || (row.template_code && SENT_BY_PLATFORM[row.template_code])) set = (platformSet ??= await platformProviders(env, db))
    const p = set[row.channel] ?? unconfigured(row.channel, 'unknown channel')

    let dlt = ''
    if (row.template_code) { try { dlt = (await resolveTemplate(db, row.template_code, row.channel))?.dlt ?? '' } catch { /* as Go */ } }

    let sendErr: Error | null = null, msgId = ''
    let wa: WATemplateSend | null = null
    if (row.channel === 'whatsapp' && row.template_code) {
      let vars: Record<string, unknown> = {}
      try { const v = JSON.parse(row.template_vars ?? 'null'); if (v && typeof v === 'object') vars = v } catch { /* empty */ }
      try { wa = await whatsappSendFor(db, row.template_code, vars) } catch (e) { sendErr = e as Error }
    }
    if (!sendErr && p.configured) {
      const [bal, isMetered] = await creditBalance(env, db, inst, row.channel, route)
      if (isMetered && bal <= 0) sendErr = new MessagingError('no_credits', ERR_NO_CREDITS)
    }
    let atts: Attachment[] = []
    if (!sendErr && row.channel === 'email') {
      atts = (await db.prepare(`SELECT filename, content_type, bytes FROM message_attachments WHERE message_log_id = ? ORDER BY id`).bind(row.id)
        .all<{ filename: string; content_type: string; bytes: ArrayBuffer }>()).results
        .map((a) => ({ filename: a.filename, content_type: a.content_type, data: new Uint8Array(a.bytes) }))
    }
    if (!sendErr) {
      try {
        msgId = await p.send({ to: row.recipient, subject: row.subject ?? '', body: row.body ?? '', dlt, wa, attachments: atts })
      } catch (e) { sendErr = e instanceof Error ? e : new Error(String(e)) }
    }
    if (sendErr) {
      failed++
      const [retry, delay] = retrySchedule(Number(row.attempts) + 1)
      if (!retry) {
        await db.prepare(`UPDATE message_log SET status = 'failed', error = ?, attempts = attempts + 1, provider = ?, send_after = ? WHERE id = ?`)
          .bind(trunc(sendErr.message, 500), p.name, row.send_after, row.id).run()
      } else {
        await db.prepare(`UPDATE message_log SET status = 'queued', error = ?, attempts = attempts + 1, provider = ?, send_after = ? WHERE id = ?`)
          .bind(trunc(sendErr.message, 500), p.name, new Date(Date.now() + delay * 1000).toISOString(), row.id).run()
      }
      continue
    }
    sent++
    await db.prepare(`UPDATE message_log SET status = 'sent', sent_at = ?, attempts = attempts + 1, provider = ?,
        provider_msg_id = NULLIF(?, ''), error = NULL, send_after = ? WHERE id = ?`)
      .bind(new Date().toISOString(), p.name, trunc(msgId, 200), row.send_after, row.id).run()
    await spendCredit(m, row.channel, row.id)
    if (row.channel === 'in_app') {
      const r = await db.prepare(`INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, source_kind, source_id, link, created_at)
          SELECT ?, m.institution_id, m.user_id, m.student_id,
                 COALESCE(m.template_code, 'message'),
                 COALESCE(NULLIF(m.subject,''), 'Message from school'),
                 m.body, 'message', m.id,
                 CASE WHEN EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                                    WHERE ur.user_id = m.user_id AND r.key = 'parent') THEN
                   CASE WHEN m.template_code LIKE 'transport.%' THEN '/parent/my_childs_bus/live_bus_tracking'
                        WHEN m.template_code LIKE 'fee%' THEN '/parent/fees/fees_payments'
                        WHEN m.template_code LIKE 'attendance%' OR m.template_code LIKE 'absen%' THEN '/parent/attendance/attendance'
                        WHEN m.template_code LIKE 'homework%' THEN '/parent/academics/homework_academics'
                        WHEN m.template_code LIKE 'report_card%' OR m.template_code LIKE 'result%' THEN '/parent/academics/results_report_cards'
                        ELSE NULL END
                 ELSE NULL END, ?
            FROM message_log m
           WHERE m.id = ? AND m.user_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.source_kind = 'message' AND n.source_id = m.id)`)
        .bind(crypto.randomUUID(), new Date().toISOString(), row.id).run()
      inAppSent += r.meta.changes ?? 0
    }
  }
  if (inAppSent > 0 && pushConfigured(env)) await enqueue(env, 'push.pump', { institution_id: inst }, { institution_id: inst })
  return { sent, failed, more: true }
}

// ---------------------------------------------------------------------------
// push pump (push_tokens.go pushOnce), per school

const PUSH_FRESHNESS_MS = 24 * 3600_000

export async function pushOnce(env: Env, db: D1Database): Promise<void> {
  if (!pushConfigured(env)) return
  const rows = (await db.prepare(`SELECT id, user_id, kind, title, body, link, created_at FROM notifications
      WHERE pushed_at IS NULL ORDER BY created_at LIMIT 200`)
    .all<{ id: string; user_id: string; kind: string; title: string; body: string | null; link: string | null; created_at: string }>()).results
  if (!rows.length) return
  const users = [...new Set(rows.map((r) => r.user_id))]
  const tokens = new Map<string, string[]>()
  for (let i = 0; i < users.length; i += 90) {
    const part = users.slice(i, i + 90)
    const ts = (await db.prepare(`SELECT user_id, token FROM push_tokens WHERE user_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(part))
      .all<{ user_id: string; token: string }>()).results
    for (const t of ts) tokens.set(t.user_id, [...(tokens.get(t.user_id) ?? []), t.token])
  }
  const base = s(env.PUBLIC_BASE_URL).replace(/\/+$/, '')
  const dead: string[] = []
  for (const r of rows) {
    if (Date.now() - Date.parse(r.created_at) > PUSH_FRESHNESS_MS) continue
    for (const t of tokens.get(r.user_id) ?? []) {
      let link = r.link ?? ''
      if (link.startsWith('/')) link = base + link
      try {
        const res = await sendPush(env, t, { title: r.title, body: r.body ?? '', link, kind: r.kind, id: r.id })
        if (res === 'unregistered') dead.push(t)
      } catch (e) { console.warn('push: send', e) }
    }
  }
  const at = new Date().toISOString()
  const stmts: D1PreparedStatement[] = []
  for (let i = 0; i < rows.length; i += 90) {
    const part = rows.slice(i, i + 90).map((r) => r.id)
    stmts.push(db.prepare(`UPDATE notifications SET pushed_at = ? WHERE id IN (SELECT value FROM json_each(?))`).bind(at, JSON.stringify(part)))
  }
  for (let i = 0; i < dead.length; i += 90) {
    const part = dead.slice(i, i + 90)
    stmts.push(db.prepare(`DELETE FROM push_tokens WHERE token IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(part)))
  }
  await db.batch(stmts)
}

// ---------------------------------------------------------------------------
// jobs

async function schoolDb(env: Env, inst: string): Promise<D1Database | null> {
  const row = await institutionById(env, inst)
  if (!row) { console.warn('message job: no such school', inst); return null }
  return tenantDb(env, row)
}

registerJob<{ institution_id: string }>('message.send', async (env, job: Job<{ institution_id: string }>) => {
  const inst = job.payload.institution_id ?? job.institution_id
  if (!inst) return
  const db = await schoolDb(env, inst)
  if (!db) return
  const res = await dispatchMessages(env, db, inst, 50)
  if (res.more) await kickDispatch(env, inst)
})

/* The push pump. Go ran RunPushPump in the worker process: every 5 s a
   pushOnce pass over unpushed notifications, and once a minute
   materialiseForTokenHolders (deliverFamilyAlerts for every parent holding a
   push token). Here the cron enqueues this per school every minute
   (services/cron.ts 'push_pump'), and message dispatch enqueues it after
   in-app deliveries; the job materialises when asked, then pushes. */
registerJob<{ institution_id: string; materialise?: boolean }>('push.pump', async (env, job) => {
  const inst = job.payload.institution_id ?? job.institution_id
  if (!inst || !pushConfigured(env)) return
  const db = await schoolDb(env, inst)
  if (!db) return
  if (job.payload.materialise) {
    try { await materialiseForTokenHolders(db) } catch (e) { console.warn('push: materialise', e) }
  }
  await pushOnce(env, db)
})

async function materialiseForTokenHolders(db: D1Database): Promise<void> {
  const holders = (await db.prepare(`SELECT DISTINCT user_id FROM push_tokens`).all<{ user_id: string }>()).results
  for (const h of holders) {
    const kids = (await db.prepare(`SELECT sg.student_id FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id WHERE g.user_id = ?`)
      .bind(h.user_id).all<{ student_id: string }>()).results.map((k) => k.student_id)
    if (!kids.length) continue // staff hold tokens too; their alerts are written at source
    try {
      const stmts = deliverFamilyAlerts({ db } as unknown as Ctx, h.user_id, kids)
      if (stmts.length) await db.batch(stmts)
    } catch (e) { console.warn('push: materialise for user', h.user_id, e) }
  }
}

// ---------------------------------------------------------------------------

function b64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
export { b64 as base64Bytes }

/* Go's message:send task (queue.TypeMessageSend -> QueueOutbound): queue one
   templated message to an account, keyed on the job so a retry is a duplicate. */
registerJob<{ channel: string; template_key: string; to_user_id: string; vars?: Record<string, unknown>; job_id?: string }>('message:send', async (env, job) => {
  const inst = job.institution_id ?? (job.payload as { institution_id?: string }).institution_id
  if (!inst) return
  const db = await schoolDb(env, inst)
  if (!db) return
  const p = job.payload
  try {
    await queueMessage({ env, db, inst }, {
      channel: p.channel, template_code: p.template_key, vars: p.vars, to_user_id: p.to_user_id || null,
      source_kind: 'queue_task', source_id: p.job_id ?? job.id ?? null, occurrence_key: p.template_key,
    })
  } catch (e) {
    if (e instanceof MessagingError) { console.warn('message:send not queued', inst, p.template_key, e.message); return }
    throw e
  }
})

/** Go's s.Queue.Enqueue(TypeMessageSend, ...) for many recipients: one 'message:send' job each. */
export async function enqueueMessageSends(env: Env, inst: string,
  items: { channel: string; template_key: string; to_user_id: string; vars?: Record<string, unknown> }[]): Promise<void> {
  if (!items.length) return
  await enqueueMany(env, items.map((i) => ({ type: 'message:send', institution_id: inst,
    payload: { institution_id: inst, ...i, job_id: crypto.randomUUID() } as Record<string, unknown> })))
}

/** time.Now().Format("2 January 2006") in India. */
export function longDateIST(): string {
  const d = new Date(Date.now() + 330 * 60_000)
  const M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${d.getUTCDate()} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
