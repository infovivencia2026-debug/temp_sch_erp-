import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Command, Grid2x2,
  Home, Layers, LayoutTemplate, PanelRightClose, Search, X,
} from 'lucide-react'
import { Badge, Dropdown } from '@/components/ui'
import { Link, NavLink, useNavigate } from '@/lib/nav'
import { useApp, UIS } from '@/hooks/useAppState'
import { activeGroupOrder, modulesForRole } from '@/industries'
import { preloadCustomView } from '@/pages/custom'
import { MobileScopeBar } from '@/components/layout/MobileScopeBar'
import { isSingleIndustry } from '@/lib/deployment'
import { cx } from '@/lib/utils'
import type { ModuleDef } from '@/industries/types'

/** On a single-vertical site the brand mark goes home, not to a chooser. */
const HOME_LABEL = isSingleIndustry ? 'Home' : 'All industries'

/* ---------------------------------------------------------------------------
   Ten interfaces, ten navigation models.

   Everything below answers the same question — how does a person get from one
   module to another — and each answers it differently: a dock beside a
   contextual panel, a mega-menu, a strip of chips, a floating rail, a command
   menu, a dock at the bottom of the screen, a keyboard-first text menu, module
   tabs, a timeline, or tiles that are themselves the dashboard.

   They all read modulesForRole(), so a role never sees a destination it cannot
   open, whichever shell it is wearing.
   --------------------------------------------------------------------------- */

/** Everything a shell needs to know about where the reader currently is. */
function useNavState() {
  const { role } = useApp()
  const { pathname } = useLocation()
  const mods = modulesForRole(role)
  const currentId = pathname.split('/')[2]
  const current = mods.find((m) => m.id === currentId)
  const groups = useMemo(
    () => activeGroupOrder().filter((g) => mods.some((m) => m.group === g)),
    [mods],
  )
  return { mods, groups, current, currentId }
}

const byGroup = (mods: ModuleDef[], g: string) => mods.filter((m) => m.group === g)

/* ===========================================================================
   THE LEFT PANEL'S WIDTH

   One control, one piece of state, in every shell that has a left panel. It
   reads the same `sidebarCollapsed` the settings page already exposes, so the
   preference follows you between interfaces and survives a reload.

   Collapsed means icons; expanded means icons with their names. Panels that
   are wide by nature shrink to the icon width, and rails that are narrow by
   nature grow to fit the labels — the same switch, from opposite ends.

   The button sits at the panel's foot, where it is out of the way of the
   navigation but always on screen, and it never moves: it is the one thing in
   the panel whose position does not depend on how many modules there are.
   =========================================================================== */
function PanelToggle({ className, sub }: { className?: string; sub?: boolean }) {
  const app = useApp()
  /* `sub` picks the module column's own flag. A shell with a rail and a list
     beside it has two panels, and wanting the rail narrow says nothing about
     wanting the list gone — so they are two switches, not one. */
  const collapsed = sub ? app.subPanelCollapsed : app.sidebarCollapsed
  const set = sub ? app.setSubPanelCollapsed : app.setSidebarCollapsed
  const label = collapsed ? 'Expand panel' : 'Collapse panel'
  return (
    <button
      onClick={() => set(!collapsed)}
      aria-label={sub ? (collapsed ? 'Expand module list' : 'Collapse module list') : label}
      aria-expanded={!collapsed}
      data-tip={collapsed ? 'Expand' : 'Collapse'}
      className={cx('rail-tip mt-auto flex h-9 shrink-0 items-center gap-2 self-stretch rounded-lg px-2.5 text-[12px] muted transition-colors hover:bg-accent/60 hover:text-foreground',
        collapsed && 'justify-center px-0', className)}
    >
      {collapsed ? <ChevronsRight className="h-4 w-4 shrink-0" /> : <ChevronsLeft className="h-4 w-4 shrink-0" />}
      {!collapsed && <span className="truncate">Collapse</span>}
    </button>
  )
}

/* ============================================================ 1. Nexus dock */
/* A slim dock of group icons on the far left, and a panel beside it whose
   contents follow whichever group is selected. Two columns, one decision each:
   which area of the business, then which screen. */
export function NexusShell() {
  const { mods, groups, current, currentId } = useNavState()
  const { sidebarCollapsed: collapsed } = useApp()
  const { industry } = useApp()
  const [openGroup, setOpenGroup] = useState<string>(groups[0] ?? '')

  // The panel follows the reader — landing on a module selects its group.
  useEffect(() => { if (current) setOpenGroup(current.group) }, [current?.group])

  const panelMods = byGroup(mods, openGroup)

  return (
    <>
      <aside className="nexus-dock hidden lg:flex w-[66px] shrink-0 flex-col items-center gap-1 border-r py-3 no-print">
        <Link to="/" aria-label={HOME_LABEL} data-tip={HOME_LABEL} className="rail-tip tip-below mb-2 grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">
          <industry.icon className="h-[18px] w-[18px]" />
        </Link>
        {groups.map((g) => {
          const first = byGroup(mods, g)[0]
          const Icon = first.icon
          const active = openGroup === g
          return (
            <button
              key={g}
              aria-label={g}
              /* Suppressed only while the panel beside it is open and showing
                 exactly this word — the label landed on top of it. Collapse
                 that panel and the word is gone from the screen, so the label
                 has to come back. */
              /* Named always. Withholding it while the panel showed the same
                 word avoided a duplicate, at the cost of the one icon in the
                 dock that never says what it is — and that trade reads as a
                 bug every time. */
              data-tip={g}
              onClick={() => setOpenGroup(g)}
              className={cx('rail-tip relative grid h-10 w-10 place-items-center rounded-md transition-colors',
                active ? 'bg-accent text-foreground' : 'muted hover:bg-accent/60 hover:text-foreground')}
            >
              <Icon className="h-[18px] w-[18px]" />
              {current?.group === g && <span className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r bg-primary" />}
            </button>
          )
        })}
      </aside>

      <aside className={cx('nexus-panel hidden lg:flex shrink-0 flex-col border-r no-print transition-[width] duration-300',
        collapsed ? 'w-[60px]' : 'w-[228px]')}>
        <div className={cx('flex h-[52px] shrink-0 items-center border-b', collapsed ? 'justify-center px-0' : 'px-4')}>
          {collapsed
            ? <span className="text-[11px] muted tabular-nums">{panelMods.length}</span>
            : <>
                <p className="truncate text-[12px] font-semibold uppercase tracking-wider">{openGroup}</p>
                <span className="ml-auto text-[11px] muted tabular-nums">{panelMods.length}</span>
              </>}
        </div>
        <nav aria-label="Modules" className="flex-1 overflow-y-auto p-2">
          {panelMods.map((m) => (
            <NavLink
              key={m.id}
              to={`/${m.id}`}
              onPointerEnter={() => { preloadCustomView(m.custom); m.tabs.forEach((t) => preloadCustomView(t.custom)) }}
              aria-label={m.label}
              data-tip={collapsed ? m.label : undefined}
              className={cx('rail-tip mb-0.5 flex items-center gap-2.5 rounded-md py-[7px] text-[13px] transition-colors',
                collapsed ? 'justify-center px-0' : 'px-2.5',
                m.id === currentId ? 'bg-accent font-medium text-foreground' : 'muted hover:bg-accent/60 hover:text-foreground')}
            >
              <m.icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">{m.label}</span>}
              {!collapsed && m.tabs.length > 0 && <span className="ml-auto text-[11px] tabular-nums opacity-60">{m.tabs.length}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="shrink-0 border-t p-2"><PanelToggle /></div>
      </aside>
    </>
  )
}

/* ========================================================== 2. Aurora mega */
/* Navigation leaves the page and becomes a header. Each group opens a wide
   panel of modules in columns, so the screen below belongs entirely to the
   content. */
export function AuroraShell() {
  const { mods, groups, current } = useNavState()
  const { industry } = useApp()
  const nav = useNavigate()
  const [open, setOpen] = useState<string | null>(null)
  const navRef = useRef<HTMLDivElement>(null)

  // Dismissal for pointers that cannot leave: tap outside, or press Escape.
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setOpen(null)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [open])

  return (
    <div ref={navRef} className="aurora-nav relative z-30 border-b no-print" onMouseLeave={() => setOpen(null)}>
      <div className="mx-auto flex h-14 max-w-[1560px] items-center gap-2 px-6 sm:px-10">
        <Link to="/" className="mr-3 flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-ink text-ink-foreground">
            <industry.icon className="h-4 w-4" />
          </span>
          <span className="hidden text-[14px] font-semibold tracking-tight sm:block">{industry.product}</span>
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scroll-x">
          {groups.map((g) => (
            <button
              key={g}
              onMouseEnter={() => setOpen(g)}
              onClick={() => setOpen(open === g ? null : g)}
              className={cx('flex h-9 shrink-0 items-center gap-1 whitespace-nowrap px-3 text-[13.5px] transition-colors',
                current?.group === g ? 'font-medium text-foreground' : 'muted hover:text-foreground')}
            >
              {g}
              <ChevronDown className={cx('h-3 w-3 transition-transform', open === g && 'rotate-180')} />
            </button>
          ))}
        </div>
      </div>

      {open && (
        <div className="absolute inset-x-0 top-full border-b border-t bg-[hsl(var(--card))] shadow-[0_18px_40px_-24px_rgba(60,45,20,.35)]">
          <div className="mx-auto grid max-w-[1560px] gap-x-8 gap-y-1 px-6 py-7 sm:px-10 md:grid-cols-3 xl:grid-cols-4">
            <div className="hidden xl:block">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[hsl(var(--primary))]">{open}</p>
              <p className="mt-3 max-w-[22ch] text-[13px] leading-relaxed muted">
                {byGroup(mods, open).length} modules in this area of the business.
              </p>
            </div>
            {byGroup(mods, open).map((m) => (
              <button
                key={m.id}
                onClick={() => { setOpen(null); nav(`/${m.id}`) }}
                className="flex items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent/60"
              >
                <m.icon className="mt-0.5 h-4 w-4 shrink-0 muted" />
                <span className="min-w-0">
                  <span className="block truncate text-[13.5px] font-medium">{m.label}</span>
                  <span className="block truncate text-[11.5px] muted">
                    {m.tabs.length ? `${m.tabs.length} views` : 'Overview'}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* =========================================================== 3. Vector grid */
/* A 56px control strip carries the groups; the modules of the active group sit
   as chips across the top. Nothing is more than two clicks away and nothing
   costs more than 56px of width. */
export function VectorStrip() {
  const { sidebarCollapsed: collapsed } = useApp()
  const { mods, groups, current } = useNavState()
  const { industry } = useApp()
  const nav = useNavigate()
  const openGroup = current?.group ?? groups[0] ?? ''

  return (
    <aside className={cx('vector-strip hidden lg:flex shrink-0 flex-col gap-0.5 border-r py-2 no-print transition-[width] duration-300',
      collapsed ? 'w-[56px] items-center' : 'w-[184px] items-stretch px-2')}>
      <Link to="/" aria-label={HOME_LABEL} data-tip={HOME_LABEL} className="rail-tip tip-below mb-1.5 grid h-8 w-8 place-items-center rounded-sm bg-primary text-primary-foreground">
        <industry.icon className="h-4 w-4" />
      </Link>
      {groups.map((g) => {
        const Icon = byGroup(mods, g)[0].icon
        return (
          <button
            key={g}
            aria-label={g} data-tip={collapsed ? g : undefined}
            onClick={() => nav(`/${byGroup(mods, g)[0].id}`)}
            className={cx('rail-tip flex h-9 items-center gap-2.5 rounded-sm border text-[12.5px] transition-colors',
              collapsed ? 'w-9 justify-center' : 'w-full px-2',
              openGroup === g ? 'border-[hsl(var(--primary))] bg-accent text-foreground'
                : 'border-transparent muted hover:bg-accent/60 hover:text-foreground')}
          >
            <Icon className="h-[17px] w-[17px] shrink-0" />
            {!collapsed && <span className="truncate">{g}</span>}
          </button>
        )
      })}
      <PanelToggle className="mx-0 mt-auto" />
    </aside>
  )
}

export function VectorChips() {
  const { mods, current, currentId } = useNavState()
  const [openGroup, setOpenGroup] = useState<string>(current?.group ?? '')
  useEffect(() => { if (current) setOpenGroup(current.group) }, [current?.group])
  const list = byGroup(mods, openGroup || (current?.group ?? ''))

  return (
    <div className="vector-chips flex h-9 items-center gap-1 overflow-x-auto border-b px-3 scroll-x no-print">
      <span className="mr-1 hidden shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] muted lg:block">{openGroup}</span>
      {/* On a phone this label is the only way to reach another group. */}
      <Dropdown
        align="left"
        className="mr-1 shrink-0 lg:hidden"
        trigger={
          <button className="flex h-[26px] items-center gap-1 rounded-sm px-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] muted">
            {openGroup} <ChevronDown className="h-3 w-3" />
          </button>
        }
        items={activeGroupOrder().filter((g) => byGroup(mods, g).length).map((g) => ({
          label: `${g === openGroup ? '✓ ' : ''}${g}`,
          onClick: () => setOpenGroup(g),
        }))}
      />
      {list.map((m) => (
        <NavLink
          key={m.id}
          to={`/${m.id}`}
          className={cx('flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm border px-2 text-[12px] transition-colors',
            m.id === currentId
              ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.12)] font-medium text-foreground'
              : 'border-transparent muted hover:bg-accent/60 hover:text-foreground')}
        >
          <m.icon className="h-3.5 w-3.5" />
          {m.label}
        </NavLink>
      ))}
    </div>
  )
}

/* ========================================================== 4. Orbit canvas */
/* The rail floats: it is an object on the canvas rather than a wall beside it.
   Anything not on the rail is reached through the command overlay. */
export function OrbitRail() {
  const { mods, groups, current } = useNavState()
  const { industry, setPaletteOpen, sidebarCollapsed: collapsed } = useApp()
  const nav = useNavigate()

  return (
    <div className={cx('orbit-rail fixed left-4 top-1/2 z-40 hidden -translate-y-1/2 flex-col gap-1 rounded-[22px] p-2 lg:flex no-print transition-[width] duration-300',
      collapsed ? 'w-[60px] items-center' : 'w-[196px] items-stretch')}>
      <Link to="/" aria-label={HOME_LABEL} data-tip={HOME_LABEL} className="rail-tip tip-below mb-1 grid h-10 w-10 place-items-center rounded-[16px] bg-primary text-primary-foreground">
        <industry.icon className="h-[18px] w-[18px]" />
      </Link>
      {groups.map((g) => {
        const first = byGroup(mods, g)[0]
        const Icon = first.icon
        const active = current?.group === g
        return (
          <button
            key={g}
            aria-label={g} data-tip={collapsed ? g : undefined}
            onClick={() => nav(`/${first.id}`)}
            className={cx('rail-tip flex h-10 items-center gap-2.5 rounded-[16px] text-[12.5px] transition-all duration-300',
              collapsed ? 'w-10 justify-center' : 'w-full px-2.5',
              active ? 'bg-[hsl(var(--primary)/0.16)] text-[hsl(var(--primary))]' : 'muted hover:bg-accent/70 hover:text-foreground')}
          >
            <Icon className="h-[18px] w-[18px] shrink-0" />
            {!collapsed && <span className="truncate">{g}</span>}
          </button>
        )
      })}
      <button
        aria-label="Open command palette"
        data-tip={collapsed ? 'Open command palette' : undefined}
        onClick={() => setPaletteOpen(true)}
        className={cx('rail-tip mt-1 flex h-10 items-center gap-2.5 rounded-[16px] border border-dashed text-[12.5px] muted hover:text-foreground',
          collapsed ? 'w-10 justify-center' : 'w-full px-2.5')}
      >
        <Command className="h-[17px] w-[17px] shrink-0" />
        {!collapsed && <span className="truncate">Command</span>}
      </button>
      <PanelToggle className="mt-1" />
    </div>
  )
}

/* ============================================================== 5. Prism */
/* A hierarchical command menu instead of a rail, and a persistent inspector on
   the right. The inspector is the point: the workspace is for exploring, and
   whatever you touch explains itself here. */
export function PrismCommandMenu() {
  const { mods, groups, current } = useNavState()
  const { industry } = useApp()
  const nav = useNavigate()

  return (
    <div className="prism-menu scroll-x flex h-11 shrink-0 items-center gap-1 border-b px-4 no-print">
      <Link to="/" className="flex items-center gap-2 pr-2 text-[13px] font-semibold">
        <industry.icon className="h-4 w-4 text-[hsl(var(--primary))]" />
        {industry.label}
      </Link>
      <ChevronRight className="h-3.5 w-3.5 opacity-40" />
      <Dropdown
        align="left"
        trigger={
          <button className="flex h-7 items-center gap-1 rounded px-2 text-[13px] hover:bg-accent">
            {current?.group ?? 'All groups'} <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
        }
        items={groups.map((g) => ({ label: g, onClick: () => nav(`/${byGroup(mods, g)[0].id}`) }))}
      />
      <ChevronRight className="h-3.5 w-3.5 opacity-40" />
      <Dropdown
        align="left"
        trigger={
          <button className="flex h-7 items-center gap-1 rounded px-2 text-[13px] font-medium hover:bg-accent">
            {current?.label ?? 'Select a module'} <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
        }
        items={byGroup(mods, current?.group ?? groups[0]).map((m) => ({
          label: m.label, icon: m.icon, onClick: () => nav(`/${m.id}`),
        }))}
      />
      <span className="ml-auto hidden shrink-0 whitespace-nowrap text-[11px] muted sm:block">Select any record to inspect it</span>
    </div>
  )
}

export function PrismInspector() {
  const { current } = useNavState()
  const app = useApp()
  const [open, setOpen] = useState(true)

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="prism-inspector-tab fixed right-0 top-1/2 z-30 hidden -translate-y-1/2 rounded-l-md border px-2 py-4 text-[11px] xl:block no-print"
      >
        Inspector
      </button>
    )
  }

  return (
    <aside className="prism-inspector hidden w-[320px] shrink-0 flex-col border-l xl:flex no-print">
      <div className="flex h-11 items-center gap-2 border-b px-4">
        <p className="text-[12px] font-semibold uppercase tracking-wider">Inspector</p>
        <button onClick={() => setOpen(false)} aria-label="Hide inspector" title="Hide inspector"
          className="ml-auto muted hover:text-foreground">
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <p className="eyebrow">Context</p>
        <p className="mt-2 text-[15px] font-medium">{current?.label ?? 'No module open'}</p>
        <p className="mt-1 text-[12px] muted">{current?.group} · {app.industry.label}</p>

        <dl className="mt-5 space-y-3 border-t pt-4">
          {[
            ['Scope', app.campus],
            ['Period', app.year],
            ['Views', current ? String(current.tabs.length || 1) : '—'],
            ['Role', app.role],
          ].map(([k, v]) => (
            <div key={k} className="flex items-baseline gap-3">
              <dt className="w-20 shrink-0 text-[11px] uppercase tracking-wide muted">{k}</dt>
              <dd className="min-w-0 flex-1 truncate text-[13px]">{v}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-6 rounded-lg border border-dashed p-4 text-center">
          <Search className="mx-auto h-4 w-4 muted" />
          <p className="mt-2 text-[12px] muted">
            Select a row or a point on a chart and its record appears here.
          </p>
        </div>
      </div>
    </aside>
  )
}

/**
 * The dock as a single outline: a rounded bar whose top edge swells into a
 * bump under the pointer. `x` is the crest; when nothing is hovered the top
 * edge is simply flat.
 */
function dockPath(w: number, h: number, x: number | null, raised: boolean) {
  const R = 18            // the bar's corner radius
  const TOP = 26          // headroom the bump rises into
  const B = h + TOP       // bottom edge
  const HALF = 46         // how far either side of the crest the swell reaches
  if (!w) return ''

  const top = raised && x !== null
    ? (() => {
        /* The crest stays under its icon; it is the wave's two halves that give
           way near the ends. Clamping the feet instead cut the curve off
           mid-rise — it climbed and then stopped, because the far foot had been
           pulled inside the crest. Each side now uses whatever room it has, so
           the wave always completes, just more steeply where it is pinched. */
        const c = Math.min(Math.max(x, R + 10), w - R - 10)
        const hl = Math.max(Math.min(HALF, c - R), 14)
        const hr = Math.max(Math.min(HALF, w - R - c), 14)
        return [
          `H ${c - hl}`,
          `C ${c - hl * 0.52},${TOP} ${c - hl * 0.46},0 ${c},0`,
          `C ${c + hr * 0.46},0 ${c + hr * 0.52},${TOP} ${c + hr},${TOP}`,
          `H ${w - R}`,
        ].join(' ')
      })()
    : `H ${w - R}`

  return [
    `M ${R},${TOP}`,
    top,
    `A ${R},${R} 0 0 1 ${w},${TOP + R}`,
    `V ${B - R}`,
    `A ${R},${R} 0 0 1 ${w - R},${B}`,
    `H ${R}`,
    `A ${R},${R} 0 0 1 0,${B - R}`,
    `V ${TOP + R}`,
    `A ${R},${R} 0 0 1 ${R},${TOP}`,
    'Z',
  ].join(' ')
}

/* ============================================================== 6. Halo */
/* The dock sits at the bottom, the way a desktop operating system puts it, and
   the module list floats near the active section instead of pinning to an edge. */
export function HaloDock() {
  const { mods, groups, current } = useNavState()
  const { industry, ui } = useApp()
  const nav = useNavigate()

  /* A scoop travels to whichever icon the pointer is over and that icon rises
     into it. The disc is painted in the page's own colour and sits half over
     the dock's top edge, so the dock reads as bitten rather than as carrying
     a shape. Being a disc it only ever translates — nothing is re-drawn. */
  const dockRef = useRef<HTMLDivElement>(null)
  const slotRefs = useRef<(HTMLElement | null)[]>([])
  const [hovered, setHovered] = useState<number | null>(null)
  const [scoopX, setScoopX] = useState<number | null>(null)
  const [dockSize, setDockSize] = useState({ w: 0, h: 0 })
  const activeIndex = Math.max(0, groups.slice(0, 8).findIndex((g) => g === current?.group))
  const focus = hovered

  useEffect(() => {
    // The scoop parks under the current section while idle, but does not lift
    // it: the hole rests where you are, the rise belongs to the pointer.
    const el = slotRefs.current[focus ?? activeIndex]
    const dock = dockRef.current
    if (!el || !dock) return
    const place = () => {
      const d = dock.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      /* Kept within the bar's own ends. Centred on the first or last icon the
         swell hung past the rounded corner and floated free of the bar, so it
         stops where the bar stops — the peak leans a little off the end icons,
         which reads better than a curve breaking out of the shape. */
      setDockSize({ w: d.width, h: d.height })
      // No clamping here: the outline handles its own ends, so the crest can
      // sit directly under whichever icon is raised.
      setScoopX(r.left - d.left + r.width / 2)
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [focus, activeIndex, current?.group, ui])

  return (
    <div
      ref={dockRef}
      onPointerLeave={() => setHovered(null)}
      /* px-9: the wave needs room either side of the end icons to come back down.
         At px-2 the last icon sat 14px from the corner, so its right half had
         nowhere to go and plunged instead of curving — the half-finished wave. */
      className="halo-dock fixed bottom-5 left-1/2 z-40 hidden -translate-x-1/2 items-center gap-1 rounded-2xl px-9 py-1.5 no-print lg:flex"
    >
      {/* The bar's own outline carries the bump, rather than a separate shape
          laid over it. A patch had to be clamped away from the ends to stop it
          hanging past the rounded corners, which then left the crest sitting
          beside the icon it belonged to instead of under it. Drawn as one path
          the overhang cannot happen: the ends are part of the same outline. */}
      <svg
        aria-hidden
        /* Behind the icons: an absolutely positioned element paints above its
           in-flow siblings whatever the DOM order, so without this the outline
           covered the first icon. */
        className="dock-shell pointer-events-none absolute left-0 -top-[26px] -z-10"
        width={dockSize.w}
        height={dockSize.h + 26}
        style={{ opacity: dockSize.w ? 1 : 0 }}
      >
        <path
          d={dockPath(dockSize.w, dockSize.h, scoopX, hovered !== null)}
          fill="hsl(var(--dock, var(--card)))"
          stroke="hsl(var(--foreground) / 0.2)"
          strokeWidth="1"
          style={{ filter: 'drop-shadow(0 10px 24px hsl(var(--foreground) / 0.28))' }}
        />
      </svg>
      <Link to="/" aria-label={HOME_LABEL} data-tip={HOME_LABEL} className="rail-tip tip-below grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-foreground">
        <industry.icon className="h-[18px] w-[18px]" />
      </Link>
      <span className="mx-1 h-6 w-px bg-border" />
      {groups.slice(0, 8).map((g, i) => {
        const first = byGroup(mods, g)[0]
        const Icon = first.icon
        const active = current?.group === g
        /* The lift belongs to the icon, not the button: when the button moved,
           the label anchored to it moved too and the two transitions fought. */
        const face = (
          <>
            <Icon className="dock-icon h-[18px] w-[18px]" />
            {active && <span className="absolute -bottom-0.5 h-1 w-1 rounded-full bg-[hsl(var(--primary))]" />}
          </>
        )
        const faceClass = cx('rail-tip group relative grid h-10 w-10 place-items-center rounded-xl transition-colors',
          active ? 'bg-[hsl(var(--primary)/0.16)] text-[hsl(var(--primary))]' : 'muted hover:text-foreground')

        /* UI-5 shows the module panel beside the dock, so a tap should open the
           section and let the panel offer the rest. UI-12 hides that panel by
           design, so there the dock has to carry the whole group itself —
           otherwise every module but the first is unreachable. */
        const slot = (el: HTMLElement | null) => { slotRefs.current[i] = el }
        const lifted = i === focus

        return ui === 'ui-12' ? (
          <Dropdown
            key={g}
            align="left"
            trigger={
              <button ref={slot as any} aria-label={g} data-tip={g}
                onPointerEnter={() => setHovered(i)}
                className={cx(faceClass, 'dock-item', lifted && 'is-lifted')}>{face}</button>
            }
            items={byGroup(mods, g).map((m) => ({
              label: `${m.id === current?.id ? '✓ ' : ''}${m.label}`,
              icon: m.icon,
              onClick: () => nav(`/${m.id}`),
            }))}
          />
        ) : (
          <button key={g} ref={slot as any} aria-label={g} data-tip={g}
            onPointerEnter={() => setHovered(i)}
            className={cx(faceClass, 'dock-item', lifted && 'is-lifted')}
            onClick={() => nav(`/${first.id}`)}>
            {face}
          </button>
        )
      })}
    </div>
  )
}

export function HaloModulePanel() {
  const { mods, current, currentId } = useNavState()
  const { sidebarCollapsed: collapsed } = useApp()
  const list = byGroup(mods, current?.group ?? '')
  if (!list.length) return null
  return (
    <div className={cx('halo-panel fixed left-6 top-24 z-30 hidden rounded-2xl p-2 xl:block no-print transition-[width] duration-300',
      collapsed ? 'w-[56px]' : 'w-[212px]')}>
      {!collapsed && (
        <p className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] muted">{current?.group}</p>
      )}
      {list.map((m) => (
        <NavLink
          key={m.id}
          to={`/${m.id}`}
          aria-label={m.label}
          data-tip={collapsed ? m.label : undefined}
          className={cx('rail-tip mb-0.5 flex items-center gap-2.5 rounded-xl py-2 text-[13px] transition-colors',
            collapsed ? 'justify-center px-0' : 'px-2.5',
            m.id === currentId ? 'bg-[hsl(var(--primary)/0.14)] font-medium text-foreground' : 'muted hover:bg-accent/70')}
        >
          <m.icon className="h-4 w-4 shrink-0" />
          {!collapsed && <span className="truncate">{m.label}</span>}
        </NavLink>
      ))}
      <div className="mt-1 flex border-t pt-1"><PanelToggle /></div>
    </div>
  )
}

/* ============================================================ 7. Monolith */
/* No rail at all. A text command strip in the top-left corner expands into the
   module list, and everything else is keyboard-first. */
export function MonolithStrip() {
  const { mods, groups, current, currentId } = useNavState()
  const { industry, setPaletteOpen } = useApp()
  const nav = useNavigate()
  const [open, setOpen] = useState(false)

  return (
    <div className="monolith-strip relative z-30 flex h-12 items-center gap-3 border-b px-5 no-print">
      <Link to="/" className="hidden shrink-0 text-[13px] font-semibold tracking-tight sm:block">{industry.product}</Link>
      <span className="hidden h-4 w-px shrink-0 bg-border sm:block" />
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium hover:text-[hsl(var(--primary))]"
      >
        <Layers className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{current?.label ?? 'Modules'}</span>
        <ChevronDown className={cx('h-3 w-3 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      <button
        onClick={() => setPaletteOpen(true)}
        aria-label="Open command palette"
        className="ml-auto flex shrink-0 items-center gap-2 text-[12px] muted hover:text-foreground"
      >
        <Command className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Command</span>
      </button>

      {open && (
        <div className="monolith-drawer absolute inset-x-0 top-full max-h-[70vh] overflow-y-auto border-b px-5 py-6">
          <div className="grid gap-x-10 gap-y-6 md:grid-cols-3 xl:grid-cols-5">
            {groups.map((g) => (
              <div key={g}>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[hsl(var(--primary))]">{g}</p>
                {byGroup(mods, g).map((m) => (
                  <button
                    key={m.id}
                    onClick={() => { setOpen(false); nav(`/${m.id}`) }}
                    className={cx('block w-full truncate py-[3px] text-left text-[13px] transition-colors hover:text-foreground',
                      m.id === currentId ? 'font-medium text-foreground' : 'muted')}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* ============================================================= 8. Terrace */
/* Module tabs across the top with a submodule strip beneath — the two bands
   that begin a page built entirely out of horizontal bands. */
export function TerraceNav() {
  const { mods, groups, current, currentId } = useNavState()
  const { industry } = useApp()
  const [openGroup, setOpenGroup] = useState<string>(groups[0] ?? '')
  useEffect(() => { if (current) setOpenGroup(current.group) }, [current?.group])

  return (
    <div className="terrace-nav no-print">
      <div className="flex h-11 items-center gap-1 overflow-x-auto px-6 scroll-x sm:px-10">
        <Link to="/" aria-label={HOME_LABEL} data-tip={HOME_LABEL} className="rail-tip tip-below mr-2 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-ink text-ink-foreground">
          <industry.icon className="h-3.5 w-3.5" />
        </Link>
        {groups.map((g) => (
          <button
            key={g}
            onClick={() => setOpenGroup(g)}
            className={cx('h-8 shrink-0 whitespace-nowrap rounded-t-lg px-3.5 text-[13px] transition-colors',
              openGroup === g ? 'bg-[hsl(var(--card))] font-medium text-foreground' : 'muted hover:text-foreground')}
          >
            {g}
          </button>
        ))}
      </div>
      <div className="terrace-sub flex h-10 items-center gap-1 overflow-x-auto border-y px-6 scroll-x sm:px-10">
        {byGroup(mods, openGroup).map((m) => (
          <NavLink
            key={m.id}
            to={`/${m.id}`}
            className={cx('flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[12.5px] transition-colors',
              m.id === currentId ? 'bg-[hsl(var(--primary)/0.16)] font-medium text-foreground' : 'muted hover:bg-accent/60')}
          >
            <m.icon className="h-3.5 w-3.5" />
            {m.label}
          </NavLink>
        ))}
      </div>
    </div>
  )
}

/* =============================================================== 9. Pulse */
/* A slim rail of business areas, and the modules beside it as a vertical
   timeline — the shape the rest of the interface uses for events. */
export function PulseShell() {
  const { mods, groups, current, currentId } = useNavState()
  const { industry, sidebarCollapsed: collapsed, subPanelCollapsed: subCollapsed } = useApp()
  const [openGroup, setOpenGroup] = useState<string>(groups[0] ?? '')
  useEffect(() => { if (current) setOpenGroup(current.group) }, [current?.group])

  return (
    <>
      <aside className={cx('pulse-rail hidden lg:flex shrink-0 flex-col gap-1 border-r py-3 no-print transition-[width] duration-300',
        collapsed ? 'w-[58px] items-center' : 'w-[186px] items-stretch px-2')}>
        <Link to="/" aria-label={HOME_LABEL} data-tip={HOME_LABEL} className="rail-tip tip-below mb-2 grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">
          <industry.icon className="h-[18px] w-[18px]" />
        </Link>
        {groups.map((g) => {
          const Icon = byGroup(mods, g)[0].icon
          return (
            <button
              key={g}
              aria-label={g} data-tip={collapsed ? g : undefined}
              onClick={() => setOpenGroup(g)}
              className={cx('rail-tip flex h-9 items-center gap-2.5 rounded-lg text-[12.5px] transition-colors',
                collapsed ? 'w-9 justify-center' : 'w-full px-2',
                openGroup === g ? 'bg-[hsl(var(--primary)/0.18)] text-[hsl(var(--primary))]' : 'muted hover:bg-accent/60')}
            >
              <Icon className="h-[17px] w-[17px] shrink-0" />
              {!collapsed && <span className="truncate">{g}</span>}
            </button>
          )
        })}
        <PanelToggle className="mx-0 mt-auto" />
      </aside>

      <aside className={cx('pulse-timeline hidden lg:flex shrink-0 flex-col border-r no-print transition-[width] duration-300',
        subCollapsed ? 'w-[56px]' : 'w-[224px]')}>
        <div className={cx('flex h-[52px] shrink-0 items-center', subCollapsed ? 'justify-center px-0' : 'px-4')}>
          {!subCollapsed && <p className="truncate text-[12px] font-semibold uppercase tracking-wider">{openGroup}</p>}
        </div>
        <nav aria-label="Modules" className={cx('relative flex-1 overflow-y-auto pb-4', subCollapsed ? 'px-2' : 'px-4')}>
          {/* The spine is the point of this column, but at 56px there is no
              room for it beside the marks, so it goes and the icons carry the
              list instead. */}
          {!subCollapsed && <span className="absolute bottom-4 left-[22px] top-0 w-px bg-border" />}
          {byGroup(mods, openGroup).map((m) => {
            const active = m.id === currentId
            return subCollapsed ? (
              <NavLink key={m.id} to={`/${m.id}`}
                aria-label={m.label} data-tip={m.label}
                className={cx('rail-tip mb-0.5 grid h-9 w-9 place-items-center rounded-lg transition-colors',
                  active ? 'bg-[hsl(var(--primary)/0.18)] text-[hsl(var(--primary))]' : 'muted hover:bg-accent/60')}>
                <m.icon className="h-4 w-4" />
              </NavLink>
            ) : (
              <NavLink key={m.id} to={`/${m.id}`} className="relative flex items-center gap-3 py-[7px] pl-5">
                <span className={cx('absolute left-[3px] h-2 w-2 rounded-full ring-4',
                  active ? 'bg-[hsl(var(--primary))] ring-[hsl(var(--primary)/0.18)]' : 'bg-border ring-transparent')} />
                <span className={cx('truncate text-[13px] transition-colors',
                  active ? 'font-medium text-foreground' : 'muted hover:text-foreground')}>{m.label}</span>
              </NavLink>
            )
          })}
        </nav>
        <div className={cx('shrink-0 border-t', subCollapsed ? 'p-2' : 'px-2 py-2')}><PanelToggle sub /></div>
      </aside>
    </>
  )
}

/* ============================================================== 10. Mosaic */
/* Navigation is the dashboard. A launcher of tiles sized by importance sits
   above the page; the current area stays expanded. */
export function MosaicLauncher() {
  const { mods, groups, current, currentId } = useNavState()
  const { industry } = useApp()
  const nav = useNavigate()
  const [open, setOpen] = useState(false)

  const TONES = ['cobalt', 'teal', 'coral', 'violet']

  return (
    <div className="mosaic-launcher no-print">
      <div className="flex items-center gap-2 px-6 py-3 sm:px-10">
        <Link to="/" aria-label={HOME_LABEL} data-tip={HOME_LABEL} className="rail-tip tip-below grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-ink text-ink-foreground">
          <industry.icon className="h-4 w-4" />
        </Link>
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium hover:bg-accent/60"
        >
          <Grid2x2 className="h-3.5 w-3.5" />
          {open ? 'Hide tiles' : 'All areas'}
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scroll-x">
          {byGroup(mods, current?.group ?? groups[0]).map((m) => (
            <NavLink
              key={m.id}
              to={`/${m.id}`}
              className={cx('flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[12.5px] transition-colors',
                m.id === currentId ? 'bg-accent font-medium text-foreground' : 'muted hover:bg-accent/60')}
            >
              <m.icon className="h-3.5 w-3.5" />
              {m.label}
            </NavLink>
          ))}
        </div>
      </div>

      {open && (
        <div className="grid gap-2.5 px-6 pb-5 sm:px-10 md:grid-cols-3 xl:grid-cols-4">
          {groups.map((g, i) => {
            const list = byGroup(mods, g)
            const big = i < 2
            return (
              <div
                key={g}
                data-tone={TONES[i % TONES.length]}
                className={cx('mosaic-tile rounded-2xl p-4', big && 'md:col-span-1 xl:col-span-2')}
              >
                <div className="flex items-center gap-2">
                  <p className="text-[13px] font-semibold">{g}</p>
                  <Badge tone="slate">{list.length}</Badge>
                </div>
                <div className={cx('mt-3 grid gap-1.5', big ? 'sm:grid-cols-2' : '')}>
                  {list.slice(0, big ? 8 : 4).map((m) => (
                    <button
                      key={m.id}
                      onClick={() => { setOpen(false); nav(`/${m.id}`) }}
                      className="flex items-center gap-2 rounded-lg bg-[hsl(var(--card))] px-2.5 py-1.5 text-left text-[12px] transition-transform duration-200 hover:-translate-y-0.5"
                    >
                      <m.icon className="h-3.5 w-3.5 shrink-0 muted" />
                      <span className="truncate">{m.label}</span>
                    </button>
                  ))}
                  {list.length > (big ? 8 : 4) && (
                    <span className="px-2.5 py-1.5 text-[11px] muted">+{list.length - (big ? 8 : 4)} more</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ Mobile */
/* Every shell falls back to the same drawer below lg. A dock, a mega-menu and
   a bottom bar all fail differently on a phone; one honest drawer does not. */
export function ShellMobileNav() {
  const { mods, groups, currentId } = useNavState()
  const { mobileNavOpen, setMobileNavOpen, industry, ui, setUi } = useApp()
  if (!mobileNavOpen) return null
  return (
    <div className="fixed inset-0 z-[70] lg:hidden no-print">
      <div className="absolute inset-0 bg-foreground/30" onClick={() => setMobileNavOpen(false)} />
      <div className="absolute left-0 top-0 flex h-full w-[276px] flex-col float">
        <div className="flex h-14 items-center gap-2 border-b px-3">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <industry.icon className="h-[18px] w-[18px]" />
          </span>
          <p className="text-[13px] font-semibold">{industry.product}</p>
          <Dropdown
            align="right"
            trigger={
              <button aria-label="Switch interface" title="Switch interface"
                className="ml-auto rounded-lg p-1.5 hover:bg-accent">
                <LayoutTemplate className="h-4 w-4" />
              </button>
            }
            items={UIS.map((u) => ({
              label: `${ui === u.id ? '✓ ' : ''}${u.label} — ${u.name}`,
              onClick: () => { setUi(u.id); setMobileNavOpen(false) },
            }))}
          />
          <button onClick={() => setMobileNavOpen(false)} className="rounded-lg p-1 hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>
        <MobileScopeBar />
        <nav aria-label="Modules" className="flex-1 overflow-y-auto p-2">
          <Link to="/" onClick={() => setMobileNavOpen(false)}
            className="mb-2 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] muted">
            <Home className="h-4 w-4" /> {HOME_LABEL}
          </Link>
          {groups.map((g) => (
            <div key={g} className="mb-2">
              <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider muted">{g}</p>
              {byGroup(mods, g).map((m) => (
                <NavLink
                  key={m.id}
                  to={`/${m.id}`}
                  onClick={() => setMobileNavOpen(false)}
                  className={cx('flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px]',
                    m.id === currentId ? 'bg-accent font-medium' : 'muted')}
                >
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
