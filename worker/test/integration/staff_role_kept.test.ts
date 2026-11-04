/* A role picked when adding a staff member is kept until their login is
   issued (owner, 2026-11-04: "after adding the role again it showed none in
   login and access, again I need to issue and give role again"). */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api } from './fixture'

beforeAll(seed)

describe('staff role picked before the login exists', () => {
  it('shows the role once the login is issued, without giving it again', async () => {
    const add = await api('admin', 'POST', '/setup/employees', {
      employee_code: 'RK001', first_name: 'Ravi', last_name: 'Kiran', phone: '9876500011', role_key: 'faculty', create_login: false,
    })
    expect(add.status, JSON.stringify(add.body)).toBe(201)
    const issue = await api('admin', 'POST', '/setup/logins/bulk', { kind: 'staff' })
    expect(issue.status, JSON.stringify(issue.body)).toBe(200)
    const users = await api('admin', 'GET', '/admin/users?q=Ravi')
    const ravi = (users.body.items ?? []).find((u: { full_name: string }) => u.full_name === 'Ravi Kiran')
    expect(ravi, JSON.stringify(users.body)).toBeTruthy()
    expect(JSON.stringify(ravi.roles)).toContain('Faculty')
  })
})
