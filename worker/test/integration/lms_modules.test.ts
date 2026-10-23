/* The LMS module first (0011): modules with a date range, reordered and
   archived; sources of every kind inside them, reordered, moved, drafted and
   scheduled; an assignment and a quiz placed in a module; what a child sees
   (published and due only), "new", "continue where you left off", and the
   teacher's per-student progress for a module. */
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

let chirag = ''
const K = `section_id=${IDS.section}&class_subject_id=${IDS.classSubject}`
const course = async () => (await api('teacher', 'GET', `/lms/course?${K}`)).body
const mine = async () => (await raw(chirag, 'GET', `/portal/lms/course?class_subject_id=${IDS.classSubject}`)).body
/** A module's lessons as the child gets them (0012: modules > days > items). */
const lessonsOf = (d: any, unit: string) => (d.modules.find((m: { id: string }) => m.id === unit)?.days ?? []).flatMap((x: any) => x.items).filter((i: any) => i.type === 'lesson').map((i: any) => i.lesson)

beforeAll(async () => {
  await seed()
  await api('admin', 'PUT', '/admin/student-logins', { enabled: true, min_level: 5 })
  const b = await api('admin', 'POST', '/setup/logins/bulk', { kind: 'students', section_id: IDS.section })
  const row = b.body.rows.find((r: { admission_no: string }) => r.admission_no === 'A001')
  const s = await signIn(row.sign_in_as, row.password)
  await raw(s.cookie!, 'POST', '/profile/password', { current_password: row.password, new_password: 'chirag-module-password-1' })
  chirag = s.cookie!

  // Every course is one by one now (owner, 2026-10-10); the Open switch is gone and the server refuses it.
  expect((await api('teacher', 'PUT', '/lms/course/settings', { section_id: IDS.section, class_subject_id: IDS.classSubject, gating: 'open' })).status).toBe(400)
})

describe('modules', () => {
  let m1 = '', m2 = '', m3 = ''
  const src: Record<string, string> = {}

  it('creates modules with a date range, renames and reorders them', async () => {
    const a = await api('teacher', 'POST', '/lms/units', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Numbers', starts_on: '2026-10-01', ends_on: '2026-10-07' })
    expect(a.status).toBe(200)
    m1 = a.body.id
    expect((await api('teacher', 'POST', '/lms/units', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Bad', starts_on: '2026-10-07', ends_on: '2026-10-01' })).status).toBe(400)
    m2 = (await api('teacher', 'POST', '/lms/units', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Shapes' })).body.id
    m3 = (await api('teacher', 'POST', '/lms/units', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Spare' })).body.id
    expect((await api('teacher', 'PUT', `/lms/units/${m2}`, { title: 'Shapes and space', ends_on: '2026-10-20' })).status).toBe(200)
    const r = await api('teacher', 'POST', '/lms/units/reorder', { ...{ section_id: IDS.section, class_subject_id: IDS.classSubject }, ids: [m2, m1, m3] })
    expect(r.status).toBe(200)
    const c = await course()
    const ours = c.units.filter((u: { id: string }) => [m1, m2, m3].includes(u.id)).map((u: { id: string }) => u.id)
    expect(ours).toEqual([m2, m1, m3])
    const u1 = c.units.find((u: { id: string }) => u.id === m1)
    expect(u1).toMatchObject({ starts_on: '2026-10-01', ends_on: '2026-10-07', is_active: true })
    expect(c.units.find((u: { id: string }) => u.id === m2)).toMatchObject({ title: 'Shapes and space', ends_on: '2026-10-20' })
    // A stranger's id in the list is refused.
    expect((await api('teacher', 'POST', '/lms/units/reorder', { section_id: IDS.section, class_subject_id: IDS.classSubject, ids: [m1, IDS.child] })).status).toBe(400)
  })

  it('archives a module and brings it back', async () => {
    expect((await api('teacher', 'DELETE', `/lms/units/${m3}`)).status).toBe(200)
    expect((await course()).units.find((u: { id: string }) => u.id === m3).is_active).toBe(false)
    expect((await api('teacher', 'PUT', `/lms/units/${m3}`, { is_active: true })).status).toBe(200)
    expect((await course()).units.find((u: { id: string }) => u.id === m3).is_active).toBe(true)
    await api('teacher', 'DELETE', `/lms/units/${m3}`)
  })

  it('adds sources of every kind, and refuses one missing what it needs', async () => {
    const add = async (title: string, kind: string, extra: Record<string, unknown> = {}) => {
      const r = await api('teacher', 'POST', '/lms/lessons', { unit_id: m1, title, kind, ...extra })
      expect(r.status, `${kind}: ${JSON.stringify(r.body)}`).toBe(200)
      return r.body.id as string
    }
    src.notes = await add('Place value', 'text', { body: 'Each place is ten times the one to its right.', duration_minutes: 5 })
    src.video = await add('Number line video', 'video', { url: 'https://www.youtube.com/watch?v=abcdef' })
    src.image = await add('Place value chart', 'image', { url: 'https://example.org/chart.png' })
    src.audio = await add('Counting song', 'audio', { url: 'https://example.org/song.mp3', duration_minutes: 3 })
    src.doc = await add('Slides', 'doc', { url: 'https://example.org/slides.pptx' })
    src.link = await add('Practice site', 'link', { url: 'https://example.org' })
    for (const k of ['image', 'audio', 'doc', 'pdf', 'file']) {
      expect((await api('teacher', 'POST', '/lms/lessons', { unit_id: m1, title: 'x', kind: k })).status, k).toBe(400)
    }
    expect((await api('teacher', 'POST', '/lms/lessons', { unit_id: m1, title: 'x', kind: 'hologram', body: 'x' })).status).toBe(400)
    expect((await api('teacher', 'POST', '/lms/lessons', { unit_id: m1, title: 'x', kind: 'text', body: 'x', duration_minutes: 0 })).status).toBe(400)
    const u = (await course()).units.find((x: { id: string }) => x.id === m1)
    expect(u.lessons.map((l: { kind: string }) => l.kind)).toEqual(['text', 'video', 'image', 'audio', 'doc', 'link'])
    expect(u.lessons[0].duration_minutes).toBe(5)
  })

  it('a parent or a child cannot change a module', async () => {
    expect((await api('parent', 'POST', `/lms/units/${m1}/order`, { items: [{ type: 'lesson', id: src.notes }] })).status).toBe(403)
    expect((await raw(chirag, 'POST', `/lms/lessons/${src.notes}/move`, { unit_id: m2 })).status).toBe(403)
    expect((await raw(chirag, 'POST', `/lms/lessons/${src.notes}/publish`, { is_published: false })).status).toBe(403)
  })

  let hw = '', quiz = ''
  it('places an assignment and a quiz in the module and orders them among the sources', async () => {
    const a = await api('teacher', 'POST', '/lms/assignments', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Place value sheet', unit_id: m1 })
    expect(a.status).toBe(200)
    hw = a.body.id
    const q = await api('teacher', 'POST', '/lms/quizzes', {
      section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Place value check', duration_minutes: 5,
      questions: [{ stem: 'The 3 in 305 is worth?', options: ['3', '30', '300'], correct: 2 }],
    })
    quiz = q.body.id
    expect((await api('teacher', 'POST', `/lms/quizzes/${quiz}/module`, { unit_id: m1 })).status).toBe(200)
    // A module of another subject (or nonsense) is refused.
    expect((await api('teacher', 'POST', `/lms/quizzes/${quiz}/module`, { unit_id: IDS.child })).status).toBe(404)
    const c = await course()
    expect(c.assignments.find((x: { id: string }) => x.id === hw)).toMatchObject({ lms_unit_id: m1, lms_sequence: 7 })
    expect(c.quizzes.find((x: { id: string }) => x.id === quiz)).toMatchObject({ lms_unit_id: m1, lms_sequence: 8 })
    const order = [
      { type: 'quiz', id: quiz }, { type: 'lesson', id: src.link }, { type: 'lesson', id: src.notes }, { type: 'assignment', id: hw },
      { type: 'lesson', id: src.video }, { type: 'lesson', id: src.image }, { type: 'lesson', id: src.audio }, { type: 'lesson', id: src.doc },
    ]
    const r = await api('teacher', 'POST', `/lms/units/${m1}/order`, { items: order })
    expect(r.status).toBe(200)
    const c2 = await course()
    expect(c2.quizzes.find((x: { id: string }) => x.id === quiz).lms_sequence).toBe(1)
    expect(c2.assignments.find((x: { id: string }) => x.id === hw).lms_sequence).toBe(4)
    const ls = c2.units.find((x: { id: string }) => x.id === m1).lessons
    expect(ls.find((l: { id: string }) => l.id === src.link).sequence).toBe(2)
    // An item from another module is refused.
    expect((await api('teacher', 'POST', `/lms/units/${m2}/order`, { items: [{ type: 'lesson', id: src.notes }] })).status).toBe(400)
  })

  it('moves a source to another module, at its end', async () => {
    expect((await api('teacher', 'POST', `/lms/lessons/${src.doc}/move`, { unit_id: m2 })).status).toBe(200)
    const c = await course()
    expect(c.units.find((x: { id: string }) => x.id === m2).lessons.map((l: { id: string }) => l.id)).toEqual([src.doc])
    expect(c.units.find((x: { id: string }) => x.id === m1).lessons.some((l: { id: string }) => l.id === src.doc)).toBe(false)
  })

  it('the child sees only published sources whose time has come', async () => {
    /* Every course is one by one, and this module is not the first, with a
       video before the audio and the link. The teacher opens it early for
       Chirag, which lifts both the day lock and the lock behind the video,
       so what is checked here is publishing, not progression. */
    expect((await api('teacher', 'POST', '/lms/unlocks', { student_id: IDS.child, unit_id: m1 })).status).toBe(200)
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString()
    expect((await api('teacher', 'POST', `/lms/lessons/${src.image}/publish`, { is_published: false })).status).toBe(200)
    expect((await api('teacher', 'POST', `/lms/lessons/${src.audio}/publish`, { is_published: true, publish_at: future })).status).toBe(200)
    const d = await mine()
    const u = d.modules.find((x: { id: string }) => x.id === m1)
    const ls = lessonsOf(d, m1)
    const ids = ls.map((l: { id: string }) => l.id)
    expect(ids).toContain(src.notes)
    expect(ids).not.toContain(src.image)
    // Scheduled: on its day, but only the title, and it cannot be opened.
    const sched = ls.find((l: { id: string }) => l.id === src.audio)
    expect(sched).toMatchObject({ scheduled: true, url: null })
    expect(u).toMatchObject({ starts_on: '2026-10-01', ends_on: '2026-10-07' })
    // Opening or finishing a hidden one is a 404.
    expect((await raw(chirag, 'POST', `/portal/lms/lessons/${src.audio}/complete`, {})).status).toBe(404)
    expect((await raw(chirag, 'POST', `/portal/lms/lessons/${src.image}/view`, {})).status).toBe(404)
    // The teacher still sees both, with their state.
    const t = (await course()).units.find((x: { id: string }) => x.id === m1).lessons
    expect(t.find((l: { id: string }) => l.id === src.image).is_published).toBe(false)
    expect(t.find((l: { id: string }) => l.id === src.audio).publish_at).toBe(future)
    // Due now: it appears.
    await api('teacher', 'POST', `/lms/lessons/${src.audio}/publish`, { is_published: true, publish_at: new Date(Date.now() - 60_000).toISOString() })
    expect(lessonsOf(await mine(), m1).find((l: { id: string }) => l.id === src.audio)).toMatchObject({ scheduled: false, url: 'https://example.org/song.mp3' })
    // The quiz and assignment carry their module.
    const again = await mine()
    expect(again.assignments.find((x: { id: string }) => x.id === hw).lms_unit_id).toBe(m1)
    expect(again.quizzes.find((x: { id: string }) => x.id === quiz).lms_unit_id).toBe(m1)
  })

  it('"new" until opened, and "continue where you left off"', async () => {
    let d = await mine()
    let ls = lessonsOf(d, m1)
    expect(ls.find((l: { id: string }) => l.id === src.video).is_new).toBe(true)
    expect(d.resume).toMatchObject({ started: false })
    expect((await raw(chirag, 'POST', `/portal/lms/lessons/${src.video}/view`, {})).status).toBe(200)
    d = await mine()
    ls = lessonsOf(d, m1)
    expect(ls.find((l: { id: string }) => l.id === src.video).is_new).toBe(false)
    expect(d.resume).toMatchObject({ type: 'lesson', id: src.video, unit_id: m1, started: true })
    // A parent opening it records nothing.
    expect((await api('parent', 'POST', `/portal/lms/lessons/${src.notes}/view`, {})).body.recorded).toBe(false)
    // A video is finished by watching it, never by a button (owner, 2026-10-10).
    expect((await raw(chirag, 'POST', `/portal/lms/lessons/${src.video}/complete`, {})).status).toBe(400)
  })

  it('the teacher sees who has completed the module', async () => {
    for (const id of [src.notes, src.audio, src.link]) await raw(chirag, 'POST', `/portal/lms/lessons/${id}/complete`, {})
    let p = await api('teacher', 'GET', `/lms/units/${m1}/progress?section_id=${IDS.section}`)
    expect(p.status).toBe(200)
    // Visible: notes, video, audio, link (image is a draft, doc moved) + 1 assignment + 1 quiz.
    expect(p.body.totals).toMatchObject({ sources: 4, assignments: 1, quizzes: 1, total: 6 })
    let me = p.body.items.find((x: { student_id: string }) => x.student_id === IDS.child)
    // Three: the video counts only once it is watched to the end, and it was not.
    expect(me).toMatchObject({ sources_done: 3, done: 3, complete: false })
    await raw(chirag, 'POST', `/portal/lms/assignments/${hw}/submit`, { text_answer: '300' })
    const st = await raw(chirag, 'POST', `/portal/lms/quizzes/${quiz}/start`, {})
    await raw(chirag, 'POST', `/portal/lms/quizzes/${quiz}/submit`, { attempt_id: st.body.attempt_id, answers: {} })
    p = await api('teacher', 'GET', `/lms/units/${m1}/progress?section_id=${IDS.section}`)
    me = p.body.items.find((x: { student_id: string }) => x.student_id === IDS.child)
    expect(me).toMatchObject({ done: 5, total: 6, complete: false })
    expect(p.body.items.find((x: { student_id: string }) => x.student_id === IDS.otherChild)?.complete ?? false).toBe(false)
  })

  it('a YouTube lesson carries on where it was left, from any device', async () => {
    expect((await raw(chirag, 'POST', `/portal/lms/lessons/${src.video}/youtube-watched`, { duration: 600, position: 42, watched: '1'.repeat(8) })).body).toMatchObject({ done: false })
    // Another phone asks the server, not its own storage.
    const p = (await raw(chirag, 'GET', `/portal/lms/lessons/${src.video}/youtube-progress`)).body
    expect(p).toMatchObject({ position: 42, bucket_seconds: 5 })
    expect(p.watched.startsWith('11111111')).toBe(true)
    // What the second phone plays is added to what the first did.
    await raw(chirag, 'POST', `/portal/lms/lessons/${src.video}/youtube-watched`, { duration: 600, position: 60, watched: '0'.repeat(8) + '1111' })
    const q = (await raw(chirag, 'GET', `/portal/lms/lessons/${src.video}/youtube-progress`)).body
    expect(q.position).toBe(60)
    expect(q.watched.startsWith('111111111111')).toBe(true)
  })

  it('taking a quiz out of a module leaves it in the course', async () => {
    expect((await api('teacher', 'POST', `/lms/quizzes/${quiz}/module`, { unit_id: null })).status).toBe(200)
    const q = (await course()).quizzes.find((x: { id: string }) => x.id === quiz)
    expect(q).toMatchObject({ lms_unit_id: null, lms_sequence: null })
  })
})
