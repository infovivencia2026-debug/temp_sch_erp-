import type { Ctx } from '../router'
import { now } from '../http'

/* DONE WORK LEAVES THE BELL IN THE SAME REQUEST (Yajur, 2026-10-24: "after
   the institution admin approved, the notification is still in the admin's
   notifications for 1-2 minutes"). A pending notification (a leave to
   approve, an exit to approve, a concern, a paper owed, a parent's message)
   used to be cleared only when its owner next fetched the bell, and nothing
   made that fetch happen: the live revision's notification part was the
   newest created_at, which a dismissal does not move. So the request that
   does the work now clears every copy of it, for every user who had one,
   and the revision (portal/live) counts open rows so the other admins'
   bells refetch on the next poll. */

/** When each pending kind is done. `?1` is a user id when `who` is given;
    with no user, each row's own owner stands in. */
export function pendingDoneSql(who: '?1' | 'notifications.user_id'): string[] {
  return [
    `kind = 'concern.support_ticket' AND EXISTS (SELECT 1 FROM support_tickets t WHERE t.id = notifications.source_id AND (t.status IN ('resolved', 'closed')
       OR EXISTS (SELECT 1 FROM grievance_updates gu WHERE gu.ticket_id = t.id AND gu.kind = 'teacher_resolved')))`,
    `kind = 'question_paper_deadline' AND (
       EXISTS (SELECT 1 FROM question_papers qp WHERE qp.exam_subject_id = notifications.source_id AND qp.status IN ('submitted', 'approved'))
       OR EXISTS (SELECT 1 FROM question_paper_deadlines d WHERE d.exam_subject_id = notifications.source_id AND d.teacher_user_id = ${who} AND d.manually_received_at IS NOT NULL))`,
    `kind = 'leave_request' AND source_kind = 'leave_request' AND EXISTS (SELECT 1 FROM leave_requests l WHERE l.id = notifications.source_id AND l.status <> 'pending')`,
    `kind = 'staff_exit_approval' AND EXISTS (SELECT 1 FROM staff_exits x WHERE x.id = notifications.source_id AND x.status <> 'pending_approval')`,
    `kind = 'parent_message' AND EXISTS (SELECT 1 FROM parent_teacher_messages m JOIN parent_teacher_messages r
         ON r.student_id = m.student_id AND r.parent_user_id = m.parent_user_id AND r.teacher_user_id = m.teacher_user_id
       WHERE m.id = notifications.source_id AND m.teacher_user_id = ${who} AND r.sender_user_id = ${who} AND r.sent_at > m.sent_at)`,
  ]
}

export type PendingKind = 'concern.support_ticket' | 'question_paper_deadline' | 'leave_request' | 'staff_exit_approval' | 'parent_message'
const ORDER: PendingKind[] = ['concern.support_ticket', 'question_paper_deadline', 'leave_request', 'staff_exit_approval', 'parent_message']
const ALL_USERS = pendingDoneSql('notifications.user_id')

/** Dismisses every user's copy of `kind` whose work is now done. Never
    throws: the work itself has already been saved. */
export async function clearDoneWork(c: Pick<Ctx, 'db'>, kind: PendingKind, sourceId?: string | null): Promise<number> {
  const ts = now()
  const done = ALL_USERS[ORDER.indexOf(kind)]
  const bySource = sourceId ? ' AND source_id = ?2' : ''
  try {
    const st = c.db.prepare(`UPDATE notifications SET dismissed_at = ?1, read_at = COALESCE(read_at, ?1)
        WHERE dismissed_at IS NULL AND kind = '${kind}'${bySource} AND (${done})`)
    const res = await (sourceId ? st.bind(ts, sourceId) : st.bind(ts)).run()
    return res.meta.changes ?? 0
  } catch {
    return 0 /* a school without this table yet */
  }
}
