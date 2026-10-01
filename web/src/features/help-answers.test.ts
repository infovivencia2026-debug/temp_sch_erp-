import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ROLES } from '../catalog.gen'

/* EVERY SCREEN THE ASSISTANT NAMES EXISTS.
 *
 * The assistant's fast path (worker/src/routes/misc/assistant.ts, matchHelp)
 * answers "how do I…" from a generated table of screens. It was once built
 * from a superseded spreadsheet and sent staff to 177 screens that did not
 * exist. scripts/gen_answers.py now builds it from catalog.gen.ts and the
 * screen registry; this holds the file to that: each row's role, screen name
 * and workspace must be a catalogued feature the SPA maps to a screen, and
 * every such feature must have a row. Stale? `python3 scripts/gen_answers.py`.
 */

const SRC = resolve(process.cwd(), 'src')
const DATA = resolve(process.cwd(), '..', 'worker', 'src', 'routes', 'misc', 'assistant', 'help_answers_data.ts')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return walk(p)
    return p.endsWith('.ts') || p.endsWith('.tsx') ? [p] : []
  })
}

function mappedKeys(): Set<string> {
  const out = new Set<string>()
  for (const file of walk(join(SRC, 'features'))) {
    if (!(file.endsWith('registry.ts') || file.endsWith('-keys.ts'))) continue
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/'([a-z_]+\.[a-z_0-9]+\.[a-z_0-9]+)':\s*(?:screen|lazy)\(/g)) out.add(m[1])
  }
  return out
}

type Row = [string, string, string, string, string[], string[], string[]]

function helpRows(): Row[] {
  const src = readFileSync(DATA, 'utf8')
  const line = src.split('\n').find((l) => l.startsWith('export const HELP_ANSWERS'))
  if (!line) throw new Error('no HELP_ANSWERS in ' + DATA)
  return JSON.parse(line.slice(line.indexOf('= ') + 2)) as Row[]
}

describe('assistant help answers', () => {
  const mapped = mappedKeys()
  const screens = new Map<string, { workspace: string; section: string }>()
  for (const r of ROLES) {
    for (const s of r.sections) {
      for (const f of s.features) {
        if (mapped.has(f.key) && f.tier !== 'optional') {
          screens.set(`${r.key}|${f.name.toLowerCase()}`, { workspace: s.workspace, section: s.name })
        }
      }
    }
  }
  const rows = helpRows()

  it('names only screens that exist, where they are', () => {
    const missing = rows
      .filter(([role, name, where]) => screens.get(`${role}|${name.toLowerCase()}`)?.workspace !== where)
      .map(([role, name, where]) => `${role}: ${name} (${where})`)
    expect(missing).toEqual([])
  })

  it('points each answer at the sidebar path of its screen', () => {
    const wrong = rows.filter(([role, name, , answer]) => {
      const s = screens.get(`${role}|${name.toLowerCase()}`)
      return !s || !answer.includes(`${s.workspace}`) || !answer.includes(name)
    })
    expect(wrong.map((r) => `${r[0]}: ${r[1]}`)).toEqual([])
  })

  it('has an answer for every screen', () => {
    const have = new Set(rows.map(([role, name]) => `${role}|${name.toLowerCase()}`))
    expect([...screens.keys()].filter((k) => !have.has(k))).toEqual([])
  })
})
