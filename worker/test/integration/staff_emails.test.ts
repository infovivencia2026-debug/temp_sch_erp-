/* Staff 360 shows a personal and a school email (owner, 2026-10-27).
   employees.email is the personal one (logins use it); school_email is new. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api } from './fixture'

beforeAll(seed)

describe('staff personal and school email', () => {
  let id = ''

  it('saves both on create and reads them back', async () => {
    const r = await api('admin', 'POST', '/setup/employees', {
      employee_code: 'SE001', first_name: 'Meena', last_name: 'Rao', email: 'meena.rao@gmail.com', school_email: 'meena@school.in',
    })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    id = r.body.id
    const d = await api('admin', 'GET', `/hr/employees/${id}/detail`)
    expect(d.body.email).toBe('meena.rao@gmail.com')
    expect(d.body.school_email).toBe('meena@school.in')
  })

  it('changes the school email without touching the personal one, and clears it', async () => {
    expect((await api('admin', 'PATCH', `/setup/employees/${id}`, { school_email: 'm.rao@school.in' })).status).toBe(200)
    let d = await api('admin', 'GET', `/hr/employees/${id}/detail`)
    expect(d.body.school_email).toBe('m.rao@school.in')
    expect(d.body.email).toBe('meena.rao@gmail.com')
    expect((await api('admin', 'PATCH', `/setup/employees/${id}`, { school_email: '' })).status).toBe(200)
    d = await api('admin', 'GET', `/hr/employees/${id}/detail`)
    expect(d.body.school_email ?? null).toBeNull()
  })

  it('refuses an invalid email on create and on edit', async () => {
    const bad = await api('admin', 'PATCH', `/setup/employees/${id}`, { school_email: 'not-an-email' })
    expect(bad.status).toBe(400)
    const bad2 = await api('admin', 'PATCH', `/setup/employees/${id}`, { email: 'meena at gmail' })
    expect(bad2.status).toBe(400)
    const bad3 = await api('admin', 'POST', '/setup/employees', { employee_code: 'SE002', first_name: 'X', school_email: 'x@y' })
    expect(bad3.status).toBe(400)
    const d = await api('admin', 'GET', `/hr/employees/${id}/detail`)
    expect(d.body.email).toBe('meena.rao@gmail.com')
  })

  it('lists the school email in the staff export', async () => {
    expect((await api('admin', 'PATCH', `/setup/employees/${id}`, { school_email: 'meena@school.in' })).status).toBe(200)
    const r = await api('admin', 'GET', '/hr/staff/export?status=all')
    expect(r.status).toBe(200)
    const row = r.body.items.find((x: { id: string }) => x.id === id)
    expect(row.school_email).toBe('meena@school.in')
    expect(row.email).toBe('meena.rao@gmail.com')
  })
})
