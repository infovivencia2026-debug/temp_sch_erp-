import { useEffect, useMemo } from 'react'
import { ChevronLeft } from 'lucide-react'
import { Link } from '@/lib/nav'
import { useSearchParams } from 'react-router-dom'
import { useApp, type UiId } from '@/hooks/useAppState'
import { derive } from './data'
import type { LayoutProps } from './types'
import { StandardDashboard } from './standard'
import { EditorialSplit, IntelligenceTriptych, MatrixWall, RadialCommand, SpatialCanvas } from './layoutsA'
import { AdaptiveMosaic, CommandDrawer, EventSpine, FullScreenStage, TerraceStack } from './layoutsB'
import { EducationOS } from './eduos'
import { roleDashboard } from './roleViews'
import { campusSlug, SuperAdminDashboard } from './superAdmin'
import { activeRole } from '@/industries'

/* ---------------------------------------------------------------------------
   Twenty interfaces, two families of dashboard.

   UI-1 to UI-9 hold the page constant and vary the shell, so what you are
   comparing is the navigation model. UI-11 to UI-15 do the reverse: the shell
   steps back and the page skeleton carries the identity — and among those ten
   no two share a skeleton, so even in greyscale they read as different
   products. There is no common KPI row, no shared two-column chart area and
   no page header among them.

   What every layout shares is its input: the same industry config and the
   same derived analytics, which is why five verticals × twenty interfaces
   works without a single per-industry branch.
   --------------------------------------------------------------------------- */

const LAYOUTS: Record<UiId, (p: LayoutProps) => JSX.Element> = {
  /* UI-1 to UI-9 differ by shell, so they share the standard page: hold the
     dashboard constant and the navigation model is what you are comparing. */
  'ui-1': StandardDashboard,
  'ui-2': StandardDashboard,
  'ui-3': StandardDashboard,
  'ui-4': StandardDashboard,
  'ui-5': StandardDashboard,
  'ui-6': StandardDashboard,
  'ui-7': StandardDashboard,
  'ui-8': StandardDashboard,
  'ui-9': StandardDashboard,

  /* UI-11 to UI-15 invert it: a quieter shell, and a page skeleton that is
     the entire identity. No two share one. */
  'ui-10': MatrixWall,             // dense analytical matrix
  'ui-11': IntelligenceTriptych,   // fixed three-pane intelligence
  'ui-12': FullScreenStage,        // single full-screen stage
  'ui-13': TerraceStack,           // horizontal stacked terraces
  'ui-14': EventSpine,             // vertical timeline spine
  'ui-15': AdaptiveMosaic,         // irregular adaptive mosaic

  /* UI-16 is education-only and brings its own shell as well as its page. */
  'ui-16': EducationOS,
}

export function IndustryDashboard() {
  const app = useApp()
  const [params] = useSearchParams()
  const campusFromUrl = params.get('campus')

  // A pasted link should arrive already scoped to the campus it names.
  useEffect(() => {
    if (!campusFromUrl) return
    const match = app.industry.scope.sites.find((s) => campusSlug(s) === campusFromUrl)
    if (match && match !== app.campus) app.setCampus(match)
  }, [campusFromUrl, app.industryId])
  // The config is rewritten for whoever is signed in before any layout sees
  // it, so every interface and every vertical gets per-role dashboards without
  // knowing that roles exist.
  const base = app.industry.dashboard
  const cfg = useMemo(
    () => (base ? roleDashboard(base, activeRole(app.role), app.industry) : undefined),
    [base, app.role, app.industryId],
  )
  const d = useMemo(() => (cfg ? derive(app.industry) : null), [app.industryId])

  /* A group administrator drills down rather than reading an average: six
   * campuses behind one attendance figure hides the campus that is failing.
   * Once a campus is chosen the ordinary dashboard takes over, scoped to it. */
  const campusParam = params.get('campus')
  if (app.role === 'super-admin' && !campusParam) return <SuperAdminDashboard />

  if (!cfg || !d) return null
  const Layout = LAYOUTS[app.ui] ?? StandardDashboard

  // No shared page header: a common masthead would be the one thing all ten
  // still had in common, and the brief is that they should look unrelated even
  // in greyscale. Each layout opens itself and places the actions its own way.
  return (
    <div className="print-area">
      {/* Drilling in has to be reversible, or the directory is a trapdoor. */}
      {app.role === 'super-admin' && campusParam && (
        <div className="flex flex-wrap items-center gap-2 px-6 pt-5 sm:px-10 no-print">
          <Link to="/dashboard"
            className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-colors hover:bg-accent">
            <ChevronLeft className="h-3.5 w-3.5" /> All campuses
          </Link>
          <span className="text-[12.5px] muted">Viewing {app.campus}</span>
        </div>
      )}
      <Layout cfg={cfg} d={d} industry={app.industry} />
    </div>
  )
}
