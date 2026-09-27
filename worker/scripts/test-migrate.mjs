#!/usr/bin/env node
// Migration runner test on plain SQLite files (no wrangler, no network):
//   1. an existing (baselined) CONTROL + two schools; a new migration per scope;
//      up applies it everywhere, a second up changes nothing;
//   2. a school with tables but no history is refused;
//   3. editing an applied migration is a checksum error (status and up);
//   4. schema-sync output equals applying the migrations, and is current;
//      a database loaded from db/tenant.sql + provisioning's record has nothing pending.
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { WORKER, buildFresh, listMigrations, plan } from './migrate-lib.mjs'
import { generate } from './schema-sync.mjs'

let failures = 0
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++ }
const tmp = mkdtempSync(join(tmpdir(), 'migrate-test-'))
const root = join(tmp, 'worker'), dbs = join(tmp, 'dbs')
// A copy of the worker's migrations and scripts, so the test can add files.
for (const d of ['migrations', 'scripts']) cpSync(join(WORKER, d), join(root, d), { recursive: true })
cpSync(join(WORKER, 'wrangler.jsonc'), join(root, 'wrangler.jsonc'))
spawnSync('mkdir', ['-p', dbs])

const migrate = (...args) => {
  const r = spawnSync(process.execPath, ['--no-warnings', join(root, 'scripts/migrate.mjs'), ...args, '--sqlite', dbs], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}
const sqlite = (f) => new DatabaseSync(join(dbs, f))

// Existing databases: fresh schemas, as production has them, with history marked.
const g = await generate()
const load = (f, sql) => { const d = sqlite(f); d.exec(sql); d.close() }
const stripHistory = (sql) => sql.split('\n').filter((l) => !l.startsWith('INSERT OR IGNORE INTO _migrations')).join('\n')
load('control.sqlite', stripHistory(g['db/control.sql']).replace(/CREATE TABLE _migrations \([\s\S]*?\);/, ''))
{
  const c = sqlite('control.sqlite')
  for (const s of ['alpha', 'beta', 'gamma']) c.prepare('INSERT INTO institutions (id, name, short_name, slug, d1_database_id, d1_binding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(s, s, s, s, 'id-' + s, 'TENANT_' + s.toUpperCase(), "2026-01-01", "2026-01-01")
  c.close()
}
for (const s of ['alpha', 'beta', 'gamma']) load(`${s}.sqlite`, stripHistory(g['db/tenant.sql']).replace(/CREATE TABLE _migrations \([\s\S]*?\);/, ''))

let r = migrate('up')
ok(r.code === 1 && /has tables but no migration history/.test(r.out), 'up refuses a database with tables and no history')
ok(migrate('mark-applied', '--scope', 'control', '--through', '9').code === 0, 'mark-applied control through 0009')
ok(migrate('mark-applied', '--scope', 'tenant', '--through', '1').code === 0, 'mark-applied tenant through 0001')
r = migrate('status')
ok(r.code === 0 && !/pending [0-9]/.test(r.out), 'status: nothing pending after marking')

// New migrations.
writeFileSync(join(root, 'migrations/control/0010_test_note.sql'), 'ALTER TABLE institutions ADD COLUMN test_note TEXT;\n')
writeFileSync(join(root, 'migrations/tenant/0002_test_table.sql'), 'CREATE TABLE IF NOT EXISTS test_things (id TEXT PRIMARY KEY);\nINSERT OR IGNORE INTO test_things VALUES (\'x\');\n')
r = migrate('up', '--dry-run')
ok(r.code === 0 && /would apply control 0010/.test(r.out) && /would apply tenant 0002/.test(r.out), 'dry-run lists pending work')
ok(!sqlite('alpha.sqlite').prepare("SELECT 1 FROM sqlite_master WHERE name = 'test_things'").get(), 'dry-run changed nothing')
r = migrate('up', '--limit', '2')
ok(r.code === 0 && /limit of 2 schools reached/.test(r.out), 'up stops at --limit')
ok(!sqlite('gamma.sqlite').prepare("SELECT 1 FROM sqlite_master WHERE name = 'test_things'").get(), 'third school left for the next run')
r = migrate('up')
ok(r.code === 0 && /school gamma: 1 applied/.test(r.out), 'second up finishes the rest')
r = migrate('up')
ok(r.code === 0 && !/applied (control|tenant)/.test(r.out), 'up again is a no-op')
ok(sqlite('control.sqlite').prepare("SELECT count(*) AS n FROM pragma_table_info('institutions') WHERE name = 'test_note'").get().n === 1, 'control migration applied once')
for (const s of ['alpha', 'beta', 'gamma']) ok(sqlite(`${s}.sqlite`).prepare('SELECT count(*) AS n FROM _migrations').get().n === 2, `${s}: 2 tenant migrations recorded`)

// One school only; a failure names the school and stops.
writeFileSync(join(root, 'migrations/tenant/0003_breaks.sql'), 'ALTER TABLE test_things ADD COLUMN extra TEXT;\n')
{ const b = sqlite('beta.sqlite'); b.exec('ALTER TABLE test_things ADD COLUMN extra TEXT'); b.close() }
r = migrate('up', '--school', 'alpha')
ok(r.code === 0 && /school alpha: 1 applied/.test(r.out) && !/school beta/.test(r.out), 'up --school touches one school')
r = migrate('up')
ok(r.code === 1 && /FAILED at school beta/.test(r.out), 'failure reports the school')
ok(!sqlite('gamma.sqlite').prepare("SELECT 1 FROM pragma_table_info('test_things') WHERE name = 'extra'").get(), 'schools after the failure untouched')
ok(sqlite('beta.sqlite').prepare('SELECT count(*) AS n FROM _migrations WHERE version = 3').get().n === 0, 'failed migration not recorded')
rmSync(join(root, 'migrations/tenant/0003_breaks.sql'))
{ const a = sqlite('alpha.sqlite'); a.exec("DELETE FROM _migrations WHERE version = 3"); a.close() }

// Checksum drift.
appendFileSync(join(root, 'migrations/tenant/0002_test_table.sql'), '-- edited after the fact\n')
r = migrate('status')
ok(r.code === 1 && /checksum mismatch/.test(r.out), 'status reports checksum drift')
r = migrate('up')
ok(r.code === 1 && /checksum mismatch/.test(r.out) && /FAILED at school alpha/.test(r.out), 'up refuses on checksum drift')

// schema-sync equals applying the migrations (real migrations, not the test ones).
const shape = (d) => JSON.stringify({
  objs: d.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
  cols: d.prepare("SELECT m.name AS t, p.* FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' ORDER BY m.name, p.cid").all(),
  idx: d.prepare("SELECT m.name AS t, l.name, l.\"unique\", l.partial FROM sqlite_master m, pragma_index_list(m.name) l WHERE m.type = 'table' ORDER BY m.name, l.name").all(),
  fks: d.prepare("SELECT m.name AS t, f.* FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table' ORDER BY m.name, f.id, f.seq").all(),
  mig: d.prepare('SELECT scope, version, name, checksum FROM _migrations ORDER BY scope, version').all(),
})
for (const scope of ['control', 'tenant']) {
  const { target } = await buildFresh(scope)
  const fromSql = new DatabaseSync(':memory:'); fromSql.exec(g[`db/${scope}.sql`])
  ok(shape(target.db) === shape(fromSql), `db/${scope}.sql equals applying migrations/${scope}`)
  ok(readFileSync(join(WORKER, `db/${scope}.sql`), 'utf8') === g[`db/${scope}.sql`], `db/${scope}.sql is current (npm run schema:sync)`)
  const p = plan(listMigrations(scope), fromSql.prepare('SELECT * FROM _migrations').all(), scope)
  ok(p.pending.length === 0 && p.errors.length === 0, `a database from db/${scope}.sql has nothing pending`)
}
ok(readFileSync(join(WORKER, 'src/services/tenant_migrations.ts'), 'utf8') === g['src/services/tenant_migrations.ts'], 'src/services/tenant_migrations.ts is current')

// Provisioning's path: tenant.sql through schemaChunks-style loading, then its record.
{
  const d = new DatabaseSync(':memory:')
  d.exec(g['db/tenant.sql'].split('\n').filter((l) => !l.startsWith('INSERT OR IGNORE INTO _migrations')).join('\n'))
  const src = readFileSync(join(WORKER, 'src/services/tenant_migrations.ts'), 'utf8')
  for (const m of src.matchAll(/version: (\d+), name: '([^']+)', checksum: '([0-9a-f]+)'/g)) d.prepare("INSERT OR IGNORE INTO _migrations (scope, version, name, checksum) VALUES ('tenant', ?, ?, ?)").run(Number(m[1]), m[2], m[3])
  const p = plan(listMigrations('tenant'), d.prepare('SELECT * FROM _migrations').all(), 'tenant')
  ok(p.pending.length === 0 && p.errors.length === 0, 'a provisioned school (tenant.sql + TENANT_MIGRATIONS) has nothing pending')
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures ? `\n${failures} failure(s)` : '\nall passed')
process.exit(failures ? 1 : 0)
