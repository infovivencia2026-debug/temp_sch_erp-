import type { Router } from '../router'
import { registerStaff } from './hr/staff'
import { registerLifecycle } from './hr/lifecycle'
import { registerOffice } from './hr/office'
import { registerAttendanceWorkflow } from './hr/attendance'

/* The chi groups /hr (with mountHRLifecycle and mountPunchGrace), the
   /hr/leave route registered outside that group, /office, /operations and
   /attendance-workflow. mountHRGrowth is mounted elsewhere in api.go and is
   not part of this block. */
export function registerHR(r: Router): void {
  registerStaff(r)
  registerLifecycle(r)
  registerOffice(r)
  registerAttendanceWorkflow(r)
}
