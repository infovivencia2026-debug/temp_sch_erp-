import type { Ctx, Router } from '../../router'
import type { Env } from '../../env'
import { memoFor } from '../../idcache'
import type { Identity } from '../../identity'
import { HttpError, badRequest, notFound, now, ok, readJSON, uuidParam } from '../../http'
import { institutionById } from '../../tenant'
import { featuresVersion } from '../../services/refcache'
import { CATALOG_ROLES } from '../admin/static_data'
import { SECTION_MODULE, entitlementFor, type Entitlement } from '../misc/shell'
import { requirePlatformAdmin } from './common'

/* Per-school feature switches (CONTROL school_feature_overrides, see
   db/changes/control_features.sql). A feature is '<section>.<feature>', the
   catalogue key without its role, so one switch covers every role that shows
   it. Its plan default is whether the plan's modules include its section's
   module; an override (until ends_at, if set) replaces that default.

   Enforced in two places:
   - GET /catalog omits a feature that is off (catalogFeatureAllowed, below);
   - featureGate (called from gates.ts subscriptionGate) refuses the API
     prefixes in FEATURE_ROUTES once every feature that uses a prefix is off:
     402 when the plan leaves it out, 403 when the seller switched it off. */

const PERM = 'platform.tenants.write'

export interface FeatureDef { id: string; section: string; name: string; summary: string; module: string }

let defs: FeatureDef[] | null = null
/** Every switchable feature, once, in catalogue order. */
export function featureDefs(): FeatureDef[] {
  if (defs) return defs
  const seen = new Map<string, FeatureDef>()
  for (const role of CATALOG_ROLES) {
    if (role.key === 'seller_admin' || role.key === 'super_admin') continue
    for (const sec of role.sections) for (const f of sec.features) {
      const id = sec.slug + '.' + f.slug
      if (!seen.has(id)) seen.set(id, { id, section: sec.name, name: f.name, summary: f.summary, module: SECTION_MODULE[sec.slug] ?? 'core' })
    }
  }
  /* Not a catalogue screen: the switch that lets the seller forbid session
     activity recording for a school (services/session_activity.ts). Off =
     the school cannot record; on or no override = the school's own choice,
     which is off until its administrator turns it on. */
  seen.set('staff.session_activity', { id: 'staff.session_activity', section: 'Staff', name: 'Session activity recording',
    summary: 'Lets the school record sign-ins, screens visited and time spent. The school still has to turn it on.', module: 'core' })
  defs = [...seen.values()]
  return defs
}
export const featureIdOf = (sectionSlug: string, featureSlug: string) => sectionSlug + '.' + featureSlug

/* API prefixes (under /api/v1) that belong to a feature. A prefix is refused
   only when every feature listing it is off, so one sub-feature switched off
   does not take a shared endpoint away from the rest. Features not listed here
   are hidden from the catalogue only. */
export const FEATURE_ROUTES: Record<string, string[]> = {
  'library.books_copies': ['/ops/library', '/ops/digital-library', '/portal/library'],
  'library.accession_register': ['/ops/library'],
  'library.issue_return': ['/ops/library'],
  'library.reservations': ['/ops/library'],
  'library.fines': ['/ops/library'],
  'hostel.hostel_rooms': ['/ops/hostel'],
  'hostel.outpasses_mess': ['/ops/hostel'],
  'hostel.night_study': ['/ops/hostel'],
  'hostel.visitor_log': ['/ops/hostel'],
  'transport.vehicles': ['/ops/transport', '/transport/vehicles'],
  'transport.routes_stops': ['/ops/transport', '/transport/map-stops'],
  'transport.student_allocation': ['/ops/transport'],
  'transport.live_vehicle_tracking': ['/transport/live', '/transport/trackers', '/transport/tracking-policy', '/me/child-bus'],
  'transport.my_bus_route': ['/me/child-bus'],
  'homework.homework_assignments': ['/homework'],
  'teaching.homework_classwork': ['/homework', '/teaching/assignments'],
  'question_papers_online_tests.objective_online_test_creation': ['/teaching/online-tests'],
  'question_papers_online_tests.question_bank_management': ['/teaching/question-bank', '/exams/question-papers'],
  'payments_devices.virtual_classroom_integration': ['/teaching/virtual-classes', '/portal/live-classes'],
  'payments_devices.tally_erp_prime_connector': ['/admin/tally', '/finance/tally'],
  'admissions.waitlist': ['/admissions/waitlist'],
  'admissions.rte_quota': ['/admissions/rte'],
  'payroll.monthly_payroll': ['/payroll/run', '/payroll/payslips', '/payroll/bank-file'],
  'campus_money.cafeteria_store_sales': ['/portal/cafeteria', '/store/catalogue'],
  'communication.class_status': ['/status'], // feature:communication.class_status
}

export interface Override { enabled: boolean; ends_at: string | null; note: string; updated_at: string }

type OvRow = { feature_id: string; enabled: number; ends_at: string | null; note: string; updated_at: string }

/* Per-isolate cache of each school's override rows, keyed on
   institutions.features_version (CONTROL migration 0013: triggers bump it on
   any write to school_feature_overrides). Every request reads the school's
   institutions row and notes the version (identity.ts, tenant.ts
   institutionById -> refcache.ts), so a changed switch is seen on the next
   request on every isolate, with no CONTROL read for the switches themselves.
   Lapsing (ends_at) is decided at read time, so a cached row that has run
   out stops counting on its own. Before the migration (no version) nothing
   is cached. */
const ovCache = new Map<string, { version: number; rows: OvRow[] }>()

/** The rows cached for this school under its current version, or null. */
export function cachedOverrideRows(institutionId: string): OvRow[] | null {
  const v = featuresVersion(institutionId)
  if (v === undefined) return null
  const e = ovCache.get(institutionId)
  return e && e.version === v ? e.rows : null
}

/** Keeps rows just read from CONTROL under the version noted for this school (a no-op without one). */
export function rememberOverrideRows(institutionId: string, rows: OvRow[]): void {
  const v = featuresVersion(institutionId)
  if (v !== undefined) ovCache.set(institutionId, { version: v, rows })
}

/* Two misses in one request (the gate and, say, session activity) share one
   read rather than each asking CONTROL. */
const inflight = new Map<string, Promise<OvRow[]>>()
export function loadOverrideRows(env: Env, institutionId: string): Promise<OvRow[]> {
  const held = cachedOverrideRows(institutionId)
  if (held) return Promise.resolve(held)
  let p = inflight.get(institutionId)
  if (!p) {
    p = overridesStmt(env, institutionId).all<OvRow>().then((r) => { rememberOverrideRows(institutionId, r.results); return r.results })
    inflight.set(institutionId, p)
    p.finally(() => inflight.delete(institutionId)).catch(() => {})
  }
  return p
}

/** Test hook: how many schools' switches this isolate holds. */
export const overrideCacheSize = () => ovCache.size

/** The statement reading ALL of a school's overrides (batched by gates.ts); lapsed ones are dropped by overridesFromRows. */
export function overridesStmt(env: Env, institutionId: string): D1PreparedStatement {
  return env.CONTROL.prepare(`SELECT feature_id, enabled, ends_at, note, updated_at FROM school_feature_overrides WHERE institution_id = ?`).bind(institutionId)
}

/** The live (not lapsed) overrides among these rows; `all` keeps the lapsed ones too (the seller's own view). */
export function overridesFromRows(rows: OvRow[], all = false): Map<string, Override> {
  const out = new Map<string, Override>()
  const t = now()
  for (const r of rows) {
    if (!all && r.ends_at !== null && !(r.ends_at > t)) continue
    out.set(r.feature_id, { enabled: !!r.enabled, ends_at: r.ends_at, note: r.note, updated_at: r.updated_at })
  }
  return out
}

/** The school's live (not lapsed) overrides. Empty until the change file is applied. */
export async function featureOverrides(env: Env, institutionId: string, all = false): Promise<Map<string, Override>> {
  try {
    // The seller's own view (all = true) always reads CONTROL: it may follow a write in this request.
    const rows = all ? (await overridesStmt(env, institutionId).all<OvRow>()).results : await loadOverrideRows(env, institutionId)
    return overridesFromRows(rows, all)
  } catch { return new Map() /* table not there yet */ }
}

const planAllows = (ent: Entitlement, module: string) => module === 'core' || ent.all || ent.modules.has(module)

/** What /catalog asks per feature. undefined = no override, fall back to the plan. */
export function catalogFeatureAllowed(ov: Map<string, Override>, sectionSlug: string, featureSlug: string): boolean | undefined {
  return ov.get(featureIdOf(sectionSlug, featureSlug))?.enabled
}

let prefixIndex: Map<string, string[]> | null = null
function prefixes(): Map<string, string[]> {
  if (prefixIndex) return prefixIndex
  prefixIndex = new Map()
  for (const [f, ps] of Object.entries(FEATURE_ROUTES)) for (const p of ps) prefixIndex.set(p, [...(prefixIndex.get(p) ?? []), f])
  return prefixIndex
}
const moduleOf = (id: string) => SECTION_MODULE[id.split('.')[0]] ?? 'core'

/** Refuses an API prefix whose every feature is off for this school. */
export async function featureGate(env: Env, id: Identity, path: string, known?: Entitlement): Promise<void> {
  if (!id.institution || id.platformAdmin) return
  let hit: string[] | null = null
  for (const [p, fs] of prefixes()) if (path === p || path.startsWith(p + '/')) { hit = fs; break }
  if (!hit) return
  const inst = id.institution.id
  const [ov, ent] = await Promise.all([memoFor(id, 'overrides', () => featureOverrides(env, inst)), known ?? entitlementFor({ env, id } as unknown as Ctx)])
  let byPlan = false
  for (const f of hit) {
    const o = ov.get(f)
    if (o ? o.enabled : planAllows(ent, moduleOf(f))) return
    if (!o) byPlan = true
  }
  const name = featureDefs().find((d) => d.id === hit![0])?.name ?? hit[0]
  if (byPlan) throw new HttpError(402, `${name} is not part of this school's plan. Ask us to add it.`, { code: 'feature_not_in_plan', feature: hit[0] })
  throw new HttpError(403, `${name} is switched off for this school. Contact us to switch it back on.`, { code: 'feature_disabled', feature: hit[0] })
}

/* --- seller routes ---------------------------------------------------------- */

function parseEnds(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null
  const s = String(v).trim()
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T23:59:59Z' : s)
  if (Number.isNaN(d.getTime())) throw badRequest('ends_at must be a date')
  if (d.getTime() <= Date.now()) throw badRequest('ends_at is already past')
  return d.toISOString()
}
function knownFeature(f: unknown): string {
  const id = String(f ?? '').trim()
  if (!featureDefs().some((d) => d.id === id)) throw badRequest('no such feature: ' + id)
  return id
}
async function entFor(env: Env, instId: string): Promise<Entitlement> {
  const inst = await institutionById(env, instId)
  if (!inst) throw notFound('no such school')
  return entitlementFor({ env, id: { institution: inst } } as unknown as Ctx)
}
/** FNV-1a: a stable bucket 0-99 per (feature, school), so raising a percentage only adds schools. */
function bucket(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h % 100
}

export function registerSellerFeatures(r: Router): void {
  r.get('/seller/features', PERM, async (c) => {
    requirePlatformAdmin(c)
    const byModule = new Map<string, FeatureDef[]>()
    for (const d of featureDefs()) byModule.set(d.module, [...(byModule.get(d.module) ?? []), d])
    const counts = new Map<string, { on: number; off: number }>()
    try {
      const rows = await c.env.CONTROL.prepare(`SELECT feature_id, sum(enabled) AS on_, sum(1 - enabled) AS off_ FROM school_feature_overrides
          WHERE ends_at IS NULL OR ends_at > ? GROUP BY feature_id`).bind(now()).all<{ feature_id: string; on_: number; off_: number }>()
      for (const x of rows.results) counts.set(x.feature_id, { on: x.on_, off: x.off_ })
    } catch { /* not applied */ }
    return ok({ modules: [...byModule].map(([module, fs]) => ({ module, features: fs.map((f) => ({
      id: f.id, name: f.name, section: f.section, enforced: !!FEATURE_ROUTES[f.id],
      overrides_on: counts.get(f.id)?.on ?? 0, overrides_off: counts.get(f.id)?.off ?? 0 })) })) })
  })

  r.get('/seller/features/schools/{id}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const sid = uuidParam(c.params.id)
    const ent = await entFor(c.env, sid)
    const ov = await featureOverrides(c.env, sid, true)
    const t = now()
    const byModule = new Map<string, unknown[]>()
    for (const d of featureDefs()) {
      const def = planAllows(ent, d.module)
      const o = ov.get(d.id)
      const live = o && (o.ends_at === null || o.ends_at > t)
      byModule.set(d.module, [...(byModule.get(d.module) ?? []), {
        id: d.id, name: d.name, section: d.section, plan_default: def,
        override: o ? { enabled: o.enabled, ends_at: o.ends_at, note: o.note, updated_at: o.updated_at, lapsed: !live } : null,
        effective: live ? o!.enabled : def, enforced: !!FEATURE_ROUTES[d.id] }])
    }
    return ok({ plan_code: ent.planCode, plan_name: ent.planName, status: ent.status, all_modules: ent.all,
      modules: [...byModule].map(([module, features]) => ({ module, in_plan: planAllows(ent, module), features })) })
  })

  r.put('/seller/features/schools/{id}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const sid = uuidParam(c.params.id)
    await entFor(c.env, sid)
    const req = await readJSON<{ feature?: string; enabled?: boolean; ends_at?: string | null; note?: string }>(c.req)
    const f = knownFeature(req.feature)
    if (typeof req.enabled !== 'boolean') throw badRequest('enabled must be true or false')
    await c.env.CONTROL.prepare(`INSERT INTO school_feature_overrides (institution_id, feature_id, enabled, ends_at, note, set_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (institution_id, feature_id) DO UPDATE SET enabled = excluded.enabled,
        ends_at = excluded.ends_at, note = excluded.note, set_by = excluded.set_by, updated_at = excluded.updated_at`)
      .bind(sid, f, req.enabled ? 1 : 0, parseEnds(req.ends_at), (req.note ?? '').trim(), c.id.userId, now()).run()
    return ok({ saved: true })
  })

  // Back to the plan default. ?feature=<id>
  r.del('/seller/features/schools/{id}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const sid = uuidParam(c.params.id)
    const f = knownFeature(c.url.searchParams.get('feature'))
    await c.env.CONTROL.prepare(`DELETE FROM school_feature_overrides WHERE institution_id = ? AND feature_id = ?`).bind(sid, f).run()
    return ok({ cleared: true })
  })

  /* Rollout: one feature on (or off) for chosen schools, a group, or a
     percentage of all schools (stable per school). dry_run lists who. */
  r.post('/seller/features/rollout', PERM, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<{ feature?: string; enabled?: boolean; ends_at?: string | null; note?: string;
      institution_ids?: string[]; group_id?: string; percent?: number; dry_run?: boolean }>(c.req)
    const f = knownFeature(req.feature)
    const enabled = req.enabled !== false
    const ends = parseEnds(req.ends_at)
    const schools = (await c.env.CONTROL.prepare(`SELECT id, name FROM institutions ORDER BY name`).all<{ id: string; name: string }>()).results
    let chosen: { id: string; name: string }[]
    if (Array.isArray(req.institution_ids) && req.institution_ids.length > 0) {
      const want = new Set(req.institution_ids)
      chosen = schools.filter((s) => want.has(s.id))
    } else if (req.group_id) {
      const m = await c.env.CONTROL.prepare(`SELECT institution_id FROM school_group_members WHERE group_id = ?`).bind(req.group_id).all<{ institution_id: string }>()
      const want = new Set(m.results.map((x) => x.institution_id))
      chosen = schools.filter((s) => want.has(s.id))
    } else if (typeof req.percent === 'number') {
      const p = Math.max(0, Math.min(100, Math.trunc(req.percent)))
      chosen = schools.filter((s) => bucket(f + ':' + s.id) < p)
    } else throw badRequest('choose schools: institution_ids, group_id or percent')
    if (!req.dry_run && chosen.length > 0) {
      const t = now()
      const stmt = c.env.CONTROL.prepare(`INSERT INTO school_feature_overrides (institution_id, feature_id, enabled, ends_at, note, set_by, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (institution_id, feature_id) DO UPDATE SET enabled = excluded.enabled,
          ends_at = excluded.ends_at, note = excluded.note, set_by = excluded.set_by, updated_at = excluded.updated_at`)
      const note = (req.note ?? '').trim() || 'rollout'
      await c.env.CONTROL.batch(chosen.map((s) => stmt.bind(s.id, f, enabled ? 1 : 0, ends, note, c.id.userId, t)))
    }
    return ok({ feature: f, enabled, applied: !req.dry_run, schools: chosen, total_schools: schools.length })
  })
}

