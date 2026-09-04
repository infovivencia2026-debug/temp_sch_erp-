import { screen } from '@/lib/screen'

/**
 * The IT administrator's workspace, keyed by catalogue feature.
 *
 * The role holds users, roles, sessions, audit, jobs and integrations
 * permissions and had no catalogue, so it signed in to nothing. Every screen
 * here exists already under the platform operator or the principal; the
 * routes each one calls are gated on keys it_admin holds.
 *
 * One caveat: the integrations index lists connectors whose fix-up screens
 * are keyed super_admin.* — the index itself opens (institution.read), the
 * links into a connector's setup may not.
 *
 * Spread into FEATURE_COMPONENTS in registry.ts; scripts/gen_implemented.py
 * reads the keys here. Keys checked against internal/catalog/catalog_gen.go.
 */
export const itAdminKeys = {
  'it_admin.home.systems_desk': screen(() =>
    import('../bento/ITDesk').then((m) => ({ default: m.Classic })),
  ),
  'it_admin.access.users': screen(() => import('./Users')),
  'it_admin.access.logins_sessions': screen(() => import('./SessionAudit')),
  'it_admin.access.roles_permissions': screen(() => import('./RolesPermissions')),
  'it_admin.systems.audit_log': screen(() => import('./AuditLog')),
  'it_admin.systems.background_jobs': screen(() => import('../shared/Jobs')),
  'it_admin.systems.integrations': screen(() => import('./Integrations')),
  'it_admin.my_profile.profile': screen(() => import('../shared/Profile')),
  'it_admin.my_profile.my_pay': screen(() => import('../me/MyPay')),
}
