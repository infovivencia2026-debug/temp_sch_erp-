import type { Env } from '../env'
import { registerJob } from './jobs'
import { cfApiFromEnv, httpD1, type CfD1Api } from './d1http'
import { PERMISSIONS, ROLES } from './provision_seed'
import tenantSql from '../../db/tenant.sql'
import { TENANT_MIGRATIONS } from './tenant_migrations'
import { roleTemplates } from './role_templates'
import { seedNewSchool } from './settings_registry'

/* Creating a school from the seller console, without a shell or a deploy.

   A school is its own D1 database. The seller's POST /seller/provisioning
   (routes/seller/provisioning.ts) writes a row in CONTROL.provisioning and
   queues 'school:provision'; this job walks the row through

     creating_database → applying_schema → seeding → attaching → ready

   recording each stage, so the console can poll it and a failure leaves
   `failed` with the stage and the error, and a Retry that resumes.

   Why the school is reached over the D1 HTTP API until the next deploy
   rather than by uploading a new Worker version with the binding added:
   `wrangler deploy` from worker/wrangler.jsonc replaces the Worker's whole
   binding list, so a binding added through the API would silently vanish on
   the next ordinary deploy (made from another machine as often as not) and
   the school would go dark; uploading a version also needs a token that can
   replace the Worker's code. Instead src/tenant.ts falls back to the API when
   the school's TENANT_<SLUG> binding is absent (src/services/d1http.ts), and
   `scripts/provision-school.sh --attach` writes the bindings of such schools
   into wrangler.jsonc so the next deploy serves them natively. Nothing is
   lost if that step is forgotten; the school is only a little slower.

   Every step is idempotent, so a retry after any partial failure is safe:
   - the database name carries the row id, so finding it by name means it is
     ours (made by an attempt that died before recording the id);
   - the schema is applied in chunks of CREATE ... IF NOT EXISTS, progress
     counted in schema_done;
   - seed rows use fixed ids from the row, INSERT OR IGNORE / NOT EXISTS;
   - the CONTROL rows are written last with INSERT OR IGNORE, so the school
     appears in the directory only once its database is complete. */

export const PROVISION_JOB = 'school:provision'

export const STAGES = ['queued', 'creating_database', 'applying_schema', 'seeding', 'attaching', 'ready'] as const
export type Stage = typeof STAGES[number] | 'failed'

export interface ProvisionRow {
  id: string
  slug: string
  country: string
  name: string
  short_name: string
  plan_code: string | null
  trial_days: number
  district: string | null
  state: string | null
  affiliation_board: string | null
  admin_name: string
  admin_email: string | null
  admin_phone: string | null
  admin_username: string | null
  admin_password_hash: string
  branding: string
  institution_id: string
  admin_user_id: string
  db_name: string
  d1_database_id: string | null
  d1_binding: string
  db_created: number
  stage: Stage
  failed_stage: string | null
  error: string | null
  schema_done: number
  schema_total: number
  attempts: number
  job_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  finished_at: string | null
}

export interface ProvisionDeps {
  control: D1Database
  cf: CfD1Api
  /** db/tenant.sql; injectable for tests. */
  schemaSql: string
  /** Whether the running Worker has this binding (a deploy has attached it). */
  hasBinding: (name: string) => boolean
  now?: () => string
}

const iso = () => new Date().toISOString()

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
export const bindingFor = (slug: string) => 'TENANT_' + slug.toUpperCase().replace(/-/g, '_')
/** Unique per request, so a database found by this name is this request's. */
export const dbNameFor = (slug: string, id: string) => `school-erp-${slug}-${id.replace(/-/g, '').slice(0, 8)}`

// --- the schema, in chunks the API accepts ---------------------------------

/** Most SQL one API call carries: D1 caps a statement at 100 KB; stay well under a request's limits. */
const CHUNK_BYTES = 60_000

/** db/tenant.sql as re-runnable chunks: CREATE ... IF NOT EXISTS, grouped under CHUNK_BYTES. */
export function schemaChunks(sql: string): string[] {
  const stmts = sql.split(/;[ \t]*\r?\n/)
    .map((s) => s.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n').trim())
    .filter((s) => s && !/^PRAGMA\b/i.test(s))
    .map((s) => s.replace(/^CREATE\s+(UNIQUE\s+)?(TABLE|INDEX|VIEW|TRIGGER)\s+(?!IF\s+NOT\s+EXISTS)/i,
      (_m, u: string | undefined, kind: string) => `CREATE ${u ? 'UNIQUE ' : ''}${kind.toUpperCase()} IF NOT EXISTS `))
  const chunks: string[] = []
  let cur = ''
  for (const s of stmts) {
    const piece = s.replace(/;\s*$/, '') + ';\n'
    if (cur && cur.length + piece.length > CHUNK_BYTES) { chunks.push(cur); cur = '' }
    cur += piece
  }
  if (cur) chunks.push(cur)
  return chunks
}

/** CREATE _migrations if absent and record every tenant migration as applied. */
export function tenantMigrationsSql(): string {
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`
  return `CREATE TABLE IF NOT EXISTS _migrations (scope TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY (scope, version));\n` +
    TENANT_MIGRATIONS.map((m) => `INSERT OR IGNORE INTO _migrations (scope, version, name, checksum) VALUES ('tenant', ${m.version}, ${q(m.name)}, ${q(m.checksum)});\n`).join('')
}

// --- plan modules (mirrors entitlement.ApplyPlan, as tenants.ts does) --------

const ALL_MODULES = ['students', 'academics', 'attendance', 'fees', 'communication',
  'exams', 'hr', 'transport', 'library', 'hostel', 'inventory']

function parseModules(raw: unknown): string[] {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s === '' || s === '{}' || s === '[]') return []
  if (s.startsWith('[')) { try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : [] } catch { return [] } }
  if (s.startsWith('{')) return s.slice(1, -1).split(',').map((m) => m.trim().replace(/^"|"$/g, '')).filter(Boolean)
  return []
}

const addDays = (d: string, n: number) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const addYear = (d: string) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCFullYear(t.getUTCFullYear() + 1); return t.toISOString().slice(0, 10) }

// --- the run -----------------------------------------------------------------------

async function load(control: D1Database, id: string): Promise<ProvisionRow | null> {
  return control.prepare('SELECT * FROM provisioning WHERE id = ?').bind(id).first<ProvisionRow>()
}

async function setStage(d: ProvisionDeps, id: string, stage: Stage, extra: Record<string, unknown> = {}): Promise<void> {
  const t = (d.now ?? iso)()
  const cols = Object.keys(extra)
  await d.control.prepare(`UPDATE provisioning SET stage = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ?`)
    .bind(stage, t, ...cols.map((c) => extra[c] as unknown), id).run()
}

/** Chunks of n. */
function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/** The school's own rows: mirrors api.provisionSchool, rbac.SeedInstitution and rbac.SeedCatalogRoles. */
async function seedTenant(d: ProvisionDeps, p: ProvisionRow, db: D1Database): Promise<void> {
  const t = (d.now ?? iso)()
  const inst = p.institution_id
  // Permission vocabulary (cmd/migrate seedPermissions), 200 per statement through json_each.
  await db.batch(chunk(PERMISSIONS, 200).map((part) => db.prepare(
    `INSERT INTO permissions (key, module, description)
       SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?) WHERE true
       ON CONFLICT (key) DO UPDATE SET module = excluded.module, description = excluded.description`).bind(JSON.stringify(part))))

  const brand = safeJSON(p.branding)
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO institutions (id, name, short_name, slug, status, affiliation_board, state, district, primary_color, created_at, updated_at)
        VALUES (?,?,?,?,'active',?,?,?,?,?,?)`)
      .bind(inst, p.name, p.short_name, p.slug, p.affiliation_board, p.state, p.district, str(brand.primary_color) ?? '#1e40af', t, t),
    // A campus, because every scoped table needs one (provision.go).
    db.prepare(`INSERT INTO campuses (id, institution_id, name, code, created_at, updated_at)
        SELECT ?, ?, 'Main Campus', 'MAIN', ?, ? WHERE NOT EXISTS (SELECT 1 FROM campuses WHERE institution_id = ?)`)
      .bind(crypto.randomUUID(), inst, t, t, inst),
    db.prepare(`INSERT OR IGNORE INTO users (id, institution_id, email, phone, username, full_name, password_hash, status, must_change_password, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,'active',1,?,?)`)
      .bind(p.admin_user_id, inst, p.admin_email, p.admin_phone, p.admin_username, p.admin_name, p.admin_password_hash, t, t),
    ...['library', 'lab', 'it', 'stores', 'hostel', 'transport', 'finance', 'hr'].map((code, i) =>
      db.prepare(`INSERT OR IGNORE INTO clearance_departments (id, institution_id, code, name, sequence) VALUES (?,?,?,?,?)`)
        .bind(crypto.randomUUID(), inst, code, ['Library', 'Science laboratories', 'IT and devices', 'Stores and stationery', 'Hostel', 'Transport', 'Accounts', 'HR and records'][i], (i + 1) * 10)),
  ])

  // Roles: create the missing ones, then grant (unless the school customised it, which a retry can meet).
  const have = await db.prepare(`SELECT id, key, customised_at FROM roles WHERE institution_id = ?`).bind(inst)
    .all<{ id: string; key: string; customised_at: string | null }>()
  const byKey = new Map(have.results.map((r) => [r.key, r]))
  // The vendor's role templates (seller Controls > Roles) replace the built-in lists.
  const templates = await roleTemplates(d.control)
  const stmts: D1PreparedStatement[] = []
  for (const role of ROLES.map((r) => ({ ...r, perms: templates.get(r.key) ?? r.perms }))) {
    let r = byKey.get(role.key)
    if (!r) {
      r = { id: crypto.randomUUID(), key: role.key, customised_at: null }
      stmts.push(db.prepare(`INSERT INTO roles (id, institution_id, key, name, is_system, is_default, created_at) VALUES (?,?,?,?,1,1,?)`)
        .bind(r.id, inst, role.key, role.name, t))
    }
    if (r.customised_at) continue
    for (const part of chunk(role.perms, 400)) {
      stmts.push(db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT ?, value FROM json_each(?)`)
        .bind(r.id, JSON.stringify(part)))
    }
  }
  stmts.push(db.prepare(`INSERT INTO user_roles (id, institution_id, user_id, role_id, created_at)
      SELECT ?, ?, ?, r.id, ? FROM roles r WHERE r.key = 'institution_admin' AND r.institution_id = ?
        AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = ? AND ur.role_id = r.id)`)
    .bind(crypto.randomUUID(), inst, p.admin_user_id, t, inst, p.admin_user_id))

  // The plan's modules, exactly (entitlement.ApplyPlan).
  if (p.plan_code) {
    const plan = await d.control.prepare('SELECT modules FROM plans WHERE code = ?').bind(p.plan_code).first<{ modules: string }>()
    const mods = parseModules(plan?.modules)
    for (const m of ALL_MODULES) {
      stmts.push(db.prepare(`INSERT INTO module_settings (institution_id, module, enabled) VALUES (?,?,?)
          ON CONFLICT (institution_id, module) DO UPDATE SET enabled = excluded.enabled`)
        .bind(inst, m, mods.length === 0 || mods.includes(m) ? 1 : 0))
    }
  }
  for (const part of chunk(stmts, 50)) await db.batch(part)
  // The vendor's platform and plan defaults for school settings (seller Controls).
  try { await seedNewSchool(d.control, db, inst, p.plan_code) } catch (e) { console.error('provision: setting defaults not applied', e) }
}

/** CONTROL's rows for the school: the directory entry, the subscription, the sign-in index. Last, so a half-built school never shows. */
async function registerInControl(d: ProvisionDeps, p: ProvisionRow): Promise<void> {
  const t = (d.now ?? iso)()
  const c = d.control
  const brand = safeJSON(p.branding)
  const stmts: D1PreparedStatement[] = [
    c.prepare(`INSERT OR IGNORE INTO institutions (id, name, short_name, slug, status, country, primary_color, accent_color, tagline,
        support_email, support_phone, d1_database_id, d1_binding, created_at, updated_at)
        VALUES (?,?,?,?,'active',?,?,?,?,?,?,?,?,?,?)`)
      .bind(p.institution_id, p.name, p.short_name, p.slug, p.country, str(brand.primary_color) ?? '#1e40af',
        str(brand.accent_color), str(brand.tagline), str(brand.support_email), str(brand.support_phone),
        p.d1_database_id, p.d1_binding, t, t),
  ]
  if (p.plan_code) {
    const plan = await c.prepare('SELECT max_students FROM plans WHERE code = ?').bind(p.plan_code).first<{ max_students: number | null }>()
    const today = t.slice(0, 10)
    stmts.push(c.prepare(`INSERT OR IGNORE INTO subscriptions (institution_id, plan_code, status, started_on, trial_ends_on, renews_on, licensed_students, updated_at)
        VALUES (?,?,'trial',?,?,?,?,?)`)
      .bind(p.institution_id, p.plan_code, today, addDays(today, p.trial_days > 0 ? p.trial_days : 30), addYear(today), plan?.max_students ?? null, t))
  }
  for (const [kind, value] of [['email', p.admin_email], ['phone', p.admin_phone], ['username', p.admin_username]] as const) {
    if (!value) continue
    stmts.push(c.prepare(`INSERT OR IGNORE INTO login_index (kind, value, institution_id, user_id, created_at) VALUES (?,?,?,?,?)`)
      .bind(kind, value, p.institution_id, p.admin_user_id, t))
  }
  await c.batch(stmts)
}

function safeJSON(s: string | null | undefined): Record<string, unknown> {
  try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} }
}
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * Walks one provisioning row to ready, resuming from wherever it stopped.
 * Never throws for a failure of the work itself: that is recorded on the row
 * as stage 'failed' with the stage and the message, for the console's Retry.
 */
export async function runProvision(d: ProvisionDeps, id: string): Promise<ProvisionRow | null> {
  let p = await load(d.control, id)
  if (!p || p.stage === 'ready') return p
  let stage: Stage = 'creating_database'
  try {
    await d.control.prepare('UPDATE provisioning SET attempts = attempts + 1, error = NULL, failed_stage = NULL WHERE id = ?').bind(id).run()

    // 1. The database.
    await setStage(d, id, stage)
    if (!p.d1_database_id) {
      let dbId = await d.cf.findDatabase(p.db_name)
      if (!dbId) {
        // Two deliveries of the same job can race here; the loser finds the winner's database.
        try { dbId = await d.cf.createDatabase(p.db_name) } catch (e) {
          dbId = await d.cf.findDatabase(p.db_name)
          if (!dbId) throw e
        }
      }
      await setStage(d, id, stage, { d1_database_id: dbId, db_created: 1 })
      p = { ...p, d1_database_id: dbId, db_created: 1 }
    }
    const dbId = p.d1_database_id!

    // 2. The schema, chunk by chunk from where the last attempt stopped.
    stage = 'applying_schema'
    // The schema, then the record of every tenant migration it contains (so
    // scripts/migrate.mjs never re-applies one here); all re-runnable chunks.
    const chunks = schemaChunks(d.schemaSql + '\n' + tenantMigrationsSql() + '\n')
    await setStage(d, id, stage, { schema_total: chunks.length })
    for (let i = Math.min(p.schema_done, chunks.length); i < chunks.length; i++) {
      await d.cf.exec(dbId, chunks[i])
      await setStage(d, id, stage, { schema_done: i + 1 })
    }

    // 3. The school's own rows.
    stage = 'seeding'
    await setStage(d, id, stage)
    const db = httpD1(d.cf, dbId)
    await seedTenant(d, p, db)

    // 4. Attach: the directory row and sign-in index, then prove the school answers.
    stage = 'attaching'
    await setStage(d, id, stage)
    await registerInControl(d, p)
    const probe = await db.prepare('SELECT count(*) AS n FROM users WHERE id = ?').bind(p.admin_user_id).first<{ n: number }>()
    if (!probe || Number(probe.n) !== 1) throw new Error('the administrator is missing from the new database')

    const t = (d.now ?? iso)()
    await setStage(d, id, 'ready', { finished_at: t })
    await recordEvent(d, p, true, `plan ${p.plan_code ?? '-'}, administrator ${p.admin_name}` +
      (d.hasBinding(p.d1_binding) ? '' : `; served over the D1 API until a deploy adds ${p.d1_binding}`))
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 2000)
    console.error('provision failed', id, stage, e)
    try {
      const t = (d.now ?? iso)()
      // Never over a 'ready' another delivery of this job reached meanwhile.
      await d.control.prepare(`UPDATE provisioning SET stage = 'failed', failed_stage = ?, error = ?, updated_at = ?, finished_at = ?
          WHERE id = ? AND stage <> 'ready'`).bind(stage, msg, t, t, id).run()
      if (p) await recordEvent(d, p, false, `${stage}: ${msg}`)
    } catch (e2) { console.error('provision: failure not recorded', id, e2) }
  }
  return load(d.control, id)
}

async function recordEvent(d: ProvisionDeps, p: ProvisionRow, okFlag: boolean, detail: string): Promise<void> {
  try {
    await d.control.prepare(`INSERT INTO platform_events (id, kind, ok, institution_id, subject, detail, actor_id, at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), 'provision', okFlag ? 1 : 0, okFlag ? p.institution_id : null, p.name, detail, p.created_by, (d.now ?? iso)()).run()
  } catch (e) { console.error('platform_events', e) }
}

/**
 * Removes a failed request, and its database when that is safe: this row
 * created it (db_created) and no school in CONTROL points at it. Returns
 * whether a database was deleted.
 */
export async function discardProvision(d: Pick<ProvisionDeps, 'control' | 'cf'>, p: ProvisionRow): Promise<boolean> {
  let deleted = false
  if (p.d1_database_id && p.db_created) {
    const used = await d.control.prepare('SELECT 1 FROM institutions WHERE d1_database_id = ? OR id = ?')
      .bind(p.d1_database_id, p.institution_id).first()
    if (!used) {
      try { await d.cf.deleteDatabase(p.d1_database_id); deleted = true } catch (e) {
        // Already gone is fine; anything else keeps the row so nothing is orphaned silently.
        if (!(e instanceof Error && /\b404\b|not found/i.test(e.message))) throw e
      }
    }
  }
  await d.control.prepare('DELETE FROM provisioning WHERE id = ?').bind(p.id).run()
  return deleted
}

/** The deps from the Worker's environment; throws a plain message when the secrets are missing. */
export function provisionDeps(env: Env): ProvisionDeps {
  const cf = cfApiFromEnv(env)
  if (!cf) throw new Error('CF_ACCOUNT_ID and CF_API_TOKEN are not set on the Worker; set them with `wrangler secret put`, or use scripts/provision-school.sh')
  return {
    control: env.CONTROL, cf, schemaSql: tenantSql,
    hasBinding: (name) => { const b = env[name]; return !!b && typeof b === 'object' && 'prepare' in b },
  }
}

registerJob<{ provisioning_id: string }>(PROVISION_JOB, async (env, job) => {
  const id = job.payload.provisioning_id
  let deps: ProvisionDeps
  try { deps = provisionDeps(env) } catch (e) {
    await env.CONTROL.prepare(`UPDATE provisioning SET stage = 'failed', failed_stage = 'creating_database', error = ?, updated_at = ?, finished_at = ? WHERE id = ?`)
      .bind(e instanceof Error ? e.message : String(e), iso(), iso(), id).run()
    return
  }
  await runProvision(deps, id)
})
