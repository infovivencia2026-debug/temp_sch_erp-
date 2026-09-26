import type { Router } from '../../router'
import { registerOpsPurchasing } from './ops_purchasing'
import { registerOpsMDM } from './ops_mdm'
import { registerOpsEvaluation } from './ops_evaluation'
import { registerOpsFeeFilings } from './ops_fee_filings'

/* /admin-ops of internal/api/admin_ops.go: purchasing, the mid-day meal
   return, 360 evaluation and fee regulatory filings. */
export function registerAdminOps(r: Router): void {
  registerOpsPurchasing(r)
  registerOpsMDM(r)
  registerOpsEvaluation(r)
  registerOpsFeeFilings(r)
}
