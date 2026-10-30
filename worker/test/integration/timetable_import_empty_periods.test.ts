/* Owner, 2026-10-28: "Why are period 9 and 10 missing for all?" A file with
   periods 1 to 8 was loaded into a ten-period day and nothing said that 9 and
   10 were left empty. The check now names every lesson no row fills, and a
   period past 8 imports like any other. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, call, as, IDS, E } from './fixture'

const T = () => E.TENANT_TEST

const BELL = '7d1e0000-0000-4000-8000-0000000000b1'
const slots = Array.from({ length: 10 }, (_, i) => `7d1e0000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`)

beforeAll(async () => {
  await seed()
  const campus = (await T().prepare('SELECT campus_id FROM sections WHERE id = ?').bind(IDS.section).first<{ campus_id: string }>())!.campus_id
  await T().batch([
    T().prepare(`INSERT OR IGNORE INTO bell_schedules (id, institution_id, campus_id, name, is_default) VALUES (?, ?, ?, 'Monday', 0)`).bind(BELL, IDS.school, campus),
    ...slots.map((id, i) => T().prepare(`INSERT OR IGNORE INTO periods (id, institution_id, campus_id, bell_schedule_id, name, sequence, starts_at, ends_at, is_break) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`)
      .bind(id, IDS.school, campus, BELL, `Period${i + 1}`, i + 1, `${String(8 + i).padStart(2, '0')}:00:00`, `${String(8 + i).padStart(2, '0')}:45:00`)),
  ])
})

const upload = async (rows: number[], commit: boolean) => {
  const csv = 'class,section,day,period,subject,teacher\n' + rows.map((p) => `Class 5,A,Monday,${p},Mathematics,`).join('\n') + '\n'
  const res = await call('/api/v1/setup/import/timetable' + (commit ? '?commit=true' : ''), { method: 'POST', body: csv, cookie: await as('admin'), headers: { 'content-type': 'text/csv' } })
  return { status: res.status, body: await res.json() as any }
}

describe('timetable import: lessons no row fills', () => {
  it('names periods 9 and 10 when the file stops at 8', async () => {
    const r = await upload([1, 2, 3, 4, 5, 6, 7, 8], false)
    expect(r.status).toBe(200)
    expect(r.body.valid).toBe(8)
    const notes: string[] = r.body.notes ?? []
    expect(notes.some((n) => n.startsWith('Period9 '))).toBe(true)
    expect(notes.some((n) => n.startsWith('Period10 '))).toBe(true)
    expect(notes.some((n) => n.startsWith('Period8 '))).toBe(false)
  })

  it('imports periods 9 and 10 and says nothing once every lesson is filled', async () => {
    const r = await upload([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], true)
    expect(r.status).toBe(200)
    expect(r.body.imported).toBe(10)
    expect(r.body.notes).toBeUndefined()
    const n = await T().prepare(`SELECT COUNT(*) AS n FROM timetable_entries WHERE section_id = ? AND period_id IN (?, ?)`).bind(IDS.section, slots[8], slots[9]).first<{ n: number }>()
    expect(n!.n).toBe(2)
  })
})
