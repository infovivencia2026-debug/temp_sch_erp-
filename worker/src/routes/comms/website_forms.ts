/* WEBSITE FORMS (owner, 2026-11-05): forms like Google Forms, built here and
   put on the school's website. Two ways in, both landing in
   website_form_responses with the date and time:

   - Embed: the website shows /f/{school}/{form} in an iframe.
   - Direct POST: the website's own form posts to
     /api/v1/public/forms/{school}/{form} (form-encoded, multipart or JSON).
     Every value sent is kept, known field or not; files are stored.

   Staff with institution.read read the responses; institution.settings.write
   builds and closes forms. */
import type { Ctx, Router } from '../../router'
import type { Env } from '../../env'
import { json } from '../../env'
import { HttpError, badRequest, created, isUUID, now, ok, readJSON, uuid } from '../../http'
import { notifyHoldersStmts } from '../../notify_holders'
import { allTenants, callerAddress, goError, goInternal, goNotFound, rateLimited, type Tenant } from './public_common'
import { baseName, extOf, putObject, refuseSize, refuseUpload, sha256, uploadKey } from '../../services/files'

export const FIELD_TYPES = ['text', 'long_text', 'email', 'phone', 'number', 'date', 'dropdown', 'checkbox', 'file'] as const
type FieldType = typeof FIELD_TYPES[number]
export interface FormField { key: string; label: string; type: FieldType; required: boolean; options?: string[] }
interface FormRow { id: string; slug: string; title: string; description: string | null; fields: string; submit_label: string | null; thanks_message: string | null; is_open: number; created_at: string; updated_at: string }

const READ = 'institution.read', WRITE = 'institution.settings.write'
const MAX_FILE = 8 * 1024 * 1024

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'form'

function cleanFields(raw: unknown): FormField[] {
  if (!Array.isArray(raw)) throw badRequest('fields must be a list')
  if (raw.length > 60) throw badRequest('a form can have at most 60 fields')
  const seen = new Set<string>()
  return raw.map((f, i) => {
    const o = (f ?? {}) as Record<string, unknown>
    const label = String(o.label ?? '').trim()
    if (!label) throw badRequest(`field ${i + 1} needs a question`)
    const type = String(o.type ?? 'text') as FieldType
    if (!FIELD_TYPES.includes(type)) throw badRequest(`field ${i + 1}: unknown type`)
    let key = slugify(String(o.key ?? '') || label).replace(/-/g, '_')
    while (seen.has(key)) key += '_' + (i + 1)
    seen.add(key)
    const options = type === 'dropdown'
      ? (Array.isArray(o.options) ? o.options : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 100)
      : undefined
    if (type === 'dropdown' && !options!.length) throw badRequest(`${label}: add at least one choice`)
    return { key, label: label.slice(0, 200), type, required: o.required === true, ...(options ? { options } : {}) }
  })
}

const view = (f: FormRow) => ({
  id: f.id, slug: f.slug, title: f.title, description: f.description ?? '', fields: JSON.parse(f.fields) as FormField[],
  submit_label: f.submit_label ?? '', thanks_message: f.thanks_message ?? '', is_open: f.is_open === 1, created_at: f.created_at, updated_at: f.updated_at,
})

async function formOr404(c: Ctx, id: string) {
  if (!isUUID(id)) throw badRequest('invalid form id')
  const f = await c.db.prepare(`SELECT * FROM website_forms WHERE id = ?`).bind(id).first<FormRow>()
  if (!f) throw new HttpError(404, 'that form does not exist')
  return f
}

export function registerWebsiteForms(r: Router): void {
  r.get('/comms/website-forms', READ, async (c) => {
    const rows = await c.db.prepare(`SELECT f.*, (SELECT count(*) FROM website_form_responses x WHERE x.form_id = f.id) AS responses,
        (SELECT count(*) FROM website_form_responses x WHERE x.form_id = f.id AND x.is_read = 0) AS unread
        FROM website_forms f ORDER BY f.created_at DESC`).all<FormRow & { responses: number; unread: number }>()
    const inst = await c.db.prepare(`SELECT slug FROM institutions LIMIT 1`).first<{ slug: string }>()
    return ok({ school: inst?.slug ?? '', items: rows.results.map((f) => ({ ...view(f), responses: f.responses, unread: f.unread })) })
  })

  r.post('/comms/website-forms', WRITE, async (c) => {
    const b = await readJSON(c.req)
    const title = String(b.title ?? '').trim()
    if (!title) throw badRequest('give the form a name')
    let slug = slugify(title), n = 1
    while (await c.db.prepare(`SELECT 1 FROM website_forms WHERE slug = ?`).bind(slug).first()) slug = `${slugify(title).slice(0, 36)}-${++n}`
    const id = uuid(), t = now()
    const fields = b.fields === undefined ? [] : cleanFields(b.fields)
    await c.db.prepare(`INSERT INTO website_forms (id, institution_id, slug, title, fields, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(id, c.id.institution!.id, slug, title.slice(0, 120), JSON.stringify(fields), c.id.userId, t, t).run()
    return created(view(await formOr404(c, id)))
  })

  r.put('/comms/website-forms/{id}', WRITE, async (c) => {
    const f = await formOr404(c, c.params.id)
    const b = await readJSON(c.req)
    const title = b.title === undefined ? f.title : String(b.title).trim().slice(0, 120)
    if (!title) throw badRequest('give the form a name')
    const fields = b.fields === undefined ? f.fields : JSON.stringify(cleanFields(b.fields))
    const txt = (k: string, cur: string | null, max: number) => b[k] === undefined ? cur : (String(b[k] ?? '').trim().slice(0, max) || null)
    await c.db.prepare(`UPDATE website_forms SET title = ?, description = ?, fields = ?, submit_label = ?, thanks_message = ?, is_open = ?, updated_at = ? WHERE id = ?`)
      .bind(title, txt('description', f.description, 2000), fields, txt('submit_label', f.submit_label, 40), txt('thanks_message', f.thanks_message, 500),
        b.is_open === undefined ? f.is_open : (b.is_open ? 1 : 0), now(), f.id).run()
    return ok(view(await formOr404(c, f.id)))
  })

  r.get('/comms/website-forms/{id}/responses', READ, async (c) => {
    const f = await formOr404(c, c.params.id)
    const rows = await c.db.prepare(`SELECT id, data, files, source, page_url, is_read, created_at FROM website_form_responses WHERE form_id = ? ORDER BY created_at DESC LIMIT 2000`)
      .bind(f.id).all<{ id: string; data: string; files: string; source: string; page_url: string | null; is_read: number; created_at: string }>()
    return ok({
      form: view(f),
      items: rows.results.map((x) => ({ id: x.id, data: JSON.parse(x.data), files: JSON.parse(x.files), source: x.source, page_url: x.page_url ?? '', is_read: x.is_read === 1, created_at: x.created_at })),
    })
  })

  r.post('/comms/website-forms/{id}/responses/read', READ, async (c) => {
    const f = await formOr404(c, c.params.id)
    await c.db.prepare(`UPDATE website_form_responses SET is_read = 1 WHERE form_id = ? AND is_read = 0`).bind(f.id).run()
    return ok({ ok: true })
  })
}

/* ---- public: GET the form, POST a response ---------------------------- */

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' }
const withCors = (res: Response) => { for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v); return res }

async function findForm(env: Env, school: string, form: string): Promise<{ t: Tenant; f: FormRow } | null> {
  const s = school.toLowerCase(), slug = form.toLowerCase()
  for (const t of await allTenants(env)) {
    if (t.inst.slug.toLowerCase() !== s) continue
    const f = await t.db.prepare(`SELECT * FROM website_forms WHERE slug = ?`).bind(slug).first<FormRow>()
    return f ? { t, f } : null
  }
  return null
}

type Incoming = { values: Record<string, string>; files: { key: string; file: File }[]; meta: Record<string, string> }

async function readIncoming(req: Request): Promise<Incoming> {
  const type = req.headers.get('content-type') ?? ''
  const out: Incoming = { values: {}, files: [], meta: {} }
  const put = (k: string, v: string) => {
    if (k.startsWith('_')) { out.meta[k] = v; return }
    out.values[k] = out.values[k] ? `${out.values[k]}, ${v}` : v
  }
  if (type.includes('application/json')) {
    const b = await req.json().catch(() => null) as Record<string, unknown> | null
    if (!b || typeof b !== 'object') throw new Error('bad_json')
    for (const [k, v] of Object.entries(b)) put(k, Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''))
    return out
  }
  const form = await req.formData()
  for (const [k, v] of form.entries()) {
    if (typeof v === 'string') put(k, v)
    else if ((v as File).size > 0) out.files.push({ key: k, file: v as File })
  }
  return out
}

const fieldKeyOf = (k: string) => k.trim().slice(0, 80)

export async function handlePublicWebsiteForms(env: Env, req: Request, path: string): Promise<Response | null> {
  const m = /^\/api\/v1\/public\/forms\/([^/]+)\/([^/]+)$/.exec(path)
  if (!m) return null
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  try {
    const found = await findForm(env, decodeURIComponent(m[1]), decodeURIComponent(m[2]))
    if (!found) return withCors(goNotFound())
    const { t, f } = found
    const fields = JSON.parse(f.fields) as FormField[]
    if (req.method === 'GET') {
      return withCors(json({ school_name: t.inst.name, title: f.title, description: f.description ?? '', fields, is_open: f.is_open === 1,
        submit_label: f.submit_label || 'Submit', thanks_message: f.thanks_message || 'Thank you. Your response has been received.' }))
    }
    if (req.method !== 'POST') return null
    if (f.is_open !== 1) return withCors(goError(409, 'form_closed', 'This form is not taking responses now.'))
    const limited = await rateLimited(env, 'public_website_form', 600, 10, callerAddress(req), 'too many responses from this connection. Please wait a few minutes and try again.')
    if (limited) return withCors(limited)
    let inc: Incoming
    try { inc = await readIncoming(req) } catch { return withCors(goError(400, 'bad_request', 'could not read the form. Is a file larger than 8 MB?')) }
    // A bot fills every box it sees; a person never sees this one.
    if ((inc.meta._gotcha ?? '').trim() !== '') return withCors(json({ ok: true }, 201))
    const source = inc.meta._source === 'embed' ? 'embed' : 'post'

    const problems: string[] = []
    const data: Record<string, string> = {}
    for (const [k, v] of Object.entries(inc.values)) { const key = fieldKeyOf(k); if (key) data[key] = v.slice(0, 5000) }
    if (Object.keys(data).length > 100) return withCors(goError(400, 'too_many_fields', 'too many fields sent'))
    for (const fd of fields) {
      const v = (data[fd.key] ?? '').trim()
      const hasFile = inc.files.some((x) => x.key === fd.key)
      if (fd.type === 'file') { if (fd.required && !hasFile) problems.push(`${fd.label} is required`); continue }
      if (fd.type === 'checkbox') { if (fd.required && !/^(true|on|yes|1)$/i.test(v)) problems.push(`Tick: ${fd.label}`); continue }
      if (!v) { if (fd.required) problems.push(`${fd.label} is required`); continue }
      if (fd.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) problems.push(`${fd.label}: give a valid email address`)
      if (fd.type === 'phone' && v.replace(/\D/g, '').length < 10) problems.push(`${fd.label}: give a 10-digit number`)
      if (fd.type === 'number' && Number.isNaN(Number(v))) problems.push(`${fd.label}: give a number`)
      if (fd.type === 'dropdown' && fd.options && !fd.options.includes(v)) problems.push(`${fd.label}: choose one of the options`)
    }
    if (!Object.keys(data).length && !inc.files.length) problems.push('The form is empty')
    if (inc.files.length > 10) problems.push('At most 10 files')
    for (const x of inc.files) {
      const ext = extOf(baseName(x.file.name)).toLowerCase()
      const bad = x.file.size > MAX_FILE ? `${x.key}: files must be 8 MB or smaller` : refuseUpload(ext, x.file.type || 'application/octet-stream') || refuseSize(x.file.size)
      if (bad) problems.push(bad)
    }
    if (problems.length) return withCors(goError(400, 'validation_failed', problems.join('. ') + '.', { details: problems }))

    const inst = t.inst.id, ts = new Date().toISOString(), respId = uuid()
    const stmts: D1PreparedStatement[] = []
    const stored: { key: string; file_id: string; name: string; size: number }[] = []
    for (const x of inc.files) {
      const name = baseName(x.file.name.trim()) || 'file', ext = extOf(name).toLowerCase(), type = x.file.type || 'application/octet-stream'
      const bytes = await x.file.arrayBuffer(), fileId = uuid(), key = uploadKey(inst, fileId, ext)
      await putObject(env, key, bytes, type)
      stmts.push(t.db.prepare(`INSERT INTO files (id, institution_id, object_key, original_name, content_type, size_bytes, checksum_sha256, owner_type, owner_id, purpose, created_at)
          VALUES (?,?,?,?,?,?,?,'website_form_response',?,'website_form',?)`).bind(fileId, inst, key, name, type, bytes.byteLength, await sha256(bytes), respId, ts))
      stored.push({ key: fieldKeyOf(x.key), file_id: fileId, name, size: bytes.byteLength })
    }
    const page = (inc.meta._page || req.headers.get('referer') || '').slice(0, 500) || null
    stmts.push(t.db.prepare(`INSERT INTO website_form_responses (id, institution_id, form_id, data, files, source, page_url, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(respId, inst, f.id, JSON.stringify(data), JSON.stringify(stored), source, page, callerAddress(req).slice(0, 64), ts))
    const who = data[fields.find((x) => x.type === 'text')?.key ?? ''] || data.name || data.full_name || 'Someone'
    stmts.push(...(await notifyHoldersStmts(t.db, inst, WRITE, null, 'website_form', `New response: ${f.title}`,
      `${who} filled the ${f.title} form on the website.`, '/go/website_forms', 'website_form_response', respId)))
    await t.db.batch(stmts)

    const thanks = f.thanks_message || 'Thank you. Your response has been received.'
    // A plain HTML form with no script: send the visitor back, or show the thanks.
    const wantsHtml = !(req.headers.get('content-type') ?? '').includes('json') && (req.headers.get('accept') ?? '').includes('text/html')
    if (wantsHtml) {
      const back = inc.meta._redirect
      if (back && /^https?:\/\//.test(back)) return Response.redirect(back, 303)
      return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(f.title)}</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;text-align:center"><h1 style="font-size:22px">${esc(f.title)}</h1><p>${esc(thanks)}</p></body>`,
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    return withCors(json({ ok: true, id: respId, received_at: ts, message: thanks }, 201))
  } catch {
    return withCors(goInternal())
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!))
