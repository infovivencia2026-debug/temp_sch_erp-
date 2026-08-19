import { lazy } from 'react'

/**
 * The daily mid-day meal register.
 *
 * Kept out of registry.ts so this lands without two agents editing one object.
 * Spread into FEATURE_COMPONENTS there; scripts/gen_implemented.py reads
 * registry.ts, so the server only marks the feature live once the spread is in
 * place.
 *
 * The key below was checked against internal/catalog/catalog_gen.go before
 * being written — a key the catalogue does not carry renders the placeholder
 * instead of the screen, silently.
 *
 * Separate from adminOpsKeys, which already carries
 * institution_admin.mid_day_meal.mdm_utilisation_report. Those two are the same
 * subject from opposite ends and deliberately stay two screens: the register is
 * written every afternoon by the clerk, the return is read once a month by the
 * head teacher, and folding them together would put one person's daily work
 * inside a page the other opens twelve times a year.
 */
export const mdmKeys = {
  'institution_admin.mid_day_meal.mid_day_meal_register': lazy(() => import('./MDMRegister')),
}
