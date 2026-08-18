import { lazy } from 'react'

/**
 * The accounting screens, keyed by catalogue feature.
 *
 * Kept beside the screens rather than pasted into registry.ts so this module
 * and the ten components it names move together. Spread into
 * FEATURE_COMPONENTS there; scripts/gen_implemented.py reads registry.ts, so
 * the server only marks these live once the spread is in place.
 *
 * Every key below was checked against internal/catalog/catalog_gen.go before
 * being written. A key the catalogue does not carry renders the placeholder
 * instead of the screen, silently — the screen is built, wired and simply
 * never appears.
 *
 * Ten keys, ten components. Unusually for this codebase they map one to one,
 * and that is not laziness: each of these is a separate conversation with a
 * separate person. The chart of accounts is set up once by whoever designs the
 * books; the trial balance is read by an auditor; petty cash is a clerk's
 * daily habit; closing the year is a decision a trustee signs. Folding them
 * together would put an irreversible button on a screen somebody opens forty
 * times a day.
 */
export const ledgerKeys = {
  'finance.ledgers.chart_of_accounts_setup': lazy(() => import('./ChartOfAccounts')),
  'finance.ledgers.general_ledger_trial_balance': lazy(() => import('./GeneralLedger')),
  'finance.ledgers.expenses_accounting': lazy(() => import('./Expenses')),
  'finance.ledgers.financial_year_closing': lazy(() => import('./YearClosing')),

  'finance.payables.vendor_management_accounts_payable': lazy(() => import('./Payables')),
  'finance.payables.petty_cash_voucher_management': lazy(() => import('./PettyCash')),

  'finance.assets_budget.fixed_asset_register_depreciation': lazy(() => import('./FixedAssets')),
  'finance.assets_budget.budgeting_variance_analysis': lazy(() => import('./Budgets')),

  'finance.reports.daybook_cashbook_reports': lazy(() => import('./CashBooks')),
  'finance.reports.taxation_audit_reports': lazy(() => import('./TaxAudit')),
}
