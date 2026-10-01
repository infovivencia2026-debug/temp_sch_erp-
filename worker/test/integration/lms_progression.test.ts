/* One by one (0012): Course > Module (sub-modules) > Day > sections. A day
   opens when the one before is done (required sources done, the assessment
   handed in or passed); the server refuses a locked source, quiz or
   assignment with 403 'locked'; a teacher can unlock a day for one child,
   switch the course to open, label and reorder days; and publish time still
   holds a day back. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, signIn, IDS } from './fixture'

async function raw(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await call('/api/v1' + path, {
    method, cookie,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: parsed }
}

const CO = { section_id: IDS.section, class_subject_id: IDS.classSubject }
let chirag = '', diya = ''
const mine = async (who = chirag) => (await raw(who, 'GET', `/portal/lms/course?class_subject_id=${IDS.classSubject}`)).body
const dayOf = (d: any, unit: string, day: number | null) => d.modules.find((m: any) => m.id === unit)?.days.find((x: any) => x.day === day)

beforeAll(async () => {
  await seed()
  await api('admin', 'PUT', '/admin/student-logins', { enabled: true, min_level: 5 })
  const b = await api('admin', 'POST', '/setup/logins/bulk', { kind: 'students', section_id: IDS.section })
  for (const [adm, pw] of [['A001', 'chirag-steps-password-1'], ['A002', 'diya-steps-password-1']]) {
    const row = b.body.rows.find((r: { admission_no: string }) => r.admission_no === adm)
    const s = await signIn(row.sign_in_as, row.password)
    await raw(s.cookie!, 'POST', '/profile/password', { current_password: row.password, new_password: pw })
    if (adm === 'A001') chirag = s.cookie!; else diya = s.cookie!
  }
})

describe('one by one', () => {
  let A = '', A1 = '', B = ''
  const L: Record<string, string> = {}
  let quiz = '', hw = ''

  it('builds a module of labelled days, a sub-module and a second module', async () => {
    A = (await api('teacher', 'POST', '/lms/units', { ...CO, title: 'Fractions' })).body.id
    for (const label of ['Basics', 'On a line', 'Adding']) expect((await api('teacher', 'POST', `/lms/units/${A}/days`, { label })).body.day).toBeGreaterThan(0)
    expect((await api('teacher', 'PUT', `/lms/units/${A}/days/2`, { label: 'Fractions on a line' })).status).toBe(200)
    const add = async (k: string, b: Record<string, unknown>, unit = A) => {
      const r = await api('teacher', 'POST', '/lms/lessons', { unit_id: unit, kind: 'text', body: 'Some notes to read.', ...b })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      L[k] = r.body.id
    }
    await add('d1', { title: 'What a fraction is', day: 1, section: 'resources' })
    await add('d1opt', { title: 'Warm-up game', day: 1, section: 'prereq', kind: 'link', url: 'https://example.org', is_optional: true })
    await add('d2', { title: 'Number line', day: 2, section: 'resources' })
    await add('d3', { title: 'Adding like fractions', day: 3, section: 'tools' })
    expect((await api('teacher', 'POST', '/lms/lessons', { unit_id: A, kind: 'text', body: 'x', title: 'x', section: 'homework' })).status).toBe(400)
    quiz = (await api('teacher', 'POST', '/lms/quizzes', { ...CO, title: 'Day 2 check', unit_id: A, day: 2, pass_percent: 60,
      questions: [{ stem: 'Half of 10?', options: ['2', '5'], correct: 1 }] })).body.id
    hw = (await api('teacher', 'POST', '/lms/assignments', { ...CO, title: 'Day 3 sheet', unit_id: A, day: 3, pass_percent: 70, max_marks: 10 })).body.id
    expect((await api('teacher', 'POST', '/lms/assignments', { ...CO, title: 'bad', unit_id: A, day: 3, pass_percent: 150 })).status).toBe(400)
    A1 = (await api('teacher', 'POST', '/lms/units', { ...CO, title: 'Fraction puzzles', parent_unit_id: A })).body.id
    // Deeper nesting is covered in lms_nesting.test.ts.
    await add('a1', { title: 'Puzzle one', day: 1 }, A1)
    B = (await api('teacher', 'POST', '/lms/units', { ...CO, title: 'Decimals' })).body.id
    await add('b1', { title: 'Tenths', day: 1 }, B)
    const c = (await api('teacher', 'GET', `/lms/course?section_id=${IDS.section}&class_subject_id=${IDS.classSubject}`)).body
    expect(c.gating).toBe('sequential')
    expect(c.days.filter((d: { unit_id: string }) => d.unit_id === A).map((d: { label: string }) => d.label)).toEqual(['Basics', 'Fractions on a line', 'Adding'])
    expect(c.units.find((u: { id: string }) => u.id === A1).parent_unit_id).toBe(A)
    expect(c.quizzes.find((q: { id: string }) => q.id === quiz)).toMatchObject({ lms_day: 2, lms_pass_percent: 60 })
  })

  it('the child sees Day 1 open and the rest locked, with the reason and no content', async () => {
    const d = await mine()
    expect(d.gating).toBe('sequential')
    expect(d.modules.map((m: { id: string }) => m.id).filter((x: string) => [A, A1, B].includes(x))).toEqual([A, A1, B])
    expect(dayOf(d, A, 1)).toMatchObject({ state: 'open', name: 'Day 1: Basics', total: 1 })
    const d2 = dayOf(d, A, 2)
    expect(d2).toMatchObject({ state: 'locked', reason: 'Finish Day 1: Basics to unlock' })
    expect(d2.items.find((i: any) => i.type === 'lesson').lesson).toMatchObject({ locked: true, body: null })
    expect(dayOf(d, B, 1)).toMatchObject({ state: 'locked' })
    // The reason names the first day still to finish, and its module when it is another one.
    expect(dayOf(d, B, 1).reason).toBe('Finish Day 1: Basics (Fractions) to unlock')
    expect(d.resume).toMatchObject({ type: 'lesson', id: L.d1opt, day_name: 'Day 1: Basics', section: 'prereq' })
    // Sections are in order: pre-requisites first.
    expect(dayOf(d, A, 1).items.map((i: any) => i.section)).toEqual(['prereq', 'resources'])
  })

  it('the server refuses a locked source, quiz and assignment', async () => {
    for (const [m, p, b] of [
      ['POST', `/portal/lms/lessons/${L.d2}/complete`, {}], ['POST', `/portal/lms/lessons/${L.d2}/view`, {}],
      ['POST', `/portal/lms/quizzes/${quiz}/start`, {}], ['POST', `/portal/lms/assignments/${hw}/submit`, { text_answer: 'x' }],
    ] as const) {
      const r = await raw(chirag, m, p, b)
      expect(r.status, p).toBe(403)
      expect(r.body.code, p).toBe('locked')
      expect(r.body.error ?? r.body.message, p).toMatch(/Finish Day/)
    }
  })

  it('finishing the required sources of Day 1 opens Day 2 (the optional one does not count)', async () => {
    expect((await raw(chirag, 'POST', `/portal/lms/lessons/${L.d1}/complete`, {})).status).toBe(200)
    const d = await mine()
    expect(dayOf(d, A, 1).state).toBe('done')
    expect(dayOf(d, A, 2).state).toBe('open')
    expect(dayOf(d, A, 3).state).toBe('locked')
    // Diya has done nothing: her Day 2 is still locked.
    expect(dayOf(await mine(diya), A, 2).state).toBe('locked')
  })

  it('a quiz below the pass mark keeps the next day locked', async () => {
    expect((await raw(chirag, 'POST', `/portal/lms/lessons/${L.d2}/complete`, {})).status).toBe(200)
    const st = await raw(chirag, 'POST', `/portal/lms/quizzes/${quiz}/start`, {})
    expect(st.status).toBe(200)
    await raw(chirag, 'POST', `/portal/lms/quizzes/${quiz}/submit`, { attempt_id: st.body.attempt_id, answers: {} })
    const d = await mine()
    expect(dayOf(d, A, 2)).toMatchObject({ state: 'open', done: 1, total: 2 })
    expect(dayOf(d, A, 3)).toMatchObject({ state: 'locked', reason: 'Finish Day 2: Fractions on a line to unlock' })
  })

  it('the teacher sees where each child is stuck, and unlocks Day 3 for one child', async () => {
    const g = (await api('teacher', 'GET', `/lms/course/progress?section_id=${IDS.section}&class_subject_id=${IDS.classSubject}`)).body
    expect(g.steps.slice(0, 3).map((s: { label: string }) => s.label)).toEqual(['Day 1: Basics', 'Day 2: Fractions on a line', 'Day 3: Adding'])
    const me = g.students.find((s: { student_id: string }) => s.student_id === IDS.child)
    expect(me.at).toBe(`${A}:2`)
    expect(me.states.slice(0, 3).map((s: { state: string }) => s.state)).toEqual(['done', 'open', 'locked'])
    expect((await api('parent', 'POST', '/lms/unlocks', { student_id: IDS.child, unit_id: A, day: 3 })).status).toBe(403)
    expect((await api('teacher', 'POST', '/lms/unlocks', { student_id: IDS.child, unit_id: A, day: 3 })).status).toBe(200)
    const d = await mine()
    expect(dayOf(d, A, 3).state).toBe('open')
    expect(dayOf(await mine(diya), A, 3).state).toBe('locked')
    // Opened early, the day works: the assignment can be handed in.
    expect((await raw(chirag, 'POST', `/portal/lms/assignments/${hw}/submit`, { text_answer: '3/4' })).status).toBe(200)
  })

  it('an assignment with a pass mark counts once it is marked at or above it', async () => {
    await raw(chirag, 'POST', `/portal/lms/lessons/${L.d3}/complete`, {})
    expect(dayOf(await mine(), A, 3).state).toBe('open')
    await api('teacher', 'POST', `/lms/assignments/${hw}/grade`, { student_id: IDS.child, marks: 6, return: true })
    expect(dayOf(await mine(), A, 3).state).toBe('open')
    const g8 = await api('teacher', 'POST', `/lms/assignments/${hw}/grade`, { student_id: IDS.child, marks: 8, return: true })
    expect(g8.status).toBe(200)
    const d = await mine()
    expect(dayOf(d, A, 3).state).toBe('done')
    // Day 2 is still not passed, so the sub-module after Day 3 opens (Day 3 was opened and is done).
    expect(dayOf(d, A1, 1).state).toBe('open')
  })

  it('publish time holds a day back', async () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString()
    const r = await api('teacher', 'POST', '/lms/lessons', { unit_id: A1, kind: 'text', body: 'Later', title: 'Puzzle two', day: 1, publish_at: future })
    await raw(chirag, 'POST', `/portal/lms/lessons/${L.a1}/complete`, {})
    const d = await mine()
    const day = dayOf(d, A1, 1)
    expect(day).toMatchObject({ state: 'open', done: 1, total: 2, opens_at: future })
    expect(day.items.find((i: any) => i.id === r.body.id).lesson).toMatchObject({ scheduled: true, body: null })
    expect((await raw(chirag, 'POST', `/portal/lms/lessons/${r.body.id}/complete`, {})).status).toBe(404)
    expect(dayOf(d, B, 1).state).toBe('locked')
  })

  it('an open course has nothing locked', async () => {
    expect((await api('teacher', 'PUT', '/lms/course/settings', { ...CO, gating: 'open' })).status).toBe(200)
    const d = await mine(diya)
    expect(d.modules.flatMap((m: any) => m.days).every((x: any) => x.state !== 'locked')).toBe(true)
    expect((await raw(diya, 'POST', `/portal/lms/lessons/${L.b1}/complete`, {})).status).toBe(200)
    expect((await api('teacher', 'PUT', '/lms/course/settings', { ...CO, gating: 'sometimes' })).status).toBe(400)
    await api('teacher', 'PUT', '/lms/course/settings', { ...CO, gating: 'sequential' })
    expect(dayOf(await mine(diya), B, 1).state).toBe('locked')
  })

  it('reorders days with everything on them, and removes only an empty day', async () => {
    expect((await api('teacher', 'POST', `/lms/units/${A}/days/order`, { days: [3, 1, 2] })).status).toBe(200)
    const c = (await api('teacher', 'GET', `/lms/course?section_id=${IDS.section}&class_subject_id=${IDS.classSubject}`)).body
    expect(c.days.filter((d: { unit_id: string }) => d.unit_id === A).map((d: { day: number; label: string }) => `${d.day}:${d.label}`)).toEqual(['1:Adding', '2:Basics', '3:Fractions on a line'])
    const ls = c.units.find((u: { id: string }) => u.id === A).lessons
    expect(ls.find((l: { id: string }) => l.id === L.d3).day).toBe(1)
    expect(c.assignments.find((a: { id: string }) => a.id === hw).lms_day).toBe(1)
    expect(c.quizzes.find((q: { id: string }) => q.id === quiz).lms_day).toBe(3)
    // Chirag's unlock moved with its day.
    const g = (await api('teacher', 'GET', `/lms/course/progress?section_id=${IDS.section}&class_subject_id=${IDS.classSubject}`)).body
    expect(g.students.find((s: { student_id: string }) => s.student_id === IDS.child).unlocks).toContain(`${A}:1`)
    expect((await api('teacher', 'DELETE', `/lms/units/${A}/days/1`)).status).toBe(409)
    const n = (await api('teacher', 'POST', `/lms/units/${A}/days`, {})).body.day
    expect(n).toBe(4)
    expect((await api('teacher', 'DELETE', `/lms/units/${A}/days/4`)).status).toBe(200)
    // A source moves to another day and section.
    expect((await api('teacher', 'POST', `/lms/lessons/${L.d2}/move`, { day: 2, section: 'prereq' })).status).toBe(200)
    const c2 = (await api('teacher', 'GET', `/lms/course?section_id=${IDS.section}&class_subject_id=${IDS.classSubject}`)).body
    expect(c2.units.find((u: { id: string }) => u.id === A).lessons.find((l: { id: string }) => l.id === L.d2)).toMatchObject({ day: 2, section: 'prereq' })
  })
})
