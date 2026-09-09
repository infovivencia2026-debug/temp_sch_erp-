import { describe, it, expect } from 'vitest'
import { ROLES } from '@/catalog.gen'
import { FEATURE_ICONS, SECTION_ICONS, DEFAULT_ICON, featureIcon } from './feature-icons'
import subset from '@/assets/fonts/material-symbols-rounded-subset.json'

const NAME = /^[a-z0-9_]+$/

describe('feature icons', () => {
  const features = ROLES.flatMap((r) => r.sections.flatMap((s) => s.features))
  const sections = ROLES.flatMap((r) => r.sections)

  it('gives every feature in the catalogue an icon of its own', () => {
    const missing = features.filter((f) => !FEATURE_ICONS[f.slug]).map((f) => f.key)
    expect(missing).toEqual([])
    expect(features.length).toBeGreaterThan(0)
  })

  it('gives every section a fallback', () => {
    const missing = sections.filter((s) => !SECTION_ICONS[s.slug]).map((s) => s.slug)
    expect(missing).toEqual([])
  })

  it('names are Material Symbols ligatures, never letters to display', () => {
    for (const v of [...Object.values(FEATURE_ICONS), ...Object.values(SECTION_ICONS), DEFAULT_ICON]) {
      expect(v).toMatch(NAME)
    }
  })

  it('every name is in the vendored font subset (run scripts/subset-icons.sh otherwise)', () => {
    const have = new Set(subset as string[])
    const absent = [...new Set([...Object.values(FEATURE_ICONS), ...Object.values(SECTION_ICONS), DEFAULT_ICON])]
      .filter((n) => !have.has(n))
    expect(absent).toEqual([])
  })

  it('no section paints all its features with one icon', () => {
    for (const s of sections) {
      if (s.features.length < 3) continue
      const distinct = new Set(s.features.map((f) => FEATURE_ICONS[f.slug]))
      expect(distinct.size, s.slug).toBeGreaterThan(1)
    }
  })

  it('falls back feature -> section -> default', () => {
    expect(featureIcon('fees')).toBe('payments')
    expect(featureIcon('no_such_thing', 'transport')).toBe('directions_bus')
    expect(featureIcon('no_such_thing', 'no_such_section')).toBe(DEFAULT_ICON)
    expect(featureIcon('no_such_thing')).toBe(DEFAULT_ICON)
  })
})
