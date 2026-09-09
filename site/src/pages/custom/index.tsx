import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { ViewProps } from './shared'

/**
 * Keys referenced by `custom:` in the module registry.
 *
 * Every view is loaded on demand. Eagerly importing them pulled all five
 * verticals' bespoke pages — and the charting library behind them — into the
 * entry bundle, so the home page paid for screens it can never show. The
 * Suspense boundary lives in ModulePage.
 */
const LOADERS: Record<string, () => Promise<{ default: ComponentType<ViewProps> }>> = {
  // Education used to have a bespoke dashboard page; it now renders through
  // the same ten layouts as every other vertical.
  dashboard: () => import('@/pages/dashboards').then((m) => ({ default: m.IndustryDashboard as ComponentType<ViewProps> })),
  'industry-dashboard': () => import('@/pages/dashboards').then((m) => ({ default: m.IndustryDashboard as ComponentType<ViewProps> })),
  'industry-analytics': () => import('./industry').then((m) => ({ default: m.IndustryAnalytics as ComponentType<ViewProps> })),
  'industry-roles': () => import('./industry').then((m) => ({ default: m.IndustryRoleMatrix as ComponentType<ViewProps> })),
  'report-builder': () => import('./industry').then((m) => ({ default: m.ReportBuilder as ComponentType<ViewProps> })),
  'con-gantt': () => import('./signature').then((m) => ({ default: m.ConstructionGantt as ComponentType<ViewProps> })),
  'log-trip-board': () => import('./signature').then((m) => ({ default: m.TripBoard as ComponentType<ViewProps> })),
  'hc-bed-board': () => import('./signature').then((m) => ({ default: m.BedBoard as ComponentType<ViewProps> })),
  'mfg-oee-board': () => import('./signature').then((m) => ({ default: m.OeeBoard as ComponentType<ViewProps> })),
  'admissions-overview': () => import('./academic').then((m) => ({ default: m.AdmissionsOverview as ComponentType<ViewProps> })),
  'admissions-pipeline': () => import('./academic').then((m) => ({ default: m.AdmissionsPipeline as ComponentType<ViewProps> })),
  'admissions-reports': () => import('./academic').then((m) => ({ default: m.AdmissionsReports as ComponentType<ViewProps> })),
  'students-directory': () => import('./academic').then((m) => ({ default: m.StudentsDirectory as ComponentType<ViewProps> })),
  'academic-calendar': () => import('./academic').then((m) => ({ default: m.AcademicCalendar as ComponentType<ViewProps> })),
  'timetable-grid': () => import('./academic').then((m) => ({ default: m.TimetableGrid as ComponentType<ViewProps> })),
  'attendance-marking': () => import('./academic').then((m) => ({ default: m.AttendanceMarking as ComponentType<ViewProps> })),
  'attendance-reports': () => import('./academic').then((m) => ({ default: m.AttendanceReports as ComponentType<ViewProps> })),
  'marks-entry': () => import('./academic').then((m) => ({ default: m.MarksEntry as ComponentType<ViewProps> })),
  'lms-courses': () => import('./academic').then((m) => ({ default: m.LmsCourses as ComponentType<ViewProps> })),
  'lms-gamification': () => import('./academic').then((m) => ({ default: m.LmsGamification as ComponentType<ViewProps> })),
  'finance-dashboard': () => import('./ops').then((m) => ({ default: m.FinanceDashboard as ComponentType<ViewProps> })),
  'finance-reports': () => import('./ops').then((m) => ({ default: m.FinanceReports as ComponentType<ViewProps> })),
  'generic-reports': () => import('./ops').then((m) => ({ default: m.GenericReports as ComponentType<ViewProps> })),
  'hr-employees': () => import('./ops').then((m) => ({ default: m.HrEmployees as ComponentType<ViewProps> })),
  'ats-pipeline': () => import('./ops').then((m) => ({ default: m.AtsPipeline as ComponentType<ViewProps> })),
  'workload-chart': () => import('./ops').then((m) => ({ default: m.WorkloadChart as ComponentType<ViewProps> })),
  'library-dashboard': () => import('./ops').then((m) => ({ default: m.LibraryDashboard as ComponentType<ViewProps> })),
  'transport-fleet': () => import('./ops').then((m) => ({ default: m.TransportFleet as ComponentType<ViewProps> })),
  'transport-tracking': () => import('./ops').then((m) => ({ default: m.TransportTracking as ComponentType<ViewProps> })),
  'vendor-comparison': () => import('./ops').then((m) => ({ default: m.VendorComparison as ComponentType<ViewProps> })),
  'counselor-calendar': () => import('./ops').then((m) => ({ default: m.CounselorCalendar as ComponentType<ViewProps> })),
  'discipline-analytics': () => import('./ops').then((m) => ({ default: m.DisciplineAnalytics as ComponentType<ViewProps> })),
  'placement-analytics': () => import('./ops').then((m) => ({ default: m.PlacementAnalytics as ComponentType<ViewProps> })),
  'comms-inbox': () => import('./ops').then((m) => ({ default: m.CommsInbox as ComponentType<ViewProps> })),
  analytics: () => import('./system').then((m) => ({ default: m.AnalyticsPage as ComponentType<ViewProps> })),
  'ai-center': () => import('./system').then((m) => ({ default: m.AiCenter as ComponentType<ViewProps> })),
  integrations: () => import('./system').then((m) => ({ default: m.Integrations as ComponentType<ViewProps> })),
  settings: () => import('./system').then((m) => ({ default: m.SettingsPage as ComponentType<ViewProps> })),
  multicampus: () => import('./system').then((m) => ({ default: m.MultiCampus as ComponentType<ViewProps> })),
  'admin-overview': () => import('./system').then((m) => ({ default: m.AdminOverview as ComponentType<ViewProps> })),
  'system-health': () => import('./system').then((m) => ({ default: m.SystemHealth as ComponentType<ViewProps> })),
  'role-matrix': () => import('./system').then((m) => ({ default: m.RoleMatrix as ComponentType<ViewProps> })),
  'form-builder': () => import('./system').then((m) => ({ default: m.FormBuilder as ComponentType<ViewProps> })),
  'report-card': () => import('./k12').then((m) => ({ default: m.ReportCard as ComponentType<ViewProps> })),
  'homework-assign': () => import('./k12').then((m) => ({ default: m.HomeworkAssign as ComponentType<ViewProps> })),
  substitutions: () => import('./k12').then((m) => ({ default: m.Substitutions as ComponentType<ViewProps> })),
  'gate-pass': () => import('./k12').then((m) => ({ default: m.GatePass as ComponentType<ViewProps> })),
  'portal-student': () => import('./portals').then((m) => ({ default: m.StudentPortal as ComponentType<ViewProps> })),
  'portal-parent': () => import('./portals').then((m) => ({ default: m.ParentPortal as ComponentType<ViewProps> })),
  'portal-faculty': () => import('./portals').then((m) => ({ default: m.FacultyPortal as ComponentType<ViewProps> })),
}

export const CUSTOM_VIEWS: Record<string, LazyExoticComponent<ComponentType<ViewProps>>> =
  Object.fromEntries(Object.entries(LOADERS).map(([k, load]) => [k, lazy(load)]))

/**
 * Start fetching a view's chunk before it is needed.
 *
 * Code-splitting moved these off the entry bundle, which is right, but it also
 * meant the first click on a bespoke screen paid for the download — long
 * enough that people clicked twice. Warming on hover and on idle puts the
 * fetch before the intent rather than after it.
 */
const warmed = new Set<string>()
export function preloadCustomView(key?: string) {
  if (!key || warmed.has(key) || !LOADERS[key]) return
  warmed.add(key)
  LOADERS[key]().catch(() => warmed.delete(key))
}

/** Warm every view a set of modules can reach, when the browser is idle. */
export function warmCustomViews(keys: (string | undefined)[]) {
  const run = () => keys.forEach(preloadCustomView)
  const idle = (window as any).requestIdleCallback
  if (typeof idle === 'function') idle(run, { timeout: 2000 })
  else setTimeout(run, 400)
}
