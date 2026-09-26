import type { Router } from '../../router'
import { HttpError, badRequest, bool, created, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { customisableKinds, isUUIDish, isUniqueViolation, isYMD, istMinute, optionValue, str, type Option } from './util'
import { school } from '../school'

/* Port of the form builder half of admissions_growth.go (section 1): the form
   the school designs, its immutable published versions, and what one
   applicant answered. The public, unauthenticated surface is not in this block. */

const READ = 'admissions.read', WRITE = 'admissions.write'

const reservedFields = new Set(['first_name', 'middle_name', 'last_name', 'date_of_birth', 'gender', 'category', 'class_sought',
  'parent_name', 'parent_phone', 'parent_email', 'address', 'previous_school'])
const requiredReserved = ['first_name', 'parent_name', 'parent_phone', 'class_sought']
const fieldTypes = ['text', 'textarea', 'number', 'date', 'select', 'checkbox', 'file', 'email', 'phone']

function validFormSlug(s: string): boolean {
  if (s.length < 3 || s.length > 64) return false
  return [...s].every((r, i) => (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || (r === '-' && i > 0))
}
function validFieldCode(s: string): boolean {
  if (s.length < 2 || s.length > 49) return false
  if (s[0] < 'a' || s[0] > 'z') return false
  return [...s].every((r) => (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r === '_')
}
function formSlug(name: string): string {
  let v = optionValue(name).split('_').join('-')
  if (v.length > 64) v = v.slice(0, 64).replace(/^-+|-+$/g, '')
  return v
}
function optionalDate(raw: unknown, name: string): string | null {
  const v = str(raw).trim()
  if (v === '') return null
  if (!isYMD(v)) throw badRequest(`${name} must be YYYY-MM-DD`)
  return v
}
function optionalUUID(raw: unknown, name: string): string | null {
  const v = str(raw).trim()
  if (v === '') return null
  if (!isUUIDish(v)) throw badRequest(`${name} must be a uuid`)
  return v
}

interface VisibilityRule { field: string; equals: string }
interface FormField {
  id: string; section_id: string; code: string; label: string; field_type: string; help_text?: string; placeholder?: string
  is_required: boolean; sequence: number; options: Option[]; option_kind?: string; min_length?: number; max_length?: number
  min_number?: number; max_number?: number; pattern?: string; visible_when?: VisibilityRule; reserved: boolean
}
interface FormSection { id: string; title: string; description?: string; sequence: number; fields: FormField[] }
export interface FormDefinition {
  version_id: string; form_id: string; form_name: string; slug: string; version: number; status: string; editable: boolean
  sections: FormSection[]; classes: Option[]
}

const omitNull = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}

/** loadFormDefinition: one whole version, the same for the builder and the renderer. */
export async function loadFormDefinition(db: D1Database, versionID: string): Promise<FormDefinition | null> {
  const v = await db.prepare(`SELECT v.id AS version_id, v.form_id, f.name AS form_name, f.slug, v.version, v.status
      FROM admission_form_versions v JOIN admission_forms f ON f.id = v.form_id WHERE v.id = ?`).bind(versionID)
    .first<{ version_id: string; form_id: string; form_name: string; slug: string; version: number; status: string }>()
  if (!v) return null
  const def: FormDefinition = { ...v, editable: v.status === 'draft', sections: [], classes: [] }
  const secs = await db.prepare(`SELECT id, title, description, sequence FROM admission_form_sections WHERE version_id = ? ORDER BY sequence, lower(title)`).bind(versionID)
    .all<{ id: string; title: string; description: string | null; sequence: number }>()
  const index = new Map<string, FormSection>()
  for (const s of secs.results) {
    const sec: FormSection = omitNull({ id: s.id, title: s.title, description: s.description ?? undefined, sequence: s.sequence, fields: [] })
    index.set(s.id, sec)
    def.sections.push(sec)
  }
  const fields = await db.prepare(`SELECT id, section_id, code, label, field_type, help_text, placeholder, is_required, sequence, options, option_kind,
      min_length, max_length, min_number, max_number, pattern, visible_when FROM admission_form_fields WHERE version_id = ? ORDER BY sequence, lower(label)`)
    .bind(versionID).all<Record<string, unknown>>()
  for (const f of fields.results) {
    let opts: Option[] = []
    try { opts = JSON.parse(str(f.options) || '[]') } catch { opts = [] }
    let vis: VisibilityRule | undefined
    try { const raw = JSON.parse(str(f.visible_when) || '{}'); if (raw && raw.field) vis = { field: String(raw.field), equals: String(raw.equals ?? '') } } catch { /* unreadable rule is no rule */ }
    const numOr = (x: unknown) => (x === null || x === undefined ? undefined : Number(x))
    const field: FormField = omitNull({
      id: str(f.id), section_id: str(f.section_id), code: str(f.code), label: str(f.label), field_type: str(f.field_type),
      help_text: (f.help_text as string | null) ?? undefined, placeholder: (f.placeholder as string | null) ?? undefined,
      is_required: bool(f.is_required), sequence: Number(f.sequence), options: opts, option_kind: (f.option_kind as string | null) ?? undefined,
      min_length: numOr(f.min_length), max_length: numOr(f.max_length), min_number: numOr(f.min_number), max_number: numOr(f.max_number),
      pattern: (f.pattern as string | null) ?? undefined, visible_when: vis, reserved: reservedFields.has(str(f.code)),
    })
    index.get(field.section_id)?.fields.push(field)
  }
  const classes = await db.prepare(`SELECT id AS value, name AS label FROM classes ORDER BY level, name`).all<Option>()
  def.classes = classes.results
  return def
}

async function requireDraft(db: D1Database, versionID: string): Promise<void> {
  const row = await db.prepare(`SELECT status FROM admission_form_versions WHERE id = ?`).bind(versionID).first<{ status: string }>()
  if (!row) throw notFound()
  if (row.status !== 'draft') throw new HttpError(409, 'this version is live and cannot be edited. Take a draft from it. Applications already submitted must keep rendering as they were answered.', { code: 'version_published' })
}

function versionEditError(e: unknown): never {
  if (e instanceof HttpError) throw e
  if (isUniqueViolation(e)) throw new HttpError(409, 'that name or code is already used on this version', { code: 'duplicate' })
  throw badRequest(e instanceof Error ? e.message : String(e))
}

export function registerAdmissionForms(r: Router) {
  r.get('/admissions/forms', READ, async (c) => {
    const rows = await c.db.prepare(`
      SELECT f.id, f.name, f.description, f.slug, f.is_open, f.opens_on, f.closes_on,
             (SELECT v.version FROM admission_form_versions v WHERE v.form_id = f.id AND v.status = 'published') AS live_version,
             (SELECT v.version FROM admission_form_versions v WHERE v.form_id = f.id AND v.status = 'draft') AS draft_version,
             (SELECT count(*) FROM applications a JOIN admission_form_versions v ON v.id = a.form_version_id WHERE v.form_id = f.id) AS submissions
        FROM admission_forms f ORDER BY f.is_open DESC, lower(f.name)`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({
      id: v.id, name: v.name, description: v.description, slug: v.slug, is_open: bool(v.is_open), opens_on: v.opens_on, closes_on: v.closes_on,
      live_version: v.live_version, draft_version: v.draft_version, submissions: v.submissions })) })
  })

  r.post('/admissions/forms', WRITE, async (c) => {
    const req = await readJSON(c.req)
    const name = str(req.name).trim()
    if (name === '') throw badRequest('the form needs a name')
    let slug = str(req.slug).trim().toLowerCase()
    if (slug === '') slug = formSlug(name)
    if (!validFormSlug(slug)) throw badRequest('the web address must be 3-64 characters of lowercase letters, digits and hyphens')
    const campus = optionalUUID(req.campus_id, 'campus_id')
    const session = optionalUUID(req.admission_session_id, 'admission_session_id')
    const opens = optionalDate(req.opens_on, 'opens_on')
    const closes = optionalDate(req.closes_on, 'closes_on')
    const formID = uuid(), versionID = uuid(), t = now()
    try {
      await c.db.batch([
        c.db.prepare(`INSERT INTO admission_forms (id, institution_id, campus_id, admission_session_id, name, description, slug, is_open, opens_on, closes_on, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,NULLIF(?,''),?,?,?,?,?,?,?)`)
          .bind(formID, school(c).id, campus, session, name, str(req.description), slug, req.is_open ? 1 : 0, opens, closes, c.id.userId, t, t),
        c.db.prepare(`INSERT INTO admission_form_versions (id, institution_id, form_id, version, status, created_at, updated_at) VALUES (?,?,?,1,'draft',?,?)`)
          .bind(versionID, school(c).id, formID, t, t),
      ])
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'a form with that name or that web address already exists', { code: 'duplicate' })
      throw e
    }
    return created({ id: formID, slug, draft_version_id: versionID })
  })

  r.post('/admissions/forms/{id}', WRITE, async (c) => {
    const formID = uuidParam(c.params.id)
    const req = await readJSON(c.req)
    const name = str(req.name).trim()
    if (name === '') throw badRequest('the form needs a name')
    const opens = optionalDate(req.opens_on, 'opens_on')
    const closes = optionalDate(req.closes_on, 'closes_on')
    const live = await c.db.prepare(`SELECT count(*) AS n FROM admission_form_versions WHERE form_id = ? AND status = 'published'`).bind(formID).first<{ n: number }>()
    if (req.is_open && (live?.n ?? 0) === 0) {
      throw new HttpError(409, 'publish a version before opening the form. An open form with no definition is a broken link on a poster', { code: 'not_published' })
    }
    let res: D1Response
    try {
      res = await c.db.prepare(`UPDATE admission_forms SET name = ?, description = NULLIF(?,''), is_open = ?, opens_on = ?, closes_on = ?, updated_at = ? WHERE id = ?`)
        .bind(name, str(req.description), req.is_open ? 1 : 0, opens, closes, now(), formID).run()
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'another form already has that name', { code: 'duplicate' })
      throw e
    }
    if (res.meta.changes === 0) throw notFound()
    return ok({ id: formID })
  })

  r.get('/admissions/forms/{id}/versions', READ, async (c) => {
    const formID = uuidParam(c.params.id)
    const rows = await c.db.prepare(`
      SELECT v.id, v.version, v.status, v.notes, ${istMinute('v.published_at')} AS published_at,
             (SELECT count(*) FROM admission_form_fields f WHERE f.version_id = v.id) AS fields,
             (SELECT count(*) FROM applications a WHERE a.form_version_id = v.id) AS applications
        FROM admission_form_versions v WHERE v.form_id = ? ORDER BY v.version DESC`).bind(formID).all<Record<string, unknown>>()
    return ok({ items: rows.results.map(omitNull) })
  })

  r.post('/admissions/forms/{id}/draft', WRITE, async (c) => {
    const formID = uuidParam(c.params.id)
    const existing = await c.db.prepare(`SELECT id FROM admission_form_versions WHERE form_id = ? AND status = 'draft'`).bind(formID).first<{ id: string }>()
    if (existing) return ok({ draft_version_id: existing.id })
    const form = await c.db.prepare(`SELECT institution_id FROM admission_forms WHERE id = ?`).bind(formID).first<{ institution_id: string }>()
    if (!form) throw notFound()
    const src = await c.db.prepare(`SELECT (SELECT id FROM admission_form_versions WHERE form_id = ? AND status = 'published') AS source_id,
        COALESCE(max(version), 0) + 1 AS next FROM admission_form_versions WHERE form_id = ?`).bind(formID, formID).first<{ source_id: string | null; next: number }>()
    const draftID = uuid(), t = now()
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`INSERT INTO admission_form_versions (id, institution_id, form_id, version, status, created_at, updated_at) VALUES (?,?,?,?,'draft',?,?)`)
        .bind(draftID, form.institution_id, formID, src?.next ?? 1, t, t),
    ]
    if (src?.source_id) {
      // Sections first, each with a fresh id; then fields keyed through the section they came from by title.
      const secs = await c.db.prepare(`SELECT institution_id, title, description, sequence FROM admission_form_sections WHERE version_id = ?`).bind(src.source_id)
        .all<{ institution_id: string; title: string; description: string | null; sequence: number }>()
      const secIds = new Map<string, string>()
      for (const s of secs.results) {
        const sid = uuid()
        secIds.set(s.title.toLowerCase(), sid)
        stmts.push(c.db.prepare(`INSERT INTO admission_form_sections (id, institution_id, version_id, title, description, sequence) VALUES (?,?,?,?,?,?)`)
          .bind(sid, s.institution_id, draftID, s.title, s.description, s.sequence))
      }
      const fields = await c.db.prepare(`SELECT f.*, os.title AS section_title FROM admission_form_fields f JOIN admission_form_sections os ON os.id = f.section_id WHERE f.version_id = ?`)
        .bind(src.source_id).all<Record<string, unknown>>()
      for (const f of fields.results) {
        const sid = secIds.get(str(f.section_title).toLowerCase())
        if (!sid) continue
        stmts.push(c.db.prepare(`INSERT INTO admission_form_fields (id, institution_id, version_id, section_id, code, label, field_type, help_text, placeholder,
            is_required, sequence, options, option_kind, min_length, max_length, min_number, max_number, pattern, visible_when, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(uuid(), f.institution_id, draftID, sid, f.code, f.label, f.field_type, f.help_text, f.placeholder, f.is_required, f.sequence, f.options,
            f.option_kind, f.min_length, f.max_length, f.min_number, f.max_number, f.pattern, f.visible_when, t))
      }
    }
    await c.db.batch(stmts)
    return ok({ draft_version_id: draftID })
  })

  r.get('/admissions/form-versions/{id}', READ, async (c) => {
    const def = await loadFormDefinition(c.db, uuidParam(c.params.id))
    if (!def) throw notFound()
    return ok(def)
  })

  r.post('/admissions/form-versions/{id}/publish', WRITE, async (c) => {
    const versionID = uuidParam(c.params.id)
    const v = await c.db.prepare(`SELECT form_id, status, version FROM admission_form_versions WHERE id = ?`).bind(versionID)
      .first<{ form_id: string; status: string; version: number }>()
    if (!v) throw notFound()
    if (v.status !== 'draft') throw new HttpError(409, 'only a draft can be published', { code: 'not_a_draft' })
    const def = (await loadFormDefinition(c.db, versionID))!
    const present = new Set<string>()
    let total = 0
    for (const sec of def.sections) for (const f of sec.fields) { present.add(f.code); total++ }
    if (total === 0) throw badRequest('this version has no fields. Publishing it would put an empty form on a poster')
    const missing = requiredReserved.filter((code) => !present.has(code))
    if (missing.length > 0) {
      throw badRequest(`an application cannot be created without ${missing.join(', ')}. Add ${missing.join(' and ')} as field codes before publishing`)
    }
    const t = now()
    await c.db.batch([
      c.db.prepare(`UPDATE admission_form_versions SET status = 'retired', updated_at = ? WHERE form_id = ? AND status = 'published'`).bind(t, v.form_id),
      c.db.prepare(`UPDATE admission_form_versions SET status = 'published', published_at = ?, published_by = ?, updated_at = ? WHERE id = ?`).bind(t, c.id.userId, t, versionID),
    ])
    return ok({ id: versionID, version: v.version, status: 'published' })
  })

  r.post('/admissions/form-versions/{id}/sections', WRITE, async (c) => {
    const versionID = uuidParam(c.params.id)
    const req = await readJSON(c.req)
    const title = str(req.title).trim()
    if (title === '') throw badRequest('the section needs a heading')
    const secID = optionalUUID(req.id, 'id')
    const sequence = typeof req.sequence === 'number' ? req.sequence : 0
    try {
      await requireDraft(c.db, versionID)
      if (secID) {
        const res = await c.db.prepare(`UPDATE admission_form_sections SET title = ?, description = NULLIF(?,''), sequence = ? WHERE id = ? AND version_id = ?`)
          .bind(title, str(req.description), sequence, secID, versionID).run()
        if (res.meta.changes === 0) throw notFound()
        return ok({ id: secID })
      }
      const v = await c.db.prepare(`SELECT institution_id FROM admission_form_versions WHERE id = ?`).bind(versionID).first<{ institution_id: string }>()
      if (!v) throw notFound()
      const id = uuid()
      await c.db.prepare(`INSERT INTO admission_form_sections (id, institution_id, version_id, title, description, sequence) VALUES (?,?,?,?,NULLIF(?,''),?)`)
        .bind(id, v.institution_id, versionID, title, str(req.description), sequence).run()
      return ok({ id })
    } catch (e) { versionEditError(e) }
  })

  r.del('/admissions/form-sections/{id}', WRITE, async (c) => {
    const secID = uuidParam(c.params.id)
    try {
      const sec = await c.db.prepare(`SELECT version_id FROM admission_form_sections WHERE id = ?`).bind(secID).first<{ version_id: string }>()
      if (!sec) throw notFound()
      await requireDraft(c.db, sec.version_id)
      await c.db.prepare(`DELETE FROM admission_form_sections WHERE id = ?`).bind(secID).run()
      return ok({ id: secID, deleted: true })
    } catch (e) { versionEditError(e) }
  })

  r.post('/admissions/form-versions/{id}/fields', WRITE, async (c) => {
    const versionID = uuidParam(c.params.id)
    const req = await readJSON(c.req)
    let code = str(req.code).trim().toLowerCase()
    const label = str(req.label).trim()
    const fieldType = str(req.field_type).trim()
    if (code === '') code = optionValue(label)
    if (label === '') throw badRequest('the field needs a label')
    if (!validFieldCode(code)) throw badRequest('the field code must start with a letter and hold only lowercase letters, digits and underscores')
    if (!fieldTypes.includes(fieldType)) throw badRequest('field_type must be one of ' + fieldTypes.join(', '))
    const options = Array.isArray(req.options) ? (req.options as Option[]) : null
    const optionKind = str(req.option_kind)
    if (fieldType === 'select' && (options?.length ?? 0) === 0 && optionKind === '' && code !== 'class_sought') {
      throw badRequest('a dropdown needs either its own options or the name of a school list to draw them from')
    }
    if (optionKind !== '' && !(optionKind in customisableKinds)) throw badRequest('unknown school list: ' + optionKind)
    const visible = (req.visible_when && typeof req.visible_when === 'object') ? (req.visible_when as VisibilityRule) : null
    if (visible && visible.field === code) throw badRequest('a field cannot be conditional on its own answer')
    const sectionID = str(req.section_id).trim()
    if (!isUUIDish(sectionID)) throw badRequest('section_id must be a uuid')
    const fieldID = optionalUUID(req.id, 'id')
    const opts = JSON.stringify(options ?? [])
    const vis = visible && str(visible.field).trim() !== '' ? JSON.stringify(visible) : '{}'
    const sequence = typeof req.sequence === 'number' ? req.sequence : 0
    const numOrNull = (x: unknown) => (typeof x === 'number' ? x : null)
    try {
      await requireDraft(c.db, versionID)
      const n = await c.db.prepare(`SELECT count(*) AS n FROM admission_form_sections WHERE id = ? AND version_id = ?`).bind(sectionID, versionID).first<{ n: number }>()
      if ((n?.n ?? 0) === 0) throw badRequest('that section does not belong to this version of the form')
      if (visible) {
        const m = await c.db.prepare(`SELECT count(*) AS n FROM admission_form_fields WHERE version_id = ? AND code = ?`).bind(versionID, visible.field).first<{ n: number }>()
        if ((m?.n ?? 0) === 0) throw badRequest('visible_when names a field this version does not have: ' + visible.field)
      }
      const args = [sectionID, code, label, fieldType, str(req.help_text), str(req.placeholder), req.is_required ? 1 : 0, sequence, opts, optionKind,
        numOrNull(req.min_length), numOrNull(req.max_length), numOrNull(req.min_number), numOrNull(req.max_number), str(req.pattern), vis]
      if (fieldID) {
        const res = await c.db.prepare(`UPDATE admission_form_fields SET section_id = ?, code = ?, label = ?, field_type = ?, help_text = NULLIF(?,''), placeholder = NULLIF(?,''),
            is_required = ?, sequence = ?, options = ?, option_kind = NULLIF(?,''), min_length = ?, max_length = ?, min_number = ?, max_number = ?, pattern = NULLIF(?,''), visible_when = ?
          WHERE id = ? AND version_id = ?`).bind(...args, fieldID, versionID).run()
        if (res.meta.changes === 0) throw notFound()
        return ok({ id: fieldID })
      }
      const v = await c.db.prepare(`SELECT institution_id FROM admission_form_versions WHERE id = ?`).bind(versionID).first<{ institution_id: string }>()
      if (!v) throw notFound()
      const id = uuid()
      await c.db.prepare(`INSERT INTO admission_form_fields (id, institution_id, version_id, section_id, code, label, field_type, help_text, placeholder, is_required, sequence,
          options, option_kind, min_length, max_length, min_number, max_number, pattern, visible_when, created_at)
        VALUES (?,?,?,?,?,?,?,NULLIF(?,''),NULLIF(?,''),?,?,?,NULLIF(?,''),?,?,?,?,NULLIF(?,''),?,?)`)
        .bind(id, v.institution_id, versionID, ...args, now()).run()
      return ok({ id })
    } catch (e) { versionEditError(e) }
  })

  r.del('/admissions/form-fields/{id}', WRITE, async (c) => {
    const fieldID = uuidParam(c.params.id)
    try {
      const f = await c.db.prepare(`SELECT version_id FROM admission_form_fields WHERE id = ?`).bind(fieldID).first<{ version_id: string }>()
      if (!f) throw notFound()
      await requireDraft(c.db, f.version_id)
      await c.db.prepare(`DELETE FROM admission_form_fields WHERE id = ?`).bind(fieldID).run()
      return ok({ id: fieldID, deleted: true })
    } catch (e) { versionEditError(e) }
  })

  r.get('/admissions/applications/{id}/answers', READ, async (c) => {
    const appID = uuidParam(c.params.id)
    const rows = await c.db.prepare(`
      SELECT sec.title AS section, f.code, f.label, f.field_type,
             COALESCE(CASE WHEN f.code = 'class_sought' THEN (SELECT cl.name FROM classes cl WHERE cl.id = ans.value_text) END,
                      ans.value_text, ans.value_number, ans.value_date,
                      CASE WHEN ans.value_bool IS NOT NULL THEN CASE WHEN ans.value_bool THEN 'Yes' ELSE 'No' END END, '') AS value,
             ans.file_id, ans.external_url
        FROM application_form_answers ans
        JOIN admission_form_fields f ON f.id = ans.field_id
        JOIN admission_form_sections sec ON sec.id = f.section_id
       WHERE ans.application_id = ?
       ORDER BY sec.sequence, sec.title, f.sequence, f.label`).bind(appID).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => omitNull({ section: v.section, code: v.code, label: v.label, field_type: v.field_type, value: String(v.value ?? ''), file_id: v.file_id, external_url: v.external_url })) })
  })
}

