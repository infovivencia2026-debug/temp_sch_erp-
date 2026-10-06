/* Help Centre requests: where a request goes, the conversation on it, who may
   read it, the escalation that names no child, "me too", and the error
   reference an unexpected failure is given. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, signIn, IDS, E, PASSWORD } from './fixture'
import { hashPassword } from '../../src/auth/password'
import { pruneErrorRefs } from '../../src/services/error_refs'

const AGENT = { id: '00000000-0000-4000-8000-0000000000b1', email: 'desk@vendor.test' }
let agent = ''

const asAgent = async (method: string, path: string, body?: unknown) => {
  const res = await call('/api/v1' + path, { method, cookie: agent,
    headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let parsed: any = text
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: parsed }
}

beforeAll(async () => {
  await seed()
  const C = E.CONTROL
  if (!(await C.prepare('SELECT 1 FROM platform_users WHERE id = ?').bind(AGENT.id).first())) {
    const t = new Date().toISOString()
    const hash = await hashPassword(E.PASSWORD_PEPPER, PASSWORD)
    await C.batch([
      C.prepare(`INSERT INTO platform_users (id, email, full_name, password_hash, status, created_at, updated_at) VALUES (?, ?, 'Dana Desk', ?, 'active', ?, ?)`).bind(AGENT.id, AGENT.email, hash, t, t),
      C.prepare(`INSERT INTO platform_user_roles (user_id, role_key, created_at) VALUES (?, 'support_admin', ?)`).bind(AGENT.id, t),
      C.prepare(`INSERT INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, NULL, ?, ?)`).bind(AGENT.email, AGENT.id, t),
    ])
  }
  agent = (await signIn(AGENT.email)).cookie!
  expect(agent).toBeTruthy()
})

const bells = async (userId: string, ticket: string) =>
  (await E.TENANT_TEST.prepare(`SELECT title, link FROM notifications WHERE user_id = ? AND source_id = ? ORDER BY created_at`).bind(userId, ticket).all<{ title: string; link: string }>()).results

describe('a request from a parent', () => {
  let id = ''

  it('goes to the school helpdesk, with its diagnostics, and rings the helpdesk', async () => {
    const r = await api('parent', 'POST', '/help/requests', {
      category: 'fees', body: 'The receipt for Chirag shows the wrong amount.\nPaid 5000 on Monday.', route: '/parent/fees/receipts', urgent: true,
      diagnostics: { route: '/parent/fees/receipts', viewport: '390x844', online: true, secret: 'dropped', client_errors: ['TypeError: x is undefined'],
        conversation: [{ role: 'user', text: 'Why is the receipt wrong?' }, { role: 'assistant', text: 'Open Fees, then Receipts.' }] },
    })
    expect(r.status).toBe(201)
    expect(r.body.with).toBe('school')
    id = r.body.id
    const row = await E.TENANT_TEST.prepare('SELECT audience, origin, priority, subject, diagnostics, respond_due_at, resolve_due_at, student_id FROM support_tickets WHERE id = ?').bind(id).first<any>()
    expect(row).toMatchObject({ audience: 'helpdesk', origin: 'help', priority: 'high', subject: 'The receipt for Chirag shows the wrong amount.', student_id: null })
    expect(row.respond_due_at).toBeTruthy()
    expect(row.resolve_due_at > row.respond_due_at).toBe(true)
    const d = JSON.parse(row.diagnostics)
    expect(d.secret).toBeUndefined()
    expect(d).toMatchObject({ viewport: '390x844', online: true })
    expect(d.conversation).toHaveLength(2)
    expect((await bells(IDS.admin, id)).map((b) => b.title)).toContain('A request for help')
  })

  it('refuses an empty request and an unknown topic', async () => {
    expect((await api('parent', 'POST', '/help/requests', { category: 'fees', body: '  ' })).status).toBe(400)
    expect((await api('parent', 'POST', '/help/requests', { category: 'gossip', body: 'x' })).status).toBe(400)
    expect((await api(null, 'POST', '/help/requests', { category: 'fees', body: 'x' })).status).toBe(401)
  })

  it('is read by its raiser and by nobody else in the Help Centre', async () => {
    const mine = await api('parent', 'GET', '/help/requests')
    expect(mine.body.items.some((t: any) => t.id === id && t.with === 'school' && t.stage === 'new')).toBe(true)
    expect((await api('parent', 'GET', `/help/requests/${id}`)).status).toBe(200)
    expect((await api('otherParent', 'GET', `/help/requests/${id}`)).status).toBe(404)
    expect((await api('otherParent', 'POST', `/help/requests/${id}/reply`, { body: 'me' })).status).toBe(404)
    expect((await api('otherParent', 'GET', '/help/requests')).body.items.some((t: any) => t.id === id)).toBe(false)
  })

  it('is not on the vendor queue, and the vendor cannot open it', async () => {
    const q = await asAgent('GET', '/admin/platform/seller/tickets')
    expect(q.status).toBe(200)
    expect(q.body.items.some((t: any) => t.id === id)).toBe(false)
    expect((await asAgent('GET', `/admin/platform/desk/${IDS.school}/tickets/${id}`)).status).toBe(404)
    // Nor is it among the office's concerns: a help request is a separate audience.
    const office = await api('admin', 'GET', '/comms/grievances')
    expect(office.status).toBe(200)
    expect(office.body.items.some((t: any) => t.id === id)).toBe(false)
  })

  it('only the helpdesk reads the school queue', async () => {
    expect((await api('teacher', 'GET', '/help/desk')).status).toBe(403)
    expect((await api('parent', 'GET', `/help/desk/${id}`)).status).toBe(403)
    expect((await api('teacher', 'POST', `/help/desk/${id}/reply`, { body: 'x' })).status).toBe(403)
    const q = await api('admin', 'GET', '/help/desk')
    expect(q.status).toBe(200)
    const t = q.body.items.find((x: any) => x.id === id)
    expect(t).toMatchObject({ raised_by: 'Pavan Parent', priority: 'high', stage: 'new', respond_breached: false })
    expect(q.body.counts.open).toBeGreaterThan(0)
    expect(q.body.counts.unassigned).toBeGreaterThan(0)
  })

  it('a working note stays in the office; a reply reaches the parent and rings them', async () => {
    expect((await api('admin', 'POST', `/help/desk/${id}/reply`, { body: 'Checking with accounts.', internal: true })).status).toBe(201)
    expect((await api('admin', 'POST', `/help/desk/${id}/reply`, { body: 'Which receipt number is it?', waiting: true })).status).toBe(201)
    const p = await api('parent', 'GET', `/help/requests/${id}`)
    expect(p.body.status).toBe('waiting')
    expect(p.body.thread.map((e: any) => e.body)).toEqual(['Which receipt number is it?'])
    expect(p.body.thread[0]).toMatchObject({ side: 'school', internal: false })
    const d = await api('admin', 'GET', `/help/desk/${id}`)
    expect(d.body.thread.map((e: any) => e.body)).toEqual(['Checking with accounts.', 'Which receipt number is it?'])
    expect(d.body.assigned_to).toBe('Asha Admin')
    expect(d.body.diagnostics.conversation).toHaveLength(2)
    expect((await bells(IDS.parent, id)).map((b) => b)).toContainEqual({ title: 'A reply to your request for help', link: `/help?request=${id}` })
  })

  it('the parent writes back, which takes it off waiting', async () => {
    expect((await api('parent', 'POST', `/help/requests/${id}/reply`, { body: 'RCPT-12' })).status).toBe(201)
    const d = await api('admin', 'GET', `/help/desk/${id}`)
    expect(d.body).toMatchObject({ status: 'in_progress', last_reply_side: 'raiser' })
  })

  it('solving it tells the parent; a thumbs down keeps it open to reopen; reopening needs a reason', async () => {
    expect((await api('parent', 'POST', `/help/requests/${id}/rating`, { helpful: true })).status).toBe(400) // not answered yet
    expect((await api('parent', 'POST', `/help/requests/${id}/reopen`, { reason: 'x' })).status).toBe(400) // still open
    expect((await api('admin', 'POST', `/help/desk/${id}/resolve`, { resolution: 'The receipt was reissued.' })).status).toBe(200)
    expect((await api('parent', 'POST', `/help/requests/${id}/reply`, { body: 'thanks' })).status).toBe(400)
    const down = await api('parent', 'POST', `/help/requests/${id}/rating`, { helpful: false, note: 'Still wrong' })
    expect(down.body).toMatchObject({ recorded: true, status: 'resolved' })
    expect((await api('parent', 'POST', `/help/requests/${id}/rating`, { helpful: true })).status).toBe(400) // once
    expect((await api('parent', 'POST', `/help/requests/${id}/reopen`, { reason: '' })).status).toBe(400)
    expect((await api('parent', 'POST', `/help/requests/${id}/reopen`, { reason: 'The amount is still wrong.' })).status).toBe(200)
    const again = await api('parent', 'GET', `/help/requests/${id}`)
    expect(again.body).toMatchObject({ status: 'open', reopened_count: 1 })
    expect(again.body.helpful).toBeUndefined()
    expect((await api('admin', 'POST', `/help/desk/${id}/resolve`, { resolution: 'Corrected to 5000.' })).status).toBe(200)
    const up = await api('parent', 'POST', `/help/requests/${id}/rating`, { helpful: true })
    expect(up.body).toMatchObject({ status: 'closed' })
    const row = await E.TENANT_TEST.prepare('SELECT solved_by, satisfaction FROM support_tickets WHERE id = ?').bind(id).first<any>()
    expect(row).toMatchObject({ solved_by: 'school', satisfaction: 5 })
  })
})

describe('me too', () => {
  it('shows that a report exists, never its words, and counts a second person once', async () => {
    const r = await api('parent', 'POST', '/help/requests', { category: 'attendance', body: 'Diya is marked absent on Tuesday but she was there.', route: '/parent/attendance/calendar' })
    expect(r.status).toBe(201)
    const own = await api('parent', 'GET', '/help/similar?route=/parent/attendance/calendar&category=attendance')
    expect(own.body.count).toBe(0) // your own report is not "someone else's"
    const s = await api('otherParent', 'GET', '/help/similar?route=/parent/attendance/calendar&category=attendance')
    expect(s.body).toMatchObject({ count: 1, ticket_id: r.body.id, already_following: false })
    expect(JSON.stringify(s.body)).not.toContain('Diya')
    expect((await api('parent', 'POST', `/help/requests/${r.body.id}/me-too`)).status).toBe(400)
    expect((await api('otherParent', 'POST', `/help/requests/${r.body.id}/me-too`)).body).toMatchObject({ added: true, me_too: 1 })
    expect((await api('otherParent', 'POST', `/help/requests/${r.body.id}/me-too`)).body).toMatchObject({ added: false, me_too: 1 })
    const f = await api('otherParent', 'GET', '/help/requests')
    expect(f.body.following.some((x: any) => x.id === r.body.id)).toBe(true)
    expect(JSON.stringify(f.body.following)).not.toContain('Diya')
    // Solving it tells the follower too.
    expect((await api('admin', 'POST', `/help/desk/${r.body.id}/resolve`, { resolution: 'Marked present.' })).status).toBe(200)
    expect((await bells(IDS.otherParent, r.body.id)).map((b) => b.title)).toContain('A problem you reported is solved')
  })
})

describe('escalation to the vendor', () => {
  let id = '', vendorId = ''

  it('needs the confirmation, and refuses a summary that names a student', async () => {
    const r = await api('parent', 'POST', '/help/requests', {
      category: 'marks', body: 'Chirag Test has no marks for the half yearly exam in the app.', route: '/parent/exams/report_card',
      diagnostics: { browser: 'Chrome 140', conversation: [{ role: 'user', text: 'Where are the marks of Chirag?' }], checks: [{ check: 'Marks published', ok: false, detail: 'Chirag: none' }] },
    })
    id = r.body.id
    expect((await api('teacher', 'POST', `/help/desk/${id}/escalate`, { summary: 'x', confirmed: true })).status).toBe(403)
    const unconfirmed = await api('admin', 'POST', `/help/desk/${id}/escalate`, { summary: 'A parent cannot see half yearly marks in the report card screen.' })
    expect(unconfirmed.status).toBe(400)
    expect(unconfirmed.body.code).toBe('confirm_no_child')
    for (const summary of ['Chirag cannot see marks.', 'The child chirag test cannot see marks.', 'Student A001 has no marks.']) {
      const named = await api('admin', 'POST', `/help/desk/${id}/escalate`, { summary, confirmed: true })
      expect(named.status).toBe(422)
      expect(named.body.code).toBe('names_a_child')
    }
  })

  it('sends only the summary, the screen and the device; the family words stay in the school', async () => {
    const e = await api('admin', 'POST', `/help/desk/${id}/escalate`, { summary: 'A parent of a Class 5 student cannot see half yearly marks on the report card screen.', confirmed: true })
    expect(e.status).toBe(201)
    vendorId = e.body.id
    expect((await api('admin', 'POST', `/help/desk/${id}/escalate`, { summary: 'Again, the same thing.', confirmed: true })).status).toBe(409)
    const v = await asAgent('GET', `/admin/platform/desk/${IDS.school}/tickets/${vendorId}`)
    expect(v.status).toBe(200)
    expect(v.body).toMatchObject({ escalated: true, category: 'marks', route: '/parent/exams/report_card', with: 'vendor' })
    const text = JSON.stringify(v.body)
    expect(text).not.toContain('Chirag')
    expect(text).not.toContain('Pavan')
    expect(v.body.diagnostics).toEqual({ browser: 'Chrome 140' })
    const row = await E.TENANT_TEST.prepare('SELECT student_id, parent_ticket_id, raised_by FROM support_tickets WHERE id = ?').bind(vendorId).first<any>()
    expect(row).toMatchObject({ student_id: null, parent_ticket_id: id, raised_by: IDS.admin })
    // The parent is told it was passed on, and sees none of what was sent.
    const p = await api('parent', 'GET', `/help/requests/${id}`)
    expect(p.body.escalated).toBe(true)
    expect(JSON.stringify(p.body.thread)).not.toContain('Class 5 student')
    expect((await api('parent', 'GET', `/help/requests/${vendorId}`)).status).toBe(404)
  })

  it('the schema itself refuses a vendor ticket that carries a child', async () => {
    await expect(E.TENANT_TEST.prepare(`INSERT INTO support_tickets (id, institution_id, raised_by, student_id, category, subject, body, audience) VALUES (?, ?, ?, ?, 'other', 's', 'b', 'vendor')`)
      .bind(crypto.randomUUID(), IDS.school, IDS.admin, IDS.child).run()).rejects.toThrow()
    await expect(E.TENANT_TEST.prepare(`UPDATE support_tickets SET student_id = ? WHERE id = ?`).bind(IDS.child, vendorId).run()).rejects.toThrow()
  })

  it('the vendor answers on its own thread: notes stay at the desk, replies reach the administrator', async () => {
    expect((await api('admin', 'POST', `/admin/platform/desk/${IDS.school}/tickets/${vendorId}/reply`, { body: 'x' })).status).toBe(403)
    expect((await asAgent('POST', `/admin/platform/desk/${IDS.school}/tickets/${vendorId}/reply`, { body: 'Looks like the publish flag.', internal: true })).status).toBe(201)
    expect((await asAgent('POST', `/admin/platform/desk/${IDS.school}/tickets/${vendorId}/reply`, { body: 'Has the exam been published under Exams > Publish results?', waiting: true })).status).toBe(201)
    const d = await api('admin', 'GET', `/help/desk/${id}`)
    expect(d.body.escalation).toMatchObject({ id: vendorId, status: 'waiting' })
    expect(d.body.escalation_thread.map((x: any) => x.body)).toEqual(['Has the exam been published under Exams > Publish results?'])
    expect((await bells(IDS.admin, vendorId)).map((b) => b)).toContainEqual({ title: 'XULO support replied', link: `/go/help/helpdesk?id=${vendorId}` })
    const q = (await asAgent('GET', '/admin/platform/seller/tickets')).body.items.find((x: any) => x.id === vendorId)
    expect(q).toMatchObject({ assigned_to: 'Dana Desk', status: 'waiting' })
    // The administrator writes back on the vendor ticket; a child's name is refused there too.
    expect((await api('admin', 'POST', `/help/desk/${vendorId}/reply`, { body: 'It is published. Diya sees hers.' })).status).toBe(422)
    expect((await api('admin', 'POST', `/help/desk/${vendorId}/reply`, { body: 'Yes, it is published.' })).status).toBe(201)
    const v = await asAgent('GET', `/admin/platform/desk/${IDS.school}/tickets/${vendorId}`)
    expect(v.body.thread.map((x: any) => [x.side, x.internal])).toEqual([['vendor', true], ['vendor', false], ['raiser', false]])
    expect(v.body.status).toBe('in_progress')
    expect((await asAgent('POST', `/admin/platform/desk/${IDS.school}/tickets/${vendorId}/resolve`, { resolution: 'Fixed in today\'s release.' })).status).toBe(200)
    expect((await asAgent('POST', `/admin/platform/desk/${IDS.school}/tickets/${vendorId}/resolve`, { resolution: 'again' })).status).toBe(400)
    // Solved through the vendor: the parent's request records that when the school closes it.
    expect((await api('admin', 'POST', `/help/desk/${id}/resolve`, { resolution: 'The marks now show. Open Exams > Report card.' })).status).toBe(200)
    expect((await E.TENANT_TEST.prepare('SELECT solved_by FROM support_tickets WHERE id = ?').bind(id).first<any>()).solved_by).toBe('vendor')
  })
})

describe("the administrator's own request", () => {
  it('goes straight to the vendor, never with a child in it', async () => {
    const named = await api('admin', 'POST', '/help/requests', { category: 'fees', body: 'The fee receipt for Diya Test prints blank.' })
    expect(named.status).toBe(422)
    const r = await api('admin', 'POST', '/help/requests', { category: 'fees', body: 'Fee receipts print blank since this morning.', route: '/finance/collections/collect',
      diagnostics: { conversation: [{ role: 'user', text: 'hello' }] } })
    expect(r.status).toBe(201)
    expect(r.body.with).toBe('vendor')
    const q = await asAgent('GET', '/admin/platform/seller/tickets')
    expect(q.body.items.some((t: any) => t.id === r.body.id)).toBe(true)
    const v = await asAgent('GET', `/admin/platform/desk/${IDS.school}/tickets/${r.body.id}`)
    expect(v.body.diagnostics.conversation).toBeUndefined()
    expect(v.body.escalated).toBe(false)
    // Its raiser follows it in the Help Centre like any other request.
    expect((await api('admin', 'GET', `/help/requests/${r.body.id}`)).body.with).toBe('vendor')
  })

  it('a platform account raises nothing here, and a desk route needs a real school', async () => {
    expect((await asAgent('POST', '/help/requests', { category: 'fees', body: 'x' })).status).toBe(403)
    expect((await asAgent('GET', `/admin/platform/desk/${crypto.randomUUID()}/tickets/${crypto.randomUUID()}`)).status).toBe(404)
  })
})

describe('error references', () => {
  it('an unexpected error answers with a reference, logs it, and a request carrying it opens onto the log', async () => {
    const T = E.TENANT_TEST
    await T.prepare('ALTER TABLE support_ticket_followers RENAME TO support_ticket_followers_away').run()
    let res: Response
    try {
      res = await call('/api/v1/help/requests', { cookie: (await signIn('teacher@test.school')).cookie!, headers: { 'x-app-version': 'build-42' } })
    } finally {
      await T.prepare('ALTER TABLE support_ticket_followers_away RENAME TO support_ticket_followers').run()
    }
    expect(res.status).toBe(500)
    const body = await res.json() as any
    expect(body.ref).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(res.headers.get('x-error-ref')).toBe(body.ref)
    const row = await E.CONTROL.prepare('SELECT * FROM error_refs WHERE code = ?').bind(body.ref).first<any>()
    expect(row).toMatchObject({ institution_id: IDS.school, user_id: IDS.teacher, user_name: 'Tara Teacher', method: 'GET', route: '/api/v1/help/requests', release: 'build-42' })
    expect(row.message).toContain('support_ticket_followers')

    // A refusal is not an unexpected error: no reference.
    const refused = await call('/api/v1/help/requests/not-a-uuid', { cookie: (await signIn('teacher@test.school')).cookie! })
    expect(refused.status).toBe(400)
    expect(refused.headers.get('x-error-ref')).toBeNull()

    const r = await api('admin', 'POST', '/help/requests', { category: 'screen', body: 'My requests will not open.', error_ref: body.ref.toLowerCase() })
    expect(r.status).toBe(201)
    const v = await asAgent('GET', `/admin/platform/desk/${IDS.school}/tickets/${r.body.id}`)
    expect(v.body.error_ref).toBe(body.ref)
    expect(v.body.error).toMatchObject({ code: body.ref, route: '/api/v1/help/requests', user: 'Tara Teacher' })

    // Kept 14 days.
    await E.CONTROL.prepare(`UPDATE error_refs SET at = ? WHERE code = ?`).bind(new Date(Date.now() - 15 * 86_400_000).toISOString(), body.ref).run()
    expect(await pruneErrorRefs(E)).toBeGreaterThan(0)
    const after = await asAgent('GET', `/admin/platform/desk/${IDS.school}/tickets/${r.body.id}`)
    expect(after.body.error).toBeUndefined()
    expect(after.body.error_expired).toBe(true)
  })

  it('a reference that is not one is dropped', async () => {
    const r = await api('admin', 'POST', '/help/requests', { category: 'other', body: 'Something else entirely.', error_ref: 'DROP TABLE' })
    expect(r.status).toBe(201)
    expect((await E.TENANT_TEST.prepare('SELECT error_ref FROM support_tickets WHERE id = ?').bind(r.body.id).first<any>()).error_ref).toBeNull()
  })
})
