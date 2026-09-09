import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, Bell, Building2, CalendarRange, Check, ChevronDown, Expand, GraduationCap,
  HelpCircle, Landmark, LayoutGrid, LogOut, Mail, Menu, Moon, Plus, Search, Settings,
  LayoutTemplate, Shrink, SlidersHorizontal, Sun, UserCog, X,
  Palette,
} from 'lucide-react'
import { Avatar, Dropdown, Modal, useToast } from '@/components/ui'
import { useApp, UIS } from '@/hooks/useAppState'
import { Link, useNavigate } from '@/lib/nav'
import { activeRole, homePathFor, modulesForRole } from '@/industries'
import { AppearanceDialog } from '@/components/layout/appearance'
import { BackgroundPicker } from '@/components/layout/BackgroundPicker'
import { useIsPhone, useMediaQuery } from '@/hooks/useMedia'
import { cx } from '@/lib/utils'

/* ===========================================================================
   UI-8 — INSTITUTIONAL HEADER

   Clean when untouched, responsive when tapped, informative when opened.

   The same functions at every width, disclosed progressively:

     desktop   context selectors, a wide search, Create, messages,
               notifications, utilities and the named profile
     tablet    the year, theme and full-screen fold into an overflow menu and
               search collapses to its icon
     phone     a menu, the brand, search, notifications and the avatar — with
               context moved into a bottom sheet, search to a full screen, and
               the common destinations to a bottom bar

   Everything is filtered by what the signed-in role may actually open, so a
   student is never shown an administrator's action and then turned away from
   it by the route guard.
   =========================================================================== */

/** What each role creates. Falls back to whatever it can reach. */
const CREATE_BY_ROLE: Record<string, { label: string; to: string }[]> = {
  faculty: [
    { label: 'Assignment', to: '/lms' },
    { label: 'Assessment', to: '/examinations' },
    { label: 'Announcement', to: '/communication' },
    { label: 'Class activity', to: '/activities' },
  ],
  student: [
    { label: 'Leave request', to: '/student-portal' },
    { label: 'Helpdesk ticket', to: '/helpdesk' },
  ],
  parent: [
    { label: 'Leave request', to: '/parent-portal' },
    { label: 'Meeting request', to: '/parent-portal' },
  ],
}

export function Ui9Header() {
  const app = useApp()
  const nav = useNavigate()
  const toast = useToast()
  const isPhone = useIsPhone()
  const isTablet = useMediaQuery('(min-width: 640px) and (max-width: 1279.98px)')

  const [sheetOpen, setSheetOpen] = useState(false)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [bgOpen, setBgOpen] = useState(false)
  // Search is the shared palette, so all 21 interfaces get the same one.
  const setSearchOpen = app.setPaletteOpen
  const [fullscreen, setFullscreen] = useState(false)

  const role = activeRole(app.role)
  const industry = app.industry
  const mods = useMemo(() => modulesForRole(app.role), [app.role, app.industryId])
  const reachable = useMemo(() => new Set(mods.map((m) => m.id)), [mods])

  const createItems = useMemo(() => {
    const preset = CREATE_BY_ROLE[app.role]
    const source = preset ?? industry.quickCreate
    return source.filter((q) => reachable.has(q.to.split('/')[1] ?? ''))
  }, [app.role, industry, reachable])

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {})
    else document.exitFullscreen?.().catch(() => {})
    setFullscreen((f) => !f)
  }

  const notifications = industry.notifications
  const messages = industry.messages

  return (
    <>
      <header
        className="ui9-header sticky top-0 z-40 flex h-16 shrink-0 items-center gap-2 border-b px-3 no-print sm:gap-3 sm:px-5"
        style={{ background: 'hsl(var(--chrome))' }}
      >
        {/* ── phone + tablet: the way back to navigation ───────────────── */}
        <button
          onClick={() => app.setMobileNavOpen(true)}
          aria-label="Open navigation"
          className="ui9-icon grid h-11 w-11 shrink-0 place-items-center rounded-lg lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* ── brand. On a phone this is also the context switcher. ─────── */}
        <button
          onClick={() => (isPhone ? setSheetOpen(true) : nav(homePathFor(app.role)))}
          className="ui9-brand flex min-w-0 shrink-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left"
          aria-label={isPhone ? 'Switch workspace' : industry.product}
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]">
            <GraduationCap className="h-[18px] w-[18px]" />
          </span>
          {/* On a phone the mark alone: the institution and campus are in the
              sheet this button opens, so repeating them here only costs width. */}
          <span className="hidden min-w-0 max-w-[120px] sm:block lg:hidden">
            <span className="block truncate text-[13px] font-semibold leading-tight">
              {industry.scope.orgs[0].split(' ')[0]}
            </span>
            {isPhone && <span className="block truncate text-[10px] muted">{app.campus}</span>}
          </span>
        </button>

        {/* ── context: institution, campus, year. Secondary to search. ─── */}
        {/* A tablet keeps institution and campus — they are context, not
            decoration — and gives up the year to the overflow menu. */}
        <div className="hidden min-w-0 shrink items-center gap-1 lg:flex">
          <Scope icon={Landmark} label="Institution" value={app.institution} options={app.institutions} onChange={app.setInstitution} />
          <span className="hidden 2xl:contents">
            <Scope icon={CalendarRange} label="Academic year" value={app.year} options={app.years} onChange={app.setYear} />
          </span>
        </div>

        {/* ── search: the primary affordance, so it takes the free space ── */}
        <button
          onClick={() => setSearchOpen(true)}
          aria-label="Search students, staff, classes, pages and actions"
          className="ui9-search ml-2 flex h-10 min-w-0 flex-1 items-center gap-2.5 overflow-hidden rounded-lg px-3 text-[13px] muted"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="truncate">Search students, classes, books, pages…</span>
        </button>
        {/* ── actions ──────────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-center gap-1">
          {createItems.length > 0 && (
            <Dropdown
              align="right"
              trigger={
                <button
                  className="ui9-cta hidden h-10 items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium sm:flex"
                  aria-label="Create"
                >
                  <Plus className="h-4 w-4" /> Create
                  <ChevronDown className="h-3 w-3 opacity-70" />
                </button>
              }
              items={createItems.map((q) => ({
                label: q.label,
                onClick: () => { nav(q.to); toast({ title: `${q.label} — opening`, tone: 'info' }) },
              }))}
            />
          )}

          <Dropdown
            align="right"
            trigger={
              <button className="ui9-icon relative grid h-11 w-11 place-items-center rounded-lg" aria-label={`Notifications, ${notifications.length} unread`} title="Notifications">
                <Bell className="h-[18px] w-[18px]" />
                <span className="absolute right-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-[hsl(var(--destructive))] px-1 text-[9px] font-semibold text-white">
                  {notifications.length}
                </span>
              </button>
            }
            items={[
              ...notifications.map((n) => ({
                label: `${n.title} · ${n.time}`,
                onClick: () => toast({ title: n.title, desc: n.desc, tone: 'info' }),
              })),
              // Messages live in here too: one bell is enough.
              'sep' as const,
              ...messages.map((m) => ({
                label: `${m.from}: ${m.text.slice(0, 30)}…`,
                onClick: () => toast({ title: m.from, desc: m.text, tone: 'info' }),
              })),
              'sep' as const,
              { label: 'Mark all as read', onClick: () => toast({ title: 'All notifications marked read', tone: 'success' }) },
            ]}
          />

          <Dropdown
            align="right"
            trigger={
              <button className="ui9-icon hidden h-11 items-center gap-1.5 rounded-lg px-2 lg:flex"
                aria-label="Switch interface" title="Switch interface">
                <LayoutTemplate className="h-[18px] w-[18px]" />
                <span className="hidden text-[12.5px] font-medium xl:block">{app.uiDef.label}</span>
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
            }
            items={UIS.map((u) => ({
              label: `${app.ui === u.id ? '✓ ' : ''}${u.label} — ${u.name}`,
              onClick: () => app.setUi(u.id),
            }))}
          />

          {/* One named control rather than three icons to tell apart. */}
          <Dropdown
            align="right"
            trigger={
              <button className="ui9-icon grid h-11 w-11 place-items-center rounded-lg" aria-label="View options" title="View options">
                <SlidersHorizontal className="h-[18px] w-[18px]" />
              </button>
            }
            items={[
              { label: app.theme === 'dark' ? 'Light appearance' : 'Dark appearance',
                icon: app.theme === 'dark' ? Sun : Moon,
                onClick: () => app.setTheme(app.theme === 'dark' ? 'light' : 'dark') },
              { label: 'Typeface & density', icon: Settings, onClick: () => setAppearanceOpen(true) },
{ label: 'Colour settings', icon: Palette, onClick: () => setBgOpen(true) },
              { label: fullscreen ? 'Exit full screen' : 'Full screen', icon: fullscreen ? Shrink : Expand, onClick: toggleFullscreen },
            ]}
          />

          {/* Account */}
          <Dropdown
            align="right"
            trigger={
              <button className="ui9-profile ml-0.5 flex h-11 shrink-0 items-center gap-2 rounded-lg px-1 pr-2" aria-label="Account menu">
                <Avatar name={industry.user.name} size={30} />
                <span className="hidden text-left leading-tight lg:block">
                  <span className="block text-[12.5px] font-semibold">{industry.user.name}</span>
                  <span className="block text-[10.5px] muted">{role.label}</span>
                </span>
                <ChevronDown className="hidden h-3.5 w-3.5 muted lg:block" />
              </button>
            }
            items={[
              { label: 'Profile', icon: UserCog, onClick: () => toast({ title: industry.user.name, desc: role.scope, tone: 'info' }) },
              { label: 'Account settings', icon: Settings, onClick: () => nav('/settings') },
              { label: 'Switch workspace', icon: Building2, onClick: () => setSheetOpen(true) },
              { label: 'Help & support', icon: HelpCircle, onClick: () => toast({ title: 'Support', desc: 'Prototype build — no support desk wired up.', tone: 'info' }) },
              'sep' as const,
              ...industry.roles.map((r) => ({
                label: `${app.role === r.id ? '✓ ' : ''}View as ${r.label}`,
                onClick: () => { app.setRole(r.id); nav(homePathFor(r.id)) },
              })),
              'sep' as const,
              { label: 'Sign out', icon: LogOut, danger: true, onClick: () => toast({ title: 'Sign-out is disabled in the prototype', tone: 'info' }) },
            ]}
          />
        </div>
      </header>

      <WorkspaceSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
      <AppearanceDialog open={appearanceOpen} onClose={() => setAppearanceOpen(false)} />
      <BackgroundPicker open={bgOpen} onClose={() => setBgOpen(false)} />
      <Ui9BottomNav />
    </>
  )
}

/* ------------------------------------------------------------- context --- */
function Scope({ icon: Icon, label, value, options, onChange }: {
  icon: typeof Landmark; label: string; value: string; options: string[]; onChange: (v: string) => void
}) {
  return (
    <Dropdown
      align="left"
      className="min-w-0 shrink"
      trigger={
        <button className="ui9-scope flex h-10 w-full min-w-[104px] max-w-[150px] shrink items-center gap-1.5 rounded-lg px-2.5 text-[13px]"
          aria-label={`${label}: ${value}`}>
          <Icon className="h-4 w-4 shrink-0 muted" />
          <span className="truncate">{value}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 muted" />
        </button>
      }
      items={options.map((o) => ({ label: (o === value ? '✓ ' : '') + o, onClick: () => onChange(o) }))}
    />
  )
}

/* ------------------------------------------------------ workspace sheet --- */
function WorkspaceSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp()
  const [inst, setInst] = useState(app.institution)
  const [camp, setCamp] = useState(app.campus)
  const [yr, setYr] = useState(app.year)
  useEffect(() => { if (open) { setInst(app.institution); setCamp(app.campus); setYr(app.year) } }, [open])

  const apply = () => { app.setInstitution(inst); app.setCampus(camp); app.setYear(yr); onClose() }

  const group = (label: string, value: string, options: string[], set: (v: string) => void) => (
    <div key={label}>
      <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider muted">{label}</p>
      <div className="grid gap-1">
        {options.map((o) => (
          <button
            key={o}
            onClick={() => set(o)}
            aria-pressed={o === value}
            className={cx('flex min-h-[48px] items-center gap-2.5 rounded-lg border px-3 text-left text-[14px]',
              o === value ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.08)] font-medium' : 'hover:bg-accent/60')}
          >
            <span className="min-w-0 flex-1 truncate">{o}</span>
            {o === value && <Check className="h-4 w-4 shrink-0 text-[hsl(var(--primary))]" />}
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <Modal open={open} onClose={onClose} title="Switch workspace" size="sm"
      footer={<><button onClick={onClose} className="ui9-ghost h-11 rounded-lg px-4 text-[13px]">Cancel</button>
        <button onClick={apply} className="ui9-cta h-11 rounded-lg px-4 text-[13px] font-medium">Apply</button></>}>
      <div className="space-y-5">
        {group('Institution', inst, app.institutions, setInst)}
        {group('Campus', camp, app.campuses, setCamp)}
        {group('Academic year', yr, app.years, setYr)}
      </div>
    </Modal>
  )
}

/* ---------------------------------------------------------- bottom nav --- */
/** The destinations a role actually uses, within reach of a thumb. */
const BOTTOM_BY_ROLE: Record<string, { label: string; to: string; icon: typeof Landmark }[]> = {
  parent: [
    { label: 'Home', to: '/parent-portal', icon: LayoutGrid },
    { label: 'Children', to: '/parent-portal', icon: GraduationCap },
    { label: 'Messages', to: '/communication', icon: Mail },
    { label: 'Profile', to: '/settings', icon: UserCog },
  ],
  student: [
    { label: 'Home', to: '/student-portal', icon: LayoutGrid },
    { label: 'Classes', to: '/lms', icon: GraduationCap },
    { label: 'Library', to: '/library', icon: Building2 },
    { label: 'Profile', to: '/settings', icon: UserCog },
  ],
  faculty: [
    { label: 'Home', to: '/dashboard', icon: LayoutGrid },
    { label: 'Classes', to: '/timetable', icon: GraduationCap },
    { label: 'Attendance', to: '/attendance', icon: Check },
    { label: 'Messages', to: '/communication', icon: Mail },
  ],
}

function Ui9BottomNav() {
  const app = useApp()
  const reach = useMemo(() => new Set(modulesForRole(app.role).map((m) => m.id)), [app.role, app.industryId])
  const items = (BOTTOM_BY_ROLE[app.role] ?? [
    { label: 'Home', to: '/dashboard', icon: LayoutGrid },
    { label: 'Students', to: '/students', icon: GraduationCap },
    { label: 'Finance', to: '/finance', icon: Building2 },
    { label: 'Inbox', to: '/communication', icon: Mail },
  ]).filter((i) => reach.has(i.to.split('/')[1] ?? ''))

  if (items.length < 2) return null

  return (
    <nav aria-label="Primary" className="ui9-bottom fixed inset-x-0 bottom-0 z-30 grid grid-flow-col border-t no-print sm:hidden"
      style={{ background: 'hsl(var(--chrome))', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {items.map((i) => (
        <Link key={i.label} to={i.to}
          className="flex min-h-[56px] flex-col items-center justify-center gap-1 text-[10.5px] muted">
          <i.icon className="h-[18px] w-[18px]" />
          {i.label}
        </Link>
      ))}
    </nav>
  )
}
