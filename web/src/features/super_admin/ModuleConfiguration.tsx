import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Loading, ErrorState,
} from '@/components/ui'

interface ModuleSetting {
  module: string
  enabled: boolean
}

/**
 * Module toggles are what make a role's navigation shrink to what the school
 * actually bought — the catalog says a feature exists, this says the tenant
 * uses it.
 */
export default function ModuleConfiguration() {
  const qc = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-modules'],
    queryFn: () => api.get<List<ModuleSetting>>('/api/v1/admin/modules'),
  })

  const toggle = useMutation({
    mutationFn: (m: ModuleSetting) => api.put('/api/v1/admin/modules', m),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-modules'] })
      // Navigation is derived from module state, so it must be refetched too.
      qc.invalidateQueries({ queryKey: ['catalog'] })
      qc.invalidateQueries({ queryKey: ['session'] })
    },
  })

  const items = data?.items ?? []
  const on = items.filter((m) => m.enabled).length

  return (
    <>
      <PageHead
        eyebrow="Platform Configuration"
        title="Module configuration"
        description="Enable or disable modules per institution so users only see what their institution uses."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Modules" value={items.length} />
          <Stat label="Enabled" value={on} />
          <Stat label="Disabled" value={items.length - on} />
        </CellGrid>

        <Card>
          <CardHeader title="Modules" description="Changes take effect on the next page load for every user" />
          {isLoading ? (
            <Loading />
          ) : error ? (
            <ErrorState error={error} />
          ) : (
            <Table
              head={['Module', 'State', '']}
              empty={!items.length}
              emptyLabel="No modules configured for this institution yet."
            >
              {items.map((m) => (
                <tr key={m.module}>
                  <Td className="font-medium">{m.module}</Td>
                  <Td>
                    <Badge tone={m.enabled ? 'success' : 'neutral'}>
                      {m.enabled ? 'enabled' : 'disabled'}
                    </Badge>
                  </Td>
                  <Td>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={toggle.isPending}
                      onClick={() => toggle.mutate({ module: m.module, enabled: !m.enabled })}
                    >
                      {m.enabled ? 'Disable' : 'Enable'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          {toggle.isError && (
            <p className="border-t px-5 py-2.5 text-[13px] text-destructive">
              {toggle.error instanceof Error ? toggle.error.message : 'Could not update module'}
            </p>
          )}
        </Card>
      </PageBody>
    </>
  )
}
