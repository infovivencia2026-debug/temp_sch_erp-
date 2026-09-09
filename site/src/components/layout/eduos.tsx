import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import {
  Bell, Building2, CalendarRange, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight,
  Clock, GraduationCap, HelpCircle, Home as HomeIcon, LayoutTemplate, Menu, Moon, Plus, Search, Settings,
  SlidersHorizontal, Star, Sun, X,
  Palette,
} from 'lucide-react'
import { Avatar, Badge, Dropdown, Modal, useToast } from '@/components/ui'
import { Link, NavLink, useNavigate } from '@/lib/nav'
import { useApp, UIS } from '@/hooks/useAppState'
import { activeGroupOrder, activeRole, modulesForRole } from '@/industries'
import { AppearanceDialog } from '@/components/layout/appearance'
import { BackgroundPicker } from '@/components/layout/BackgroundPicker'
import { preloadCustomView } from '@/pages/custom'
import { MobileScopeBar } from '@/components/layout/MobileScopeBar'
import { cx, fmtDate, TODAY } from '@/lib/utils'

/* ---------------------------------------------------------------------------
   UI-16 · EDUCATION OS — the application shell.

   Four persistent zones: a collapsible left sidebar (248 / 72), a 64px command
   bar, the workspace, and a contextual right drawer that any screen can open.

   The sidebar renders the education registry's own groups rather than a
   re-cut list, which is the point: every module in the registry keeps a
   navigation location, and no capability can go missing behind a nicer menu.
   Groups collapse so that 49 modules are never all on screen at once.
   --------------------------------------------------------------------------- */

/* ------------------------------------------------------- Contextual drawer */

interface DrawerPayload { title: string; subtitle?: string; body: ReactNode; footer?: ReactNode }
interface DrawerApi { open: (p: DrawerPayload) => void; close: () => void }

const DrawerCtx = createContext<DrawerApi>({ open: () => {}, close: () => {} })
export const useContextDrawer = () => useContext(DrawerCtx)

export function EduDrawerProvider({ children }: { children: ReactNode }) {
  const [payload, setPayload] = useState<DrawerPayload | null>(null)
  const api = useMemo<DrawerApi>(() => ({
    open: (p) => setPayload(p),
    close: () => setPayload(null),
  }), [])

  return (
    <DrawerCtx.Provider value={api}>
      {children}
      {/* Zone 4. 460px, header + scrolling body + sticky footer. */}
      <aside
        className={cx('edu-drawer fixed right-0 top-0 z-50 flex h-full w-[min(460px,92vw)] flex-col border-l no-print',
          payload ? 'translate-x-0' : 'pointer-events-none translate-x-full')}
        aria-hidden={!payload}
      >
        {payload && (
          <>
            <header className="flex items-start gap-3 border-b px-5 py-4">
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold tracking-tight">{payload.title}</p>
                {payload.subtitle && <p className="truncate text-[12px] muted">{payload.subtitle}</p>}
              </div>
              <button onClick={api.close} aria-label="Close panel"
                className="ml-auto rounded-lg p-1.5 muted hover:bg-accent hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{payload.body}</div>
            {payload.footer && <footer className="border-t px-5 py-3">{payload.footer}</footer>}
          </>
        )}
      </aside>
    </DrawerCtx.Provider>
  )
}

/* --------------------------------------------------------------- Zone 1 */

const readList = (k: string): string[] => {
  try { return JSON.parse(localStorage.getItem(k) || '[]') } catch { return [] }
}

export function EduSidebar() {
  const { role, sidebarCollapsed, setSidebarCollapsed, industry } = useApp()
  const { pathname } = useLocation()
  const mods = modulesForRole(role)
  const groups = activeGroupOrder().filter((g) => mods.some((m) => m.group === g))
  const currentId = pathname.split('/')[2]
  const current = mods.find((m) => m.id === currentId)

  // Only the group you are in is open, so 49 modules never arrive at once.
  const [open, setOpen] = useState<string[]>(() => [current?.group ?? groups[0]])
  useEffect(() => { if (current) setOpen((o) => (o.includes(current.group) ? o : [...o, current.group])) }, [current?.group])

  const [pinned, setPinned] = useState<string[]>(() => readList('erp.pinned.education'))
  const togglePin = (id: string) => setPinned((p) => {
    const next = p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-8)
    localStorage.setItem('erp.pinned.education', JSON.stringify(next))
    return next
  })

  const collapsed = sidebarCollapsed
  const pinnedMods = pinned.map((id) => mods.find((m) => m.id === id)).filter(Boolean) as typeof mods

  const Item = ({ m, nested }: { m: typeof mods[number]; nested?: boolean }) => {
    const active = m.id === currentId
    return (
      <div className="group/item relative">
        <NavLink
          to={`/${m.id}`}
          aria-label={m.label}
          /* The styled label the rails use, not the browser's: collapsed to
             icons, this list is unreadable without one, and a tooltip that
             takes a second to appear reads as no label at all. */
          data-tip={collapsed ? m.label : undefined}
          onPointerEnter={() => {
            preloadCustomView(m.custom)
            m.tabs.forEach((t) => preloadCustomView(t.custom))
          }}
          className={cx('rail-tip edu-nav-item flex items-center gap-2.5 rounded-lg py-[7px] text-[13px] transition-colors',
            nested && !collapsed ? 'pl-9 pr-2.5' : 'px-2.5',
            active && 'is-active',
            collapsed && 'justify-center px-0')}
        >
          <m.icon className="h-[16px] w-[16px] shrink-0" />
          {!collapsed && <span className="truncate">{m.label}</span>}
          {!collapsed && m.tabs.length > 0 && (
            <span className="edu-nav-count ml-auto text-[11px] tabular-nums">{m.tabs.length}</span>
          )}
        </NavLink>
        {!collapsed && (
          <button
            onClick={(e) => { e.preventDefault(); togglePin(m.id) }}
            aria-label={pinned.includes(m.id) ? `Unpin ${m.label}` : `Pin ${m.label}`}
            data-tip={pinned.includes(m.id) ? 'Unpin' : 'Pin'}
            className={cx('rail-tip absolute right-1.5 top-1.5 rounded p-1',
              pinned.includes(m.id) ? 'text-amber-400' : 'touch-reveal group-hover/item:opacity-100')}
          >
            <Star className="h-3 w-3" fill={pinned.includes(m.id) ? 'currentColor' : 'none'} />
          </button>
        )}
      </div>
    )
  }

  return (
    <aside className={cx('edu-sidebar hidden lg:flex shrink-0 flex-col no-print',
      collapsed ? 'w-[72px]' : 'w-[248px]')}>
      <div className={cx('flex h-16 shrink-0 items-center gap-2.5 px-4', collapsed && 'justify-center px-0')}>
        <Link to="/" aria-label="All industries" data-tip="All industries"
          className="rail-tip tip-below grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#4F46E5] text-white">
          <GraduationCap className="h-[18px] w-[18px]" />
        </Link>
        {!collapsed && (
          <div className="min-w-0">
            <p className="edu-rail-title truncate text-[13px] font-semibold leading-tight">{industry.scope.orgs[0]}</p>
            <p className="edu-rail-sub truncate text-[10.5px]">{industry.productSub}</p>
          </div>
        )}
      </div>

      <nav aria-label="Modules" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {pinnedMods.length > 0 && !collapsed && (
          <div className="mb-2">
            <p className="edu-nav-group px-2.5 pb-1 pt-2">Favourites</p>
            {pinnedMods.map((m) => <Item key={`p-${m.id}`} m={m} />)}
          </div>
        )}

        {groups.map((g) => {
          const inGroup = mods.filter((m) => m.group === g)
          const isOpen = open.includes(g) || collapsed
          return (
            <div key={g} className="mb-0.5">
              {!collapsed && (
                <button
                  onClick={() => setOpen((o) => (o.includes(g) ? o.filter((x) => x !== g) : [...o, g]))}
                  className="edu-nav-group flex w-full items-center gap-1.5 px-2.5 py-2"
                  aria-expanded={isOpen}
                >
                  <ChevronRight className={cx('h-3 w-3 transition-transform duration-200', isOpen && 'rotate-90')} />
                  <span className="truncate">{g}</span>
                  <span className="ml-auto text-[10px] tabular-nums opacity-60">{inGroup.length}</span>
                </button>
              )}
              {isOpen && (
                <div className="space-y-[1px]">
                  {inGroup.map((m) => <Item key={m.id} m={m} nested />)}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {/* Same control as every other left panel, named the same way, so the
          same thing is findable by the same means in all of them. */}
      <button
        onClick={() => setSidebarCollapsed(!collapsed)}
        aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
        aria-expanded={!collapsed}
        data-tip={collapsed ? 'Expand' : undefined}
        className="rail-tip edu-nav-collapse flex items-center gap-2 px-4 py-3 text-[12px]"
      >
        {collapsed ? <ChevronsRight className="mx-auto h-4 w-4" /> : <><ChevronsLeft className="h-4 w-4" /> Collapse</>}
      </button>
    </aside>
  )
}

/* --------------------------------------------------------------- Zone 2 */

const CREATE_ITEMS = [
  ['Admission enquiry', '/admissions'], ['Student', '/students'], ['Attendance', '/attendance'],
  ['Exam', '/examinations'], ['Journal entry', '/finance'], ['Vendor invoice', '/procurement'],
  ['Expense claim', '/finance'], ['Employee', '/hr'], ['Purchase requisition', '/procurement'],
  ['Purchase order', '/procurement'], ['Quotation', '/procurement'], ['Sales order', '/finance'],
  ['Report', '/analytics'],
] as const

export function EduTopbar() {
  const app = useApp()
  const nav = useNavigate()
  const toast = useToast()
  const { pathname } = useLocation()
  const mods = modulesForRole(app.role)
  const current = mods.find((m) => m.id === pathname.split('/')[2])
  const role = activeRole(app.role)
  const [createOpen, setCreateOpen] = useState(false)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [bgOpen, setBgOpen] = useState(false)
  const [createQuery, setCreateQuery] = useState('')

  // Same rule as the sidebar: nothing on offer that this role cannot open.
  const reachable = new Set(modulesForRole(app.role).map((m) => m.id))
  const available = CREATE_ITEMS.filter(([, to]) => reachable.has(to.split('/')[1] ?? ''))
  const shown = available.filter(([label]) =>
    label.toLowerCase().includes(createQuery.trim().toLowerCase()))

  return (
    <header className="edu-topbar sticky top-0 z-40 flex h-16 shrink-0 items-center gap-2 border-b px-2 no-print sm:gap-3 sm:px-4">
      <button onClick={() => app.setMobileNavOpen(true)} aria-label="Open navigation"
        className="-ml-1 grid h-9 w-9 shrink-0 place-items-center rounded-lg hover:bg-accent lg:hidden">
        <Menu className="h-5 w-5" />
      </button>

      {/* left — breadcrumb / page context */}
      {/* Each segment ellipsizes on its own. Clipping the whole row instead cut
          words in half — "Overview" arriving as "Over" with nothing to say so. */}
      <nav aria-label="Breadcrumb" className="crumbs hidden min-w-0 shrink items-center gap-1.5 whitespace-nowrap text-[12.5px] lg:flex">
        <Link to="/" aria-label="Home" title="Home"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg muted hover:bg-accent hover:text-foreground">
          <HomeIcon className="h-4 w-4" />
        </Link>
        <ChevronRight className="h-3 w-3 shrink-0 opacity-40" />
        <span className="min-w-0 max-w-[220px] truncate font-medium">{current?.label ?? 'Dashboard'}</span>
      </nav>

      {/* centre — global search */}
      <button
        onClick={() => app.setPaletteOpen(true)}
        aria-label="Search"
        /* Below sm the pill has no room for its label and rendered as an empty
           blob. There it is just the magnifier. */
        className="edu-search mx-auto flex h-9 w-9 shrink-0 items-center justify-center gap-2.5 overflow-hidden rounded-lg text-[13px] sm:w-auto sm:min-w-[170px] sm:flex-1 sm:shrink sm:justify-start sm:px-3 lg:max-w-[760px]"
      >
        <Search className="h-4 w-4 shrink-0 muted" />
        <span className="hidden truncate muted sm:inline">Search students, faculty, invoices, courses, vendors or actions…</span>
      </button>

      {/* right — scope, create, alerts, help, user */}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Scope icon={CalendarRange} value={app.year} options={app.years} onChange={app.setYear} />
        <Scope icon={Clock} value={app.period} options={app.periods} onChange={app.setPeriod} />

        {/* A role with nothing it may create should not be offered the button. */}
        {available.length > 0 && (
          <button onClick={() => setCreateOpen(true)}
            className="ml-1 flex h-9 items-center gap-1.5 rounded-lg bg-[#4F46E5] px-3 text-[13px] font-medium text-white transition-colors hover:bg-[#4338CA]">
            <Plus className="h-4 w-4" /> <span className="hidden sm:inline">Create</span>
          </button>
        )}

        <Dropdown
          align="right"
          trigger={
            <button className="relative rounded-lg p-2 hover:bg-accent" aria-label="Notifications">
              <Bell className="h-[18px] w-[18px]" />
              <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[#E5484D] px-1 text-[9px] font-semibold text-white">
                {app.industry.notifications.length}
              </span>
            </button>
          }
          items={app.industry.notifications.map((n) => ({
            label: n.title,
            onClick: () => toast({ title: n.title, desc: `${n.desc} · ${n.time}`, tone: 'info' }),
          }))}
        />

        {/* Every other shell carries the interface switcher in its top bar.
            This one did not, so once you were in UI-16 the only way to any of
            the other twenty was to edit the URL. */}
        <Dropdown
          align="right"
          trigger={
            <button className="hidden h-9 items-center gap-1.5 rounded-lg px-2 hover:bg-accent md:flex"
              title="Switch interface" aria-label="Switch interface">
              <LayoutTemplate className="h-[18px] w-[18px]" />
              <span className="hidden text-[12.5px] font-medium lg:block">{app.uiDef.label}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
          }
          items={UIS.map((u) => ({
            label: `${app.ui === u.id ? '✓ ' : ''}${u.label} — ${u.name}`,
            onClick: () => app.setUi(u.id),
          }))}
        />

        {/* One named control instead of three icons to tell apart. */}
        <Dropdown
          align="right"
          trigger={
            <button className="grid h-9 w-9 place-items-center rounded-lg hover:bg-accent"
              aria-label="View options" title="View options">
              <SlidersHorizontal className="h-[18px] w-[18px]" />
            </button>
          }
          items={[
            { label: app.theme === 'dark' ? 'Light appearance' : 'Dark appearance',
              icon: app.theme === 'dark' ? Sun : Moon,
              onClick: () => app.setTheme(app.theme === 'dark' ? 'light' : 'dark') },
            { label: 'Typeface & density', icon: Settings, onClick: () => setAppearanceOpen(true) },
{ label: 'Colour settings', icon: Palette, onClick: () => setBgOpen(true) },
            { label: 'Help & support', icon: HelpCircle,
              onClick: () => toast({ title: 'Help centre', desc: 'Prototype build — no help desk wired up.', tone: 'info' }) },
          ]}
        />
        <AppearanceDialog open={appearanceOpen} onClose={() => setAppearanceOpen(false)} />
      <BackgroundPicker open={bgOpen} onClose={() => setBgOpen(false)} />

        <Dropdown
          align="right"
          trigger={
            <button className="ml-0.5 flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 hover:bg-accent">
              <Avatar name="Dr. Reddy" size={28} />
              <span className="hidden text-left leading-tight 2xl:block">
                <span className="block text-[12px] font-semibold">Dr. Reddy</span>
                <span className="block text-[10px] muted">{role.label}</span>
              </span>
              <ChevronDown className="h-3.5 w-3.5 muted" />
            </button>
          }
          items={app.industry.roles.map((r) => ({
            label: `${app.role === r.id ? '✓ ' : ''}View as ${r.label}`,
            onClick: () => { app.setRole(r.id); toast({ title: `Now previewing as ${r.label}`, desc: r.scope, tone: 'info' }) },
          }))}
        />
      </div>

      {/* searchable quick create */}
      <Modal open={createOpen} onClose={() => { setCreateOpen(false); setCreateQuery('') }}
        title="Create" subtitle={`${app.campus} · ${fmtDate(TODAY)}`}>
        <input
          autoFocus
          value={createQuery}
          onChange={(e) => setCreateQuery(e.target.value)}
          placeholder="Search what you want to create…"
          className="field mb-3"
        />
        <div className="grid gap-1.5 sm:grid-cols-2">
          {shown.map(([label, to]) => (
            <button key={label}
              onClick={() => { setCreateOpen(false); setCreateQuery(''); nav(to); toast({ title: `${label} — opening`, tone: 'info' }) }}
              className="flex items-center gap-2 rounded-lg hairline px-3 py-2.5 text-left text-[13px] hover:bg-accent/60">
              <Plus className="h-4 w-4 muted" /> {label}
            </button>
          ))}
          {shown.length === 0 && <p className="col-span-2 py-6 text-center text-[13px] muted">Nothing matches “{createQuery}”.</p>}
        </div>
      </Modal>
    </header>
  )
}

function Scope({ icon: Icon, value, options, onChange }: {
  icon: React.ComponentType<{ className?: string }>; value: string; options: string[]; onChange: (v: string) => void
}) {
  return (
    <Dropdown
      align="right"
      className="min-w-0 shrink"
      trigger={
        <button className="edu-scope hidden h-9 w-full min-w-0 max-w-[150px] shrink items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] 2xl:flex">
          <Icon className="h-3.5 w-3.5 shrink-0 muted" />
          <span className="truncate">{value}</span>
          <ChevronDown className="h-3 w-3 shrink-0 muted" />
        </button>
      }
      items={options.map((o) => ({ label: (o === value ? '✓ ' : '') + o, onClick: () => onChange(o) }))}
    />
  )
}

/* ------------------------------------------------------------ Mobile nav */

export function EduMobileNav() {
  const { mobileNavOpen, setMobileNavOpen, role, theme, setTheme, industry, ui, setUi } = useApp()
  const { pathname } = useLocation()
  const mods = modulesForRole(role)
  const groups = activeGroupOrder().filter((g) => mods.some((m) => m.group === g))
  const currentId = pathname.split('/')[2]
  if (!mobileNavOpen) return null
  return (
    <div className="fixed inset-0 z-[70] lg:hidden no-print">
      <div className="absolute inset-0 bg-black/40" onClick={() => setMobileNavOpen(false)} />
      <div className="edu-sidebar absolute left-0 top-0 flex h-full w-[280px] flex-col">
        <div className="flex h-16 items-center gap-2.5 px-4">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-[#4F46E5] text-white">
            <GraduationCap className="h-[18px] w-[18px]" />
          </span>
          <p className="edu-rail-title text-[13px] font-semibold">{industry.product}</p>
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label="Toggle appearance"
            className="edu-rail-btn ml-auto rounded p-1"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <Dropdown
            align="right"
            trigger={
              <button className="edu-rail-btn rounded p-1" aria-label="Switch interface">
                <LayoutTemplate className="h-4 w-4" />
              </button>
            }
            items={UIS.map((u) => ({
              label: `${ui === u.id ? '✓ ' : ''}${u.label} — ${u.name}`,
              onClick: () => { setUi(u.id); setMobileNavOpen(false) },
            }))}
          />
          <button onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" className="edu-rail-btn rounded p-1">
            <X className="h-4 w-4" />
          </button>
        </div>
        <MobileScopeBar withPeriod />
        <nav aria-label="Modules" className="flex-1 overflow-y-auto px-2 pb-4">
          {groups.map((g) => (
            <div key={g} className="mb-2">
              <p className="edu-nav-group px-2.5 pb-1 pt-2">{g}</p>
              {mods.filter((m) => m.group === g).map((m) => (
                <NavLink key={m.id} to={`/${m.id}`} onClick={() => setMobileNavOpen(false)}
                  className={cx('edu-nav-item flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px]',
                    m.id === currentId && 'is-active')}>
                  <m.icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{m.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- Utilities */

/** Status chips used by the greeting and the pulse. */
export function EduChip({ tone = 'slate', children }: { tone?: 'slate' | 'indigo' | 'green' | 'amber'; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium', `edu-chip-${tone}`)}>
      {children}
    </span>
  )
}

export { Badge as EduBadge }
