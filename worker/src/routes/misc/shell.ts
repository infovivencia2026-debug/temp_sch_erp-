import type { Router, Ctx } from '../../router'
import { badRequest, bool, isUUID, now, ok, readJSON } from '../../http'
import { can } from '../../identity'
import { institutionId, parseJSON, resolveScope, type Scope } from '../admin/common'
import { CATALOG_ROLES, IMPLEMENTED_FEATURES, allCatalogFeatureKeys, catalogLookup, type CatalogFeature } from '../admin/static_data'

/* Port of the loose shell routes: getRefData (academics.go), working_year.go,
   daterange.go, catalog.go (+ catalog_evidence.go, admissions_stages.go,
   gate.go/entitlement) and storeCatalogue (collections.go). */

// --- ref-data ----------------------------------------------------------------

async function refData(c: Ctx): Promise<Response> {
  const [years, classes, sections, subjects] = await c.db.batch<Record<string, unknown>>([
    c.db.prepare(`SELECT id, name, starts_on, ends_on, is_current FROM academic_years ORDER BY starts_on DESC`),
    c.db.prepare(`SELECT id, name, level, stream FROM classes ORDER BY level, name`),
    c.db.prepare(`SELECT sec.id, sec.class_id, c.name AS class_name, sec.academic_year_id, sec.name, sec.capacity, sec.room
        FROM sections sec JOIN classes c ON c.id = sec.class_id ORDER BY c.level, sec.name`),
    c.db.prepare(`SELECT id, name, code, is_scholastic FROM subjects ORDER BY name`),
  ])
  return ok({
    academic_years: years.results.map((y) => ({ id: y.id, name: y.name, starts_on: y.starts_on, ends_on: y.ends_on, is_current: bool(y.is_current) })),
    classes: classes.results.map((k) => ({ id: k.id, name: k.name, level: k.level, stream: k.stream ?? undefined })),
    sections: sections.results.map((s) => ({ id: s.id, class_id: s.class_id, class_name: s.class_name, academic_year_id: s.academic_year_id,
      name: s.name, capacity: s.capacity, room: s.room ?? undefined, enrolled: 0 })),
    subjects: subjects.results.map((s) => ({ id: s.id, name: s.name, code: s.code, is_scholastic: bool(s.is_scholastic) })),
  })
}

// --- the working year ----------------------------------------------------------

export const ERR_UNKNOWN_YEAR = 'academic_year_id names no academic year of this school'

/** workingYearIn: the year named, else the person's chosen one, else the current/latest. */
export async function workingYear(c: Ctx, explicit = ''): Promise<string | null> {
  explicit = explicit.trim() || (c.url.searchParams.get('academic_year_id') ?? '').trim()
  if (explicit !== '') {
    if (!isUUID(explicit)) throw badRequest(ERR_UNKNOWN_YEAR)
    const y = await c.db.prepare(`SELECT id FROM academic_years WHERE id = ?`).bind(explicit).first<{ id: string }>()
    if (!y) throw badRequest(ERR_UNKNOWN_YEAR)
    return y.id
  }
  const chosen = await c.db.prepare(`SELECT y.id FROM user_working_years w JOIN academic_years y ON y.id = w.academic_year_id WHERE w.user_id = ?`)
    .bind(c.id.userId).first<{ id: string }>()
  if (chosen) return chosen.id
  const latest = await c.db.prepare(`SELECT id FROM academic_years ORDER BY is_current DESC, starts_on DESC LIMIT 1`).first<{ id: string }>()
  return latest?.id ?? null
}

async function getWorkingYear(c: Ctx): Promise<Response> {
  const out: Record<string, unknown> = { academic_year_id: null, chosen: false, years: [] }
  if (!c.id.institution) return ok(out)
  const rows = await c.db.prepare(`SELECT id, name, starts_on, ends_on, is_current, (is_current OR ends_on >= date('now')) AS open
      FROM academic_years ORDER BY starts_on DESC`).all<{ id: string; name: string; starts_on: string; ends_on: string; is_current: number; open: number }>()
  out.years = rows.results.map((y) => ({ id: y.id, name: y.name, starts_on: y.starts_on, ends_on: y.ends_on, is_current: !!y.is_current, open: !!y.open }))
  const chosen = await c.db.prepare(`SELECT y.id FROM user_working_years w JOIN academic_years y ON y.id = w.academic_year_id WHERE w.user_id = ?`)
    .bind(c.id.userId).first<{ id: string }>()
  if (chosen) { out.academic_year_id = chosen.id; out.chosen = true; return ok(out) }
  const y = await workingYear(c)
  if (y) out.academic_year_id = y
  return ok(out)
}

// --- date ranges ---------------------------------------------------------------

const RANGE_PRESETS = [
  { value: 'today', label: 'Today', group: 'Recent' },
  { value: 'yesterday', label: 'Yesterday', group: 'Recent' },
  { value: 'last_7', label: 'Last 7 days', group: 'Recent' },
  { value: 'last_30', label: 'Last 30 days', group: 'Recent' },
  { value: 'this_week', label: 'This week', group: 'Calendar' },
  { value: 'this_month', label: 'This month', group: 'Calendar' },
  { value: 'last_month', label: 'Last month', group: 'Calendar' },
  { value: 'this_quarter', label: 'This quarter', group: 'Calendar' },
  { value: 'this_term', label: 'This term', group: 'School' },
  { value: 'this_year', label: 'This academic year', group: 'School' },
  { value: 'last_year', label: 'Last academic year', group: 'School' },
  { value: 'fin_year', label: 'This financial year (Apr–Mar)', group: 'School' },
  { value: 'custom', label: 'Custom range…', group: 'Custom' },
]

export interface DateRange { from: string; to: string; label: string; period: string }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
const dmy = (d: Date) => `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d))

/** resolveRange in daterange.go, with every date resolved in Asia/Kolkata (dates are handled as UTC-midnight stand-ins). */
export function resolveRange(c: Ctx): DateRange {
  const ist = new Date(Date.now() + 5.5 * 3_600_000)
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth(), d = ist.getUTCDate()
  const today = utc(y, m, d)
  const q = c.url.searchParams
  let period = q.get('period') ?? ''
  const f = q.get('from'), t = q.get('to')
  if (f && t && /^\d{4}-\d{2}-\d{2}$/.test(f) && /^\d{4}-\d{2}-\d{2}$/.test(t)) {
    let from = new Date(f + 'T00:00:00Z'), to = new Date(t + 'T00:00:00Z')
    if (!isNaN(from.getTime()) && !isNaN(to.getTime())) {
      if (to < from) [from, to] = [to, from]
      return { from: ymd(from), to: ymd(to), period: 'custom', label: dmy(from) + ' to ' + dmy(to) }
    }
  }
  const mk = (from: Date, to: Date, label: string, p: string): DateRange => ({ from: ymd(from), to: ymd(to), label, period: p })
  const ayStart = (yy: number, mm: number) => utc(mm < 5 ? yy - 1 : yy, 5, 1)
  const fyStart = (yy: number, mm: number) => utc(mm < 3 ? yy - 1 : yy, 3, 1)
  const yy2 = (dt: Date) => String(dt.getUTCFullYear() + 1).slice(2)
  if (period === '') period = 'this_month'
  switch (period) {
    case 'today': return mk(today, today, 'Today', period)
    case 'yesterday': { const v = addDays(today, -1); return mk(v, v, 'Yesterday', period) }
    case 'last_7': return mk(addDays(today, -6), today, 'Last 7 days', period)
    case 'last_30': return mk(addDays(today, -29), today, 'Last 30 days', period)
    case 'this_week': { const off = (today.getUTCDay() + 6) % 7; return mk(addDays(today, -off), today, 'This week', period) }
    case 'last_month': { const first = utc(y, m - 1, 1); return mk(first, utc(y, m, 0), 'Last month - ' + MONTHS[first.getUTCMonth()] + ' ' + first.getUTCFullYear(), period) }
    case 'this_quarter': { const qm = Math.floor(m / 3) * 3; return mk(utc(y, qm, 1), today, 'This quarter', period) }
    case 'this_term': return mk(ayStart(y, m), today, 'This term', period)
    case 'this_year': { const s = ayStart(y, m); return mk(s, today, 'This academic year - ' + s.getUTCFullYear() + '-' + yy2(s), period) }
    case 'last_year': { const s = utc(ayStart(y, m).getUTCFullYear() - 1, 5, 1); return mk(s, utc(s.getUTCFullYear() + 1, 5, 0), 'Last academic year - ' + s.getUTCFullYear() + '-' + yy2(s), period) }
    case 'fin_year': { const s = fyStart(y, m); return mk(s, today, 'Financial year ' + s.getUTCFullYear() + '-' + yy2(s), period) }
  }
  const first = utc(y, m, 1)
  return mk(first, today, 'This month - ' + MONTHS[m] + ' ' + y, 'this_month')
}

// --- entitlement (internal/entitlement) -----------------------------------------

const SECTION_MODULE: Record<string, string> = {
  students: 'students', admissions: 'students', enquiries: 'students', applications: 'students',
  academics: 'academics', my_classes: 'academics', teaching: 'academics', timetable: 'academics', learning: 'academics',
  homework: 'academics', department: 'academics', assessment_schemes: 'academics', question_papers_online_tests: 'academics',
  attendance: 'attendance',
  fees: 'fees', collections: 'fees', student_dues: 'fees', fee_structure: 'fees', concessions_refunds: 'fees',
  reconciliation: 'fees', ledgers: 'fees', payables: 'fees', assets_budget: 'fees',
  communication: 'communication', messaging: 'communication', messages: 'communication', notices_calendar: 'communication',
  examinations: 'exams', exams_results: 'exams', marks_report_cards: 'exams', evaluation: 'exams',
  directory_workload: 'hr', onboarding_exit: 'hr', verification: 'hr', leave: 'hr', payroll: 'hr', statutory: 'hr', hiring_growth: 'hr', welfare: 'hr',
  transport: 'transport', my_childs_bus: 'transport',
  library: 'library', hostel: 'hostel', stores: 'inventory',
}

export interface Entitlement { active: boolean; code: string; reason: string; planCode: string; planName: string; status: string; customIntegration: boolean; all: boolean; modules: Set<string> }

/** entitlement.Resolve, read from CONTROL. plans.modules is JSON: a list of names, or an object of name -> enabled. */
export async function entitlementFor(c: Ctx): Promise<Entitlement> {
  const platform: Entitlement = { active: true, code: '', reason: '', planCode: 'platform', planName: '', status: 'platform', customIntegration: true, all: true, modules: new Set() }
  if (!c.id.institution) return platform
  const s = await c.env.CONTROL.prepare(`SELECT s.plan_code, p.name, s.status, s.trial_ends_on, p.modules, p.custom_integration
      FROM subscriptions s LEFT JOIN plans p ON p.code = s.plan_code WHERE s.institution_id = ? ORDER BY s.started_on DESC LIMIT 1`)
    .bind(c.id.institution.id).first<{ plan_code: string; name: string | null; status: string | null; trial_ends_on: string | null; modules: string | null; custom_integration: number | null }>()
  if (!s || s.status === null) {
    return { active: false, code: 'none', reason: 'This school does not have a subscription yet. Choose a plan to switch the system on.',
      planCode: '', planName: '', status: '', customIntegration: false, all: false, modules: new Set() }
  }
  const raw: unknown = parseJSON<unknown>(s.modules, [])
  const mods = new Set<string>()
  if (Array.isArray(raw)) {
    for (const m of raw) if (typeof m === 'string') mods.add(m)
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (v) mods.add(k)
  }
  const st: Entitlement = { active: false, code: '', reason: '', planCode: s.plan_code ?? '', planName: s.name ?? '', status: s.status,
    customIntegration: !!s.custom_integration, all: mods.size === 0, modules: mods }
  switch (st.status) {
    case 'active': st.active = true; break
    case 'trial':
      if (s.trial_ends_on && Date.parse(s.trial_ends_on) < Date.now()) {
        const d = new Date(s.trial_ends_on)
        st.code = 'expired'
        st.reason = 'Your trial ended on ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + '. Subscribe to carry on where you left off, your data is all still here.'
      } else st.active = true
      break
    case 'past_due': st.code = 'past_due'; st.reason = "We have not been able to collect this year's subscription. Settle the invoice and the system switches straight back on."; break
    case 'suspended': st.code = 'suspended'; st.reason = "This school's account is suspended. Please contact us."; break
    case 'cancelled': st.code = 'cancelled'; st.reason = 'This subscription was cancelled. Your data is retained · subscribe again to reopen the school.'; break
    default: st.code = 'none'; st.reason = 'This school does not have an active subscription.'
  }
  return st
}

export function entitlementAllows(st: Entitlement, sectionSlug: string): boolean {
  const mod = SECTION_MODULE[sectionSlug]
  if (!mod) return true
  if (st.all) return true
  return st.modules.has(mod)
}

// --- the catalog ------------------------------------------------------------------

const SETUP_SECTIONS = new Set(['getting_started', 'home', 'my_profile'])
const EVIDENCE_KEYS = new Set([
  'parent.my_childs_bus.live_bus_tracking', 'parent.alerts_preferences.parent_bus_proximity_radius_customizer',
  'institution_admin.hostel.hostel_rooms', 'institution_admin.hostel.outpasses_mess', 'institution_admin.hostel.night_study_attendance',
  'institution_admin.hostel.room_inventory_checklists', 'institution_admin.hostel.hostel_visitor_log', 'institution_admin.hostel.boarder_laundry',
])
const STAGE_KEYS = new Set(['admissions.applications.entrance_tests', 'admissions.applications.interviews'])

function hasScope(sc: Scope, c: Ctx, s: string): boolean {
  switch (s) {
    case 'platform': return sc.platformAdmin
    case 'institution': return sc.platformAdmin || !!c.id.institution
    case 'campus': return sc.allCampuses || sc.campusIds.length > 0
    case 'department': return true
    case 'assigned_classes': return sc.teaches
    case 'self': return true
    case 'children': return sc.studentIds.length > 0
    default: return false
  }
}

async function anyRow(c: Ctx, sql: string, ...args: unknown[]): Promise<boolean> {
  try {
    const r = await c.db.prepare(sql).bind(...args).first<{ ok: number }>()
    return !!r?.ok
  } catch { return false }
}

async function setupIncomplete(c: Ctx): Promise<boolean> {
  if (c.id.platformAdmin || !c.id.institution) return false
  try {
    const r = await c.db.prepare(`SELECT (SELECT count(*) FROM classes) AS classes, (SELECT count(*) FROM sections) AS sections,
        (SELECT count(*) FROM subjects) AS subjects, (SELECT count(*) FROM class_subjects) AS cs,
        (SELECT count(*) FROM employees WHERE status = 'active') AS staff, (SELECT count(*) FROM students WHERE status = 'active') AS students,
        COALESCE((SELECT district IS NOT NULL AND state IS NOT NULL AND affiliation_board IS NOT NULL FROM institutions WHERE id = ?), 0) AS profile_done`)
      .bind(c.id.institution.id).first<{ classes: number; sections: number; subjects: number; cs: number; staff: number; students: number; profile_done: number }>()
    if (!r) return false
    return !r.profile_done || r.classes === 0 || r.sections === 0 || r.subjects === 0 || r.cs === 0 || r.staff === 0 || r.students === 0
  } catch (err) { console.error(err); return false }
}

async function getCatalog(c: Ctx): Promise<Response> {
  const sc = await resolveScope(c)
  const ent = await entitlementFor(c)
  const locked = await setupIncomplete(c)
  const implemented = [...IMPLEMENTED_FEATURES].sort()

  // heldRoleKeys and catalogRoleKeys share one read.
  const heldRows = c.id.platformAdmin ? { results: [] as { key: string }[] } :
    await c.db.prepare(`SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`).bind(c.id.userId).all<{ key: string }>()
  const mine = new Set(c.id.platformAdmin ? c.id.roles : heldRows.results.map((x) => x.key))
  let held = new Set<string>()
  let viewingAll = false
  if (!c.id.platformAdmin) {
    if (mine.has('institution_admin')) {
      for (const role of CATALOG_ROLES) {
        if (['super_admin', 'seller_admin', 'student', 'parent'].includes(role.key)) continue
        held.add(role.key)
      }
      viewingAll = true
    } else {
      for (const role of CATALOG_ROLES) if (mine.has(role.key)) held.add(role.key)
    }
  }
  const features = allCatalogFeatureKeys()
  const directFeatures = new Set<string>()
  if (!c.id.platformAdmin) {
    const rows = await c.db.prepare(`SELECT permission_key FROM user_permissions WHERE user_id = ?`).bind(c.id.userId).all<{ permission_key: string }>()
    for (const r of rows.results) if (features.has(r.permission_key)) directFeatures.add(r.permission_key)
  }

  // Evidence and stage gates, each asked at most once per response.
  const evidence = new Map<string, boolean>()
  const evidenceFor = async (key: string): Promise<boolean> => {
    if (evidence.has(key)) return evidence.get(key)!
    let v = true
    if (key === 'parent.my_childs_bus.live_bus_tracking' || key === 'parent.alerts_preferences.parent_bus_proximity_radius_customizer') {
      const ids = sc.studentIds
      v = ids.length > 0 && await anyRow(c, `SELECT EXISTS (SELECT 1 FROM transport_allocations ta WHERE ta.student_id IN (SELECT value FROM json_each(?))
        AND (ta.valid_to IS NULL OR ta.valid_to >= date('now'))) AS ok`, JSON.stringify(ids))
    } else if (key.startsWith('institution_admin.hostel.')) {
      v = await anyRow(c, `SELECT EXISTS (SELECT 1 FROM hostel_rooms) AS ok`)
    }
    evidence.set(key, v)
    return v
  }
  let stages: { entrance_test: boolean; interview: boolean } | null = null
  const stageAllowed = async (key: string): Promise<boolean> => {
    if (!stages) {
      stages = { entrance_test: true, interview: true }
      try {
        const r = await c.db.prepare(`SELECT config FROM module_settings WHERE module = 'admissions'`).first<{ config: string }>()
        const m = parseJSON<Record<string, unknown>>(r?.config, {})
        if (typeof m.entrance_test === 'boolean') stages.entrance_test = m.entrance_test
        if (typeof m.interview === 'boolean') stages.interview = m.interview
      } catch { /* default both on */ }
    }
    if (key === 'admissions.applications.entrance_tests') return stages.entrance_test
    if (key === 'admissions.applications.interviews') return stages.interview
    return true
  }
  const canKey = (k: string) => viewingAll || can(c.id, k)
  const gate = async (secSlug: string, f: CatalogFeature): Promise<boolean> => {
    if (!entitlementAllows(ent, secSlug)) return false
    if (locked && !SETUP_SECTIONS.has(secSlug)) return false
    if (!canKey(f.key)) return false
    if (EVIDENCE_KEYS.has(f.key) && !(await evidenceFor(f.key))) return false
    if (STAGE_KEYS.has(f.key) && !(await stageAllowed(f.key))) return false
    return true
  }
  const feat = (f: CatalogFeature, inScope: boolean) => ({ key: f.key, slug: f.slug, name: f.name, summary: f.summary, scope: f.scope, tier: f.tier, in_scope: inScope, live: IMPLEMENTED_FEATURES.has(f.key) })

  type Sec = { slug: string; name: string; workspace: string; features: ReturnType<typeof feat>[] }
  type Role = { key: string; name: string; sections: Sec[] }
  const ordered = [...CATALOG_ROLES.filter((r) => mine.has(r.key)), ...CATALOG_ROLES.filter((r) => !mine.has(r.key))]
  const roles: Role[] = []
  for (const role of ordered) {
    if (held.size > 0 && !held.has(role.key)) continue
    const out: Role = { key: role.key, name: role.name, sections: [] }
    for (const sec of role.sections) {
      if (!entitlementAllows(ent, sec.slug)) continue
      if (locked && !SETUP_SECTIONS.has(sec.slug)) continue
      const cs: Sec = { slug: sec.slug, name: sec.name, workspace: sec.workspace, features: [] }
      for (const f of sec.features) {
        if (!(await gate(sec.slug, f))) continue
        cs.features.push(feat(f, hasScope(sc, c, f.scope) || viewingAll))
      }
      if (cs.features.length > 0) out.sections.push(cs)
    }
    if (out.sections.length > 0) roles.push(out)
  }

  if (directFeatures.size > 0) {
    const emitted = new Set<string>()
    for (const ro of roles) for (const s of ro.sections) for (const f of s.features) emitted.add(f.key)
    const granted: ReturnType<typeof feat>[] = []
    for (const role of CATALOG_ROLES) for (const sec of role.sections) for (const f of sec.features) {
      if (!directFeatures.has(f.key) || emitted.has(f.key)) continue
      if (!(await gate(sec.slug, f))) continue
      granted.push(feat(f, true))
      emitted.add(f.key)
    }
    if (granted.length > 0) {
      const primary = roles.findIndex((ro) => mine.has(ro.key))
      if (primary >= 0) {
        roles[primary].sections.push({ slug: 'granted', name: 'Granted to you', workspace: roles[primary].name, features: granted })
      } else {
        roles.push({ key: roles.length > 0 ? roles[0].key : 'granted', name: 'Granted to you',
          sections: [{ slug: 'granted', name: 'Granted to you', workspace: 'Granted to you', features: granted }] })
      }
    }
  }

  if (can(c.id, 'academics.attendance.read.all')) {
    const fk = 'faculty.attendance.absentee_followup'
    const has = roles.some((ro) => ro.sections.some((s) => s.features.some((f) => f.key === fk)))
    const def = catalogLookup(fk)
    if (!has && roles.length > 0 && IMPLEMENTED_FEATURES.has(fk) && def) {
      const f = { key: fk, slug: def.slug, name: def.name, summary: def.summary, scope: def.scope, tier: def.tier, in_scope: true, live: true }
      const r0 = roles[0]
      const att = r0.sections.find((s) => s.slug === 'attendance')
      if (att) att.features.push(f)
      else r0.sections.push({ slug: 'attendance', name: 'Attendance', workspace: 'Attendance', features: [f] })
    }
  }

  return ok({
    setup_required: locked,
    active_role: roles.length > 0 ? roles[0].key : '',
    roles,
    scope: { platform_admin: sc.platformAdmin, all_campuses: sc.allCampuses, campuses: sc.campusIds.length,
      departments: sc.departmentIds.length, sections: sc.sectionIds.length, students: sc.studentIds.length },
    implemented,
  })
}

// --- the store's shop window (collections.go storeCatalogue) ----------------------

async function storeCatalogue(c: Ctx): Promise<Response> {
  const inst = institutionId(c)
  const [prods, vars] = await c.db.batch<Record<string, unknown>>([
    c.db.prepare(`SELECT p.id, p.code, p.name, p.category, COALESCE(p.notes, '') AS description, p.sale_price_paise, p.image_key
        FROM store_products p WHERE p.institution_id = ? AND p.is_active ORDER BY p.category, p.name`).bind(inst),
    c.db.prepare(`SELECT v.product_id, v.size, v.colour, v.variant_note, COALESCE(v.sale_price_paise, p.sale_price_paise) AS price, i.on_hand
        FROM store_product_variants v JOIN store_products p ON p.id = v.product_id JOIN inventory_items i ON i.id = v.item_id
       WHERE p.institution_id = ? AND p.is_active AND v.is_active
       ORDER BY p.name, (v.size IS NOT NULL), v.size, (v.colour IS NOT NULL), v.colour`).bind(inst),
  ])
  const byProduct = new Map<string, unknown[]>()
  for (const v of vars.results) {
    const parts = [v.size, v.colour, v.variant_note].map((p) => (typeof p === 'string' ? p.trim() : '')).filter((p) => p !== '')
    const on = Number(v.on_hand ?? 0)
    const list = byProduct.get(String(v.product_id)) ?? []
    list.push({ label: parts.join(' / '), price: Number(v.price ?? 0), in_stock: on > 0, stock: on })
    byProduct.set(String(v.product_id), list)
  }
  return ok(prods.results.map((p) => {
    const key = typeof p.image_key === 'string' ? p.image_key.trim() : ''
    return { code: p.code, name: p.name, category: p.category, description: p.description, price: Number(p.sale_price_paise ?? 0),
      image_url: key ? '/api/v1/files/' + key + '?inline=1' : '', variants: byProduct.get(String(p.id)) ?? [] }
  }))
}

export function registerShell(r: Router): void {
  r.get('/ref-data', 'auth', refData)
  r.get('/working-year', 'auth', getWorkingYear)
  r.put('/working-year', 'auth', async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ academic_year_id?: string }>(c.req)
    const want = (req.academic_year_id ?? '').trim()
    if (want === '') {
      await c.db.prepare(`DELETE FROM user_working_years WHERE user_id = ?`).bind(c.id.userId).run()
    } else {
      const year = await workingYear(c, want)
      await c.db.prepare(`INSERT INTO user_working_years (user_id, institution_id, academic_year_id, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (user_id, institution_id) DO UPDATE SET academic_year_id = excluded.academic_year_id, updated_at = excluded.updated_at`)
        .bind(c.id.userId, inst, year, now()).run()
    }
    return getWorkingYear(c)
  })
  r.get('/date-ranges', 'auth', () => ok({ items: RANGE_PRESETS, default: 'this_month' }))
  r.get('/catalog', 'auth', getCatalog)
  r.get('/store/catalogue', 'auth', storeCatalogue)
}
