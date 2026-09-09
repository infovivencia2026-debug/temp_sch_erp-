import { useOverlayHistory } from '@/lib/overlay-history'
import {
  Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties,
} from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Home, GraduationCap, Users, Wallet, BookOpen, MessageSquare, ClipboardList,
  BarChart3, Bus, Settings2, ShieldCheck, CalendarDays, Boxes, Clock, Search,
  CornerDownLeft, House, Pin, PinOff, Ellipsis,
  Activity, Banknote, Bot, Building2, CalendarCheck, CircleUser, CreditCard,
  FileCheck2, FileText, FolderTree, Handshake, Inbox, KeyRound, Landmark,
  LibraryBig, LifeBuoy, ListChecks, Presentation, Server, Sparkle,
  Wrench,
} from 'lucide-react'
import { useActiveRole, featurePath, usable } from '@/lib/catalog'
import { useT } from '@/lib/i18n'
import { useRecents } from '@/lib/recents'
import { FeatureGlyph } from '@/components/FeatureGlyph'
import { usePins, togglePin } from '@/lib/pins'
import { buzz } from '@/lib/haptics'
import { useReduceMotion } from './bento-kit'
import './launcher.css'

/* The open and the close: a short rise and a fade, in and out. 200ms is the
   layout's --dur-fast, the speed everything else on the board answers at. A
   drag — the finger bringing the sheet up, or pulling it back down — is not a
   transition at all: the sheet is wherever the finger is. */
const MOTION_MS = 200

/* Everything the role can open, on one surface, reachable by pointing at it.

   The palette answers "I know what I want"; it shows eight items until you
   type, so it cannot answer "what is there". A principal's job is partly
   noticing things, and a layout that can only be searched has taken that away
   — so this is the sidebar's discovery, without the sidebar.

   It is an APP GRID now, the shape iCloud.com and every phone's home screen
   use: a rounded plate with a glyph, the name beneath, four to a row on a
   phone and six to eight at a desk. One kind of object, everywhere on the
   surface — pinned, recent, or filed under its workspace — so that position
   and colour become memory and the third visit is faster than the first.

   PINNED, THEN RECENT, THEN EVERYTHING. Almost nobody uses sixty-five
   features. A principal opens the same four or five every morning: the
   launcher notices which (recents) and lets them say which (pins), and the
   two rows are kept apart because a curated row must not reorder itself.

   AN ICON PER FEATURE, A MARK PER WORKSPACE. The plate used to show the
   feature's two initials, because the catalogue carries no icon and nobody
   wanted to draw sixty-five. Initials are not a picture: a grid of them is
   read word by word, which is the slow path the launcher exists to avoid.
   Every slug now names a Material Symbol (feature-icons.tsx, with a test that
   fails the day one does not), drawn in a tint of its workspace's colour with
   the workspace's mark in the corner: the family is legible from across the
   room and the member is legible up close.

   OPERABLE FROM THE KEYBOARD. Typing filters, the arrows walk the grid in
   two dimensions, Enter opens, Escape leaves. */

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

  /* Each of these is the thing the workspace is ABOUT rather than a shape
     that happened to be free — a reader learns "money is a banknote" once and
     it holds across Accounts, Payroll and Campus Money. */
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
  /* Schools reuses the building the singular School already uses, because
     they are the same subject seen from the two sides of the product. */
  Schools: Building2,
  Documents: FileText,
}

export function markFor(workspace: string) {
  /* The fallback is deliberately NOT LayoutGrid: that is the All-features
     glyph, so anything unmapped used to be a perfect copy of the button
     beside it. A workspace nobody has thought about should look unremarkable,
     not look like something else. */
  return WORKSPACE_ICON[workspace] ?? Sparkle
}

/* Colour by ERP domain, not by launcher category.

   These are the product's domain palette — attendance is cyan in this list,
   on its chart, on its chip and in a mixed queue — so the launcher is one of
   the places colour is read rather than the one place it means something.

   Nine domains for thirty-nine workspace labels, because the labels are how
   the catalogue files things and the domains are how a school thinks about
   them: Fees, Accounting, Payroll and Subscriptions are four sections of one
   subject.

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

/** The name cut around the first match, so the launcher can underline what
    it matched on. `hit` marks the piece that matched; a name that matched by
    its section rather than its own words comes back in one unmarked piece. */
export function splitMatch(name: string, needle: string): { text: string; hit: boolean }[] {
  if (!needle) return [{ text: name, hit: false }]
  const at = name.toLowerCase().indexOf(needle.toLowerCase())
  if (at < 0) return [{ text: name, hit: false }]
  const out: { text: string; hit: boolean }[] = []
  if (at > 0) out.push({ text: name.slice(0, at), hit: false })
  out.push({ text: name.slice(at, at + needle.length), hit: true })
  if (at + needle.length < name.length) out.push({ text: name.slice(at + needle.length), hit: false })
  return out
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

/* One place on the surface where a feature is drawn. A feature can be drawn
   up to three times — pinned, recent, and under its workspace — and the
   keyboard cursor walks PLACES, so each gets an id of its own. */
interface Slot {
  id: string
  r: Row
  /** Say where it belongs under the name (recents and results, which are
      drawn from everywhere at once). */
  context: boolean
}

export function BentoLauncher({
  open,
  drag = null,
  onClose,
}: {
  open: boolean
  /** Where a swipe has the sheet, 0..1, while the finger is still down. */
  drag?: number | null
  onClose: () => void
}) {
  const role = useActiveRole()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const t = useT()
  const recentKeys = useRecents()
  const pinKeys = usePins()
  const still = useReduceMotion()
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  /* The slot whose "…" menu is open, if any. */
  const [menuFor, setMenuFor] = useState<string | null>(null)
  /* What a screen reader is told when a pin is made by long-press, which
     has no visible menu to confirm it. */
  const [note, setNote] = useState('')
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

  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows])

  const needle = q.trim().toLowerCase()

  const results = useMemo(() => {
    if (!needle) return []
    return rows
      .map((r) => ({ r, s: score(r, needle) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.r.name.localeCompare(b.r.name))
      .map((x) => x.r)
  }, [rows, needle])

  /* Both filtered through the catalogue, so a feature this account has since
     lost access to simply disappears rather than 404ing on tap. */
  const recents = useMemo(
    () => recentKeys.map((k) => byKey.get(k)).filter((r): r is Row => !!r),
    [recentKeys, byKey],
  )
  const pinned = useMemo(
    () => pinKeys.map((k) => byKey.get(k)).filter((r): r is Row => !!r),
    [pinKeys, byKey],
  )
  const pinSet = useMemo(() => new Set(pinKeys), [pinKeys])

  const groups = useMemo(() => {
    const out: { name: string; rows: Row[] }[] = []
    for (const r of rows) {
      let g = out.find((x) => x.name === r.workspace)
      if (!g) { g = { name: r.workspace, rows: [] }; out.push(g) }
      g.rows.push(r)
    }
    return out
  }, [rows])

  /* What the keyboard walks, in the order it is drawn: the results while
     searching, otherwise pinned, then recent, then every workspace. */
  const slots = useMemo<Slot[]>(() => {
    if (needle) return results.map((r) => ({ id: `q:${r.key}`, r, context: true }))
    return [
      ...pinned.map((r) => ({ id: `pin:${r.key}`, r, context: false })),
      ...recents.map((r) => ({ id: `recent:${r.key}`, r, context: true })),
      ...groups.flatMap((g) => g.rows.map((r) => ({ id: `all:${r.key}`, r, context: false }))),
    ]
  }, [needle, results, pinned, recents, groups])

  /* The way home, from the panel that lists everywhere else. It resolves to
     the role's first opening feature, exactly as the dock's Home does — the
     same rule in both places, because two different answers to "where is
     home" would be worse than none. */
  const homeRow = rows[0]

  const go = useCallback(
    (r: Row) => {
      if (!role) return
      navigate(featurePath(role.key, r.sectionSlug, r.slug))
      onClose()
    },
    [navigate, onClose, role],
  )

  const onPin = useCallback(
    (r: Row) => {
      const now = togglePin(r.key)
      buzz('select')
      setNote(t(now ? 'bento.launcher.pinned_note' : 'bento.launcher.unpinned_note', { name: r.name }))
      setMenuFor(null)
    },
    [t],
  )

  useEffect(() => {
    if (!open) return
    setQ('')
    setCursor(0)
    setMenuFor(null)
    setNote('')
    /* Focused on open WHERE THERE IS A KEYBOARD ALREADY ON THE DESK.

       At a desk the fastest path through a launcher is to start typing. On a
       phone, focusing an input summons the on-screen keyboard, which covers
       the grid somebody opened the launcher to READ. Keyed on the pointer
       rather than on the width: what decides this is whether focusing costs
       a keyboard, and that is a property of the input device. */
    if (window.matchMedia?.('(pointer: fine)').matches !== false) {
      const id = requestAnimationFrame(() => inputRef.current?.focus())
      return () => cancelAnimationFrame(id)
    }
  }, [open])

  useEffect(() => setCursor(0), [needle])

  /* The one close everything goes through. Calling `onClose` directly leaves
     the history entry the open pushed, so the next Back goes one page too far;
     the function this returns takes the entry with it. Escape, the button and
     the pull-down all use it. */
  const close = useOverlayHistory(open, onClose)

  /* THE ARROWS WALK THE GRID IN TWO DIMENSIONS.

     Left and right are the previous and next slot. Up and down are measured
     rather than counted: the tile nearest above or below the cursor's own
     position, by geometry, so the same keys work in a four-column band, an
     eight-column grid and across the seam between them without the component
     knowing how many columns the stylesheet chose today. Where there is no
     geometry (a test runner has no layout) they fall back to one step. */
  const stepVertical = useCallback((from: number, dir: 1 | -1): number => {
    const list = listRef.current
    if (!list) return from
    const tiles = Array.from(list.querySelectorAll<HTMLElement>('[data-slot]'))
    const cur = tiles.find((el) => Number(el.dataset.slot) === from)
    if (!cur) return from
    const a = cur.getBoundingClientRect()
    if (a.width === 0 && a.height === 0) {
      return Math.max(0, Math.min(slots.length - 1, from + dir))
    }
    const ax = a.left + a.width / 2
    let best: { i: number; dy: number; dx: number } | null = null
    for (const el of tiles) {
      const b = el.getBoundingClientRect()
      const dy = dir === 1 ? b.top - a.top : a.top - b.top
      if (dy < 2) continue
      const dx = Math.abs(b.left + b.width / 2 - ax)
      if (!best || dy < best.dy - 1 || (Math.abs(dy - best.dy) <= 1 && dx < best.dx)) {
        best = { i: Number(el.dataset.slot), dy, dx }
      }
    }
    return best ? best.i : from
  }, [slots.length])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (menuFor) setMenuFor(null)
        else close()
        return
      }
      const target = e.target as HTMLElement | null
      /* The "…" and its menu are ordinary buttons; Enter there is theirs. */
      if (target?.closest?.('.lch-more, .lch-menu')) return
      if (!slots.length) return
      const inInput = target === inputRef.current
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        /* In a field with text in it, left and right belong to the caret. */
        if (inInput && q.length) return
        e.preventDefault()
        const d = e.key === 'ArrowRight' ? 1 : -1
        setCursor((c) => (c + d + slots.length) % slots.length)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor((c) => stepVertical(c, e.key === 'ArrowDown' ? 1 : -1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const pick = slots[cursor]
        if (pick) go(pick.r)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, slots, cursor, go, close, menuFor, q.length, stepVertical])

  // Keep the cursor in view when it walks past the fold.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-cursor="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [cursor, needle])

  /* A SHEET, NOT A SWITCH.

     Opened from the dock, it rises a little and fades in over 200ms, and
     leaves the same way. Opened by the swipe on the board it is somewhere
     else entirely: exactly where the drag has it while the finger is down,
     with no transition at all — a transition during a drag is lag — and
     eased the rest of the way once the decision is made.

     Mounted from the first pixel of a drag and kept mounted until the exit
     has finished, which is why `open` alone no longer decides whether it
     renders. */
  const dragging = drag !== null && !open

  /* THE SAME GESTURE, BACKWARDS.

     Pulling the sheet down takes it down: the finger drags, the panel
     follows exactly, and on release it either finishes leaving or springs
     back. The pull is only recognised when the sheet's own list is scrolled
     to the top — otherwise a downward finger is scrolling the list.

     `pull` is 0..1 of the sheet's height, written to the same transform the
     open-drag uses, so the two directions are one mechanism. */
  const sheetRef = useRef<HTMLDivElement>(null)
  const [pull, setPull] = useState(0)
  const pullStart = useRef<{ y: number; live: boolean } | null>(null)
  /* Whether the exit should slide off the bottom rather than fade in place:
     true once a finger has had the sheet, so a cancelled swipe or a pull that
     commits finishes the journey it started instead of dissolving mid-air. */
  const exitDown = useRef(false)
  const onSheetTouchStart = (e: React.TouchEvent) => {
    if (!open || e.touches.length !== 1) return
    const el = sheetRef.current
    pullStart.current = { y: e.touches[0].clientY, live: !!el && el.scrollTop <= 0 }
  }
  const onSheetTouchMove = (e: React.TouchEvent) => {
    const st = pullStart.current
    if (!st || !st.live || e.touches.length !== 1) return
    const dy = e.touches[0].clientY - st.y
    const h = sheetRef.current?.clientHeight || window.innerHeight
    if (dy <= 0) { setPull(0); return }
    setPull(Math.min(1, dy / h))
  }
  const onSheetTouchEnd = () => {
    const st = pullStart.current
    pullStart.current = null
    if (!st || !st.live) return
    /* A fifth of the way is a decision; less is a wobble. The same
       proportion the up-swipe commits at, so the two feel like one hinge. */
    if (pull > 0.2) {
      exitDown.current = true
      setPull(0)
      close()
      return
    }
    setPull(0)
  }
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(open)
  /* Written during render on purpose: the very next render after a drag
     ends is the one that must already know the sheet came from a finger,
     and an effect would tell it a frame late. */
  const cameFromDrag = useRef(false)
  if (dragging) {
    cameFromDrag.current = true
    exitDown.current = true
  }
  useLayoutEffect(() => {
    if (open) {
      setMounted(true)
      exitDown.current = false
      if (cameFromDrag.current) {
        /* The sheet is already mid-way and painted; the transition has its
           starting point, so it can go straight to shown. Waiting two frames
           here would paint it at the bottom first — a visible drop. */
        cameFromDrag.current = false
        setShown(true)
        return
      }
      // Two frames: one for the mount to paint at its start, one for the
      // transition to have somewhere to start from.
      let inner = 0
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setShown(true))
      })
      return () => {
        cancelAnimationFrame(outer)
        cancelAnimationFrame(inner)
      }
    }
    setShown(false)
    if (dragging) {
      setMounted(true)
      return
    }
    const tm = window.setTimeout(() => setMounted(false), still ? 0 : MOTION_MS)
    return () => window.clearTimeout(tm)
  }, [open, dragging, still])

  if (!mounted || !role) return null
  const pulling = pullStart.current !== null && pull > 0
  const transform = dragging
    ? `translate3d(0, ${(1 - (drag ?? 0)) * 100}%, 0)`
    : pulling
      ? `translate3d(0, ${pull * 100}%, 0)`
      : shown
        ? 'translate3d(0, 0, 0)'
        : `translate3d(0, ${exitDown.current ? '100%' : '24px'}, 0)`
  const sheet: CSSProperties = {
    transform,
    opacity: dragging || pulling || shown ? 1 : 0,
    transition: dragging || pulling || still
      ? 'none'
      : `transform ${MOTION_MS}ms var(--ease-out, ease), opacity ${MOTION_MS}ms var(--ease-out, ease)`,
    willChange: 'transform, opacity',
  }

  /* What every tile needs from the launcher, handed down as props — see the
     note on Tile for why it must not simply close over these. */
  const tileProps = {
    roleKey: role.key, pathname, cursor, setCursor, go, onPin,
    needle, menuFor, setMenuFor,
  }

  /* The two header controls. Both are mixed from `--ink-here`, which is by
     construction the colour this ground contrasts with. */
  const quiet =
    `flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[12.5px] transition-colors ` +
    `hover:bg-[color-mix(in_srgb,var(--ink-here)_12%,transparent)] focus-visible:outline-none ` +
    `focus-visible:ring-2 focus-visible:ring-[var(--ink-here)]`

  const indexOf = new Map(slots.map((s, i) => [s.id, i]))
  const draw = (list: Slot[], band = false) => (
    <div className={band ? 'lch-band' : 'lch-grid'}>
      {list.map((s) => (
        <Tile
          key={s.id}
          slot={s}
          index={indexOf.get(s.id) ?? -1}
          pinned={pinSet.has(s.r.key)}
          {...tileProps}
        />
      ))}
    </div>
  )

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('bento.launcher.title')}
      /* Frosted glass over the board, the way an iPhone's App Library sits
         over the wallpaper — see .bento-frost in bento-theme.css for why the
         saturation matters as much as the blur. */
      ref={sheetRef}
      onTouchStart={onSheetTouchStart}
      onTouchMove={onSheetTouchMove}
      onTouchEnd={onSheetTouchEnd}
      onTouchCancel={onSheetTouchEnd}
      className="lch bento-frost fixed inset-0 z-[60] overflow-y-auto overscroll-contain"
      /* THE INK IS CHOSEN BY THE SURFACE, AND EVERY SURFACE CHOOSES ITS OWN.

         This panel's ground is the PAGE and not a card, and `--bento-ink` is
         the card's ink. So the ink is derived from the ground it will sit on:
         black or white, whichever the ground is further from, by that
         ground's own lightness. `--ink-here` is redefined by each surface
         below — the page, a plate — and everything inside a surface reads
         it, so a word is always the ink of the thing it is printed on. */
      style={
        {
          ...sheet,
          '--ink-here': 'hsl(from var(--bento-bg) 0 0% clamp(0%, (49 - l) * 100%, 100%))',
          color: 'var(--ink-here)',
          /* Fixed to the viewport, so the body's padding for the notch does
             not reach this panel; in the iPhone app its header sat under the
             clock. Zero in a browser and on Android. */
          paddingTop: 'env(safe-area-inset-top, 0px)',
        } as CSSProperties
      }
      onClick={() => close()}
    >
      <div
        className="lch-body"
        onClick={(e) => {
          e.stopPropagation()
          if (menuFor) setMenuFor(null)
        }}
      >
        <div className="mb-5 flex items-baseline justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.08em]">{role.name}</p>
            <h2 className="text-[22px] font-semibold">{t('bento.launcher.title')}</h2>
          </div>
          <div className="flex items-center gap-1.5">
            {homeRow && (
              <button type="button" onClick={() => go(homeRow)} className={quiet}>
                <House className="size-3.5" aria-hidden="true" />
                {t('bento.dock.home')}
              </button>
            )}
            <button type="button" onClick={() => close()} className={quiet}>
              {t('bento.launcher.close')}
            </button>
          </div>
        </div>

        <div className="relative mb-7">
          {/* The glyph sits ON the field, not on the page, so it takes the
              card's ink rather than the page's. */}
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2
                       text-[var(--bento-ink)]"
            aria-hidden="true"
          />
          {/* The field is a card, so its words are the card's ink. Its edge
              is mixed from the ink rather than taken from `--bento-line`,
              which at 1.13:1 against the page left the one text input on the
              surface with no visible boundary at all. */}
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            type="search"
            autoComplete="off"
            placeholder={t('bento.launcher.filter', { count: String(rows.length) })}
            aria-label={t('bento.launcher.filter', { count: String(rows.length) })}
            className="inset-field w-full rounded-[12px] border
                       !border-[color-mix(in_srgb,var(--bento-ink)_45%,transparent)]
                       bg-[var(--bento-card)] py-2.5 pl-10 pr-3.5 text-[13.5px]
                       text-[var(--bento-ink)] focus-visible:outline-none focus-visible:ring-2
                       focus-visible:ring-[var(--bento-ink)]"
          />
        </div>

        <div ref={listRef}>
          {needle ? (
            results.length ? (
              <section className="lch-section" data-band="results">
                <Label icon={Search} label={t('bento.launcher.results', { count: String(results.length) })} />
                {draw(slots)}
                <p className="mt-6 flex items-center gap-1.5 text-[11.5px] opacity-80">
                  <CornerDownLeft className="size-3" aria-hidden="true" />
                  {t('bento.launcher.grid_hint')}
                </p>
              </section>
            ) : (
              <p className="py-10 text-center text-[13.5px] opacity-80">
                {t('bento.launcher.empty', { q: q.trim() })}
              </p>
            )
          ) : (
            <>
              {pinned.length > 0 && (
                <section className="lch-section" data-band="pinned">
                  <Label icon={Pin} label={t('bento.launcher.pinned')} />
                  {draw(slots.filter((s) => s.id.startsWith('pin:')))}
                </section>
              )}
              {recents.length > 0 && (
                <section className="lch-section" data-band="recent">
                  <Label icon={Clock} label={t('bento.launcher.recent')} />
                  {draw(slots.filter((s) => s.id.startsWith('recent:')), true)}
                </section>
              )}
              {groups.map((g) => {
                const Mark = markFor(g.name)
                return (
                  <section key={g.name} className="lch-section" data-band="all" data-workspace={g.name}>
                    <Label icon={Mark} label={g.name} tint={hueFor(g.name)} />
                    {draw(slots.filter((s) => s.id.startsWith('all:') && s.r.workspace === g.name))}
                  </section>
                )
              })}
            </>
          )}
        </div>

        <div className="lch-live" role="status" aria-live="polite">{note}</div>
      </div>
    </div>
  )
}

/* DECLARED HERE, AT MODULE SCOPE, AND NOT INSIDE THE LAUNCHER'S RENDER.

   It used to be a const inside BentoLauncher's body, which made it a new
   component TYPE on every render of the launcher. React does not reconcile
   across a change of type: every tile was unmounted and a fresh one mounted
   in its place, on every render.

   That is why "Recently opened" did nothing on the iPhone. The band sits at
   the top of the sheet, which is the one place the pull-down gesture is armed,
   and a finger that is tapping still drifts a pixel between touchstart and
   touchend. The pixel reached onSheetTouchMove, which set `pull`, which
   re-rendered the launcher, which threw away the button under the finger. By
   the time the browser went to dispatch the click, its target was no longer in
   the document, and WebKit dispatches nothing to a detached node.

   Everything the tile used to close over arrives as props instead, so the
   type is stable and a re-render is a re-render. BentoLauncher.test.tsx
   guards this. */

/* How long a finger rests before it is a hold rather than a tap, and how far
   it may drift before it is a scroll. */
const HOLD_MS = 450
const HOLD_SLOP = 10

function Tile({
  slot, index, pinned, roleKey, pathname, cursor, setCursor, go, onPin,
  needle, menuFor, setMenuFor,
}: {
  slot: Slot
  index: number
  pinned: boolean
  roleKey: string
  pathname: string
  cursor: number
  setCursor: (i: number) => void
  go: (r: Row) => void
  onPin: (r: Row) => void
  needle: string
  menuFor: string | null
  setMenuFor: (id: string | null) => void
}) {
  const t = useT()
  const { r, context } = slot
  const href = featurePath(roleKey, r.sectionSlug, r.slug)
  const here = pathname === href
  const onCursor = index === cursor
  const menuOpen = menuFor === slot.id
  const Mark = markFor(r.workspace)
  const hue = hueFor(r.workspace)
  const menuRef = useRef<HTMLButtonElement>(null)

  /* THE LONG PRESS.

     A phone has no hover to reveal a "…" on, and a second target beside a
     56px plate is a mis-tap. So holding the tile is how it is pinned there:
     the timer starts on touch, a drift of more than a few pixels means the
     finger is scrolling and stands it down, and lifting before it fires is
     the tap it always was. When it does fire, the click that follows the
     lift is swallowed — a hold that also opened the feature would be a
     hold nobody could use. */
  const hold = useRef<number | null>(null)
  const held = useRef(false)
  const at = useRef<{ x: number; y: number } | null>(null)
  const clearHold = () => {
    if (hold.current !== null) {
      window.clearTimeout(hold.current)
      hold.current = null
    }
  }
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return
    held.current = false
    at.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    clearHold()
    hold.current = window.setTimeout(() => {
      hold.current = null
      held.current = true
      onPin(r)
    }, HOLD_MS)
  }
  const onTouchMove = (e: React.TouchEvent) => {
    const a = at.current
    if (!a || e.touches.length !== 1) return
    const dx = e.touches[0].clientX - a.x
    const dy = e.touches[0].clientY - a.y
    if (Math.abs(dx) > HOLD_SLOP || Math.abs(dy) > HOLD_SLOP) clearHold()
  }
  const onTouchEnd = () => {
    clearHold()
    at.current = null
  }
  useEffect(() => clearHold, [])

  useEffect(() => {
    if (menuOpen) menuRef.current?.focus()
  }, [menuOpen])

  const pieces = splitMatch(r.name, needle)

  return (
    <div className="lch-cell" data-key={r.key}>
      <button
        type="button"
        data-slot={index}
        data-cursor={onCursor ? 'true' : undefined}
        aria-current={here ? 'page' : undefined}
        aria-label={pinned ? `${r.name} · ${t('bento.launcher.pinned')}` : undefined}
        className="lch-app"
        onClick={() => {
          if (held.current) { held.current = false; return }
          go(r)
        }}
        onMouseEnter={() => setCursor(index)}
        onFocus={() => setCursor(index)}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        /* A right-click is the desk's long press: it opens the same one-item
           menu the "…" does, and never the browser's. */
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuFor(menuOpen ? null : slot.id)
        }}
      >
        {/* The plate: a round disc tinted 14% from the workspace colour on
            the theme's paper, and the feature's Material Symbol in the
            workspace colour. Every feature has one -- see feature-icons.tsx,
            whose test fails the day a slug does not -- so no plate ever
            falls back to two letters. The workspace's own mark sits in the
            corner so a tile still says which family it is once the eye has
            left the heading. */}
        <FeatureGlyph
          slug={r.slug}
          section={r.sectionSlug}
          tint={hue}
          className="lch-plate"
          style={{ '--size': 'var(--lch-plate)' } as CSSProperties}
        >
          <span className="lch-plate-mark" title={r.workspace}>
            <Mark aria-hidden="true" />
          </span>
          {pinned && (
            <span className="lch-pinmark">
              <Pin aria-hidden="true" />
            </span>
          )}
        </FeatureGlyph>
        <span className="lch-name">
          {pieces.map((p, i) =>
            p.hit ? <mark key={i} className="lch-hl">{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>,
          )}
          {/* Where it belongs, said only where that is not already obvious:
              recents and results are drawn from everywhere at once. Under a
              workspace label the label has just said it. */}
          {context && <span className="lch-where">{r.workspace}</span>}
        </span>
      </button>

      <button
        type="button"
        className="lch-more"
        aria-label={t('bento.launcher.more_for', { name: r.name })}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(e) => {
          e.stopPropagation()
          setMenuFor(menuOpen ? null : slot.id)
        }}
      >
        <Ellipsis aria-hidden="true" />
      </button>
      {menuOpen && (
        <div className="lch-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <button
            ref={menuRef}
            type="button"
            role="menuitem"
            onClick={() => onPin(r)}
          >
            {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
            {t(pinned ? 'bento.launcher.unpin' : 'bento.launcher.pin')}
          </button>
        </div>
      )}
    </div>
  )
}

/** One label treatment for every band, so pinned, recents, results and
    workspaces read as the same kind of thing rather than four inventions.
    Quiet on purpose: the tiles are the content. */
function Label({ icon: Icon, label, tint }: { icon: typeof Home; label: string; tint?: string }) {
  return (
    <h3
      className="lch-label"
      /* The category's own colour, where there is a category. Pinned,
         recents and results are ways of gathering features rather than
         families of them, so they keep the quiet ink and only a workspace
         heading is coloured -- which is the whole of what colour now says on
         this screen. */
      style={tint ? ({ '--t': `var(--dom-${tint}, hsl(var(--primary)))` } as CSSProperties) : undefined}
      data-tinted={tint ? '' : undefined}
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </h3>
  )
}
