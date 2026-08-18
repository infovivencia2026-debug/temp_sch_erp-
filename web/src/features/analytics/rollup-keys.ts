import { lazy } from 'react'

/**
 * The administrative roll-ups, keyed by catalogue feature.
 *
 * Kept beside the screens rather than pasted into registry.ts so this module
 * and the seven components it names move together. Spread into
 * FEATURE_COMPONENTS there; scripts/gen_implemented.py reads registry.ts, so
 * the server only marks these live once the spread is in place.
 *
 * Every key below was checked against internal/catalog/catalog_gen.go before
 * being written. A key the catalogue does not carry renders the placeholder
 * instead of the screen, silently — the screen is built, wired, and simply
 * never appears.
 *
 * One screen per key, unusually for this codebase, because these seven are
 * seven genuinely different questions rather than one subject sliced seven
 * ways. Two are close enough to say why they stayed apart: department
 * academics is the standing picture of a department and department reports is
 * the same departments bounded by a period and laid out to be printed and
 * signed. Merging them would mean one screen that is either undated or
 * un-printable.
 *
 * All seven read from /api/v1/rollups/*, which mountAdminRollups registers.
 * Scope is applied server-side: a head of department opening any of these
 * receives their department, and the CSV they download contains the same rows
 * they were shown — which is why these screens use the feature-local
 * CsvButton rather than ui.tsx's ExportButton, whose targets are unscoped
 * whole-table extracts.
 */
export const rollupKeys = {
  'institution_admin.home.today': lazy(() => import('./Today')),
  'institution_admin.fees.fee_overview': lazy(() => import('./FeeOverview')),
  'institution_admin.department.department_academics': lazy(() => import('./DepartmentAcademics')),
  'institution_admin.analysis.department_reports': lazy(() => import('./DepartmentReports')),
  'institution_admin.analysis.performance_analytics': lazy(() => import('./PerformanceAnalytics')),
  'institution_admin.standard.fee_collection_summaries': lazy(() => import('./CollectionSummaries')),
  'hr.reports.hr_reports': lazy(() => import('./HRReports')),
}
