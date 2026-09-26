import type { Router } from '../router'
import { registerRecruitment } from './growth/hr_recruit'
import { registerAppraisal } from './growth/hr_appraisal'
import { registerTraining } from './growth/hr_training'
import { registerPeople } from './growth/people'
import { registerRollups } from './growth/rollups'
import { registerReportBuilder } from './growth/report_builder'

/* Port of hr_growth.go (mountHRGrowth), people_search.go and
   person_groups.go (/people), admin_rollups.go (mountAdminRollups) and
   report_builder.go (mountReportBuilder). Literal paths register before
   {id} paths within each module. */
export function registerGrowth(r: Router): void {
  registerAppraisal(r)
  registerTraining(r)
  registerRecruitment(r)
  registerPeople(r)
  registerRollups(r)
  registerReportBuilder(r)
}
