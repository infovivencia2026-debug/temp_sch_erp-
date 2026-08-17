import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Loading, ErrorState,
} from '@/components/ui'

interface Item {
  code: string; name: string; category?: string; unit: string
  on_hand: number; reorder_level: number; below_reorder: boolean
}

/** Stock. on_hand is maintained by a database trigger over the movement
    history, so the balance can never drift from the ledger. */
export default function Inventory() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['stock'],
    queryFn: () => api.get<List<Item>>('/api/v1/ops/inventory/stock'),
  })
  const rows = data?.items ?? []
  const low = rows.filter((r) => r.below_reorder)

  return (
    <>
      <PageHead
        eyebrow="Inventory & Stores"
        title="Stock"
        description="Running balances with reorder alerts. Issuing more than is in stock is refused."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Items" value={rows.length} />
          <Stat label="Below reorder" value={low.length}
            delta={{ value: low.length ? 'Reorder needed' : 'Healthy', positive: low.length === 0 }} />
          <Stat label="Units on hand" value={rows.reduce((a, r) => a + r.on_hand, 0)} />
        </CellGrid>
        <Card>
          <CardHeader title="Items" />
          {isLoading ? <Loading /> : error ? <ErrorState error={error} /> : (
            <Table head={['Code', 'Item', 'Category', 'Unit', 'On hand', 'Reorder at', 'State']}
              empty={!rows.length} emptyLabel="No stock items configured.">
              {rows.map((i) => (
                <tr key={i.code}>
                  <Td className="font-mono text-[12px]">{i.code}</Td>
                  <Td className="font-medium">{i.name}</Td>
                  <Td className="text-muted-foreground">{i.category ?? '—'}</Td>
                  <Td>{i.unit}</Td>
                  <Td className="font-medium">{i.on_hand}</Td>
                  <Td>{i.reorder_level}</Td>
                  <Td>
                    <Badge tone={i.below_reorder ? 'danger' : 'success'}>
                      {i.below_reorder ? 'reorder' : 'ok'}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
