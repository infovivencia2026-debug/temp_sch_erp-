import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Home, GraduationCap, Users, Wallet, BookOpen, MessageSquare, ClipboardList,
  BarChart3, Bus, Settings2, ShieldCheck, CalendarDays, Boxes, Clock, Search,
  CornerDownLeft, LayoutGrid,
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

function markFor(workspace: string) {
  return WORKSPACE_ICON[workspace] ?? LayoutGrid
}

/* Colour per category, from a set of eight.

   Not a hue each. There are thirty-nine workspaces across the roles, and past
   about eight a reader stops decoding colour and starts ignoring it — a
   library where every heading is its own shade has no categories, only
   confetti. Any one role shows six to twelve, so eight is enough for its
   groups to differ on the screen somebody is actually looking at.

   Named where the meaning is obvious, because a learnable colour beats an
   arbitrary one: money is green wherever it appears, transport amber, people
   rose. The long tail is hashed rather than left unassigned — a workspace
   nobody thought about must still get a colour, and it must get the same one
   every time, so the hash is over the name and not the position. Position
   would be stable until the catalogue was reordered and then silently repaint
   half the library. */
const WORKSPACE_HUE: Record<string, string> = {
  Students: 'blue', Admissions: 'blue', 'My Child': 'blue', People: 'blue',
  Academics: 'violet', Assessments: 'violet', Teaching: 'violet',
  'My Classes': 'violet', Examinations: 'violet', Timetable: 'violet',
  Finance: 'green', Fees: 'green', Accounting: 'green', Payroll: 'green',
  'Subscriptions & Billing': 'green',
  Transport: 'amber', Operations: 'amber', Library: 'amber',
  Staff: 'rose', Employees: 'rose', 'Attendance & Leave': 'rose',
  Communication: 'cyan', 'Front Desk': 'cyan', Requests: 'cyan', Support: 'cyan',
  Reports: 'teal', 'Usage & Health': 'teal', Dashboard: 'teal',
  Home: 'slate', 'My Work': 'slate', Administration: 'slate',
  Profile: 'slate', 'Access & Security': 'slate',
}

const HUES = ['blue', 'violet', 'teal', 'green', 'amber', 'rose', 'cyan', 'slate']

function hueFor(workspace: string): string {
  const named = WORKSPACE_HUE[workspace]
  if (named) return named
  let h = 0
  for (let i = 0; i < workspace.length; i++) h = (h * 31 + workspace.charCodeAt(i)) >>> 0
  return HUES[h % HUES.length]
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

  const Tile = ({ r, i }: { r: Row; i?: number }) => {
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
        className={cn(
          `flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors
           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`,
          onCursor ? 'bg-accent' : 'hover:bg-accent/60',
          here && 'font-medium',
        )}
      >
        {/* The row's glyph carries its group's colour, which is what ties a
            tile to the heading it sits under once the eye has left it. Within
            a group every glyph is the same, so it reads as grouping rather
            than as sixty-five separate decisions. */}
        <Mark
          className="size-4 shrink-0"
          style={{ color: `var(--cat-${hueFor(r.workspace)})` }}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px]">{r.name}</span>
          <span className="block truncate text-[11.5px] text-muted-foreground">{r.section}</span>
        </span>
      </button>
    )
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('bento.launcher.title')}
      className="fixed inset-0 z-[60] overflow-y-auto bg-background/80 backdrop-blur-xl"
      onClick={onClose}
    >
      <div
        className="mx-auto max-w-5xl px-6 pb-16 pt-10 sm:px-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-baseline justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              {role.name}
            </p>
            <h2 className="text-[22px] font-semibold">{t('bento.launcher.title')}</h2>
          </div>
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
                <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                  {results.map((r, i) => <Tile key={r.key} r={r} i={i} />)}
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
                  <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                    {recents.map((r) => <Tile key={`recent-${r.key}`} r={r} />)}
                  </div>
                </section>
              )}
              {groups.map((g) => {
                const Mark = markFor(g.name)
                return (
                  <section key={g.name} className="mb-9">
                    <Heading icon={Mark} label={g.name} hue={hueFor(g.name)} />
                    <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                      {g.sections.flatMap((s) => s.rows).map((r) => (
                        <Tile key={r.key} r={r} />
                      ))}
                    </div>
                  </section>
                )
              })}
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
  hue = 'slate',
}: {
  icon: typeof Home
  label: string
  hue?: string
}) {
  return (
    <h3 className="mb-2.5 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em]
                   text-muted-foreground">
      <span
        className="flex size-6 items-center justify-center rounded-[7px]"
        style={{
          background: `var(--cat-${hue}-soft)`,
          color: `var(--cat-${hue})`,
        }}
      >
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      {label}
    </h3>
  )
}
