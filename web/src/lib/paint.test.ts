import { describe, expect, it } from 'vitest'
import { BUILT_IN_PALETTES, DEFAULT_PALETTE } from './paint'

/* A palette is a promise about every token, not most of them.

   Two things can go wrong silently when a palette is added: a missing key,
   which leaves that one surface wearing the previous theme, and a colour that
   was picked by eye, which leaves text that cannot be read. Neither shows up
   in a type check — the tokens are a plain string map — so they are measured
   here instead. */

const rgb = (hex: string) => {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}
const luminance = (hex: string) =>
  rgb(hex)
    .map((v) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    .reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0)
const contrast = (a: string, b: string) => {
  const l1 = luminance(a)
  const l2 = luminance(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

const FLOOR = 4.6
const DOMAINS = [
  'students', 'academics', 'finance', 'operations', 'reports', 'staff',
  'admissions', 'attendance', 'communication', 'critical', 'success', 'warning',
] as const

describe('built-in palettes', () => {
  const reference = Object.keys(BUILT_IN_PALETTES[0].tokens).sort()

  it('all define the same token set', () => {
    for (const p of BUILT_IN_PALETTES) {
      expect(Object.keys(p.tokens).sort(), p.name).toEqual(reference)
    }
  })

  it('define every domain triple', () => {
    for (const p of BUILT_IN_PALETTES) {
      for (const d of DOMAINS) {
        for (const suffix of ['', '-soft', '-text']) {
          expect(p.tokens[`--dom-${d}${suffix}`], `${p.name} --dom-${d}${suffix}`)
            .toMatch(/^#[0-9a-f]{6}$/)
        }
      }
    }
  })

  it('clear 4.6:1 wherever text sits on a surface', () => {
    for (const p of BUILT_IN_PALETTES) {
      const card = p.tokens['--bento-card']
      const pairs: [string, string, string][] = [
        ['ink on card', p.tokens['--bento-ink'], card],
        ['muted on card', p.tokens['--bento-muted'], card],
        ['dock ink on dock', p.tokens['--bento-dock-ink'], p.tokens['--bento-dock-bg']],
        ['anchor ink on from', p.tokens['--bento-anchor-ink'], p.tokens['--bento-anchor-from']],
        ['anchor ink on to', p.tokens['--bento-anchor-ink'], p.tokens['--bento-anchor-to']],
      ]
      for (const a of ['mint', 'purple', 'pink', 'orange']) {
        pairs.push([`${a} on card`, p.tokens[`--bento-${a}`], card])
      }
      for (const d of DOMAINS) {
        pairs.push([`${d} on card`, p.tokens[`--dom-${d}`], card])
        pairs.push([`${d} text on soft`, p.tokens[`--dom-${d}-text`], p.tokens[`--dom-${d}-soft`]])
      }
      for (const [what, fg, bg] of pairs) {
        expect(contrast(fg, bg), `${p.name}: ${what}`).toBeGreaterThanOrEqual(FLOOR)
      }
    }
  })

  it('ships a default that exists', () => {
    expect(BUILT_IN_PALETTES.map((p) => p.name)).toContain(DEFAULT_PALETTE)
  })
})
