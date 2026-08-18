import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Shared types and data hooks for the platform tier.
 *
 * Seventeen screens sit on one Go file and one migration, and most of them are
 * a read followed by a save that invalidates the read. Written once here so a
 * field renamed in internal/api/platform_config.go fails to compile in one
 * place rather than drifting silently in seventeen.
 *
 * Every path below is relative to /api/v1/admin/platform, which is where
 * mountPlatformConfig puts them.
 */

const BASE = '/api/v1/admin/platform'

export interface Option {
  value: string
  label: string
}

/** A read, and a save that refreshes it. The shape almost every screen wants. */
export function usePlatform<T>(key: string, path: string) {
  return useQuery({
    queryKey: ['platform', key],
    queryFn: () => api.get<T>(BASE + path),
  })
}

export function usePlatformSave<T, B = unknown>(
  key: string,
  path: string,
  method: 'post' | 'put' = 'put',
  /* Screens that read one endpoint and write another still have to refresh the
     first, and a screen whose save quietly leaves stale numbers on it is worse
     than one that does not save. */
  alsoInvalidate: string[] = [],
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: B) => api[method]<T>(BASE + path, body),
    onSuccess: () => {
      for (const k of [key, ...alsoInvalidate]) {
        qc.invalidateQueries({ queryKey: ['platform', k] })
      }
    },
  })
}

/**
 * A POST whose path is only known at the click: verify this domain, end that
 * session, update this ticket. The path travels with the call rather than with
 * the hook, because a hook created per row is a hook created inside a loop.
 */
export function usePlatformAction<T = unknown>(key: string, alsoInvalidate: string[] = []) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      api.post<T>(BASE + path, body),
    onSuccess: () => {
      for (const k of [key, ...alsoInvalidate]) {
        qc.invalidateQueries({ queryKey: ['platform', k] })
      }
    },
  })
}

export function usePlatformDelete(key: string, alsoInvalidate: string[] = []) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (path: string) => api.del(BASE + path),
    onSuccess: () => {
      for (const k of [key, ...alsoInvalidate]) {
        qc.invalidateQueries({ queryKey: ['platform', k] })
      }
    },
  })
}

/** Paise to rupees, the way every other screen in this product prints money. */
export function rupees(paise: number): string {
  return '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

/** Basis points as a percentage: 725 reads as 7.25%. */
export function bp(v: number): string {
  return (v / 100).toFixed(2).replace(/\.00$/, '') + '%'
}

export function bytes(n?: number | null): string {
  if (n == null) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export const MONTHS: Option[] = [
  { value: '1', label: 'January' }, { value: '2', label: 'February' },
  { value: '3', label: 'March' }, { value: '4', label: 'April' },
  { value: '5', label: 'May' }, { value: '6', label: 'June' },
  { value: '7', label: 'July' }, { value: '8', label: 'August' },
  { value: '9', label: 'September' }, { value: '10', label: 'October' },
  { value: '11', label: 'November' }, { value: '12', label: 'December' },
]

export const WEEKDAYS: Option[] = [
  { value: '0', label: 'Sunday' }, { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' }, { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' }, { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
]

// --- board affiliation and public disclosure ---------------------------------

export interface Disclosure {
  id: string
  campus_id?: string
  campus?: string
  document: string
  title: string
  reference_no?: string
  issuing_authority?: string
  issued_on?: string
  valid_to?: string
  file_key?: string
  public_url?: string
  notes?: string
  days_to_expiry?: number
}

export interface Affiliation {
  affiliation_board?: string
  affiliation_no?: string
  affiliation_valid_to?: string
  udise_code?: string
  days_to_renewal?: number
  documents: Disclosure[]
  document_kinds: Option[]
  boards: Option[]
  recorded: number
  expired: number
  expiring_90_days: number
}

// --- state board rules -------------------------------------------------------

export interface BoardConfig {
  id: string
  board: string
  stage: string
  pass_percent: number
  max_marks: number
  internal_weight_percent: number
  attendance_min_percent: number
  exam_pattern: string
  grading_scale_id?: string
  grading_scale?: string
  medium?: string
  is_default: boolean
}

export interface BoardConfigResponse {
  items: BoardConfig[]
  boards: Option[]
  stages: Option[]
  exam_patterns: Option[]
  grading_scales: Option[]
}

// --- district and mandal -----------------------------------------------------

export interface LocationCode {
  id: string
  parent_id?: string
  level: string
  code: string
  name: string
  active: boolean
  children: number
}

// --- SQAA --------------------------------------------------------------------

export interface SQAAFramework {
  code: string
  name: string
  authority: string
  version: string
  effective_from?: string
  status: string
  standards: number
  weight_bp: number
}

export interface SQAAStandard {
  id: string
  parent_id?: string
  code: string
  name: string
  description?: string
  weight_bp: number
  evidence_required: boolean
  sequence: number
}

export interface SQAAResponse {
  frameworks: SQAAFramework[]
  standards: SQAAStandard[]
  selected?: string
}

// --- campus classification ---------------------------------------------------

export interface CampusClass {
  id: string
  name: string
  code: string
  city?: string
  status: string
  management_type?: string
  school_category?: string
  udise_code?: string
  students: number
}

export interface CampusClassResponse {
  items: CampusClass[]
  institution_management_type?: string
  institution_school_category?: string
  management_types: Option[]
  school_categories: Option[]
  unclassified: number
}

// --- calendar model ----------------------------------------------------------

export interface AcademicYearRow {
  id: string
  name: string
  starts_on: string
  ends_on: string
  is_current: boolean
  terms: number
  matches_model: boolean
}

export interface CalendarModel {
  school_year_start_month: number
  school_year_end_month: number
  financial_year_start_month: number
  term_count: number
  week_start_day: number
  working_days_per_week: number
  saturday_pattern: string
  required_working_days: number
  school_year_label: string
  financial_year_label: string
  academic_years: AcademicYearRow[]
  current_terms: number
}

// --- branding ----------------------------------------------------------------

export interface BrandingProfile {
  id: string
  campus_id?: string
  campus?: string
  display_name?: string
  tagline?: string
  logo_key?: string
  wordmark_key?: string
  favicon_key?: string
  primary_color?: string
  accent_color?: string
  custom_domain?: string
  domain_verified_at?: string
  login_headline?: string
  login_message?: string
  login_banner_key?: string
  email_header_key?: string
  email_footer_html?: string
  email_from_name?: string
  support_email?: string
  support_phone?: string
}

export interface BrandingResponse {
  items: BrandingProfile[]
  institution_name: string
  institution_logo_key?: string
  institution_primary_color: string
  campuses: Option[]
  uploads_available: boolean
}

// --- franchises --------------------------------------------------------------

export interface FranchiseMember {
  institution_id: string
  school: string
  district?: string
  status: string
  agreement_no?: string
  joined_on: string
  renews_on?: string
  annual_fee_paise: number
  compliance_percent?: number
  last_audited_on?: string
  students: number
}

export interface Franchise {
  id: string
  code: string
  name: string
  brand_owner?: string
  royalty_bp: number
  contact_name?: string
  contact_email?: string
  contact_phone?: string
  brand_standards?: string
  status: string
  members: number
  students: number
  annual_fee_paise: number
  compliance_percent?: number
  never_audited: number
}

export interface FranchiseResponse {
  items: Franchise[]
  members: FranchiseMember[]
  unattached: Option[]
  selected?: string
}

export interface OwnFranchise {
  membership?: FranchiseMember
  chain?: Franchise
}

// --- numbering and templates -------------------------------------------------

export interface NumberingScheme {
  id: string
  campus_id?: string
  campus?: string
  kind: string
  prefix: string
  suffix: string
  padding: number
  next_value: number
  reset_yearly: boolean
  preview: string
}

export interface CertificateTemplate {
  id: string
  code: string
  name: string
  requires_approval: boolean
  has_template: boolean
  template_length: number
}

export interface NumberingResponse {
  items: NumberingScheme[]
  templates: CertificateTemplate[]
  kinds: Option[]
  campuses: Option[]
  financial_year: string
}

// --- SSO and MFA -------------------------------------------------------------

export interface AuthPolicy {
  mfa_required_roles: string[]
  mfa_grace_days: number
  password_min_length: number
  password_expiry_days: number
  session_idle_minutes: number
  allowed_email_domains: string[]
  sso_enabled: boolean
  sso_protocol?: string
  sso_provider?: string
  sso_entity_id?: string
  sso_metadata_url?: string
  sso_verified_at?: string
  users: number
  mfa_enrolled: number
  users_covered_by_rule: number
  users_covered_without_mfa: number
  roles: Option[]
  sso_available: boolean
  sso_blocked_by: string
}

// --- backup ------------------------------------------------------------------

export interface BackupRun {
  id: string
  kind: string
  started_at: string
  finished_at?: string
  status: string
  size_bytes?: number
  object_key?: string
  restore_point?: string
  error?: string
}

export interface BackupPosture {
  enabled: boolean
  frequency: string
  run_at_hour: number
  retention_days: number
  pitr_window_days: number
  destination: string
  runs: BackupRun[]
  last_good_at?: string
  last_good_hours?: number
  lapsed: boolean
  failed_runs_30_days: number
  can_run_from_here: boolean
  runs_blocked_by: string
}

export interface BackupFleetRow {
  institution_id: string
  school: string
  enabled: boolean
  frequency: string
  last_good_at?: string
  last_good_hours?: number
  lapsed: boolean
  failed_runs_30_days: number
  students: number
}

// --- tickets -----------------------------------------------------------------

export interface VendorTicket {
  id: string
  school?: string
  subject: string
  category: string
  priority: string
  status: string
  raised_by?: string
  assigned_to?: string
  created_at: string
  open_days: number
  body?: string
}

// --- impersonation -----------------------------------------------------------

export interface Grant {
  id: string
  institution_id: string
  school?: string
  operator: string
  reason: string
  ticket_id?: string
  started_at: string
  expires_at: string
  ended_at?: string
  ended_by?: string
  ended_reason?: string
  live: boolean
  changes: number
}

export interface AuditEntry {
  id: number
  at: string
  actor?: string
  action: string
  entity_type: string
  ip?: string
}

export interface GrantActivity {
  grant: Grant
  items: AuditEntry[]
  covers: string
  /* Changes made during the session that landed in no school's audit trail.
     A measured defect rather than a curiosity — see the note the server sends
     with it. */
  unattributed_changes: number
  unattributed_note?: string
}

// --- adoption and health -----------------------------------------------------

export interface AdoptionRow {
  institution_id: string
  school: string
  plan?: string
  students: number
  staff: number
  accounts: number
  sign_ins_28_days: number
  active_users_28_days: number
  changes_28_days: number
  active_percent: number
  last_sign_in?: string
  quiet_days?: number
}

export interface AdoptionWeek {
  week_start: string
  sign_ins: number
  active_users: number
  changes: number
}

export interface AdoptionResponse {
  items: AdoptionRow[]
  weeks: AdoptionWeek[]
  at_risk: number
}

export interface HealthRow {
  institution_id: string
  school: string
  integrations_enabled: number
  integrations_failing: number
  failing_providers: string[]
  messages_failed_24h: number
  payments_failed_24h: number
  open_vendor_tickets: number
  attendance_marked_today: number
  sessions_24h: number
  concerns: number
}

export interface QueueStat {
  size: number
  pending: number
  active: number
  retry: number
  failed: number
  paused: boolean
}

export interface HealthResponse {
  items: HealthRow[]
  queues: Record<string, QueueStat | string>
  not_measured: string
}

// --- entitlements ------------------------------------------------------------

export interface PlanRow {
  code: string
  name: string
  price_paise: number
  modules: string[]
  schools: number
  sequence: number
}

export interface EntitlementSchool {
  institution_id: string
  school: string
  plan?: string
  plan_name?: string
  plan_modules: string[]
  enabled: string[]
  beyond_plan: string[]
}

export interface EntitlementResponse {
  plans: PlanRow[]
  schools: EntitlementSchool[]
  modules: string[]
}
