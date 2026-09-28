/* The concerns pipeline, end to end, and its privacy rules.

   Families: raise with the SLA stamped from the category's policy, the five
   stages, internal notes kept from the raiser, replies and stage changes
   notified, the raiser writing back, reopening within the window, rating.
   Staff: raising anonymously, the raiser following an anonymous case, HR's
   pipeline never returning who raised it, and the cell closed to anyone who
   is not HR, the principal or the person handling a case. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

const T = () => E.TENANT_TEST
const EMP_TEACHER = '00000000-0000-4000-8000-000000000301'
const EMP_ADMIN = '00000000-0000-4000-8000-000000000302'

beforeAll(async () => {
  await seed()
  const campus = (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
  await T().batch([
    T().prepare(`INSERT OR IGNORE INTO employees (id, institution_id, campus_id, employee_code, first_name, last_name, user_id) VALUES (?, ?, ?, 'T01', 'Tara', 'Teacher', ?)`)
      .bind(EMP_TEACHER, IDS.school, campus, IDS.teacher),
    T().prepare(`INSERT OR IGNORE INTO employees (id, institution_id, campus_id, employee_code, first_name, last_name, user_id) VALUES (?, ?, ?, 'A01', 'Asha', 'Admin', ?)`)
      .bind(EMP_ADMIN, IDS.school, campus, IDS.admin),
  ])
  const r = await api('admin', 'PUT', '/comms/grievance-sla', { category: 'transport', department: 'Transport office', respond_hours: 4, resolve_hours: 48 })
  expect(r.status).toBe(200)
})

const notes = async (user: string, source: string) =>
  (await T().prepare(`SELECT title FROM notifications WHERE user_id = ? AND source_id = ? ORDER BY created_at`).bind(user, source).all<{ title: string }>()).results.map((x) => x.title)

describe('family concerns', () => {
  let id = ''

  it('stamps the SLA from the policy the moment a concern is raised', async () => {
    const r = await api('parent', 'POST', '/portal/concerns', { category: 'transport', subject: 'Bus late every day', body: 'Route 4 is 30 minutes late.' })
    expect(r.status).toBe(201)
    id = r.body.id
    const d = await api('admin', 'GET', `/comms/grievances/${id}`)
    expect(d.body).toMatchObject({ stage: 'new', status: 'open', department: 'Transport office', respond_breached: false })
    const hours = (Date.parse(d.body.resolve_due_at) - Date.parse(d.body.created_at)) / 3600_000
    expect(Math.round(hours)).toBe(48)
    const list = await api('admin', 'GET', '/comms/grievances?stage=new')
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(id)
    expect(list.body.counts.new).toBeGreaterThanOrEqual(1)
  })

  it('acknowledging moves it to acknowledged, keeps it open, and tells the parent', async () => {
    expect((await api('admin', 'POST', `/comms/grievances/${id}/acknowledge`, {})).status).toBe(200)
    const d = await api('admin', 'GET', `/comms/grievances/${id}`)
    expect(d.body).toMatchObject({ stage: 'acknowledged', status: 'open' })
    expect(await notes(IDS.parent, id)).toContain('Your concern has been acknowledged')
  })

  it('keeps internal notes from the parent and sends replies', async () => {
    await api('admin', 'POST', `/comms/grievances/${id}/updates`, { body: 'Driver has a history here', visible_to_parent: false })
    const rep = await api('admin', 'POST', `/comms/grievances/${id}/updates`, { body: 'We have spoken to the transport office.', visible_to_parent: true })
    expect(rep.body).toEqual({ added: true })
    const p = await api('parent', 'GET', `/portal/comms/grievances/${id}`)
    const bodies = p.body.timeline.map((u: { body: string }) => u.body)
    expect(bodies).toContain('We have spoken to the transport office.')
    expect(bodies).not.toContain('Driver has a history here')
    expect(await notes(IDS.parent, id)).toContain('The school replied to your concern')
    const office = await api('admin', 'GET', `/comms/grievances/${id}/updates`)
    expect(office.body.items.map((u: { body: string }) => u.body)).toContain('Driver has a history here')
  })

  it('assigns to a person, starts work, and hears the parent write back', async () => {
    const a = await api('admin', 'PUT', `/comms/grievances/${id}/assign`, { assigned_to: IDS.teacher })
    expect(a.body.assigned_to).toBe('Tara Teacher')
    expect(await notes(IDS.teacher, id)).toContain('A concern has been given to you')
    await api('admin', 'POST', `/comms/grievances/${id}/start`, {})
    expect((await api('admin', 'GET', `/comms/grievances/${id}`)).body.stage).toBe('in_progress')
    const r = await api('parent', 'POST', `/portal/comms/grievances/${id}/reply`, { body: 'Still late today.' })
    expect(r.status).toBe(201)
    expect(await notes(IDS.teacher, id)).toContain('A family replied on a concern')
    const d = await api('admin', 'GET', `/comms/grievances/${id}`)
    expect(d.body.unanswered_replies).toBe(1)
  })

  it('another family cannot read, reply to or reopen it', async () => {
    expect((await api('otherParent', 'GET', `/portal/comms/grievances/${id}`)).status).toBe(404)
    expect((await api('otherParent', 'POST', `/portal/comms/grievances/${id}/reply`, { body: 'x' })).status).toBe(404)
    expect((await api('otherParent', 'GET', '/portal/concerns')).body.items.map((x: { id: string }) => x.id)).not.toContain(id)
  })

  it('resolves, is rated, and can be reopened inside the window', async () => {
    await api('admin', 'POST', `/comms/grievances/${id}/resolve`, { resolution: 'Route re-timed from Monday.' })
    let mine = (await api('parent', 'GET', '/portal/concerns')).body.items.find((x: { id: string }) => x.id === id)
    expect(mine).toMatchObject({ stage: 'resolved', can_reopen: true })
    expect((await api('parent', 'POST', `/portal/comms/grievances/${id}/satisfaction`, { rating: 2 })).status).toBe(200)
    expect((await api('parent', 'POST', `/portal/comms/grievances/${id}/reply`, { body: 'x' })).status).toBe(400)
    const r = await api('parent', 'POST', `/portal/comms/grievances/${id}/reopen`, { reason: 'Still late.' })
    expect(r.status).toBe(200)
    mine = (await api('parent', 'GET', '/portal/concerns')).body.items.find((x: { id: string }) => x.id === id)
    expect(mine).toMatchObject({ status: 'open', reopened_count: 1, can_reopen: false })
    expect(mine.satisfaction).toBeUndefined()
  })

  it('will not reopen after the window', async () => {
    await api('admin', 'POST', `/comms/grievances/${id}/resolve`, { resolution: 'Done.' })
    await T().prepare(`UPDATE support_tickets SET resolved_at = '2020-01-01T00:00:00Z' WHERE id = ?`).bind(id).run()
    expect((await api('parent', 'POST', `/portal/comms/grievances/${id}/reopen`, { reason: 'x' })).status).toBe(400)
  })

  it('flags a breach and escalates overdue concerns in one go', async () => {
    const r = await api('parent', 'POST', '/portal/concerns', { category: 'transport', subject: 'Old one', body: 'Waiting a week' })
    await T().prepare(`UPDATE support_tickets SET created_at = '2020-01-01T00:00:00Z', respond_due_at = '2020-01-01T04:00:00Z', resolve_due_at = '2020-01-03T00:00:00Z' WHERE id = ?`).bind(r.body.id).run()
    const d = await api('admin', 'GET', `/comms/grievances/${r.body.id}`)
    expect(d.body).toMatchObject({ respond_breached: true, resolve_breached: true, escalated: false })
    const e = await api('admin', 'POST', '/comms/grievances/escalate-overdue', { to_user_id: IDS.teacher })
    expect(e.body.escalated).toBeGreaterThanOrEqual(1)
    expect((await api('admin', 'GET', `/comms/grievances/${r.body.id}`)).body).toMatchObject({ escalated: true, escalated_to: 'Tara Teacher' })
  })

  it('the office queue is closed to a teacher and a parent', async () => {
    expect((await api('teacher', 'GET', '/comms/grievances')).status).toBe(403)
    expect((await api('parent', 'GET', '/comms/grievances')).status).toBe(403)
  })
})

describe('staff concerns', () => {
  let anon = ''
  let named = ''

  it('a teacher raises one anonymously and can follow it', async () => {
    const r = await api('teacher', 'POST', '/me/concerns', { category: 'workload', severity: 'high', subject: 'Substitution load', description: 'Six extra periods a week.', is_anonymous: true })
    expect(r.status).toBe(201)
    anon = r.body.id
    expect(r.body.reference_no).toMatch(/^GRV\//)
    const mine = await api('teacher', 'GET', '/me/concerns')
    expect(mine.body.items.find((x: { id: string }) => x.id === anon)).toMatchObject({ is_anonymous: true, stage: 'new' })
    const row = await T().prepare(`SELECT employee_id, raised_by, raiser_hash FROM staff_grievances WHERE id = ?`).bind(anon).first<Record<string, unknown>>()
    expect(row!.employee_id).toBeNull()
    expect(row!.raised_by).toBeNull()
    expect(String(row!.raiser_hash)).not.toContain(IDS.teacher)
  })

  it('HR sees the case with SLA due times but never who raised it', async () => {
    const list = await api('admin', 'GET', '/hr/grievances')
    const row = list.body.items.find((x: { id: string }) => x.id === anon)
    expect(row).toMatchObject({ is_anonymous: true, stage: 'new', severity: 'high' })
    expect(row.full_name).toBeUndefined()
    expect(Math.round((Date.parse(row.resolve_due_at) - Date.parse(row.created_at)) / 3600_000)).toBe(72)
    await api('teacher', 'POST', `/me/concerns/${anon}/reply`, { body: 'It is getting worse.' })
    await api('admin', 'POST', `/hr/grievances/${anon}/updates`, { body: 'We are reviewing the timetable.', visible_to_raiser: true })
    const everything = JSON.stringify([
      list.body,
      (await api('admin', 'GET', `/hr/grievances/${anon}`)).body,
      (await api('admin', 'GET', `/hr/grievances/${anon}/updates`)).body,
      (await api('admin', 'GET', '/hr/grievances')).body,
    ])
    expect(everything).not.toContain(IDS.teacher)
    expect(everything).not.toContain('Tara')
    expect(everything).not.toContain('raiser_hash')
    expect(everything).not.toContain('raised_by')
    const tl = (await api('admin', 'GET', `/hr/grievances/${anon}/updates`)).body.items
    expect(tl.find((u: { body: string }) => u.body === 'It is getting worse.').author).toBe('Raiser (anonymous)')
    // No notification can be addressed to an anonymous raiser.
    expect(await notes(IDS.teacher, anon)).toEqual([])
    // The raiser still sees the reply on their own copy.
    const d = await api('teacher', 'GET', `/me/concerns/${anon}`)
    expect(d.body.timeline.map((u: { body: string }) => u.body)).toContain('We are reviewing the timetable.')
  })

  it('a named concern notifies its raiser and keeps internal notes internal', async () => {
    const r = await api('teacher', 'POST', '/me/concerns', { category: 'facilities', subject: 'Staff room fan', description: 'Broken for a month.' })
    named = r.body.id
    await api('admin', 'POST', `/hr/grievances/${named}/acknowledge`, {})
    await api('admin', 'POST', `/hr/grievances/${named}/updates`, { body: 'Check the maintenance budget', visible_to_raiser: false })
    await api('admin', 'POST', `/hr/grievances/${named}/start`, {})
    await api('admin', 'POST', `/hr/grievances/${named}/decide`, { status: 'resolved', resolution: 'Fan replaced.' })
    expect(await notes(IDS.teacher, named)).toEqual([
      expect.stringContaining('has been acknowledged'),
      expect.stringContaining('In progress'),
      expect.stringContaining('Resolved'),
    ])
    const d = await api('teacher', 'GET', `/me/concerns/${named}`)
    const bodies = d.body.timeline.map((u: { body: string }) => u.body)
    expect(bodies).toContain('Fan replaced.')
    expect(bodies).not.toContain('Check the maintenance budget')
    expect(d.body).toMatchObject({ stage: 'resolved', can_reopen: true })
    expect((await api('teacher', 'POST', `/me/concerns/${named}/rate`, { rating: 5 })).status).toBe(200)
    expect((await api('teacher', 'POST', `/me/concerns/${named}/reopen`, { reason: 'Fan broke again' })).status).toBe(200)
    expect((await api('admin', 'GET', `/hr/grievances/${named}`)).body).toMatchObject({ stage: 'acknowledged', reopened_count: 1 })
  })

  it('the cell is closed to anyone but HR, the principal and the assignee', async () => {
    expect((await api('teacher', 'GET', '/hr/grievances')).status).toBe(403)
    expect((await api('finance', 'GET', '/hr/grievances')).status).toBe(403)
    expect((await api('teacher', 'GET', `/hr/grievances/${anon}/updates`)).status).toBe(403)
    expect((await api('teacher', 'POST', `/hr/grievances/${anon}/updates`, { body: 'x' })).status).toBe(403)
    // A family cannot raise or read staff concerns.
    expect((await api('parent', 'GET', '/me/concerns')).status).toBe(403)
    expect((await api('parent', 'POST', '/me/concerns', { subject: 'x', description: 'y' })).status).toBe(403)
    // Another member of staff cannot read somebody else's.
    expect((await api('finance', 'GET', `/me/concerns/${anon}`)).status).toBe(404)
  })

  it('does not assign a concern to the person who raised it', async () => {
    const r = await api('admin', 'PUT', `/hr/grievances/${named}/assign`, { assigned_to: IDS.teacher })
    expect(r.status).toBe(400)
  })
})
