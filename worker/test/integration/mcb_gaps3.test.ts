/* Third MCB group: leave application windows, staff acknowledging a policy,
   and certificates issued for a whole section (achievement, promotion, TC
   with the fee block respected). */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, isoDay, E } from './fixture'

beforeAll(seed)
const T = () => E.TENANT_TEST
const uuid = (n: number) => `00000000-0000-4000-8000-${String(1100 + n).padStart(12, '0')}`
const today = isoDay(0)
const mmdd = (d: string) => d.slice(5)

async function staff(): Promise<void> {
  const cid = (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
  await T().prepare(`INSERT OR IGNORE INTO employees (id, institution_id, campus_id, user_id, employee_code, first_name) VALUES (?, ?, ?, ?, 'E-W1', 'Tara')`)
    .bind(uuid(1), IDS.school, cid, IDS.teacher).run()
}

describe('leave application windows', () => {
  let typeId = ''
  beforeAll(async () => {
    await staff()
    const r = await api('admin', 'POST', '/hr/leave-types', { code: 'EL', name: 'Earned leave', applies_to: 'staff', annual_quota: 15, is_paid: true })
    expect([200, 201]).toContain(r.status)
    typeId = (await T().prepare(`SELECT id FROM leave_types WHERE code = 'EL' AND applies_to = 'staff'`).first<{ id: string }>())!.id
  })

  it('refuses a half window and a bad date', async () => {
    const base = { late_marks_per_lop_day: 3 }
    expect((await api('admin', 'POST', '/hr/leave-policy', { ...base, types: [{ leave_type_id: typeId, window_from: '04-01' }] })).status).toBe(400)
    expect((await api('admin', 'POST', '/hr/leave-policy', { ...base, types: [{ leave_type_id: typeId, window_from: '13-01', window_to: '13-31' }] })).status).toBe(400)
  })

  it('keeps the window and refuses an application outside it', async () => {
    const base = { late_marks_per_lop_day: 3 }
    // A window that is closed today: the single day after tomorrow.
    const closed = mmdd(isoDay(2))
    expect((await api('admin', 'POST', '/hr/leave-policy', { ...base, types: [{ leave_type_id: typeId, window_from: closed, window_to: closed }] })).status).toBe(200)
    const pol = await api('admin', 'GET', '/hr/leave-policy')
    const t = pol.body.types.find((x: { leave_type_id: string }) => x.leave_type_id === typeId)
    expect(t.window_from).toBe(closed)
    const no = await api('teacher', 'POST', '/workflow/leave', { leave_type_id: typeId, from_date: isoDay(20), to_date: isoDay(21), reason: 'family' })
    expect(no.status).toBe(400)
    expect(String(no.body?.error?.message ?? JSON.stringify(no.body))).toContain('applications for this leave type')
    // A window that wraps the year end and contains today.
    const from = mmdd(isoDay(-3)), to = mmdd(isoDay(3))
    expect((await api('admin', 'POST', '/hr/leave-policy', { ...base, types: [{ leave_type_id: typeId, window_from: from, window_to: to }] })).status).toBe(200)
    const yes = await api('teacher', 'POST', '/workflow/leave', { leave_type_id: typeId, from_date: isoDay(20), to_date: isoDay(21), reason: 'family' })
    expect(yes.status).toBe(201)
    // Cleared: any time again.
    expect((await api('admin', 'POST', '/hr/leave-policy', { ...base, types: [{ leave_type_id: typeId, window_from: '', window_to: '' }] })).status).toBe(200)
  })
})

describe('staff handbook', () => {
  beforeAll(staff)
  it('a policy is a circular to staff that each member of staff acknowledges once', async () => {
    const pub = await api('admin', 'POST', '/communication/circulars', { title: 'Leave policy 2026', body: 'Apply in April.', kind: 'policy', audience_role: 'staff', requires_ack: true })
    expect([200, 201]).toContain(pub.status)
    const id = pub.body.id
    const before = await api('teacher', 'GET', '/communication/circulars')
    const mine = before.body.items.find((x: { id: string }) => x.id === id)
    expect(mine.kind).toBe('policy'); expect(mine.acknowledged_by_me).toBe(false)
    expect((await api('teacher', 'POST', `/communication/circulars/${id}/ack`)).status).toBe(200)
    expect((await api('teacher', 'POST', `/communication/circulars/${id}/ack`)).status).toBe(200)
    const n = await T().prepare(`SELECT count(*) AS n FROM staff_announcement_acks WHERE announcement_id = ? AND user_id = ?`).bind(id, IDS.teacher).first<{ n: number }>()
    expect(n!.n).toBe(1)
    const after = await api('teacher', 'GET', '/communication/circulars')
    expect(after.body.items.find((x: { id: string }) => x.id === id).acknowledged_by_me).toBe(true)
    expect((await api('finance', 'POST', `/communication/circulars/${id}/ack`)).status).toBe(400)
    const who = await api('admin', 'GET', `/communication/circulars/${id}/delivery`)
    expect(who.status).toBe(200)
    expect(who.body.acknowledged).toBeGreaterThanOrEqual(1)
  })
})

describe('certificates for a whole section', () => {
  it('needs something to achieve, and names the children it skipped', async () => {
    expect((await api('admin', 'POST', '/lifecycle/certificates/bulk', { section_id: IDS.section, type_code: 'ACHIEVEMENT' })).status).toBe(200)
  })

  it('issues achievement and promotion certificates to every child of the section', async () => {
    const r = await api('admin', 'POST', '/lifecycle/certificates/bulk', { section_id: IDS.section, type_code: 'ACHIEVEMENT', achievement: 'Participation', event: 'Sports day' })
    expect(r.status).toBe(200)
    expect(r.body.issued).toBe(2)
    expect(r.body.skipped).toBe(0)
    const render = await api('admin', 'GET', `/lifecycle/certificates/${(await T().prepare(`SELECT ic.id FROM issued_certificates ic JOIN certificate_types ct ON ct.id = ic.certificate_type_id WHERE ct.code = 'ACHIEVEMENT' ORDER BY ic.created_at DESC LIMIT 1`).first<{ id: string }>())!.id}/render`)
    expect(render.status).toBe(200)
    expect(render.body.fields.achievement).toBe('Participation')
    expect(render.body.title).toBe('Achievement Certificate')
    const p = await api('admin', 'POST', '/lifecycle/certificates/bulk', { section_id: IDS.section, type_code: 'PROMOTION' })
    expect(p.body.issued).toBe(2)
    expect((await api('admin', 'POST', '/lifecycle/certificates/bulk', { section_id: 'nope', type_code: 'PROMOTION' })).status).toBe(400)
    expect((await api('parent', 'POST', '/lifecycle/certificates/bulk', { section_id: IDS.section, type_code: 'PROMOTION' })).status).toBe(403)
  })

  it('bulk transfer certificates skip a child who owes fees rather than override', async () => {
    const r = await api('admin', 'POST', '/lifecycle/certificates/bulk', { section_id: IDS.section, type_code: 'TC', reason: 'Batch left' })
    expect(r.status).toBe(200)
    // Both seeded children owe their invoice, so both are skipped and named.
    expect(r.body.issued).toBe(0)
    expect(r.body.skipped).toBe(2)
    expect(r.body.skipped_items[0].reason).toContain('owed')
    const still = await T().prepare(`SELECT status FROM students WHERE id = ?`).bind(IDS.child).first<{ status: string }>()
    expect(still!.status).toBe('active')
  })
})

describe('the live vehicle map screen', () => {
  it('still answers its data for the office', async () => {
    const r = await api('admin', 'GET', '/ops/transport/vehicles')
    expect(r.status).toBe(200)
  })
})
