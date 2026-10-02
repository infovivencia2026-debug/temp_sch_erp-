import type { SettingDecl, SettingRow, SettingSource, SettingValue } from '@shared/api/settings'
import { featureDefs, FEATURE_ROUTES } from '../routes/seller/features'
import { entitlementFromRow, type Entitlement } from '../routes/misc/shell'
import { DEFAULT_SETTINGS as DELIVERY } from './delivery'
import { DEFAULT_DAILY_CAP } from './ai/llm'

/* THE SETTINGS REGISTRY: every school-level setting the seller console can
   see, and the one road by which the vendor changes one.

   Each setting names an adapter onto the place the school's own screens
   already keep it (module_settings, message_settings, auth_policies, CONTROL
   institutions, CONTROL school_feature_overrides). Nothing is copied into a
   new table, so the school's screens keep reading and writing what they
   always did. The adapters below are the only SQL here, and each touches
   only its own settings table: STORAGE_TABLES lists them and the privacy
   test checks no school record table is among them.

   Resolution (docs/seller-controls.md): the school's stored value when it
   differs from the default that applies; otherwise that default's source:
   plan (CONTROL platform_setting_defaults scope 'plan:<code>'), platform
   (scope 'platform'), built-in (the code's own fallback). When nothing is
   stored the school runs on the built-in value, and that is what is shown:
   vendor defaults reach a school only when written into it (new schools at
   provisioning, existing ones through "Apply to schools" or Reset). */

type Store =
  | { kind: 'module_enabled'; module: string }
  | { kind: 'module_config'; module: string; path: string; enabledIfNew: 0 | 1; asString?: boolean }
  | { kind: 'row'; table: 'message_settings' | 'auth_policies'; column: string }
  | { kind: 'institution'; column: 'primary_color' | 'accent_color' | 'tagline' | 'login_headline' | 'login_message' | 'support_email' | 'support_phone' | 'timezone' | 'locale' }
  | { kind: 'feature'; feature: string; module: string }

export interface SettingDef extends SettingDecl { store: Store; pattern?: RegExp; maxLength?: number }

/** Every table an adapter reads or writes. Nothing else is reachable from the registry. */
export const STORAGE_TABLES = ['module_settings', 'message_settings', 'auth_policies', 'institutions', 'school_feature_overrides', 'platform_setting_defaults'] as const

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const COLOR = /^#[0-9a-fA-F]{6}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type D = Omit<SettingDef, 'defaults' | 'stored_in'> & { defaults?: boolean }
const mod = (module: string): Store => ({ kind: 'module_enabled', module })
const cfg = (module: string, path: string, enabledIfNew: 0 | 1 = 1, asString = false): Store => ({ kind: 'module_config', module, path, enabledIfNew, asString })
const row = (table: 'message_settings' | 'auth_policies', column: string): Store => ({ kind: 'row', table, column })
const inst = (column: Extract<Store, { kind: 'institution' }>['column']): Store => ({ kind: 'institution', column })

const SETTINGS: D[] = [
  // Logins & access
  { key: 'student_logins.enabled', group: 'logins', label: 'Student logins', help: 'Children may hold their own login for lessons and homework.', type: 'bool', builtin: true, editors: 'both', notify: true, store: mod('student_logins') },
  // Class Status
  { key: 'class_status.enabled', group: 'class_status', label: 'Class Status', help: 'Photos and short videos posted to a class for 24 hours.', type: 'bool', builtin: true, editors: 'both', notify: true, store: mod('class_status') },
  { key: 'class_status.needs_approval', group: 'class_status', label: 'Posts need approval', help: 'Posts by anyone who does not run Class Status wait for the principal.', type: 'bool', builtin: false, editors: 'both', notify: true, store: cfg('class_status', 'needs_approval') },
  { key: 'class_status.who', group: 'class_status', label: 'Who may post', help: 'Teachers, class teachers only, or administrators only.', type: 'enum', options: [{ value: 'teachers', label: 'Teachers' }, { value: 'class_teachers', label: 'Class teachers' }, { value: 'admins', label: 'Administrators' }], builtin: 'teachers', editors: 'both', notify: true, store: cfg('class_status', 'who') },
  { key: 'class_status.allow_video', group: 'class_status', label: 'Videos allowed', help: 'Off means photos and text only.', type: 'bool', builtin: true, editors: 'both', notify: false, store: cfg('class_status', 'allow_video') },
  { key: 'class_status.max_video_seconds', group: 'class_status', label: 'Longest video (seconds)', help: 'Between 5 and 60.', type: 'number', min: 5, max: 60, builtin: 30, editors: 'both', notify: false, store: cfg('class_status', 'max_video_seconds') },
  // Communication
  { key: 'messaging.digest_time', group: 'communication', label: 'Daily digest time', help: 'When the day\'s non-urgent messages go out together (HH:MM).', type: 'text', pattern: TIME, builtin: DELIVERY.digest_time, editors: 'both', notify: true, store: row('message_settings', 'digest_time') },
  { key: 'messaging.quiet_from', group: 'communication', label: 'Quiet hours start', help: 'No messages to families after this time (HH:MM). Empty for no quiet hours.', type: 'text', pattern: TIME, nullable: true, builtin: DELIVERY.quiet_from, editors: 'both', notify: true, store: row('message_settings', 'quiet_from') },
  { key: 'messaging.quiet_to', group: 'communication', label: 'Quiet hours end', help: 'Messages resume at this time (HH:MM).', type: 'text', pattern: TIME, nullable: true, builtin: DELIVERY.quiet_to, editors: 'both', notify: true, store: row('message_settings', 'quiet_to') },
  { key: 'messaging.daily_cap', group: 'communication', label: 'Messages per family per day', help: 'Most messages one family receives in a day; urgent ones are not counted.', type: 'number', min: 1, max: 100, builtin: DELIVERY.daily_cap, editors: 'both', notify: true, store: row('message_settings', 'daily_cap') },
  { key: 'messaging.dedup_minutes', group: 'communication', label: 'Repeat window (minutes)', help: 'The same message is not sent twice within this time.', type: 'number', min: 0, max: 10080, builtin: DELIVERY.dedup_minutes, editors: 'both', notify: false, store: row('message_settings', 'dedup_minutes') },
  // AI
  { key: 'ai.enabled', group: 'ai', label: 'AI assistant and briefs', help: 'Drafts, summaries and warnings, always labelled as AI on screen.', type: 'bool', builtin: true, editors: 'both', notify: true, store: mod('ai') },
  { key: 'ai.daily_cap', group: 'ai', label: 'AI requests per day', help: 'The school\'s daily limit across all its people.', type: 'number', min: 0, max: 100000, builtin: DEFAULT_DAILY_CAP, editors: 'both', notify: false, store: cfg('ai', 'daily_cap') },
  { key: 'ai.email_principal_brief', group: 'ai', label: 'E-mail the principal\'s brief', help: 'The morning brief is also sent by e-mail.', type: 'bool', builtin: false, editors: 'both', notify: true, store: cfg('ai', 'email_principal_brief') },
  { key: 'ai.parent_weekly_sms', group: 'ai', label: 'Weekly SMS to parents', help: 'A short weekly note on each child by SMS.', type: 'bool', builtin: false, editors: 'both', notify: true, store: cfg('ai', 'parent_weekly_sms') },
  { key: 'ai.parent_weekly_email', group: 'ai', label: 'Weekly e-mail to parents', help: 'A short weekly note on each child by e-mail.', type: 'bool', builtin: false, editors: 'both', notify: true, store: cfg('ai', 'parent_weekly_email') },
  // Admissions
  { key: 'admissions.entrance_test', group: 'admissions', label: 'Entrance test stage', help: 'Applications go through an entrance test.', type: 'bool', builtin: true, editors: 'both', notify: false, store: cfg('admissions', 'entrance_test') },
  { key: 'admissions.interview', group: 'admissions', label: 'Interview stage', help: 'Applications go through an interview.', type: 'bool', builtin: true, editors: 'both', notify: false, store: cfg('admissions', 'interview') },
  { key: 'admissions.enrolment_needs_approval', group: 'admissions', label: 'Enrolment needs approval', help: 'An admitted child is enrolled only after the principal approves.', type: 'bool', builtin: false, editors: 'both', notify: true, store: cfg('admissions', 'enrolment_needs_approval', 1, true) },
  // Exams
  { key: 'exams.report_card_font', group: 'exams', label: 'Report card font', help: 'The typeface printed report cards use.', type: 'enum', options: [{ value: 'times', label: 'Times New Roman' }, { value: 'arial', label: 'Arial' }, { value: 'calibri', label: 'Calibri' }], builtin: 'times', editors: 'both', notify: false, store: cfg('examinations', 'report_card_font') },
  // Fees & fines
  { key: 'fees.cheque_bounce_fine_paise', group: 'fees', label: 'Bounced cheque fine (paise)', help: 'Added to the bill when a cheque bounces. 0 for none.', type: 'number', min: 0, max: 10_000_000, builtin: 0, editors: 'both', notify: true, store: cfg('finance', 'cheque_bounce_fine_paise', 1, true) },
  { key: 'fees.library_fine_per_day_paise', group: 'fees', label: 'Library fine per day (paise)', help: 'Charged for each day a book is late.', type: 'number', min: 0, max: 100_000, builtin: 100, editors: 'both', notify: true, store: cfg('library_fines', 'fine_per_day_paise') },
  // Branding & app (CONTROL)
  { key: 'branding.primary_color', group: 'branding', label: 'School colour', help: 'Used on the sign-in page, the app and printed documents.', type: 'text', pattern: COLOR, builtin: '#1e40af', editors: 'seller', notify: true, store: inst('primary_color') },
  { key: 'branding.accent_color', group: 'branding', label: 'Accent colour', help: 'A second colour for highlights. Empty for none.', type: 'text', pattern: COLOR, nullable: true, builtin: null, editors: 'seller', notify: true, store: inst('accent_color') },
  { key: 'branding.tagline', group: 'branding', label: 'Tagline', help: 'One line under the school\'s name.', type: 'text', maxLength: 120, nullable: true, builtin: null, editors: 'seller', notify: true, store: inst('tagline') },
  { key: 'branding.login_headline', group: 'branding', label: 'Sign-in headline', help: 'The heading on the school\'s sign-in page.', type: 'text', maxLength: 120, nullable: true, builtin: null, editors: 'seller', notify: true, store: inst('login_headline') },
  { key: 'branding.login_message', group: 'branding', label: 'Sign-in message', help: 'A short note under the heading, such as office hours.', type: 'text', maxLength: 400, nullable: true, builtin: null, editors: 'seller', notify: true, store: inst('login_message') },
  { key: 'branding.support_email', group: 'branding', label: 'Help e-mail', help: 'Shown to the school\'s people when they need help signing in.', type: 'text', pattern: EMAIL, nullable: true, builtin: null, editors: 'seller', notify: false, store: inst('support_email') },
  { key: 'branding.support_phone', group: 'branding', label: 'Help phone', help: 'Shown next to the help e-mail.', type: 'text', maxLength: 30, nullable: true, builtin: null, editors: 'seller', notify: false, store: inst('support_phone') },
  { key: 'branding.timezone', group: 'branding', label: 'Time zone', help: 'Decides the school\'s day for attendance, digests and AI limits.', type: 'enum', options: ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Kathmandu', 'Asia/Dhaka', 'Europe/London', 'Africa/Nairobi', 'America/New_York'].map((v) => ({ value: v, label: v })), builtin: 'Asia/Kolkata', editors: 'seller', notify: true, store: inst('timezone') },
  { key: 'branding.locale', group: 'branding', label: 'Number and date format', help: 'How dates and amounts are written.', type: 'enum', options: [{ value: 'en-IN', label: 'India (en-IN)' }, { value: 'en-GB', label: 'United Kingdom (en-GB)' }, { value: 'en-US', label: 'United States (en-US)' }], builtin: 'en-IN', editors: 'seller', notify: true, store: inst('locale') },
  // Security & sessions
  { key: 'security.password_min_length', group: 'security', label: 'Shortest password', help: 'Characters a new password needs, 8 to 64.', type: 'number', min: 8, max: 64, builtin: 10, editors: 'both', notify: true, store: row('auth_policies', 'password_min_length') },
  { key: 'security.password_expiry_days', group: 'security', label: 'Password expiry (days)', help: 'People must choose a new password after this many days. 0 for never.', type: 'number', min: 0, max: 730, builtin: 0, editors: 'both', notify: true, store: row('auth_policies', 'password_expiry_days') },
  { key: 'security.session_idle_minutes', group: 'security', label: 'Sign out after idle (minutes)', help: 'A session with no activity for this long is ended.', type: 'number', min: 5, max: 1440, builtin: 120, editors: 'both', notify: true, store: row('auth_policies', 'session_idle_minutes') },
  { key: 'security.mfa_grace_days', group: 'security', label: 'Two-step sign-in grace (days)', help: 'Days a person has to set up two-step sign-in once their role requires it.', type: 'number', min: 0, max: 90, builtin: 7, editors: 'both', notify: true, store: row('auth_policies', 'mfa_grace_days') },
  { key: 'security.activity_recording', group: 'security', label: 'Record staff activity', help: 'Sign-ins, screens and time spent. The school decides; the vendor can only forbid it under Features.', type: 'bool', builtin: false, editors: 'school', notify: false, store: mod('session_activity') },
  { key: 'security.activity_retention_days', group: 'security', label: 'Keep activity records (days)', help: 'Between 7 and 730.', type: 'number', min: 7, max: 730, builtin: 90, editors: 'both', notify: false, store: cfg('session_activity', 'retention_days', 0) },
]

function describe(s: Store): string {
  switch (s.kind) {
    case 'module_enabled': return `module_settings '${s.module}'.enabled`
    case 'module_config': return `module_settings '${s.module}'.config.${s.path}`
    case 'row': return `${s.table}.${s.column}`
    case 'institution': return `CONTROL institutions.${s.column}`
    case 'feature': return `CONTROL school_feature_overrides '${s.feature}'`
  }
}

let all: SettingDef[] | null = null
let byKey: Map<string, SettingDef> | null = null
/** Every declared setting: the feature switches first, then the rest. */
export function settingDefs(): SettingDef[] {
  if (all) return all
  const features: SettingDef[] = featureDefs().map((f) => ({
    key: 'feature.' + f.id, group: 'features', label: f.name, help: `${f.section}. ${FEATURE_ROUTES[f.id] ? 'Its screens and API are refused when off.' : 'Hidden from menus when off.'}`,
    type: 'bool', builtin: true, editors: 'seller', notify: true, defaults: false,
    store: { kind: 'feature', feature: f.id, module: f.module }, stored_in: '',
  }))
  all = [...features, ...SETTINGS.map((d) => ({ ...d, defaults: d.defaults ?? true, stored_in: '' }) as SettingDef)]
  for (const d of all) d.stored_in = describe(d.store)
  byKey = new Map(all.map((d) => [d.key, d]))
  return all
}
export function settingDef(key: string): SettingDef | undefined {
  settingDefs()
  return byKey!.get(key)
}
/** Editable by the vendor: declared, and not the school's own decision. */
export const vendorEditable = (d: SettingDef) => d.editors !== 'school'

export function declOf(d: SettingDef): SettingDecl {
  const { store: _s, pattern: _p, maxLength: _m, ...decl } = d
  return decl
}

/* --- validation ------------------------------------------------------------ */

export class SettingError extends Error {}

/** The value cleaned to the setting's type, or a SettingError saying why not. */
export function cleanValue(d: SettingDef, v: unknown): SettingValue {
  if ((v === null || v === '') && d.nullable) return null
  switch (d.type) {
    case 'bool':
      if (typeof v !== 'boolean') throw new SettingError(`${d.label}: choose on or off`)
      return v
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
      if (!Number.isInteger(n)) throw new SettingError(`${d.label}: a whole number`)
      if ((d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max)) throw new SettingError(`${d.label}: between ${d.min} and ${d.max}`)
      return n
    }
    case 'enum':
      if (typeof v !== 'string' || !d.options!.some((o) => o.value === v)) throw new SettingError(`${d.label}: one of ${d.options!.map((o) => o.label).join(', ')}`)
      return v
    case 'text': {
      if (typeof v !== 'string') throw new SettingError(`${d.label}: text`)
      const s = v.trim()
      if (!s) throw new SettingError(`${d.label}: cannot be empty`)
      if (d.pattern && !d.pattern.test(s)) throw new SettingError(`${d.label}: ${d.pattern === TIME ? 'a time as HH:MM' : d.pattern === COLOR ? 'a colour as #RRGGBB' : 'an e-mail address'}`)
      if (s.length > (d.maxLength ?? 200)) throw new SettingError(`${d.label}: at most ${d.maxLength ?? 200} characters`)
      return s
    }
  }
}

/* --- reading ---------------------------------------------------------------- */

export interface SchoolRef { id: string; plan_code: string | null }
/** What the adapters need: CONTROL and the school's own database. */
export interface Stores { control: D1Database; db: D1Database }

type Stored = Map<string, SettingValue>

function decode(d: SettingDef, raw: unknown): SettingValue {
  if (raw === null || raw === undefined) return null
  if (d.type === 'bool') return raw === true || raw === 1 || raw === 'true' || raw === '1'
  if (d.type === 'number') { const n = Number(raw); return Number.isFinite(n) ? Math.trunc(n) : null }
  return String(raw)
}

/** The values a school has stored, by key; a key absent here runs on its built-in value. */
export async function readStored(s: Stores, school: SchoolRef, defs = settingDefs()): Promise<Stored> {
  const out: Stored = new Map()
  const need = new Set(defs.map((d) => d.store.kind))
  const [mods, msg, auth, instRow, ov] = await Promise.all([
    need.has('module_enabled') || need.has('module_config')
      ? s.db.prepare(`SELECT module, enabled, config FROM module_settings`).all<{ module: string; enabled: number; config: string | null }>().then((r) => r.results).catch(() => [])
      : [],
    need.has('row') ? s.db.prepare(`SELECT * FROM message_settings LIMIT 1`).first<Record<string, unknown>>().catch(() => null) : null,
    need.has('row') ? s.db.prepare(`SELECT * FROM auth_policies WHERE institution_id = ?`).bind(school.id).first<Record<string, unknown>>().catch(() => null) : null,
    need.has('institution') ? s.control.prepare(`SELECT * FROM institutions WHERE id = ?`).bind(school.id).first<Record<string, unknown>>() : null,
    need.has('feature')
      ? s.control.prepare(`SELECT feature_id, enabled FROM school_feature_overrides WHERE institution_id = ? AND (ends_at IS NULL OR ends_at > ?)`)
        .bind(school.id, new Date().toISOString()).all<{ feature_id: string; enabled: number }>().then((r) => r.results).catch(() => [])
      : [],
  ])
  const modBy = new Map(mods.map((m) => [m.module, m]))
  const ovBy = new Map(ov.map((o) => [o.feature_id, !!o.enabled]))
  for (const d of defs) {
    const st = d.store
    if (st.kind === 'module_enabled') {
      const m = modBy.get(st.module)
      if (m) out.set(d.key, !!m.enabled)
    } else if (st.kind === 'module_config') {
      const m = modBy.get(st.module)
      if (!m) continue
      let c: Record<string, unknown> = {}
      try { c = JSON.parse(m.config || '{}') } catch { /* nothing stored */ }
      if (c[st.path] !== undefined && c[st.path] !== null) out.set(d.key, decode(d, c[st.path]))
    } else if (st.kind === 'row') {
      const r = st.table === 'message_settings' ? msg : auth
      if (r) out.set(d.key, decode(d, r[st.column]))
    } else if (st.kind === 'institution') {
      if (instRow) { const v = decode(d, instRow[st.column]); if (v !== null || d.nullable) out.set(d.key, v) }
    } else if (ovBy.has(st.feature)) out.set(d.key, ovBy.get(st.feature)!)
  }
  return out
}

export interface Defaults { platform: Map<string, SettingValue>; plan: Map<string, SettingValue> }

export async function readDefaults(control: D1Database, planCode: string | null): Promise<Defaults> {
  const rows = (await control.prepare(`SELECT scope, key, value FROM platform_setting_defaults WHERE scope = 'platform' OR scope = ?`)
    .bind('plan:' + (planCode ?? '')).all<{ scope: string; key: string; value: string }>().catch(() => ({ results: [] }))).results
  const out: Defaults = { platform: new Map(), plan: new Map() }
  for (const r of rows) {
    const d = settingDef(r.key)
    if (!d) continue
    let v: SettingValue
    try { v = cleanValue(d, JSON.parse(r.value)) } catch { continue }
    ;(r.scope === 'platform' ? out.platform : out.plan).set(r.key, v)
  }
  return out
}

const planAllows = (ent: Entitlement, module: string) => module === 'core' || ent.all || ent.modules.has(module)

/** The default a reset would set, and whose it is. */
export function defaultFor(d: SettingDef, defaults: Defaults, ent: Entitlement | null): { value: SettingValue; source: Exclude<SettingSource, 'school'> } {
  if (d.store.kind === 'feature') return { value: ent ? planAllows(ent, d.store.module) : true, source: 'plan' }
  if (defaults.plan.has(d.key)) return { value: defaults.plan.get(d.key)!, source: 'plan' }
  if (defaults.platform.has(d.key)) return { value: defaults.platform.get(d.key)!, source: 'platform' }
  return { value: d.builtin, source: 'built-in' }
}

export function resolveRows(defs: SettingDef[], stored: Stored, defaults: Defaults, ent: Entitlement | null): SettingRow[] {
  return defs.map((d) => {
    const def = defaultFor(d, defaults, ent)
    const has = stored.has(d.key)
    const value = has ? stored.get(d.key)! : d.store.kind === 'feature' ? def.value : d.builtin
    const source: SettingSource = !has ? (d.store.kind === 'feature' ? 'plan' : 'built-in') : value === def.value ? def.source : 'school'
    return { ...declOf(d), value, source, default_value: def.value, default_source: def.source, vendor_editable: vendorEditable(d) }
  })
}

export async function entitlementOf(control: D1Database, institutionId: string): Promise<Entitlement> {
  const r = await control.prepare(`SELECT s.plan_code, p.name, s.status, s.trial_ends_on, p.modules, p.custom_integration
      FROM subscriptions s LEFT JOIN plans p ON p.code = s.plan_code WHERE s.institution_id = ? ORDER BY s.started_on DESC LIMIT 1`)
    .bind(institutionId).first()
  return entitlementFromRow(r as never)
}

/** A school's every setting, resolved. */
export async function schoolRows(s: Stores, school: SchoolRef, defs = settingDefs()): Promise<SettingRow[]> {
  const [stored, defaults, ent] = await Promise.all([readStored(s, school, defs), readDefaults(s.control, school.plan_code), entitlementOf(s.control, school.id)])
  return resolveRows(defs, stored, defaults, ent)
}

/* --- writing ---------------------------------------------------------------- */

/** The statements that store one value. The only writes the registry makes into a school. */
export function writeStmts(s: Stores, school: SchoolRef, d: SettingDef, v: SettingValue, by: string | null): { control: D1PreparedStatement[]; tenant: D1PreparedStatement[] } {
  const t = new Date().toISOString()
  const st = d.store
  switch (st.kind) {
    case 'module_enabled':
      return { control: [], tenant: [s.db.prepare(`INSERT INTO module_settings (institution_id, module, enabled, config) VALUES (?, ?, ?, '{}')
          ON CONFLICT (institution_id, module) DO UPDATE SET enabled = excluded.enabled`).bind(school.id, st.module, v ? 1 : 0)] }
    case 'module_config': {
      const stored = st.asString ? String(v) : v
      return { control: [], tenant: [s.db.prepare(`INSERT INTO module_settings (institution_id, module, enabled, config) VALUES (?1, ?2, ?3, json_object(?4, json(?5)))
          ON CONFLICT (institution_id, module) DO UPDATE SET config = json_set(COALESCE(NULLIF(module_settings.config, ''), '{}'), '$.' || ?4, json(?5))`)
        .bind(school.id, st.module, st.enabledIfNew, st.path, JSON.stringify(stored))] }
    }
    case 'row': {
      const seed = st.table === 'message_settings'
        ? s.db.prepare(`INSERT INTO message_settings (institution_id, digest_time, quiet_from, quiet_to, daily_cap, dedup_minutes, updated_at, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (institution_id) DO NOTHING`)
          .bind(school.id, DELIVERY.digest_time, DELIVERY.quiet_from, DELIVERY.quiet_to, DELIVERY.daily_cap, DELIVERY.dedup_minutes, t, by)
        : s.db.prepare(`INSERT INTO auth_policies (institution_id, updated_at) VALUES (?, ?) ON CONFLICT (institution_id) DO NOTHING`).bind(school.id, t)
      // The column comes from the declaration above, never from a request.
      const set = s.db.prepare(`UPDATE ${st.table} SET ${st.column} = ?, updated_at = ? WHERE institution_id = ?`).bind(v, t, school.id)
      return { control: [], tenant: [seed, set] }
    }
    case 'institution':
      return { control: [s.control.prepare(`UPDATE institutions SET ${st.column} = ?, updated_at = ? WHERE id = ?`).bind(v, t, school.id)], tenant: [] }
    case 'feature':
      return { control: [s.control.prepare(`INSERT INTO school_feature_overrides (institution_id, feature_id, enabled, ends_at, note, set_by, updated_at)
          VALUES (?, ?, ?, NULL, 'controls', ?, ?) ON CONFLICT (institution_id, feature_id) DO UPDATE SET enabled = excluded.enabled,
          ends_at = NULL, note = excluded.note, set_by = excluded.set_by, updated_at = excluded.updated_at`).bind(school.id, st.feature, v ? 1 : 0, by, t)], tenant: [] }
  }
}

/** A feature reset removes the override (back to the plan); anything else stores its default. */
export function resetStmts(s: Stores, school: SchoolRef, d: SettingDef, def: SettingValue, by: string | null) {
  if (d.store.kind === 'feature') {
    return { control: [s.control.prepare(`DELETE FROM school_feature_overrides WHERE institution_id = ? AND feature_id = ?`).bind(school.id, d.store.feature)], tenant: [] }
  }
  return writeStmts(s, school, d, def, by)
}

/** Writes plan, else platform, defaults into a school just provisioned. School-database settings only: CONTROL rows do not exist yet. */
export async function seedNewSchool(control: D1Database, db: D1Database, institutionId: string, planCode: string | null): Promise<number> {
  const defaults = await readDefaults(control, planCode)
  const s = { control, db }
  const stmts: D1PreparedStatement[] = []
  for (const d of settingDefs()) {
    if (!d.defaults || d.store.kind === 'institution' || d.store.kind === 'feature') continue
    const v = defaults.plan.has(d.key) ? defaults.plan.get(d.key)! : defaults.platform.get(d.key)
    if (v === undefined) continue
    stmts.push(...writeStmts(s, { id: institutionId, plan_code: planCode }, d, v, null).tenant)
  }
  if (stmts.length) await db.batch(stmts)
  return stmts.length
}

