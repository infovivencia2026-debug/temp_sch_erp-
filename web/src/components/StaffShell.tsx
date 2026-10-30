import { useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { COMBOS, MOVES, comboOf } from '@/components/StaffCombos'
import { useQuery } from '@tanstack/react-query'
import {
  BookOpen, Bus, Images, CalendarClock, CalendarDays, ClipboardCheck, Contact, FileText, Home, Layers, LayoutGrid, ListChecks, MonitorCheck, Repeat2,
  Award, Bookmark, Briefcase, ChevronDown, ChevronRight, ChevronUp, Compass, Flag, GraduationCap, Megaphone, Puzzle, Shapes, Star,
  LogOut, Mail, MessageSquare, MessageSquareText, NotebookPen, Plane, Presentation, Settings2, UserRound, Users, Wallet, type LucideIcon,
} from 'lucide-react'
import { api } from '@/lib/api'
import { buzz } from '@/lib/haptics'
import { BentoSettings } from '@/features/bento/BentoSettings'
import { HelpButton } from '@/features/help/HelpEntry'
import { LayoutSwitch } from './LayoutSwitch'
import { usePhone } from '@/lib/viewport'
import { featurePath, type ApiSection } from '@/lib/catalog'
import { SIGN_INS_PATH, type TodaySignIns } from '@/lib/staff-layout'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { Button } from './ui'
import { PersonAvatar } from './ChatScreen'
import { CommandSearch } from './CommandSearch'
import Notifications from './Notifications'

/* THE STAFF LAYOUT (owner, 2026-10-19; per school, module_settings
   'staff_layout'). Only the presentation of the shell changes: the menu
   items, their permission filtering and the search are the ones Shell.tsx
   already builds. A text menu of collapsible groups, and one bar across the
   workspace with the greeting, the search and who is signed in. */

/** Today's sign-ins, the staff code and campus. Always called, fetched only when on. */
export function useTodaySignIns(on: boolean) {
  return useQuery({
    queryKey: ['me-sign-ins-today'],
    queryFn: () => api.get<TodaySignIns>(SIGN_INS_PATH),
    enabled: on, staleTime: 60_000, refetchInterval: on ? 5 * 60_000 : false, retry: false,
  })
}

/* Minimal line icons (owner, 2026-10-19: "use lined minimal icons"), chosen
   from what the group or screen is called; anything unmatched gets a plain grid, never a dot. */
const LINE_ICONS: [RegExp, LucideIcon][] = [
  [/home|today|dashboard|overview/, Home],
  [/timetable|calendar|schedule|period/, CalendarDays],
  [/attendance|absen|register/, ClipboardCheck],
  [/mark|grade|assessment|exam|result|report card|cce|question|paper/, FileText],
  [/teaching|teach|lesson/, Presentation],
  [/homework|assignment|classwork|submission/, NotebookPen],
  [/class|student|progress|360|behaviour|detail/, Users],
  [/remark|anecdot|ptm|note/, MessageSquareText],
  [/gallery/, Images],
  [/inbox|mail/, Mail],
  [/message|communication|chat|status|circular|notice|concern|complaint/, MessageSquare],
  [/leave/, Plane],
  [/pay|salary|fee|finance|account/, Wallet],
  [/task|work|approval/, ListChecks],
  [/profile|my |self/, UserRound],
  [/staff|teacher|hr|people/, Contact],
  [/library|book|lms|learn|course|syllabus/, BookOpen],
  [/transport|bus|route/, Bus],
  [/setting|setup|rule|config/, Settings2],
  [/substitut/, Repeat2],
  [/allocation/, Layers],
  [/meeting/, CalendarClock],
  [/online test|quiz/, MonitorCheck],
]
/* THE PILL MENU (Yajur, 2026-10-24, owner's designs): every top-level row is a
   rounded card with a round pastel badge and an arrow, and every one is
   unique -- its own hue and its own icon, so no two rows look alike. */
const PILL_HUES = [199, 160, 262, 38, 330, 347, 173, 239, 24, 142, 280, 210, 52, 0, 190, 300]
const SPARE_ICONS: LucideIcon[] = [Star, Compass, Bookmark, Flag, Shapes, Briefcase, GraduationCap, Megaphone, Award, Puzzle, LayoutGrid]
/** The matching icon not yet used in this menu, else the first unused spare. */
function uniqueIcon(name: string, used: Set<LucideIcon>): LucideIcon {
  const n = name.toLowerCase()
  const pick = LINE_ICONS.filter(([re]) => re.test(n)).map(([, I]) => I).find((I) => !used.has(I))
    ?? SPARE_ICONS.find((I) => !used.has(I)) ?? LayoutGrid
  used.add(pick)
  return pick
}
function PillBadge({ icon: Icon }: { icon: LucideIcon }) {
  return <span className="nav-pill__badge"><Icon aria-hidden strokeWidth={2} /></span>
}

export function LineIcon({ name, size = 16 }: { name: string; size?: number }) {
  const Icon = LINE_ICONS.find(([re]) => re.test(name.toLowerCase()))?.[1] ?? LayoutGrid
  // On a phone .nav-line-icon goes to 24px (index.css, owner 2026-10-24).
  return <Icon aria-hidden className="nav-line-icon shrink-0" style={{ width: size, height: size }} strokeWidth={1.75} />
}

/* v2: a group someone opened under the old open-by-default rule starts closed again. */
const groupKey = (slug: string) => `erp.navGroup.v2.${slug}`
/* Closed until opened (owner, 2026-10-19: "as default close all dropdowns"). */
function readOpen(slug: string): boolean {
  try { return localStorage.getItem(groupKey(slug)) === 'open' } catch { return false }
}

/* Open parent concerns passed to this teacher (Yajur, 2026-10-22: a number on
   My classes and on Concerns from parents, the way the bell has one). */
function useOpenConcerns(enabled: boolean): number {
  const q = useQuery({
    // The same cache as the Concerns from parents screen, so resolving one lowers the number at once.
    queryKey: ['concerns-from-parents'],
    enabled,
    refetchInterval: 60_000,
    queryFn: () => api.get<{ items: { status: string; my_note: string | null }[] }>('/api/v1/teaching/parent-concerns'),
  })
  return (q.data?.items ?? []).filter((t) => !['resolved', 'closed'].includes(t.status) && !t.my_note).length
}

function Count({ n }: { n: number }) {
  if (!n) return null
  return <span aria-label={`${n} open`} className="ml-auto min-w-[20px] shrink-0 rounded-full bg-destructive px-1.5 text-center text-[11px] font-semibold leading-5 text-destructive-foreground tabular-nums">{n}</span>
}

/** One rounded row inside a group; active = accent tint (also used by the Elements gallery). */
export function staffItemClass(on: boolean, live = true) {
  return cn(
    'flex min-h-[calc(44px*var(--font-scale,1))] max-sm:min-h-[calc(48px*var(--font-scale,1))] max-sm:text-[calc(16px*var(--font-scale,1))] items-center gap-3.5 rounded-[10px] px-3.5 py-2.5 text-[calc(14.5px*var(--font-scale,1))] transition-colors',
    on ? 'nav-pill__item--on font-bold' : 'font-medium text-muted-foreground hover:text-foreground',
    !live && !on && 'text-muted-foreground/70',
  )
}

/* `go`: pressing the head also lands on that screen and opens rather than
   closes (Home holding the workspace's other screens, owner 2026-10-24). */
export function StaffNavGroup({ slug, name, count = 0, hue = PILL_HUES[0], icon = LayoutGrid, go, children }: {
  slug: string; name: string; count?: number; hue?: number; icon?: LucideIcon; go?: string; children: React.ReactNode
}) {
  const [open, setOpen] = useState(() => readOpen(slug))
  const navigate = useNavigate()
  const toggle = () => {
    const next = !open
    /* Opening Home also shows the dashboard; a second press closes the group
       (owner, 2026-10-24: "after clicking Home it is not closing"). */
    if (go && next) navigate(go)
    setOpen(next)
    try { localStorage.setItem(groupKey(slug), next ? 'open' : 'closed') } catch { /* private browsing: lasts the session */ }
  }
  return (
    /* shrink-0: in the menu's fixed-height scroll column a card must keep its
       height and let the column scroll; shrinking sliced titles and items. */
    <div className="nav-pill shrink-0" data-open={open || undefined} style={{ '--h': hue } as React.CSSProperties}>
      <button type="button" data-row onClick={toggle} aria-expanded={open} className="nav-pill__head">
        <PillBadge icon={icon} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <Count n={count} />
        <ChevronRight aria-hidden className="nav-pill__arrow" />
      </button>
      {/* Always mounted, so opening slides (grid rows 0fr to 1fr) instead of popping in. */}
      <div className="nav-pill__body" {...({ inert: open ? undefined : '' } as Record<string, string | undefined>)}><div className="nav-pill__sub">{children}</div></div>
    </div>
  )
}

export const isHomeSection = (s: ApiSection) => s.slug === 'home' || s.slug === 'dashboard' || s.workspace === 'Home'

export interface StaffNavWorkspace { slug: string; name: string; sections: ApiSection[] }

/** Every workspace's sections as collapsible groups of text links. */
export function StaffNavList({ roleKey, workspaces, items, onNavigate, label }: {
  roleKey: string
  workspaces: StaffNavWorkspace[]
  items: (section: ApiSection) => ApiSection['features']
  onNavigate: () => void
  label: (name: string) => string
}) {
  /* Question papers just above My profile, and My profile last (Yajur, 2026-10-21). */
  const LAST = ['exams', 'my_profile']
  const rank = (slug: string) => LAST.indexOf(slug)
  const groups = workspaces.flatMap((ws) => ws.sections.map((section) => ({ ws, section })))
    .map((g, i) => ({ ...g, i }))
    .sort((a, b) => (rank(a.section.slug) - rank(b.section.slug)) || a.i - b.i)
  /* Regrouped (StaffCombos.tsx): some screens shown under another group, and a
     group of related screens shown once, its others reached as tabs. */
  const { pathname } = useLocation()
  const here = pathname.split('/')[3] ?? ''
  const listed = groups.map((g) => ({ ...g, list: items(g.section) }))
  const held = new Set(listed.flatMap((g) => g.list.map((f) => f.slug)))
  const hidden = new Set(COMBOS.flatMap((c) => c.slugs.filter((s) => s !== c.slugs.find((x) => held.has(x)))))
  const present = new Set(listed.filter((g) => g.list.length).map((g) => g.section.slug))
  const target = (slug: string, from: string) => (MOVES[slug] && present.has(MOVES[slug]) ? MOVES[slug] : from)
  const concerns = useOpenConcerns(held.has('concerns_from_parents'))
  const bySection = new Map<string, { section: string; f: ApiSection['features'][number] }[]>()
  for (const g of listed) for (const f of g.list) {
    if (hidden.has(f.slug)) continue
    const to = target(f.slug, g.section.slug)
    if (!bySection.has(to)) bySection.set(to, [])
    bySection.get(to)!.push({ section: g.section.slug, f })
  }
  /* Only the first Home is called Home; a role with several workspaces names
     the others after their workspace (owner, 2026-10-24: three Homes). */
  let homes = 0
  let row = 0
  const usedIcons = new Set<LucideIcon>()
  /* Home holds the other screens of its workspace (owner, 2026-10-24: "Getting
     started, Approvals, all those used to be inside one"): pressing Home opens
     the dashboard and the group; the screens sit inside it. */
  const homeHeld = new Map<string, { section: string; f: ApiSection['features'][number] }[]>()
  const folded = new Set<string>()
  for (const { ws, section } of listed) {
    if (!isHomeSection(section) || homeHeld.has(ws.slug)) continue
    const rest = listed.filter((g) => g.ws.slug === ws.slug && g.section.slug !== section.slug)
      .flatMap((g) => { const l = bySection.get(g.section.slug) ?? []; if (l.length) folded.add(g.section.slug); return l })
    homeHeld.set(ws.slug, rest)
  }
  return (
    <>
      {listed.map(({ ws, section }) => {
        const list = bySection.get(section.slug) ?? []
        if (!list.length || folded.has(section.slug)) return null
        const title = ws.sections.length > 1 ? section.name : ws.name
        /* Home is one item, not a group: it opens the workspace dashboard
           (Yajur, 2026-10-22: "No need of sub-section for Home; Today's
           classes - no need"). A group holding one screen is that screen,
           not a drawer around it (owner, 2026-10-24: "no need of again one
           sub section"). */
        const home = isHomeSection(section)
        const hue = PILL_HUES[row++ % PILL_HUES.length]
        const inHome = home ? homeHeld.get(ws.slug) ?? [] : []
        if (home && inHome.length) {
          const first = list[0]
          const name = homes++ === 0 ? 'Home' : (ws.name !== 'Home' ? ws.name : section.name)
          return (
            <StaffNavGroup key={`${ws.slug}.${section.slug}`} slug={`${ws.slug}.${section.slug}`} name={label(name)}
              hue={hue} icon={uniqueIcon('home', usedIcons)} go={featurePath(roleKey, first.section, first.f.slug)}>
              {[...list, ...inHome].map(({ section: from, f }) => (
                <NavLink key={f.key} data-row to={featurePath(roleKey, from, f.slug)} onClick={onNavigate} title={f.summary}
                  className={({ isActive }) => staffItemClass(isActive || !!comboOf(f.slug)?.slugs.includes(here), f.live)}>
                  <LineIcon name={`${f.slug} ${f.name}`} size={20} />
                  <span className="truncate">{label(f.name)}</span>
                </NavLink>
              ))}
            </StaffNavGroup>
          )
        }
        if (home || list.length === 1) {
          const first = list[0]
          const name = !home ? first.f.name : homes++ === 0 ? 'Home' : (ws.name !== 'Home' ? ws.name : section.name)
          return (
            <NavLink key={`${ws.slug}.${section.slug}`} to={featurePath(roleKey, first.section, first.f.slug)} onClick={onNavigate}
              title={home ? undefined : first.f.summary} style={{ '--h': hue } as React.CSSProperties}
              className={({ isActive }) => cn('nav-pill nav-pill__head nav-tap shrink-0', (isActive || (!home && !!comboOf(first.f.slug)?.slugs.includes(here))) && 'nav-pill--on')}>
              <PillBadge icon={uniqueIcon(home ? 'home' : `${section.slug} ${first.f.slug} ${name}`, usedIcons)} />
              <span className="min-w-0 flex-1 truncate">{label(name)}</span>
              {first.f.slug === 'concerns_from_parents' && <Count n={concerns} />}
              <ChevronRight aria-hidden className="nav-pill__arrow" />
            </NavLink>
          )
        }
        return (
          <StaffNavGroup key={`${ws.slug}.${section.slug}`} slug={`${ws.slug}.${section.slug}`} name={title}
            hue={hue} icon={uniqueIcon(`${section.slug} ${title}`, usedIcons)}
            count={list.some((x) => x.f.slug === 'concerns_from_parents') ? concerns : 0}>
            {list.map(({ section: from, f }) => (
              <NavLink key={f.key} data-row to={featurePath(roleKey, from, f.slug)} onClick={onNavigate} title={f.summary}
                className={({ isActive }) => {
                  // A grouped item stays lit while one of its tabs is open.
                  const on = isActive || !!comboOf(f.slug)?.slugs.includes(here)
                  return staffItemClass(on, f.live)
                }}>
                <LineIcon name={`${f.slug} ${f.name}`} size={20} />
                <span className="truncate">{label(f.name)}</span>
                {f.slug === 'concerns_from_parents' && <Count n={concerns} />}
              </NavLink>
            ))}
          </StaffNavGroup>
        )
      })}
    </>
  )
}

/* In the school's timezone, not the browser's: a header read on a laptop set
   to UTC showed 04:31 for a 10:01 sign-in. */
function clock(iso: string | null | undefined, timeZone: string | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone })
}

/** The one bar across the workspace: greeting and date, search, who is signed in. */
/* `dashboard`: the greeting, name and sign-in times show on the dashboard
   only; other screens keep just the bar's controls (owner, 2026-10-24). */
export function StaffHeaderContent({ signIns, dashboard }: { signIns: ReturnType<typeof useTodaySignIns>; dashboard: boolean }) {
  const session = useSession()
  const phone = usePhone()
  const now = new Date()
  const hour = now.getHours()
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const fullName = session.user?.full_name ?? ''
  const first = fullName.split(/\s+/)[0]
  const dateLine = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const d = signIns.data
  const firstAt = clock(d?.first_sign_in_at, d?.timezone)
  const lastAt = clock(d?.last_activity_at, d?.timezone)
  const times = firstAt && lastAt ? `First ${firstAt} · Last ${lastAt}` : lastAt ? `Last ${lastAt}` : null
  /* ON A PHONE, THE OWNER'S HEADER (Yajur, 2026-10-24,
     docs/owner-designs/2026-10-24-teacher-home-phone.html): avatar and bell on
     the top row beside the menu, then the greeting, the full name large, the
     staff ID with today's sign-in times, and search across the width. */
  if (phone) {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-3.5">
        <div className="flex items-center justify-between gap-2">
          <PersonAvatar name={fullName || '?'} photoId={session.user?.avatar_key} size={40} />
          {/* Search as an icon beside the bell (owner, 2026-10-27): it opens the palette across the top. */}
          <div className="flex shrink-0 items-center gap-1"><CommandSearch /><Notifications /></div>
        </div>
        {dashboard && <div className="min-w-0">
          <p className="text-[13px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">{greet}</p>
          <p className="truncate text-[20px] font-extrabold leading-tight tracking-[-0.01em]">{fullName || first}</p>
          {(d?.employee_code || times) && (
            <p className="mt-0.5 truncate text-[12px] font-medium text-muted-foreground tabular-nums">
              {d?.employee_code && <>ID: <span className="font-bold text-warning">{d.employee_code}</span></>}
              {d?.employee_code && times && ' • '}{times}
            </p>
          )}
        </div>}
      </div>
    )
  }
  return (
    <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 md:grid-cols-[minmax(0,1fr)_minmax(0,420px)_minmax(0,1fr)]">
      <div className="min-w-0">
        {dashboard && <>{/* The account's name first, then the greeting and the date (Yajur, 2026-10-21). */}
        <p className="truncate text-[calc(16px*var(--font-scale,1))] font-bold leading-tight">{fullName || first}</p>
        <p className="truncate text-[calc(12.5px*var(--font-scale,1))] text-muted-foreground">{greet} · {dateLine}</p></>}
        {!dashboard && <div id="staff-crumb" className="min-w-0" />}
      </div>
      <div className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:col-start-2 md:row-start-1">
        <CommandSearch wide fill />
      </div>
      <div className="col-start-2 row-start-1 flex min-w-0 items-center justify-end gap-2 md:col-start-3">
        {/* No avatar or staff ID here (owner, 2026-10-30): the profile in the panel's foot is enough. */}
        {dashboard && times && <p className="truncate text-[calc(12px*var(--font-scale,1))] text-muted-foreground tabular-nums">{times}</p>}
        {!dashboard && <div id="staff-actions" className="flex items-center gap-2" />}
        <Notifications />
      </div>
    </div>
  )
}

/* The panel's foot (owner's side-panel design, 2026-10-24): Focus | Work as
   one full-width pill, then a card with who is signed in and Help, Settings
   and Sign out. The avatar and name open the account page. */
const FOOT_ICON = 'foot-icon grid size-10 max-sm:size-12 shrink-0 place-items-center rounded-[10px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** Up above the menu and down below it (owner, 2026-10-30): real buttons
    that scroll the menu when its groups run past the panel's height. */
export function NavScrollButton({ dir }: { dir: 1 | -1 }) {
  const label = dir < 0 ? 'Scroll menu up' : 'Scroll menu down'
  return (
    /* Not on a phone (owner, 2026-10-30): the menu scrolls under the finger there. */
    <div className={cn('shrink-0 px-[18px] max-sm:hidden', dir < 0 ? 'pt-3' : 'pb-1 pt-2')}>
      <Button variant="secondary" size="sm" className="w-full" aria-label={label} title={label} onClick={() => scrollNav(dir)}>
        {dir < 0 ? <ChevronUp aria-hidden className="h-4 w-4" /> : <ChevronDown aria-hidden className="h-4 w-4" />}
      </Button>
    </div>
  )
}

function scrollNav(dir: 1 | -1) {
  const nav = document.querySelector<HTMLElement>('nav[aria-label="Sections"]')
  nav?.scrollBy({ top: dir * nav.clientHeight * 0.7, behavior: 'smooth' })
}

export function StaffPanelFoot({ employeeCode, onNavigate }: { employeeCode?: string | null; onNavigate: () => void }) {
  const session = useSession()
  const fullName = session.user?.full_name ?? ''
  return (
    <div className="flex shrink-0 flex-col gap-3.5 border-t px-5 pb-5 pt-4 max-sm:px-4">
      <LayoutSwitch pill />
      <StaffProfileCard name={fullName} sub={employeeCode} photoId={session.user?.avatar_key} onNavigate={onNavigate} />
    </div>
  )
}

/** Who is signed in, with Help, Settings and Sign out. Also shown in the Elements gallery. */
export function StaffProfileCard({ name, sub, photoId, onNavigate }: {
  name: string; sub?: string | null; photoId?: string; onNavigate?: () => void
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded-[14px] border bg-surface-subtle py-2.5 pl-3 pr-2">
      <Link to="/account" data-help-anchor="account" onClick={onNavigate}
        title="My profile"
        /* Reads as a button (owner, 2026-10-28: "idk that is clickable"): it
           lifts on hover and tints on press, with a chevron saying it opens. */
        className="group -my-1 -ml-1.5 flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-[10px] px-1.5 transition-colors duration-150 hover:bg-primary/10 active:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {/* The photo alone (owner, 2026-10-30): the cut-off name and staff ID said nothing. */}
        <PersonAvatar name={name || '?'} photoId={photoId} size={42} />
        <span className="sr-only">{name}{sub ? ` ${sub}` : ''}</span>
        <ChevronRight aria-hidden className="ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5" />
      </Link>
      <div className="flex shrink-0 items-center gap-0.5">
        <HelpButton className={FOOT_ICON} iconClassName="h-5 w-5 max-sm:h-6 max-sm:w-6" />
        <div className="staff-foot-settings foot-icon-wrap"><BentoSettings placement="rail" /></div>
        <a href="/logout" onClick={() => buzz('warn')} aria-label="Sign out" title="Sign out"
          className={FOOT_ICON}>
          <LogOut aria-hidden className="h-5 w-5 max-sm:h-6 max-sm:w-6" />
        </a>
      </div>
    </div>
  )
}
