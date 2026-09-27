#!/usr/bin/env node
/* Feature scaffolding, renaming, retirement and the consistency check.

     npm run feature:new    -- [flags]     add a feature everywhere it has to live
     npm run feature:rename -- --id <section.slug> --to "New name"
     npm run feature:remove -- --id <section.slug> [--drop-tables]
     npm run feature:check  -- [--update-baseline]

   docs/feature-anatomy.md is the manual: every file a feature touches, which of
   them are generated, and how to update and retire a feature safely.

   Source of truth. The catalogue is docs/edu_features.csv. Permissions and role
   grants are internal/rbac (Go), because the Go server is still built in CI and
   still serves production until the switchover; the Worker's copies
   (worker/src/routes/admin/static_data.ts, services/provision_seed.ts,
   routes/setup/common.ts) are kept in step by this script, and feature:check
   fails when they disagree.

   Everything this script writes into a shared file carries a marker comment,
   `feature:<section.slug>`, and everything it creates is recorded in
   scripts/feature-manifest.json, so feature:remove can take exactly that back
   out. Every command is safe to re-run: a step already done is reported as
   such and skipped. */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import readline from 'node:readline/promises'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const P = (f) => path.join(ROOT, f)
const exists = (f) => fs.existsSync(P(f))
const read = (f) => fs.readFileSync(P(f), 'utf8')
const write = (f, s) => { fs.mkdirSync(path.dirname(P(f)), { recursive: true }); fs.writeFileSync(P(f), s) }

const F = {
  csv: 'docs/edu_features.csv',
  genCatalog: 'scripts/gen_catalog.py',
  webCatalog: 'web/src/catalog.gen.ts',
  registry: 'web/src/features/registry.ts',
  implementedGo: 'internal/api/implemented_gen.go',
  staticData: 'worker/src/routes/admin/static_data.ts',
  provisionSeed: 'worker/src/services/provision_seed.ts',
  setupCommon: 'worker/src/routes/setup/common.ts',
  shell: 'worker/src/routes/misc/shell.ts',
  switches: 'worker/src/routes/seller/features.ts',
  routesIndex: 'worker/src/routes/index.ts',
  workerEntry: 'worker/src/index.ts',
  goRbac: 'internal/rbac/rbac.go',
  goModel: 'internal/rbac/model.go',
  migrate: 'worker/scripts/migrate.mjs',
  sharedIndex: 'shared/api/index.ts',
  manifest: 'scripts/feature-manifest.json',
  baseline: 'scripts/feature-check-baseline.json',
  planned: 'docs/features-planned.txt',
}

/* --- small helpers ---------------------------------------------------------- */

const log = []
const did = (s) => { log.push('  [done] ' + s) }
const skip = (s) => { log.push('  [skip] ' + s) }
const todo = (s) => { log.push('  [todo] ' + s) }
const die = (msg) => { console.error('feature: ' + msg); process.exit(1) }

/** gen_catalog.py's slug(), exactly. */
const slug = (s) => s.toLowerCase().replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
const pascal = (s) => s.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('')
const dashed = (s) => s.replace(/_/g, '-')
const tsStr = (s) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
const goStr = (s) => JSON.stringify(s)
const sqlStr = (s) => "'" + s.replace(/'/g, "''") + "'"
const markerOf = (id) => `feature:${id}`
const hasMarker = (line, id) => new RegExp(`feature:${id.replace(/\./g, '\\.')}(\\s|$| begin| end)`).test(line)

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts })
  if (r.error) return { ok: false, out: String(r.error.message) }
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' }
}
const haveGo = () => run('go', ['version']).ok

function parseArgs(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { o._.push(a); continue }
    const eq = a.indexOf('=')
    if (eq > 0) { o[a.slice(2, eq)] = a.slice(eq + 1); continue }
    const k = a.slice(2), v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) o[k] = true
    else { o[k] = v; i++ }
  }
  return o
}

/* One CSV record per line (the sheet has no embedded newlines; checked). */
function csvFields(line) {
  const out = []; let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (ch === '"') q = false; else cur += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out
}
const csvCell = (s) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s)

function readCsv() {
  const lines = read(F.csv).split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const header = csvFields(lines[0])
  const rows = lines.slice(1).map((line, i) => {
    const f = csvFields(line), r = {}
    header.forEach((h, j) => { r[h] = (f[j] ?? '').trim() })
    return { line, lineNo: i + 2, r }
  })
  return { header, lines, rows }
}

/** ROLE_KEYS and FEATURE_SLUG_OVERRIDE, read from gen_catalog.py so there is one copy. */
function genCatalogMaps() {
  const src = read(F.genCatalog)
  const block = (name) => src.slice(src.indexOf(name + ' = {'), src.indexOf('\n}', src.indexOf(name + ' = {')))
  const pairs = (b) => [...b.matchAll(/^\s*"([^"]+)":\s*"([^"]+)",/gm)].map((m) => [m[1], m[2]])
  const roleKeys = new Map(pairs(block('ROLE_KEYS')))
  const slugOverride = new Map(pairs(block('FEATURE_SLUG_OVERRIDE')))
  const roleName = new Map([...roleKeys].map(([n, k]) => [k, n]))
  return { roleKeys, roleName, slugOverride }
}

function csvKeyOf(row, maps) {
  const role = maps.roleKeys.get(row.r.Role)
  const feat = maps.slugOverride.get(row.r.Feature) ?? slug(row.r.Feature)
  return { role, section: slug(row.r.Section), slug: feat, key: `${role}.${slug(row.r.Section)}.${feat}`, id: `${slug(row.r.Section)}.${feat}` }
}

async function loadWebCatalog() {
  const mod = await import(pathToFileURL(P(F.webCatalog)).href + '?v=' + Date.now() + Math.random())
  return mod.ROLES
}

/** Every catalogue feature from the generated web catalogue: key -> {role, section, slug, name}. */
function catalogIndex(roles) {
  const out = new Map()
  for (const r of roles) for (const s of r.sections) for (const f of s.features) {
    out.set(f.key, { role: r.key, section: s.slug, sectionName: s.name, workspace: s.workspace, slug: f.slug, name: f.name, id: s.slug + '.' + f.slug })
  }
  return out
}

/* --- the manifest --------------------------------------------------------------- */

const manifest = () => (exists(F.manifest) ? JSON.parse(read(F.manifest)) : { features: {} })
function saveManifest(m) {
  if (!Object.keys(m.features).length) { if (exists(F.manifest)) fs.rmSync(P(F.manifest)); return }
  const sorted = Object.fromEntries(Object.keys(m.features).sort().map((k) => [k, m.features[k]]))
  write(F.manifest, JSON.stringify({
    _comment: 'Written by scripts/feature.mjs: what `feature:new` added for each feature, so `feature:remove` can take exactly that back out. Do not edit by hand.',
    features: sorted,
  }, null, 2) + '\n')
}

/* --- JSON-line files (static_data.ts) -------------------------------------------- */

function jsonLine(file, name) {
  const lines = read(file).split('\n')
  const i = lines.findIndex((l) => l.startsWith(`export const ${name}`))
  if (i < 0) die(`${file}: no export const ${name}`)
  const at = lines[i].indexOf('= ') + 2
  return {
    value: JSON.parse(lines[i].slice(at).replace(/;$/, '')),
    save(v) { const cur = read(file).split('\n'); cur[i] = lines[i].slice(0, at) + JSON.stringify(v); write(file, cur.join('\n')) },
  }
}

/* --- regeneration ------------------------------------------------------------------ */

/** Worker copy of the catalogue and the implemented list, from the generated web + Go files. */
async function syncWorkerCatalog() {
  const roles = await loadWebCatalog()
  const norm = roles.map((r) => ({ key: r.key, name: r.name, sections: r.sections.map((s) => ({
    slug: s.slug, name: s.name, workspace: s.workspace,
    features: s.features.map((f) => ({ key: f.key, slug: f.slug, name: f.name, summary: f.summary, scope: f.scope, tier: f.tier })),
  })) }))
  const before = read(F.staticData)
  jsonLine(F.staticData, 'CATALOG_ROLES').save(norm)
  const impl = [...read(F.implementedGo).matchAll(/^\s*"([^"]+)":\s*true,/gm)].map((m) => m[1]).sort()
  const lines = read(F.staticData).split('\n')
  const i = lines.findIndex((l) => l.startsWith('export const IMPLEMENTED_FEATURES'))
  lines[i] = 'export const IMPLEMENTED_FEATURES: ReadonlySet<string> = new Set(' + JSON.stringify(impl) + ')'
  write(F.staticData, lines.join('\n'))
  return before !== read(F.staticData)
}

/** The whole chain `make catalog` runs, plus the Worker copies. */
async function regenerate() {
  const steps = [
    ['python3', ['scripts/gen_catalog.py']],
    ['python3', ['scripts/gen_implemented.py']],
    ['python3', ['scripts/gen_answers.py']],
  ]
  for (const [c, a] of steps) {
    const r = run(c, a)
    if (!r.ok) die(`${c} ${a.join(' ')} failed:\n${r.out}`)
  }
  if (haveGo()) {
    // Only the generated Go files: gofmt -w internal/api would also rewrite hand-written files.
    run('gofmt', ['-w', 'internal/catalog/catalog_gen.go', F.implementedGo, 'internal/api/help_answers_gen.go', F.goRbac, F.goModel])
    const seed = run('go', ['run', './scripts/d1/tenant_seed'])
    if (!seed.ok) die('go run ./scripts/d1/tenant_seed failed:\n' + seed.out)
    if (seed.stdout !== read(F.provisionSeed)) write(F.provisionSeed, seed.stdout)
  } else {
    todo('Go is not installed: run `make catalog` and `go run ./scripts/d1/tenant_seed > ' + F.provisionSeed + '` on a machine with Go')
  }
  await syncWorkerCatalog()
  did('regenerated catalogue outputs: internal/catalog/catalog_gen.go, web/src/catalog.gen.ts, internal/api/implemented_gen.go, internal/api/help_answers_gen.go, ' + F.provisionSeed + ', CATALOG_ROLES + IMPLEMENTED_FEATURES in ' + F.staticData)
}

/* --- text edits with markers --------------------------------------------------------- */

/** Inserts `text` (one or more lines) before line index `at` unless a line with the marker is already there. */
function insertLines(file, at, text, id, what) {
  const lines = read(file).split('\n')
  const marker = markerOf(id)
  if (lines.some((l) => l.includes(marker) && l.includes(text.split('\n')[0].trim().slice(0, 40)))) { skip(`${what} (already in ${file})`); return false }
  lines.splice(at, 0, ...text.split('\n'))
  write(file, lines.join('\n'))
  did(`${what} -> ${file}`)
  return true
}

/** Removes every line carrying the marker, and every begin..end block. */
function stripMarkers(file, id) {
  if (!exists(file)) return 0
  const lines = read(file).split('\n'), out = []
  let inBlock = false, n = 0
  for (const l of lines) {
    if (hasMarker(l, id) && / begin\b/.test(l)) { inBlock = true; n++; continue }
    if (inBlock) { n++; if (hasMarker(l, id) && / end\b/.test(l)) inBlock = false; continue }
    if (hasMarker(l, id)) { n++; continue }
    out.push(l)
  }
  if (n) write(file, out.join('\n'))
  return n
}

/** Index of the line that closes the object/array opened on the first line matching `open`. */
function closingLine(lines, openRe) {
  const start = lines.findIndex((l) => openRe.test(l))
  if (start < 0) return -1
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    // On the opening line, count from its last opener: `[]string{` must not close on its own `]`.
    let text = lines[i]
    if (i === start) text = text.slice(Math.max(text.lastIndexOf('{'), text.lastIndexOf('['), text.lastIndexOf('(')))
    for (const ch of text.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`|\/\/.*$/g, '')) {
      if (ch === '{' || ch === '[' || ch === '(') depth++
      else if (ch === '}' || ch === ']' || ch === ')') { depth--; if (depth === 0) return i }
    }
  }
  return -1
}

/* --- permissions ------------------------------------------------------------------ */

function goPermIdents() {
  const src = read(F.goRbac)
  const out = new Map()
  for (const m of src.matchAll(/^\t(\w+)\s*=\s*"([^"]+)"/gm)) out.set(m[2], m[1])
  return out
}

function permissionKeys() {
  return {
    go: new Set(goPermIdents().keys()),
    goAll: new Set([...read(F.goRbac).matchAll(/^\t\{(\w+),\s*"[^"]*",/gm)].map((m) => m[1])),
    worker: new Set(jsonLine(F.staticData, 'PERMISSIONS').value.map((p) => p.key)),
  }
}

function addPermission(key, module, desc, id, group) {
  const idents = goPermIdents()
  let ident = idents.get(key)
  const created = !ident
  if (!ident) {
    ident = pascal(key)
    const taken = new Set(idents.values())
    while (taken.has(ident) || new RegExp(`\\b${ident}\\b`).test(read(F.goRbac))) ident += 'Perm'
    let lines = read(F.goRbac).split('\n')
    const constStart = lines.findIndex((l) => l === 'const (')
    const constEnd = lines.findIndex((l, i) => i > constStart && l === ')')
    insertLines(F.goRbac, constEnd, `\t${ident} = ${goStr(key)} // ${markerOf(id)}`, id, `Go permission const ${ident}`)
    lines = read(F.goRbac).split('\n')
    const allEnd = closingLine(lines, /^var All = \[\]Permission\{/)
    insertLines(F.goRbac, allEnd, `\t{${ident}, ${goStr(module)}, ${goStr(desc)}}, // ${markerOf(id)}`, id, `Go rbac.All entry ${key}`)
  } else skip(`permission ${key} already exists (Go ${ident})`)

  const perms = jsonLine(F.staticData, 'PERMISSIONS')
  if (!perms.value.some((p) => p.key === key)) {
    perms.value.push({ description: desc, key, module })
    perms.save(perms.value)
    did(`Worker PERMISSIONS entry ${key} -> ${F.staticData}`)
  } else skip(`Worker PERMISSIONS already has ${key}`)
  return { ident, created }
}

/** A roles-grid group for the new keys (TestGroupsCoverEveryPermission needs every key in one). */
function addGroup(id, name, blurb, view, manage, identOf) {
  const gkey = id.replace(/\./g, '_')
  const lines = read(F.goModel).split('\n')
  if (!lines.some((l) => hasMarker(l, id))) {
    const end = closingLine(lines, /^var Groups = \[\]Group\{/)
    const list = (ks) => '[]string{' + ks.map((k) => identOf(k)).join(', ') + '}'
    const block = [
      `\t// ${markerOf(id)} begin`,
      '\t{',
      `\t\tKey: ${goStr(gkey)}, Name: ${goStr(name)}, Band: BandOptional,`,
      `\t\tBlurb: ${goStr(blurb)},`,
      ...(view.length ? [`\t\tView: ${list(view)},`] : []),
      ...(manage.length ? [`\t\tManage: ${list(manage)},`] : []),
      '\t\tScopes: fixed("institution"),',
      `\t\tScopeNote: "The whole school.",`,
      '\t},',
      `\t// ${markerOf(id)} end`,
    ].join('\n')
    insertLines(F.goModel, end, block, id, `Go roles-grid group ${gkey}`)
  } else skip(`Go roles-grid group ${gkey} already present`)
  const groups = jsonLine(F.staticData, 'GROUPS')
  if (!groups.value.some((g) => g.key === gkey)) {
    groups.value.push({ key: gkey, name, blurb, band: 'optional', view, manage, approve: [], export: [],
      scopes: [{ scope: 'institution', keys: [], write_keys: [] }], scope_note: 'The whole school.' })
    groups.save(groups.value)
    did(`Worker GROUPS entry ${gkey} -> ${F.staticData}`)
  } else skip(`Worker GROUPS already has ${gkey}`)
  return gkey
}

/** Grants `key` to `role` in every copy. Returns what it actually added. */
function grant(role, key, ident, id) {
  const added = []
  // Go
  if (role === 'institution_admin') skip(`Go: institution_admin holds every key via keysExcept`)
  else {
    const lines = read(F.goRbac).split('\n')
    const open = role === 'seller_admin' ? /^var SellerAdminPermissions = \[\]string\{/
      : role === 'support_admin' ? /^var SupportAdminPermissions = \[\]string\{/
        : new RegExp(`^\\t\\{"${role}", "`)
    const at = lines.findIndex((l) => open.test(l))
    if (at < 0) skip(`Go: no system role ${role} in rbac.go (catalogue-only role)`)
    else {
      const end = closingLine(lines, open)
      const body = lines.slice(at, end + 1).join('\n')
      if (new RegExp(`\\b${ident}\\b`).test(body)) skip(`Go: ${role} already grants ${ident}`)
      else { insertLines(F.goRbac, at + 1, `\t\t${ident}, // ${markerOf(id)}`, id, `Go grant ${role} += ${ident}`); added.push('go') }
    }
  }
  // Worker: static_data SYSTEM_ROLES
  const sr = jsonLine(F.staticData, 'SYSTEM_ROLES')
  const r = sr.value.find((x) => x.key === role)
  if (!r) skip(`Worker SYSTEM_ROLES has no ${role}`)
  else if (r.permissions.includes(key)) skip(`Worker SYSTEM_ROLES ${role} already has ${key}`)
  else { r.permissions.push(key); sr.save(sr.value); did(`Worker SYSTEM_ROLES ${role} += ${key}`); added.push('static_data') }
  // Worker: setup/common.ts SYSTEM_ROLES
  const lines = read(F.setupCommon).split('\n')
  const i = lines.findIndex((l) => new RegExp(`^  ${role}: \\{ name: `).test(l))
  if (i < 0) skip(`${F.setupCommon} has no ${role}`)
  else if (/permissions: 'all'/.test(lines[i])) skip(`${F.setupCommon}: ${role} holds 'all'`)
  else {
    const end = closingLine(lines, new RegExp(`^  ${role}: \\{ name: `))
    if (lines.slice(i, end + 1).join('\n').includes(`'${key}'`)) skip(`${F.setupCommon}: ${role} already has ${key}`)
    else {
      lines[i] = lines[i].replace('permissions: [', `permissions: ['${key}', `)
      write(F.setupCommon, lines.join('\n'))
      did(`${F.setupCommon} ${role} += ${key}`)
      added.push('setup_common')
    }
  }
  return added
}

function ungrant(role, key, where) {
  if (where.includes('static_data')) {
    const sr = jsonLine(F.staticData, 'SYSTEM_ROLES')
    const r = sr.value.find((x) => x.key === role)
    if (r && r.permissions.includes(key)) { r.permissions = r.permissions.filter((k) => k !== key); sr.save(sr.value); did(`Worker SYSTEM_ROLES ${role} -= ${key}`) }
  }
  if (where.includes('setup_common')) {
    const s = read(F.setupCommon)
    const n = s.replace(new RegExp(`(^  ${role}: \\{ name: [^\\n]*?)'${key.replace(/\./g, '\\.')}', `, 'm'), '$1')
    if (n !== s) { write(F.setupCommon, n); did(`${F.setupCommon} ${role} -= ${key}`) }
  }
  // Go grants carry the marker and go with stripMarkers.
}

function removePermission(key) {
  const perms = jsonLine(F.staticData, 'PERMISSIONS')
  if (perms.value.some((p) => p.key === key)) { perms.save(perms.value.filter((p) => p.key !== key)); did(`Worker PERMISSIONS -= ${key}`) }
}
function removeGroup(gkey) {
  const groups = jsonLine(F.staticData, 'GROUPS')
  if (groups.value.some((g) => g.key === gkey)) { groups.save(groups.value.filter((g) => g.key !== gkey)); did(`Worker GROUPS -= ${gkey}`) }
}

/* --- shared API types ------------------------------------------------------------------ */

/** How shared/api/index.ts composes the per-domain interfaces, if it exists. */
function sharedIndexStyle() {
  if (!exists(F.sharedIndex)) return null
  const s = read(F.sharedIndex)
  if (/export interface Api extends [^{]+\{/.test(s)) return 'extends'
  if (/export type Api =/.test(s)) return 'intersection'
  return null
}

function wireSharedIndex(file, iface, id) {
  const style = sharedIndexStyle()
  if (!style) { skip('shared/api/index.ts not found or not recognised: routes use plain r.get/r.post with shared/api types'); return false }
  let s = read(F.sharedIndex)
  if (s.includes(`${iface}`)) { skip(`${F.sharedIndex} already names ${iface}`); return true }
  const mod = './' + path.basename(file, '.ts')
  const importLine = `import type { ${iface} } from '${mod}' // ${markerOf(id)}`
  const lines = s.split('\n')
  let lastImport = -1
  lines.forEach((l, i) => { if (/^import /.test(l)) lastImport = i })
  lines.splice(lastImport + 1, 0, importLine)
  s = lines.join('\n')
  if (style === 'extends') s = s.replace(/export interface Api extends ([^{]+)\{/, (m, list) => `export interface Api extends ${list.trimEnd()}, ${iface} {`)
  else s = s.replace(/export type Api =/, `export type Api = ${iface} &`)
  write(F.sharedIndex, s)
  did(`${F.sharedIndex}: Api includes ${iface}`)
  return true
}
function unwireSharedIndex(iface, id) {
  if (!exists(F.sharedIndex)) return
  stripMarkers(F.sharedIndex, id)
  const s = read(F.sharedIndex)
  const n = s.replace(new RegExp(`, ${iface}(?=\\s*\\{)`), '').replace(new RegExp(`${iface} & `), '')
  if (n !== s) { write(F.sharedIndex, n); did(`${F.sharedIndex}: Api no longer includes ${iface}`) }
}

/* --- templates ------------------------------------------------------------------------- */

function tplShared(t) {
  return `/* ${t.name}: ${t.summary}
   Generated by \`npm run feature:new\` (scripts/feature.mjs) for ${t.id}; grow it by hand. */
import type { List } from './contract'

export interface ${t.Pascal}Item {
  id: string
  title: string
  created_at: string
}

export interface ${t.Pascal}Api {
  'GET ${t.apiBase}': { res: List<${t.Pascal}Item> }
  'POST ${t.apiBase}': { body: { title: string }; res: ${t.Pascal}Item }
}
`
}

function tplRoute(t) {
  const typed = t.typed
  const imports = typed
    ? `import type { Router } from '../../router'\nimport { reply } from '../../router'\nimport { badRequest, now, readJSON, uuid } from '../../http'\nimport type { ${t.Pascal}Item } from '@shared/api/${t.sharedName}'`
    : `import type { Router } from '../../router'\nimport { created, badRequest, now, ok, readJSON, uuid } from '../../http'\nimport type { List } from '@shared/api/contract'\nimport type { ${t.Pascal}Item } from '@shared/api/${t.sharedName}'`
  const reg = (m, perm, body) => typed
    ? `  r.typed('${m} ${t.apiBase}', '${perm}', async (c) => {\n${body}\n  })`
    : `  r.${m === 'GET' ? 'get' : 'post'}('${t.apiBase}', '${perm}', async (c) => {\n${body}\n  })`
  const list = t.table
    ? `    const rows = await c.db.prepare('SELECT id, title, created_at FROM ${t.table} ORDER BY created_at DESC LIMIT 200').all<${t.Pascal}Item>()\n` +
      (typed ? `    return { items: rows.results }` : `    return ok({ items: rows.results } satisfies List<${t.Pascal}Item>)`)
    : (typed ? `    void c\n    return { items: [] as ${t.Pascal}Item[] }` : `    void c\n    return ok({ items: [] } satisfies List<${t.Pascal}Item>)`)
  const post = `    const b = await readJSON<{ title?: string }>(c.req)
    const title = String(b.title ?? '').trim()
    if (!title) throw badRequest('title is required')
    const item: ${t.Pascal}Item = { id: uuid(), title, created_at: now() }
` + (t.table ? `    await c.db.prepare('INSERT INTO ${t.table} (id, institution_id, title, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(item.id, c.id.institution!.id, item.title, c.id.userId, item.created_at).run()
` : `    // No table yet: nothing is stored. Add one with \`npm run feature:new -- ... --table\` or a migration.
`) + (typed ? `    return reply(item, 201)` : `    return created(item)`)
  return `/* ${t.name} (${t.id}): ${t.summary}

   Generated by \`npm run feature:new\` (scripts/feature.mjs). Catalogue keys:
   ${t.keys.join(', ')}.
   Read ${t.readPerm}${t.writePerm ? `, write ${t.writePerm}` : ''}. Follow worker/PORTING.md for everything you add. */
${imports}

export function register${t.Pascal}(r: Router): void {
${reg('GET', t.readPerm, list)}
${t.writePerm ? reg('POST', t.writePerm, post) : ''}
}
`
}

function tplScreen(t) {
  return `import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { List } from '@shared/api/contract'
import type { ${t.Pascal}Item } from '@shared/api/${t.sharedName}'
import { PageHead, PageBody, EmptyState, ErrorState, Card } from '@/components/ui'

/* ${t.name}: ${t.summary}

   Generated by \`npm run feature:new\` (scripts/feature.mjs) for ${t.keys.join(', ')}.
   Reads GET /api/v1${t.apiBase} (worker/src/routes/${t.module}/${t.slug}.ts). */
export default function ${t.Pascal}() {
  const q = useQuery({
    queryKey: ['${t.id}'],
    queryFn: () => api.get<List<${t.Pascal}Item>>('${t.apiBase}'),
  })
  return (
    <>
      <PageHead eyebrow=${JSON.stringify(t.sectionName)} title=${JSON.stringify(t.name)} />
      <PageBody>
        {q.isError ? (
          <ErrorState error={q.error} />
        ) : !q.data ? null : q.data.items.length === 0 ? (
          <EmptyState title="Nothing here yet" />
        ) : (
          <Card>
            <ul>
              {q.data.items.map((it) => (
                <li key={it.id}>{it.title}</li>
              ))}
            </ul>
          </Card>
        )}
      </PageBody>
    </>
  )
}
`
}

function tplTest(t) {
  return `/* ${t.name} (${t.id}): the routes exist under the permissions the catalogue expects.
   Generated by \`npm run feature:new\` (scripts/feature.mjs); extend with real cases. */
import { describe, it, expect } from 'vitest'
import { Router } from '${t.testDepth}/src/router'
import { register${t.Pascal} } from '${t.testDepth}/src/routes/${t.module}/${t.slug}'

describe('${t.id}', () => {
  const r = new Router()
  register${t.Pascal}(r)
  it('lists under ${t.readPerm}', () => {
    expect(r.match('GET', '/api/v1${t.apiBase}')?.route.perm).toBe('${t.readPerm}')
  })
${t.writePerm ? `  it('creates under ${t.writePerm}', () => {
    expect(r.match('POST', '/api/v1${t.apiBase}')?.route.perm).toBe('${t.writePerm}')
  })
` : ''}})
`
}

function tplMigration(t, createdPerms) {
  const out = [`-- ${t.name} (${t.id}), added by \`npm run feature:new\` (scripts/feature.mjs).`,
    '-- Brings every existing school database up to what a new school is provisioned with.', '']
  if (t.table) {
    out.push(`CREATE TABLE IF NOT EXISTS ${t.table} (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ${t.table}_created_idx ON ${t.table} (created_at);
`)
  }
  out.push('-- The permission vocabulary: new capability keys and the catalogue (navigation) keys.')
  for (const p of createdPerms) out.push(`INSERT OR IGNORE INTO permissions (key, module, description) VALUES (${sqlStr(p.key)}, ${sqlStr(p.module)}, ${sqlStr(p.desc)});`)
  for (const k of t.keysDetail) out.push(`INSERT OR IGNORE INTO permissions (key, module, description) VALUES (${sqlStr(k.key)}, ${sqlStr(k.role)}, ${sqlStr(t.summary.slice(0, 240))});`)
  out.push('', '-- The built-in roles pick them up. A school that customised a role keeps its customisation.')
  for (const k of t.keysDetail) out.push(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, ${sqlStr(k.key)} FROM roles WHERE key = ${sqlStr(k.role)} AND is_system = 1 AND customised_at IS NULL;`)
  for (const [role, keys] of Object.entries(t.grants)) for (const key of keys) {
    out.push(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, ${sqlStr(key)} FROM roles WHERE key = ${sqlStr(role)} AND is_system = 1 AND customised_at IS NULL;`)
  }
  return out.join('\n') + '\n'
}

function tplRetire(f, dropTables) {
  const keys = [...f.keys, ...f.createdPerms.map((p) => p.key)]
  const lines = [`-- Retires ${f.name} (${f.id}), written by \`npm run feature:remove\` (scripts/feature.mjs).`,
    '-- Takes the navigation and capability keys out of every school database.', '']
  for (const k of keys) lines.push(`DELETE FROM role_permissions WHERE permission_key = ${sqlStr(k)};`)
  for (const k of keys) lines.push(`DELETE FROM user_permissions WHERE permission_key = ${sqlStr(k)};`)
  for (const k of keys) lines.push(`DELETE FROM permissions WHERE key = ${sqlStr(k)};`)
  if (f.table) {
    lines.push('')
    if (dropTables) lines.push(`-- --drop-tables was given: the data goes. Export first (docs/feature-anatomy.md, Retiring a feature).`, `DROP TABLE IF EXISTS ${f.table};`)
    else lines.push(`-- The table ${f.table} is kept: its rows are school data. Drop it only with`, `-- \`npm run feature:remove -- --id ${f.id} --drop-tables\` after the retention period.`, `-- DROP TABLE IF EXISTS ${f.table};`)
  }
  return lines.join('\n') + '\n'
}

/* --- migrations ---------------------------------------------------------------------- */

function newMigration(name, body) {
  if (exists(F.migrate)) {
    const r = run(process.execPath, ['scripts/migrate.mjs', 'new', 'tenant', name], { cwd: P('worker') })
    if (!r.ok) die('migrate.mjs new failed:\n' + r.out)
    const file = r.stdout.trim().split('\n').pop()
    fs.appendFileSync(file, body)
    const rel = path.relative(ROOT, file)
    did(`migration ${rel} (worker/scripts/migrate.mjs new tenant ${name})`)
    return rel
  }
  const rel = `worker/db/changes/tenant_${name}.sql`
  write(rel, `-- Apply to every school database: wrangler d1 execute <db> --file=${rel}\n` + body)
  did(`change file ${rel} (no migration runner found)`)
  return rel
}
const untracked = (f) => !run('git', ['ls-files', '--error-unmatch', f]).ok

/* --- references ------------------------------------------------------------------------- */

const SEARCH_ROOTS = ['web/src', 'worker/src', 'worker/test', 'internal', 'cmd', 'migrations', 'worker/migrations', 'shared', 'mobile', 'desktop', 'tests']
const GENERATED = new Set([F.webCatalog, 'internal/catalog/catalog_gen.go', F.implementedGo, 'internal/api/help_answers_gen.go', F.staticData, F.provisionSeed])

function grepRefs(needles, ignore) {
  const args = ['grep', '-n', '-I', '-F']
  for (const n of needles) args.push('-e', n)
  args.push('--', ...SEARCH_ROOTS.filter(exists))
  const r = run('git', args)
  const also = run('grep', ['-rnIF', ...needles.flatMap((n) => ['-e', n]), '--exclude-dir=node_modules', ...SEARCH_ROOTS.filter(exists)])
  const lines = new Set([...(r.stdout || '').split('\n'), ...(also.stdout || '').split('\n')].filter(Boolean))
  return [...lines].filter((l) => { const f = l.split(':')[0]; return !GENERATED.has(f) && !ignore(f, l) })
}

/* --- registry --------------------------------------------------------------------------- */

function registryFiles() {
  const out = [F.registry]
  const walk = (d) => { for (const e of fs.readdirSync(P(d), { withFileTypes: true })) { const f = d + '/' + e.name; if (e.isDirectory()) walk(f); else if (/keys\.ts$/.test(e.name) && !e.name.endsWith('.test.ts')) out.push(f) } }
  walk('web/src/features')
  return out
}

/** Every mapped key: key -> [{file, target}]. */
function registryEntries() {
  const out = new Map()
  for (const f of registryFiles()) {
    const src = read(f)
    const start = f === F.registry ? src.indexOf('FEATURE_COMPONENTS') : 0
    const body = src.slice(start)
    for (const m of body.matchAll(/'([a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+)':\s*(?:screen|lazy)\(\s*\(\)\s*=>\s*(?:\n\s*)?import\(\s*'([^']+)'/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[2]))
      if (!out.has(m[1])) out.set(m[1], [])
      out.get(m[1]).push({ file: f, target })
    }
  }
  return out
}

/** Removes the entry for `key` from a registry file: from the key to the end of its screen(...) call. */
function removeRegistryEntry(file, key) {
  const src = read(file)
  const at = src.indexOf(`'${key}':`)
  if (at < 0) return false
  let i = src.indexOf('(', at), depth = 0
  for (; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')') { depth--; if (depth === 0) break } }
  let end = i + 1
  if (src[end] === ',') end++
  const nl = src.indexOf('\n', end)
  const rest = src.slice(end, nl)
  if (/^\s*(\/\/.*)?$/.test(rest)) end = nl + 1
  const lineStart = src.lastIndexOf('\n', at) + 1
  const from = /^\s*$/.test(src.slice(lineStart, at)) ? lineStart : at
  write(file, src.slice(0, from) + src.slice(end))
  return true
}

/* ============================================================================================
   feature:new
   ============================================================================================ */

async function ask(o, key, question, def) {
  if (o[key] !== undefined && o[key] !== true) return String(o[key])
  if (!process.stdin.isTTY || o.yes) { if (def !== undefined) return def; die(`--${key} is required (${question})`) }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const a = (await rl.question(`${question}${def !== undefined ? ` [${def}]` : ''}: `)).trim()
  rl.close()
  return a || def || die(`${key} is required`)
}

async function cmdNew(o) {
  const maps = genCatalogMaps()
  const roles = (await ask(o, 'roles', 'Role key(s), comma separated (e.g. faculty,hod)')).split(',').map((s) => s.trim()).filter(Boolean)
  for (const r of roles) if (!maps.roleName.has(r)) die(`unknown role ${r}; one of ${[...maps.roleName.keys()].join(', ')}`)
  const sectionName = await ask(o, 'section', 'Section (display name, e.g. "Library")')
  const name = await ask(o, 'name', 'Feature name (display)')
  const summary = await ask(o, 'summary', 'Summary (what the user sees and does)')
  const module = await ask(o, 'module', 'Code module: worker/src/routes/<module>/ and web/src/features/<module>/ (e.g. ops)')
  const readPerm = await ask(o, 'read', 'Read permission key (existing or new, e.g. operations.library.read)')
  const writePerm = await ask(o, 'write', 'Write permission key (empty for read-only)', '')
  const tableOpt = o.table === true ? 'y' : await ask(o, 'table', 'Needs a table? (y/N or a table name)', 'n')

  if (!/^[a-z][a-z0-9_]*$/.test(module)) die('--module must be snake_case')
  const sectionSlug = slug(sectionName), featSlug = maps.slugOverride.get(name) ?? slug(name)
  const id = `${sectionSlug}.${featSlug}`
  const table = /^(n|no|false|)$/i.test(tableOpt) ? null : /^(y|yes|true)$/i.test(tableOpt) ? `${featSlug}_items` : slug(tableOpt)
  const Pascal = pascal(featSlug)
  const apiBase = o.path || `/${dashed(module)}/${dashed(featSlug)}`
  const csv = readCsv()
  const cat = catalogIndex(await loadWebCatalog())

  // Guard against colliding with somebody else's feature.
  const m = manifest()
  const mine = m.features[id]
  const keys = roles.map((r) => `${r}.${sectionSlug}.${featSlug}`)
  for (const k of keys) if (cat.has(k) && !mine) die(`${k} already exists in the catalogue and was not made by this script; pick another name`)
  const routeFile = `worker/src/routes/${module}/${featSlug}.ts`
  if (exists(routeFile) && !mine) die(`${routeFile} exists and was not made by this script`)
  const routeIdx = read(F.routesIndex)
  if (!mine && new RegExp(`\\bregister${Pascal}\\b`).test(routeIdx)) die(`register${Pascal} is already registered in ${F.routesIndex}`)
  const collide = grepRefs([`'${apiBase}'`, `'${apiBase}/`], (f) => f === routeFile)
  if (collide.length && !mine) die(`API path ${apiBase} is already used:\n  ${collide.join('\n  ')}\nPass --path /other/path`)

  const planModule = o['plan-module'] || sectionModuleOf(sectionSlug) || 'core'
  const scopeText = (r) => o.scope || (r === 'parent' ? 'Linked child/children only' : r === 'student' ? 'Self only' : r === 'super_admin' || r === 'seller_admin' ? 'All schools / all branches' : 'Assigned institution/campus')

  console.log(`feature:new ${id} (${keys.join(', ')})`)

  // 1. catalogue rows
  const have = new Set(csv.rows.map((row) => csvKeyOf(row, maps).key))
  const add = []
  for (const r of roles) {
    const key = `${r}.${sectionSlug}.${featSlug}`
    if (have.has(key)) { skip(`catalogue row ${key}`); continue }
    const existing = [...cat.values()].find((f) => f.role === r && f.section === sectionSlug)
    const workspace = o.workspace || existing?.workspace || sectionName
    const section = existing?.sectionName || sectionName
    add.push([maps.roleName.get(r), workspace, section, name, summary, scopeText(r), o.priority || 'Must-Have', o.tier || 'core'].map(csvCell).join(','))
    did(`catalogue row ${key} -> ${F.csv}`)
  }
  if (add.length) write(F.csv, csv.lines.concat(add).join('\n') + '\n')

  // 2. permissions and grants (Go is the source of truth; Worker copies follow)
  const perms = [readPerm, writePerm].filter(Boolean)
  const known = permissionKeys()
  const created = [], identOf = new Map()
  const prevCreated = mine?.createdPerms ?? []
  for (const k of perms) {
    const isNew = !known.go.has(k) || prevCreated.some((p) => p.key === k)
    const desc = `${k.endsWith('.write') ? 'Manage' : 'View'} ${name}`
    const { ident } = addPermission(k, k.split('.')[0], desc, id)
    identOf.set(k, ident)
    if (isNew) created.push({ key: k, module: k.split('.')[0], desc, ident })
  }
  let group = mine?.group ?? null
  if (created.length) {
    const view = created.filter((p) => p.key === readPerm).map((p) => p.key)
    const manage = created.filter((p) => p.key === writePerm).map((p) => p.key)
    if (!view.length && manage.length) { view.push(...manage.splice(0)) }
    group = addGroup(id, name, summary.length > 160 ? summary.slice(0, 157) + '...' : summary, view, manage, (k) => identOf.get(k))
  }
  const grants = { ...(mine?.grants ?? {}) }
  const grantWhere = { ...(mine?.grantWhere ?? {}) }
  for (const r of roles) for (const k of perms) {
    const added = grant(r, k, identOf.get(k), id)
    if (added.length) { grants[r] = [...new Set([...(grants[r] ?? []), k])]; grantWhere[`${r} ${k}`] = [...new Set([...(grantWhere[`${r} ${k}`] ?? []), ...added])] }
  }

  // 3. regenerate the catalogue outputs (+ provision seed, which reads rbac too)
  await regenerate()

  // 4. shared API types, Worker route, registration
  const sharedName = `feature_${featSlug}`
  const sharedFile = `shared/api/${sharedName}.ts`
  const t = { id, name, summary, slug: featSlug, Pascal, module, apiBase, keys, sectionName, readPerm, writePerm, table, sharedName,
    keysDetail: roles.map((r) => ({ role: r, key: `${r}.${sectionSlug}.${featSlug}` })), grants }
  const files = new Set(mine?.files ?? [])
  const create = (f, body) => { if (exists(f)) skip(`${f} exists (left as is)`); else { write(f, body); did(`created ${f}`) } files.add(f) }
  create(sharedFile, tplShared(t))
  t.typed = wireSharedIndex(sharedFile, `${Pascal}Api`, id)
  create(routeFile, tplRoute(t))
  {
    const lines = read(F.routesIndex).split('\n')
    let lastImport = -1
    lines.forEach((l, i) => { if (/^import /.test(l)) lastImport = i })
    insertLines(F.routesIndex, lastImport + 1, `import { register${Pascal} } from './${module}/${featSlug}' // ${markerOf(id)}`, id, `import register${Pascal}`)
    const l2 = read(F.routesIndex).split('\n')
    const ret = l2.findIndex((l) => /^\s*return r\s*$/.test(l))
    insertLines(F.routesIndex, ret, `  register${Pascal}(r) // ${markerOf(id)}`, id, `register${Pascal}(r) in buildRouter`)
  }

  // 5. feature switch: the API prefix is refused when a school has the feature off
  if (o.gate !== 'false' && o['no-gate'] === undefined) {
    const lines = read(F.switches).split('\n')
    const end = closingLine(lines, /^export const FEATURE_ROUTES/)
    if (lines.some((l) => l.includes(`'${id}':`))) skip(`FEATURE_ROUTES already has ${id}`)
    else insertLines(F.switches, end, `  '${id}': ['${apiBase}'], // ${markerOf(id)}`, id, `feature switch FEATURE_ROUTES['${id}']`)
  }
  // plan module for a new section
  let addedSectionModule = mine?.addedSectionModule ?? false
  if (!sectionModuleOf(sectionSlug) && planModule !== 'core') {
    const lines = read(F.shell).split('\n')
    const end = closingLine(lines, /^export const SECTION_MODULE/)
    insertLines(F.shell, end, `  ${sectionSlug}: '${planModule}', // ${markerOf(id)}`, id, `SECTION_MODULE.${sectionSlug} = '${planModule}'`)
    addedSectionModule = true
  } else skip(`plan module: section ${sectionSlug} -> ${sectionModuleOf(sectionSlug) ?? 'core (always on)'}`)

  // 6. web screen + registry
  const webDir = o['web-dir'] || module
  const screenFile = `web/src/features/${webDir}/${Pascal}.tsx`
  create(screenFile, tplScreen(t))
  {
    const lines = read(F.registry).split('\n')
    const end = closingLine(lines, /^export const FEATURE_COMPONENTS/)
    let at = end
    for (const k of keys) {
      if (read(F.registry).includes(`'${k}':`)) { skip(`registry already maps ${k}`); continue }
      insertLines(F.registry, at, `  '${k}': screen(() => import('./${webDir}/${Pascal}')), // ${markerOf(id)}`, id, `registry ${k} -> ${screenFile}`)
      at++
    }
  }

  // 7. migration (permissions + grants for existing schools, and the table)
  let migration = mine?.migration ?? null
  if (migration && exists(migration)) skip(`migration ${migration} exists`)
  else migration = newMigration(`feature_${featSlug}`, tplMigration(t, created))
  files.add(migration)

  // 8. test stub
  // vitest (worker/vitest.config.ts) runs test/integration/** inside workerd; older node --test files sit in test/.
  const testDir = exists('worker/test/integration') ? 'worker/test/integration' : 'worker/test'
  t.testDepth = testDir.endsWith('integration') ? '../..' : '..'
  create(`${testDir}/feature_${featSlug}.test.ts`, tplTest(t))

  // regenerate once more: the registry now maps the keys, so implemented_gen.go / IMPLEMENTED_FEATURES follow
  await regenerate()

  m.features[id] = { name, summary, section: sectionSlug, sectionName, slug: featSlug, roles, keys, module, webDir, planModule,
    apiBase, readPerm, writePerm: writePerm || null, table, group, createdPerms: created.map(({ key, module: mm, desc }) => ({ key, module: mm, desc })),
    grants, grantWhere, addedSectionModule, migration, files: [...files].sort() }
  saveManifest(m)
  did(`recorded in ${F.manifest}`)

  todo(`fill in ${routeFile} and ${screenFile}; keep worker/PORTING.md rules`)
  todo(`apply the migration: cd worker && node scripts/migrate.mjs up (--remote for the real databases)`)
  todo(`Go server: no Go handler was generated; the feature is Worker-only until the switchover`)
  todo(`run: npm run feature:check; cd worker && npx tsc --noEmit; cd web && npx tsc --noEmit -p .`)
  printLog()
}

let sectionModuleCache = null
function sectionModuleOf(sec) {
  if (!sectionModuleCache) {
    const s = read(F.shell)
    const body = s.slice(s.indexOf('export const SECTION_MODULE'), s.indexOf('\n}\n', s.indexOf('export const SECTION_MODULE')))
    sectionModuleCache = new Map([...body.matchAll(/(\w+):\s*'(\w+)'/g)].map((m) => [m[1], m[2]]))
  }
  return sectionModuleCache.get(sec)
}

function printLog() {
  console.log(log.join('\n'))
  log.length = 0
}

/* ============================================================================================
   feature:remove
   ============================================================================================ */

/** What a feature id or key resolves to. */
async function resolveFeature(o) {
  const want = o.id || o.key || o._[1]
  if (!want) die('--id <section.slug> (or --key <role.section.slug>) is required')
  const m = manifest()
  const cat = catalogIndex(await loadWebCatalog())
  let id = want, onlyKeys = null
  if (want.split('.').length === 3) { const f = cat.get(want); if (!f) die(`${want} is not in the catalogue`); id = f.id; onlyKeys = [want] }
  const keys = onlyKeys ?? [...cat.values()].filter((f) => f.id === id).map((f) => [...cat].find(([, v]) => v === f)[0])
  const entry = m.features[id] ?? null
  if (!keys.length && !entry) die(`no catalogue feature with id ${id}`)
  return { id, keys, entry, m, cat, partial: !!onlyKeys }
}

function referencesOf(id, keys, entry) {
  const ownFiles = new Set(entry?.files ?? [])
  const regFiles = new Set(registryFiles())
  const needles = [...keys]
  if (entry) needles.push(`register${pascal(entry.slug)}`, `${pascal(entry.slug)}Item`, `${pascal(entry.slug)}Api`, `/${entry.webDir}/${pascal(entry.slug)}'`, entry.apiBase + "'")
  const ignore = (f, line) => ownFiles.has(f) || line.includes(markerOf(id)) ||
    (regFiles.has(f) && keys.some((k) => line.includes(`'${k}':`))) ||
    (f === F.switches && line.includes(`'${id}':`)) ||
    (entry && f === F.sharedIndex && /export (interface|type) Api\b/.test(line)) ||
    // catalog-keys.test.ts freezes dead keys; removing the feature fixes them, it does not reference them
    f === 'web/src/features/catalog-keys.test.ts'
  return grepRefs(needles, ignore)
}

async function cmdRemove(o) {
  const { id, keys, entry, m, cat, partial } = await resolveFeature(o)
  console.log(`feature:remove ${id} (${keys.join(', ') || 'no catalogue rows left'})`)
  const refs = referencesOf(id, keys, entry)
  if (o['dry-run']) { console.log(refs.length ? 'References:\n  ' + refs.join('\n  ') : 'No references outside the places feature:remove edits.'); return }
  if (refs.length && !o.force) {
    console.error('Refusing: these still reference the feature. Remove or rewire them first (or --force to proceed anyway):')
    for (const r of refs) console.error('  ' + r)
    process.exit(2)
  }
  const maps = genCatalogMaps()

  // catalogue rows
  const csv = readCsv()
  const keep = csv.rows.filter((row) => !keys.includes(csvKeyOf(row, maps).key))
  if (keep.length !== csv.rows.length) { write(F.csv, [csv.lines[0], ...keep.map((r) => r.line)].join('\n') + '\n'); did(`removed ${csv.rows.length - keep.length} catalogue row(s) from ${F.csv}`) }
  else skip('no catalogue rows')

  // registry entries
  for (const f of registryFiles()) for (const k of keys) if (removeRegistryEntry(f, k)) did(`registry: removed ${k} from ${f}`)

  // feature switch, unless another role still has the same section.slug
  const stillThere = [...cat.entries()].some(([k, f]) => f.id === id && !keys.includes(k))
  if (!stillThere) {
    const s = read(F.switches)
    const n = s.split('\n').filter((l) => !l.startsWith(`  '${id}':`)).join('\n')
    if (n !== s) { write(F.switches, n); did(`FEATURE_ROUTES: removed ${id}`) }
  }

  if (entry && !partial) {
    // grants, then the permissions this script created
    for (const [k, where] of Object.entries(entry.grantWhere ?? {})) { const [role, key] = k.split(' '); ungrant(role, key, where) }
    for (const p of entry.createdPerms) removePermission(p.key)
    if (entry.group) removeGroup(entry.group)
    for (const f of [F.goRbac, F.goModel, F.routesIndex, F.shell, F.registry, F.switches]) { const n = stripMarkers(f, id); if (n) did(`removed ${n} marked line(s) from ${f}`) }
    unwireSharedIndex(`${pascal(entry.slug)}Api`, id)
    // generated files; a migration that was never committed was never applied anywhere and goes too
    for (const f of entry.files) {
      if (!exists(f)) continue
      if (f === entry.migration && !untracked(f)) { skip(`kept ${f}: committed, may be applied (forward-only)`); continue }
      fs.rmSync(P(f)); did(`deleted ${f}`)
      const dir = path.dirname(P(f)); if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
    }
    if (entry.migration && exists(entry.migration)) newMigration(`retire_${entry.slug}`, tplRetire({ ...entry, id }, !!o['drop-tables']))
    else if (entry.table && o['drop-tables']) newMigration(`retire_${entry.slug}`, tplRetire({ ...entry, id }, true))
    delete m.features[id]
    saveManifest(m)
    did(`removed ${id} from ${F.manifest}`)
  } else {
    todo('hand-built feature: its route file, screen, permissions and tables are left in place (they may be shared); retire them per docs/feature-anatomy.md')
    if (keys.length) newMigration(`retire_${id.replace(/\./g, '_')}`, tplRetire({ id, name: id, keys, createdPerms: [], table: o['drop-tables'] ? o.table : null }, !!o['drop-tables']))
  }
  await regenerate()
  printLog()
}

/* ============================================================================================
   feature:rename
   ============================================================================================ */

async function cmdRename(o) {
  const { id, keys, entry, m, cat } = await resolveFeature(o)
  const to = o.to || die('--to "New name" is required')
  const maps = genCatalogMaps()
  const newSlug = slug(to)
  const oldSlug = cat.get(keys[0])?.slug ?? entry?.slug
  const sec = id.split('.')[0]
  const newId = `${sec}.${newSlug}`
  console.log(`feature:rename ${id} -> ${newId} ("${to}")`)
  const newKeys = keys.map((k) => k.replace(/\.[^.]+$/, '.' + newSlug))
  for (const k of newKeys) if (cat.has(k) && !keys.includes(k)) die(`${k} already exists`)

  if (newSlug !== oldSlug && !o['keep-key']) {
    const refs = referencesOf(id, keys, entry)
    if (refs.length && !o.force) {
      console.error('Refusing: renaming changes the key, and these still reference the old one (use --keep-key to rename the label only):')
      for (const r of refs) console.error('  ' + r)
      process.exit(2)
    }
  }

  // catalogue: the Feature column
  const csv = readCsv()
  const lines = [csv.lines[0]]
  for (const row of csv.rows) {
    if (!keys.includes(csvKeyOf(row, maps).key)) { lines.push(row.line); continue }
    const f = csvFields(row.line); f[csv.header.indexOf('Feature')] = to
    lines.push(f.map(csvCell).join(','))
  }
  write(F.csv, lines.join('\n') + '\n')
  did(`catalogue: ${keys.length} row(s) renamed in ${F.csv}`)

  if (newSlug === oldSlug) { await regenerate(); printLog(); return }
  if (o['keep-key']) {
    const s = read(F.genCatalog)
    const anchor = 'FEATURE_SLUG_OVERRIDE = {\n'
    if (!s.includes(`"${to}": "${oldSlug}"`)) {
      write(F.genCatalog, s.replace(anchor, anchor + `    "${to}": "${oldSlug}",  # ${markerOf(id)} (renamed by feature:rename, key kept)\n`))
      did(`gen_catalog.py FEATURE_SLUG_OVERRIDE "${to}" -> ${oldSlug} (keys unchanged)`)
    }
    await regenerate(); printLog(); return
  }

  // keys everywhere this script put them
  const sub = (file, pairs) => { if (!exists(file)) return; let s = read(file); const b = s; for (const [a, c] of pairs) s = s.split(a).join(c); if (s !== b) { write(file, s); did(`rewrote ${file}`) } }
  const keyPairs = keys.map((k, i) => [`'${k}'`, `'${newKeys[i]}'`])
  for (const f of registryFiles()) sub(f, keyPairs)
  sub(F.switches, [[`'${id}':`, `'${newId}':`]])

  if (entry) {
    const OldP = pascal(oldSlug), NewP = pascal(newSlug)
    const pairs = [[markerOf(id), markerOf(newId)], ...keyPairs, [OldP, NewP], [`/${dashed(oldSlug)}`, `/${dashed(newSlug)}`], [`feature_${oldSlug}`, `feature_${newSlug}`], [`${id}`, `${newId}`], [`/${oldSlug}'`, `/${newSlug}'`], [entry.name, to]]
    const moved = []
    for (const f of entry.files) {
      if (!exists(f)) continue
      if (f === entry.migration) { moved.push(f); continue } // forward-only; the keys it seeded are fixed up by a new migration below
      const nf = f.replace(`/${OldP}.tsx`, `/${NewP}.tsx`).replace(`/${oldSlug}.ts`, `/${newSlug}.ts`).replace(`feature_${oldSlug}`, `feature_${newSlug}`)
      sub(f, pairs)
      if (nf !== f) { fs.renameSync(P(f), P(nf)); did(`moved ${f} -> ${nf}`) }
      moved.push(nf)
    }
    for (const f of [F.goRbac, F.goModel, F.routesIndex, F.shell, F.registry, F.switches, F.sharedIndex]) sub(f, pairs.filter(([a]) => a !== entry.name))
    const sd = jsonLine(F.staticData, 'GROUPS'); const g = sd.value.find((x) => x.key === entry.group)
    const newGroup = entry.group ? newId.replace(/\./g, '_') : null
    if (g) { g.key = newGroup; g.name = to; sd.save(sd.value); did(`Worker GROUPS ${entry.group} -> ${newGroup}`) }
    if (entry.group) sub(F.goModel, [[`"${entry.group}"`, `"${newGroup}"`], [goStr(entry.name), goStr(to)]])
    const renameSql = keys.map((k, i) => `UPDATE OR IGNORE role_permissions SET permission_key = ${sqlStr(newKeys[i])} WHERE permission_key = ${sqlStr(k)};`)
    const mig = entry.migration && exists(entry.migration) && untracked(entry.migration)
      ? (sub(entry.migration, pairs), entry.migration)
      : newMigration(`rename_${oldSlug}_to_${newSlug}`, keys.map((k, i) => `INSERT OR IGNORE INTO permissions (key, module, description) SELECT ${sqlStr(newKeys[i])}, module, description FROM permissions WHERE key = ${sqlStr(k)};`).concat(renameSql, keys.map((k) => `DELETE FROM permissions WHERE key = ${sqlStr(k)};`)).join('\n') + '\n')
    delete m.features[id]
    m.features[newId] = { ...entry, name: to, slug: newSlug, keys: newKeys, apiBase: entry.apiBase.replace(`/${dashed(oldSlug)}`, `/${dashed(newSlug)}`), group: newGroup,
      files: [...new Set([...moved.filter((f) => f !== entry.migration), mig])].sort(), migration: entry.migration && untracked(entry.migration) ? entry.migration : entry.migration }
    saveManifest(m)
    did(`manifest: ${id} -> ${newId}`)
  } else {
    newMigration(`rename_${id.replace(/\./g, '_')}`, keys.map((k, i) => `INSERT OR IGNORE INTO permissions (key, module, description) SELECT ${sqlStr(newKeys[i])}, module, description FROM permissions WHERE key = ${sqlStr(k)};\nUPDATE OR IGNORE role_permissions SET permission_key = ${sqlStr(newKeys[i])} WHERE permission_key = ${sqlStr(k)};`).join('\n') + '\n')
  }
  await regenerate()
  printLog()
}

/* ============================================================================================
   feature:check
   ============================================================================================ */

function walkFiles(dir, re) {
  const out = []
  if (!exists(dir)) return out
  for (const e of fs.readdirSync(P(dir), { withFileTypes: true })) {
    const f = dir + '/' + e.name
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...walkFiles(f, re)) } else if (re.test(e.name)) out.push(f)
  }
  return out
}

function resolveImport(from, spec, alias) {
  let base
  if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))
  else if (alias && spec.startsWith('@/')) base = alias + spec.slice(1)
  else if (spec.startsWith('@shared/')) base = 'shared/' + spec.slice(8)
  else return null
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) if (exists(base + ext) && fs.statSync(P(base + ext)).isFile()) return base + ext
  return null
}

function importsOf(file) {
  const src = read(file)
  return [...src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)'([^']+)'/g)].map((m) => m[1])
}

async function cmdCheck(o) {
  const problems = {}
  const add = (kind, item) => { (problems[kind] ??= []).push(item) }
  const cat = catalogIndex(await loadWebCatalog())
  const reg = registryEntries()
  const planned = new Set(exists(F.planned) ? read(F.planned).split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean) : [])

  // 1. every catalogue feature has a screen or is marked planned
  for (const [k] of cat) if (!reg.has(k) && !planned.has(k)) add('catalogue feature with no screen and not planned', k)
  for (const k of planned) if (reg.has(k)) add('marked planned but has a screen (take it off docs/features-planned.txt)', k)
  for (const k of planned) if (!cat.has(k)) add('marked planned but not in the catalogue', k)
  // 2. every registry key exists in the catalogue, and its screen file exists
  for (const [k, es] of reg) {
    if (!cat.has(k)) add('registry key not in the catalogue', `${k} (${es.map((e) => e.file).join(', ')})`)
    for (const e of es) if (!resolveImport(e.file, './' + path.posix.relative(path.posix.dirname(e.file), e.target))) add('registry points at a missing screen', `${k} -> ${e.target}`)
  }
  // 3. every permission a route uses exists in the role catalogue (and the copies agree)
  const pk = permissionKeys()
  const routeFiles = walkFiles('worker/src/routes', /\.ts$/)
  for (const f of routeFiles) {
    const src = read(f)
    const consts = new Map([...src.matchAll(/const\s+(\w+)\s*=\s*'([a-z][a-z0-9_.]*)'/g)].map((m) => [m[1], m[2]]))
    for (const m of src.matchAll(/\br\.(?:get|post|put|patch|del|typed|on)\(\s*(?:'[A-Z]+',\s*)?['`][^'`]+['`]\s*,\s*('([^']+)'|(\w+))/g)) {
      const perm = m[2] ?? consts.get(m[3])
      if (m[3] && !consts.has(m[3])) continue // computed at runtime; not checkable here
      if (perm === 'auth') continue
      if (cat.has(perm)) continue // a catalogue key is a permission too (seeded into every school)
      if (!pk.worker.has(perm)) add('route permission not in the Worker permission catalogue (static_data PERMISSIONS)', `${perm} (${f})`)
      else if (!pk.go.has(perm)) add('route permission not in Go internal/rbac', `${perm} (${f})`)
    }
  }
  for (const k of pk.worker) if (!pk.go.has(k)) add('permission in the Worker copy but not in Go rbac', k)
  for (const k of pk.go) if (!pk.worker.has(k) && pk.goAll.has(goPermIdents().get(k))) add('permission in Go rbac.All but not in the Worker copy', k)
  const seedPerms = new Set([...read(F.provisionSeed).matchAll(/\["([^"]+)","/g)].map((m) => m[1]))
  for (const k of pk.worker) if (!seedPerms.has(k)) add('permission missing from provision_seed.ts (run go run ./scripts/d1/tenant_seed)', k)
  for (const k of cat.keys()) if (!seedPerms.has(k)) add('catalogue key missing from provision_seed.ts (run go run ./scripts/d1/tenant_seed)', k)
  // grants: static_data SYSTEM_ROLES vs setup/common.ts
  {
    const sr = jsonLine(F.staticData, 'SYSTEM_ROLES').value
    const common = read(F.setupCommon)
    const selfKeys = ['self.profile.read', 'self.profile.write']
    for (const r of sr) {
      const at = common.search(new RegExp(`^  ${r.key}: \\{ name: `, 'm'))
      if (at < 0) continue
      const block = common.slice(at, common.indexOf('] }', at))
      if (/permissions: 'all'/.test(common.slice(at, common.indexOf('\n', at)))) continue
      const have = new Set([...block.matchAll(/'([a-z][a-z0-9_.]+)'/g)].map((m) => m[1]))
      if (block.includes('...SELF')) selfKeys.forEach((k) => have.add(k))
      for (const k of r.permissions) if (!have.has(k)) add('grant in static_data SYSTEM_ROLES but not in setup/common.ts', `${r.key}: ${k}`)
      for (const k of have) if (!r.permissions.includes(k)) add('grant in setup/common.ts but not in static_data SYSTEM_ROLES', `${r.key}: ${k}`)
    }
  }
  // Worker catalogue copy matches the generated one
  {
    const before = read(F.staticData)
    await syncWorkerCatalog()
    const after = read(F.staticData)
    if (before !== after) { write(F.staticData, before); add('Worker catalogue copy is stale (static_data CATALOG_ROLES / IMPLEMENTED_FEATURES)', 'run npm run feature:check -- --fix or scripts/feature.mjs sync') }
  }
  // 4. every Worker route file is registered (reachable from worker/src/index.ts)
  {
    const seen = new Set(), stack = [F.workerEntry]
    while (stack.length) {
      const f = stack.pop()
      if (seen.has(f)) continue
      seen.add(f)
      for (const s of importsOf(f)) { const r = resolveImport(f, s); if (r && r.startsWith('worker/src/')) stack.push(r) }
    }
    for (const f of routeFiles) if (!seen.has(f)) add('Worker route file not registered (not reachable from worker/src/index.ts)', f)
  }
  // 5. no orphan screens: every screen file under web/src/features is imported by something
  {
    const all = walkFiles('web/src', /\.(ts|tsx)$/)
    const imported = new Set()
    for (const f of all) for (const s of importsOf(f)) { const r = resolveImport(f, s, 'web/src'); if (r) imported.add(r) }
    for (const f of all) if (f.startsWith('web/src/features/') && f.endsWith('.tsx') && !/\.test\.tsx$/.test(f) && !imported.has(f)) add('orphan screen (no import reaches it)', f)
  }
  // 6. the manifest's files are still there
  for (const [id, e] of Object.entries(manifest().features)) for (const f of e.files) if (!exists(f)) add('manifest names a missing file', `${id}: ${f}`)
  // switches name real features
  {
    const s = read(F.switches)
    const body = s.slice(s.indexOf('export const FEATURE_ROUTES'), s.indexOf('\n}\n', s.indexOf('export const FEATURE_ROUTES')))
    const ids = new Set([...cat.values()].map((f) => f.id))
    for (const mm of body.matchAll(/^\s*'([^']+)':/gm)) if (!ids.has(mm[1])) add('feature switch (FEATURE_ROUTES) names no catalogue feature', mm[1])
  }

  // baseline: known debt does not fail the check, anything new does
  const baseline = exists(F.baseline) ? JSON.parse(read(F.baseline)).known ?? {} : {}
  if (o['update-baseline']) {
    write(F.baseline, JSON.stringify({ _comment: 'Known inconsistencies as of the date feature:check was introduced. Shrink it; never grow it by hand. `npm run feature:check -- --update-baseline` rewrites it.', known: problems }, null, 2) + '\n')
    console.log(`feature:check: baseline written to ${F.baseline}`)
  }
  let fresh = 0, known = 0, fixed = 0
  const kinds = [...new Set([...Object.keys(problems), ...Object.keys(baseline)])].sort()
  for (const kind of kinds) {
    const now = problems[kind] ?? [], was = new Set(baseline[kind] ?? [])
    const newOnes = now.filter((x) => !was.has(x))
    const gone = [...was].filter((x) => !now.includes(x))
    known += now.length - newOnes.length; fixed += gone.length
    if (newOnes.length) { fresh += newOnes.length; console.log(`\nFAIL ${kind} (${newOnes.length}):`); for (const x of newOnes) console.log('  ' + x) }
    if (o.verbose && now.length - newOnes.length) { console.log(`\nknown ${kind} (${now.length - newOnes.length}):`); for (const x of now.filter((x) => was.has(x))) console.log('  ' + x) }
    if (gone.length && !o['update-baseline']) { console.log(`\nfixed since the baseline, take out of ${F.baseline} (${kind}):`); for (const x of gone) console.log('  ' + x) }
  }
  console.log(`\nfeature:check: ${cat.size} catalogue features, ${reg.size} mapped keys, ${routeFiles.length} route files; ${fresh} new problem(s), ${known} known (baseline), ${fixed} fixed since baseline.`)
  if (fresh && !o['update-baseline']) process.exit(1)
}

/* ============================================================================================ */

const o = parseArgs(process.argv.slice(2))
const cmd = o._[0]
const cmds = { new: cmdNew, remove: cmdRemove, rename: cmdRename, check: cmdCheck, sync: async () => { await regenerate(); printLog() } }
if (!cmds[cmd]) {
  console.error('usage: node scripts/feature.mjs new|rename|remove|check|sync [flags]   (see docs/feature-anatomy.md)')
  process.exit(2)
}
await cmds[cmd](o)
