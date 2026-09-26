import { Router } from '../router'
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

/* Every ported domain registers here, one module per Go handler group.
   Routes match in registration order, so within a module literal paths
   come before {id} paths. Board exams register before exams so
   /exams/board/* is not swallowed by an /exams/{id} pattern. */
export function buildRouter(): Router {
  const r = new Router()
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
  return r
}
