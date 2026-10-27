/* Substitution approval (owner, 2026-10-27): only the principal approves a
   pick; the principal is told when one waits; approving tells both teachers
   with a View that opens their day; rejecting tells whoever picked and frees
   the period; a teacher's own request tells them the decision. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, E, IDS } from './fixture'

const T = () => E.TENANT_TEST
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ABSENT = id(701), SUB = id(702), SUB2 = id(703), DESK = id(704)
const ENTRY = id(705), PERIOD = id(706), BELL = id(707)

/** The next date (from tomorrow) that falls on a Monday, so the entry (weekday 1) is on it. */
function nextMonday(): string {
  const d = new Date(Date.now() + 86_400_000)
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
const ON = nextMonday()
const notes = (user: string) => T().prepare(`SELECT title, link, kind FROM notifications WHERE user_id = ? ORDER BY created_at`).bind(user)
  .all<{ title: string; link: string; kind: string }>().then((r) => r.results)

beforeAll(async () => {
  await seed()
  const t = new Date().toISOString()
  const campus = (await T().prepare('SELECT campus_id FROM sections WHERE id = ?').bind(IDS.section).first<{ campus_id: string }>())!.campus_id
  const user = (uid: string, email: string, name: string) => T().prepare(`INSERT OR IGNORE INTO users (id, institution_id, email, full_name, password_hash, status, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'x', 'active', 0, ?, ?)`).bind(uid, IDS.school, email, name, t, t)
  await T().batch([
    user(ABSENT, 'absent@test.school', 'Asha Away'), user(SUB, 'sub@test.school', 'Sunil Sub'), user(SUB2, 'sub2@test.school', 'Sara Second'),
    // A timetable desk: may propose (timetable.write) but is not the principal. Held by the seeded teacher.
    T().prepare(`INSERT OR IGNORE INTO roles (id, institution_id, key, name, is_system, created_at) VALUES (?, ?, 'timetable_desk', 'Timetable desk', 0, ?)`).bind(DESK, IDS.school, t),
    T().prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, 'academics.timetable.read'), (?, 'academics.timetable.write')`).bind(DESK, DESK),
    T().prepare(`INSERT OR IGNORE INTO user_roles (id, institution_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?, ?)`).bind(DESK + '-r', IDS.school, IDS.teacher, DESK, t),
    T().prepare(`INSERT OR IGNORE INTO bell_schedules (id, institution_id, campus_id, name, is_default) VALUES (?, ?, ?, 'Sub test bells', 0)`).bind(BELL, IDS.school, campus),
    T().prepare(`INSERT OR IGNORE INTO periods (id, institution_id, campus_id, name, sequence, starts_at, ends_at, is_break, bell_schedule_id) VALUES (?, ?, ?, 'P7', 7, '13:00', '13:40', 0, ?)`)
      .bind(PERIOD, IDS.school, campus, BELL),
    T().prepare(`INSERT OR IGNORE INTO timetable_entries (id, institution_id, academic_year_id, section_id, period_id, weekday, class_subject_id, teacher_user_id) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .bind(ENTRY, IDS.school, IDS.year, IDS.section, PERIOD, IDS.classSubject, ABSENT),
  ])
})

const pick = (sub: string) => api('teacher', 'POST', '/timetable-cover/propose', { timetable_entry_id: ENTRY, on_date: ON, substitute_user_id: sub })
const slot = { timetable_entry_id: ENTRY, on_date: ON }

describe('substitution approval', () => {
  it('a pick waits and the principal is told, with a View to the board on that date', async () => {
    const r = await pick(SUB)
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('waiting')
    const n = (await notes(IDS.admin)).filter((x) => x.kind === 'substitution_approval')
    expect(n.length).toBeGreaterThan(0)
    expect(n.at(-1)!.link).toBe(`/go/academics/substitutions?date=${ON}`)
  })

  it('a non-principal gets 403 on approve and on reject', async () => {
    expect((await api('teacher', 'POST', '/timetable-cover/approve', slot)).status).toBe(403)
    expect((await api('teacher', 'POST', '/timetable-cover/reject', slot)).status).toBe(403)
  })

  it('reject tells the proposer, writes nothing, and frees the period', async () => {
    const r = await api('admin', 'POST', '/timetable-cover/reject', { ...slot, note: 'Sunil has a lab' })
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('rejected')
    const sb = await T().prepare(`SELECT count(*) AS n FROM substitutions WHERE timetable_entry_id = ? AND on_date = ?`).bind(ENTRY, ON).first<{ n: number }>()
    expect(sb!.n).toBe(0)
    const told = (await notes(IDS.teacher)).filter((x) => x.title.startsWith('Substitution not approved'))
    expect(told.length).toBe(1)
    expect(told[0].link).toBe(`/go/academics/substitutions?date=${ON}`)
    const line = await T().prepare(`SELECT status FROM substitution_request_periods WHERE timetable_entry_id = ? AND on_date = ?`).bind(ENTRY, ON).first<{ status: string }>()
    expect(line!.status).toBe('rejected')
    expect((await api('admin', 'POST', '/timetable-cover/reject', slot)).status).toBe(409)
    // Free again: another teacher can be picked.
    expect((await pick(SUB2)).status).toBe(200)
  })

  it('approve writes the substitution and tells both teachers with links to their day', async () => {
    const r = await api('admin', 'POST', '/timetable-cover/approve', slot)
    expect(r.status).toBe(200)
    const sb = await T().prepare(`SELECT substitute_user_id FROM substitutions WHERE timetable_entry_id = ? AND on_date = ?`).bind(ENTRY, ON).first<{ substitute_user_id: string }>()
    expect(sb?.substitute_user_id).toBe(SUB2)
    const sub = (await notes(SUB2)).filter((x) => x.kind === 'substitution')
    const away = (await notes(ABSENT)).filter((x) => x.kind === 'substitution')
    expect(sub.length).toBe(1)
    expect(away.length).toBe(1)
    // ON is a future date, so both open the timetable (today would open Today's classes).
    expect(sub[0].link).toBe('/go/timetable/my_timetable')
    expect(away[0].link).toBe('/go/timetable/my_timetable')
    expect(sub[0].link).not.toBe('/')
  })

  it('a second approval is refused', async () => {
    expect((await api('admin', 'POST', '/timetable-cover/approve', slot)).status).toBe(409)
  })

  it('a teacher request notifies the principal; the decision notifies the teacher', async () => {
    const campus = (await T().prepare('SELECT campus_id FROM sections WHERE id = ?').bind(IDS.section).first<{ campus_id: string }>())!.campus_id
    await T().prepare(`INSERT OR IGNORE INTO periods (id, institution_id, campus_id, name, sequence, starts_at, ends_at, is_break, bell_schedule_id) VALUES (?, ?, ?, 'P8', 8, '13:45', '14:25', 0, ?)`)
      .bind(id(709), IDS.school, campus, BELL).run()
    // The seeded teacher asks for cover of nothing timetabled: give them a Monday period first.
    await T().prepare(`INSERT OR IGNORE INTO timetable_entries (id, institution_id, academic_year_id, section_id, period_id, weekday, class_subject_id, teacher_user_id)
        SELECT ?, institution_id, academic_year_id, section_id, ?, 1, class_subject_id, ? FROM timetable_entries WHERE id = ?`)
      .bind(id(708), id(709), IDS.teacher, ENTRY).run()
    const made = await api('teacher', 'POST', '/timetable-cover/requests', { reason: 'Exam duty', from_date: ON, to_date: ON })
    expect(made.status).toBe(201)
    expect(made.body.periods).toBe(1)
    const asked = (await notes(IDS.admin)).filter((x) => x.title.startsWith('Substitution request'))
    expect(asked.at(-1)!.link).toBe(`/go/academics/substitutions?date=${ON}`)
    const d = await api('admin', 'POST', `/timetable-cover/requests/${made.body.id}/decide`, { decision: 'reject', note: 'Not this week' })
    expect(d.status).toBe(200)
    const told = (await notes(IDS.teacher)).filter((x) => x.title === 'Your substitution request was rejected')
    expect(told.length).toBe(1)
    expect(told[0].link).toBe('/go/timetable/substitution_request_submission')
  })
})
