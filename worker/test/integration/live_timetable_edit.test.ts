/* Owner, 2026-10-28: "In Master timetable I should be able to edit the one I
   uploaded ... class-wise with a filter, and staff-wise too." One cell of the
   live timetable is set, changed and cleared; clashes and a missing grant are
   refused with the class and subject named. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

const T = () => E.TENANT_TEST
const n = (k: number) => `7e1e0000-0000-4000-8000-${String(k).padStart(12, '0')}`
const BELL = n(1), P1 = n(2), BRK = n(3), SEC_B = n(4), SUB2 = n(5), CS2 = n(6)

beforeAll(async () => {
  await seed()
  const campus = (await T().prepare('SELECT campus_id FROM sections WHERE id = ?').bind(IDS.section).first<{ campus_id: string }>())!.campus_id
  await T().batch([
    T().prepare(`INSERT OR IGNORE INTO bell_schedules (id, institution_id, campus_id, name, is_default) VALUES (?, ?, ?, 'Edit day', 0)`).bind(BELL, IDS.school, campus),
    T().prepare(`INSERT OR IGNORE INTO periods (id, institution_id, campus_id, bell_schedule_id, name, sequence, starts_at, ends_at, is_break) VALUES (?, ?, ?, ?, 'Period 1', 1, '08:00:00', '08:45:00', 0)`).bind(P1, IDS.school, campus, BELL),
    T().prepare(`INSERT OR IGNORE INTO periods (id, institution_id, campus_id, bell_schedule_id, name, sequence, starts_at, ends_at, is_break) VALUES (?, ?, ?, ?, 'Recess', 2, '08:45:00', '09:00:00', 1)`).bind(BRK, IDS.school, campus, BELL),
    T().prepare(`INSERT OR IGNORE INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name) VALUES (?, ?, ?, ?, ?, 'B')`).bind(SEC_B, IDS.school, campus, IDS.klass, IDS.year),
    T().prepare(`UPDATE sections SET bell_schedule_id = ? WHERE id IN (?, ?)`).bind(BELL, IDS.section, SEC_B),
    T().prepare(`INSERT OR IGNORE INTO subjects (id, institution_id, campus_id, name, code) VALUES (?, ?, ?, 'Science', 'SCI')`).bind(SUB2, IDS.school, campus),
    T().prepare(`INSERT OR IGNORE INTO class_subjects (id, institution_id, class_id, subject_id) VALUES (?, ?, ?, ?)`).bind(CS2, IDS.school, IDS.klass, SUB2),
  ])
})

const cell = (over: Record<string, unknown> = {}) => ({ section_id: IDS.section, period_name: 'Period 1', weekday: 1, subject_code: 'MATH', teacher_user_id: IDS.teacher, room: '12', ...over })
const put = (who: 'admin' | 'teacher', body: unknown) => api(who, 'PUT', '/timetable/entries/cell', body)

describe('live timetable: edit one cell', () => {
  let entry = ''

  it('sets a cell and reads it back by class and by teacher', async () => {
    const r = await put('admin', cell())
    expect(r.status).toBe(200)
    entry = r.body.id
    const byClass = await api('admin', 'GET', `/timetable/entries?section_id=${IDS.section}`)
    expect(byClass.body.items.find((e: any) => e.id === entry)?.subject_name).toBe('Mathematics')
    const byStaff = await api('admin', 'GET', `/timetable/entries?teacher_id=${IDS.teacher}`)
    expect(byStaff.body.items.map((e: any) => e.id)).toContain(entry)
    const other = await api('admin', 'GET', `/timetable/entries?section_id=${SEC_B}`)
    expect(other.body.items).toHaveLength(0)
    const audit = await T().prepare(`SELECT count(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'timetable.entry.create'`).bind(entry).first<{ n: number }>()
    expect(audit!.n).toBe(1)
  })

  it('keeps one entry per class, period and day (a second save edits it)', async () => {
    const r = await put('admin', cell({ room: '14' }))
    expect(r.body.id).toBe(entry)
    const n = await T().prepare(`SELECT count(*) AS n FROM timetable_entries WHERE section_id = ? AND weekday = 1 AND period_id = ?`).bind(IDS.section, P1).first<{ n: number }>()
    expect(n!.n).toBe(1)
  })

  it('refuses the same teacher on another subject in another class at that time, naming it', async () => {
    const r = await put('admin', cell({ section_id: SEC_B, subject_code: 'SCI' }))
    expect(r.status).toBe(409)
    expect(r.body.error).toContain('Mathematics to Class 5 A')
  })

  it('refuses a break', async () => {
    const r = await put('admin', cell({ period_name: 'Recess' }))
    expect(r.status).toBe(409)
    expect(r.body.error).toContain('break')
  })

  it('refuses someone without timetable write', async () => {
    expect((await put('teacher', cell({ room: '99' }))).status).toBe(403)
    expect((await api('teacher', 'DELETE', `/timetable/entries/${entry}`)).status).toBe(403)
  })

  it('changes the subject and teacher in place', async () => {
    const r = await put('admin', cell({ subject_code: 'SCI', teacher_user_id: '' }))
    expect(r.status).toBe(200)
    expect(r.body.id).toBe(entry)
    const row = await T().prepare(`SELECT teacher_user_id, class_subject_id FROM timetable_entries WHERE id = ?`).bind(entry).first<any>()
    expect(row.teacher_user_id).toBeNull()
    expect(row.class_subject_id).toBe(CS2)
  })

  it('clears the cell', async () => {
    const r = await api('admin', 'DELETE', `/timetable/entries/${entry}`)
    expect(r.status).toBe(200)
    const left = await T().prepare(`SELECT count(*) AS n FROM timetable_entries WHERE id = ?`).bind(entry).first<{ n: number }>()
    expect(left!.n).toBe(0)
    expect((await api('admin', 'DELETE', `/timetable/entries/${entry}`)).status).toBe(404)
    const audit = await T().prepare(`SELECT count(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'timetable.entry.delete'`).bind(entry).first<{ n: number }>()
    expect(audit!.n).toBe(1)
  })
})
