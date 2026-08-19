import { api, type List } from '@/lib/api'
import { useQuery } from '@tanstack/react-query'

/* Shapes and helpers shared by the three admissions-growth screens.

   Everything here mirrors internal/api/admissions_growth.go. Nothing computes
   an authorisation decision: a screen hides what the caller cannot use and the
   server refuses it regardless, because a hidden button is not access
   control. */

const A = '/api/v1/admissions'

// --- the form builder --------------------------------------------------------

export interface AdmissionForm {
  id: string
  name: string
  description?: string
  slug: string
  is_open: boolean
  opens_on?: string
  closes_on?: string
  live_version?: number
  draft_version?: number
  submissions: number
}

export interface FormVersion {
  id: string
  version: number
  status: 'draft' | 'published' | 'retired'
  notes?: string
  published_at?: string
  fields: number
  applications: number
}

export interface FieldOption {
  value: string
  label: string
}

export interface VisibilityRule {
  field: string
  equals: string
}

export interface FormField {
  id: string
  section_id: string
  code: string
  label: string
  field_type: FieldType
  help_text?: string
  placeholder?: string
  is_required: boolean
  sequence: number
  options: FieldOption[]
  option_kind?: string
  min_length?: number
  max_length?: number
  min_number?: number
  max_number?: number
  pattern?: string
  visible_when?: VisibilityRule
  reserved: boolean
}

export interface FormSection {
  id: string
  title: string
  description?: string
  sequence: number
  fields: FormField[]
}

export interface FormDefinition {
  version_id: string
  form_id: string
  form_name: string
  slug: string
  version: number
  status: string
  editable: boolean
  sections: FormSection[]
  classes: FieldOption[]
}

export interface ApplicationAnswer {
  section: string
  code: string
  label: string
  field_type: string
  value: string
  file_id?: string
  external_url?: string
}

export type FieldType =
  | 'text' | 'textarea' | 'number' | 'date' | 'select'
  | 'checkbox' | 'file' | 'email' | 'phone'

export const FIELD_TYPES: FieldOption[] = [
  { value: 'text', label: 'Single line of text' },
  { value: 'textarea', label: 'Paragraph' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Choose one' },
  { value: 'checkbox', label: 'Tick box' },
  { value: 'file', label: 'File or link' },
  { value: 'email', label: 'Email address' },
  { value: 'phone', label: 'Phone number' },
]

/* The codes that write through to the application record itself.

   Duplicated from reservedFields in admissions_growth.go so the builder can
   explain a code before the server has to reject one. The server is still the
   authority — this list only decides what the hint says. */
export const RESERVED_CODES = [
  'first_name', 'middle_name', 'last_name', 'date_of_birth', 'gender',
  'category', 'class_sought', 'parent_name', 'parent_phone', 'parent_email',
  'address', 'previous_school',
]

/** Without these four the applications table will not take a row, so the
 *  server refuses to publish. Named here so the builder can say so first. */
export const REQUIRED_CODES = ['first_name', 'parent_name', 'parent_phone', 'class_sought']

/* The named patterns the server understands.

   Deliberately not regular expressions: a school administrator setting "eleven
   digits" on an Aadhaar field should not have to learn one, and an
   unauthenticated endpoint should not be compiling expressions a school typed. */
export const PATTERNS: FieldOption[] = [
  { value: '', label: 'No pattern' },
  { value: 'digits', label: 'Digits only' },
  { value: 'digits:10', label: 'Exactly 10 digits' },
  { value: 'digits:11', label: 'Exactly 11 digits' },
  { value: 'digits:12', label: 'Exactly 12 digits (Aadhaar)' },
  { value: 'letters', label: 'Letters and spaces only' },
  { value: 'alnum', label: 'Letters and digits' },
]

export function useAdmissionForms() {
  return useQuery({
    queryKey: ['admissions-forms'],
    queryFn: () => api.get<List<AdmissionForm>>(`${A}/forms`),
  })
}

export function useFormVersions(formID: string) {
  return useQuery({
    enabled: !!formID,
    queryKey: ['admissions-form-versions', formID],
    queryFn: () => api.get<List<FormVersion>>(`${A}/forms/${formID}/versions`),
  })
}

export function useFormDefinition(versionID: string) {
  return useQuery({
    enabled: !!versionID,
    queryKey: ['admissions-form-version', versionID],
    queryFn: () => api.get<FormDefinition>(`${A}/form-versions/${versionID}`),
  })
}

// --- campaign sequences ------------------------------------------------------

export interface Campaign {
  id: string
  name: string
  description?: string
  is_active: boolean
  auto_enrol_source?: string
  steps: number
  active_leads: number
  stopped_leads: number
  messages_queued: number
  touches_due: number
}

export interface CampaignStep {
  id: string
  step_no: number
  name: string
  offset_days: number
  channel: string
  template_code: string
  quiet_from?: string
  quiet_to?: string
  is_active: boolean
  queued: number
  skipped: number
}

export interface CampaignEnrolment {
  id: string
  enquiry_id: string
  student_name: string
  parent_name?: string
  phone?: string
  lead_status: string
  status: 'active' | 'stopped' | 'completed'
  enrolled_at: string
  stopped_at?: string
  stopped_reason?: string
  touches_done: number
  touches_remaining: number
  next_due?: string
}

export interface OutboxRow {
  id: string
  campaign: string
  step: string
  student_name: string
  phone?: string
  channel: string
  due_at: string
  status: string
  note?: string
}

export interface CampaignRunResult {
  considered: number
  queued: number
  skipped: number
  enrolments_stopped: number
  enrolments_completed: number
}

export const CHANNELS: FieldOption[] = [
  { value: 'sms', label: 'SMS' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'Email' },
  { value: 'in_app', label: 'In the portal' },
  { value: 'push', label: 'Push notification' },
]

export function useCampaigns() {
  return useQuery({
    queryKey: ['admissions-campaigns'],
    queryFn: () => api.get<List<Campaign>>(`${A}/campaigns`),
  })
}

// --- lost lead reasons -------------------------------------------------------

export interface LostLead {
  id: string
  student_name: string
  parent_name?: string
  class_sought?: string
  source: string
  counsellor?: string
  reason?: string
  reason_label: string
  note?: string
  lost_on?: string
  days_worked: number
}

export interface LostAnalysisRow {
  group: string
  lost: number
  total: number
  share_percent?: number
  top_reason?: string
  top_reason_count?: number
}

export const LOST_DIMENSIONS: FieldOption[] = [
  { value: 'reason', label: 'By reason' },
  { value: 'class', label: 'By class sought' },
  { value: 'source', label: 'By source' },
  { value: 'counsellor', label: 'By counsellor' },
  { value: 'month', label: 'By month enquired' },
  { value: 'lost_month', label: 'By month lost' },
]

export function useLostReasons() {
  return useQuery({
    queryKey: ['admissions-lost-reasons'],
    queryFn: () => api.get<List<FieldOption>>(`${A}/lost-leads/reasons`),
  })
}

// --- shared -------------------------------------------------------------------

export interface Lead {
  id: string
  student_name: string
  parent_name?: string
  phone?: string
  class_sought?: string
  source?: string
  status: string
  assigned_to?: string
  days_silent: number
}

export function useLeads() {
  return useQuery({
    queryKey: ['admissions-leads'],
    queryFn: () => api.get<List<Lead>>(`${A}/leads`),
  })
}

export function labelOf(options: FieldOption[], value: string | undefined): string {
  if (!value) return '—'
  return options.find((o) => o.value === value)?.label ?? value
}

/** An empty numeric box is absent, not zero. `Number('')` is 0, and shipping
 *  that means a blank "minimum length" silently becomes a rule. */
export function numOrNull(raw: string): number | null {
  const t = raw.trim()
  return t === '' ? null : Number(t)
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong')

export { A as ADMISSIONS_BASE }
