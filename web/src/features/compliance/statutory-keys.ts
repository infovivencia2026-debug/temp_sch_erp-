import { lazy } from 'react'

/**
 * The statutory filings, keyed by catalogue feature.
 *
 * Every key below was checked against internal/catalog/catalog_gen.go at the
 * head this was written on. A key the catalogue does not carry renders the
 * "catalogued, not implemented" placeholder instead of the screen, silently —
 * the screen is built, wired, and simply never appears.
 *
 * Merged into FEATURE_COMPONENTS in web/src/features/registry.ts, which this
 * agent does not own; the integration lead splices in the import and the
 * `...statutoryKeys` spread and runs `make catalog` so
 * internal/api/implemented_gen.go agrees with it.
 *
 * Five keys, five screens — unusually, none of them share. The sibling keys in
 * these two groups are deliberately absent because they are already bound in
 * registry.ts: udise_return_preparation, apaar_id_register, statutory_registers,
 * udise_data_sync and apaar_id_provisioning all point at compliance/UDISE, and
 * re-declaring any of them here would be a duplicate the spread silently
 * overrides in whichever order the integrator happened to write.
 */
export const statutoryKeys = {
  'institution_admin.statutory_returns.working_days_teaching_hours': lazy(
    () => import('./WorkingDays'),
  ),
  'super_admin.statutory_boards.child_info_portal_sync': lazy(
    () => import('./ChildInfoPortal'),
  ),
}
