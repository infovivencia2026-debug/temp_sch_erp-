import type { Env } from './env'
import { currentSession } from './auth/session'
import { institutionById, tenantDb, type Institution } from './tenant'
import { HttpError } from './http'
import { SYSTEM_ROLES } from './routes/admin/static_data'

// rbac.OperatorRoles: platform roles not held to a permission list.
const OPERATOR_ROLES = new Set(['super_admin', 'seller_admin'])

/* Who is calling, resolved once per request from the session cookie. Mirrors
   internal/httpx.Identity. A platform admin acts as a school by sending
   X-Acting-Institution, which the Go server also honours. */
export interface Identity {
  sessionId: string
  userId: string
  fullName: string
  platformAdmin: boolean
  /** A platform account that is not an operator (support_admin): held to its granted permissions. */
  restricted: boolean
  institution: Institution | null
  /** The school the session signed in to (null for platform staff). Differs from institution while a board member acts in another school. */
  homeInstitutionId: string | null
  permissions: Set<string>
  roles: string[]
  mustChangePassword: boolean
}

export async function identityFrom(env: Env, req: Request): Promise<Identity | null> {
  const s = await currentSession(env, req)
  if (!s) return null

  if (s.institution_id === null) {
    const u = await env.CONTROL.prepare(`SELECT full_name FROM platform_users WHERE id = ? AND status = 'active'`)
      .bind(s.user_id).first<{ full_name: string }>()
    if (!u) return null
    const acting = req.headers.get('x-acting-institution')
    const institution = acting ? await institutionById(env, acting) : null
    /* Not every platform account is an operator (httpx.Identity.Restricted): only the roles in
       rbac.OperatorRoles may do anything. support_admin reaches across schools but holds only the
       permissions its role grants, or a support desk would inherit every school's records. */
    const pr = await env.CONTROL.prepare(`SELECT role_key FROM platform_user_roles WHERE user_id = ?`).bind(s.user_id).all<{ role_key: string }>()
    const roleKeys = pr.results.map((r) => r.role_key)
    const operator = roleKeys.some((k) => OPERATOR_ROLES.has(k))
    const permissions = new Set<string>(operator ? ['*'] : [])
    if (!operator) for (const k of roleKeys) for (const p of SYSTEM_ROLES.find((r) => r.key === k)?.permissions ?? []) permissions.add(p)
    return { sessionId: s.id, userId: s.user_id, fullName: u.full_name, platformAdmin: true, restricted: !operator,
      institution, homeInstitutionId: null, permissions, roles: roleKeys.length ? roleKeys : ['platform_admin'], mustChangePassword: false }
  }

  const home = await institutionById(env, s.institution_id)
  if (!home) return null
  /* A board member (acting.go actAsBoardMember) may stand inside another school,
     but ONLY one they oversee. Proven twice: the CONTROL index written when the
     seller granted it, and the board grant itself in that school's own database.
     Non-member and non-existent get the same 403, so ids cannot be probed. The
     permissions are the ones that school granted, never the home school's. */
  const acting = req.headers.get('x-acting-institution')
  let institution = home
  if (acting && acting !== home.id) {
    const denied = () => new HttpError(403, 'you do not oversee that school', { code: 'not_a_board_member' })
    const idx = await env.CONTROL.prepare(`SELECT 1 AS x FROM board_memberships WHERE user_id = ? AND home_institution_id = ? AND institution_id = ?`)
      .bind(s.user_id, home.id, acting).first().catch(() => null)
    if (!idx) throw denied()
    const target = await institutionById(env, acting)
    if (!target) throw denied()
    let tdb: D1Database
    try { tdb = tenantDb(env, target) } catch { throw denied() }
    const held = await tdb.prepare(`SELECT 1 AS x FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
        WHERE ur.user_id = ? AND r.key = 'board_member' AND u.status = 'active'`).bind(s.user_id).first()
    if (!held) throw denied()
    if (target.status === 'suspended') throw new HttpError(403, 'that school is suspended')
    institution = target
  }
  const db = tenantDb(env, institution)
  const homeDb = institution === home ? db : tenantDb(env, home)
  const [u, roles, perms, direct] = await Promise.all([
    homeDb.prepare(`SELECT full_name, must_change_password FROM users WHERE id = ? AND status = 'active'`).bind(s.user_id)
      .first<{ full_name: string; must_change_password: number }>(),
    db.prepare(`SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`).bind(s.user_id).all<{ key: string }>(),
    db.prepare(`SELECT DISTINCT rp.permission_key AS key FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = ?`)
      .bind(s.user_id).all<{ key: string }>(),
    /* Direct grants ("give this person that feature") count everywhere,
       at home too. The port skipped them at home, so an access given on
       Logins & access or Roles never reached the person's feature list. */
    db.prepare(`SELECT DISTINCT permission_key AS key FROM user_permissions WHERE user_id = ?`).bind(s.user_id).all<{ key: string }>(),
  ])
  if (!u) return null
  /* platform.* keys belong to the vendor. A school role can come to hold one (a copy of a platform
     role, a stray grant in the school's copy of role_permissions); in Go it bought nothing because
     the seller's handlers ran AsPlatform only for platform identities. Here CONTROL is one call
     away, so the key itself is refused to every school account. */
  const granted = [...perms.results, ...direct.results].map((p) => p.key).filter((k) => !k.startsWith('platform.'))
  return { sessionId: s.id, userId: s.user_id, fullName: u.full_name, platformAdmin: false, restricted: false, institution,
    homeInstitutionId: home.id, permissions: new Set(granted), roles: roles.results.map((r) => r.key),
    mustChangePassword: !!u.must_change_password }
}

export function can(id: Identity, perm: string): boolean {
  return (id.platformAdmin && !id.restricted) || id.permissions.has(perm)
}
