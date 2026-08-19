import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Package, Shirt, TriangleAlert } from 'lucide-react'
import { api, type Page, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Select, Input, Field, FormGrid, FormNotice, Loading, ErrorState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { VariancePanel } from './CanteenTerminal'
import {
  collectionsBase, collectionsKey, inr, toPaise, draftTotals, draftLineTotal,
  useTerminals, useTillSessions, useStoreProducts, useStoreVariants,
  useInventoryItems, usePosSales, usePosSale, PRODUCT_CATEGORIES,
  type DraftLine, type StoreProduct, type StoreVariant, type TillSession,
} from './collections-lib'

/* The school store.

   Uniforms, books, stationery. Three things make it different from the canteen
   counter it shares a till with:

   Sizes. A shirt in eight sizes is eight shelves, not one shelf with an
   attribute, because "how many size 32 left" has to have exactly one answer.
   So a size is an ordinary stores item and a variant is the row that says
   which stores item a size lives on. That is the whole variant model, and
   stopping there is deliberate: a general attribute system is three tables and
   a week, for a school that sells shirts and trousers.

   Stock. A sale draws down the stores ledger the purchase-order module already
   maintains -- the same inventory_movements table a goods receipt writes to,
   the same trigger recomputing on_hand. Nothing here counts anything itself.

   Returns. A parent brings back an unworn shirt, and the accounting has to
   reverse cleanly: the stock goes back on the shelf, the cash comes out of the
   drawer so the cash-up sees it, and where the sale was charged to a fee
   account the invoice is reduced. An exchange is a return and then a sale, on
   the same open till. */

export default function SchoolStore() {
  const can = useCan()
  const mayRing = can('finance.payments.write')
  const mayEdit = can('finance.fees.write')

  const products = useStoreProducts()
  const open = useTillSessions('store', 'open')
  const sales = usePosSales('store')
  const terminals = useTerminals('store')

  const [openSale, setOpenSale] = useState<string | null>(null)

  if (products.isLoading || open.isLoading) return <Loading label="Opening the store…" />
  if (products.error) return <ErrorState error={products.error} />
  if (open.error) return <ErrorState error={open.error} />

  const rows = products.data?.items ?? []
  const session = (open.data?.items ?? [])[0] ?? null
  const lowStock = rows.filter((p) => p.variant_count > 0 && p.on_hand === 0).length

  return (
    <>
      <PageHead
        eyebrow="Collections"
        title="School store"
        description="Uniforms, books and stationery, sold off the stock the stores module already counts."
        width="wide"
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Items on the price list" value={rows.filter((p) => p.is_active).length} icon={Shirt} />
          <Stat label="Sizes stocked" value={rows.reduce((n, p) => n + p.variant_count, 0)} icon={Package} />
          <Stat label="Out of stock" value={lowStock} icon={TriangleAlert}
            hint={lowStock ? 'Nothing left on any size' : 'Everything has stock'} />
          <Stat label="Till" value={session ? 'Open' : 'Closed'}
            hint={session ? `${session.terminal_name}, ${session.opened_by}` : 'Open one on the counter screen'} />
        </CellGrid>

        {session ? (
          <StoreCounter key={session.id} session={session} disabled={!mayRing} />
        ) : (
          <Card>
            <CardHeader
              title="No till is open"
              description="A store sale comes out of a drawer somebody is accountable for. Open one before selling."
            />
            <div className="p-5">
              <OpenStoreTill
                terminals={(terminals.data?.items ?? []).filter((t) => !t.open_since)}
                disabled={!mayRing}
              />
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Today’s counter"
            description="Sales and returns, newest first. Open one to take something back."
          />
          {sales.error ? (
            <div className="p-5"><ErrorState error={sales.error} /></div>
          ) : (
            <Table
              head={[
                'Receipt', 'What', 'Who', 'Paid',
                { label: 'Total', align: 'right' }, '',
              ]}
              empty={(sales.data?.items ?? []).length === 0}
              emptyLabel="Nothing has been sold this week."
            >
              {(sales.data?.items ?? []).map((s) => (
                <tr key={s.id}>
                  <Td className="font-medium">{s.receipt_no}</Td>
                  <Td>
                    <Badge tone={s.kind === 'return' ? 'warning' : 'neutral'}>
                      {s.kind === 'return' ? 'Return' : 'Sale'}
                    </Badge>
                  </Td>
                  <Td>{s.student_name ?? s.buyer_name ?? '—'}</Td>
                  <Td>
                    {s.payment_mode === 'account'
                      ? `Account${s.invoice_no ? ` · ${s.invoice_no}` : ''}`
                      : 'Cash'}
                  </Td>
                  <Td className="text-right tabular-nums">{inr(s.total_paise)}</Td>
                  <Td>
                    {s.kind === 'sale' && (
                      <Button size="sm" variant="ghost" onClick={() => setOpenSale(s.id)}>
                        Take back
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {openSale && (
          <ReturnPanel
            key={openSale}
            saleId={openSale}
            session={session}
            disabled={!mayRing}
            onDone={() => setOpenSale(null)}
          />
        )}

        <VariancePanel kind="store" />

        <PriceList products={rows} disabled={!mayEdit} />
        <SizesPanel disabled={!mayEdit} />
      </PageBody>
    </>
  )
}

function OpenStoreTill({
  terminals, disabled,
}: {
  terminals: { id: string; name: string }[]
  disabled: boolean
}) {
  const qc = useQueryClient()
  const [terminalId, setTerminalId] = useState('')
  const [float, setFloat] = useState('')

  const start = useMutation({
    mutationFn: () =>
      api.post(`${collectionsBase}/sessions`, {
        terminal_id: terminalId,
        opening_float_paise: toPaise(float),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [collectionsKey] }),
  })

  return (
    <>
      <FormGrid>
        <Field label="Counter" required>
          <Select
            value={terminalId}
            onChange={setTerminalId}
            options={terminals.map((t) => ({ value: t.id, label: t.name }))}
            placeholder={terminals.length ? 'Which counter?' : 'No store counter is set up'}
          />
        </Field>
        <Field label="Opening float (₹)" required hint="Type 0 if the drawer starts empty.">
          <Input value={float} onChange={setFloat} type="number" srLabel="Opening float in rupees" />
        </Field>
      </FormGrid>
      <div className="mt-5">
        <Button
          disabled={disabled || start.isPending || !terminalId || float.trim() === ''}
          onClick={() => start.mutate()}
        >
          {start.isPending ? 'Opening…' : 'Open the till'}
        </Button>
      </div>
      <FormNotice error={start.error} />
    </>
  )
}

/* The counter itself.

   Prices come from the catalogue and are not editable here. A till that took
   its price from whoever was standing at it would produce takings that are
   whatever that person said, and the cash-up would then reconcile a number
   they chose. A discount is typed as a discount, which is recorded as one. */
function StoreCounter({ session, disabled }: { session: TillSession; disabled: boolean }) {
  const qc = useQueryClient()
  const variants = useStoreVariants()
  const [lines, setLines] = useState<DraftLine[]>([])
  const [variantId, setVariantId] = useState('')
  const [qty, setQty] = useState('1')
  const [discount, setDiscount] = useState('')
  const [mode, setMode] = useState<'cash' | 'account'>('cash')
  const [search, setSearch] = useState('')
  const [student, setStudent] = useState<Student | null>(null)
  const [buyer, setBuyer] = useState('')
  const [receipt, setReceipt] = useState<string | null>(null)

  const results = useQuery({
    queryKey: [collectionsKey, 'student-search', search],
    queryFn: () =>
      api.get<Page<Student>>(`/api/v1/students?q=${encodeURIComponent(search)}&limit=10`),
    enabled: search.trim().length >= 2,
  })

  const byId = useMemo(() => {
    const m = new Map<string, StoreVariant>()
    for (const v of variants.data?.items ?? []) m.set(v.id, v)
    return m
  }, [variants.data])

  const totals = useMemo(() => draftTotals(lines), [lines])
  const chosen = byId.get(variantId)

  const ring = useMutation({
    mutationFn: () =>
      api.post<{ receipt_no: string; invoice_no?: string }>(`${collectionsBase}/sales`, {
        session_id: session.id,
        student_id: student?.id ?? '',
        buyer_name: student ? '' : buyer,
        payment_mode: mode,
        lines: lines.map((l) => ({
          variant_id: l.variantId,
          quantity: l.quantity,
          discount_paise: l.discountPaise,
        })),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: [collectionsKey] })
      setReceipt(r.receipt_no)
      setLines([])
      setStudent(null)
      setBuyer('')
      setSearch('')
    },
  })

  function addLine() {
    if (!chosen) return
    setLines((cur) => [
      ...cur,
      {
        key: `${Date.now()}-${cur.length}`,
        variantId: chosen.id,
        itemName: `${chosen.product_name}${chosen.label ? ` — ${chosen.label}` : ''}`,
        category: 'uniform',
        quantity: Math.max(1, Number(qty) || 1),
        unitPaise: chosen.price_paise,
        discountPaise: discount.trim() === '' ? 0 : toPaise(discount),
        taxRateBP: chosen.tax_rate_bp,
      },
    ])
    setVariantId('')
    setQty('1')
    setDiscount('')
  }

  const ready = lines.length > 0 && (student !== null || buyer.trim() !== '')

  if (variants.error) {
    // A price list that failed to load must not render as an empty catalogue:
    // a clerk would conclude the school sells nothing.
    return (
      <Card>
        <CardHeader title="Store counter" description="The price list could not be read." />
        <div className="p-5"><ErrorState error={variants.error} /></div>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title={`Store counter — ${session.terminal_name}`}
        description={`Opened by ${session.opened_by}. Prices come from the price list; a reduction is a discount.`}
        action={receipt ? <Badge tone="success">Receipt {receipt}</Badge> : undefined}
      />
      <div className="p-5">
        <FormGrid>
          <Field label="Item and size" required wide>
            <Select
              value={variantId}
              onChange={setVariantId}
              options={(variants.data?.items ?? []).map((v) => ({
                value: v.id,
                label: `${v.product_name}${v.label ? ` — ${v.label}` : ''} · ${v.on_hand} left · ${inr(v.price_paise)}`,
              }))}
              placeholder="Pick the size off the shelf"
            />
          </Field>
          <Field label="Quantity">
            <Input value={qty} onChange={setQty} type="number" srLabel="Quantity" />
          </Field>
          <Field label="Discount (₹)" hint="Recorded as a discount, not as a different price.">
            <Input value={discount} onChange={setDiscount} type="number" srLabel="Discount in rupees" />
          </Field>
        </FormGrid>
        {chosen && chosen.on_hand < Math.max(1, Number(qty) || 1) && (
          <p className="mt-3 text-sm">
            Only {chosen.on_hand} of {chosen.product_name} {chosen.label} left on the shelf.
          </p>
        )}
        <div className="mt-5">
          <Button variant="secondary" onClick={addLine} disabled={!chosen}>
            Add to the receipt
          </Button>
        </div>
      </div>

      <Table
        head={[
          'Item',
          { label: 'Qty', align: 'right' },
          { label: 'Each', align: 'right' },
          { label: 'Discount', align: 'right' },
          { label: 'GST', align: 'right' },
          { label: 'Line', align: 'right' },
          '',
        ]}
        empty={lines.length === 0}
        emptyLabel="Nothing on the receipt yet."
      >
        {lines.map((l) => (
          <tr key={l.key}>
            <Td className="font-medium">{l.itemName}</Td>
            <Td className="text-right tabular-nums">{l.quantity}</Td>
            <Td className="text-right tabular-nums">{inr(l.unitPaise)}</Td>
            <Td className="text-right tabular-nums">{inr(l.discountPaise)}</Td>
            <Td className="text-right tabular-nums">{inr(draftLineTotal(l).tax)}</Td>
            <Td className="text-right tabular-nums">{inr(draftLineTotal(l).total)}</Td>
            <Td>
              <Button size="sm" variant="ghost" tone="danger"
                onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))}>
                Remove
              </Button>
            </Td>
          </tr>
        ))}
      </Table>

      <div className="p-5">
        <FormGrid>
          <Field label="How is it being paid?" required
            hint="Cash, or charged to the child's fee account. There is no card reader behind this counter.">
            <Select
              value={mode}
              onChange={(v) => setMode(v as 'cash' | 'account')}
              options={[
                { value: 'cash', label: 'Cash into the drawer' },
                { value: 'account', label: "Charge the child's fee account" },
              ]}
            />
          </Field>
          <Field label="Who is buying?" required={mode === 'account'}>
            <Input
              value={student ? `${student.full_name} · ${student.admission_no}` : search}
              onChange={(v) => { setStudent(null); setSearch(v) }}
              placeholder="Search by name or admission number"
              srLabel="Search for the child"
            />
          </Field>
        </FormGrid>

        {!student && search.trim().length >= 2 && (
          results.error ? (
            <div className="mt-3"><ErrorState error={results.error} /></div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {(results.data?.items ?? []).map((st) => (
                <Button key={st.id} size="sm" variant="outline"
                  onClick={() => { setStudent(st); setSearch('') }}>
                  {st.full_name} · {st.class_name ?? '—'}
                </Button>
              ))}
            </div>
          )
        )}

        {!student && mode === 'cash' && (
          <div className="mt-5">
            <Field label="Or a name for the receipt">
              <Input value={buyer} onChange={setBuyer} srLabel="Buyer's name" />
            </Field>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-4">
          <span className="text-sm">
            {inr(totals.subtotal - totals.discount)} + {inr(totals.tax)} GST
          </span>
          <span className="text-lg font-semibold tabular-nums">{inr(totals.total)}</span>
          <Button disabled={disabled || !ready || ring.isPending} onClick={() => ring.mutate()}>
            {ring.isPending ? 'Selling…' : mode === 'cash' ? 'Take the cash' : 'Charge the account'}
          </Button>
        </div>
        <FormNotice error={ring.error} />
      </div>
    </Card>
  )
}

/* Taking something back.

   Quantities are capped at what is left to return -- sold, less everything
   already returned -- and the cap is computed on the server from the rows
   rather than from a counter, so the same shirt cannot come back twice.

   Where the sale was charged to a fee account and the family has since paid
   it, the server refuses and says to refund in cash. Reducing a settled
   invoice would leave a credit balance the fee module has no concept of. */
function ReturnPanel({
  saleId, session, disabled, onDone,
}: {
  saleId: string
  session: TillSession | null
  disabled: boolean
  onDone: () => void
}) {
  const qc = useQueryClient()
  const sale = usePosSale(saleId)
  const [qty, setQty] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')

  const send = useMutation({
    mutationFn: () =>
      api.post<{ receipt_no: string; refund_paise: number }>(
        `${collectionsBase}/sales/${saleId}/return`,
        {
          session_id: session?.id ?? '',
          reason,
          lines: Object.entries(qty)
            .filter(([, v]) => Number(v) > 0)
            .map(([lineId, v]) => ({ original_line_id: lineId, quantity: Number(v) })),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [collectionsKey] })
      onDone()
    },
  })

  if (sale.isLoading) return <Loading label="Reading the receipt…" />
  if (sale.error) return <ErrorState error={sale.error} />
  const d = sale.data
  if (!d) return null

  const anything = Object.values(qty).some((v) => Number(v) > 0)

  return (
    <Card>
      <CardHeader
        title={`Return against ${d.receipt_no}`}
        description={
          d.payment_mode === 'account'
            ? `Charged to ${d.student_name ?? 'an account'} on ${d.invoice_no ?? 'an invoice'}. The reversal reduces that invoice.`
            : 'Paid in cash. The refund comes out of the open drawer, so the cash-up sees it.'
        }
        action={<Button size="sm" variant="ghost" onClick={onDone}>Close</Button>}
      />
      <Table
        head={[
          'Item',
          { label: 'Sold', align: 'right' },
          { label: 'Already back', align: 'right' },
          { label: 'Each', align: 'right' },
          { label: 'Returning', align: 'right' },
        ]}
        empty={(d.lines ?? []).length === 0}
        emptyLabel="That receipt has no lines."
      >
        {(d.lines ?? []).map((l) => (
          <tr key={l.id}>
            <Td className="font-medium">
              {l.item_name}
              {l.variant_label ? ` — ${l.variant_label}` : ''}
            </Td>
            <Td className="text-right tabular-nums">{l.quantity}</Td>
            <Td className="text-right tabular-nums">{l.returned_quantity}</Td>
            <Td className="text-right tabular-nums">{inr(l.unit_paise)}</Td>
            <Td className="text-right">
              <Input
                value={qty[l.id] ?? ''}
                onChange={(v) => setQty((cur) => ({ ...cur, [l.id]: v }))}
                type="number"
                className="w-24"
                srLabel={`Quantity of ${l.item_name} coming back`}
              />
            </Td>
          </tr>
        ))}
      </Table>
      <div className="p-5">
        <Field label="Why is it coming back?" required
          hint="A refund with no reason is one nobody can defend at audit.">
          <Input value={reason} onChange={setReason} srLabel="Reason for the return" />
        </Field>
        <div className="mt-5">
          <Button
            disabled={disabled || !session || !anything || !reason.trim() || send.isPending}
            onClick={() => send.mutate()}
          >
            {send.isPending ? 'Refunding…' : 'Take it back and refund'}
          </Button>
        </div>
        {!session && (
          <p className="mt-3 text-sm">A refund needs an open till. Open one first.</p>
        )}
        <FormNotice error={send.error} />
      </div>
    </Card>
  )
}

function PriceList({ products, disabled }: { products: StoreProduct[]; disabled: boolean }) {
  const [editing, setEditing] = useState<string | null>(null)
  const list = products
  const record = list.find((p) => p.id === editing) ?? null

  return (
    <>
      <Card>
        <CardHeader
          title="Price list"
          description="What the store sells and for how much. Sizes are set up below, against the stores items that actually hold the stock."
          action={
            <Button size="sm" variant="secondary" disabled={disabled}
              onClick={() => setEditing(editing === 'new' ? null : 'new')}>
              {editing === 'new' ? 'Cancel' : 'Add an item'}
            </Button>
          }
        />
        <Table
          head={[
            'Code', 'Item', 'Category',
            { label: 'Price', align: 'right' },
            { label: 'GST', align: 'right' },
            { label: 'Sizes', align: 'right' },
            { label: 'In stock', align: 'right' },
            '',
          ]}
          empty={list.length === 0}
          emptyLabel="Nothing on the price list yet."
        >
          {list.map((p) => (
            <tr key={p.id}>
              <Td className="font-medium">{p.code}</Td>
              <Td>{p.name}</Td>
              <Td>{p.category}</Td>
              <Td className="text-right tabular-nums">{inr(p.sale_price_paise)}</Td>
              <Td className="text-right tabular-nums">{(p.tax_rate_bp / 100).toFixed(2)}%</Td>
              <Td className="text-right tabular-nums">{p.variant_count}</Td>
              <Td className="text-right tabular-nums">{p.on_hand}</Td>
              <Td>
                <Button size="sm" variant="ghost" disabled={disabled}
                  onClick={() => setEditing(editing === p.id ? null : p.id)}>
                  {editing === p.id ? 'Close' : 'Edit'}
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      {editing && (
        // Keyed on the record: without it, opening a second item would reuse
        // the first one's typed values in this panel's local state.
        <ProductEditor key={editing} record={record} onDone={() => setEditing(null)} />
      )}
    </>
  )
}

function ProductEditor({
  record, onDone,
}: {
  record: {
    id: string; code: string; name: string; category: string; hsn_code?: string
    tax_rate_bp: number; sale_price_paise: number; return_window_days?: number
    is_active: boolean
  } | null
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [code, setCode] = useState(record?.code ?? '')
  const [name, setName] = useState(record?.name ?? '')
  const [category, setCategory] = useState(record?.category ?? 'uniform')
  const [hsn, setHsn] = useState(record?.hsn_code ?? '')
  const [tax, setTax] = useState(String((record?.tax_rate_bp ?? 0) / 100))
  const [price, setPrice] = useState(
    record ? String(record.sale_price_paise / 100) : '',
  )
  const [window, setWindow] = useState(
    record?.return_window_days != null ? String(record.return_window_days) : '',
  )

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`${collectionsBase}/products`, {
        id: record?.id ?? '',
        code, name, category,
        hsn_code: hsn,
        // Basis points on the wire, so the rate is an integer and never a
        // float that has to be compared for equality later.
        tax_rate_bp: Math.round(Number(tax || 0) * 100),
        sale_price_paise: toPaise(price),
        return_window_days: window.trim() === '' ? null : Number(window),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [collectionsKey] })
      onDone()
    },
  })

  return (
    <Card>
      <CardHeader
        title={record ? `Edit ${record.name}` : 'Add an item to the price list'}
        description="The price here is what every size sells for unless a size overrides it."
      />
      <div className="p-5">
        <FormGrid>
          <Field label="Code" required><Input value={code} onChange={setCode} srLabel="Item code" /></Field>
          <Field label="Name" required><Input value={name} onChange={setName} srLabel="Item name" /></Field>
          <Field label="Category" required>
            <Select value={category} onChange={setCategory} options={PRODUCT_CATEGORIES} />
          </Field>
          <Field label="Price (₹)" required><Input value={price} onChange={setPrice} type="number" srLabel="Price in rupees" /></Field>
          <Field label="GST rate (%)" hint="Uniforms and stationery are taxable; a fee is not.">
            <Input value={tax} onChange={setTax} type="number" srLabel="GST rate percent" />
          </Field>
          <Field label="HSN code"><Input value={hsn} onChange={setHsn} srLabel="HSN code" /></Field>
          <Field label="Return window (days)" hint="Blank means the clerk decides.">
            <Input value={window} onChange={setWindow} type="number" srLabel="Return window in days" />
          </Field>
        </FormGrid>
        <div className="mt-5 flex gap-3">
          <Button disabled={save.isPending || !code.trim() || !name.trim() || price.trim() === ''}
            onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="ghost" onClick={onDone}>Cancel</Button>
        </div>
        <FormNotice error={save.error} />
      </div>
    </Card>
  )
}

/* Sizes.

   The item_id column is the whole point of this panel: a size is attached to
   an existing stores row and the store never creates one. That keeps the
   count in one place -- a purchase order receives shirts, this sells them, and
   inventory_items.on_hand is the only answer to how many there are.

   Items already taken by another size are greyed out rather than left to fail
   on save, because "one shelf, one size" is a rule the clerk should meet in
   the form rather than in an error. */
function SizesPanel({ disabled }: { disabled: boolean }) {
  const qc = useQueryClient()
  const products = useStoreProducts()
  const variants = useStoreVariants()
  const items = useInventoryItems()

  const [productId, setProductId] = useState('')
  const [itemId, setItemId] = useState('')
  const [size, setSize] = useState('')
  const [colour, setColour] = useState('')
  const [price, setPrice] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`${collectionsBase}/variants`, {
        product_id: productId,
        item_id: itemId,
        size, colour,
        sale_price_paise: price.trim() === '' ? null : toPaise(price),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [collectionsKey] })
      setItemId(''); setSize(''); setColour(''); setPrice('')
    },
  })

  return (
    <Card>
      <CardHeader
        title="Sizes and colours"
        description="Each size is its own shelf in the stores register, so “how many size 32 are left” has one answer."
      />
      <div className="p-5">
        {items.error ? (
          <ErrorState error={items.error} />
        ) : (
          <FormGrid>
            <Field label="Item" required>
              <Select
                value={productId}
                onChange={setProductId}
                options={(products.data?.items ?? []).map((p) => ({ value: p.id, label: p.name }))}
                placeholder="Which item?"
              />
            </Field>
            <Field label="Stores item" required
              hint="The shelf this size is counted on. Greyed-out rows already belong to another size.">
              <Select
                value={itemId}
                onChange={setItemId}
                options={(items.data?.items ?? [])
                  .filter((i) => !i.taken)
                  .map((i) => ({ value: i.id, label: `${i.code} · ${i.name} · ${i.on_hand} on hand` }))}
                placeholder={
                  (items.data?.items ?? []).some((i) => !i.taken)
                    ? 'Pick the stores row'
                    : 'Every stores item is already a size'
                }
              />
            </Field>
            <Field label="Size"><Input value={size} onChange={setSize} placeholder="32" srLabel="Size" /></Field>
            <Field label="Colour"><Input value={colour} onChange={setColour} placeholder="White" srLabel="Colour" /></Field>
            <Field label="Price override (₹)" hint="Blank uses the item’s price.">
              <Input value={price} onChange={setPrice} type="number" srLabel="Price override in rupees" />
            </Field>
          </FormGrid>
        )}
        <div className="mt-5">
          <Button disabled={disabled || save.isPending || !productId || !itemId}
            onClick={() => save.mutate()}>
            {save.isPending ? 'Adding…' : 'Add the size'}
          </Button>
        </div>
        <FormNotice error={save.error} />
      </div>

      {variants.error ? (
        <div className="p-5"><ErrorState error={variants.error} /></div>
      ) : (
        <Table
          head={[
            'Item', 'Size', 'Stores code',
            { label: 'Price', align: 'right' },
            { label: 'On hand', align: 'right' },
          ]}
          empty={(variants.data?.items ?? []).length === 0}
          emptyLabel="No sizes have been set up."
        >
          {(variants.data?.items ?? []).map((v) => (
            <tr key={v.id}>
              <Td className="font-medium">{v.product_name}</Td>
              <Td>{v.label || '—'}</Td>
              <Td>{v.item_code}</Td>
              <Td className="text-right tabular-nums">{inr(v.price_paise)}</Td>
              <Td className="text-right tabular-nums">
                {v.on_hand === 0 ? <Badge tone="danger">Out</Badge> : v.on_hand}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}
