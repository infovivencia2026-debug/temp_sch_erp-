import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
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

const groupKey = (slug: string) => `erp.navGroup.${slug}`
function readOpen(slug: string): boolean {
  try { return localStorage.getItem(groupKey(slug)) !== 'closed' } catch { return true }
}

function Group({ slug, name, children }: { slug: string; name: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(() => readOpen(slug))
  const toggle = () => {
    const next = !open
    setOpen(next)
    try { localStorage.setItem(groupKey(slug), next ? 'open' : 'closed') } catch { /* private browsing: lasts the session */ }
  }
  return (
    <div className="pt-3 first:pt-1">
      <button type="button" onClick={toggle} aria-expanded={open}
        className="flex min-h-[calc(32px*var(--font-scale,1))] w-full items-center justify-between gap-2 rounded-sm px-2.5 text-left
                   text-[calc(11.5px*var(--font-scale,1))] font-semibold uppercase tracking-[0.09em] text-muted-foreground
                   transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="truncate">{name}</span>
        <ChevronDown aria-hidden className={cn('h-3.5 w-3.5 shrink-0 transition-transform duration-150', !open && '-rotate-90')} />
      </button>
      {open && <div className="flex flex-col">{children}</div>}
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
  return (
    <>
      {workspaces.flatMap((ws) => ws.sections.map((section) => {
        const list = items(section)
        if (!list.length) return null
        const title = ws.sections.length > 1 ? section.name : ws.name
        return (
          <Group key={`${ws.slug}.${section.slug}`} slug={`${ws.slug}.${section.slug}`} name={title}>
            {list.map((f) => (
              <NavLink key={f.key} to={featurePath(roleKey, section.slug, f.slug)} onClick={onNavigate} title={f.summary}
                className={({ isActive }) => cn(
                  'flex min-h-[calc(36px*var(--font-scale,1))] items-center rounded-sm px-2.5 py-1 text-[calc(14px*var(--font-scale,1))] transition-colors',
                  isActive ? 'bg-primary/10 font-semibold text-primary' : 'text-secondary-foreground hover:bg-surface-hover hover:text-foreground',
                  !f.live && !isActive && 'text-muted-foreground/70',
                )}>
                <span className="truncate">{label(f.name)}</span>
              </NavLink>
            ))}
          </Group>
        )
      }))}
    </>
  )
}

function clock(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
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
  const firstAt = clock(d?.first_sign_in_at)
  const lastAt = clock(d?.last_activity_at)
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
