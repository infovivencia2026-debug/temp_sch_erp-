import type { Router } from '../router'
import { registerChildRemarks } from './teaching/comms'
import { registerPortalFamily } from './portal/family'
import { registerPortalRequests } from './portal/requests'
import { registerPortalSchoolLife } from './portal/school_life'
import { registerPortalLearning } from './portal/learning'
import { registerPortalRecords } from './portal/records'
import { registerPortalLife } from './portal/life'

/* Port of the /portal route group of internal/api/api.go: what parents and
   students use. Every route carries self.profile.read; each handler then
   narrows to the caller's own record or linked children through
   portalChild / familyChildren in teaching/common.ts. */
export function registerPortal(r: Router): void {
  registerPortalFamily(r)
  registerChildRemarks(r)
  registerPortalRequests(r)
  registerPortalSchoolLife(r)
  registerPortalLearning(r)
  registerPortalRecords(r)
  registerPortalLife(r)
}
