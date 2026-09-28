/* STUDENT LOGINS: a per-school switch with an optional lowest class.

   module_settings module 'student_logins' (enabled, config.min_level). While
   it is off the school cannot issue a login to a child and a child's existing
   login cannot sign in; while it is on, only children in a class at or above
   min_level (classes.level) can have or use one.

   A school that has never touched the switch keeps the behaviour it had
   before the switch existed: on if it has already issued any student login,
   off otherwise. Nothing is written until an administrator chooses. */

export const MODULE = 'student_logins'

export interface StudentLoginPolicy { enabled: boolean; min_level: number | null; chosen: boolean }

export async function studentLoginPolicy(db: D1Database): Promise<StudentLoginPolicy> {
  const row = await db.prepare(`SELECT enabled, config FROM module_settings WHERE module = ?`).bind(MODULE)
    .first<{ enabled: number; config: string | null }>().catch(() => null)
  if (!row) {
    const any = await db.prepare(`SELECT 1 AS x FROM students WHERE user_id IS NOT NULL LIMIT 1`).first().catch(() => null)
    return { enabled: !!any, min_level: null, chosen: false }
  }
  let min: number | null = null
  try {
    const v = JSON.parse(row.config || '{}').min_level
    if (typeof v === 'number' && Number.isFinite(v)) min = Math.trunc(v)
  } catch { /* none */ }
  return { enabled: !!row.enabled, min_level: min, chosen: true }
}

/** The level of the class a student is in now (active enrolment), or null when not enrolled. */
export async function studentLevel(db: D1Database, studentId: string): Promise<{ level: number | null; class_name: string | null }> {
  const r = await db.prepare(`SELECT cl.level, cl.name FROM enrollments e JOIN classes cl ON cl.id = e.class_id
      WHERE e.student_id = ? AND e.status = 'active' ORDER BY e.enrolled_on DESC LIMIT 1`).bind(studentId)
    .first<{ level: number | null; name: string }>().catch(() => null)
  return { level: r?.level ?? null, class_name: r?.name ?? null }
}

/** Why this child may not have a login right now, or null when they may. */
export async function studentLoginRefusal(db: D1Database, studentId: string, policy?: StudentLoginPolicy): Promise<string | null> {
  const p = policy ?? await studentLoginPolicy(db)
  if (!p.enabled) return 'Student logins are switched off at this school. An administrator can switch them on under Staff, Logins & access.'
  if (p.min_level !== null) {
    const l = await studentLevel(db, studentId)
    if (l.level === null || l.level < p.min_level) {
      return `Student logins at this school start from class level ${p.min_level}${l.class_name ? `; this child is in ${l.class_name}` : ''}.`
    }
  }
  return null
}

/** For sign-in: the student record behind an account that is ONLY a student (no staff or parent role), else null. */
export async function studentOnlyAccount(db: D1Database, userId: string): Promise<string | null> {
  const r = await db.prepare(`SELECT st.id FROM students st WHERE st.user_id = ?
      AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = st.user_id AND r.key <> 'student')`)
    .bind(userId).first<{ id: string }>().catch(() => null)
  return r?.id ?? null
}
