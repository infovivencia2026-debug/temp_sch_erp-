import { lazy } from 'react'

/**
 * The finance workspace, keyed by catalogue feature.
 *
 * Forty-five entries became thirteen. Every screen that was reachable before is
 * still reachable — eleven of them now sit behind four entries that name a job
 * rather than a table, and the grouping lives in ./bundles.tsx. What changed is
 * the menu: a cashier looking for the counter no longer picks it out of a list
 * that also offers fee structure versioning and a depreciation register.
 *
 * The keys that used to be here — finance.collections.*, finance.ledgers.*,
 * finance.payables.*, finance.reconciliation.*, finance.assets_budget.*,
 * finance.student_dues.*, finance.fee_structure.*, finance.concessions_refunds.*,
 * finance.export.* — no longer exist in the catalogue, so they are gone from
 * here too. A key the catalogue does not carry renders the placeholder
 * silently: the screen stays built, wired, and never appears.
 *
 * One entry the sheet asked for is deliberately absent. Student smart wallets
 * need a parent to load money from home, which needs a payment gateway this
 * install does not have, and a stored balance a school can neither top up nor
 * refund is worse for a family than no wallet at all. internal/api/collections.go
 * blocks it at the counter for the same reason.
 */
export const financeKeys = {
  'finance.home.dashboard': lazy(() => import('./Dashboard')),

  // Fee collection & setup.
  'finance.fees.take_fee_payment': lazy(() => import('./FeeCounter')),
  'finance.fees.online_fee_portal': lazy(() => import('./Payments')),
  'finance.fees.unpaid_fees_reminders': lazy(() =>
    import('./bundles').then((m) => ({ default: m.UnpaidFees })),
  ),
  'finance.fees.class_transport_fee_setup': lazy(() =>
    import('./bundles').then((m) => ({ default: m.FeeSetup })),
  ),

  // Campus sales & funds.
  'finance.campus_money.cafeteria_store_sales': lazy(() =>
    import('./bundles').then((m) => ({ default: m.CampusSales })),
  ),
  'finance.campus_money.donations_aid': lazy(() =>
    import('./bundles').then((m) => ({ default: m.DonationsAndAid })),
  ),

  // Accounting & expenses.
  'finance.accounts.approve_pay_salaries': lazy(() =>
    import('./bundles').then((m) => ({ default: m.SalaryPayout })),
  ),
  'finance.accounts.vendor_bills_petty_cash': lazy(() =>
    import('./bundles').then((m) => ({ default: m.VendorsAndPettyCash })),
  ),
  'finance.accounts.school_property_budgeting': lazy(() =>
    import('./bundles').then((m) => ({ default: m.PropertyAndBudget })),
  ),

  // Banking & reports.
  'finance.banking_reports.match_bank_records': lazy(() =>
    import('./bundles').then((m) => ({ default: m.MatchBankRecords })),
  ),
  'finance.banking_reports.accounting_tax_reports': lazy(() =>
    import('./bundles').then((m) => ({ default: m.AccountingReports })),
  ),

  'finance.my_profile.my_pay': lazy(() => import('../me/MyPay')),
}
