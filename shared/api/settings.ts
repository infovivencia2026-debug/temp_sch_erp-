/* The seller console's Controls (worker/src/services/settings_registry.ts and
   routes/seller/controls.ts): every school-level setting the vendor may see,
   with its value, where that value comes from, and who may change it.
   Configuration only: nothing here carries a school's records. */

export type SettingType = 'bool' | 'enum' | 'number' | 'text'
export type SettingValue = boolean | number | string | null

export const SETTING_GROUPS = [
  { key: 'features', label: 'Features' },
  { key: 'logins', label: 'Logins & access' },
  { key: 'communication', label: 'Communication' },
  { key: 'class_status', label: 'Class Status' },
  { key: 'ai', label: 'AI' },
  { key: 'admissions', label: 'Admissions' },
  { key: 'exams', label: 'Exams & report cards' },
  { key: 'fees', label: 'Fees & fines' },
  { key: 'branding', label: 'Branding & app' },
  { key: 'security', label: 'Security & sessions' },
] as const
export type SettingGroup = (typeof SETTING_GROUPS)[number]['key']

/** school: the school's own value; plan / platform: the vendor's default it matches; built-in: the code's fallback. */
export type SettingSource = 'school' | 'plan' | 'platform' | 'built-in'
/** Who may change it: the vendor here, the school on its own screens, or both. */
export type SettingEditors = 'both' | 'school' | 'seller'

export interface SettingDecl {
  key: string
  group: SettingGroup
  label: string
  help: string
  type: SettingType
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  nullable?: boolean
  /** The value the code uses when nothing is stored. */
  builtin: SettingValue
  editors: SettingEditors
  /** A change by the vendor also puts a notice on the school's board. */
  notify: boolean
  /** May hold a platform or plan default (features take theirs from the plan). */
  defaults: boolean
  /** Where it lives, in words, for the inventory column. */
  stored_in: string
}

export interface SettingRow extends SettingDecl {
  value: SettingValue
  source: SettingSource
  /** What a reset would set: plan, else platform, else built-in. */
  default_value: SettingValue
  default_source: Exclude<SettingSource, 'school'>
  vendor_editable: boolean
}

export interface SchoolSettings {
  institution: { id: string; name: string; plan_code: string | null; plan_name: string | null }
  settings: SettingRow[]
}

export interface SettingChange { key: string; value: SettingValue }

export interface ApplyResult {
  applied: boolean
  schools: {
    id: string
    name: string
    /** Only the settings whose value would change. */
    changes: { key: string; label: string; before: SettingValue; after: SettingValue }[]
    error?: string
  }[]
}

export interface ConfigTemplate {
  format: 'xulo-config/1'
  exported_at: string
  from: { id: string; name: string }
  settings: Record<string, SettingValue>
}

export interface RoleTemplate {
  key: string
  name: string
  permissions: string[]
  source: 'platform' | 'built-in'
  updated_at: string | null
}

export interface RolePushResult {
  applied: boolean
  role: string
  schools: { id: string; name: string; status: 'updated' | 'unchanged' | 'customised' | 'missing' | 'error'; added: number; removed: number; error?: string }[]
}
