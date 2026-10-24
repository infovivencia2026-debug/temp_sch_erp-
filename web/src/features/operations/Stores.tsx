import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, Input, Select, Switch, SkeletonTable, ErrorState, FormNotice,
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
  /** Selling price in the parent store, in paise. */
  sale_price_paise: number | null
  /** Shown to parents in the store catalogue. */
  in_store: boolean
}

const KINDS = [
  { value: 'receipt', label: 'Receipt, stock came in' },
  { value: 'issue', label: 'Issue, stock went out' },
  { value: 'return', label: 'Return, came back' },
  { value: 'adjustment', label: 'Adjustment, correcting a count' },
]

export default function Stores() {
  const qc = useQueryClient()
  const can = useCan()
  const mayMove = can('operations.inventory.write')

  const [moving, setMoving] = useState<StockItem | null>(null)
  /* ADDING THE ITEM ITSELF.

     This screen could record what happened to a thing and never bring a thing
     into existence: the only INSERT into inventory_items in the product was
     the demo seeder, so a real school opened an empty stores list with no way
     to put its first box of chalk in it -- and the shop's catalogue, which
     reads its stock through this same table, could not be stocked either.

     No opening balance is asked for. A count is a movement, and an item born
     already holding forty of something would put a number in the balance that
     no line of the ledger accounts for. It starts at zero; the first receipt
     says where the forty came from. */
  const [adding, setAdding] = useState(false)
  // The item being edited; the same form as adding, without the code.
  const [editing, setEditing] = useState<StockItem | null>(null)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [unit, setUnit] = useState('nos')
  const [reorder, setReorder] = useState('0')
  /* One list for the store (Yajur, 2026-10-22): an item can be sold to
     parents at its own price. */
  const [price, setPrice] = useState('')
  const [inStore, setInStore] = useState(false)
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

  const priceValue = price.trim() === '' ? null : Number(price)
  const priceOk = priceValue === null || (Number.isFinite(priceValue) && priceValue >= 0)
  const fields = () => ({
    name: name.trim(),
    category: category.trim(),
    unit: unit.trim() || 'nos',
    reorder_level: Number(reorder) || 0,
    sale_price_paise: priceValue === null ? null : Math.round(priceValue * 100),
    in_store: inStore,
  })
  const closeForm = () => {
    setAdding(false); setEditing(null)
    setCode(''); setName(''); setCategory(''); setUnit('nos'); setReorder('0'); setPrice(''); setInStore(false)
  }
  const openEdit = (i: StockItem) => {
    setAdding(false); setMoving(null); setNote('')
    setEditing(i)
    setName(i.name); setCategory(i.category ?? ''); setUnit(i.unit); setReorder(String(i.reorder_level))
    setPrice(i.sale_price_paise == null ? '' : String(i.sale_price_paise / 100)); setInStore(i.in_store)
  }

  const add = useMutation({
    mutationFn: () =>
      editing
        ? api.patch(`/api/v1/ops/inventory/items/${editing.id}`, fields())
        : api.post('/api/v1/ops/inventory/items', { code: code.trim(), ...fields() }),
    onSuccess: () => {
      setNote(editing ? `${name.trim()} saved.` : `${name.trim()} is on the register. Record a receipt to give it a balance.`)
      closeForm()
      qc.invalidateQueries({ queryKey: ['stock'] })
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

        <FormNotice error={move.error ?? add.error} ok={note} />

        {moving && (
          <Card>
            <CardHeader
              title={`Record a movement · ${moving.name}`}
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

        {(adding || editing) && (
          <Card>
            <CardHeader
              title={editing ? `Edit · ${editing.name}` : 'Add an item to the register'}
              description={editing
                ? 'The balance is not edited here; it comes from the movements.'
                : 'What the school keeps, not how much of it. The balance comes from the first receipt.'}
              action={<Button variant="ghost" onClick={closeForm}>Cancel</Button>}
            />
            <div className="grid gap-4 p-5 sm:grid-cols-3">
              {!editing && (
                <label className="flex flex-col gap-1.5 text-[13px]">
                  <span className="text-muted-foreground">Code</span>
                  <Input value={code} onChange={setCode} placeholder="CHK-001" />
                </label>
              )}
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Name</span>
                <Input value={name} onChange={setName} placeholder="Chalk, white" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Category</span>
                <Input value={category} onChange={setCategory} placeholder="Stationery" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Unit</span>
                <Input value={unit} onChange={setUnit} placeholder="nos, box, kg" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Reorder level</span>
                <Input value={reorder} onChange={setReorder} placeholder="0" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Selling price (₹, optional)</span>
                <Input value={price} onChange={setPrice} placeholder="Not sold" />
              </label>
              <div className="flex items-center justify-between gap-3 text-[13px] sm:col-span-3">
                <div className="min-w-0">
                  <p className="font-medium">Show in parent store</p>
                  <p className="text-muted-foreground">Parents see the price and whether it is in stock, not the count.</p>
                </div>
                <Switch on={inStore} onChange={setInStore} label="Show in parent store" />
              </div>
            </div>
            <div className="border-t px-5 py-4">
              <Button
                disabled={(!editing && !code.trim()) || !name.trim() || !priceOk || (inStore && priceValue === null) || add.isPending}
                onClick={() => add.mutate()}
              >
                {add.isPending ? 'Saving…' : editing ? 'Save' : 'Add the item'}
              </Button>
              {inStore && priceValue === null && (
                <p className="mt-2 text-[12.5px] text-muted-foreground">Give a selling price to show it in the parent store.</p>
              )}
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Stock"
            description="Below reorder level first"
            action={
              mayMove && !adding && !editing ? (
                <Button variant="secondary" onClick={() => setAdding(true)}>Add an item</Button>
              ) : undefined
            }
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
                    <Td className="text-muted-foreground">
                      {i.category ?? '-'}
                      {i.in_store && <Badge tone="info" className="ml-2">In parent store</Badge>}
                    </Td>
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
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="ghost" onClick={() => openEdit(i)}>Edit</Button>
                          <Button size="sm" variant="secondary" onClick={() => { setMoving(i); setNote('') }}>
                            Movement
                          </Button>
                        </div>
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
