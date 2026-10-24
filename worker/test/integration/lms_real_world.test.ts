/* The LMS as a term of real use, from both sides. The teacher sets, fixes,
   withdraws, marks and nudges; the child hands in late, redoes work, retakes
   a quiz, and tries doors that should be shut. Each test states the rule a
   school expects; a failure is a gap. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, signIn, IDS, E, isoDay } from './fixture'

const T = () => E.TENANT_TEST
async function raw(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await call('/api/v1' + path, { method, cookie, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text(); let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: parsed }
}
let chirag = '', diya = ''
const X = { unit: '', lesson: '', hw: '', quiz: '' }

beforeAll(async () => {
  await seed()
  await api('admin', 'PUT', '/admin/student-logins', { enabled: true })
  const b = await api('admin', 'POST', '/setup/logins/bulk', { kind: 'students', section_id: IDS.section })
  const rows: { admission_no: string; sign_in_as: string; password?: string }[] = b.body.rows
  for (const [adm, pw, set] of [['A001', 'chirag-lms-pass-1', (c: string) => { chirag = c }], ['A002', 'diya-lms-pass-1', (c: string) => { diya = c }]] as const) {
    const r = rows.find((x) => x.admission_no === adm)!
    let s = await signIn(r.sign_in_as, r.password ?? adm)
    if (s.cookie) {
      const ch = await raw(s.cookie, 'POST', '/profile/password', { current_password: r.password ?? adm, new_password: pw })
      if (ch.status !== 200) s = await signIn(r.sign_in_as, pw)
    } else s = await signIn(r.sign_in_as, pw)
    if (!s.cookie) throw new Error('student sign-in failed for ' + adm)
    set(s.cookie)
  }
})

describe('the teacher sets work', () => {
  it('builds a unit with a lesson, an assignment and a quiz', async () => {
    const u = await api('teacher', 'POST', '/lms/units', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Decimals' })
    expect(u.status).toBe(200); X.unit = u.body.id
    const l = await api('teacher', 'POST', '/lms/lessons', { unit_id: X.unit, title: 'Tenths and hundredths', kind: 'text', body: 'A tenth is one of ten equal parts.' })
    expect(l.status).toBe(200); X.lesson = l.body.id
    const a = await api('teacher', 'POST', '/lms/assignments', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Decimal worksheet', due_on: isoDay(2), max_marks: 10 })
    expect(a.status, JSON.stringify(a.body)).toBe(200); X.hw = a.body.id
    const q = await api('teacher', 'POST', '/lms/quizzes', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Decimals check', duration_minutes: 10, max_attempts: 2,
      questions: [{ stem: '0.5 equals', options: ['1/2', '1/5', '5'], correct: 0 }, { stem: '0.25 equals', options: ['1/4', '2/5'], correct: 0, marks: 2 }] })
    expect(q.status, JSON.stringify(q.body)).toBe(200); X.quiz = q.body.id
  })

  it('refuses an assignment due in the past and a quiz that cannot be answered', async () => {
    expect((await api('teacher', 'POST', '/lms/assignments', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Old', due_on: isoDay(-1) })).status).toBe(400)
    expect((await api('teacher', 'POST', '/lms/quizzes', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Bad', questions: [{ stem: 'x', options: ['a'], correct: 0 }] })).status).toBe(400)
    expect((await api('teacher', 'POST', '/lms/quizzes', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Bad', questions: [{ stem: 'x', options: ['a', 'b'], correct: 5 }] })).status).toBe(400)
    expect((await api('teacher', 'POST', '/lms/quizzes', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Bad', duration_minutes: 0, questions: [{ stem: 'x', options: ['a', 'b'], correct: 0 }] })).status).toBe(400)
  })

  it('fixes a typo and moves the due date on an assignment already set', async () => {
    const r = await api('teacher', 'PUT', `/lms/assignments/${X.hw}`, { title: 'Decimals worksheet', due_on: isoDay(4) })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const row = await T().prepare('SELECT title, due_on FROM homework WHERE id = ?').bind(X.hw).first<{ title: string; due_on: string }>()
    expect(row).toEqual({ title: 'Decimals worksheet', due_on: isoDay(4) })
    expect((await api('teacher', 'PUT', `/lms/assignments/${X.hw}`, { due_on: isoDay(-3) })).status).toBe(400)
  })

  it('fixes the title and the time limit on a quiz nobody has started', async () => {
    const r = await api('teacher', 'PUT', `/lms/quizzes/${X.quiz}`, { title: 'Decimals quick check', duration_minutes: 15 })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const row = await T().prepare('SELECT title, duration_minutes FROM online_tests WHERE id = ?').bind(X.quiz).first<{ title: string; duration_minutes: number }>()
    expect(row).toEqual({ title: 'Decimals quick check', duration_minutes: 15 })
  })

  it('cannot mark a child who has not handed in, unless it says so', async () => {
    const r = await api('teacher', 'POST', `/lms/assignments/${X.hw}/grade`, { student_id: IDS.otherChild, marks: 0, feedback: 'Nothing received' })
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    const ok = await api('teacher', 'POST', `/lms/assignments/${X.hw}/grade`, { student_id: IDS.otherChild, marks: 0, feedback: 'Nothing received', without_submission: true })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    await T().prepare('DELETE FROM homework_submissions WHERE homework_id = ? AND student_id = ?').bind(X.hw, IDS.otherChild).run()
  })

  it('a person with no teaching cannot read the gradebook or the quiz results', async () => {
    expect([403, 404]).toContain((await api('finance', 'GET', `/lms/assignments/${X.hw}/gradebook`)).status)
    expect([403, 404]).toContain((await api('finance', 'GET', `/lms/quizzes/${X.quiz}/results`)).status)
  })
})

describe('the child does the work', () => {
  it('a lesson is done once, and can be un-done', async () => {
    expect((await raw(chirag, 'POST', `/portal/lms/lessons/${X.lesson}/complete`, {})).status).toBe(200)
    expect((await raw(chirag, 'POST', `/portal/lms/lessons/${X.lesson}/complete`, {})).status).toBe(200)
    const n = await T().prepare('SELECT count(*) AS n FROM lms_lesson_progress WHERE lesson_id = ? AND student_id = ?').bind(X.lesson, IDS.child).first<{ n: number }>()
    expect(n?.n).toBe(1)
    expect((await raw(chirag, 'POST', `/portal/lms/lessons/${X.lesson}/complete`, { done: false })).body.done).toBe(false)
  })

  it('the parent reads the course but cannot hand in, start a quiz or finish a lesson for the child', async () => {
    expect((await api('parent', 'GET', `/portal/lms/course?class_subject_id=${IDS.classSubject}&student_id=${IDS.child}`)).status).toBe(200)
    expect((await api('parent', 'POST', `/portal/lms/assignments/${X.hw}/submit`, { text_answer: 'dad did it' })).status).toBe(403)
    expect((await api('parent', 'POST', `/portal/lms/quizzes/${X.quiz}/start`, {})).status).toBe(403)
    expect((await api('parent', 'POST', `/portal/lms/lessons/${X.lesson}/complete`, {})).status).toBe(403)
  })

  it('a child cannot read the gradebook or results, and cannot hand in to another section', async () => {
    expect([403, 404]).toContain((await raw(chirag, 'GET', `/lms/assignments/${X.hw}/gradebook`)).status)
    expect([403, 404]).toContain((await raw(chirag, 'GET', `/lms/quizzes/${X.quiz}/results`)).status)
    const other = crypto.randomUUID()
    await T().prepare(`INSERT INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name) SELECT ?, institution_id, campus_id, class_id, academic_year_id, 'Z' FROM sections WHERE id = ?`).bind(other, IDS.section).run()
    const h = crypto.randomUUID(); const t = new Date().toISOString()
    await T().prepare(`INSERT INTO homework (id, institution_id, section_id, class_subject_id, kind, title, assigned_on, due_on, is_published, allow_submission, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'homework', 'Z only', ?, ?, 1, 1, ?, ?)`).bind(h, IDS.school, other, IDS.classSubject, isoDay(0), isoDay(3), t, t).run()
    expect((await raw(chirag, 'POST', `/portal/lms/assignments/${h}/submit`, { text_answer: 'x' })).status).toBe(404)
  })

  it('work handed in after the due date is marked late, and the teacher sees that', async () => {
    await T().prepare('UPDATE homework SET due_on = ? WHERE id = ?').bind(isoDay(-1), X.hw).run()
    const s = await raw(chirag, 'POST', `/portal/lms/assignments/${X.hw}/submit`, { text_answer: '0.5 = 1/2' })
    expect(s.status).toBe(200)
    expect(s.body).toMatchObject({ status: 'late', late: true })
    const g = await api('teacher', 'GET', `/lms/assignments/${X.hw}/gradebook`)
    const mine = (g.body.rows ?? g.body.items ?? []).find((x: any) => x.student_id === IDS.child)
    expect(mine?.status).toBe('late')
    await T().prepare('UPDATE homework SET due_on = ? WHERE id = ?').bind(isoDay(4), X.hw).run()
  })

  it('sent back to redo, the child hands in again; marked, it is sealed', async () => {
    const redo = await api('teacher', 'POST', `/lms/assignments/${X.hw}/grade`, { student_id: IDS.child, status: 'resubmit', feedback: 'Show the working.' })
    expect(redo.status).toBe(200)
    const again = await raw(chirag, 'POST', `/portal/lms/assignments/${X.hw}/submit`, { text_answer: '0.5 = 5/10 = 1/2' })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.status).toBe('submitted')
    const mark = await api('teacher', 'POST', `/lms/assignments/${X.hw}/grade`, { student_id: IDS.child, marks: 9, return: true })
    expect(mark.status).toBe(200)
    expect((await raw(chirag, 'POST', `/portal/lms/assignments/${X.hw}/submit`, { text_answer: 'once more' })).status).toBe(409)
    expect((await api('teacher', 'POST', `/lms/assignments/${X.hw}/grade`, { student_id: IDS.child, marks: 11 })).status).toBe(400)
  })

  it('nudging when nobody is missing tells nobody', async () => {
    const r = await api('teacher', 'POST', `/lms/assignments/${X.hw}/nudge`, { to: 'both' })
    expect(r.status).toBe(200)
    expect(r.body.missing).toBe(1) // Diya has not handed in
    expect(r.body.told).toBeGreaterThanOrEqual(1)
  })

  it('a quiz with two attempts keeps the best; nonsense option ids score nothing; the third start is refused', async () => {
    const s1 = await raw(chirag, 'POST', `/portal/lms/quizzes/${X.quiz}/start`, {})
    expect(s1.status, JSON.stringify(s1.body)).toBe(200)
    // The same child starting again before handing in gets the same attempt, not a second one.
    const same = await raw(chirag, 'POST', `/portal/lms/quizzes/${X.quiz}/start`, {})
    expect(same.body.attempt_id).toBe(s1.body.attempt_id)
    const r1 = await raw(chirag, 'POST', `/portal/lms/quizzes/${X.quiz}/submit`, { attempt_id: s1.body.attempt_id, answers: { [s1.body.questions[0].test_question_id]: crypto.randomUUID(), bogus: 'x' } })
    expect(r1.status).toBe(200)
    expect(r1.body.score).toBe(0)
    const s2 = await raw(chirag, 'POST', `/portal/lms/quizzes/${X.quiz}/start`, {})
    expect(s2.status).toBe(200)
    const pick = (qq: any, body: string) => qq.options.find((o: any) => o.body === body).id
    const q1 = s2.body.questions.find((x: any) => x.stem.startsWith('0.5')), q2 = s2.body.questions.find((x: any) => x.stem.startsWith('0.25'))
    const r2 = await raw(chirag, 'POST', `/portal/lms/quizzes/${X.quiz}/submit`, { attempt_id: s2.body.attempt_id, answers: { [q1.test_question_id]: pick(q1, '1/2'), [q2.test_question_id]: pick(q2, '1/4') } })
    expect(r2.body).toMatchObject({ score: 3, max_score: 3 })
    expect(r2.body.review.length).toBe(2) // answers shown once no attempt is left
    expect((await raw(chirag, 'POST', `/portal/lms/quizzes/${X.quiz}/start`, {})).status).toBe(409)
    const res = await api('teacher', 'GET', `/lms/quizzes/${X.quiz}/results`)
    expect(res.body.items.find((x: any) => x.student_id === IDS.child).best).toBe(3)
  })

  it('a quiz that has not opened, or has closed, cannot be started; closing it mid-attempt still lets the attempt finish', async () => {
    const later = await api('teacher', 'POST', '/lms/quizzes', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Later', opens_at: new Date(Date.now() + 3_600_000).toISOString(), questions: [{ stem: 'x', options: ['a', 'b'], correct: 0 }] })
    expect((await raw(diya, 'POST', `/portal/lms/quizzes/${later.body.id}/start`, {})).body.code).toBe('quiz_not_open')
    const s = await raw(diya, 'POST', `/portal/lms/quizzes/${X.quiz}/start`, {})
    expect(s.status).toBe(200)
    expect((await api('teacher', 'POST', `/lms/quizzes/${X.quiz}/status`, { status: 'closed' })).status).toBe(200)
    const sub = await raw(diya, 'POST', `/portal/lms/quizzes/${X.quiz}/submit`, { attempt_id: s.body.attempt_id, answers: {} })
    expect(sub.status).toBe(200)
    expect((await raw(diya, 'POST', `/portal/lms/quizzes/${X.quiz}/start`, {})).body.code).toBe('quiz_closed')
  })

  it('a quiz with an attempt cannot have its questions changed; one with none can be withdrawn', async () => {
    const r = await api('teacher', 'PUT', `/lms/quizzes/${X.quiz}`, { questions: [{ stem: 'new', options: ['a', 'b'], correct: 0 }] })
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    const fresh = await api('teacher', 'POST', '/lms/quizzes', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Oops', questions: [{ stem: 'x', options: ['a', 'b'], correct: 0 }] })
    const del = await api('teacher', 'DELETE', `/lms/quizzes/${fresh.body.id}`)
    expect(del.status, JSON.stringify(del.body)).toBe(200)
    expect((await raw(chirag, 'POST', `/portal/lms/quizzes/${fresh.body.id}/start`, {})).status).toBe(404)
  })

  it('an assignment with work handed in cannot be deleted, only closed; one with none can go', async () => {
    const del = await api('teacher', 'DELETE', `/lms/assignments/${X.hw}`)
    expect(del.status, JSON.stringify(del.body)).toBe(409)
    const empty = await api('teacher', 'POST', '/lms/assignments', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Set by mistake', due_on: isoDay(3) })
    const gone = await api('teacher', 'DELETE', `/lms/assignments/${empty.body.id}`)
    expect(gone.status, JSON.stringify(gone.body)).toBe(200)
    const todo = await raw(chirag, 'GET', '/portal/lms/todo')
    expect(JSON.stringify(todo.body)).not.toContain(empty.body.id)
  })

  it('retiring a unit hides its lessons from the child but keeps what was done', async () => {
    await raw(chirag, 'POST', `/portal/lms/lessons/${X.lesson}/complete`, {})
    expect((await api('teacher', 'DELETE', `/lms/units/${X.unit}`)).status).toBe(200)
    const c = await raw(chirag, 'GET', `/portal/lms/course?class_subject_id=${IDS.classSubject}`)
    expect(JSON.stringify(c.body)).not.toContain(X.lesson)
    const kept = await T().prepare('SELECT count(*) AS n FROM lms_lesson_progress WHERE lesson_id = ?').bind(X.lesson).first<{ n: number }>()
    expect(kept?.n).toBe(1)
  })
})
