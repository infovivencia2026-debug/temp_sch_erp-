import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, useNavigate, useParams } from 'react-router-dom'
import { Check, ChevronDown, LogOut, Menu, Moon, Rows3, Sun, X } from 'lucide-react'
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

/* Icons were removed from navigation.

   Every label carried one, which meant thirty icons down the rail all saying
   "this is a menu item" and none of them distinguishing anything -- the label
   already did that. Icons stay where they aid recognition: the workspace mark,
   the topbar controls, status.  */

/* What the rail actually shows.

   Four rules, in the order they matter. Out of scope is hidden, not dimmed --
   a head of department who heads no department, a guardian with no linked
   child; the permission is real, the workspace is simply empty, and an empty
   workspace is not a menu entry. Optional never appears. Advanced appears on
   request. Unbuilt appears on request. */
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
   fourth level -- and a feature key is a seeded grant and a saved bookmark,
   not just a string. */
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

/* One navigation item, at one of two depths.

   Parent 10px, child 28px. Indentation carries the hierarchy that a connector
   spine used to draw -- the spine made the sidebar read as a file explorer,
   and a file explorer is a thing you browse rather than a place you work. */
function navItem(active: boolean, depth: 0 | 1, dim = false) {
  return cn(
    'relative flex h-[36px] items-center gap-2 rounded-[7px] pr-2 text-[13.5px]',
    'transition-colors duration-100',
    depth === 0 ? 'pl-2.5' : 'pl-7',
    active
      ? 'bg-nav-active font-[550] text-foreground shadow-[var(--lift-panel)]'
      : dim
        // Unbuilt, and only on screen because the roadmap toggle is on. A
        // lighter weight says so without a chip beside every second label.
        ? 'text-muted-foreground/70 hover:bg-surface-hover hover:text-muted-foreground'
        : 'text-secondary-foreground hover:bg-surface-hover hover:text-foreground',
  )
}

/** A 2px mark on the active item. Enough to find at a glance, quiet enough
    not to turn the rail into a column of colour. */
function ActiveMark() {
  return (
    <span
      aria-hidden
      className="absolute left-0 top-1/2 h-[18px] w-[2px] -translate-y-1/2 rounded-full bg-primary"
    />
  )
}

/* Navigation labels optimise for scanning; the page says the full thing.

   "Staff ID Card Printing" is the catalogue's name and belongs on the screen
   it opens. In a column of thirty links, the words that distinguish it are
   "staff ID cards" and everything else is read and discarded. */
const LABEL_TRIM = [
  / Management$/i, / Configuration$/i, / Register$/i, / Generation$/i,
  / Printing$/i, / Tracking$/i, / Entry$/i, / Setup$/i, / Engine$/i,
  /^Staff /i, /^Student /i, /^Annual /i, /^Digital /i, /^Automated /i,
]

function shortLabel(name: string) {
  if (name.length <= 24) return name
  let out = name
  for (const re of LABEL_TRIM) {
    const next = out.replace(re, '')
    if (next.trim().length >= 6) out = next.trim()
    if (out.length <= 24) break
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
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const scopeLine = useScopeLine()
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
      {/* --- one sidebar --------------------------------------------------

          The icon rail is gone. A 56px column of role icons beside a 248px
          column of links is two navigations answering one question, and the
          seam between them fragmented the screen more than the switching was
          worth. Role switching now lives in the sidebar header, where the
          workspace name already was.

          The sidebar sits a shade off the ground rather than white, so it
          separates by tone. A white sidebar beside a white page divided by a
          grey line is three rectangles and a border to read first. */}
      <aside
        className={cn(
          'w-[256px] shrink-0 flex-col bg-sidebar',
          'max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-50 max-lg:w-[280px]',
          'max-lg:border-r max-lg:transition-transform',
          navOpen ? 'flex max-lg:translate-x-0' : 'hidden lg:flex max-lg:-translate-x-full',
        )}
      >
        {/* --- workspace header: where am I, and whose -------------------- */}
        <div className="relative shrink-0 px-3 pb-2 pt-3">
          <button
            onClick={() => setSwitcherOpen((v) => !v)}
            aria-expanded={switcherOpen}
            aria-haspopup="menu"
            disabled={catalog.roles.length < 2}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-[7px] px-2 py-2 text-left',
              'transition-colors duration-100',
              catalog.roles.length > 1 && 'hover:bg-surface-hover',
            )}
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[7px] bg-primary text-[13px] font-semibold text-primary-foreground">
              {session.institution?.short_name?.[0] ?? 'E'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1">
                <span className="truncate text-[14px] font-semibold">
                  {role?.name ?? 'Workspace'}
                </span>
                {catalog.roles.length > 1 && (
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                      switcherOpen && 'rotate-180',
                    )}
                  />
                )}
              </span>
              <span className="block truncate text-[12px] text-muted-foreground">
                {session.institution?.name ?? 'EDU CLOUD'}
              </span>
            </span>
          </button>

          {switcherOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setSwitcherOpen(false)}
                aria-hidden
              />
              <div
                role="menu"
                className="absolute left-3 right-3 z-50 mt-1 overflow-hidden rounded-[10px] border bg-popover py-1 shadow-[var(--lift-float)]"
              >
                {catalog.roles.map((r) => (
                  <button
                    key={r.key}
                    role="menuitem"
                    onClick={() => {
                      setSwitcherOpen(false)
                      setNavOpen(false)
                      navigate(`/${r.key}`)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-2 text-left text-[13.5px]',
                      'transition-colors duration-100',
                      r.key === role?.key
                        ? 'bg-nav-active font-[550] text-foreground shadow-[var(--lift-panel)]'
                        : 'text-secondary-foreground hover:bg-surface-hover hover:text-foreground',
                    )}
                  >
                    <span className="truncate">{r.name}</span>
                    {r.key === role?.key && <Check className="ml-auto h-3.5 w-3.5 shrink-0" />}
                  </button>
                ))}
              </div>
            </>
          )}

          <button
            className="absolute right-4 top-5 lg:hidden"
            onClick={() => setNavOpen(false)}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* --- navigation: indentation, not a tree ------------------------ */}
        <nav aria-label="Sections" className="flex-1 overflow-y-auto px-3 pb-3">
          {workspacesFor(role, showPlanned, showAdvanced).map((ws) => {
            const open =
              ws.sections.some((sec) => sec.slug === activeSection?.slug) || opened.has(ws.slug)
            const count = ws.sections.reduce(
              (n, sec) => n + visibleFeatures(sec, showPlanned, showAdvanced).length,
              0,
            )

            /* A workspace holding one item is a link, not a drawer. Making
               somebody expand a section to reach the single thing inside it is
               the tree-explorer feel in miniature. */
            const onlyItem =
              ws.sections.length === 1 && count === 1
                ? visibleFeatures(ws.sections[0], showPlanned, showAdvanced)[0]
                : null

            if (onlyItem && role) {
              return (
                <NavLink
                  key={ws.slug}
                  to={featurePath(role.key, ws.sections[0].slug, onlyItem.slug)}
                  onClick={() => setNavOpen(false)}
                  className={({ isActive }) => navItem(isActive, 0, !onlyItem.live)}
                >
                  {({ isActive }) => (
                    <>
                      {isActive && <ActiveMark />}
                      <span className="truncate">{ws.name}</span>
                    </>
                  )}
                </NavLink>
              )
            }

            return (
              <div key={ws.slug} className="mb-0.5">
                <button
                  aria-expanded={open}
                  onClick={() => toggleSection(ws.slug)}
                  className={cn(
                    'flex h-[37px] w-full items-center gap-2 rounded-[7px] pl-2.5 pr-2 text-left',
                    'text-[13.5px] transition-colors duration-100',
                    open
                      ? 'font-[550] text-foreground'
                      : 'text-secondary-foreground hover:bg-surface-hover hover:text-foreground',
                  )}
                >
                  <span className="truncate">{ws.name}</span>
                  {!open && count > 0 && (
                    <span className="ml-auto shrink-0 text-[12px] tabular-nums text-muted-foreground/70">
                      {count}
                    </span>
                  )}
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                      open ? 'ml-auto rotate-180' : '',
                    )}
                  />
                </button>

                {open && (
                  <div className="pb-1">
                    {ws.sections.map((section) => {
                      const items = visibleFeatures(section, showPlanned, showAdvanced)
                      if (!items.length) return null
                      /* A group heading only where it separates something. One
                         group inside a workspace needs no label over it. */
                      const labelled = ws.sections.length > 1
                      return (
                        <div key={section.slug} className={labelled ? 'mt-2 first:mt-1' : undefined}>
                          {labelled && (
                            <p className="px-2.5 pb-0.5 pt-1 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground/75">
                              {section.name}
                            </p>
                          )}
                          {items.map((f) => (
                            <NavLink
                              key={f.key}
                              to={featurePath(role!.key, section.slug, f.slug)}
                              onClick={() => setNavOpen(false)}
                              title={f.summary}
                              className={({ isActive }) => navItem(isActive, 1, !f.live)}
                            >
                              {({ isActive }) => (
                                <>
                                  {isActive && <ActiveMark />}
                                  <span className="truncate">{shortLabel(f.name)}</span>
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

          {/* Depth that exists but is rarely wanted, and depth that does not
              exist yet: two different questions, so two switches. Both live at
              the foot, out of the way of the work. */}
          <div className="mt-3 space-y-0.5 border-t pt-3">
            <button
              onClick={toggleAdvanced}
              className="w-full rounded-[7px] px-2.5 py-1.5 text-left text-[12.5px] text-muted-foreground transition-colors duration-100 hover:bg-surface-hover hover:text-foreground"
            >
              {showAdvanced ? 'Hide advanced tools' : 'Advanced tools'}
            </button>
            <button
              onClick={togglePlanned}
              className="w-full rounded-[7px] px-2.5 py-1.5 text-left text-[12.5px] text-muted-foreground transition-colors duration-100 hover:bg-surface-hover hover:text-foreground"
            >
              {showPlanned ? 'Hide coming later' : 'Coming later'}
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
        {/* A quiet contextual bar, not a toolbar bolted to a box. No bottom
            border: the page beneath it is the same ground colour, and the
            sticky blur already says "this stays". */}
        <header className="chrome sticky top-0 z-30 flex h-[56px] shrink-0 items-center gap-2 px-4 sm:gap-3 sm:px-7">
          <button
            aria-label="Open navigation"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-[7px] transition-colors duration-100 hover:bg-surface-hover lg:hidden"
            onClick={() => setNavOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </button>

          {/* Institution, campus, academic year. A school user has to know
              which of each they are looking at before any number on the page
              means anything, and the sidebar answers "where am I" rather than
              "whose". Plain text, not a bordered dropdown: three chips up here
              would be three more rectangles. */}
          <p className="min-w-0 truncate text-[13.5px]">
            <span className="font-medium">{session.institution?.name ?? 'EDU CLOUD'}</span>
            {scopeLine && <span className="text-muted-foreground"> · {scopeLine}</span>}
          </p>

          <div className="ml-auto flex shrink-0 items-center gap-1">
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
              className="grid h-9 w-9 place-items-center rounded-[7px] text-muted-foreground transition-colors duration-100 hover:bg-surface-hover hover:text-foreground"
            >
              <Rows3 className="h-4 w-4" />
            </button>
            <button
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="grid h-9 w-9 place-items-center rounded-[7px] text-muted-foreground transition-colors duration-100 hover:bg-surface-hover hover:text-foreground"
            >
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <a
              href="/logout"
              aria-label="Sign out"
              className="grid h-9 w-9 place-items-center rounded-[7px] text-muted-foreground transition-colors duration-100 hover:bg-surface-hover hover:text-foreground"
            >
              <LogOut className="h-4 w-4" />
            </a>
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}

/** The caller's resolved boundary, as words rather than a bordered chip. */
function useScopeLine() {
  const { scope } = useCatalog()
  const bits: string[] = []
  if (scope.platform_admin) bits.push('platform')
  else if (scope.all_campuses) bits.push('all campuses')
  else if (scope.campuses) bits.push(`${scope.campuses} campus`)
  if (scope.departments) bits.push(`${scope.departments} dept`)
  if (scope.sections) bits.push(`${scope.sections} sections`)
  if (scope.students) bits.push(`${scope.students} students`)
  return bits.join(' · ')
}
