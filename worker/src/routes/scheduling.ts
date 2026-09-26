import type { Router } from '../router'
import { registerMaster } from './scheduling/master'
import { registerCover } from './scheduling/cover'
import { registerOptimizer } from './scheduling/optimizer'
import { registerMDM } from './scheduling/mdm'
import { registerTransportOfficeTracking } from './scheduling/office'
import { registerChildBus } from './scheduling/child_bus'

/* Timetable tools, transport tracking and the mid-day meal register. */
export function registerScheduling(r: Router): void {
  registerMaster(r)
  registerCover(r)
  registerOptimizer(r)
  registerMDM(r)
  registerTransportOfficeTracking(r)
  registerChildBus(r)
}
