import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, clampInt, created, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { tenantDb, type Institution } from '../../tenant'
import { institutionId, notImplemented, parseJSON, platformOnly, requireAny, today } from './common'
import { school } from '../school'

/* Port of internal/api/platform_config.go: statutory masters, board
   affiliation and disclosure, board rules, SQAA, campus classification, the
   calendar model, branding, franchises, numbering, auth policy, backups,
   vendor tickets, impersonation, adoption, health and entitlements.

   Cross-school reads (fleet, adoption, health, entitlements, franchises)
   take the school list from CONTROL and open each school's D1 by its
   binding; a school with no binding is skipped. Tables that were shared
   platform tables in Postgres but exist only in the tenant schema here
   (location_codes, sqaa_*, franchises, franchise_members) are read and
   written in the acting school's database. */

const NIL = '00000000-0000-0000-0000-000000000000'
type Option = { value: string; label: string }
const opt = (v: string, l: string): Option => ({ value: v, label: l })
const nz = (s: unknown) => { const v = typeof s === 'string' ? s.trim() : ''; return v === '' ? null : v }
const und = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v)

/** Every active school with a D1 binding, for the fleet reads. */
async function fleet(c: Ctx): Promise<{ inst: Institution; db: D1Database }[]> {
  const insts = await c.env.CONTROL.prepare(`SELECT * FROM institutions WHERE status = 'active' ORDER BY name`).all<Institution>()
  const out: { inst: Institution; db: D1Database }[] = []
  for (const inst of insts.results) { try { out.push({ inst, db: tenantDb(c.env, inst) }) } catch { /* not provisioned */ } }
  return out
}

async function deleteOwnedRow(c: Ctx, table: string): Promise<Response> {
  const inst = institutionId(c)
  if (!isUUID(c.params.id)) throw badRequest('id must be a uuid')
  const res = await c.db.prepare(`DELETE FROM ${table} WHERE id = ? AND institution_id = ?`).bind(c.params.id, inst).run()
  if ((res.meta.changes ?? 0) === 0) throw notFound('resource not found')
  return ok({ deleted: true })
}

const daysBetween = (to: string | null, from: string): number | undefined => {
  if (!to) return undefined
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000)
}

/** fees.FinancialYear: "2026-27" for a date on or after 1 April. */
export function financialYear(d = new Date(Date.now() + 5.5 * 3_600_000)): string {
  let y = d.getUTCFullYear()
  if (d.getUTCMonth() < 3) y--
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`
}

// --- vocabularies ----------------------------------------------------------------

const DISCLOSURE_KINDS = [
  opt('affiliation_certificate', 'Affiliation / recognition certificate'), opt('trust_deed', 'Trust, society or company registration'),
  opt('noc_state', 'State government NOC'), opt('recognition_certificate', 'Recognition certificate under RTE'),
  opt('building_safety', 'Building safety certificate'), opt('fire_safety', 'Fire safety certificate'),
  opt('water_sanitation', 'Water, health and sanitation certificate'), opt('deo_certificate', 'DEO certificate'),
  opt('land_certificate', 'Land certificate'), opt('fee_structure', 'Fee structure as published'),
  opt('managing_committee', 'Managing committee / SMC composition'), opt('annual_report', 'Annual report and audited accounts'),
]
// affiliationBoards, managementTypes and schoolCategories live in setup_profile.go; the same vocabularies.
const AFFILIATION_BOARDS = [opt('CBSE', 'CBSE'), opt('CISCE', 'CISCE (ICSE / ISC)'), opt('BSE_TS', 'Board of Secondary Education, Telangana'), opt('TSBIE', 'TS Board of Intermediate Education'),
  opt('IB', 'International Baccalaureate'), opt('IGCSE', 'Cambridge IGCSE'), opt('OTHER', 'Other')]
const MANAGEMENT_TYPES = [opt('government', 'Government'), opt('local_body', 'Local body'), opt('aided', 'Private aided'), opt('unaided', 'Private unaided'), opt('central', 'Central government'), opt('other', 'Other')]
const SCHOOL_CATEGORIES = [opt('primary', 'Primary'), opt('upper_primary', 'Upper primary'), opt('secondary', 'Secondary'), opt('higher_secondary', 'Higher secondary')]
const PLAT_BOARDS = [opt('bse_ts_ssc', 'BSE Telangana, SSC (class X)'), opt('tsbie', 'TSBIE, Intermediate (classes XI–XII)'), opt('cbse', 'CBSE'), opt('icse', 'CISCE, ICSE / ISC'), opt('igcse', 'Cambridge IGCSE'), opt('ib', 'International Baccalaureate'), opt('other', 'Other')]
const PLAT_STAGES = [opt('primary', 'Primary (I–V)'), opt('upper_primary', 'Upper primary (VI–VIII)'), opt('secondary', 'Secondary (IX–X)'), opt('higher_secondary', 'Higher secondary (XI–XII)')]
const EXAM_PATTERNS = [opt('formative_summative', 'Formative and summative (FA/SA)'), opt('term_annual', 'Term tests and an annual examination'), opt('continuous', 'Continuous and comprehensive'), opt('semester', 'Semester')]
const NUMBERING_KINDS = [opt('receipt', 'Fee receipt'), opt('invoice', 'Fee invoice'), opt('admission', 'Admission number'), opt('student_id', 'Student ID card'), opt('employee', 'Employee code'),
  opt('certificate', 'Certificate serial'), opt('transfer_certificate', 'Transfer certificate'), opt('voucher', 'Accounting voucher')]
const VENDOR_CATEGORIES = new Set(['fault', 'data', 'performance', 'integration', 'training', 'billing', 'feature_request', 'other'])

const previewNumber = (prefix: string, suffix: string, padding: number, next: number, yearly: boolean) =>
  yearly ? `${prefix}${financialYear()}/${String(next).padStart(padding, '0')}${suffix}` : `${prefix}${String(next).padStart(padding, '0')}${suffix}`

function backupLapsed(frequency: string, ageHours: number | undefined): boolean {
  if (ageHours === undefined) return true
  switch (frequency) { case 'hourly': return ageHours > 2; case 'weekly': return ageHours > 24 * 14; default: return ageHours > 48 }
}

// --- reads shared by a save and its GET -------------------------------------------

async function getBoardAffiliation(c: Ctx): Promise<Response> {
  const inst = institutionId(c)
  const t = today(c)
  const i = await c.db.prepare(`SELECT affiliation_board, affiliation_no, affiliation_valid_to, udise_code FROM institutions WHERE id = ?`).bind(inst)
    .first<{ affiliation_board: string | null; affiliation_no: string | null; affiliation_valid_to: string | null; udise_code: string | null }>()
  if (!i) throw notFound('resource not found')
  const docs = await c.db.prepare(`SELECT d.id, d.campus_id, c.name AS campus, d.document, d.title, d.reference_no, d.issuing_authority, d.issued_on, d.valid_to, d.file_key, d.public_url, d.notes
      FROM board_disclosures d LEFT JOIN campuses c ON c.id = d.campus_id ORDER BY (d.valid_to IS NULL), d.valid_to, d.document`).all<Record<string, string | null>>()
  const documents = docs.results.map((d) => ({ id: d.id, campus_id: und(d.campus_id), campus: und(d.campus), document: d.document, title: d.title, reference_no: und(d.reference_no),
    issuing_authority: und(d.issuing_authority), issued_on: und(d.issued_on), valid_to: und(d.valid_to), file_key: und(d.file_key), public_url: und(d.public_url), notes: und(d.notes),
    days_to_expiry: daysBetween(d.valid_to, t) }))
  let expired = 0, expiring = 0
  for (const d of documents) { if (d.days_to_expiry === undefined) continue; if (d.days_to_expiry < 0) expired++; else if (d.days_to_expiry <= 90) expiring++ }
  return ok({ affiliation_board: und(i.affiliation_board), affiliation_no: und(i.affiliation_no), affiliation_valid_to: und(i.affiliation_valid_to), udise_code: und(i.udise_code),
    days_to_renewal: daysBetween(i.affiliation_valid_to, t), documents, document_kinds: DISCLOSURE_KINDS, boards: AFFILIATION_BOARDS, recorded: documents.length, expired, expiring_90_days: expiring })
}

async function getCalendarModel(c: Ctx): Promise<Response> {
  const inst = institutionId(c)
  const out = { school_year_start_month: 6, school_year_end_month: 4, financial_year_start_month: 4, term_count: 3, week_start_day: 1, working_days_per_week: 6,
    saturday_pattern: 'all', required_working_days: 220, school_year_label: '', financial_year_label: '', academic_years: [] as unknown[], current_terms: 0 }
  const m = await c.db.prepare(`SELECT * FROM academic_calendar_models WHERE institution_id = ?`).bind(inst).first<Record<string, number | string>>()
  if (m) Object.assign(out, { school_year_start_month: m.school_year_start_month, school_year_end_month: m.school_year_end_month, financial_year_start_month: m.financial_year_start_month,
    term_count: m.term_count, week_start_day: m.week_start_day, working_days_per_week: m.working_days_per_week, saturday_pattern: m.saturday_pattern, required_working_days: m.required_working_days })
  const years = await c.db.prepare(`SELECT y.id, y.name, y.starts_on, y.ends_on, y.is_current, (SELECT count(*) FROM terms t WHERE t.academic_year_id = y.id) AS terms, CAST(substr(y.starts_on, 6, 2) AS INTEGER) AS sm
      FROM academic_years y ORDER BY y.starts_on DESC`).all<{ id: string; name: string; starts_on: string; ends_on: string; is_current: number; terms: number; sm: number }>()
  for (const y of years.results) {
    if (y.is_current) out.current_terms = y.terms
    out.academic_years.push({ id: y.id, name: y.name, starts_on: y.starts_on, ends_on: y.ends_on, is_current: !!y.is_current, terms: y.terms, matches_model: y.sm === Number(out.school_year_start_month) })
  }
  const ist = new Date(Date.now() + 5.5 * 3_600_000)
  let sy = ist.getUTCFullYear()
  if (ist.getUTCMonth() + 1 < Number(out.school_year_start_month)) sy--
  out.school_year_label = `${sy}-${String((sy + 1) % 100).padStart(2, '0')}`
  out.financial_year_label = financialYear(ist)
  return ok(out)
}

async function getNumberingAndTemplates(c: Ctx): Promise<Response> {
  institutionId(c)
  const [schemes, templates, campuses] = await c.db.batch<Record<string, unknown>>([
    c.db.prepare(`SELECT n.id, n.campus_id, c.name AS campus, n.kind, n.prefix, n.suffix, n.padding, n.next_value, n.reset_yearly FROM numbering_schemes n LEFT JOIN campuses c ON c.id = n.campus_id ORDER BY n.kind, (n.campus_id IS NOT NULL), n.campus_id`),
    c.db.prepare(`SELECT id, code, name, requires_approval, template_html IS NOT NULL AND template_html <> '' AS has_template, COALESCE(length(template_html), 0) AS template_length FROM certificate_types ORDER BY name`),
    c.db.prepare(`SELECT id AS value, name AS label FROM campuses ORDER BY name`),
  ])
  return ok({
    items: schemes.results.map((n) => ({ id: n.id, campus_id: und(n.campus_id as string | null), campus: und(n.campus as string | null), kind: n.kind, prefix: n.prefix, suffix: n.suffix, padding: n.padding, next_value: n.next_value,
      reset_yearly: !!n.reset_yearly, preview: previewNumber(String(n.prefix), String(n.suffix), Number(n.padding), Number(n.next_value), !!n.reset_yearly) })),
    templates: templates.results.map((t) => ({ id: t.id, code: t.code, name: t.name, requires_approval: !!t.requires_approval, has_template: !!t.has_template, template_length: t.template_length })),
    kinds: NUMBERING_KINDS, campuses: campuses.results, financial_year: financialYear(),
  })
}

async function getAuthPolicy(c: Ctx): Promise<Response> {
  const inst = institutionId(c)
  const out: Record<string, unknown> = { mfa_required_roles: [] as string[], mfa_grace_days: 7, password_min_length: 10, password_expiry_days: 0, session_idle_minutes: 120, allowed_email_domains: [] as string[],
    sso_enabled: false, sso_protocol: undefined, sso_provider: undefined, sso_entity_id: undefined, sso_metadata_url: undefined, sso_verified_at: undefined,
    users: 0, mfa_enrolled: 0, users_covered_by_rule: 0, users_covered_without_mfa: 0, roles: [] as Option[], sso_available: false,
    sso_blocked_by: 'No SAML or OIDC adapter is built and no identity provider is connected. The configuration below is stored and will be read by the sign-in page once an adapter exists; it does not change how anyone signs in today.' }
  const p = await c.db.prepare(`SELECT * FROM auth_policies WHERE institution_id = ?`).bind(inst).first<Record<string, unknown>>()
  if (p) Object.assign(out, { mfa_required_roles: parseJSON<string[]>(p.mfa_required_roles, []), mfa_grace_days: p.mfa_grace_days, password_min_length: p.password_min_length, password_expiry_days: p.password_expiry_days,
    session_idle_minutes: p.session_idle_minutes, allowed_email_domains: parseJSON<string[]>(p.allowed_email_domains, []), sso_enabled: !!p.sso_enabled, sso_protocol: und(p.sso_protocol as string | null),
    sso_provider: und(p.sso_provider as string | null), sso_entity_id: und(p.sso_entity_id as string | null), sso_metadata_url: und(p.sso_metadata_url as string | null), sso_verified_at: und(p.sso_verified_at as string | null) })
  const roles = out.mfa_required_roles as string[]
  const rq = 'SELECT value FROM json_each(?)'
  const cov = await c.db.prepare(`SELECT count(*) AS users, sum(u.mfa_secret IS NOT NULL) AS enrolled, sum(covered) AS covered, sum(covered AND u.mfa_secret IS NULL) AS missing FROM (
      SELECT u.id, u.mfa_secret, EXISTS (SELECT 1 FROM user_roles ur JOIN roles rr ON rr.id = ur.role_id WHERE ur.user_id = u.id AND rr.key IN (${rq})) AS covered
        FROM users u WHERE u.institution_id = ? AND u.status = 'active') u`).bind(JSON.stringify(roles), inst).first<{ users: number; enrolled: number; covered: number; missing: number }>()
  Object.assign(out, { users: cov?.users ?? 0, mfa_enrolled: cov?.enrolled ?? 0, users_covered_by_rule: cov?.covered ?? 0, users_covered_without_mfa: cov?.missing ?? 0 })
  out.roles = (await c.db.prepare(`SELECT key AS value, name AS label FROM roles ORDER BY name`).all<Option>()).results
  return ok(out)
}

async function getBackupPosture(c: Ctx): Promise<Response> {
  const inst = institutionId(c)
  const out: Record<string, unknown> = { enabled: true, frequency: 'daily', run_at_hour: 1, retention_days: 30, pitr_window_days: 7, destination: 'object_store', runs: [] as unknown[],
    last_good_at: undefined, last_good_hours: undefined, lapsed: false, failed_runs_30_days: 0, can_run_from_here: false,
    runs_blocked_by: "Backups are taken by the operator's pipeline and reported here. This process does not run pg_dump: a web request competing with the database for the same disk, at whatever hour somebody clicks, is how a backup becomes an outage." }
  const p = await c.db.prepare(`SELECT * FROM backup_policies WHERE institution_id = ?`).bind(inst).first<Record<string, unknown>>()
  if (p) Object.assign(out, { enabled: !!p.enabled, frequency: p.frequency, run_at_hour: p.run_at_hour, retention_days: p.retention_days, pitr_window_days: p.pitr_window_days, destination: p.destination })
  const g = await c.db.prepare(`SELECT max(CASE WHEN status = 'succeeded' THEN restore_point END) AS last_good, sum(status = 'failed' AND started_at >= datetime('now', '-30 days')) AS failed FROM backup_runs WHERE institution_id = ?`).bind(inst)
    .first<{ last_good: string | null; failed: number | null }>()
  out.failed_runs_30_days = g?.failed ?? 0
  let hours: number | undefined
  if (g?.last_good) { out.last_good_at = g.last_good; hours = Math.floor((Date.now() - Date.parse(g.last_good)) / 3_600_000); out.last_good_hours = hours }
  const runs = await c.db.prepare(`SELECT id, kind, started_at, finished_at, status, size_bytes, object_key, restore_point, error FROM backup_runs ORDER BY started_at DESC LIMIT 50`).all<Record<string, unknown>>()
  out.runs = runs.results.map((r) => ({ id: r.id, kind: r.kind, started_at: r.started_at, finished_at: und(r.finished_at as string | null), status: r.status, size_bytes: und(r.size_bytes as number | null),
    object_key: und(r.object_key as string | null), restore_point: und(r.restore_point as string | null), error: und(r.error as string | null) }))
  out.lapsed = !!out.enabled && backupLapsed(String(out.frequency), hours)
  return ok(out)
}

const GRANT_SELECT = `SELECT g.id, g.institution_id, g.operator_name AS operator, g.reason, g.ticket_id, g.started_at, g.expires_at, g.ended_at, g.ended_by_name AS ended_by, g.ended_reason,
    (g.ended_at IS NULL AND g.expires_at > ?1) AS live,
    (SELECT count(*) FROM audit_log a WHERE a.actor_user_id = g.operator_user_id AND a.institution_id = g.institution_id AND a.created_at BETWEEN g.started_at AND COALESCE(g.ended_at, g.expires_at)) AS changes
    FROM impersonation_grants g`
const grantView = (g: Record<string, unknown>, school: string | undefined) => ({ id: g.id, institution_id: g.institution_id, school, operator: g.operator, reason: g.reason, ticket_id: und(g.ticket_id as string | null),
  started_at: g.started_at, expires_at: g.expires_at, ended_at: und(g.ended_at as string | null), ended_by: und(g.ended_by as string | null), ended_reason: und(g.ended_reason as string | null), live: !!g.live, changes: g.changes })

/** The register is read across the fleet by a platform operator with no school, otherwise in the acting school. */
async function grantScopes(c: Ctx): Promise<{ db: D1Database; school: string }[]> {
  if (c.id.platformAdmin && !c.id.institution) return (await fleet(c)).map((f) => ({ db: f.db, school: f.inst.name }))
  return [{ db: c.db, school: school(c).name }]
}

// --- routes -----------------------------------------------------------------------------

export function registerPlatformConfig(r: Router): void {
  const vendor = 'platform.tenants.write', plans = 'platform.plans.write', read = 'institution.read', settings = 'institution.settings.write', profile = 'institution.write'

  // statutory: district and mandal master
  r.get('/admin/platform/locations', 'auth', async (c) => {
    const parent = (c.url.searchParams.get('parent_id') ?? '').trim()
    if (parent !== '' && !isUUID(parent)) throw badRequest('parent_id must be a uuid')
    const rows = await c.db.prepare(`SELECT l.id, l.parent_id, l.level, l.code, l.name, l.active, (SELECT count(*) FROM location_codes c WHERE c.parent_id = l.id) AS children
        FROM location_codes l WHERE (? IS NULL AND l.parent_id IS NULL) OR l.parent_id = ? ORDER BY l.code`).bind(parent || null, parent || null).all<Record<string, unknown>>()
    return ok(rows.results.map((v) => ({ id: v.id, parent_id: und(v.parent_id as string | null), level: v.level, code: v.code, name: v.name, active: !!v.active, children: v.children })))
  })
  r.post('/admin/platform/locations', vendor, async (c) => {
    const req = await readJSON<{ id?: string; parent_id?: string; level?: string; code?: string; name?: string; active?: boolean }>(c.req)
    const code = (req.code ?? '').trim(), name = (req.name ?? '').trim()
    if (code === '' || name === '') throw badRequest('code and name are required')
    const parent = req.parent_id || null
    if (parent && !isUUID(parent)) throw badRequest('parent_id must be a uuid')
    const active = req.active ?? true
    if (req.id) {
      if (!isUUID(req.id)) throw badRequest('id must be a uuid')
      const res = await c.db.prepare(`UPDATE location_codes SET code = ?, name = ?, active = ? WHERE id = ?`).bind(code, name, active ? 1 : 0, req.id).run()
      if ((res.meta.changes ?? 0) === 0) throw badRequest('no rows in result set')
      return ok({ id: req.id })
    }
    const existing = await c.db.prepare(`SELECT id FROM location_codes WHERE COALESCE(parent_id, ?) = ? AND level = ? AND code = ?`).bind(NIL, parent ?? NIL, req.level ?? '', code).first<{ id: string }>()
    if (existing) { await c.db.prepare(`UPDATE location_codes SET name = ?, active = ? WHERE id = ?`).bind(name, active ? 1 : 0, existing.id).run(); return ok({ id: existing.id }) }
    const id = uuid()
    await c.db.prepare(`INSERT INTO location_codes (id, parent_id, level, code, name, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, parent, req.level ?? '', code, name, active ? 1 : 0, now()).run()
    return ok({ id })
  })
  r.del('/admin/platform/locations/{id}', vendor, async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('id must be a uuid')
    const res = await c.db.prepare(`UPDATE location_codes SET active = 0 WHERE id = ?`).bind(c.params.id).run()
    if ((res.meta.changes ?? 0) === 0) throw notFound('resource not found')
    return ok({ retired: true })
  })

  // statutory: board affiliation and disclosure
  r.get('/admin/platform/board-affiliation', read, getBoardAffiliation)
  r.put('/admin/platform/board-affiliation', profile, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ affiliation_board?: string; affiliation_no?: string; affiliation_valid_to?: string }>(c.req)
    await c.db.prepare(`UPDATE institutions SET affiliation_board = ?, affiliation_no = ?, affiliation_valid_to = ?, updated_at = ? WHERE id = ?`)
      .bind(nz(req.affiliation_board), nz(req.affiliation_no), nz(req.affiliation_valid_to), now(), inst).run()
    return getBoardAffiliation(c)
  })
  r.post('/admin/platform/board-affiliation/documents', profile, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<Record<string, string | undefined>>(c.req)
    const document = (req.document ?? '').trim(), title = (req.title ?? '').trim()
    if (document === '' || title === '') throw badRequest('document and title are required')
    const campus = req.campus_id || null
    if (campus && !isUUID(campus)) throw badRequest('campus_id must be a uuid')
    const existing = await c.db.prepare(`SELECT id FROM board_disclosures WHERE institution_id = ? AND COALESCE(campus_id, ?) = ? AND document = ?`).bind(inst, NIL, campus ?? NIL, document).first<{ id: string }>()
    const id = existing?.id ?? uuid()
    const vals = [title, nz(req.reference_no), nz(req.issuing_authority), nz(req.issued_on), nz(req.valid_to), nz(req.file_key), nz(req.public_url), nz(req.notes), now()]
    if (existing) await c.db.prepare(`UPDATE board_disclosures SET title = ?, reference_no = ?, issuing_authority = ?, issued_on = ?, valid_to = ?, file_key = ?, public_url = ?, notes = ?, updated_at = ? WHERE id = ?`).bind(...vals, id).run()
    else await c.db.prepare(`INSERT INTO board_disclosures (id, institution_id, campus_id, document, title, reference_no, issuing_authority, issued_on, valid_to, file_key, public_url, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, inst, campus, document, ...vals).run()
    return ok({ id })
  })
  r.del('/admin/platform/board-affiliation/documents/{id}', profile, (c) => deleteOwnedRow(c, 'board_disclosures'))

  // statutory: state board rules
  r.get('/admin/platform/board-config', read, async (c) => {
    institutionId(c)
    const [items, scales] = await c.db.batch<Record<string, unknown>>([
      c.db.prepare(`SELECT b.id, b.board, b.stage, b.pass_percent, b.max_marks, b.internal_weight_percent, b.attendance_min_percent, b.exam_pattern, b.grading_scale_id, g.name AS grading_scale, b.medium, b.is_default
          FROM board_configurations b LEFT JOIN grading_scales g ON g.id = b.grading_scale_id ORDER BY b.stage, b.board`),
      c.db.prepare(`SELECT id AS value, name AS label FROM grading_scales ORDER BY name`),
    ])
    return ok({ items: items.results.map((v) => ({ id: v.id, board: v.board, stage: v.stage, pass_percent: v.pass_percent, max_marks: v.max_marks, internal_weight_percent: v.internal_weight_percent,
      attendance_min_percent: v.attendance_min_percent, exam_pattern: v.exam_pattern, grading_scale_id: und(v.grading_scale_id as string | null), grading_scale: und(v.grading_scale as string | null),
      medium: und(v.medium as string | null), is_default: !!v.is_default })), boards: PLAT_BOARDS, stages: PLAT_STAGES, exam_patterns: EXAM_PATTERNS, grading_scales: scales.results })
  })
  r.post('/admin/platform/board-config', settings, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ board?: string; stage?: string; pass_percent?: number; max_marks?: number; internal_weight_percent?: number; attendance_min_percent?: number; exam_pattern?: string; grading_scale_id?: string; medium?: string; is_default?: boolean }>(c.req)
    if (!(req.board ?? '').trim() || !(req.stage ?? '').trim()) throw badRequest('board and stage are required')
    const maxMarks = req.max_marks || 100
    const scale = req.grading_scale_id || null
    if (scale && !isUUID(scale)) throw badRequest('grading_scale_id must be a uuid')
    const stmts: D1PreparedStatement[] = []
    if (req.is_default) stmts.push(c.db.prepare(`UPDATE board_configurations SET is_default = 0 WHERE institution_id = ? AND is_default AND NOT (board = ? AND stage = ?)`).bind(inst, req.board, req.stage))
    const existing = await c.db.prepare(`SELECT id FROM board_configurations WHERE institution_id = ? AND board = ? AND stage = ?`).bind(inst, req.board, req.stage).first<{ id: string }>()
    const id = existing?.id ?? uuid()
    const vals = [req.pass_percent ?? 0, maxMarks, req.internal_weight_percent ?? 0, req.attendance_min_percent ?? 0, req.exam_pattern ?? '', scale, nz(req.medium), req.is_default ? 1 : 0, now()]
    if (existing) stmts.push(c.db.prepare(`UPDATE board_configurations SET pass_percent = ?, max_marks = ?, internal_weight_percent = ?, attendance_min_percent = ?, exam_pattern = ?, grading_scale_id = ?, medium = ?, is_default = ?, updated_at = ? WHERE id = ?`).bind(...vals, id))
    else stmts.push(c.db.prepare(`INSERT INTO board_configurations (id, institution_id, board, stage, pass_percent, max_marks, internal_weight_percent, attendance_min_percent, exam_pattern, grading_scale_id, medium, is_default, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, inst, req.board, req.stage, ...vals))
    await c.db.batch(stmts)
    return ok({ id })
  })
  r.del('/admin/platform/board-config/{id}', settings, (c) => deleteOwnedRow(c, 'board_configurations'))

  // statutory: SQAA framework
  r.get('/admin/platform/sqaa', 'auth', async (c) => {
    let want = (c.url.searchParams.get('framework') ?? '').trim()
    const fw = await c.db.prepare(`SELECT f.code, f.name, f.authority, f.version, f.effective_from, f.status, (SELECT count(*) FROM sqaa_standards t WHERE t.framework_code = f.code) AS standards,
        COALESCE((SELECT sum(t.weight_bp) FROM sqaa_standards t WHERE t.framework_code = f.code AND t.parent_id IS NULL), 0) AS weight_bp
        FROM sqaa_frameworks f ORDER BY f.status, (f.effective_from IS NULL), f.effective_from DESC, f.code`).all<Record<string, unknown>>()
    const frameworks = fw.results.map((f) => ({ code: f.code, name: f.name, authority: f.authority, version: f.version, effective_from: und(f.effective_from as string | null), status: f.status, standards: f.standards, weight_bp: f.weight_bp }))
    if (want === '') { want = (frameworks.find((f) => f.status === 'published') ?? frameworks[0])?.code as string ?? '' }
    let standards: unknown[] = []
    if (want !== '') {
      const st = await c.db.prepare(`SELECT id, parent_id, code, name, description, weight_bp, evidence_required, sequence FROM sqaa_standards WHERE framework_code = ? ORDER BY sequence, code`).bind(want).all<Record<string, unknown>>()
      standards = st.results.map((s) => ({ id: s.id, parent_id: und(s.parent_id as string | null), code: s.code, name: s.name, description: und(s.description as string | null), weight_bp: s.weight_bp, evidence_required: !!s.evidence_required, sequence: s.sequence }))
    }
    return ok({ frameworks, standards, selected: want || undefined })
  })
  r.post('/admin/platform/sqaa/frameworks', vendor, async (c) => {
    platformOnly(c)
    const req = await readJSON<{ code?: string; name?: string; authority?: string; version?: string; effective_from?: string; status?: string }>(c.req)
    const code = (req.code ?? '').trim()
    if (code === '' || !(req.name ?? '').trim()) throw badRequest('code and name are required')
    await c.db.prepare(`INSERT INTO sqaa_frameworks (code, name, authority, version, effective_from, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (code) DO UPDATE SET name = excluded.name, authority = excluded.authority, version = excluded.version, effective_from = excluded.effective_from, status = excluded.status`)
      .bind(code, (req.name ?? '').trim(), (req.authority ?? '').trim(), req.version || '1', nz(req.effective_from), req.status || 'draft', now()).run()
    return ok({ code })
  })
  r.post('/admin/platform/sqaa/standards', vendor, async (c) => {
    platformOnly(c)
    const req = await readJSON<{ id?: string; framework_code?: string; parent_id?: string; code?: string; name?: string; description?: string; weight_bp?: number; evidence_required?: boolean; sequence?: number }>(c.req)
    const fw = (req.framework_code ?? '').trim(), code = (req.code ?? '').trim(), name = (req.name ?? '').trim()
    if (fw === '' || code === '' || name === '') throw badRequest('framework_code, code and name are required')
    const parent = req.parent_id || null
    if (parent && !isUUID(parent)) throw badRequest('parent_id must be a uuid')
    const existing = await c.db.prepare(`SELECT id FROM sqaa_standards WHERE framework_code = ? AND COALESCE(parent_id, ?) = ? AND code = ?`).bind(fw, NIL, parent ?? NIL, code).first<{ id: string }>()
    const id = existing?.id ?? uuid()
    if (existing) await c.db.prepare(`UPDATE sqaa_standards SET name = ?, description = ?, weight_bp = ?, evidence_required = ?, sequence = ? WHERE id = ?`).bind(name, nz(req.description), req.weight_bp ?? 0, req.evidence_required ? 1 : 0, req.sequence ?? 0, id).run()
    else await c.db.prepare(`INSERT INTO sqaa_standards (id, framework_code, parent_id, code, name, description, weight_bp, evidence_required, sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, fw, parent, code, name, nz(req.description), req.weight_bp ?? 0, req.evidence_required ? 1 : 0, req.sequence ?? 0).run()
    return ok({ id })
  })
  r.del('/admin/platform/sqaa/standards/{id}', vendor, async (c) => {
    platformOnly(c)
    if (!isUUID(c.params.id)) throw badRequest('id must be a uuid')
    const res = await c.db.prepare(`DELETE FROM sqaa_standards WHERE id = ?`).bind(c.params.id).run()
    if ((res.meta.changes ?? 0) === 0) throw notFound('resource not found')
    return ok({ deleted: true })
  })

  // statutory: management type per campus
  r.get('/admin/platform/campus-classification', read, async (c) => {
    const inst = institutionId(c)
    const i = await c.db.prepare(`SELECT management_type, school_category FROM institutions WHERE id = ?`).bind(inst).first<{ management_type: string | null; school_category: string | null }>()
    const rows = await c.db.prepare(`SELECT c.id, c.name, c.code, c.city, c.status, c.management_type, c.school_category, c.udise_code, (SELECT count(*) FROM students st WHERE st.campus_id = c.id AND st.status = 'active') AS students FROM campuses c ORDER BY c.name`).all<Record<string, unknown>>()
    const items = rows.results.map((v) => ({ id: v.id, name: v.name, code: v.code, city: und(v.city as string | null), status: v.status, management_type: und(v.management_type as string | null), school_category: und(v.school_category as string | null), udise_code: und(v.udise_code as string | null), students: v.students }))
    return ok({ items, institution_management_type: und(i?.management_type ?? null), institution_school_category: und(i?.school_category ?? null), management_types: MANAGEMENT_TYPES, school_categories: SCHOOL_CATEGORIES, unclassified: items.filter((x) => x.management_type === undefined).length })
  })
  r.put('/admin/platform/campus-classification/{id}', 'institution.campuses.write', async (c) => {
    const inst = institutionId(c)
    if (!isUUID(c.params.id)) throw badRequest('id must be a uuid')
    const req = await readJSON<{ management_type?: string; school_category?: string; udise_code?: string }>(c.req)
    const udise = nz(req.udise_code)
    if (udise && !/^\d{11}$/.test(udise)) throw badRequest('a UDISE code is eleven digits')
    const res = await c.db.prepare(`UPDATE campuses SET management_type = ?, school_category = ?, udise_code = ?, updated_at = ? WHERE id = ? AND institution_id = ?`).bind(nz(req.management_type), nz(req.school_category), udise, now(), c.params.id, inst).run()
    if ((res.meta.changes ?? 0) === 0) throw notFound('resource not found')
    return ok({ updated: true })
  })

  // the calendar model
  r.get('/admin/platform/calendar-model', read, getCalendarModel)
  r.put('/admin/platform/calendar-model', settings, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<Record<string, number | string | undefined>>(c.req)
    await c.db.prepare(`INSERT INTO academic_calendar_models (institution_id, school_year_start_month, school_year_end_month, term_count, week_start_day, working_days_per_week, saturday_pattern, required_working_days, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (institution_id) DO UPDATE SET school_year_start_month = excluded.school_year_start_month, school_year_end_month = excluded.school_year_end_month, term_count = excluded.term_count, week_start_day = excluded.week_start_day,
          working_days_per_week = excluded.working_days_per_week, saturday_pattern = excluded.saturday_pattern, required_working_days = excluded.required_working_days, updated_at = excluded.updated_at`)
      .bind(inst, req.school_year_start_month ?? 0, req.school_year_end_month ?? 0, req.term_count ?? 0, req.week_start_day ?? 0, req.working_days_per_week ?? 0, req.saturday_pattern ?? '', req.required_working_days ?? 0, now()).run()
    return getCalendarModel(c)
  })

  // branding
  r.get('/admin/platform/branding', read, async (c) => {
    const inst = institutionId(c)
    const i = await c.db.prepare(`SELECT name, logo_key, primary_color FROM institutions WHERE id = ?`).bind(inst).first<{ name: string; logo_key: string | null; primary_color: string }>()
    if (!i) throw notFound('resource not found')
    const [campuses, rows] = await c.db.batch<Record<string, unknown>>([
      c.db.prepare(`SELECT id AS value, name AS label FROM campuses ORDER BY name`),
      c.db.prepare(`SELECT b.*, c.name AS campus FROM branding_profiles b LEFT JOIN campuses c ON c.id = b.campus_id ORDER BY (b.campus_id IS NOT NULL), b.campus_id`),
    ])
    const s = (v: unknown) => und(v as string | null)
    return ok({ items: rows.results.map((b) => ({ id: b.id, campus_id: s(b.campus_id), campus: s(b.campus), display_name: s(b.display_name), tagline: s(b.tagline), logo_key: s(b.logo_key), wordmark_key: s(b.wordmark_key), favicon_key: s(b.favicon_key),
      primary_color: s(b.primary_color), accent_color: s(b.accent_color), custom_domain: s(b.custom_domain), domain_verified_at: s(b.domain_verified_at), login_headline: s(b.login_headline), login_message: s(b.login_message),
      login_banner_key: s(b.login_banner_key), email_header_key: s(b.email_header_key), email_footer_html: s(b.email_footer_html), email_from_name: s(b.email_from_name), support_email: s(b.support_email), support_phone: s(b.support_phone) })),
      institution_name: i.name, institution_logo_key: und(i.logo_key), institution_primary_color: i.primary_color, campuses: campuses.results, uploads_available: true })
  })
  r.put('/admin/platform/branding', settings, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<Record<string, string | undefined>>(c.req)
    const campus = req.campus_id || null
    if (campus && !isUUID(campus)) throw badRequest('campus_id must be a uuid')
    const domain = (req.custom_domain ?? '').trim().toLowerCase() || null
    const cols = ['display_name', 'tagline', 'logo_key', 'wordmark_key', 'favicon_key', 'primary_color', 'accent_color', 'login_headline', 'login_message', 'login_banner_key', 'email_header_key', 'email_footer_html', 'email_from_name', 'support_email', 'support_phone']
    const vals = cols.map((k) => nz(req[k]))
    const existing = await c.db.prepare(`SELECT id, custom_domain FROM branding_profiles WHERE institution_id = ? AND COALESCE(campus_id, ?) = ?`).bind(inst, NIL, campus ?? NIL).first<{ id: string; custom_domain: string | null }>()
    const id = existing?.id ?? uuid()
    if (existing) {
      const keepVerified = existing.custom_domain === domain
      await c.db.prepare(`UPDATE branding_profiles SET ${cols.map((k) => k + ' = ?').join(', ')}, custom_domain = ?, domain_verified_at = CASE WHEN ? THEN domain_verified_at ELSE NULL END, updated_at = ? WHERE id = ?`)
        .bind(...vals, domain, keepVerified ? 1 : 0, now(), id).run()
    } else {
      await c.db.prepare(`INSERT INTO branding_profiles (id, institution_id, campus_id, ${cols.join(', ')}, custom_domain, updated_at) VALUES (?, ?, ?, ${cols.map(() => '?').join(', ')}, ?, ?)`).bind(id, inst, campus, ...vals, domain, now()).run()
    }
    return ok({ id })
  })
  r.post('/admin/platform/branding/{id}/verify-domain', vendor, async (c) => {
    platformOnly(c)
    if (!isUUID(c.params.id)) throw badRequest('id must be a uuid')
    const row = await c.db.prepare(`SELECT custom_domain FROM branding_profiles WHERE id = ? AND custom_domain IS NOT NULL`).bind(c.params.id).first<{ custom_domain: string }>()
    if (!row) throw badRequest('no such profile, or it has no custom domain to verify')
    await c.db.prepare(`UPDATE branding_profiles SET domain_verified_at = ?, updated_at = ? WHERE id = ?`).bind(now(), now(), c.params.id).run()
    return ok({ custom_domain: row.custom_domain, verified: true })
  })

  // franchise chains
  r.get('/admin/platform/franchises', vendor, async (c) => {
    platformOnly(c)
    let want = (c.url.searchParams.get('franchise_id') ?? '').trim()
    const schools = await fleet(c)
    const students = new Map<string, number>()
    for (const f of schools) { try { students.set(f.inst.id, (await f.db.prepare(`SELECT count(*) AS n FROM students WHERE status = 'active'`).first<{ n: number }>())?.n ?? 0) } catch { /* skip */ } }
    const fw = await c.db.prepare(`SELECT f.*, (SELECT count(*) FROM franchise_members m WHERE m.franchise_id = f.id) AS members, COALESCE((SELECT sum(m.annual_fee_paise) FROM franchise_members m WHERE m.franchise_id = f.id), 0) AS fee,
        (SELECT CAST(avg(m.compliance_percent) AS INTEGER) FROM franchise_members m WHERE m.franchise_id = f.id AND m.compliance_percent IS NOT NULL) AS compliance,
        (SELECT count(*) FROM franchise_members m WHERE m.franchise_id = f.id AND m.last_audited_on IS NULL) AS never_audited FROM franchises f ORDER BY f.name`).all<Record<string, unknown>>()
    const memberRows = await c.db.prepare(`SELECT franchise_id, institution_id FROM franchise_members`).all<{ franchise_id: string; institution_id: string }>()
    const items = fw.results.map((f) => ({ id: f.id, code: f.code, name: f.name, brand_owner: und(f.brand_owner as string | null), royalty_bp: f.royalty_bp, contact_name: und(f.contact_name as string | null), contact_email: und(f.contact_email as string | null),
      contact_phone: und(f.contact_phone as string | null), brand_standards: und(f.brand_standards as string | null), status: f.status, members: f.members,
      students: memberRows.results.filter((m) => m.franchise_id === f.id).reduce((n, m) => n + (students.get(m.institution_id) ?? 0), 0), annual_fee_paise: f.fee, compliance_percent: und(f.compliance as number | null), never_audited: f.never_audited }))
    if (want === '' && items.length > 0) want = String(items[0].id)
    let members: unknown[] = []
    if (want !== '') {
      if (!isUUID(want)) throw new HttpError(500, 'id must be a uuid')
      const ms = await c.db.prepare(`SELECT * FROM franchise_members WHERE franchise_id = ?`).bind(want).all<Record<string, unknown>>()
      const byId = new Map(schools.map((f) => [f.inst.id, f.inst]))
      members = ms.results.map((m) => { const i = byId.get(String(m.institution_id)); return { institution_id: m.institution_id, school: i?.name ?? '', district: undefined, status: i?.status ?? '', agreement_no: und(m.agreement_no as string | null),
        joined_on: m.joined_on, renews_on: und(m.renews_on as string | null), annual_fee_paise: m.annual_fee_paise, compliance_percent: und(m.compliance_percent as number | null), last_audited_on: und(m.last_audited_on as string | null), students: students.get(String(m.institution_id)) ?? 0 } })
        .sort((a, b) => (a.school < b.school ? -1 : 1))
    }
    const attached = new Set(memberRows.results.map((m) => m.institution_id))
    return ok({ items, members, unattached: schools.filter((f) => !attached.has(f.inst.id)).map((f) => opt(f.inst.id, f.inst.name)), selected: want || undefined })
  })
  r.post('/admin/platform/franchises', vendor, async (c) => {
    platformOnly(c)
    const req = await readJSON<Record<string, string | number | undefined>>(c.req)
    const code = String(req.code ?? '').trim(), name = String(req.name ?? '').trim()
    if (code === '' || name === '') throw badRequest('code and name are required')
    const existing = await c.db.prepare(`SELECT id FROM franchises WHERE code = ?`).bind(code).first<{ id: string }>()
    const id = existing?.id ?? uuid()
    const vals = [name, nz(req.brand_owner), Number(req.royalty_bp ?? 0), nz(req.contact_name), nz(req.contact_email), nz(req.contact_phone), nz(req.brand_standards), String(req.status || 'active')]
    if (existing) await c.db.prepare(`UPDATE franchises SET name = ?, brand_owner = ?, royalty_bp = ?, contact_name = ?, contact_email = ?, contact_phone = ?, brand_standards = ?, status = ? WHERE id = ?`).bind(...vals, id).run()
    else await c.db.prepare(`INSERT INTO franchises (id, code, name, brand_owner, royalty_bp, contact_name, contact_email, contact_phone, brand_standards, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, code, ...vals, now()).run()
    return ok({ id })
  })
  r.post('/admin/platform/franchises/members', vendor, async (c) => {
    platformOnly(c)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const fid = String(req.franchise_id ?? '').trim(), iid = String(req.institution_id ?? '').trim()
    if (!isUUID(fid)) throw badRequest('franchise_id must be a uuid')
    if (!isUUID(iid)) throw badRequest('institution_id must be a uuid')
    await c.db.prepare(`INSERT INTO franchise_members (institution_id, franchise_id, agreement_no, joined_on, renews_on, annual_fee_paise, compliance_percent, last_audited_on, notes, updated_at) VALUES (?, ?, ?, COALESCE(?, date('now')), ?, ?, ?, ?, ?, ?)
        ON CONFLICT (institution_id) DO UPDATE SET franchise_id = excluded.franchise_id, agreement_no = excluded.agreement_no, joined_on = excluded.joined_on, renews_on = excluded.renews_on, annual_fee_paise = excluded.annual_fee_paise,
          compliance_percent = excluded.compliance_percent, last_audited_on = excluded.last_audited_on, notes = excluded.notes, updated_at = excluded.updated_at`)
      .bind(iid, fid, nz(req.agreement_no), nz(req.joined_on), nz(req.renews_on), Number(req.annual_fee_paise ?? 0), req.compliance_percent ?? null, nz(req.last_audited_on), nz(req.notes), now()).run()
    return ok({ institution_id: iid })
  })
  r.del('/admin/platform/franchises/members/{id}', vendor, async (c) => {
    platformOnly(c)
    if (!isUUID(c.params.id)) throw badRequest('id must be an institution uuid')
    const res = await c.db.prepare(`DELETE FROM franchise_members WHERE institution_id = ?`).bind(c.params.id).run()
    if ((res.meta.changes ?? 0) === 0) throw notFound('resource not found')
    return ok({ removed: true })
  })
  r.get('/admin/platform/franchise', read, async (c) => {
    const inst = institutionId(c)
    const m = await c.db.prepare(`SELECT * FROM franchise_members WHERE institution_id = ?`).bind(inst).first<Record<string, unknown>>()
    if (!m) return ok({})
    const i = school(c)
    const students = (await c.db.prepare(`SELECT count(*) AS n FROM students WHERE status = 'active'`).first<{ n: number }>())?.n ?? 0
    const ch = await c.db.prepare(`SELECT id, code, name, brand_owner, royalty_bp, contact_name, contact_email, contact_phone, brand_standards, status FROM franchises WHERE id = ?`).bind(m.franchise_id).first<Record<string, unknown>>()
    if (!ch) throw notFound('resource not found')
    return ok({
      membership: { institution_id: inst, school: i.name, district: undefined, status: i.status, agreement_no: und(m.agreement_no as string | null), joined_on: m.joined_on, renews_on: und(m.renews_on as string | null),
        annual_fee_paise: m.annual_fee_paise, compliance_percent: und(m.compliance_percent as number | null), last_audited_on: und(m.last_audited_on as string | null), students },
      chain: { id: ch.id, code: ch.code, name: ch.name, brand_owner: und(ch.brand_owner as string | null), royalty_bp: ch.royalty_bp, contact_name: und(ch.contact_name as string | null), contact_email: und(ch.contact_email as string | null),
        contact_phone: und(ch.contact_phone as string | null), brand_standards: und(ch.brand_standards as string | null), status: ch.status, members: 0, students: 0, annual_fee_paise: 0, never_audited: 0 },
    })
  })

  // numbering and templates
  r.get('/admin/platform/numbering', read, getNumberingAndTemplates)
  r.post('/admin/platform/numbering', settings, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ campus_id?: string; kind?: string; prefix?: string; suffix?: string; padding?: number; next_value?: number; reset_yearly?: boolean }>(c.req)
    const kind = (req.kind ?? '').trim()
    if (kind === '') throw badRequest('kind is required')
    const padding = (req.padding ?? 0) > 0 ? req.padding! : 5
    const nextValue = (req.next_value ?? 0) > 0 ? req.next_value! : 1
    const campus = req.campus_id || null
    if (campus && !isUUID(campus)) throw badRequest('campus_id must be a uuid')
    const existing = await c.db.prepare(`SELECT id, next_value FROM numbering_schemes WHERE institution_id = ? AND campus_id IS ? AND kind = ?`).bind(inst, campus, kind).first<{ id: string; next_value: number }>()
    const id = existing?.id ?? uuid()
    const nv = existing ? Math.max(existing.next_value, nextValue) : nextValue
    if (existing) await c.db.prepare(`UPDATE numbering_schemes SET prefix = ?, suffix = ?, padding = ?, next_value = ?, reset_yearly = ?, updated_at = ? WHERE id = ?`).bind(req.prefix ?? '', req.suffix ?? '', padding, nv, req.reset_yearly ? 1 : 0, now(), id).run()
    else await c.db.prepare(`INSERT INTO numbering_schemes (id, institution_id, campus_id, kind, prefix, suffix, padding, next_value, reset_yearly, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, inst, campus, kind, req.prefix ?? '', req.suffix ?? '', padding, nv, req.reset_yearly ? 1 : 0, now()).run()
    return ok({ id, kind, prefix: req.prefix ?? '', suffix: req.suffix ?? '', padding, next_value: nv, reset_yearly: !!req.reset_yearly, preview: previewNumber(req.prefix ?? '', req.suffix ?? '', padding, nv, !!req.reset_yearly) })
  })
  r.del('/admin/platform/numbering/{id}', settings, (c) => deleteOwnedRow(c, 'numbering_schemes'))
  r.post('/admin/platform/templates', settings, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ code?: string; name?: string; template_html?: string; requires_approval?: boolean }>(c.req)
    const code = (req.code ?? '').trim(), name = (req.name ?? '').trim()
    if (code === '' || name === '') throw badRequest('code and name are required')
    const existing = await c.db.prepare(`SELECT id FROM certificate_types WHERE institution_id = ? AND code = ?`).bind(inst, code).first<{ id: string }>()
    const id = existing?.id ?? uuid()
    if (existing) await c.db.prepare(`UPDATE certificate_types SET name = ?, template_html = ?, requires_approval = ?, updated_at = ? WHERE id = ?`).bind(name, nz(req.template_html), req.requires_approval ? 1 : 0, now(), id).run()
    else await c.db.prepare(`INSERT INTO certificate_types (id, institution_id, code, name, template_html, requires_approval, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, inst, code, name, nz(req.template_html), req.requires_approval ? 1 : 0, now()).run()
    return ok({ id })
  })

  // SSO and MFA
  r.get('/admin/platform/auth-policy', 'access.roles.read', getAuthPolicy)
  r.put('/admin/platform/auth-policy', 'access.roles.write', async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const roles = Array.isArray(req.mfa_required_roles) ? req.mfa_required_roles : []
    const domains = Array.isArray(req.allowed_email_domains) ? req.allowed_email_domains : []
    await c.db.prepare(`INSERT INTO auth_policies (institution_id, mfa_required_roles, mfa_grace_days, password_min_length, password_expiry_days, session_idle_minutes, allowed_email_domains, sso_enabled, sso_protocol, sso_provider, sso_entity_id, sso_metadata_url, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (institution_id) DO UPDATE SET mfa_required_roles = excluded.mfa_required_roles, mfa_grace_days = excluded.mfa_grace_days, password_min_length = excluded.password_min_length, password_expiry_days = excluded.password_expiry_days,
          session_idle_minutes = excluded.session_idle_minutes, allowed_email_domains = excluded.allowed_email_domains, sso_enabled = excluded.sso_enabled, sso_protocol = excluded.sso_protocol, sso_provider = excluded.sso_provider,
          sso_entity_id = excluded.sso_entity_id, sso_metadata_url = excluded.sso_metadata_url, updated_at = excluded.updated_at`)
      .bind(inst, JSON.stringify(roles), Number(req.mfa_grace_days ?? 0), Number(req.password_min_length) || 10, Number(req.password_expiry_days ?? 0), Number(req.session_idle_minutes) || 120, JSON.stringify(domains),
        req.sso_enabled ? 1 : 0, nz(req.sso_protocol), nz(req.sso_provider), nz(req.sso_entity_id), nz(req.sso_metadata_url), now()).run()
    return getAuthPolicy(c)
  })

  // backup and restore
  r.get('/admin/platform/backups', read, getBackupPosture)
  r.put('/admin/platform/backups', settings, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<Record<string, unknown>>(c.req)
    await c.db.prepare(`INSERT INTO backup_policies (institution_id, enabled, frequency, run_at_hour, retention_days, pitr_window_days, destination, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (institution_id) DO UPDATE SET enabled = excluded.enabled, frequency = excluded.frequency, run_at_hour = excluded.run_at_hour, retention_days = excluded.retention_days, pitr_window_days = excluded.pitr_window_days, destination = excluded.destination, updated_at = excluded.updated_at`)
      .bind(inst, req.enabled ? 1 : 0, String(req.frequency || 'daily'), Number(req.run_at_hour ?? 0), Number(req.retention_days) || 30, Number(req.pitr_window_days ?? 0), String(req.destination || 'object_store'), now()).run()
    return getBackupPosture(c)
  })
  r.post('/admin/platform/backups/runs', vendor, async (c) => {
    platformOnly(c)
    const req = await readJSON<Record<string, unknown>>(c.req)
    const iid = String(req.institution_id ?? '').trim()
    if (!isUUID(iid)) throw badRequest('institution_id must be a uuid')
    const status = String(req.status || 'running')
    const restorePoint = nz(req.restore_point)
    if (status === 'succeeded' && !restorePoint) throw badRequest('a run marked succeeded must carry a restore point')
    const inst = await c.env.CONTROL.prepare(`SELECT * FROM institutions WHERE id = ?`).bind(iid).first<Institution>()
    if (!inst) throw notFound('resource not found')
    const db = tenantDb(c.env, inst)
    const id = uuid()
    await db.prepare(`INSERT INTO backup_runs (id, institution_id, kind, started_at, finished_at, status, size_bytes, object_key, restore_point, checksum, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, iid, String(req.kind || 'scheduled'), nz(req.started_at) ?? now(), nz(req.finished_at), status, req.size_bytes ?? null, nz(req.object_key), restorePoint, nz(req.checksum), nz(req.error)).run()
    return created({ id })
  })
  r.get('/admin/platform/backups/fleet', vendor, async (c) => {
    platformOnly(c)
    const items: Record<string, unknown>[] = []
    for (const f of await fleet(c)) {
      try {
        const row = await f.db.prepare(`SELECT COALESCE(p.enabled, 1) AS enabled, COALESCE(p.frequency, 'daily') AS frequency,
            (SELECT max(restore_point) FROM backup_runs b WHERE b.institution_id = ? AND b.status = 'succeeded') AS last_good,
            (SELECT count(*) FROM backup_runs b WHERE b.institution_id = ? AND b.status = 'failed' AND b.started_at >= datetime('now', '-30 days')) AS failed30,
            (SELECT count(*) FROM students st WHERE st.status = 'active') AS students
            FROM (SELECT 1) x LEFT JOIN backup_policies p ON p.institution_id = ?`).bind(f.inst.id, f.inst.id, f.inst.id).first<{ enabled: number; frequency: string; last_good: string | null; failed30: number; students: number }>()
        if (!row) continue
        const hours = row.last_good ? Math.floor((Date.now() - Date.parse(row.last_good)) / 3_600_000) : undefined
        items.push({ institution_id: f.inst.id, school: f.inst.name, enabled: !!row.enabled, frequency: row.frequency, last_good_at: und(row.last_good), last_good_hours: hours, lapsed: !!row.enabled && backupLapsed(row.frequency, hours), failed_runs_30_days: row.failed30, students: row.students })
      } catch { /* skip */ }
    }
    items.sort((a, b) => { const x = (a.last_good_at as string | undefined) ?? '', y = (b.last_good_at as string | undefined) ?? ''; return x < y ? -1 : x > y ? 1 : String(a.school) < String(b.school) ? -1 : 1 })
    return ok(items)
  })

  // support tickets
  const ticketView = (t: Record<string, unknown>, school?: string) => ({ id: t.id, school, subject: t.subject, category: t.category, priority: t.priority, status: t.status, raised_by: und(t.raised_by as string | null), assigned_to: und(t.assigned_to as string | null),
    created_at: String(t.created_at).slice(0, 10), open_days: Math.floor((Date.now() - Date.parse(String(t.created_at))) / 86_400_000), body: und(t.body as string | null) })
  const TICKET_SQL = `SELECT t.id, t.subject, t.category, t.priority, t.status, u.full_name AS raised_by, a.full_name AS assigned_to, t.created_at, t.body FROM support_tickets t LEFT JOIN users u ON u.id = t.raised_by LEFT JOIN users a ON a.id = t.assigned_to WHERE t.audience = 'vendor'`
  r.get('/admin/platform/seller/tickets', vendor, async (c) => {
    platformOnly(c)
    const status = (c.url.searchParams.get('status') ?? '').trim() || null
    const items: Record<string, unknown>[] = []
    for (const f of await fleet(c)) {
      try {
        const rows = await f.db.prepare(`${TICKET_SQL} AND (? IS NULL OR t.status = ?) AND (? IS NOT NULL OR t.status <> 'closed')`).bind(status, status, status).all<Record<string, unknown>>()
        for (const t of rows.results) items.push(ticketView(t, f.inst.name))
      } catch { /* skip */ }
    }
    const pr = (p: unknown) => ({ urgent: 0, high: 1, normal: 2 } as Record<string, number>)[String(p)] ?? 3
    items.sort((a, b) => pr(a.priority) - pr(b.priority) || (String(a.created_at) < String(b.created_at) ? -1 : 1))
    return ok(items)
  })
  r.post('/admin/platform/seller/tickets/{id}', vendor, async (c) => {
    platformOnly(c)
    if (!isUUID(c.params.id)) throw badRequest('id must be a uuid')
    const req = await readJSON<{ status?: string; priority?: string; assigned_to?: string; resolution?: string }>(c.req)
    const assign = req.assigned_to || null
    if (assign && !isUUID(assign)) throw badRequest('assigned_to must be a uuid')
    const status = nz(req.status)
    for (const f of await fleet(c)) {
      try {
        const res = await f.db.prepare(`UPDATE support_tickets SET status = COALESCE(?, status), priority = COALESCE(?, priority), assigned_to = COALESCE(?, assigned_to), resolution = COALESCE(?, resolution),
            resolved_at = CASE WHEN ? IN ('resolved','closed') THEN COALESCE(resolved_at, ?) ELSE resolved_at END WHERE id = ? AND audience = 'vendor'`)
          .bind(status, nz(req.priority), assign, nz(req.resolution), status, now(), c.params.id).run()
        if ((res.meta.changes ?? 0) > 0) return ok({ updated: true })
      } catch { /* skip */ }
    }
    throw notFound('resource not found')
  })
  r.get('/admin/platform/support/tickets', read, async (c) => {
    institutionId(c)
    const rows = await c.db.prepare(`${TICKET_SQL} ORDER BY t.created_at DESC LIMIT 200`).all<Record<string, unknown>>()
    return ok(rows.results.map((t) => ticketView(t)))
  })
  r.post('/admin/platform/support/tickets', settings, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ category?: string; subject?: string; body?: string; priority?: string }>(c.req)
    const subject = (req.subject ?? '').trim(), body = (req.body ?? '').trim()
    if (subject === '' || body === '') throw badRequest('subject and body are required')
    const category = req.category || 'other'
    if (!VENDOR_CATEGORIES.has(category)) throw badRequest('unknown category for a vendor ticket')
    const id = uuid()
    await c.db.prepare(`INSERT INTO support_tickets (id, institution_id, raised_by, category, subject, body, priority, audience, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'vendor', ?, ?)`)
      .bind(id, inst, c.id.userId, category, subject, body, req.priority || 'normal', now(), now()).run()
    return created({ id })
  })

  // impersonation
  r.get('/admin/platform/impersonation', 'auth', async (c) => {
    requireAny(c, 'admin.audit.read', vendor)
    const limit = clampInt(c.url.searchParams.get('limit'), 100, 1, 500)
    const items: Record<string, unknown>[] = []
    for (const s of await grantScopes(c)) {
      try {
        const rows = await s.db.prepare(`${GRANT_SELECT} ORDER BY g.started_at DESC LIMIT ?2`).bind(now(), limit).all<Record<string, unknown>>()
        for (const g of rows.results) items.push(grantView(g, s.school))
      } catch { /* skip */ }
    }
    items.sort((a, b) => (String(a.started_at) < String(b.started_at) ? 1 : -1))
    return ok(items.slice(0, limit))
  })
  r.post('/admin/platform/impersonation', vendor, async (c) => {
    platformOnly(c)
    const req = await readJSON<{ institution_id?: string; reason?: string; ticket_id?: string; minutes?: number }>(c.req)
    const iid = (req.institution_id ?? '').trim()
    if (!isUUID(iid)) throw badRequest('institution_id must be a uuid')
    const reason = (req.reason ?? '').trim()
    if (reason.length < 8) throw badRequest("say why you are entering this school. At least a few words, because the school's administrator reads this")
    let minutes = req.minutes ?? 0
    if (minutes <= 0) minutes = 60
    if (minutes > 240) throw badRequest('a support session may not exceed four hours')
    const ticket = req.ticket_id || null
    if (ticket && !isUUID(ticket)) throw badRequest('ticket_id must be a uuid')
    const inst = await c.env.CONTROL.prepare(`SELECT * FROM institutions WHERE id = ? AND status = 'active'`).bind(iid).first<Institution>()
    if (!inst) throw notFound('resource not found')
    const db = tenantDb(c.env, inst)
    const id = uuid()
    const expires = new Date(Date.now() + minutes * 60_000).toISOString()
    /* impersonation_grants.operator_user_id references the tenant's users table, which holds no platform account;
       under PRAGMA foreign_keys the insert is refused, which is reported rather than hidden. */
    await db.batch([
      db.prepare(`UPDATE impersonation_grants SET ended_at = ?, ended_by = NULL, ended_by_name = ?, ended_reason = 'superseded by a new session' WHERE operator_user_id = ? AND ended_at IS NULL`).bind(now(), c.id.fullName, c.id.userId),
      db.prepare(`INSERT INTO impersonation_grants (id, institution_id, operator_user_id, operator_name, reason, ticket_id, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, iid, c.id.userId, c.id.fullName, reason, ticket, now(), expires),
    ])
    const g = await db.prepare(`${GRANT_SELECT} WHERE g.id = ?2`).bind(now(), id).first<Record<string, unknown>>()
    if (!g) throw notFound('resource not found')
    return created(grantView(g, inst.name))
  })
  r.get('/admin/platform/impersonation/{id}/activity', 'auth', async (c) => {
    requireAny(c, 'admin.audit.read', vendor)
    if (!isUUID(c.params.id)) throw badRequest('id must be a uuid')
    for (const s of await grantScopes(c)) {
      const g = await s.db.prepare(`${GRANT_SELECT} WHERE g.id = ?2`).bind(now(), c.params.id).first<Record<string, unknown>>().catch(() => null)
      if (!g) continue
      const rows = await s.db.prepare(`SELECT a.id, a.created_at AS at, COALESCE(u.full_name, g.operator_name) AS actor, a.action, a.entity_type, a.ip, a.before, a.after
          FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id JOIN impersonation_grants g ON g.id = ?
         WHERE a.actor_user_id = g.operator_user_id AND a.institution_id = g.institution_id AND a.created_at BETWEEN g.started_at AND COALESCE(g.ended_at, g.expires_at) ORDER BY a.id DESC LIMIT 500`).bind(c.params.id).all<Record<string, unknown>>()
      const unattributed = await s.db.prepare(`SELECT count(*) AS n FROM audit_log a JOIN impersonation_grants g ON g.id = ? WHERE a.actor_user_id = g.operator_user_id AND a.institution_id IS NULL AND a.created_at BETWEEN g.started_at AND COALESCE(g.ended_at, g.expires_at)`).bind(c.params.id).first<{ n: number }>()
      const n = unattributed?.n ?? 0
      return ok({ grant: grantView(g, s.school), items: rows.results.map((a) => ({ id: a.id, at: a.at, actor: und(a.actor as string | null), action: a.action, entity_type: a.entity_type, ip: und(a.ip as string | null), request: parseJSON<unknown>(a.before, undefined), response: parseJSON<unknown>(a.after, undefined) })),
        covers: 'Changes made during the session. Reads are not recorded: the audit middleware records state-changing requests only, so an empty list means nothing was altered, not that nothing was seen.',
        unattributed_changes: n, unattributed_note: n > 0 ? "This operator made changes during the session that were recorded against no school and so cannot be listed here. The audit middleware runs above the acting-institution middleware and never sees the school the operator named; until that is corrected, a platform operator's edits inside a school do not reach that school's audit trail." : undefined })
    }
    throw notFound('resource not found')
  })
  r.post('/admin/platform/impersonation/{id}/end', 'auth', async (c) => {
    requireAny(c, 'admin.audit.read', vendor)
    if (!isUUID(c.params.id)) throw badRequest('id must be a uuid')
    let reason = ''
    if (Number(c.req.headers.get('content-length') ?? 0) > 0) reason = ((await readJSON<{ reason?: string }>(c.req)).reason ?? '').trim()
    if (reason === '') reason = 'ended by ' + c.id.fullName
    for (const s of await grantScopes(c)) {
      const res = await s.db.prepare(`UPDATE impersonation_grants SET ended_at = ?, ended_by = ?, ended_by_name = ?, ended_reason = ? WHERE id = ? AND ended_at IS NULL`)
        .bind(now(), c.id.platformAdmin ? null : c.id.userId, c.id.fullName, reason, c.params.id).run().catch(() => null)
      if (res && (res.meta.changes ?? 0) > 0) return ok({ ended: true })
    }
    throw notFound('resource not found')
  })

  // adoption
  r.get('/admin/platform/adoption', vendor, async (c) => {
    platformOnly(c)
    const items: Record<string, unknown>[] = []
    let atRisk = 0
    const subs = await c.env.CONTROL.prepare(`SELECT institution_id, plan_code FROM subscriptions`).all<{ institution_id: string; plan_code: string }>()
    const planOf = new Map(subs.results.map((s) => [s.institution_id, s.plan_code]))
    const sess = await c.env.CONTROL.prepare(`SELECT institution_id, count(*) AS n, count(DISTINCT user_id) AS users FROM sessions WHERE created_at >= datetime('now', '-28 days') AND institution_id IS NOT NULL GROUP BY institution_id`).all<{ institution_id: string; n: number; users: number }>()
    const sessOf = new Map(sess.results.map((s) => [s.institution_id, s]))
    for (const f of await fleet(c)) {
      try {
        const row = await f.db.prepare(`SELECT (SELECT count(*) FROM students WHERE status = 'active') AS students, (SELECT count(*) FROM employees WHERE status = 'active') AS staff,
            (SELECT count(*) FROM users WHERE status = 'active') AS accounts, (SELECT count(*) FROM audit_log WHERE created_at >= datetime('now', '-28 days')) AS changes,
            (SELECT max(last_login_at) FROM users) AS last_login`).first<{ students: number; staff: number; accounts: number; changes: number; last_login: string | null }>()
        if (!row) continue
        const s = sessOf.get(f.inst.id)
        const quiet = row.last_login ? Math.floor((Date.now() - Date.parse(row.last_login)) / 86_400_000) : undefined
        if (quiet === undefined || quiet >= 14) atRisk++
        items.push({ institution_id: f.inst.id, school: f.inst.name, plan: planOf.get(f.inst.id), students: row.students, staff: row.staff, accounts: row.accounts, sign_ins_28_days: s?.n ?? 0, active_users_28_days: s?.users ?? 0,
          changes_28_days: row.changes, active_percent: row.accounts > 0 ? Math.floor(((s?.users ?? 0) * 100) / row.accounts) : 0, last_sign_in: row.last_login ? row.last_login.slice(0, 10) : undefined, quiet_days: quiet })
      } catch { /* skip */ }
    }
    // The installation's trend by week (Monday-start), sign-ins from CONTROL and changes summed over the fleet.
    const weekOf = (iso: string) => { const d = new Date(iso); const off = (d.getUTCDay() + 6) % 7; const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - off)); return m.toISOString().slice(0, 10) }
    const wk = new Map<string, { sign_ins: number; users: Set<string>; changes: number }>()
    const ws = await c.env.CONTROL.prepare(`SELECT created_at, user_id FROM sessions WHERE created_at >= datetime('now', '-84 days')`).all<{ created_at: string; user_id: string }>()
    for (const s of ws.results) { const k = weekOf(s.created_at); const e = wk.get(k) ?? { sign_ins: 0, users: new Set(), changes: 0 }; e.sign_ins++; e.users.add(s.user_id); wk.set(k, e) }
    for (const f of await fleet(c)) {
      try {
        const ch = await f.db.prepare(`SELECT substr(created_at, 1, 10) AS d, count(*) AS n FROM audit_log WHERE created_at >= datetime('now', '-84 days') GROUP BY d`).all<{ d: string; n: number }>()
        for (const x of ch.results) { const k = weekOf(x.d); const e = wk.get(k); if (e) e.changes += x.n }
      } catch { /* skip */ }
    }
    const weeks = [...wk.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([week_start, v]) => ({ week_start, sign_ins: v.sign_ins, active_users: v.users.size, changes: v.changes }))
    return ok({ items, weeks, at_risk: atRisk })
  })

  // health
  r.get('/admin/platform/health', vendor, async (c) => {
    platformOnly(c)
    const items: Record<string, unknown>[] = []
    const sess = await c.env.CONTROL.prepare(`SELECT institution_id, count(*) AS n FROM sessions WHERE created_at >= datetime('now', '-24 hours') GROUP BY institution_id`).all<{ institution_id: string; n: number }>()
    const sessOf = new Map(sess.results.map((s) => [s.institution_id, s.n]))
    const istHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date())) % 24
    for (const f of await fleet(c)) {
      try {
        const failing = `g.institution_id = ?1 AND g.enabled AND g.last_error IS NOT NULL AND (g.last_ok_at IS NULL OR g.last_ok_at < datetime('now', '-24 hours'))`
        const row = await f.db.prepare(`SELECT (SELECT count(*) FROM integrations g WHERE g.institution_id = ?1 AND g.enabled) AS on_, (SELECT count(*) FROM integrations g WHERE ${failing}) AS failed,
            (SELECT group_concat(provider, ',') FROM (SELECT g.provider FROM integrations g WHERE ${failing} ORDER BY g.provider)) AS providers,
            (SELECT count(*) FROM message_log m WHERE m.status = 'failed' AND m.queued_at >= datetime('now', '-24 hours')) AS msg_failed,
            (SELECT count(*) FROM payments p WHERE p.status = 'failed' AND p.created_at >= datetime('now', '-24 hours')) AS pay_failed,
            (SELECT count(*) FROM support_tickets t WHERE t.audience = 'vendor' AND t.status NOT IN ('resolved','closed')) AS tickets,
            (SELECT count(*) FROM student_attendance sa WHERE sa.on_date = date('now')) AS marked`).bind(f.inst.id)
          .first<{ on_: number; failed: number; providers: string | null; msg_failed: number; pay_failed: number; tickets: number; marked: number }>()
        if (!row) continue
        let concerns = 0
        if (row.failed > 0) concerns++
        if (row.msg_failed > 0) concerns++
        if (row.pay_failed > 0) concerns++
        if (row.marked === 0 && istHour >= 11) concerns++
        items.push({ institution_id: f.inst.id, school: f.inst.name, integrations_enabled: row.on_, integrations_failing: row.failed, failing_providers: row.providers ? row.providers.split(',') : [], messages_failed_24h: row.msg_failed,
          payments_failed_24h: row.pay_failed, open_vendor_tickets: row.tickets, attendance_marked_today: row.marked, sessions_24h: sessOf.get(f.inst.id) ?? 0, concerns })
      } catch { /* skip */ }
    }
    return ok({ items, queues: {}, not_measured: 'Per-endpoint error rates and response times are written to the structured log and are not stored, so they cannot be reported here. What is below is measured from the database: failing integrations, undelivered messages, failed payments and whether the register was taken.' })
  })

  // entitlements
  const planModules = (raw: unknown): string[] => { const v = parseJSON<unknown>(raw, []); if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string'); if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).filter(([, on]) => on).map(([k]) => k); return [] }
  r.get('/admin/platform/entitlements', plans, async (c) => {
    platformOnly(c)
    const pr = await c.env.CONTROL.prepare(`SELECT p.code, p.name, p.price_paise, p.modules, p.sequence, (SELECT count(*) FROM subscriptions s WHERE s.plan_code = p.code) AS schools FROM plans p ORDER BY p.sequence, p.code`).all<Record<string, unknown>>()
    const planRows = pr.results.map((p) => ({ code: p.code, name: p.name, price_paise: p.price_paise, modules: planModules(p.modules), schools: p.schools, sequence: p.sequence }))
    const subs = await c.env.CONTROL.prepare(`SELECT s.institution_id, s.plan_code, p.name, p.modules FROM subscriptions s LEFT JOIN plans p ON p.code = s.plan_code`).all<{ institution_id: string; plan_code: string; name: string | null; modules: string | null }>()
    const subOf = new Map(subs.results.map((s) => [s.institution_id, s]))
    const modules = new Set<string>()
    for (const p of planRows) for (const m of p.modules) modules.add(m)
    const schools: Record<string, unknown>[] = []
    for (const f of await fleet(c)) {
      let enabled: string[] = []
      try { enabled = (await f.db.prepare(`SELECT module FROM module_settings WHERE institution_id = ? AND enabled ORDER BY module`).bind(f.inst.id).all<{ module: string }>()).results.map((m) => m.module) } catch { /* skip */ }
      try { for (const m of (await f.db.prepare(`SELECT DISTINCT module FROM module_settings`).all<{ module: string }>()).results) modules.add(m.module) } catch { /* skip */ }
      const s = subOf.get(f.inst.id)
      const pm = s ? planModules(s.modules) : []
      schools.push({ institution_id: f.inst.id, school: f.inst.name, plan: s?.plan_code, plan_name: und(s?.name ?? null), plan_modules: pm, enabled, beyond_plan: pm.length === 0 ? [] : enabled.filter((m) => !pm.includes(m)) })
    }
    return ok({ plans: planRows, schools, modules: [...modules].sort() })
  })
  r.put('/admin/platform/entitlements', plans, async (c) => {
    platformOnly(c)
    const req = await readJSON<{ institution_id?: string; module?: string; enabled?: boolean }>(c.req)
    const iid = (req.institution_id ?? '').trim()
    if (!isUUID(iid)) throw badRequest('institution_id must be a uuid')
    const module = (req.module ?? '').trim()
    if (module === '') throw badRequest('module is required')
    const inst = await c.env.CONTROL.prepare(`SELECT * FROM institutions WHERE id = ?`).bind(iid).first<Institution>()
    if (!inst) throw badRequest('no such school')
    await tenantDb(c.env, inst).prepare(`INSERT INTO module_settings (institution_id, module, enabled) VALUES (?, ?, ?) ON CONFLICT (institution_id, module) DO UPDATE SET enabled = excluded.enabled`).bind(iid, module, req.enabled ? 1 : 0).run()
    return ok({ institution_id: iid, module, enabled: !!req.enabled })
  })

  void notImplemented
}
