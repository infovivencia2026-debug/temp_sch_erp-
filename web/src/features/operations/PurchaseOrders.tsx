import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Input, Select, Textarea, Loading, ErrorState, FormNotice, EmptyState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { cn } from '@/lib/utils'
import {
  adminOpsBase, inr, toPaise,
  type Requisition, type RequisitionLine, type PurchaseOrder,
  type OrderLine, type GoodsReceipt, type InvoiceMatch, type ApprovalBand,
} from './admin-ops-lib'

/* The purchase order workflow.
 *
 * Requisition → approval → order → receipt → match, as five tabs on one
 * screen because they are five stages of one thing and a buyer moves between
 * them constantly.
 *
 * Three behaviours here are the server's, not this screen's, and the screen
 * says so rather than reimplementing them:
 *
 *   Who may approve comes from the value ladder. This page shows the band a
 *   requisition landed in and lets anyone press Approve — the server answers
 *   403 with the permission needed if they may not. A button hidden by the
 *   browser is not a spending control, and pretending otherwise teaches
 *   people the UI is the rule.
 *
 *   Receiving moves stock. Nothing here writes an inventory balance; a
 *   database trigger writes the movement and the stores screen picks it up.
 *   The GRN panel reports how many movements it caused, so the person
 *   receiving can see the shelf was updated.
 *
 *   An order cannot be cut below what has arrived. The quantity field is not
 *   clamped in the browser — the constraint lives in the database and the
 *   error it produces is a sentence, which is more honest than a form that
 *   silently refuses to accept a keystroke.
 */

type Tab = 'requisitions' | 'orders' | 'matching' | 'ladder'

const TABS: { id: Tab; label: string }[] = [
  { id: 'requisitions', label: 'Requisitions' },
  { id: 'orders', label: 'Purchase orders' },
  { id: 'matching', label: 'Invoice matching' },
  { id: 'ladder', label: 'Approval ladder' },
]

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  draft: 'neutral',
  submitted: 'warning',
  approved: 'success',
  rejected: 'danger',
  ordered: 'success',
  cancelled: 'danger',
  issued: 'info',
  partly_received: 'warning',
  received: 'success',
  closed: 'neutral',
  matched: 'success',
  variance_accepted: 'warning',
  blocked: 'danger',
}

function statusLabel(s: string) {
  return s.replace(/_/g, ' ')
}

export default function PurchaseOrders() {
  const qc = useQueryClient()
  const can = useCan()
  const mayWrite = can('operations.inventory.write')
  const mayConfigure = can('institution.settings.write')
  const mayPay = can('finance.invoices.write')

  const [tab, setTab] = useState<Tab>('requisitions')
  const [note, setNote] = useState('')

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-ops', 'purchasing'] })
    qc.invalidateQueries({ queryKey: ['stock'] })
  }

  return (
    <>
      <PageHead
        eyebrow="Stores"
        title="Purchase order workflow"
        description="A department asks, somebody with authority agrees, the vendor is ordered from, the goods are counted in, and the bill is checked against what actually arrived."
      />
      <PageBody>
        <div className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <Button
              key={t.id}
              size="sm"
              variant={tab === t.id ? 'primary' : 'secondary'}
              onClick={() => { setTab(t.id); setNote('') }}
            >
              {t.label}
            </Button>
          ))}
        </div>

        {note && <FormNotice ok={note} />}

        {tab === 'requisitions' && (
          <RequisitionsPanel mayWrite={mayWrite} onDone={(m) => { setNote(m); invalidate() }} />
        )}
        {tab === 'orders' && (
          <OrdersPanel mayWrite={mayWrite} onDone={(m) => { setNote(m); invalidate() }} />
        )}
        {tab === 'matching' && (
          <MatchingPanel mayPay={mayPay} onDone={(m) => { setNote(m); invalidate() }} />
        )}
        {tab === 'ladder' && (
          <LadderPanel mayConfigure={mayConfigure} onDone={(m) => { setNote(m); invalidate() }} />
        )}
      </PageBody>
    </>
  )
}

// --- requisitions ------------------------------------------------------------

function RequisitionsPanel({ mayWrite, onDone }: { mayWrite: boolean; onDone: (m: string) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const list = useQuery({
    queryKey: ['admin-ops', 'purchasing', 'requisitions'],
    queryFn: () => api.get<List<Requisition>>(`${adminOpsBase}/purchasing/requisitions`),
  })

  const items = list.data?.items ?? []
  const pending = items.filter((r) => r.status === 'submitted')
  const approved = items.filter((r) => r.status === 'approved')

  return (
    <>
      <CellGrid cols={4}>
        <Stat label="Requisitions" value={items.length} />
        <Stat label="Waiting on approval" value={pending.length}
          hint={pending.length ? 'Somebody is waiting' : 'Nothing pending'} />
        <Stat label="Approved, not yet ordered" value={approved.length} />
        <Stat label="Value pending"
          value={inr(pending.reduce((n, r) => n + r.estimated_total_paise, 0))} />
      </CellGrid>

      {creating && mayWrite && (
        <RequisitionForm
          onCancel={() => setCreating(false)}
          onSaved={(m) => { setCreating(false); onDone(m) }}
        />
      )}

      <Card>
        <CardHeader
          title="Requisitions"
          description="Pending first — an approval nobody has looked at is somebody's work stopped."
          action={mayWrite && !creating ? (
            <Button size="sm" onClick={() => setCreating(true)}>Raise a requisition</Button>
          ) : undefined}
        />
        {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} /> : (
          <Table
            head={['No.', 'Department', 'Raised', 'Needed by', 'Value', 'Approval band', 'Status', '']}
            empty={!items.length}
            emptyLabel="Nothing has been requisitioned yet."
          >
            {[...items]
              .sort((a, b) => Number(b.status === 'submitted') - Number(a.status === 'submitted'))
              .map((r) => (
                <tr key={r.id}>
                  <Td className="font-mono text-[12px]">{r.requisition_no}</Td>
                  <Td>{r.department ?? '—'}</Td>
                  <Td className="text-muted-foreground">{r.raised_on}</Td>
                  <Td className="text-muted-foreground">{r.needed_by ?? '—'}</Td>
                  <Td className="tabular-nums">{inr(r.estimated_total_paise)}</Td>
                  <Td className="text-muted-foreground text-[12px]">{r.approval_band ?? '—'}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{statusLabel(r.status)}</Badge>
                    {r.order_no && (
                      <span className="block text-[12px] text-muted-foreground">{r.order_no}</span>
                    )}
                  </Td>
                  <Td>
                    <Button size="sm" variant="secondary"
                      onClick={() => setOpen(open === r.id ? null : r.id)}>
                      {open === r.id ? 'Close' : 'Open'}
                    </Button>
                  </Td>
                </tr>
              ))}
          </Table>
        )}
      </Card>

      {/* Keyed by the requisition: the approve/refuse note lives in the panel,
          and a reason written to refuse one request must not follow the reader
          onto the next. */}
      {open && <RequisitionDetail key={open} id={open} mayWrite={mayWrite} onDone={onDone} />}
    </>
  )
}

function RequisitionDetail({ id, mayWrite, onDone }: {
  id: string; mayWrite: boolean; onDone: (m: string) => void
}) {
  const [decisionNote, setDecisionNote] = useState('')

  const detail = useQuery({
    queryKey: ['admin-ops', 'purchasing', 'requisitions', id],
    queryFn: () => api.get<{
      requisition: Requisition; justification?: string; lines: RequisitionLine[]
    }>(`${adminOpsBase}/purchasing/requisitions/${id}`),
  })

  const submit = useMutation({
    mutationFn: () => api.post<{ approval_band?: string }>(
      `${adminOpsBase}/purchasing/requisitions/${id}/submit`, {}),
    onSuccess: (r: { approval_band?: string }) =>
      onDone(`Submitted. It needs sign-off from: ${r.approval_band ?? 'the approver'}.`),
  })

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      api.post(`${adminOpsBase}/purchasing/requisitions/${id}/decide`,
        { decision, note: decisionNote.trim() }),
    onSuccess: (_d, decision) => onDone(decision === 'approve' ? 'Approved.' : 'Rejected.'),
  })

  if (detail.isLoading) return <Card><Loading /></Card>
  if (detail.error) return <Card><ErrorState error={detail.error} /></Card>

  const r = detail.data!.requisition
  const lines = detail.data!.lines

  return (
    <Card>
      <CardHeader
        title={`${r.requisition_no} — ${r.department ?? 'no department'}`}
        description={r.approval_permission
          ? `Approval sits in the "${r.approval_band}" band, which needs ${r.approval_permission}. The server checks that; this screen does not.`
          : 'Not yet submitted, so no approval band has been fixed.'}
      />
      <div className="border-b px-5 py-4 text-[13px]">
        <span className="text-muted-foreground">Why it is needed: </span>
        {detail.data!.justification || <em className="text-muted-foreground">not stated yet</em>}
      </div>

      <Table head={['#', 'Item', 'Description', 'Qty', 'Rate', 'Line total']} empty={!lines.length}>
        {lines.map((l) => (
          <tr key={l.id}>
            <Td className="text-muted-foreground">{l.line_no}</Td>
            <Td className="font-mono text-[12px]">{l.item_code ?? '—'}</Td>
            <Td>{l.description}</Td>
            <Td className="tabular-nums">{l.quantity} {l.unit}</Td>
            <Td className="tabular-nums">{inr(l.rate_paise)}</Td>
            <Td className="tabular-nums">{inr(l.quantity * l.rate_paise)}</Td>
          </tr>
        ))}
      </Table>

      {mayWrite && (r.status === 'draft' || r.status === 'submitted') && (
        <div className="space-y-3 border-t px-5 py-4">
          <FormNotice error={submit.error ?? decide.error} />
          {r.status === 'draft' && (
            <Button disabled={submit.isPending} onClick={() => submit.mutate()}>
              {submit.isPending ? 'Submitting…' : 'Submit for approval'}
            </Button>
          )}
          {r.status === 'submitted' && (
            <>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">
                  Note — required to reject, and worth writing when approving
                </span>
                <Textarea value={decisionNote} onChange={setDecisionNote} rows={2} />
              </label>
              <div className="flex gap-2">
                <Button disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
                  Approve
                </Button>
                <Button variant="secondary" disabled={decide.isPending || !decisionNote.trim()}
                  onClick={() => decide.mutate('reject')}>
                  Reject
                </Button>
              </div>
              <p className="text-[12px] text-muted-foreground">
                You will be refused if this value is above your authority, or if you raised it
                yourself.
              </p>
            </>
          )}
        </div>
      )}
      {r.decision_note && (
        <div className="border-t px-5 py-4 text-[13px]">
          <span className="text-muted-foreground">Decision by {r.decided_by ?? 'unknown'}: </span>
          {r.decision_note}
        </div>
      )}
    </Card>
  )
}

interface DraftLine {
  description: string
  quantity: string
  unit: string
  rate: string
}

function RequisitionForm({ onCancel, onSaved }: {
  onCancel: () => void; onSaved: (m: string) => void
}) {
  const [justification, setJustification] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([
    { description: '', quantity: '', unit: 'nos', rate: '' },
  ])

  const save = useMutation({
    mutationFn: () => api.post<{ requisition_no?: string }>(`${adminOpsBase}/purchasing/requisitions`, {
      justification: justification.trim(),
      lines: lines
        .filter((l) => l.description.trim() && Number(l.quantity) > 0)
        .map((l) => ({
          description: l.description.trim(),
          quantity: Number(l.quantity),
          unit: l.unit.trim() || 'nos',
          rate_paise: toPaise(l.rate),
        })),
    }),
    onSuccess: (r: { requisition_no?: string }) =>
      onSaved(`Saved as ${r.requisition_no ?? 'a draft'}. Submit it when the lines are right.`),
  })

  const set = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)))

  const total = lines.reduce((n, l) => n + (Number(l.quantity) || 0) * toPaise(l.rate), 0)
  const usable = lines.some((l) => l.description.trim() && Number(l.quantity) > 0)

  return (
    <Card>
      <CardHeader
        title="Raise a requisition"
        description="What you need and why. The value decides who has to agree to it."
        action={<Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      />
      <div className="space-y-4 p-5">
        <FormNotice error={save.error} />
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted-foreground">
            Why it is needed — required before it can be submitted
          </span>
          <Textarea value={justification} onChange={setJustification} rows={2}
            placeholder="Forty chairs for the new section in Block B" />
        </label>

        {lines.map((l, i) => (
          <div key={i} className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]">
            <Input value={l.description} onChange={(v) => set(i, { description: v })}
              placeholder="What is needed" srLabel={`Item ${i + 1}: what is needed`} />
            <Input value={l.quantity} onChange={(v) => set(i, { quantity: v })} placeholder="Qty"
              srLabel={`Item ${i + 1}: quantity`} />
            <Input value={l.unit} onChange={(v) => set(i, { unit: v })} placeholder="nos"
              srLabel={`Item ${i + 1}: unit`} />
            <Input value={l.rate} onChange={(v) => set(i, { rate: v })} placeholder="Rate ₹"
              srLabel={`Item ${i + 1}: rate in rupees`} />
            <Button variant="ghost" size="sm" disabled={lines.length === 1}
              onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))}>
              Remove
            </Button>
          </div>
        ))}
        <Button size="sm" variant="secondary"
          onClick={() => setLines((ls) => [...ls, { description: '', quantity: '', unit: 'nos', rate: '' }])}>
          Add a line
        </Button>
      </div>
      <div className="flex items-center justify-between border-t px-5 py-4">
        <span className="text-[13px] text-muted-foreground">
          Estimated value <strong className="tabular-nums text-foreground">{inr(total)}</strong>
        </span>
        <Button disabled={!usable || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save draft'}
        </Button>
      </div>
    </Card>
  )
}

// --- orders ------------------------------------------------------------------

function OrdersPanel({ mayWrite, onDone }: { mayWrite: boolean; onDone: (m: string) => void }) {
  const [open, setOpen] = useState<string | null>(null)

  const list = useQuery({
    queryKey: ['admin-ops', 'purchasing', 'orders'],
    queryFn: () => api.get<List<PurchaseOrder>>(`${adminOpsBase}/purchasing/orders`),
  })

  const items = list.data?.items ?? []
  const outstanding = items.filter((o) => o.status === 'issued' || o.status === 'partly_received')

  return (
    <>
      <CellGrid cols={4}>
        <Stat label="Orders" value={items.length} />
        <Stat label="Awaiting delivery" value={outstanding.length} />
        <Stat label="Ordered value"
          value={inr(items.reduce((n, o) => n + o.total_paise, 0))} />
        <Stat label="Received value"
          value={inr(items.reduce((n, o) => n + o.received_paise, 0))}
          hint="At order prices, rejects excluded" />
      </CellGrid>

      <Card>
        <CardHeader
          title="Purchase orders"
          description="Partly received orders lead — those are the ones somebody has to chase."
        />
        {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} /> : (
          <Table
            head={['No.', 'Vendor', 'Ordered', 'Expected', 'Value', 'Received', 'Status', '']}
            empty={!items.length}
            emptyLabel="No purchase orders yet. Approve a requisition and turn it into one."
          >
            {[...items]
              .sort((a, b) => Number(b.status === 'partly_received') - Number(a.status === 'partly_received'))
              .map((o) => (
                <tr key={o.id}>
                  <Td className="font-mono text-[12px]">{o.po_no}</Td>
                  <Td className="font-medium">{o.vendor}</Td>
                  <Td className="text-muted-foreground">{o.order_date}</Td>
                  <Td className="text-muted-foreground">{o.expected_on ?? '—'}</Td>
                  <Td className="tabular-nums">{inr(o.total_paise)}</Td>
                  <Td className="tabular-nums">
                    {inr(o.received_paise)}
                    {o.outstanding_lines > 0 && (
                      <span className="block text-[12px] text-muted-foreground">
                        {o.outstanding_lines} line{o.outstanding_lines === 1 ? '' : 's'} outstanding
                      </span>
                    )}
                  </Td>
                  <Td><Badge tone={STATUS_TONE[o.status] ?? 'neutral'}>{statusLabel(o.status)}</Badge></Td>
                  <Td>
                    <Button size="sm" variant="secondary"
                      onClick={() => setOpen(open === o.id ? null : o.id)}>
                      {open === o.id ? 'Close' : 'Open'}
                    </Button>
                  </Td>
                </tr>
              ))}
          </Table>
        )}
      </Card>

      {/* Keyed by the order. The delivery being entered — the challan number
          and the per-line quantities — belongs to the order it was opened
          against; the quantities are keyed by line id and so could not cross,
          but the challan number could, and it is the audit link to the vendor's
          own document. */}
      {open && <OrderDetail key={open} id={open} mayWrite={mayWrite} onDone={onDone} />}
    </>
  )
}

function OrderDetail({ id, mayWrite, onDone }: {
  id: string; mayWrite: boolean; onDone: (m: string) => void
}) {
  const [receiving, setReceiving] = useState(false)
  const [qty, setQty] = useState<Record<string, string>>({})
  const [rejected, setRejected] = useState<Record<string, string>>({})
  const [reason, setReason] = useState<Record<string, string>>({})
  const [challan, setChallan] = useState('')

  const detail = useQuery({
    queryKey: ['admin-ops', 'purchasing', 'orders', id],
    queryFn: () => api.get<{
      order: PurchaseOrder; lines: OrderLine[]; receipts: GoodsReceipt[]
      terms?: string; notes?: string; closed_reason?: string
    }>(`${adminOpsBase}/purchasing/orders/${id}`),
  })

  const issue = useMutation({
    mutationFn: () => api.post(`${adminOpsBase}/purchasing/orders/${id}/issue`, {}),
    onSuccess: () => onDone('Issued to the vendor.'),
  })

  const receive = useMutation({
    mutationFn: () => api.post<{ grn_no?: string; stock_movements?: number }>(
      `${adminOpsBase}/purchasing/orders/${id}/receipts`, {
      challan_no: challan.trim(),
      lines: (detail.data?.lines ?? [])
        .filter((l) => Number(qty[l.id]) > 0 || Number(rejected[l.id]) > 0)
        .map((l) => ({
          purchase_order_line_id: l.id,
          quantity_received: Number(qty[l.id]) || 0,
          quantity_rejected: Number(rejected[l.id]) || 0,
          rejection_reason: (reason[l.id] ?? '').trim(),
        })),
    }),
    onSuccess: (r: { grn_no?: string; stock_movements?: number }) => {
      setReceiving(false); setQty({}); setRejected({}); setReason({}); setChallan('')
      onDone(`${r.grn_no} recorded. ${r.stock_movements ?? 0} stock movement(s) written — the stores balance has already followed.`)
    },
  })

  if (detail.isLoading) return <Card><Loading /></Card>
  if (detail.error) return <Card><ErrorState error={detail.error} /></Card>

  const o = detail.data!.order
  const lines = detail.data!.lines
  const receipts = detail.data!.receipts
  const anyEntered = lines.some((l) => Number(qty[l.id]) > 0 || Number(rejected[l.id]) > 0)

  return (
    <>
      <Card>
        <CardHeader
          title={`${o.po_no} — ${o.vendor}`}
          description={o.requisition_no
            ? `Against requisition ${o.requisition_no}.`
            : 'Raised without a requisition — an exception worth being able to explain.'}
          action={mayWrite && o.status === 'draft' ? (
            <Button size="sm" disabled={issue.isPending} onClick={() => issue.mutate()}>
              Issue to vendor
            </Button>
          ) : mayWrite && (o.status === 'issued' || o.status === 'partly_received') ? (
            <Button size="sm" onClick={() => setReceiving(!receiving)}>
              {receiving ? 'Cancel' : 'Record a delivery'}
            </Button>
          ) : undefined}
        />
        <FormNotice error={issue.error ?? receive.error} />
        <Table
          head={['#', 'Description', 'Ordered', 'Received', 'Rejected', 'Outstanding', 'Rate', 'GST']}
          empty={!lines.length}
        >
          {lines.map((l) => (
            <tr key={l.id}>
              <Td className="text-muted-foreground">{l.line_no}</Td>
              <Td>
                {l.description}
                {l.item_code && (
                  <span className="block font-mono text-[12px] text-muted-foreground">
                    {l.item_code} — enters stock on receipt
                  </span>
                )}
                {!l.item_code && (
                  <span className="block text-[12px] text-muted-foreground">
                    no stock item — receivable, but nothing to shelve
                  </span>
                )}
              </Td>
              <Td className="tabular-nums">{l.quantity} {l.unit}</Td>
              <Td className="tabular-nums">{l.received_qty}</Td>
              <Td className="tabular-nums">{l.rejected_qty || '—'}</Td>
              <Td className={cn('tabular-nums', l.outstanding_qty > 0 && 'font-medium text-destructive')}>
                {l.outstanding_qty}
              </Td>
              <Td className="tabular-nums">{inr(l.unit_price_paise)}</Td>
              <Td className="tabular-nums text-muted-foreground">{l.tax_rate_bp / 100}%</Td>
            </tr>
          ))}
        </Table>
      </Card>

      {receiving && mayWrite && (
        <Card>
          <CardHeader
            title="Record what arrived"
            description="Leave a line blank if it was not in this delivery. Partial deliveries are normal and each one is its own note."
          />
          <div className="p-5">
            <label className="mb-4 flex max-w-sm flex-col gap-1.5 text-[13px]">
              <span className="text-muted-foreground">Vendor's challan number</span>
              <Input value={challan} onChange={setChallan} placeholder="From the delivery note" />
            </label>
            <Table head={['Description', 'Outstanding', 'Received now', 'Rejected', 'Why rejected']}>
              {lines.filter((l) => l.outstanding_qty > 0).map((l) => (
                <tr key={l.id}>
                  <Td>{l.description}</Td>
                  <Td className="tabular-nums text-muted-foreground">{l.outstanding_qty}</Td>
                  <Td>
                    <Input value={qty[l.id] ?? ''} placeholder="0"
                      srLabel={`Quantity received of ${l.description}`}
                      onChange={(v) => setQty((q) => ({ ...q, [l.id]: v }))} />
                  </Td>
                  <Td>
                    <Input value={rejected[l.id] ?? ''} placeholder="0"
                      srLabel={`Quantity rejected of ${l.description}`}
                      onChange={(v) => setRejected((q) => ({ ...q, [l.id]: v }))} />
                  </Td>
                  <Td>
                    <Input value={reason[l.id] ?? ''} placeholder="Damaged, wrong size…"
                      srLabel={`Reason for rejecting ${l.description}`}
                      onChange={(v) => setReason((q) => ({ ...q, [l.id]: v }))} />
                  </Td>
                </tr>
              ))}
            </Table>
          </div>
          <div className="border-t px-5 py-4">
            <Button disabled={!anyEntered || receive.isPending} onClick={() => receive.mutate()}>
              {receive.isPending ? 'Recording…' : 'Record delivery and move stock'}
            </Button>
            <p className="mt-2 text-[12px] text-muted-foreground">
              Rejected units are counted in but never enter stock and are not payable.
            </p>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Deliveries" description="Every arrival against this order." />
        <Table
          head={['GRN', 'Received', 'Challan', 'Units in', 'Rejected', 'Stock moved', 'By']}
          empty={!receipts.length}
          emptyLabel="Nothing has arrived yet."
        >
          {receipts.map((g) => (
            <tr key={g.id}>
              <Td className="font-mono text-[12px]">{g.grn_no}</Td>
              <Td className="text-muted-foreground">{g.received_on}</Td>
              <Td className="text-muted-foreground">{g.challan_no ?? '—'}</Td>
              <Td className="tabular-nums">{g.units_received}</Td>
              <Td className="tabular-nums">{g.units_rejected || '—'}</Td>
              <Td className="tabular-nums text-muted-foreground">{g.stock_movements}</Td>
              <Td className="text-muted-foreground">{g.received_by ?? '—'}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  )
}

// --- matching ----------------------------------------------------------------

function MatchingPanel({ mayPay, onDone }: { mayPay: boolean; onDone: (m: string) => void }) {
  const list = useQuery({
    queryKey: ['admin-ops', 'purchasing', 'matches'],
    queryFn: () => api.get<List<InvoiceMatch>>(`${adminOpsBase}/purchasing/matches`),
  })

  const orders = useQuery({
    queryKey: ['admin-ops', 'purchasing', 'orders'],
    queryFn: () => api.get<List<PurchaseOrder>>(`${adminOpsBase}/purchasing/orders`),
  })

  const [poID, setPoID] = useState('')

  const items = list.data?.items ?? []
  const blocked = items.filter((m) => m.status === 'blocked')
  const exposure = items
    .filter((m) => m.variance_paise > 0)
    .reduce((n, m) => n + m.variance_paise, 0)

  const matchable = (orders.data?.items ?? [])
    .filter((o) => o.status === 'partly_received' || o.status === 'received' || o.status === 'closed')

  return (
    <>
      <CellGrid cols={3}>
        <Stat label="Matched bills" value={items.length} />
        <Stat label="Blocked" value={blocked.length}
          hint={blocked.length ? 'Do not pay these' : 'Nothing held'} />
        <Stat label="Billed above receipts" value={inr(exposure)}
          hint="What the school would pay for goods it has not counted in" />
      </CellGrid>

      <Card>
        <CardHeader
          title="Three-way matching"
          description="Order, receipt, invoice. The exposure is measured against what arrived, not what was ordered — an invoice for goods still on a lorry is the case this stops."
        />
        <div className="border-b p-5">
          <label className="flex max-w-md flex-col gap-1.5 text-[13px]">
            <span className="text-muted-foreground">Match a bill against an order</span>
            <Select
              value={poID}
              onChange={setPoID}
              options={[
                { value: '', label: 'Choose a received order…' },
                ...matchable.map((o) => ({
                  value: o.id,
                  label: `${o.po_no} — ${o.vendor} — ${inr(o.received_paise)} received`,
                })),
              ]}
            />
          </label>
        </div>
        {poID && <MatchForm poID={poID} mayPay={mayPay}
          onDone={(m) => { setPoID(''); onDone(m) }} />}
      </Card>

      <Card>
        <CardHeader title="Matched bills" description="Largest variance first." />
        {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} /> : (
          <Table
            head={['PO', 'Vendor', 'Bill', 'Ordered', 'Received', 'Invoiced', 'Variance', 'Status']}
            empty={!items.length}
            emptyLabel="No bills matched yet."
          >
            {items.map((m) => (
              <tr key={m.id}>
                <Td className="font-mono text-[12px]">{m.po_no}</Td>
                <Td>{m.vendor}</Td>
                <Td className="font-mono text-[12px]">{m.bill_no}</Td>
                <Td className="tabular-nums text-muted-foreground">{inr(m.ordered_paise)}</Td>
                <Td className="tabular-nums">{inr(m.received_paise)}</Td>
                <Td className="tabular-nums">{inr(m.invoiced_paise)}</Td>
                <Td className={cn('tabular-nums', m.variance_paise > 0 && 'font-medium text-destructive')}>
                  {m.variance_paise === 0 ? '—' : inr(m.variance_paise)}
                </Td>
                <Td>
                  <Badge tone={STATUS_TONE[m.status] ?? 'neutral'}>{statusLabel(m.status)}</Badge>
                  {m.note && (
                    <span className="block text-[12px] text-muted-foreground">{m.note}</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}

interface BillOption {
  id: string
  bill_no: string
  bill_date: string
  total_paise: number
  status: string
  already_matched: boolean
}

function MatchForm({ poID, mayPay, onDone }: {
  poID: string; mayPay: boolean; onDone: (m: string) => void
}) {
  const [billID, setBillID] = useState('')
  const [note, setNote] = useState('')

  const preview = useQuery({
    queryKey: ['admin-ops', 'purchasing', 'match-preview', poID],
    queryFn: () => api.get<{
      po_no: string; vendor: string; ordered_paise: number
      received_paise: number; bills: BillOption[]; note: string
    }>(`${adminOpsBase}/purchasing/orders/${poID}/match`),
  })

  const decide = useMutation({
    mutationFn: (decision: string) =>
      api.post(`${adminOpsBase}/purchasing/orders/${poID}/match`,
        { vendor_bill_id: billID, decision, note: note.trim() }),
    onSuccess: (_r, decision) => onDone(
      decision === 'match' ? 'Matched — the bill agrees with what arrived.'
        : decision === 'accept_variance' ? 'Variance accepted, with a reason on the record.'
          : 'Blocked. Do not pay this until it is explained.'),
  })

  if (preview.isLoading) return <Loading />
  if (preview.error) return <ErrorState error={preview.error} />

  const p = preview.data!
  const bill = p.bills.find((b) => b.id === billID)
  const variance = bill ? bill.total_paise - p.received_paise : 0

  return (
    <div className="space-y-4 p-5">
      <FormNotice error={decide.error} />
      <CellGrid cols={3}>
        <Stat label="Ordered" value={inr(p.ordered_paise)} />
        <Stat label="Received" value={inr(p.received_paise)} hint="At order prices" />
        <Stat label="Invoiced" value={bill ? inr(bill.total_paise) : '—'} />
      </CellGrid>

      <label className="flex max-w-md flex-col gap-1.5 text-[13px]">
        <span className="text-muted-foreground">Vendor bill</span>
        <Select
          value={billID}
          onChange={setBillID}
          options={[
            { value: '', label: 'Choose the bill…' },
            ...p.bills.map((b) => ({
              value: b.id,
              label: `${b.bill_no} — ${b.bill_date} — ${inr(b.total_paise)}${b.already_matched ? ' (already matched)' : ''}`,
            })),
          ]}
        />
      </label>

      {bill && (
        <div className={cn('rounded-md border p-4 text-[13px]',
          variance > 0 ? 'border-destructive/40 bg-destructive/5' : 'border-border')}>
          {variance === 0
            ? 'The bill matches what was received exactly. Safe to pass for payment.'
            : variance > 0
              ? `The bill is ${inr(variance)} more than the goods received. That is the exposure — accept it with a reason, or block it.`
              : `The bill is ${inr(-variance)} less than the goods received. Worth checking a second bill is not coming.`}
        </div>
      )}

      {bill && mayPay && (
        <>
          <label className="flex flex-col gap-1.5 text-[13px]">
            <span className="text-muted-foreground">
              Reason — required to accept a difference
            </span>
            <Textarea value={note} onChange={setNote} rows={2} />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button disabled={decide.isPending || variance !== 0}
              onClick={() => decide.mutate('match')}>
              Match and pass for payment
            </Button>
            <Button variant="secondary" disabled={decide.isPending || !note.trim()}
              onClick={() => decide.mutate('accept_variance')}>
              Accept the difference
            </Button>
            <Button variant="secondary" disabled={decide.isPending}
              onClick={() => decide.mutate('block')}>
              Block
            </Button>
          </div>
        </>
      )}
      {bill && !mayPay && (
        <p className="text-[13px] text-muted-foreground">
          Passing a bill for payment needs finance rights.
        </p>
      )}
    </div>
  )
}

// --- approval ladder ---------------------------------------------------------

function LadderPanel({ mayConfigure, onDone }: {
  mayConfigure: boolean; onDone: (m: string) => void
}) {
  const list = useQuery({
    queryKey: ['admin-ops', 'purchasing', 'thresholds'],
    queryFn: () => api.get<{
      items: ApprovalBand[]; using_default: boolean; default: ApprovalBand[]
    }>(`${adminOpsBase}/purchasing/thresholds`),
  })

  if (list.isLoading) return <Card><Loading /></Card>
  if (list.error) return <Card><ErrorState error={list.error} /></Card>

  const d = list.data!
  const bands = d.using_default ? d.default : d.items

  return (
    <Card>
      <CardHeader
        title="Who may approve what"
        description={d.using_default
          ? 'No ladder configured, so the built-in default applies. Save your own to change it.'
          : 'Each band names a permission, not a person — so nothing stops while somebody is on leave.'}
      />
      {!bands.length ? (
        <EmptyState title="No bands" body="Nothing configured and no default available." />
      ) : (
        <Table head={['Band', 'Up to', 'Approver must hold']}>
          {bands.map((b, i) => (
            <tr key={b.id ?? i}>
              <Td className="font-medium">{b.label}</Td>
              <Td className="tabular-nums">
                {b.up_to_paise === undefined || b.up_to_paise === null
                  ? 'no limit'
                  : inr(b.up_to_paise)}
              </Td>
              <Td className="font-mono text-[12px] text-muted-foreground">
                {b.approver_permission}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <div className="border-t px-5 py-4 text-[13px] text-muted-foreground">
        {mayConfigure
          ? 'Editing the ladder is a settings change and replaces the whole set — a ladder with a gap is a requisition nobody may approve.'
          : 'Changing this needs institution settings rights, deliberately: a store keeper must not be able to raise their own ceiling.'}
        <p className="mt-2">
          Whoever raised a requisition can never approve it, whatever the ladder says.
        </p>
      </div>
      {/* The save form is intentionally omitted until a school asks for it:
          replacing a live ladder from a half-filled form is how a gap gets in.
          onDone is wired for when it lands. */}
      <span className="hidden">{String(!!onDone)}</span>
    </Card>
  )
}
