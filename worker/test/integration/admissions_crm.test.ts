/* The admissions CRM: a lead's timeline, duplicate phone numbers, logging a
   call, stage moves, closing as lost with a reason, and converting to an
   application that carries the lead over. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS } from './fixture'

beforeAll(seed)

describe('admissions CRM', () => {
  let lead = ''

  it('logs a walk-in with a created entry on its timeline', async () => {
    const r = await api('admin', 'POST', '/admissions/workflow/enquiries',
      { student_name: 'Ravi Kumar', parent_name: 'Sita Kumar', phone: '+91 98480 11111', source: 'walk_in', class_sought: IDS.klass, notes: 'Wants the bus' })
    expect(r.status).toBe(201)
    expect(r.body.duplicates).toEqual([])
    lead = r.body.id
    const d = await api('admin', 'GET', `/admissions/workflow/enquiries/${lead}`)
    expect(d.status).toBe(200)
    expect(d.body.enquiry).toMatchObject({ student_name: 'Ravi Kumar', class_name: 'Class 5', status: 'new' })
    expect(d.body.activities.map((a: { kind: string }) => a.kind)).toEqual(['created'])
  })

  it('finds the same family by phone however the number is written', async () => {
    const dup = await api('admin', 'GET', '/admissions/workflow/enquiries/duplicates?phone=098480-11111')
    expect(dup.body.items.map((x: { id: string }) => x.id)).toEqual([lead])
    const again = await api('admin', 'POST', '/admissions/workflow/enquiries', { student_name: 'Ravi K', phone: '9848011111' })
    expect(again.body.duplicates[0].id).toBe(lead)
    const d = await api('admin', 'GET', `/admissions/workflow/enquiries/${lead}`)
    expect(d.body.duplicates[0].id).toBe(again.body.id)
  })

  it('logging a call moves a new lead to contacted and sets the follow-up', async () => {
    const r = await api('admin', 'POST', `/admissions/workflow/enquiries/${lead}/activities`, { kind: 'call', body: 'Will visit Saturday', next_follow_up: '2030-01-05' })
    expect(r.status).toBe(201)
    expect(r.body.status).toBe('contacted')
    const d = await api('admin', 'GET', `/admissions/workflow/enquiries/${lead}`)
    expect(d.body.enquiry.next_follow_up).toBe('2030-01-05')
    expect(d.body.enquiry.last_contacted_at).toBeTruthy()
    const kinds = d.body.activities.map((a: { kind: string }) => a.kind)
    expect(kinds).toContain('call')
    expect(kinds).toContain('stage')
    expect((await api('admin', 'POST', `/admissions/workflow/enquiries/${lead}/activities`, { kind: 'note' })).status).toBe(400)
    expect((await api('admin', 'POST', `/admissions/workflow/enquiries/${lead}/activities`, { kind: 'fax' })).status).toBe(400)
    expect((await api('parent', 'POST', `/admissions/workflow/enquiries/${lead}/activities`, { kind: 'call' })).status).toBe(403)
  })

  it('a stage change through the old update is recorded, and a date alone keeps the stage', async () => {
    expect((await api('admin', 'PUT', `/admissions/workflow/enquiries/${lead}`, { status: 'visit_scheduled' })).status).toBe(200)
    const r = await api('admin', 'PUT', `/admissions/workflow/enquiries/${lead}`, { next_follow_up: '2030-02-01' })
    expect(r.body.status).toBe('visit_scheduled')
    const d = await api('admin', 'GET', `/admissions/workflow/enquiries/${lead}`)
    expect(d.body.activities.find((a: { to_status: string }) => a.to_status === 'visit_scheduled')).toMatchObject({ from_status: 'contacted' })
  })

  it('lost with a reason, reopened, then converted to an application', async () => {
    const reasons = await api('admin', 'GET', '/admissions/lost-leads/reasons')
    const reason = reasons.body.items[0].value
    expect((await api('admin', 'POST', `/admissions/leads/${lead}/lost`, { reason, note: reason === 'other' ? 'x' : '' })).status).toBe(200)
    expect((await api('admin', 'POST', `/admissions/leads/${lead}/reopen`)).status).toBe(200)
    const app = await api('admin', 'POST', '/admissions/workflow/applications',
      { first_name: 'Ravi', last_name: 'Kumar', parent_name: 'Sita Kumar', parent_phone: '9848011111', class_sought: IDS.klass, enquiry_id: lead })
    expect(app.status).toBe(201)
    const d = await api('admin', 'GET', `/admissions/workflow/enquiries/${lead}`)
    expect(d.body.enquiry.status).toBe('applied')
    expect(d.body.application).toMatchObject({ id: app.body.id })
    const moves = d.body.activities.filter((a: { kind: string }) => a.kind === 'stage').map((a: { to_status: string }) => a.to_status)
    expect(moves).toEqual(['applied', 'contacted', 'lost', 'visit_scheduled', 'contacted'])
  })

  it('the list carries the class and last contact', async () => {
    const l = await api('admin', 'GET', '/admissions/enquiries')
    expect(l.body.items.find((x: { id: string }) => x.id === lead)).toMatchObject({ class_name: 'Class 5', status: 'applied' })
  })

  it('offers an AI follow-up draft for a lead, only to admissions staff', async () => {
    expect((await api('admin', 'POST', '/ai/draft', { kind: 'enquiry_follow_up' })).status).toBe(400)
    const r = await api('admin', 'POST', '/ai/draft', { kind: 'enquiry_follow_up', enquiry_id: lead })
    expect(r.status).toBe(200)
    expect((await api('parent', 'POST', '/ai/draft', { kind: 'enquiry_follow_up', enquiry_id: lead })).status).toBe(403)
  })

  it('404s an unknown lead', async () => {
    expect((await api('admin', 'GET', '/admissions/workflow/enquiries/00000000-0000-4000-8000-000000009999')).status).toBe(404)
  })
})
