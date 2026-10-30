import { beforeAll, expect, it } from 'vitest'
import { E, IDS, api, seed } from './fixture'

/* The lesson plan register (owner, 2026-10-30): rows worked out from the
   timetable and the calendar; the principal reads any class, the teacher of
   a period writes its topic and moves its status forward only. */
const T = () => E.TENANT_TEST
const PERIOD = '00000000-0000-4000-8000-0000000c0a01'
let monday = '', tuesday = ''

beforeAll(async () => {
  await seed()
  const campus = (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
  const y = (await T().prepare('SELECT starts_on FROM academic_years WHERE id = ?').bind(IDS.year).first<{ starts_on: string }>())!
  const d = new Date(y.starts_on.slice(0, 10) + 'T00:00:00Z')
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1)
  monday = d.toISOString().slice(0, 10)
  d.setUTCDate(d.getUTCDate() + 1)
  tuesday = d.toISOString().slice(0, 10)
  const bell = '00000000-0000-4000-8000-0000000c0a00'
  await T().batch([
    T().prepare(`INSERT OR IGNORE INTO bell_schedules (id, institution_id, campus_id, name, is_default, created_at) VALUES (?, ?, ?, 'Register day', 0, '2000-01-01T00:00:00Z')`).bind(bell, IDS.school, campus),
    T().prepare(`INSERT INTO periods (id, institution_id, campus_id, name, sequence, starts_at, ends_at, is_break, bell_schedule_id) VALUES (?, ?, ?, 'Period 1', 1, '09:00', '09:40', 0, ?)`)
      .bind(PERIOD, IDS.school, campus, bell),
    ...[1, 2].map((w) => T().prepare(`INSERT INTO timetable_entries (id, institution_id, academic_year_id, section_id, period_id, weekday, class_subject_id, teacher_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), IDS.school, IDS.year, IDS.section, PERIOD, w, IDS.classSubject, IDS.teacher)),
    T().prepare(`INSERT INTO holidays (id, institution_id, name, on_date, kind, applies_to) VALUES (?, ?, 'Festival', ?, 'holiday', 'all')`).bind(crypto.randomUUID(), IDS.school, tuesday),
  ])
})

const q = `/academics/lesson-register?section_id=${IDS.section}&class_subject_id=${IDS.classSubject}`

it('lists each timetabled date with its day type, for the principal and the teacher', async () => {
  const r = await api('admin', 'GET', q)
  expect(r.status).toBe(200)
  const first = r.body.items.filter((x: { date: string }) => x.date === monday || x.date === tuesday)
  expect(first.map((x: { date: string; day_type: string; mine: boolean }) => `${x.date}:${x.day_type}:${x.mine}`)).toEqual([`${monday}:working:false`, `${tuesday}:holiday:false`])
  const opts = await api('teacher', 'GET', '/academics/lesson-register/options')
  expect(opts.body.sees_all).toBe(false)
  expect(opts.body.sections.map((s: { id: string }) => s.id)).toEqual([IDS.section])
  const mine = await api('teacher', 'GET', q)
  expect(mine.body.items.find((x: { date: string }) => x.date === monday).mine).toBe(true)
})

it('lets the teacher write the topic and move the status forward, never back', async () => {
  const at = { section_id: IDS.section, class_subject_id: IDS.classSubject, period_id: PERIOD, on_date: monday }
  expect((await api('teacher', 'PUT', '/academics/lesson-register', { ...at, topic: 'Fractions', status: 'ongoing' })).body).toEqual({ topic: 'Fractions', status: 'ongoing' })
  expect((await api('teacher', 'PUT', '/academics/lesson-register', { ...at, status: 'not_completed' })).status).toBe(409)
  expect((await api('teacher', 'PUT', '/academics/lesson-register', { ...at, status: 'completed' })).body.status).toBe('completed')
  expect((await api('teacher', 'PUT', '/academics/lesson-register', { ...at, status: 'ongoing' })).status).toBe(409)
  const row = (await api('admin', 'GET', q)).body.items.find((x: { date: string }) => x.date === monday)
  expect(row).toMatchObject({ topic: 'Fractions', status: 'completed' })
})

it('refuses the principal writing, a holiday, and a period not in the timetable', async () => {
  const at = { section_id: IDS.section, class_subject_id: IDS.classSubject, period_id: PERIOD }
  expect((await api('admin', 'PUT', '/academics/lesson-register', { ...at, on_date: monday, topic: 'x' })).status).toBe(403)
  expect((await api('teacher', 'PUT', '/academics/lesson-register', { ...at, on_date: tuesday, topic: 'x' })).status).toBe(400)
  const d = new Date(monday + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 2)
  expect((await api('teacher', 'PUT', '/academics/lesson-register', { ...at, on_date: d.toISOString().slice(0, 10), topic: 'x' })).status).toBe(404)
  expect((await api('parent', 'GET', '/academics/lesson-register/options')).body.sections ?? []).toEqual([])
})
