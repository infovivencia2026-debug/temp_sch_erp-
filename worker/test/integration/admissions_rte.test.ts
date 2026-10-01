/* Admissions audit fixes: the drip sweep on the cron, the old stage update
   filling the lost-lead columns, the RTE quota from the counter to the seat
   guard, admission sessions, and statutory fields carried to the student. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'
import { SCHEDULES } from '../../src/services/cron'
import { runCampaigns } from '../../src/routes/admissions/campaigns'
import { seatGuard } from '../../src/routes/admissions/workflow'

beforeAll(seed)

const apply = (first: string, extra: Record<string, unknown> = {}) => api('admin', 'POST', '/admissions/workflow/applications',
  { first_name: first, parent_name: 'P ' + first, parent_phone: '98480' + String(Math.floor(Math.random() * 1e5)).padStart(5, '0'), class_sought: IDS.klass, ...extra })

describe('admission drip on the cron', () => {
  it('is scheduled per school and the sweep is idempotent', async () => {
    expect(SCHEDULES.find((s) => s.name === 'admission_campaigns')).toMatchObject({ kind: 'admissions:campaigns_run', perInstitution: true })
    const camp = await api('admin', 'POST', '/admissions/campaigns', { name: 'Nurture', is_active: true })
    await api('admin', 'POST', `/admissions/campaigns/${camp.body.id}/steps`, { step_no: 1, name: 'Hello', offset_days: 0, channel: 'sms', template_code: 'admissions.nurture', is_active: true })
    const lead = await api('admin', 'POST', '/admissions/workflow/enquiries', { student_name: 'Drip Kid', phone: '9000000001' })
    const en = await api('admin', 'POST', `/admissions/campaigns/${camp.body.id}/enrol`, { enquiry_ids: [lead.body.id] })
    expect(en.body.enrolled).toBe(1)
    const first = await runCampaigns(E, E.TENANT_TEST, IDS.school)
    expect(first.considered).toBe(1)
    const again = await runCampaigns(E, E.TENANT_TEST, IDS.school)
    expect(again.considered).toBe(0)
    const pending = await E.TENANT_TEST.prepare(`SELECT count(*) AS n FROM admission_campaign_sends WHERE status = 'pending'`).first<{ n: number }>()
    expect(pending?.n).toBe(0)
  })
})

describe('lost through the stage update', () => {
  it('writes the structured reason, free text as other, and clears on reopen', async () => {
    const a = await api('admin', 'POST', '/admissions/workflow/enquiries', { student_name: 'Lost One', phone: '9000000002' })
    expect((await api('admin', 'PUT', `/admissions/workflow/enquiries/${a.body.id}`, { status: 'lost', lost_reason: 'fees' })).status).toBe(200)
    let row = await E.TENANT_TEST.prepare(`SELECT lost_reason, lost_reason_note, lost_at, lost_month FROM enquiries WHERE id = ?`).bind(a.body.id).first<Record<string, string | null>>()
    expect(row).toMatchObject({ lost_reason: 'fees', lost_reason_note: null })
    expect(row?.lost_at).toBeTruthy()
    expect(row?.lost_month).toMatch(/-01$/)

    const b = await api('admin', 'POST', '/admissions/workflow/enquiries', { student_name: 'Lost Two', phone: '9000000003' })
    await api('admin', 'PUT', `/admissions/workflow/enquiries/${b.body.id}`, { status: 'lost', lost_reason: 'moved to Pune' })
    row = await E.TENANT_TEST.prepare(`SELECT lost_reason, lost_reason_note FROM enquiries WHERE id = ?`).bind(b.body.id).first()
    expect(row).toMatchObject({ lost_reason: 'other', lost_reason_note: 'moved to Pune' })

    await api('admin', 'PUT', `/admissions/workflow/enquiries/${b.body.id}`, { status: 'contacted' })
    row = await E.TENANT_TEST.prepare(`SELECT lost_reason, lost_at FROM enquiries WHERE id = ?`).bind(b.body.id).first()
    expect(row).toMatchObject({ lost_reason: null, lost_at: null })
  })
})

describe('RTE pipeline', () => {
  it('the counter writes the quota', async () => {
    const r = await apply('Rte', { is_rte: true })
    const g = await apply('Gen')
    const rows = await E.TENANT_TEST.prepare(`SELECT id, quota, is_rte, rte_status FROM applications WHERE id IN (?, ?)`).bind(r.body.id, g.body.id).all<Record<string, unknown>>()
    const by = Object.fromEntries(rows.results.map((x) => [x.id, x]))
    expect(by[r.body.id]).toMatchObject({ quota: 'rte', is_rte: 1, rte_status: 'applied' })
    expect(by[g.body.id]).toMatchObject({ quota: 'general', is_rte: 0 })
    expect((await apply('Bad', { quota: 'vip' })).status).toBe(400)
  })

  it('seatGuard holds a quarter for RTE', () => {
    expect(seatGuard({ capacity: 40, enrolled: 30, enrolled_rte: 0, offered: 0, offered_rte: 0 })).toEqual({ available: 10, rte_reserved: 10, general_available: 0 })
    expect(seatGuard({ capacity: 40, enrolled: 30, enrolled_rte: 10, offered: 0, offered_rte: 0 })).toEqual({ available: 10, rte_reserved: 0, general_available: 10 })
  })

  describe('the offer guard', () => {
    afterAll(async () => { await E.TENANT_TEST.prepare(`UPDATE sections SET capacity = 40 WHERE id = ?`).bind(IDS.section).run() })
    it('refuses a general offer that would eat the RTE seats, allows an RTE one', async () => {
      // Two children are already enrolled; capacity 4 leaves 2 seats, 1 of them held for RTE.
      await E.TENANT_TEST.prepare(`UPDATE sections SET capacity = 4 WHERE id = ?`).bind(IDS.section).run()
      await E.TENANT_TEST.prepare(`UPDATE applications SET status = 'rejected'`).run()
      const g1 = await apply('G1'), g2 = await apply('G2'), r1 = await apply('R1', { quota: 'rte' })
      expect((await api('admin', 'POST', `/admissions/workflow/applications/${g1.body.id}/decision`, { decision: 'offered' })).status).toBe(200)
      const refused = await api('admin', 'POST', `/admissions/workflow/applications/${g2.body.id}/decision`, { decision: 'offered' })
      expect(refused.status).toBe(409)
      expect(JSON.stringify(refused.body)).toContain('rte_reserved')
      expect((await api('admin', 'POST', `/admissions/workflow/applications/${r1.body.id}/decision`, { decision: 'offered' })).status).toBe(200)
    })
  })

  it('admission sessions: create, list, update, refuse delete in use', async () => {
    const bad = await api('admin', 'POST', '/admissions/sessions', { name: 'X' })
    expect(bad.status).toBe(400)
    const s = await api('admin', 'POST', '/admissions/sessions', { name: 'Admissions 2027', academic_year_id: IDS.year, opens_on: '2027-01-01', closes_on: '2027-03-31' })
    expect(s.status).toBe(201)
    const l = await api('admin', 'GET', '/admissions/sessions')
    expect(l.body.items.find((x: { id: string }) => x.id === s.body.id)).toMatchObject({ name: 'Admissions 2027', is_open: true, applications: 0 })
    expect((await api('admin', 'PUT', `/admissions/sessions/${s.body.id}`, { name: 'Admissions 2027-28', academic_year_id: IDS.year, is_open: false })).status).toBe(200)
    await apply('InSession', { admission_session_id: s.body.id })
    expect((await api('admin', 'DELETE', `/admissions/sessions/${s.body.id}`)).status).toBe(409)
    const s2 = await api('admin', 'POST', '/admissions/sessions', { name: 'Spare', academic_year_id: IDS.year })
    expect((await api('admin', 'DELETE', `/admissions/sessions/${s2.body.id}`)).status).toBe(200)
    expect((await api('parent', 'GET', '/admissions/sessions')).status).toBe(403)
  })
})

describe('conversion carries statutory fields', () => {
  it('copies Aadhaar, APAAR, UDISE, RTE and the rest to the student', async () => {
    const a = await apply('Stat', { category: 'obc', address: '1 Main Rd', previous_school: 'Little Stars' })
    await api('admin', 'POST', '/admissions/applications/patch', { id: a.body.id, quota: 'rte', aadhaar_consent: true, aadhaar_last4: '1234',
      apaar_id: 'APAAR123', prior_udise_code: '36123456789', blood_group: 'B+' })
    await E.TENANT_TEST.prepare(`UPDATE applications SET status = 'offered' WHERE id = ?`).bind(a.body.id).run()
    const r = await api('admin', 'POST', `/admissions/workflow/applications/${a.body.id}/enrol`, { section_id: IDS.section, no_invoice: true })
    expect(r.status).toBe(201)
    const st = await E.TENANT_TEST.prepare(`SELECT category, is_rte, aadhaar_consent, aadhaar_last4, apaar_id, prior_udise_code, prior_school, blood_group, address_line1
        FROM students WHERE id = ?`).bind(r.body.student_id).first()
    expect(st).toMatchObject({ category: 'obc', is_rte: 1, aadhaar_consent: 1, aadhaar_last4: '1234', apaar_id: 'APAAR123',
      prior_udise_code: '36123456789', prior_school: 'Little Stars', blood_group: 'B+', address_line1: '1 Main Rd' })
  })
})
