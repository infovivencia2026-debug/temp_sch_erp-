/* What Class Status costs to look at. A strip of rings is one feed read and
   then a thumbnail per post; opening a ring is the media and a "seen" per
   post. Each of those used to work out who the viewer is from scratch (the
   switch, their sections and children, the post, the audience test), so a
   family opening the app with twenty statuses paid for it about forty times.
   The feed now signs each address for the person it was built for, and the
   byte and "seen" routes check that signature and read one row.

   Counted the way perf.test.ts counts: statements prepared on the school's
   database in one request. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, as, IDS, E } from './fixture'

/* Reads the sign-in itself makes on the school's database when the identity
   cache is off, as it is in tests (4: the user, roles, permissions, direct
   grants). In production these are cached and the figures below are the
   whole cost. */
const SIGN_IN = 4
const SHOW = false
const log: string[] = []
const wrap = (db: D1Database) => {
  const d = db as unknown as Record<string, unknown>
  const prepare = db.prepare.bind(db), withSession = db.withSession.bind(db)
  d.prepare = (sql: string) => { log.push(sql); return prepare(sql) }
  d.withSession = (constraint?: string) => {
    const s = withSession(constraint as never)
    return { prepare: (sql: string) => { log.push(sql); return s.prepare(sql) }, batch: (x: D1PreparedStatement[]) => s.batch(x), getBookmark: () => s.getBookmark() }
  }
}

async function post(extra: Record<string, string> = {}) {
  const f = new FormData()
  f.set('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5])], { type: 'image/jpeg' }), 'photo.jpg')
  f.set('thumb', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 9])], { type: 'image/jpeg' }), 'thumb.jpg')
  f.set('targets', JSON.stringify([{ kind: 'section', id: IDS.section }]))
  for (const [k, v] of Object.entries(extra)) f.set(k, v)
  const res = await call('/api/v1/status/posts', { method: 'POST', cookie: await as('teacher'), body: f })
  return (await res.json()) as { id: string }
}

async function count(who: 'parent' | 'otherParent' | 'finance', path: string, method = 'GET') {
  const cookie = await as(who)
  log.length = 0
  const res = await call(path, { method, cookie })
  await res.arrayBuffer()
  if (SHOW) console.log(path.slice(0, 60), '\n  ' + log.map((x) => x.replace(/\s+/g, ' ').trim().slice(0, 110)).join('\n  '))
  return { status: res.status, reads: log.length, cache: res.headers.get('cache-control') ?? '' }
}

let item: { id: string; url: string; thumb: string; seen_url: string }
beforeAll(async () => {
  await seed()
  await api('admin', 'PUT', '/status/settings', { enabled: true, needs_approval: false, who: 'teachers', allow_video: true, max_video_seconds: 30 })
  wrap(E.TENANT_TEST)
  const p = await post({ caption: 'Counted' })
  const feed = await api('parent', 'GET', '/status/feed')
  item = feed.body.rings.flatMap((r: any) => r.posts).find((x: any) => x.id === p.id)
})

describe('class status: what a look costs', () => {
  it('the feed is a handful of reads, however many posts', async () => {
    for (let i = 0; i < 5; i++) await post({ caption: `More ${i}` })
    const f = await count('parent', '/api/v1/status/feed')
    expect(f.status).toBe(200)
    console.log('feed reads', f.reads)
    // Was 15 and still is: the feed is the one place the whole question is asked.
    expect(f.reads).toBeLessThanOrEqual(SIGN_IN + 11)
  })

  it('a thumbnail and the media are one read each, and the browser may keep them', async () => {
    const t = await count('parent', item.thumb)
    const m = await count('parent', item.url)
    console.log('thumb reads', t.reads, '| media reads', m.reads)
    expect(t.status).toBe(200)
    expect(m.status).toBe(200)
    // Were 15 each.
    expect(t.reads).toBe(SIGN_IN + 1)
    expect(m.reads).toBe(SIGN_IN + 1)
    expect(t.cache).toContain('private')
    expect(t.cache).toContain('immutable')
    expect(m.cache).toContain('private')
  })

  it('marking a post seen is a few reads', async () => {
    const v = await count('parent', item.seen_url + '&last=1', 'POST')
    console.log('view reads', v.reads)
    expect(v.status).toBe(200)
    // Was 18: the post, the view, the bell.
    expect(v.reads).toBe(SIGN_IN + 3)
    const seen = await E.TENANT_TEST.prepare('SELECT student_id FROM status_views WHERE post_id = ? AND user_id = ?').bind(item.id, IDS.parent).first<{ student_id: string | null }>()
    expect(seen?.student_id).toBe(IDS.child)
    const bell = await E.TENANT_TEST.prepare(`SELECT read_at FROM notifications WHERE user_id = ? AND kind = 'status'`).bind(IDS.parent).first<{ read_at: string | null }>()
    expect(bell?.read_at).toBeTruthy()
  })

  it('an address signed for one person does not open for another, nor with a changed signature', async () => {
    // The other parent is in the same section: allowed, but through the full check, not on this signature.
    const other = await count('finance', item.url)
    expect(other.status).toBe(404)
    const bare = item.url.split('?')[0]
    expect((await count('finance', bare)).status).toBe(404)
    const forged = item.url.replace(/sig=[^&]+/, 'sig=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    expect((await count('finance', forged)).status).toBe(404)
    // Without a signature the old check still answers the people in the audience.
    expect((await count('parent', bare)).status).toBe(200)
    expect((await count('otherParent', bare)).status).toBe(200)
  })
})
