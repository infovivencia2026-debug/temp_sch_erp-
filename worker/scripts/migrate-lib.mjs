// Shared by migrate.mjs, schema-sync.mjs and test-migrate.mjs.
// Migrations: worker/migrations/<scope>/NNNN_name.sql, forward-only, applied
// in order and recorded in _migrations(scope, version, name, checksum, applied_at)
// in the database itself. Scopes: 'control' (the CONTROL database) and
// 'tenant' (every school database).
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

export const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SCOPES = ['control', 'tenant']
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/

export const TRACKING_SQL = `CREATE TABLE IF NOT EXISTS _migrations (
  scope TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (scope, version)
);`

export const checksum = (sql) => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex')
export const q = (s) => `'${String(s).replace(/'/g, "''")}'`

/** The migration files of a scope, in order. */
export function listMigrations(scope, root = join(WORKER, 'migrations')) {
  if (!SCOPES.includes(scope)) throw new Error(`unknown scope ${scope} (control | tenant)`)
  const dir = join(root, scope)
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.sql')) continue
    const m = FILE_RE.exec(f)
    if (!m) throw new Error(`${scope}/${f}: expected NNNN_name.sql`)
    const sql = readFileSync(join(dir, f), 'utf8')
    const version = Number(m[1])
    if (out.some((x) => x.version === version)) throw new Error(`${scope}: version ${m[1]} used twice`)
    out.push({ scope, version, name: m[2], file: join(dir, f), sql, checksum: checksum(sql) })
  }
  return out
}

export function recordSql(m) {
  return `INSERT INTO _migrations (scope, version, name, checksum) VALUES (${q(m.scope)}, ${m.version}, ${q(m.name)}, ${q(m.checksum)});`
}

/**
 * Compare the files with a database's _migrations rows.
 * Returns { applied, pending, errors }; a checksum mismatch or an applied
 * version with no file is an error.
 */
export function plan(files, rows, scope) {
  const byVersion = new Map(rows.filter((r) => r.scope === scope).map((r) => [Number(r.version), r]))
  const errors = [], applied = [], pending = []
  for (const f of files) {
    const r = byVersion.get(f.version)
    if (!r) { pending.push(f); continue }
    byVersion.delete(f.version)
    if (r.checksum !== f.checksum) errors.push(`${scope} ${pad(f.version)}_${f.name}: checksum mismatch (applied ${String(r.checksum).slice(0, 12)}, file ${f.checksum.slice(0, 12)}); applied migrations must not be edited, write a new one`)
    else applied.push(f)
  }
  for (const [v, r] of byVersion) errors.push(`${scope} ${pad(v)}_${r.name}: applied but its file is missing`)
  return { applied, pending, errors }
}

export const pad = (v) => String(v).padStart(4, '0')

// --- targets: a database the runner can read and write --------------------
// { label, query(sql) -> rows, exec(sql), apply(m) }

/** A local SQLite file (tests, schema-sync). */
export async function sqliteTarget(file, label = file) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  return {
    label, db,
    async query(sql) { return db.prepare(sql).all() },
    async exec(sql) { db.exec(sql) },
    async apply(m) {
      db.exec('BEGIN')
      try { db.exec(m.sql); db.exec(recordSql(m)); db.exec('COMMIT') } catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
    },
    close() { db.close() },
  }
}

/** A database wrangler knows (a binding in wrangler.jsonc), --remote or --local. */
export function wranglerTarget(dbName, mode, label = dbName) {
  const run = (args) => {
    const r = spawnSync('npx', ['wrangler', 'd1', 'execute', dbName, `--${mode}`, ...args], { cwd: WORKER, encoding: 'utf8', maxBuffer: 256 << 20 })
    if (r.status !== 0) throw new Error(`wrangler d1 execute ${dbName}: ${(r.stderr || r.stdout || '').trim().slice(-2000)}`)
    return r.stdout
  }
  const execFile = (sql) => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-'))
    try { const f = join(dir, 'm.sql'); writeFileSync(f, sql); run(['--yes', `--file=${f}`]) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  return {
    label,
    async query(sql) {
      const out = run(['--json', `--command=${sql}`])
      const parsed = JSON.parse(out.slice(out.indexOf('[')))
      return parsed[parsed.length - 1]?.results ?? []
    },
    async exec(sql) { execFile(sql) },
    // One file: the migration and its _migrations row go together.
    async apply(m) { execFile(m.sql.replace(/\s*$/, '\n') + recordSql(m) + '\n') },
  }
}

/** A school database with no binding, over the D1 HTTP API (as src/services/d1http.ts). */
export function httpTarget(accountId, token, databaseId, label = databaseId) {
  const call = async (sql) => {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sql }),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.success) throw new Error(`D1 API ${res.status}: ${JSON.stringify(body?.errors ?? body).slice(0, 1000)}`)
    return body.result ?? []
  }
  return {
    label,
    async query(sql) { const r = await call(sql); return r[r.length - 1]?.results ?? [] },
    async exec(sql) { for (const c of chunkSql(sql)) await call(c) },
    async apply(m) { for (const c of chunkSql(m.sql.replace(/\s*$/, '\n') + recordSql(m))) await call(c) },
  }
}

/** Split SQL into API-sized pieces on statement ends (no triggers with inner ';' in our schema). */
export function chunkSql(sql, max = 60_000) {
  if (sql.length <= max) return [sql]
  const stmts = sql.split(/;[ \t]*\r?\n/).map((s) => s.trim()).filter((s) => s && !/^(--[^\n]*\n?\s*)*$/.test(s))
  const out = []; let cur = ''
  for (const s of stmts) {
    const piece = s.replace(/;\s*$/, '') + ';\n'
    if (cur && cur.length + piece.length > max) { out.push(cur); cur = '' }
    cur += piece
  }
  if (cur) out.push(cur)
  return out
}

// --- dump: a database back to SQL (schema-sync) ---------------------------

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"

function lit(v, since) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString('hex')}'`
  // A timestamp written while the migrations ran is "now" in a fresh database.
  if (since && ISO_RE.test(v) && v >= since) return NOW
  return q(v)
}

/**
 * The schema (in creation order) and every row, as SQL that rebuilds the
 * database. `since`: ISO time the migrations started; timestamps from then
 * on are written as strftime('now') so the output is reproducible.
 */
export function dump(db, { header = '', since = '' } = {}) {
  const objs = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`).all()
  let out = header + 'PRAGMA foreign_keys = ON;\n'
  for (const o of objs) out += (o.type === 'table' ? '\n' : '') + o.sql.trim().replace(/;\s*$/, '') + ';\n'
  const tables = objs.filter((o) => o.type === 'table').map((o) => o.name)
  let data = ''
  for (const t of tables) {
    const cols = db.prepare(`SELECT name FROM pragma_table_info(${q(t)}) ORDER BY cid`).all().map((c) => c.name)
    const rows = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()
    for (const r of rows) {
      if (t === '_migrations') {
        data += `INSERT OR IGNORE INTO _migrations (scope, version, name, checksum) VALUES (${q(r.scope)}, ${r.version}, ${q(r.name)}, ${q(r.checksum)});\n`
        continue
      }
      data += `INSERT OR IGNORE INTO "${t}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => lit(r[c], since)).join(', ')});\n`
    }
  }
  if (data) out += '\n-- Rows the migrations insert (settings singletons) and the migrations applied.\n' + data
  return out
}

/** Apply every migration of a scope to an empty in-memory/local SQLite database. */
export async function buildFresh(scope, file = ':memory:', root) {
  const t = await sqliteTarget(file)
  t.db.exec(TRACKING_SQL)
  const since = new Date(Date.now() - 1000).toISOString()
  for (const m of listMigrations(scope, root)) {
    try { await t.apply(m) } catch (e) { throw new Error(`${scope} ${pad(m.version)}_${m.name}: ${e.message}`) }
  }
  return { target: t, since }
}

/** Minimal JSONC reader for wrangler.jsonc (comments and trailing commas). */
export function readWranglerConfig() {
  const src = readFileSync(join(WORKER, 'wrangler.jsonc'), 'utf8')
  let out = '', inStr = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inStr) { out += c; if (c === '\\') { out += src[++i] } else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue }
    out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}
