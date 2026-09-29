/* D1 health (docs/d1-health.md): the read-replica session with its bookmark
   (tenant.ts tenantSession) and the reference-data cache with its version key
   (services/refcache.ts, tenant migration 0015). */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { seed, api, call, as, E, IDS } from './fixture'
import { BOOKMARK_HEADER, bookmarkFrom, tenantSession, type Institution } from '../../src/tenant'
import { SCHOOL, cachedRef, invalidateRef, setRefTtl, refTtl, schoolOf } from '../../src/services/refcache'

const T = () => E.TENANT_TEST
const version = async () => (await T().prepare(`SELECT version FROM ref_versions WHERE key = 'ref'`).first<{ version: number }>())!.version
const school = async () => (await E.CONTROL.prepare('SELECT * FROM institutions WHERE id = ?').bind(IDS.school).first<Institution>())!

beforeAll(seed)
const ttl0 = refTtl()
afterEach(() => setRefTtl(ttl0))

/** A fake binding that records the constraint each session was opened with. */
function recordingDb(real: D1Database) {
  const opened: string[] = []
  const db = Object.create(real) as D1Database
  ;(db as unknown as { withSession: (c: string) => D1DatabaseSession }).withSession = (c: string) => {
    opened.push(c)
    const s = real.withSession(c)
    return { prepare: (q: string) => s.prepare(q), batch: (x: D1PreparedStatement[]) => s.batch(x), getBookmark: () => 'bm-after-' + c } as unknown as D1DatabaseSession
  }
  return { db, opened }
}

describe('bookmark / session helper', () => {
  it('reads only a bookmark minted for this school', () => {
    const r = (v?: string) => new Request('https://x/', { headers: v ? { [BOOKMARK_HEADER]: v } : {} })
    expect(bookmarkFrom(r(), IDS.school)).toBeNull()
    expect(bookmarkFrom(r(`${IDS.school}:abc`), IDS.school)).toBe('abc')
    expect(bookmarkFrom(r(`${IDS.admin}:abc`), IDS.school)).toBeNull()
    expect(bookmarkFrom(r('abc'), IDS.school)).toBeNull()
  })

  it('starts a GET unconstrained, a write on the primary, and a bookmarked request from its bookmark', async () => {
    const inst = await school()
    const { db, opened } = recordingDb(T())
    const env = { ...E, [inst.d1_binding]: db } as typeof E
    tenantSession(env, inst, new Request('https://x/', { method: 'GET' }))
    tenantSession(env, inst, new Request('https://x/', { method: 'POST' }))
    tenantSession(env, inst, new Request('https://x/', { method: 'GET', headers: { [BOOKMARK_HEADER]: `${inst.id}:bm-7` } }))
    tenantSession(env, inst, new Request('https://x/', { method: 'GET', headers: { [BOOKMARK_HEADER]: `other-school:bm-7` } }))
    expect(opened).toEqual(['first-unconstrained', 'first-primary', 'bm-7', 'first-unconstrained'])
  })

  it('hands the session bookmark back on the response, tagged with the school', async () => {
    const inst = await school()
    const { db } = recordingDb(T())
    const env = { ...E, [inst.d1_binding]: db } as typeof E
    const s = tenantSession(env, inst, new Request('https://x/', { method: 'POST' }))
    expect(schoolOf(s.db)).toBe(inst.id)
    // Reads and writes go through the session.
    expect(await s.db.prepare('SELECT 1 AS one').first('one')).toBe(1)
    const res = s.finish(new Response('ok'))
    expect(res.headers.get(BOOKMARK_HEADER)).toBe(`${inst.id}:bm-after-first-primary`)
  })

  it('the real Worker answers with a bookmark, and a write is read back with it', async () => {
    const first = await call('/api/v1/ref-data', { cookie: await as('admin') })
    expect(first.status).toBe(200)
    const bm = first.headers.get(BOOKMARK_HEADER)
    expect(bm).toMatch(new RegExp(`^${IDS.school}:.+`))
    const made = await call('/api/v1/setup/classes', {
      method: 'POST', cookie: await as('admin'),
      headers: { 'content-type': 'application/json', [BOOKMARK_HEADER]: bm! },
      body: JSON.stringify({ name: 'Class 9 bookmark', level: 9 }),
    })
    expect(made.status).toBeLessThan(300)
    const after = made.headers.get(BOOKMARK_HEADER)
    expect(after).toMatch(new RegExp(`^${IDS.school}:.+`))
    const again = await call('/api/v1/ref-data', { cookie: await as('admin'), headers: { [BOOKMARK_HEADER]: after! } })
    const body = await again.json() as { classes: { name: string }[] }
    expect(body.classes.map((c) => c.name)).toContain('Class 9 bookmark')
    await T().prepare(`DELETE FROM sections WHERE class_id IN (SELECT id FROM classes WHERE name = 'Class 9 bookmark')`).run()
    await T().prepare(`DELETE FROM classes WHERE name = 'Class 9 bookmark'`).run()
  })
})

describe('reference cache version', () => {
  const tagged = () => Object.assign(Object.create(T()) as D1Database, { [SCHOOL]: 'cache-test-school' })

  it('any write to classes, sections, subjects or years bumps the version', async () => {
    const v0 = await version()
    await T().prepare(`UPDATE classes SET name = name WHERE id = ?`).bind(IDS.klass).run()
    const v1 = await version()
    expect(v1).toBe(v0 + 1)
    await T().prepare(`UPDATE subjects SET name = name WHERE id = ?`).bind(IDS.subject).run()
    await T().prepare(`UPDATE sections SET name = name WHERE id = ?`).bind(IDS.section).run()
    await T().prepare(`UPDATE academic_years SET name = name WHERE id = ?`).bind(IDS.year).run()
    expect(await version()).toBe(v1 + 3)
  })

  it('serves from memory until the version moves, then reloads', async () => {
    setRefTtl(0) // re-read the version on every call
    invalidateRef('cache-test-school')
    const db = tagged()
    let loads = 0
    const load = async () => { loads++; return (await T().prepare(`SELECT count(*) AS n FROM classes`).first<{ n: number }>())!.n }
    const a = await cachedRef(db, 'n', load)
    const b = await cachedRef(db, 'n', load)
    expect(loads).toBe(1)
    expect(b).toBe(a)
    await T().prepare(`INSERT INTO classes (id, institution_id, campus_id, name, level)
        SELECT '00000000-0000-4000-8000-0000000c0ffe', institution_id, campus_id, 'Cache test', 11 FROM classes WHERE id = ?`).bind(IDS.klass).run()
    const c = await cachedRef(db, 'n', load)
    expect(loads).toBe(2)
    expect(c).toBe(a + 1)
    await T().prepare(`DELETE FROM classes WHERE id = '00000000-0000-4000-8000-0000000c0ffe'`).run()
  })

  it('within the TTL the version is not re-read; invalidateRef forces it', async () => {
    setRefTtl(60_000)
    invalidateRef('cache-test-school')
    const db = tagged()
    let loads = 0
    const load = async () => ++loads
    await cachedRef(db, 'k', load)
    await T().prepare(`UPDATE classes SET name = name WHERE id = ?`).bind(IDS.klass).run()
    expect(await cachedRef(db, 'k', load)).toBe(1) // trusted for the TTL
    invalidateRef('cache-test-school')
    expect(await cachedRef(db, 'k', load)).toBe(2)
  })

  it('an untagged handle is never cached', async () => {
    let loads = 0
    await cachedRef(T(), 'x', async () => ++loads)
    await cachedRef(T(), 'x', async () => ++loads)
    expect(loads).toBe(2)
  })

  it('ref-data answers through the cache with every year', async () => {
    const r1 = await api('admin', 'GET', '/ref-data')
    expect(r1.status).toBe(200)
    expect(r1.body.academic_years.map((y: { id: string }) => y.id)).toContain(IDS.year)
  })
})
