import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Home, GraduationCap, Users, Wallet, BookOpen, MessageSquare, ClipboardList,
  BarChart3, Bus, Settings2, ShieldCheck, CalendarDays, Boxes, Clock, Search,
  CornerDownLeft, LayoutGrid, House,
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
  Setup: Settings2,
}

export function markFor(workspace: string) {
  return WORKSPACE_ICON[workspace] ?? LayoutGrid
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
      .map((r) => ({ r, s: score(r, needle) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.r.name.localeCompare(b.r.name))
      .map((x) => x.r)
  }, [rows, needle])

  const recents = useMemo(() => {
    const byKey = new Map(rows.map((r) => [r.key, r]))
    // Filtered through the catalogue, so a feature this account has since lost
    // access to simply disappears from the list rather than 404ing on click.
    return recentKeys.map((k) => byKey.get(k)).filter((r): r is Row => !!r)
  }, [recentKeys, rows])

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

  const Tile = ({ r, i, context }: { r: Row; i?: number; context?: boolean }) => {
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
          `launcher-app group flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2
           text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`,
          onCursor && 'launcher-app-on',
          here && 'font-medium',
        )}
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
          style={{ color: `var(--dom-${hueFor(r.workspace)})` }}
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
            <span className="block truncate text-[11.5px] text-muted-foreground">
              {r.workspace}
            </span>
          )}
        </span>
      </button>
    )
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('bento.launcher.title')}
      className="fade-in fixed inset-0 z-[60] overflow-y-auto bg-background/80 backdrop-blur-xl"
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
            <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              {role.name}
            </p>
            <h2 className="text-[22px] font-semibold">{t('bento.launcher.title')}</h2>
          </div>
          <div className="flex items-center gap-1.5">
            {homeRow && (
              <button
                type="button"
                onClick={() => go(homeRow)}
                className="flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[12.5px]
                           text-muted-foreground transition-colors hover:bg-accent
                           hover:text-foreground focus-visible:outline-none focus-visible:ring-2
                           focus-visible:ring-ring"
              >
                <House className="size-3.5" aria-hidden="true" />
                {t('bento.dock.home')}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-[10px] px-3 py-1.5 text-[12.5px] text-muted-foreground transition-colors
                         hover:bg-accent hover:text-foreground focus-visible:outline-none
                         focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('bento.launcher.close')}
            </button>
          </div>
        </div>

        <div className="relative mb-8">
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2
                       text-muted-foreground"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('bento.launcher.filter', { count: String(rows.length) })}
            aria-label={t('bento.launcher.filter', { count: String(rows.length) })}
            className="w-full rounded-[10px] border bg-popover py-2.5 pl-10 pr-3.5 text-[13.5px]
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div ref={listRef}>
          {needle ? (
            results.length ? (
              <>
                <Heading icon={Search} label={t('bento.launcher.results', { count: String(results.length) })} />
                <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                  {results.map((r, i) => <Tile key={r.key} r={r} i={i} context />)}
                </div>
                <p className="mt-6 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <CornerDownLeft className="size-3" aria-hidden="true" />
                  {t('bento.launcher.hint')}
                </p>
              </>
            ) : (
              <p className="py-10 text-center text-[13.5px] text-muted-foreground">
                {t('bento.launcher.empty', { q: q.trim() })}
              </p>
            )
          ) : (
            <>
              {recents.length > 0 && (
                <section className="mb-9">
                  <Heading icon={Clock} label={t('bento.launcher.recent')} />
                  <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {recents.map((r) => <Tile key={`recent-${r.key}`} r={r} context />)}
                  </div>
                </section>
              )}
              <div className="grid grid-flow-dense auto-rows-min grid-cols-1 gap-3 sm:grid-cols-2
                              lg:grid-cols-4">
              {groups.map((g) => {
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
                      'launcher-tile rounded-[var(--bento-radius)] border p-3.5',
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
                    style={{
                      background: `color-mix(in srgb, var(--dom-${hue}) 13%, var(--bento-card))`,
                      borderColor: `color-mix(in srgb, var(--dom-${hue}) 28%, transparent)`,
                    }}
                  >
                    <Heading icon={Mark} label={g.name} hue={hue} onTint />
                    <div className={cn('grid gap-1.5', tileColumns(count))}>
                      {g.sections.flatMap((s) => s.rows).map((r) => (
                        <Tile key={r.key} r={r} />
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
      className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em]"
      style={onTint ? { color: `var(--dom-${hue})` } : undefined}
    >
      <span
        title={label}
        className="flex size-6 items-center justify-center"
        style={{
          background: onTint ? 'transparent' : `var(--dom-${hue}-soft)`,
          color: `var(--dom-${hue})`,
        }}
      >
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <span className={onTint ? 'font-semibold' : 'text-muted-foreground'}>{label}</span>
    </h3>
  )
}
