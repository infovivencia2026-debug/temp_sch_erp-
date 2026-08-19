import { lazy } from 'react'

/**
 * The three collections screens, keyed by catalogue feature.
 *
 * Kept beside the screens rather than pasted into registry.ts so this module
 * and the three components it names move together. Spread into
 * FEATURE_COMPONENTS there; scripts/gen_implemented.py reads registry.ts, so
 * the server only marks these live once the spread is in place.
 *
 * Every key below was checked against internal/catalog/catalog_gen.go before
 * being written — they are lines 701, 702 and 741. A key the catalogue does
 * not carry renders the placeholder instead of the screen, silently: the
 * screen is built, wired, and simply never appears.
 *
 * Three keys, three components. The first two share every table below the word
 * "counter" — a till session, a sale, a receipt number, a cash-up — and it
 * would be tempting to fold them into one screen with a tab. They are not
 * folded, because they are two different people's mornings:
 *
 *   the canteen screen is somebody with a queue of nine-year-olds and twenty
 *   minutes, typing free-hand prices for food that has no product master and
 *   never will, whose whole afternoon is the cash-up at the end;
 *   the store screen is a clerk selling a size 32 shirt off a shelf the
 *   purchase-order module counts, where the price is not theirs to type and
 *   the interesting operation is the return three weeks later.
 *
 * Putting the uniform price list in front of the canteen counter, or asking
 * the store clerk to type a price, is what the split prevents. They share the
 * variance report, which is imported rather than written twice.
 *
 * The third shares nothing with them. Grant-in-aid is government accounting —
 * sanctions per head, tranches from the treasury, expenditure that may not
 * leave its head, and the utilisation certificate the school files. It is in
 * this module because it was built alongside them, not because it belongs
 * with them.
 */
export const collectionsKeys = {
  'finance.collections.pos_canteen_terminal_integration': lazy(
    () => import('./CanteenTerminal'),
  ),
  'finance.collections.school_store_merchandise_sales': lazy(
    () => import('./SchoolStore'),
  ),
  'finance.concessions_refunds.grant_in_aid_accounting': lazy(
    () => import('./GrantInAid'),
  ),
}
