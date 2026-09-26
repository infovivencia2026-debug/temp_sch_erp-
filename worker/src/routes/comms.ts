import type { Router } from '../router'
import { registerClassroomCapture } from './comms/capture'
import { registerClassroomLearning } from './comms/classroom'
import { registerClassroomGrading } from './comms/grading'
import { registerCounselor } from './comms/counselor'
import { registerGrievances } from './comms/grievances'
import { registerShowcase } from './comms/showcase'
import { registerSMSGateway } from './comms/sms_gateway'
import { registerPortalExtra } from './portal/extra'

/* /comms, /classroom and /sms-gateway of internal/api/api.go. */
export function registerComms(r: Router): void {
  registerClassroomCapture(r)
  registerClassroomLearning(r)
  registerClassroomGrading(r)
  registerCounselor(r)
  registerGrievances(r)
  registerShowcase(r)
  registerSMSGateway(r)
  registerPortalExtra(r)
}
