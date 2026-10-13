/* WHOSE HOLIDAY IS IT (owner, 2026-10-13: "in some schools the holidays are
   different for teaching and other staff").

   A calendar entry's applies_to is 'all', 'students', 'staff', and now
   'teaching' (staff who teach: a faculty or HOD role) or 'non_teaching'
   (every other member of staff), 'people:<employee ids>' (named staff) or
   'group:<staff group id>' (a saved group from Staff groups & lists, its rules
   read at the time). Students never take any of these;
   their screens already read only 'all' and 'students'. Everything that
   counts a member of staff's working days asks here, so payroll, loss of
   pay, the attendance sheet and the staff calendar agree on one answer. */

import { staffGroupMemberIds } from '../growth/people'

export interface StaffHolidayRow { on_date: string; to_date: string; applies_to: string }

/** Holidays and vacations any member of staff might have off in [from, to]. */
export async function staffHolidayRows(db: D1Database, from: string, to: string): Promise<StaffHolidayRow[]> {
  const r = await db.prepare(`SELECT substr(on_date, 1, 10) AS on_date, substr(COALESCE(to_date, on_date), 1, 10) AS to_date, applies_to FROM holidays
      WHERE kind IN ('holiday','vacation') AND (applies_to IN ('all','staff','teaching','non_teaching') OR applies_to LIKE 'people:%' OR applies_to LIKE 'group:%')
        AND on_date <= ? AND COALESCE(to_date, on_date) >= ?`)
    .bind(to, from).all<StaffHolidayRow>()
  return r.results
}

/** Users who teach: a faculty or HOD role. */
export async function teachingUsers(db: D1Database): Promise<Set<string>> {
  const r = await db.prepare(`SELECT DISTINCT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.key IN ('faculty','hod')`).all<{ user_id: string }>()
  return new Set(r.results.map((x) => x.user_id))
}

/** Is `day` a holiday for this member of staff? `eid` and `groups` are needed for named people and groups. */
export function isStaffHoliday(rows: StaffHolidayRow[], day: string, teaching: boolean, eid: string | null = null, groups?: Map<string, Set<string>>): boolean {
  return rows.some((h) => day >= h.on_date && day <= h.to_date && appliesToStaff(h.applies_to, teaching, eid, groups))
}

export function appliesToStaff(a: string, teaching: boolean, eid: string | null, groups?: Map<string, Set<string>>): boolean {
  if (a === 'all' || a === 'staff') return true
  if (a === 'teaching') return teaching
  if (a === 'non_teaching') return !teaching
  if (a.startsWith('people:')) return !!eid && a.slice(7).split(',').includes(eid)
  if (a.startsWith('group:')) return !!eid && !!groups?.get(a.slice(6))?.has(eid)
  return false
}

/** Everything needed to answer "is this day off for this person", loaded once. */
export async function staffHolidayChecker(db: D1Database, from: string, to: string): Promise<(day: string, uid: string | null) => boolean> {
  const rows = await staffHolidayRows(db, from, to)
  const teachers = await teachingUsers(db)
  const emps = await db.prepare(`SELECT id, user_id FROM employees WHERE user_id IS NOT NULL`).all<{ id: string; user_id: string }>()
  const eidOf = new Map(emps.results.map((e) => [e.user_id, e.id]))
  const groups = new Map<string, Set<string>>()
  for (const h of rows) if (h.applies_to.startsWith('group:') && !groups.has(h.applies_to.slice(6))) groups.set(h.applies_to.slice(6), await staffGroupMemberIds(db, h.applies_to.slice(6)))
  return (day, uid) => isStaffHoliday(rows, day, !!uid && teachers.has(uid), uid ? eidOf.get(uid) ?? null : null, groups)
}

/** The same rule in SQL, for a holidays row `h` and a user id expression. */
export const staffHolidaySql = (h: string, user: string) => `(${h}.applies_to IN ('all','staff')
  OR (${h}.applies_to = 'teaching' AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ${user} AND r.key IN ('faculty','hod')))
  OR (${h}.applies_to = 'non_teaching' AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ${user} AND r.key IN ('faculty','hod')))
  OR (${h}.applies_to LIKE 'people:%' AND instr(${h}.applies_to, COALESCE((SELECT e.id FROM employees e WHERE e.user_id = ${user} LIMIT 1), '-')) > 0)
  -- A group's hand-picked members here; a rule-made group is read in full by staffHolidayChecker.
  OR (${h}.applies_to LIKE 'group:%' AND EXISTS (SELECT 1 FROM person_group_members m JOIN employees e ON e.id = m.employee_id
        WHERE m.group_id = substr(${h}.applies_to, 7) AND e.user_id = ${user})))`
