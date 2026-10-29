import { describe, it, expect } from 'vitest'
import { FEATURE_BY_KEY } from '@/catalog.gen'

/* A key passed to useFeatureHref / useFeatureHrefAny that the catalogue does
   not contain resolves to nothing, and the card it feeds goes dead (owner,
   2026-10-24: the parent's attendance card opened a blank page). Every literal
   key in a call must be a catalogue key. */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

describe('feature href keys', () => {
  it('every literal key passed to useFeatureHref/useFeatureHrefAny is in the catalogue', () => {
    const missing: string[] = []
    for (const [file, src] of Object.entries(sources)) {
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue
      for (const m of src.matchAll(/useFeatureHref(?:Any)?\(\s*(\[[^\]]*\]|'[^']*')/g)) {
        for (const k of m[1].matchAll(/'([^']+)'/g)) {
          if (!FEATURE_BY_KEY.has(k[1])) missing.push(`${file}: ${k[1]}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})
