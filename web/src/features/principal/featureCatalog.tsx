import { useState, type ReactNode } from 'react'
import { Badge, Card, Select, Switch, SEG_BAR, segClass } from '@/components/ui'
import { SearchBox } from '@/components/rows'
import { cn } from '@/lib/utils'

/* One grantable screen, as served by GET /api/v1/admin/features: one item per
   catalogue KEY. The same name in two workspaces is usually two screens ("Take
   attendance" for a teacher is their register; for the office it is the
   school's register with import and export), so it is listed, held and
   granted by its exact key, with the workspace it belongs to beside it. */
export interface FeatureItem {
  key: string
  name: string
  summary: string
  unlocks: string[]
  role_key: string
  role_name: string
  section: string
}

/* GENERAL: the self-service screens that are one screen in every workspace.
   Each slug below is served under 5 to 21 workspaces and every one of those
   keys opens the same component in features/registry.ts (comms/Inbox,
   comms/StaffMessages, hr/Leave, me/MyPay), showing the person's own mail,
   threads, leave or payslips whichever workspace they open it from. Listed
   once; granting it grants every variant key so it works wherever they are.
   subject_overview also shares one component across three workspaces but is
   scoped to the subjects a person heads, so it stays with its workspace. */
const GENERAL_SLUGS = ['inbox', 'messages', 'leave_self_service', 'my_pay']

/** One screen as the person sees it: a single key, or a General screen covering many. */
interface Entry {
  id: string
  name: string
  summary: string
  workspace: string
  keys: string[]
}

function entries(items: FeatureItem[]): Entry[] {
  const general: Entry[] = []
  const rest: Entry[] = []
  for (const f of items) {
    const slug = f.key.split('.').pop() ?? ''
    if (GENERAL_SLUGS.includes(slug)) {
      const e = general.find((g) => g.id === slug)
      if (e) e.keys.push(f.key)
      else general.push({ id: slug, name: f.name, summary: f.summary, workspace: 'General', keys: [f.key] })
      continue
    }
    rest.push({ id: f.key, name: f.name, summary: f.summary, workspace: f.role_name, keys: [f.key] })
  }
  return [...general, ...rest]
}

type Status = 'all' | 'active' | 'role' | 'direct' | 'none'

/* Every built feature as one flat list, each with a switch: on means the
   person can open it. From a role: on and locked, the role is what to change.
   Direct: on, can be turned off. Inactive: off, turning it on grants it to
   this person directly. `roleGrants` maps a key to the names of the roles
   granting it; `direct` is their direct set. `header` receives the counts so
   the card above can say how many they hold. */
export function FeatureAccess({ items, roleGrants, direct, busy, onChange, header }: {
  items: FeatureItem[]
  roleGrants: Map<string, string[]>
  direct: Set<string>
  busy: boolean
  onChange: (keys: string[], on: boolean) => void
  header: (held: number, total: number) => ReactNode
}) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<Status>('all')
  const [workspace, setWorkspace] = useState('')
  const list = entries(items)
  const workspaces = [...new Set(list.map((e) => e.workspace))]

  const fromRoles = (e: Entry) => [...new Set(e.keys.flatMap((k) => roleGrants.get(k) ?? []))]
  const stateOf = (e: Entry): Exclude<Status, 'all' | 'active'> =>
    fromRoles(e).length ? 'role' : e.keys.some((k) => direct.has(k)) ? 'direct' : 'none'
  const count = (s: Status) => list.filter((e) => s === 'all' || (s === 'active' ? stateOf(e) !== 'none' : stateOf(e) === s)).length
  const tabs: { key: Status; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'active', label: `Active (${count('active')})` },
    { key: 'role', label: `From role (${count('role')})` },
    { key: 'direct', label: `Direct (${count('direct')})` },
    { key: 'none', label: `Inactive (${count('none')})` },
  ]

  const q = search.trim().toLowerCase()
  const shown = list.filter((e) => {
    if (workspace && e.workspace !== workspace) return false
    const s = stateOf(e)
    if (status === 'active' ? s === 'none' : status !== 'all' && s !== status) return false
    return !q || e.name.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q) || e.workspace.toLowerCase().includes(q)
  })

  return (
    <div className="min-w-0 space-y-3">
      {header(count('active'), list.length)}
      <div className="rounded-xl border border-warning/30 bg-warning/[0.07] px-4 py-3 text-[13px]">
        Access normally comes from roles. Use this screen only for one-off extras.
      </div>
      <Card className="min-w-0">
        <div className="flex min-w-0 flex-wrap gap-2 p-[var(--card-pad)]">
          <SearchBox value={search} onChange={setSearch} placeholder="Search features" className="w-full min-w-0 flex-1 sm:min-w-[200px]" />
          <div className="w-full sm:w-56">
            <Select value={workspace} onChange={setWorkspace} options={[{ value: '', label: 'All workspaces' }, ...workspaces.map((w) => ({ value: w, label: w }))]} />
          </div>
        </div>
      </Card>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className={SEG_BAR} role="group" aria-label="Show">
            {tabs.map((s) => (
              <button key={s.key} type="button" aria-pressed={status === s.key} onClick={() => setStatus(s.key)} className={cn(segClass(status === s.key), 'whitespace-nowrap')}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <span className="shrink-0 text-[12.5px] text-muted-foreground">{list.length} total</span>
      </div>
      <Card className="min-w-0">
        {shown.length === 0 ? (
          <p className="p-[var(--card-pad)] text-[13px] text-muted-foreground">No features match.</p>
        ) : (
          <ul className="divide-y">
            {shown.map((e) => {
              const s = stateOf(e)
              const roles = fromRoles(e)
              return (
                <li key={e.id} className="flex min-w-0 items-center gap-3 px-[var(--card-pad)] py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium">{e.name}</span>
                    <span className="block truncate text-[12.5px] text-muted-foreground">
                      {s === 'role' ? `From ${roles.join(', ')}` : e.summary || e.workspace}
                    </span>
                    <span className="block truncate text-[12px] text-muted-foreground">{e.workspace}</span>
                  </span>
                  <Badge tone={s === 'role' ? 'success' : s === 'direct' ? 'primary' : 'neutral'}>
                    {s === 'role' ? 'From role' : s === 'direct' ? 'Direct' : 'Inactive'}
                  </Badge>
                  <Switch
                    on={s !== 'none'}
                    disabled={s === 'role' || busy}
                    label={e.name}
                    title={s === 'role' ? 'Given by a role. Change their roles to remove it.' : undefined}
                    onChange={(on) => onChange(e.keys, on)}
                  />
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}
