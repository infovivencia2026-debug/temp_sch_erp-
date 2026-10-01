import type { Env } from '../env'
import type { Ctx } from '../router'
import { institutionById, tenantDb } from '../tenant'
import { enqueue, enqueueMany, registerJob, type Job } from './jobs'
import { BUILTIN_TEMPLATES, BUILTIN_TEMPLATES_TE, isTelugu } from '../routes/admin/msg_templates'
import { loadGuard, normalisePhone, normaliseRecipient, permits } from '../routes/admin/msg_guard'
import { PROVIDER as PHONE_PROVIDER, isPhoneGatewayConfig, smsGatewayReason } from '../routes/comms/sms_gateway'
import { sendSMTP } from './smtp'
import { sendPush, pushConfigured } from './push'
import { deliverFamilyAlerts } from '../routes/portal/school_life'
import {
  afterQuietHours, channelStatus, dedupKeyOf, isDuplicate, liveMap, loadPolicies, loadSettings, looksEmail, messageType, messageTypeOf,
  phoneOf, sentToday, type DeliverySettings, type Policy,
  isMarketingSend, optOutReason, pricesOf, smsSegments, survivesOptOut,
} from './delivery'

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
/** A provider refused this message for a reason retrying will not change (a bad number,
    no approved template): with a rung left on the ladder, it moves on at once. */
export class PermanentSendError extends Error {}

export const ERR_NOT_CONFIGURED = 'messaging provider is not configured'
export const ERR_NO_RECIPIENT = 'no address on file for this recipient'
export const ERR_NO_CREDITS = 'out of message credits for this channel, top up to resume sending'

// ---------------------------------------------------------------------------
// providers

export interface Attachment { filename: string; content_type: string; data: Uint8Array }
export interface WATemplateSend { name: string; language: string; params: string[] }
export interface Media { kind: 'document' | 'image' | 'video'; url: string; filename?: string }
export interface Outbound {
  to: string; subject: string; body: string; dlt: string; wa?: WATemplateSend | null; attachments?: Attachment[]
  /** "<school id>:<message id>": echoed back by provider webhooks (WhatsApp biz_opaque_callback_data, Resend tags). */
  ref?: string
  /** A file to carry on WhatsApp (template header, or a media message inside the 24-hour window). */
  media?: Media | null
}

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
      const headers: Record<string, string> = { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' }
      if (m.ref) {
        // Resend tags carry the message back on its webhooks (routes/comms/message_webhooks.ts);
        // the idempotency key makes a retried send of the same row a no-op at Resend.
        body.tags = [{ name: 'ref', value: m.ref.replace(/[^A-Za-z0-9_-]/g, '_') }]
        headers['Idempotency-Key'] = m.ref
      }
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST', signal: timeout(), headers, body: JSON.stringify(body),
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
      if (res.status >= 300) {
        const msg = `gateway ${res.status} ${res.statusText}: ${raw.trim()}`
        throw res.status >= 400 && res.status < 500 && res.status !== 429 ? new PermanentSendError(msg) : new Error(msg)
      }
      return gatewayMessageId(raw)
    },
  }
}

/** The vendor's message id out of a gateway answer, for delivery reports to find the row
    (Fast2SMS request_id, MSG91 request id / message, Gupshup messageId); the raw answer otherwise. */
export function gatewayMessageId(raw: string): string {
  const t = raw.trim()
  try {
    const v = JSON.parse(t) as Record<string, unknown>
    for (const k of ['request_id', 'requestId', 'messageId', 'message_id', 'msgid', 'id']) {
      const x = v[k]
      if (typeof x === 'string' && x.trim()) return x.trim()
      if (typeof x === 'number') return String(x)
    }
    const r = v.response as Record<string, unknown> | undefined
    if (r && typeof r.id === 'string') return r.id
    if (v.type === 'success' && typeof v.message === 'string') return v.message
  } catch { /* not JSON */ }
  return t
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

const META_TRANSIENT = new Set([4, 80007, 130429, 131016, 131056, 133004])

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
  // Rate limits and Meta's own outages pass; everything else is about this message or account.
  return META_TRANSIENT.has(code) ? new Error(trunc(out, 480)) : new PermanentSendError(trunc(out, 480))
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
        const components: Record<string, unknown>[] = []
        // A template approved with a media header takes the file as its header parameter.
        if (m.media?.url) components.push({ type: 'header', parameters: [waMedia(m.media)] })
        if (m.wa.params.length) components.push({ type: 'body', parameters: m.wa.params.map((v) => ({ type: 'text', text: v })) })
        if (components.length) tmpl.components = components
        payload = { messaging_product: 'whatsapp', to, type: 'template', template: tmpl }
      } else if (cfg.allow_free_text === true) {
        payload = m.media?.url
          ? { messaging_product: 'whatsapp', to, type: m.media.kind, [m.media.kind]: { ...waMediaObject(m.media), caption: trunc(m.body, 1024) } }
          : { messaging_product: 'whatsapp', to, type: 'text', text: { body: m.body, preview_url: false } }
      } else {
        throw new MessagingError('provider_not_configured', `whatsapp: ${ERR_NOT_CONFIGURED}: no approved template is mapped for this message, ` +
          'and WhatsApp accepts free text only inside a 24-hour window opened by the ' +
          "parent's own reply. Which this product cannot observe, having no inbound " +
          'webhook. Map this template to an approved WhatsApp template name')
      }
      // Echoed back on every status webhook for this message (routes/comms/message_webhooks.ts).
      if (m.ref) payload.biz_opaque_callback_data = m.ref
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

function waMediaObject(m: Media): Record<string, unknown> {
  const o: Record<string, unknown> = { link: m.url }
  if (m.kind === 'document' && m.filename) o.filename = m.filename
  return o
}
function waMedia(m: Media): Record<string, unknown> {
  return { type: m.kind, [m.kind]: waMediaObject(m) }
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

export async function resolveTemplate(db: D1Database, code: string, channel: string, inst?: string | null):
  Promise<{ subject: string; body: string; dlt: string } | null> {
  const r = await db.prepare(`SELECT subject, body, dlt_template_id FROM message_templates WHERE code = ? AND channel = ? AND is_active = 1`)
    .bind(code, channel).first<{ subject: string | null; body: string | null; dlt_template_id: string | null }>()
  if (r) return { subject: r.subject ?? '', body: r.body ?? '', dlt: r.dlt_template_id ?? '' }
  /* A Telugu school's parents get the Telugu built-in (login messages only).
     WhatsApp keeps English: its wording is the Meta-approved template. */
  const te = BUILTIN_TEMPLATES_TE[code]
  if (te && inst && channel !== 'whatsapp') {
    const loc = await db.prepare(`SELECT locale FROM institutions WHERE id = ?`).bind(inst).first<{ locale: string | null }>().catch(() => null)
    if (isTelugu(loc?.locale)) return { subject: te.subject, body: te.body, dlt: '' }
  }
  const b = BUILTIN_TEMPLATES[code]
  return b ? { subject: b.subject, body: b.body, dlt: '' } : null
}

// ---------------------------------------------------------------------------
// queueing

export interface SendRequest {
  /** email | sms | whatsapp | in_app, or 'auto' for the message type's ladder. */
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
  /** A second queue() with the same key is a duplicate, whatever else differs. */
  idempotency_key?: string | null
  /** Send on exactly this channel: no ladder, no digest, no cap (a person chose it). */
  exact_channel?: boolean
  /** Skip de-duplication, the digest, the cap and quiet hours (an office resend). */
  force?: boolean
  /** A file for WhatsApp to carry (email carries attachments). */
  media?: Media | null
}
export interface SendResult {
  id: string | null
  duplicate: boolean
  /** Held for the recipient's daily digest ('digest') or over their daily cap ('cap'). */
  held?: 'digest' | 'cap'
  /** The channel the first rung went out on. */
  channel?: string
}

/** Where to queue: the school's database and id. */
export interface MsgScope { env: Env; db: D1Database; inst: string }

export const scopeOf = (c: Ctx): MsgScope => ({ env: c.env, db: c.db, inst: c.id.institution!.id })

interface Contact { email: string; phone: string }

async function contactOf(db: D1Database, user: string): Promise<Contact | null> {
  const u = await db.prepare(`SELECT email, phone FROM users WHERE id = ?`).bind(user).first<{ email: string | null; phone: string | null }>()
  return u ? { email: u.email ?? '', phone: u.phone ?? '' } : null
}

async function addressFor(db: D1Database, user: string, channel: string): Promise<string> {
  const u = await contactOf(db, user)
  if (!u) throw new MessagingError('no_recipient', ERR_NO_RECIPIENT)
  if (channel === 'email' && u.email) return u.email
  if ((channel === 'sms' || channel === 'whatsapp') && u.phone) return u.phone
  if (channel === 'in_app') return user
  throw new MessagingError('no_recipient', ERR_NO_RECIPIENT)
}

/** Ladder bookkeeping written with a row. */
interface RowExtra {
  message_type?: string | null
  ladder?: string[]
  dedup_key?: string | null
  idempotency_key?: string | null
  urgent?: boolean
  fallback_of?: string | null
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
  private settings: DeliverySettings | null = null
  private policies: Record<string, Policy> | null = null
  private live: Record<string, boolean> | null = null
  private kicks = false
  constructor(public m: MsgScope) {}

  async providers(code: string): Promise<ProviderSet> {
    if (SENT_BY_PLATFORM[code]) return (this.platformSet ??= await platformProviders(this.m.env, this.m.db))
    return (this.schoolSet ??= await loadProviders(this.m.env, this.m.db, this.m.inst))
  }

  /** Which channels are live right now (provider set up and, if metered, in credit). */
  async liveChannels(): Promise<Record<string, boolean>> {
    return (this.live ??= liveMap(await channelStatus(this.m.env, this.m.db, this.m.inst)))
  }

  /** QueueMessage. Throws MessagingError for the refusals Go returned as errors. */
  async queue(req: SendRequest): Promise<SendResult> {
    const { db } = this.m
    if (!knownChannel(req.channel) && req.channel !== 'auto') throw new MessagingError('unknown_channel', `unknown channel "${req.channel}"`)
    const idem = (req.idempotency_key ?? '').trim() || null
    if (idem) {
      const ex = await db.prepare(`SELECT id FROM message_log WHERE idempotency_key = ?`).bind(idem).first<{ id: string }>()
      if (ex) return { id: ex.id, duplicate: true }
    }
    let type: string | null = messageTypeOf(req.template_code)
    if (req.exact_channel || SENT_BY_PLATFORM[req.template_code] || (req.channel === 'email' && req.attachments?.length)) type = null
    if (type === null && req.channel === 'auto') type = 'other'
    if (type === null) {
      // Direct sends (a named channel, typed text) wake a phone as much as the ladder's do:
      // quiet hours hold them too, unless urgent, a code the person asked for, or forced.
      let sendAfter = req.send_after ?? null
      if (quietHoursApply(req)) {
        const settings = (this.settings ??= await loadSettings(db))
        const base = sendAfter ? Math.max(Date.parse(sendAfter), Date.now()) : Date.now()
        const q = afterQuietHours(base, settings.quiet_from, settings.quiet_to)
        if (q > base) sendAfter = new Date(q).toISOString()
      }
      return this.insert({ ...req, send_after: sendAfter }, req.channel, { idempotency_key: idem })
    }
    return this.ladder(req, type, idem)
  }

  /** The ladder path: dedup, digest, cap, quiet hours, then the first rung that can reach the person. */
  private async ladder(req: SendRequest, typeKey: string, idem: string | null): Promise<SendResult> {
    const { db, inst } = this.m
    const t = messageType(typeKey)
    const settings = (this.settings ??= await loadSettings(db))
    const pol = (this.policies ??= await loadPolicies(db))[typeKey] ?? { ladder: t.ladder, mode: t.mode }
    const user = req.to_user_id || null
    const raw = (req.recipient ?? '').trim()
    const who = user ?? raw
    if (!who) throw new MessagingError('no_recipient', ERR_NO_RECIPIENT)
    const contact: Contact = user ? (await contactOf(db, user)) ?? { email: '', phone: '' } : { email: looksEmail(raw) ? raw : '', phone: looksEmail(raw) ? '' : raw }
    if (raw) { if (looksEmail(raw)) contact.email = raw; else if (phoneOf(raw)) contact.phone = raw }
    const dedup = await dedupKeyOf(inst, req.template_code, who, req.student_id, req.vars)
    if (!req.force && await isDuplicate(db, dedup, settings.dedup_minutes)) return { id: null, duplicate: true }

    if (!req.force && !t.urgent && typeKey !== 'digest') {
      let held: 'digest' | 'cap' | null = pol.mode === 'digest' ? 'digest' : null
      if (!held && settings.daily_cap > 0 && await sentToday(db, user, contact.phone || contact.email || who) >= settings.daily_cap) held = 'cap'
      if (held) {
        await this.hold(req, typeKey, user, contact.phone || contact.email || who, dedup, held)
        return { id: null, duplicate: false, held }
      }
    }

    const live = await this.liveChannels()
    const reach = (ch: string) => ch === 'in_app' ? !!user
      : ch === 'email' ? live.email && contact.email !== ''
      : live[ch] && phoneOf(contact.phone) !== ''
    let rungs = pol.ladder.filter(reach)
    // Nothing on the ladder can reach them, but they have an account: the bell is free and always there.
    if (!rungs.length && user) rungs = ['in_app']
    if (!rungs.length) {
      const why = pol.ladder.map((ch) => ch === 'in_app' ? 'in-app needs an account' : live[ch] ? `${ch}: no address on file` : `${ch}: not live`).join('; ')
      throw notConfigured(req.channel === 'auto' ? pol.ladder[0] ?? 'in_app' : req.channel, `no channel on the ${t.label.toLowerCase()} ladder can reach this recipient (${why})`)
    }
    let sendAfter = req.send_after ?? null
    if (!t.urgent && !req.force) {
      const base = sendAfter ? Math.max(Date.parse(sendAfter), Date.now()) : Date.now()
      const q = afterQuietHours(base, settings.quiet_from, settings.quiet_to)
      if (q > base) sendAfter = new Date(q).toISOString()
    }
    const first = rungs[0]
    const recipient = first === 'in_app' ? user! : first === 'email' ? contact.email : contact.phone
    return this.insert({ ...req, recipient, send_after: sendAfter }, first,
      { message_type: typeKey, ladder: rungs.slice(1), dedup_key: dedup, idempotency_key: idem, urgent: t.urgent })
  }

  /** Put a non-urgent item in the recipient's next digest. */
  private async hold(req: SendRequest, typeKey: string, user: string | null, recipient: string, dedup: string, reason: 'digest' | 'cap'): Promise<void> {
    const { db, inst } = this.m
    const vars = await this.withSchool(req.vars)
    const t = await resolveTemplate(db, req.template_code, 'in_app', inst)
    const body = t ? renderTemplate(t.body, vars).trim() : ''
    let title = t ? renderTemplate(t.subject, vars).trim() : ''
    if (!title) title = String(vars.title ?? '').trim() || body.split('\n')[0].slice(0, 120) || req.template_code
    await db.prepare(`INSERT INTO message_digest_items (id, institution_id, user_id, recipient, message_type, template_code, title, body,
        source_kind, source_id, dedup_key, reason, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), inst, user, recipient, typeKey, req.template_code, trunc(title, 200), trunc(body, 1000),
        (req.source_kind ?? '').trim() || null, req.source_id ?? null, dedup, reason, new Date().toISOString()).run()
  }

  private async withSchool(v: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    const { db, inst } = this.m
    const vars: Record<string, unknown> = { ...(v ?? {}) }
    if (inst && !Object.prototype.hasOwnProperty.call(vars, 'school_name')) {
      if (this.schoolName === null) {
        const r = await db.prepare(`SELECT name FROM institutions WHERE id = ?`).bind(inst).first<{ name: string }>()
        this.schoolName = r?.name ?? ''
      }
      if (this.schoolName) vars.school_name = this.schoolName
    }
    return vars
  }

  /** Write one message_log row on one channel (Go's QueueMessage insert). */
  async insert(req: SendRequest, channel: string, extra: RowExtra = {}): Promise<SendResult> {
    const { db, inst } = this.m
    if (!knownChannel(channel)) throw new MessagingError('unknown_channel', `unknown channel "${channel}"`)
    const set = await this.providers(req.template_code)
    let p = set[channel]
    if (!p || !p.configured) {
      if (!SENT_BY_PLATFORM[req.template_code] && !extra.message_type) throw notConfigured(channel, p ? p.why : 'not set up yet')
      if (!p) p = unconfigured(channel, 'platform channel not set up yet')
    }
    let recipient = (req.recipient ?? '').trim()
    if (recipient === '' && req.to_user_id) recipient = await addressFor(db, req.to_user_id, channel)
    if (recipient === '') throw new MessagingError('no_recipient', ERR_NO_RECIPIENT)

    const vars = await this.withSchool(req.vars)
    if (req.media?.url) vars.__media = req.media
    const t = await resolveTemplate(db, req.template_code, channel, inst)
    if (!t) {
      throw new MessagingError('no_template', `there is no ${channel} wording for "${req.template_code}" yet, add it under Communication → ` +
        'Message channels → Wording')
    }
    const subject = renderTemplate(t.subject, vars), body = renderTemplate(t.body, vars)
    const id = crypto.randomUUID(), at = new Date().toISOString()
    // An SMS is billed per part: a Hindi or emoji body is UCS-2 at 70 characters a part.
    const seg = channel === 'sms' ? smsSegments(body) : null
    const sk = (req.source_kind ?? '').trim() === '' ? null : req.source_kind!
    const ok = (req.occurrence_key ?? '') === '' ? null : req.occurrence_key!
    const r = await db.prepare(`INSERT INTO message_log (id, institution_id, channel, template_code, recipient, user_id, student_id,
          subject, body, status, provider, source_kind, source_id, occurrence_key, send_after, template_vars, queued_at, attempts,
          message_type, ladder, dedup_key, idempotency_key, urgent, fallback_of, segments, encoding)
        VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)
        ON CONFLICT DO NOTHING RETURNING id`)
      .bind(id, inst, channel, req.template_code, recipient, req.to_user_id ?? null, req.student_id ?? null,
        subject.trim() === '' ? null : subject, body, p.name, sk, req.source_id ?? null, ok, req.send_after ?? null,
        JSON.stringify(req.vars === undefined && Object.keys(vars).length === 0 ? null : vars), at,
        extra.message_type ?? null, extra.ladder?.length ? JSON.stringify(extra.ladder) : null, extra.dedup_key ?? null,
        extra.idempotency_key ?? null, extra.urgent ? 1 : 0, extra.fallback_of ?? null, seg?.segments ?? null, seg?.encoding ?? null)
      .first<{ id: string }>()
    if (!r) return { id: null, duplicate: true }
    if (channel === 'email' && req.attachments?.length) {
      await db.batch(req.attachments.map((a) => db.prepare(`INSERT INTO message_attachments (id, institution_id, message_log_id, filename, content_type, bytes, created_at)
          VALUES (?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), inst, id, a.filename, a.content_type, a.data, at)))
    }
    if (!req.send_after || Date.parse(req.send_after) <= Date.now()) this.kicks = true
    return { id, duplicate: false, channel }
  }

  /** Enqueue the dispatch job(s) for everything queued through this messenger. */
  async kick(): Promise<void> {
    if (!this.kicks) return
    this.kicks = false
    await kickDispatch(this.m.env, this.m.inst)
  }
}

/** Sources whose direct sends are urgent (quiet hours do not hold them). */
const URGENT_SOURCES = new Set(['absence_alert', 'emergency', 'transport_trip'])

/** Do quiet hours hold this non-ladder send? Only phone channels; never codes, platform
    notices, tests, urgent sources or an office resend. */
export function quietHoursApply(req: Pick<SendRequest, 'channel' | 'template_code' | 'force' | 'source_kind'>): boolean {
  if (req.force) return false
  if (req.channel !== 'sms' && req.channel !== 'whatsapp') return false
  const code = (req.template_code ?? '').trim().toLowerCase()
  if (SENT_BY_PLATFORM[code] || code === 'messaging.test' || code.startsWith('credits.')) return false
  const t = messageTypeOf(code)
  if (t && messageType(t).urgent) return false
  return !URGENT_SOURCES.has((req.source_kind ?? '').trim())
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

/** [balance, metered] for a channel on a route (the half of creditBalance that needs only the school's database). */
export async function creditBalanceOf(db: D1Database, ch: string, route: string): Promise<[number, boolean]> {
  return creditBalance(null, db, '', ch, route)
}

async function creditBalance(_env: Env | null, db: D1Database, _inst: string, ch: string, route: string): Promise<[number, boolean]> {
  if (!metered(ch)) return [0, false]
  const r = await db.prepare(`SELECT balance FROM message_credits WHERE channel = ?`).bind(ch).first<{ balance: number }>()
  if (!r) return [0, route === 'edu_cloud']
  return [Number(r.balance), true]
}

function channelLabel(ch: string): string { return ch === 'sms' ? 'SMS' : ch === 'whatsapp' ? 'WhatsApp' : ch }

/** spendCredit: after the row is marked sent. Conditional decrement, then the ledger, then the low/empty alert. */
async function spendCredit(m: MsgScope, ch: string, msgId: string, parts = 1): Promise<void> {
  if (!metered(ch)) return
  const { db, inst } = m
  const at = new Date().toISOString()
  const n = Math.max(1, Math.trunc(parts))
  // One credit per SMS part (what the carrier bills), never below zero.
  const prevRow = await db.prepare(`SELECT balance FROM message_credits WHERE channel = ?`).bind(ch).first<{ balance: number }>()
  if (!prevRow || Number(prevRow.balance) <= 0) return
  const after = await db.prepare(`UPDATE message_credits SET balance = MAX(balance - ?, 0), updated_at = ? WHERE channel = ? AND balance > 0 RETURNING balance`)
    .bind(n, at, ch).first<{ balance: number }>()
  if (!after) return
  const prev = Number(prevRow.balance)
  const spent = Math.max(1, Math.min(n, prev - Number(after.balance)))
  try { await alertIfCrossed(m, ch, prev) } catch (e) { console.warn('credit alert not queued', ch, e) }
  await db.prepare(`INSERT INTO message_credit_entries (id, institution_id, channel, delta, reason, message_id, created_at)
      VALUES (?, ?, ?, ?, 'send', ?, ?)`).bind(crypto.randomUUID(), inst, ch, -spent, msgId || null, at).run()
}

async function alertIfCrossed(m: MsgScope, ch: string, prev?: number): Promise<void> {
  const { db, inst, env } = m
  const r = await db.prepare(`SELECT balance, low_water FROM message_credits WHERE channel = ?`).bind(ch).first<{ balance: number; low_water: number }>()
  if (!r) return
  const balance = Number(r.balance), low = Number(r.low_water)
  let code = ''
  // Crossed, not landed on: a three-part SMS can step from low+1 straight past low.
  const was = prev ?? balance + 1
  if (balance === 0 && was > 0) code = 'credits.empty'
  else if (low > 0 && balance <= low && was > low) code = 'credits.low'
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

/** A timeout or dropped connection after the request went out: it may have been delivered. */
export function ambiguousSendError(e: Error): boolean {
  if (e instanceof MessagingError || e instanceof PermanentSendError) return false
  const n = (e as { name?: string }).name ?? ''
  return n === 'TimeoutError' || n === 'AbortError' || /timed? ?out|socket hang up|connection (reset|closed)|network connection was lost/i.test(e.message)
}
/** Providers that make a repeated send of one row a no-op (Resend's Idempotency-Key). */
const idempotentProvider = (p: Provider) => p.name === 'email:resend' || p.channel === 'in_app'

/** Rows marked 'sending' whose lease ran out: the Worker died between the provider
    call and the result. Never re-sent (it may have gone); failed with the reason. */
export async function settleStaleSends(db: D1Database, inst: string): Promise<number> {
  const at = new Date().toISOString()
  const cutoff = new Date(Date.now() - LEASE_SECONDS * 1000).toISOString()
  const stale = (await db.prepare(`SELECT id, provider FROM message_log WHERE status = 'sending' AND send_after < ?`).bind(cutoff)
    .all<{ id: string; provider: string | null }>()).results
  const why = 'outcome unknown: the send was started and never confirmed, so it is not retried'
  for (const r of stale) {
    const u = await db.prepare(`UPDATE message_log SET status = 'failed', error = ?, failed_at = ? WHERE id = ? AND status = 'sending'`).bind(why, at, r.id).run()
    if (u.meta.changes) await recordEvent(db, inst, r.id, 'failed', r.provider, why, at)
  }
  return stale.length
}

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

  await settleStaleSends(db, inst)
  for (let i = 0; i < limit; i++) {
    const at = new Date().toISOString()
    const row = await db.prepare(`SELECT id, channel, recipient, subject, body, template_code, attempts, template_vars, send_after, ladder, user_id,
             source_kind, message_type, segments
        FROM message_log WHERE status = 'queued' AND (send_after IS NULL OR send_after <= ?)
        ORDER BY urgent DESC, queued_at LIMIT 1`).bind(at)
      .first<{ id: string; channel: string; recipient: string; subject: string | null; body: string | null; template_code: string | null; attempts: number; template_vars: string | null; send_after: string | null; ladder: string | null; user_id: string | null
        source_kind: string | null; message_type: string | null; segments: number | null }>()
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
    if (row.channel !== 'in_app') {
      const optOut = await optOutReason(db, normaliseRecipient(row.recipient), isMarketingSend(row.source_kind, row.template_code),
        survivesOptOut(row.template_code, row.message_type))
      if (optOut) {
        await db.prepare(`UPDATE message_log SET status = 'suppressed', error = ?, send_after = NULL WHERE id = ?`).bind(trunc(optOut, 500), row.id).run()
        continue
      }
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
    let media: Media | null = null
    if (row.channel === 'whatsapp') {
      let vars: Record<string, unknown> = {}
      try { const v = JSON.parse(row.template_vars ?? 'null'); if (v && typeof v === 'object') vars = v } catch { /* empty */ }
      const mv = vars.__media as Media | undefined
      if (mv && typeof mv.url === 'string' && ['document', 'image', 'video'].includes(mv.kind)) media = mv
      if (row.template_code) { try { wa = await whatsappSendFor(db, row.template_code, vars) } catch (e) { sendErr = e as Error } }
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
    if (!sendErr && row.channel !== 'in_app') {
      // Mark before the send: from here a crash, a lost 'sent' write or an expired lease
      // must not put this row back in the queue, or the family gets it twice.
      const mark = await db.prepare(`UPDATE message_log SET status = 'sending' WHERE id = ? AND status = 'queued'`).bind(row.id).run()
      if (!mark.meta.changes) continue
    }
    if (!sendErr) {
      try {
        msgId = await p.send({ to: row.recipient, subject: row.subject ?? '', body: row.body ?? '', dlt, wa, attachments: atts, ref: `${inst}:${row.id}`, media })
      } catch (e) { sendErr = e instanceof Error ? e : new Error(String(e)) }
    }
    if (sendErr && ambiguousSendError(sendErr) && !idempotentProvider(p)) {
      // The request left and no answer came back: the provider may well have sent it.
      // Retrying (or moving down the ladder) could message the family twice, so stop here.
      failed++
      const t = new Date().toISOString()
      const why = 'outcome unknown, not retried so nobody is messaged twice: ' + sendErr.message
      await db.prepare(`UPDATE message_log SET status = 'failed', error = ?, attempts = attempts + 1, provider = ?, send_after = ?, failed_at = ? WHERE id = ?`)
        .bind(trunc(why, 500), p.name, row.send_after, t, row.id).run()
      await recordEvent(db, inst, row.id, 'failed', p.name, why, t)
      continue
    }
    if (sendErr) {
      failed++
      const [retry, delay] = retrySchedule(Number(row.attempts) + 1)
      // With a rung left on the ladder, a refusal that cannot change (not set up, no address,
      // no credit) or a second transient failure moves on to it rather than waiting hours.
      const hasLadder = !!row.ladder && row.ladder !== '[]'
      const giveUp = !retry || (hasLadder && (sendErr instanceof MessagingError || sendErr instanceof PermanentSendError || Number(row.attempts) + 1 >= 2))
      if (giveUp) {
        const t = new Date().toISOString()
        await db.prepare(`UPDATE message_log SET status = 'failed', error = ?, attempts = attempts + 1, provider = ?, send_after = ?, failed_at = ? WHERE id = ?`)
          .bind(trunc(sendErr.message, 500), p.name, row.send_after, t, row.id).run()
        await recordEvent(db, inst, row.id, 'failed', p.name, sendErr.message, t)
        if (hasLadder) await queueFallback(m, row.id, sendErr.message)
      } else {
        await db.prepare(`UPDATE message_log SET status = 'queued', error = ?, attempts = attempts + 1, provider = ?, send_after = ? WHERE id = ?`)
          .bind(trunc(sendErr.message, 500), p.name, new Date(Date.now() + delay * 1000).toISOString(), row.id).run()
      }
      continue
    }
    sent++
    const sentAt = new Date().toISOString()
    const parts = row.channel === 'sms' ? Math.max(1, Number(row.segments ?? 0) || smsSegments(row.body ?? '').segments) : 1
    const cost = (pricesOf(env)[row.channel] ?? 0) * parts
    await db.prepare(`UPDATE message_log SET status = 'sent', sent_at = ?, attempts = attempts + 1, provider = ?,
        provider_msg_id = NULLIF(?, ''), error = NULL, send_after = ?, cost_paise = ?, segments = COALESCE(segments, ?) WHERE id = ?`)
      .bind(sentAt, p.name, trunc(msgId, 200), row.send_after, cost, row.channel === 'sms' ? parts : null, row.id).run()
    await recordEvent(db, inst, row.id, 'sent', p.name, null, sentAt)
    await spendCredit(m, row.channel, row.id, parts)
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
      // The bell always has it; the ladder goes on only if nobody will be told.
      if (row.ladder && row.ladder !== '[]' && row.user_id) {
        const hasToken = pushConfigured(env) && !!(await db.prepare(`SELECT 1 AS x FROM push_tokens WHERE user_id = ? LIMIT 1`).bind(row.user_id).first())
        if (!hasToken) await queueFallback(m, row.id, pushConfigured(env) ? 'no phone with the app to push to' : 'app push is not set up')
      }
    }
  }
  if (inAppSent > 0 && pushConfigured(env)) await enqueue(env, 'push.pump', { institution_id: inst }, { institution_id: inst })
  return { sent, failed, more: true }
}

// ---------------------------------------------------------------------------
// push pump (push_tokens.go pushOnce), per school

const PUSH_FRESHNESS_MS = 24 * 3600_000

export async function pushOnce(env: Env, db: D1Database, inst = ''): Promise<void> {
  if (!pushConfigured(env)) return
  const rows = (await db.prepare(`SELECT id, user_id, kind, title, body, link, created_at, source_kind, source_id FROM notifications
      WHERE pushed_at IS NULL ORDER BY created_at LIMIT 200`)
    .all<{ id: string; user_id: string; kind: string; title: string; body: string | null; link: string | null; created_at: string; source_kind: string | null; source_id: string | null }>()).results
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
  const unreached: string[] = []
  for (const r of rows) {
    if (Date.now() - Date.parse(r.created_at) > PUSH_FRESHNESS_MS) continue
    let delivered = false
    const held = tokens.get(r.user_id) ?? []
    for (const t of held) {
      let link = r.link ?? ''
      if (link.startsWith('/')) link = base + link
      try {
        const res = await sendPush(env, t, { title: r.title, body: r.body ?? '', link, kind: r.kind, id: r.id })
        if (res === 'unregistered') dead.push(t)
        else delivered = true
      } catch (e) { console.warn('push: send', e) }
    }
    // Every phone refused it: the message's ladder moves on (WhatsApp, then SMS).
    if (!delivered && held.length && r.source_kind === 'message' && r.source_id) unreached.push(r.source_id)
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
  if (unreached.length && inst) {
    for (const id of unreached) {
      try { await queueFallback({ env, db, inst }, id, 'the push to every phone failed') } catch (e) { console.warn('push: fallback', id, e) }
    }
  }
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
  await pushOnce(env, db, inst)
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
interface MessageSendJob {
  channel: string; template_key: string; to_user_id: string; vars?: Record<string, unknown>; job_id?: string; source_kind?: string; source_id?: string
  /** What this message is about, stable across retries and repeat clicks (e.g. "absence:<day>:<student>").
      With it, the same key to the same person on the same channel is queued once, ever. */
  dedupe_key?: string
  student_id?: string
}
registerJob<MessageSendJob>('message:send', async (env, job) => {
  const inst = job.institution_id ?? (job.payload as { institution_id?: string }).institution_id
  if (!inst) return
  const db = await schoolDb(env, inst)
  if (!db) return
  const p = job.payload
  try {
    await queueMessage({ env, db, inst }, messageSendRequest(p, p.job_id ?? job.id ?? null))
  } catch (e) {
    if (e instanceof MessagingError) { console.warn('message:send not queued', inst, p.template_key, e.message); return }
    throw e
  }
})

/** The SendRequest a 'message:send' job queues. A dedupe_key makes the idempotency key
    stable (what the message is about + who + channel), so a second click, a second job
    for the same thing, or a replayed job is a duplicate; without one it falls back to
    the job id, which only protects a retry of that one job. */
export function messageSendRequest(p: MessageSendJob, jobId: string | null): SendRequest {
  const dk = (p.dedupe_key ?? '').trim()
  return {
    channel: p.channel, template_code: p.template_key, vars: p.vars, to_user_id: p.to_user_id || null, student_id: p.student_id || null,
    // A notice's fan-out names its notice, so the delivery screen can count it.
    source_kind: p.source_kind || 'queue_task', source_id: p.source_id || (dk ? null : jobId),
    occurrence_key: dk ? `${dk}:${p.to_user_id}:${p.channel}` : p.source_kind ? `${p.to_user_id}:${p.channel}` : p.template_key,
    idempotency_key: dk ? `dk:${dk}:${p.to_user_id}:${p.channel}` : jobId ? `job:${jobId}:${p.channel}` : null,
  }
}

/** Go's s.Queue.Enqueue(TypeMessageSend, ...) for many recipients: one 'message:send' job each. */
export async function enqueueMessageSends(env: Env, inst: string,
  items: { channel: string; template_key: string; to_user_id: string; vars?: Record<string, unknown>; source_kind?: string; source_id?: string; dedupe_key?: string; student_id?: string }[]): Promise<void> {
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

// ---------------------------------------------------------------------------
// receipts and the ladder's next rung

/** One line of a message's receipt trail. Never throws. */
export async function recordEvent(db: D1Database, inst: string, msgId: string, status: string, provider: string | null, detail: string | null, at: string): Promise<void> {
  try {
    await db.prepare(`INSERT INTO message_events (id, institution_id, message_log_id, status, provider, detail, occurred_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), inst, msgId, status, provider, detail ? trunc(detail, 500) : null, at).run()
  } catch (e) { console.warn('message event not recorded', msgId, status, e) }
}

/**
 * The next rung of a message's ladder, queued as its own row pointing back
 * at this one. Claims the ladder first (sets it NULL), so a push failure and
 * a webhook arriving together queue it once. Returns the new row's id, or
 * null when there was no rung left or none could reach the person.
 */
export async function queueFallback(m: MsgScope, msgId: string, reason: string): Promise<string | null> {
  const { db } = m
  const row = await db.prepare(`SELECT id, template_code, template_vars, user_id, student_id, recipient, source_kind, source_id, occurrence_key,
      ladder, dedup_key, message_type, urgent FROM message_log WHERE id = ?`).bind(msgId)
    .first<{ id: string; template_code: string | null; template_vars: string | null; user_id: string | null; student_id: string | null; recipient: string;
      source_kind: string | null; source_id: string | null; occurrence_key: string | null; ladder: string | null; dedup_key: string | null; message_type: string | null; urgent: number }>()
  if (!row || !row.ladder) return null
  const claim = await db.prepare(`UPDATE message_log SET ladder = NULL WHERE id = ? AND ladder IS NOT NULL`).bind(msgId).run()
  if (!claim.meta.changes) return null
  let rungs: string[] = []
  try { const v = JSON.parse(row.ladder); if (Array.isArray(v)) rungs = v.map(String) } catch { return null }
  let vars: Record<string, unknown> = {}
  try { const v = JSON.parse(row.template_vars ?? 'null'); if (v && typeof v === 'object') vars = v } catch { /* none */ }
  const media = (vars.__media ?? null) as Media | null
  delete vars.__media
  const ms = new Messenger(m)
  const live = await ms.liveChannels()
  const contact: Contact = row.user_id ? (await contactOf(db, row.user_id)) ?? { email: '', phone: '' }
    : { email: looksEmail(row.recipient) ? row.recipient : '', phone: looksEmail(row.recipient) ? '' : row.recipient }
  while (rungs.length) {
    const ch = rungs.shift()!
    const to = ch === 'in_app' ? row.user_id ?? '' : ch === 'email' ? contact.email : phoneOf(contact.phone) ? contact.phone : ''
    if (!to || (ch !== 'in_app' && !live[ch])) continue
    try {
      const res = await ms.insert({ channel: ch, template_code: row.template_code ?? 'messaging.direct', vars, to_user_id: row.user_id, student_id: row.student_id,
        recipient: to, source_kind: row.source_kind, source_id: row.source_id, occurrence_key: row.occurrence_key, media },
      ch, { message_type: row.message_type, ladder: rungs, dedup_key: row.dedup_key, urgent: !!row.urgent, fallback_of: row.id })
      if (res.id) {
        await recordEvent(db, m.inst, row.id, 'fallback', ch, reason, new Date().toISOString())
        await ms.kick()
        return res.id
      }
    } catch (e) {
      console.warn('fallback rung skipped', ch, (e as Error).message)
    }
  }
  return null
}

const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 }

/**
 * A provider's report on one message (WhatsApp status, email webhook, SMS
 * delivery report). Statuses only move forward (sent < delivered < read); a
 * failure after 'sent' marks the row failed and moves the ladder on.
 */
export async function applyStatus(m: MsgScope, msgId: string, status: 'sent' | 'delivered' | 'read' | 'failed', provider: string, detail: string | null, at: string): Promise<boolean> {
  const { db, inst } = m
  const row = await db.prepare(`SELECT status FROM message_log WHERE id = ?`).bind(msgId).first<{ status: string }>()
  if (!row) return false
  await recordEvent(db, inst, msgId, status, provider, detail, at)
  if (status === 'failed') {
    const r = await db.prepare(`UPDATE message_log SET status = 'failed', failed_at = ?, error = COALESCE(?, error) WHERE id = ? AND status IN ('queued','sent')`)
      .bind(at, detail ? trunc(detail, 500) : 'the provider reported the message undelivered', msgId).run()
    if (r.meta.changes) await queueFallback(m, msgId, detail ?? 'undelivered')
    return true
  }
  const lower = Object.keys(RANK).filter((k) => RANK[k] < RANK[status])
  await db.prepare(`UPDATE message_log SET status = ?,
      sent_at = COALESCE(sent_at, ?),
      delivered_at = CASE WHEN ? IN ('delivered','read') THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
      read_at = CASE WHEN ? = 'read' THEN COALESCE(read_at, ?) ELSE read_at END
    WHERE id = ? AND status IN (SELECT value FROM json_each(?))`)
    .bind(status, at, status, at, status, at, msgId, JSON.stringify(lower)).run()
  return true
}
