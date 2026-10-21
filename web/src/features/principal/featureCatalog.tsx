import { useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Badge, Card, Select, SEG_BAR, segClass } from '@/components/ui'
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
const GENERAL = 'general'

/** One row in the editor: a single key, or a General screen covering many. */
interface Entry {
  id: string
  name: string
  summary: string
  unlocks: string[]
  where: string
  group: string
  keys: string[]
}

function entries(items: FeatureItem[]): { list: Entry[]; groups: { key: string; name: string }[] } {
  const list: Entry[] = []
  const general = new Map<string, Entry>()
  const groups = [{ key: GENERAL, name: 'General' }]
  for (const f of items) {
    const slug = f.key.split('.').pop() ?? ''
    if (GENERAL_SLUGS.includes(slug)) {
      const e = general.get(slug)
      if (e) { e.keys.push(f.key); for (const u of f.unlocks) if (!e.unlocks.includes(u)) e.unlocks.push(u); continue }
      const g: Entry = { id: slug, name: f.name, summary: f.summary, unlocks: [...f.unlocks], where: 'Every workspace', group: GENERAL, keys: [f.key] }
      general.set(slug, g)
      list.push(g)
      continue
    }
    if (!groups.some((g) => g.key === f.role_key)) groups.push({ key: f.role_key, name: f.role_name })
    list.push({ id: f.key, name: f.name, summary: f.summary, unlocks: f.unlocks, where: f.section, group: f.role_key, keys: [f.key] })
  }
  return { list, groups: groups.filter((g) => list.some((e) => e.group === g.key)) }
}

type Status = 'all' | 'held' | 'role' | 'direct' | 'none'
const STATUSES: { key: Status; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'held', label: 'Held' },
  { key: 'role', label: 'From roles' },
  { key: 'direct', label: 'Given directly' },
  { key: 'none', label: 'Not held' },
]

/* Every built feature and how this person holds it: through a role (ticked,
   locked: the role is what to change), given directly (ticked, removable), or
   not at all. `roleGrants` maps a key to the names of the roles granting it;
   `direct` is the direct set being edited. */
export function FeatureAccess({ items, roleGrants, direct, onChange }: {
  items: FeatureItem[]
  roleGrants: Map<string, string[]>
  direct: Set<string>
  onChange: (keys: string[], on: boolean) => void
}) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<Status>('all')
  const [group, setGroup] = useState('')
  const { list, groups } = entries(items)

  const fromRoles = (e: Entry) => [...new Set(e.keys.flatMap((k) => roleGrants.get(k) ?? []))]
  const stateOf = (e: Entry): Exclude<Status, 'all' | 'held'> =>
    fromRoles(e).length ? 'role' : e.keys.some((k) => direct.has(k)) ? 'direct' : 'none'

  const q = search.trim().toLowerCase()
  const shown = list.filter((e) => {
    if (group && e.group !== group) return false
    const s = stateOf(e)
    if (status === 'held' ? s === 'none' : status !== 'all' && s !== status) return false
    return !q || e.name.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q) || e.where.toLowerCase().includes(q)
  })
  const filtering = q !== '' || status !== 'all' || group !== ''

  return (
    <div className="space-y-3">
      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-2 bg-card px-1 pb-2 pt-1">
        <SearchBox value={search} onChange={setSearch} placeholder="Search features" className="min-w-[200px] flex-1" />
        <div className="w-full sm:w-56">
          <Select
            value={group}
            onChange={setGroup}
            options={[{ value: '', label: 'Every workspace' }, ...groups.map((g) => ({ value: g.key, label: g.name }))]}
          />
        </div>
        <div className={SEG_BAR} role="group" aria-label="Show">
          {STATUSES.map((s) => (
            <button key={s.key} type="button" aria-pressed={status === s.key} onClick={() => setStatus(s.key)} className={segClass(status === s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        <span className="text-[12.5px] text-muted-foreground">
          {filtering ? `${shown.length} of ${list.length}` : `${list.length} features`}
        </span>
      </div>

      {groups.map((g) => {
        const rows = shown.filter((e) => e.group === g.key)
        if (!rows.length) return null
        const all = list.filter((e) => e.group === g.key)
        return (
          <FeatureGroup key={g.key} name={g.name} held={all.filter((e) => stateOf(e) !== 'none').length} total={all.length} forceOpen={filtering}>
            {rows.map((e) => {
              const s = stateOf(e)
              const on = s !== 'none'
              const roles = fromRoles(e)
              return (
                <button
                  key={e.id}
                  type="button"
                  disabled={s === 'role'}
                  title={s === 'role' ? 'Held through a role. Change the roles above to remove it.' : undefined}
                  onClick={() => onChange(e.keys, s === 'none')}
                  className={cn(
                    'flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors duration-150',
                    s === 'role' ? 'cursor-default bg-muted/50' : on ? 'border-primary/40 bg-accent' : 'hover:bg-accent/60',
                  )}
                >
                  <span className={cn('mt-0.5 flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[3px] border', on ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
                    {on && <Check className="h-2.5 w-2.5" strokeWidth={3.5} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[14px] font-medium">{e.name}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">{e.where}</span>
                    <span className="mt-1 block">
                      {s === 'role'
                        ? <Badge tone="success">From role: {roles.join(', ')}</Badge>
                        : s === 'direct'
                          ? <Badge tone="primary">Given directly</Badge>
                          : <Badge tone="neutral">Not held</Badge>}
                    </span>
                    {e.unlocks.length > 0 && (
                      <span className="mt-0.5 block text-[12px] text-muted-foreground">Also grants: {e.unlocks.join(', ')}</span>
                    )}
                  </span>
                </button>
              )
            })}
          </FeatureGroup>
        )
      })}
      {shown.length === 0 && <p className="text-[13px] text-muted-foreground">No features match.</p>}
    </div>
  )
}

/** A workspace card with how many of its features are held. Closed by
    default; `forceOpen` opens it while a search or filter has hits inside. */
function FeatureGroup({ name, held, total, forceOpen, children }: {
  name: string
  held: number
  total: number
  forceOpen: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const shown = open || forceOpen
  return (
    <Card>
      <button type="button" onClick={() => setOpen(!shown)} aria-expanded={shown}
        className={cn('flex min-h-[44px] w-full items-center gap-3 px-[var(--card-pad)] py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-[40px]', shown && 'border-b')}>
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em]">{name}</span>
        <Badge tone={held ? 'primary' : 'neutral'}>{held} / {total} held</Badge>
        <ChevronDown aria-hidden className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150', !shown && '-rotate-90')} />
      </button>
      {shown && <div className="grid gap-1.5 p-[var(--card-pad)] sm:grid-cols-2">{children}</div>}
    </Card>
  )
}
