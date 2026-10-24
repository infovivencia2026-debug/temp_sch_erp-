/* The front desk's existing-parent picker: who may search, what comes back,
   and the pass that names the parent. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

beforeAll(async () => { await seed() })

describe('GET /office/visitors/parents', () => {
  it('refuses anyone without the front desk permission', async () => {
    expect((await api(null, 'GET', '/office/visitors/parents?q=Pavan')).status).toBe(401)
    expect((await api('parent', 'GET', '/office/visitors/parents?q=Pavan')).status).toBe(403)
  })

  it('finds a parent by name or phone, with only name, phone and children', async () => {
    const r = await api('admin', 'GET', '/office/visitors/parents?q=pavan')
    expect(r.status).toBe(200)
    expect(r.body.items).toEqual([{ id: IDS.guardian, name: 'Pavan Parent', phone: '9000000001',
      children: [{ id: IDS.child, name: 'Chirag Test', class: 'Class 5 A' }] }])
    const byPhone = await api('admin', 'GET', '/office/visitors/parents?q=000002')
    expect(byPhone.body.items.map((g: any) => g.id)).toEqual([IDS.otherGuardian])
    expect((await api('admin', 'GET', '/office/visitors/parents?q=p')).body.items).toEqual([])
  })

  it('links a pass to the parent picked, and refuses a parent from nowhere', async () => {
    const r = await api('admin', 'POST', '/office/visitors', { full_name: 'Pavan Parent', phone: '9000000001', purpose: 'Meeting the class teacher', student_id: IDS.child, guardian_id: IDS.guardian })
    expect(r.status).toBe(201)
    const row = await E.TENANT_TEST.prepare('SELECT guardian_id, student_id FROM visitors WHERE id = ?').bind(r.body.id).first<any>()
    expect(row).toEqual({ guardian_id: IDS.guardian, student_id: IDS.child })
    expect((await api('admin', 'POST', '/office/visitors', { full_name: 'X', purpose: 'Y', guardian_id: '00000000-0000-4000-8000-00000000ffff' })).status).toBe(400)
    const plain = await api('admin', 'POST', '/office/visitors', { full_name: 'New Person', purpose: 'Delivery' })
    expect(plain.status).toBe(201)
  })
})
