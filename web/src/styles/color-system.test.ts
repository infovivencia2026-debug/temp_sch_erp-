import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { describe, expect, it } from 'vitest'

/* EVERY SYSTEM COLOUR IS MEASURED, NOT ADMIRED.

   color-system.css promises three things per hue -- a vivid value that
   clears 3:1 on the card, a fill that carries white text at 4.5:1, an ink
   that reads at 4.5:1 on both the card and the ground -- in light and in
   dark. This reads the stylesheet, resolves the triplets and holds each
   value to its promise against the surfaces index.css actually ships. */

const css = readFileSync(resolvePath(__dirname, 'color-system.css'), 'utf8')
const index = readFileSync(resolvePath(__dirname, '..', 'index.css'), 'utf8')

function block(src: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = new RegExp(`(^|\\n)\\s*${selector.replace(/[.:]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g')
  for (const m of src.matchAll(re)) {
    for (const line of m[2].split('\n')) {
      const d = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/.exec(line.replace(/\/\*.*?\*\//g, ''))
      if (d) out[d[1]] = d[2].trim()
    }
  }
  return out
}

/* The theme's surfaces: the first :root and .dark blocks in index.css. */
const surfaces = {
  light: block(index.split('.dark {')[0], ':root'),
  dark: block(index, '.dark'),
}

const light = block(css, ':root')
const dark = { ...light, ...block(css, '.dark') }

function hsl(triplet: string): [number, number, number] {
  const m = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%/.exec(triplet)
  if (!m) throw new Error(`not an hsl triplet: ${triplet}`)
  const h = +m[1], s = +m[2] / 100, l = +m[3] / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as [number, number, number]
}

function lum([r, g, b]: [number, number, number]) {
  const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
export function contrast(a: [number, number, number], b: [number, number, number]) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

function resolve(vars: Record<string, string>, name: string, depth = 0): string {
  const v = vars[name]
  if (!v) throw new Error(`${name} is not defined`)
  const m = /^var\((--[a-z0-9-]+)\)$/.exec(v)
  if (m) {
    if (depth > 8) throw new Error(`${name} loops`)
    return resolve(vars, m[1], depth + 1)
  }
  return v
}

const WHITE: [number, number, number] = [255, 255, 255]
const HUES = ['blue', 'green', 'orange', 'red', 'purple', 'teal', 'indigo', 'pink', 'gray', 'brown']
const ROLES = ['accent', 'success', 'warning', 'danger', 'info']

describe.each([
  ['light', light, surfaces.light],
  ['dark', dark, surfaces.dark],
] as const)('%s', (_mode, vars, surf) => {
  const card = hsl(surf['--card'])
  const ground = hsl(surf['--background'])

  it.each(HUES)('--sys-%s: vivid clears 3:1 on the card (non-text contrast)', (h) => {
    expect(contrast(hsl(resolve(vars, `--sys-${h}`)), card)).toBeGreaterThanOrEqual(3)
  })
  it.each(HUES)('--sys-%s-fill: white text clears 4.5:1 on it', (h) => {
    expect(contrast(hsl(resolve(vars, `--sys-${h}-fill`)), WHITE)).toBeGreaterThanOrEqual(4.5)
  })
  it.each(HUES)('--sys-%s-ink: clears 4.5:1 on the card and the ground', (h) => {
    const ink = hsl(resolve(vars, `--sys-${h}-ink`))
    expect(contrast(ink, card)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(ink, ground)).toBeGreaterThanOrEqual(4.5)
  })
  it.each(ROLES)('--sys-%s resolves through all three roles', (r) => {
    expect(() => resolve(vars, `--sys-${r}`)).not.toThrow()
    expect(() => resolve(vars, `--sys-${r}-fill`)).not.toThrow()
    expect(() => resolve(vars, `--sys-${r}-ink`)).not.toThrow()
  })
  it('the rebased theme tokens keep their contracts', () => {
    // --primary carries white text (Button primary, count pills).
    expect(contrast(hsl(resolve(vars, '--primary')), WHITE)).toBeGreaterThanOrEqual(4.5)
    if (_mode === 'light') expect(contrast(hsl(resolve(vars, '--destructive')), WHITE)).toBeGreaterThanOrEqual(4.5)
    // --success/--warning/--info are text on the card (Badge, FormNotice).
    for (const t of ['--success', '--warning', '--info', '--destructive']) {
      expect(contrast(hsl(resolve(vars, t)), card), `${t} on card`).toBeGreaterThanOrEqual(4.5)
    }
    // The switch's ON track is a graphic: 3:1 on the card.
    expect(contrast(hsl(resolve(vars, '--sys-switch-on')), card)).toBeGreaterThanOrEqual(3)
  })
  it('chart series 1..8 are all defined and pairwise distinct', () => {
    const seen = new Set<string>()
    for (let i = 1; i <= 8; i++) {
      const v = resolve(vars, `--chart-${i}`)
      expect(seen.has(v), `chart-${i} repeats a hue`).toBe(false)
      seen.add(v)
      expect(contrast(hsl(v), card)).toBeGreaterThanOrEqual(3)
    }
  })
})
