import { screen } from '@/lib/screen'

/**
 * The month and year close, keyed by catalogue feature.
 *
 * One key: the principal's. Closing a month makes the register, the fee
 * counter, the payslip and the mark sheet read-only across every module at
 * once, so it belongs to the person answerable for the whole school rather
 * than to the accountant's ledger screens, and it is enforced by the
 * settings permission on the server (internal/api/period_close.go).
 */
export const periodCloseKeys = {
  'institution_admin.fees.period_close': screen(() => import('./PeriodClose')),
  // The same office wallet screen the finance role holds; the principal's
  // workspace files it under Finance › Fees too.
  'institution_admin.fees.student_wallets': screen(() => import('./StudentWallets')),
}
