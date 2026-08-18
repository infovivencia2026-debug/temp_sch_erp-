import { lazy } from 'react'

/**
 * The fee engine, keyed by catalogue feature.
 *
 * Kept beside the screens rather than pasted into registry.ts so this module
 * and the three components it names move together. Spread into
 * FEATURE_COMPONENTS there; scripts/gen_implemented.py reads registry.ts, so
 * the server only marks these live once the spread is in place.
 *
 * Every key below was checked against internal/catalog/catalog_gen.go before
 * being written. A key the catalogue does not carry renders the placeholder
 * instead of the screen, silently — the screen is built, wired and simply
 * never appears.
 *
 * Three keys, three components, and they are separate on purpose even though
 * one API prefix serves all of them. Versioning is a decision the person who
 * sets the fee book makes once a term; the fine run is a clerk's monthly job;
 * the receipt series is a compliance setting somebody touches when the auditor
 * asks. Folding them together would put "activate this fee revision" on a page
 * somebody opens to check a receipt number.
 */
export const feeEngineKeys = {
  'finance.fee_structure.fee_structure_versioning': lazy(() => import('./FeeStructureVersions')),
  'finance.student_dues.late_fine_rules_engine': lazy(() => import('./LateFineRules')),
  'finance.collections.gst_compliant_receipt_numbering': lazy(() => import('./ReceiptSeries')),
}
