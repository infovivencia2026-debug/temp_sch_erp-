import type { Router, Ctx } from '../../router'
import type { Env } from '../../env'
import { json } from '../../env'
import { HttpError, badRequest, created, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { activityStmt, phoneKey } from './crm'
import { isUUIDish, isUniqueViolation, isYMD, optionValue, parseJSON, str, todayIST } from './util'
import { allTenants, callerAddress, goBadRequest, goError, goInternal, goNotFound, rateLimited, type Tenant } from '../comms/public_common'

/* ENQUIRY LINKS: the family fills in the enquiry, not the front desk.

   An enquiry reached the list one way: somebody at the school typed it in
   while the parent stood there or held the phone. A parent who asks on
   WhatsApp at nine at night, or reads the school's poster, had nothing to
   fill in, and the lead lived in a chat until somebody remembered it.

   A school now makes links (Admissions > Enquiries > Enquiry links): one per
   place it is handed out, because the first thing a school asks of its
   admissions spend is which channel brought whom. A link opens a short form
   at /admissions/enquire/<slug>, with no sign-in. What comes back is an
   enquiry at "new", due for a follow-up today, carrying the link's name as
   its campaign.

   WHAT THE FORM ASKS IS THE SCHOOL'S CHOICE. The child's name, a parent's
   name and a phone number are always asked: without them there is nobody to
   call. Class, email, date of birth, the present school, how they heard, a
   preferred day to visit and a message are each off, optional or required.

   THE SAME FAMILY ASKING TWICE IS ONE LEAD. A second enquiry for the same
   child from the same number, while the first is still open, is added to
   that lead's history instead of becoming a row somebody has to merge.

   FROM A LEAD TO THE APPLICATION. A lead's own application link carries a
   signature naming that enquiry: the application form opens with what the
   school already knows filled in, and what is submitted is attached to that
   lead rather than matched by phone number afterwards. */

const READ = 'admissions.read', WRITE = 'admissions.write'
const SOURCES = ['walk_in', 'phone', 'website', 'referral', 'campaign', 'other']
const QUESTIONS = ['class_sought', 'email', 'date_of_birth', 'current_school', 'how_heard', 'visit_date', 'message'] as const
type Question = (typeof QUESTIONS)[number]
type Ask = Record<Question, 'off' | 'optional' | 'required'>
const DEFAULT_ASK: Ask = { class_sought: 'required', email: 'optional', date_of_birth: 'off', current_school: 'off', how_heard: 'optional', visit_date: 'off', message: 'optional' }
const LABEL: Record<Question, string> = { class_sought: 'Class sought', email: 'Email', date_of_birth: "Child's date of birth", current_school: 'Present school',
  how_heard: 'How they heard of the school', visit_date: 'Preferred day to visit', message: 'Message' }
const WINDOW_S = 10 * 60, BURST = 8

function cleanAsk(raw: unknown): Ask {
  const out = { ...DEFAULT_ASK }
  const given = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  for (const q of QUESTIONS) if (given[q] === 'off' || given[q] === 'optional' || given[q] === 'required') out[q] = given[q] as Ask[Question]
  return out
}
function validSlug(s: string): boolean {
  if (s.length < 3 || s.length > 64) return false
  return [...s].every((r, i) => (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || (r === '-' && i > 0))
}
const slugOf = (name: string) => optionValue(name).split('_').join('-').slice(0, 56).replace(/^-+|-+$/g, '')
const short = (v: unknown, max: number) => str(v).trim().slice(0, max)

interface LinkRow {
  id: string; institution_id: string; campus_id: string | null; name: string; slug: string; source: string; is_open: number
  heading: string | null; intro: string | null; thanks: string | null; ask: string; apply_form_id: string | null; created_at: string
}
const view = (l: LinkRow & { enquiries?: number; last_at?: string | null; apply_slug?: string | null; apply_name?: string | null }, origin: string) => ({
  id: l.id, name: l.name, slug: l.slug, source: l.source, is_open: !!l.is_open, heading: l.heading ?? '', intro: l.intro ?? '', thanks: l.thanks ?? '',
  ask: cleanAsk(parseJSON(l.ask, {})), apply_form_id: l.apply_form_id ?? '', apply_form: l.apply_name ?? undefined,
  /* `path` is what a browser should use: the Worker may be answering behind
     the site's proxy, where its own origin is not the address families open. */
  path: `/admissions/enquire/${l.slug}`, url: `${origin}/admissions/enquire/${l.slug}`, enquiries: l.enquiries ?? 0, last_enquiry_at: l.last_at ?? undefined, created_at: l.created_at,
})

async function readLink(c: Ctx, req: Record<string, unknown>, existing?: LinkRow) {
  const name = short(req.name ?? existing?.name, 80)
  if (name === '') throw badRequest('give the link a name: where it will be handed out')
  const source = str(req.source ?? existing?.source ?? 'website')
  if (!SOURCES.includes(source)) throw badRequest('source must be one of: ' + SOURCES.join(', '))
  let form: string | null = req.apply_form_id === undefined ? existing?.apply_form_id ?? null : str(req.apply_form_id).trim() || null
  if (form !== null) {
    if (!isUUIDish(form)) throw badRequest('apply_form_id must be a uuid')
    if (!(await c.db.prepare('SELECT 1 FROM admission_forms WHERE id = ?').bind(form).first())) throw badRequest('no such application form')
    form = form.toLowerCase()
  }
  return {
    name, source, form,
    open: req.is_open === undefined ? (existing ? !!existing.is_open : true) : !!req.is_open,
    heading: short(req.heading ?? existing?.heading, 120) || null,
    intro: short(req.intro ?? existing?.intro, 600) || null,
    thanks: short(req.thanks ?? existing?.thanks, 400) || null,
    ask: JSON.stringify(cleanAsk(req.ask ?? parseJSON(existing?.ask, {}))),
  }
}

// ---------------------------------------------------------------- signed lead links

const enc = new TextEncoder()
const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
async function leadSignature(env: Env, inst: string, enquiryId: string, exp: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode('admissions-lead-link:' + env.PASSWORD_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(`${inst}.${enquiryId}.${exp}`)))
}
/** `<enquiry>.<expiry>.<signature>`: names one lead of one school, for thirty days. */
export async function leadToken(env: Env, inst: string, enquiryId: string): Promise<string> {
  const exp = Date.now() + 30 * 86_400_000
  return `${enquiryId}.${exp}.${await leadSignature(env, inst, enquiryId, exp)}`
}
/** The enquiry a token names, when it is this school's and still good; else null. */
export async function leadFromToken(env: Env, inst: string, token: string | null): Promise<string | null> {
  const [id, expRaw, sig] = (token ?? '').split('.')
  const exp = Number(expRaw)
  if (!id || !sig || !isUUIDish(id) || !Number.isFinite(exp) || exp < Date.now()) return null
  const want = await leadSignature(env, inst, id.toLowerCase(), exp)
  if (want.length !== sig.length) return null
  let diff = 0
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i)
  return diff === 0 ? id.toLowerCase() : null
}

// ---------------------------------------------------------------- the school's side

export function registerEnquiryLinks(r: Router) {
  r.get('/admissions/enquiry-links', READ, async (c) => {
    const origin = new URL(c.req.url).origin
    const rows = await c.db.prepare(`SELECT l.*, f.slug AS apply_slug, f.name AS apply_name,
          (SELECT count(*) FROM enquiries e WHERE e.utm_campaign = l.slug) AS enquiries,
          (SELECT max(e.created_at) FROM enquiries e WHERE e.utm_campaign = l.slug) AS last_at
        FROM enquiry_links l LEFT JOIN admission_forms f ON f.id = l.apply_form_id ORDER BY l.created_at`).all<LinkRow & { enquiries: number; last_at: string | null; apply_slug: string | null; apply_name: string | null }>()
    const forms = await c.db.prepare(`SELECT f.id, f.name, f.slug, f.is_open FROM admission_forms f
        WHERE EXISTS (SELECT 1 FROM admission_form_versions v WHERE v.form_id = f.id AND v.status = 'published') ORDER BY f.name`).all<{ id: string; name: string; slug: string; is_open: number }>()
    return ok({ items: rows.results.map((l) => view(l, origin)), forms: forms.results.map((f) => ({ ...f, is_open: !!f.is_open })),
      questions: QUESTIONS.map((q) => ({ key: q, label: LABEL[q] })), sources: SOURCES })
  })

  r.post('/admissions/enquiry-links', WRITE, async (c) => {
    const v = await readLink(c, await readJSON(c.req))
    const inst = c.id.institution!.id
    const base = slugOf(`${c.id.institution!.short_name || c.id.institution!.name} ${v.name}`) || 'enquiry'
    const id = uuid(), t = now()
    // The slug is the public address and is unique across every school; a taken one gets a short tail.
    for (let n = 0; n < 6; n++) {
      const slug = n === 0 ? base : `${base.slice(0, 50)}-${uuid().slice(0, 4)}`
      if (!validSlug(slug)) throw badRequest('that name cannot be made into a link; use letters and digits')
      try {
        await c.db.prepare(`INSERT INTO enquiry_links (id, institution_id, name, slug, source, is_open, heading, intro, thanks, ask, apply_form_id, created_by, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, inst, v.name, slug, v.source, v.open ? 1 : 0, v.heading, v.intro, v.thanks, v.ask, v.form, c.id.userId, t, t).run()
        const row = await c.db.prepare('SELECT * FROM enquiry_links WHERE id = ?').bind(id).first<LinkRow>()
        return created(view(row!, new URL(c.req.url).origin))
      } catch (e) {
        if (!isUniqueViolation(e)) throw e
        if (/enquiry_links_name|lower\(name\)/.test((e as Error).message)) throw new HttpError(409, 'a link with that name already exists', { code: 'name_taken' })
      }
    }
    throw new HttpError(409, 'could not find a free address for that link; try another name')
  })

  r.post('/admissions/enquiry-links/{id}', WRITE, async (c) => {
    const id = uuidParam(c.params.id)
    const existing = await c.db.prepare('SELECT * FROM enquiry_links WHERE id = ?').bind(id).first<LinkRow>()
    if (!existing) throw notFound('no such link')
    const v = await readLink(c, await readJSON(c.req), existing)
    try {
      // The address never changes once handed out: a poster cannot be reprinted.
      await c.db.prepare(`UPDATE enquiry_links SET name = ?, source = ?, is_open = ?, heading = ?, intro = ?, thanks = ?, ask = ?, apply_form_id = ?, updated_at = ? WHERE id = ?`)
        .bind(v.name, v.source, v.open ? 1 : 0, v.heading, v.intro, v.thanks, v.ask, v.form, now(), id).run()
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'a link with that name already exists', { code: 'name_taken' })
      throw e
    }
    const row = await c.db.prepare('SELECT * FROM enquiry_links WHERE id = ?').bind(id).first<LinkRow>()
    return ok(view(row!, new URL(c.req.url).origin))
  })

  r.del('/admissions/enquiry-links/{id}', WRITE, async (c) => {
    const id = uuidParam(c.params.id)
    const res = await c.db.prepare('DELETE FROM enquiry_links WHERE id = ?').bind(id).run()
    if (!(res.meta.changes ?? 0)) throw notFound('no such link')
    return ok({ id, deleted: true })
  })

  /* One lead's own way into the application: the open form's address with a
     signature naming this enquiry, and a message ready to send. */
  r.get('/admissions/workflow/enquiries/{id}/apply-link', READ, async (c) => {
    const id = uuidParam(c.params.id)
    const e = await c.db.prepare('SELECT student_name, parent_name FROM enquiries WHERE id = ?').bind(id).first<{ student_name: string; parent_name: string | null }>()
    if (!e) throw notFound('no such enquiry')
    const today = todayIST()
    const f = await c.db.prepare(`SELECT f.slug, f.name FROM admission_forms f
        WHERE f.is_open = 1 AND (f.opens_on IS NULL OR f.opens_on <= ?1) AND (f.closes_on IS NULL OR f.closes_on >= ?1)
          AND EXISTS (SELECT 1 FROM admission_form_versions v WHERE v.form_id = f.id AND v.status = 'published')
        ORDER BY f.updated_at DESC LIMIT 1`).bind(today).first<{ slug: string; name: string }>()
    if (!f) throw new HttpError(409, 'no application form is open. Publish and open one under Admissions > Application form.', { code: 'no_open_form' })
    const inst = c.id.institution!
    const path = `/admissions/apply/${f.slug}?lead=${await leadToken(c.env, inst.id, id)}`
    const url = new URL(c.req.url).origin + path
    const school = inst.short_name || inst.name
    // `{url}` is left for the caller to fill with the address families actually open (see `path`).
    return ok({ url, path, form: f.name, valid_days: 30,
      message: `Dear ${e.parent_name?.trim() || 'Parent'}, thank you for your interest in ${school}. You can fill in ${e.student_name}'s application here; we have filled in what you already told us: ${url}`,
      message_template: `Dear ${e.parent_name?.trim() || 'Parent'}, thank you for your interest in ${school}. You can fill in ${e.student_name}'s application here; we have filled in what you already told us: {url}` })
  })
}

// ---------------------------------------------------------------- telling the admissions desk

/* A lead that arrives at nine at night has to be seen in the morning. Every
   active person who may work enquiries (admissions.write, through a role or
   granted directly) gets a bell entry that opens the lead. One entry per
   person while it is unread: a second enquiry before they look updates it
   ("3 new enquiries", the latest named) instead of stacking another, the
   same way Class Status collapses a poster's posts. In-app only; nothing is
   sent by SMS or WhatsApp. */
function alertDesk(db: D1Database, inst: string, enquiryId: string, child: string, linkName: string, again: boolean): D1PreparedStatement[] {
  const at = now()
  const link = `/go/enquiries/enquiries?lead=${enquiryId}`
  const what = again ? `${child} asked again through "${linkName}"` : `${child}, through "${linkName}"`
  const desk = `SELECT DISTINCT u.id FROM users u WHERE u.status = 'active' AND (
        EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = u.id AND rp.permission_key = 'admissions.write')
     OR EXISTS (SELECT 1 FROM user_permissions up WHERE up.user_id = u.id AND up.permission_key = 'admissions.write'))`
  return [
    // An unread entry: count it up and name the latest.
    db.prepare(`UPDATE notifications SET
          title = 'New enquiries',
          body = ?, link = '/go/enquiries/enquiries', created_at = ?, pushed_at = NULL
        WHERE kind = 'enquiry' AND source_kind = 'enquiry_link' AND source_id = 'desk' AND read_at IS NULL AND dismissed_at IS NULL
          AND user_id IN (${desk})`).bind(`Latest: ${what}. Open the list to see them all.`, at),
    // Read, cleared or never had one: a fresh entry for this lead.
    db.prepare(`UPDATE notifications SET title = ?, body = ?, link = ?, created_at = ?, read_at = NULL, dismissed_at = NULL, pushed_at = NULL
        WHERE kind = 'enquiry' AND source_kind = 'enquiry_link' AND source_id = 'desk' AND (read_at IS NOT NULL OR dismissed_at IS NOT NULL)
          AND user_id IN (${desk})`).bind('New enquiry', `${what}. Due a call today.`, link, at),
    db.prepare(`INSERT INTO notifications (id, institution_id, user_id, kind, title, body, link, source_kind, source_id, created_at)
        SELECT lower(hex(randomblob(16))), ?, d.id, 'enquiry', 'New enquiry', ?, ?, 'enquiry_link', 'desk', ?
          FROM (${desk}) d
         WHERE NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = d.id AND n.kind = 'enquiry' AND n.source_kind = 'enquiry_link' AND n.source_id = 'desk')`)
      .bind(inst, `${what}. Due a call today.`, link, at),
  ]
}

// ---------------------------------------------------------------- the family's side (no session)

async function resolveLink(env: Env, slug: string): Promise<{ t: Tenant; link: LinkRow & { apply_slug: string | null } } | null> {
  const today = new Date().toISOString().slice(0, 10)
  const hits = await Promise.all((await allTenants(env)).map(async (t) => {
    const link = await t.db.prepare(`SELECT l.*, (SELECT f.slug FROM admission_forms f WHERE f.id = l.apply_form_id AND f.is_open = 1
            AND (f.opens_on IS NULL OR f.opens_on <= ?2) AND (f.closes_on IS NULL OR f.closes_on >= ?2)
            AND EXISTS (SELECT 1 FROM admission_form_versions v WHERE v.form_id = f.id AND v.status = 'published')) AS apply_slug
        FROM enquiry_links l WHERE l.slug = ?1`).bind(slug, today).first<LinkRow & { apply_slug: string | null }>().catch(() => null)
    return link ? { t, link } : null
  }))
  return hits.find((h) => h !== null) ?? null
}

async function getPublicEnquiry(env: Env, slug: string): Promise<Response> {
  const found = await resolveLink(env, slug)
  if (!found) return goNotFound()
  const { t, link } = found
  const classes = await t.db.prepare('SELECT id AS value, name AS label FROM classes ORDER BY level, name').all<{ value: string; label: string }>()
  const brand = await t.db.prepare('SELECT display_name FROM branding_profiles WHERE campus_id IS NULL LIMIT 1').first<{ display_name: string | null }>().catch(() => null)
  return json({
    school: brand?.display_name || t.inst.name, open: !!link.is_open,
    heading: link.heading || `Enquire about admission`, intro: link.intro ?? '', ask: cleanAsk(parseJSON(link.ask, {})), classes: classes.results,
  })
}

interface EnquiryBody { student_name?: string; parent_name?: string; phone?: string; email?: string; class_sought?: string; date_of_birth?: string
  current_school?: string; how_heard?: string; visit_date?: string; message?: string; website?: string }

async function submitPublicEnquiry(env: Env, req: Request, slug: string): Promise<Response> {
  const limited = await rateLimited(env, 'public_enquiry', WINDOW_S, BURST, callerAddress(req), 'too many enquiries from this connection. Please wait a few minutes and try again.')
  if (limited) return limited
  let body: EnquiryBody
  try { body = (await req.json()) as EnquiryBody } catch { return goBadRequest('malformed JSON body') }
  if (!body || typeof body !== 'object') return goBadRequest('malformed JSON body')
  const found = await resolveLink(env, slug)
  if (!found) return goNotFound()
  const { t, link } = found
  if (!link.is_open) return goError(409, 'closed', 'This enquiry form is closed. Please contact the school directly.')
  const thanks = link.thanks || 'Thank you. The school has your enquiry and will call you.'
  // A field no person sees: filled in only by a script. Answered as a success and dropped.
  if (short(body.website, 200) !== '') return json({ message: thanks }, 201)

  const ask = cleanAsk(parseJSON(link.ask, {}))
  const student = short(body.student_name, 120), parent = short(body.parent_name, 120), phoneRaw = short(body.phone, 30)
  const problems: string[] = []
  if (student.length < 2) problems.push("The child's name is required")
  if (parent.length < 2) problems.push("A parent's name is required")
  const digits = phoneRaw.replace(/[^0-9]/g, '')
  if (digits.length < 10 || digits.length > 15) problems.push('A phone number of at least 10 digits is required')
  const val: Record<Question, string> = {
    class_sought: short(body.class_sought, 40), email: short(body.email, 160).toLowerCase(), date_of_birth: short(body.date_of_birth, 10),
    current_school: short(body.current_school, 160), how_heard: short(body.how_heard, 120), visit_date: short(body.visit_date, 10), message: short(body.message, 1000),
  }
  for (const q of QUESTIONS) {
    if (ask[q] === 'off') { val[q] = ''; continue }
    if (ask[q] === 'required' && val[q] === '') problems.push(`${LABEL[q]} is required`)
  }
  if (val.email && (!val.email.includes('@') || val.email.startsWith('@') || val.email.endsWith('@'))) problems.push('Email must be an email address')
  if (val.date_of_birth && (!isYMD(val.date_of_birth) || val.date_of_birth > todayIST())) problems.push("The child's date of birth must be a past date")
  if (val.visit_date && (!isYMD(val.visit_date) || val.visit_date < todayIST())) problems.push('The day to visit must be today or later')
  let classID: string | null = null
  if (val.class_sought) {
    const cl = isUUIDish(val.class_sought) ? await t.db.prepare('SELECT id FROM classes WHERE id = ?').bind(val.class_sought.toLowerCase()).first<{ id: string }>() : null
    if (!cl) problems.push('Choose one of the classes offered')
    else classID = cl.id
  }
  if (problems.length) return goError(400, 'validation_failed', 'Some answers need attention.', { details: problems })

  const inst = t.inst.id, ts = now(), today = todayIST()
  const said = [
    val.date_of_birth && `Date of birth: ${val.date_of_birth}`, val.current_school && `Present school: ${val.current_school}`,
    val.how_heard && `Heard of us through: ${val.how_heard}`, val.visit_date && `Would like to visit on: ${val.visit_date}`, val.message && `Message: ${val.message}`,
  ].filter(Boolean).join('\n')
  const apply = async (enquiryId: string) => link.apply_slug
    ? `/admissions/apply/${link.apply_slug}?lead=${await leadToken(env, inst, enquiryId)}` : undefined

  /* The same child from the same number, still open: one lead. Phone numbers
     are compared by their last ten digits, as the duplicate check does. */
  const open = await t.db.prepare(`SELECT e.id, e.phone FROM enquiries e WHERE lower(e.student_name) = lower(?) AND e.status NOT IN ('lost', 'enrolled', 'admitted')
      ORDER BY e.created_at DESC LIMIT 50`).bind(student).all<{ id: string; phone: string }>()
  const same = open.results.find((e) => phoneKey(e.phone) === phoneKey(phoneRaw))
  if (same) {
    await t.db.batch([
      activityStmt(t.db, inst, same.id, 'note', { body: `Enquired again through "${link.name}".${said ? '\n' + said : ''}`, follow: today, author: null, at: ts }),
      t.db.prepare(`UPDATE enquiries SET next_follow_up = COALESCE(next_follow_up, ?), updated_at = ? WHERE id = ?`).bind(today, ts, same.id),
      ...alertDesk(t.db, inst, same.id, student, link.name, true),
    ])
    return json({ message: thanks, apply_url: await apply(same.id) }, 201)
  }

  const campus = link.campus_id ?? (await t.db.prepare('SELECT id FROM campuses ORDER BY created_at LIMIT 1').first<{ id: string }>())?.id
  if (!campus) return goInternal()
  const id = uuid()
  await t.db.batch([
    t.db.prepare(`INSERT INTO enquiries (id, institution_id, campus_id, student_name, parent_name, phone, email, class_sought, source, campaign, utm_source, utm_campaign,
          next_follow_up, notes, status, created_at, updated_at) VALUES (?,?,?,?,?,?,NULLIF(?, ''),?,?,?,?,?,?,NULLIF(?, ''),'new',?,?)`)
      .bind(id, inst, campus, student, parent, phoneRaw, val.email, classID, link.source, link.name, 'enquiry_link', link.slug, today, said, ts, ts),
    activityStmt(t.db, inst, id, 'created', { body: `Filled in by the family through "${link.name}".${said ? '\n' + said : ''}`, to: 'new', follow: today, author: null, at: ts }),
    ...alertDesk(t.db, inst, id, student, link.name, false),
  ])
  return json({ message: thanks, apply_url: await apply(id) }, 201)
}

/** GET/POST /api/v1/public/admissions/enquiry/{slug}; null for anything else. */
export async function handlePublicEnquiry(env: Env, req: Request, path: string): Promise<Response | null> {
  const m = /^\/api\/v1\/public\/admissions\/enquiry\/([^/]+)$/.exec(path)
  if (!m || (req.method !== 'GET' && req.method !== 'POST')) return null
  let slug: string
  try { slug = decodeURIComponent(m[1]).trim().toLowerCase() } catch { return goNotFound() }
  if (!validSlug(slug)) return goNotFound()
  try {
    return req.method === 'GET' ? await getPublicEnquiry(env, slug) : await submitPublicEnquiry(env, req, slug)
  } catch (err) {
    console.error(err)
    return goInternal()
  }
}
