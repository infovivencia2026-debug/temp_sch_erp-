/* A fee concession from request to decision (owner, 2026-10-23): the
   principal is told when one is asked for, the decision and its note are
   stored and returned, the requester is told with the note, and the request
   leaves the approvers' queue and their notifications. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

const T = () => E.TENANT_TEST
const notes = async (user: string, source: string) =>
  (await T().prepare(`SELECT kind, title, body, link, read_at FROM notifications WHERE user_id = ? AND source_id = ? ORDER BY created_at`)
    .bind(user, source).all<{ kind: string; title: string; body: string; link: string; read_at: string | null }>()).results

beforeAll(seed)

describe('fee concession flow', () => {
  it('notifies the principal on request, and the requester on decision with the note', async () => {
    const made = await api<{ id: string; status: string }>('finance', 'POST', '/fees/concessions',
      { student_id: IDS.child, kind: 'sibling', percent: '10', reason: 'Elder sister in class 8' })
    expect(made.status).toBe(201)
    const id = made.body.id

    const asked = await notes(IDS.admin, id)
    expect(asked).toHaveLength(1)
    expect(asked[0].kind).toBe('concession_request')
    expect(asked[0].link).toBe('/go/approvals/approvals')
    expect(asked[0].body).toContain('Elder sister in class 8')
    expect(asked[0].read_at).toBeNull()

    const inbox = await api<{ items: { id: string }[] }>('admin', 'GET', '/workflow/approvals')
    expect(inbox.body.items.some((i) => i.id === id)).toBe(true)

    const d = await api<{ id: string; status: string; decision_note: string }>('admin', 'POST', `/workflow/concessions/${id}/decide`,
      { decision: 'approved', note: 'Sibling proof seen' })
    expect(d.status).toBe(200)
    expect(d.body.status).toBe('approved')
    expect(d.body.decision_note).toBe('Sibling proof seen')

    const list = await api<{ items: { id: string; status: string; reason: string; decision_note: string }[] }>('finance', 'GET', '/fees/concessions')
    const row = list.body.items.find((i) => i.id === id)!
    expect(row.status).toBe('approved')
    expect(row.reason).toBe('Elder sister in class 8')
    expect(row.decision_note).toBe('Sibling proof seen')

    const told = await notes(IDS.finance, id)
    expect(told).toHaveLength(1)
    expect(told[0].title).toBe('Concession approved')
    expect(told[0].body).toContain('Approved: Sibling proof seen')
    expect(told[0].link).toBe('/go/fees/class_transport_fee_setup?view=concessions')

    const after = await notes(IDS.admin, id)
    expect(after[0].read_at).not.toBeNull()
    expect(after[0].title).toContain('approved')

    const inbox2 = await api<{ items: { id: string }[] }>('admin', 'GET', '/workflow/approvals')
    expect(inbox2.body.items.some((i) => i.id === id)).toBe(false)
    const pending = await api<{ items: { id: string }[] }>('finance', 'GET', '/fees/concessions?status=pending')
    expect(pending.body.items.some((i) => i.id === id)).toBe(false)
  })
})
