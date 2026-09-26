import type { Router } from '../router'
import { registerDashboards } from './teaching/dashboards'
import { registerFacultyComms } from './teaching/comms'
import { registerClasswork } from './teaching/classwork'
import { registerAssessment } from './teaching/assessment'

/* Port of the /principal, /department and /teaching route groups of
   internal/api/api.go. Group permissions are on each route; nested ones
   (homework.write, marks.write, discipline/announcements, integrations)
   are checked inside the handlers. Scope narrowing lives in
   teaching/common.ts (port of internal/scope). */
export function registerTeaching(r: Router): void {
  registerDashboards(r)
  registerFacultyComms(r)
  registerClasswork(r)
  registerAssessment(r)
}
