import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/* No hook below an early return.
 *
 * React counts hooks per render, so a hook that only runs once the data has
 * arrived makes the second render call more hooks than the first — error #310,
 * "rendered more hooks than during the previous render". The screen dies with a
 * minified stack that says nothing about which file it was.
 *
 * It happened twice in one afternoon, both times the same way: a `useMutation`
 * added next to the JSX that uses it, below an `if (q.isLoading) return`
 * written months earlier. The mistake is invisible in review because the two
 * lines are two hundred apart, and invisible in TypeScript because both halves
 * are perfectly valid.
 *
 * So it is a test. Crude on purpose — it reads the top level of each exported
 * component, finds the first unconditional early return, and fails if a hook
 * call appears after it at the same indentation. Nested functions are indented
 * further and are not the bug being hunted.
 */

/* From the runner's root, not from import.meta.url.

   These tests run in a browser-like environment, where import.meta.url is an
   http: URL rather than a file: one — so `new URL('..', …).pathname` came out
   as the bare "/src", an absolute path that does not exist. readdirSync threw,
   and because the throw happened while collecting the file rather than inside
   the assertion, the whole check reported as one failure and had never
   actually walked a single component. */
const SRC = resolve(process.cwd(), 'src')
const HOOK = /^ {2}(?:const|let)\s[^=]*=\s*use[A-Z]\w*\(/
const EARLY_RETURN = /^ {2}if \(.*\)\s*return\s/
// Anything declared at column 0 opens a fresh hook scope. Without this the
// check bleeds from one component into the next and reports twelve hundred
// findings, which is the same as reporting none.
const BOUNDARY = /^(?:export\s+)?(?:default\s+)?(?:function|const)\s+[A-Za-z_]/

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return walk(p)
    return p.endsWith('.tsx') ? [p] : []
  })
}

describe('hook order', () => {
  it('has no hook below an early return', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      let returnedAt = -1
      lines.forEach((line, i) => {
        if (BOUNDARY.test(line)) {
          returnedAt = -1
          return
        }
        if (EARLY_RETURN.test(line) && returnedAt === -1) returnedAt = i
        else if (returnedAt !== -1 && HOOK.test(line)) {
          offenders.push(
            `${file.replace(SRC, '')}:${i + 1} — ${line.trim().slice(0, 60)} ` +
              `(after the early return on line ${returnedAt + 1})`,
          )
        }
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
