import type { Env } from '../../env'
import { json } from '../../env'
import { institutionById, tenantDb } from '../../tenant'
import { applyStatus } from '../../services/messaging'

/* Delivery receipts from the providers, on /api/v1/public/webhooks/*. No
   session: each provider proves itself its own way.

     GET  /webhooks/whatsapp          Meta's subscription check (hub.verify_token = WHATSAPP_VERIFY_TOKEN)
     POST /webhooks/whatsapp          status updates, signed X-Hub-Signature-256 with WHATSAPP_APP_SECRET
     POST /webhooks/email             Resend events, signed Svix-style with RESEND_WEBHOOK_SECRET
     GET|POST /webhooks/sms/{school}/{key}   an SMS vendor's delivery report; key = HMAC(SESSION_SECRET, school)

   Every send carries "<school>:<message>" (WhatsApp biz_opaque_callback_data,
   a Resend tag), so a status finds its row without a cross-school search.
   A secret that is not set refuses the webhook (503) rather than trusting
   anything. Answers are 200 for anything well-formed, so a provider never
   retries a report this product cannot use. */

const enc = new TextEncoder()
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const UUIDISH = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const REF = new RegExp(`^(${UUIDISH})[:_](${UUIDISH})$`, 'i')

async function hmac(key: BufferSource, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', k, enc.encode(msg))
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

const secret = (env: Env, name: string) => { const v = env[name]; return typeof v === 'string' ? v.trim() : '' }

/** The key in a school's SMS delivery-report URL. */
export async function smsReportKey(env: Env, inst: string): Promise<string> {
  const s = secret(env, 'SESSION_SECRET')
  if (!s) return ''
  return hex(await hmac(enc.encode(s), 'sms-dlr:' + inst)).slice(0, 32)
}

type Status = 'sent' | 'delivered' | 'read' | 'failed'

async function apply(env: Env, inst: string, msgId: string, status: Status, provider: string, detail: string | null, at: string,
  providerId?: string): Promise<boolean> {
  const row = await institutionById(env, inst).catch(() => null)
  if (!row) return false
  const db = tenantDb(env, row)
  // The row must be the one the provider sent: a ref from elsewhere cannot move another school's message.
  if (providerId) {
    const m = await db.prepare(`SELECT 1 AS x FROM message_log WHERE id = ? AND (provider_msg_id IS NULL OR provider_msg_id = ?)`).bind(msgId, providerId).first()
    if (!m) return false
  }
  return applyStatus({ env, db, inst }, msgId, status, provider, detail, at)
}

// --- WhatsApp Cloud API ------------------------------------------------------

interface WaStatus { id?: string; status?: string; timestamp?: string; biz_opaque_callback_data?: string; errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[] }

export async function whatsappWebhook(env: Env, req: Request, url: URL): Promise<Response> {
  if (req.method === 'GET') {
    const token = secret(env, 'WHATSAPP_VERIFY_TOKEN')
    const q = url.searchParams
    if (token && q.get('hub.mode') === 'subscribe' && safeEqual(q.get('hub.verify_token') ?? '', token)) {
      return new Response(q.get('hub.challenge') ?? '', { headers: { 'content-type': 'text/plain' } })
    }
    return json({ error: 'verification failed' }, 403)
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  const appSecret = secret(env, 'WHATSAPP_APP_SECRET')
  if (!appSecret) return json({ error: 'WhatsApp webhooks are not configured on this server (WHATSAPP_APP_SECRET)' }, 503)
  const body = await req.text()
  const sig = (req.headers.get('x-hub-signature-256') ?? '').replace(/^sha256=/, '')
  const want = hex(await hmac(enc.encode(appSecret), body))
  if (!sig || !safeEqual(sig.toLowerCase(), want)) return json({ error: 'bad signature' }, 401)
  let payload: { entry?: { changes?: { value?: { statuses?: WaStatus[] } }[] }[] }
  try { payload = JSON.parse(body) } catch { return json({ error: 'malformed JSON' }, 400) }
  let applied = 0, unmatched = 0
  for (const e of payload.entry ?? []) for (const ch of e.changes ?? []) for (const st of ch.value?.statuses ?? []) {
    const ref = REF.exec(st.biz_opaque_callback_data ?? '')
    const status = ({ sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' } as Record<string, Status>)[st.status ?? '']
    if (!ref || !status) { unmatched++; continue }
    const at = st.timestamp && /^\d+$/.test(st.timestamp) ? new Date(Number(st.timestamp) * 1000).toISOString() : new Date().toISOString()
    const err = st.errors?.[0]
    const detail = err ? `whatsapp ${err.code ?? ''}: ${err.title ?? err.message ?? ''}${err.error_data?.details ? ' - ' + err.error_data.details : ''}`.trim() : null
    if (await apply(env, ref[1].toLowerCase(), ref[2].toLowerCase(), status, 'whatsapp:cloud', detail, at, st.id)) applied++
    else unmatched++
  }
  return json({ ok: true, applied, unmatched })
}

// --- Resend (Svix-signed) ----------------------------------------------------

export async function emailWebhook(env: Env, req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  const whsec = secret(env, 'RESEND_WEBHOOK_SECRET')
  if (!whsec) return json({ error: 'email webhooks are not configured on this server (RESEND_WEBHOOK_SECRET)' }, 503)
  const body = await req.text()
  const id = req.headers.get('svix-id') ?? '', ts = req.headers.get('svix-timestamp') ?? '', sigs = req.headers.get('svix-signature') ?? ''
  if (!id || !/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return json({ error: 'bad or stale signature headers' }, 401)
  let key: Uint8Array
  try { key = Uint8Array.from(atob(whsec.replace(/^whsec_/, '')), (c) => c.charCodeAt(0)) } catch { return json({ error: 'RESEND_WEBHOOK_SECRET is not a whsec_ secret' }, 503) }
  const want = btoa(String.fromCharCode(...new Uint8Array(await hmac(key, `${id}.${ts}.${body}`))))
  if (!sigs.split(' ').some((s) => safeEqual(s.replace(/^v1,/, ''), want))) return json({ error: 'bad signature' }, 401)
  let ev: { type?: string; created_at?: string; data?: { email_id?: string; tags?: Record<string, string> | { name: string; value: string }[]; bounce?: { message?: string } } }
  try { ev = JSON.parse(body) } catch { return json({ error: 'malformed JSON' }, 400) }
  const tags = ev.data?.tags
  const refRaw = Array.isArray(tags) ? tags.find((t) => t.name === 'ref')?.value : tags?.ref
  const ref = REF.exec(refRaw ?? '')
  const status = ({ 'email.sent': 'sent', 'email.delivered': 'delivered', 'email.opened': 'read', 'email.clicked': 'read',
    'email.bounced': 'failed', 'email.complained': 'failed', 'email.failed': 'failed' } as Record<string, Status>)[ev.type ?? '']
  if (!ref || !status) return json({ ok: true, applied: 0 })
  const detail = status === 'failed' ? `${ev.type}${ev.data?.bounce?.message ? ': ' + ev.data.bounce.message : ''}` : null
  const at = ev.created_at && !Number.isNaN(Date.parse(ev.created_at)) ? new Date(ev.created_at).toISOString() : new Date().toISOString()
  const done = await apply(env, ref[1].toLowerCase(), ref[2].toLowerCase(), status, 'email:resend', detail, at, ev.data?.email_id)
  return json({ ok: true, applied: done ? 1 : 0 })
}

// --- SMS delivery reports (vendor-agnostic) ---------------------------------

const pick = (o: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) { const v = o[k]; if (typeof v === 'string' && v.trim()) return v.trim(); if (typeof v === 'number') return String(v) }
  return ''
}

/** A vendor's status word or code as ours. MSG91: 1 delivered, 2 failed, 9 NDNC, 16 rejected, 17 blocked, 25/26 rejected. */
export function smsStatusOf(raw: string): Status | null {
  const s = raw.trim().toLowerCase()
  if (!s) return null
  if (s === '1' || /^deliv|delivrd|success/.test(s)) return 'delivered'
  if (['2', '9', '16', '17', '25', '26'].includes(s) || /fail|reject|undeliv|expired|invalid|dnd|ndnc|block/.test(s)) return 'failed'
  if (s === '8' || /sent|submit|accept|pending|queued/.test(s)) return 'sent'
  return null
}

export async function smsWebhook(env: Env, req: Request, url: URL, inst: string, key: string): Promise<Response> {
  const want = await smsReportKey(env, inst)
  if (!want) return json({ error: 'SMS delivery reports are not configured on this server (SESSION_SECRET)' }, 503)
  if (!safeEqual(key, want)) return json({ error: 'bad key' }, 401)
  const reports: Record<string, unknown>[] = []
  const q = Object.fromEntries(url.searchParams)
  if (Object.keys(q).length) reports.push(q)
  if (req.method === 'POST') {
    const text = await req.text()
    const ct = req.headers.get('content-type') ?? ''
    if (ct.includes('json') || /^\s*[[{]/.test(text)) {
      try {
        const v = JSON.parse(text) as unknown
        const walk = (x: unknown) => {
          if (Array.isArray(x)) { x.forEach(walk); return }
          if (x && typeof x === 'object') {
            const o = x as Record<string, unknown>
            if (Array.isArray(o.data)) { o.data.forEach(walk); return }
            if (Array.isArray(o.report)) { for (const r of o.report as Record<string, unknown>[]) reports.push({ ...o, ...r }); return }
            reports.push(o)
          }
        }
        walk(v)
      } catch { return json({ error: 'malformed JSON' }, 400) }
    } else if (text.trim()) {
      reports.push(Object.fromEntries(new URLSearchParams(text)))
    }
  }
  const row = await institutionById(env, inst).catch(() => null)
  if (!row) return json({ error: 'no such school' }, 404)
  const db = tenantDb(env, row)
  let applied = 0
  for (const r of reports) {
    const pid = pick(r, ['request_id', 'requestId', 'requestID', 'message_id', 'messageId', 'msgid', 'id'])
    const status = smsStatusOf(pick(r, ['status', 'Status', 'report_status', 'desc', 'deliveryStatus']))
    if (!pid || !status) continue
    const m = await db.prepare(`SELECT id FROM message_log WHERE provider_msg_id = ? AND channel = 'sms' ORDER BY queued_at DESC LIMIT 1`).bind(pid).first<{ id: string }>()
    if (!m) continue
    const detail = status === 'failed' ? `sms: ${pick(r, ['status', 'Status', 'desc', 'reason', 'error']) || 'undelivered'}` : null
    if (await applyStatus({ env, db, inst }, m.id, status, 'sms', detail, new Date().toISOString())) applied++
  }
  return json({ ok: true, applied })
}

const SMS_PATH = new RegExp(`^/api/v1/public/webhooks/sms/(${UUIDISH})/([0-9a-f]{32})$`, 'i')

/** /api/v1/public/webhooks/*; null for anything else. */
export async function handleMessageWebhooks(env: Env, req: Request, url: URL, p: string): Promise<Response | null> {
  if (!p.startsWith('/api/v1/public/webhooks/')) return null
  try {
    if (p === '/api/v1/public/webhooks/whatsapp') return await whatsappWebhook(env, req, url)
    if (p === '/api/v1/public/webhooks/email') return await emailWebhook(env, req)
    const sms = SMS_PATH.exec(p)
    if (sms && (req.method === 'GET' || req.method === 'POST')) return await smsWebhook(env, req, url, sms[1].toLowerCase(), sms[2].toLowerCase())
  } catch (err) {
    console.error('message webhook', p, err)
    return json({ error: 'internal error' }, 500)
  }
  return json({ error: 'not found' }, 404)
}
