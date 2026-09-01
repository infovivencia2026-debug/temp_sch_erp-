import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Home, GraduationCap, Users, Wallet, BookOpen, MessageSquare, ClipboardList,
  BarChart3, Bus, Settings2, ShieldCheck, CalendarDays, Boxes, Clock, Search,
  CornerDownLeft, House,
  Activity, Banknote, Bot, Building2, CalendarCheck, CircleUser, CreditCard,
  FileCheck2, FileText, FolderTree, Handshake, Inbox, KeyRound, Landmark,
  LibraryBig, LifeBuoy, ListChecks, Presentation, Server, Sparkle,
  Wrench,
} from 'lucide-react'
import { useActiveRole, featurePath, usable } from '@/lib/catalog'
import { useT } from '@/lib/i18n'
import { useRecents } from '@/lib/recents'
import { cn } from '@/lib/utils'

/* Everything the role can open, on one surface, reachable by pointing at it.

   The palette answers "I know what I want"; it shows eight items until you
   type, so it cannot answer "what is there". A principal's job is partly
   noticing things, and a layout that can only be searched has taken that away
   — so this is the sidebar's discovery, without the sidebar.

   It used to be a filing cabinet: sixty-five identical text rows in workspace
   order, correct and complete and no faster on the hundredth visit than the
   first. Three things changed that, and none of them is decoration.

   RECENTS FIRST. Almost nobody uses sixty-five features. A principal opens the
   same four or five every morning, and the only real advantage a library has
   over a menu is that it can notice which.

   ICONS ON THE GROUPS, NOT THE ROWS. A mark per workspace is a landmark you
   navigate by after a week. A mark per feature would be sixty-five glyphs
   invented for concepts that do not have one — "Working Days & Instructional
   Hours" has no icon — and a wall of near-identical shapes is slower to read
   than plain words.

   OPERABLE FROM THE KEYBOARD. It is a launcher. Typing filters, up and down
   walk the results, Enter opens, Escape leaves. A launcher you must aim at
   with a mouse is a menu with extra steps. */

/** Workspace name -> mark. Keyed by the catalogue's own workspace labels
    rather than a new field on the section, because the catalogue is generated
    from a CSV and adding a column to carry an icon name would put a rendering
    decision in a document the product owner edits. Anything unmatched gets the
    neutral mark; a missing icon must never be a missing row. */
const WORKSPACE_ICON: Record<string, typeof Home> = {
  Home,
  Students: GraduationCap,
  Academics: BookOpen,
  Examinations: ClipboardList,
  Finance: Wallet,
  Fees: Wallet,
  Staff: Users,
  Communication: MessageSquare,
  Administration: ShieldCheck,
  Reports: BarChart3,
  Operations: Bus,
  Transport: Bus,
  Timetable: CalendarDays,
  Stores: Boxes,

  /* THE OTHER THIRTY-TWO.

     Everything absent from this map fell through to LayoutGrid — the same
     glyph the "All features" button uses — so 32 of the catalogue's 41
     workspaces drew the identical icon, and My Profile was indistinguishable
     from All features sitting next to it in the dock. A row of identical marks
     is not an icon set; it is decoration that costs a click to disambiguate.

     Each of these is the thing the workspace is ABOUT rather than a shape that
     happened to be free — a reader learns "money is a banknote" once and it
     holds across Accounts, Payroll and Campus Money. */
  Admissions: Handshake,
  'Front Desk': Handshake,
  Assessments: FileCheck2,
  'Attendance & Leave': CalendarCheck,
  Accounts: Landmark,
  'Banking & Reports': Landmark,
  'Campus Money': Banknote,
  Payroll: Banknote,
  'Subscriptions & Billing': CreditCard,
  Entitlements: KeyRound,
  'Access & Security': KeyRound,
  'AI & Automation': Bot,
  Customers: Building2,
  Dashboard: BarChart3,
  'Department Workspace': FolderTree,
  Employees: Users,
  People: Users,
  Library: LibraryBig,
  'My Child': GraduationCap,
  School: Building2,
  'My Classes': Presentation,
  Teaching: Presentation,
  'My Profile': CircleUser,
  Profile: CircleUser,
  'My Work': Inbox,
  Requests: ListChecks,
  'Institution Setup': Wrench,
  'Platform Setup': Server,
  'Platform Configuration': Server,
  Support: LifeBuoy,
  'Usage & Health': Activity,
  Setup: Settings2,

  /* The last two that fell through.

     Every unmapped workspace draws the same fallback, so these two were
     indistinguishable from each other in the rail — and Schools is the
     vendor's own first section, where the whole business lives.

     Schools reuses the building the singular School already uses, because they
     are the same subject seen from the two sides of the product: one school's
     own record, and the vendor's list of all of them. */
  Schools: Building2,
  Documents: FileText,
}

export function markFor(workspace: string) {
  /* The fallback is deliberately NOT LayoutGrid.

     That is the All-features glyph, so anything unmapped used to be a perfect
     copy of the button beside it. A workspace nobody has thought about should
     look unremarkable, not look like something else. */
  return WORKSPACE_ICON[workspace] ?? Sparkle
}

/* Colour by ERP domain, not by launcher category.

   These were the launcher's own eight hues. They are now the product's domain
   palette — attendance is cyan in this list, on its chart, on its chip and in
   a mixed queue — so the launcher stops being the one place colour means
   something and becomes one of the places it is read.

   Nine domains for thirty-nine workspace labels, because the labels are how
   the catalogue files things and the domains are how a school thinks about
   them: Fees, Accounting, Payroll and Subscriptions are four sections of one
   subject, and a reader who has learnt that money is teal should not have to
   learn it four times.

   The tail is hashed over the name rather than left unassigned — a workspace
   nobody thought about still gets a colour and gets the same one every time.
   Over the name and not the position: position is stable right up until the
   catalogue is reordered, and then silently repaints half the library. */
const WORKSPACE_DOMAIN: Record<string, string> = {
  Students: 'students', 'My Child': 'students', School: 'students',
  Admissions: 'admissions',
  Academics: 'academics', Assessments: 'academics', Teaching: 'academics',
  'My Classes': 'academics', Examinations: 'academics', Timetable: 'academics',
  'Attendance & Leave': 'attendance',
  Finance: 'finance', Fees: 'finance', Accounting: 'finance', Payroll: 'finance',
  'Subscriptions & Billing': 'finance',
  Staff: 'staff', Employees: 'staff', People: 'staff', Entitlements: 'staff',
  Communication: 'communication', 'Front Desk': 'communication',
  Requests: 'communication', Support: 'communication',
  Reports: 'reports', 'Usage & Health': 'reports', Dashboard: 'reports',
  Operations: 'operations', Transport: 'operations', Library: 'operations',
  Home: 'operations', 'My Work': 'operations', Administration: 'operations',
  Profile: 'operations', 'Access & Security': 'operations',
  'Institution Setup': 'operations', 'Platform Setup': 'operations',
  'Platform Configuration': 'operations', Customers: 'operations',
  'AI & Automation': 'operations',
}

const DOMAINS = [
  'students', 'academics', 'attendance', 'finance', 'staff',
  'admissions', 'communication', 'operations', 'reports',
]

export function hueFor(workspace: string): string {
  const named = WORKSPACE_DOMAIN[workspace]
  if (named) return named
  let h = 0
  for (let i = 0; i < workspace.length; i++) h = (h * 31 + workspace.charCodeAt(i)) >>> 0
  return DOMAINS[h % DOMAINS.length]
}

/* How much of the board a category takes.

   The list was the honest first version and the wrong shape: every workspace
   got a full-width band whether it held two features or twenty-one, so
   Administration — one feature — occupied as much of the screen as Operations,
   which holds twenty-one. Reading it meant scrolling past the small ones to
   find the large ones.

   Size by content, and let them pack. Tailwind needs whole class names at
   build time, so these are four fixed strings rather than a computed span; a
   template literal here would compile to nothing and every tile would be one
   column wide.

   grid-flow-dense is what makes it a mosaic rather than a ragged column: a
   one-wide tile will back-fill a hole an earlier three-wide tile left beside
   it, so the board closes up instead of leaving steps down the right edge. */
function tileSpan(count: number): string {
  if (count >= 12) return 'sm:col-span-2 lg:col-span-4'
  if (count >= 7) return 'sm:col-span-2 lg:col-span-2 lg:row-span-2'
  if (count >= 4) return 'sm:col-span-2 lg:col-span-2'
  return 'sm:col-span-1 lg:col-span-1'
}

/* A wide tile gets its features in columns. A narrow one must not: two columns
   inside a single grid column is two four-character-wide columns. */
function tileColumns(count: number): string {
  if (count >= 12) return 'sm:grid-cols-2 lg:grid-cols-4'
  if (count >= 4) return 'lg:grid-cols-2'
  return ''
}

interface Row {
  key: string
  name: string
  section: string
  sectionSlug: string
  slug: string
  workspace: string
}

/* Ranked, not merely filtered.

   A substring match puts "Fee Regulatory Committee Filing" above "Fees"
   whenever the alphabet says so, which is the behaviour that teaches people
   the search is not worth using. Rank by how the match sits in the string:
   the whole name, then its start, then the start of any word in it, then
   anywhere. The section name is searched too but always ranks below the
   feature's own, so typing a section name gathers its contents without
   burying an exactly-named feature somewhere else. */
function score(row: Row, needle: string): number {
  if (!needle) return 0
  const name = row.name.toLowerCase()
  const section = row.section.toLowerCase()
  if (name === needle) return 100
  if (name.startsWith(needle)) return 80
  if (name.split(/[\s&/(),-]+/).some((w) => w.startsWith(needle))) return 60
  if (name.includes(needle)) return 40
  if (section.startsWith(needle)) return 20
  if (section.includes(needle)) return 10
  return -1
}

export function BentoLauncher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const role = useActiveRole()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const t = useT()
  const recentKeys = useRecents()
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  /* Which categories are switched OFF, not which are on.

     Everything is visible by default, so the empty set is the ordinary state
     and the filter starts by showing the whole board rather than nothing. The
     inverse — a set of selected categories, empty meaning none — would put a
     blank panel in front of somebody who has just opened a launcher to look
     around, and make "show me everything" a thing they had to ask for. */
  const [off, setOff] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Every row this role can open, flattened once. The grouping below is a view
  // over this, so search and browse cannot disagree about what exists.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const s of role?.sections ?? []) {
      for (const f of s.features) {
        if (!usable(f)) continue
        out.push({
          key: f.key, name: f.name, slug: f.slug,
          section: s.name, sectionSlug: s.slug,
          workspace: s.workspace || 'Other',
        })
      }
    }
    return out
  }, [role])

  const needle = q.trim().toLowerCase()

  const results = useMemo(() => {
    if (!needle) return []
    return rows
      .filter((r) => !off.has(r.workspace))
      .map((r) => ({ r, s: score(r, needle) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.r.name.localeCompare(b.r.name))
      .map((x) => x.r)
  }, [rows, needle, off])

  const recents = useMemo(() => {
    const byKey = new Map(rows.map((r) => [r.key, r]))
    // Filtered through the catalogue, so a feature this account has since lost
    // access to simply disappears from the list rather than 404ing on click.
    return recentKeys.map((k) => byKey.get(k)).filter((r): r is Row => !!r)
  }, [recentKeys, rows])

  /* Every category this role has, in board order, with its colour. */
  const chips = useMemo(() => {
    const seen: string[] = []
    for (const r of rows) if (!seen.includes(r.workspace)) seen.push(r.workspace)
    return seen
  }, [rows])

  const toggle = (name: string) =>
    setOff((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const groups = useMemo(() => {
    const out: { name: string; sections: { name: string; rows: Row[] }[] }[] = []
    for (const r of rows) {
      let g = out.find((x) => x.name === r.workspace)
      if (!g) { g = { name: r.workspace, sections: [] }; out.push(g) }
      let s = g.sections.find((x) => x.name === r.section)
      if (!s) { s = { name: r.section, rows: [] }; g.sections.push(s) }
      s.rows.push(r)
    }
    return out
  }, [rows])

  // What the keyboard walks. Only meaningful while searching: browsing a
  // sixty-five item grid with arrow keys is worse than pointing at it.
  const walkable = needle ? results : []

  /* The way home, from the panel that lists everywhere else.

     Somebody who opens All features to look around needs a way back that is
     not "guess which of these sixty-five is the dashboard". It resolves to the
     role's first opening feature, exactly as the dock's Home does — the same
     rule in both places, because two different answers to "where is home"
     would be worse than none. */
  const homeRow = rows[0]

  const go = useCallback(
    (r: Row) => {
      if (!role) return
      navigate(featurePath(role.key, r.sectionSlug, r.slug))
      onClose()
    },
    [navigate, onClose, role],
  )

  useEffect(() => {
    if (!open) return
    setQ('')
    setCursor(0)
    // Focused on open: the fastest path through a launcher is to start typing,
    // and a search box you must click first is a search box that gets clicked.
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  useEffect(() => setCursor(0), [needle])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (!walkable.length) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor((c) => (c + 1) % walkable.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor((c) => (c - 1 + walkable.length) % walkable.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const pick = walkable[cursor]
        if (pick) go(pick)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, walkable, cursor, go])

  // Keep the cursor in view when it walks past the fold.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-cursor="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [cursor, needle])

  if (!open || !role) return null

  const Tile = ({ r, i, context, step }: { r: Row; i?: number; context?: boolean; step?: number }) => {
    const href = featurePath(role.key, r.sectionSlug, r.slug)
    const here = pathname === href
    const onCursor = i !== undefined && i === cursor
    const Mark = markFor(r.workspace)
    return (
      <button
        type="button"
        onClick={() => go(r)}
        onMouseEnter={() => i !== undefined && setCursor(i)}
        data-cursor={onCursor ? 'true' : undefined}
        aria-current={here ? 'page' : undefined}
        /* Each feature is its own object now, not a line of a list.

           A row of text is read; a box is aimed at. With sixty-five of them
           the difference is the whole experience of the panel — the eye lands
           on a shape and the hand goes there, rather than scanning a column
           for a word. It is the home-screen arrangement, and it works for the
           same reason: position and colour become memory, so the third visit
           is faster than the first.

           The box carries its own surface rather than sitting transparently on
           the category tint. That is what makes it an object at all — on the
           tint alone it is a hover state pretending to be a thing. */
        className={cn(
          /* min-w-0 is what keeps this inside the screen.

             A grid item's min-width is `auto`, which means it refuses to be
             narrower than its own content. "Parent Bus Proximity Radius
             Customizer" is a wide piece of min-content, so the box grew, the
             grid grew with it, and the whole launcher overflowed the phone by
             36px -- every tile pushed off the right edge, and the truncation
             on the label below never got a chance to fire because nothing was
             ever narrower than the text. */
          `launcher-app group flex w-full min-w-0 items-center gap-2.5 rounded-[10px] px-2.5 py-2
           text-left focus-visible:outline-none focus-visible:ring-2
           focus-visible:ring-[var(--ink-here)]`,
          onCursor && 'launcher-app-on',
          here && 'font-medium',
        )}
        /* Each box takes a tone from its category's own colour.

           Not one tint repeated: the mix walks 5, 7, 9, 11 per cent down the
           tile order and then repeats, so neighbours differ by a step small
           enough to read as one family and large enough that the boxes are
           separate objects rather than a striped field. It is the difference
           between a shelf of books in a series and a shelf of identical books.

           All of them stay lighter than the panel behind, which is at 13, so
           the boxes lift off their category rather than sinking into it.

           Mixed against the card token rather than white, so dark mode needs
           no second rule: there the same expression tints a dark surface. */
        /* THE TINT IS NOW ACTUALLY PAINTED.

           `--tile-tint` was computed here and consumed nowhere: the stylesheet
           says the background is "given inline", the inline style set only the
           variable, and so every one of the sixty-five boxes was transparent.
           The whole reason the box exists — an object you aim at rather than a
           row you read — was never on screen, and its words were inheriting the
           ink of whatever it happened to be sitting over.

           With a surface it also gets an ink, chosen against that surface the
           same way every other surface here chooses one. */
        style={
          {
            '--tile-tint': `color-mix(in srgb, var(--dom-${hueFor(r.workspace)}) ${
              5 + ((step ?? 0) % 4) * 2
            }%, var(--bento-card))`,
            '--ink-here': 'hsl(from var(--tile-tint) 0 0% clamp(0%, (49 - l) * 100%, 100%))',
            background: 'var(--tile-tint)',
            color: 'var(--ink-here)',
          } as CSSProperties
        }
      >
        {/* The row's glyph carries its group's colour, which is what ties a
            tile to the heading it sits under once the eye has left it. Within
            a group every glyph is the same, so it reads as grouping rather
            than as sixty-five separate decisions.

            It names itself on hover. A mark is only a landmark once you have
            learnt it, and nothing here teaches it: a book means Academics to
            whoever chose the book. The title is on a wrapping span rather than
            the svg because a title inside an aria-hidden element is read by
            neither the pointer nor the screen reader in some browsers. */}
        <span
          title={r.workspace}
          className="grid shrink-0 place-items-center"
          /* Neat domain colour on a surface mixed from that same domain colour
             is a glyph you cannot see — 1.00:1 for Operations under the default
             palette, where `--dom-operations` IS the paper the tile is made of.
             Mixed toward the tile's own ink it keeps the hue that ties it to
             its heading and gains a shape. */
          style={{ color: `color-mix(in srgb, var(--dom-${hueFor(r.workspace)}) 45%, var(--ink-here))` }}
        >
          <Mark className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px]">{r.name}</span>
          {/* Where it belongs, said only where that is not already obvious.

              Inside a category panel the heading has just said it: HOME, and
              then three tiles each captioned "Home". Repeating the answer to a
              question the block already answered is noise the eye has to
              discard on every row.

              Recents and search results are the cases where it earns its
              place, because those are drawn from everywhere at once — and
              there it names the category rather than the section, since the
              category is the thing carrying a colour the reader has been
              learning. */}
          {context && (
            <span className="block truncate text-[11.5px] opacity-80">
              {r.workspace}
            </span>
          )}
        </span>
      </button>
    )
  }

  /* The two header controls, and the reason they no longer name a semantic
     class. `hover:bg-accent` is a wash mixed from `--bento-ink` — the card's
     ink — which on the near-black page is a black smear that cannot be seen;
     `focus-visible:ring-ring` is the mint accent, measured against the card
     and 1.2:1 against the paper dock, so the focus ring was the one thing on
     screen a keyboard user could not find. Both are mixed from `--ink-here`
     instead, which is by construction the colour this ground contrasts with. */
  const quiet =
    `flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[12.5px] transition-colors ` +
    `hover:bg-[color-mix(in_srgb,var(--ink-here)_12%,transparent)] focus-visible:outline-none ` +
    `focus-visible:ring-2 focus-visible:ring-[var(--ink-here)]`

  return (
    <div
      role="dialog"
      aria-modal="true"
      /* Frosted glass over the board, the way an iPhone's App Library sits
         over the wallpaper — see .bento-frost in bento-theme.css for why the
         saturation matters as much as the blur. */
      className="fade-in bento-frost fixed inset-0 z-[60] overflow-y-auto"
      /* THE INK IS CHOSEN BY THE SURFACE, AND EVERY SURFACE CHOOSES ITS OWN.

         This panel is the one place in the layout whose ground is the PAGE and
         not a card. `--bento-ink` is the card's ink — the palettes measured it
         against `--bento-card` and nothing else — so every word in this header
         inherited black and the default palette put it on a near-black page at
         1.11:1. Not a palette that could fix it: one ink cannot be right on two
         grounds.

         So the ink is derived from the ground it will sit on: black or white,
         whichever the ground is further from, by that ground's own lightness.
         `--ink-here` is redefined by each surface below — the page, a category
         panel, a chip, a tile — and everything inside a surface reads it, so a
         word is always the ink of the thing it is printed on. No colour is
         named and no palette has anything new to set. */
      style={
        {
          '--ink-here': 'hsl(from var(--bento-bg) 0 0% clamp(0%, (49 - l) * 100%, 100%))',
          color: 'var(--ink-here)',
        } as CSSProperties
      }
      onClick={onClose}
    >
      <div
        /* Wider than a reading column, because this is not one.

           max-w-5xl is the width prose wants — about 1024px — and it was
           strangling a four-column board of boxes: "Academic Performan…"
           truncated at 1024 with a thousand pixels of empty screen either side
           of it. A launcher is scanned across, not read down, so it should take
           the glass it is given.

           Capped rather than full-bleed. On an ultrawide, panels stretched to
           2500px would put Home and Operations so far apart that finding one
           means moving your head, and the tiles inside would grow into empty
           rectangles. 1600 is about as wide as a four-column board stays
           readable. */
        className="mx-auto max-w-[1600px] px-6 pb-16 pt-10 sm:px-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-baseline justify-between gap-4">
          <div>
            {/* `text-muted-foreground` resolves to `--bento-muted`, which is
                the card's ink. On the page it is the wrong ground's ink, and
                the muted tone is the ink anyway — the difference is carried by
                size and weight, which is where it already was. */}
            <p className="text-[11px] uppercase tracking-[0.08em]">
              {role.name}
            </p>
            <h2 className="text-[22px] font-semibold">{t('bento.launcher.title')}</h2>
          </div>
          <div className="flex items-center gap-1.5">
            {homeRow && (
              <button
                type="button"
                onClick={() => go(homeRow)}
                className={quiet}
              >
                <House className="size-3.5" aria-hidden="true" />
                {t('bento.dock.home')}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className={quiet}
            >
              {t('bento.launcher.close')}
            </button>
          </div>
        </div>

        <div className="relative mb-8">
          {/* The glyph sits ON the field, not on the page, so it takes the
              card's ink rather than the page's. */}
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2
                       text-[var(--bento-ink)]"
            aria-hidden="true"
          />
          {/* The field is a card, so its words are the card's ink — it was
              inheriting the page's and came out black on white by luck on two
              palettes and black on near-black on the default.

              Its edge is mixed from the ink rather than taken from
              `--bento-line`: the line token is the hairline BETWEEN cards, and
              at 1.13:1 against the page it left the one text input on the
              surface with no visible boundary at all. */}
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('bento.launcher.filter', { count: String(rows.length) })}
            aria-label={t('bento.launcher.filter', { count: String(rows.length) })}
            className="w-full rounded-[10px] border
                       !border-[color-mix(in_srgb,var(--bento-ink)_45%,transparent)]
                       bg-[var(--bento-card)] py-2.5 pl-10 pr-3.5 text-[13.5px]
                       text-[var(--bento-ink)] focus-visible:outline-none focus-visible:ring-2
                       focus-visible:ring-[var(--bento-ink)]"
          />
        </div>

        {/* The categories, as switches rather than as a picker.

            All are on when the panel opens, and pressing one turns it off.
            That is the direction round that matches what somebody is doing
            here: they arrive wanting the whole board and narrow it by removing
            the parts they are not looking in — the opposite arrangement makes
            "show me everything" a thing they have to ask for first.

            Each carries its domain colour when on and goes flat when off, so
            the row of chips reads as the same colour system as the board it is
            filtering rather than as a separate control panel. */}
        <div className="mb-6 flex flex-wrap items-center gap-1.5">
          {chips.map((name) => {
            const Mark = markFor(name)
            const hue = hueFor(name)
            const on = !off.has(name)
            return (
              <button
                key={name}
                type="button"
                onClick={() => toggle(name)}
                aria-pressed={on}
                className={cn(
                  `flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]
                   transition-colors focus-visible:outline-none focus-visible:ring-2
                   focus-visible:ring-[var(--ink-here)]`,
                  on && 'font-medium',
                )}
                /* A chip that is on is its own little surface, so it declares
                   its own ink; a chip that is off is the page, so it keeps the
                   page's.

                   The off state's border was a literal `hsl(var(--border))` —
                   the classic theme's token, written inline where the
                   stylesheet's re-pointing rules cannot reach it. It is the one
                   value in these three components a palette structurally could
                   not move, and it moved only when the theme flipped between
                   light and dark. */
                style={
                  on
                    ? ({
                        '--chip': `color-mix(in srgb, var(--dom-${hue}) 40%, var(--bento-card))`,
                        '--ink-here': 'hsl(from var(--chip) 0 0% clamp(0%, (49 - l) * 100%, 100%))',
                        background: 'var(--chip)',
                        color: 'var(--ink-here)',
                        borderColor: `color-mix(in srgb, var(--dom-${hue}) 60%, var(--ink-here))`,
                      } as CSSProperties)
                    : {
                        borderColor: 'color-mix(in srgb, var(--ink-here) 45%, transparent)',
                        opacity: 0.75,
                      }
                }
              >
                {/* The mark keeps its hue and is moved far enough toward the
                    chip's own ink to be a shape rather than a stain: the
                    default palette's domain colours ARE its card colours, so
                    drawn neat on a chip mixed from the same colour they
                    measured 1.0-1.9:1. */}
                <Mark
                  className="size-3.5 shrink-0"
                  style={{
                    color: on
                      ? `color-mix(in srgb, var(--dom-${hue}) 45%, var(--ink-here))`
                      : 'currentColor',
                  }}
                  aria-hidden="true"
                />
                {name}
              </button>
            )
          })}

          {/* Only offered when it would do something. A reset that is always
              there is a control people learn to ignore. */}
          {off.size > 0 && (
            <button
              type="button"
              onClick={() => setOff(new Set())}
              className="ml-1 rounded-full px-2.5 py-1 text-[12px] underline-offset-4
                         transition-colors hover:underline focus-visible:outline-none
                         focus-visible:ring-2 focus-visible:ring-[var(--ink-here)]"
            >
              {t('bento.launcher.show_all')}
            </button>
          )}
        </div>

        <div ref={listRef}>
          {needle ? (
            results.length ? (
              <>
                <Heading icon={Search} label={t('bento.launcher.results', { count: String(results.length) })} />
                <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                  {results.map((r, i) => <Tile key={r.key} r={r} i={i} step={i} context />)}
                </div>
                <p className="mt-6 flex items-center gap-1.5 text-[11.5px] opacity-80">
                  <CornerDownLeft className="size-3" aria-hidden="true" />
                  {t('bento.launcher.hint')}
                </p>
              </>
            ) : (
              <p className="py-10 text-center text-[13.5px] opacity-80">
                {t('bento.launcher.empty', { q: q.trim() })}
              </p>
            )
          ) : (
            <>
              {recents.length > 0 && (
                <section className="mb-9">
                  <Heading icon={Clock} label={t('bento.launcher.recent')} />
                  <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {recents.map((r, i) => <Tile key={`recent-${r.key}`} r={r} step={i} context />)}
                  </div>
                </section>
              )}
              <div className="grid grid-flow-dense auto-rows-min grid-cols-[minmax(0,1fr)] gap-3
                              sm:grid-cols-2 lg:grid-cols-4">
              {groups.filter((g) => !off.has(g.name)).map((g) => {
                const Mark = markFor(g.name)
                const hue = hueFor(g.name)
                const count = g.sections.reduce((n, x) => n + x.rows.length, 0)
                return (
                  /* The whole category sits on its colour, not just its glyph.

                     A tinted panel does the grouping that a heading alone only
                     asserts: the eye finds the block before it reads the word,
                     and a feature's category is legible from the far side of
                     the screen. The tint is the same soft the chip uses, so a
                     workspace is one colour in two weights rather than two
                     colours that have to be learned separately. */
                  <section
                    key={g.name}
                    className={cn(
                      'launcher-tile min-w-0 rounded-[var(--bento-radius)] border p-3.5',
                      tileSpan(count),
                    )}
                    /* Mixed from the domain's ink, not its chip tone.

                       The -soft tokens are about 4% saturation, which is right
                       behind a chip the size of a word and invisible behind a
                       panel the size of a hand: Home, Students and Finance all
                       came out off-white and the colour system stopped saying
                       anything. 13% of the ink against the card is enough to
                       name a category across the width of the screen while
                       still reading as a tint, and the border at 28% gives the
                       block an edge so it is a region rather than a wash.

                       Derived rather than a second set of hexes per domain, so
                       there is nothing to keep in step and dark mode follows
                       from the ink it already redefines. */
                    /* The panel declares the ink for everything printed
                       directly on it. Its colour is a mix, so which of black
                       and white wins is a question about the mix and not about
                       the palette's polarity: under the default palette Staff
                       and Department Workspace come out dark enough to need
                       white while their neighbours need black, and no single
                       token could have said that. */
                    style={
                      {
                        '--panel': `color-mix(in srgb, var(--dom-${hue}) 40%, var(--bento-card))`,
                        '--ink-here': 'hsl(from var(--panel) 0 0% clamp(0%, (49 - l) * 100%, 100%))',
                        background: 'var(--panel)',
                        color: 'var(--ink-here)',
                        borderColor: `color-mix(in srgb, var(--dom-${hue}) 60%, var(--ink-here))`,
                      } as CSSProperties
                    }
                  >
                    <Heading icon={Mark} label={g.name} hue={hue} onTint />
                    <div className={cn('grid grid-cols-[minmax(0,1fr)] gap-1.5', tileColumns(count))}>
                      {g.sections.flatMap((s) => s.rows).map((r, i) => (
                        <Tile key={r.key} r={r} step={i} />
                      ))}
                    </div>
                  </section>
                )
              })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** One heading treatment for every band, so recents, results and workspaces
    read as the same kind of thing rather than three inventions.

    The glyph sits in a filled chip of its category's colour. Both halves earn
    their place: a coloured icon alone is too small a mark to register on this
    ground, and a coloured chip alone loses the shape that says which
    workspace it is. The label stays muted — colouring the words as well would
    make eight headings shout at each other, and the chip has already said it. */
function Heading({
  icon: Icon,
  label,
  hue = 'operations',
  onTint,
}: {
  icon: typeof Home
  label: string
  hue?: string
  /** True when the heading sits on its category's tint, where a chip of the
      same soft would be invisible. There the glyph goes bare and the label
      takes the ink, so the heading still reads as the strongest thing in the
      panel without inventing a third weight of the colour. */
  onTint?: boolean
}) {
  return (
    <h3
      className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.08em]"
      /* On the tint the heading was drawn in `--dom-<hue>` — the domain colour
         — on a panel mixed from that same domain colour. In the shipped
         palettes that name is a dark ink and it read; under the default palette
         it is the panel's own colour and the heading measured 1.86:1. It takes
         the panel's ink instead, which is the one colour the panel is
         guaranteed to contrast with, and the weight keeps it the strongest
         thing in the block. */
      style={onTint ? { color: 'var(--ink-here)' } : undefined}
    >
      <span
        title={label}
        className="flex size-6 items-center justify-center"
        /* Off the tint the chip is the domain's own panel, so the glyph is
           that panel's measured ink — `-text` is exactly the token for it, and
           `--dom-<hue>` was the panel colour again: a mark drawn in the colour
           it sits on. */
        style={{
          background: onTint ? 'transparent' : `var(--dom-${hue}-soft)`,
          color: onTint
            ? `color-mix(in srgb, var(--dom-${hue}) 45%, var(--ink-here))`
            : `var(--dom-${hue}-text)`,
        }}
      >
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <span className={onTint ? 'font-semibold' : undefined}>{label}</span>
    </h3>
  )
}
