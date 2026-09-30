/* STUDENT LOGINS: on for every child, unless a school switches them off.

   module_settings module 'student_logins' (enabled, config.min_level).

   THE LOWEST-CLASS RULE IS GONE. It was a reasonable-looking safeguard -- very
   young children arguably have no business with an account -- and in practice
   it did two things nobody wanted. It refused to issue a login to children the
   school had asked for one for, and, worse, it refused SIGN-IN to children who
   already held a working login: a child typed a username and password that
   were correct and was told "student logins at this school start from class
   level -3", which is not a sentence anybody can act on and not a fact about
   their password. The learning material is for every child in the school, so
   every child may have a login for it.

   min_level is still read, so a school that set one is not silently rewritten,
   but nothing enforces it any more and the settings screen no longer offers
   it. Whether student logins exist at all remains the school's to decide.

   A school that has never touched the switch now gets them ON. The old
   fallback -- on only if a login had already been issued -- meant a new school
   could not issue its first one without first finding a switch it did not know
   existed. Nothing is written until an administrator chooses otherwise. */

export const MODULE = 'student_logins'

export interface StudentLoginPolicy { enabled: boolean; min_level: number | null; chosen: boolean }

export async function studentLoginPolicy(db: D1Database): Promise<StudentLoginPolicy> {
  const row = await db.prepare(`SELECT enabled, config FROM module_settings WHERE module = ?`).bind(MODULE)
    .first<{ enabled: number; config: string | null }>().catch(() => null)
  if (!row) return { enabled: true, min_level: null, chosen: false }
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
  /* No class-level test. Every child in the school may hold a login and use
     it; see the note at the top of this file. studentId is kept in the
     signature because the switch is still per-school and a future rule would
     need it, and because every caller already passes it. */
  void studentId
  return null
}

/** For sign-in: the student record behind an account that is ONLY a student (no staff or parent role), else null. */
export async function studentOnlyAccount(db: D1Database, userId: string): Promise<string | null> {
  const r = await db.prepare(`SELECT st.id FROM students st WHERE st.user_id = ?
      AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = st.user_id AND r.key <> 'student')`)
    .bind(userId).first<{ id: string }>().catch(() => null)
  return r?.id ?? null
}
