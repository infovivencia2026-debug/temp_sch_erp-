import type { Env } from '../../env'
import { json } from '../../env'
import { isUUID, now, uuid } from '../../http'
import { loadFormDefinition, type FormDefinition } from './forms'
import { nextNumber, optionsForKind, todayIST } from './util'
import { allTenants, callerAddress, decodeStrict, goError, goInternal, goNotFound, rateLimited, type Tenant } from '../comms/public_common'

/* Port of mountAdmissionsPublic (admissions_growth.go): GET and POST
   /api/v1/public/admissions/forms/{slug}, the applicant-facing form, with no
   session. The school is found by the slug: Go asked every school's
   admission_forms AsPlatform; here each school's database is asked. */

const WINDOW_S = 10 * 60, BURST = 12 // publicFormPolicy

const reserved = new Set(['first_name', 'middle_name', 'last_name', 'date_of_birth', 'gender', 'category', 'class_sought',
  'parent_name', 'parent_phone', 'parent_email', 'address', 'previous_school'])

function validFormSlug(s: string): boolean {
  if (s.length < 3 || s.length > 64) return false
  return [...s].every((r, i) => (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || (r === '-' && i > 0))
}

/** resolvePublicForm: the open, published version behind a slug, and its school. */
async function resolvePublicForm(env: Env, slug: string): Promise<{ t: Tenant; versionID: string } | null> {
  const today = new Date().toISOString().slice(0, 10) // Postgres current_date on a UTC server
  const hits = await Promise.all((await allTenants(env)).map(async (t) => {
    const r = await t.db.prepare(`SELECT v.id FROM admission_forms f
        JOIN admission_form_versions v ON v.form_id = f.id AND v.status = 'published'
        WHERE f.slug = ? AND f.is_open = 1
          AND (f.opens_on IS NULL OR f.opens_on <= ?) AND (f.closes_on IS NULL OR f.closes_on >= ?)`)
      .bind(slug, today, today).first<{ id: string }>()
    return r ? { t, versionID: r.id } : null
  }))
  return hits.find((h) => h !== null) ?? null
}

type Field = FormDefinition['sections'][number]['fields'][number]

/** resolveFieldOptions. */
async function resolveFieldOptions(db: D1Database, def: FormDefinition): Promise<void> {
  for (const sec of def.sections) for (const f of sec.fields) {
    if (f.code === 'class_sought') { f.options = def.classes; continue }
    if (!f.option_kind) continue
    f.options = await optionsForKind(db, f.option_kind)
  }
}

async function getPublicAdmissionForm(env: Env, slug: string): Promise<Response> {
  if (!validFormSlug(slug)) return goNotFound()
  const found = await resolvePublicForm(env, slug)
  if (!found) return goNotFound()
  const def = await loadFormDefinition(found.t.db, found.versionID)
  if (!def) return goInternal()
  await resolveFieldOptions(found.t.db, def)
  return json({ school: found.t.inst.name, form: def })
}

// ---------------------------------------------------------------- validation

interface Submission { answers?: Record<string, string>; files?: Record<string, string>; urls?: Record<string, string> }
interface Checked { field: Field; text?: string; number?: number; date?: string; bool?: boolean; fileID?: string; url?: string }

const runeLen = (s: string) => [...s].length
const allDigits = (s: string) => /^[0-9]+$/.test(s)
/** %g for the numbers a school types as bounds. */
const g = (n: number) => String(n)

function parseRange(arg: string): [number, number] | null {
  const i = arg.indexOf('-')
  const atoi = (s: string) => (/^[+-]?\d+$/.test(s.trim()) ? Number(s.trim()) : NaN)
  const lo = atoi(i < 0 ? arg : arg.slice(0, i))
  if (Number.isNaN(lo)) return null
  if (i < 0) return [lo, lo]
  const hi = atoi(arg.slice(i + 1))
  return Number.isNaN(hi) ? null : [lo, hi]
}

/** matchStoredPattern: null means an unreadable rule. */
function matchStoredPattern(pattern: string, value: string): boolean | null {
  const i = pattern.indexOf(':')
  const kind = (i < 0 ? pattern : pattern.slice(0, i)).trim(), arg = i < 0 ? '' : pattern.slice(i + 1)
  switch (kind) {
    case 'digits': {
      if (!allDigits(value)) return false
      if (arg === '') return true
      const r = parseRange(arg)
      if (!r) return null
      return value.length >= r[0] && value.length <= r[1]
    }
    case 'letters': return /^[a-zA-Z .'-]*$/.test(value)
    case 'alnum': return /^[a-zA-Z0-9 ]*$/.test(value)
    case 'starts': return value.toLowerCase().startsWith(arg.toLowerCase())
  }
  return null
}

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(s + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function checkOneAnswer(f: Field, raw: string): [Checked, string] {
  const a: Checked = { field: f }
  if (f.min_length !== undefined && runeLen(raw) < f.min_length) return [a, `${f.label} must be at least ${f.min_length} characters`]
  let limit = 2000
  if (f.max_length !== undefined && f.max_length < limit) limit = f.max_length
  if (runeLen(raw) > limit) return [a, `${f.label} must be at most ${limit} characters`]
  if (f.pattern) {
    const m = matchStoredPattern(f.pattern, raw)
    // A broken rule is the school's mistake, not the applicant's: accepted.
    if (m === false) return [a, f.label + ' is not in the expected format']
  }
  switch (f.field_type) {
    case 'number': {
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return [a, f.label + ' must be a number']
      const n = Number(raw)
      if (f.min_number !== undefined && n < f.min_number) return [a, `${f.label} must be at least ${g(f.min_number)}`]
      if (f.max_number !== undefined && n > f.max_number) return [a, `${f.label} must be at most ${g(f.max_number)}`]
      a.number = n
      break
    }
    case 'date':
      if (!validDate(raw)) return [a, f.label + ' must be a date, like 2019-04-15']
      a.date = raw
      break
    case 'checkbox': {
      const b = raw === 'true' || raw === 'yes' || raw === '1' || raw === 'on'
      if (f.is_required && !b) return [a, f.label + ' must be ticked']
      a.bool = b
      break
    }
    case 'select':
      if (!(f.options ?? []).some((o) => o.value === raw)) return [a, f.label + ': choose one of the options offered']
      a.text = raw
      break
    case 'email':
      if (!raw.includes('@') || raw.startsWith('@') || raw.endsWith('@')) return [a, f.label + ' must be an email address']
      a.text = raw
      break
    case 'phone': {
      const d = raw.replace(/[^0-9]/g, '')
      if (d.length < 10 || d.length > 15) return [a, f.label + ' must be a phone number of at least 10 digits']
      a.text = raw
      break
    }
    default:
      a.text = raw
  }
  return [a, '']
}

function validateSubmission(def: FormDefinition, req: Submission): [Checked[], string[]] {
  const out: Checked[] = [], errs: string[] = []
  const given: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.answers ?? {})) given[k.trim().toLowerCase()] = v.trim()
  const allowed = new Set<string>()
  for (const s of def.sections) for (const f of s.fields) allowed.add(f.code)
  for (const code of Object.keys(given)) if (!allowed.has(code)) errs.push('this form has no question called ' + code)

  for (const sec of def.sections) for (const f of sec.fields) {
    if (f.visible_when && (given[f.visible_when.field.toLowerCase()] ?? '') !== f.visible_when.equals) continue
    if (f.field_type === 'file') {
      const fileRaw = (req.files?.[f.code] ?? '').trim(), urlRaw = (req.urls?.[f.code] ?? '').trim()
      if (fileRaw === '' && urlRaw === '') {
        if (f.is_required) errs.push(f.label + ' is required. Attach a file or give a link to it')
        continue
      }
      if (fileRaw !== '' && urlRaw !== '') { errs.push(f.label + ': give either an uploaded file or a link, not both'); continue }
      const a: Checked = { field: f }
      if (fileRaw !== '') {
        if (!isUUID(fileRaw)) { errs.push(f.label + ': that upload reference is not valid'); continue }
        a.fileID = fileRaw.toLowerCase()
      } else {
        if (!urlRaw.startsWith('https://') && !urlRaw.startsWith('http://')) { errs.push(f.label + ': a link must start with https://'); continue }
        a.url = urlRaw
      }
      out.push(a)
      continue
    }
    const raw = given[f.code] ?? ''
    if (raw === '') {
      if (f.is_required && f.field_type !== 'checkbox') errs.push(f.label + ' is required')
      if (f.field_type === 'checkbox') {
        if (f.is_required) { errs.push(f.label + ' must be ticked'); continue }
        out.push({ field: f, bool: false })
      }
      continue
    }
    const [a, msg] = checkOneAnswer(f, raw)
    if (msg !== '') { errs.push(msg); continue }
    out.push(a)
  }
  return [out, errs]
}

// ---------------------------------------------------------------- insert

/** insertPublicApplication. Returns the application number; an Error is a 500, as in Go. */
async function insertPublicApplication(t: Tenant, versionID: string, def: FormDefinition, answers: Checked[], from: string): Promise<string> {
  const { db } = t, inst = t.inst.id
  const core: Record<string, string> = {}
  let classID: string | null = null
  for (const a of answers) {
    if (!reserved.has(a.field.code)) continue
    if (a.text !== undefined) core[a.field.code] = a.text
    else if (a.date !== undefined) core[a.field.code] = a.date
    else if (a.number !== undefined) core[a.field.code] = String(a.number)
    if (a.field.code === 'class_sought' && a.text !== undefined) {
      if (!isUUID(a.text)) throw new Error('the class applied for is not one this school offers')
      classID = a.text
    }
  }
  if (classID === null) throw new Error('please choose the class you are applying for')
  const c = (k: string) => core[k] ?? ''
  if (c('first_name') === '' || c('parent_name') === '' || c('parent_phone') === '') {
    throw new Error("the child's name, a parent's name and a phone number are all required")
  }

  const form = await db.prepare(`SELECT COALESCE(f.campus_id, (SELECT id FROM campuses ORDER BY created_at LIMIT 1)) AS campus_id, f.admission_session_id
      FROM admission_forms f WHERE f.id = ?`).bind(def.form_id).first<{ campus_id: string | null; admission_session_id: string | null }>()
  if (!form || !form.campus_id) throw new Error('no campus for the form')

  const appNo = await nextNumber(db, inst, 'application', todayIST())

  const enq = await db.prepare(`SELECT e.id FROM enquiries e
      WHERE (e.phone = ? OR (NULLIF(?, '') IS NOT NULL AND e.email = ?))
        AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.enquiry_id = e.id)
      ORDER BY e.created_at DESC LIMIT 1`).bind(c('parent_phone'), c('parent_email'), c('parent_email')).first<{ id: string }>()

  const ts = now(), appID = uuid()
  const stmts: D1PreparedStatement[] = []
  let enquiryID: string
  if (enq) {
    enquiryID = enq.id
  } else {
    // A web application is also a lead: the enquiry is created, already 'applied'.
    enquiryID = uuid()
    stmts.push(db.prepare(`INSERT INTO enquiries (id, institution_id, campus_id, student_name, parent_name, phone, email, class_sought, source, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?, 'website', 'applied', ?, ?)`)
      .bind(enquiryID, inst, form.campus_id, `${c('first_name')} ${c('last_name')}`.trim(), c('parent_name'), c('parent_phone'), c('parent_email'), classID, ts, ts))
  }
  stmts.push(db.prepare(`INSERT INTO applications (id, institution_id, campus_id, admission_session_id, enquiry_id, application_no, first_name, middle_name,
        last_name, date_of_birth, gender, category, class_sought, parent_name, parent_phone, parent_email, address, previous_school, status,
        form_version_id, submitted_from, submitted_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''),
        'submitted', ?, ?, ?, ?, ?)`)
    .bind(appID, inst, form.campus_id, form.admission_session_id, enquiryID, appNo, c('first_name'), c('middle_name'), c('last_name'), c('date_of_birth'),
      c('gender'), c('category'), classID, c('parent_name'), c('parent_phone'), c('parent_email'), c('address'), c('previous_school'),
      versionID, from.slice(0, 60), ts, ts, ts))
  if (enq) {
    // enquiries_touch trigger: updated_at is set here.
    stmts.push(db.prepare(`UPDATE enquiries SET status = 'applied', updated_at = ? WHERE id = ? AND status NOT IN ('applied', 'lost')`).bind(ts, enquiryID))
  }
  for (const a of answers) {
    stmts.push(db.prepare(`INSERT INTO application_form_answers (id, institution_id, application_id, version_id, field_id,
          value_text, value_number, value_date, value_bool, file_id, external_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(uuid(), inst, appID, versionID, a.field.id, a.text ?? null, a.number === undefined ? null : String(a.number), a.date ?? null,
        a.bool === undefined ? null : a.bool ? 1 : 0, a.fileID ?? null, a.url ?? null, ts))
  }
  await db.batch(stmts)
  /* Not performed, and not a 501 because Go never lets them fail the
     application: issueEnquiryLogin (the family's login, sent by message) and
     notifyApplicantOn (admissions.application_received on WhatsApp, SMS and
     email). Both queue outbound messages. */
  return appNo
}

async function submitPublicAdmissionForm(env: Env, req: Request, slug: string): Promise<Response> {
  if (!validFormSlug(slug)) return goNotFound()
  const limited = await rateLimited(env, 'public_form', WINDOW_S, BURST, callerAddress(req),
    'too many applications from this connection. Please wait a few minutes and try again.')
  if (limited) return limited
  const body = await decodeStrict<Submission>(req, { answers: 'map', files: 'map', urls: 'map' })
  if (body instanceof Response) return body
  const found = await resolvePublicForm(env, slug)
  if (!found) return goNotFound()
  const def = await loadFormDefinition(found.t.db, found.versionID)
  if (!def) return goInternal()
  await resolveFieldOptions(found.t.db, def)
  const [checked, problems] = validateSubmission(def, body)
  if (problems.length) return goError(400, 'validation_failed', 'Some answers need attention.', { details: problems })
  const appNo = await insertPublicApplication(found.t, found.versionID, def, checked, callerAddress(req))
  return json({ application_no: appNo, message: 'Your application has been received. Please keep this number for reference.' }, 201)
}

/** GET/POST /api/v1/public/admissions/forms/{slug}; null for anything else. */
export async function handlePublicAdmissionForms(env: Env, req: Request, path: string): Promise<Response | null> {
  const m = /^\/api\/v1\/public\/admissions\/forms\/([^/]+)$/.exec(path)
  if (!m) return null
  if (req.method !== 'GET' && req.method !== 'POST') return null
  let slug: string
  try { slug = decodeURIComponent(m[1]).trim().toLowerCase() } catch { return goNotFound() }
  try {
    return req.method === 'GET' ? await getPublicAdmissionForm(env, slug) : await submitPublicAdmissionForm(env, req, slug)
  } catch (err) {
    console.error(err)
    return goInternal()
  }
}
