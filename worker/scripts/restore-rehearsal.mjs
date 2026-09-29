#!/usr/bin/env node
// Restore rehearsal: prove a school's backup restores, into a NEW scratch D1.
//
//   node scripts/restore-rehearsal.mjs --school <slug> [--from-r2 <key>] [--keep]
//
//   1. Export the school's database with the D1 export API (`wrangler d1 export`,
//      the same export the weekly job backup:weekly_export takes) and put it,
//      gzipped, in the FILES_WRITE bucket at backups/<slug>/weekly/<date>.sql.gz.
//      With --from-r2 <key> the export is skipped and that backup is used.
//   2. Download that object back from R2 and gunzip it (what a real restore does).
//   3. Create the scratch database school-erp-restore-test (refuses if it exists).
//   4. Load the dump into it.
//   5. Compare row counts, table by table, with the live school database.
//   6. Delete the scratch database (unless --keep).
// Nothing is written to the school's own database. See docs/d1-health.md.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKER, readWranglerConfig } from './migrate-lib.mjs'

const LIMIT_MIN = Number(process.env.REHEARSAL_TIMEOUT_MIN || 30)
setTimeout(() => { console.error(`restore-rehearsal: gave up after ${LIMIT_MIN} min (scratch database may remain: npx wrangler d1 delete ${SCRATCH} -y)`); process.exit(3) }, LIMIT_MIN * 60_000).unref()

const SCRATCH = 'school-erp-restore-test'
const BUCKET = 'school-erp-d1-uploads' // FILES_WRITE; never "school-erp"

function args(argv) {
  const o = { keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--school') o.school = argv[++i]
    else if (a === '--from-r2') o.key = argv[++i]
    else if (a === '--keep') o.keep = true
    else throw new Error(`unknown option ${a}`)
  }
  if (!o.school) throw new Error('usage: restore-rehearsal.mjs --school <slug> [--from-r2 <key>] [--keep]')
  return o
}

function wrangler(cmd, { allowFail = false } = {}) {
  const r = spawnSync('npx', ['wrangler', ...cmd], { cwd: WORKER, encoding: 'utf8', maxBuffer: 512 << 20 })
  if (r.status !== 0 && !allowFail) throw new Error(`wrangler ${cmd.slice(0, 3).join(' ')}: ${(r.stderr || r.stdout || '').trim().slice(-1500)}`)
  return { ok: r.status === 0, out: r.stdout + r.stderr }
}
function query(db, sql) {
  const { out } = wrangler(['d1', 'execute', db, '--remote', '--json', `--command=${sql}`])
  const s = out.slice(out.indexOf('['))
  const parsed = JSON.parse(s.slice(0, s.lastIndexOf(']') + 1))
  return parsed[parsed.length - 1]?.results ?? []
}
const counts = (db) => {
  const tables = query(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name`).map((r) => r.name)
  const out = new Map()
  for (let i = 0; i < tables.length; i += 80) {
    const part = tables.slice(i, i + 80)
    const row = query(db, 'SELECT ' + part.map((t, j) => `(SELECT count(*) FROM "${t}") AS c${j}`).join(', '))[0]
    part.forEach((t, j) => out.set(t, Number(row[`c${j}`])))
  }
  return out
}

/** The dump, re-ordered so no row precedes a table it references (python3's sqlite3, no extra install). */
function reorderDump(file, dir) {
  const py = String.raw`
import sqlite3, sys
db = sqlite3.connect(sys.argv[2])
db.executescript(open(sys.argv[1], encoding='utf-8').read())
def q(x): return '"' + x.replace('"', '""') + '"'
def lit(v):
    if v is None: return 'NULL'
    if isinstance(v, (int, float)): return repr(v)
    if isinstance(v, bytes): return "X'" + v.hex() + "'"
    return "'" + str(v).replace("'", "''") + "'"
master = db.execute("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").fetchall()
tabs = [n for t, n, _ in master if t == 'table']
fks = {t: db.execute(f'PRAGMA foreign_key_list({q(t)})').fetchall() for t in tabs}
deps = {t: {r[2] for r in fks[t] if r[2] != t and r[2] in tabs} for t in tabs}
order, seen = [], set()
def visit(t, stack=()):
    if t in seen or t in stack: return
    for d in sorted(deps[t]): visit(d, stack + (t,))
    seen.add(t); order.append(t)
for t in sorted(tabs): visit(t)
rank = {t: i for i, t in enumerate(order)}
out = ['PRAGMA defer_foreign_keys = true;']
out += [sql + ';' for t, n, sql in master if t == 'table']
later = []
for t in order:
    info = db.execute(f'PRAGMA table_info({q(t)})').fetchall()
    cols = [c[1] for c in info]
    notnull = {c[1] for c in info if c[3]}
    # Foreign keys to this table or to one loaded later (a cycle): loaded NULL, set afterwards.
    back = {r[3] for r in fks[t] if r[2] == t or rank.get(r[2], -1) >= rank[t]} - notnull
    rowid = not db.execute("SELECT sql FROM sqlite_master WHERE name = ?", (t,)).fetchone()[0].upper().replace(' ', '').endswith('WITHOUTROWID')
    sel = (['rowid'] if rowid else []) + cols
    for row in db.execute(f'SELECT {", ".join(q(c) for c in sel)} FROM {q(t)}'):
        vals = dict(zip(sel, row))
        fix = {c: vals[c] for c in back if vals[c] is not None}
        ins = [c for c in sel]
        out.append(f'INSERT INTO {q(t)} ({", ".join(q(c) for c in ins)}) VALUES ({", ".join("NULL" if c in fix else lit(vals[c]) for c in ins)});')
        if fix and rowid:
            later.append(f'UPDATE {q(t)} SET {", ".join(f"{q(c)} = {lit(v)}" for c, v in fix.items())} WHERE rowid = {vals["rowid"]};')
out += later
out += [sql + ';' for t, n, sql in master if t != 'table']
sys.stdout.write('\n'.join(out) + '\n')
`
  const r = spawnSync('python3', ['-c', py, file, join(dir, 'local.sqlite')], { encoding: 'utf8', maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error('reordering the dump: ' + (r.stderr || '').slice(-800))
  return Buffer.from(r.stdout)
}

async function main() {
  const o = args(process.argv.slice(2))
  const cfg = readWranglerConfig()
  const ctl = cfg.d1_databases.find((d) => d.binding === 'CONTROL')
  const inst = query(ctl.database_name, `SELECT slug, d1_binding FROM institutions WHERE slug = '${o.school.replace(/'/g, "''")}'`)[0]
  if (!inst) throw new Error(`no school ${o.school}`)
  const live = cfg.d1_databases.find((d) => d.binding === inst.d1_binding)?.database_name
  if (!live) throw new Error(`no binding ${inst.d1_binding} in wrangler.jsonc`)
  const dir = mkdtempSync(join(tmpdir(), 'rehearsal-'))
  const t0 = Date.now()
  let created = false
  try {
    let key = o.key
    if (!key) {
      const date = new Date().toISOString().slice(0, 10)
      key = `backups/${o.school}/weekly/${date}.sql.gz`
      console.log(`1. exporting ${live} with the D1 export API`)
      wrangler(['d1', 'export', live, '--remote', `--output=${join(dir, 'export.sql')}`])
      writeFileSync(join(dir, 'export.sql.gz'), gzipSync(readFileSync(join(dir, 'export.sql'))))
      wrangler(['r2', 'object', 'put', `${BUCKET}/${key}`, `--file=${join(dir, 'export.sql.gz')}`, '--content-type=application/gzip', '--remote'])
      console.log(`   -> r2://${BUCKET}/${key}`)
    }
    console.log(`2. downloading r2://${BUCKET}/${key}`)
    wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, `--file=${join(dir, 'restore.sql.gz')}`, '--remote'])
    /* A D1 export writes each table's CREATE then its rows, in sqlite_master order, so a
       row can arrive for a table whose foreign key names a table created later, and D1
       refuses it ("no such table: main.files") even with deferred checks. So the dump is
       loaded into a local SQLite first and re-emitted as: every CREATE TABLE, then every
       row, then indexes, triggers and views (reorderDump). */
    writeFileSync(join(dir, 'raw.sql'), gunzipSync(readFileSync(join(dir, 'restore.sql.gz'))))
    const sql = reorderDump(join(dir, 'raw.sql'), dir)
    writeFileSync(join(dir, 'restore.sql'), sql)
    console.log(`   ${sql.length} bytes of SQL`)
    console.log(`3. creating ${SCRATCH}`)
    const mk = wrangler(['d1', 'create', SCRATCH], { allowFail: true })
    if (!mk.ok) throw new Error(`could not create ${SCRATCH} (it may exist already; delete it first): ${mk.out.trim().slice(-400)}`)
    created = true
    console.log(`4. loading the dump`)
    wrangler(['d1', 'execute', SCRATCH, '--remote', '--yes', `--file=${join(dir, 'restore.sql')}`])
    console.log(`5. comparing row counts`)
    const [a, b] = [counts(live), counts(SCRATCH)]
    let diff = 0, rows = 0
    for (const [t, n] of a) {
      rows += n
      const m = b.get(t)
      if (m !== n) { diff++; console.log(`   MISMATCH ${t}: live ${n}, restored ${m ?? 'missing'}`) }
    }
    for (const t of b.keys()) if (!a.has(t)) { diff++; console.log(`   extra table in restore: ${t}`) }
    console.log(`   ${a.size} tables, ${rows} rows in the live database; ${diff} table(s) differ`)
    console.log(diff === 0 ? 'RESULT: restore matches' : 'RESULT: restore differs (rows written to the live school since the export also show here)')
  } finally {
    if (created && !o.keep) {
      console.log(`6. deleting ${SCRATCH}`)
      wrangler(['d1', 'delete', SCRATCH, '-y'], { allowFail: true })
    }
    rmSync(dir, { recursive: true, force: true })
    console.log(`took ${Math.round((Date.now() - t0) / 1000)} s`)
  }
}

main().then(() => process.exit(0), (e) => { console.error('restore-rehearsal:', e.message); process.exit(1) })
