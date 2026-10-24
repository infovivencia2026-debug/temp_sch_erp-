/* Done work leaves the bell in the same request (Yajur, 2026-10-24: "after
   the institution admin approved, the notification is still in the admin's
   notifications for 1-2 minutes"). Approving a leave clears every copy of
   its leave_request notification -- the approver's and another approver's --
   without anybody fetching the bell first, and moves the live revision. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

const T = () => E.TENANT_TEST
const LEAVE = '00000000-0000-4000-8000-000000000b01'
const N_ADMIN = '00000000-0000-4000-8000-000000000b02'
const N_OTHER = '00000000-0000-4000-8000-000000000b03'

const note = (id: string, user: string) =>
  T().prepare(`INSERT INTO notifications (id, institution_id, user_id, kind, title, link, source_kind, source_id, created_at)
               VALUES (?, ?, ?, 'leave_request', 'Leave to approve', '/go/approvals/approvals', 'leave_request', ?, '2026-01-01 08:00:00')`)
    .bind(id, IDS.school, user, LEAVE)

beforeAll(async () => {
  await seed()
  await T().batch([
    T().prepare(`INSERT INTO leave_requests (id, institution_id, subject_kind, student_id, from_date, to_date, days, reason, status, applied_by, created_at)
        VALUES (?, ?, 'student', ?, '2026-02-02', '2026-02-02', '1', 'Fever', 'pending', ?, '2026-01-01 08:00:00')`)
      .bind(LEAVE, IDS.school, IDS.child, IDS.parent),
    note(N_ADMIN, IDS.admin),
    note(N_OTHER, IDS.finance),
  ])
})

const dismissed = async (id: string) =>
  (await T().prepare('SELECT dismissed_at FROM notifications WHERE id = ?').bind(id).first<{ dismissed_at: string | null }>())?.dismissed_at ?? null

describe('done work clears the bell at once', () => {
  it('approving a leave removes the leave_request notification in the same request', async () => {
    const before = (await api('finance', 'GET', '/portal/live')).body.rev as string
    expect(await dismissed(N_ADMIN)).toBeNull()
    const res = await api('admin', 'POST', `/workflow/leave/${LEAVE}/decide`, { decision: 'approved' })
    expect(res.status).toBe(200)
    // No GET /portal/notifications in between: the decide request itself cleared both.
    expect(await dismissed(N_ADMIN)).not.toBeNull()
    expect(await dismissed(N_OTHER)).not.toBeNull()
    const items = (await api('admin', 'GET', '/portal/notifications')).body.items as { id: string }[]
    expect(items.map((x) => x.id)).not.toContain(N_ADMIN)
    // The other approver's bell refetches on the next live poll.
    expect((await api('finance', 'GET', '/portal/live')).body.rev).not.toBe(before)
  })
})
