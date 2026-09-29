/* GET /bootstrap: everything the app needs to draw its first screen, in one
   response. Each part has exactly the shape of the endpoint it replaces
   (worker/src/routes/bootstrap.ts builds each from that endpoint's own
   helper), and is null when the caller could not have read that endpoint
   (no permission, no school in scope, subscription locked, no session). */
import type { SessionResponse } from './session'
import type { CatalogResponse } from './catalog'

/** GET /attention: what needs someone's attention now, and today's figures. */
export interface AttentionItem {
  key: string
  severity: 'critical' | 'warning' | 'info'
  count: number
  headline: string
  detail?: string
  action: string
  href?: string
  amount_paise?: number
}
export interface AttentionSummaryStat { label: string; value: string; hint?: string; tone?: string; span?: number }
export interface AttentionResponse {
  role: string
  greeting: string
  items: AttentionItem[]
  summary: AttentionSummaryStat[]
}

/** GET /working-year. */
export interface WorkingYearRow { id: string; name: string; starts_on: string; ends_on: string; is_current: boolean; open: boolean }
export interface WorkingYearResponse { academic_year_id: string | null; chosen: boolean; years: WorkingYearRow[] }

/** GET /portal/preferences/display. */
export interface DisplayPreference {
  theme: string; density: string; reduce_motion: boolean; locale: string; high_contrast: boolean; layout: string
}
export interface DisplayPreferencesResponse {
  preference: DisplayPreference
  theme_choices: string[]; density_choices: string[]; default_theme: string; default_density: string
  locale_choices: string[]; default_locale: string; layout_choices: string[]; default_layout: string
}

/** GET /rollups/today (the JSON form). Empty lists are present; money only with finance.invoices.read. */
export interface RollupsTodayResponse {
  date: string
  weekday: string
  /** 'institution' or 'department'. */
  scope: string
  staff_absent: { user_id: string; full_name: string; department?: string; status: string; periods_today: number; periods_covered: number; periods_uncovered: number }[]
  uncovered_periods: { period: string; starts_at: string; class_name: string; section_name: string; subject: string; reason: string }[]
  money?: { due_today_paise: number; collected_today_paise: number; receipts_today: number; overdue_as_of_today_paise: number; overdue_students: number; cheques_awaiting_clearance_paise: number }
  visitors_expected: { at?: string; title: string; with?: string; kind?: string }[]
  events: { at?: string; title: string; with?: string; kind?: string }[]
  decisions: { key: string; label: string; count: number; href: string }[]
}

export interface BootstrapResponse {
  /** GET /session. Always present; { authenticated: false } without a session (then every other part is null). */
  session: SessionResponse
  /** GET /catalog. */
  catalog: CatalogResponse | null
  /** GET /portal/preferences/display (needs self.profile.read). */
  display_preferences: DisplayPreferencesResponse | null
  /** GET /working-year. */
  working_year: WorkingYearResponse | null
  /** GET /attention (role ''). */
  attention: AttentionResponse | null
  /** GET /rollups/today (needs admin.reports.read). */
  today: RollupsTodayResponse | null
}

export interface BootstrapApi {
  'GET /bootstrap': { res: BootstrapResponse }
}
