#!/usr/bin/env node
// Archive a CLOSED academic year's high-volume rows out of a school database.
//
//   node scripts/archive-year.mjs --school <slug> --year <id|name> [--remote] [--confirm]
//
// For every table in ARCHIVE below, the rows dated inside the year
// (academic_years.starts_on .. ends_on) are:
//   1. exported, in pages by rowid, as gzipped JSONL to the R2 bucket bound as
//      FILES_WRITE (never "school-erp"), at
//        archive/<slug>/<year name>/<table>.jsonl.gz
//      plus archive/<slug>/<year name>/manifest.json (row counts, sha256, the rowid range);
//   2. verified: each object is downloaded back, gunzipped, its lines counted
//      and parsed, and its sha256 compared with what was uploaded;
//      (a dry run writes under archive-dryrun/ instead, so it is never mistaken for an archive);
//   3. deleted from the database ONLY with --confirm, table by table, and only
//      rows whose rowid is in the verified export (a row written since is kept).
// Without --confirm it is a dry run: it exports and verifies, and deletes nothing.
//
// Refuses a year that is not closed (academic_years.closed_at, or ends_on in the past
// when the school has never closed one), and the year marked current.
// --allow-open lets a DRY RUN export an open year (to rehearse on a school
// that has no closed year yet); it cannot be combined with --confirm.
// Restore: download the JSONL, and INSERT each line's object back into <table>.
// See docs/d1-health.md, "Archiving a closed year".
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKER, readWranglerConfig } from './migrate-lib.mjs'

// Whole-run timer: macOS has no `timeout`, and wrangler can hang on the network.
const LIMIT_MIN = Number(process.env.ARCHIVE_TIMEOUT_MIN || 60)
setTimeout(() => { console.error(`archive-year: gave up after ${LIMIT_MIN} min`); process.exit(3) }, LIMIT_MIN * 60_000).unref()

/** High-volume tables and the column that dates each row. */
export const ARCHIVE = [
  ['student_attendance', 'on_date'],
  ['staff_attendance', 'on_date'],
  ['attendance_corrections', 'created_at'],
  ['transport_attendance', 'created_at'],
  ['message_log', 'queued_at'],
  ['notifications', 'created_at'],
  ['staff_messages', 'sent_at'],
  ['parent_teacher_messages', 'sent_at'],
  ['audit_log', 'created_at'],
  ['app_events', 'created_at'],
  ['login_events', 'created_at'],
  ['session_screens', 'last_at'],
  ['session_activity_views', 'started_at'],
  ['session_activity', 'signed_in_at'],
  ['enquiry_activities', 'created_at'],
  ['lms_lesson_views', 'created_at'],
  ['study_material_views', 'created_at'],
  ['vehicle_positions', 'recorded_at'],
  ['vehicle_logs', 'created_at'],
  ['transport_stop_events', 'created_at'],
  ['call_log', 'created_at'],
]
const BUCKET = 'school-erp-d1-uploads' // FILES_WRITE in wrangler.jsonc
const PAGE = 1000

function args(argv) {
  const o = { remote: false, confirm: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--remote') o.remote = true
    else if (a === '--local') o.remote = false
    else if (a === '--confirm') o.confirm = true
    else if (a === '--allow-open') o.allowOpen = true
    else if (a === '--school') o.school = argv[++i]
    else if (a === '--year') o.year = argv[++i]
    else throw new Error(`unknown option ${a}`)
  }
  if (o.allowOpen && o.confirm) throw new Error('--allow-open is for dry runs only; it cannot be combined with --confirm')
  if (!o.school || !o.year) throw new Error('usage: archive-year.mjs --school <slug> --year <id|name> [--remote] [--confirm]')
  return o
}

function wrangler(cmd) {
  const r = spawnSync('npx', ['wrangler', ...cmd], { cwd: WORKER, encoding: 'utf8', maxBuffer: 512 << 20 })
  if (r.status !== 0) throw new Error(`wrangler ${cmd.slice(0, 3).join(' ')}: ${(r.stderr || r.stdout || '').trim().slice(-1500)}`)
  return r.stdout
}
const mode = (o) => (o.remote ? '--remote' : '--local')

function query(o, db, sql) {
  // A few tries: D1 answers 7500 while an export of the same database is running.
  let out
  for (let i = 1; ; i++) {
    try { out = wrangler(['d1', 'execute', db, mode(o), '--json', `--command=${sql}`]); break } catch (e) {
      if (i >= 4) throw e
      spawnSync('sleep', [String(5 * i)])
    }
  }
  const parsed = JSON.parse(out.slice(out.indexOf('[')))
  return parsed[parsed.length - 1]?.results ?? []
}
const lit = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)

function r2Put(o, key, file, type) {
  wrangler(['r2', 'object', 'put', `${BUCKET}/${key}`, `--file=${file}`, `--content-type=${type}`, mode(o)])
}
function r2Get(o, key, file) {
  wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, `--file=${file}`, mode(o)])
}

async function main() {
  const o = args(process.argv.slice(2))
  if (BUCKET === 'school-erp') throw new Error('refusing the live bucket')
  const cfg = readWranglerConfig()
  const ctl = (cfg.d1_databases ?? []).find((d) => d.binding === 'CONTROL')
  const inst = query(o, ctl.database_name, `SELECT id, slug, d1_binding FROM institutions WHERE slug = ${lit(o.school)}`)[0]
  if (!inst) throw new Error(`no school ${o.school}`)
  const bind = (cfg.d1_databases ?? []).find((d) => d.binding === inst.d1_binding)
  if (!bind) throw new Error(`school ${o.school} has no binding in wrangler.jsonc (${inst.d1_binding}); deploy it first`)
  const db = bind.database_name
  const year = query(o, db, `SELECT id, name, starts_on, ends_on, is_current, closed_at FROM academic_years WHERE id = ${lit(o.year)} OR name = ${lit(o.year)}`)[0]
  if (!year) throw new Error(`no academic year ${o.year} in ${o.school}`)
  const today = new Date().toISOString().slice(0, 10)
  const open = year.is_current ? 'is the current year' : !year.closed_at && !(year.ends_on < today) ? 'is not closed and has not ended' : null
  if (open && !o.allowOpen) throw new Error(`${year.name} ${open}; archive only closed years`)
  if (open) console.log(`note: ${year.name} ${open}; exporting anyway because --allow-open (dry run only)`)
  const from = year.starts_on, to = year.ends_on + 'T23:59:59.999Z'
  const prefix = `${o.confirm ? 'archive' : 'archive-dryrun'}/${o.school}/${year.name.replace(/[^A-Za-z0-9._-]+/g, '-')}`
  console.log(`${o.confirm ? 'ARCHIVE' : 'DRY RUN'}: ${o.school} ${year.name} (${from} .. ${year.ends_on}) -> r2://${BUCKET}/${prefix}/ [${o.remote ? 'remote' : 'local'}]`)

  const tables = new Set(query(o, db, `SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name))
  const dir = mkdtempSync(join(tmpdir(), 'archive-'))
  const manifest = { school: o.school, year: { id: year.id, name: year.name, starts_on: year.starts_on, ends_on: year.ends_on },
    bucket: BUCKET, taken_at: new Date().toISOString(), dry_run: !o.confirm, tables: [] }
  try {
    for (const [t, col] of ARCHIVE) {
      if (!tables.has(t)) { console.log(`  ${t}: no such table, skipped`); continue }
      const cols = new Set(query(o, db, `SELECT name FROM pragma_table_info('${t}')`).map((r) => r.name))
      if (!cols.has(col)) { console.log(`  ${t}: no ${col} column, skipped`); continue }
      const where = `${col} >= ${lit(from)} AND ${col} <= ${lit(to)}`
      const n = Number(query(o, db, `SELECT count(*) AS n FROM ${t} WHERE ${where}`)[0].n)
      if (n === 0) { console.log(`  ${t}: 0 rows`); continue }
      // Export in rowid pages.
      const lines = []; const rowids = []
      let last = -1
      for (;;) {
        const page = query(o, db, `SELECT rowid AS __rid, * FROM ${t} WHERE ${where} AND rowid > ${last} ORDER BY rowid LIMIT ${PAGE}`)
        if (!page.length) break
        for (const r of page) { rowids.push(r.__rid); delete r.__rid; lines.push(JSON.stringify(r)) }
        last = rowids[rowids.length - 1]
        if (page.length < PAGE) break
      }
      const gz = gzipSync(Buffer.from(lines.join('\n') + '\n'))
      const sha = createHash('sha256').update(gz).digest('hex')
      const key = `${prefix}/${t}.jsonl.gz`
      const f = join(dir, `${t}.jsonl.gz`)
      writeFileSync(f, gz)
      r2Put(o, key, f, 'application/gzip')
      // Verify: read it back.
      const back = join(dir, `${t}.back.gz`)
      r2Get(o, key, back)
      const got = readFileSync(back)
      const gotSha = createHash('sha256').update(got).digest('hex')
      const gotLines = gunzipSync(got).toString('utf8').split('\n').filter(Boolean)
      gotLines.forEach((l) => JSON.parse(l))
      const ok = gotSha === sha && gotLines.length === rowids.length && rowids.length === n
      console.log(`  ${t}: ${n} rows, ${gz.length} bytes gz, ${ok ? 'verified' : 'VERIFY FAILED'}`)
      manifest.tables.push({ table: t, column: col, rows: n, key, bytes: gz.length, sha256: sha, rowid_min: rowids[0], rowid_max: last, verified: ok })
      if (!ok) throw new Error(`verification failed for ${t}; nothing deleted`)
    }
    const mf = join(dir, 'manifest.json')
    writeFileSync(mf, JSON.stringify(manifest, null, 2))
    r2Put(o, `${prefix}/manifest.json`, mf, 'application/json')
    if (!o.confirm) {
      console.log(`dry run: ${manifest.tables.reduce((a, x) => a + x.rows, 0)} rows exported and verified; nothing deleted (add --confirm to delete)`)
      return
    }
    // Delete only what was verified: same predicate, bounded by the exported rowid range.
    for (const x of manifest.tables) {
      const where = `${x.column} >= ${lit(from)} AND ${x.column} <= ${lit(to)} AND rowid BETWEEN ${x.rowid_min} AND ${x.rowid_max}`
      for (;;) {
        const left = Number(query(o, db, `SELECT count(*) AS n FROM ${x.table} WHERE ${where}`)[0].n)
        if (!left) break
        query(o, db, `DELETE FROM ${x.table} WHERE rowid IN (SELECT rowid FROM ${x.table} WHERE ${where} LIMIT 5000)`)
      }
      console.log(`  ${x.table}: deleted ${x.rows} archived rows`)
    }
    console.log('done. Run PRAGMA optimize if many rows went: npx wrangler d1 execute <db> --remote --command "PRAGMA optimize"')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

main().then(() => process.exit(0), (e) => { console.error('archive-year:', e.message); process.exit(1) })
