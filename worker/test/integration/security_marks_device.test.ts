import { beforeAll, describe, expect, it } from 'vitest'
import { E, IDS, api, call, isoDay, seed } from './fixture'

/* Security audit, 2026-10-27: marks for children the caller does not teach,
   punches from readers nobody registered, outpass steps taken by the wrong
   person or twice, and vacancy and lesson-plan decisions taken twice. */
const T = () => E.TENANT_TEST
const SECTION_B = '00000000-0000-4000-8000-0000000000b1'
const STRANGER = '00000000-0000-4000-8000-0000000000b2'
const SN = 'SECTESTREGISTERED'

beforeAll(async () => {
  await seed()
  const campus = (await T().prepare(`SELECT id FROM campuses LIMIT 1`).first<{ id: string }>())!.id
  await T().batch([
    // Section B of the same class: nobody seeded teaches it.
    T().prepare(`INSERT INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name) VALUES (?, ?, ?, ?, ?, 'B')`)
      .bind(SECTION_B, IDS.school, campus, IDS.klass, IDS.year),
    T().prepare(`INSERT INTO students (id, institution_id, campus_id, admission_no, first_name, last_name, admission_date) VALUES (?, ?, ?, 'B001', 'Bela', 'Test', ?)`)
      .bind(STRANGER, IDS.school, campus, isoDay(-150)),
    T().prepare(`INSERT INTO enrollments (id, institution_id, student_id, academic_year_id, class_id, section_id, roll_no, enrolled_on) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
      .bind(crypto.randomUUID(), IDS.school, STRANGER, IDS.year, IDS.klass, SECTION_B, isoDay(-150)),
    T().prepare(`INSERT INTO biometric_devices (id, institution_id, serial, name, is_active, created_at) VALUES (?, ?, ?, 'Gate', 1, ?)`)
      .bind(crypto.randomUUID(), IDS.school, SN, new Date().toISOString()),
  ])
})

describe('marks', () => {
  it('a class teacher cannot write marks for a child in another section, even mixed with her own', async () => {
    const r = await api('teacher', 'POST', '/exams/marks', {
      exam_subject_id: IDS.paper, entries: [{ student_id: IDS.child, marks_obtained: 50 }, { student_id: STRANGER, marks_obtained: 99 }],
    })
    expect(r.status).toBe(403)
    const m = await T().prepare(`SELECT 1 FROM marks WHERE student_id = ?`).bind(STRANGER).first()
    expect(m).toBeNull()
  })

  it('her own section is still allowed', async () => {
    const r = await api('teacher', 'POST', '/exams/marks', { exam_subject_id: IDS.paper, entries: [{ student_id: IDS.child, marks_obtained: 50 }] })
    expect(r.status).toBe(200)
  })

  it('the admin reaches every section', async () => {
    const r = await api('admin', 'POST', '/exams/marks', { exam_subject_id: IDS.paper, entries: [{ student_id: STRANGER, marks_obtained: 60 }] })
    expect(r.status).toBe(200)
  })
})

describe('biometric push', () => {
  const body = '7\t2026-10-12 08:41:02\t0\t1\t0\t0\n'
  it('an unknown serial is refused, not stored, not registered, and written down', async () => {
    const r = await call(`/iclock/cdata?SN=FORGED123&table=ATTLOG&Stamp=1`, { method: 'POST', body })
    expect(r.status).toBe(403)
    expect(await T().prepare(`SELECT 1 FROM biometric_devices WHERE serial = 'FORGED123'`).first()).toBeNull()
    expect(await T().prepare(`SELECT count(*) AS n FROM biometric_punches`).first<{ n: number }>()).toEqual({ n: 0 })
    const log = await E.CONTROL.prepare(`SELECT outcome FROM login_events WHERE identifier = 'iclock:FORGED123'`).first<{ outcome: string }>()
    expect(log?.outcome).toBe('iclock_refused_unknown')
  })

  it('a registered reader still records punches', async () => {
    const r = await call(`/iclock/cdata?SN=${SN}&table=ATTLOG&Stamp=1`, { method: 'POST', body })
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('OK: 1')
    expect(await T().prepare(`SELECT count(*) AS n FROM biometric_punches`).first<{ n: number }>()).toEqual({ n: 1 })
  })
})

describe('hostel outpass', () => {
  let pass = ''
  beforeAll(async () => {
    const r = await api('parent', 'POST', '/ops/hostel/outpasses', {
      student_id: IDS.child, reason: 'Wedding', expected_out: `${isoDay(1)}T09:00:00Z`, expected_in: `${isoDay(2)}T18:00:00Z`,
    })
    expect(r.status).toBe(201)
    pass = r.body.id
  })

  it('another parent cannot cancel it', async () => {
    const r = await api('otherParent', 'POST', `/ops/hostel/outpasses/${pass}/decide`, { action: 'cancel' })
    expect(r.status).toBe(404)
  })

  it('the warden cannot record the guardian consent', async () => {
    const r = await api('admin', 'POST', `/ops/hostel/outpasses/${pass}/decide`, { action: 'consent' })
    expect(r.status).toBe(403)
  })

  it('the guardian consents once, the warden decides once, and the guardian is told', async () => {
    expect((await api('parent', 'POST', `/ops/hostel/outpasses/${pass}/decide`, { action: 'consent' })).status).toBe(200)
    expect((await api('parent', 'POST', `/ops/hostel/outpasses/${pass}/decide`, { action: 'consent' })).status).toBe(409)
    expect((await api('admin', 'POST', `/ops/hostel/outpasses/${pass}/decide`, { action: 'reject', note: 'Exams that week' })).status).toBe(200)
    expect((await api('admin', 'POST', `/ops/hostel/outpasses/${pass}/decide`, { action: 'approve' })).status).toBe(409)
    const n = await T().prepare(`SELECT link FROM notifications WHERE user_id = ? AND kind = 'outpass_decided'`).bind(IDS.parent).first<{ link: string }>()
    expect(n?.link).toBe('/go/consent_permissions/permission_slips')
  })
})

describe('vacancy', () => {
  it('the raiser cannot approve it, and a decided vacancy is not decided again', async () => {
    const r = await api('admin', 'POST', '/hr-growth/vacancies', { code: 'SEC-1', title: 'Physics teacher', submit: true })
    expect(r.status).toBe(201)
    const id = r.body.id
    expect((await api('admin', 'POST', `/hr-growth/vacancies/${id}/decide`, { action: 'approve' })).status).toBe(403)
    expect((await api('admin', 'POST', `/hr-growth/vacancies/${id}/decide`, { action: 'reject', note: 'No budget' })).status).toBe(200)
    expect((await api('admin', 'POST', `/hr-growth/vacancies/${id}/decide`, { action: 'reject' })).status).toBe(409)
    expect((await api('admin', 'POST', `/hr-growth/vacancies/${id}/decide`, { action: 'close' })).status).toBe(409)
  })
})

describe('lesson plan', () => {
  it('a decided plan is not decided again, and the teacher is told of the decision', async () => {
    const id = crypto.randomUUID()
    await T().prepare(`INSERT INTO lesson_plans (id, institution_id, section_id, class_subject_id, teacher_user_id, week_of, status, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?)`).bind(id, IDS.school, IDS.section, IDS.classSubject, IDS.teacher, isoDay(0), new Date().toISOString()).run()
    expect((await api('admin', 'POST', `/syllabus/lesson-plans/${id}/decide`, { decision: 'approved' })).status).toBe(200)
    expect((await api('admin', 'POST', `/syllabus/lesson-plans/${id}/decide`, { decision: 'returned', remarks: 'Redo' })).status).toBe(409)
    const n = await T().prepare(`SELECT link FROM notifications WHERE user_id = ? AND kind = 'lesson_plan_decided'`).bind(IDS.teacher).first<{ link: string }>()
    expect(n?.link).toBe('/go/teaching/lesson_plans_content')
  })
})
