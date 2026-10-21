import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  BookOpen, Bus, CalendarDays, ChevronDown, ClipboardCheck, Contact, Dot, FileText, Home, ListChecks,
  MessageSquare, MessageSquareText, NotebookPen, Plane, Presentation, Settings2, UserRound, Users, Wallet, type LucideIcon,
} from 'lucide-react'
import { api } from '@/lib/api'
import { featurePath, type ApiSection } from '@/lib/catalog'
import { SIGN_INS_PATH, type TodaySignIns } from '@/lib/staff-layout'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
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
   from what the group or screen is called; anything unmatched gets a plain dot. */
const LINE_ICONS: [RegExp, LucideIcon][] = [
  [/home|today|dashboard|overview/, Home],
  [/timetable|calendar|schedule|period/, CalendarDays],
  [/attendance|absen|register/, ClipboardCheck],
  [/mark|grade|assessment|exam|result|report card|cce|question|paper/, FileText],
  [/teaching|teach|lesson/, Presentation],
  [/homework|assignment|classwork|submission/, NotebookPen],
  [/class|student|progress|360|behaviour|detail/, Users],
  [/remark|anecdot|ptm|note/, MessageSquareText],
  [/message|communication|chat|status|circular|notice|concern|complaint/, MessageSquare],
  [/leave/, Plane],
  [/pay|salary|fee|finance|account/, Wallet],
  [/task|work|approval/, ListChecks],
  [/profile|my |self/, UserRound],
  [/staff|teacher|hr|people/, Contact],
  [/library|book|lms|learn|course|syllabus/, BookOpen],
  [/transport|bus|route/, Bus],
  [/setting|setup|rule|config/, Settings2],
]
function LineIcon({ name, size = 16 }: { name: string; size?: number }) {
  const Icon = LINE_ICONS.find(([re]) => re.test(name.toLowerCase()))?.[1] ?? Dot
  return <Icon aria-hidden className="shrink-0" style={{ width: size, height: size }} strokeWidth={1.75} />
}

/* v2: a group someone opened under the old open-by-default rule starts closed again. */
const groupKey = (slug: string) => `erp.navGroup.v2.${slug}`
/* Closed until opened (owner, 2026-10-19: "as default close all dropdowns"). */
function readOpen(slug: string): boolean {
  try { return localStorage.getItem(groupKey(slug)) === 'open' } catch { return false }
}

function Group({ slug, section, name, children }: { slug: string; section: string; name: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(() => readOpen(slug))
  const toggle = () => {
    const next = !open
    setOpen(next)
    try { localStorage.setItem(groupKey(slug), next ? 'open' : 'closed') } catch { /* private browsing: lasts the session */ }
  }
  return (
    <div className="pt-1">
      <button type="button" onClick={toggle} aria-expanded={open}
        className="flex min-h-[calc(38px*var(--font-scale,1))] w-full items-center justify-between gap-2 rounded-sm px-2.5 text-left
                   text-[calc(14px*var(--font-scale,1))] font-semibold text-foreground
                   transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="flex min-w-0 items-center gap-2.5">
          <LineIcon name={`${section} ${name}`} size={18} />
          <span className="truncate">{name}</span>
        </span>
        <ChevronDown aria-hidden className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150', !open && '-rotate-90')} />
      </button>
      {/* One level in, under a guide line, so a screen reads as part of its group. */}
      {open && <div className="ml-[19px] flex flex-col border-l pl-2">{children}</div>}
    </div>
  )
}

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
  return (
    <>
      {groups.map(({ ws, section }) => {
        const list = items(section)
        if (!list.length) return null
        const title = ws.sections.length > 1 ? section.name : ws.name
        return (
          <Group key={`${ws.slug}.${section.slug}`} slug={`${ws.slug}.${section.slug}`} section={section.slug} name={title}>
            {list.map((f) => (
              <NavLink key={f.key} to={featurePath(roleKey, section.slug, f.slug)} onClick={onNavigate} title={f.summary}
                className={({ isActive }) => cn(
                  'flex min-h-[calc(34px*var(--font-scale,1))] items-center gap-2 rounded-sm px-2.5 py-1 text-[calc(13.5px*var(--font-scale,1))] transition-colors',
                  isActive ? 'bg-primary/10 font-semibold text-primary' : 'text-secondary-foreground hover:bg-surface-hover hover:text-foreground',
                  !f.live && !isActive && 'text-muted-foreground/70',
                )}>
                <LineIcon name={`${f.slug} ${f.name}`} size={15} />
                <span className="truncate">{label(f.name)}</span>
              </NavLink>
            ))}
          </Group>
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
export function StaffHeaderContent({ signIns }: { signIns: ReturnType<typeof useTodaySignIns> }) {
  const session = useSession()
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
  return (
    <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 md:grid-cols-[minmax(0,1fr)_minmax(0,420px)_minmax(0,1fr)]">
      <div className="min-w-0">
        <p className="truncate text-[calc(16px*var(--font-scale,1))] font-bold leading-tight">{greet}{first ? `, ${first}` : ''}</p>
        <p className="truncate text-[calc(12.5px*var(--font-scale,1))] text-muted-foreground">{dateLine}</p>
      </div>
      <div className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:col-start-2 md:row-start-1">
        <CommandSearch wide fill />
      </div>
      <div className="col-start-2 row-start-1 flex min-w-0 items-center justify-end gap-2 md:col-start-3">
        <Notifications />
        <PersonAvatar name={fullName || '?'} photoId={session.user?.avatar_key} size={36} />
        <div className="min-w-0 max-w-[9.5rem] sm:max-w-none">
          {d?.employee_code && <p className="truncate text-[calc(13px*var(--font-scale,1))] font-semibold tabular-nums">{d.employee_code}</p>}
          {times && <p className="truncate text-[calc(12px*var(--font-scale,1))] text-muted-foreground tabular-nums">{times}</p>}
        </div>
      </div>
    </div>
  )
}
