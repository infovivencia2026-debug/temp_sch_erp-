import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Input, Select, SkeletonTable, ErrorState, FormNotice,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { cn } from '@/lib/utils'

/* Stores: what is on the shelf, and what just left it.
 *
 * The stock and movement endpoints both existed with nothing calling them.
 * on_hand is maintained by a trigger over the movement history, so this screen
 * never writes a balance — it records what happened and lets the balance
 * follow. That is the difference between a stock system and a spreadsheet
 * with a total in it.
 *
 * Below-reorder lines lead, because the only reason to open a stores screen
 * unprompted is to find out what needs ordering.
 */

interface StockItem {
  id: string
  code: string
  name: string
  category?: string
  unit: string
  on_hand: number
  reorder_level: number
  below_reorder: boolean
}

const KINDS = [
  { value: 'receipt', label: 'Receipt — stock came in' },
  { value: 'issue', label: 'Issue — stock went out' },
  { value: 'return', label: 'Return — came back' },
  { value: 'adjustment', label: 'Adjustment — correcting a count' },
]

export default function Stores() {
  const qc = useQueryClient()
  const can = useCan()
  const mayMove = can('operations.inventory.write')

  const [moving, setMoving] = useState<StockItem | null>(null)
  const [kind, setKind] = useState('issue')
  const [qty, setQty] = useState('')
  const [ref, setRef] = useState('')
  const [note, setNote] = useState('')

  const stock = useQuery({
    queryKey: ['stock'],
    queryFn: () => api.get<List<StockItem>>('/api/v1/ops/inventory/stock'),
  })

  const move = useMutation({
    mutationFn: () =>
      api.post('/api/v1/ops/inventory/movements', {
        item_id: moving!.id,
        kind,
        quantity: Number(qty) || 0,
        reference: ref.trim(),
      }),
    onSuccess: () => {
      setNote(`Recorded. ${moving!.name} balance updated.`)
      setMoving(null); setQty(''); setRef('')
      qc.invalidateQueries({ queryKey: ['stock'] })
      qc.invalidateQueries({ queryKey: ['attention'] })
    },
  })

  const items = stock.data?.items ?? []
  const low = items.filter((i) => i.below_reorder)
  const categories = [...new Set(items.map((i) => i.category ?? 'Uncategorised'))]

  return (
    <>
      <PageHead
        eyebrow="Operations"
        title="Stores & inventory"
        description="Uniforms, stationery, lab and housekeeping stock, and the movements behind each balance."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Items" value={items.length} />
          <Stat label="Categories" value={categories.length} />
          <Stat
            label="Below reorder"
            value={low.length}
            hint={low.length ? 'Needs ordering' : 'All above level'}
          />
          <Stat label="Units on hand" value={items.reduce((n, i) => n + i.on_hand, 0)} />
        </CellGrid>

        <FormNotice error={move.error} ok={note} />

        {moving && (
          <Card>
            <CardHeader
              title={`Record a movement — ${moving.name}`}
              description={`On hand ${moving.on_hand} ${moving.unit}. The balance is recalculated from the movement, not typed.`}
              action={<Button variant="ghost" onClick={() => setMoving(null)}>Cancel</Button>}
            />
            <div className="grid gap-4 p-5 sm:grid-cols-3">
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">What happened</span>
                <Select value={kind} onChange={setKind} options={KINDS} />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Quantity ({moving.unit})</span>
                <Input value={qty} onChange={setQty} placeholder="0" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Reference</span>
                <Input value={ref} onChange={setRef} placeholder="Bill no., or who it went to" />
              </label>
            </div>
            <div className="border-t px-5 py-4">
              <Button
                disabled={!qty || Number(qty) <= 0 || move.isPending}
                onClick={() => move.mutate()}
              >
                {move.isPending ? 'Recording…' : 'Record movement'}
              </Button>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Stock"
            description="Below reorder level first"
          />
          {stock.isLoading ? (
            <SkeletonTable columns={6} />
          ) : stock.error ? (
            <ErrorState error={stock.error} />
          ) : (
            <Table
              head={['Item', 'Code', 'Category', 'On hand', 'Reorder at', '']}
              empty={!items.length}
              emptyLabel="No stock recorded yet."
            >
              {[...items]
                .sort((a, b) => Number(b.below_reorder) - Number(a.below_reorder))
                .map((i) => (
                  <tr key={i.id}>
                    <Td className="font-medium">{i.name}</Td>
                    <Td className="font-mono text-[12px] text-muted-foreground">{i.code}</Td>
                    <Td className="text-muted-foreground">{i.category ?? '—'}</Td>
                    <Td>
                      <span className={cn('tabular-nums', i.below_reorder && 'font-medium text-destructive')}>
                        {i.on_hand} {i.unit}
                      </span>
                      {i.below_reorder && (
                        <span className="block text-[12px] text-destructive">below reorder</span>
                      )}
                    </Td>
                    <Td className="tabular-nums text-muted-foreground">{i.reorder_level}</Td>
                    <Td>
                      {mayMove && (
                        <Button size="sm" variant="secondary" onClick={() => { setMoving(i); setNote('') }}>
                          Movement
                        </Button>
                      )}
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
