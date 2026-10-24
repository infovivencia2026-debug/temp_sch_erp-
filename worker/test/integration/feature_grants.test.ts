/* A feature given to someone reaches their feature list: granted directly
   on the person, or through a custom role the school built. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

/* The feature list is empty while a school is still in setup, so finish
   setup here: a profile and one member of staff. */
beforeAll(async () => {
  await seed()
  const T = E.TENANT_TEST
  const campus = await T.prepare(`SELECT id FROM campuses LIMIT 1`).first<{ id: string }>()
  await T.prepare(`UPDATE institutions SET district = 'Hyderabad', state = 'Telangana', affiliation_board = 'CBSE' WHERE id = ?`).bind(IDS.school).run()
  await T.prepare(`INSERT OR IGNORE INTO employees (id, institution_id, campus_id, employee_code, first_name, status) VALUES (?, ?, ?, 'E-1', 'Tara', 'active')`)
    .bind('00000000-0000-4000-8000-0000000000e1', IDS.school, campus!.id).run()
})

const FEATURE = 'institution_admin.students.class_promotion'
const keysOf = (body: any): string[] =>
  (body.roles ?? []).flatMap((r: any) => r.sections.flatMap((s: any) => s.features.map((f: any) => f.key)))

describe('feature grants', () => {
  it('a teacher does not see the feature before it is granted', async () => {
    const { status, body } = await api('teacher', 'GET', '/catalog')
    expect(status).toBe(200)
    expect(keysOf(body)).not.toContain(FEATURE)
  })

  it('a direct grant shows up in their feature list at their own school', async () => {
    const g = await api('admin', 'PUT', `/admin/users/${IDS.teacher}/permissions`, { permission_keys: [FEATURE] })
    expect(g.status).toBe(200)
    const { body } = await api('teacher', 'GET', '/catalog')
    expect(keysOf(body)).toContain(FEATURE)
    await api('admin', 'PUT', `/admin/users/${IDS.teacher}/permissions`, { permission_keys: [] })
    const after = await api('teacher', 'GET', '/catalog')
    expect(keysOf(after.body)).not.toContain(FEATURE)
  })

  it('a custom role carrying the feature shows it too', async () => {
    const made = await api('admin', 'POST', '/admin/roles', { name: 'Promotions desk' })
    expect(made.status).toBe(201)
    await E.TENANT_TEST.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)`).bind(made.body.id, FEATURE).run()
    await E.TENANT_TEST.prepare(`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`).bind(IDS.teacher, made.body.id).run()
    const { body } = await api('teacher', 'GET', '/catalog')
    expect(keysOf(body)).toContain(FEATURE)
    await E.TENANT_TEST.prepare(`DELETE FROM user_roles WHERE user_id = ? AND role_id = ?`).bind(IDS.teacher, made.body.id).run()
  })
})

/* One item per catalogue key, each naming its workspace: the same name in two
   workspaces is two screens, granted and held separately. */
describe('GET /admin/features', () => {
  it('lists every key once, with its role and section', async () => {
    const { status, body } = await api('admin', 'GET', '/admin/features')
    expect(status).toBe(200)
    const items = body.items as { key: string; name: string; role_key: string; role_name: string; section: string }[]
    expect(items.length).toBeGreaterThan(0)
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length)
    for (const i of items) {
      expect(i.key.startsWith(i.role_key + '.')).toBe(true)
      expect(i.role_name).not.toBe('')
      expect(i.section).not.toBe('')
      expect(i).not.toHaveProperty('keys')
    }
    const take = items.filter((i) => i.name === 'Take attendance')
    expect(new Set(take.map((i) => i.role_key)).size).toBe(take.length)
    expect(take.length).toBeGreaterThan(1)
  })

  it('a teacher cannot read it', async () => {
    const { status } = await api('teacher', 'GET', '/admin/features')
    expect(status).toBe(403)
  })
})
