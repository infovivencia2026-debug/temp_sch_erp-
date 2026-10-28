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

const cell = (over: Record<string, unknown> = {}) => ({ section_id: IDS.section, period_id: P1, weekday: 1, class_subject_id: IDS.classSubject, teacher_id: IDS.teacher, room: '12', ...over })

describe('live timetable: edit one cell', () => {
  let entry = ''

  it('sets a cell and reads it back by class and by teacher', async () => {
    const r = await api('admin', 'PUT', '/master-timetable/live/cell', cell())
    expect(r.status).toBe(200)
    entry = r.body.id
    expect(r.body.subject_name).toBe('Mathematics')
    const byClass = await api('admin', 'GET', `/master-timetable/live?section_id=${IDS.section}`)
    expect(byClass.body.items.map((e: any) => e.id)).toContain(entry)
    const byStaff = await api('admin', 'GET', `/master-timetable/live?teacher_id=${IDS.teacher}`)
    expect(byStaff.body.items.map((e: any) => e.id)).toContain(entry)
    const other = await api('admin', 'GET', `/master-timetable/live?section_id=${SEC_B}`)
    expect(other.body.items).toHaveLength(0)
    const slot = await api('admin', 'GET', `/master-timetable/live/slot?weekday=1&period_id=${P1}&section_id=${SEC_B}`)
    expect(slot.body.busy[0].teacher_id).toBe(IDS.teacher)
    expect(slot.body.subjects.length).toBe(2)
    const audit = await T().prepare(`SELECT count(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'timetable.entry.create'`).bind(entry).first<{ n: number }>()
    expect(audit!.n).toBe(1)
  })

  it('refuses a second entry for the same class, period and day', async () => {
    const r = await api('admin', 'PUT', '/master-timetable/live/cell', cell({ class_subject_id: CS2, teacher_id: null }))
    expect(r.status).toBe(409)
    expect(r.body.error).toContain('Class 5 A already has Mathematics')
  })

  it('refuses the same teacher on another subject in another class at that time', async () => {
    const r = await api('admin', 'PUT', '/master-timetable/live/cell', cell({ section_id: SEC_B, class_subject_id: CS2 }))
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('teacher_busy')
    expect(r.body.error).toContain('Mathematics to Class 5 A')
  })

  it('refuses a break', async () => {
    const r = await api('admin', 'PUT', '/master-timetable/live/cell', cell({ period_id: BRK }))
    expect(r.status).toBe(400)
  })

  it('refuses someone without timetable write', async () => {
    const r = await api('teacher', 'PUT', '/master-timetable/live/cell', cell({ entry_id: entry, room: '99' }))
    expect(r.status).toBe(403)
    const d = await api('teacher', 'DELETE', `/master-timetable/live/entries/${entry}`)
    expect(d.status).toBe(403)
  })

  it('changes the subject and teacher in place', async () => {
    const r = await api('admin', 'PUT', '/master-timetable/live/cell', cell({ entry_id: entry, class_subject_id: CS2, teacher_id: null, room: '' }))
    expect(r.status).toBe(200)
    expect(r.body.id).toBe(entry)
    expect(r.body.subject_name).toBe('Science')
    expect(r.body.teacher_id).toBeNull()
  })

  it('clears the cell and its cover', async () => {
    const r = await api('admin', 'DELETE', `/master-timetable/live/entries/${entry}`)
    expect(r.status).toBe(200)
    const left = await T().prepare(`SELECT count(*) AS n FROM timetable_entries WHERE id = ?`).bind(entry).first<{ n: number }>()
    expect(left!.n).toBe(0)
    const again = await api('admin', 'DELETE', `/master-timetable/live/entries/${entry}`)
    expect(again.status).toBe(404)
  })
})
