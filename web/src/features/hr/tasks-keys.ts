import { screen } from '@/lib/screen'

/* Staff tasks and reporting managers: one screen, two doors. HR's shows
   everyone, the report and who answers to whom; a teacher's shows their own
   and their team's. Spread into FEATURE_COMPONENTS in registry.ts. */
export const staffTasksKeys = {
  'hr.tasks.staff_tasks': screen(() => import('./StaffTasks')),
  'faculty.my_profile.my_tasks': screen(() => import('./StaffTasks')),
}
