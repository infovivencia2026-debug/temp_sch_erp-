/* Known issues link matching requests, give the workaround and a banner; reports and CSV. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, signIn, IDS, E, PASSWORD } from './fixture'
import { hashPassword } from '../../src/auth/password'

const AGENT = { id: '00000000-0000-4000-8000-0000000000b4', email: 'inc@vendor.test' }
let agent = ''
const as = async (method: string, path: string, body?: unknown) => {
  const res = await call('/api/v1' + path, { method, cookie: agent, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text(); let b: any = text; try { b = JSON.parse(text) } catch { /* text */ }
  return { status: res.status, body: b, res }
}
beforeAll(async () => {
  await seed()
  const C = E.CONTROL
  if (!(await C.prepare('SELECT 1 FROM platform_users WHERE id = ?').bind(AGENT.id).first())) {
    const t = new Date().toISOString(), hash = await hashPassword(E.PASSWORD_PEPPER, PASSWORD)
    await C.batch([
      C.prepare(`INSERT INTO platform_users (id, email, full_name, password_hash, status, created_at, updated_at) VALUES (?, ?, 'Indu Incident', ?, 'active', ?, ?)`).bind(AGENT.id, AGENT.email, hash, t, t),
      C.prepare(`INSERT INTO platform_user_roles (user_id, role_key, created_at) VALUES (?, 'support_admin', ?)`).bind(AGENT.id, t),
      C.prepare(`INSERT INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, NULL, ?, ?)`).bind(AGENT.email, AGENT.id, t),
    ])
  }
  agent = (await signIn(AGENT.email)).cookie!
})

describe('known issues', () => {
  let incId = ''
  it('links open matching requests, writes the workaround, and puts up a banner', async () => {
    const before = (await api('parent', 'POST', '/help/requests', { category: 'other', body: 'The timetable will not load.', route: '/parent/timetable/week' })).body.id
    expect((await as('POST', '/admin/platform/incidents', { title: 'x' })).status).toBe(400)
    expect((await as('POST', '/admin/platform/incidents', { title: 'Timetable', workaround: 'Use the PDF.' })).status).toBe(400)
    const inc = await as('POST', '/admin/platform/incidents', { title: 'Timetable does not load', workaround: 'Open the printed timetable under Notices until Monday.', routes: ['/parent/timetable'], banner: true })
    expect(inc.status).toBe(201)
    expect(inc.body.linked).toBeGreaterThanOrEqual(1)
    incId = inc.body.id
    const p = await api('parent', 'GET', `/help/requests/${before}`)
    expect(p.body.incident).toMatchObject({ title: 'Timetable does not load' })
    expect(p.body.thread.some((e: any) => e.kind === 'known_issue')).toBe(true)
    const b = await E.CONTROL.prepare(`SELECT title FROM platform_broadcasts WHERE id = ?`).bind(inc.body.broadcast_id).first<any>()
    expect(b.title).toBe('Timetable does not load')
    // A new matching request gets it as it arrives.
    const after = await api('otherParent', 'POST', '/help/requests', { category: 'screen', body: 'Blank timetable.', route: '/parent/timetable/week' })
    expect(after.body.incident).toMatchObject({ workaround: 'Open the printed timetable under Notices until Monday.' })
    expect((await api('admin', 'POST', '/admin/platform/incidents', { title: 'a', workaround: 'b', routes: ['/x'] })).status).toBe(403)
  })
  it('resolving retires the banner and stops new links', async () => {
    expect((await as('POST', `/admin/platform/incidents/${incId}/resolve`)).status).toBe(200)
    expect((await as('POST', `/admin/platform/incidents/${incId}/resolve`)).status).toBe(404)
    const r = await api('parent', 'POST', '/help/requests', { category: 'screen', body: 'Timetable again.', route: '/parent/timetable/week' })
    expect(r.body.incident).toBeUndefined()
  })
})

describe('reports', () => {
  it('counts per school, deflection and satisfaction; CSV; desk only', async () => {
    const r = await as('GET', '/admin/platform/help-reports?days=30')
    expect(r.status).toBe(200)
    expect(r.body.schools.find((s: any) => s.institution_id === IDS.school).requests).toBeGreaterThan(0)
    expect(r.body.top_categories.length).toBeGreaterThan(0)
    const csv = await as('GET', '/admin/platform/help-reports?days=30&format=csv')
    expect(csv.res.headers.get('content-type')).toContain('text/csv')
    expect(csv.body).toContain('Test Public School')
    expect((await api('admin', 'GET', '/admin/platform/help-reports')).status).toBe(403)
  })
})
