import { beforeAll, expect, it } from 'vitest'
import { E, IDS, api, seed } from './fixture'

/* A break is a break (owner, 2026-11-19): an entry left on an is_break period
   (Assembly, Break, Lunch) must not show its subject or teacher on a parent's
   "Today's classes". Entries on every weekday, so today and the next school
   day both carry one. */
const T = () => E.TENANT_TEST
const BELL = '00000000-0000-4000-8000-0000000b0a00'
const LESSON = '00000000-0000-4000-8000-0000000b0a01'
const LUNCH = '00000000-0000-4000-8000-0000000b0a02'

beforeAll(async () => {
  await seed()
  const campus = (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
  await T().batch([
    T().prepare(`INSERT OR IGNORE INTO bell_schedules (id, institution_id, campus_id, name, is_default, created_at) VALUES (?, ?, ?, 'Break day', 0, '2000-01-01T00:00:00Z')`).bind(BELL, IDS.school, campus),
    T().prepare(`INSERT INTO periods (id, institution_id, campus_id, name, sequence, starts_at, ends_at, is_break, bell_schedule_id) VALUES (?, ?, ?, 'Period 1', 1, '09:00', '09:40', 0, ?)`).bind(LESSON, IDS.school, campus, BELL),
    T().prepare(`INSERT INTO periods (id, institution_id, campus_id, name, sequence, starts_at, ends_at, is_break, bell_schedule_id) VALUES (?, ?, ?, 'Lunch', 2, '12:30', '13:10', 1, ?)`).bind(LUNCH, IDS.school, campus, BELL),
    ...[1, 2, 3, 4, 5, 6, 7].flatMap((w) => [LESSON, LUNCH].map((p) => T().prepare(`INSERT INTO timetable_entries (id, institution_id, academic_year_id, section_id, period_id, weekday, class_subject_id, teacher_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), IDS.school, IDS.year, IDS.section, p, w, IDS.classSubject, IDS.teacher))),
  ])
})

it('shows a break by its own name, with no subject or teacher, once', { timeout: 120_000 }, async () => {
  const r = await api('parent', 'GET', `/portal/summary?student_id=${IDS.child}`)
  expect(r.status).toBe(200)
  type P = { period: string; subject: string; teacher?: string; is_break?: boolean }
  for (const day of [r.body.today as P[], r.body.next_day.periods as P[]]) {
    const lunch = day.filter((p) => p.period === 'Lunch')
    expect(lunch).toHaveLength(1)
    expect(lunch[0]).toMatchObject({ subject: 'Lunch', is_break: true })
    expect(lunch[0].teacher).toBeUndefined()
    const lesson = day.find((p) => p.period === 'Period 1')!
    expect(lesson.is_break).toBeUndefined()
    expect(lesson.subject).not.toBe('Period 1')
  }
})
