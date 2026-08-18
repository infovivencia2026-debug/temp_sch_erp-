import { lazy } from 'react'

/**
 * The banking screens, keyed by catalogue feature.
 *
 * Kept beside the screens rather than pasted into registry.ts so this module
 * and the three components it names move together. Spread into
 * FEATURE_COMPONENTS there; scripts/gen_implemented.py reads registry.ts, so
 * the server only marks these live once the spread is in place.
 *
 * Every key below was checked against internal/catalog/catalog_gen.go before
 * being written — they are lines 751 to 753. A key the catalogue does not
 * carry renders the placeholder instead of the screen, silently: the screen is
 * built, wired, and simply never appears.
 *
 * Three keys, three components, and unusually for this codebase they map one
 * to one. That is not laziness. The three sit in the same catalogue group and
 * share two database tables, but they are three different people's afternoons:
 * the reconciliation is an accountant closing a month against a passbook; the
 * payout queue is a clerk assembling a list that somebody senior then releases;
 * the register is a scholarship clerk typing what a family brought in on a
 * scrap of paper. Folding any two together would put a finalise button, or an
 * account number, on a screen somebody has open all day.
 */
export const bankingKeys = {
  'finance.reconciliation.bank_reconciliation_statement_brs': lazy(
    () => import('./BankReconciliation'),
  ),
  'finance.reconciliation.connected_banking_payouts': lazy(() => import('./BankingPayouts')),
  'finance.reconciliation.student_bank_account_register': lazy(
    () => import('./StudentBankAccounts'),
  ),
}
