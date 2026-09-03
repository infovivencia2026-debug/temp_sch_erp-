import { describe, expect, it } from 'vitest'
import {
  DOMAINS, PERSONALITIES, SPECS, contrast, hslTriplet, renderPersonalityCss, tokensFor,
} from './personality'

/* The brief's own floor: text at 4.5:1, large text and controls at 3:1. The
   two specified palettes are copied verbatim, so where one of their roles
   falls under the floor the test states which, rather than the palette being
   quietly adjusted. */
describe('personalities', () => {
  it('every personality fills every role in both polarities', () => {
    for (const s of SPECS) {
      if (s.id === 'classic') continue
      for (const r of [s.light, s.dark]) {
        expect(r, s.id).not.toBeNull()
        expect(r!.accents).toHaveLength(4)
        expect(r!.domains).toHaveLength(DOMAINS.length)
        for (const v of Object.values(r!).flat()) expect(v).toMatch(/^#[0-9A-Fa-f]{6}$/)
      }
    }
  })

  it('ink and secondary read on the card, and the brand contrast reads on the brand', () => {
    for (const s of SPECS) {
      for (const [pol, r] of [['light', s.light], ['dark', s.dark]] as const) {
        if (!r) continue
        const tag = `${s.id} ${pol}`
        expect(contrast(r.ink, r.card), `${tag} ink/card`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(r.ink, r.ground), `${tag} ink/ground`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(r.secondary, r.card), `${tag} secondary/card`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(r.muted, r.card), `${tag} muted/card`).toBeGreaterThanOrEqual(3)
        expect(contrast(r.primaryContrast, r.primary), `${tag} contrast/primary`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('converts hex to the triplet tailwind wraps', () => {
    expect(hslTriplet('#FFFFFF')).toBe('0 0% 100%')
    expect(hslTriplet('#2563EB')).toBe('221.2 83.2% 53.3%')
  })

  it('renders a block per polarity per personality, and none for classic', () => {
    const css = renderPersonalityCss()
    for (const id of PERSONALITIES) {
      const has = css.includes(`html[data-personality='${id}']`)
      expect(has, id).toBe(id !== 'classic')
      if (id !== 'classic') expect(css).toContain(`html.dark[data-personality='${id}']`)
    }
    const t = tokensFor(SPECS[4].light!)
    expect(t['--bento-orange']).toBe('#FF3B00')
    expect(t['--primary']).toBe(hslTriplet('#FF3B00'))
    expect(Object.keys(t).length).toBeGreaterThan(60)
  })
})
