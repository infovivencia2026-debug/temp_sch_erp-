import { Router } from '../router'
import { withSellerAudit } from '../services/seller_audit'
import { withLifecycleGate } from './seller/lifecycle'
import { registerMisc } from './misc'
import { registerStudents } from './students'
import { registerAcademics } from './academics'
import { registerDaily } from './daily'
import { registerSetup } from './setup'
import { registerTeaching } from './teaching'
import { registerPortal } from './portal'
import { registerFees } from './fees'
import { registerAdmissions } from './admissions'
import { registerHR } from './hr'
import { registerExams } from './exams'
import { registerBoardExams } from './board_exams'
import { registerPayroll } from './payroll'
import { registerStatutory } from './statutory'
import { registerOps } from './ops'
import { registerSeller } from './seller'
import { registerAdmin } from './admin'
import { registerGrowth } from './growth'
import { registerComms } from './comms'
import { registerScheduling } from './scheduling'
import { registerAIWarnings } from './ai/warnings'
import { registerAIImport } from './ai/import'
import { registerAi } from './ai'
import { registerClassStatus } from './comms/class_status' // feature:communication.class_status
import { registerHelpdesk } from './help/helpdesk' // feature:help.helpdesk
import { registerHelpRequests } from './help/requests'
import { registerSupportDesk } from './help/desk'
import { registerTroubleshooters } from './help/troubleshoot'

/* Every ported domain registers here, one module per Go handler group.
   Routes match in registration order, so within a module literal paths
   come before {id} paths. Board exams register before exams so
   /exams/board/* is not swallowed by an /exams/{id} pattern. */
export function buildRouter(): Router {
  // Every seller/platform write is recorded; a read-only (off-boarding) school refuses writes.
  const r = withSellerAudit(withLifecycleGate(new Router()))
  registerMisc(r)
  registerStudents(r)
  registerAcademics(r)
  registerDaily(r)
  registerSetup(r)
  registerTeaching(r)
  registerPortal(r)
  registerFees(r)
  registerAdmissions(r)
  registerHR(r)
  registerBoardExams(r)
  registerExams(r)
  registerPayroll(r)
  registerStatutory(r)
  registerOps(r)
  registerSeller(r)
  registerAdmin(r)
  registerGrowth(r)
  registerComms(r)
  registerScheduling(r)
  registerAIWarnings(r)
  registerAIImport(r)
  registerAi(r)
  registerClassStatus(r) // feature:communication.class_status
  registerHelpRequests(r)
  registerHelpdesk(r) // feature:help.helpdesk
  registerSupportDesk(r)
  registerTroubleshooters(r)
  return r
}
