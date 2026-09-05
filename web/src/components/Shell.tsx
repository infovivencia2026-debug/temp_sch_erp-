import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  Check, ChevronDown, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Rows3, Sun,
  UserRound, X,
} from 'lucide-react'
import {
  useCatalog, useActiveRole, featurePath, allRolesOn, setAllRoles, type ApiSection,
} from '@/lib/catalog'
import Notifications from '@/components/Notifications'
import Outbox from '@/components/Outbox'
import FirstRunTour from './FirstRunTour'
import { CommandSearch } from './CommandSearch'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
/* The layout switch and its routing seam. Both are new files; nothing the
   classic layout renders is changed by their presence, and with the switch
   left on 'classic' BentoOutlet renders its children unchanged.
   See docs/BENTO_UI_CONTRACT.md. */
import { LayoutSwitch } from '@/components/LayoutSwitch'
import { BentoOutlet } from '@/features/bento/BentoOutlet'
import TabStrip from '@/components/TabStrip'
import PaneArea from '@/components/PaneArea'
import { usePanes } from '@/lib/panes'
import { BentoDock } from '@/features/bento/BentoDock'
import { useLayout } from '@/lib/layout'
import { useAppearance, DENSITIES } from '@/lib/appearance'
import { useTheme } from '@/lib/theme'
import { BentoSettings } from '@/features/bento/BentoSettings'
import { markFor, hueFor } from '@/features/bento/BentoLauncher'
import { useViewport } from '@/lib/viewport'

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
/* Chrome type answers the text-size slider, like everything else.

   The slider moves `--font-scale`, which reaches the product through
   `html { font-size }` — and therefore reaches rem, and nothing else. The
   sidebar, the topbar and the workspace names are all written in exact pixels
   on purpose (a nav label is chrome; it should not reflow when a table decides
   it wants larger figures), so the one place in the product somebody looks
   first was the one place the setting did nothing.

   calc against the same variable rather than a switch to rem: the sizes stay
   the considered values they are, and they move when asked. */
function navItem(active: boolean, depth: 0 | 1, dim = false) {
  return cn(
    // The row grows with its type, or larger text is set in a 36px box and
    // clipped by it. min-height rather than height for the same reason: a
    // two-line label at 116% has to be allowed to be two lines.
    'relative flex min-h-[calc(36px*var(--font-scale,1))] items-center gap-2 rounded-[7px] pr-2',
    /* THE SAME SIZE AS THE PAGE IT NAVIGATES.

       13.5 against a 14px body is not a hierarchy, it is a half-pixel nobody
       chose: the sidebar simply read as slightly squinted next to the screen
       beside it, and at the default scale on a wide monitor the names of the
       school's own sections were the smallest ordinary text in the product.

       A navigation item is a destination, not a caption. It carries the same
       weight as the words it takes you to. */
    'py-1 text-[calc(14px*var(--font-scale,1))]',
    'transition-colors',
    depth === 0 ? 'pl-2.5' : 'pl-7',
    /* A NAV ITEM IS TEXT UNTIL IT IS POINTED AT.

       The active item was a filled white card with a shadow — a raised button
       sitting in a column of plain words, which is more emphasis than "you are
       here" needs and enough to make the item beside it look disabled by
       comparison. The mark at the left edge and a half-step of weight say the
       same thing without lifting anything off the page.

       Hover is where the surface appears, and only there: a wash and a
       darkening of the ink, so pointing at a row shows it can be pressed. That
       is the whole button — it is drawn by the cursor and put away after. */
    active
      ? 'font-[560] text-foreground hover:bg-surface-hover'
      : dim
        // Unbuilt, and only on screen because the roadmap toggle is on. A
        // lighter weight says so without a chip beside every second label.
        ? 'text-muted-foreground/70 hover:bg-surface-hover hover:text-secondary-foreground'
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

export function Shell({
  children,
  renderAt,
}: {
  children: ReactNode
  /** Renders the router at an arbitrary path, for a split work area. Optional
      so the shell still stands up in a test that only wants the chrome. */
  renderAt?: (path: string) => ReactNode
}) {
  const catalog = useCatalog()
  const session = useSession()
  const role = useActiveRole()
  /* Whether this person may look into every office in the building. Held by
     the principal, and the reason the workspace menu opens for somebody with a
     single workspace. */
  const canSeeEveryRole =
    allRolesOn() || catalog.roles.some((r) => r.key === 'institution_admin')
  const { paths } = usePanes()
  // A split work area scrolls per pane, so the shell's own scroller has to
  // stand down — two bars for one gesture move the wrong thing.
  const split = paths.length > 1
  const navigate = useNavigate()
  const location = useLocation()
  const { sectionSlug } = useParams()
  const [navOpen, setNavOpen] = useState(false)
  /* Which of the three device shapes this is. The one place in the shell that
     asks; every other responsive decision here is a Tailwind variant keyed to
     the same two numbers. */
  const viewport = useViewport()
  const asideRef = useRef<HTMLElement>(null)
  /* Where focus goes back to when the drawer closes. Held in a ref rather than
     read from document.activeElement at close time, because by then focus is
     inside the drawer that is about to be removed. */
  const openerRef = useRef<HTMLButtonElement>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const scopeLine = useScopeLine()
  const { resolved, setTheme } = useTheme()
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
  /* Unbuilt features are never listed.

     There used to be a "Coming later" switch at the foot of the rail that
     revealed catalogued-but-unwritten screens. It answered a question the team
     has and a school does not: a principal does not want to be shown the
     things they cannot use, and every one of them opens onto a placeholder.
     The catalogue still records them and DEFERRED.md still explains them —
     that is where the answer belongs. */
  const showPlanned = false

  /* Advanced tools are off by default and remembered once revealed.

     An accountant who has found the Tally export has found it for good; a
     class teacher who never opens the ICSE gradebook variant never sees it.
     Same storage pattern as the roadmap toggle, deliberately: one habit to
     learn, not two. */
  const [showAdvanced] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('erp.showAdvanced') ?? 'false') as boolean
    } catch {
      return false
    }
  })
  /* One section open at a time, by default.

     Every section expanded at once is the same problem as listing unbuilt
     features: a wall to read rather than a menu to use. The section you are in
     opens; the rest stay shut until you click them, and then they stay open
     because you asked. */
  /* Whether the rail is put away, remembered per device.

     A preference about how much of the screen this person wants given to
     navigation, on the machine they are sitting at — not an account setting.
     Somebody working on a laptop and a desk monitor wants different answers on
     each, and syncing it would make the small screen dictate to the large one.

     Read synchronously on first render so a reload does not show the rail for
     a frame and then snatch it away. */
  const [railHidden, setRailHidden] = useState(() => {
    try {
      return localStorage.getItem('erp.rail') === 'hidden'
    } catch {
      return false
    }
  })
  const toggleRail = (hidden: boolean) => {
    setRailHidden(hidden)
    try {
      localStorage.setItem('erp.rail', hidden ? 'hidden' : 'shown')
    } catch {
      /* private browsing: the choice lasts the session, which is enough */
    }
  }

  /* Which workspace the rail has selected.

     Undefined means "follow the page", which is the resting state: open a fee
     screen from the palette and the rail moves to Finance without being told.
     It only holds a value once somebody clicks the rail, so browsing the rail
     and navigating by other means do not fight each other. */
  const [railPick, setRailPick] = useState<string | undefined>(undefined)
  /* Row height, for people who live in the tables.

     index.css has carried a --row-py dial keyed off data-density since the
     first commit and nothing ever set the attribute, so the feature existed
     and could not be reached. A clerk working a 400-row ledger all day wants
     more rows on screen; a head of school glancing at a dashboard does not.

     ONE SOURCE FOR THIS SETTING, not two that disagree. This kept its own
     useState, read `erp.density` from localStorage RAW, and stamped
     data-density itself. web/src/lib/appearance.ts writes the same key as JSON
     -- "compact", quote characters included -- and stamps the parsed value. So
     once anybody touched the appearance screen this component read the quoted
     string back and stamped data-density WITH the quotes in it, matching no
     selector in either stylesheet: the setting silently stopped working, and
     index.html's boot script (which does parse) was overwritten a moment later
     by this effect.

     It reads the appearance module now, which owns the key, the parsing and
     the attribute. The cycle walks DENSITIES, so this button and the
     appearance screen offer the same five steps -- it used to cycle through a
     'spacious' the module's own list did not contain. */
  const { appearance, set } = useAppearance()
  const density = appearance.density
  const cycleDensity = () => {
    const i = DENSITIES.indexOf(density)
    set('density', DENSITIES[(i + 1) % DENSITIES.length])
  }

  /* The rail's workspaces, and the one on screen.

     Selection follows the page unless the rail has been clicked, so opening a
     fee screen from the command palette moves the rail to Finance by itself.
     A rail that only ever followed clicks would sit on Home while somebody
     worked in Operations all afternoon. */
  const railWorkspaces = workspacesFor(role, showPlanned, showAdvanced)

  const activeWs =
    railWorkspaces.find((w) => w.slug === railPick) ??
    railWorkspaces.find((w) =>
      w.sections.some((sec) => sec.slug === sectionSlug),
    ) ??
    railWorkspaces[0]

  /* Through the shared store, not straight at the DOM.

     This used to toggle the class and write localStorage itself, which made
     it a second writer beside the appearance screen — and a lossy one, since
     it could only ever say light or dark and so quietly destroyed a "system"
     choice, without ever telling the account row. It now goes through
     lib/theme, so the header, the appearance screen and the Bento dock are
     the same preference seen from three places. */
  const toggleTheme = () => {
    const next = resolved === 'dark' ? 'light' : 'dark'
    setDark(next === 'dark')
    setTheme(next)
  }

  /* THERE IS NO SUCH THING AS A BENTO ROLE, AND THERE SHOULD NEVER HAVE BEEN.

     A const here read `role?.key === 'faculty' || role?.key === 'parent'` and
     hid the sidebar, the hamburger and the show-navigation button for those
     two roles and nobody else. It was written when faculty and parent were the
     only two roles with a Bento home board, and it was already stale by the
     time finance, the principal, student and admissions got one -- a hardcoded
     list of two that nothing regenerates.

     What it produced was a product that behaved differently for two of
     thirteen roles for a reason no user could see or fix. A teacher who chose
     the Sidebar layout got no sidebar, and no hamburger to open one with,
     which is not a layout preference being applied -- it is a preference being
     ignored. There was no way back to navigation from inside those roles
     except by knowing the URL.

     Chrome is decided by the layout preference, for everybody. `chromeless`
     below is that preference and it is the only thing that hides the sidebar
     now. Which SCREEN a role lands on is a separate question, answered by
     bento-registry.ts, and it was never the same question as whether that role
     is allowed a menu. */

  /* Bento is a full-bleed canvas: no sidebar, no header. A grid laid out to be
     read edge to edge with a 256px rail beside it and a 56px strip above it is
     neither one layout nor the other.

     Everything the header carried — the switch, sign-out, notifications — goes
     with it, which is why BentoEscape exists and why it renders before this is
     allowed to hide anything. */
  const { layout } = useLayout()
  const chromeless = layout === 'bento'

  /* THE DRAWER, AND ONLY WHEN IT IS ACTUALLY A DRAWER.

     The same <aside> is three things across the width range, and only one of
     them is a modal layer over the page. Everything below hangs off this one
     condition so that a tablet's rail and a desktop's sidebar never acquire a
     scroll lock, a focus trap or an Escape handler — all three of which would
     be actively wrong on navigation that sits beside the content rather than
     over it. */
  const phoneDrawer = viewport === 'phone' && navOpen && !chromeless

  /* The page behind a modal layer does not scroll.

     Without this a swipe over the scrim scrolls the content underneath — on
     iOS it also drags the whole document and leaves the drawer floating over a
     half-scrolled page — which is the difference between a drawer and a panel
     that happens to be drawn on top. */
  useEffect(() => {
    if (!phoneDrawer) return
    document.body.setAttribute('data-scroll-lock', '')
    return () => document.body.removeAttribute('data-scroll-lock')
  }, [phoneDrawer])

  /* Escape closes it, and Tab cannot leave it.

     A dialog that a keyboard can tab out of is a dialog that hides the page
     behind it from the eye and not from the focus ring: the next Tab lands on
     something under the scrim that cannot be seen and cannot be clicked. The
     trap is the two-line kind — wrap at each end — rather than an inert
     polyfill, because the drawer's contents are ordinary links and the only
     thing wrong with the rest of the document is that it is behind a scrim. */
  useEffect(() => {
    if (!phoneDrawer) return
    const el = asideRef.current
    if (!el) return
    const opener = openerRef.current
    const focusable = () =>
      Array.from(
        el.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((n) => n.offsetParent !== null)

    // After paint: the drawer is mid-transition and a hidden element cannot
    // take focus.
    const id = requestAnimationFrame(() => focusable()[0]?.focus())

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setNavOpen(false)
        return
      }
      if (e.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(id)
      document.removeEventListener('keydown', onKey)
      /* Back to the button that opened it, which is where the eye and the
         focus ring both were. Guarded on the opener still being in the
         document, because this also runs when the shell unmounts. */
      if (opener?.isConnected) opener.focus()
    }
  }, [phoneDrawer])

  /* Navigating closes it.

     The three inline `setNavOpen(false)` calls on the nav links stay where
     they are and are not redundant with this: tapping the screen you are
     already on does not change the pathname, so only the handler closes that
     one. This catches everything that moves the router WITHOUT a tap on a
     link — the command palette, a redirect, the back button — which used to
     leave the drawer standing open over the screen it had just opened. */
  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname])

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
      {/* THREE SHAPES, NOT ONE, AND THE MIDDLE ONE IS THE POINT.

          There was a single breakpoint here — `lg`, at 1024 — so everything
          below it was a phone. A 820px tablet got a 300px modal drawer over
          520px of dimmed content, reached by a hamburger, which is the phone
          treatment on a device with room for navigation to simply be there.
          768 to 1023 was the gap.

          Phone (below md): the off-canvas drawer, which is the convention and
          was already right; it is 288px rather than 300px so that a strip of
          the page behind stays visible and the drawer reads as covering the
          page rather than as replacing it.

          Tablet (md to lg): the collapsed icon rail. The 58px rail this
          sidebar already draws stays in flow, permanently, and the label panel
          beside it is simply not drawn. No hamburger, no scrim, nothing to
          open — a tablet has 58px to spare and the marks are the navigation
          the rail was built to be.

          Desktop (lg and up): both panes, exactly as before, including the
          hide control and its remembered `erp.rail`.

          Every width is stated by a variant rather than one being the base,
          because three widths on one property is precisely the case where
          "which of these two utilities did Tailwind emit last" stops being a
          question worth having an answer to. */}
      <aside
        id="shell-nav"
        ref={asideRef}
        data-paint="sidebar"
        /* A drawer over the page is a dialog; a rail in the page is not.

           Only while it is actually the phone drawer, because announcing
           aria-modal on a rail that sits beside the content is a lie that
           costs a screen-reader user the rest of the page. */
        role={phoneDrawer ? 'dialog' : undefined}
        aria-modal={phoneDrawer ? true : undefined}
        aria-label={phoneDrawer ? 'Navigation' : undefined}
        className={cn(
          'shrink-0 flex-row bg-sidebar',
          'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:w-[288px]',
          'max-md:border-r max-md:transition-transform',
          'md:max-lg:w-[58px] lg:w-[282px]',
          navOpen ? 'flex max-md:translate-x-0' : 'hidden md:flex max-md:-translate-x-full',
          /* Only on lg. Below it the sidebar is either a drawer that is
             already closed by default or a rail that is the whole navigation,
             and hiding either would leave nothing to open. */
          railHidden ? 'lg:!hidden' : '',
          chromeless ? '!hidden' : ''
        )}
      >
        {/* --- the rail: one mark per workspace ---------------------------

            Taken from ui-8 in the reference set. Two panes rather than one
            column: the rail says which part of the school you are in, and the
            panel beside it shows only that part's screens.

            What it replaces is an accordion of nine workspaces, where reaching
            Operations meant scrolling past eight collapsed headings, and
            opening one pushed everything below it down. Here the second pane
            changes and nothing moves.

            Marks carry their domain colour, so the rail, the dock, the board
            and the cards are one colour system rather than four. */}
        {/* overflow-y-auto because on a tablet this column IS the navigation.
            Twelve workspace marks at 40px plus the settings mark come to about
            560px, which a landscape tablet at 768 high does not have once the
            padding is out — and a mark you cannot reach is a workspace that
            does not exist on that device. */}
        {/* The scroll is TABLET-ONLY, and the gate is load-bearing.

            At 768-1023 this column IS the navigation, so it has to scroll when
            a school has more workspaces than fit. Applied at every width, it
            also clipped the desktop rail: the workspace tooltips are
            `.rail-item::after`, absolutely positioned at `left: calc(100% + 8px)`
            so they open to the RIGHT of the 58px column, and per CSS Overflow
            an `overflow-y: auto` with `overflow-x: visible` computes the x axis
            to `auto` as well. That makes the column a clipping scroll container
            on both axes, and z-index does not defeat an ancestor's clip — so
            every workspace mark on desktop lost the only label it has. */}
        <div className="flex w-[58px] shrink-0 flex-col items-center gap-1 border-r py-3
                        md:max-lg:overflow-y-auto">
          {railWorkspaces.map((ws) => {
            const Mark = markFor(ws.name)
            const on = ws.slug === activeWs?.slug
            return (
              <button
                key={ws.slug}
                type="button"
                onClick={() => {
                  setRailPick(ws.slug)
                  /* On a tablet the mark IS the navigation.

                     The panel it normally selects is not drawn at this width,
                     so selecting a workspace and stopping there would leave a
                     column of buttons that visibly do nothing — the rail would
                     be decoration on the one device where it is the whole
                     menu. So it also opens that workspace's first screen,
                     which is what the dock's category marks do for the same
                     reason in the chrome-less layout.

                     Desktop and phone are untouched: there the panel is beside
                     it and changing the panel is the entire job. */
                  if (viewport !== 'tablet' || !role) return
                  for (const sec of ws.sections) {
                    const first = visibleFeatures(sec, showPlanned, showAdvanced)[0]
                    if (first) {
                      navigate(featurePath(role.key, sec.slug, first.slug))
                      return
                    }
                  }
                }}
                aria-label={ws.name}
                aria-current={on ? 'true' : undefined}
                data-tip={ws.name}
                className={cn(
                  'rail-item grid size-10 shrink-0 place-items-center rounded-[10px]',
                  'transition-colors duration-100 focus-visible:outline-none',
                  'focus-visible:ring-2 focus-visible:ring-ring',
                  on ? 'bg-surface-hover' : 'hover:bg-surface-hover',
                )}
              >
                <Mark
                  className="size-[18px]"
                  style={{ color: on ? `var(--dom-${hueFor(ws.name)})` : undefined }}
                  aria-hidden="true"
                />
              </button>
            )
          })}

          <div className="mt-auto" />
          <BentoSettings placement="rail" />
        </div>

        {/* --- the panel: the selected workspace, and nothing else ---------

            Not drawn at tablet width, which is what makes the sidebar a
            collapsed rail there rather than a narrow two-pane sidebar with its
            second pane crushed to nothing. */}
        <div className="flex min-w-0 flex-1 flex-col md:max-lg:hidden">

        {/* --- workspace header: where am I, and whose -------------------- */}
        <div className="relative shrink-0 px-3 pb-2 pt-3">
          {/* Icon only, and only where there is a rail to put away. It sits
              over the switcher's right edge rather than in a row of its own:
              a control for hiding navigation should not itself cost a line of
              navigation. */}
          <button
            type="button"
            onClick={() => toggleRail(true)}
            aria-label="Hide navigation"
            title="Hide navigation"
            className="absolute right-2.5 top-2.5 z-10 hidden h-10 w-10 place-items-center
                       rounded-full text-muted-foreground transition-colors duration-100
                       hover:bg-surface-hover hover:text-foreground
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                       lg:grid"
          >
            <PanelLeftClose className="h-5 w-5" />
          </button>
          <button
            onClick={() => setSwitcherOpen((v) => !v)}
            aria-expanded={switcherOpen}
            aria-haspopup="menu"
            /* Openable for a head holding one role.

               It was disabled below two workspaces — right, when the menu only
               ever listed workspaces somebody already had. The menu now also
               carries "View every role", and a principal holds exactly one
               role, so the one control that reaches every office in the
               building was behind a button that could not be pressed. */
            disabled={catalog.roles.length < 2 && !canSeeEveryRole}
            className={cn(
              /* pr-12 keeps the role name clear of the hide control sitting over
                 this button's right edge. Without it the label truncates at the
                 button's far side and the last characters render underneath it,
                 which reads as a rendering fault rather than a truncation. */
              'flex w-full items-center gap-2.5 rounded-[7px] py-2 pl-2 pr-12 text-left',
              'transition-colors duration-100',
              catalog.roles.length > 1 && 'hover:bg-surface-hover',
            )}
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[7px] bg-primary text-[calc(13px*var(--font-scale,1))] font-semibold text-primary-foreground">
              {session.institution?.short_name?.[0] ?? 'E'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1">
                <span className="truncate text-[calc(14px*var(--font-scale,1))] font-semibold">
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
              <span className="block truncate text-[calc(12px*var(--font-scale,1))] text-muted-foreground">
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
                      'flex w-full items-center gap-2 px-3 py-2 text-left text-[calc(13.5px*var(--font-scale,1))]',
                      'transition-colors',
                      // Same rule as the rail: the check says which one, so
                      // the row does not also have to be a filled card.
                      r.key === role?.key
                        ? 'font-[560] text-foreground hover:bg-surface-hover'
                        : 'text-secondary-foreground hover:bg-surface-hover hover:text-foreground',
                    )}
                  >
                    <span className="truncate">{r.name}</span>
                    {r.key === role?.key && <Check className="ml-auto h-3.5 w-3.5 shrink-0" />}
                  </button>
                ))}
                {/* The head looking at the whole school.

                    A principal already holds every permission this product
                    defines bar the two platform ones, so every screen in the
                    building opens for them — what they had no way to do was
                    REACH one. The fee counter, the library desk and the
                    transport office are somebody else's workspace, and there
                    was no route to them short of borrowing a login.

                    Offered only to somebody holding that role, and off until
                    they ask: thirteen workspaces in this menu is not a day's
                    work, it is an inspection. */}
                {catalog.roles.some((r) => r.key === 'institution_admin') && (
                  <button
                    role="menuitem"
                    onClick={() => setAllRoles(!allRolesOn())}
                    className="mt-1 flex w-full items-center gap-2 border-t px-3 py-2 text-left
                               text-[calc(13.5px*var(--font-scale,1))] text-secondary-foreground
                               transition-colors hover:bg-surface-hover hover:text-foreground"
                  >
                    <span className="truncate">
                      {allRolesOn() ? 'Show only my workspace' : 'View every role'}
                    </span>
                  </button>
                )}
              </div>
            </>
          )}

          {/* md, not lg: at tablet width this panel is not drawn at all, and
              at desktop width there is a drawer to close. */}
          <button
            className="absolute right-4 top-5 md:hidden"
            onClick={() => setNavOpen(false)}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* --- navigation: indentation, not a tree ------------------------ */}
        <nav aria-label="Sections" className="flex-1 overflow-y-auto px-3 pb-3">
          {/* Recent was here, above the workspace.

              It read as part of the menu without being part of it: five
              entries at the top of the rail, in no fixed place, changing
              under somebody who was learning where things live. A menu is
              worth learning precisely because it does not move, and the rail
              is short enough that a habit is one glance down it. */}
          {(activeWs ? [activeWs] : []).map((ws) => {
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
              <div key={ws.slug} className="pb-1 pt-1">
                {ws.sections.map((section) => {
                  const items = visibleFeatures(section, showPlanned, showAdvanced)
                  if (!items.length) return null
                  const labelled = ws.sections.length > 1
                  return (
                    /* GROUPS HAVE TO BE FURTHER APART THAN THEIR OWN ROWS.

                       Most sections here hold one feature, so the rail was
                       Home / Dashboard / Getting started / School setup /
                       Approvals / Approvals — six lines at even spacing, and
                       whether a line was a heading or a destination came down
                       to reading its capitals. The distance now says it before
                       the type does: a group is separated by more than the
                       gap between two items inside one, which is the oldest
                       rule there is for making a list into groups.

                       A hairline above each group but the first, because with
                       one item per group the space alone still leaves the
                       heading closer to the item above it than to its own. */
                    <div
                      key={section.slug}
                      className={labelled ? 'mt-5 border-t border-border/60 pt-3 first:mt-0 first:border-t-0 first:pt-0' : undefined}
                    >
                      {labelled && (
                        /* Smaller and wider-tracked than an item, and short of
                           full weight: a heading is a label for what follows,
                           not a thing to be pressed, and at 11px semibold it
                           was competing with the row under it.

                           Lifted from 10.5 to 11.5 and from 60% to 75%: below
                           that it had stopped being a heading and become
                           decoration, and "GETTING STARTED" is exactly what
                           somebody scans for when they do not yet know where
                           anything is. */
                        <p className="px-2.5 pb-1.5 text-[calc(11.5px*var(--font-scale,1))] font-medium uppercase tracking-[0.09em] text-muted-foreground/75">
                          {section.name}
                        </p>
                      )}
                      {items.map((f) => (
                        <NavLink
                          key={f.key}
                          to={featurePath(role!.key, section.slug, f.slug)}
                          onClick={() => setNavOpen(false)}
                          title={f.summary}
                          className={({ isActive }) => navItem(isActive, 0, !f.live)}
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
            )
          })}

          {/* Settings is not repeated here.

              It was put in the sidebar because the preferences were otherwise
              reachable only from the chrome-less layout's cog — but the rail's
              own cog, a few pixels to the left, opens the same panel. Two
              controls for one thing on one screen reads as two different
              things until somebody presses both. */}
        </nav>
        </div>
      </aside>

      {/* The scrim belongs to the drawer, so it stops where the drawer does.
          A tablet's rail sits in the page and has nothing to dim. */}
      {navOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
      )}

      {/* --- content ------------------------------------------------------ */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* A quiet contextual bar, not a toolbar bolted to a box. No bottom
            border: the page beneath it is the same ground colour, and the
            sticky blur already says "this stays". */}
        {!chromeless && (
        <header data-paint="topbar" className="chrome sticky top-0 z-30 flex h-[56px] shrink-0 items-center gap-2 px-4 sm:gap-3 sm:px-7">
          {/* Gone at md, because from md up the navigation is on the screen.
              A hamburger beside a visible rail asks somebody to open what they
              are already looking at. */}
          <button
            ref={openerRef}
            aria-label="Open navigation"
            aria-expanded={navOpen}
            aria-controls="shell-nav"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-[7px] transition-colors duration-100 hover:bg-surface-hover md:hidden"
            onClick={() => setNavOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </button>

          {/* The way back. Shown only when the rail is away, because a button
              that puts back something already there is a button that does
              nothing — and a hidden rail with no visible way to return it is
              how a person decides the app has lost its menu. */}
          {railHidden && (
            <button
              type="button"
              aria-label="Show navigation"
              title="Show navigation"
              className="hidden h-9 w-9 shrink-0 place-items-center rounded-[7px] text-muted-foreground
                         transition-colors duration-100 hover:bg-surface-hover hover:text-foreground
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                         lg:grid"
              onClick={() => toggleRail(false)}
            >
              <PanelLeftOpen className="h-5 w-5" />
            </button>
          )}

          {/* Institution, campus, academic year. A school user has to know
              which of each they are looking at before any number on the page
              means anything, and the sidebar answers "where am I" rather than
              "whose". Plain text, not a bordered dropdown: three chips up here
              would be three more rectangles. */}
          <p className="min-w-0 truncate text-[calc(13.5px*var(--font-scale,1))]">
            <span className="font-medium">{session.institution?.name ?? 'EDU CLOUD'}</span>
            {scopeLine && <span className="text-muted-foreground"> · {scopeLine}</span>}
          </p>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <CommandSearch />
            <Notifications />
            {/* Cycles compact → comfortable → spacious. One control rather
                than three, because it is a preference set once. */}
            <button
              onClick={cycleDensity}
              title={`Row height: ${density}`}
              aria-label={`Row height: ${density}. Click to change.`}
              className="grid h-9 w-9 place-items-center rounded-[7px] text-muted-foreground transition-colors duration-100 hover:bg-surface-hover hover:text-foreground"
            >
              <Rows3 className="h-4 w-4" />
            </button>
            {/* Classic | Bento, beside the theme control. Added, not moved:
                every control that was here is still here, in the same order,
                with the same classes. */}
            <LayoutSwitch />
            <button
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="grid h-9 w-9 place-items-center rounded-[7px] text-muted-foreground transition-colors duration-100 hover:bg-surface-hover hover:text-foreground"
            >
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            {/* Your own account, beside the way out of it. Reachable from
                every role rather than from a catalogue entry only faculty
                had. */}
            <Link
              to="/account"
              aria-label="Your account"
              title="Your account and password"
              className="grid h-9 w-9 place-items-center rounded-[7px] text-muted-foreground transition-colors duration-100 hover:bg-surface-hover hover:text-foreground"
            >
              <UserRound className="h-4 w-4" />
            </Link>
            <a
              href="/logout"
              aria-label="Sign out"
              className="grid h-9 w-9 place-items-center rounded-[7px] text-muted-foreground transition-colors duration-100 hover:bg-surface-hover hover:text-foreground"
            >
              <LogOut className="h-4 w-4" />
            </a>
          </div>
        </header>
        )}

        {/* Several screens open at once, above the work area and OUTSIDE the
            scroller — a tab strip that scrolls away with the page is a tab strip
            you cannot reach. Desktop only, and it returns null with fewer than
            two tabs: one tab is not a strip, it is a line of chrome restating
            the title. */}
        {/* min-h-0 is load-bearing, not tidying.
        
            A flex item defaults to min-height:auto and refuses to shrink below
            its content. Without it this wrapper grew to the height of the page,
            <main>'s overflow-y-auto never engaged, and the scroll escaped to the
            outer container — so scrolling a long register scrolled the SIDEBAR
            with it. Introduced when this wrapper was added for the tab strip. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TabStrip />
          {/* Split or whole, decided one level in.

              PaneArea renders `children` untouched when nothing is split, so
              the ordinary case has neither an extra scroller nor an extra
              wrapper — and each pane brings its own BentoOutlet, because a
              pane resolves its own path rather than the address bar's. */}
          {/* THE DOCK FLOATS OVER THIS, SO THIS HAS TO END ABOVE IT.

              BentoDock is `fixed` and sits 24px off the bottom, 70px tall, so
              it covers the last ninety-odd pixels of the viewport. This
              scroller is the full height with nothing reserving that space, so
              the end of every page on a phone sat under the dock: the last row
              of a register, the Save button at the foot of a form, the final
              stop on a route. You could scroll to the bottom and still not see
              or tap what was there.

              Reserved rather than repositioned, and read from the dock's own
              tokens so a school that sets a larger dock in Appearance gets a
              larger reserve without a second number to keep in step. The safe
              area is added on top for the phones with a home indicator, which
              eats another 34px on an iPhone.

              AT EVERY WIDTH, not phones and tablets only. This carried
              `lg:pb-0` and the token carried a matching zero above 1024px,
              both written from the belief that the dock returns to the layout
              on a desktop. It does not. BentoDock renders `fixed left-1/2
              bottom-6` with no responsive class that ever puts it back in
              flow, and it was measured floating at 821 to 879 in a 900px
              viewport at 1024, 1280, 1440 and 1920 alike. So the foot of every
              desktop page sat under it: on the setup wizard the line reading
              "Drop a CSV here, or choose a file" was drawn underneath the
              dock. Content sliding under floating chrome is the plainest way
              an interface says it was never checked at that size. */}
          <main
            data-paint="workarea"
            /* Named so the Android shell can find the thing that actually
               scrolls. It asks the WebView otherwise, which reports on the
               document — and the document never moves, because this element
               is what does. See lib/shell-scroll.ts. */
            data-app-scroll=""
            className={cn(
              'min-h-0 min-w-0 flex-1 pb-[var(--dock-reserve,0px)]',
              split ? 'overflow-hidden' : 'overflow-y-auto',
            )}
          >
            {split && renderAt ? (
              <PaneArea renderAt={renderAt}>{children}</PaneArea>
            ) : (
              <BentoOutlet>{children}</BentoOutlet>
            )}
            <BentoDock />
          </main>
          {/* A small corner tab, not a screen. A question is nearly always about
              what is already on screen, so an assistant that covers it makes
              somebody leave the thing they wanted to ask about. Mounted outside
              <main> so it stays put while a long register scrolls. */}
          {/* The assistant is archived: its service is off the server and its code
             stays in components/AssistantTab.tsx for the day it returns. */}
          {/* Mounted here for the same reason as the tab: what is queued was
              queued on a screen the person has usually already left, so it
              cannot live on that screen. */}
          <Outbox />
        </div>
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
