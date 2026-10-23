import { screen } from '@/lib/screen'
import { lazy } from 'react'

/**
 * The transport office's front page, its runs screen and its reports.
 *
 * Kept out of registry.ts so this lands without several agents editing one
 * object at once. Spread into FEATURE_COMPONENTS there.
 *
 * The desk and the runs screen share one component file and one endpoint,
 * /ops/transport/runs: they ask the same question at different distances,
 * and two sources would eventually disagree about whether a bus was out.
 */
export const transportDeskKeys = {
  'transport_manager.home.dashboard': lazy(() =>
    import('./TodaysRuns').then((m) => ({ default: m.TransportDashboard })),
  ),
  'transport_manager.transport.todays_runs': screen(() => import('./TodaysRuns')),
  'transport_manager.reports.transport_reports': screen(() => import('./TransportReports')),
}
