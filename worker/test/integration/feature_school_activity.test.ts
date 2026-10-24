/* School activity: the principal's one timeline of what students, parents and
   staff do, with its filters, and nobody else reads it. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, E, IDS } from './fixture'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const yesterday = new Date(Date.now() - 86_400_000).toISOString()

beforeAll(async () => {
  await seed()
  const T = E.TENANT_TEST
  await T.batch([
    T.prepare(`INSERT INTO support_tickets (id, institution_id, raised_by, student_id, category, subject, body, priority, status, audience, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'academics', 'Homework load', 'Too much homework this week.', 'normal', 'open', 'school', ?, ?)`)
      .bind(id(960), IDS.school, IDS.parent, IDS.child, yesterday, yesterday),
    T.prepare(`INSERT INTO announcements (id, institution_id, title, body, kind, publish_at, created_by, created_at)
        VALUES (?, ?, 'Sports day', 'Sports day is on Friday.', 'general', ?, ?, ?)`).bind(id(961), IDS.school, yesterday, IDS.teacher, yesterday),
    T.prepare(`INSERT INTO student_attendance (id, institution_id, student_id, section_id, on_date, status, marked_by, marked_at)
        VALUES (?, ?, ?, ?, ?, 'absent', ?, ?), (?, ?, ?, ?, ?, 'present', ?, ?)`)
      .bind(id(962), IDS.school, IDS.child, IDS.section, yesterday.slice(0, 10), IDS.teacher, yesterday,
        id(963), IDS.school, IDS.otherChild, IDS.section, yesterday.slice(0, 10), IDS.teacher, yesterday),
  ])
})

type Ev = { id: string; type: string; title: string; detail: string; by: string; who: string }
const items = async (qs = '') => (await api('admin', 'GET', `/admin/activity${qs}`)).body.items as Ev[]

describe('school activity', () => {
  it('shows what parents, staff and sign-ins did, saying who', async () => {
    const all = await items('?limit=100')
    expect(all.find((e) => e.title === 'Concern raised: Homework load')).toMatchObject({ who: 'parent', by: 'Pavan Parent', type: 'concern' })
    expect(all.find((e) => e.title === 'Notice sent: Sports day')).toMatchObject({ who: 'staff', by: 'Tara Teacher' })
    expect(all.some((e) => e.type === 'signin')).toBe(true)
    expect(all.find((e) => e.title.startsWith('Attendance taken: Class 5 A'))?.detail).toBe('1 absent, 0 late, of 2')
  })

  it('filters by who, by kind, by day and by name', async () => {
    const parents = await items('?who=parent')
    expect(parents.length).toBeGreaterThan(0)
    expect(parents.every((e) => e.who === 'parent')).toBe(true)
    expect((await items('?types=notice')).every((e) => e.type === 'notice')).toBe(true)
    const day = yesterday.slice(0, 10)
    expect((await items(`?types=concern&from=${day}&to=${day}`)).some((e) => e.title.includes('Homework load'))).toBe(true)
    expect(await items('?types=concern&from=2001-01-01&to=2001-01-02')).toHaveLength(0)
    const pavan = await items('?q=Pavan')
    expect(pavan.length).toBeGreaterThan(0)
    expect(pavan.every((e) => e.by.includes('Pavan') || e.title.includes('Pavan'))).toBe(true)
  })

  it('refuses bad filters', async () => {
    expect((await api('admin', 'GET', '/admin/activity?who=alien')).status).toBe(400)
    expect((await api('admin', 'GET', '/admin/activity?from=yesterday')).status).toBe(400)
    expect((await api('admin', 'GET', '/admin/activity?from=2026-02-02&to=2026-01-01')).status).toBe(400)
  })

  it('is the principal’s alone: not a teacher, a parent or an accountant', async () => {
    for (const who of ['teacher', 'parent', 'finance'] as const) expect((await api(who, 'GET', '/admin/activity')).status).toBe(403)
  })
})
