/* Owner, 2026-10-27: "I changed the phone number from the institution (admin)
   account. The change does not show in another institution admin, and also all
   roles." One admin saves a staff phone; a second admin and the teacher it
   belongs to both read the new number, the staff part of /portal/live moves
   (so open screens refetch), and the new number signs in. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, signIn, call, IDS, E, PASSWORD } from './fixture'
import { hashPassword } from '../../src/auth/password'

const ADMIN_B = '00000000-0000-4000-8000-000000000077'

beforeAll(async () => {
  await seed()
  const t = new Date().toISOString()
  const role = (await E.TENANT_TEST.prepare(`SELECT id FROM roles WHERE key = 'institution_admin'`).first<{ id: string }>())!.id
  const hash = await hashPassword(E.PASSWORD_PEPPER, PASSWORD)
  await E.TENANT_TEST.batch([
    E.TENANT_TEST.prepare(`INSERT OR IGNORE INTO users (id, institution_id, email, full_name, password_hash, status, must_change_password, created_at, updated_at)
      VALUES (?, ?, 'admin.b@test.school', 'Bina Admin', ?, 'active', 0, ?, ?)`).bind(ADMIN_B, IDS.school, hash, t, t),
    E.TENANT_TEST.prepare(`INSERT OR IGNORE INTO user_roles (id, institution_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), IDS.school, ADMIN_B, role, t),
    E.TENANT_TEST.prepare(`INSERT OR IGNORE INTO employees (id, institution_id, campus_id, user_id, employee_code, first_name, phone, joined_on, status, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-000000000078', ?, (SELECT id FROM campuses LIMIT 1), ?, 'PS001', 'Tara Teacher', '9111111111', date('now'), 'active', ?, ?)`)
      .bind(IDS.school, IDS.teacher, t, t),
    E.TENANT_TEST.prepare(`UPDATE users SET phone = '9111111111' WHERE id = ?`).bind(IDS.teacher),
  ])
  await E.CONTROL.prepare(`INSERT OR IGNORE INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', 'admin.b@test.school', ?, ?, ?)`)
    .bind(IDS.school, ADMIN_B, t).run()
})

let cookieB: string | null = null
async function asAdminB<T = any>(method: string, path: string): Promise<{ status: number; body: T }> {
  if (!cookieB) cookieB = (await signIn('admin.b@test.school')).cookie
  const cookie = cookieB
  const res = await call('/api/v1' + path, { method, cookie: cookie! })
  return { status: res.status, body: await res.json() as T }
}

describe('a staff phone saved by one admin', () => {
  it('reads back new for another admin and the teacher, and moves the live revision', async () => {
    const emp = '00000000-0000-4000-8000-000000000078'
    const rev0 = (await asAdminB<{ rev: string }>('GET', '/portal/live')).body.rev
    const save = await api('admin', 'PATCH', `/setup/employees/${emp}`, { phone: '9222222222', confirm_overwrite: true })
    expect(save.status).toBe(200)

    const list = await asAdminB<{ items: { id: string; user_id?: string; phone: string | null }[] }>('GET', '/hr/employees?limit=200')
    expect(list.status).toBe(200)
    expect(list.body.items.find((e) => e.id === emp)?.phone).toBe('9222222222')
    expect((await asAdminB<{ rev: string }>('GET', '/portal/live')).body.rev).not.toBe(rev0)

    const me = await api<{ phone?: string }>('teacher', 'GET', '/profile')
    expect(me.status).toBe(200)
    expect(me.body.phone).toBe('9222222222')

    const idx = await E.CONTROL.prepare(`SELECT value FROM login_index WHERE kind = 'phone' AND user_id = ?`).bind(IDS.teacher).all<{ value: string }>()
    expect(idx.results.map((r) => r.value)).toEqual(['9222222222'])
  })

  it('a self-edited phone reaches the staff record as well', async () => {
    const put = await api('teacher', 'PUT', '/profile', { full_name: 'Tara Teacher', phone: '9333333333' })
    expect(put.status).toBe(200)
    const list = await asAdminB<{ items: { id: string; user_id?: string; phone: string | null }[] }>('GET', '/hr/employees?limit=200')
    expect(list.body.items.find((e) => e.user_id === IDS.teacher || e.id === '00000000-0000-4000-8000-000000000078')?.phone).toBe('9333333333')
  })
})
