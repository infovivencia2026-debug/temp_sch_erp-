import { lazy } from 'react'

/**
 * The whole-school master timetable: generate, review, correct, publish.
 *
 * Kept out of registry.ts so this lands without two agents editing one object.
 * Spread into FEATURE_COMPONENTS there; scripts/gen_implemented.py reads
 * registry.ts, so the server only marks the feature live once the spread is in
 * place.
 *
 * The key below was checked against internal/catalog/catalog_gen.go before
 * being written.
 *
 * Distinct from timetableOpsKeys, which carries
 * super_admin.ai_automation.automated_timetable_optimizer — the generator's own
 * screen, one draft at a time, with the requirements and the caps it runs on.
 * This one is the administrator's: every section at once, what publishing will
 * overwrite, and the hand edit. They share the solver, the draft tables and the
 * publish endpoint, and neither reimplements any of it.
 */
export const masterTimetableKeys = {
  'institution_admin.academics.master_timetable': lazy(
    () => import('./MasterTimetable'),
  ),
}
