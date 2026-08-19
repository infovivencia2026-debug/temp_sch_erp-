import { lazy } from 'react'

/**
 * The two reminder-plan screens, keyed by catalogue feature.
 *
 * Both keys were checked against internal/catalog/catalog_gen.go at the head
 * this was written on (lines 592 and 713) and against web/src/catalog.gen.ts
 * (lines 545 and 666). Neither was invented. A key the catalogue does not
 * carry renders the "catalogued, not implemented" placeholder instead of the
 * screen, silently — the screen is built, wired, and never appears.
 *
 * Kept beside the screens rather than pasted into registry.ts so this module
 * and the components it names move together. The integrator splices the import
 * and the `...messageRulesKeys` spread into FEATURE_COMPONENTS there and runs
 * `make catalog`, which is what makes internal/api/implemented_gen.go agree —
 * the server only marks these features live once the spread is in place, so
 * until then implemented_gen.go correctly says they are not.
 *
 * ---------------------------------------------------------------------------
 * Two keys, two screens, one implementation
 *
 * Both lazy imports resolve to a four-line wrapper around ReminderPlans, which
 * is the whole screen. A fee chase and an absence alert are the same machinery
 * twice — the same trigger-rule row, the same dry run, the same reasons for
 * not sending — and building them as two screens would have meant fixing every
 * bug twice and finding out about the second one from a school.
 *
 * They are separate catalogue features rather than one because they are
 * separate jobs: the bursar who sets the fee chase is not the person who
 * decides when a guardian hears their child is missing, and the catalogue
 * scopes them differently (institution vs assigned_classes). The split lives
 * in the navigation and in the `kind` prop; it is not, and must not be
 * mistaken for, access control — both screens' routes are gated on the server
 * by internal/rbac permissions, in mountMessageRules.
 */
export const messageRulesKeys = {
  'finance.student_dues.automated_fee_reminders': lazy(() => import('./FeeReminders')),
}
