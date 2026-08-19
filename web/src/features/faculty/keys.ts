import { lazy } from 'react'

/* The faculty communication screens, keyed by catalogue entry.

   Keys are the ones internal/catalog carries — faculty.communication.*,
   not faculty.communication.* — because the catalogue is generated from
   docs/edu_features.csv and the SPA's router looks the component up by the key
   it was navigated to. A key invented here would render the honest "catalogued,
   not implemented" placeholder instead of the screen.

   Merged into FEATURE_COMPONENTS in web/src/features/registry.ts, which this
   agent does not own; the integration lead splices it in and runs `make
   catalog` so internal/api/implemented_gen.go agrees with it. */
export const facultyCommsKeys = {
  'faculty.communication.remarks': lazy(() => import('./Remarks')),
  'faculty.communication.communication': lazy(() => import('./Communication')),
}
