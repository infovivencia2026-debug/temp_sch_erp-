import type { Ctx } from '../../router'
import { forbidden, isUUID, notFound } from '../../http'
import type { Scope } from '../teaching/common'

/* The shared gates of classroom.go. Section-id sets are bound as one JSON
   array (json_each) rather than one placeholder each, because D1 caps a
   statement at 100 bound parameters and a vice principal's reach can exceed it. */

/** errClassroomDenied: a 403 with no detail. */
export const denied = () => forbidden('that is not one of your classes')

/** `col IN (SELECT value FROM json_each(?))` with its one bind. */
export const inJSON = (col: string, ids: readonly string[]) => ({ sql: `${col} IN (SELECT value FROM json_each(?))`, arg: JSON.stringify(ids) })

/** classReachesSection. */
export const reachesSection = (s: Scope, sectionId: string) => s.allStudents || s.allAttendance || s.sectionIds.includes(sectionId)

/** classReachesClass: the caller teaches some section of the class. */
export async function reachesClass(c: Ctx, s: Scope, classId: string): Promise<boolean> {
  if (s.allStudents || s.allAttendance) return true
  if (!s.sectionIds.length) return false
  const q = inJSON('sec.id', s.sectionIds)
  const r = await c.db.prepare(`SELECT 1 AS x FROM sections sec WHERE sec.class_id = ? AND ${q.sql} LIMIT 1`).bind(classId, q.arg).first()
  return !!r
}

/** reachesTaughtStudent in faculty_comms.go. */
export async function reachesTaughtStudent(c: Ctx, s: Scope, studentId: string): Promise<boolean> {
  if (s.allStudents) return true
  if (!s.sectionIds.length) return false
  const q = inJSON('e.section_id', s.sectionIds)
  const r = await c.db.prepare(`SELECT 1 AS x FROM enrollments e WHERE e.student_id = ? AND e.status = 'active' AND ${q.sql} LIMIT 1`)
    .bind(studentId, q.arg).first()
  return !!r
}

/** requireTaughtStudent. */
export async function requireTaughtStudent(c: Ctx, s: Scope, studentId: string): Promise<void> {
  if (!(await reachesTaughtStudent(c, s, studentId))) throw denied()
}

/** pathUUID in student_life.go: a malformed id is a 404, not a 400. */
export function pathUUID(c: Ctx, key: string): string {
  const v = c.params[key]
  if (!isUUID(v)) throw notFound()
  return v
}
