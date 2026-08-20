import { lazy } from 'react'

/* The head of department's workspace.
 *
 * There was an rbac role called "hod" carrying TimetableWrite, LeaveApprove
 * and MarksWrite, and there was no catalogue role to match it. Capabilities
 * without navigation is the same failure as navigation without capabilities,
 * only quieter: the API would have answered every one of these calls, and no
 * screen ever made them, so a head of department signed in to an empty menu
 * and the school concluded the account was broken.
 *
 * Most of what is mapped here already existed and was filed under
 * institution_admin, addressed to a principal who has a whole school to run
 * and no reason to be the person moving one department's Tuesday period.
 * Pointing the HOD's keys at the same components rather than copying them
 * keeps one screen per idea; the rows each role sees are narrowed by
 * internal/scope, which is where a department boundary belongs.
 */
export const hodKeys = {
  // The editable whole-school grid, reached by whoever actually edits it.
  'hod.timetable.class_timetable': lazy(() => import('../academics/MasterTimetable')),
  // Loads, free periods, and the subject requirements the live grid does not
  // meet — the three things you need before moving anybody.
  'hod.timetable.staff_timetable': lazy(() => import('./DepartmentTimetable')),
  'hod.timetable.department_timetable': lazy(() => import('./DepartmentTimetable')),
  /* The approver's board, reached by the person who approves.
   *
   * Cover requests were routed to whoever holds TimetableWrite, which has
   * always included the head of department — and the only screen for acting on
   * one was filed under institution_admin, so in practice they went to the
   * principal's desk. The engine, the free-teacher candidate list and the
   * notification to whoever picks up the period all already existed; what was
   * missing was a door into them from the department. */
  'hod.timetable.substitution_requests': lazy(() => import('../academics/SubstitutionBoard')),
  'hod.academics.faculty_allocation': lazy(() => import('../academics/FacultyAllocation')),
  'hod.academics.language_subject_allocation': lazy(() => import('../faculty/LanguageAllocation')),
  'hod.staff.teacher_remarks': lazy(() => import('../shared/StaffRemarks')),
  'hod.staff.staff_leave_substitute_approval': lazy(() => import('../hr/Leave')),
  'hod.my_profile.profile': lazy(() => import('../shared/Profile')),
}
