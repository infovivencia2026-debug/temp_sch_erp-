/* Timings per class: a section runs to its own bell schedule, else its
   class's, else the school day. The grid, the generator and every period
   list follow that one rule (routes/scheduling/bell.ts); a school with one
   bell sees nothing change. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, IDS, E } from './fixture'

const T = () => E.TENANT_TEST
const NURSERY = '00000000-0000-4000-8000-000000000a01'
const NURSERY_A = '00000000-0000-4000-8000-000000000a02'
const RHYMES = '00000000-0000-4000-8000-000000000a03'
const RHYMES_CS = '00000000-0000-4000-8000-000000000a04'
const DAY = '00000000-0000-4000-8000-000000000a10'

const day = (n: number, first = '09:00') => {
  const [h, m] = first.split(':').map(Number)
  return Array.from({ length: n }, (_, i) => {
    const at = h * 60 + m + i * 40
    const hh = (x: number) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`
    return { name: `Period ${i + 1}`, sequence: i + 1, starts_at: hh(at), ends_at: hh(at + 40), is_break: false }
  })
}
const periodsOf = async (q: string) => (await api('admin', 'GET', `/timetable/periods?${q}`)).body.items as { id: string; sequence: number; bell_schedule_id: string }[]
let schoolDay = ''

beforeAll(async () => {
  await seed()
  const campus = (await T().prepare('SELECT campus_id FROM sections WHERE id = ?').bind(IDS.section).first<{ campus_id: string }>())!.campus_id
  // A school day of six periods, unless another file left one.
  if (!(await T().prepare('SELECT 1 FROM bell_schedules WHERE is_default = 1').first())) {
    await T().prepare(`INSERT INTO bell_schedules (id, institution_id, campus_id, name, is_default, created_at) VALUES (?, ?, ?, 'Standard day', 1, '2000-01-01T00:00:00Z')`)
      .bind(DAY, IDS.school, campus).run()
  }
  schoolDay = (await T().prepare(`SELECT id FROM bell_schedules ORDER BY is_default DESC, created_at LIMIT 1`).first<{ id: string }>())!.id
  const put = await api('admin', 'PUT', '/setup/periods', { periods: day(6) })
  expect(put.status).toBe(200)
  await T().batch([
    T().prepare(`INSERT OR IGNORE INTO classes (id, institution_id, campus_id, name, level) VALUES (?, ?, ?, 'Nursery', -1)`).bind(NURSERY, IDS.school, campus),
    T().prepare(`INSERT OR IGNORE INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name) VALUES (?, ?, ?, ?, ?, 'A')`)
      .bind(NURSERY_A, IDS.school, campus, NURSERY, IDS.year),
    T().prepare(`INSERT OR IGNORE INTO subjects (id, institution_id, campus_id, name, code) VALUES (?, ?, ?, 'Rhymes', 'RHY')`).bind(RHYMES, IDS.school, campus),
    T().prepare(`INSERT OR IGNORE INTO class_subjects (id, institution_id, class_id, subject_id, periods_per_week) VALUES (?, ?, ?, ?, 3)`)
      .bind(RHYMES_CS, IDS.school, NURSERY, RHYMES),
    T().prepare(`UPDATE class_subjects SET periods_per_week = 3 WHERE id = ?`).bind(IDS.classSubject),
  ])
})

describe('timings per class', () => {
  let nurseryDay = '', lateShift = ''

  it('a school with one bell: every class gets the school day', async () => {
    const plain = await periodsOf('')
    expect(plain.length).toBe(6)
    expect(plain.every((p) => p.bell_schedule_id === schoolDay)).toBe(true)
    expect((await periodsOf(`section_id=${IDS.section}`)).map((p) => p.id)).toEqual(plain.map((p) => p.id))
    expect((await periodsOf(`section_id=${NURSERY_A}`)).map((p) => p.id)).toEqual(plain.map((p) => p.id))
    const ov = await api('admin', 'GET', '/master-timetable/overview')
    expect(ov.status).toBe(200)
    expect(ov.body.periods.map((p: { id: string }) => p.id)).toEqual(plain.map((p) => p.id))
    expect(ov.body.section_schedules[NURSERY_A]).toBe(schoolDay)
  })

  it('a class with timings of its own gets its own periods', async () => {
    const made = await api('admin', 'POST', '/setup/bell-schedules', { name: 'Nursery timings' })
    expect(made.status).toBe(201)
    nurseryDay = made.body.id
    // Copied from the school day, then cut to a short morning.
    const edit = await api('admin', 'PUT', `/setup/bell-schedules/${nurseryDay}`, { periods: day(3, '09:30') })
    expect(edit.status).toBe(200)
    expect((await api('admin', 'PUT', '/setup/bell-schedules/assign', { class_id: NURSERY, bell_schedule_id: nurseryDay })).status).toBe(200)

    const mine = await periodsOf(`section_id=${NURSERY_A}`)
    expect(mine.length).toBe(3)
    expect(mine.every((p) => p.bell_schedule_id === nurseryDay)).toBe(true)
    expect((await periodsOf(`class_id=${NURSERY}`)).map((p) => p.id)).toEqual(mine.map((p) => p.id))
    // Class 5 and the school day are untouched.
    expect((await periodsOf(`section_id=${IDS.section}`)).every((p) => p.bell_schedule_id === schoolDay)).toBe(true)
    expect((await periodsOf('')).length).toBe(6)

    const list = await api('admin', 'GET', '/setup/bell-schedules')
    const row = list.body.items.find((x: { id: string }) => x.id === nurseryDay)
    expect(row.classes.map((x: { id: string }) => x.id)).toEqual([NURSERY])
  })

  it('the generator places a class only on its own periods', async () => {
    const gen = await api('admin', 'POST', '/timetable-optimizer/drafts', { section_ids: [NURSERY_A, IDS.section], seed: 7 })
    expect(gen.status).toBe(201)
    const d = await api('admin', 'GET', `/timetable-optimizer/drafts/${gen.body.id}`)
    const own = new Set((await periodsOf(`section_id=${NURSERY_A}`)).map((p) => p.id))
    const school = new Set((await periodsOf('')).map((p) => p.id))
    const nursery = d.body.entries.filter((e: { section_id: string }) => e.section_id === NURSERY_A)
    const five = d.body.entries.filter((e: { section_id: string }) => e.section_id === IDS.section)
    expect(nursery.length).toBe(3)
    expect(nursery.every((e: { period_id: string }) => own.has(e.period_id))).toBe(true)
    expect(five.length).toBe(3)
    expect(five.every((e: { period_id: string }) => school.has(e.period_id))).toBe(true)
    expect(d.body.section_schedules[NURSERY_A]).toBe(nurseryDay)
    await api('admin', 'POST', `/timetable-optimizer/drafts/${gen.body.id}/discard`, {})
  })

  it("a section's own timings beat its class's", async () => {
    const made = await api('admin', 'POST', '/setup/bell-schedules', { name: 'Late shift', periods: day(4, '12:00') })
    expect(made.status).toBe(201)
    lateShift = made.body.id
    expect((await api('admin', 'PUT', '/setup/bell-schedules/assign', { section_id: NURSERY_A, bell_schedule_id: lateShift })).status).toBe(200)
    const mine = await periodsOf(`section_id=${NURSERY_A}`)
    expect(mine.length).toBe(4)
    expect(mine.every((p) => p.bell_schedule_id === lateShift)).toBe(true)
    expect((await periodsOf(`class_id=${NURSERY}`)).every((p) => p.bell_schedule_id === nurseryDay)).toBe(true)
  })

  it('a shorter day names the slots it would drop, and drops them only when told', async () => {
    const late = await periodsOf(`section_id=${NURSERY_A}`)
    await T().batch(late.map((p, i) => T().prepare(`INSERT INTO timetable_entries (id, institution_id, academic_year_id, section_id, period_id, weekday, class_subject_id)
        VALUES (?, ?, ?, ?, ?, 1, ?)`).bind(`00000000-0000-4000-8000-000000000b0${i}`, IDS.school, IDS.year, NURSERY_A, p.id, RHYMES_CS)))
    // Back to the class's three-period day: period 4 has nowhere to go.
    const ask = await api('admin', 'PUT', '/setup/bell-schedules/assign', { section_id: NURSERY_A, bell_schedule_id: null })
    expect(ask.status).toBe(409)
    expect(ask.body.code).toBe('slots_dropped')
    expect(ask.body.dropped.length).toBe(1)
    expect(ask.body.dropped[0].period).toBe('Period 4')
    const still = await periodsOf(`section_id=${NURSERY_A}`)
    expect(still.every((p) => p.bell_schedule_id === lateShift)).toBe(true)

    const done = await api('admin', 'PUT', '/setup/bell-schedules/assign', { section_id: NURSERY_A, bell_schedule_id: null, confirm: true })
    expect(done.status).toBe(200)
    const now = new Set((await periodsOf(`section_id=${NURSERY_A}`)).map((p) => p.id))
    const entries = (await T().prepare(`SELECT period_id FROM timetable_entries WHERE section_id = ?`).bind(NURSERY_A).all<{ period_id: string }>()).results
    expect(entries.length).toBe(3)
    expect(entries.every((e) => now.has(e.period_id))).toBe(true)
  })

  it('deleting a schedule sends its classes back to the school day', async () => {
    expect((await api('admin', 'DELETE', `/setup/bell-schedules/${lateShift}`)).status).toBe(200)
    const del = await api('admin', 'DELETE', `/setup/bell-schedules/${nurseryDay}`)
    expect(del.status).toBe(200)
    const school = (await periodsOf('')).map((p) => p.id)
    expect((await periodsOf(`section_id=${NURSERY_A}`)).map((p) => p.id)).toEqual(school)
    // The three lessons followed, period for period.
    const entries = (await T().prepare(`SELECT period_id FROM timetable_entries WHERE section_id = ?`).bind(NURSERY_A).all<{ period_id: string }>()).results
    expect(entries.length).toBe(3)
    expect(entries.every((e) => school.includes(e.period_id))).toBe(true)
    // The school day itself cannot go.
    expect((await api('admin', 'DELETE', `/setup/bell-schedules/${schoolDay}`)).status).toBe(400)
  })
})
