/* The 360 timelines (routes/timeline.ts): one union per subject, newest
   first, filtered by type, paged by cursor, and read through the same scope
   as the record it sits on. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E, isoDay } from './fixture'

const T = () => E.TENANT_TEST
const EMP_TEACHER = '00000000-0000-4000-8000-000000000401'

type Ev = { id: string; type: string; at: string; title: string; detail: string; by: string; link: string | null }

beforeAll(async () => {
  await seed()
  const campus = (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
  await T().batch([
    T().prepare(`INSERT OR IGNORE INTO employees (id, institution_id, campus_id, employee_code, first_name, last_name, user_id) VALUES (?, ?, ?, 'TL01', 'Tara', 'Teacher', ?)`)
      .bind(EMP_TEACHER, IDS.school, campus, IDS.teacher),
    T().prepare(`INSERT INTO student_remarks (institution_id, student_id, kind, body, recorded_by, created_at) VALUES (?, ?, 'academic', 'Reads well aloud', ?, '2026-01-10T09:00:00.000Z')`)
      .bind(IDS.school, IDS.child, IDS.teacher),
    T().prepare(`INSERT INTO discipline_records (institution_id, student_id, category, description, recorded_by, created_at) VALUES (?, ?, 'Punctuality', 'Late to assembly', ?, '2026-01-11T09:00:00.000Z')`)
      .bind(IDS.school, IDS.child, IDS.teacher),
    T().prepare(`INSERT INTO payments (institution_id, campus_id, student_id, receipt_no, amount_paise, mode, status, created_at) VALUES (?, ?, ?, 'R-1', 250000, 'cash', 'success', '2026-01-12T09:00:00.000Z')`)
      .bind(IDS.school, campus, IDS.child),
    T().prepare(`INSERT INTO student_attendance (institution_id, student_id, section_id, on_date, status, marked_by) VALUES (?, ?, ?, ?, 'absent', ?)`)
      .bind(IDS.school, IDS.child, IDS.section, isoDay(-3), IDS.teacher),
    // Another child's remark must never appear on this child's timeline.
    T().prepare(`INSERT INTO student_remarks (institution_id, student_id, kind, body, recorded_by) VALUES (?, ?, 'academic', 'Not this child', ?)`)
      .bind(IDS.school, IDS.otherChild, IDS.teacher),
    T().prepare(`INSERT INTO leave_requests (institution_id, subject_kind, employee_id, from_date, to_date, days, reason, status, applied_by, decided_by, decided_at, created_at)
        VALUES (?, 'staff', ?, '2026-02-02', '2026-02-03', '2', 'Family wedding', 'approved', ?, ?, '2026-01-21T10:00:00.000Z', '2026-01-20T10:00:00.000Z')`)
      .bind(IDS.school, EMP_TEACHER, IDS.teacher, IDS.admin),
    T().prepare(`INSERT INTO staff_tasks (id, institution_id, title, assigned_to, assigned_by, created_at) VALUES (?, ?, 'Collect consent slips', ?, ?, '2026-01-22T10:00:00.000Z')`)
      .bind(crypto.randomUUID(), IDS.school, EMP_TEACHER, IDS.admin),
  ])
})

describe('student timeline', () => {
  it('unions the sources, newest first, and keeps other children out', async () => {
    const r = await api<{ items: Ev[]; next: string | null; types: string[] }>('admin', 'GET', `/students/${IDS.child}/timeline`)
    expect(r.status).toBe(200)
    const types = r.body.items.map((e) => e.type)
    expect(types).toEqual(expect.arrayContaining(['remark', 'behaviour', 'fee', 'attendance']))
    const ats = r.body.items.map((e) => e.at)
    expect([...ats].sort().reverse()).toEqual(ats)
    expect(r.body.items.some((e) => e.detail === 'Not this child')).toBe(false)
    const fee = r.body.items.find((e) => e.type === 'fee')!
    expect(fee.title).toContain('2,500')
    expect(fee.link).toBe('/go/fee_receipts')
    expect(r.body.types).toContain('concern')
  })

  it('filters by type', async () => {
    const r = await api<{ items: Ev[] }>('admin', 'GET', `/students/${IDS.child}/timeline?types=remark`)
    expect(r.status).toBe(200)
    expect(r.body.items.length).toBeGreaterThan(0)
    expect(r.body.items.every((e) => e.type === 'remark')).toBe(true)
  })

  it('pages with a cursor without repeating an event', async () => {
    const one = await api<{ items: Ev[]; next: string | null }>('admin', 'GET', `/students/${IDS.child}/timeline?limit=2`)
    expect(one.body.items).toHaveLength(2)
    expect(one.body.next).toBeTruthy()
    const two = await api<{ items: Ev[] }>('admin', 'GET', `/students/${IDS.child}/timeline?limit=2&cursor=${encodeURIComponent(one.body.next!)}`)
    expect(two.status).toBe(200)
    const firstIds = new Set(one.body.items.map((e) => e.id))
    expect(two.body.items.some((e) => firstIds.has(e.id))).toBe(false)
    expect(two.body.items[0].at <= one.body.items[1].at).toBe(true)
  })

  it('opens for the class teacher of the section', async () => {
    expect((await api('teacher', 'GET', `/students/${IDS.child}/timeline`)).status).toBe(200)
  })

  it('refuses a parent, who does not hold the student record', async () => {
    expect((await api('parent', 'GET', `/students/${IDS.child}/timeline`)).status).toBe(403)
  })

  it('refuses a malformed id and a cursor it did not hand out', async () => {
    expect((await api('admin', 'GET', '/students/not-a-uuid/timeline')).status).toBe(400)
    expect((await api('admin', 'GET', `/students/${IDS.child}/timeline?cursor=nonsense`)).status).toBe(400)
  })
})

describe('staff timeline', () => {
  it('shows leave asked and decided, and tasks, to the principal', async () => {
    const r = await api<{ items: Ev[]; types: string[] }>('admin', 'GET', `/hr/employees/${EMP_TEACHER}/timeline`)
    expect(r.status).toBe(200)
    const titles = r.body.items.map((e) => e.title)
    expect(titles.some((t) => t.startsWith('Leave asked'))).toBe(true)
    expect(titles.some((t) => t.startsWith('Leave approved'))).toBe(true)
    expect(titles).toContain('Task given: Collect consent slips')
    expect(r.body.types).toEqual(expect.arrayContaining(['leave', 'task', 'role']))
  })

  it('refuses a teacher, who does not hold the staff file', async () => {
    expect((await api('teacher', 'GET', `/hr/employees/${EMP_TEACHER}/timeline`)).status).toBe(403)
  })

  it('answers 404 for somebody who is not on the staff roll', async () => {
    expect((await api('admin', 'GET', `/hr/employees/${IDS.child}/timeline`)).status).toBe(404)
  })
})

describe('staff summary', () => {
  it('returns the register, leave, timetable and tasks to the principal', async () => {
    const r = await api<{ leave: { requests: unknown[] }; tasks: unknown[]; timetable: { entries: unknown[] }; pay: unknown[] | null }>(
      'admin', 'GET', `/hr/employees/${EMP_TEACHER}/summary`)
    expect(r.status).toBe(200)
    expect(r.body.leave.requests).toHaveLength(1)
    expect(r.body.tasks).toHaveLength(1)
    expect(Array.isArray(r.body.timetable.entries)).toBe(true)
    expect(r.body.pay).not.toBeNull()
  })

  it('refuses a teacher', async () => {
    expect((await api('teacher', 'GET', `/hr/employees/${EMP_TEACHER}/summary`)).status).toBe(403)
  })
})
