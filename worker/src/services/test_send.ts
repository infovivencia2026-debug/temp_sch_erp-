import { normaliseRecipient } from '../routes/admin/msg_guard'

/* "Send to test parent only" (owner, 2026-11-20). Whatever audience or
   children are picked, a test send goes only to the school's test recipients:
   the numbers and addresses on Message Channels → allowlist. A test parent is
   a guardian whose phone or email is on that list; their linked children are
   the test children. With an empty list there is nobody to test on. */
export interface TestGuardian { student_id: string; name: string | null; uid: string | null; phone: string | null; email: string | null }

export async function testGuardians(db: D1Database): Promise<TestGuardian[]> {
  const allowed = new Set((await db.prepare(`SELECT kind || ':' || normalised AS k FROM messaging_allowed_recipients`).all<{ k: string }>()).results.map((r) => r.k))
  if (!allowed.size) return []
  const rows = (await db.prepare(`SELECT sg.student_id, g.full_name AS name, g.user_id AS uid, g.phone, g.email FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
      JOIN students st ON st.id = sg.student_id AND st.status = 'active'
     WHERE NOT sg.portal_blocked AND (NULLIF(g.phone,'') IS NOT NULL OR NULLIF(g.email,'') IS NOT NULL)`).all<TestGuardian>()).results
  return rows.filter((r) => (r.phone && allowed.has(normaliseRecipient(r.phone))) || (r.email && allowed.has(normaliseRecipient(r.email))))
}
