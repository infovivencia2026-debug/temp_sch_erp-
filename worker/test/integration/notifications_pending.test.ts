/* The bell's owner rules (Yajur, 2026-10-21): opened is gone; a status whose
   post has gone is not listed; work owed (a parent concern, a paper deadline,
   a leave to approve, a parent awaiting this teacher's reply) stays, marked
   pending, until the work is done. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

const T = () => E.TENANT_TEST
const N_STATUS = '00000000-0000-4000-8000-000000000a01'
const N_CONCERN = '00000000-0000-4000-8000-000000000a02'
const N_PLAIN = '00000000-0000-4000-8000-000000000a03'
const N_MSG = '00000000-0000-4000-8000-000000000a04'
const MSG = '00000000-0000-4000-8000-000000000a05'
const REPLY = '00000000-0000-4000-8000-000000000a06'
const old = '2026-01-01 08:00:00'

const note = (id: string, kind: string, sourceKind: string | null, sourceId: string | null) =>
  T().prepare(`INSERT INTO notifications (id, institution_id, user_id, kind, title, link, source_kind, source_id, created_at)
               VALUES (?, ?, ?, ?, 'T', ?, ?, ?, ?)`)
    .bind(id, IDS.school, IDS.teacher, kind, kind === 'status' ? '/?status=00000000-0000-4000-8000-000000000a99' : null, sourceKind, sourceId, old)

beforeAll(async () => {
  await seed()
  await T().batch([
    note(N_STATUS, 'status', 'status', 'school'),
    note(N_CONCERN, 'concern.support_ticket', null, '00000000-0000-4000-8000-000000000a98'),
    note(N_PLAIN, 'staff_message', 'staff_message', null),
    T().prepare(`INSERT INTO parent_teacher_messages (id, institution_id, student_id, parent_user_id, teacher_user_id, sender_user_id, body, sent_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'Please call', ?)`).bind(MSG, IDS.school, IDS.child, IDS.parent, IDS.teacher, IDS.parent, old),
    note(N_MSG, 'parent_message', 'parent_teacher_message', MSG),
  ])
})

const listed = async () => (await api('teacher', 'GET', '/portal/notifications')).body.items as { id: string; pending?: boolean }[]

describe('bell owner rules', () => {
  it('drops a status entry whose poster has nothing live', async () => {
    expect((await listed()).map((x) => x.id)).not.toContain(N_STATUS)
    const row = await T().prepare('SELECT dismissed_at FROM notifications WHERE id = ?').bind(N_STATUS).first<{ dismissed_at: string | null }>()
    expect(row?.dismissed_at).not.toBeNull()
  })

  it('marks owed work pending and keeps it when opened', async () => {
    const items = await listed()
    expect(items.find((x) => x.id === N_CONCERN)?.pending).toBe(true)
    expect(items.find((x) => x.id === N_MSG)?.pending).toBe(true)
    expect(items.find((x) => x.id === N_PLAIN)?.pending).toBeFalsy()
    expect((await api('teacher', 'POST', `/portal/notifications/${N_CONCERN}/dismiss`, {})).body.status).toBe('read')
    expect((await api('teacher', 'POST', `/portal/notifications/${N_PLAIN}/dismiss`, {})).body.status).toBe('dismissed')
    const after = (await listed()).map((x) => x.id)
    expect(after).toContain(N_CONCERN)
    expect(after).not.toContain(N_PLAIN)
  })

  it('lets a parent message go once the teacher has replied', async () => {
    await T().prepare(`INSERT INTO parent_teacher_messages (id, institution_id, student_id, parent_user_id, teacher_user_id, sender_user_id, body, sent_at)
                       VALUES (?, ?, ?, ?, ?, ?, 'Will do', '2026-01-02 08:00:00')`)
      .bind(REPLY, IDS.school, IDS.child, IDS.parent, IDS.teacher, IDS.teacher).run()
    expect((await listed()).map((x) => x.id)).not.toContain(N_MSG)
  })
})
