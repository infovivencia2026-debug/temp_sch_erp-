import { lazy } from 'react'

/* Timetable operations: the generator, the department's grid, the cover request.

   Three catalogue keys sitting at three different desks — platform AI, the
   head of department, and the faculty member who will be away — and one model
   underneath all three. They ship together because the second and third read
   what the first works on, and building them apart would have meant three
   ideas of what a period is.

   Kept out of registry.ts so this batch can be added without several agents
   editing one map at once. Spread into FEATURE_COMPONENTS there.

   Every key below is one catalog_gen.go already carries. A key the catalogue
   lacks renders the honest placeholder instead of the screen, which is a silent
   way to lose a feature that looks finished from the code. */
export const timetableOpsKeys = {
  'super_admin.ai_automation.automated_timetable_optimizer': lazy(
    () => import('./TimetableOptimizer'),
  ),
  'institution_admin.department.department_timetable': lazy(
    () => import('../hod/DepartmentTimetable'),
  ),
  'faculty.timetable.substitution_request_submission': lazy(
    () => import('../faculty/SubstitutionRequest'),
  ),
}
