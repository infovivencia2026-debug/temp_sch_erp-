import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/* RESPONSIVE ON EVERY SCREEN (owner, 2026-10-26: "all phones and browsers,
   no overlapping and overlaying"). Two things that came back before:

   - A height in plain vh. On iOS Safari and Android Chrome 100vh is the
     height with the browser bars hidden, so a sheet or list sized in vh runs
     under the bottom bar. Use dvh; postcss-fallbacks.js writes the vh copy
     for old engines.
   - Floating controls without the safe-area inset. styles/page-foot.css adds
     it to the dock corner, the assistant orb and `.float-safe` once. */
const SRC = join(__dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p)
  }
  return out
}

describe('responsive guard', () => {
  it('sizes heights in dvh, not vh', () => {
    const bad: string[] = []
    for (const f of walk(SRC)) {
      const lines = readFileSync(f, 'utf8').split('\n')
      lines.forEach((l, i) => {
        if (/\b(?:min-|max-)?h-\[[^\]\s]*\d(?:\.\d+)?vh\b/.test(l)) bad.push(`${relative(SRC, f).split(sep).join('/')}:${i + 1}`)
      })
    }
    expect(bad).toEqual([])
  })

  it('floating controls carry the safe-area inset', () => {
    const css = readFileSync(join(SRC, 'styles/page-foot.css'), 'utf8')
    for (const sel of ['.bento-corner', '[data-assistant-orb]', '.float-safe']) expect(css).toContain(sel)
    expect(css).toContain('env(safe-area-inset-left')
    expect(css).toContain('env(safe-area-inset-right')
    expect(readFileSync(join(SRC, 'components/LiveToasts.tsx'), 'utf8')).toContain('float-safe')
  })
})
