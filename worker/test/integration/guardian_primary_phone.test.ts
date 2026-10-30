/* Owner, 2026-10-28: "In Student 360, let them change the primary number."
   Editing a parent's own number moves their sign-in (the old number stops
   working) for every child they are linked to; choosing which parent is
   primary only changes who is rung first and touches no login. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, signIn, IDS, E, PASSWORD } from './fixture'
import { hashPassword } from '../../src/auth/password'

const MOTHER_USER = '00000000-0000-4000-8000-000000000091'
const MOTHER = '00000000-0000-4000-8000-000000000092'
const SIBLING = '00000000-0000-4000-8000-000000000093'

beforeAll(async () => {
  await seed()
  const t = new Date().toISOString()
  const T = E.TENANT_TEST
  const role = (await T.prepare(`SELECT id FROM roles WHERE key = 'parent'`).first<{ id: string }>())!.id
  const hash = await hashPassword(E.PASSWORD_PEPPER, PASSWORD)
  await T.batch([
    T.prepare(`UPDATE users SET phone = '9000000001' WHERE id = ?`).bind(IDS.parent),
    T.prepare(`INSERT OR IGNORE INTO users (id, institution_id, email, phone, full_name, password_hash, status, must_change_password, created_at, updated_at)
      VALUES (?, ?, 'mother@test.school', '9000000011', 'Meena Mother', ?, 'active', 0, ?, ?)`).bind(MOTHER_USER, IDS.school, hash, t, t),
    T.prepare(`INSERT OR IGNORE INTO user_roles (id, institution_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), IDS.school, MOTHER_USER, role, t),
    T.prepare(`INSERT OR IGNORE INTO guardians (id, institution_id, full_name, relation, phone, user_id) VALUES (?, ?, 'Meena Mother', 'mother', '9000000011', ?)`).bind(MOTHER, IDS.school, MOTHER_USER),
    T.prepare(`INSERT OR IGNORE INTO student_guardians (student_id, guardian_id, institution_id, is_primary) VALUES (?, ?, ?, 0)`).bind(IDS.child, MOTHER, IDS.school),
    T.prepare(`INSERT OR IGNORE INTO students (id, institution_id, campus_id, admission_no, first_name, last_name, admission_date)
      VALUES (?, ?, (SELECT id FROM campuses LIMIT 1), 'A003', 'Esha', 'Test', date('now'))`).bind(SIBLING, IDS.school),
    T.prepare(`INSERT OR IGNORE INTO student_guardians (student_id, guardian_id, institution_id, is_primary) VALUES (?, ?, ?, 1)`).bind(SIBLING, IDS.guardian, IDS.school),
  ])
  await E.CONTROL.batch([
    E.CONTROL.prepare(`INSERT OR IGNORE INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('phone', '9000000001', ?, ?, ?)`).bind(IDS.school, IDS.parent, t),
    E.CONTROL.prepare(`INSERT OR IGNORE INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('phone', '9000000011', ?, ?, ?)`).bind(IDS.school, MOTHER_USER, t),
  ])
})

const father = (phone: string) => ({ id: IDS.guardian, full_name: 'Pavan Parent', relation: 'father', phone, email: 'parent@test.school' })
const phonesOf = async (uid: string) =>
  (await E.CONTROL.prepare(`SELECT value FROM login_index WHERE kind = 'phone' AND user_id = ?`).bind(uid).all<{ value: string }>()).results.map((r) => r.value)

describe('the primary number in Student 360', () => {
  it('lists the sibling who shares the parent', async () => {
    const p = await api<{ guardians: { id: string; siblings?: string[] }[] }>('admin', 'GET', `/students/${IDS.child}/profile`)
    expect(p.status).toBe(200)
    expect(p.body.guardians.find((g) => g.id === IDS.guardian)?.siblings?.join(' ')).toContain('Esha')
  })

  it('refuses a number that is not a 10-digit mobile', async () => {
    expect((await api('admin', 'POST', `/students/${IDS.child}/guardians`, father('12345'))).status).toBe(400)
  })

  it('refuses a number another family signs in with, and names the family', async () => {
    const r = await api<{ error?: string; message?: string }>('admin', 'POST', `/students/${IDS.child}/guardians`, father('9000000002'))
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.body)).toContain('Olga Other')
    expect(await phonesOf(IDS.parent)).toEqual(['9000000001'])
  })

  it('a changed number signs in, the old one does not, siblings follow, and it is audited', async () => {
    const r = await api('admin', 'POST', `/students/${IDS.child}/guardians`, father('+91 98765 43210'))
    expect(r.status).toBe(200)
    expect(await phonesOf(IDS.parent)).toEqual(['9876543210'])
    expect((await signIn('9876543210')).cookie).toBeTruthy()
    expect((await signIn('9000000001')).cookie).toBeNull()
    const sib = await api<{ guardians: { id: string; phone: string }[] }>('admin', 'GET', `/students/${SIBLING}/profile`)
    expect(sib.body.guardians.find((g) => g.id === IDS.guardian)?.phone).toBe('9876543210')
    const a = await E.TENANT_TEST.prepare(`SELECT count(*) AS n FROM audit_log WHERE action = 'guardian.phone_changed' AND entity_id = ?`).bind(IDS.guardian).first<{ n: number }>()
    expect(a!.n).toBeGreaterThan(0)
  })

  it('switching the primary parent changes who is first and no login', async () => {
    const r = await api('admin', 'POST', `/students/${IDS.child}/guardians/${MOTHER}/primary`, {})
    expect(r.status).toBe(200)
    const rows = (await E.TENANT_TEST.prepare(`SELECT guardian_id, is_primary FROM student_guardians WHERE student_id = ?`).bind(IDS.child).all<{ guardian_id: string; is_primary: number }>()).results
    expect(rows.find((x) => x.guardian_id === MOTHER)?.is_primary).toBe(1)
    expect(rows.find((x) => x.guardian_id === IDS.guardian)?.is_primary).toBe(0)
    expect(await phonesOf(IDS.parent)).toEqual(['9876543210'])
    expect(await phonesOf(MOTHER_USER)).toEqual(['9000000011'])
    expect((await signIn('9000000011')).cookie).toBeTruthy()
    // The sibling's own primary is untouched.
    const s = await E.TENANT_TEST.prepare(`SELECT is_primary FROM student_guardians WHERE student_id = ? AND guardian_id = ?`).bind(SIBLING, IDS.guardian).first<{ is_primary: number }>()
    expect(s!.is_primary).toBe(1)
  })

  it('a role without students.write is refused both changes', async () => {
    expect((await api('parent', 'POST', `/students/${IDS.child}/guardians/${MOTHER}/primary`, {})).status).toBe(403)
    expect((await api('finance', 'POST', `/students/${IDS.child}/guardians`, father('9123456789'))).status).toBe(403)
  })
})
