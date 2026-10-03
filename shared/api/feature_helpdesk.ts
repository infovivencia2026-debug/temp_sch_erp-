/* The Help Centre (every role), the school's Helpdesk (help.helpdesk) and the
   vendor's desk: one ticket model, three readers.
   Routes: worker/src/routes/help/*.ts. */
import type { List } from './contract'

export type HelpSide = 'raiser' | 'school' | 'vendor'

/** A request as every list shows it. */
export interface HelpTicket {
  id: string
  subject: string
  category: string
  priority: string
  status: string
  stage: string
  /** Who answers it: the school's own helpdesk, or the vendor's desk. */
  with: 'school' | 'vendor'
  route?: string
  role?: string
  error_ref?: string
  me_too: number
  created_at: string
  updated_at: string
  respond_due_at?: string
  resolve_due_at?: string
  acknowledged_at?: string
  resolved_at?: string
  last_reply_at?: string
  last_reply_side?: HelpSide
  /** The raiser's thumb on the answer; absent until given. */
  helpful?: boolean
  can_reopen: boolean
  reopened_count: number
  incident_id?: string
  merged_into?: string
  solved_by?: string
}

export interface HelpThreadEntry {
  id: string
  kind: string
  body: string
  side: HelpSide
  author: string
  /** A working note the other side never sees. */
  internal: boolean
  new_status?: string
  created_at: string
}

export interface HelpDiagnostics {
  route?: string
  role?: string
  layout?: string
  theme?: string
  language?: string
  app_version?: string
  browser?: string
  os?: string
  viewport?: string
  online?: boolean
  standalone?: boolean
  client_errors?: string[]
  last_failed?: { path?: string; status?: number; ref?: string; at?: string }
  conversation?: { role: string; text: string }[]
  checks?: { check: string; ok: boolean; detail: string }[]
}

export interface HelpCategoryOption {
  key: string
  label: string
  hint: string
  troubleshooter?: string
}

/** A known issue attached to a request: what to do until it is fixed. */
export interface HelpIncidentNote { id: string; title: string; workaround: string }

export interface HelpRequestDetail extends HelpTicket {
  body: string
  resolution?: string
  attachment?: { id: string; name: string }
  /** The school passed it to the vendor (shown to the raiser as a fact, with nothing of the vendor's thread). */
  escalated: boolean
  incident?: HelpIncidentNote
  thread: HelpThreadEntry[]
}

export interface HelpRequestInput {
  category: string
  body: string
  subject?: string
  /** "This is stopping my work": raises the priority. */
  urgent?: boolean
  route?: string
  role?: string
  error_ref?: string
  attachment_file_id?: string
  diagnostics?: HelpDiagnostics
}

/** Reports like this one from other people in the same school; nobody else's words are shown. */
export interface HelpSimilar {
  count: number
  /** The newest open one, to add "me too" to. */
  ticket_id?: string
  stage?: string
  me_too?: number
  already_following?: boolean
}

export interface HelpFollowed { id: string; category: string; stage: string; created_at: string }

// --- the school's helpdesk --------------------------------------------------

export interface DeskTicket extends HelpTicket {
  raised_by: string
  assigned_to?: string
  assigned_to_id?: string
  /** For a request passed to the vendor: the vendor ticket and where it stands. */
  escalation?: { id: string; stage: string; status: string }
  respond_breached: boolean
  resolve_breached: boolean
}

export interface DeskTicketDetail extends DeskTicket {
  body: string
  resolution?: string
  attachment?: { id: string; name: string }
  diagnostics: HelpDiagnostics
  incident?: HelpIncidentNote
  thread: HelpThreadEntry[]
  /** The vendor's public replies on the escalation, for the administrator to relay. */
  escalation_thread?: HelpThreadEntry[]
}

export interface DeskCounts { open: number; mine: number; unassigned: number; waiting: number; overdue: number; with_vendor: number; solved: number }

export interface EscalateInput {
  /** What the vendor is told. The family's own words are not sent. */
  summary: string
  subject?: string
  urgent?: boolean
  /** "I have checked that this names no child." */
  confirmed: boolean
}

export interface HelpArticleView { key: string; title: string; topic: string; body: string; route?: string; anchor?: string; keywords?: string }
export interface HelpTipView { key: string; title: string; body: string; device?: 'desktop' | 'phone'; since: string }

export interface HelpdeskApi {
  'GET /help/articles': { res: List<HelpArticleView> }
  'GET /help/tips': { query: { lang?: string }; res: List<HelpTipView> }
  'POST /help/tips/{key}/dismiss': { res: { dismissed: true } }
  // The Help Centre: any signed-in person of a school.
  'GET /help/categories': { query: { lang?: string }; res: List<HelpCategoryOption> }
  'GET /help/requests': { res: { items: HelpTicket[]; following: HelpFollowed[] } }
  'POST /help/requests': { body: HelpRequestInput; res: { id: string; with: 'school' | 'vendor'; incident?: HelpIncidentNote } }
  'GET /help/requests/{id}': { res: HelpRequestDetail }
  'POST /help/requests/{id}/reply': { body: { body: string }; res: { added: true } }
  'POST /help/requests/{id}/reopen': { body: { reason: string }; res: { status: string } }
  'POST /help/requests/{id}/rating': { body: { helpful: boolean; note?: string }; res: { recorded: true; status: string } }
  'POST /help/requests/{id}/me-too': { res: { added: boolean; me_too: number } }
  'GET /help/similar': { query: { category?: string; route?: string }; res: HelpSimilar }

  // The school's helpdesk.
  'GET /help/desk': { query: { box?: string; q?: string }; res: { items: DeskTicket[]; counts: DeskCounts } }
  'GET /help/desk/{id}': { res: DeskTicketDetail }
  'POST /help/desk/{id}/reply': { body: { body: string; internal?: boolean; waiting?: boolean }; res: { added: true } }
  'POST /help/desk/{id}/take': { res: { assigned_to: string } }
  'POST /help/desk/{id}/resolve': { body: { resolution: string }; res: { status: string } }
  'POST /help/desk/{id}/escalate': { body: EscalateInput; res: { id: string } }
}
