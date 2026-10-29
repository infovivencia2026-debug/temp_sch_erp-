import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { areaOf, keyCovered, wordsFor } from '@shared/live-areas'

/* The guard for "a change saved by one user shows for every other user"
   (Yajur, 2026-10-27). Fails when a new table of the school database has no
   live area, or a new query key matches no area's words: either one is a
   screen that would stay stale after somebody else's save. */

const ROOT = join(__dirname, '..', '..', '..')

function tables(): string[] {
  const sql = readFileSync(join(ROOT, 'worker', 'db', 'tenant.sql'), 'utf8')
  return [...new Set([...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?["`]?([a-z_0-9]+)/gi)].map((m) => m[1]))]
}

function queryKeys(): string[] {
  const out = new Set<string>()
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p); continue }
      if (!/\.tsx?$/.test(n) || /\.test\.tsx?$/.test(n)) continue
      for (const m of readFileSync(p, 'utf8').matchAll(/queryKey:\s*\[\s*'([^']+)'/g)) out.add(m[1])
    }
  }
  walk(join(ROOT, 'web', 'src'))
  return [...out]
}

describe('live areas cover everything', () => {
  it('every table of the school database belongs to an area', () => {
    const missing = tables().filter((t) => areaOf(t) === null)
    expect(missing, 'add these tables to an area in shared/live-areas.ts').toEqual([])
  })
  it('every query key is refreshed by some area', () => {
    const missing = queryKeys().filter((k) => !keyCovered(k))
    expect(missing, 'add a word for these keys to an area in shared/live-areas.ts').toEqual([])
  })
  it('a staff phone edit refreshes the screens that showed the old one', () => {
    const w = [...(wordsFor(['employees', 'users']) ?? [])]
    for (const k of ['admin-users', 'school-logins', 'people-search', 'profile', 'hr-employees', 'staff-register', 'login-roster'])
      expect(w.some((x) => k.includes(x)), k).toBe(true)
  })
  it('an unknown table refreshes everything; quiet tables nothing', () => {
    expect(wordsFor(['brand_new_table'])).toBeNull()
    expect(wordsFor(['idempotency_keys'])?.size).toBe(0)
  })
})
