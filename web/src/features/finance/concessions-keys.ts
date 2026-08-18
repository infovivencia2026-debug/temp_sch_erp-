import { lazy } from 'react'

/**
 * The three concessions screens, keyed by catalogue feature.
 *
 * Kept beside the screens rather than pasted into registry.ts so this module
 * and the three components it names move together. Spread into
 * FEATURE_COMPONENTS there; scripts/gen_implemented.py reads registry.ts, so
 * the server only marks these live once the spread is in place.
 *
 * Every key below was checked against internal/catalog/catalog_gen.go before
 * being written — they are lines 738, 739 and 740. A key the catalogue does not
 * carry renders the placeholder instead of the screen, silently: the screen is
 * built, wired, and simply never appears.
 *
 * Three keys, three components. They share a database table — the government
 * scheme registry — and the first two share the word "scholarship", but they
 * are three different people's afternoons and folding any two together would
 * put the wrong thing in front of somebody:
 *
 *   the claim screen is an accountant chasing the state for money the school is
 *   owed, per child, per quarter, some of it two years old;
 *   the scholarship screen is a clerk verifying applications on a portal and
 *   noticing when a child's sanctioned money never arrived — and it is the one
 *   screen in this feature that shows social category, because that is what the
 *   eligibility turns on;
 *   the loan screen is the front office telling a parent which paper is still
 *   missing, and it carries no money of the school's at all.
 *
 * Putting the category column on the claim screen, or the state's claim file
 * behind the clerk's read permission, is exactly the kind of leak the split
 * prevents.
 */
export const concessionsKeys = {
  'finance.concessions_refunds.government_reimbursement_claims': lazy(
    () => import('./GovernmentClaims'),
  ),
  'finance.concessions_refunds.nsp_scholarship_reconciliation': lazy(
    () => import('./ScholarshipReconciliation'),
  ),
  'finance.concessions_refunds.student_loan_assistance_portal': lazy(
    () => import('./LoanAssistance'),
  ),
}
