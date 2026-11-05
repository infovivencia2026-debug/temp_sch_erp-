/* The assistant's school tools (routes/misc/assistant/tools_school.ts) and
   the loose class and section matching (read.ts findSection), with the
   scripted fake in place of Gemini. Each tool reads through a route as the
   caller, so a class teacher sees only their own section's children. */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { seed, as, call, IDS, E, type Who } from './fixture'
import { absenceRuns, birthdayIn, birthdayWindow } from '../../src/routes/misc/assistant/tools_school'

type Part = Record<string, unknown>
let script: Part[][] = []
const seen: Record<string, unknown>[] = []
;(globalThis as { __FAKE_GEMINI__?: unknown }).__FAKE_GEMINI__ = (payload: Record<string, unknown>) => {
  seen.push(payload)
  const parts = script.shift() ?? [{ text: 'Done.' }]
  return { candidates: [{ content: { role: 'model', parts } }] }
}
afterEach(() => { script = []; seen.length = 0 })
const fn = (name: string, args: Record<string, unknown> = {}) => ({ functionCall: { name, args } })

async function ask(who: Who, message = 'question') {
  const res = await call('/api/v1/assistant/agent', {
    method: 'POST', cookie: await as(who), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }),
  })
  expect(res.status).toBe(200)
  return new TextDecoder().decode(await res.arrayBuffer()).split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
async function run(who: Who, name: string, args: Record<string, unknown> = {}) {
  script = [[fn(name, args)], [{ text: 'Done.' }]]
  const ev = await ask(who)
  const done = ev.find((e) => e.t === 'tool_done')
  const contents = (seen[1]?.contents ?? []) as { parts: any[] }[]
  const result = contents.length ? contents[contents.length - 1].parts[0]?.functionResponse?.response?.result : undefined
  return { done, result, text: JSON.stringify(result ?? {}) }
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const G3 = id(301), BODHA = id(302), HITHA = id(303), ESHA = id(304)
const ist = (off = 0) => new Date(Date.now() + 5.5 * 3600_000 + off * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  await seed()
  const T = E.TENANT_TEST
  const campus = (await T.prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
  const today = ist()
  const dob = `${Number(today.slice(0, 4)) - 9}${today.slice(4)}`
  await T.batch([
    T.prepare(`INSERT OR IGNORE INTO classes (id, institution_id, campus_id, name, level) VALUES (?, ?, ?, 'Grade 3', 3)`).bind(G3, IDS.school, campus),
    T.prepare(`INSERT OR IGNORE INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name) VALUES (?, ?, ?, ?, ?, 'BODHA')`).bind(BODHA, IDS.school, campus, G3, IDS.year),
    T.prepare(`INSERT OR IGNORE INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name) VALUES (?, ?, ?, ?, ?, 'HITHA')`).bind(HITHA, IDS.school, campus, G3, IDS.year),
    T.prepare(`INSERT OR IGNORE INTO students (id, institution_id, campus_id, admission_no, first_name, last_name, admission_date, date_of_birth) VALUES (?, ?, ?, 'B001', 'Esha', 'Test', ?, ?)`)
      .bind(ESHA, IDS.school, campus, ist(-100), dob),
    T.prepare(`INSERT OR IGNORE INTO enrollments (id, institution_id, student_id, academic_year_id, class_id, section_id, roll_no, enrolled_on) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
      .bind(id(305), IDS.school, ESHA, IDS.year, G3, BODHA, ist(-100)),
    // Diya (Class 5 A, the teacher's section) and Esha (Grade 3 BODHA, not theirs): absent the last three days. Chirag present.
    ...[1, 2, 3].flatMap((d) => [
      T.prepare(`INSERT INTO student_attendance (institution_id, student_id, section_id, on_date, status) VALUES (?, ?, ?, ?, 'absent')`).bind(IDS.school, IDS.otherChild, IDS.section, ist(-d)),
      T.prepare(`INSERT INTO student_attendance (institution_id, student_id, section_id, on_date, status) VALUES (?, ?, ?, ?, 'absent')`).bind(IDS.school, ESHA, BODHA, ist(-d)),
      T.prepare(`INSERT INTO student_attendance (institution_id, student_id, section_id, on_date, status) VALUES (?, ?, ?, ?, 'present')`).bind(IDS.school, IDS.child, IDS.section, ist(-d)),
    ]),
    // Diya was present four days ago, so her run is exactly three.
    T.prepare(`INSERT INTO student_attendance (institution_id, student_id, section_id, on_date, status) VALUES (?, ?, ?, ?, 'present')`).bind(IDS.school, IDS.otherChild, IDS.section, ist(-4)),
  ])
})

describe('helpers', () => {
  it('finds a birthday in a window, across the year end and on 29 February', () => {
    expect(birthdayIn('2015-12-31', '2026-12-28', '2027-01-03')).toBe('2026-12-31')
    expect(birthdayIn('2016-02-29', '2027-02-28', '2027-02-28')).toBe('2027-02-28')
    expect(birthdayIn('2015-06-01', '2026-11-05', '2026-11-05')).toBeNull()
    expect(birthdayIn(null, '2026-11-05', '2026-11-05')).toBeNull()
    expect(birthdayWindow('this_week', '2026-11-05')).toEqual({ from: '2026-11-05', to: '2026-11-11' })
    expect(birthdayWindow('nonsense', '2026-11-05')).toBeNull()
  })
  it('counts runs of school days, a day with no register neither breaking nor extending one', () => {
    const d = (date: string, ...ids: string[]) => ({ date, absent: new Set(ids) })
    const runs = absenceRuns([d('2026-11-05', 'a'), d('2026-11-04', 'a', 'b'), d('2026-11-02', 'a', 'b'), d('2026-10-31', 'b')], 3)
    expect(runs.get('a')).toEqual({ length: 3, from: '2026-11-02', to: '2026-11-05', current: true })
    expect(runs.get('b')).toEqual({ length: 3, from: '2026-10-31', to: '2026-11-04', current: false })
    expect(absenceRuns([d('2026-11-05', 'a'), d('2026-11-04', 'a')], 3).size).toBe(0)
  })
})

describe('class and section names', () => {
  it('lists a class\'s word-named sections when asked for a letter that is not there', async () => {
    const r = await run('admin', 'timetable', { class: 'grade 3', section: 'A' })
    expect(r.done.ok).toBe(false)
    expect(r.done.error).toMatch(/BODHA/)
    expect(r.done.error).toMatch(/HITHA/)
  })
  it('matches "3 bod" to Grade 3 BODHA', async () => {
    const r = await run('admin', 'timetable', { class: '3 bod' })
    expect(r.done.ok).toBe(true)
    expect(r.done.view.title).toMatch(/Grade 3 BODHA/)
  })
  it('matches "Grade 5" to a class called Class 5', async () => {
    const r = await run('admin', 'section_attendance', { class: 'Grade 5', section: 'a' })
    expect(r.done.ok).toBe(true)
  })
})

describe('class_sections', () => {
  it('names the class teacher and the students per section', async () => {
    const r = await run('admin', 'class_sections', { class: 'Class 5' })
    expect(r.done.ok).toBe(true)
    expect(r.text).toContain('Tara Teacher')
    expect(r.result.rows[0].students).toBe(2)
  })
  it('lists the sections of Grade 3', async () => {
    const r = await run('admin', 'class_sections', { class: '3' })
    expect(r.result.total).toBe(2)
    expect(r.text).toContain('not set')
  })
  it('is not offered to a parent', async () => {
    const r = await run('parent', 'class_sections')
    expect(r.done?.ok ?? false).toBe(false)
  })
})

describe('student_count', () => {
  it('counts the whole school for the admin, and one class', async () => {
    const all = await run('admin', 'student_count')
    expect(all.result.active).toBe(3)
    seen.length = 0
    const five = await run('admin', 'student_count', { class: '5' })
    expect(five.result.active_students).toBe(2)
  })
  it('counts only the class teacher\'s own children', async () => {
    const r = await run('teacher', 'student_count')
    expect(r.result.active).toBe(2)
  })
})

describe('birthdays', () => {
  it('finds a student whose birthday is today, with the age', async () => {
    const r = await run('admin', 'birthdays', { when: 'today' })
    expect(r.done.ok).toBe(true)
    expect(r.text).toContain('Esha')
    expect(r.result.rows.find((x: any) => String(x.name).includes('Esha')).age).toBe(9)
  })
  it('does not show a class teacher a child outside their section', async () => {
    const r = await run('teacher', 'birthdays', { when: 'today', who: 'students' })
    expect(r.text).not.toContain('Esha')
  })
  it('is not offered to a parent', async () => {
    const r = await run('parent', 'birthdays')
    expect(r.done?.ok ?? false).toBe(false)
  })
})

describe('consecutive_absences', () => {
  it('finds both children away three days in a row for the admin', async () => {
    const r = await run('admin', 'consecutive_absences', { days: 3 })
    expect(r.done.ok).toBe(true)
    expect(r.text).toContain('Diya')
    expect(r.text).toContain('Esha')
    expect(r.text).not.toContain('Chirag')
  })
  it('narrows to a class by a word-named section', async () => {
    const r = await run('admin', 'consecutive_absences', { class: 'Grade 3', section: 'bodha' })
    expect(r.text).toContain('Esha')
    expect(r.text).not.toContain('Diya')
  })
  it('gives a class teacher only their own section', async () => {
    const r = await run('teacher', 'consecutive_absences')
    expect(r.text).toContain('Diya')
    expect(r.text).not.toContain('Esha')
  })
  it('finds nobody for four days in a row', async () => {
    const r = await run('admin', 'consecutive_absences', { days: 4, lookback: 10 })
    expect(r.text).not.toContain('Diya')
  })
})

describe('the agent loop', () => {
  it('tries again once when the model returns an empty reply', async () => {
    script = [[], [{ text: 'There are 3 students.' }]]
    const ev = await ask('admin', 'how many students')
    expect(ev.find((e) => e.t === 'answer').text).toBe('There are 3 students.')
  })
  it('offers the new tools and asks the model to use them before refusing', async () => {
    script = [[{ text: 'ok' }]]
    await ask('admin')
    const p = seen[0] as any
    const names = p.tools[0].functionDeclarations.map((d: any) => d.name)
    expect(names).toEqual(expect.arrayContaining(['class_sections', 'student_count', 'birthdays', 'consecutive_absences']))
    expect(p.system_instruction.parts[0].text).toMatch(/Before you say you cannot/)
  })
})
