/* Inbox (communication.inbox): a member of staff's own school email address.
   Every route reads and writes only the signed-in person's mailbox; none takes
   a user id. Routes: worker/src/routes/comms/inbox.ts. Mail arrives through
   worker/src/services/mail.ts (receiveMail). */
import type { Ok } from './contract'

export type MailFolder = 'inbox' | 'sent' | 'trash'

export interface MailPerson { name: string; address: string }

/** One line of a folder. */
export interface MailSummary {
  id: string
  folder: MailFolder
  from: MailPerson
  to: MailPerson[]
  subject: string
  snippet: string
  received_at: string
  read: boolean
  starred: boolean
  has_attachments: boolean
}

export interface MailAttachmentInfo { id: string; filename: string; content_type: string; size_bytes: number }

/** A message opened. `html` is the sender's HTML as received: show it only in a sandboxed frame. */
export interface MailMessage extends MailSummary {
  cc: MailPerson[]
  text: string
  html: string | null
  message_id: string | null
  attachments: MailAttachmentInfo[]
}

export interface MailboxInfo {
  /** The person's address, or null when the office has not given them one. */
  address: string | null
  /** active | disabled; null with no address. */
  status: 'active' | 'disabled' | null
  unread: number
}

export interface MailPage {
  items: MailSummary[]
  total: number
  limit: number
  offset: number
}

export interface MailSendInput {
  to: string[]
  cc?: string[]
  subject: string
  text: string
  /** The message being answered, from this mailbox. */
  reply_to_id?: string
}

export interface InboxApi {
  'GET /comms/mail/box': { res: MailboxInfo }
  'GET /comms/mail': { query: { folder?: MailFolder; q?: string; starred?: boolean; limit?: number; offset?: number }; res: MailPage }
  'GET /comms/mail/{id}': { res: MailMessage }
  'PATCH /comms/mail/{id}': { body: { read?: boolean; starred?: boolean }; res: Ok }
  'POST /comms/mail/{id}/trash': { res: Ok }
  'POST /comms/mail/{id}/restore': { res: Ok }
  'DELETE /comms/mail/{id}': { res: Ok }
  'POST /comms/mail/send': { body: MailSendInput; res: { id: string } }
}
