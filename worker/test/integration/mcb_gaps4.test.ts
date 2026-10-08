/* Fourth MCB group: a zone on each stop with the transport reports, and
   staff asking for a day's punch to be fixed. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, as, call, IDS, isoDay, E } from './fixture'

beforeAll(seed)
const T = () => E.TENANT_TEST
const uuid = (n: number) => `00000000-0000-4000-8000-${String(1200 + n).padStart(12, '0')}`

describe('transport zones and reports', () => {
  it('a stop keeps its zone, and the reports run', async () => {
    const r = await api('admin', 'POST', '/ops/transport/routes', { name: 'Kukatpally', code: 'R-Z1', stops: [
      { name: 'KPHB Colony', pickup_time: '07:10', latitude: '17.4948', longitude: '78.3996', zone: 'Kukatpally' },
      { name: 'Hitec City', pickup_time: '07:30', latitude: '17.4435', longitude: '78.3772' },
    ] })
    expect([200, 201]).toContain(r.status)
    const rid = r.body.id
    const stops = await api('admin', 'GET', `/ops/transport/routes/${rid}/stops`)
    expect(stops.status).toBe(200)
    const kphb = stops.body.items.find((s: { name: string }) => s.name === 'KPHB Colony')
    expect(kphb.zone).toBe('Kukatpally')
    const cookie = await as('admin')
    for (const name of ['transport_zone_students', 'transport_daily_sheet', 'vehicle_papers']) {
      const res = await call(`/api/v1/export/${name}`, { cookie })
      expect(res.status, name).toBe(200)
      expect(await res.text(), name).not.toContain('EXPORT FAILED')
    }
    const sheet = await (await call('/api/v1/export/transport_daily_sheet', { cookie })).text()
    expect(sheet).toContain('Kukatpally')
  })
})

describe('fixing a day’s punch', () => {
  beforeAll(async () => {
    const cid = (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
    await T().prepare(`INSERT OR IGNORE INTO employees (id, institution_id, campus_id, user_id, employee_code, first_name) VALUES (?, ?, ?, ?, 'E-P1', 'Tara')`)
      .bind(uuid(1), IDS.school, cid, IDS.teacher).run()
  })
  let id = ''

  it('a member of staff asks, with checks', async () => {
    expect((await api('teacher', 'POST', '/hr/attendance-requests', { on_date: isoDay(1), reason: 'reader was down' })).status).toBe(400)
    expect((await api('teacher', 'POST', '/hr/attendance-requests', { on_date: isoDay(-1), reason: 'x' })).status).toBe(400)
    expect((await api('teacher', 'POST', '/hr/attendance-requests', { on_date: isoDay(-1), check_in: '9am', reason: 'reader was down' })).status).toBe(400)
    expect((await api('teacher', 'POST', '/hr/attendance-requests', { on_date: isoDay(-1), check_in: '09:00', check_out: '08:00', reason: 'reader was down' })).status).toBe(400)
    expect((await api('parent', 'POST', '/hr/attendance-requests', { on_date: isoDay(-1), reason: 'reader was down' })).status).toBe(400)
    const r = await api('teacher', 'POST', '/hr/attendance-requests', { on_date: isoDay(-1), check_in: '08:50', check_out: '16:10', reason: 'The reader at the gate was off' })
    expect(r.status).toBe(201)
    id = r.body.id
    expect((await api('teacher', 'POST', '/hr/attendance-requests', { on_date: isoDay(-1), reason: 'again please' })).status).toBe(409)
    const mine = await api('teacher', 'GET', '/hr/attendance-requests?for=mine')
    expect(mine.body.items.some((x: { id: string }) => x.id === id)).toBe(true)
    // Somebody without the HR right only ever sees their own.
    const theirs = await api('finance', 'GET', '/hr/attendance-requests')
    expect(theirs.body.items.some((x: { id: string }) => x.id === id)).toBe(false)
  })

  it('HR approves and the register carries the mark; a refusal needs a note', async () => {
    expect((await api('teacher', 'POST', `/hr/attendance-requests/${id}/decide`, { decision: 'approved' })).status).toBe(403)
    expect((await api('admin', 'POST', `/hr/attendance-requests/${id}/decide`, { decision: 'rejected' })).status).toBe(400)
    const ok = await api('admin', 'POST', `/hr/attendance-requests/${id}/decide`, { decision: 'approved', note: 'Guard confirmed' })
    expect(ok.status).toBe(200)
    const mark = await T().prepare(`SELECT status, check_in, remarks FROM staff_attendance WHERE user_id = ? AND on_date = ?`).bind(IDS.teacher, isoDay(-1))
      .first<{ status: string; check_in: string; remarks: string }>()
    expect(mark!.status).toBe('present')
    expect(mark!.check_in).toBeTruthy()
    expect(mark!.remarks).toContain('Guard confirmed')
    expect((await api('admin', 'POST', `/hr/attendance-requests/${id}/decide`, { decision: 'approved' })).status).toBe(404)
  })
})
