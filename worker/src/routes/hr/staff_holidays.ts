/* WHOSE HOLIDAY IS IT (owner, 2026-10-13: "in some schools the holidays are
   different for teaching and other staff").

   A calendar entry's applies_to is 'all', 'students', 'staff', and now
   'teaching' (staff who teach: a faculty or HOD role) or 'non_teaching'
   (every other member of staff). Students never take either of the new two;
   their screens already read only 'all' and 'students'. Everything that
   counts a member of staff's working days asks here, so payroll, loss of
   pay, the attendance sheet and the staff calendar agree on one answer. */

export interface StaffHolidayRow { on_date: string; to_date: string; applies_to: string }

/** Holidays and vacations any member of staff might have off in [from, to]. */
export async function staffHolidayRows(db: D1Database, from: string, to: string): Promise<StaffHolidayRow[]> {
  const r = await db.prepare(`SELECT substr(on_date, 1, 10) AS on_date, substr(COALESCE(to_date, on_date), 1, 10) AS to_date, applies_to FROM holidays
      WHERE kind IN ('holiday','vacation') AND applies_to IN ('all','staff','teaching','non_teaching') AND on_date <= ? AND COALESCE(to_date, on_date) >= ?`)
    .bind(to, from).all<StaffHolidayRow>()
  return r.results
}

/** Users who teach: a faculty or HOD role. */
export async function teachingUsers(db: D1Database): Promise<Set<string>> {
  const r = await db.prepare(`SELECT DISTINCT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.key IN ('faculty','hod')`).all<{ user_id: string }>()
  return new Set(r.results.map((x) => x.user_id))
}

/** Is `day` a holiday for this member of staff? */
export function isStaffHoliday(rows: StaffHolidayRow[], day: string, teaching: boolean): boolean {
  return rows.some((h) => day >= h.on_date && day <= h.to_date && (
    h.applies_to === 'all' || h.applies_to === 'staff' || (h.applies_to === 'teaching' ? teaching : h.applies_to === 'non_teaching' ? !teaching : false)))
}

/** The same rule in SQL, for a holidays row `h` and a user id expression. */
export const staffHolidaySql = (h: string, user: string) => `(${h}.applies_to IN ('all','staff')
  OR (${h}.applies_to = 'teaching' AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ${user} AND r.key IN ('faculty','hod')))
  OR (${h}.applies_to = 'non_teaching' AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ${user} AND r.key IN ('faculty','hod'))))`
