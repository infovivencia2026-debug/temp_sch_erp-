/* A student gets a login by default: added while student logins are on, or
   when the school switches them on. Admission number is username and first
   password, and it must be changed at first sign-in. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

beforeAll(seed)
const T = () => E.TENANT_TEST
const userOf = (adm: string) => T().prepare(`SELECT st.user_id AS uid, u.username, u.must_change_password AS m
    FROM students st LEFT JOIN users u ON u.id = st.user_id WHERE st.admission_no = ?`).bind(adm).first<{ uid: string | null; username: string | null; m: number | null }>()

describe('student logins by default', () => {
  it('no login is made while student logins are off', async () => {
    expect((await api('admin', 'PUT', '/admin/student-logins', { enabled: false })).status).toBe(200)
    const r = await api('admin', 'POST', '/students', { first_name: 'Off', last_name: 'Kid', admission_no: 'AUTO-OFF-1', section_id: IDS.section })
    expect(r.status).toBe(201)
    expect((await userOf('AUTO-OFF-1'))?.uid).toBeNull()
  })

  it('switching on issues the missing logins at once', async () => {
    const r = await api('admin', 'PUT', '/admin/student-logins', { enabled: true })
    expect(r.status).toBe(200)
    expect(r.body.logins_issued).toBeGreaterThanOrEqual(1)
    const u = await userOf('AUTO-OFF-1')
    expect(u?.uid).toBeTruthy()
    expect(u?.m).toBe(1)
  })

  it('a student added while logins are on gets one straight away', async () => {
    const r = await api('admin', 'POST', '/students', { first_name: 'New', last_name: 'Kid', admission_no: 'AUTO-ON-1', section_id: IDS.section })
    expect(r.status).toBe(201)
    const u = await userOf('AUTO-ON-1')
    expect(u?.uid).toBeTruthy()
    expect(String(u?.username).toLowerCase()).toBe('auto-on-1')
    expect(u?.m).toBe(1)
  })
})

describe('parent logins by default', () => {
  const guardianUser = (phone: string) => E.TENANT_TEST.prepare(`SELECT g.user_id AS uid, u.username, u.must_change_password AS m
      FROM guardians g LEFT JOIN users u ON u.id = g.user_id WHERE g.phone = ?`).bind(phone).all<{ uid: string | null; username: string | null; m: number | null }>()

  it('a parent with a phone gets a login when their child is added, and a sibling joins the same account', async () => {
    const r1 = await api('admin', 'POST', '/students', { first_name: 'Sib', last_name: 'One', admission_no: 'AUTO-SIB-1', section_id: IDS.section,
      guardian_name: 'Ravi Sib', guardian_phone: '9000011111', guardian_relation: 'father' })
    expect(r1.status).toBe(201)
    const g1 = (await guardianUser('9000011111')).results
    expect(g1.length).toBe(1)
    expect(g1[0].uid).toBeTruthy()
    expect(g1[0].m).toBe(1)
    const r2 = await api('admin', 'POST', '/students', { first_name: 'Sib', last_name: 'Two', admission_no: 'AUTO-SIB-2', section_id: IDS.section,
      guardian_name: 'Ravi Sib', guardian_phone: '9000011111', guardian_relation: 'father' })
    expect(r2.status).toBe(201)
    const g2 = (await guardianUser('9000011111')).results
    expect(new Set(g2.map((x) => x.uid)).size).toBe(1)
  })
})
