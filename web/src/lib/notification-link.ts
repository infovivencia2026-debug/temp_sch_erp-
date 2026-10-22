/* WHERE A NOTIFICATION'S VIEW BUTTON GOES (owner, 2026-10-22: "when they
   click the View button in a notification, the page should redirect").

   One pure table so the bell and the staff home panel agree, and so it can be
   tested without a catalogue. `hrefs` holds this reader's own screen for each
   destination (resolved from the catalogue by the caller, staff and family
   roles alike); a destination the reader does not hold is undefined and the
   notification is then read in full instead. */
import { statusPostIdOf } from './notification-shown'

export type NoteDest =
  | 'status' | 'messages' | 'circular' | 'fee' | 'attendance' | 'homework' | 'result'
  | 'transport' | 'timetable' | 'concern' | 'questionPapers' | 'leaveApprovals'
  | 'leaveSelf' | 'calendar' | 'certificates' | 'reports'

export type NoteHrefs = Partial<Record<NoteDest, string>>

/** The destination a kind is about, when its stored link is missing or unusable. */
export function destOfKind(kind: string): NoteDest | undefined {
  const k = kind.toLowerCase()
  if (k === 'status') return 'status'
  if (k.startsWith('transport') || k.includes('bus')) return 'transport'
  if (k.startsWith('fee')) return 'fee'
  if (k.startsWith('attendance') || k.startsWith('absen')) return 'attendance'
  if (k.startsWith('homework')) return 'homework'
  if (k.startsWith('report_card') || k.startsWith('result') || k === 'date_sheet') return 'result'
  if (k.startsWith('timetable')) return 'timetable'
  if (k.startsWith('question_paper')) return 'questionPapers'
  if (k === 'leave_request') return 'leaveApprovals'
  if (k.startsWith('leave')) return 'leaveSelf'
  if (k.startsWith('concern') || k.includes('support_ticket') || k.includes('grievance')) return 'concern'
  if (k.startsWith('circular') || k.startsWith('announcement')) return 'circular'
  if (k === 'ptm' || k.startsWith('event') || k === 'meeting') return 'calendar'
  if (k.startsWith('certificate')) return 'certificates'
  if (k.startsWith('report_digest')) return 'reports'
  if (k === 'message' || k === 'chat' || k.startsWith('message_') || k.startsWith('chat_')
    || k.endsWith('_message')) return 'messages'
  return undefined
}

/** A screen path written for one role ("/faculty/exams/question_papers")
    reaches whoever holds that screen under any role through /go/. */
const ROLE_PATH = /^\/([a-z_]+)\/([a-z_]+)\/([a-z_]+)(\?.*)?$/

export function noteDestination(n: { kind: string; link?: string | null }, hrefs: NoteHrefs): string | undefined {
  const post = statusPostIdOf({ kind: n.kind, link: n.link ?? undefined })
  if (post) return hrefs.status ? `${hrefs.status}?status=${post}` : undefined
  const link = n.link ?? ''
  /* "/portal/..." is the API's shape, written by the digests: no screen lives
     there, so the kind names the screen instead. */
  if (link && !link.startsWith('/portal/') && n.kind !== 'status') {
    const m = ROLE_PATH.exec(link)
    if (m && m[1] !== 'go') return `/go/${m[2]}/${m[3]}${m[4] ?? ''}`
    return link
  }
  const dest = destOfKind(n.kind)
  return dest ? hrefs[dest] : undefined
}
