import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, useNavigate, useParams } from 'react-router-dom'
import {
  Moon, Sun, Rows3, LogOut, Menu, X, ChevronDown, Check,
  LayoutDashboard, Users, GraduationCap, ClipboardCheck, Wallet,
  Briefcase, Building2, Boxes, Megaphone, ShieldCheck, Settings2, HeartPulse,
  BookOpen, Bus, Sparkles, ListChecks, UserCog, School, type LucideIcon,
} from 'lucide-react'
import { useCatalog, useActiveRole, featurePath, type ApiSection } from '@/lib/catalog'
import FirstRunTour from './FirstRunTour'
import { CommandSearch } from './CommandSearch'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'

/* The "pulse" shell: a narrow inverted icon rail, a timeline column whose
   vertical hairline threads the section's features, and the content column
   under a sticky translucent header.

   The rail switches *role*; the timeline switches *feature within a section*.
   Keeping those on two axes is what stops a 419-feature catalog from becoming
   one unusable list. */

const ROLE_ICONS: Record<string, LucideIcon> = {
  super_admin: ShieldCheck,
  institution_admin: School,
  hod: Building2,
  faculty: GraduationCap,
  finance: Wallet,
  admissions: Briefcase,
  hr: UserCog,
  operations: Boxes,
  student: BookOpen,
  parent: Users,
}

const SECTION_ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  institution_setup: Settings2,
  access_security: ShieldCheck,
  platform_configuration: Settings2,
  platform_setup: Settings2,
  ai_automation: Sparkles,
  students_admissions: Users,
  academics: GraduationCap,
  academic_monitoring: ClipboardCheck,
  administration: ListChecks,
  reports: ListChecks,
  school_culture: Megaphone,
  department_workspace: Building2,
  teaching_workspace: GraduationCap,
  student_self_service: BookOpen,
  student_portal: BookOpen,
  parent_self_service: Users,
  parent_mobile_app: Users,
  fee_finance_workspace: Wallet,
  fee_workspace: Wallet,
  finance_workspace: Wallet,
  admissions_workspace: Briefcase,
  front_office: Briefcase,
  hr_workspace: UserCog,
  specialist_workspace: Boxes,
  transport_management: Bus,
  hostel_management: Building2,
  library_management: BookOpen,
  infirmary: HeartPulse,
  inventory_stores: Boxes,
}

export function Shell({ children }: { children: ReactNode }) {
  const catalog = useCatalog()
  const session = useSession()
  const role = useActiveRole()
  const navigate = useNavigate()
  const { sectionSlug } = useParams()
  const [navOpen, setNavOpen] = useState(false)
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  // Most catalogued features have no screen yet. Hiding them by default keeps
  // a role's navigation to what actually works, with one line to reveal the
  // rest — honest without burying the six live items under forty dead ones.
  /* Only what works, unless you ask.

     Listing all 53 catalogued entries put a teacher's fifteen working screens
     among thirty-eight marked "soon" — honest about the roadmap and useless as
     navigation, because finding the thing you came for meant reading past the
     things you cannot use. A menu is for getting somewhere.

     The roadmap is still one click away for anyone evaluating the product
     rather than working in it, and the choice is remembered. */
  const [showPlanned, setShowPlanned] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('erp.showPlanned') ?? 'false') as boolean
    } catch {
      return false
    }
  })
  const togglePlanned = () => {
    setShowPlanned((v) => {
      try {
        localStorage.setItem('erp.showPlanned', JSON.stringify(!v))
      } catch {
        /* private browsing; the default returns next time */
      }
      return !v
    })
  }

  /* One section open at a time, by default.

     Every section expanded at once is the same problem as listing unbuilt
     features: a wall to read rather than a menu to use. The section you are in
     opens; the rest stay shut until you click them, and then they stay open
     because you asked. */
  const [opened, setOpened] = useState<Set<string>>(new Set())
  /* Row height, for people who live in the tables.

     index.css has carried a --row-py dial keyed off data-density since the
     first commit and nothing ever set the attribute, so the feature existed
     and could not be reached. A clerk working a 400-row ledger all day wants
     more rows on screen; a head of school glancing at a dashboard does not.

     Three steps, not a slider: the useful range is small and a slider invites
     fiddling with something that should be set once. */
  const [density, setDensity] = useState(() => {
    try {
      return localStorage.getItem('erp.density') ?? 'comfortable'
    } catch {
      return 'comfortable'
    }
  })
  useEffect(() => {
    document.documentElement.dataset.density = density
    try {
      localStorage.setItem('erp.density', density)
    } catch {
      /* private browsing; the default returns next time */
    }
  }, [density])

  const toggleSection = (slug: string) =>
    setOpened((prev) => {
      const next = new Set(prev)
      next.has(slug) ? next.delete(slug) : next.add(slug)
      return next
    })

  const activeSection: ApiSection | undefined =
    role?.sections.find((s) => s.slug === sectionSlug) ?? role?.sections[0]

  const toggleTheme = () => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('erp.theme', JSON.stringify(next ? 'dark' : 'light'))
  }

  return (
    <div className="flex h-full">
      {/* Shown once per person, over whatever they landed on. */}
      <FirstRunTour />
      {/* --- icon rail: role switcher ------------------------------------ */}
      <aside
        className="hidden w-[56px] shrink-0 flex-col items-center gap-0.5 border-r py-3 lg:flex"
        style={{ background: 'hsl(var(--rail))', color: 'hsl(var(--rail-foreground))' }}
      >
        <div className="mb-3 grid h-8 w-8 place-items-center rounded-sm bg-primary text-[14px] font-semibold text-primary-foreground">
          {session.institution?.short_name?.[0] ?? 'E'}
        </div>
        {catalog.roles.map((r) => {
          const Icon = ROLE_ICONS[r.key] ?? LayoutDashboard
          const active = r.key === role?.key
          return (
            <button
              key={r.key}
              title={r.name}
              aria-label={r.name}
              aria-current={active ? 'page' : undefined}
              onClick={() => navigate(`/${r.key}`)}
              className={cn(
                // Only the active role is filled. Every item looking like a
                // button is what turns a rail into a wall of chrome.
                'grid h-9 w-9 place-items-center rounded-sm transition-colors duration-150',
                active
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <Icon className="h-[18px] w-[18px]" />
            </button>
          )
        })}
      </aside>

      {/* --- timeline: sections + features ------------------------------- */}
      <aside
        className={cn(
          'w-[248px] shrink-0 flex-col border-r bg-card',
          'max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-50 max-lg:w-[280px] max-lg:transition-transform',
          navOpen ? 'flex max-lg:translate-x-0' : 'hidden lg:flex max-lg:-translate-x-full',
        )}
      >
        <div className="flex h-[56px] shrink-0 items-center justify-between border-b px-4">
          <p className="truncate text-[14px] font-semibold">{role?.name ?? 'Workspace'}</p>
          <button className="lg:hidden" onClick={() => setNavOpen(false)} aria-label="Close navigation">
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav aria-label="Sections" className="flex-1 overflow-y-auto px-3 py-3">
          {role?.sections.map((section) => {
            const SIcon = SECTION_ICONS[section.slug] ?? LayoutDashboard
            // The section being viewed, plus any the user has opened.
            const open =
              section.slug === activeSection?.slug || opened.has(section.slug)
            return (
              <div key={section.slug} className="mb-1">
                <button
                  aria-expanded={open}
                  // Toggles rather than navigates. Browsing what a section
                  // contains should not move you off the screen you are on.
                  onClick={() => toggleSection(section.slug)}
                  className={cn(
                    'flex h-9 w-full items-center gap-2.5 rounded-sm px-2 text-left text-[14px] transition-colors',
                    open
                      ? 'font-medium text-foreground'
                      : 'text-secondary-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <SIcon className="h-[18px] w-[18px] shrink-0" />
                  <span className="truncate">{section.name}</span>
                  {!open && (
                    <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                      {section.features.filter((f) => f.live || showPlanned).length}
                    </span>
                  )}
                  <ChevronDown
                    className={cn('ml-auto h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')}
                  />
                </button>

                {/* The timeline spine: one hairline threading the features,
                    with a dot per item. This is the pulse signature. */}
                {open && (
                  <div className="relative mt-0.5 pb-2">
                    <span className="absolute bottom-2 left-[9px] top-0 w-px bg-border" />
                    {section.features.filter((f) => f.live || showPlanned).map((f) => (
                      <NavLink
                        key={f.key}
                        to={featurePath(role.key, section.slug, f.slug)}
                        onClick={() => setNavOpen(false)}
                        title={
                          !f.live
                            ? `${f.name} — catalogued, not built yet`
                            : f.in_scope
                              ? f.summary
                              : `${f.name} — no data in your scope`
                        }
                        className={({ isActive }) =>
                          cn(
                            'relative flex min-h-[32px] items-center gap-3 rounded-sm py-1 pl-6 pr-2 text-[14px] transition-colors',
                            isActive
                              ? 'bg-accent font-medium text-foreground'
                              : 'text-secondary-foreground hover:text-foreground',
                            // Muted, not faded. opacity-45 measured 2.4:1
                            // against the sidebar in dark mode — about half
                            // the 4.5:1 that body text needs to be legible.
                            (!f.in_scope || !f.live) && 'text-muted-foreground',
                          )
                        }
                      >
                        {({ isActive }) => (
                          <>
                            <span
                              className={cn(
                                'absolute left-[6px] h-1.5 w-1.5 rounded-full transition-colors',
                                isActive
                                  ? 'bg-primary'
                                  : f.live
                                    ? 'bg-muted-foreground/40'
                                    : 'border border-border bg-card',
                              )}
                            />
                            <span className="truncate">{f.name}</span>
                            {!f.live && (
                              <span className="ml-auto shrink-0 rounded-sm border px-1 text-[11px] leading-4 text-muted-foreground">
                                soon
                              </span>
                            )}
                          </>
                        )}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          {/* One control for the whole rail rather than a link inside every
              section, which is where it used to be — and was therefore missed
              by anyone whose first section happened to be fully built. */}
          <button
            onClick={togglePlanned}
            className="mt-2 w-full rounded-sm px-2 py-2 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {showPlanned ? 'Show only what works today' : 'Show the full roadmap'}
          </button>
        </nav>
      </aside>

      {navOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
      )}

      {/* --- content ------------------------------------------------------ */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="chrome sticky top-0 z-30 flex h-[56px] shrink-0 items-center gap-2 border-b px-3 sm:gap-3 sm:px-5">
          <button
            aria-label="Open navigation"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-sm hover:bg-accent lg:hidden"
            onClick={() => setNavOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </button>

          {/* One line, not a stacked title block: the sidebar already says
              which workspace this is, and a 64px header repeating it is height
              taken from the table below. */}
          <p className="min-w-0 truncate text-[14px] font-medium">
            {session.institution?.name ?? 'EDU CLOUD'}
            {activeSection && (
              <span className="text-muted-foreground"> · {activeSection.name}</span>
            )}
          </p>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <ScopeChip />
            <CommandSearch />
            {/* Cycles compact → comfortable → spacious. One control rather
                than three, because it is a preference set once. */}
            <button
              onClick={() =>
                setDensity((d) =>
                  d === 'compact' ? 'comfortable' : d === 'comfortable' ? 'spacious' : 'compact',
                )
              }
              title={`Row height: ${density}`}
              aria-label={`Row height: ${density}. Click to change.`}
              className="grid h-9 w-9 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Rows3 className="h-4 w-4" />
            </button>
            <button
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="grid h-9 w-9 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <a
              href="/logout"
              aria-label="Sign out"
              className="grid h-9 w-9 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <LogOut className="h-4 w-4" />
            </a>
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="page-shell">{children}</div>
        </main>
      </div>
    </div>
  )
}

/** Shows what the signed-in user's data boundary actually resolved to. */
function ScopeChip() {
  const { scope } = useCatalog()
  const bits: string[] = []
  if (scope.platform_admin) bits.push('platform')
  else if (scope.all_campuses) bits.push('all campuses')
  else if (scope.campuses) bits.push(`${scope.campuses} campus`)
  if (scope.departments) bits.push(`${scope.departments} dept`)
  if (scope.sections) bits.push(`${scope.sections} sections`)
  if (scope.students) bits.push(`${scope.students} students`)
  if (!bits.length) return null

  return (
    <span
      title="Your resolved data scope"
      className="hidden items-center gap-1.5 rounded-sm bg-muted px-2 py-1 text-[12px] text-muted-foreground md:inline-flex"
    >
      <Check className="h-3 w-3" />
      {bits.join(' · ')}
    </span>
  )
}
