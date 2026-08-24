import { lazy } from 'react'

/* The three admissions-growth screens, keyed by catalogue entry.

   Every key below was checked against internal/catalog/catalog_gen.go at the
   commit this was written on. A key the catalogue does not carry renders the
   "catalogued, not implemented" placeholder instead of the screen, and the
   screen is then unreachable with nothing to say why.

   Merged into FEATURE_COMPONENTS in web/src/features/registry.ts, which this
   agent does not own; the integration lead splices it in and runs `make
   catalog` so internal/api/implemented_gen.go agrees with it.

   Two notes for whoever reads these screens and expects more than is there.

   The applicant-facing form is served by the API, not by this bundle:
   GET and POST /api/v1/public/admissions/forms/{slug}, mounted outside the
   authenticated group. What is here is the builder a school designs with and
   the rendered answers the office reads; the page a parent fills in is a
   separate, unauthenticated surface and is validated entirely on the server.

   The campaign runner is a button rather than a schedule. Nothing on this
   deployment flushes the message queue on a timer yet, so the sequences screen
   offers "Send what is due" and says so on its face. The call is idempotent
   and is the same code a scheduler will invoke; it does not start one. */

export const admissionsGrowthKeys = {
  'admissions.reports.lost_lead_reason_analysis': lazy(
    () => import('./LostLeads'),
  ),
}
