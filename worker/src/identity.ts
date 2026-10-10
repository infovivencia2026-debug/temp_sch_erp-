import type { Env } from './env'
import { liveSession, readCookie, sessionStmt, tokenHash, type Session } from './auth/session'
import { cacheKey, cacheTtl, cached, ensureVersionsTable, remember, versionString, versionsStmt } from './idcache'
import { institutionById, noteInstitution, tenantDb, type Institution } from './tenant'
import { HttpError } from './http'
import { SYSTEM_ROLES } from './routes/admin/static_data'

// rbac.OperatorRoles: platform roles not held to a permission list.
const OPERATOR_ROLES = new Set(['super_admin', 'seller_admin'])
/** The vendor's ticket queue (Support → Support): the one screen a support login holds. */
export const SUPPORT_DESK = 'seller_admin.support.support'

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
  /** Inside a school on a Quick Assist session: reads only. */
  readOnly?: boolean
}

/* The session row and the cache versions in one CONTROL round trip; then the
   identity from this isolate's cache when its versions still match
   (idcache.ts), else resolved afresh and remembered. */
export async function identityFrom(env: Env, req: Request, ctx?: ExecutionContext): Promise<Identity | null> {
  const token = readCookie(req)
  if (!token) return null
  const hash = await tokenHash(token)
  const acting = req.headers.get('x-acting-institution') || null
  let row: Session | null
  let versions: string | null = null
  let home: Institution | null | undefined
  const read = () => env.CONTROL.batch([sessionStmt(env, hash), versionsStmt(env, hash, acting),
    env.CONTROL.prepare('SELECT * FROM institutions WHERE id = (SELECT institution_id FROM sessions WHERE token_hash = ?)').bind(hash)])
  try {
    let res: D1Result[]
    try { res = await read() } catch { await ensureVersionsTable(env); res = await read() }
    row = (res[0].results[0] as Session | undefined) ?? null
    if (row) versions = versionString(res[1].results as { scope: string; version: number }[], row.institution_id, acting)
    // Read on every request, cached identity or not: the switch version rides along (refcache.ts).
    home = noteInstitution((res[2].results[0] as Institution | undefined) ?? null)
  } catch {
    row = await sessionStmt(env, hash).first<Session>()
  }
  const s = await liveSession(env, row, ctx)
  if (!s) return null
  const key = cacheKey(hash, acting)
  const ttl = cacheTtl(env)
  if (ttl === 0) versions = null
  if (versions !== null) {
    const hit = cached(key, versions, s.id, ttl)
    if (hit) return hit
  }
  const id = await resolveIdentity(env, req, s, home)
  if (id && versions !== null) remember(key, versions, id)
  return id
}

/** The operator's live session in a school: null when none; read_only for a Quick Assist session (help/assist.ts). */
async function liveGrant(env: Env, inst: Institution, operatorId: string): Promise<{ read_only: boolean } | null> {
  try {
    const row = await tenantDb(env, inst).prepare(`SELECT read_only FROM impersonation_grants WHERE operator_user_id = ? AND ended_at IS NULL AND expires_at > ? ORDER BY started_at DESC LIMIT 1`)
      .bind(operatorId, new Date().toISOString()).first<{ read_only: number | null }>()
    return row ? { read_only: !!row.read_only } : null
  } catch (err) {
    // A school whose database cannot be opened grants nothing.
    console.error(err)
    return null
  }
}

async function resolveIdentity(env: Env, req: Request, s: Session, prefetched?: Institution | null): Promise<Identity | null> {

  if (s.institution_id === null) {
    const u = await env.CONTROL.prepare(`SELECT full_name FROM platform_users WHERE id = ? AND status = 'active'`)
      .bind(s.user_id).first<{ full_name: string }>()
    if (!u) return null
    const acting = req.headers.get('x-acting-institution')
    let institution = acting ? await institutionById(env, acting) : null
    /* Not every platform account is an operator (httpx.Identity.Restricted): only the roles in
       rbac.OperatorRoles may do anything. support_admin reaches across schools but holds only the
       permissions its role grants, or a support desk would inherit every school's records. */
    const pr = await env.CONTROL.prepare(`SELECT role_key FROM platform_user_roles WHERE user_id = ?`).bind(s.user_id).all<{ role_key: string }>()
    const roleKeys = pr.results.map((r) => r.role_key)
    const operator = roleKeys.some((k) => OPERATOR_ROLES.has(k))
    const permissions = new Set<string>(operator ? ['*'] : [])
    if (!operator) for (const k of roleKeys) for (const p of SYSTEM_ROLES.find((r) => r.key === k)?.permissions ?? []) permissions.add(p)
    /* THE SUPPORT DESK'S OWN SCREEN. The role's grants are capabilities and
       name no screen, so a support login signed in to an empty console and
       could not open the queue it exists to answer. A catalogue key, added
       here rather than to the role's list: that list is mirrored from Go's
       rbac, whose permission grid does not carry catalogue keys. It reveals
       tickets schools raised with the vendor and nothing from a school's
       own records. */
    if (!operator && roleKeys.includes('support_admin')) permissions.add(SUPPORT_DESK)
    /* A SUPPORT LOGIN STANDS INSIDE A SCHOOL ONLY ON A RECORDED SESSION.
       The header alone used to be enough: any support account could name any
       school and read its shape, jobs and audit trail, with no reason given
       and nothing for that school's administrator to see. Now there must be
       a live grant in that school's own register (impersonation_grants: who,
       why, until when), which the support screen writes and the school can
       read and end. No grant, or an expired one, and the request is treated
       as made from outside every school. Operators are not held to this:
       running the console means entering schools all day. */
    /* A QUICK ASSIST SESSION ONLY READS. The person who read out the code
       agreed to be looked at, not to have their school changed: while the
       newest live session in this school is read-only, index.ts refuses every
       write, operators included. */
    const grant = institution ? await liveGrant(env, institution, s.user_id) : null
    if (institution && !operator && !grant) institution = null
    return { sessionId: s.id, userId: s.user_id, fullName: u.full_name, platformAdmin: true, restricted: !operator,
      institution, homeInstitutionId: null, permissions, roles: roleKeys.length ? roleKeys : ['platform_admin'], mustChangePassword: false,
      readOnly: !!(institution && grant?.read_only) }
  }

  const home = prefetched?.id === s.institution_id ? prefetched : await institutionById(env, s.institution_id)
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
  const [u, roles, perms, direct, blocked] = await Promise.all([
    homeDb.prepare(`SELECT full_name, must_change_password FROM users WHERE id = ? AND status = 'active'`).bind(s.user_id)
      .first<{ full_name: string; must_change_password: number }>(),
    db.prepare(`SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`).bind(s.user_id).all<{ key: string }>(),
    db.prepare(`SELECT DISTINCT rp.permission_key AS key FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = ?`)
      .bind(s.user_id).all<{ key: string }>(),
    /* Direct grants ("give this person that feature") count everywhere,
       at home too. The port skipped them at home, so an access given on
       Logins & access or Roles never reached the person's feature list. */
    db.prepare(`SELECT DISTINCT permission_key AS key FROM user_permissions WHERE user_id = ?`).bind(s.user_id).all<{ key: string }>(),
    /* Features the school switched OFF for this student or parent: for the
       whole school, their (child's) class or section, or them alone
       (routes/admin/feature_blocks.ts). Only student.* / parent.* keys are
       ever stored. Empty until the table exists. */
    db.prepare(`SELECT DISTINCT fb.feature_key AS key FROM feature_blocks fb WHERE
        (fb.scope = 'person' AND fb.target_id = ?1)
        OR (fb.portal = 'student' AND EXISTS (SELECT 1 FROM students st WHERE st.user_id = ?1 AND (fb.scope = 'school'
          OR EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = st.id AND e.status = 'active'
            AND ((fb.scope = 'class' AND e.class_id = fb.target_id) OR (fb.scope = 'section' AND e.section_id = fb.target_id))))))
        OR (fb.portal = 'parent' AND EXISTS (SELECT 1 FROM guardians g WHERE g.user_id = ?1 AND (fb.scope = 'school'
          OR EXISTS (SELECT 1 FROM student_guardians sg JOIN enrollments e ON e.student_id = sg.student_id AND e.status = 'active'
            WHERE sg.guardian_id = g.id
            AND ((fb.scope = 'class' AND e.class_id = fb.target_id) OR (fb.scope = 'section' AND e.section_id = fb.target_id))))))`)
      .bind(s.user_id).all<{ key: string }>().catch(() => ({ results: [] as { key: string }[] })),
  ])
  if (!u) return null
  /* platform.* keys belong to the vendor. A school role can come to hold one (a copy of a platform
     role, a stray grant in the school's copy of role_permissions); in Go it bought nothing because
     the seller's handlers ran AsPlatform only for platform identities. Here CONTROL is one call
     away, so the key itself is refused to every school account. */
  const off = new Set((blocked.results ?? []).map((b) => b.key).filter((k) => k.startsWith('student.') || k.startsWith('parent.')))
  const granted = [...perms.results, ...direct.results].map((p) => p.key).filter((k) => !k.startsWith('platform.') && !off.has(k))
  return { sessionId: s.id, userId: s.user_id, fullName: u.full_name, platformAdmin: false, restricted: false, institution,
    homeInstitutionId: home.id, permissions: new Set(granted), roles: roles.results.map((r) => r.key),
    mustChangePassword: !!u.must_change_password }
}

export function can(id: Identity, perm: string): boolean {
  return (id.platformAdmin && !id.restricted) || id.permissions.has(perm)
}
