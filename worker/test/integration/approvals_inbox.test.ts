/* Approvals inbox speed (owner, 2026-10-24: "make the approvals faster").
   The kinds are read together and each is capped at APPROVALS_PER_KIND, so a
   long backlog of one kind cannot hold up the inbox. The list still carries
   every kind, and deciding is still refused to people without the right. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, E, IDS, isoDay } from './fixture'
import { APPROVALS_PER_KIND } from '../../src/routes/daily'
import { cloudflareD1Api, CfApiError } from '../../src/services/d1http'

const T = () => E.TENANT_TEST
const ATT = '00000000-0000-4000-8000-000000000601'
const CORR = '00000000-0000-4000-8000-000000000602'
const LEAVE = '00000000-0000-4000-8000-000000000603'
let concession = ''

beforeAll(async () => {
  await seed()
  const stmts = [
    T().prepare(`INSERT OR IGNORE INTO student_attendance (id, institution_id, student_id, section_id, on_date, status) VALUES (?, ?, ?, ?, ?, 'absent')`)
      .bind(ATT, IDS.school, IDS.child, IDS.section, isoDay(-1)),
    T().prepare(`INSERT OR IGNORE INTO attendance_corrections (id, institution_id, attendance_id, requested_by, from_status, to_status, reason, status)
      VALUES (?, ?, ?, ?, 'absent', 'present', 'Was at the sports meet', 'pending')`).bind(CORR, IDS.school, ATT, IDS.teacher),
    T().prepare(`INSERT OR IGNORE INTO leave_requests (id, institution_id, subject_kind, student_id, from_date, to_date, days, reason, status)
      VALUES (?, ?, 'student', ?, ?, ?, 1, 'Fever', 'pending')`).bind(LEAVE, IDS.school, IDS.child, isoDay(1), isoDay(1)),
  ]
  for (let i = 0; i < APPROVALS_PER_KIND + 5; i++) {
    stmts.push(T().prepare(`INSERT INTO fee_concessions (institution_id, student_id, kind, amount_paise, reason, status, created_at)
      VALUES (?, ?, 'sibling', 1000, 'Second child', 'pending', ?)`).bind(IDS.school, IDS.child, new Date(Date.now() - i * 1000).toISOString()))
  }
  await T().batch(stmts)
})

describe('approvals inbox', () => {
  it('lists every kind, caps each kind, and answers quickly', async () => {
    await api('admin', 'GET', '/workflow/approvals') // signs in once; the timing below is the inbox alone
    const t0 = Date.now()
    const r = await api('admin', 'GET', '/workflow/approvals')
    const took = Date.now() - t0
    expect(r.status).toBe(200)
    expect(r.body.by_kind.fee_concession).toBe(APPROVALS_PER_KIND)
    expect(r.body.by_kind.leave).toBeGreaterThanOrEqual(1)
    expect(r.body.by_kind.attendance_correction).toBeGreaterThanOrEqual(1)
    expect(r.body.total).toBe(r.body.items.length)
    const ids = r.body.items.map((i: { id: string }) => i.id)
    expect(ids).toContain(CORR)
    expect(ids).toContain(LEAVE)
    // The oldest first, as before.
    const kinds = r.body.items.map((i: { kind: string }) => i.kind)
    expect(kinds.indexOf('leave')).toBeLessThan(kinds.indexOf('fee_concession'))
    expect(took).toBeLessThan(3000)
    concession = r.body.items.find((i: { kind: string }) => i.kind === 'fee_concession').id
  })

  it('a parent sees nothing to decide and cannot decide', async () => {
    const r = await api('parent', 'GET', '/workflow/approvals')
    if (r.status === 200) expect(r.body.items.filter((i: { kind: string }) => i.kind !== 'leave')).toEqual([])
    else expect(r.status).toBe(403)
    expect((await api('parent', 'POST', `/workflow/concessions/${concession}/decide`, { decision: 'approved' })).status).toBe(403)
    expect((await api('parent', 'POST', `/attendance-workflow/corrections/${CORR}/decide`, { decision: 'approved' })).status).toBe(403)
    const still = await T().prepare(`SELECT status FROM fee_concessions WHERE id = ?`).bind(concession).first<{ status: string }>()
    expect(still?.status).toBe('pending')
  })

  it('the admin decides, and the row leaves the inbox', async () => {
    expect((await api('admin', 'POST', `/workflow/concessions/${concession}/decide`, { decision: 'approved' })).status).toBe(200)
    const r = await api('admin', 'GET', '/workflow/approvals')
    expect(r.body.items.some((i: { id: string }) => i.id === concession)).toBe(false)
  })
})

describe('D1 HTTP API timeout', () => {
  it('a call that never answers fails with a clear error', async () => {
    const hang = (_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(init.signal!.reason))
    })
    const api = cloudflareD1Api('acc', 'tok', hang, 20)
    const err = await api.query('db', [{ sql: 'SELECT 1', params: [] }]).catch((e) => e)
    expect(err).toBeInstanceOf(CfApiError)
    expect(err.status).toBe(504)
    expect(String(err.message)).toContain('no answer within')
  })
})
