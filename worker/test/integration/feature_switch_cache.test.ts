/* The feature-switch cache (routes/seller/features.ts ovCache): a school's
   switches are kept in memory under CONTROL institutions.features_version
   (control migration 0013, bumped by triggers on every write to
   school_feature_overrides). A change made in CONTROL -- by the seller
   console, a rollout, or by hand -- is seen on the very next request, and a
   request that follows an unchanged one reads no switches at all. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { seed, api, E, IDS } from './fixture'
import { featuresVersion } from '../../src/services/refcache'
import { cachedOverrideRows } from '../../src/routes/seller/features'

const C = () => E.CONTROL
const version = async () => (await C().prepare(`SELECT features_version AS v FROM institutions WHERE id = ?`).bind(IDS.school).first<{ v: number }>())!.v
const FEATURE = 'communication.class_status' // gates /status (FEATURE_ROUTES)

/* How often CONTROL is asked for the switches: the binding's prepare, counted. */
let reads = 0
beforeAll(async () => {
  await seed()
  const db = C() as unknown as { prepare: (sql: string) => D1PreparedStatement }
  const prepare = db.prepare.bind(db)
  db.prepare = (sql: string) => { if (/^\s*SELECT[\s\S]*FROM school_feature_overrides/.test(sql)) reads++; return prepare(sql) }
})
afterAll(async () => { await C().prepare(`DELETE FROM school_feature_overrides WHERE institution_id = ?`).bind(IDS.school).run() })

describe('feature switch cache', () => {
  it('the triggers bump the school\'s version on insert, update and delete', async () => {
    const v0 = await version()
    await C().prepare(`INSERT INTO school_feature_overrides (institution_id, feature_id, enabled, note, updated_at) VALUES (?, 'x.probe', 0, '', ?)`).bind(IDS.school, new Date().toISOString()).run()
    expect(await version()).toBe(v0 + 1)
    await C().prepare(`UPDATE school_feature_overrides SET enabled = 1 WHERE institution_id = ? AND feature_id = 'x.probe'`).bind(IDS.school).run()
    expect(await version()).toBe(v0 + 2)
    await C().prepare(`DELETE FROM school_feature_overrides WHERE institution_id = ? AND feature_id = 'x.probe'`).bind(IDS.school).run()
    expect(await version()).toBe(v0 + 3)
  })

  it('a request notes the version and fills the cache; the next request reads no switches', async () => {
    expect((await api('parent', 'GET', '/status/feed')).status).toBe(200)
    expect(featuresVersion(IDS.school)).toBe(await version())
    expect(cachedOverrideRows(IDS.school)).not.toBeNull()
    reads = 0
    expect((await api('parent', 'GET', '/status/feed')).status).toBe(200)
    expect((await api('parent', 'GET', '/catalog')).status).toBe(200)
    expect(reads).toBe(0)
  })

  it('a switch turned off straight in CONTROL is honoured on the next request, and back on when removed', async () => {
    await C().prepare(`INSERT INTO school_feature_overrides (institution_id, feature_id, enabled, note, updated_at) VALUES (?, ?, 0, 'test', ?)
        ON CONFLICT (institution_id, feature_id) DO UPDATE SET enabled = 0`).bind(IDS.school, FEATURE, new Date().toISOString()).run()
    reads = 0
    const off = await api('parent', 'GET', '/status/feed')
    expect(off.status).toBe(403)
    expect(off.body.code).toBe('feature_disabled')
    expect(reads).toBe(1) // the new version was read once...
    expect((await api('parent', 'GET', '/status/feed')).status).toBe(403)
    expect(reads).toBe(1) // ...and served from memory after that
    await C().prepare(`DELETE FROM school_feature_overrides WHERE institution_id = ? AND feature_id = ?`).bind(IDS.school, FEATURE).run()
    expect((await api('parent', 'GET', '/status/feed')).status).toBe(200)
    expect(reads).toBe(2)
  })

  it('a lapsed override stops counting without a new read', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    await C().prepare(`INSERT INTO school_feature_overrides (institution_id, feature_id, enabled, ends_at, note, updated_at) VALUES (?, ?, 0, ?, 'lapsed', ?)`)
      .bind(IDS.school, FEATURE, past, past).run()
    expect((await api('parent', 'GET', '/status/feed')).status).toBe(200)
    // The seller's own view still lists it, lapsed and all.
    expect(cachedOverrideRows(IDS.school)?.some((r) => r.feature_id === FEATURE)).toBe(true)
    await C().prepare(`DELETE FROM school_feature_overrides WHERE institution_id = ? AND feature_id = ?`).bind(IDS.school, FEATURE).run()
  })
})
