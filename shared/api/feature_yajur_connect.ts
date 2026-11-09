/* Yajur Connect: WhatsApp chats with parents. Inbound messages come from the
   WhatsApp webhook; replies and auto-replies are queued through the school's
   message queue, so the recipient guard decides whether they leave. */
import type { List, Ok } from './contract'

export type ConnectState = 'open' | 'resolved'
export type ConnectMatch = 'exact' | 'starts' | 'contains'

export interface ConnectConversation {
  id: string
  phone: string
  /** The guardian's name, else the student's, else the WhatsApp profile name, else the number. */
  name: string
  profile_name: string | null
  guardian_id: string | null
  student_id: string | null
  student_name: string | null
  assigned_to: string | null
  assigned_name: string | null
  labels: string[]
  state: ConnectState
  unread: number
  last_inbound_at: string | null
  last_message_at: string | null
  last_preview: string | null
}

export interface ConnectMessage {
  id: string
  direction: 'in' | 'out'
  kind: string
  text: string | null
  /** WhatsApp's media id: the file itself is not downloaded. */
  media_id: string | null
  media_mime: string | null
  media_name: string | null
  reply_to_wa_id: string | null
  wa_id: string | null
  /** received for inbound; for outbound the queue's status (queued, sent, delivered, read, failed, suppressed). */
  status: string
  error: string | null
  /** Held until this time (quiet hours); null when it can go now. */
  send_after: string | null
  /** When the provider took it; null until then. */
  sent_at: string | null
  sent_by_name: string | null
  auto_reply: boolean
  at: string
}

export interface ConnectContact {
  guardian: { id: string; name: string; relation: string; phone: string | null; email: string | null } | null
  student: { id: string; name: string; admission_no: string; class_section: string | null } | null
}

export interface ConnectTemplate { code: string; name: string }

export interface ConnectSending {
  /** The recipient guard holds messages to this number: replies queue but are not delivered. */
  paused: boolean
  /** Phone numbers on the test list (see ConnectList.test_numbers). */
  test_numbers: number
  window_open: boolean
  window_ends_at: string | null
}

export interface ConnectThread {
  conversation: ConnectConversation
  messages: ConnectMessage[]
  contact: ConnectContact
  sending: ConnectSending
  templates: ConnectTemplate[]
}

export interface ConnectList {
  items: ConnectConversation[]
  guard_on: boolean
  /** Phone numbers on the recipient allowlist; with guard_on, only these receive (none: nothing is sent). */
  test_numbers: number
  can_write: boolean
}
export interface ConnectStaff { id: string; name: string }

export interface ConnectAutoReply {
  id: string
  match_type: ConnectMatch
  keyword: string
  reply: string
  enabled: boolean
  position: number
}
export interface ConnectAutoReplyBody { match_type: ConnectMatch; keyword: string; reply: string; enabled?: boolean }


// ---- sending (Send, Campaigns, Scheduled tabs; comms.connect.write) ----

/** An approved WhatsApp template and the fields its wording uses. */
export interface ConnectSendTemplate {
  code: string
  name: string
  body: string
  /** The {{fields}} to fill, in order (school_name is filled by the queue). */
  fields: string[]
  /** Approved with a picture header; only then can a header picture be sent. */
  has_image_header: boolean
}
/** Merge tokens a value may hold; each recipient gets their own. A field with one of these names is filled per recipient when left empty. */
export const CONNECT_MERGE_TOKENS = ['parent_name', 'student_name', 'class'] as const

export type ConnectRelation = 'father' | 'mother' | 'both'
/** Parents (school, classes, sections) or staff (staff = all, departments = chosen). relation applies to parents only. */
export interface ConnectAudience { scope: 'school' | 'classes' | 'sections' | 'staff' | 'departments'; ids: string[]; relation: ConnectRelation }
export interface ConnectAudienceOptions { classes: { id: string; name: string; sections: { id: string; name: string }[] }[]; departments: { id: string; name: string }[] }

/** A parent (and one child) found by name, number or admission number. */
export interface ConnectPerson {
  guardian_id: string
  guardian_name: string
  relation: string
  phone: string
  student_id: string | null
  student_name: string | null
  class_section: string | null
  opted_out: boolean
}

export interface ConnectNewBody { guardian_id: string; student_id?: string | null; template_code: string; values: Record<string, string>; header_image_url?: string | null }
export interface ConnectNewResult { conversation_id: string; message: ConnectMessage }

/** A test send to a number on the school's recipient allowlist; no student is involved. */
export interface ConnectTestNumber { id: string; label: string; phone: string }
export interface ConnectTestBody { phone: string; template_code: string; values: Record<string, string>; header_image_url?: string | null }
export interface ConnectTestResult { message_log_id: string | null; status: string }

export interface ConnectBroadcastBody {
  name: string
  template_code: string
  values: Record<string, string>
  header_image_url?: string | null
  audience: ConnectAudience
}
export interface ConnectPreview {
  /** Recipients the broadcast would queue: after opt-outs and numbers that cannot be read. */
  count: number
  opted_out: number
  no_phone: number
  audience_label: string
  /** The wording as the first recipient would get it. */
  sample: string | null
  sample_to: string | null
}

export type ConnectRecipientStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'blocked'
export interface ConnectCampaign {
  id: string
  name: string
  template_code: string
  template_name: string | null
  values: Record<string, string>
  rendered: string
  header_image_url: string | null
  audience: ConnectAudience
  audience_label: string
  recipient_count: number
  opted_out: number
  schedule_id: string | null
  created_by_name: string | null
  created_at: string
  counts: Partial<Record<ConnectRecipientStatus, number>>
}
export interface ConnectCampaignRecipient {
  id: string
  recipient: string
  parent_name: string | null
  student_name: string | null
  class: string | null
  status: ConnectRecipientStatus
  error: string | null
  at: string
}
export interface ConnectCampaignDetail { campaign: ConnectCampaign; recipients: ConnectCampaignRecipient[] }

export type ConnectRepeat = 'once' | 'daily' | 'weekly' | 'monthly'
export interface ConnectScheduleBody extends ConnectBroadcastBody { repeat: ConnectRepeat; run_at: string }
export interface ConnectSchedule {
  id: string
  name: string
  repeat: ConnectRepeat
  first_run_at: string
  next_run_at: string | null
  last_run_at: string | null
  last_campaign_id: string | null
  last_error: string | null
  active: boolean
  template_code: string
  audience_label: string
}

/** One WhatsApp message from message_log, for the Log tab. name: the parent or staff member whose number it is. */
export interface ConnectLogItem {
  id: string; recipient: string; name: string | null; template_code: string | null; status: ConnectRecipientStatus
  error: string | null; queued_at: string; sent_at: string | null
}
export interface ConnectLogList { items: ConnectLogItem[]; total: number; page: number; page_size: number }

export interface YajurConnectApi {
  'GET /comms/yajur-connect': { query?: { q?: string; state?: ConnectState | 'all'; mine?: '1' }; res: ConnectList }
  'GET /comms/yajur-connect/staff': { res: List<ConnectStaff> }
  'GET /comms/yajur-connect/autoreplies': { res: List<ConnectAutoReply> }
  'POST /comms/yajur-connect/autoreplies': { body: ConnectAutoReplyBody; res: ConnectAutoReply }
  'PUT /comms/yajur-connect/autoreplies/{id}': { body: Partial<ConnectAutoReplyBody>; res: ConnectAutoReply }
  'DELETE /comms/yajur-connect/autoreplies/{id}': { res: Ok }
  'GET /comms/yajur-connect/send/templates': { res: List<ConnectSendTemplate> & { school_name: string } }
  'GET /comms/yajur-connect/send/audiences': { res: ConnectAudienceOptions }
  'GET /comms/yajur-connect/send/people': { query: { q: string }; res: List<ConnectPerson> }
  'POST /comms/yajur-connect/send': { body: ConnectNewBody; res: ConnectNewResult }
  'GET /comms/yajur-connect/send/test-numbers': { res: List<ConnectTestNumber> }
  'POST /comms/yajur-connect/send/test': { body: ConnectTestBody; res: ConnectTestResult }
  'POST /comms/yajur-connect/send/preview': { body: ConnectBroadcastBody; res: ConnectPreview }
  'GET /comms/yajur-connect/campaigns': { res: List<ConnectCampaign> }
  'POST /comms/yajur-connect/campaigns': { body: ConnectBroadcastBody; res: ConnectCampaign }
  'GET /comms/yajur-connect/campaigns/{id}': { res: ConnectCampaignDetail }
  'GET /comms/yajur-connect/schedules': { res: List<ConnectSchedule> }
  'POST /comms/yajur-connect/schedules': { body: ConnectScheduleBody; res: ConnectSchedule }
  'PUT /comms/yajur-connect/schedules/{id}': { body: { active: boolean }; res: ConnectSchedule }
  'DELETE /comms/yajur-connect/schedules/{id}': { res: Ok }
  'GET /comms/yajur-connect/log': { query?: { status?: ConnectRecipientStatus; from?: string; to?: string; q?: string; page?: string }; res: ConnectLogList }
  'GET /comms/yajur-connect/{id}': { res: ConnectThread }
  'PUT /comms/yajur-connect/{id}': { body: { assigned_to?: string | null; labels?: string[]; state?: ConnectState }; res: ConnectConversation }
  'POST /comms/yajur-connect/{id}/reply': { body: { text?: string; template_code?: string }; res: ConnectMessage }
  'POST /comms/yajur-connect/{id}/messages/{mid}/retry': { res: ConnectMessage }
  'DELETE /comms/yajur-connect/{id}/messages/{mid}': { res: { ok: true } }
}
