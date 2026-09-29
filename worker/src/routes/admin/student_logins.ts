import type { Router } from '../../router'
import { badRequest, now, ok, readJSON } from '../../http'
import { auditStmt, institutionId } from './common'
import { MODULE, studentLoginPolicy } from '../../services/student_logins'
import { autoIssueStudentLogin, autoIssueGuardianLogin } from '../setup/staff'

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
    /* Issued by default: switching on gives every eligible child without a
       login one straight away (admission number as username and first
       password). Up to 60 per save, so the request stays quick; the rest are
       counted and the Issue button (or saving again) finishes them. */
    let issued = 0, remaining = 0
    if (b.enabled) {
      const missing = (await c.db.prepare(`SELECT st.id FROM students st
          LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active' LEFT JOIN classes cl ON cl.id = e.class_id
          WHERE st.status = 'active' AND st.user_id IS NULL AND TRIM(COALESCE(st.admission_no, '')) <> ''
            AND (? IS NULL OR (cl.level IS NOT NULL AND cl.level >= ?))
          ORDER BY cl.level, st.admission_no`).bind(min, min).all<{ id: string }>()).results ?? []
      for (const m of missing.slice(0, 60)) { try { if (await autoIssueStudentLogin(c, m.id)) issued++ } catch (e) { console.error('auto login', e) } }
      remaining = Math.max(0, missing.length - issued)
    }
    return ok({ ...(await studentLoginPolicy(c.db)), signed_out: signedOut, logins_issued: issued, logins_remaining: remaining })
  })

  /* Every parent number on file gets a login (owner, 2026-09-29): guardians of
     active students with a phone or email and no login yet. Up to 60 per call
     so the request stays quick; `remaining` says how many are left, and the
     screen calls again until it is 0. No message is sent. */
  r.get('/admin/parent-logins', 'access.users.read', async (c) => {
    const row = await c.db.prepare(`SELECT count(DISTINCT g.id) AS total,
        count(DISTINCT CASE WHEN g.user_id IS NOT NULL THEN g.id END) AS with_login,
        count(DISTINCT CASE WHEN g.user_id IS NULL AND (TRIM(COALESCE(g.phone,'')) <> '' OR TRIM(COALESCE(g.email,'')) <> '') THEN g.id END) AS missing
      FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id JOIN students st ON st.id = sg.student_id AND st.status = 'active'`)
      .first<{ total: number; with_login: number; missing: number }>()
    return ok({ total: row?.total ?? 0, with_login: row?.with_login ?? 0, missing: row?.missing ?? 0 })
  })
  r.post('/admin/parent-logins/issue-missing', 'access.users.write', async (c) => {
    const ids = (await c.db.prepare(`SELECT DISTINCT g.id FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id
        JOIN students st ON st.id = sg.student_id AND st.status = 'active'
        WHERE g.user_id IS NULL AND (TRIM(COALESCE(g.phone,'')) <> '' OR TRIM(COALESCE(g.email,'')) <> '')
        ORDER BY g.id`).all<{ id: string }>()).results ?? []
    let issued = 0, skipped = 0
    for (const g of ids.slice(0, 60)) {
      try { if (await autoIssueGuardianLogin(c, g.id)) issued++; else skipped++ } catch (e) { skipped++; console.error('parent login', e) }
    }
    const left = await c.db.prepare(`SELECT count(DISTINCT g.id) AS n FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id
        JOIN students st ON st.id = sg.student_id AND st.status = 'active'
        WHERE g.user_id IS NULL AND (TRIM(COALESCE(g.phone,'')) <> '' OR TRIM(COALESCE(g.email,'')) <> '')`).first<{ n: number }>()
    await auditStmt(c, 'parent_logins.issue_missing', 'guardians', null, null, { issued, skipped }).run()
    return ok({ issued, skipped, remaining: Math.max(0, (left?.n ?? 0) - skipped) })
  })

  /* Every eligible student without a login gets one, 60 per call; the screen
     calls again until `remaining` is 0. Same rules as the switch. */
  r.post('/admin/student-logins/issue-missing', 'access.users.write', async (c) => {
    const p = await studentLoginPolicy(c.db)
    if (!p.enabled) throw badRequest('switch student logins on first')
    const q = `FROM students st LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active' LEFT JOIN classes cl ON cl.id = e.class_id
        WHERE st.status = 'active' AND st.user_id IS NULL AND TRIM(COALESCE(st.admission_no, '')) <> ''
          AND (? IS NULL OR (cl.level IS NOT NULL AND cl.level >= ?))`
    const ids = (await c.db.prepare(`SELECT st.id ${q} ORDER BY cl.level, st.admission_no LIMIT 60`).bind(p.min_level, p.min_level).all<{ id: string }>()).results ?? []
    let issued = 0, skipped = 0
    for (const m of ids) { try { if (await autoIssueStudentLogin(c, m.id)) issued++; else skipped++ } catch (e) { skipped++; console.error('student login', e) } }
    const left = await c.db.prepare(`SELECT count(*) AS n ${q}`).bind(p.min_level, p.min_level).first<{ n: number }>()
    await auditStmt(c, 'student_logins.issue_missing', 'students', null, null, { issued, skipped }).run()
    return ok({ issued, skipped, remaining: Math.max(0, (left?.n ?? 0) - skipped) })
  })
}
