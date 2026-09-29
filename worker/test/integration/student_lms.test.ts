/* Student logins and the LMS, end to end.

   The school's switch and lowest class; issuing logins in bulk for a
   section (usernames from the admission number, a printed code, forced
   change at first sign-in); a child seeing only their own records; and the
   LMS: units and lessons with progress, assignments with a rubric, grading,
   handing back and nudging, and a timed, auto-marked quiz. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, signIn, IDS, E } from './fixture'

const T = () => E.TENANT_TEST

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

const creds: Record<string, { sign_in_as: string; password: string }> = {}
let chirag = '', diya = ''

beforeAll(async () => {
  await seed()
})

describe('student logins: the school switch', () => {
  it('is off for a school that has never issued one, and issuing is refused', async () => {
    const s = await api('admin', 'GET', '/admin/student-logins')
    expect(s.status).toBe(200)
    expect(s.body).toMatchObject({ enabled: false, chosen: false })
    const b = await api('admin', 'POST', '/setup/logins/bulk', { kind: 'students', section_id: IDS.section })
    expect(b.status).toBe(409)
    const one = await api('admin', 'POST', `/setup/students/${IDS.child}/login`, {})
    expect(one.status).toBe(409)
  })

  it('a lowest class above the section issues nothing', async () => {
    expect((await api('admin', 'PUT', '/admin/student-logins', { enabled: true, min_level: 6 })).status).toBe(200)
    const b = await api('admin', 'POST', '/setup/logins/bulk', { kind: 'students', section_id: IDS.section })
    expect(b.status).toBe(200)
    expect(b.body.created).toBe(0)
    const one = await api('admin', 'POST', `/setup/students/${IDS.child}/login`, {})
    expect(one.status).toBe(409)
  })

  it('only an administrator may change it', async () => {
    expect((await api('teacher', 'PUT', '/admin/student-logins', { enabled: true })).status).toBe(403)
    expect((await api('parent', 'PUT', '/admin/student-logins', { enabled: true })).status).toBe(403)
  })

  it('issues a section in bulk: admission number usernames, codes, and a sheet to print', async () => {
    expect((await api('admin', 'PUT', '/admin/student-logins', { enabled: true, min_level: 5 })).status).toBe(200)
    const b = await api('admin', 'POST', '/setup/logins/bulk', { kind: 'students', section_id: IDS.section })
    expect(b.status).toBe(200)
    expect(b.body.created).toBe(2)
    for (const r of b.body.rows) {
      expect(r).toMatchObject({ class_name: 'Class 5', section_name: 'A', existing: false })
      expect(r.sign_in_as.toLowerCase()).toBe(String(r.admission_no).toLowerCase())
      // First password is the admission number; the child must change it.
      expect(r.password).toBe(String(r.admission_no))
      creds[r.admission_no] = r
    }
    const u = await T().prepare(`SELECT u.must_change_password AS m FROM users u JOIN students s ON s.user_id = u.id WHERE s.id = ?`).bind(IDS.child).first<{ m: number }>()
    expect(u?.m).toBe(1)
    const roles = await T().prepare(`SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN students s ON s.user_id = ur.user_id WHERE s.id = ?`).bind(IDS.child).all<{ key: string }>()
    expect(roles.results.map((x) => x.key)).toEqual(['student'])
    // A second run keeps what was issued; while a login is unused, its first
    // password (the admission number) is shown again for the slip.
    const again = await api('admin', 'POST', '/setup/logins/bulk', { kind: 'students', section_id: IDS.section })
    expect(again.body).toMatchObject({ created: 0, existing: 2 })
    expect(again.body.rows.every((r: { password?: string; admission_no?: string }) => r.password === String(r.admission_no))).toBe(true)
  })

  it('makes the child choose a password before anything else, with no skip', async () => {
    const c = creds.A001
    const { cookie } = await signIn(c.sign_in_as, c.password)
    expect(cookie).toBeTruthy()
    const blocked = await raw(cookie!, 'GET', '/portal/lms/courses')
    expect(blocked.status).toBe(403)
    expect(blocked.body.code).toBe('password_change_required')
    expect((await raw(cookie!, 'POST', '/profile/password/skip', {})).status).toBe(403)
    const ch = await raw(cookie!, 'POST', '/profile/password', { current_password: c.password, new_password: 'chirag-own-password-1' })
    expect(ch.status).toBe(200)
    chirag = cookie!
    const d = creds.A002
    const s2 = await signIn(d.sign_in_as, d.password)
    expect((await raw(s2.cookie!, 'POST', '/profile/password', { current_password: d.password, new_password: 'diya-own-password-1' })).status).toBe(200)
    diya = s2.cookie!
  })
})

describe('a student sees only their own records', () => {
  it('reads their own', async () => {
    const h = await raw(chirag, 'GET', '/portal/lms/home')
    expect(h.status).toBe(200)
    expect(h.body.student_id).toBe(IDS.child)
    expect((await raw(chirag, 'GET', '/portal/fees')).status).toBe(200)
    expect((await raw(chirag, 'GET', `/portal/fees?student_id=${IDS.child}`)).status).toBe(200)
  })

  it("gets 403 or 404 for another child's id, everywhere", async () => {
    const other = IDS.otherChild
    for (const p of [`/portal/fees?student_id=${other}`, `/portal/attendance?student_id=${other}`, `/portal/results?student_id=${other}`,
      `/portal/lms/home?student_id=${other}`, `/portal/lms/courses?student_id=${other}`, `/portal/lms/todo?student_id=${other}`,
      `/portal/lms/course?student_id=${other}&class_subject_id=${IDS.classSubject}`, `/students/${other}`,
      `/fees/students/${other}/wallet`]) {
      const r = await raw(chirag, 'GET', p)
      expect([403, 404], p).toContain(r.status)
    }
    // Reads that take no child ignore the parameter and answer for the caller.
    const me = await raw(chirag, 'GET', `/me/student?student_id=${other}`)
    expect(me.body.id).toBe(IDS.child)
    for (const p of [`/homework?student_id=${other}`, `/portal/receipts?student_id=${other}`]) {
      const r = await raw(chirag, 'GET', p)
      expect(r.status, p).toBe(200)
      expect(JSON.stringify(r.body), p).not.toContain(other)
    }
  })

  it('cannot reach staff screens', async () => {
    for (const p of ['/students', '/admin/users', `/lms/courses`, '/teaching/assignments']) {
      const r = await raw(chirag, 'GET', p)
      if (r.status === 200) expect(r.body.items ?? [], p).toEqual([])
      else expect([403, 404], p).toContain(r.status)
    }
  })

  it('switching student logins off refuses the sign-in and ends the session', async () => {
    const off = await api('admin', 'PUT', '/admin/student-logins', { enabled: false, min_level: 5 })
    expect(off.status).toBe(200)
    expect(off.body.signed_out).toBeGreaterThanOrEqual(1)
    expect((await raw(chirag, 'GET', '/portal/lms/home')).status).toBe(401)
    const s = await signIn(creds.A001.sign_in_as, 'chirag-own-password-1')
    expect(s.cookie).toBeNull()
    expect(s.res.status).toBe(403)
    await api('admin', 'PUT', '/admin/student-logins', { enabled: true, min_level: 5 })
    chirag = (await signIn(creds.A001.sign_in_as, 'chirag-own-password-1')).cookie!
    diya = (await signIn(creds.A002.sign_in_as, 'diya-own-password-1')).cookie!
    expect(chirag).toBeTruthy()
  })
})

describe('the LMS', () => {
  let unit = '', lesson = '', hw = '', quiz = ''

  it('a teacher builds a course: a unit and a lesson', async () => {
    const list = await api('teacher', 'GET', '/lms/courses')
    expect(list.status).toBe(200)
    expect(list.body.items.some((x: { class_subject_id: string }) => x.class_subject_id === IDS.classSubject)).toBe(true)
    const u = await api('teacher', 'POST', '/lms/units', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Fractions' })
    expect(u.status).toBe(200)
    unit = u.body.id
    const bad = await api('teacher', 'POST', '/lms/lessons', { unit_id: unit, title: 'Video', kind: 'video' })
    expect(bad.status).toBe(400)
    const l = await api('teacher', 'POST', '/lms/lessons', { unit_id: unit, title: 'What a fraction is', kind: 'text', body: 'A fraction is a part of a whole. The top number is the numerator.' })
    expect(l.status).toBe(200)
    lesson = l.body.id
    await api('teacher', 'POST', '/lms/lessons', { unit_id: unit, title: 'Khan Academy video', kind: 'video', url: 'https://www.youtube.com/watch?v=abc' })
    const c = await api('teacher', 'GET', `/lms/course?section_id=${IDS.section}&class_subject_id=${IDS.classSubject}`)
    expect(c.body.units[0].lessons).toHaveLength(2)
    // The child is told.
    const n = await T().prepare(`SELECT count(*) AS n FROM notifications n JOIN students s ON s.user_id = n.user_id WHERE s.id = ? AND n.source_id = ?`).bind(IDS.child, lesson).first<{ n: number }>()
    expect(n?.n).toBe(1)
  })

  it('a parent and another school role cannot write to a course', async () => {
    expect((await api('parent', 'POST', '/lms/units', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'x' })).status).toBe(403)
    expect((await raw(chirag, 'POST', '/lms/lessons', { unit_id: unit, title: 'x', kind: 'text', body: 'x' })).status).toBe(403)
  })

  it('the child sees the course with progress and marks a lesson done', async () => {
    const cs = await raw(chirag, 'GET', '/portal/lms/courses')
    const m = cs.body.items.find((x: { class_subject_id: string }) => x.class_subject_id === IDS.classSubject)
    expect(m).toMatchObject({ lessons: 2, completed: 0 })
    expect((await raw(chirag, 'POST', `/portal/lms/lessons/${lesson}/complete`, {})).status).toBe(200)
    const after = await raw(chirag, 'GET', `/portal/lms/course?class_subject_id=${IDS.classSubject}`)
    const lessonsOf = (b: any) => b.modules.flatMap((m: any) => m.days).flatMap((d: any) => d.items).filter((i: any) => i.type === 'lesson').map((i: any) => i.lesson)
    const ls = lessonsOf(after.body)
    expect(ls.find((x: { id: string }) => x.id === lesson).done).toBe(true)
    // Diya's progress is her own.
    const d = await raw(diya, 'GET', `/portal/lms/course?class_subject_id=${IDS.classSubject}`)
    expect(lessonsOf(d.body).find((x: { id: string }) => x.id === lesson).done).toBe(false)
    // A parent reads but does not do the child's work.
    expect((await api('parent', 'POST', `/portal/lms/lessons/${lesson}/complete`, {})).status).toBe(403)
    const pv = await api('parent', 'GET', `/portal/lms/course?class_subject_id=${IDS.classSubject}&student_id=${IDS.child}`)
    expect(pv.status).toBe(200)
    expect((await api('parent', 'GET', `/portal/lms/course?class_subject_id=${IDS.classSubject}&student_id=${IDS.otherChild}`)).status).toBe(404)
  })

  it('sets an assignment with a rubric; the child hands in; the gradebook shows who is missing', async () => {
    const a = await api('teacher', 'POST', '/lms/assignments', {
      section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Fraction worksheet', due_on: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
      rubric: [{ criterion: 'Working', max: 6 }, { criterion: 'Answers', max: 4 }],
    })
    expect(a.status).toBe(200)
    hw = a.body.id
    const todo = await raw(chirag, 'GET', '/portal/lms/todo')
    expect(todo.body.assignments.map((x: { id: string }) => x.id)).toContain(hw)
    expect((await raw(chirag, 'POST', `/portal/lms/assignments/${hw}/submit`, {})).status).toBe(400)
    const s = await raw(chirag, 'POST', `/portal/lms/assignments/${hw}/submit`, { text_answer: '1/2 + 1/4 = 3/4' })
    expect(s.status).toBe(200)
    expect(s.body).toMatchObject({ status: 'submitted', late: false })
    const g = await api('teacher', 'GET', `/lms/assignments/${hw}/gradebook`)
    expect(g.body.assignment.max_marks).toBe(10)
    expect(g.body.summary).toMatchObject({ roll: 2, submitted: 1, missing: 1 })
    // Before marking, the child sees no marks.
    const before = await raw(chirag, 'GET', `/portal/lms/course?class_subject_id=${IDS.classSubject}`)
    expect(before.body.assignments.find((x: { id: string }) => x.id === hw).marks ?? null).toBeNull()
  })

  it('grades on the rubric, refuses a score over a criterion, and hands the work back', async () => {
    expect((await api('teacher', 'POST', `/lms/assignments/${hw}/grade`, { student_id: IDS.child, rubric_scores: { Working: 7, Answers: 4 } })).status).toBe(400)
    const g = await api('teacher', 'POST', `/lms/assignments/${hw}/grade`, { student_id: IDS.child, rubric_scores: { Working: 5, Answers: 4 }, feedback: 'Show the common denominator.', return: true })
    expect(g.status).toBe(200)
    expect(g.body).toMatchObject({ marks: 9, returned: true })
    const after = await raw(chirag, 'GET', `/portal/lms/course?class_subject_id=${IDS.classSubject}`)
    const mine = after.body.assignments.find((x: { id: string }) => x.id === hw)
    expect(mine).toMatchObject({ marks: 9, feedback: 'Show the common denominator.', status: 'graded' })
    expect(mine.rubric_scores).toEqual({ Working: 5, Answers: 4 })
    // Marked work cannot be handed in again over the top.
    expect((await raw(chirag, 'POST', `/portal/lms/assignments/${hw}/submit`, { text_answer: 'again' })).status).toBe(409)
    // The parent is told too.
    const n = await T().prepare(`SELECT count(*) AS n FROM notifications WHERE user_id = ? AND kind = 'homework_graded' AND source_id = ?`).bind(IDS.parent, hw).first<{ n: number }>()
    expect(n?.n).toBe(1)
  })

  it('nudges only the children who have not handed in, and their parents', async () => {
    const r = await api('teacher', 'POST', `/lms/assignments/${hw}/nudge`, { to: 'both' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ missing: 1, told: 2 })
    const toDiyaParent = await T().prepare(`SELECT count(*) AS n FROM notifications WHERE user_id = ? AND kind = 'homework_nudge'`).bind(IDS.otherParent).first<{ n: number }>()
    const toChiragParent = await T().prepare(`SELECT count(*) AS n FROM notifications WHERE user_id = ? AND kind = 'homework_nudge'`).bind(IDS.parent).first<{ n: number }>()
    expect(toDiyaParent?.n).toBe(1)
    expect(toChiragParent?.n).toBe(0)
  })

  it('a timed MCQ quiz: questions without answers, auto-marked, one attempt', async () => {
    const q = await api('teacher', 'POST', '/lms/quizzes', {
      section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Fractions check', duration_minutes: 10,
      questions: [
        { stem: 'What is 1/2 + 1/2?', options: ['1', '2', '1/4'], correct: 0 },
        { stem: 'The top number is the...', options: ['denominator', 'numerator'], correct: 1, marks: 2 },
      ],
    })
    expect(q.status).toBe(200)
    quiz = q.body.id
    const s = await raw(chirag, 'POST', `/portal/lms/quizzes/${quiz}/start`, {})
    expect(s.status).toBe(200)
    expect(s.body.questions).toHaveLength(2)
    expect(JSON.stringify(s.body.questions)).not.toContain('is_correct')
    expect(s.body.deadline).toBeTruthy()
    const q1 = s.body.questions.find((x: { stem: string }) => x.stem.startsWith('What'))
    const q2 = s.body.questions.find((x: { stem: string }) => x.stem.startsWith('The top'))
    const pick = (qq: { options: { id: string; body: string }[] }, body: string) => qq.options.find((o) => o.body === body)!.id
    const sub = await raw(chirag, 'POST', `/portal/lms/quizzes/${quiz}/submit`, { attempt_id: s.body.attempt_id, answers: { [q1.test_question_id]: pick(q1, '1'), [q2.test_question_id]: pick(q2, 'denominator') } })
    expect(sub.status).toBe(200)
    expect(sub.body).toMatchObject({ score: 1, max_score: 3, timed_out: false })
    expect((await raw(chirag, 'POST', `/portal/lms/quizzes/${quiz}/submit`, { attempt_id: s.body.attempt_id, answers: {} })).status).toBe(409)
    expect((await raw(chirag, 'POST', `/portal/lms/quizzes/${quiz}/start`, {})).status).toBe(409)
    // Diya cannot hand in Chirag's attempt.
    expect((await raw(diya, 'POST', `/portal/lms/quizzes/${quiz}/submit`, { attempt_id: s.body.attempt_id, answers: {} })).status).toBe(404)
    const res = await api('teacher', 'GET', `/lms/quizzes/${quiz}/results`)
    expect(res.body.items.find((x: { student_id: string }) => x.student_id === IDS.child).best).toBe(1)
  })

  it('refuses answers after the time limit', async () => {
    const s = await raw(diya, 'POST', `/portal/lms/quizzes/${quiz}/start`, {})
    expect(s.status).toBe(200)
    await T().prepare(`UPDATE online_test_attempts SET started_at = ? WHERE id = ?`).bind(new Date(Date.now() - 20 * 60_000).toISOString(), s.body.attempt_id).run()
    const q1 = s.body.questions[0]
    const sub = await raw(diya, 'POST', `/portal/lms/quizzes/${quiz}/submit`, { attempt_id: s.body.attempt_id, answers: { [q1.test_question_id]: q1.options[0].id } })
    expect(sub.body).toMatchObject({ score: 0, timed_out: true })
  })
})

describe('scheduled lessons and the LMS Admin role', () => {
  it('a lesson scheduled for later is hidden from the child until then', async () => {
    const c = await api('teacher', 'GET', `/lms/course?section_id=${IDS.section}&class_subject_id=${IDS.classSubject}`)
    const unit = c.body.units[0].id
    const later = new Date(Date.now() + 86_400_000).toISOString()
    const l = await api('teacher', 'POST', '/lms/lessons', { unit_id: unit, title: 'Tomorrow', kind: 'text', body: 'Not yet.', day: 2, publish_at: later })
    expect(l.status).toBe(200)
    const teacherView = await api('teacher', 'GET', `/lms/course?section_id=${IDS.section}&class_subject_id=${IDS.classSubject}`)
    expect(teacherView.body.units[0].lessons.find((x: { id: string }) => x.id === l.body.id)).toMatchObject({ day: 2, publish_at: later })
    // Since 0012 it stands on its day as a title with its opening time, with none of its content.
    const find = (b: any) => b.modules.flatMap((m: any) => m.days).flatMap((d: any) => d.items).find((i: any) => i.id === l.body.id)?.lesson
    const kid = await raw(chirag, 'GET', `/portal/lms/course?class_subject_id=${IDS.classSubject}`)
    expect(find(kid.body)).toMatchObject({ scheduled: true, body: null })
    expect(JSON.stringify(kid.body)).not.toContain('Not yet.')
    expect((await raw(chirag, 'POST', `/portal/lms/lessons/${l.body.id}/complete`, {})).status).toBe(404)
    await T().prepare(`UPDATE lms_lessons SET publish_at = ? WHERE id = ?`).bind(new Date(Date.now() - 1000).toISOString(), l.body.id).run()
    const now = await raw(chirag, 'GET', `/portal/lms/course?class_subject_id=${IDS.classSubject}`)
    expect(find(now.body)).toMatchObject({ scheduled: false, body: 'Not yet.' })
  })

  it('installs as an optional role, is granted beside another role, and reaches every course', async () => {
    const inst = await api('admin', 'POST', '/admin/roles/install', { key: 'lms_admin' })
    expect(inst.status).toBe(200)
    const roles = await api('admin', 'GET', '/admin/assignable-roles')
    expect(JSON.stringify(roles.body)).toContain('lms_admin')
    // Finance holds no teaching; with LMS Admin added on the same login, every course opens.
    expect((await api('finance', 'GET', `/lms/course?section_id=${IDS.section}&class_subject_id=${IDS.classSubject}`)).status).toBe(403)
    const rid = (await T().prepare(`SELECT id FROM roles WHERE key = 'lms_admin'`).first<{ id: string }>())!.id
    await T().prepare(`INSERT INTO user_roles (id, institution_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), IDS.school, IDS.finance, rid, new Date().toISOString()).run()
    const list = await api('finance', 'GET', '/lms/courses')
    expect(list.body.items.length).toBeGreaterThan(0)
    const u = await api('finance', 'POST', '/lms/units', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Decimals' })
    expect(u.status).toBe(200)
    const perms = await T().prepare(`SELECT permission_key FROM role_permissions WHERE role_id = ?`).bind(rid).all<{ permission_key: string }>()
    expect(perms.results.map((x) => x.permission_key)).toContain('lms_admin.lms.courses')
  })
})
