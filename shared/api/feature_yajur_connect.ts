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

export interface ConnectList { items: ConnectConversation[]; guard_on: boolean; can_write: boolean }
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

export interface YajurConnectApi {
  'GET /comms/yajur-connect': { query?: { q?: string; state?: ConnectState | 'all'; mine?: '1' }; res: ConnectList }
  'GET /comms/yajur-connect/staff': { res: List<ConnectStaff> }
  'GET /comms/yajur-connect/autoreplies': { res: List<ConnectAutoReply> }
  'POST /comms/yajur-connect/autoreplies': { body: ConnectAutoReplyBody; res: ConnectAutoReply }
  'PUT /comms/yajur-connect/autoreplies/{id}': { body: Partial<ConnectAutoReplyBody>; res: ConnectAutoReply }
  'DELETE /comms/yajur-connect/autoreplies/{id}': { res: Ok }
  'GET /comms/yajur-connect/{id}': { res: ConnectThread }
  'PUT /comms/yajur-connect/{id}': { body: { assigned_to?: string | null; labels?: string[]; state?: ConnectState }; res: ConnectConversation }
  'POST /comms/yajur-connect/{id}/reply': { body: { text?: string; template_code?: string }; res: ConnectMessage }
}
