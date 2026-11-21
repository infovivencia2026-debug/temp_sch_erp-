/* Yajur Connect templates (communication.yajur_connect): every WhatsApp
   template on the school's own WhatsApp Business account, with its status as
   Meta reports it, the wording parents receive, and which ERP message uses
   it; and making, editing and deleting a template on Meta from here.

   Read comms.connect.read; make, edit and delete comms.connect.write.

   The list is Meta's own (GET /{waba}/message_templates) merged with the
   school's mappings in message_templates (channel whatsapp). When the account
   is not connected, or Meta cannot be reached, the school's mappings are
   still listed and the screen says why the live status is missing.

   A template made here is also saved as a Yajur Connect template
   (code connect_<name>) with its {{1}}, {{2}} numbered variables renamed to
   the field names the school gave them, so the Send tab can use it the
   moment Meta approves it. Nothing here sends a message. */
import type { Ctx, Router } from '../../router'
import { HttpError, badRequest, ok, readJSON, uuid } from '../../http'
import { explainMetaError } from '../../services/messaging'
import { connectLabel } from '../../services/wa_send'
import { openSecret } from '../admin/providers'
import { can } from '../../identity'
import { getObject } from '../../services/files'

const READ = 'comms.connect.read', WRITE = 'comms.connect.write'
const WA_DEFAULT_VERSION = 'v21.0'
const CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const
type Category = typeof CATEGORIES[number]
const MERGE_LABEL: Record<string, string> = { parent_name: "Parent's name", student_name: "Student's name", class: 'Class', staff_name: "Staff member's name", school_name: 'School name' }

export interface TplButton { type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER'; text: string; url?: string; phone_number?: string }
export interface TplItem {
  id: string | null
  name: string
  label: string
  code: string | null
  language: string
  category: string
  status: string
  rejected_reason: string | null
  header: { format: string; text: string | null } | null
  body: string
  footer: string | null
  buttons: TplButton[]
  /** Friendly names of {{1}}, {{2}}… in order, from the school's mapping when there is one. */
  fields: { key: string; label: string; sample: string }[]
  used_for: string[]
  /** Usable on the Send tab (an approved Yajur Connect template). */
  sendable: boolean
  on_meta: boolean
}

const s = (v: unknown) => (typeof v === 'string' ? v : '')
const labelOf = (key: string) => MERGE_LABEL[key] ?? key.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase())
const usedLabel = (code: string) => {
  const known: Record<string, string> = {
    'attendance.absent': 'Absence alert', 'fees.overdue': 'Fee reminder', 'fees.reminder': 'Fee reminder', 'announcement.published': 'Circular',
    'homework.set': 'Homework', 'ptm.reminder': 'PTM reminder', 'reportcard.published': 'Report card', 'payroll.payslip': 'Payslip', 'student.remark': 'Teacher remark',
  }
  return known[code] ?? code.replace(/[._]/g, ' ').replace(/^./, (x) => x.toUpperCase())
}

interface Account { version: string; waba: string; token: string; appId: string }
/** The school's WhatsApp Cloud account, or why there is none. */
async function account(c: Ctx): Promise<{ acc: Account | null; reason: string }> {
  const row = await c.db.prepare(`SELECT config, credentials FROM integrations WHERE institution_id IS NOT NULL AND kind = 'messaging' AND provider = 'whatsapp'`)
    .first<{ config: string | null; credentials: ArrayBuffer | null }>()
  if (!row) return { acc: null, reason: "The school's WhatsApp Business account is not connected (Message Channels → WhatsApp)." }
  let cfg: Record<string, unknown> = {}
  try { cfg = JSON.parse(row.config ?? '{}') as Record<string, unknown> } catch { /* empty */ }
  const waba = s(cfg.waba_id).trim()
  if (!waba) return { acc: null, reason: 'No WhatsApp Business Account id is saved (Message Channels → WhatsApp), so the live list cannot be read.' }
  const creds = row.credentials as unknown as ArrayLike<number> | null
  if (!creds || creds.length === 0) return { acc: null, reason: 'No access token is saved for the WhatsApp account.' }
  const token = await openSecret(c, row.credentials)
  return { acc: { version: s(cfg.api_version).trim() || WA_DEFAULT_VERSION, waba, token, appId: s(cfg.app_id).trim() }, reason: '' }
}

async function graph(acc: Account, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(`https://graph.facebook.com/${acc.version}/${path}`, {
      ...init, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + acc.token, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000),
    })
  } catch (e) { throw new HttpError(502, 'could not reach WhatsApp (graph.facebook.com): ' + (e as Error).message) }
  const text = (await res.text()).slice(0, 65536)
  if (res.status >= 300) {
    const err = explainMetaError(res.status, text)
    throw new HttpError(res.status >= 500 ? 502 : 422, err.message, { code: 'whatsapp_rejected' })
  }
  try { return JSON.parse(text) as Record<string, unknown> } catch { return {} }
}

interface MetaComponent { type?: string; format?: string; text?: string; buttons?: { type?: string; text?: string; url?: string; phone_number?: string }[]; example?: { body_text?: string[][]; header_text?: string[] } }
interface MetaTemplate { id?: string; name?: string; status?: string; category?: string; language?: string; rejected_reason?: string; components?: MetaComponent[] }

async function metaList(acc: Account): Promise<MetaTemplate[]> {
  const out: MetaTemplate[] = []
  let path = `${acc.waba}/message_templates?fields=id,name,status,category,language,rejected_reason,components&limit=200`
  for (let page = 0; page < 5 && path; page++) {
    const r = await graph(acc, path)
    for (const t of (r.data as MetaTemplate[] | undefined) ?? []) out.push(t)
    const next = s((r.paging as { next?: string } | undefined)?.next)
    path = next ? next.replace(/^https:\/\/graph\.facebook\.com\/v[0-9.]+\//, '') : ''
  }
  return out
}

interface LocalRow { code: string; body: string; wa_template_name: string | null; wa_language: string | null; wa_params: string | null; is_active: number; has_image_header: number }

function fieldsFrom(local: LocalRow | undefined, metaBody: string, samples: string[]): TplItem['fields'] {
  const n = Math.max(0, ...[...metaBody.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))
  let keys: string[] = []
  if (local) {
    try { const p = JSON.parse(local.wa_params ?? '[]') as unknown; if (Array.isArray(p)) keys = p.map(String) } catch { /* none */ }
    if (keys.length === 0) keys = [...new Set([...local.body.matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g)].map((m) => m[1]))]
  }
  const count = Math.max(n, keys.length)
  return Array.from({ length: count }, (_, i) => {
    const key = keys[i] ?? `field_${i + 1}`
    return { key, label: keys[i] ? labelOf(key) : `Message field ${i + 1}`, sample: samples[i] ?? '' }
  })
}

function fromMeta(t: MetaTemplate, local: LocalRow | undefined, usedFor: string[], named?: LocalRow): TplItem {
  const comps = t.components ?? []
  const head = comps.find((x) => x.type === 'HEADER')
  const body = comps.find((x) => x.type === 'BODY')
  const foot = comps.find((x) => x.type === 'FOOTER')
  const btns = comps.find((x) => x.type === 'BUTTONS')?.buttons ?? []
  const bodyText = s(body?.text)
  const status = s(t.status) || 'UNKNOWN'
  return {
    id: s(t.id) || null, name: s(t.name), label: local ? connectLabel(local.code) : connectLabel(s(t.name)), code: local?.code ?? null,
    language: s(t.language), category: s(t.category), status, rejected_reason: s(t.rejected_reason) && s(t.rejected_reason) !== 'NONE' ? s(t.rejected_reason) : null,
    header: head ? { format: s(head.format) || 'TEXT', text: s(head.text) || null } : null,
    body: bodyText, footer: s(foot?.text) || null,
    buttons: btns.map((b) => ({ type: (s(b.type) as TplButton['type']) || 'QUICK_REPLY', text: s(b.text), url: s(b.url) || undefined, phone_number: s(b.phone_number) || undefined })),
    fields: fieldsFrom(local ?? named, bodyText, body?.example?.body_text?.[0] ?? []),
    used_for: usedFor, sendable: status === 'APPROVED' && !!local && local.code.startsWith('connect_') && local.is_active === 1, on_meta: true,
  }
}

function fromLocal(l: LocalRow, usedFor: string[]): TplItem {
  const keys = [...new Set([...l.body.matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g)].map((m) => m[1]))]
  let i = 0
  const numbered = l.body.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g, (_m, k: string) => `{{${keys.indexOf(k) + 1 || ++i}}}`)
  return {
    id: null, name: l.wa_template_name ?? l.code, label: connectLabel(l.code), code: l.code, language: l.wa_language ?? '', category: '', status: 'NOT_CHECKED', rejected_reason: null,
    header: l.has_image_header === 1 ? { format: 'IMAGE', text: null } : null, body: numbered, footer: null, buttons: [],
    fields: keys.map((k) => ({ key: k, label: labelOf(k), sample: '' })), used_for: usedFor, sendable: l.is_active === 1, on_meta: false,
  }
}

async function listAll(c: Ctx): Promise<{ items: TplItem[]; live: boolean; reason: string; can_write: boolean }> {
  const rows = (await c.db.prepare(`SELECT code, body, wa_template_name, wa_language, wa_params, is_active, coalesce(has_image_header, 0) AS has_image_header
      FROM message_templates WHERE channel = 'whatsapp'`).all<LocalRow>()).results
  const usedBy = new Map<string, string[]>()
  for (const r of rows) {
    const n = (r.wa_template_name ?? '').trim()
    if (!n || r.code.startsWith('connect_') || r.is_active !== 1) continue
    usedBy.set(n, [...(usedBy.get(n) ?? []), usedLabel(r.code)])
  }
  const connect = rows.filter((r) => r.code.startsWith('connect_') && (r.wa_template_name ?? '').trim())
  const byName = new Map(connect.map((r) => [(r.wa_template_name ?? '').trim(), r]))
  // Any mapping of the same template name gives its fields their names (the ERP's own messages name theirs too).
  const anyByName = new Map<string, LocalRow>()
  for (const r of rows) { const n = (r.wa_template_name ?? '').trim(); if (n && !anyByName.has(n)) anyByName.set(n, r) }
  const can_write = can(c.id, WRITE)
  const { acc, reason } = await account(c)
  if (acc) {
    try {
      const meta = await metaList(acc)
      const seen = new Set<string>()
      const items = meta.map((t) => { seen.add(s(t.name)); return fromMeta(t, byName.get(s(t.name)), usedBy.get(s(t.name)) ?? [], anyByName.get(s(t.name))) })
      for (const r of connect) if (!seen.has((r.wa_template_name ?? '').trim())) items.push(fromLocal(r, usedBy.get((r.wa_template_name ?? '').trim()) ?? []))
      return { items: sortItems(items), live: true, reason: '', can_write }
    } catch (e) {
      return { items: sortItems(connect.map((r) => fromLocal(r, usedBy.get((r.wa_template_name ?? '').trim()) ?? []))), live: false, reason: (e as Error).message, can_write }
    }
  }
  return { items: sortItems(connect.map((r) => fromLocal(r, usedBy.get((r.wa_template_name ?? '').trim()) ?? []))), live: false, reason, can_write }
}

const RANK: Record<string, number> = { APPROVED: 0, PENDING: 1, IN_APPEAL: 1, PAUSED: 2, REJECTED: 3, DISABLED: 4 }
function sortItems(items: TplItem[]): TplItem[] {
  return items.sort((a, b) => (RANK[a.status] ?? 5) - (RANK[b.status] ?? 5) || a.label.localeCompare(b.label))
}

// ---- making and editing ---------------------------------------------------------

export interface TplInput {
  name?: string; category?: string; language?: string
  header?: { type?: 'none' | 'text' | 'image'; text?: string; sample?: string } | null
  body?: string
  /** One per {{n}}: a field name ("parent_name", "Due date"…) and a sample value Meta reviews. */
  fields?: { name?: string; sample?: string }[]
  footer?: string
  buttons?: { type?: string; text?: string; url?: string; phone_number?: string }[]
}

const snake = (v: string) => v.trim().toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)

/** Meta's rules, checked here so a school sees the reason before Meta rejects it. Returns the Graph components and the field keys in order. */
export function checkTemplate(b: TplInput, editing: boolean): { name: string; category: Category; language: string; components: Record<string, unknown>[]; keys: string[]; image: boolean } {
  const name = s(b.name).trim()
  if (!editing && !/^[a-z0-9_]{1,512}$/.test(name)) throw badRequest('the name is lowercase letters, numbers and underscores only, e.g. fee_reminder_term2')
  const category = s(b.category).trim().toUpperCase() as Category
  if (!CATEGORIES.includes(category)) throw badRequest('choose a category: Utility, Marketing or Authentication')
  const language = s(b.language).trim() || 'en'
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language)) throw badRequest('the language code looks like en, en_US or te')
  const body = s(b.body).trim()
  if (!body) throw badRequest('write the message body')
  if (body.length > 1024) throw badRequest('the body is at most 1,024 characters')
  const nums = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]))
  if (/\{\{\s*[^0-9\s}][^}]*\}\}/.test(body)) throw badRequest('variables are numbered: {{1}}, {{2}} and so on')
  const count = nums.length ? Math.max(...nums) : 0
  for (let i = 1; i <= count; i++) if (!nums.includes(i)) throw badRequest(`the variables must run {{1}} to {{${count}}} with no gap; {{${i}}} is missing`)
  if (/^\s*\{\{/.test(body) || /\{\{\s*\d+\s*\}\}\s*[.!?]?\s*$/.test(body)) throw badRequest('the body cannot start or end with a variable; add words before and after it')
  const fields = b.fields ?? []
  if (fields.length < count) throw badRequest(`give a name and a sample value for each of the ${count} variables`)
  const keys: string[] = [], samples: string[] = []
  for (let i = 0; i < count; i++) {
    const key = snake(s(fields[i]?.name))
    if (!key) throw badRequest(`name variable {{${i + 1}}}, e.g. Parent name`)
    if (keys.includes(key)) throw badRequest(`two variables are both called "${s(fields[i]?.name)}"`)
    const sample = s(fields[i]?.sample).trim()
    if (!sample) throw badRequest(`give a sample value for {{${i + 1}}}; Meta reviews the message with it`)
    keys.push(key); samples.push(sample)
  }
  if (category === 'UTILITY' && /\b(offer|discount|sale|admissions? open|enrol now|limited seats|hurry)\b/i.test(body)) {
    throw badRequest('this reads as promotional; Meta rejects promotion in a Utility template. Choose Marketing or reword it')
  }
  const components: Record<string, unknown>[] = []
  let image = false
  const h = b.header ?? null
  if (h && h.type === 'text') {
    const t = s(h.text).trim()
    if (!t) throw badRequest('write the header text, or choose no header')
    if (t.length > 60) throw badRequest('the header is at most 60 characters')
    if (/\{\{/.test(t)) throw badRequest('keep the header fixed text, without variables')
    components.push({ type: 'HEADER', format: 'TEXT', text: t })
  } else if (h && h.type === 'image') {
    image = true
  }
  const bodyComp: Record<string, unknown> = { type: 'BODY', text: body }
  if (count > 0) bodyComp.example = { body_text: [samples] }
  components.push(bodyComp)
  const footer = s(b.footer).trim()
  if (footer) {
    if (footer.length > 60) throw badRequest('the footer is at most 60 characters')
    if (/\{\{/.test(footer)) throw badRequest('the footer is fixed text; it cannot carry a variable')
    components.push({ type: 'FOOTER', text: footer })
  }
  const btns = (b.buttons ?? []).filter((x) => s(x.text).trim())
  if (btns.length > 10) throw badRequest('at most 10 buttons')
  if (btns.filter((x) => x.type === 'URL').length > 2) throw badRequest('at most 2 website buttons')
  if (btns.filter((x) => x.type === 'PHONE_NUMBER').length > 1) throw badRequest('at most 1 call button')
  const out = btns.map((x) => {
    const text = s(x.text).trim()
    if (text.length > 25) throw badRequest(`the button "${text}" is longer than 25 characters`)
    if (x.type === 'URL') {
      const url = s(x.url).trim()
      if (!/^https:\/\/\S+$/.test(url)) throw badRequest(`the button "${text}" needs a link starting with https://`)
      return { type: 'URL', text, url }
    }
    if (x.type === 'PHONE_NUMBER') {
      const phone = s(x.phone_number).replace(/[^0-9+]/g, '')
      if (!/^\+?[0-9]{10,15}$/.test(phone)) throw badRequest(`the button "${text}" needs a phone number with the country code, e.g. +918886663636`)
      return { type: 'PHONE_NUMBER', text, phone_number: phone.startsWith('+') ? phone : '+' + phone }
    }
    return { type: 'QUICK_REPLY', text }
  })
  if (out.length) components.push({ type: 'BUTTONS', buttons: out })
  return { name, category, language, components, keys, image }
}

/** Upload a sample picture to Meta for an image header (resumable upload; needs the Meta app id). */
async function headerHandle(acc: Account, picture: { bytes: ArrayBuffer; type: string; name: string }): Promise<string> {
  if (!acc.appId) throw new HttpError(409, 'a picture header needs the Meta app id saved on Message Channels → WhatsApp', { code: 'whatsapp_not_ready' })
  const start = await graph(acc, `${acc.appId}/uploads?file_name=${encodeURIComponent(picture.name)}&file_length=${picture.bytes.byteLength}&file_type=${encodeURIComponent(picture.type)}`, { method: 'POST' })
  const session = s(start.id)
  if (!session) throw new HttpError(502, 'WhatsApp did not open an upload for the picture')
  const done = await graph(acc, session, { method: 'POST', body: picture.bytes, headers: { 'Content-Type': picture.type, file_offset: '0', Authorization: 'OAuth ' + acc.token } })
  const h = s(done.h)
  if (!h) throw new HttpError(502, 'WhatsApp did not return a handle for the picture')
  return h
}

async function pictureOf(c: Ctx, fileId: string): Promise<{ bytes: ArrayBuffer; type: string; name: string }> {
  const f = await c.db.prepare(`SELECT object_key, content_type, original_name FROM files WHERE id = ? AND deleted_at IS NULL`).bind(fileId).first<{ object_key: string; content_type: string; original_name: string }>()
  if (!f) throw badRequest('upload the sample picture first')
  if (!/^image\/(jpeg|png)$/.test(f.content_type)) throw badRequest('the header picture must be a JPG or PNG')
  const obj = await getObject(c.env, f.object_key)
  if (!obj) throw badRequest('the sample picture could not be read')
  return { bytes: await obj.arrayBuffer(), type: f.content_type, name: f.original_name }
}

/** The body as the Send tab uses it: {{1}} renamed to the school's field names. */
const namedBody = (body: string, keys: string[]) => body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => `{{${keys[Number(n) - 1] ?? `field_${n}`}}}`)

async function saveLocal(c: Ctx, name: string, language: string, body: string, keys: string[], image: boolean): Promise<string> {
  const code = 'connect_' + name
  await c.db.prepare(`INSERT INTO message_templates (id, institution_id, code, channel, body, wa_template_name, wa_language, wa_params, is_active, has_image_header)
      VALUES (?, ?, ?, 'whatsapp', ?, ?, ?, ?, 1, ?)
      ON CONFLICT (institution_id, code, channel) DO UPDATE SET body = excluded.body, wa_template_name = excluded.wa_template_name,
        wa_language = excluded.wa_language, wa_params = excluded.wa_params, is_active = 1, has_image_header = excluded.has_image_header`)
    .bind(uuid(), c.id.institution?.id ?? null, code, namedBody(body, keys), name, language, JSON.stringify(keys), image ? 1 : 0).run()
  return code
}

async function needAccount(c: Ctx): Promise<Account> {
  const { acc, reason } = await account(c)
  if (!acc) throw new HttpError(409, reason, { code: 'whatsapp_not_ready' })
  return acc
}

export function registerYajurConnectTemplates(r: Router): void {
  r.get('/comms/yajur-connect/templates', READ, async (c) => ok(await listAll(c)))

  r.post('/comms/yajur-connect/templates', WRITE, async (c) => {
    const b = await readJSON<TplInput & { header_file_id?: string }>(c.req)
    const t = checkTemplate(b, false)
    const acc = await needAccount(c)
    if (t.image) {
      const handle = await headerHandle(acc, await pictureOf(c, s(b.header_file_id)))
      t.components.unshift({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [handle] } })
    }
    const res = await graph(acc, `${acc.waba}/message_templates`, {
      method: 'POST', body: JSON.stringify({ name: t.name, language: t.language, category: t.category, components: t.components }),
    })
    const code = await saveLocal(c, t.name, t.language, s((t.components.find((x) => x.type === 'BODY') as { text?: string }).text), t.keys, t.image)
    return ok({ id: s(res.id) || null, name: t.name, code, status: s(res.status) || 'PENDING', category: s(res.category) || t.category })
  })

  r.put('/comms/yajur-connect/templates/{id}', WRITE, async (c) => {
    const id = s(c.params.id)
    if (!/^[0-9]{5,25}$/.test(id)) throw badRequest('that is not a WhatsApp template id')
    const b = await readJSON<TplInput & { header_file_id?: string }>(c.req)
    const t = checkTemplate({ ...b, name: 'x' }, true)
    const acc = await needAccount(c)
    const name = s(b.name).trim()
    if (!/^[a-z0-9_]{1,512}$/.test(name)) throw badRequest('the template name is missing')
    if (t.image) {
      const handle = await headerHandle(acc, await pictureOf(c, s(b.header_file_id)))
      t.components.unshift({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [handle] } })
    }
    await graph(acc, id, { method: 'POST', body: JSON.stringify({ category: t.category, components: t.components }) })
    const code = await saveLocal(c, name, t.language, s((t.components.find((x) => x.type === 'BODY') as { text?: string }).text), t.keys, t.image)
    return ok({ id, name, code, status: 'PENDING' })
  })

  r.del('/comms/yajur-connect/templates/{name}', WRITE, async (c) => {
    const name = s(c.params.name)
    if (!/^[a-z0-9_]{1,512}$/.test(name)) throw badRequest('that is not a template name')
    const acc = await needAccount(c)
    const id = (c.url.searchParams.get('id') ?? '').trim()
    await graph(acc, `${acc.waba}/message_templates?name=${encodeURIComponent(name)}${/^[0-9]{5,25}$/.test(id) ? `&hsm_id=${id}` : ''}`, { method: 'DELETE' })
    await c.db.prepare(`UPDATE message_templates SET is_active = 0 WHERE channel = 'whatsapp' AND code = ?`).bind('connect_' + name).run()
    return ok({ deleted: name })
  })
}
