#!/usr/bin/env node
// Schema migrations for CONTROL and every school database.
//
//   node scripts/migrate.mjs status                  applied / pending per database
//   node scripts/migrate.mjs up                      CONTROL, then every school (stops at the first failure)
//   node scripts/migrate.mjs up --school <slug>      CONTROL untouched; one school
//   node scripts/migrate.mjs new <control|tenant> <name>
//   node scripts/migrate.mjs mark-applied --scope <control|tenant> --through <N> [--school <slug>]
//                                                    record 0001..N as applied WITHOUT running them (one-time baseline)
//
// Where:  --local (default; wrangler's local D1)  --remote (the real databases)
//         --sqlite <dir> (plain SQLite files: <dir>/control.sqlite, <dir>/<slug>.sqlite; tests)
// Also:   --dry-run   --limit <n> (schools with pending work per run, default 25)
//
// Schools come from CONTROL.institutions (slug, d1_binding, d1_database_id).
// A school whose binding is in wrangler.jsonc goes through `wrangler d1 execute`;
// one without (created from Tenants → New school, not yet deployed) goes over
// the D1 HTTP API with CF_ACCOUNT_ID and CF_API_TOKEN (remote only).
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  WORKER, SCOPES, TRACKING_SQL, listMigrations, plan, pad, recordSql,
  sqliteTarget, wranglerTarget, httpTarget, readWranglerConfig,
} from './migrate-lib.mjs'

function parseArgs(argv) {
  const o = { _: [], dryRun: false, mode: 'local', limit: 25 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--remote') o.mode = 'remote'
    else if (a === '--local') o.mode = 'local'
    else if (a === '--sqlite') { o.mode = 'sqlite'; o.dir = argv[++i] }
    else if (a === '--school') o.school = argv[++i]
    else if (a === '--limit') o.limit = Number(argv[++i])
    else if (a === '--scope') o.scope = argv[++i]
    else if (a === '--through') o.through = Number(argv[++i])
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else o._.push(a)
  }
  return o
}

// --- the databases --------------------------------------------------------

async function controlTarget(o) {
  if (o.mode === 'sqlite') return sqliteTarget(join(o.dir, 'control.sqlite'), 'CONTROL')
  const cfg = readWranglerConfig()
  const c = (cfg.d1_databases ?? []).find((d) => d.binding === 'CONTROL')
  if (!c) throw new Error('no CONTROL binding in wrangler.jsonc')
  return wranglerTarget(c.database_name, o.mode, 'CONTROL')
}

/** Every school, in slug order: { slug, target } or { slug, skip }. */
async function schoolTargets(o, control) {
  const rows = await control.query('SELECT slug, d1_binding, d1_database_id FROM institutions ORDER BY slug')
  const list = o.school ? rows.filter((r) => r.slug === o.school) : rows
  if (o.school && list.length === 0) throw new Error(`no school with slug ${o.school} in CONTROL`)
  const bindings = new Map(o.mode === 'sqlite' ? [] : (readWranglerConfig().d1_databases ?? []).map((d) => [d.binding, d.database_name]))
  const acc = process.env.CF_ACCOUNT_ID, tok = process.env.CF_API_TOKEN
  const out = []
  for (const r of list) {
    const label = `school ${r.slug}`
    if (o.mode === 'sqlite') {
      const f = join(o.dir, `${r.slug}.sqlite`)
      out.push(existsSync(f) ? { slug: r.slug, target: await sqliteTarget(f, label) } : { slug: r.slug, skip: `no ${f}` })
    } else if (bindings.has(r.d1_binding)) {
      out.push({ slug: r.slug, target: wranglerTarget(bindings.get(r.d1_binding), o.mode, label) })
    } else if (o.mode === 'local') {
      out.push({ slug: r.slug, skip: `no binding ${r.d1_binding} in wrangler.jsonc (local mode reaches bound databases only)` })
    } else if (!r.d1_database_id || String(r.d1_database_id).startsWith('local-')) {
      out.push({ slug: r.slug, skip: `no database id` })
    } else if (acc && tok) {
      out.push({ slug: r.slug, target: httpTarget(acc, tok, r.d1_database_id, `${label} (D1 API)`) })
    } else {
      out.push({ slug: r.slug, error: `no binding ${r.d1_binding} and no CF_ACCOUNT_ID/CF_API_TOKEN for the D1 API` })
    }
  }
  return out
}

async function readApplied(t, create) {
  if (create) await t.exec(TRACKING_SQL)
  const has = await t.query(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '_migrations'`)
  if (!Number(has[0]?.n)) return []
  return t.query('SELECT scope, version, name, checksum, applied_at FROM _migrations')
}

// --- commands -------------------------------------------------------------

async function status(o) {
  const control = await controlTarget(o)
  let bad = false
  const show = async (t, scope) => {
    const rows = await readApplied(t, false)
    const p = plan(listMigrations(scope), rows, scope)
    const tracked = rows.length ? '' : ' (no _migrations table: run mark-applied once)'
    console.log(`${t.label}: ${p.applied.length} applied, ${p.pending.length} pending${tracked}`)
    for (const m of p.pending) console.log(`  pending ${pad(m.version)}_${m.name}`)
    for (const e of p.errors) { console.log(`  ERROR ${e}`); bad = true }
  }
  if (!o.school) await show(control, 'control')
  for (const s of await schoolTargets(o, control)) {
    if (s.skip) { console.log(`school ${s.slug}: skipped, ${s.skip}`); continue }
    if (s.error) { console.log(`school ${s.slug}: ERROR ${s.error}`); bad = true; continue }
    try { await show(s.target, 'tenant') } catch (e) { console.log(`school ${s.slug}: ERROR ${e.message}`); bad = true }
  }
  return bad ? 1 : 0
}

/** Apply a database's pending migrations; returns the number applied. Throws on the first failure. */
async function migrateOne(t, scope, o) {
  const rows = await readApplied(t, !o.dryRun)
  const p = plan(listMigrations(scope), rows, scope)
  if (p.errors.length) throw new Error(p.errors.join('; '))
  if (!rows.length && p.pending.length && p.pending[0].version === 1) {
    // An existing database with no history would get the baseline run over it.
    const tables = await t.query(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT IN ('_migrations', '_cf_KV', 'd1_migrations') AND name NOT LIKE 'sqlite_%'`)
    if (Number(tables[0]?.n) > 0) throw new Error(`${t.label} has tables but no migration history; run mark-applied once (see docs/cloudflare-stack.md)`)
  }
  for (const m of p.pending) {
    if (o.dryRun) { console.log(`  would apply ${scope} ${pad(m.version)}_${m.name} to ${t.label}`); continue }
    try { await t.apply(m) } catch (e) { throw new Error(`${scope} ${pad(m.version)}_${m.name}: ${e.message}`) }
    console.log(`  applied ${scope} ${pad(m.version)}_${m.name} to ${t.label}`)
  }
  return p.pending.length
}

async function up(o) {
  const control = await controlTarget(o)
  if (!o.school) {
    try {
      const n = await migrateOne(control, 'control', o)
      console.log(`CONTROL: ${n ? `${n} ${o.dryRun ? 'pending' : 'applied'}` : 'up to date'}`)
    } catch (e) { console.error(`FAILED at CONTROL: ${e.message}`); return 1 }
  }
  let worked = 0, done = 0
  const schools = await schoolTargets(o, control)
  for (const s of schools) {
    if (s.skip) { console.log(`school ${s.slug}: skipped, ${s.skip}`); continue }
    if (s.error) { console.error(`FAILED at school ${s.slug}: ${s.error}`); return 1 }
    if (worked >= o.limit) { console.log(`limit of ${o.limit} schools reached; run up again for the rest`); break }
    try {
      const n = await migrateOne(s.target, 'tenant', o)
      if (n) worked++
      done++
      console.log(`school ${s.slug}: ${n ? `${n} ${o.dryRun ? 'pending' : 'applied'}` : 'up to date'}`)
    } catch (e) {
      console.error(`FAILED at school ${s.slug}: ${e.message}`)
      console.error(`${done} school(s) before it are done; fix and run up again (it resumes).`)
      return 1
    }
  }
  return 0
}

async function markApplied(o) {
  if (!SCOPES.includes(o.scope) || !(o.through >= 1)) throw new Error('mark-applied needs --scope control|tenant and --through <N>')
  const files = listMigrations(o.scope).filter((m) => m.version <= o.through)
  const control = await controlTarget(o)
  const targets = o.scope === 'control' ? [{ slug: 'CONTROL', target: control }] : await schoolTargets(o, control)
  for (const s of targets) {
    if (s.skip) { console.log(`school ${s.slug}: skipped, ${s.skip}`); continue }
    if (s.error) { console.error(`school ${s.slug}: ${s.error}`); return 1 }
    const rows = await readApplied(s.target, !o.dryRun)
    const have = new Set(rows.filter((r) => r.scope === o.scope).map((r) => Number(r.version)))
    const todo = files.filter((m) => !have.has(m.version))
    if (!todo.length) { console.log(`${s.target.label}: already recorded`); continue }
    if (o.dryRun) { console.log(`${s.target.label}: would record ${todo.map((m) => pad(m.version)).join(', ')}`); continue }
    await s.target.exec(todo.map((m) => recordSql(m).replace(/^INSERT/, 'INSERT OR IGNORE')).join('\n'))
    console.log(`${s.target.label}: recorded ${todo.map((m) => `${pad(m.version)}_${m.name}`).join(', ')} as applied`)
  }
  return 0
}

function newMigration(o) {
  const [scope, ...words] = o._.slice(1)
  if (!SCOPES.includes(scope) || !words.length) throw new Error('usage: new <control|tenant> <name>')
  const name = words.join('_').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  const all = listMigrations(scope)
  const version = (all.length ? all[all.length - 1].version : 0) + 1
  const dir = join(WORKER, 'migrations', scope)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${pad(version)}_${name}.sql`)
  writeFileSync(file, `-- ${pad(version)}_${name} (${scope}${scope === 'tenant' ? ': every school database' : ': CONTROL only'}).
-- What and why, in a sentence or two.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

`)
  console.log(file)
  return 0
}

const o = parseArgs(process.argv.slice(2))
const cmd = o._[0]
try {
  const code = cmd === 'status' ? await status(o)
    : cmd === 'up' ? await up(o)
    : cmd === 'mark-applied' ? await markApplied(o)
    : cmd === 'new' ? newMigration(o)
    : (console.error('usage: migrate.mjs status|up|new|mark-applied [--local|--remote|--sqlite <dir>] [--school <slug>] [--dry-run] [--limit <n>]'), 2)
  process.exit(code)
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
