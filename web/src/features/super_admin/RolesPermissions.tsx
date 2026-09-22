import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, Plus, Check, Download, ShieldCheck } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Button, Input,
  Table, Td, Badge, Loading, SkeletonTable, ErrorState, EmptyState, FormNotice,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import { PickerMenu } from '@/components/PickerMenu'

/* Roles as a school reads them.

   The old screen listed a role's permission keys. It was accurate and nobody
   could act on it: "academics.attendance.write.any" does not tell a head
   teacher whether the new accountant can mark a register. This screen shows
   the same grants as feature groups with a level and a data scope, and writes
   the grid back as keys. internal/rbac/model.go owns the mapping. */

interface AdminRole {
  id: string
  key: string
  name: string
  is_system: boolean
  is_default: boolean
  institution?: string
  permissions: number
  capabilities: number
  users: number
}

interface GroupState {
  group: string
  level: string
  scope: string
  approve: boolean
  export: boolean
  extra?: string[]
}

interface GridGroup extends GroupState {
  key: string
  name: string
  blurb: string
  band: 'core' | 'optional' | 'system'
  levels: string[]
  can_approve: boolean
  approve_note?: string
  can_export: boolean
  scope_options: { scope: string; label: string }[]
  scope_note?: string
}

interface RoleGrid {
  id: string
  key: string
  name: string
  is_system: boolean
  is_default: boolean
  editable: boolean
  lock_note?: string
  users: number
  feature_grants: number
  groups: GridGroup[]
}

interface RoleFeature {
  key: string
  name: string
  summary: string
  held: boolean
}

interface RoleFeatureSection {
  slug: string
  name: string
  features: RoleFeature[]
}

interface RoleFeatures {
  workspace: boolean
  sections: RoleFeatureSection[]
}

interface InstallableRole {
  key: string
  name: string
  description: string
  installed: boolean
  permissions: number
}

const BANDS: { band: GridGroup['band']; title: string; blurb: string }[] = [
  { band: 'core', title: 'Everyday school work', blurb: 'What every school uses.' },
  { band: 'optional', title: 'Optional modules', blurb: 'Switched on when the school buys or uses them.' },
  { band: 'system', title: 'Portals & platform', blurb: 'Arrives with the person’s record. Rarely edited here.' },
]

const LEVEL_LABEL: Record<string, string> = {
  none: 'No access',
  view: 'View',
  manage: 'Manage',
}

const LEVEL_HINT: Record<string, string> = {
  none: 'Hidden from the menu entirely.',
  view: 'Can open and read, but not change anything.',
  manage: 'Can create, edit and delete.',
}

export default function RolesPermissions() {
  const qc = useQueryClient()
  const [selectedID, setSelectedID] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, GroupState> | null>(null)
  const [showKeys, setShowKeys] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [saved, setSaved] = useState('')

  const roles = useQuery({
    queryKey: ['admin-roles'],
    queryFn: () => api.get<List<AdminRole>>('/api/v1/admin/roles'),
  })

  const grid = useQuery({
    queryKey: ['role-grid', selectedID],
    queryFn: () => api.get<RoleGrid>(`/api/v1/admin/roles/${selectedID}/grid`),
    enabled: !!selectedID,
  })

  const installable = useQuery({
    queryKey: ['installable-roles'],
    queryFn: () => api.get<List<InstallableRole>>('/api/v1/admin/installable-roles'),
  })

  // The draft is seeded from the server and edited locally, so a half-made
  // change is never posted a field at a time.
  useEffect(() => {
    if (!grid.data) return
    const next: Record<string, GroupState> = {}
    for (const g of grid.data.groups) {
      next[g.key] = {
        group: g.key, level: g.level, scope: g.scope,
        approve: g.approve, export: g.export, extra: g.extra,
      }
    }
    setDraft(next)
    setSaved('')
  }, [grid.data])

  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/v1/admin/roles/${selectedID}/grid`, {
        groups: Object.values(draft ?? {}),
      }),
    onSuccess: () => {
      setSaved('Saved. People holding this role pick it up on their next sign-in.')
      qc.invalidateQueries({ queryKey: ['role-grid', selectedID] })
      qc.invalidateQueries({ queryKey: ['admin-roles'] })
    },
  })

  const create = useMutation({
    mutationFn: (body: { name: string; copy_from?: string }) =>
      api.post<{ id: string }>('/api/v1/admin/roles', body),
    onSuccess: (r) => {
      setNewName('')
      setCreating(false)
      setSelectedID(r.id)
      qc.invalidateQueries({ queryKey: ['admin-roles'] })
    },
  })

  const install = useMutation({
    mutationFn: (key: string) => api.post('/api/v1/admin/roles/install', { key }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-roles'] })
      qc.invalidateQueries({ queryKey: ['installable-roles'] })
    },
  })

  const items = roles.data?.items ?? []
  const notInstalled = (installable.data?.items ?? []).filter((r) => !r.installed)

  const dirty = useMemo(() => {
    if (!grid.data || !draft) return false
    return grid.data.groups.some((g) => {
      const d = draft[g.key]
      return d && (d.level !== g.level || d.scope !== g.scope ||
        d.approve !== g.approve || d.export !== g.export)
    })
  }, [grid.data, draft])

  function set(key: string, patch: Partial<GroupState>) {
    setDraft((prev) => (prev ? { ...prev, [key]: { ...prev[key], ...patch } } : prev))
    setSaved('')
  }

  return (
    <>
      <PageHead
        eyebrow="Access & Security"
        title="Roles & permissions"
        description="What each role can do, and how much of the school it can see. Set a level per area of work rather than picking permissions one by one."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Roles" value={items.length} />
          <Stat label="Built in" value={items.filter((r) => r.is_system).length} hint="Restored on every upgrade" />
          <Stat label="Custom" value={items.filter((r) => !r.is_system).length} hint="Yours to edit" />
          <Stat label="Assigned users" value={items.reduce((a, r) => a + r.users, 0)} />
        </CellGrid>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader
                title="Roles"
                description="Select a role to see what it can do"
                action={
                  <Button size="sm" variant="secondary" onClick={() => setCreating((v) => !v)}>
                    <Plus className="h-3.5 w-3.5" /> New
                  </Button>
                }
              />
              {creating && (
                <div className="flex flex-col gap-2 border-b px-5 py-4">
                  <Input value={newName} onChange={setNewName} placeholder="e.g. Senior Accountant" />
                  <p className="text-[12px] text-muted-foreground">
                    Starts from the role selected on the left, so you adjust rather than build
                    from nothing. Every built-in is a preset this way — Accounts, HR and the
                    rest are starting points, and the copy is yours to change.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={!newName.trim() || create.isPending}
                      onClick={() =>
                        create.mutate({ name: newName.trim(), copy_from: grid.data?.key })
                      }
                    >
                      Create role
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                      Cancel
                    </Button>
                  </div>
                  <FormNotice error={create.error} />
                </div>
              )}
              {roles.isLoading ? (
                <SkeletonTable columns={3} />
              ) : roles.error ? (
                <ErrorState error={roles.error} />
              ) : (
                <Table head={['Role', 'Areas', 'Users']} empty={!items.length}>
                  {items.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => setSelectedID(r.id)}
                      className={cn(
                        'cursor-pointer transition-colors',
                        selectedID === r.id ? 'bg-accent' : 'hover:bg-accent/50',
                      )}
                    >
                      <Td className="font-medium">
                        {r.name}
                        {r.is_system && (
                          <Lock
                            className="ml-1.5 inline h-3 w-3 text-muted-foreground"
                            aria-label="Built in"
                          />
                        )}
                        <div className="font-mono text-[12px] text-muted-foreground">{r.key}</div>
                      </Td>
                      <Td>{r.capabilities}</Td>
                      <Td>{r.users || '—'}</Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>

            {notInstalled.length > 0 && (
              <Card>
                <CardHeader
                  title="Roles you can add"
                  description="Not set up by default — most schools do not need them"
                />
                <div className="divide-y">
                  {notInstalled.map((r) => (
                    <div key={r.key} className="flex items-start justify-between gap-3 px-5 py-3">
                      <div>
                        <p className="text-[13px] font-medium">{r.name}</p>
                        <p className="text-[12px] text-muted-foreground">{r.description}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={install.isPending}
                        onClick={() => install.mutate(r.key)}
                      >
                        Add
                      </Button>
                    </div>
                  ))}
                </div>
                <FormNotice error={install.error} />
              </Card>
            )}
          </div>

          <div className="flex flex-col gap-6">
          <Card>
            <CardHeader
              title={grid.data ? grid.data.name : 'Permissions'}
              description={
                grid.data
                  ? `${grid.data.users || 'No'} ${grid.data.users === 1 ? 'person holds' : 'people hold'} this role`
                  : undefined
              }
              action={
                grid.data?.editable ? (
                  <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
                    {save.isPending ? 'Saving…' : 'Save changes'}
                  </Button>
                ) : undefined
              }
            />

            {!selectedID ? (
              <div className="p-6">
                <EmptyState
                  title="Select a role"
                  body="Pick a role on the left to see what it can do and how much of the school it can see."
                />
              </div>
            ) : grid.isLoading ? (
              <Loading />
            ) : grid.error ? (
              <ErrorState error={grid.error} />
            ) : !grid.data || !draft ? null : (
              <>
                {grid.data.lock_note && (
                  <div className="mx-5 mt-4 flex items-start gap-2.5 rounded-md border border-dashed px-4 py-3">
                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="text-[13px] text-muted-foreground">
                      {grid.data.lock_note}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-1 h-auto px-1 py-0 align-baseline"
                        onClick={() => setCreating(true)}
                      >
                        Start from this preset
                      </Button>
                    </div>
                  </div>
                )}
                <FormNotice error={save.error} ok={saved} />

                {BANDS.map(({ band, title, blurb }) => {
                  const groups = grid.data!.groups.filter((g) => g.band === band)
                  if (!groups.length) return null
                  return (
                    <section key={band} className="border-b last:border-b-0">
                      <div className="flex items-baseline justify-between px-5 pb-1 pt-5">
                        <p className="eyebrow">{title}</p>
                        <span className="text-[12px] text-muted-foreground">{blurb}</span>
                      </div>
                      <div className="divide-y">
                        {groups.map((g) => (
                          <GroupRow
                            key={g.key}
                            group={g}
                            state={draft[g.key]}
                            editable={grid.data!.editable}
                            showKeys={showKeys}
                            onChange={(patch) => set(g.key, patch)}
                          />
                        ))}
                      </div>
                    </section>
                  )
                })}

                <div className="flex items-center justify-between px-5 py-4 text-[12px] text-muted-foreground">
                  <span>
                    {grid.data.feature_grants > 0 &&
                      `${grid.data.feature_grants} menu entries come with this role and are not set here.`}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setShowKeys((v) => !v)}>
                    {showKeys ? 'Hide' : 'Show'} permission keys
                  </Button>
                </div>
              </>
            )}
          </Card>

          {selectedID && <FeaturesEditor roleID={selectedID} />}
          </div>
        </div>
      </PageBody>
    </>
  )
}

/* Features (menu tiles): which navigation entries this role sees.

   The grid above decides what a role can do; this decides what it shows. A tile
   appears in the menu (from GET /api/v1/catalog) only when the role holds the
   catalog feature key behind it, so a checkbox here is an insert or a delete of
   that one key. It is deliberately separate from the grid, which never touches
   these keys. */
function FeaturesEditor({ roleID }: { roleID: string }) {
  const qc = useQueryClient()
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState('')

  const features = useQuery({
    queryKey: ['role-features', roleID],
    queryFn: () => api.get<RoleFeatures>(`/api/v1/admin/roles/${roleID}/features`),
  })

  // Seed the local checkbox state from the server whenever the role changes.
  useEffect(() => {
    if (!features.data) return
    const next: Record<string, boolean> = {}
    for (const sec of features.data.sections) {
      for (const f of sec.features) next[f.key] = f.held
    }
    setChecked(next)
    setSaved('')
  }, [features.data])

  const dirty = useMemo(() => {
    if (!features.data) return false
    return features.data.sections.some((sec) =>
      sec.features.some((f) => checked[f.key] !== f.held),
    )
  }, [features.data, checked])

  const save = useMutation({
    mutationFn: () => {
      const enable: string[] = []
      const disable: string[] = []
      for (const sec of features.data!.sections) {
        for (const f of sec.features) {
          if (checked[f.key] && !f.held) enable.push(f.key)
          if (!checked[f.key] && f.held) disable.push(f.key)
        }
      }
      return api.put(`/api/v1/admin/roles/${roleID}/features`, { enable, disable })
    },
    onSuccess: () => {
      setSaved('Saved. The menu updates on the next page load; people holding this role pick it up right away.')
      qc.invalidateQueries({ queryKey: ['role-features', roleID] })
      qc.invalidateQueries({ queryKey: ['role-grid', roleID] })
      // The server drops the resolve cache for everyone holding this role, so
      // refetch the menu here too — if the editor is themselves in that role,
      // a tile they just enabled appears without a reload.
      qc.invalidateQueries({ queryKey: ['catalog'] })
    },
  })

  if (features.isLoading) {
    return (
      <Card>
        <CardHeader title="Features (menu tiles)" />
        <Loading />
      </Card>
    )
  }
  if (features.error) {
    return (
      <Card>
        <CardHeader title="Features (menu tiles)" />
        <ErrorState error={features.error} />
      </Card>
    )
  }
  if (!features.data) return null

  if (!features.data.workspace) {
    return (
      <Card>
        <CardHeader title="Features (menu tiles)" />
        <div className="px-5 py-4 text-[13px] text-muted-foreground">
          This role has no workspace of its own, so it has no feature tiles to toggle.
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title="Features (menu tiles)"
        description="Which navigation tiles this role sees in its menu"
        action={
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        }
      />
      <div className="px-5 pt-4 text-[12px] text-muted-foreground">
        Turning a feature on adds it to this role’s menu. The person still needs the
        matching permission above for the screen to work.
      </div>
      <FormNotice error={save.error} ok={saved} />

      {features.data.sections.map((sec) => (
        <section key={sec.slug} className="border-b last:border-b-0">
          <div className="px-5 pb-1 pt-5">
            <p className="eyebrow">{sec.name}</p>
          </div>
          <div className="divide-y">
            {sec.features.map((f) => (
              <label
                key={f.key}
                className="flex cursor-pointer items-start gap-3 px-5 py-3 hover:bg-accent/50"
              >
                <input
                  type="checkbox"
                  className="mt-1 h-3.5 w-3.5 shrink-0"
                  checked={!!checked[f.key]}
                  onChange={(e) => {
                    const on = e.target.checked
                    setChecked((prev) => ({ ...prev, [f.key]: on }))
                    setSaved('')
                  }}
                />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">{f.name}</p>
                  <p className="text-[12px] text-muted-foreground">{f.summary}</p>
                </div>
              </label>
            ))}
          </div>
        </section>
      ))}
    </Card>
  )
}

/* One area of work: a level, a scope, and the two toggles that are not rungs.

   Approve and Export sit beside the level rather than above it because they
   are not supersets of editing — a head of department approves leave without
   editing employee records, and an accountant exports a ledger they cannot
   refund against. */
function GroupRow({
  group,
  state,
  editable,
  showKeys,
  onChange,
}: {
  group: GridGroup
  state: GroupState
  editable: boolean
  showKeys: boolean
  onChange: (patch: Partial<GroupState>) => void
}) {
  const off = state.level === 'none'
  const scopeChoices = group.scope_options
  const scopeLabel = scopeChoices.find((s) => s.scope === state.scope)?.label ?? state.scope

  return (
    <div className={cn('px-5 py-4', off && 'opacity-60')}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-[200px] flex-1">
          <p className="text-[13px] font-medium">{group.name}</p>
          <p className="text-[12px] text-muted-foreground">{group.blurb}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border" role="group" aria-label={`${group.name} level`}>
            {group.levels.map((l) => (
              <button
                key={l}
                type="button"
                disabled={!editable}
                title={LEVEL_HINT[l]}
                aria-pressed={state.level === l}
                onClick={() => onChange({ level: l })}
                className={cn(
                  // Dense on a desk; grown to a comfortable tap target on a
                  // coarse pointer (min-, so the 12px desk row is untouched).
                  '[@media(pointer:coarse)]:min-h-[40px] [@media(pointer:coarse)]:px-3.5',
                  'px-2.5 py-1 text-[12px] transition-colors',
                  state.level === l
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-accent',
                  !editable && 'cursor-not-allowed',
                )}
              >
                {LEVEL_LABEL[l]}
              </button>
            ))}
          </div>

          {scopeChoices.length > 1 ? (
            <PickerMenu
              value={state.scope}
              onChange={(v) => onChange({ scope: v })}
              ariaLabel={`${group.name} scope`}
              align="start"
              options={scopeChoices.map((s) => ({ value: s.scope, label: s.label }))}
              className={cn((!editable || off) && 'pointer-events-none opacity-50')}
            />
          ) : (
            <Badge>{scopeLabel}</Badge>
          )}

          {group.can_approve && (
            <Toggle
              on={state.approve && !off}
              disabled={!editable || off}
              icon={<ShieldCheck className="h-3 w-3" />}
              label="Approve"
              title={group.approve_note}
              onClick={() => onChange({ approve: !state.approve })}
            />
          )}
          {group.can_export && (
            <Toggle
              on={state.export && !off}
              disabled={!editable || off}
              icon={<Download className="h-3 w-3" />}
              label="Export"
              title="Download this data as a spreadsheet."
              onClick={() => onChange({ export: !state.export })}
            />
          )}
        </div>
      </div>

      {!off && group.scope_note && (
        <p className="mt-2 text-[12px] text-muted-foreground">{group.scope_note}</p>
      )}
      {state.extra && state.extra.length > 0 && (
        <p className="mt-2 text-[12px] text-muted-foreground">
          Also holds {state.extra.length} permission{state.extra.length > 1 ? 's' : ''} outside
          these levels: <span className="font-mono">{state.extra.join(', ')}</span>. Saving keeps
          {state.extra.length > 1 ? ' them' : ' it'}.
        </p>
      )}
      {showKeys && <KeyList group={group} state={state} />}
    </div>
  )
}

function Toggle({
  on, disabled, icon, label, title, onClick,
}: {
  on: boolean
  disabled: boolean
  icon: React.ReactNode
  label: string
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] transition-colors',
        '[@media(pointer:coarse)]:min-h-[40px] [@media(pointer:coarse)]:px-3',
        on ? 'border-primary bg-accent' : 'text-muted-foreground hover:bg-accent',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {on ? <Check className="h-3 w-3" /> : icon}
      {label}
    </button>
  )
}

/* The raw keys, for whoever has to answer an auditor.

   Kept behind a toggle rather than removed: the grid is what a school reads,
   and "which key does this actually grant" is a real question with a real
   audience — it is simply not the default one. */
function KeyList({ group, state }: { group: GridGroup; state: GroupState }) {
  return (
    <p className="mt-2 font-mono text-[11px] text-muted-foreground">
      {group.key} · {state.level}
      {state.scope && ` · ${state.scope}`}
      {state.approve && ' · approve'}
      {state.export && ' · export'}
    </p>
  )
}
