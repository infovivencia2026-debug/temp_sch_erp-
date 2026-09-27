#!/usr/bin/env node
/* How much of the API is on the shared contract (shared/api), and what is not.

   The web and the Worker describe the same API separately unless a route is
   declared in shared/api and registered with `r.typed(...)` on the Worker and
   called with `api.call(...)` on the web. This lists:

     1. contract routes the Worker does not register with r.typed  (a gap: the
        handler is not checked against the declared shape)
     2. web call sites that reach a contract route through api.get/post/...
        instead of api.call  (the screen's type is an unchecked promise)
     3. Worker routes not on the contract yet, grouped by area, so coverage
        can grow a group at a time

   Usage:
     node scripts/check-api-contract.mjs            report; exit 0
     node scripts/check-api-contract.mjs --strict   exit 1 if (1) or (2) is non-empty
     node scripts/check-api-contract.mjs --all      also print every uncovered route

   Plain text parsing, no TypeScript needed: it reads the "'METHOD /path':"
   keys in shared/api/*.ts and the r.get/post/put/patch/del/typed calls in
   worker/src. A route registered some other way (a loop, a variable path) is
   not seen; the few such routes are listed in SPECIAL below. */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const args = new Set(process.argv.slice(2))

/* Routes served outside the Router (worker/src/index.ts answers them first). */
const SPECIAL = new Set(['GET /session'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules' || name.startsWith('.')) continue
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

// --- the contract -------------------------------------------------------------
const contract = new Map() // "GET /students" -> file
for (const f of walk(join(root, 'shared/api'))) {
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(/^\s*'((?:GET|POST|PUT|PATCH|DELETE) \/[^']*)'\s*:/gm)) contract.set(m[1], relative(root, f))
}

// --- the Worker ---------------------------------------------------------------
const METHOD = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE' }
const typed = new Map()
const plain = new Map()
for (const f of walk(join(root, 'worker/src'))) {
  const src = readFileSync(f, 'utf8')
  const rel = relative(root, f)
  for (const m of src.matchAll(/\br\.typed\(\s*'((?:GET|POST|PUT|PATCH|DELETE) \/[^']*)'/g)) typed.set(m[1], rel)
  for (const m of src.matchAll(/\br\.(get|post|put|patch|del)\(\s*'(\/[^']*)'/g)) plain.set(`${METHOD[m[1]]} ${m[2]}`, rel)
  for (const m of src.matchAll(/\br\.on\(\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*'(\/[^']*)'/g)) plain.set(`${m[1]} ${m[2]}`, rel)
}

const notTyped = [...contract.keys()].filter((k) => !typed.has(k) && !SPECIAL.has(k))
const typedButUndeclared = [...typed.keys()].filter((k) => !contract.has(k)) // tsc refuses these; listed for completeness
const uncovered = [...plain.keys()].filter((k) => !contract.has(k)).sort()

// --- the web ------------------------------------------------------------------
/* A web call "reaches" a contract route when its literal path, with ${...}
   read as a placeholder and the query string dropped, matches the pattern. */
const patterns = [...contract.keys()].map((k) => {
  const [method, path] = k.split(' ')
  const re = new RegExp('^' + path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[a-zA-Z_]+\\?\}/g, '[^/]+').replace(/\{[a-zA-Z_]+\}/g, '[^/]+') + '/?$')
  return { key: k, method, re }
})
const WEB_METHOD = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE' }
const bypass = []
let calls = 0
for (const f of walk(join(root, 'web/src'))) {
  const src = readFileSync(f, 'utf8')
  calls += (src.match(/\bapi\.call\(/g) ?? []).length
  for (const m of src.matchAll(/\bapi\.(get|post|put|patch|del)(?:<[^()]*?>)?\(\s*(['`])\/api\/v1(\/[^'`?]*)/g)) {
    const method = WEB_METHOD[m[1]]
    const path = m[3].replace(/\$\{[^}]*\}/g, 'X')
    // A literal route the Worker registers (/students/notes) wins over a
    // pattern (/students/{id}), as it does in the router.
    const literal = plain.has(`${method} ${path.replace(/\/$/, '')}`)
    const hit = !literal && patterns.find((p) => p.method === method && p.re.test(path))
    if (hit) {
      const line = src.slice(0, m.index).split('\n').length
      bypass.push(`${relative(root, f)}:${line}  ${hit.key}`)
    }
  }
}

// --- report -------------------------------------------------------------------
const total = plain.size + typed.size
console.log(`API contract: ${contract.size} routes declared in shared/api, ${typed.size} registered with r.typed,`)
console.log(`${total} Worker routes in all (${((100 * typed.size) / Math.max(1, total)).toFixed(1)}% on the contract); web: ${calls} api.call sites.\n`)

if (notTyped.length) {
  console.log(`Declared in shared/api but not registered with r.typed (${notTyped.length}):`)
  for (const k of notTyped) console.log(`  ${k}   (${contract.get(k)}${plain.has(k) ? '; plain r.* in ' + plain.get(k) : '; not registered at all'})`)
  console.log()
}
if (typedButUndeclared.length) {
  console.log(`r.typed with no shared/api entry (${typedButUndeclared.length}):`)
  for (const k of typedButUndeclared) console.log(`  ${k}   (${typed.get(k)})`)
  console.log()
}
if (bypass.length) {
  console.log(`Web call sites reaching a contract route without api.call (${bypass.length}):`)
  for (const b of bypass) console.log(`  ${b}`)
  console.log()
}

const groups = new Map()
for (const k of uncovered) {
  const seg = k.split(' ')[1].split('/')[1] || '/'
  groups.set(seg, (groups.get(seg) ?? 0) + 1)
}
console.log(`Not on the contract yet: ${uncovered.length} routes. By area:`)
const sorted = [...groups.entries()].sort((a, b) => b[1] - a[1])
const width = Math.max(...sorted.map(([g]) => g.length), 4)
for (const [g, n] of sorted) console.log(`  /${g.padEnd(width)}  ${n}`)
if (args.has('--all')) {
  console.log()
  for (const k of uncovered) console.log(`  ${k}   (${plain.get(k)})`)
} else {
  console.log('\n(--all lists every one)')
}

if (args.has('--strict') && (notTyped.length || typedButUndeclared.length || bypass.length)) process.exit(1)
