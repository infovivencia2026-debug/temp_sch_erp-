import type { Ctx, Router } from '../../router'
import type { Env } from '../../env'
import { HttpError, badRequest, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { institutionById, tenantDb, type Institution } from '../../tenant'
import { auditDetail, recordSellerAction } from '../../services/seller_audit'
import {
  SettingError, cleanValue, defaultFor, entitlementOf, readDefaults, readStored, resetStmts, resolveRows, settingDef, settingDefs,
  vendorEditable, writeStmts, declOf, type SettingDef, type Stores,
} from '../../services/settings_registry'
import { PERMISSION_SET, SCHOOL_ROLES, roleTemplates } from '../../services/role_templates'
import { PERMISSIONS } from '../../services/provision_seed'
import type { ApplyResult, ConfigTemplate, RolePushResult, RoleTemplate, SchoolSettings, SettingValue } from '@shared/api/settings'
import { requirePlatformAdmin } from './common'

/* SELLER CONTROLS: every school-level setting, the vendor's defaults, the
   role templates, and configuration templates (docs/seller-controls.md).

   Reading needs institution.read (support_admin holds it); changing needs
   platform.tenants.write, which only operators hold, so a support login sees
   these screens read-only. Every route also requires a platform account.

   Configuration only. A key must be declared in the settings registry to be
   read or written, and writes go through the registry's adapters, which
   touch only settings tables. Every vendor change is a seller_audit row the
   school reads under Security > Vendor activity; a setting marked notify
   also puts a notice on the school's administrators' board. */

const READ = 'institution.read'
const WRITE = 'platform.tenants.write'
const NOTICE_DAYS = 14

interface School { inst: Institution; name: string; plan_code: string | null; plan_name: string | null }

async function loadSchool(env: Env, id: string): Promise<School> {
  const inst = await institutionById(env, id)
  if (!inst) throw notFound('no such school')
  const sub = await env.CONTROL.prepare(`SELECT s.plan_code, p.name FROM subscriptions s LEFT JOIN plans p ON p.code = s.plan_code
      WHERE s.institution_id = ? ORDER BY s.started_on DESC LIMIT 1`).bind(id).first<{ plan_code: string | null; name: string | null }>()
  return { inst, name: inst.name, plan_code: sub?.plan_code ?? null, plan_name: sub?.name ?? null }
}
const storesOf = (env: Env, s: School): Stores => ({ control: env.CONTROL, db: tenantDb(env, s.inst) })
const ref = (s: School) => ({ id: s.inst.id, plan_code: s.plan_code })

function reasonOf(v: unknown): string {
  const r = typeof v === 'string' ? v.trim() : ''
  if (r.length < 3) throw badRequest('say why: the school reads the reason with the change')
  return r.slice(0, 500)
}

function knownKey(k: unknown): SettingDef {
  const d = typeof k === 'string' ? settingDef(k) : undefined
  if (!d) throw badRequest('no such setting: ' + String(k))
  return d
}

/** A change list from a request: declared, vendor-editable keys with clean values. Anything else refuses the whole request. */
function parseChanges(raw: unknown): { def: SettingDef; value: SettingValue }[] {
  if (!Array.isArray(raw) || raw.length === 0) throw badRequest('changes: a list of { key, value }')
  if (raw.length > 500) throw badRequest('at most 500 changes at once')
  return raw.map((x) => {
    const def = knownKey((x as { key?: unknown })?.key)
    if (!vendorEditable(def)) throw new HttpError(403, `${def.label} is the school's own decision`, { code: 'school_only', key: def.key })
    try { return { def, value: cleanValue(def, (x as { value?: unknown }).value) } } catch (e) {
      if (e instanceof SettingError) throw badRequest(e.message, { key: def.key })
      throw e
    }
  })
}
function parseResetKeys(raw: unknown): SettingDef[] {
  if (!Array.isArray(raw) || raw.length === 0) throw badRequest('keys: a list of setting keys')
  return raw.map((k) => {
    const def = knownKey(k)
    if (!vendorEditable(def)) throw new HttpError(403, `${def.label} is the school's own decision`, { code: 'school_only', key: def.key })
    return def
  })
}

const show = (v: SettingValue) => (v === null ? 'none' : v === true ? 'on' : v === false ? 'off' : String(v))

type Plan = { def: SettingDef; value: SettingValue } | { def: SettingDef; reset: true }

/** Works out, and unless dry, makes, one school's changes. Returns only what changes. */
async function applyToSchool(c: Ctx, s: School, plan: Plan[], reason: string, dry: boolean, bulk: boolean): Promise<ApplyResult['schools'][number]> {
  const st = storesOf(c.env, s)
  const defs = plan.map((p) => p.def)
  const [stored, defaults, ent] = await Promise.all([readStored(st, ref(s), defs), readDefaults(c.env.CONTROL, s.plan_code), entitlementOf(c.env.CONTROL, s.inst.id)])
  const rows = new Map(resolveRows(defs, stored, defaults, ent).map((r) => [r.key, r]))
  const changes: ApplyResult['schools'][number]['changes'] = []
  const control: D1PreparedStatement[] = [], tenant: D1PreparedStatement[] = []
  for (const p of plan) {
    const before = rows.get(p.def.key)!
    if ('reset' in p) {
      const def = defaultFor(p.def, defaults, ent)
      const has = stored.has(p.def.key)
      // Nothing to undo: no override, or the stored value already is the default (or would be the built-in anyway).
      if (p.def.store.kind === 'feature' ? !has : has ? before.value === def.value : def.value === p.def.builtin) continue
      const w = resetStmts(st, ref(s), p.def, def.value, c.id.userId)
      control.push(...w.control); tenant.push(...w.tenant)
      changes.push({ key: p.def.key, label: p.def.label, before: before.value, after: def.value })
    } else {
      if (before.value === p.value) continue
      const w = writeStmts(st, ref(s), p.def, p.value, c.id.userId)
      control.push(...w.control); tenant.push(...w.tenant)
      changes.push({ key: p.def.key, label: p.def.label, before: before.value, after: p.value })
    }
  }
  const out = { id: s.inst.id, name: s.name, changes }
  if (dry || (control.length === 0 && tenant.length === 0)) return out
  if (tenant.length) await st.db.batch(tenant)
  if (control.length) await c.env.CONTROL.batch(control)
  const noticed = changes.filter((x) => settingDef(x.key)!.notify)
  if (noticed.length) await notifySchool(c, s, noticed, reason)
  const entry = { action: 'controls.set', institution_id: s.inst.id, institution_name: s.name, target: changes.map((x) => x.key).join(',').slice(0, 300),
    before: Object.fromEntries(changes.map((x) => [x.key, x.before])), after: { ...Object.fromEntries(changes.map((x) => [x.key, x.after])), reason } }
  if (bulk) {
    await recordSellerAction(c.env, { actor_id: c.id.userId, actor_name: c.id.fullName, actor_roles: c.id.roles, method: c.req.method, path: c.url.pathname,
      route: null, ...entry, status: 200, ip: c.req.headers.get('cf-connecting-ip') })
  } else auditDetail(c, entry)
  return out
}

/** A notice on the school administrators' board: what changed and why. */
async function notifySchool(c: Ctx, s: School, changes: { label: string; before: SettingValue; after: SettingValue }[], reason: string): Promise<void> {
  const id = uuid(), t = now()
  const ends = new Date(Date.now() + NOTICE_DAYS * 86_400_000).toISOString()
  const body = changes.slice(0, 20).map((x) => `${x.label}: ${show(x.before)} to ${show(x.after)}`).join('\n')
    + (changes.length > 20 ? `\nand ${changes.length - 20} more` : '') + `\n\nReason: ${reason}\nThe full record is under Security, Vendor activity.`
  await c.env.CONTROL.batch([
    c.env.CONTROL.prepare(`INSERT INTO platform_broadcasts (id, severity, title, body, starts_at, ends_at, created_by, created_at) VALUES (?, 'info', ?, ?, ?, ?, ?, ?)`)
      .bind(id, changes.length === 1 ? `Support changed a setting: ${changes[0].label}` : `Support changed ${changes.length} settings`, body, t, ends, c.id.userId, t),
    c.env.CONTROL.prepare(`INSERT INTO platform_broadcast_targets (broadcast_id, target_kind, target_ids, audiences, updated_at) VALUES (?, 'schools', ?, '["admins"]', ?)`)
      .bind(id, JSON.stringify([s.inst.id]), t),
  ])
}

/** Schools named by ids, a group, or all. */
async function chooseSchools(env: Env, req: { institution_ids?: unknown; group_id?: unknown; all?: unknown }): Promise<string[]> {
  if (Array.isArray(req.institution_ids) && req.institution_ids.length) {
    const ids = req.institution_ids.filter((x): x is string => typeof x === 'string')
    if (ids.length > 200) throw badRequest('at most 200 schools at once')
    return ids.map((x) => uuidParam(x, 'institution_ids'))
  }
  if (typeof req.group_id === 'string') {
    return (await env.CONTROL.prepare(`SELECT institution_id FROM school_group_members WHERE group_id = ?`).bind(req.group_id).all<{ institution_id: string }>()).results.map((r) => r.institution_id)
  }
  if (req.all === true) return (await env.CONTROL.prepare(`SELECT id FROM institutions ORDER BY name`).all<{ id: string }>()).results.map((r) => r.id)
  throw badRequest('choose schools: institution_ids, group_id or all')
}

async function runBulk(c: Ctx, ids: string[], plan: Plan[], reason: string, dry: boolean): Promise<ApplyResult> {
  const schools: ApplyResult['schools'] = []
  for (const id of ids) {
    try { schools.push(await applyToSchool(c, await loadSchool(c.env, id), plan, reason, dry, true)) } catch (e) {
      schools.push({ id, name: '', changes: [], error: e instanceof HttpError ? e.message : 'could not reach this school' })
    }
  }
  if (!dry) auditDetail(c, { action: 'controls.apply', target: `${plan.length} settings, ${ids.length} schools`, after: { reason } })
  return { applied: !dry, schools }
}

function checkScope(v: unknown, plans: Set<string>): string {
  const s = String(v ?? '')
  if (s === 'platform') return s
  if (s.startsWith('plan:') && plans.has(s.slice(5))) return s
  throw badRequest('scope: platform, or plan:<code> of an existing plan')
}

/* --- roles ------------------------------------------------------------------ */

async function templatesList(env: Env): Promise<RoleTemplate[]> {
  const tpl = await roleTemplates(env.CONTROL)
  const at = new Map((await env.CONTROL.prepare(`SELECT role_key, updated_at FROM platform_role_templates`).all<{ role_key: string; updated_at: string }>()
    .catch(() => ({ results: [] }))).results.map((r) => [r.role_key, r.updated_at]))
  return SCHOOL_ROLES.map((r) => ({ key: r.key, name: r.name, permissions: tpl.get(r.key) ?? r.perms, source: tpl.has(r.key) ? 'platform' : 'built-in', updated_at: at.get(r.key) ?? null }))
}
const knownRole = (k: string) => {
  const r = SCHOOL_ROLES.find((x) => x.key === k)
  if (!r) throw notFound('no such built-in role')
  return r
}

async function pushRole(c: Ctx, key: string, perms: string[], ids: string[], force: Set<string>, dry: boolean, reason: string): Promise<RolePushResult> {
  const out: RolePushResult = { applied: !dry, role: key, schools: [] }
  const want = new Set(perms)
  for (const id of ids) {
    let name = ''
    try {
      const s = await loadSchool(c.env, id)
      name = s.name
      const db = tenantDb(c.env, s.inst)
      const role = await db.prepare(`SELECT id, customised_at FROM roles WHERE key = ? AND is_system = 1 LIMIT 1`).bind(key).first<{ id: string; customised_at: string | null }>()
      if (!role) { out.schools.push({ id, name, status: 'missing', added: 0, removed: 0 }); continue }
      const have = new Set((await db.prepare(`SELECT permission_key FROM role_permissions WHERE role_id = ?`).bind(role.id).all<{ permission_key: string }>()).results.map((r) => r.permission_key))
      const add = [...want].filter((p) => !have.has(p)), remove = [...have].filter((p) => !want.has(p))
      if (role.customised_at && !force.has(id)) { out.schools.push({ id, name, status: 'customised', added: add.length, removed: remove.length }); continue }
      if (!add.length && !remove.length) { out.schools.push({ id, name, status: 'unchanged', added: 0, removed: 0 }); continue }
      if (!dry) {
        await db.batch([
          db.prepare(`DELETE FROM role_permissions WHERE role_id = ? AND permission_key NOT IN (SELECT value FROM json_each(?))`).bind(role.id, JSON.stringify(perms)),
          db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT ?, value FROM json_each(?) WHERE value IN (SELECT key FROM permissions)`).bind(role.id, JSON.stringify(perms)),
          db.prepare(`UPDATE roles SET customised_at = NULL WHERE id = ?`).bind(role.id),
        ])
        await recordSellerAction(c.env, { actor_id: c.id.userId, actor_name: c.id.fullName, actor_roles: c.id.roles, method: c.req.method, path: c.url.pathname,
          action: 'controls.role_template.push', institution_id: id, institution_name: name, target: key,
          before: { removed: remove }, after: { added: add, reason, replaced_customisation: !!role.customised_at }, status: 200 })
      }
      out.schools.push({ id, name, status: 'updated', added: add.length, removed: remove.length })
    } catch (e) {
      out.schools.push({ id, name, status: 'error', added: 0, removed: 0, error: e instanceof HttpError ? e.message : 'could not reach this school' })
    }
  }
  return out
}

/* --- routes ----------------------------------------------------------------- */

export function registerSellerControls(r: Router): void {
  // The registry itself, the groups, the defaults and the plans they can be set for.
  r.get('/seller/controls/registry', READ, async (c) => {
    requirePlatformAdmin(c)
    const plans = (await c.env.CONTROL.prepare(`SELECT code, name FROM plans WHERE retired_at IS NULL ORDER BY sequence, name`).all<{ code: string; name: string }>()).results
    const rows = (await c.env.CONTROL.prepare(`SELECT scope, key, value, updated_at FROM platform_setting_defaults ORDER BY scope, key`)
      .all<{ scope: string; key: string; value: string; updated_at: string }>()).results
    return ok({
      settings: settingDefs().map((d) => ({ ...declOf(d), vendor_editable: vendorEditable(d) })),
      plans,
      defaults: rows.filter((x) => settingDef(x.key)).map((x) => ({ scope: x.scope, key: x.key, value: JSON.parse(x.value) as SettingValue, updated_at: x.updated_at })),
      can_edit: !c.id.restricted,
    })
  })

  r.get('/seller/controls/schools/{id}', READ, async (c) => {
    requirePlatformAdmin(c)
    const s = await loadSchool(c.env, uuidParam(c.params.id))
    const st = storesOf(c.env, s)
    const [stored, defaults, ent] = await Promise.all([readStored(st, ref(s)), readDefaults(c.env.CONTROL, s.plan_code), entitlementOf(c.env.CONTROL, s.inst.id)])
    const body: SchoolSettings = { institution: { id: s.inst.id, name: s.name, plan_code: s.plan_code, plan_name: s.plan_name }, settings: resolveRows(settingDefs(), stored, defaults, ent) }
    return ok(body)
  })

  // Change one or many settings of one school. dry_run shows what would change.
  r.put('/seller/controls/schools/{id}', WRITE, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<{ changes?: unknown; reason?: unknown; dry_run?: boolean }>(c.req)
    const plan = parseChanges(req.changes)
    const reason = req.dry_run ? '' : reasonOf(req.reason)
    const s = await loadSchool(c.env, uuidParam(c.params.id))
    return ok({ applied: !req.dry_run, schools: [await applyToSchool(c, s, plan, reason, !!req.dry_run, false)] } satisfies ApplyResult)
  })

  r.post('/seller/controls/schools/{id}/reset', WRITE, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<{ keys?: unknown; reason?: unknown; dry_run?: boolean }>(c.req)
    const plan: Plan[] = parseResetKeys(req.keys).map((def) => ({ def, reset: true as const }))
    const reason = req.dry_run ? '' : reasonOf(req.reason)
    const s = await loadSchool(c.env, uuidParam(c.params.id))
    return ok({ applied: !req.dry_run, schools: [await applyToSchool(c, s, plan, reason, !!req.dry_run, false)] } satisfies ApplyResult)
  })

  // Two schools side by side: every setting, and whether they differ.
  r.get('/seller/controls/compare', READ, async (c) => {
    requirePlatformAdmin(c)
    const [a, b] = await Promise.all([loadSchool(c.env, uuidParam(c.url.searchParams.get('a') ?? '', 'a')), loadSchool(c.env, uuidParam(c.url.searchParams.get('b') ?? '', 'b'))])
    const read = async (s: School) => {
      const st = storesOf(c.env, s)
      const [stored, defaults, ent] = await Promise.all([readStored(st, ref(s)), readDefaults(c.env.CONTROL, s.plan_code), entitlementOf(c.env.CONTROL, s.inst.id)])
      return resolveRows(settingDefs(), stored, defaults, ent)
    }
    const [ra, rb] = await Promise.all([read(a), read(b)])
    return ok({
      a: { id: a.inst.id, name: a.name }, b: { id: b.inst.id, name: b.name },
      rows: ra.map((x, i) => ({ key: x.key, group: x.group, label: x.label, type: x.type, a: x.value, a_source: x.source, b: rb[i].value, b_source: rb[i].source, differs: x.value !== rb[i].value })),
    })
  })

  // The same settings on many schools, with a preview first (dry_run).
  r.post('/seller/controls/apply', WRITE, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<{ changes?: unknown; reset_keys?: unknown; reason?: unknown; dry_run?: boolean; institution_ids?: unknown; group_id?: unknown; all?: unknown }>(c.req)
    const plan: Plan[] = req.reset_keys !== undefined ? parseResetKeys(req.reset_keys).map((def) => ({ def, reset: true as const })) : parseChanges(req.changes)
    const reason = req.dry_run ? '' : reasonOf(req.reason)
    return ok(await runBulk(c, await chooseSchools(c.env, req), plan, reason, !!req.dry_run))
  })

  // Platform and plan defaults: what new schools start with.
  r.put('/seller/controls/defaults', WRITE, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<{ scope?: unknown; key?: unknown; value?: unknown }>(c.req)
    const plans = new Set((await c.env.CONTROL.prepare(`SELECT code FROM plans`).all<{ code: string }>()).results.map((p) => p.code))
    const scope = checkScope(req.scope, plans)
    const [{ def, value }] = parseChanges([{ key: req.key, value: req.value }])
    if (!def.defaults) throw badRequest(`${def.label} takes its default from the plan's modules`)
    await c.env.CONTROL.prepare(`INSERT INTO platform_setting_defaults (scope, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(scope, def.key, JSON.stringify(value), c.id.userId, now()).run()
    auditDetail(c, { action: 'controls.default.set', target: `${scope} ${def.key}`, after: { value } })
    return ok({ saved: true })
  })
  r.del('/seller/controls/defaults', WRITE, async (c) => {
    requirePlatformAdmin(c)
    const def = knownKey(c.url.searchParams.get('key'))
    const scope = String(c.url.searchParams.get('scope') ?? '')
    await c.env.CONTROL.prepare(`DELETE FROM platform_setting_defaults WHERE scope = ? AND key = ?`).bind(scope, def.key).run()
    auditDetail(c, { action: 'controls.default.clear', target: `${scope} ${def.key}` })
    return ok({ cleared: true })
  })

  // A school's configuration as a template: settings only, never records.
  r.get('/seller/controls/schools/{id}/export', READ, async (c) => {
    requirePlatformAdmin(c)
    const s = await loadSchool(c.env, uuidParam(c.params.id))
    const rows = await (async () => {
      const st = storesOf(c.env, s)
      const [stored, defaults, ent] = await Promise.all([readStored(st, ref(s)), readDefaults(c.env.CONTROL, s.plan_code), entitlementOf(c.env.CONTROL, s.inst.id)])
      return resolveRows(settingDefs(), stored, defaults, ent)
    })()
    const body: ConfigTemplate = { format: 'xulo-config/1', exported_at: now(), from: { id: s.inst.id, name: s.name },
      settings: Object.fromEntries(rows.filter((x) => x.vendor_editable).map((x) => [x.key, x.value])) }
    return ok(body)
  })

  r.post('/seller/controls/schools/{id}/import', WRITE, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<{ template?: Partial<ConfigTemplate>; reason?: unknown; dry_run?: boolean }>(c.req)
    const t = req.template
    if (!t || t.format !== 'xulo-config/1' || !t.settings || typeof t.settings !== 'object') throw badRequest('template: a configuration exported from Controls')
    const plan = parseChanges(Object.entries(t.settings).map(([key, value]) => ({ key, value })))
    const reason = req.dry_run ? '' : reasonOf(req.reason)
    const s = await loadSchool(c.env, uuidParam(c.params.id))
    return ok({ applied: !req.dry_run, schools: [await applyToSchool(c, s, plan, reason, !!req.dry_run, false)] } satisfies ApplyResult)
  })

  // Role templates.
  r.get('/seller/controls/roles', READ, async (c) => {
    requirePlatformAdmin(c)
    return ok({ roles: await templatesList(c.env), permissions: PERMISSIONS.map(([key, module, description]) => ({ key, module, description })) })
  })
  r.put('/seller/controls/roles/{key}', WRITE, async (c) => {
    requirePlatformAdmin(c)
    const role = knownRole(c.params.key)
    const req = await readJSON<{ permissions?: unknown }>(c.req)
    if (!Array.isArray(req.permissions)) throw badRequest('permissions: a list of permission keys')
    const perms = [...new Set(req.permissions.map(String))]
    const bad = perms.filter((p) => !PERMISSION_SET.has(p))
    if (bad.length) throw badRequest('unknown permissions: ' + bad.slice(0, 5).join(', '))
    const before = (await templatesList(c.env)).find((x) => x.key === role.key)!.permissions
    await c.env.CONTROL.prepare(`INSERT INTO platform_role_templates (role_key, permissions, updated_by, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (role_key) DO UPDATE SET permissions = excluded.permissions, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(role.key, JSON.stringify(perms.sort()), c.id.userId, now()).run()
    auditDetail(c, { action: 'controls.role_template.set', target: role.key,
      before: { removed: before.filter((p) => !perms.includes(p)) }, after: { added: perms.filter((p) => !before.includes(p)) } })
    return ok({ saved: true })
  })
  r.del('/seller/controls/roles/{key}', WRITE, async (c) => {
    requirePlatformAdmin(c)
    const role = knownRole(c.params.key)
    await c.env.CONTROL.prepare(`DELETE FROM platform_role_templates WHERE role_key = ?`).bind(role.key).run()
    auditDetail(c, { action: 'controls.role_template.clear', target: role.key })
    return ok({ cleared: true })
  })
  /* Push the template to schools. Schools that customised the role are
     listed and skipped; naming one in include_customised replaces its
     customisation, deliberately and per school. */
  r.post('/seller/controls/roles/{key}/push', WRITE, async (c) => {
    requirePlatformAdmin(c)
    const role = knownRole(c.params.key)
    const req = await readJSON<{ dry_run?: boolean; reason?: unknown; institution_ids?: unknown; group_id?: unknown; all?: unknown; include_customised?: unknown }>(c.req)
    const reason = req.dry_run ? '' : reasonOf(req.reason)
    const force = new Set(Array.isArray(req.include_customised) ? req.include_customised.filter((x): x is string => typeof x === 'string') : [])
    const ids = await chooseSchools(c.env, req.institution_ids || req.group_id ? req : { all: true })
    const perms = (await templatesList(c.env)).find((x) => x.key === role.key)!.permissions
    const out = await pushRole(c, role.key, perms, ids, force, !!req.dry_run, reason)
    if (!req.dry_run) auditDetail(c, { action: 'controls.role_template.push', target: role.key, after: { reason, updated: out.schools.filter((s) => s.status === 'updated').length } })
    return ok(out)
  })
}
