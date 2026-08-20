import { lazy } from 'react'

/**
 * Four administrative controls, keyed by catalogue feature.
 *
 * Kept out of registry.ts so this batch lands without four agents editing one
 * object. Spread into FEATURE_COMPONENTS there; scripts/gen_implemented.py
 * reads registry.ts, so the server only marks these live once the spread is in
 * place.
 *
 * Every key below was checked against internal/catalog/catalog_gen.go before
 * being written. A key the catalogue does not carry renders the placeholder
 * instead of the screen, silently.
 *
 * Four keys, four screens, and they stay separate even though one API prefix
 * serves them. The people are different: a store keeper raises requisitions,
 * a head cook's clerk files the meal return, the principal runs the
 * evaluation cycle, and the accountant compiles the fee filing. Folding any
 * two together would put somebody's work on a page they never open.
 */
export const adminOpsKeys = {
  'institution_admin.stores.purchase_order_workflow': lazy(() => import('./PurchaseOrders')),
  'institution_admin.mid_day_meal.mid_day_meal_utilisation': lazy(() => import('./MDMUtilisation')),
  'institution_admin.evaluation.teacher_performance_review_360': lazy(
    () => import('./EvaluationOversight'),
  ),
}
