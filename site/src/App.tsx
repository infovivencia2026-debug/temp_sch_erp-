import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { Topbar } from '@/components/layout/Topbar'
import { BottomBar } from '@/components/layout/BottomBar'
import { Ui9Header } from '@/components/layout/ui9/Header'
import { CommandPalette } from '@/components/layout/CommandPalette'
import { ContextMenu } from '@/components/layout/ContextMenu'
import {
  AuroraShell, HaloDock, HaloModulePanel, MonolithStrip, MosaicLauncher, NexusShell,
  PrismCommandMenu, PrismInspector, PulseShell, ShellMobileNav, TerraceNav,
  VectorChips, VectorStrip,
} from '@/components/layout/shells'
import { EduDrawerProvider, EduMobileNav, EduSidebar, EduTopbar } from '@/components/layout/eduos'
import { ModulePage } from '@/pages/ModulePage'
import { Home } from '@/pages/Home'
import { useApp, UI_MAP, type UiId } from '@/hooks/useAppState'
import { homePathFor, INDUSTRY_MAP } from '@/industries'
import { industryPath } from '@/lib/nav'
import { isSingleIndustry, ONLY_INDUSTRY } from '@/lib/deployment'
import { modulesForRole } from '@/industries'
import { warmCustomViews } from '@/pages/custom'
import { activeModuleMap } from '@/industries'

/**
 * The URL owns the vertical: /construction/projects/boq. The home page sits
 * outside any vertical and is the only route without industry chrome.
 */
export default function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={isSingleIndustry ? <Navigate to={`/${ONLY_INDUSTRY}/dashboard`} replace /> : <Home />}
      />
      <Route path="/:industryId/*" element={<IndustryShell />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

/**
 * A single-page navigation changes the document without moving the browser's
 * focus, so a screen reader says nothing. Naming the new page in a polite live
 * region is what a full page load would have done for free.
 */
function RouteAnnouncer({ label }: { label: string }) {
  return <p className="sr-only" role="status" aria-live="polite">{label}</p>
}

/** The first stop on the keyboard, so the rails can be jumped past. */
function SkipLink() {
  return <a href="#main" className="skip-link">Skip to main content</a>
}

function IndustryShell() {
  const { industryId = '' } = useParams()
  const app = useApp()
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const known = !!INDUSTRY_MAP[industryId]

  // ?ui=ui-2 makes an interface choice shareable — paste a link and the reader
  // sees the shell you saw, not whatever their browser last stored.
  const uiParam = params.get('ui')
  useEffect(() => {
    if (uiParam && UI_MAP[uiParam] && uiParam !== app.ui) app.setUi(uiParam as UiId)
  }, [uiParam])

  // The URL is the source of truth, so a pasted link or a back button lands in
  // the right vertical even when the stored preference says otherwise.
  useEffect(() => {
    if (known && industryId !== app.industryId) app.setIndustry(industryId)
  }, [industryId, known])

  // What this page is, in words, for the announcer and the main landmark.
  const moduleId = pathname.split('/')[2] ?? 'dashboard'
  const pageLabel = `${activeModuleMap()[moduleId]?.label ?? 'Dashboard'} — ${INDUSTRY_MAP[industryId]?.label ?? ''}`.trim()

  // Every route change starts at the top of the page.
  useEffect(() => { document.getElementById('main')?.scrollTo({ top: 0 }) }, [pathname])

  // Once the shell is up, fetch the bespoke views this role can reach so the
  // first click on one is instant rather than a download.
  useEffect(() => {
    if (!known) return
    const mods = modulesForRole(app.role)
    warmCustomViews([
      ...mods.map((m) => m.custom),
      ...mods.flatMap((m) => m.tabs.map((t) => t.custom)),
    ])
  }, [industryId, app.role, known])

  if (!known) return <Navigate to="/" replace />
  // One frame while the registry catches up with the URL; rendering the shell
  // against the previous vertical's modules would flash the wrong navigation.
  if (industryId !== app.industryId) return null

  const home = industryPath(homePathFor(app.role), industryId)
  const shell = app.uiDef.shell

  const routes = (
    <Routes>
      <Route path=":moduleId" element={<ModulePage />} />
      <Route path=":moduleId/:tabId" element={<ModulePage />} />
      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  )

  /* Ten interfaces, three slots. Each shell decides what stands to the left of
     the page, what sits above it, what stands to the right, and what floats
     over it — which is the whole of the structural difference between them. */
  // UI-16 composes its own four zones rather than the shared slots.
  if (shell === 'eduos') {
    return (
      <EduDrawerProvider>
        <div className="app-shell flex h-full" data-shell="eduos">
          <SkipLink />
          <RouteAnnouncer label={pageLabel} />
          <EduSidebar />
          <EduMobileNav />
          <div className="flex min-w-0 flex-1 flex-col">
            <EduTopbar />
            <main id="main" tabIndex={-1} aria-label={pageLabel}
              key={`${industryId}-${app.segment}-${app.ui}`} className="min-w-0 flex-1 overflow-y-auto pb-28">
              <div className="page-shell">{routes}</div>
            </main>
          </div>
          <CommandPalette />
      <ContextMenu />
          <ContextMenu />
        </div>
      </EduDrawerProvider>
    )
  }

  const left = ({
    dock: <NexusShell />,
    strip: <VectorStrip />,
    pulse: <PulseShell />,
  } as Record<string, JSX.Element>)[shell] ?? null

  const above = ({
    mega: <AuroraShell />,
    strip: <VectorChips />,
    prism: <PrismCommandMenu />,
    monolith: <MonolithStrip />,
    terrace: <TerraceNav />,
    mosaic: <MosaicLauncher />,
  } as Record<string, JSX.Element>)[shell] ?? null

  return (
    <div className="app-shell flex h-full" data-shell={shell}>
      <SkipLink />
      <RouteAnnouncer label={pageLabel} />
      {left}
      <ShellMobileNav />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* UI-8 carries its own header: role-aware, and disclosed differently
            at each width rather than shrunk. */}
        {app.ui === 'ui-8' ? <Ui9Header /> : <Topbar />}
        {above}
        <main
          id="main"
          tabIndex={-1}
          aria-label={pageLabel}
          key={`${industryId}-${app.segment}-${app.ui}`}
          className="min-w-0 flex-1 overflow-y-auto pb-28"
        >
          <div className="page-shell">{routes}</div>
        </main>
      </div>
      {/* The halo shell already owns the bottom edge with its dock; two bars
          there sat on top of each other and the dock, being lower, could not
          be hovered or clicked at all. */}
      {shell !== 'halo' && <BottomBar />}
      {shell === 'prism' && <PrismInspector />}
      {shell === 'halo' && <><HaloDock /><HaloModulePanel /></>}
      <CommandPalette />
      <ContextMenu />
    </div>
  )
}
