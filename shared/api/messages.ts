/* Staff-to-staff messages. internal/api/staff_messages.go. */

export interface Attachment { file_id: string; name: string; size_bytes: number; content_type: string; url: string }

export interface StaffThread {
  user_id: string
  full_name: string
  designation?: string
  photo?: string
  unread: number
  last_message?: string
  last_at?: string
}

export interface StaffMessage {
  id: string
  body: string
  sent_at: string
  mine: boolean
  sender_name: string
  attachments: Attachment[]
  /** Full-precision send time; pass as `before` to fetch the page above. */
  cursor: string
  reply_to_id?: string
  reply_body?: string
  reply_sender?: string
  edited: boolean
  deleted: boolean
  read_at?: string
}

export interface MessagesApi {
  'GET /staff-messages/threads': { res: { items: StaffThread[] } }
  'GET /staff-messages': {
    query: { with: string; before?: string }
    res: { items: StaffMessage[]; has_more: boolean; cursor: string }
  }
}
