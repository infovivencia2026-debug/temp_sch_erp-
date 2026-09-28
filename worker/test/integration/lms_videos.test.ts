/* The LMS video library: a multipart upload through the Worker (start,
   parts, resume, complete, abort), playback with HTTP Range (206, Accept-Ranges,
   Content-Range, 416), and who may play what: a child only a video in a
   lesson they can see. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, as, signIn, IDS, E } from './fixture'
import { PART_SIZE, parseRange } from '../../src/routes/teaching/videos'

let child = ''

async function put(who: string, path: string, bytes: Uint8Array, type = 'application/octet-stream') {
  const res = await call('/api/v1' + path, { method: 'PUT', cookie: who, headers: { 'content-type': type }, body: bytes })
  const text = await res.text()
  let body: any = text
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body }
}

async function stream(cookie: string, id: string, range?: string) {
  return call(`/api/v1/lms/videos/${id}/stream`, { cookie, headers: range ? { range } : {} })
}

const pattern = (n: number) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = i % 251; return b }

/** A whole small video in one part; returns its id. */
async function smallVideo(title: string) {
  const bytes = pattern(1000)
  const s = await api('teacher', 'POST', '/lms/videos/uploads', { filename: `${title}.mp4`, size_bytes: bytes.length, title })
  expect(s.status).toBe(200)
  expect((await put(await as('teacher'), `/lms/videos/${s.body.id}/parts/1`, bytes)).status).toBe(200)
  expect((await api('teacher', 'POST', `/lms/videos/${s.body.id}/complete`, { duration_seconds: 60 })).status).toBe(200)
  return s.body.id as string
}

beforeAll(async () => {
  await seed()
  // The child's own login, so the child side is tested as the child.
  await api('admin', 'PUT', '/admin/student-logins', { enabled: true, min_level: 1 })
  const b = await api('admin', 'POST', '/setup/logins/bulk', { kind: 'students', section_id: IDS.section })
  const row = (b.body.rows as { admission_no: string; sign_in_as: string; password?: string }[]).find((r) => r.admission_no === 'A001')!
  let pw = row.password
  if (!pw) {
    // Issued by another file sharing storage: that file set this password.
    pw = 'chirag-own-password-1'
  }
  const s = await signIn(row.sign_in_as, pw)
  child = s.cookie!
  if (row.password) {
    const ch = await call('/api/v1/profile/password', { method: 'POST', cookie: child, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current_password: row.password, new_password: 'video-child-password-1' }) })
    expect(ch.status).toBe(200)
  }
  expect(child).toBeTruthy()
})

describe('parseRange', () => {
  it('reads the forms a browser sends', () => {
    expect(parseRange('bytes=0-1', 100)).toEqual({ offset: 0, length: 2 })
    expect(parseRange('bytes=10-', 100)).toEqual({ offset: 10, length: 90 })
    expect(parseRange('bytes=-10', 100)).toEqual({ offset: 90, length: 10 })
    expect(parseRange('bytes=90-500', 100)).toEqual({ offset: 90, length: 10 })
    expect(parseRange('bytes=100-', 100)).toBe('bad')
    expect(parseRange('bytes=5-2', 100)).toBe('bad')
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull()
  })
})

describe('multipart upload', () => {
  const size = PART_SIZE * 2 + 1234
  let id = ''

  it('refuses a type that is not a video, and a file over the school limit', async () => {
    expect((await api('teacher', 'POST', '/lms/videos/uploads', { filename: 'notes.pdf', size_bytes: 10 })).status).toBe(400)
    const big = await api('teacher', 'POST', '/lms/videos/uploads', { filename: 'huge.mp4', size_bytes: 3 * 1024 ** 3 })
    expect(big.status).toBe(400)
    expect(big.body.code).toBe('too_large')
    expect((await api('parent', 'POST', '/lms/videos/uploads', { filename: 'a.mp4', size_bytes: 10 })).status).toBe(403)
  })

  it('starts, takes parts out of order, resumes, and completes', async () => {
    const s = await api('teacher', 'POST', '/lms/videos/uploads', { filename: 'Lesson one.MOV', size_bytes: size, title: 'Fractions explained' })
    expect(s.status).toBe(200)
    expect(s.body).toMatchObject({ part_size: PART_SIZE, parts: 3, content_type: 'video/quicktime' })
    id = s.body.id
    const t = await as('teacher')
    const all = pattern(size)
    // A part of the wrong size is refused.
    expect((await put(t, `/lms/videos/${id}/parts/1`, all.slice(0, 100))).status).toBe(400)
    expect((await put(t, `/lms/videos/${id}/parts/3`, all.slice(2 * PART_SIZE))).status).toBe(200)
    expect((await put(t, `/lms/videos/${id}/parts/1`, all.slice(0, PART_SIZE))).status).toBe(200)
    // Completing early names what is missing.
    const early = await api('teacher', 'POST', `/lms/videos/${id}/complete`, {})
    expect(early.status).toBe(409)
    expect(early.body.missing).toEqual([2])
    // A reload resumes from the parts received.
    const v = await api('teacher', 'GET', `/lms/videos/${id}`)
    expect(v.body.parts_received).toEqual([1, 3])
    expect((await put(t, `/lms/videos/${id}/parts/2`, all.slice(PART_SIZE, 2 * PART_SIZE))).status).toBe(200)
    const done = await api('teacher', 'POST', `/lms/videos/${id}/complete`, { duration_seconds: 125.5 })
    expect(done.status).toBe(200)
    const obj = await E.FILES_WRITE.head(`lms-videos/${IDS.school}/${id}.mov`)
    expect(obj?.size).toBe(size)
    // Nothing went to the live bucket.
    expect(await E.FILES.head(`lms-videos/${IDS.school}/${id}.mov`)).toBeNull()
    const lib = await api('teacher', 'GET', '/lms/videos?q=fractions')
    expect(lib.body.items[0]).toMatchObject({ id, status: 'ready', size_bytes: size, duration_seconds: 125.5 })
    expect(lib.body.usage.used_bytes).toBeGreaterThanOrEqual(size)
  })

  it('stores a thumbnail and renames', async () => {
    const t = await as('teacher')
    expect((await put(t, `/lms/videos/${id}/thumbnail`, pattern(500), 'image/jpeg')).status).toBe(200)
    expect((await put(t, `/lms/videos/${id}/thumbnail`, pattern(500), 'text/html')).status).toBe(400)
    expect((await api('teacher', 'PATCH', `/lms/videos/${id}`, { title: 'Fractions, part 1' })).status).toBe(200)
    const th = await call(`/api/v1/lms/videos/${id}/thumbnail`, { cookie: t })
    expect(th.status).toBe(200)
    expect(th.headers.get('content-type')).toBe('image/jpeg')
  })

  it('an abort throws the parts away and marks the upload failed', async () => {
    const s = await api('teacher', 'POST', '/lms/videos/uploads', { filename: 'x.webm', size_bytes: 5000 })
    expect((await api('teacher', 'POST', `/lms/videos/${s.body.id}/abort`, {})).status).toBe(200)
    expect((await put(await as('teacher'), `/lms/videos/${s.body.id}/parts/1`, pattern(5000))).status).toBe(409)
    const v = await api('teacher', 'GET', `/lms/videos/${s.body.id}`)
    expect(v.body.status).toBe('failed')
  })

  it('serves Range requests: 206 with Content-Range, whole with 200, 416 past the end', async () => {
    const t = await as('teacher')
    const whole = await stream(t, id)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect(whole.headers.get('content-length')).toBe(String(size))
    await whole.body?.cancel()
    const first = await stream(t, id, 'bytes=0-1')
    expect(first.status).toBe(206)
    expect(first.headers.get('content-range')).toBe(`bytes 0-1/${size}`)
    expect([...new Uint8Array(await first.arrayBuffer())]).toEqual([0, 1])
    // Across a part boundary, as a seek would ask.
    const mid = await stream(t, id, `bytes=${PART_SIZE - 2}-${PART_SIZE + 1}`)
    expect(mid.status).toBe(206)
    expect(mid.headers.get('content-length')).toBe('4')
    expect([...new Uint8Array(await mid.arrayBuffer())]).toEqual([0, 1, 2, 3].map((i) => (PART_SIZE - 2 + i) % 251))
    const open = await stream(t, id, `bytes=${size - 10}-`)
    expect(open.status).toBe(206)
    expect(open.headers.get('content-range')).toBe(`bytes ${size - 10}-${size - 1}/${size}`)
    await open.body?.cancel()
    const past = await stream(t, id, `bytes=${size}-`)
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe(`bytes */${size}`)
  })
})

describe('who may play', () => {
  let inLesson = '', loose = '', draft = '', lesson = ''

  it('a lesson picks a video from the library', async () => {
    inLesson = await smallVideo('In a lesson')
    loose = await smallVideo('Not in any lesson')
    draft = await smallVideo('In a draft')
    const u = await api('teacher', 'POST', '/lms/units', { section_id: IDS.section, class_subject_id: IDS.classSubject, title: 'Videos unit' })
    const l = await api('teacher', 'POST', '/lms/lessons', { unit_id: u.body.id, title: 'Watch this', kind: 'video', video_id: inLesson })
    expect(l.status).toBe(200)
    lesson = l.body.id
    expect((await api('teacher', 'POST', '/lms/lessons', { unit_id: u.body.id, title: 'Draft', kind: 'video', video_id: draft, is_published: false })).status).toBe(200)
    // A video that is not in the library is refused.
    expect((await api('teacher', 'POST', '/lms/lessons', { unit_id: u.body.id, title: 'x', kind: 'video', video_id: '00000000-0000-4000-8000-999999999999' })).status).toBe(400)
    const c = await api('teacher', 'GET', `/lms/course?section_id=${IDS.section}&class_subject_id=${IDS.classSubject}`)
    const found = c.body.units.flatMap((x: { lessons: unknown[] }) => x.lessons).find((x: { id: string }) => x.id === lesson)
    expect(found).toMatchObject({ video_id: inLesson, video_title: 'In a lesson', url: null })
  })

  it('the child plays a video in a lesson they can see, and nothing else', async () => {
    const ok = await stream(child, inLesson, 'bytes=0-99')
    expect(ok.status).toBe(206)
    await ok.body?.cancel()
    expect((await stream(child, loose)).status).toBe(404)
    expect((await stream(child, draft)).status).toBe(404)
    // A parent of a child in the class may watch too; staff with no lesson using it may not.
    const p = await stream(await as('parent'), inLesson, 'bytes=0-1')
    expect(p.status).toBe(206)
    expect((await stream(await as('finance'), inLesson)).status).toBe(404)
    // A child's library is empty (it lists only one's own uploads), and a child cannot upload.
    const lib = await call('/api/v1/lms/videos', { cookie: child })
    if (lib.status === 200) expect(((await lib.json()) as { items: unknown[] }).items).toEqual([])
    else expect(lib.status).toBe(403)
    expect((await call('/api/v1/lms/videos/uploads', { method: 'POST', cookie: child, headers: { 'content-type': 'application/json' }, body: '{"filename":"a.mp4","size_bytes":5}' })).status).toBe(403)
  })

  it('saves where the child is, and 90% watched finishes the lesson', async () => {
    const post = (body: unknown) => call(`/api/v1/portal/lms/lessons/${lesson}/video-progress`, { method: 'POST', cookie: child, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    // 60 s in 5 s buckets = 12; the first half.
    let r = await (await post({ position: 30, watched: '111111000000' })).json() as any
    expect(r).toMatchObject({ percent: 50, done: false, position: 30 })
    r = await (await post({ position: 58, watched: '000000111110' })).json() as any
    expect(r).toMatchObject({ percent: 92, done: true })
    const c = await (await call(`/api/v1/portal/lms/course?class_subject_id=${IDS.classSubject}`, { cookie: child })).json() as any
    const l = c.modules.flatMap((m: any) => m.days).flatMap((d: any) => d.items).find((i: any) => i.id === lesson)?.lesson
    expect(l).toMatchObject({ done: true, video_position: 58, video_percent: 92 })
    const g = await (await call(`/api/v1/portal/lms/lessons/${lesson}/video-progress`, { cookie: child })).json() as any
    expect(g).toMatchObject({ position: 58, percent: 92, bucket_seconds: 5 })
    // A parent cannot record the child's watching.
    expect((await api('parent', 'POST', `/portal/lms/lessons/${lesson}/video-progress`, { position: 1, watched: '1' })).status).toBe(403)
  })

  it('deleting a video removes the object and takes it out of lessons', async () => {
    const d = await api('teacher', 'DELETE', `/lms/videos/${inLesson}`)
    expect(d.status).toBe(200)
    expect(d.body.lessons_cleared).toBe(1)
    expect(await E.FILES_WRITE.head(`lms-videos/${IDS.school}/${inLesson}.mp4`)).toBeNull()
    expect((await stream(child, inLesson)).status).toBe(404)
  })
})
