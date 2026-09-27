import type { Router } from '../router'
import { registerAdmissionForms } from './admissions/forms'
import { registerAdmissionCampaigns } from './admissions/campaigns'
import { registerAdmissionsFunnel } from './admissions/funnel'
import { registerAdmissionsWorkflow } from './admissions/workflow'
import { registerAdmissionsCRM } from './admissions/crm'

/* The two chi groups /admissions (api.go, mountAdmissionsGrowth) and
   /admissions/workflow. Literal paths are registered before {id} paths within
   each file; the workflow group is registered first so /admissions/workflow/...
   is never read as /admissions/{something}. */
export function registerAdmissions(r: Router): void {
  registerAdmissionsCRM(r)
  registerAdmissionsWorkflow(r)
  registerAdmissionForms(r)
  registerAdmissionCampaigns(r)
  registerAdmissionsFunnel(r)
}
