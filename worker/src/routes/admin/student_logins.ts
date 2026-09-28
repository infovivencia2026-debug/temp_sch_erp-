import type { Router } from '../../router'
import { badRequest, now, ok, readJSON } from '../../http'
import { auditStmt, institutionId } from './common'
import { MODULE, studentLoginPolicy } from '../../services/student_logins'

/* The school's "Student logins" switch (services/student_logins.ts).
   Reading needs access.users.read, changing it access.users.write, the keys
   Logins & access already runs on. Switching it off signs every child's
   login out at once; the accounts stay, so switching it back on needs no
   re-issue. */
export function registerStudentLogins(r: Router) {
  r.get('/admin/student-logins', 'access.users.read', async (c) => {
    const p = await studentLoginPolicy(c.db)
    const [classes, counts] = await Promise.all([
      c.db.prepare(`SELECT id, name, level FROM classes ORDER BY level, name`).all<{ id: string; name: string; level: number }>(),
      c.db.prepare(`SELECT count(*) AS students, sum(st.user_id IS NOT NULL) AS with_login,
          sum(? IS NULL OR cl.level >= ?) AS eligible
          FROM students st LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active' LEFT JOIN classes cl ON cl.id = e.class_id
          WHERE st.status = 'active'`).bind(p.min_level, p.min_level).first<{ students: number; with_login: number | null; eligible: number | null }>(),
    ])
    return ok({ ...p, classes: classes.results, students: counts?.students ?? 0, with_login: counts?.with_login ?? 0, eligible: counts?.eligible ?? 0 })
  })

  r.put('/admin/student-logins', 'access.users.write', async (c) => {
    const b = await readJSON<{ enabled?: unknown; min_level?: unknown }>(c.req)
    if (typeof b.enabled !== 'boolean') throw badRequest('enabled must be true or false')
    let min: number | null = null
    if (b.min_level !== null && b.min_level !== undefined && b.min_level !== '') {
      const n = Number(b.min_level)
      if (!Number.isInteger(n) || n < -5 || n > 20) throw badRequest('min_level must be a class level, a whole number')
      min = n
    }
    const before = await studentLoginPolicy(c.db)
    await c.db.batch([
      c.db.prepare(`INSERT INTO module_settings (institution_id, module, enabled, config) VALUES (?, ?, ?, ?)
          ON CONFLICT (institution_id, module) DO UPDATE SET enabled = excluded.enabled, config = excluded.config`)
        .bind(institutionId(c), MODULE, b.enabled ? 1 : 0, JSON.stringify({ min_level: min })),
      auditStmt(c, 'student_logins.update', 'module_settings', null, { enabled: before.enabled, min_level: before.min_level }, { enabled: b.enabled, min_level: min }),
    ])
    /* Children who may no longer sign in are signed out now, not at their next sign-in. */
    let signedOut = 0
    const blocked = await c.db.prepare(`SELECT st.user_id FROM students st
        LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active' LEFT JOIN classes cl ON cl.id = e.class_id
        WHERE st.user_id IS NOT NULL AND (? = 0 OR (? IS NOT NULL AND (cl.level IS NULL OR cl.level < ?)))
          AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = st.user_id AND r.key <> 'student')`)
      .bind(b.enabled ? 1 : 0, min, min).all<{ user_id: string }>()
    for (let i = 0; i < blocked.results.length; i += 50) {
      const ids = blocked.results.slice(i, i + 50).map((x) => x.user_id)
      const res = await c.env.CONTROL.prepare(`UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL AND user_id IN (${ids.map(() => '?').join(',')})`)
        .bind(now(), ...ids).run()
      signedOut += res.meta.changes ?? 0
    }
    return ok({ ...(await studentLoginPolicy(c.db)), signed_out: signedOut })
  })
}
