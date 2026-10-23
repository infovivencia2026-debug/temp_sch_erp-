/* A plain subject teacher (the faculty defaults without comms.announcements.write
   or self.profile.write): messages colleagues but not families, sees their profile
   read-only and can still change their password, and sees a class's progress only
   through the subjects they teach in it. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, call, signIn, IDS, E, isoDay, PASSWORD } from './fixture'
import { hashPassword } from '../../src/auth/password'

const ROLE = '00000000-0000-4000-8000-000000000a01'
const ST = '00000000-0000-4000-8000-000000000a02'
const OTHER_SUBJECT = '00000000-0000-4000-8000-000000000a03'
const OTHER_CS = '00000000-0000-4000-8000-000000000a04'
const HW_MINE = '00000000-0000-4000-8000-000000000a05'
const HW_OTHER = '00000000-0000-4000-8000-000000000a06'
const EMAIL = 'subject.teacher@test.school'
const PERMS = ['status.post', 'students.read', 'academics.read', 'academics.timetable.read', 'academics.exams.read',
  'academics.marks.write', 'academics.homework.write', 'welfare.discipline.write', 'self.profile.read']

let cookie = ''
async function req(method: string, path: string, body?: unknown) {
  const res = await call('/api/v1' + path, { method, cookie,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let parsed: any = text
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: parsed }
}

beforeAll(async () => {
  await seed()
  const T = E.TENANT_TEST, t = new Date().toISOString(), today = isoDay(0)
  if (!(await T.prepare('SELECT 1 AS x FROM users WHERE id = ?').bind(ST).first())) {
    const hash = await hashPassword(E.PASSWORD_PEPPER, PASSWORD)
    await T.batch([
      T.prepare(`INSERT INTO roles (id, institution_id, key, name, is_system, is_default, created_at) VALUES (?, ?, 'test_subject_teacher', 'Subject teacher (test)', 0, 0, ?)`).bind(ROLE, IDS.school, t),
      ...PERMS.map((p) => T.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)`).bind(ROLE, p)),
      T.prepare(`INSERT INTO users (id, institution_id, email, full_name, password_hash, status, must_change_password, created_at, updated_at)
          VALUES (?, ?, ?, 'Sam Subject', ?, 'active', 0, ?, ?)`).bind(ST, IDS.school, EMAIL, hash, t, t),
      T.prepare(`INSERT INTO user_roles (id, institution_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), IDS.school, ST, ROLE, t),
      T.prepare(`INSERT INTO section_subject_teachers (id, institution_id, section_id, class_subject_id, teacher_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), IDS.school, IDS.section, IDS.classSubject, ST, t),
      T.prepare(`INSERT INTO subjects (id, institution_id, campus_id, name, code) SELECT ?, institution_id, campus_id, 'Science', 'SCI' FROM subjects WHERE id = ?`).bind(OTHER_SUBJECT, IDS.subject),
      T.prepare(`INSERT INTO class_subjects (id, institution_id, class_id, subject_id) VALUES (?, ?, ?, ?)`).bind(OTHER_CS, IDS.school, IDS.klass, OTHER_SUBJECT),
      T.prepare(`INSERT INTO homework (id, institution_id, section_id, class_subject_id, title, assigned_on, due_on, is_published) VALUES (?, ?, ?, ?, 'Fractions', ?, ?, 1)`)
        .bind(HW_MINE, IDS.school, IDS.section, IDS.classSubject, today, isoDay(2)),
      T.prepare(`INSERT INTO homework (id, institution_id, section_id, class_subject_id, title, assigned_on, due_on, is_published) VALUES (?, ?, ?, ?, 'Plants', ?, ?, 1)`)
        .bind(HW_OTHER, IDS.school, IDS.section, OTHER_CS, today, isoDay(2)),
    ])
    await E.CONTROL.prepare(`INSERT OR IGNORE INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, ?, ?, ?)`)
      .bind(EMAIL, IDS.school, ST, t).run()
  }
  const s = await signIn(EMAIL)
  if (!s.cookie) throw new Error('sign-in as the subject teacher failed: ' + s.res.status)
  cookie = s.cookie
})

describe('subject teacher limits', () => {
  it('cannot start or reply to a conversation with a parent', async () => {
    const r = await req('POST', '/portal/messages', { student_id: IDS.child, parent_user_id: IDS.parent, body: 'Hello' })
    expect(r.status).toBe(403)
    expect(JSON.stringify(r.body)).toContain('comms.announcements.write')
  })

  it('can message a colleague', async () => {
    const r = await req('POST', '/staff-messages', { to: IDS.teacher, body: 'Swap periods on Friday?' })
    expect(r.status).toBe(201)
  })

  it('sees the profile but cannot change it, and can still change the password', async () => {
    expect((await req('GET', '/profile')).status).toBe(200)
    expect((await req('PUT', '/profile', { full_name: 'Someone Else' })).status).toBe(403)
    const pw = await req('POST', '/profile/password', { current_password: 'wrong password here', new_password: 'a brand new long password' })
    expect(pw.status).toBe(403)
    expect(JSON.stringify(pw.body)).toContain('current password is incorrect')
  })

  it('sees class progress only through the subjects they teach, with or without a class picked', async () => {
    const range = `from=${isoDay(-1)}&to=${isoDay(1)}`
    for (const q of [`?${range}`, `?section_id=${IDS.section}&${range}`]) {
      const r = await req('GET', '/teaching/progress' + q)
      expect(r.status).toBe(200)
      expect(r.body.full).toBe(false)
      const row = r.body.items.find((x: any) => x.student_id === IDS.child)
      expect(row.homework_set).toBe(1)
    }
    const pending = await req('GET', `/teaching/progress/pending-homework?${range}`)
    expect(pending.status).toBe(200)
    expect(pending.body.items.map((h: any) => h.id)).toEqual([HW_MINE])
    expect((await req('GET', `/teaching/progress?section_id=${IDS.section}&class_subject_id=${OTHER_CS}&${range}`)).status).toBe(404)
  })
})
