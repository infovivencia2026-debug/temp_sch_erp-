/* The vendor desk, second round: the queue from the CONTROL index (status
   filter, search, paging), one-school ticket updates, bulk checks before any
   change, sessions started from a ticket, operator writes in the school's own
   trail, and the SLA clock (business hours, waiting paused, breach alerts). */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, signIn, IDS, E, PASSWORD } from './fixture'
import { hashPassword } from '../../src/auth/password'
import { businessSeconds, DEFAULT_SLA, type SlaPolicy } from '../../src/routes/help/content'
import { alertBreaches, clockOf } from '../../src/services/ticket_index'

const ACCOUNTS = {
  a: { id: '00000000-0000-4000-8000-0000000000c1', email: 'desk-a@vendor.test', name: 'Anu Agent', role: 'support_admin' },
  b: { id: '00000000-0000-4000-8000-0000000000c2', email: 'desk-b@vendor.test', name: 'Bala Agent', role: 'support_admin' },
  op: { id: '00000000-0000-4000-8000-0000000000c3', email: 'operator@vendor.test', name: 'Omar Operator', role: 'seller_admin' },
} as const
type Acct = keyof typeof ACCOUNTS
const cookies: Partial<Record<Acct, string>> = {}
const as = async (who: Acct, method: string, path: string, body?: unknown, acting = false) => {
  const headers: Record<string, string> = body === undefined ? {} : { 'content-type': 'application/json' }
  if (acting) headers['x-acting-institution'] = IDS.school
  const res = await call('/api/v1' + path, { method, cookie: cookies[who], headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text(); let b: any = text; try { b = JSON.parse(text) } catch { /* text */ }
  return { status: res.status, body: b }
}

beforeAll(async () => {
  await seed()
  const C = E.CONTROL
  const t = new Date().toISOString(), hash = await hashPassword(E.PASSWORD_PEPPER, PASSWORD)
  for (const [k, u] of Object.entries(ACCOUNTS) as [Acct, (typeof ACCOUNTS)[Acct]][]) {
    if (!(await C.prepare('SELECT 1 FROM platform_users WHERE id = ?').bind(u.id).first())) {
      await C.batch([
        C.prepare(`INSERT INTO platform_users (id, email, full_name, password_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`).bind(u.id, u.email, u.name, hash, t, t),
        C.prepare(`INSERT INTO platform_user_roles (user_id, role_key, created_at) VALUES (?, ?, ?)`).bind(u.id, u.role, t),
        C.prepare(`INSERT INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, NULL, ?, ?)`).bind(u.email, u.id, t),
      ])
    }
    cookies[k] = (await signIn(u.email)).cookie!
  }
})

const raise = async (body: string) => (await api('admin', 'POST', '/help/requests', { category: 'slow', body })).body.id as string
const indexRow = (id: string) => E.CONTROL.prepare('SELECT * FROM support_ticket_index WHERE ticket_id = ?').bind(id).first<any>()

describe('the queue, from the index', () => {
  let a = '', b = ''
  it('copies a new ticket and filters by status, searches, pages; refuses a made-up status', async () => {
    a = await raise('Attendance report will not print for Class 5.')
    b = await raise('Fee receipt shows the wrong total.')
    expect(await indexRow(a)).toMatchObject({ institution_id: IDS.school, status: 'open' })
    const q = await as('a', 'GET', '/admin/platform/seller/tickets')
    expect(q.status).toBe(200)
    expect(q.body.items.find((x: any) => x.id === a)).toMatchObject({ institution_id: IDS.school, promised_hours: 72, school: 'Test Public School' })
    expect(q.body.failed_schools).toEqual([])
    expect((await as('a', 'GET', '/admin/platform/seller/tickets?status=nonsense')).status).toBe(400)
    const s = await as('a', 'GET', `/admin/platform/seller/tickets?status=all&q=${encodeURIComponent('wrong total')}`)
    expect(s.body.items.map((x: any) => x.id)).toEqual([b])
    expect((await as('a', 'GET', `/admin/platform/seller/tickets?status=all&q=${a.slice(0, 8)}`)).body.items.map((x: any) => x.id)).toEqual([a])
    const page = await as('a', 'GET', '/admin/platform/seller/tickets?status=all&limit=1')
    expect(page.body.items.length).toBe(1)
    expect(page.body.total).toBeGreaterThanOrEqual(2)
    expect((await api('admin', 'GET', '/admin/platform/seller/tickets')).status).toBe(403)
  })

  it('updates one ticket in the named school: refuses no school, bad status and bad priority; tells the school', async () => {
    expect((await as('a', 'POST', `/admin/platform/seller/tickets/${a}`, { priority: 'high' })).status).toBe(400)
    expect((await as('a', 'POST', `/admin/platform/seller/tickets/${a}`, { institution_id: IDS.school, status: 'done' })).status).toBe(400)
    expect((await as('a', 'POST', `/admin/platform/seller/tickets/${a}`, { institution_id: IDS.school, priority: 'extreme' })).status).toBe(400)
    expect((await as('a', 'POST', `/admin/platform/seller/tickets/${a}`, { institution_id: crypto.randomUUID(), priority: 'high' })).status).toBe(404)
    expect((await as('a', 'POST', `/admin/platform/seller/tickets/${crypto.randomUUID()}`, { institution_id: IDS.school, priority: 'high' })).status).toBe(404)
    expect((await as('a', 'POST', `/admin/platform/seller/tickets/${a}`, { institution_id: IDS.school, priority: 'high' })).status).toBe(200)
    expect(await indexRow(a)).toMatchObject({ priority: 'high' })
    const line = await E.TENANT_TEST.prepare(`SELECT kind, body, author_side FROM grievance_updates WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 1`).bind(a).first<any>()
    expect(line).toMatchObject({ kind: 'status', author_side: 'vendor' })
    expect(line.body).toContain('Priority is now high')
    const bell = await E.TENANT_TEST.prepare(`SELECT title FROM notifications WHERE user_id = ? AND source_id = ? ORDER BY created_at DESC LIMIT 1`).bind(IDS.admin, a).first<any>()
    expect(bell?.title).toBe('XULO support updated your ticket')
    const audit = await E.CONTROL.prepare(`SELECT institution_id, target FROM seller_audit WHERE action = 'desk.ticket.update' AND target = ?`).bind(a).first<any>()
    expect(audit?.institution_id).toBe(IDS.school)
  })

  it('bulk: checks every item first, refuses take on a closed ticket, merge into a closed one, and records each id', async () => {
    expect((await as('a', 'POST', '/admin/platform/desk/bulk', { action: 'close', items: [{ school: IDS.school, id: b }] })).body.done).toBe(1)
    const r = await as('a', 'POST', '/admin/platform/desk/bulk', { action: 'take', items: [{ school: IDS.school, id: b }, { school: crypto.randomUUID(), id: a }, { school: IDS.school, id: a }] })
    expect(r.status).toBe(200)
    expect(r.body.done).toBe(1)
    expect(r.body.results.map((x: any) => x.ok)).toEqual([false, false, true])
    expect(r.body.results[0].error).toContain('solved or closed')
    expect(r.body.results[1].error).toBe('no such school')
    const taken = await E.TENANT_TEST.prepare('SELECT vendor_agent_id, status FROM support_tickets WHERE id = ?').bind(a).first<any>()
    expect(taken).toMatchObject({ vendor_agent_id: ACCOUNTS.a.id, status: 'in_progress' })
    const audit = await E.CONTROL.prepare(`SELECT institution_id, target FROM seller_audit WHERE action = 'desk.bulk.take' ORDER BY at DESC LIMIT 1`).first<any>()
    expect(audit).toMatchObject({ institution_id: IDS.school, target: `${IDS.school}/${a}` })
    expect((await as('a', 'POST', '/admin/platform/desk/bulk', { action: 'merge', items: [{ school: IDS.school, id: a }], into: { school: IDS.school, id: b } })).status).toBe(400)
    expect((await as('a', 'GET', '/admin/platform/seller/tickets')).body.items.some((x: any) => x.id === b)).toBe(false)
    expect((await as('a', 'GET', '/admin/platform/seller/tickets?status=closed')).body.items.some((x: any) => x.id === b)).toBe(true)
  })

  it('a session from a ticket: refuses a ticket the school did not raise; each agent ends only its own', async () => {
    expect((await as('a', 'POST', '/admin/platform/impersonation', { institution_id: IDS.school, reason: 'Checking the attendance report', ticket_id: crypto.randomUUID() })).status).toBe(404)
    const mine = await as('a', 'POST', '/admin/platform/impersonation', { institution_id: IDS.school, reason: 'Checking the attendance report', ticket_id: a, minutes: 30 })
    expect(mine.status).toBe(201)
    expect(mine.body).toMatchObject({ ticket_id: a, live: true })
    const theirs = await as('b', 'POST', '/admin/platform/impersonation', { institution_id: IDS.school, reason: 'Looking at the fee receipt', minutes: 30 })
    expect(theirs.status).toBe(201)
    const list = await as('a', 'GET', '/admin/platform/impersonation')
    expect(list.body.items.map((g: any) => g.id)).toContain(mine.body.id)
    expect(list.body.items.map((g: any) => g.id)).not.toContain(theirs.body.id)
    expect((await as('a', 'POST', `/admin/platform/impersonation/${theirs.body.id}/end`)).status).toBe(403)
    expect((await as('a', 'GET', `/admin/platform/impersonation/${theirs.body.id}/activity`)).status).toBe(403)
    expect((await as('a', 'POST', `/admin/platform/impersonation/${mine.body.id}/end`)).status).toBe(200)
    expect((await as('b', 'POST', `/admin/platform/impersonation/${theirs.body.id}/end`)).status).toBe(200)
    const started = await E.CONTROL.prepare(`SELECT institution_id FROM seller_audit WHERE action = 'impersonation.start' AND target = ?`).bind(mine.body.id).first<any>()
    expect(started?.institution_id).toBe(IDS.school)
  })

  it("an operator's write inside a school lands in that school's trail and the session's activity", async () => {
    const g = await as('op', 'POST', '/admin/platform/impersonation', { institution_id: IDS.school, reason: 'Setting up houses for the school', minutes: 30 })
    expect(g.status).toBe(201)
    expect((await as('op', 'POST', '/academics/houses', { name: 'Operator House' }, true)).status).toBeLessThan(300)
    const row = await E.TENANT_TEST.prepare(`SELECT institution_id, entity_id, action FROM audit_log WHERE entity_type = 'operator_session' ORDER BY id DESC LIMIT 1`).first<any>()
    expect(row).toMatchObject({ institution_id: IDS.school, entity_id: ACCOUNTS.op.id, action: 'acting_as.academics.houses.post' })
    const act = await as('op', 'GET', `/admin/platform/impersonation/${g.body.id}/activity`)
    expect(act.body.items.some((x: any) => x.action === 'acting_as.academics.houses.post')).toBe(true)
    expect(act.body.unattributed_note).toBeUndefined()
    const sa = await E.CONTROL.prepare(`SELECT institution_id, acting_as FROM seller_audit WHERE actor_id = ? AND path LIKE '%/academics/houses' ORDER BY at DESC LIMIT 1`).bind(ACCOUNTS.op.id).first<any>()
    expect(sa).toMatchObject({ institution_id: IDS.school, acting_as: 1 })
    expect((await as('op', 'POST', `/admin/platform/impersonation/${g.body.id}/end`)).status).toBe(200)
  })

  it('waiting on the school is counted from the index and left off the clock', async () => {
    expect((await as('a', 'POST', `/admin/platform/desk/${IDS.school}/tickets/${a}/reply`, { body: 'Which printer do you use?', waiting: true })).status).toBe(201)
    const w = await indexRow(a)
    expect(w.status).toBe('waiting')
    expect(w.waiting_since).toBeTruthy()
    // Waiting since a Monday morning, so the business time to now is at least a working day.
    await E.CONTROL.prepare(`UPDATE support_ticket_index SET waiting_since = '2026-10-19T04:30:00.000Z' WHERE ticket_id = ?`).bind(a).run()
    expect((await api('admin', 'POST', `/help/requests/${a}/reply`, { body: 'The office printer, an HP.' })).status).toBeLessThan(300)
    const after = await indexRow(a)
    expect(after.status).not.toBe('waiting')
    expect(after.waiting_since).toBeNull()
    expect(after.waiting_seconds).toBeGreaterThanOrEqual(9 * 3600)
  })

  it('a breach bells the agent who holds the ticket, once', async () => {
    await E.CONTROL.prepare(`UPDATE support_ticket_index SET created_at = '2026-09-01T04:30:00.000Z', waiting_seconds = 0, breach_alerted_at = NULL WHERE ticket_id = ?`).bind(a).run()
    expect(await alertBreaches(E)).toBeGreaterThanOrEqual(1)
    await alertBreaches(E)
    const notes = await E.CONTROL.prepare(`SELECT kind FROM platform_notifications WHERE user_id = ? AND source_key LIKE ?`).bind(ACCOUNTS.a.id, `%${a}`).all<any>()
    expect(notes.results.filter((n: any) => n.kind === 'support.sla.resolve').length).toBe(1)
    const mine = await as('a', 'GET', '/admin/platform/desk/alerts')
    expect(mine.body.unread).toBeGreaterThanOrEqual(1)
    expect((await as('a', 'POST', `/admin/platform/desk/alerts/${mine.body.items[0].id}/read`)).status).toBe(200)
    expect((await as('b', 'POST', `/admin/platform/desk/alerts/${mine.body.items[0].id}/read`)).status).toBe(404)
    expect((await as('a', 'GET', '/admin/platform/seller/tickets')).body.items.find((x: any) => x.id === a).breached).toBe(true)
  })

  it('the SLA tier stored on a plan wins over the plan code; the policy refuses bad hours', async () => {
    expect((await as('op', 'PUT', '/admin/platform/plans/test/sla-tier', { tier: 9 })).status).toBe(400)
    expect((await as('a', 'PUT', '/admin/platform/plans/test/sla-tier', { tier: 0 })).status).toBe(403)
    expect((await as('op', 'PUT', '/admin/platform/plans/test/sla-tier', { tier: 0 })).status).toBe(200)
    const sub = await E.CONTROL.prepare(`SELECT 1 AS x FROM subscriptions WHERE institution_id = ? AND status IN ('active','trial')`).bind(IDS.school).first()
    if (sub) expect((await as('a', 'GET', '/admin/platform/seller/tickets')).body.items.find((x: any) => x.id === a).promised_hours).toBe(4)
    expect((await as('op', 'PUT', '/admin/platform/plans/test/sla-tier', { tier: null })).status).toBe(200)
    expect((await as('a', 'PUT', '/admin/platform/help-content/sla/policy', { data: { respond_hours: 8, resolve_hours: 48, business_hours: { days: [1], start: '18:00', end: '09:00', tz_offset_minutes: 330 } } })).status).toBe(400)
    expect((await as('a', 'PUT', '/admin/platform/help-content/sla/policy', { data: { respond_hours: 8, resolve_hours: 48, holidays: ['26 Jan'] } })).status).toBe(400)
  })
})

describe('the SLA clock', () => {
  const p: SlaPolicy = { ...DEFAULT_SLA[0], holidays: ['2026-10-02'] }
  const ist = (s: string) => Date.parse(s + '+05:30')
  it('counts Monday to Saturday, 9 to 6 India time, and skips holidays', () => {
    expect(businessSeconds(p, ist('2026-10-19T09:00:00'), ist('2026-10-19T10:00:00'))).toBe(3600)
    expect(businessSeconds(p, ist('2026-10-19T07:00:00'), ist('2026-10-19T09:30:00'))).toBe(1800)
    // Friday 17:00 to Saturday 10:00: one hour each day.
    expect(businessSeconds(p, ist('2026-10-23T17:00:00'), ist('2026-10-24T10:00:00'))).toBe(7200)
    // Sunday is not a working day.
    expect(businessSeconds(p, ist('2026-10-25T09:00:00'), ist('2026-10-25T18:00:00'))).toBe(0)
    // 2 October is on the holiday list.
    expect(businessSeconds(p, ist('2026-10-02T09:00:00'), ist('2026-10-02T18:00:00'))).toBe(0)
    expect(businessSeconds(p, ist('2026-10-19T10:00:00'), ist('2026-10-19T09:00:00'))).toBe(0)
  })
  it('pauses while waiting on the school, both past waits and the one running now', () => {
    const base = { created_at: new Date(ist('2026-10-19T09:00:00')).toISOString(), status: 'in_progress', priority: 'normal', acknowledged_at: null, resolved_at: null }
    const now = ist('2026-10-19T15:00:00')
    const plan = { code: 'basic', tier: null }
    expect(clockOf({ ...base, waiting_since: null, waiting_seconds: 0 }, p, plan, now).sla_hours).toBe(6)
    expect(clockOf({ ...base, waiting_since: null, waiting_seconds: 2 * 3600 }, p, plan, now).sla_hours).toBe(4)
    const running = clockOf({ ...base, status: 'waiting', waiting_since: new Date(ist('2026-10-19T13:00:00')).toISOString(), waiting_seconds: 3600 }, p, plan, now)
    expect(running).toMatchObject({ sla_hours: 3, waiting_hours: 3, promised_hours: 48, breached: false })
    // No first reply after 6 working hours on a basic plan at normal urgency (promise: 8 h): not yet late; after 9 it is.
    expect(clockOf({ ...base, waiting_since: null, waiting_seconds: 0 }, p, plan, now).response_breached).toBe(false)
    expect(clockOf({ ...base, waiting_since: null, waiting_seconds: 0 }, p, plan, ist('2026-10-20T13:00:00')).response_breached).toBe(true)
    expect(clockOf({ ...base, waiting_since: null, waiting_seconds: 0 }, p, { code: 'basic', tier: 0 }, now).promised_hours).toBe(8)
  })
})
