/* A student gets a login by default: added while student logins are on, or
   when the school switches them on. Admission number is username and first
   password, and it must be changed at first sign-in. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E, signIn } from './fixture'

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

describe('a changed number moves the login', () => {
  it('a parent whose number the office changes signs in with the new number', async () => {
    const r = await api('admin', 'POST', '/students', { first_name: 'Move', last_name: 'Kid', admission_no: 'AUTO-MOVE-1', section_id: IDS.section,
      guardian_name: 'Asha Move', guardian_phone: '9000022222', guardian_relation: 'mother' })
    expect(r.status).toBe(201)
    const g = await E.TENANT_TEST.prepare(`SELECT id, user_id FROM guardians WHERE phone = ?`).bind('9000022222').first<{ id: string; user_id: string }>()
    expect(g?.user_id).toBeTruthy()
    // First password is the original number.
    expect((await signIn('9000022222', '9000022222')).cookie).toBeTruthy()
    const u = await api('admin', 'POST', `/students/${r.body.id}/guardians`, { id: g!.id, full_name: 'Asha Move', relation: 'mother', phone: '9000033333' })
    expect(u.status).toBe(200)
    expect((await signIn('9000033333', '9000022222')).cookie).toBeTruthy()
  })

  it('a parent with no login gets one when a number is added', async () => {
    const r = await api('admin', 'POST', '/students', { first_name: 'No', last_name: 'Num', admission_no: 'AUTO-NONUM-1', section_id: IDS.section })
    expect(r.status).toBe(201)
    const add = await api('admin', 'POST', `/students/${r.body.id}/guardians`, { full_name: 'Late Parent', relation: 'father', phone: '9000044444' })
    expect(add.status).toBe(200)
    const g = await E.TENANT_TEST.prepare(`SELECT user_id FROM guardians WHERE phone = ?`).bind('9000044444').first<{ user_id: string | null }>()
    expect(g?.user_id).toBeTruthy()
  })
})
