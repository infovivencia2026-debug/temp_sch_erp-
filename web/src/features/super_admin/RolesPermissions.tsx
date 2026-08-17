import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Lock } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { cn } from '@/lib/utils'

interface AdminRole {
  id: string
  key: string
  name: string
  is_system: boolean
  institution?: string
  permissions: number
  users: number
}

interface RolePermission {
  key: string
  module: string
  description: string
}

export default function RolesPermissions() {
  const [selected, setSelected] = useState<AdminRole | null>(null)

  const roles = useQuery({
    queryKey: ['admin-roles'],
    queryFn: () => api.get<List<AdminRole>>('/api/v1/admin/roles'),
  })

  const perms = useQuery({
    queryKey: ['role-permissions', selected?.id],
    queryFn: () => api.get<List<RolePermission>>(`/api/v1/admin/roles/${selected!.id}/permissions`),
    enabled: !!selected,
  })

  const items = roles.data?.items ?? []
  const totalGrants = items.reduce((a, r) => a + r.permissions, 0)
  const platform = items.filter((r) => !r.institution).length

  // Grants group by module so a 419-key role is readable.
  const byModule = new Map<string, RolePermission[]>()
  for (const p of perms.data?.items ?? []) {
    const list = byModule.get(p.module) ?? []
    list.push(p)
    byModule.set(p.module, list)
  }

  return (
    <>
      <PageHead
        eyebrow="Access & Security"
        title="Roles & permissions"
        description="Assign roles and inspect the data scope each one grants — institution, campus, department, class or self."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Roles" value={items.length} />
          <Stat label="Platform roles" value={platform} hint="Not owned by a tenant" />
          <Stat label="Total grants" value={totalGrants} />
          <Stat label="Assigned users" value={items.reduce((a, r) => a + r.users, 0)} />
        </CellGrid>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <Card>
            <CardHeader title="Roles" description="Select a role to inspect its grants" />
            {roles.isLoading ? (
              <Loading />
            ) : roles.error ? (
              <ErrorState error={roles.error} />
            ) : (
              <Table head={['Role', 'Scope', 'Grants', 'Users']} empty={!items.length}>
                {items.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => setSelected(r)}
                    className={cn(
                      'cursor-pointer transition-colors',
                      selected?.id === r.id ? 'bg-accent' : 'hover:bg-accent/50',
                    )}
                  >
                    <Td className="font-medium">
                      {r.name}
                      {r.is_system && (
                        <Lock className="ml-1.5 inline h-3 w-3 text-muted-foreground" aria-label="System role" />
                      )}
                      <div className="font-mono text-[12px] text-muted-foreground">{r.key}</div>
                    </Td>
                    <Td>
                      {r.institution ? (
                        <Badge>{r.institution}</Badge>
                      ) : (
                        <Badge tone="primary">platform</Badge>
                      )}
                    </Td>
                    <Td>{r.permissions}</Td>
                    <Td>{r.users || '—'}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader
              title={selected ? `Grants — ${selected.name}` : 'Grants'}
              description={selected ? `${perms.data?.items.length ?? 0} permission keys` : undefined}
            />
            {!selected ? (
              <div className="p-6">
                <EmptyState title="Select a role" body="Pick a role on the left to see everything it grants." />
              </div>
            ) : perms.isLoading ? (
              <Loading />
            ) : perms.error ? (
              <ErrorState error={perms.error} />
            ) : (
              <div className="max-h-[520px] overflow-y-auto">
                {[...byModule.entries()].map(([module, list]) => (
                  <div key={module} className="border-b last:border-b-0">
                    <div className="sticky top-0 z-10 flex items-center justify-between bg-card px-5 py-2">
                      <p className="eyebrow">{module}</p>
                      <span className="text-[12px] text-muted-foreground">{list.length}</span>
                    </div>
                    {list.map((p) => (
                      <div key={p.key} className="px-5 pb-2.5">
                        <p className="font-mono text-[12px]">{p.key}</p>
                        <p className="text-[13px] text-muted-foreground">{p.description}</p>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </PageBody>
    </>
  )
}
