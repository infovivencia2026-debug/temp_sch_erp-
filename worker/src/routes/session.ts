import type { Env } from '../env'
import { json } from '../env'
import { currentSession } from '../auth/session'
import { institutionById, tenantDb } from '../tenant'
import { entitlementFor } from './misc/shell'
import type { Ctx } from '../router'

/* GET /api/v1/session: the boot call. Same JSON as internal/api/session.go
   so the web client needs no change. Permissions and roles come from the
   school's database; modules and subscription from CONTROL. */
export async function getSession(env: Env, req: Request): Promise<Response> {
  const s = await currentSession(env, req)
  if (!s) return json({ authenticated: false, permissions: [] })

  if (s.institution_id === null) {
    const u = await env.CONTROL.prepare('SELECT full_name FROM platform_users WHERE id = ?').bind(s.user_id).first<{ full_name: string }>()
    return json({
      authenticated: true, permissions: ['*'],
      user: { id: s.user_id, full_name: u?.full_name ?? '', roles: ['platform_admin'], platform_admin: true },
    })
  }

  const inst = await institutionById(env, s.institution_id)
  if (!inst) return json({ authenticated: false, permissions: [] })
  const db = tenantDb(env, inst)

  const [user, roles, perms, branding, sub] = await Promise.all([
    db.prepare('SELECT full_name, avatar_key, must_change_password FROM users WHERE id = ?').bind(s.user_id)
      .first<{ full_name: string; avatar_key: string | null; must_change_password: number }>(),
    db.prepare('SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.key').bind(s.user_id)
      .all<{ key: string }>(),
    db.prepare(`SELECT DISTINCT rp.permission_key AS key FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                WHERE ur.user_id = ? ORDER BY rp.permission_key`).bind(s.user_id)
      .all<{ key: string }>(),
    db.prepare('SELECT display_name, tagline, logo_key, favicon_key, primary_color, accent_color FROM branding_profiles WHERE campus_id IS NULL LIMIT 1')
      .first<{ display_name: string | null; tagline: string | null; logo_key: string | null; favicon_key: string | null; primary_color: string | null; accent_color: string | null }>()
      .catch(() => null),
    env.CONTROL.prepare('SELECT s.plan_code, p.name AS plan_name, s.status, s.renews_on, s.trial_ends_on, p.modules FROM subscriptions s JOIN plans p ON p.code = s.plan_code WHERE s.institution_id = ?')
      .bind(inst.id).first<{ plan_code: string; plan_name: string; status: string; renews_on: string | null; trial_ends_on: string | null; modules: string }>(),
  ])
  if (!user) return json({ authenticated: false, permissions: [] })

  /* As internal/api/session.go: `modules` is the school's own module switches
     (module_settings), and `subscription` is the entitlement the gate uses,
     with `active` -- the flag the app reads to decide whether the school is
     switched on. */
  const [modRows, ent] = await Promise.all([
    db.prepare('SELECT module, enabled FROM module_settings ORDER BY module').all<{ module: string; enabled: number }>()
      .catch(() => ({ results: [] as { module: string; enabled: number }[] })),
    entitlementFor({ env, id: { institution: inst } } as unknown as Ctx),
  ])
  const modules = modRows.results.map((m) => ({ module: m.module, enabled: !!m.enabled }))
  const ALL_MODULES = ['students', 'academics', 'attendance', 'fees', 'communication', 'exams', 'hr', 'transport', 'library', 'hostel', 'inventory']
  const subscription = {
    active: ent.active, code: ent.code || undefined, reason: ent.reason || undefined,
    plan_code: ent.planCode || undefined, plan_name: ent.planName || undefined, status: ent.status || undefined,
    trial_ends_on: sub?.trial_ends_on ? sub.trial_ends_on.slice(0, 10) : undefined,
    modules: ent.all ? ALL_MODULES : ALL_MODULES.filter((m) => ent.modules.has(m)),
    custom_integration: ent.customIntegration,
  }
  return json({
    authenticated: true,
    permissions: perms.results.map((p) => p.key),
    user: {
      id: s.user_id, full_name: user.full_name, roles: roles.results.map((r) => r.key),
      avatar_key: user.avatar_key ?? undefined, platform_admin: false,
      must_change_password: !!user.must_change_password || undefined,
    },
    institution: {
      id: inst.id, name: inst.name, short_name: inst.short_name, slug: inst.slug,
      primary_color: branding?.primary_color || inst.primary_color, timezone: inst.timezone, locale: inst.locale,
      display_name: branding?.display_name ?? undefined, tagline: branding?.tagline ?? undefined,
      logo_key: branding?.logo_key || inst.logo_key || undefined, favicon_key: branding?.favicon_key ?? undefined,
      accent_color: branding?.accent_color ?? undefined,
    },
    modules,
    subscription,
  })
}
