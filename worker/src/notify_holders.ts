import { now, uuid } from './http'

/** One notification row for every active user holding `perm` (through a role or a
    direct grant), except `skip`. Used where a request waits on whoever may approve it. */
export async function notifyHoldersStmts(db: D1Database, inst: string, perm: string, skip: string | null,
  kind: string, title: string, body: string, link: string, sourceKind: string, sourceId: string): Promise<D1PreparedStatement[]> {
  const rows = await db.prepare(`SELECT u.id FROM users u WHERE u.status = 'active' AND u.id IS NOT ?2 AND (
      EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = u.id AND rp.permission_key = ?1)
      OR EXISTS (SELECT 1 FROM user_permissions up WHERE up.user_id = u.id AND up.permission_key = ?1))`)
    .bind(perm, skip).all<{ id: string }>()
  return rows.results.map((r) => notifyStmt(db, inst, r.id, kind, title, body, link, sourceKind, sourceId))
}

export function notifyStmt(db: D1Database, inst: string, user: string, kind: string, title: string, body: string,
  link: string, sourceKind: string, sourceId: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO notifications (id, institution_id, user_id, kind, title, body, link, source_kind, source_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst, user, kind, title, body, link, sourceKind, sourceId, now())
}
