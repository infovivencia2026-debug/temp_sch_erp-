/* Orchestration tests for src/services/provision.ts with fakes: CONTROL and
   every "Cloudflare" database are in-memory node:sqlite databases, and the
   Cloudflare API is a fake that never touches the network. The real
   db/tenant.sql and db/control.sql are applied, so the SQL is exercised.

   Run from worker/: scripts/test-provision.sh (esbuild bundle, node --test). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { runProvision, discardProvision, schemaChunks, dbNameFor, bindingFor, type ProvisionDeps, type ProvisionRow } from '../src/services/provision'
import { cloudflareD1Api, type CfD1Api, type Stmt, type QueryResult } from '../src/services/d1http'
import { ROLES } from '../src/services/provision_seed'

const TENANT_SQL = readFileSync('db/tenant.sql', 'utf8')
const CONTROL_SQL = readFileSync('db/control.sql', 'utf8')

type Row = Record<string, unknown>
const bindable = (vs: unknown[]) => vs.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)) as never[]

function runOn(db: DatabaseSync, sql: string, params: unknown[]): Row[] {
  const st = db.prepare(sql)
  return (st.all(...bindable(params)) as Row[]).map((r) => ({ ...r }))
}

/** Enough of D1Database over node:sqlite for CONTROL. */
function d1(db: DatabaseSync): D1Database {
  const mk = (sql: string, params: unknown[] = []): any => ({
    sql, params,
    bind: (...v: unknown[]) => mk(sql, v),
    first: async (col?: string) => { const r = runOn(db, sql, params)[0]; return r ? (col ? r[col] : r) : null },
    all: async () => ({ results: runOn(db, sql, params), success: true, meta: {} }),
    run: async () => { const r = db.prepare(sql).run(...bindable(params)); return { results: [], success: true, meta: { changes: Number(r.changes) } } },
  })
  return {
    prepare: (sql: string) => mk(sql),
    batch: async (stmts: any[]) => {
      db.exec('BEGIN')
      try { const out = stmts.map((s) => ({ results: runOn(db, s.sql, s.params), success: true, meta: {} })); db.exec('COMMIT'); return out }
      catch (e) { db.exec('ROLLBACK'); throw e }
    },
    exec: async (sql: string) => { db.exec(sql); return { count: 0, duration: 0 } },
  } as unknown as D1Database
}

interface FakeCf extends CfD1Api {
  dbs: Map<string, { name: string; db: DatabaseSync }>
  calls: string[]
  failNext: Partial<Record<'create' | 'exec' | 'query', number>>
  execCount: number
}

function fakeCf(): FakeCf {
  let n = 0
  const f: FakeCf = {
    dbs: new Map(), calls: [], failNext: {}, execCount: 0,
    async findDatabase(name) { f.calls.push('find'); for (const [id, d] of f.dbs) if (d.name === name) return id; return null },
    async createDatabase(name) {
      f.calls.push('create')
      if (f.failNext.create) { f.failNext.create--; throw new Error('Cloudflare API POST d1: 500 boom') }
      for (const d of f.dbs.values()) if (d.name === name) throw new Error('7502 database name already exists')
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
      const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON')
      f.dbs.set(id, { name, db }); return id
    },
    async deleteDatabase(id) { f.calls.push('delete'); if (!f.dbs.delete(id)) throw new Error('404 not found') },
    async exec(id, sql) {
      f.execCount++
      if (f.failNext.exec !== undefined && f.execCount === f.failNext.exec) throw new Error('Cloudflare API POST d1/query: 503 overloaded')
      f.dbs.get(id)!.db.exec(sql)
    },
    async query(id, stmts: Stmt[]): Promise<QueryResult[]> {
      if (f.failNext.query) { f.failNext.query--; throw new Error('Cloudflare API POST d1/query: 502 bad gateway') }
      const db = f.dbs.get(id)!.db
      if (stmts.length > 1) db.exec('BEGIN')
      try {
        const out = stmts.map((s) => ({ results: runOn(db, s.sql, s.params), success: true, meta: {} }))
        if (stmts.length > 1) db.exec('COMMIT')
        return out
      } catch (e) { if (stmts.length > 1) db.exec('ROLLBACK'); throw e }
    },
  }
  return f
}

function setup() {
  const ctl = new DatabaseSync(':memory:')
  ctl.exec(CONTROL_SQL)
  ctl.exec(`INSERT INTO plans (code, name, modules) VALUES ('starter', 'Starter', '["students","fees","communication"]')`)
  const cf = fakeCf()
  const deps: ProvisionDeps = { control: d1(ctl), cf, schemaSql: TENANT_SQL, hasBinding: () => false }
  return { ctl, cf, deps }
}

function addRow(ctl: DatabaseSync, over: Partial<ProvisionRow> = {}): ProvisionRow {
  const id = crypto.randomUUID(), slug = over.slug ?? 'green-valley', t = new Date().toISOString()
  const row = {
    id, slug, country: 'in', name: 'Green Valley School', short_name: 'GVS', plan_code: 'starter', trial_days: 14,
    district: 'Warangal', state: 'Telangana', affiliation_board: 'CBSE', admin_name: 'Sudha Rani',
    admin_email: 'sudha@example.com', admin_phone: null, admin_username: 'sudha', admin_password_hash: 'hash',
    branding: JSON.stringify({ primary_color: '#0f766e', tagline: 'Learn well' }),
    institution_id: crypto.randomUUID(), admin_user_id: crypto.randomUUID(), db_name: dbNameFor(slug, id),
    d1_binding: bindingFor(slug), stage: 'queued', created_by: null, created_at: t, updated_at: t, ...over,
  } as Row
  const cols = Object.keys(row)
  ctl.prepare(`INSERT INTO provisioning (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...bindable(Object.values(row)))
  return ctl.prepare('SELECT * FROM provisioning WHERE id = ?').get(id) as unknown as ProvisionRow
}

const one = (db: DatabaseSync, sql: string, ...p: unknown[]) => db.prepare(sql).get(...bindable(p)) as Row | undefined

test('schema chunks are re-runnable and under the size limit', () => {
  const chunks = schemaChunks(TENANT_SQL)
  assert.ok(chunks.length > 5)
  for (const c of chunks) assert.ok(c.length <= 60_000 + 100_000)
  const all = chunks.join('')
  assert.doesNotMatch(all, /CREATE (UNIQUE )?(TABLE|INDEX) (?!IF NOT EXISTS)/)
  assert.doesNotMatch(all, /PRAGMA/)
  const db = new DatabaseSync(':memory:')
  for (const c of chunks) db.exec(c)
  for (const c of chunks) db.exec(c) // twice: a retry of any chunk is harmless
  // Every table tenant.sql declares (_migrations among them). Counted from
  // the file, not written down: a hard-coded 470 went stale as soon as a
  // table was added. sqlite_sequence is SQLite's own, made by AUTOINCREMENT.
  const declared = new Set([...TENANT_SQL.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?["`]?(\w+)/g)].map((m) => m[1]))
  const made = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name <> 'sqlite_sequence'`).all() as { name: string }[]).map((r) => r.name)
  assert.deepEqual(new Set(made), declared)
})

test('happy path: queued to ready, school usable', async () => {
  const { ctl, cf, deps } = setup()
  const p = addRow(ctl)
  const out = await runProvision(deps, p.id)
  assert.equal(out!.stage, 'ready', out!.error ?? '')
  assert.equal(out!.schema_done, out!.schema_total)
  assert.equal(out!.db_created, 1)
  const db = cf.dbs.get(out!.d1_database_id!)!.db
  assert.equal(cf.dbs.get(out!.d1_database_id!)!.name, p.db_name)
  assert.equal(one(db, 'SELECT name FROM institutions WHERE id = ?', p.institution_id)!.name, 'Green Valley School')
  assert.equal(one(db, 'SELECT count(*) n FROM campuses')!.n, 1)
  assert.equal(one(db, 'SELECT must_change_password m FROM users WHERE id = ?', p.admin_user_id)!.m, 1)
  assert.equal(one(db, 'SELECT count(*) n FROM roles WHERE institution_id = ?', p.institution_id)!.n, ROLES.length)
  const admin = one(db, `SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`, p.admin_user_id)
  assert.equal(admin!.key, 'institution_admin')
  const grants = one(db, `SELECT count(*) n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = 'institution_admin'`)!.n as number
  assert.equal(grants, ROLES.find((r) => r.key === 'institution_admin')!.perms.length)
  assert.equal(one(db, `SELECT enabled FROM module_settings WHERE module = 'fees'`)!.enabled, 1)
  assert.equal(one(db, `SELECT enabled FROM module_settings WHERE module = 'hostel'`)!.enabled, 0)
  assert.equal(one(db, 'SELECT count(*) n FROM clearance_departments')!.n, 8)
  // CONTROL
  const inst = one(ctl, 'SELECT * FROM institutions WHERE id = ?', p.institution_id)!
  assert.equal(inst.d1_binding, 'TENANT_GREEN_VALLEY')
  assert.equal(inst.d1_database_id, out!.d1_database_id)
  assert.equal(inst.primary_color, '#0f766e')
  assert.equal(one(ctl, 'SELECT status FROM subscriptions WHERE institution_id = ?', p.institution_id)!.status, 'trial')
  assert.equal(one(ctl, 'SELECT count(*) n FROM login_index WHERE institution_id = ?', p.institution_id)!.n, 2)
  assert.equal(one(ctl, `SELECT ok FROM platform_events WHERE kind = 'provision'`)!.ok, 1)
  // Running again is a no-op.
  await runProvision(deps, p.id)
  assert.deepEqual(cf.calls.filter((c) => c === 'create'), ['create'])
})

test('failure while applying schema, then retry resumes', async () => {
  const { ctl, cf, deps } = setup()
  const p = addRow(ctl)
  cf.failNext.exec = 3
  const failed = await runProvision(deps, p.id)
  assert.equal(failed!.stage, 'failed')
  assert.equal(failed!.failed_stage, 'applying_schema')
  assert.match(failed!.error!, /503/)
  assert.equal(failed!.schema_done, 2)
  assert.equal(one(ctl, 'SELECT count(*) n FROM institutions')!.n, 0, 'no half-built school in the directory')
  const before = cf.execCount
  const ok = await runProvision(deps, p.id)
  assert.equal(ok!.stage, 'ready', ok!.error ?? '')
  assert.equal(cf.execCount - before, ok!.schema_total - 2, 'resumed at chunk 3')
  assert.equal(cf.calls.filter((c) => c === 'create').length, 1)
  assert.equal(ok!.attempts, 2)
})

test('failure while seeding, retry is idempotent', async () => {
  const { ctl, cf, deps } = setup()
  const p = addRow(ctl)
  let calls = 0
  const q = cf.query.bind(cf)
  cf.query = async (id, s) => { if (++calls === 4) throw new Error('502 bad gateway'); return q(id, s) }
  const failed = await runProvision(deps, p.id)
  assert.equal(failed!.failed_stage, 'seeding')
  const ok = await runProvision(deps, p.id)
  assert.equal(ok!.stage, 'ready', ok!.error ?? '')
  const db = cf.dbs.get(ok!.d1_database_id!)!.db
  assert.equal(one(db, 'SELECT count(*) n FROM campuses')!.n, 1)
  assert.equal(one(db, 'SELECT count(*) n FROM users')!.n, 1)
  assert.equal(one(db, 'SELECT count(*) n FROM user_roles')!.n, 1)
  assert.equal(one(db, 'SELECT count(*) n FROM roles')!.n, ROLES.length)
})

test('a database created by an attempt that died before recording it is reused', async () => {
  const { ctl, cf, deps } = setup()
  const p = addRow(ctl)
  const orphan = await cf.createDatabase(p.db_name)
  cf.calls.length = 0
  const ok = await runProvision(deps, p.id)
  assert.equal(ok!.stage, 'ready', ok!.error ?? '')
  assert.equal(ok!.d1_database_id, orphan)
  assert.ok(!cf.calls.includes('create'))
})

test('create failure is recorded with its stage; discard deletes only what is safe', async () => {
  const { ctl, cf, deps } = setup()
  const p = addRow(ctl)
  cf.failNext.create = 1
  const f = await runProvision(deps, p.id)
  assert.equal(f!.stage, 'failed'); assert.equal(f!.failed_stage, 'creating_database')
  assert.equal(await discardProvision(deps, f!), false, 'no database to delete')
  assert.equal(one(ctl, 'SELECT count(*) n FROM provisioning')!.n, 0)

  // Failed after the database exists: discard deletes it.
  const p2 = addRow(ctl, { slug: 'hill-top' })
  cf.failNext.exec = cf.execCount + 1
  const f2 = await runProvision(deps, p2.id)
  assert.equal(f2!.failed_stage, 'applying_schema')
  assert.equal(await discardProvision(deps, f2!), true)
  assert.equal(cf.dbs.size, 0)

  // A database some school in CONTROL points at is never deleted.
  const p3 = addRow(ctl, { slug: 'river-side' })
  const ok = await runProvision(deps, p3.id)
  assert.equal(ok!.stage, 'ready')
  ctl.prepare(`UPDATE provisioning SET stage = 'failed' WHERE id = ?`).run(p3.id)
  assert.equal(await discardProvision(deps, { ...ok!, stage: 'failed' }), false)
  assert.equal(cf.dbs.size, 1)
})

test('the real API client sends single queries and batches as the D1 API expects', async () => {
  const seen: { url: string; method?: string; body?: unknown }[] = []
  const fetchFn = async (url: string, init?: RequestInit) => {
    seen.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const result = url.includes('?name=') ? [{ uuid: 'u1', name: 'school-erp-x' }]
      : url.endsWith('/query') ? [{ results: [{ n: 1 }], success: true, meta: {} }, { results: [], success: true, meta: {} }]
      : { uuid: 'u2' }
    return new Response(JSON.stringify({ success: true, result }), { status: 200 })
  }
  const api = cloudflareD1Api('acc', 'tok', fetchFn)
  assert.equal(await api.findDatabase('school-erp-x'), 'u1')
  assert.equal(await api.createDatabase('school-erp-y'), 'u2')
  await api.query('u1', [{ sql: 'SELECT ?', params: [1] }])
  await api.query('u1', [{ sql: 'SELECT 1', params: [] }, { sql: 'SELECT 2', params: [] }])
  assert.equal(seen[1].method, 'POST'); assert.deepEqual(seen[1].body, { name: 'school-erp-y' })
  assert.match(seen[2].url, /\/accounts\/acc\/d1\/database\/u1\/query$/)
  assert.deepEqual(seen[2].body, { sql: 'SELECT ?', params: [1] })
  assert.deepEqual(seen[3].body, { batch: [{ sql: 'SELECT 1', params: [] }, { sql: 'SELECT 2', params: [] }] })
  const bad = cloudflareD1Api('acc', 'tok', async () => new Response(JSON.stringify({ success: false, errors: [{ code: 7403, message: 'not authorized' }] }), { status: 403 }))
  await assert.rejects(bad.createDatabase('z'), /403 7403 not authorized/)
})
