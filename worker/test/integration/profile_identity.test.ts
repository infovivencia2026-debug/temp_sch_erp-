/* GET /api/v1/profile, the "Identity and profile" card (owner, 2026-10-24):
   the school address from Staff Inbox and what the signed-in teacher
   teaches, for that user only; a parent gets neither. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { seed, api, E, IDS } from './fixture'

const T = () => E.TENANT_TEST
const SST = crypto.randomUUID()

beforeAll(async () => {
  await seed()
  await T().batch([
    T().prepare(`INSERT INTO section_subject_teachers (id, institution_id, section_id, class_subject_id, teacher_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(SST, IDS.school, IDS.section, IDS.classSubject, IDS.teacher, new Date().toISOString()),
    T().prepare(`INSERT INTO mail_addresses (id, user_id, address) VALUES (?, ?, 'teacher@school.example')`).bind(crypto.randomUUID(), IDS.teacher),
  ])
})
afterAll(async () => {
  await T().prepare(`DELETE FROM section_subject_teachers WHERE id = ?`).bind(SST).run()
  await T().prepare(`DELETE FROM mail_addresses WHERE user_id = ?`).bind(IDS.teacher).run()
})

describe('profile identity', () => {
  it('a teacher sees her school email, classes (class teacher marked) and subjects', async () => {
    const r = await api('teacher', 'GET', '/profile')
    expect(r.status).toBe(200)
    expect(r.body.school_email).toBe('teacher@school.example')
    expect(r.body.email).toBe('teacher@test.school')
    expect(r.body.teaching).toEqual({ classes: [{ name: 'Class 5 A', class_teacher: true }], subjects: ['Mathematics'] })
  })
  it('a parent gets no school email and no teaching block', async () => {
    const r = await api('parent', 'GET', '/profile')
    expect(r.status).toBe(200)
    expect(r.body.school_email).toBeUndefined()
    expect(r.body.teaching).toBeUndefined()
  })
})
