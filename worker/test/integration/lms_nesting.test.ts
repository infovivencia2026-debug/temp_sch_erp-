/* Modules inside modules, at any depth up to four levels: a module can hold
   sub-modules and content (on a day or straight in the module). The child
   takes them depth first, progress rolls up through them, a teacher can move
   a module inside another (never inside itself) and back out, and another
   class's course stays out of reach. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, signIn, IDS, E } from './fixture'

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
let chirag = ''
const mine = async () => (await raw(chirag, 'GET', `/portal/lms/course?class_subject_id=${IDS.classSubject}`)).body
const unit = (title: string, parent?: string) => api('teacher', 'POST', '/lms/units', { ...CO, title, ...(parent ? { parent_unit_id: parent } : {}) })
const lesson = async (unit_id: string, title: string, day: number | null = null) => {
  const r = await api('teacher', 'POST', '/lms/lessons', { unit_id, kind: 'text', body: 'Read this.', title, ...(day === null ? {} : { day }) })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return r.body.id as string
}

beforeAll(async () => {
  await seed()
  await api('admin', 'PUT', '/admin/student-logins', { enabled: true, min_level: 5 })
  const b = await api('admin', 'POST', '/setup/logins/bulk', { kind: 'students', section_id: IDS.section })
  const row = b.body.rows.find((r: { admission_no: string }) => r.admission_no === 'A001')
  const s = await signIn(row.sign_in_as, row.password)
  await raw(s.cookie!, 'POST', '/profile/password', { current_password: row.password, new_password: 'chirag-nest-password-1' })
  chirag = s.cookie!
})

describe('modules inside modules', () => {
  let M = '', S1 = '', S2 = '', S3 = '', N = ''
  const L: Record<string, string> = {}

  it('nests four levels and refuses a fifth', async () => {
    M = (await unit('Plants')).body.id
    S1 = (await unit('Parts of a plant', M)).body.id
    S2 = (await unit('Roots', S1)).body.id
    const r3 = await unit('Root hairs', S2)
    expect(r3.status, JSON.stringify(r3.body)).toBe(200)
    S3 = r3.body.id
    expect((await unit('Too deep', S3)).status).toBe(400)
    N = (await unit('Animals')).body.id
    const c = (await api('teacher', 'GET', `/lms/course?section_id=${IDS.section}&class_subject_id=${IDS.classSubject}`)).body
    expect(c.units.find((u: { id: string }) => u.id === S3).parent_unit_id).toBe(S2)
  })

  it('content sits on a day or straight in a module, at every level', async () => {
    L.m = await lesson(M, 'What a plant needs')
    L.s1 = await lesson(S1, 'Leaves and stems', 1)
    L.s3 = await lesson(S3, 'Tiny hairs drink water')
    L.n = await lesson(N, 'Pets')
    const d = await mine()
    const ids = d.modules.map((m: { id: string }) => m.id)
    // Depth first: the module, then what is inside it, then the next module.
    // Roots has nothing of its own but holds Root hairs, so it is shown in its place.
    expect(ids).toEqual([M, S1, S2, S3, N])
    expect(d.modules.find((m: { id: string }) => m.id === S3).parent_unit_id).toBe(S2)
    const straight = d.modules.find((m: { id: string }) => m.id === M).days
    expect(straight).toHaveLength(1)
    expect(straight[0].day).toBeNull()
  })

  it('one by one runs through the nested modules in order, and progress rolls up', async () => {
    let d = await mine()
    const st = (id: string) => d.modules.find((m: { id: string }) => m.id === id).days[0].state
    expect(st(M)).toBe('open')
    expect(st(S1)).toBe('locked')
    expect(st(S3)).toBe('locked')
    for (const k of ['m', 's1']) expect((await raw(chirag, 'POST', `/portal/lms/lessons/${L[k]}/complete`, { done: true })).status).toBe(200)
    // Locked deep inside until what is before it is done.
    d = await mine()
    expect(st(S3)).toBe('open')
    expect(st(N)).toBe('locked')
    expect((await raw(chirag, 'POST', `/portal/lms/lessons/${L.n}/complete`, { done: true })).status).toBe(403)
    expect((await raw(chirag, 'POST', `/portal/lms/lessons/${L.s3}/complete`, { done: true })).status).toBe(200)
    d = await mine()
    for (const id of [M, S1, S3]) expect(st(id)).toBe('done')
    expect(st(N)).toBe('open')
    // The subject's count includes the lessons in every nested module.
    const list = (await raw(chirag, 'GET', '/portal/lms/courses')).body.items.find((x: { class_subject_id: string }) => x.class_subject_id === IDS.classSubject)
    expect(list).toMatchObject({ lessons: 4, completed: 3 })
  })

  it('a module moves inside another and back out, never inside itself', async () => {
    expect((await api('teacher', 'PUT', `/lms/units/${M}`, { parent_unit_id: S2 })).status).toBe(400)
    expect((await api('teacher', 'PUT', `/lms/units/${S1}`, { parent_unit_id: S1 })).status).toBe(400)
    // Plants is four deep, so it cannot go inside Animals.
    expect((await api('teacher', 'PUT', `/lms/units/${M}`, { parent_unit_id: N })).status).toBe(400)
    expect((await api('teacher', 'PUT', `/lms/units/${S3}`, { parent_unit_id: N })).status).toBe(200)
    let d = await mine()
    expect(d.modules.find((m: { id: string }) => m.id === S3).parent_unit_id).toBe(N)
    // Roots is now empty all the way down, so the child no longer sees it.
    expect(d.modules.some((m: { id: string }) => m.id === S2)).toBe(false)
    expect((await api('teacher', 'PUT', `/lms/units/${S3}`, { parent_unit_id: null })).status).toBe(200)
    d = await mine()
    expect(d.modules.find((m: { id: string }) => m.id === S3).parent_unit_id).toBeNull()
    // Lessons move between modules too.
    expect((await api('teacher', 'POST', `/lms/lessons/${L.n}/move`, { unit_id: S1, day: null, section: 'resources' })).status).toBe(200)
    d = await mine()
    expect(d.modules.find((m: { id: string }) => m.id === S1).days.flatMap((x: { items: { id: string }[] }) => x.items.map((i) => i.id))).toContain(L.n)
  })

  it('another class cannot reach this course, and a teacher cannot nest into it', async () => {
    const T = E.TENANT_TEST
    const campus = (await T.prepare('SELECT campus_id FROM classes WHERE id = ?').bind(IDS.klass).first<{ campus_id: string }>())!.campus_id
    const k2 = crypto.randomUUID(), cs2 = crypto.randomUUID(), u2 = crypto.randomUUID()
    await T.batch([
      T.prepare(`INSERT INTO classes (id, institution_id, campus_id, name, level) VALUES (?, ?, ?, 'Class 6', 6)`).bind(k2, IDS.school, campus),
      T.prepare(`INSERT INTO class_subjects (id, institution_id, class_id, subject_id) VALUES (?, ?, ?, ?)`).bind(cs2, IDS.school, k2, IDS.subject),
      T.prepare(`INSERT INTO syllabus_units (id, institution_id, class_subject_id, sequence, title, planned_periods, is_active, created_at) VALUES (?, ?, ?, 1, 'Secret', 1, 1, ?)`)
        .bind(u2, IDS.school, cs2, new Date().toISOString()),
    ])
    expect((await raw(chirag, 'GET', `/portal/lms/course?class_subject_id=${cs2}`)).status).toBe(404)
    const items = (await raw(chirag, 'GET', '/portal/lms/courses')).body.items
    expect(items.some((x: { class_subject_id: string }) => x.class_subject_id === cs2)).toBe(false)
    // A module of another class's course is not a parent here.
    const r = await unit('Sneaky', u2)
    expect([400, 403]).toContain(r.status)
    expect((await api('teacher', 'PUT', `/lms/units/${S1}`, { parent_unit_id: u2 })).status).toBeGreaterThanOrEqual(400)
  })
})
