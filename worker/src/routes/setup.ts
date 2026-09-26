import type { Router } from '../router'
import { registerProfile } from './setup/profile'
import { registerAcademics } from './setup/academics'
import { registerStaff } from './setup/staff'
import { registerImports } from './setup/imports'
import { registerReset } from './setup/reset'

/* The chi group /setup of internal/api/api.go, one file per Go handler
   group. Literal paths are registered before their {id} siblings inside
   each module, as routes/index.ts asks. */
export function registerSetup(r: Router): void {
  registerProfile(r)
  registerAcademics(r)
  registerStaff(r)
  registerImports(r)
  registerReset(r)
}
