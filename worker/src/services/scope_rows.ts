/* The caller's data boundary, read once per request.

   Four modules each kept a port of internal/scope (teaching, admin, students,
   exams) with the same six statements -- campuses, departments headed,
   sections reached, class-teacher-of, children, "teaches at all" -- and each
   memoised on its own key, so a request that crossed modules (GET /bootstrap
   builds its parts with three of them) ran the batch three times. The rows
   are read here, once per Request, and every resolver shapes its own Scope
   from them.

   Sections reached: taught (section_subject_teachers), on the timetable,
   class teacher of, and -- for a head of department -- every section the
   department's teachers are timetabled in. Children: the person's own student
   record and the children whose portal link is open today (Indian time, the
   school's day). */
import type { Identity } from '../identity'

export interface ScopeRows {
  campusIds: string[]
  /** A user_roles row with no campus spans every campus. */
  allCampuses: boolean
  departmentIds: string[]
  sectionIds: string[]
  classTeacherOf: string[]
  studentIds: string[]
  teaches: boolean
}

/** The sections a user reaches. `?1` = user id. */
export const SECTION_SET_SQL = `
  SELECT section_id AS id FROM section_subject_teachers WHERE teacher_user_id = ?1
  UNION SELECT section_id FROM timetable_entries WHERE teacher_user_id = ?1
  UNION SELECT id FROM sections WHERE class_teacher_id = ?1
  UNION SELECT DISTINCT te.section_id FROM timetable_entries te
          JOIN employees emp ON emp.user_id = te.teacher_user_id
         WHERE emp.department_id IN (SELECT id FROM departments WHERE head_user_id = ?1)`

/** Own student record plus linked children. `?1` = user id, `?2` = today. */
export const STUDENT_SET_SQL = `
  SELECT id FROM students WHERE user_id = ?1
  UNION SELECT sg.student_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
         WHERE g.user_id = ?1 AND sg.portal_blocked = 0 AND (sg.access_until IS NULL OR sg.access_until >= ?2)`

const todayIST = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)

const memo = new WeakMap<Request, Promise<ScopeRows>>()

/** The rows for this request, read at most once (the Request is the key: GET /bootstrap's parts share one). */
export function scopeRows(c: { req: Request; db: D1Database; id: Identity }): Promise<ScopeRows> {
  let p = memo.get(c.req)
  if (!p) { p = load(c); memo.set(c.req, p) }
  return p
}

async function load(c: { db: D1Database; id: Identity }): Promise<ScopeRows> {
  const u = c.id.userId
  const [campuses, depts, sections, ct, teaches, students] = await c.db.batch([
    c.db.prepare(`SELECT campus_id FROM user_roles WHERE user_id = ?`).bind(u),
    c.db.prepare(`SELECT id FROM departments WHERE head_user_id = ?`).bind(u),
    c.db.prepare(SECTION_SET_SQL).bind(u),
    c.db.prepare(`SELECT id FROM sections WHERE class_teacher_id = ?`).bind(u),
    c.db.prepare(`SELECT (EXISTS (SELECT 1 FROM section_subject_teachers t WHERE t.teacher_user_id = ?1)
                       OR EXISTS (SELECT 1 FROM sections s WHERE s.class_teacher_id = ?1)) AS t`).bind(u),
    c.db.prepare(STUDENT_SET_SQL).bind(u, todayIST()),
  ])
  const r: ScopeRows = { campusIds: [], allCampuses: false, departmentIds: [], sectionIds: [], classTeacherOf: [], studentIds: [], teaches: false }
  for (const row of campuses.results as { campus_id: string | null }[]) {
    if (row.campus_id === null) r.allCampuses = true
    else r.campusIds.push(String(row.campus_id))
  }
  r.departmentIds = (depts.results as { id: string }[]).map((x) => String(x.id))
  r.sectionIds = (sections.results as { id: string }[]).map((x) => String(x.id))
  r.classTeacherOf = (ct.results as { id: string }[]).map((x) => String(x.id))
  r.teaches = !!Number((teaches.results[0] as { t: number } | undefined)?.t ?? 0)
  r.studentIds = (students.results as { id: string }[]).map((x) => String(x.id))
  return r
}
