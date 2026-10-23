import type { Router } from '../router'
import { registerStaff } from './hr/staff'
import { registerLifecycle } from './hr/lifecycle'
import { registerStaffConcerns } from './hr/concerns'
import { registerOffice } from './hr/office'
import { registerAttendanceWorkflow } from './hr/attendance'
import { registerStaffTasks } from './hr/tasks'
import { registerStaffRecord } from './hr/staff_record'
import { registerTimeline } from './timeline'

/* The chi groups /hr (with mountHRLifecycle and mountPunchGrace), the
   /hr/leave route registered outside that group, /office, /operations and
   /attendance-workflow. mountHRGrowth is mounted elsewhere in api.go and is
   not part of this block. */
export function registerHR(r: Router): void {
  registerStaff(r)
  registerStaffConcerns(r)
  registerLifecycle(r)
  registerOffice(r)
  registerAttendanceWorkflow(r)
  registerStaffTasks(r)
  registerStaffRecord(r)
  // Student 360's and Staff 360's timelines, one union per subject.
  registerTimeline(r)
}
