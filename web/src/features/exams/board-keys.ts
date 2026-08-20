import { lazy } from 'react'

/* The board examination screens, keyed by catalogue entry.

   Every key below was checked against internal/catalog/catalog_gen.go at the
   head this was written on. A key the catalogue does not carry renders the
   honest "catalogued, not implemented" placeholder instead of the screen, and
   the screen is then unreachable with nothing to say why — an earlier agent
   lost six screens to exactly that, having read a catalogue twelve migrations
   stale.

   Merged into FEATURE_COMPONENTS in web/src/features/registry.ts, which this
   agent does not own; the integration lead splices it in and runs `make
   catalog` so internal/api/implemented_gen.go agrees with it. */
export const boardKeys = {
  'institution_admin.examinations.performance_overview': lazy(
    () => import('./PerformanceOverview'),
  ),
}
