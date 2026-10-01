import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/* EVERY WIRED SCREEN HANGS OFF A KEY THE CATALOGUE STILL HAS.
 *
 * A screen reaches a person through a catalogue key: `'role.section.slug':
 * screen(() => import('./Thing'))` in registry.ts or one of the `*-keys.ts`
 * files. reachable.test.ts guards the other half -- a screen file nobody
 * imports -- and cannot see this one, because these screens ARE imported.
 * Their key simply no longer exists in catalog.gen.ts: the feature was
 * renamed, re-sectioned or dropped from docs/edu_features.csv, and the SPA
 * went on mapping a key the menu will never emit. The screen compiles,
 * type-checks, and is dead; even a direct URL answers "not in your
 * workspace". live-tracking-keys.ts records this happening once already.
 *
 * Twenty were frozen here when this test was written. By 2026-09-29 every one
 * was resolved: the finished screens with live endpoints behind them got their
 * catalogue rows back (as 'advanced' features: off the sidebar, found by
 * search), and the keys that were a second door to a screen another key
 * already opens were deleted. KNOWN is empty; keep it so. Add a dead key and
 * this fails, naming it.
 */

const SRC = resolve(process.cwd(), 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return walk(p)
    return p.endsWith('.ts') || p.endsWith('.tsx') ? [p] : []
  })
}

/** Keys the catalogue actually defines. */
function catalogKeys(): Set<string> {
  const src = readFileSync(join(SRC, 'catalog.gen.ts'), 'utf8')
  return new Set([...src.matchAll(/\bkey:\s*'([^']+)'/g)].map((m) => m[1]))
}

/** Every key mapped to a screen, and the file that maps it. */
function mappedKeys(): Map<string, string> {
  const out = new Map<string, string>()
  for (const file of walk(join(SRC, 'features'))) {
    if (!(file.endsWith('registry.ts') || file.endsWith('-keys.ts'))) continue
    const src = readFileSync(file, 'utf8')
    // Both spellings a keys file uses: screen(() => import(...)) and the
    // older bare lazy(() => import(...)).
    for (const m of src.matchAll(/'([a-z_]+\.[a-z_0-9]+\.[a-z_0-9]+)':\s*(?:screen|lazy)\(/g)) {
      out.set(m[1], file.slice(SRC.length + 1))
    }
  }
  return out
}

/* Dead keys tolerated. Empty; never grow it. */
const KNOWN = new Set<string>([])

describe('every wired screen key exists in the catalogue', () => {
  const catalog = catalogKeys()
  const mapped = mappedKeys()
  const dead = [...mapped.keys()].filter((k) => !catalog.has(k)).sort()

  it('adds no new dead key', () => {
    expect(dead.filter((k) => !KNOWN.has(k))).toEqual([])
  })

  it('does not list a key that has since been fixed', () => {
    const live = new Set(dead)
    expect([...KNOWN].filter((k) => !live.has(k)).sort()).toEqual([])
  })
})
