import { screen } from '@/lib/screen'

/**
 * The custom report builder, keyed by catalogue feature.
 *
 * Kept beside the screen rather than pasted into registry.ts so the two move
 * together. Spread into FEATURE_COMPONENTS there; scripts/gen_implemented.py
 * reads registry.ts, so the server only marks this live once the spread is in
 * place.
 *
 * The key below was checked against internal/catalog/catalog_gen.go before
 * being written. A key the catalogue does not carry renders the placeholder
 * instead of the screen, silently — the screen is built, wired, and never
 * appears.
 *
 * One key, one screen. The builder is deliberately not three screens: picking
 * a subject, choosing columns and running the thing are one task, and
 * splitting them across routes would mean carrying a half-built definition
 * between them.
 *
 * Everything reads from /api/v1/report-builder/*, which mountReportBuilder
 * registers behind admin.reports.read. Scope is applied server-side on every
 * run: a head of department opening a report the principal shared receives
 * their own department, because what is shared is the definition and the rows
 * are resolved for whoever is asking. Nothing on this screen can widen that —
 * which is why the export is a plain link to the same endpoint the screen is
 * already reading, rather than a second, unscoped extract.
 */
export const reportBuilderKeys = {
  'institution_admin.analysis.custom_report_builder': screen(() => import('./ReportBuilder')),
}
