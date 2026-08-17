import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, useNavigate, useParams } from 'react-router-dom'
import {
  Moon, Sun, Rows3, LogOut, Menu, X, ChevronDown, Check,
  LayoutDashboard, Users, GraduationCap, ClipboardCheck, Wallet,
  Briefcase, Building2, Boxes, Megaphone, ShieldCheck, Settings2, HeartPulse,
  BookOpen, Bus, Sparkles, ListChecks, UserCog, School, CalendarDays,
  type LucideIcon,
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
  vice_principal: ClipboardCheck,
  hod: Building2,
  class_teacher: GraduationCap,
  faculty: GraduationCap,
  finance: Wallet,
  admissions: Briefcase,
  hr: UserCog,
  it_admin: Settings2,
  operations: Boxes,
  transport_manager: Bus,
  librarian: BookOpen,
  hostel_warden: Building2,
  student: BookOpen,
  parent: Users,
}

/* Section icons are keyed on the slug, which is shared across roles by design:
   "attendance" means the same thing in a teacher's rail and a vice principal's,
   so it should carry the same mark in both. */
const SECTION_ICONS: Record<string, LucideIcon> = {
  home: LayoutDashboard,
  dashboard: LayoutDashboard,

  // academic
  academics: GraduationCap,
  classes_sections: GraduationCap,
  timetable: CalendarDays,
  attendance: ClipboardCheck,
  attendance_leave: ClipboardCheck,
  teaching: BookOpen,
  homework: BookOpen,
  learning: BookOpen,
  marks_assessment: ClipboardCheck,
  marks_report_cards: ClipboardCheck,
  examinations: ClipboardCheck,
  exams_results: ClipboardCheck,
  my_class: Users,
  my_classes: Users,
  my_department: Building2,
  teachers: UserCog,

  // people and money
  students: Users,
  boarders: Users,
  members: Users,
  staff: UserCog,
  employees: UserCog,
  people: UserCog,
  payroll: Wallet,
  statutory: ListChecks,
  fees: Wallet,
  collections: Wallet,
  student_dues: Wallet,
  fee_structure: Wallet,
  concessions_refunds: Wallet,
  reconciliation: Wallet,
  accounting: Wallet,

  // front office and admissions
  admissions: Briefcase,
  enquiries: Briefcase,
  applications: Briefcase,
  visitor_desk: Briefcase,

  // operations
  transport: Bus,
  fleet: Bus,
  routes: Bus,
  tracking: Bus,
  today: CalendarDays,
  hostel: Building2,
  rooms: Building2,
  daily: ClipboardCheck,
  complaints: Megaphone,
  library: BookOpen,
  catalogue: BookOpen,
  circulation: BookOpen,
  infirmary: HeartPulse,
  stores: Boxes,

  // everything else
  communication: Megaphone,
  parent_communication: Megaphone,
  messages: Megaphone,
  announcements: Megaphone,
  approvals: ListChecks,
  requests: ListChecks,
  reports: ListChecks,
  compliance: ShieldCheck,
  school_life: Sparkles,
  school_culture: Megaphone,
  my_profile: Users,
  profile: Users,

  // platform / vendor consoles, unchanged
  institution_setup: Settings2,
  access_security: ShieldCheck,
  platform_configuration: Settings2,
  platform_setup: Settings2,
  ai_automation: Sparkles,
  school_settings: Settings2,
  integrations: Settings2,
  sessions_devices: ShieldCheck,
  audit_logs: ShieldCheck,
  users: Users,
  roles_permissions: ShieldCheck,
  data: Boxes,
  customers: Briefcase,
  subscriptions_billing: Wallet,
  entitlements: ListChecks,
  usage_health: HeartPulse,
  support: Megaphone,
}

/* What the rail actually shows.

   Depth is not the enemy; undifferentiated depth is. Four rules, in the order
   they matter:

   Out of scope is hidden, not dimmed. A head of department who heads no
   department, a guardian with no linked child. It used to render muted and
   clickable, which is the "disabled menu item" that makes an ERP feel like a
   form you failed to fill in. The permission is real, the workspace is simply
   empty, and an empty workspace is not a menu entry.

   Optional never appears. Gimmicks, hardware integrations and board-specific
   registers stay catalogued and routable; they do not cost a teacher a line of
   sidebar every day.

   Advanced appears on request. Real capability, occasionally reached for —
   Tally export, PF and ESI, the ICSE gradebook variant.

   Unbuilt appears on request, as before. */
function visibleFeatures(section: ApiSection, showPlanned: boolean, showAdvanced: boolean) {
  return section.features.filter(
    (f) =>
      f.in_scope &&
      (f.live || showPlanned) &&
      f.tier !== 'optional' &&
      (f.tier !== 'advanced' || showAdvanced),
  )
}

interface Workspace {
  slug: string
  name: string
  sections: ApiSection[]
}

/* Groups the role's sections into the workspaces the rail lists.

   The server sends a flat list of sections, each labelled with its workspace,
   because nesting them would have meant changing every feature key to carry a
   fourth level — and a feature key is a seeded grant and a saved bookmark, not
   just a string. Order follows the server's, which follows the catalog. */
function workspacesFor(
  role: { sections: ApiSection[] } | undefined,
  showPlanned: boolean,
  showAdvanced: boolean,
): Workspace[] {
  if (!role) return []
  const out: Workspace[] = []
  const index = new Map<string, Workspace>()
  for (const section of role.sections) {
    if (visibleFeatures(section, showPlanned, showAdvanced).length === 0) continue
    const name = section.workspace || section.name
    let ws = index.get(name)
    if (!ws) {
      ws = { slug: slugify(name), name, sections: [] }
      index.set(name, ws)
      out.push(ws)
    }
    ws.sections.push(section)
  }
  return out
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
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

  /* Advanced tools are off by default and remembered once revealed.

     An accountant who has found the Tally export has found it for good; a
     class teacher who never opens the ICSE gradebook variant never sees it.
     Same storage pattern as the roadmap toggle, deliberately: one habit to
     learn, not two. */
  const [showAdvanced, setShowAdvanced] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('erp.showAdvanced') ?? 'false') as boolean
    } catch {
      return false
    }
  })
  const toggleAdvanced = () => {
    setShowAdvanced((v) => {
      try {
        localStorage.setItem('erp.showAdvanced', JSON.stringify(!v))
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
          {/* Workspaces, not sections. A role has six to nine of them, each
              gathering several groups — the depth is still there, it is just
              one level further in. A workspace with nothing visible in it does
              not render at all: a heading that opens onto nothing is the menu
              equivalent of a locked door with a label on it. */}
          {workspacesFor(role, showPlanned, showAdvanced).map((ws) => {
            const SIcon = SECTION_ICONS[ws.slug] ?? LayoutDashboard
            const open =
              ws.sections.some((s) => s.slug === activeSection?.slug) || opened.has(ws.slug)
            const count = ws.sections.reduce(
              (n, s) => n + visibleFeatures(s, showPlanned, showAdvanced).length, 0)
            // A workspace built from one group does not need the group's name
            // repeated inside it.
            /* A workspace built from one group does not need the group's name
               repeated inside it, and a two-item group does not need a lid.
               Anything larger gets a collapsible category, because Operations
               holds sixty features and opening it should not mean reading all
               sixty to find the library. */
            const showGroupLabels = ws.sections.length > 1
            return (
              <div key={ws.slug} className="mb-1">
                <button
                  aria-expanded={open}
                  // Toggles rather than navigates. Browsing what a workspace
                  // contains should not move you off the screen you are on.
                  onClick={() => toggleSection(ws.slug)}
                  className={cn(
                    'flex h-9 w-full items-center gap-2.5 rounded-sm px-2 text-left text-[14px] transition-colors',
                    open
                      ? 'font-medium text-foreground'
                      : 'text-secondary-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <SIcon className="h-[18px] w-[18px] shrink-0" />
                  <span className="truncate">{ws.name}</span>
                  {!open && (
                    <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                      {count}
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
                    {ws.sections.map((section) => {
                      const items = visibleFeatures(section, showPlanned, showAdvanced)
                      const onActive = section.slug === activeSection?.slug
                      /* A category opens if you are in it, if you opened it, or
                         if it is small enough that hiding two links behind a
                         click costs more than it saves. Collapsing a lone
                         category would also mean two clicks to reach anything
                         in a single-group workspace. */
                      const catOpen =
                        !showGroupLabels || onActive || opened.has(ws.slug + '/' + section.slug) ||
                        items.length <= 2
                      return (
                        <div key={section.slug}>
                          {showGroupLabels && (
                            <button
                              aria-expanded={catOpen}
                              onClick={() => toggleSection(ws.slug + '/' + section.slug)}
                              className={cn(
                                'flex w-full items-center gap-1.5 py-1 pl-6 pr-2 text-left',
                                'text-[11px] font-medium uppercase tracking-[0.08em] transition-colors',
                                catOpen
                                  ? 'text-muted-foreground'
                                  : 'text-muted-foreground/80 hover:text-foreground',
                              )}
                            >
                              <span className="truncate">{section.name}</span>
                              {!catOpen && (
                                <span className="tabular-nums normal-case tracking-normal">
                                  {items.length}
                                </span>
                              )}
                              {items.length > 2 && (
                                <ChevronDown
                                  className={cn(
                                    'ml-auto h-3 w-3 shrink-0 transition-transform',
                                    catOpen && 'rotate-180',
                                  )}
                                />
                              )}
                            </button>
                          )}
                          {catOpen &&
                            items.map((f) => (
                      <NavLink
                        key={f.key}
                        to={featurePath(role.key, section.slug, f.slug)}
                        onClick={() => setNavOpen(false)}
                        title={!f.live ? `${f.name} — catalogued, not built yet` : f.summary}
                        className={({ isActive }) =>
                          cn(
                            'relative flex min-h-[32px] items-center gap-3 rounded-sm py-1 pl-6 pr-2 text-[14px] transition-colors',
                            isActive
                              ? 'bg-accent font-medium text-foreground'
                              : 'text-secondary-foreground hover:text-foreground',
                            // Muted, not faded. opacity-45 measured 2.4:1
                            // against the sidebar in dark mode — about half
                            // the 4.5:1 that body text needs to be legible.
                            !f.live && 'text-muted-foreground',
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
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}

          {/* Two controls for the whole rail rather than a link inside every
              section, which is where the roadmap toggle used to be — and was
              therefore missed by anyone whose first section happened to be
              fully built.

              They answer different questions. "Advanced tools" is about depth
              that exists and is rarely needed; the roadmap is about depth that
              does not exist yet. Collapsing them into one switch would have
              made "show me the Tally export" also show forty unbuilt screens. */}
          <div className="mt-2 border-t pt-2">
            <button
              onClick={toggleAdvanced}
              className="w-full rounded-sm px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {showAdvanced ? 'Hide advanced tools' : 'Show advanced tools'}
            </button>
            <button
              onClick={togglePlanned}
              className="w-full rounded-sm px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {showPlanned ? 'Show only what works today' : 'Show the full roadmap'}
            </button>
          </div>
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
