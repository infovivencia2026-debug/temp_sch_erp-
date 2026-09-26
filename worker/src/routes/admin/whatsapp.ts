import type { Router, Ctx } from '../../router'
import { explainMetaError, loadProviders as loadSendingProviders, renderTemplate, whatsappSendFor } from '../../services/messaging'
import { HttpError, badRequest, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { institutionId, parseJSON, requireAny } from './common'
import { isoZ, loadProviders, openSecret, sealSecret } from './providers'
import { upsertIntegration } from './messaging'
import { BUILTIN_TEMPLATES, templatePlaceholders } from './msg_templates'
import { loadGuard, normalisePhone, permits } from './msg_guard'

/* /admin/whatsapp and the recipient guard under /admin/messaging, from
   internal/api/whatsapp.go, whatsapp_submit.go and message_test_link.go.

   POST /admin/whatsapp/test sends through services/messaging. The two
   template submissions call Graph's /{waba}/message_templates with the
   school's sealed token, exactly as whatsapp_submit.go did. */

const READ = 'institution.read'
const CREDS = 'institution.integrations.write'
const CONFIG = 'institution.settings.write'
const SEND = 'comms.messages.send'
const AUDIT = 'admin.audit.read'
const WA_DEFAULT_VERSION = 'v21.0'
type Row = Record<string, unknown>
const u = <T>(v: T | null | undefined) => (v === null || v === undefined ? undefined : v)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

async function readSettings(c: Ctx): Promise<Record<string, unknown>> {
  const v: Record<string, unknown> = { phone_number_id: '', waba_id: '', business_number: '', api_version: '', default_language: '', allow_free_text: false,
    enabled: false, has_token: false, configured: false, reason: undefined, endpoint: '', mode: 'none', last_ok_at: undefined, last_error: undefined,
    queued: 0, sent_today: 0, failed_today: 0, suppressed_today: 0 }
  const row = await c.db.prepare(`SELECT config, enabled, credentials, ${isoZ('last_ok_at')} AS last_ok_at, last_error FROM integrations
      WHERE institution_id IS NOT NULL AND provider = 'whatsapp' AND kind = 'messaging'`).first<{ config: string | null; enabled: number; credentials: ArrayLike<number> | null; last_ok_at: string | null; last_error: string | null }>()
  if (row) {
    const st = parseJSON<Record<string, unknown>>(row.config, {})
    Object.assign(v, { enabled: !!row.enabled, has_token: !!row.credentials && row.credentials.length > 0, last_ok_at: u(row.last_ok_at), last_error: u(row.last_error),
      phone_number_id: str(st.phone_number_id), waba_id: str(st.waba_id), business_number: str(st.business_number), api_version: str(st.api_version),
      default_language: str(st.default_language), allow_free_text: st.allow_free_text === true })
    if (str(st.phone_number_id).trim() !== '') {
      v.mode = 'cloud'
      v.endpoint = `https://graph.facebook.com/${str(st.api_version).trim() || WA_DEFAULT_VERSION}/${str(st.phone_number_id).trim()}/messages`
    } else v.mode = 'gateway'
  }
  if (v.api_version === '') v.api_version = WA_DEFAULT_VERSION
  const p = (await loadProviders(c)).whatsapp
  if (p) { v.configured = p.configured; v.reason = p.why || undefined }
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString()
  const k = await c.db.prepare(`SELECT sum(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS q,
      sum(CASE WHEN status IN ('sent','delivered','read') AND sent_at > ?1 THEN 1 ELSE 0 END) AS s,
      sum(CASE WHEN status = 'failed' AND queued_at > ?1 THEN 1 ELSE 0 END) AS f,
      sum(CASE WHEN status = 'suppressed' AND queued_at > ?1 THEN 1 ELSE 0 END) AS x
    FROM message_log WHERE channel = 'whatsapp'`).bind(since).first<{ q: number | null; s: number | null; f: number | null; x: number | null }>()
  Object.assign(v, { queued: Number(k?.q ?? 0), sent_today: Number(k?.s ?? 0), failed_today: Number(k?.f ?? 0), suppressed_today: Number(k?.x ?? 0) })
  return v
}

async function listTemplates(c: Ctx): Promise<Response> {
  const rows = await c.db.prepare(`SELECT code, body, wa_template_name, wa_language, wa_params, is_active FROM message_templates
      WHERE channel = 'whatsapp' ORDER BY code`).all<Row>()
  const seen = new Set<string>()
  const items = rows.results.map((v) => {
    seen.add(String(v.code))
    const params = parseJSON<unknown>(v.wa_params, [])
    const name = str(v.wa_template_name)
    return { code: String(v.code), body: String(v.body), placeholders: templatePlaceholders(String(v.body)), wa_template_name: name, wa_language: str(v.wa_language),
      wa_params: Array.isArray(params) ? params : [], is_active: !!v.is_active, built_in: false, mapped: name.trim() !== '' }
  })
  for (const [code, t] of Object.entries(BUILTIN_TEMPLATES)) {
    if (seen.has(code)) continue
    items.push({ code, body: t.body, placeholders: templatePlaceholders(t.body), wa_template_name: '', wa_language: '', wa_params: [], is_active: true, built_in: true, mapped: false })
  }
  items.sort((a, b) => (a.mapped === b.mapped ? (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) : a.mapped ? 1 : -1))
  return ok({ items })
}

async function readPolicy(c: Ctx): Promise<Record<string, unknown>> {
  const p = await c.db.prepare(`SELECT mode, note, ${isoZ('updated_at')} AS updated_at FROM messaging_recipient_policy`).first<{ mode: string; note: string | null; updated_at: string | null }>()
  const items = (await c.db.prepare(`SELECT id, kind, raw, normalised, COALESCE(label,'') AS label, ${isoZ('created_at')} AS created_at
      FROM messaging_allowed_recipients ORDER BY kind, normalised`).all<Row>()).results
  const mode = p?.mode ?? 'everyone'
  let sending: boolean, explanation: string
  if (mode === 'everyone') { sending = true; explanation = 'Live. Every parent, guardian and member of staff this school messages will receive it.' }
  else if (items.length === 0) {
    sending = false
    explanation = 'Nothing is being sent to anybody. This school is in allowlist mode and the list is empty. Every outbound message on every channel is being recorded as suppressed instead of sent.'
  } else {
    sending = false
    explanation = `Allowlist mode. Only the ${items.length} recipient(s) below are being messaged, on every channel. Everything else is recorded as suppressed.`
  }
  return { mode, note: p?.note ?? '', items, sending, explanation, updated_at: u(p?.updated_at) }
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)))
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/* whatsapp_submit.go: buildSubmission / waExample / createMetaTemplate. */
const WA_PLACEHOLDER = /\{\{([a-z_][a-z0-9_]*)\}\}/g
const WA_CATEGORIES: Record<string, string> = {}
for (const k of ['attendance.absent', 'fees.overdue', 'homework.set', 'ptm.reminder', 'reportcard.published', 'payroll.payslip', 'student.remark',
  'announcement.published', 'messaging.direct', 'messaging.test', 'admissions.enquiry_link', 'admissions.portal_login', 'admissions.portal_existing',
  'admissions.portal_ready', 'admissions.applicant_ready', 'admissions.application_received']) WA_CATEGORIES[k] = 'UTILITY'
interface WaSubmission { name: string; body: string; params: string[]; examples: string[]; category: string }
interface WaSubmitResult { code: string; name: string; status: string; category?: string; error?: string }

function waExample(name: string): string {
  switch (name) {
    case 'student_name': return 'Ananya Reddy'
    case 'parent_name': return 'Sir/Madam'
    case 'school_name': return 'Vivencia High School'
    case 'on_date': case 'due_on': return '12 August 2026'
    case 'amount_due': return 'Rs 4,500'
    case 'invoice_no': return 'INV-2026-0142'
    case 'apply_url': return 'https://school.example/admissions/apply/2026'
    case 'title': return 'Holiday on Friday'
    case 'body': case 'message': return 'The school will remain closed.'
    default: return 'Vivencia High School'
  }
}

export function buildSubmission(code: string, body: string): WaSubmission {
  const seen = new Map<string, number>(), order: string[] = []
  let out = body.replace(WA_PLACEHOLDER, (_m, name: string) => {
    const n = seen.get(name)
    if (n !== undefined) return `{{${n}}}`
    order.push(name)
    seen.set(name, order.length)
    return `{{${order.length}}}`
  })
  // Go's strings.TrimSpace trims Unicode whitespace; JS trim() is equivalent for practical input.
  if (out.trim().endsWith('}}')) out = out.trim() + '.'
  if (out.trim().startsWith('{{')) out = 'Notice: ' + out.trim()
  return { name: code.split('.').join('_'), body: out, params: order, examples: order.map(waExample), category: WA_CATEGORIES[code] || 'UTILITY' }
}

async function createMetaTemplate(version: string, wabaID: string, token: string, lang: string, sub: WaSubmission): Promise<string> {
  const component: Record<string, unknown> = { type: 'BODY', text: sub.body }
  if (sub.examples.length > 0) component.example = { body_text: [sub.examples] }
  const payload = { name: sub.name, language: lang, category: sub.category, components: [component] }
  let res: Response
  try {
    res = await fetch(`https://graph.facebook.com/${version}/${wabaID}/message_templates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000),
    })
  } catch (e) { throw new Error('could not reach graph.facebook.com: ' + (e as Error).message) }
  const answer = (await res.text()).slice(0, 8192)
  if (res.status >= 300) {
    if (answer.includes('already exists') || answer.includes('duplicate')) return 'ALREADY_SUBMITTED'
    throw explainMetaError(res.status, answer)
  }
  try {
    const v = JSON.parse(answer) as { status?: unknown }
    if (typeof v.status === 'string' && v.status.trim() !== '') return v.status
  } catch { /* PENDING below */ }
  return 'PENDING'
}

export function registerWhatsApp(r: Router): void {
  r.get('/admin/whatsapp/settings', READ, async (c) => ok(await readSettings(c)))

  r.put('/admin/whatsapp/settings', CREDS, async (c) => {
    const req = await readJSON<{ phone_number_id?: string; waba_id?: string; business_number?: string; api_version?: string; default_language?: string;
      allow_free_text?: boolean; enabled?: boolean; token?: string | null }>(c.req)
    const st = { phone_number_id: str(req.phone_number_id).trim(), waba_id: str(req.waba_id).trim(), business_number: str(req.business_number).trim(),
      api_version: str(req.api_version).trim(), default_language: str(req.default_language).trim(), allow_free_text: !!req.allow_free_text }
    if (st.phone_number_id === '' || !/^[0-9]+$/.test(st.phone_number_id)) throw badRequest('the phone number id is the numeric id from WhatsApp Manager, not the phone number')
    if (st.api_version !== '' && !/^v[0-9]+\.[0-9]+$/.test(st.api_version)) throw badRequest('the API version looks like v21.0')
    if (st.default_language !== '' && !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(st.default_language)) throw badRequest('the language code looks like en, en_US or te')
    if (st.business_number !== '' && normalisePhone(st.business_number) === '') throw badRequest('the business number is not a phone number this can read')
    const sealed = typeof req.token === 'string' && req.token.trim() !== '' ? await sealSecret(c, req.token.trim()) : null
    await upsertIntegration(c, 'whatsapp', JSON.stringify(st), sealed, !!req.enabled)
    return ok(await readSettings(c))
  })

  r.del('/admin/whatsapp/settings', CREDS, async (c) => {
    await c.db.prepare(`DELETE FROM integrations WHERE institution_id IS NOT NULL AND provider = 'whatsapp' AND kind = 'messaging'`).run()
    return ok(await readSettings(c))
  })

  r.post('/admin/whatsapp/test', SEND, async (c) => {
    const req = await readJSON<{ to?: string; template_code?: string }>(c.req)
    const to = str(req.to).trim()
    if (to === '') throw badRequest('a number to test against is required')
    const code = str(req.template_code).trim()
    const inst = institutionId(c)
    const p = (await loadSendingProviders(c.env, c.db, inst)).whatsapp
    const [allowed, why] = permits(await loadGuard(c), 'whatsapp', to)
    if (!allowed) throw new HttpError(409, why, { code: 'not_on_allowlist' })
    const school = (await c.db.prepare(`SELECT name FROM institutions WHERE id = ?`).bind(inst).first<{ name: string }>())?.name ?? ''
    let wa = null
    if (code !== '') { try { wa = await whatsappSendFor(c.db, code, { school_name: school }) } catch (e) { throw badRequest((e as Error).message) } }
    if (!p || !p.configured) throw new HttpError(409, p ? p.why : 'WhatsApp is not set up', { code: 'provider_not_configured' })
    const t = BUILTIN_TEMPLATES['messaging.test'], vars = { school_name: school }
    let msgId = '', sendErr: Error | null = null
    try { msgId = await p.send({ to, subject: renderTemplate(t.subject, vars), body: renderTemplate(t.body, vars), dlt: '', wa }) } catch (e) { sendErr = e as Error }
    if (sendErr) await c.db.prepare(`UPDATE integrations SET last_error = ? WHERE institution_id IS NOT NULL AND provider = 'whatsapp'`).bind(sendErr.message.trim().slice(0, 500)).run()
    else await c.db.prepare(`UPDATE integrations SET last_ok_at = ?, last_error = NULL WHERE institution_id IS NOT NULL AND provider = 'whatsapp'`).bind(new Date().toISOString()).run()
    if (sendErr) throw new HttpError(502, sendErr.message.trim().slice(0, 400), { code: 'provider_rejected' })
    return ok({ ok: true, message_id: msgId, message: 'WhatsApp accepted the message for …' + to.slice(-4) })
  })

  r.get('/admin/whatsapp/templates', READ, listTemplates)

  r.put('/admin/whatsapp/templates', CONFIG, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ code?: string; body?: string; wa_template_name?: string; wa_language?: string; wa_params?: string[] | null; is_active?: boolean }>(c.req)
    const code = str(req.code).trim()
    if (code === '') throw badRequest('a template code is required')
    const name = str(req.wa_template_name).trim()
    if (name !== '' && (!/^[a-z0-9_]+$/.test(name) || name.length > 512)) {
      throw badRequest('an approved WhatsApp template name is lowercase letters, digits and underscores, up to 512 characters')
    }
    const lang = str(req.wa_language).trim()
    if (lang !== '' && !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(lang)) throw badRequest('the language code looks like en, en_US or te')
    if (name !== '' && lang === '') throw badRequest('an approved template needs the language it was approved in')
    let body = str(req.body)
    if (body.trim() === '') {
      const t = BUILTIN_TEMPLATES[code]
      if (!t) throw badRequest('a body is required for a template that is not a built-in')
      body = t.body
    }
    const params = Array.isArray(req.wa_params) ? req.wa_params : []
    const known = new Set(templatePlaceholders(body))
    for (const p of params) if (!known.has(p)) throw badRequest(`the mapping names ${JSON.stringify(p)}, which this template's body does not use`)
    await c.db.prepare(`INSERT INTO message_templates (id, institution_id, code, channel, body, wa_template_name, wa_language, wa_params, is_active)
        VALUES (?, ?, ?, 'whatsapp', ?, ?, ?, ?, ?)
        ON CONFLICT (institution_id, code, channel) DO UPDATE SET body = excluded.body, wa_template_name = excluded.wa_template_name,
          wa_language = excluded.wa_language, wa_params = excluded.wa_params, is_active = excluded.is_active`)
      .bind(uuid(), inst, code, body, name || null, lang || null, JSON.stringify(params), req.is_active ? 1 : 0).run()
    return listTemplates(c)
  })

  const submit = async (c: Ctx): Promise<Response> => {
    const inst = institutionId(c)
    const only = (c.params.code ?? '').trim()
    const notReady = (m: string) => new HttpError(409, m, { code: 'whatsapp_not_ready' })
    const row = await c.db.prepare(`SELECT config, credentials FROM integrations WHERE institution_id IS NOT NULL AND kind = 'messaging' AND provider = 'whatsapp'`)
      .first<{ config: string | null; credentials: ArrayBuffer | null }>()
    if (!row) throw notReady("connect the school's WhatsApp Business account first")
    const cfg = parseJSON<Record<string, unknown>>(row.config, {})
    const waba = str(cfg.waba_id).trim()
    if (waba === '') {
      throw notReady('this account has no WhatsApp Business Account id, which is what a template is created against. Add it on the WhatsApp settings screen')
    }
    const creds = row.credentials as unknown as ArrayLike<number> | null
    if (!creds || creds.length === 0) throw notReady('no access token is stored for this account')
    const token = await openSecret(c, row.credentials)
    const mapped = new Set<string>()
    for (const m of (await c.db.prepare(`SELECT code, COALESCE(wa_template_name,'') AS name FROM message_templates WHERE channel = 'whatsapp'`)
      .all<{ code: string; name: string }>()).results) if (m.name.trim() !== '') mapped.add(m.code)
    const lang = str(cfg.default_language).trim() || 'en'
    const version = str(cfg.api_version).trim() || WA_DEFAULT_VERSION
    const results: WaSubmitResult[] = []
    for (const [code, t] of Object.entries(BUILTIN_TEMPLATES)) {
      if (only !== '' && code !== only) continue
      if (only === '' && mapped.has(code)) continue
      const sub = buildSubmission(code, t.body)
      const res: WaSubmitResult = { code, name: sub.name, status: '', category: sub.category }
      try { res.status = await createMetaTemplate(version, waba, token, lang, sub) } catch (e) {
        res.error = (e as Error).message
        results.push(res)
        continue
      }
      try {
        await c.db.prepare(`INSERT INTO message_templates (id, institution_id, code, channel, subject, body, wa_template_name, wa_language, wa_params, is_active)
            VALUES (?, ?, ?, 'whatsapp', ?, ?, ?, ?, ?, 1)
            ON CONFLICT (institution_id, code, channel) DO UPDATE SET wa_template_name = excluded.wa_template_name,
              wa_language = excluded.wa_language, wa_params = excluded.wa_params`)
          .bind(uuid(), inst, code, t.subject ?? null, t.body, sub.name, lang, JSON.stringify(sub.params)).run()
      } catch (e) { res.error = 'submitted to Meta but the mapping could not be saved: ' + (e as Error).message }
      results.push(res)
    }
    return ok({ items: results.map((x) => ({ code: x.code, name: x.name, status: x.status, category: x.category || undefined, error: x.error || undefined })) })
  }
  r.post('/admin/whatsapp/templates/submit', CREDS, submit)
  r.post('/admin/whatsapp/templates/{code}/submit', CREDS, submit)

  r.get('/admin/messaging/test-link', CREDS, async (c) => {
    const inst = institutionId(c)
    const secret = c.env.SESSION_SECRET
    if (typeof secret !== 'string' || secret.trim() === '') {
      throw new HttpError(409, 'SESSION_SECRET is not set on this server, so a signed link cannot be made')
    }
    const key = (await hmacHex(secret, 'message-test:' + inst)).slice(0, 32)
    return ok({ url: new URL(c.req.url).origin + '/download/message-test.html?key=' + key,
      note: 'Anyone with this link can send test messages to the addresses on your allowlist, ten an hour. It stops working the moment the guard is taken off allowlist mode.' })
  })

  r.get('/admin/whatsapp/log', 'auth', async (c) => {
    requireAny(c, SEND, AUDIT)
    const rows = await c.db.prepare(`SELECT id, recipient, subject, status, provider, template_code, error, attempts, ${isoZ('queued_at')} AS queued_at, ${isoZ('sent_at')} AS sent_at
        FROM message_log WHERE channel = 'whatsapp' ORDER BY queued_at DESC LIMIT 100`).all<Row>()
    return ok({ items: rows.results.map((v) => ({ id: v.id, recipient: v.recipient, subject: u(v.subject), status: v.status, provider: u(v.provider),
      template_code: u(v.template_code), error: u(v.error), attempts: Number(v.attempts), queued_at: v.queued_at, sent_at: u(v.sent_at) })) })
  })

  // --- the recipient guard ---
  r.get('/admin/messaging/recipients', READ, async (c) => ok(await readPolicy(c)))

  r.put('/admin/messaging/recipients/mode', CREDS, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ mode?: string; note?: string; confirm?: string }>(c.req)
    const mode = str(req.mode).trim()
    if (mode !== 'allowlist' && mode !== 'everyone') throw badRequest('mode must be allowlist or everyone')
    if (mode === 'everyone' && str(req.confirm).trim() !== 'everyone') throw badRequest("turning the guard off messages every real parent. Type 'everyone' to confirm")
    const t = now()
    await c.db.prepare(`INSERT INTO messaging_recipient_policy (institution_id, mode, note, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (institution_id) DO UPDATE SET mode = excluded.mode, note = excluded.note, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(inst, mode, str(req.note).trim() || null, t, c.id.platformAdmin ? null : c.id.userId).run()
    return ok(await readPolicy(c))
  })

  r.post('/admin/messaging/recipients', CREDS, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ value?: string; label?: string }>(c.req)
    const raw = str(req.value).trim()
    if (raw === '') throw badRequest('a number or an email address is required')
    const kind = raw.includes('@') ? 'email' : 'phone'
    let norm: string
    if (kind === 'email') {
      norm = raw.toLowerCase()
      if (!norm.includes('.') || norm.startsWith('@') || norm.endsWith('@')) throw badRequest('that does not look like an email address')
    } else {
      norm = normalisePhone(raw)
      if (norm === '') throw badRequest('that is not a phone number this can read. A ten-digit Indian mobile, or an international number')
    }
    await c.db.prepare(`INSERT INTO messaging_allowed_recipients (id, institution_id, kind, raw, normalised, label, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (institution_id, kind, normalised) DO NOTHING`)
      .bind(uuid(), inst, kind, raw, norm, str(req.label).trim() || null, now(), c.id.platformAdmin ? null : c.id.userId).run()
    return ok(await readPolicy(c))
  })

  r.del('/admin/messaging/recipients/{id}', CREDS, async (c) => {
    const id = uuidParam(c.params.id)
    await c.db.prepare(`DELETE FROM messaging_allowed_recipients WHERE id = ?`).bind(id).run()
    return ok(await readPolicy(c))
  })
}
