/* Class Status, the gaps closed after the first cut: the teachers of a
   section or class are told of a post to it; a video's length is read from
   the file itself and held to the school's maximum; the front office posts
   as the school; the principal's board carries live and waiting counts. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { seed, api, call, as, signIn, IDS, E, PASSWORD } from './fixture'
import { hashPassword } from '../../src/auth/password'
import { SYSTEM_ROLES } from '../../src/routes/admin/static_data'
import { mp4DurationSeconds, tinyMp4 } from '../../src/services/video_meta'
import migrationSql from '../../migrations/tenant/0022_front_office_status.sql?raw'

const T = () => E.TENANT_TEST
const SECTION_B = '00000000-0000-4000-8000-000000000913'
const MATHS_TEACHER = '00000000-0000-4000-8000-000000000931' // teaches Maths in section A (section_subject_teachers)
const B_TEACHER = '00000000-0000-4000-8000-000000000932'     // on the timetable in section B only
const RECEPTION = '00000000-0000-4000-8000-000000000933'     // front_office

async function post(who: string, targets: { kind: string; id?: string }[], extra: Record<string, string> = {}, file?: { bytes: Uint8Array; type: string; name: string }) {
  const f = new FormData()
  const b = file ?? { bytes: new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), type: 'image/jpeg', name: 'p.jpg' }
  f.set('file', new Blob([b.bytes], { type: b.type }), b.name)
  f.set('targets', JSON.stringify(targets))
  for (const [k, v] of Object.entries(extra)) f.set(k, v)
  const res = await call('/api/v1/status/posts', { method: 'POST', cookie: who, body: f })
  const text = await res.text()
  let body: any = text
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body }
}
const bell = async (userId: string) =>
  (await T().prepare(`SELECT title FROM notifications WHERE user_id = ? AND kind = 'status'`).bind(userId).all<{ title: string }>()).results

const cookies: Record<string, string> = {}
const cookieOf = async (email: string) => (cookies[email] ??= (await signIn(email)).cookie!)

beforeAll(async () => {
  await seed()
  const t = new Date().toISOString(), hash = await hashPassword(E.PASSWORD_PEPPER, PASSWORD)
  const role = async (key: string) => (await T().prepare('SELECT id FROM roles WHERE key = ?').bind(key).first<{ id: string }>())?.id
  const user = (uid: string, email: string, name: string) => T().prepare(`INSERT OR IGNORE INTO users (id, institution_id, email, full_name, password_hash, status, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)`).bind(uid, IDS.school, email, name, hash, t, t)
  const grant = (uid: string, rid: string) => T().prepare(`INSERT OR IGNORE INTO user_roles (id, institution_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(uid + '-r', IDS.school, uid, rid, t)
  /* front_office is an optional role: created here from the Worker's own seed
     (static_data SYSTEM_ROLES), as POST /setup/roles would. */
  const fo = SYSTEM_ROLES.find((r) => r.key === 'front_office')!
  const foId = (await role('front_office')) ?? '00000000-0000-4000-8000-000000000934'
  const faculty = (await role('faculty'))!
  await T().batch([
    T().prepare(`INSERT OR IGNORE INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name)
        SELECT ?, institution_id, campus_id, class_id, academic_year_id, 'B' FROM sections WHERE id = ?`).bind(SECTION_B, IDS.section),
    T().prepare(`INSERT OR IGNORE INTO roles (id, institution_id, key, name, is_system, created_at) VALUES (?, ?, 'front_office', ?, 1, ?)`).bind(foId, IDS.school, fo.name, t),
    T().prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT ?, value FROM json_each(?)`).bind(foId, JSON.stringify(fo.permissions)),
    user(MATHS_TEACHER, 'maths@test.school', 'Meena Maths'), grant(MATHS_TEACHER, faculty),
    user(B_TEACHER, 'bee@test.school', 'Bala B'), grant(B_TEACHER, faculty),
    user(RECEPTION, 'reception@test.school', 'Rani Reception'), grant(RECEPTION, foId),
    T().prepare(`INSERT OR IGNORE INTO section_subject_teachers (id, institution_id, section_id, class_subject_id, teacher_user_id) VALUES (?, ?, ?, ?, ?)`)
      .bind(MATHS_TEACHER + '-sst', IDS.school, IDS.section, IDS.classSubject, MATHS_TEACHER),
  ])
  // Bala is on section B's timetable: one bell schedule, one period, one entry.
  const campus = (await T().prepare('SELECT campus_id FROM sections WHERE id = ?').bind(IDS.section).first<{ campus_id: string }>())!.campus_id
  const bellId = B_TEACHER + '-bell', periodId = B_TEACHER + '-p1'
  await T().batch([
    T().prepare(`INSERT OR IGNORE INTO bell_schedules (id, institution_id, campus_id, name, is_default) VALUES (?, ?, ?, 'Gaps test bells', 0)`).bind(bellId, IDS.school, campus),
    T().prepare(`INSERT OR IGNORE INTO periods (id, institution_id, campus_id, name, sequence, starts_at, ends_at, is_break, bell_schedule_id) VALUES (?, ?, ?, 'P1', 1, '09:00', '09:40', 0, ?)`)
      .bind(periodId, IDS.school, campus, bellId),
    T().prepare(`INSERT OR IGNORE INTO timetable_entries (id, institution_id, academic_year_id, section_id, period_id, weekday, class_subject_id, teacher_user_id) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .bind(B_TEACHER + '-te', IDS.school, IDS.year, SECTION_B, periodId, IDS.classSubject, B_TEACHER),
  ])
  await E.CONTROL.batch([['maths@test.school', MATHS_TEACHER], ['bee@test.school', B_TEACHER], ['reception@test.school', RECEPTION]].map(([e, uid]) =>
    E.CONTROL.prepare(`INSERT OR IGNORE INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, ?, ?, ?)`).bind(e, IDS.school, uid, t)))
  await api('admin', 'PUT', '/status/settings', { enabled: true, needs_approval: false, who: 'teachers', allow_video: true, max_video_seconds: 30 })
})
afterAll(async () => { await api('admin', 'PUT', '/status/settings', { enabled: true, needs_approval: false, allow_video: true, max_video_seconds: 30 }) })

describe('class status: who is told', () => {
  it('a post to a section reaches its subject teacher and class teacher, not a teacher of another section', async () => {
    const p = await post(await as('admin'), [{ kind: 'section', id: IDS.section }], { caption: 'Section A trip' })
    expect(p.status).toBe(200)
    // The title no longer names the audience (4a743ccc: families read it too),
    // so the subject teacher is checked by having been told at all.
    expect((await bell(MATHS_TEACHER)).length).toBe(1)
    expect((await bell(IDS.teacher)).length).toBe(1) // the class teacher
    expect((await bell(B_TEACHER)).length).toBe(0)
    expect((await bell(IDS.finance)).length).toBe(0)
    // The teacher sees it in the feed too (visible() already reached taught sections).
    const feed = await api('admin', 'GET', '/status/feed')
    expect(feed.status).toBe(200)
    const mine = await call('/api/v1/status/feed', { cookie: await cookieOf('maths@test.school') })
    const body = await mine.json() as any
    expect(body.rings.flatMap((r: any) => r.posts).some((x: any) => x.id === p.body.id)).toBe(true)
  })

  it('a post to the whole class reaches every teacher of any of its sections', async () => {
    await T().prepare(`DELETE FROM notifications WHERE kind = 'status'`).run()
    const p = await post(await as('admin'), [{ kind: 'class', id: IDS.klass }], { caption: 'Class 5 fete' })
    expect(p.status).toBe(200)
    expect((await bell(MATHS_TEACHER)).length).toBe(1)
    expect((await bell(IDS.teacher)).length).toBe(1)
    expect((await bell(B_TEACHER)).length).toBe(1) // on section B's timetable, and B is in the class
    expect((await bell(IDS.finance)).length).toBe(0)
    expect((await bell(IDS.parent)).length).toBe(1)
    // The management list sizes the audience in one read and counts them: two families, three teachers.
    const list = await api('admin', 'GET', '/status/admin/posts')
    const row = list.body.items.find((x: any) => x.id === p.body.id)
    expect(row.audience_size).toBeGreaterThanOrEqual(5)
  })
})

describe('class status: video length', () => {
  it('reads the movie header of an MP4, at the back of the file and in both header versions', () => {
    expect(mp4DurationSeconds(tinyMp4(12.5).buffer as ArrayBuffer)).toBeCloseTo(12.5, 3)
    expect(mp4DurationSeconds(tinyMp4(45, 1).buffer as ArrayBuffer)).toBeCloseTo(45, 3)
    expect(mp4DurationSeconds(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]).buffer as ArrayBuffer)).toBeNull()
    expect(mp4DurationSeconds(new TextEncoder().encode('\x1aE\xdf\xa3 webm-ish bytes here, long enough').buffer as ArrayBuffer)).toBeNull()
  })

  it('the file decides: a 45 s MP4 is refused whatever the browser said, a 12 s one goes up', async () => {
    const t = await as('teacher')
    const long = await post(t, [{ kind: 'section', id: IDS.section }], { duration_seconds: '12' }, { bytes: tinyMp4(45), type: 'video/mp4', name: 'long.mp4' })
    expect(long.status).toBe(400)
    expect(long.body.code).toBe('too_long')
    expect(long.body.duration_seconds).toBe(45)
    expect(long.body.max_video_seconds).toBe(30)
    const short = await post(t, [{ kind: 'section', id: IDS.section }], { duration_seconds: '45' }, { bytes: tinyMp4(12), type: 'video/mp4', name: 'short.mp4' })
    expect(short.status).toBe(200)
    const stored = await T().prepare(`SELECT duration_seconds FROM status_posts WHERE id = ?`).bind(short.body.id).first<{ duration_seconds: number }>()
    expect(stored?.duration_seconds).toBeCloseTo(12, 3)
    // A MOV carries the same header.
    const mov = await post(t, [{ kind: 'section', id: IDS.section }], { duration_seconds: '5' }, { bytes: tinyMp4(31), type: 'video/quicktime', name: 'clip.mov' })
    expect(mov.body.code).toBe('too_long')
  })

  it('falls back to the browser\'s figure when the file cannot be read: WebM, or a broken MP4', async () => {
    const t = await as('teacher')
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    expect((await post(t, [{ kind: 'section', id: IDS.section }], { duration_seconds: '45' }, { bytes: webm, type: 'video/webm', name: 'c.webm' })).body.code).toBe('too_long')
    expect((await post(t, [{ kind: 'section', id: IDS.section }], { duration_seconds: '12' }, { bytes: webm, type: 'video/webm', name: 'c.webm' })).status).toBe(200)
    const broken = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9])
    expect((await post(t, [{ kind: 'section', id: IDS.section }], { duration_seconds: '12' }, { bytes: broken, type: 'video/mp4', name: 'b.mp4' })).status).toBe(200)
    expect((await post(t, [{ kind: 'section', id: IDS.section }], {}, { bytes: broken, type: 'video/mp4', name: 'b.mp4' })).status).toBe(400)
  })
})

describe('class status: the front office and the board', () => {
  it('the Worker seed, the Go seed and the migration all give front_office status.post and status.post_school', () => {
    const fo = SYSTEM_ROLES.find((r) => r.key === 'front_office')!
    expect(fo.permissions).toContain('status.post')
    expect(fo.permissions).toContain('status.post_school')
    const mig = migrationSql
    expect(mig).toMatch(/'status\.post_school' FROM roles WHERE key = 'front_office'/)
    expect(mig).toMatch(/'status\.post' FROM roles WHERE key = 'front_office'/)
  })

  it('the receptionist posts as the school; a teacher still cannot', async () => {
    const r = await cookieOf('reception@test.school')
    const p = await post(r, [{ kind: 'school' }], { as_school: '1', caption: 'Gates close at 4' })
    expect(p.status).toBe(200)
    expect(p.body.status).toBe('live')
    const feed = await api('parent', 'GET', '/status/feed')
    expect(feed.body.rings[0].as_school).toBe(true)
    expect(feed.body.rings[0].posts.some((x: any) => x.id === p.body.id)).toBe(true)
    expect((await post(await as('teacher'), [{ kind: 'school' }], { as_school: '1' })).status).toBe(403)
    // The front office is not the school's management: no approvals or settings.
    expect((await call('/api/v1/status/admin/posts', { cookie: r })).status).toBe(403)
  })

  it('the principal\'s dashboard carries status.live and status.pending', async () => {
    await api('admin', 'PUT', '/status/settings', { needs_approval: true })
    const waiting = await post(await as('teacher'), [{ kind: 'section', id: IDS.section }])
    expect(waiting.body.status).toBe('pending')
    const d = await api('admin', 'GET', '/principal/dashboard')
    expect(d.status).toBe(200)
    expect(d.body.status.pending).toBeGreaterThanOrEqual(1)
    expect(d.body.status.live).toBeGreaterThanOrEqual(1)
    expect(d.body.as_of_now).toContain('status')
    const s = await api('admin', 'GET', '/status/summary')
    expect(s.body).toEqual({ enabled: true, live: d.body.status.live, pending: d.body.status.pending })
    await api('admin', 'PUT', '/status/settings', { needs_approval: false, enabled: false })
    expect((await api('admin', 'GET', '/principal/dashboard')).body.status).toBeUndefined()
    await api('admin', 'PUT', '/status/settings', { enabled: true })
  })
})
