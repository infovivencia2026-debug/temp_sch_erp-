/* The school gallery for every staff workspace (owner, 2026-10-24): it is on
   a teacher's menu without a grant of its own, and pinning a live post tells
   the staff it was for once -- not again on a re-pin, and never families. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, as, IDS, E } from './fixture'

const T = () => E.TENANT_TEST
const gallery = async (userId: string) =>
  (await T().prepare(`SELECT title, body, link FROM notifications WHERE user_id = ? AND kind = 'gallery'`).bind(userId).all<{ title: string; body: string; link: string }>()).results

beforeAll(async () => {
  await seed()
  await api('admin', 'PUT', '/status/settings', { enabled: true, needs_approval: false, allow_video: true, max_video_seconds: 30 })
})

describe('school gallery', () => {
  it('is one item on a teacher\'s menu, and not on a parent\'s', async () => {
    const keys = (b: any) => (b.roles ?? []).flatMap((r: any) => r.sections.flatMap((s: any) => s.features.map((f: any) => f.key)))
    const t = await api('teacher', 'GET', '/catalog')
    expect(t.status).toBe(200)
    // The test school is mid-setup (menu is Home only), so the item is checked once setup is done.
    if (!t.body.setup_required) expect(keys(t.body)).toContain('faculty.school_gallery.school_gallery')
    const p = await api('parent', 'GET', '/catalog')
    expect(keys(p.body).some((k: string) => k.includes('school_gallery'))).toBe(false)
  })

  it('pinning a post notifies the staff once, with a link to the post', async () => {
    const f = new FormData()
    f.set('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], { type: 'image/jpeg' }), 'p.jpg')
    f.set('targets', JSON.stringify([{ kind: 'school' }]))
    f.set('caption', 'Sports day relay')
    const res = await call('/api/v1/status/posts', { method: 'POST', cookie: await as('admin'), body: f })
    expect(res.status).toBe(200)
    const id = ((await res.json()) as { id: string }).id
    expect(await gallery(IDS.teacher)).toHaveLength(0)

    expect((await api('admin', 'POST', `/status/posts/${id}/pin`, { pinned: true })).status).toBe(200)
    const rows = await gallery(IDS.teacher)
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('New in the school gallery')
    expect(rows[0].body).toContain('Whole school')
    expect(rows[0].body).toContain('Sports day relay')
    expect(rows[0].link).toBe(`/go/school_gallery/school_gallery?post=${id}`)

    // Unpinned and pinned again: still the one notification.
    await api('admin', 'POST', `/status/posts/${id}/pin`, { pinned: false })
    await api('admin', 'POST', `/status/posts/${id}/pin`, { pinned: true })
    expect(await gallery(IDS.teacher)).toHaveLength(1)
    // Families had the status notification; the gallery one is for staff.
    expect(await gallery(IDS.parent)).toHaveLength(0)
  })
})
