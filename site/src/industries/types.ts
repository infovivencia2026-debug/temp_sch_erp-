import type { LucideIcon } from 'lucide-react'
import type { VocabPools } from '@/data/industryVocab'

/* ---------------------------------------------------------------------------
   One shape describes a module in every vertical. Education, construction,
   logistics, healthcare and manufacturing all compile down to this, which is
   why they can share a single sidebar, table, drawer and form.
   --------------------------------------------------------------------------- */

export interface TabDef {
  id: string
  label: string
  /** Compact column spec — see parseCols(). */
  cols?: string[]
  count?: number
  /** Renders a bespoke view instead of the generic table. */
  custom?: string
  actions?: string[]
  description?: string
}

export interface ModuleDef {
  id: string
  label: string
  icon: LucideIcon
  group: string
  tabs: TabDef[]
  primaryAction?: string
  custom?: string
}

export interface Role {
  id: string
  label: string
  scope: string
  modules: string[] | '*'
}

/** Table tab: `t('Label', ['type:Column@Option,Option'], rowCount)`. */
export const t = (label: string, cols: string[], count = 24, actions?: string[]): TabDef => ({
  id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  label, cols, count, actions,
})

/** Bespoke tab: renders the view registered under `key` in CUSTOM_VIEWS. */
export const customTab = (label: string, key: string): TabDef => ({
  id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label, custom: key,
})

/* ------------------------------------------------------------- Dashboards */

export interface KpiDef {
  label: string
  value: string
  delta: string
  up: boolean
  icon: LucideIcon
  to: string
}

export interface DashboardConfig {
  /** Greeting line under the headline, e.g. "Site operations · 6 live sites". */
  greeting: string
  primaryAction: { label: string; to: string }
  kpis: KpiDef[]
  secondary: { label: string; value: string; icon: LucideIcon }[]
  trend: { title: string; subtitle: string; data: any[]; keys: { key: string; label: string }[] }
  mix: { title: string; subtitle: string; data: { name: string; value: number }[] }
  funnel: { title: string; subtitle: string; data: any[]; keys: { key: string; label: string }[] }
  money: { title: string; subtitle: string; data: any[]; keys: { key: string; label: string }[] }
  progress: { title: string; subtitle: string; unit: string; rows: { name: string; done: number; total: number }[] }
  approvals: { id: string; type: string; detail: string; value: string; age: string }[]
  alerts: { tone: 'red' | 'amber' | 'blue'; title: string; detail: string }[]
  activityVerbs: string[]
  /** Right-hand feed: recent records of the industry's core entity. */
  recent: { title: string; action: string; to: string; rows: { id: string; name: string; sub: string; stage: string }[] }
  tasks: { title: string; due: string; done: boolean }[]
  announcements: { title: string; by: string; time: string; pinned: boolean }[]
  events: { name: string; date: string; venue: string }[]
  calendar: Record<number, string[]>
  ranking: { title: string; subtitle: string; rows: { name: string; value: number }[] }
}

/* -------------------------------------------------------------- Industries */

export interface IndustryDef {
  id: string
  label: string
  /** Short line shown on the home page card. */
  tagline: string
  /** Long line shown on the home page card. */
  blurb: string
  icon: LucideIcon
  /** Product name in the sidebar header. */
  product: string
  /** Sub-line in the sidebar header. */
  productSub: string
  /** Signed-in persona for the top bar. */
  user: { name: string; defaultRole: string }
  modules: ModuleDef[]
  groupOrder: string[]
  roles: Role[]
  vocab: VocabPools
  /** Top-bar scope pickers. */
  scope: {
    orgLabel: string; orgs: string[]
    siteLabel: string; sites: string[]
    periodLabel: string; periods: string[]
  }
  quickCreate: { label: string; to: string }[]
  notifications: { title: string; desc: string; time: string }[]
  messages: { from: string; text: string; time: string }[]
  searchHint: string
  /** Config-driven dashboard. Education ships its own bespoke page instead. */
  dashboard?: DashboardConfig
  /** Home-page proof points. */
  highlights: string[]
}
