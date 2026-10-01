import { useOverlayHistory } from '@/lib/overlay-history'
import {
  Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties,
} from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Home, GraduationCap, Users, Wallet, BookOpen, MessageSquare, ClipboardList,
  BarChart3, Bus, Settings2, ShieldCheck, CalendarDays, Boxes, Clock, Search,
  CornerDownLeft, House, Pin, PinOff, Ellipsis, X, Sparkles, History,
  Activity, Banknote, Bot, Building2, CalendarCheck, CircleUser, CreditCard, LayoutGrid,
  FileCheck2, FileText, FolderTree, Handshake, KeyRound, Landmark,
  LibraryBig, LifeBuoy, ListChecks, Presentation, Server,
  Wrench,
  Baby, NotebookPen, Receipt, PiggyBank, HandCoins, IdCard, Contact, ConciergeBell, Lock,
  LayoutDashboard, Cog, BedDouble, Briefcase, School as SchoolIcon, UserCog, ListTodo, SlidersHorizontal,
  Compass, Shapes, Puzzle, Layers, Flag, Star, Gem, Leaf, Feather, Anchor, Globe, Lightbulb, Target,
  Trophy, Palette, Music, Microscope, Utensils, HeartPulse, Shirt, Warehouse, Store,
} from 'lucide-react'
import { useActiveRole, featurePath, usable } from '@/lib/catalog'
import { useT } from '@/lib/i18n'
import { useRecents } from '@/lib/recents'
import { FeatureGlyph } from '@/components/FeatureGlyph'
import { usePins, togglePin } from '@/lib/pins'
import { useShortcuts, toggleDashboard } from '@/lib/shortcuts'
import { createPortal } from 'react-dom'
import { usePhone } from '@/lib/viewport'
import { cn } from '@/lib/utils'
import { buzz } from '@/lib/haptics'
import { useReduceMotion } from './bento-kit'
import {
  buildIndex, rank, readRecentSearches, recordRecentSearch, type SearchHit,
} from '@/lib/search/feature-search'
import { askAssistant } from '@/components/assistant/agent'
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
  /* ONE ICON, ONE WORKSPACE (owner, 2026-09-28: "no icon in the dock should
     be the same"). Every name below has a glyph of its own; nothing here is
     shared, and uniqueMarks() below settles any clash that a new, unmapped
     workspace could still cause. */
  Home,
  Students: GraduationCap,
  'My Child': Baby,
  Academics: BookOpen,
  Examinations: ClipboardList,
  Assessments: FileCheck2,
  Timetable: CalendarDays,
  'Attendance & Leave': CalendarCheck,
  'My Classes': Presentation,
  Teaching: NotebookPen,
  Finance: Wallet,
  Fees: Receipt,
  Accounts: Landmark,
  'Banking & Reports': PiggyBank,
  'Campus Money': Banknote,
  Payroll: HandCoins,
  'Subscriptions & Billing': CreditCard,
  Staff: Users,
  Employees: IdCard,
  People: Contact,
  Communication: MessageSquare,
  Admissions: Handshake,
  'Front Desk': ConciergeBell,
  Requests: ListChecks,
  Support: LifeBuoy,
  Administration: ShieldCheck,
  Entitlements: KeyRound,
  'Access & Security': Lock,
  Reports: BarChart3,
  Dashboard: LayoutDashboard,
  'Usage & Health': Activity,
  Operations: Cog,
  Transport: Bus,
  Hostel: BedDouble,
  Stores: Boxes,
  Library: LibraryBig,
  'AI & Automation': Bot,
  Customers: Briefcase,
  School: SchoolIcon,
  Schools: Building2,
  'Department Workspace': FolderTree,
  'My Profile': CircleUser,
  Profile: UserCog,
  'My Work': ListTodo,
  'Institution Setup': Wrench,
  'Platform Setup': Server,
  'Platform Configuration': SlidersHorizontal,
  Setup: Settings2,
  Documents: FileText,
}

export function markFor(workspace: string) {
  /* An unmapped workspace gets a glyph from a pool, chosen by its name so it
     is the same every time; never LayoutGrid (All features) or Inbox. */
  return WORKSPACE_ICON[workspace] ?? POOL[hashName(workspace) % POOL.length]
}

const POOL: (typeof Home)[] = [Compass, Shapes, Puzzle, Layers, Flag, Star, Gem, Leaf, Feather, Anchor, Globe, Lightbulb, Target, Trophy, Palette, Music, Microscope, Utensils, HeartPulse, Shirt, Warehouse, Store]
function hashName(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

/** Icons for a row of workspaces with no two alike: a clash takes the next
    free glyph from the pool. Also never repeats the icons the caller already
    shows beside them (the dock's Home, Inbox and All features). */
export function uniqueMarks(names: string[], reserved: (typeof Home)[] = []): (typeof Home)[] {
  const used = new Set<typeof Home>(reserved)
  return names.map((n) => {
    let m = markFor(n)
    if (used.has(m)) {
      const start = hashName(n) % POOL.length
      for (let i = 0; i < POOL.length; i++) {
        const c = POOL[(start + i) % POOL.length]
        if (!used.has(c)) { m = c; break }
      }
    }
    used.add(m)
    return m
  })
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

/** The name cut around the ranker's runs, in order, so the matched letters
    can be set a shade bolder: "s360" bolds the S and the 360 of Student 360. */
export function splitRuns(name: string, runs?: [number, number][]): { text: string; hit: boolean }[] {
  if (!runs?.length) return [{ text: name, hit: false }]
  const out: { text: string; hit: boolean }[] = []
  let at = 0
  for (const [a, b] of runs) {
    if (a > at) out.push({ text: name.slice(at, a), hit: false })
    if (b > a) out.push({ text: name.slice(a, b), hit: true })
    at = Math.max(at, b)
  }
  if (at < name.length) out.push({ text: name.slice(at), hit: false })
  return out
}

interface Row {
  key: string
  name: string
  section: string
  sectionSlug: string
  slug: string
  workspace: string
  summary: string
}

/* RANKED, NOT MERELY FILTERED -- and not merely by substring.

   The ranking lives in lib/search/feature-search.ts and is unit-tested
   there: exact > prefix > alias > word-start > phrase > initials > anywhere
   > section > fuzzy thread > one-edit typo > description, with recents and
   pins lifting a tie. "s360" finds Student 360, "fee def" finds Fee
   defaulters, "attnd" finds Attendance and "bus" finds Transport. This file
   only decides how many to draw and how. */

/** How many results are drawn. Twelve is three rows on a phone and under two
    at a desk: a list you can read, not a second catalogue. The count still
    says how many matched. */
const RESULT_LIMIT = 12

/** What the empty state offers to try: words every school has a screen for. */
const SUGGESTIONS = ['attendance', 'fees', 'timetable']

/* One place on the surface where a feature is drawn. A feature can be drawn
   up to three times — pinned, recent, and under its workspace — and the
   keyboard cursor walks PLACES, so each gets an id of its own. */
interface Slot {
  id: string
  r: Row
  /** Say where it belongs under the name (recents and results, which are
      drawn from everywhere at once). */
  context: boolean
  /** Which characters of the name the search matched, as [start, end). */
  runs?: [number, number][]
  /** Position in the staggered pop-in, for the first dozen results. */
  pop?: number
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
  /* What this person has put on their own dashboard. Read here so the menu can
     say "remove" as readily as "add" -- a toggle that only ever offers one
     direction is a control somebody presses twice to find out what it does. */
  const dashKeys = useShortcuts()
  const still = useReduceMotion()
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  /* The slot whose "…" menu is open, if any. */
  const [menuFor, setMenuFor] = useState<string | null>(null)
  /* What a screen reader is told after a pin or a home shortcut is made
     from the menu. */
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
          summary: f.summary ?? '',
        })
      }
    }
    return out
  }, [role])

  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows])

  const needle = q.trim().toLowerCase()

  /* Indexed once per role (everything lowercased at index time), ranked on
     every keystroke with no debounce: a few hundred string comparisons is
     well under a frame, and a search that answers a keystroke late feels
     broken in a way no animation can hide. */
  const index = useMemo(() => buildIndex(rows), [rows])
  const hits = useMemo<SearchHit<Row>[]>(
    () => (needle ? rank(index, needle, { recent: recentKeys, pinned: pinKeys }) : []),
    [index, needle, recentKeys, pinKeys],
  )
  const results = useMemo(() => hits.slice(0, RESULT_LIMIT).map((h) => h.doc), [hits])

  /* Both filtered through the catalogue, so a feature this account has since
     lost access to simply disappears rather than 404ing on tap. */
  /* FOUR ON A PHONE, SEVEN AT A DESK.

     The recents band drew every key the store held -- eight -- above the
     workspaces. On a phone that is two full rows of tiles before the first
     workspace heading, on a sheet a thumb scrolls; the band exists to save a
     scroll, not to be one. Four is one row on a phone and seven is one row
     at a desk, so the band is always a single row of "where you were" and
     the catalogue starts where the eye already is. The store keeps eight
     either way; this is what the sheet shows of it. */
  const phone = usePhone()
  const recents = useMemo(
    () => recentKeys.map((k) => byKey.get(k)).filter((r): r is Row => !!r).slice(0, phone ? 4 : 7),
    [recentKeys, byKey, phone],
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
    if (needle) {
      /* No "where it belongs" under a result: the group heading above it
         has just said so, and the line it took is the name's second line. */
      return hits.slice(0, RESULT_LIMIT).map((h, i) => ({ id: `q:${h.doc.key}`, r: h.doc, context: false, runs: h.runs, pop: i }))
    }
    return [
      ...pinned.map((r) => ({ id: `pin:${r.key}`, r, context: false })),
      ...recents.map((r) => ({ id: `recent:${r.key}`, r, context: true })),
      ...groups.flatMap((g) => g.rows.map((r) => ({ id: `all:${r.key}`, r, context: false }))),
    ]
  }, [needle, hits, pinned, recents, groups])

  /* RESULTS, GROUPED BY WORKSPACE, BEST FIRST.

     The groups are in the order their best member ranked, and the members
     keep their rank inside the group, so slot 0 -- the one Enter opens -- is
     the first tile of the first group. On a phone the groups are drawn
     bottom-up: the best group sits right above the search pill, within a
     thumb's reach of the keyboard, and the rest stack away from it. */
  const resultGroups = useMemo(() => {
    const out: { name: string; slots: Slot[] }[] = []
    if (!needle) return out
    for (const s of slots) {
      let g = out.find((x) => x.name === s.r.workspace)
      if (!g) { g = { name: s.r.workspace, slots: [] }; out.push(g) }
      g.slots.push(s)
    }
    return out
  }, [needle, slots])

  /* The last five searches, kept in this browser, offered while the field is
     focused and empty: the search somebody made yesterday is the search they
     are about to make again. */
  const [focused, setFocused] = useState(false)
  const [recentSearches, setRecentSearches] = useState<string[]>(() => readRecentSearches())

  /* The way home, from the panel that lists everywhere else. It resolves to
     the role's first opening feature, exactly as the dock's Home does — the
     same rule in both places, because two different answers to "where is
     home" would be worse than none. */
  const homeRow = rows[0]

  const go = useCallback(
    (r: Row) => {
      if (!role) return
      if (needle) setRecentSearches(recordRecentSearch(q))
      navigate(featurePath(role.key, r.sectionSlug, r.slug))
      onClose()
    },
    [navigate, onClose, role, needle, q],
  )

  /* The question goes to the assistant as typed (AssistantTab listens for
     the event), and the sheet gets out of its way. */
  const ask = useCallback(() => {
    const s = q.trim()
    if (!s) return
    setRecentSearches(recordRecentSearch(s))
    askAssistant(s)
    onClose()
  }, [q, onClose])

  const onPin = useCallback(
    (r: Row) => {
      const now = togglePin(r.key)
      setNote(t(now ? 'bento.launcher.pinned_note' : 'bento.launcher.unpinned_note', { name: r.name }))
      setMenuFor(null)
    },
    [t],
  )

  /* ON THE DASHBOARD, WHICH IS NOT THE SAME AS PINNED.
   *
   * A pin keeps a feature at the top of THIS screen -- the launcher, which
   * somebody opens on purpose. A dashboard shortcut puts it on the page they
   * land on, so they never open the launcher at all. A registrar pins
   * Admissions because it is where they work, and puts Fee Collection on the
   * dashboard because they want it on the way past.
   *
   * Same gesture, same menu, its own list. See lib/shortcuts.ts. */
  const onDashboard = useCallback(
    (r: Row) => {
      const now = toggleDashboard(r.key)
      setNote(
        now
          ? `${r.name} is on your home`
          : `${r.name} is off your home`,
      )
      setMenuFor(null)
    },
    [],
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

  /* The pill rides above an on-screen keyboard: iOS overlays the keyboard
     on the layout viewport, so the gap is what visualViewport lost. And
     Cmd/Ctrl+K while the sheet is open goes to this field, not to the
     command search behind it. */
  useEffect(() => {
    if (!open) return
    const vv = window.visualViewport
    const sheet = sheetRef.current
    const kb = () => {
      if (!vv || !sheet) return
      const gap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      sheet.style.setProperty('--lch-kb', `${Math.round(gap)}px`)
    }
    kb()
    vv?.addEventListener('resize', kb)
    vv?.addEventListener('scroll', kb)
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopImmediatePropagation()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      vv?.removeEventListener('resize', kb)
      vv?.removeEventListener('scroll', kb)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

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
        /* One step back at a time: the menu, then the query, then the sheet.
           A query somebody typed is work; the first Escape must not throw
           the whole sheet away with it. */
        if (menuFor) setMenuFor(null)
        else if (q) { e.preventDefault(); setQ('') }
        else close()
        return
      }
      const target = e.target as HTMLElement | null
      /* The "…" and its menu are ordinary buttons; Enter there is theirs. */
      if (target?.closest?.('.lch-more, .lch-menu')) return
      if (!slots.length) {
        /* Nothing matched: Enter hands the words to the assistant, which is
           the row the empty state offers. */
        if (e.key === 'Enter' && needle) { e.preventDefault(); ask() }
        return
      }
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
  }, [open, slots, cursor, go, close, menuFor, q, needle, ask, stepVertical])

  /* ON A PHONE THE RESULTS SIT ON THE KEYBOARD. The sheet is scrolled to its
     foot whenever the results change, so the best group is right above the
     pill and the thumb never has to travel up the glass to reach it. */
  useEffect(() => {
    if (!phone || !needle) return
    const el = sheetRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [phone, needle, results.length])

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
    roleKey: role.key, pathname, cursor, setCursor, go, onPin, onDashboard, dashKeys,
    menuFor, setMenuFor,
  }

  /* The two header controls. Both are mixed from `--ink-here`, which is by
     construction the colour this ground contrasts with. */
  const quiet =
    `flex items-center gap-1.5 whitespace-nowrap rounded-[10px] px-3 py-1.5 text-[12.5px] transition-colors ` +
    `bg-[color-mix(in_srgb,var(--ink-here)_8%,transparent)] ` +
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
      onClick={() => {
        /* A tap outside with a query typed puts the keyboard away and keeps
           the query; only an empty sheet closes on a tap through. */
        if (q) { inputRef.current?.blur(); return }
        close()
      }}
    >
      <div
        className="lch-body"
        onClick={(e) => {
          e.stopPropagation()
          if (menuFor) setMenuFor(null)
        }}
      >
        {/* The header is ruled off from the field below it. A title sitting on
            nothing, at the top of a sheet that is otherwise all tiles, was the
            page's one piece of chrome with no weight behind it. */}
        <div
          className="mb-5 flex flex-wrap items-baseline justify-between gap-4 border-b
                     border-[color-mix(in_srgb,var(--ink-here)_10%,transparent)] pb-4"
        >
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.08em] opacity-80">{role.name}</p>
            <h2 className="text-[23px] font-semibold tracking-[-0.01em]">
              {t('bento.launcher.title')}
            </h2>
          </div>
          <div className="flex items-center gap-1.5">
            {homeRow && (
              <button type="button" onClick={() => go(homeRow)} className={quiet}>
                <House className="size-4" strokeWidth={2.25} aria-hidden="true" />
                {t('bento.dock.home')}
              </button>
            )}
            <button type="button" onClick={() => close()} className={quiet}>
              {t('bento.launcher.close')}
            </button>
          </div>
        </div>

        <div ref={listRef} className={cn(needle && phone && 'lch-list--up')}>
          {needle ? (
            results.length ? (
              /* Keyed by the query so every keystroke pops the new answer in
                 afresh: each tile rises from 96% and fades in, 20ms after the
                 one before it, best first. Transform and opacity only, and
                 nothing at all under reduced motion (launcher.css). */
              <section
                key={needle}
                className={cn('lch-section lch-results', !still && 'lch-pop')}
                data-band="results"
                aria-live="polite"
              >
                <Label
                  icon={Search}
                  label={
                    hits.length > results.length
                      ? `${results.length} of ${hits.length} ${t('bento.launcher.results', { count: '' }).trim()}`
                      : t('bento.launcher.results', { count: String(hits.length) })
                  }
                />
                {(phone ? [...resultGroups].reverse() : resultGroups).map((g) => (
                  <div key={g.name} className="lch-rgroup" data-workspace={g.name}>
                    <p className="lch-rgroup__name" style={{ '--t': `var(--dom-${hueFor(g.name)}, currentColor)` } as CSSProperties}>
                      <span className="lch-dot" aria-hidden="true" />
                      {g.name}
                    </p>
                    {draw(g.slots)}
                  </div>
                ))}
                {!phone && (
                  <p className="mt-4 flex items-center gap-1.5 text-[11.5px] opacity-80">
                    <CornerDownLeft className="size-3" aria-hidden="true" />
                    {t('bento.launcher.grid_hint')}
                  </p>
                )}
              </section>
            ) : (
              <section key={needle} className={cn('lch-section lch-empty', !still && 'lch-pop')} data-band="empty">
                <p className="lch-empty__title">{t('bento.launcher.empty', { q: q.trim() })}</p>
                <p className="lch-empty__try">
                  <span>Try:</span>
                  {SUGGESTIONS.map((w) => (
                    <button key={w} type="button" className="lch-chip" onClick={() => { setQ(w); inputRef.current?.focus() }}>
                      {w}
                    </button>
                  ))}
                </p>
                {/* The words typed were a question the catalogue cannot
                    answer; the assistant can. Enter does the same. */}
                <button type="button" className="lch-ask" data-cursor="true" onClick={ask}>
                  <Sparkles aria-hidden="true" />
                  <span className="min-w-0 truncate">Ask the assistant: “{q.trim()}”</span>
                  <CornerDownLeft className="lch-ask__key" aria-hidden="true" />
                </button>
              </section>
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
        {/* THE SEARCH FLOATS AT THE FOOT (owner, 2026-10-01): a round pill
            like the dock, centred, sticky to the bottom of the sheet so the
            results scroll above it, lifted over the safe area and over the
            on-screen keyboard (--lch-kb, from visualViewport). */}
        <div className="lch-searchbar">
          {/* Recent searches, while the field is focused and empty: a row of
              chips just above the pill, newest first. mousedown is swallowed
              so the chip's click lands before the field loses focus. */}
          {focused && !q && recentSearches.length > 0 && (
            <div className={cn('lch-recentq', !still && 'lch-pop')} onMouseDown={(e) => e.preventDefault()}>
              {recentSearches.map((sq, i) => (
                <button
                  key={sq}
                  type="button"
                  className="lch-chip"
                  style={{ '--i': i } as CSSProperties}
                  onClick={() => { setQ(sq); inputRef.current?.focus() }}
                >
                  <History aria-hidden="true" />
                  {sq}
                </button>
              ))}
            </div>
          )}
          {/* The glyph sits ON the field, not on the page, so it takes the
              card's ink rather than the page's. It is a real button that
              drops the cursor in the field. */}
          <button
            type="button"
            tabIndex={-1}
            onClick={() => inputRef.current?.focus()}
            aria-label={t('bento.launcher.filter', { count: String(rows.length) })}
            className="absolute bottom-2 left-2 flex h-8 w-8 items-center
                       justify-center rounded-full text-[var(--ink-here)] transition-colors
                       hover:bg-[color-mix(in_srgb,var(--ink-here)_10%,transparent)]
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-here)]"
          >
            <Search className="size-4" aria-hidden="true" />
          </button>
          {/* The clear, inside the pill on the right: one fat tap empties the
              field and keeps the keyboard up for the next word. */}
          {q && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setQ(''); inputRef.current?.focus() }}
              aria-label={t('bento.launcher.clear')}
              className="lch-clear absolute bottom-2 right-2 flex h-8 w-8 items-center
                         justify-center rounded-full text-[var(--ink-here)] transition-colors
                         hover:bg-[color-mix(in_srgb,var(--ink-here)_10%,transparent)]
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink-here)]"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
          {/* The field is a card, so its words are the card's ink. Its edge
              is mixed from the ink rather than taken from `--bento-line`,
              which at 1.13:1 against the page left the one text input on the
              surface with no visible boundary at all. */}
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            type="search"
            autoComplete="off"
            placeholder={t('bento.launcher.filter', { count: String(rows.length) })}
            aria-label={t('bento.launcher.filter', { count: String(rows.length) })}
            className="lch-searchbar__input bg-transparent"
          />
        </div>

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
  slot, index, pinned, roleKey, pathname, cursor, setCursor, go, onPin, onDashboard, dashKeys,
  menuFor, setMenuFor,
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
  onDashboard: (r: Row) => void
  dashKeys: string[]
  menuFor: string | null
  setMenuFor: (id: string | null) => void
}) {
  const phone = usePhone()
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
      /* THE HOLD OPENS THE MENU, IT DOES NOT PIN.

         A long-press used to toggle the pin outright -- one gesture, one
         outcome, with no visible menu to say which. That made the second
         thing a person can do from here, put the feature on their home
         board, unreachable on a phone: the "…" that offers it is hidden
         where the pointer is a finger, on purpose, and there was nothing
         else. So the hold now opens the same two-item menu the "…" and a
         right-click open on a desk: Pin, and Add to home. Same menu, same
         order, every input. */
      buzz('select')
      setMenuFor(slot.id)
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

  const pieces = splitRuns(r.name, slot.runs)

  return (
    <div
      className="lch-cell"
      data-key={r.key}
      style={slot.pop !== undefined ? ({ '--i': slot.pop } as CSSProperties) : undefined}
    >
      <button
        type="button"
        data-slot={index}
        data-cursor={onCursor ? 'true' : undefined}
        aria-current={here ? 'page' : undefined}
        aria-label={pinned ? `${r.name} · ${t('bento.launcher.pinned')}` : undefined}
        className="lch-app"
        onClick={(e) => {
          if (held.current) {
            /* The click after a hold is swallowed -- and STOPPED. It used
               to be swallowed here and then bubble to the sheet body, whose
               own click closes any open menu; so the menu the hold had
               just opened was gone before the finger left the glass. */
            held.current = false
            e.stopPropagation()
            return
          }
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
      {menuOpen && (() => {
        const menu = (
          <div
            className={cn('lch-menu', phone && 'lch-menu--sheet')}
            role="menu"
            aria-label={t('bento.launcher.more_for', { name: r.name })}
            onClick={(e) => e.stopPropagation()}
          >
            {phone && <p className="lch-menu__title">{r.name}</p>}
            <button
              ref={menuRef}
              type="button"
              role="menuitem"
              onClick={() => onPin(r)}
            >
              {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
              {t(pinned ? 'bento.launcher.unpin' : 'bento.launcher.pin')}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => onDashboard(r)}
            >
              <LayoutGrid aria-hidden="true" />
              {dashKeys.includes(r.key) ? 'Remove from home' : 'Add to home'}
            </button>
          </div>
        )
        /* ON A PHONE THE MENU IS A SHEET, NOT A POPOVER.

           The popover hangs off the tile's top-right corner at 128px wide,
           and a launcher tile on a phone is about 80px: the menu ran past
           the tile, past its neighbour, and was clipped by the grid's own
           overflow -- "Pin" visible, "Add to home" cut off. A portal to the
           body, fixed to the bottom edge under a scrim, is the shape every
           phone uses for a long-press menu, and it is clipped by nothing. */
        if (!phone) return menu
        return createPortal(
          <>
            <div className="lch-menu-scrim" onClick={() => setMenuFor(null)} aria-hidden="true" />
            {menu}
          </>,
          document.body,
        )
      })()}
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
      /* The fallback is the ink already on the heading, not a named colour:
          this file states every tone as a token or a mix, and the one hsl()
          left in it was failing the test that says so. */
      style={tint ? ({ '--t': `var(--dom-${tint}, currentColor)` } as CSSProperties) : undefined}
      data-tinted={tint ? '' : undefined}
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </h3>
  )
}
