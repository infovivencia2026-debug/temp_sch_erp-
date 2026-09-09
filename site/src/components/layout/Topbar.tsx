import { useState } from 'react'
import { useNavigate } from '@/lib/nav'
import {
  Bell, Building2, CalendarRange, Check, ChevronDown, Expand, Grid3x3, Mail, Menu, Moon, Plus,
  Search, Shrink, SlidersHorizontal, Sun, UserCog, LogOut, LayoutTemplate, Settings, HelpCircle, Landmark, Link, Copy, ExternalLink, GraduationCap,
  Palette,
} from 'lucide-react'
import { Avatar, Badge, Button, Dropdown, Modal, useToast } from '@/components/ui'
import { useApp, UIS } from '@/hooks/useAppState'
import { AppearanceDialog } from '@/components/layout/appearance'
import { BackgroundPicker } from '@/components/layout/BackgroundPicker'
import { activeRole, homePathFor, INDUSTRIES, modulesForRole } from '@/industries'
import { industryPath } from '@/lib/nav'
import { cx, fmtDate, TODAY } from '@/lib/utils'
import { isSingleIndustry } from '@/lib/deployment'

export function Topbar() {
  const nav = useNavigate()
  const toast = useToast()
  const app = useApp()
  const [quickOpen, setQuickOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [bgOpen, setBgOpen] = useState(false)

  const toggleFullscreen = () => {
    const el = document.documentElement
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {})
    else document.exitFullscreen?.().catch(() => {})
    setFullscreen((f) => !f)
  }

  const role = activeRole(app.role)
  // Only offer shortcuts this role can actually follow.
  const reachable = new Set(modulesForRole(app.role).map((m) => m.id))
  const quickCreate = app.industry.quickCreate.filter((q) => reachable.has(q.to.split('/')[1] ?? ''))
  const industry = app.industry
  const notifications = industry.notifications
  const messages = industry.messages

  const dedicatedDomainUrl = 'http://education.187-127-178-100.sslip.io'
  const relativeLinkUrl = window.location.origin + '/education'

  const copyLink = (url: string) => {
    navigator.clipboard.writeText(url)
    setCopied(true)
    toast({ title: 'Separate ERP Link Copied!', desc: url, tone: 'success' })
    setTimeout(() => setCopied(false), 2500)
  }

  return (
    <header className="sticky top-0 z-40 flex h-[68px] items-center gap-2 border-b chrome px-3 no-print sm:gap-3 sm:px-5">
      <button className="rounded-full p-2.5 hover:bg-accent lg:hidden" aria-label="Open navigation"
        onClick={() => app.setMobileNavOpen(true)}>
        <Menu className="h-5 w-5" />
      </button>

      {!isSingleIndustry && <span className="hidden lg:contents"><IndustrySwitcher /></span>}
      <UiSwitcher />

      {/* Scope selectors */}
      <div className="hidden min-w-0 shrink items-center gap-1.5 xl:flex">
        <ScopePicker icon={Landmark} value={app.institution} options={app.institutions} onChange={app.setInstitution} />
        {/* The campus is chosen from the campus directory and carried in the
            URL, so a second picker in the bar was a second source of truth. */}
        <ScopePicker icon={CalendarRange} value={app.year} options={app.years} onChange={app.setYear} />
      </div>

      {/* Global search */}
      <button
        onClick={() => app.setPaletteOpen(true)}
        className="ml-2 flex h-10 min-w-0 flex-1 shrink items-center gap-2.5 overflow-hidden rounded-full hairline px-3 text-[13px] muted transition-colors duration-300 ease-premium hover:bg-accent/60"
      >
        <Search className="h-4 w-4" />
        <span className="truncate">{industry.searchHint}</span>
      </button>

      {/* shrink-0: without it the cluster gives way before the search does, and
          its buttons squeeze to slivers instead of the field narrowing. */}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="outline" icon={Link} className="hidden sm:inline-flex border-indigo-500/40 text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-950/40" onClick={() => setLinkOpen(true)}>
          EduLink
        </Button>

        {quickCreate.length > 0 && (
          <Button size="sm" variant="primary" icon={Plus} aria-label="Create" onClick={() => setQuickOpen(true)}>
            <span className="hidden sm:inline">Create</span>
          </Button>
        )}

        <Dropdown
          align="right"
          trigger={
            <button className="relative rounded-full p-2.5 hover:bg-accent" aria-label="Notifications" title="Notifications">
              <Bell className="h-[18px] w-[18px]" />
              <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[9px] font-semibold text-primary-foreground">{notifications.length}</span>
            </button>
          }
          items={[
            ...notifications.map((n) => ({ label: n.title, onClick: () => toast({ title: n.title, desc: `${n.desc} · ${n.time}`, tone: 'info' as const }) })),
            'sep' as const,
            ...messages.map((m) => ({ label: `${m.from}: ${m.text.slice(0, 30)}…`, onClick: () => toast({ title: m.from, desc: m.text, tone: 'info' as const }) })),
            'sep' as const,
            { label: 'Mark all as read', onClick: () => toast({ title: 'All notifications marked read', tone: 'success' }) },
          ]}
        />

        <Dropdown
          align="right"
          trigger={
            <button className="rounded-full p-2.5 hover:bg-accent" aria-label="View options" title="View options">
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

        <Dropdown
          align="right"
          trigger={
            <button className="ml-1 flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg py-1 pl-1 pr-2 hover:bg-accent">
              <Avatar name={industry.user.name} size={28} />
              <span className="hidden text-left leading-tight xl:block">
                <span className="block text-[12px] font-semibold">{industry.user.name}</span>
                <span className="block text-[10px] muted">{role.label}</span>
              </span>
              <ChevronDown className="h-3.5 w-3.5 muted" />
            </button>
          }
          items={[
            { label: 'Education ERP Hub (21 UI)', icon: GraduationCap, onClick: () => nav('/education') },
            { label: 'My profile', icon: UserCog, onClick: () => toast({ title: industry.user.name, desc: role.scope, tone: 'info' }) },
            { label: 'Preferences', icon: Settings, onClick: () => nav('/settings') },
            { label: 'Help & support', icon: HelpCircle, onClick: () => toast({ title: 'Support', desc: 'Prototype build — no support desk wired up.', tone: 'info' }) },
            'sep',
            ...industry.roles.map((r) => ({
              label: `${app.role === r.id ? '✓ ' : ''}View as ${r.label}`,
              onClick: () => {
                app.setRole(r.id)
                toast({ title: `Now previewing as ${r.label}`, desc: r.scope, tone: 'info' })
                nav(homePathFor(r.id))
              },
            })),
            'sep',
            { label: 'Sign out', icon: LogOut, danger: true, onClick: () => toast({ title: 'Sign-out is disabled in the prototype', tone: 'info' }) },
          ]}
        />
      </div>

      {/* Separate ERP Link Modal */}
      <Modal open={linkOpen} onClose={() => setLinkOpen(false)} title="Separate Education ERP Links" subtitle="Standalone link configurations for deployment and direct browser access">
        <div className="space-y-4">
          <div className="rounded-lg bg-accent/40 p-3.5 hairline text-xs space-y-2">
            <p className="font-semibold text-foreground flex items-center gap-1.5">
              <GraduationCap className="h-4 w-4 text-primary" /> Dedicated Education ERP Subdomain Link
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={dedicatedDomainUrl}
                className="flex-1 rounded border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground select-all"
              />
              <Button size="sm" variant="primary" onClick={() => copyLink(dedicatedDomainUrl)}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <div className="rounded-lg bg-accent/40 p-3.5 hairline text-xs space-y-2">
            <p className="font-semibold text-foreground flex items-center gap-1.5">
              <ExternalLink className="h-4 w-4 text-primary" /> Local Standalone Route Link
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={relativeLinkUrl}
                className="flex-1 rounded border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground select-all"
              />
              <Button size="sm" variant="outline" onClick={() => { setLinkOpen(false); nav('/education') }}>
                Launch Hub
              </Button>
            </div>
          </div>

          <div className="pt-2 flex justify-end">
            <Button size="sm" variant="secondary" onClick={() => setLinkOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      </Modal>
      <QuickCreate open={quickOpen} onClose={() => setQuickOpen(false)} items={quickCreate} />
      <AppearanceDialog open={appearanceOpen} onClose={() => setAppearanceOpen(false)} />
      <BackgroundPicker open={bgOpen} onClose={() => setBgOpen(false)} />
    </header>
  )
}

function ScopePicker({ icon: Icon, value, options, onChange }: {
  icon: React.ComponentType<{ className?: string }>; value: string; options: string[]; onChange: (v: string) => void
}) {
  return (
    <Dropdown
      align="left"
      className="min-w-0 shrink"
      trigger={
        <button className="flex h-9 w-full min-w-[112px] max-w-[210px] shrink items-center gap-1.5 rounded-lg hairline px-2.5 text-[13px] hover:bg-accent/60">
          <Icon className="h-4 w-4 shrink-0 muted" />
          <span className="truncate">{value}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 muted" />
        </button>
      }
      items={options.map((o) => ({ label: (o === value ? '✓ ' : '') + o, onClick: () => onChange(o) }))}
    />
  )
}

function QuickCreate({ open, onClose, items }: {
  open: boolean; onClose: () => void; items: { label: string; to: string }[]
}) {
  const nav = useNavigate()
  const toast = useToast()
  return (
    <Modal open={open} onClose={onClose} title="Quick create" subtitle={`Working context · ${fmtDate(TODAY)}`}>
      <div className="grid gap-2 sm:grid-cols-2">
        {items.map((q) => (
          <button
            key={q.label}
            onClick={() => { onClose(); nav(q.to); toast({ title: `${q.label} — opening module`, tone: 'info' }) }}
            className="flex items-center gap-2 rounded-lg hairline px-3 py-2.5 text-left text-sm hover:bg-accent/60"
          >
            <Plus className="h-4 w-4 muted" /> {q.label}
          </button>
        ))}
      </div>
    </Modal>
  )
}

/** Move between verticals without losing the current session. */
function IndustrySwitcher() {
  const app = useApp()
  const nav = useNavigate()
  return (
    <Dropdown
      align="left"
      trigger={
        <button className="flex h-9 items-center gap-2 rounded-full hairline px-3 text-[13px] hover:bg-accent/60" title="Switch industry">
          <app.industry.icon className="h-4 w-4 shrink-0 text-primary" />
          <span className="hidden truncate sm:block">{app.industry.label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 muted" />
        </button>
      }
      items={[
        { label: 'All industries — home', icon: Grid3x3, onClick: () => nav('/') },
        'sep' as const,
        ...INDUSTRIES.map((ind) => ({
          label: `${app.industryId === ind.id ? '✓ ' : ''}${ind.label} — ${ind.product}`,
          onClick: () => {
            if (ind.id === app.industryId) return
            app.setIndustry(ind.id)
            nav(industryPath(homePathFor(ind.user.defaultRole), ind.id))
          },
        })),
      ]}
    />
  )
}

/** The same application in a different shell — switchable without leaving the page. */
function UiSwitcher() {
  const app = useApp()
  return (
    <Dropdown
      align="left"
      trigger={
        <button className="hidden h-9 items-center gap-1.5 rounded-full hairline px-3 text-[13px] hover:bg-accent/60 md:flex" title="Switch interface">
          <LayoutTemplate className="h-4 w-4 shrink-0 muted" />
          <span className="hidden truncate 2xl:block">{app.uiDef.label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 muted" />
        </button>
      }
      items={UIS.map((u) => ({
        label: `${app.ui === u.id ? '✓ ' : ''}${u.label} — ${u.name}`,
        onClick: () => app.setUi(u.id),
      }))}
    />
  )
}
