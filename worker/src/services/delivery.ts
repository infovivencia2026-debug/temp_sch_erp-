import type { Env } from '../env'
import { pushConfigured } from './push'
import { loadProviders, platformProviders, routeFor, creditBalanceOf, type ProviderSet } from './messaging'
import { normalisePhone } from '../routes/admin/msg_guard'

/* Delivery policy: which channel a message leaves by, when, and whether at
   all. services/messaging.ts calls in here from Messenger.queue (the one
   place every send passes) and from dispatch; nothing else needs to know.

   THE LADDER. Each message type has a list of channels, cheapest first. The
   first rung that can reach the person is used; if it fails (or, for in-app,
   the person has no phone with the app to push to), the next rung is queued
   as a fallback row that points back at the first (message_log.fallback_of).
   SMS is the last rung everywhere except OTP, where it is the only one.

   NO SPAM. The same alert to the same person inside the school's window is
   dropped (message_log.dedup_key). Non-urgent types can be set to 'digest':
   they wait in message_digest_items and go as one message a day at the
   school's time. Quiet hours hold non-urgent messages until the morning. A
   per-recipient daily cap sends anything over it to the next digest.
   Urgent types (absence, emergencies, fee due today, the bus) ignore all
   three.

   HONEST STATUS. channelStatus() says a channel is live only when its
   provider is configured and, where it is metered, has credit. */

// ---------------------------------------------------------------------------
// message types

export interface MessageType {
  key: string
  label: string
  urgent: boolean
  ladder: string[]
  mode: 'instant' | 'digest'
  /** May a school put this type in the digest? Urgent ones may not. */
  digestible: boolean
  example: string
}

export const LADDER_CHANNELS = ['in_app', 'whatsapp', 'sms', 'email'] as const

export const MESSAGE_TYPES: MessageType[] = [
  { key: 'otp', label: 'One-time codes', urgent: true, ladder: ['sms'], mode: 'instant', digestible: false, example: 'sign-in and verification codes' },
  { key: 'absence', label: 'Absence alerts', urgent: true, ladder: ['in_app', 'whatsapp', 'sms'], mode: 'instant', digestible: false, example: 'your child was marked absent' },
  { key: 'emergency', label: 'Emergencies', urgent: true, ladder: ['in_app', 'whatsapp', 'sms'], mode: 'instant', digestible: false, example: 'school closed today, early dismissal' },
  { key: 'fee_due_today', label: 'Fee due today', urgent: true, ladder: ['in_app', 'whatsapp', 'sms'], mode: 'instant', digestible: false, example: 'a fee falls due today' },
  { key: 'transport', label: 'School bus', urgent: true, ladder: ['in_app'], mode: 'instant', digestible: false, example: 'the bus has started, is near your stop' },
  { key: 'fees', label: 'Fee reminders', urgent: false, ladder: ['in_app', 'whatsapp', 'sms'], mode: 'instant', digestible: true, example: 'an invoice is overdue' },
  { key: 'notice', label: 'Notices and circulars', urgent: false, ladder: ['in_app', 'whatsapp', 'sms'], mode: 'digest', digestible: true, example: 'a circular was published' },
  { key: 'homework', label: 'Homework', urgent: false, ladder: ['in_app', 'whatsapp', 'sms'], mode: 'digest', digestible: true, example: 'homework was set' },
  { key: 'marks', label: 'Marks and remarks', urgent: false, ladder: ['in_app', 'whatsapp', 'sms'], mode: 'digest', digestible: true, example: 'a report card or a remark' },
  { key: 'meetings', label: 'Meetings', urgent: false, ladder: ['in_app', 'whatsapp', 'sms'], mode: 'instant', digestible: true, example: 'a parent-teacher meeting reminder' },
  { key: 'documents', label: 'Receipts, reports and payslips', urgent: false, ladder: ['email', 'in_app'], mode: 'instant', digestible: false, example: 'anything with an attachment' },
  { key: 'admissions', label: 'Admissions', urgent: false, ladder: ['email', 'whatsapp', 'sms'], mode: 'instant', digestible: false, example: 'an applicant’s status changed' },
  { key: 'digest', label: 'The daily digest itself', urgent: false, ladder: ['in_app', 'whatsapp', 'sms'], mode: 'instant', digestible: false, example: 'one message bundling the day’s notices' },
  { key: 'other', label: 'Everything else', urgent: false, ladder: ['in_app', 'whatsapp', 'sms'], mode: 'instant', digestible: true, example: 'any other alert' },
]
const TYPE_BY_KEY = new Map(MESSAGE_TYPES.map((t) => [t.key, t]))
export const messageType = (key: string) => TYPE_BY_KEY.get(key) ?? TYPE_BY_KEY.get('other')!

/** Codes that never go through the ladder: the platform's own, tests and
    one-to-one sends where the person chose the channel. */
const EXPLICIT = /^(credits\.|messaging\.|password_reset$|report_digest\.)/

/** The message type of a template code, or null when the channel the
    caller named is final. */
export function messageTypeOf(code: string): string | null {
  const c = (code ?? '').trim().toLowerCase()
  if (c === '' || EXPLICIT.test(c)) return null
  if (/(^|\.)otp|login_code|verify_code/.test(c)) return 'otp'
  if (c.startsWith('digest.')) return 'digest'
  if (c.startsWith('attendance.') || c.startsWith('absen')) return 'absence'
  if (c.startsWith('emergency') || c.startsWith('alert.emergency')) return 'emergency'
  if (/^fees?\.due_today/.test(c)) return 'fee_due_today'
  if (c.startsWith('transport.')) return 'transport'
  if (/^(fees?|invoice)\./.test(c)) return 'fees'
  if (c.startsWith('announcement') || c.startsWith('circular') || c.startsWith('notice')) return 'notice'
  if (c.startsWith('homework') || c.startsWith('diary')) return 'homework'
  if (/^(reportcard|report_card|result|marks|exam|student\.remark)/.test(c)) return 'marks'
  if (c.startsWith('ptm') || c.startsWith('meeting')) return 'meetings'
  if (/^(payroll\.|receipt|fees?\.receipt|report\.)/.test(c)) return 'documents'
  if (c.startsWith('admissions.') || c.startsWith('enquiry')) return 'admissions'
  return 'other'
}

// ---------------------------------------------------------------------------
// settings and policies

export interface DeliverySettings {
  digest_time: string
  quiet_from: string | null
  quiet_to: string | null
  daily_cap: number
  dedup_minutes: number
}
export const DEFAULT_SETTINGS: DeliverySettings = { digest_time: '18:00', quiet_from: '21:00', quiet_to: '07:00', daily_cap: 6, dedup_minutes: 360 }

export async function loadSettings(db: D1Database): Promise<DeliverySettings> {
  const r = await db.prepare(`SELECT digest_time, quiet_from, quiet_to, daily_cap, dedup_minutes FROM message_settings LIMIT 1`)
    .first<DeliverySettings>().catch(() => null)
  if (!r) return { ...DEFAULT_SETTINGS }
  return { digest_time: r.digest_time || DEFAULT_SETTINGS.digest_time, quiet_from: r.quiet_from ?? null, quiet_to: r.quiet_to ?? null,
    daily_cap: Number(r.daily_cap ?? DEFAULT_SETTINGS.daily_cap), dedup_minutes: Number(r.dedup_minutes ?? DEFAULT_SETTINGS.dedup_minutes) }
}

export interface Policy { ladder: string[]; mode: 'instant' | 'digest' }

export async function loadPolicies(db: D1Database): Promise<Record<string, Policy>> {
  const out: Record<string, Policy> = {}
  for (const t of MESSAGE_TYPES) out[t.key] = { ladder: [...t.ladder], mode: t.mode }
  const rows = (await db.prepare(`SELECT message_type, ladder, mode FROM message_policies`).all<{ message_type: string; ladder: string; mode: string }>()
    .catch(() => ({ results: [] as { message_type: string; ladder: string; mode: string }[] }))).results
  for (const r of rows) {
    const t = TYPE_BY_KEY.get(r.message_type)
    if (!t) continue
    const ladder = cleanLadder(r.ladder)
    out[t.key] = { ladder: ladder.length ? ladder : [...t.ladder], mode: r.mode === 'digest' && t.digestible ? 'digest' : 'instant' }
  }
  return out
}

/** A stored or submitted ladder: known channels, each once. */
export function cleanLadder(raw: unknown): string[] {
  let v: unknown = raw
  if (typeof raw === 'string') { try { v = JSON.parse(raw) } catch { return [] } }
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) if (typeof x === 'string' && (LADDER_CHANNELS as readonly string[]).includes(x) && !out.includes(x)) out.push(x)
  return out
}

export function validClock(s: unknown): boolean {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s)
}

// ---------------------------------------------------------------------------
// time (the product's schedules are IST, as message_rules.ts)

const IST_MS = 330 * 60_000
const clockMins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))

/** If `at` falls inside quiet hours, the end of them; else `at`. */
export function afterQuietHours(at: number, from: string | null, to: string | null): number {
  if (!validClock(from) || !validClock(to) || from === to) return at
  const f = clockMins(from!), t = clockMins(to!)
  const w = new Date(at + IST_MS)
  const mins = w.getUTCHours() * 60 + w.getUTCMinutes()
  const inside = f < t ? mins >= f && mins < t : mins >= f || mins < t
  if (!inside) return at
  let out = Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), Math.trunc(t / 60), t % 60) - IST_MS
  if (out <= at) out += 86_400_000
  return out
}

/** Start of the IST day holding `at`, as epoch ms. */
export function istDayStart(at: number): number {
  const w = new Date(at + IST_MS)
  return Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) - IST_MS
}

/** The digest moment of the IST day holding `at`. */
export function digestMoment(at: number, digestTime: string): number {
  return istDayStart(at) + clockMins(validClock(digestTime) ? digestTime : DEFAULT_SETTINGS.digest_time) * 60_000
}

// ---------------------------------------------------------------------------
// dedup

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  const o = v as Record<string, unknown>
  return '{' + Object.keys(o).sort().filter((k) => !k.startsWith('__')).map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}'
}

export async function dedupKeyOf(inst: string, code: string, who: string, student: string | null | undefined, vars: Record<string, unknown> | undefined): Promise<string> {
  const text = [inst, code, who.toLowerCase(), student ?? '', stable(vars ?? {})].join('|')
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...d.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Was this alert already queued to this person inside the window (and not a failure)? */
export async function isDuplicate(db: D1Database, key: string, minutes: number): Promise<boolean> {
  if (minutes <= 0) return false
  const since = new Date(Date.now() - minutes * 60_000).toISOString()
  const hit = await db.prepare(`SELECT 1 AS x FROM message_log WHERE dedup_key = ? AND queued_at > ? AND status NOT IN ('failed','suppressed') LIMIT 1`)
    .bind(key, since).first()
  if (hit) return true
  const held = await db.prepare(`SELECT 1 AS x FROM message_digest_items WHERE dedup_key = ? AND created_at > ? LIMIT 1`).bind(key, since).first()
  return !!held
}

/** Outbound messages already queued to this person today (IST), first rungs only. */
export async function sentToday(db: D1Database, userId: string | null, recipient: string): Promise<number> {
  const since = new Date(istDayStart(Date.now())).toISOString()
  const r = await db.prepare(`SELECT count(*) AS n FROM message_log WHERE queued_at >= ? AND fallback_of IS NULL AND urgent = 0
      AND COALESCE(message_type, '') NOT IN ('', 'digest') AND ((? IS NOT NULL AND user_id = ?) OR recipient = ?)`)
    .bind(since, userId, userId, recipient).first<{ n: number }>()
  return Number(r?.n ?? 0)
}

// ---------------------------------------------------------------------------
// honest channel status

/** Estimated price of one send, in paise. Override with the Worker variable
    MESSAGE_PRICES_PAISE, e.g. {"sms":25,"whatsapp":13,"email":0}. */
export const DEFAULT_PRICES_PAISE: Record<string, number> = { in_app: 0, push: 0, email: 0, whatsapp: 13, sms: 25 }

export function pricesOf(env: Env): Record<string, number> {
  const out = { ...DEFAULT_PRICES_PAISE }
  const raw = env.MESSAGE_PRICES_PAISE
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const v = JSON.parse(raw) as Record<string, unknown>
      for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && n >= 0) out[k] = n
    } catch { /* keep defaults */ }
  }
  return out
}

export interface ChannelHealth {
  channel: string
  label: string
  /** live | not_configured | no_credit | off */
  state: 'live' | 'not_configured' | 'no_credit' | 'off'
  live: boolean
  reason: string
  route: string
  provider: string
  /** null when the channel is not metered. */
  credits: number | null
  cost_paise: number
}

const LABELS: Record<string, string> = { in_app: 'In-app', push: 'Push (app notifications)', whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' }

/** Per channel: is it really live? Provider configured, and credit where metered. */
export async function channelStatus(env: Env, db: D1Database, inst: string): Promise<ChannelHealth[]> {
  const prices = pricesOf(env)
  const out: ChannelHealth[] = [
    { channel: 'in_app', label: LABELS.in_app, state: 'live', live: true, reason: '', route: 'own', provider: 'in_app', credits: null, cost_paise: 0 },
  ]
  const push = pushConfigured(env)
  out.push({ channel: 'push', label: LABELS.push, state: push ? 'live' : 'not_configured', live: push,
    reason: push ? '' : 'the Firebase service account (FCM_SERVICE_ACCOUNT) is not set on the server, so the apps get no notifications; messages wait in the in-app bell',
    route: 'own', provider: push ? 'fcm' : '', credits: null, cost_paise: 0 })
  let school: ProviderSet | null = null, platform: ProviderSet | null = null
  for (const ch of ['whatsapp', 'sms', 'email']) {
    const route = await routeFor(env, db, inst, ch).catch(() => 'edu_cloud')
    let set: ProviderSet
    try {
      set = route === 'edu_cloud' ? (platform ??= await platformProviders(env, db)) : (school ??= await loadProviders(env, db, inst))
    } catch (e) {
      out.push({ channel: ch, label: LABELS[ch], state: 'not_configured', live: false, reason: 'provider settings unreadable: ' + (e as Error).message,
        route, provider: '', credits: null, cost_paise: prices[ch] ?? 0 })
      continue
    }
    const p = set[ch]
    const [bal, metered] = await creditBalanceOf(db, ch, route)
    let state: ChannelHealth['state'] = 'live', reason = ''
    if (!p || !p.configured) {
      state = p?.why === 'configured but switched off' ? 'off' : 'not_configured'
      reason = route === 'edu_cloud'
        ? `sent through the platform, whose ${LABELS[ch]} account is not set up yet${p?.why ? ` (${p.why})` : ''}`
        : (p?.why || 'not set up')
    } else if (metered && bal <= 0) {
      state = 'no_credit'
      reason = `no ${LABELS[ch]} credit left; messages on this channel are held until credit is added`
    }
    out.push({ channel: ch, label: LABELS[ch], state, live: state === 'live', reason, route, provider: p?.name ?? '',
      credits: metered ? bal : null, cost_paise: prices[ch] ?? 0 })
  }
  return out
}

export const liveMap = (h: ChannelHealth[]) => Object.fromEntries(h.map((x) => [x.channel, x.live])) as Record<string, boolean>

/** A phone number this product can send to, or ''. */
export const phoneOf = (v: string | null | undefined) => (v ? normalisePhone(v) : '')
export const looksEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim())
