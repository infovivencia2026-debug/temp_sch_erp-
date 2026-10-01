/* Class Status: posting to an audience, who can see and fetch it, views and
   the unseen count, the bell entry (audience only, collapsed per poster), the
   24-hour sweep (row and R2 object), approval, posting as the school, the
   school's management list and the switch. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { seed, api, call, as, IDS, E } from './fixture'
import { expireStatuses } from '../../src/services/class_status'

const SECTION_B = '00000000-0000-4000-8000-000000000913'

async function post(who: 'teacher' | 'admin', targets: { kind: string; id?: string }[], extra: Record<string, string> = {}, type = 'image/jpeg') {
  const f = new FormData()
  f.set('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5])], { type }), type.startsWith('video') ? 'clip.mp4' : 'photo.jpg')
  f.set('targets', JSON.stringify(targets))
  for (const [k, v] of Object.entries(extra)) f.set(k, v)
  const res = await call('/api/v1/status/posts', { method: 'POST', cookie: await as(who), body: f })
  const text = await res.text()
  let body: any = text
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body }
}

const settings = (b: Record<string, unknown>) => api('admin', 'PUT', '/status/settings', b)
const bellStatus = async (who: 'parent' | 'otherParent' | 'finance') =>
  (await E.TENANT_TEST.prepare(`SELECT id, title, read_at FROM notifications WHERE user_id = ? AND kind = 'status'`)
    .bind(who === 'parent' ? IDS.parent : who === 'otherParent' ? IDS.otherParent : IDS.finance).all<{ id: string; title: string; read_at: string | null }>()).results

beforeAll(async () => {
  await seed()
  await E.TENANT_TEST.prepare(`INSERT OR IGNORE INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name)
      SELECT ?, institution_id, campus_id, class_id, academic_year_id, 'B' FROM sections WHERE id = ?`).bind(SECTION_B, IDS.section).run()
  await settings({ enabled: true, needs_approval: false, who: 'teachers', allow_video: true, max_video_seconds: 30 })
})
afterAll(async () => { await settings({ enabled: true, needs_approval: false }) })

describe('class status', () => {
  let first = ''

  it('a teacher posts to their section; its families see it, and the bell rings for them only', async () => {
    const p = await post('teacher', [{ kind: 'section', id: IDS.section }], { caption: 'Sports day' })
    expect(p.status).toBe(200)
    expect(p.body.status).toBe('live')
    first = p.body.id
    const feed = await api('parent', 'GET', '/status/feed')
    expect(feed.status).toBe(200)
    const ring = feed.body.rings.find((r: any) => r.poster_id === IDS.teacher)
    expect(ring.posts.map((x: any) => x.id)).toContain(first)
    expect(ring.posts.find((x: any) => x.id === first).caption).toBe('Sports day')
    expect((await bellStatus('parent')).length).toBe(1)
    expect((await bellStatus('parent'))[0].title).toContain('Tara Teacher added a status')
    expect((await bellStatus('finance')).length).toBe(0)
    const media = await call(`/api/v1/status/posts/${first}/media`, { cookie: await as('parent') })
    expect(media.status).toBe(200)
    expect(media.headers.get('content-type')).toBe('image/jpeg')
  })

  it('a teacher cannot post to a section they do not teach', async () => {
    expect((await post('teacher', [{ kind: 'section', id: SECTION_B }])).status).toBe(403)
  })

  it('a second post by the same poster updates the bell entry rather than adding one', async () => {
    const p = await post('teacher', [{ kind: 'class', id: IDS.klass }])
    expect(p.status).toBe(200)
    expect((await bellStatus('parent')).length).toBe(1)
  })

  it('a parent of another section neither sees nor fetches it', async () => {
    const p = await post('admin', [{ kind: 'section', id: SECTION_B }], { caption: 'B only' })
    expect(p.status).toBe(200)
    const feed = await api('parent', 'GET', '/status/feed')
    expect(feed.body.rings.flatMap((r: any) => r.posts).some((x: any) => x.id === p.body.id)).toBe(false)
    expect((await call(`/api/v1/status/posts/${p.body.id}/media`, { cookie: await as('parent') })).status).toBe(404)
    expect((await api('parent', 'POST', `/status/posts/${p.body.id}/view`)).status).toBe(404)
    const adminBell = await E.TENANT_TEST.prepare(`SELECT count(*) AS n FROM notifications WHERE kind = 'status' AND user_id = ? AND title LIKE '%B'`)
      .bind(IDS.parent).first<{ n: number }>()
    expect(adminBell?.n).toBe(0)
  })

  it('views are recorded once; the unseen count and the bell go down', async () => {
    const before = (await api('parent', 'GET', '/status/unseen')).body.unseen
    expect(before).toBeGreaterThanOrEqual(2)
    expect((await api('parent', 'POST', `/status/posts/${first}/view`)).body.counted).toBe(true)
    expect((await api('parent', 'POST', `/status/posts/${first}/view`)).body.counted).toBe(false)
    expect((await api('parent', 'GET', '/status/unseen')).body.unseen).toBe(before - 1)
    // The rest of this poster's posts seen: the bell entry is read.
    const feed = await api('parent', 'GET', '/status/feed')
    for (const x of feed.body.rings.find((r: any) => r.poster_id === IDS.teacher).posts) await api('parent', 'POST', `/status/posts/${x.id}/view`)
    expect((await bellStatus('parent'))[0].read_at).toBeTruthy()
    const views = await api('teacher', 'GET', `/status/posts/${first}/views`)
    expect(views.status).toBe(200)
    expect(views.body.views).toBe(1)
    expect(views.body.items[0].full_name).toBe('Pavan Parent')
    expect(views.body.items[0].student_name).toContain('Chirag')
    expect((await api('otherParent', 'GET', `/status/posts/${first}/views`)).status).toBe(404)
  })

  it('the hourly sweep deletes expired unpinned posts and their objects, and keeps pinned ones', async () => {
    const a = (await post('teacher', [{ kind: 'section', id: IDS.section }])).body.id
    const b = (await post('teacher', [{ kind: 'section', id: IDS.section }])).body.id
    expect((await api('teacher', 'POST', `/status/posts/${b}/pin`, { pinned: true })).body.pinned).toBe(true)
    const key = (await E.TENANT_TEST.prepare(`SELECT object_key FROM status_posts WHERE id = ?`).bind(a).first<{ object_key: string }>())!.object_key
    expect(await E.FILES_WRITE.head(key)).toBeTruthy()
    await E.TENANT_TEST.prepare(`UPDATE status_posts SET expires_at = '2000-01-01T00:00:00Z' WHERE id IN (?, ?)`).bind(a, b).run()
    expect(await expireStatuses(E, E.TENANT_TEST)).toBeGreaterThanOrEqual(1)
    expect(await E.TENANT_TEST.prepare(`SELECT 1 FROM status_posts WHERE id = ?`).bind(a).first()).toBeNull()
    expect(await E.FILES_WRITE.head(key)).toBeNull()
    expect(await E.TENANT_TEST.prepare(`SELECT 1 FROM status_posts WHERE id = ?`).bind(b).first()).toBeTruthy()
    const feed = await api('parent', 'GET', '/status/feed')
    expect(feed.body.gallery.map((x: any) => x.id)).toContain(b)
  })

  it('with approval on, a teacher post waits for the principal and nobody sees it until approved', async () => {
    await settings({ needs_approval: true })
    const p = await post('teacher', [{ kind: 'section', id: IDS.section }], { caption: 'Waiting' })
    expect(p.body.status).toBe('pending')
    let feed = await api('otherParent', 'GET', '/status/feed')
    expect(feed.body.rings.flatMap((r: any) => r.posts).some((x: any) => x.id === p.body.id)).toBe(false)
    const queue = await api('admin', 'GET', '/status/admin/posts?status=pending')
    expect(queue.body.items.map((x: any) => x.id)).toContain(p.body.id)
    expect((await api('teacher', 'POST', `/status/posts/${p.body.id}/approve`)).status).toBe(403)
    expect((await api('admin', 'POST', `/status/posts/${p.body.id}/approve`)).body.status).toBe('live')
    feed = await api('otherParent', 'GET', '/status/feed')
    expect(feed.body.rings.flatMap((r: any) => r.posts).some((x: any) => x.id === p.body.id)).toBe(true)
    const r = await post('teacher', [{ kind: 'section', id: IDS.section }])
    expect((await api('admin', 'POST', `/status/posts/${r.body.id}/reject`)).body.status).toBe('rejected')
    await settings({ needs_approval: false })
  })

  it('posts as the school to the staff: the school ring is first, families do not see it, staff are told', async () => {
    expect((await post('teacher', [{ kind: 'staff' }], { as_school: '1' })).status).toBe(403)
    const p = await post('admin', [{ kind: 'staff' }], { as_school: '1', caption: 'Staff meeting at 4' })
    expect(p.status).toBe(200)
    const feed = await api('finance', 'GET', '/status/feed')
    expect(feed.body.rings[0].as_school).toBe(true)
    expect(feed.body.rings[0].posts[0].id).toBe(p.body.id)
    const fam = await api('parent', 'GET', '/status/feed')
    expect(fam.body.rings.some((r: any) => r.as_school)).toBe(false)
    expect((await bellStatus('finance')).length).toBe(1)
    const list = await api('admin', 'GET', '/status/admin/posts')
    const row = list.body.items.find((x: any) => x.id === p.body.id)
    expect(row.as_school).toBe(true)
    expect(row.audience).toBe('Staff')
    expect((await api('admin', 'GET', '/status/summary')).body.live).toBeGreaterThanOrEqual(1)
    expect((await api('teacher', 'GET', '/status/admin/posts')).status).toBe(403)
  })

  it('videos follow the school rules', async () => {
    expect((await post('teacher', [{ kind: 'section', id: IDS.section }], { duration_seconds: '45' }, 'video/mp4')).body.code).toBe('too_long')
    expect((await post('teacher', [{ kind: 'section', id: IDS.section }], { duration_seconds: '12' }, 'video/mp4')).status).toBe(200)
    await settings({ allow_video: false })
    expect((await post('teacher', [{ kind: 'section', id: IDS.section }], { duration_seconds: '12' }, 'video/mp4')).body.code).toBe('no_video')
    await settings({ allow_video: true })
  })

  it('the admin deletes any post', async () => {
    const p = await post('teacher', [{ kind: 'section', id: IDS.section }])
    expect((await api('otherParent', 'DELETE', `/status/posts/${p.body.id}`)).status).toBe(404)
    expect((await api('admin', 'DELETE', `/status/posts/${p.body.id}`)).body.deleted).toBe(true)
  })

  it('a thumbnail is stored with the post and served only to its audience', async () => {
    const thumb = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 9, 9, 9])], { type: 'image/jpeg' })
    const f = new FormData()
    f.set('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], { type: 'image/jpeg' }), 'p.jpg')
    f.set('thumb', thumb, 't.jpg')
    f.set('targets', JSON.stringify([{ kind: 'section', id: IDS.section }]))
    const res = await call('/api/v1/status/posts', { method: 'POST', cookie: await as('teacher'), body: f })
    expect(res.status).toBe(200)
    const id = (await res.json() as any).id
    const feed = await api('parent', 'GET', '/status/feed')
    const item = feed.body.rings.flatMap((r: any) => r.posts).find((x: any) => x.id === id)
    // The address is signed for this viewer (status_perf.test.ts); the path is the post's.
    expect(item.thumb.split('?')[0]).toBe(`/api/v1/status/posts/${id}/thumb`)
    expect(item.thumb).toMatch(/\?exp=\d+&sig=[\w-]+$/)
    const got = await call(`/api/v1/status/posts/${id}/thumb`, { cookie: await as('parent') })
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/jpeg')
    expect(new Uint8Array(await got.arrayBuffer())[3]).toBe(9)
    // Not in the audience (staff who do not teach the section): 404.
    expect((await call(`/api/v1/status/posts/${id}/thumb`, { cookie: await as('finance') })).status).toBe(404)
    // A post without one has no thumb route.
    expect((await call(`/api/v1/status/posts/${first}/thumb`, { cookie: await as('parent') })).status).toBe(404)
    // Deleting the post takes the thumbnail object with it.
    const key = (await E.TENANT_TEST.prepare(`SELECT thumb_key FROM status_posts WHERE id = ?`).bind(id).first<{ thumb_key: string }>())!.thumb_key
    expect(await E.FILES_WRITE.head(key)).toBeTruthy()
    expect((await api('teacher', 'DELETE', `/status/posts/${id}`)).body.deleted).toBe(true)
    expect(await E.FILES_WRITE.head(key)).toBeNull()
  })

  it('refuses a thumbnail that is not a picture', async () => {
    const f = new FormData()
    f.set('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: 'image/jpeg' }), 'p.jpg')
    f.set('thumb', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 't.svg')
    f.set('targets', JSON.stringify([{ kind: 'section', id: IDS.section }]))
    expect((await call('/api/v1/status/posts', { method: 'POST', cookie: await as('teacher'), body: f })).status).toBe(400)
  })

  it('a text status: words on the school colour, no media, seen by its audience only', async () => {
    const empty = await post('teacher', [{ kind: 'section', id: IDS.section }], { kind: 'text', caption: '   ' })
    expect(empty.status).toBe(400)
    const p = await post('teacher', [{ kind: 'section', id: IDS.section }], { kind: 'text', caption: 'Holiday tomorrow!' })
    expect(p.status).toBe(200)
    expect(p.body.status).toBe('live')
    const feed = await api('parent', 'GET', '/status/feed')
    const item = feed.body.rings.flatMap((r: any) => r.posts).find((x: any) => x.id === p.body.id)
    expect(item.media_kind).toBe('text')
    expect(item.caption).toBe('Holiday tomorrow!')
    expect(item.url).toBe('')
    expect(item.thumb).toBeUndefined()
    const other = await api('finance', 'GET', '/status/feed')
    expect(other.body.rings.flatMap((r: any) => r.posts).some((x: any) => x.id === p.body.id)).toBe(false)
    expect((await call(`/api/v1/status/posts/${p.body.id}/media`, { cookie: await as('parent') })).status).toBe(404)
    expect((await api('parent', 'POST', `/status/posts/${p.body.id}/view`)).body.counted).toBe(true)
    const bell = await bellStatus('parent')
    expect(bell.length).toBe(1)
    expect((await api('teacher', 'DELETE', `/status/posts/${p.body.id}`)).body.deleted).toBe(true)
  })

  it('the switch off hides everything and refuses posting', async () => {
    await settings({ enabled: false })
    const feed = await api('parent', 'GET', '/status/feed')
    expect(feed.body.enabled).toBe(false)
    expect(feed.body.rings).toEqual([])
    expect((await api('parent', 'GET', '/status/unseen')).body.unseen).toBe(0)
    expect((await call(`/api/v1/status/posts/${first}/media`, { cookie: await as('parent') })).status).toBe(404)
    expect((await post('teacher', [{ kind: 'section', id: IDS.section }])).status).toBe(403)
    await settings({ enabled: true })
  })
})
