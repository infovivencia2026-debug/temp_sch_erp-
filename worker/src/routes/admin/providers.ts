import type { Ctx } from '../../router'
import { forbidden } from '../../http'
import { parseJSON } from './common'

/* The messaging provider registry of internal/api/messaging.go, as far as a
   screen needs it: which channels can send and, when one cannot, why. No
   provider here sends anything (rule 7); Send lives only in the Go server.

   Credentials are sealed exactly as sealSecret sealed them - AES-256-GCM
   under SHA-256(CREDENTIAL_KEY), stored as nonce || ciphertext || tag - so a
   row written by either server opens in the other. */

export const CHANNELS = ['email', 'sms', 'whatsapp', 'in_app'] as const
export const knownChannel = (c: unknown): c is string => typeof c === 'string' && (CHANNELS as readonly string[]).includes(c)
export const CHANNEL_LABELS: Record<string, string> = { email: 'Email (SMTP)', sms: 'SMS gateway', whatsapp: 'WhatsApp Business', in_app: 'In-app notifications' }

/** `to_char(x AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'` over a stored ISO timestamp. */
export const isoZ = (col: string) => `CASE WHEN ${col} IS NULL THEN NULL ELSE replace(substr(${col},1,19),' ','T') || 'Z' END`

async function aesKey(c: Ctx, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey | null> {
  const key = c.env.CREDENTIAL_KEY
  if (typeof key !== 'string' || key.trim() === '') return null
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage])
}

/** sealSecret. A missing key is a 403 with the Go server's sentence: never store a password in clear. */
export async function sealSecret(c: Ctx, plain: string): Promise<Uint8Array> {
  const k = await aesKey(c, 'encrypt')
  if (!k) throw forbidden('CREDENTIAL_KEY is not set. Refusing to store a password in clear')
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, new TextEncoder().encode(plain)))
  const out = new Uint8Array(nonce.length + sealed.length)
  out.set(nonce, 0); out.set(sealed, nonce.length)
  return out
}

/** openSecret. Throws an Error whose message is the reason a provider reads as unconfigured. */
export async function openSecret(c: Ctx, sealed: ArrayBuffer | Uint8Array | number[] | null): Promise<string> {
  if (!sealed) return ''
  const bytes = sealed instanceof Uint8Array ? sealed : new Uint8Array(sealed as ArrayBuffer | number[])
  if (bytes.length === 0) return ''
  const k = await aesKey(c, 'decrypt')
  if (!k) throw new Error('CREDENTIAL_KEY is not set')
  if (bytes.length < 12) throw new Error('stored credential is truncated')
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, k, bytes.slice(12)))
  } catch { throw new Error('stored credential will not decrypt, CREDENTIAL_KEY may have changed') }
}

export interface ProviderState { name: string; configured: boolean; why: string }
const unconfigured = (ch: string, why: string): ProviderState => ({ name: ch + ':unconfigured', configured: false, why })
const ready = (name: string, why: string): ProviderState => ({ name, configured: why === '', why })

function hostOf(raw: string): string { try { return new URL(raw).hostname } catch { return '' } }
const str = (v: unknown) => (typeof v === 'string' ? v : '')

function gateway(ch: string, cfg: Record<string, unknown>, secret: string): ProviderState {
  const endpoint = str(cfg.endpoint), h = hostOf(endpoint)
  let why = ''
  if (endpoint.trim() === '') why = 'no gateway endpoint set. Blocked on a vendor account'
  else if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) why = 'gateway endpoint must be an http or https URL'
  else if (secret === '' && str(cfg.auth_header).trim() === '') why = 'no API key stored. Blocked on a vendor account'
  return ready(h ? `${ch}:${h}` : ch, why)
}

/** buildProvider: one stored row to a provider's name and readiness. */
export function buildProvider(ch: string, rawCfg: string | null, secret: string): ProviderState {
  let cfg: Record<string, unknown> = {}
  if (rawCfg && rawCfg !== '') {
    try { const v = JSON.parse(rawCfg); if (v && typeof v === 'object' && !Array.isArray(v)) cfg = v as Record<string, unknown>; else throw new Error() }
    catch { return unconfigured(ch, 'stored settings are not readable') }
  }
  if (ch === 'email') {
    let why = ''
    if (str(cfg.host).trim() === '') why = 'no SMTP host set'
    else if (!(Number(cfg.port) > 0)) why = 'no SMTP port set'
    else if (str(cfg.from_address).trim() === '') why = 'no From address set. A message with no sender is rejected by every recipient'
    return ready('smtp', why)
  }
  if (ch === 'whatsapp') {
    const pn = str(cfg.phone_number_id).trim()
    if (pn !== '') {
      let why = ''
      if (!/^[0-9]+$/.test(pn)) why = 'the WhatsApp phone number id must be the numeric id, not the phone number'
      else if (secret.trim() === '') why = 'no access token stored. Paste a long-lived System User token'
      return ready('whatsapp:cloud', why)
    }
    return gateway(ch, cfg, secret)
  }
  if (ch === 'sms') return gateway(ch, cfg, secret)
  if (ch === 'in_app') return ready('in_app', '')
  return unconfigured(ch, 'unknown channel')
}

function humanSilence(ms: number): string {
  const min = ms / 60_000, h = ms / 3_600_000
  if (min < 2) return 'a minute'
  if (min < 60) return `${Math.trunc(min)} minutes`
  if (h < 2) return 'an hour'
  if (h < 48) return `${Math.trunc(h)} hours`
  return `${Math.trunc(Math.trunc(h) / 24)} days`
}

/** smsGatewayReason in sms_gateway.go. */
async function phoneGateway(c: Ctx): Promise<ProviderState> {
  const r = await c.db.prepare(`SELECT count(*) AS paired, sum(CASE WHEN paused = 0 THEN 1 ELSE 0 END) AS active,
      max(CASE WHEN paused = 0 THEN last_seen_at END) AS last_seen FROM sms_gateway_devices WHERE revoked_at IS NULL`)
    .first<{ paired: number; active: number | null; last_seen: string | null }>()
  let why = ''
  if (!r || Number(r.paired) === 0) why = 'no phone is paired. Pair the office handset to start sending SMS'
  else if (Number(r.active ?? 0) === 0) why = 'every paired phone is paused. Switch one back on to start sending'
  else if (!r.last_seen) why = 'the paired phone has never reported in. Open the gateway app on the handset'
  else {
    const silent = Date.now() - Date.parse(r.last_seen)
    if (silent > 15 * 60_000) why = 'the office phone has not reported in for ' + humanSilence(silent)
  }
  return { name: 'sms:phone', configured: why === '', why }
}

export interface IntegrationRow { provider: string; config: string | null; credentials: ArrayBuffer | null; enabled: number; last_ok_at: string | null; last_error: string | null }

/** The school's messaging rows in integrations. */
export async function integrationRows(c: Ctx): Promise<IntegrationRow[]> {
  return (await c.db.prepare(`SELECT provider, config, credentials, enabled, ${isoZ('last_ok_at')} AS last_ok_at, last_error
      FROM integrations WHERE institution_id IS NOT NULL AND kind = 'messaging'`).all<IntegrationRow>()).results
}

/** loadProviders: every channel, configured or not, with the sentence for why not. */
export async function loadProviders(c: Ctx, rows?: IntegrationRow[]): Promise<Record<string, ProviderState>> {
  const stored = new Map((rows ?? await integrationRows(c)).map((r) => [r.provider, r]))
  const set: Record<string, ProviderState> = { in_app: ready('in_app', '') }
  for (const ch of ['email', 'sms', 'whatsapp']) {
    const row = stored.get(ch)
    if (!row) { set[ch] = unconfigured(ch, ch === 'email' ? 'not set up yet' : 'not set up. Awaiting a vendor account and its credentials'); continue }
    if (!row.enabled) { set[ch] = unconfigured(ch, 'configured but switched off'); continue }
    if (ch === 'sms' && String(parseJSON<Record<string, unknown>>(row.config, {}).kind ?? '').trim().toLowerCase() === 'phone') {
      set[ch] = await phoneGateway(c); continue
    }
    let secret: string
    try { secret = await openSecret(c, row.credentials) } catch (e) { set[ch] = unconfigured(ch, (e as Error).message); continue }
    set[ch] = buildProvider(ch, row.config, secret)
  }
  return set
}
