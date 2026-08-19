import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Banknote, Coins, ScaleIcon, Store } from 'lucide-react'
import { api, type Page, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Select, Input, Field, FormGrid, FormNotice,
  Loading, ErrorState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import {
  collectionsBase, collectionsKey, inr, toPaise, expectedCash, draftTotals,
  draftLineTotal, useTerminals, useTillSessions, useVarianceReport,
  CANTEEN_CATEGORIES, type DraftLine, type TillSession,
} from './collections-lib'

/* The canteen counter.

   Three things happen on this screen and they are three cards, in the order
   the day happens in: somebody opens the drawer, things are rung up, the
   drawer is counted.

   The variance panel is fourth and is the only one a bursar opens. A till that
   cannot be reconciled at close is an honesty box, so the report shows the
   sessions that disagreed with their drawer and nothing else -- a till that
   balanced is not a row here.

   There is no wallet and no card reader. The campus wallet feature is blocked
   for want of a payment gateway, and a stored balance a school can neither top
   up nor refund is a liability it cannot discharge. The cashless mode is
   charge-to-account, which raises an ordinary invoice on the fee ledger the
   parent already reads. The Select below says so rather than leaving the
   cashier to wonder where the card option went. */

export default function CanteenTerminal() {
  const can = useCan()
  const mayRing = can('finance.payments.write')

  const terminals = useTerminals('canteen')
  const open = useTillSessions('canteen', 'open')
  const recent = useTillSessions('canteen', 'closed')
  const variance = useVarianceReport('canteen')

  const [sessionId, setSessionId] = useState<string | null>(null)
  const live = open.data?.items ?? []
  const active = live.find((s) => s.id === sessionId) ?? live[0] ?? null

  if (terminals.isLoading || open.isLoading) return <Loading label="Opening the counter…" />
  // Never an empty state for a failed query: a blank counter reads as "no
  // sales today", which is a different and much worse statement than "the
  // server did not answer".
  if (terminals.error) return <ErrorState error={terminals.error} />
  if (open.error) return <ErrorState error={open.error} />

  const takings = live.reduce((n, s) => n + s.cash_sales_paise - s.cash_returns_paise, 0)
  const charged = live.reduce((n, s) => n + s.account_sales_paise, 0)

  return (
    <>
      <PageHead
        eyebrow="Collections"
        title="Canteen counter"
        description="Open a till with its float, ring up the break, and cash up against what is in the drawer."
        width="wide"
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Tills open" value={live.length} icon={Store}
            hint={live.length === 0 ? 'Nobody has a drawer open' : undefined} />
          <Stat label="Cash taken" value={inr(takings)} icon={Banknote}
            hint="Across every open drawer" />
          <Stat label="Charged to accounts" value={inr(charged)} icon={Coins}
            hint="Invoiced, not in the drawer" />
          <Stat label="Tills out of tolerance" value={variance.data?.items.length ?? '—'}
            icon={ScaleIcon} hint="Last thirty days" />
        </CellGrid>

        <OpenTill terminals={terminals.data?.items ?? []} disabled={!mayRing} />

        {active && (
          <RingUp key={active.id} session={active} disabled={!mayRing} />
        )}
        {active && <CashUp key={`cash-${active.id}`} session={active} disabled={!mayRing} />}

        {live.length > 1 && (
          <Card>
            <CardHeader
              title="Other open drawers"
              description="Pick the one you are working, so a sale lands on the right cash-up."
            />
            <Table head={['Counter', 'Opened by', 'Since', { label: 'Cash', align: 'right' }, '']}>
              {live.map((s) => (
                <tr key={s.id}>
                  <Td className="font-medium">{s.terminal_name}</Td>
                  <Td>{s.opened_by}</Td>
                  <Td>{new Date(s.opened_at).toLocaleTimeString('en-IN')}</Td>
                  <Td className="text-right tabular-nums">
                    {inr(s.cash_sales_paise - s.cash_returns_paise)}
                  </Td>
                  <Td>
                    <Button size="sm" variant="ghost" onClick={() => setSessionId(s.id)}>
                      {s.id === active.id ? 'Working' : 'Work this one'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        <VariancePanel />

        <Card>
          <CardHeader
            title="Cashed up"
            description="What each closed drawer was counted at, and how far that was from the till."
          />
          {recent.error ? (
            <div className="p-5"><ErrorState error={recent.error} /></div>
          ) : (
            <Table
              head={[
                'Counter', 'Opened by', 'Closed',
                { label: 'Expected', align: 'right' },
                { label: 'Counted', align: 'right' },
                { label: 'Variance', align: 'right' },
                'Reason',
              ]}
              empty={(recent.data?.items ?? []).length === 0}
              emptyLabel="No drawer has been cashed up yet."
            >
              {(recent.data?.items ?? []).map((s) => (
                <tr key={s.id}>
                  <Td className="font-medium">{s.terminal_name}</Td>
                  <Td>{s.opened_by}</Td>
                  <Td>{s.closed_at ? new Date(s.closed_at).toLocaleString('en-IN') : '—'}</Td>
                  <Td className="text-right tabular-nums">{inr(s.expected_cash_paise ?? 0)}</Td>
                  <Td className="text-right tabular-nums">{inr(s.counted_cash_paise ?? 0)}</Td>
                  <Td className="text-right tabular-nums">
                    <VarianceBadge paise={s.variance_paise} tolerance={s.variance_tolerance_paise} />
                  </Td>
                  <Td>{s.variance_reason ?? '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}

/* A variance reads as three different facts and the badge says which.

   Zero is "balanced" and is the only one that should be common. Inside the
   school's tolerance is a coin nobody can find. Outside it is a number
   somebody has to account for, and colouring it the same green as a balanced
   drawer is how it stops being looked at. */
export function VarianceBadge({ paise, tolerance }: { paise: number; tolerance: number }) {
  if (paise === 0) return <Badge tone="success">Balanced</Badge>
  const over = Math.abs(paise) > tolerance
  return (
    <Badge tone={over ? 'danger' : 'warning'}>
      {paise > 0 ? 'Over ' : 'Short '}
      {inr(Math.abs(paise))}
    </Badge>
  )
}

function OpenTill({
  terminals, disabled,
}: {
  terminals: { id: string; name: string; open_since?: string; open_by?: string }[]
  disabled: boolean
}) {
  const qc = useQueryClient()
  const [terminalId, setTerminalId] = useState('')
  const [float, setFloat] = useState('')

  const free = terminals.filter((t) => !t.open_since)

  const start = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`${collectionsBase}/sessions`, {
        terminal_id: terminalId,
        // The float is sent as an explicit number, never as an omitted field:
        // a blank box must not arrive as a confident zero.
        opening_float_paise: toPaise(float),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [collectionsKey] })
      setTerminalId('')
      setFloat('')
    },
  })

  return (
    <Card>
      <CardHeader
        title="Open a till"
        description="The float is what is in the drawer before the first sale. Count it now; at close it is what the variance is measured from."
      />
      <div className="p-5">
        <FormGrid>
          <Field label="Counter" required>
            <Select
              value={terminalId}
              onChange={setTerminalId}
              options={free.map((t) => ({ value: t.id, label: t.name }))}
              placeholder={free.length ? 'Which counter?' : 'Every counter is already open'}
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
        <FormNotice error={start.error} ok={start.isSuccess ? 'Till open.' : undefined} />
      </div>
    </Card>
  )
}

/* Ringing up.

   Lines are held in local state and posted as one request. A canteen has a
   queue of nine-year-olds and twenty minutes; posting a header and then each
   line would leave half-sales behind the first time the tablet lost signal,
   and half a sale is food handed over for money nobody took. */
function RingUp({ session, disabled }: { session: TillSession; disabled: boolean }) {
  const qc = useQueryClient()
  const [lines, setLines] = useState<DraftLine[]>([])
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [qty, setQty] = useState('1')
  const [category, setCategory] = useState('snack')
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

  const totals = useMemo(() => draftTotals(lines), [lines])

  const ring = useMutation({
    mutationFn: () =>
      api.post<{ receipt_no: string; total_paise: number; invoice_no?: string }>(
        `${collectionsBase}/sales`,
        {
          session_id: session.id,
          student_id: student?.id ?? '',
          buyer_name: student ? '' : buyer,
          payment_mode: mode,
          lines: lines.map((l) => ({
            item_name: l.itemName,
            category: l.category,
            quantity: l.quantity,
            unit_paise: l.unitPaise,
            discount_paise: l.discountPaise,
          })),
        },
      ),
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
    if (!name.trim() || price.trim() === '') return
    setLines((cur) => [
      ...cur,
      {
        key: `${Date.now()}-${cur.length}`,
        itemName: name.trim(),
        category,
        quantity: Math.max(1, Number(qty) || 1),
        unitPaise: toPaise(price),
        discountPaise: 0,
        // A canteen keeps no product master, so there is no rate to inherit.
        taxRateBP: 0,
      },
    ])
    setName('')
    setPrice('')
    setQty('1')
  }

  const ready = lines.length > 0 && (student !== null || buyer.trim() !== '')

  return (
    <Card>
      <CardHeader
        title={`Ring up — ${session.terminal_name}`}
        description={`Opened by ${session.opened_by}. ${session.sale_count} sales so far.`}
        action={receipt ? <Badge tone="success">Receipt {receipt}</Badge> : undefined}
      />
      <div className="p-5">
        <FormGrid>
          <Field label="Item" required>
            <Input value={name} onChange={setName} placeholder="Samosa" srLabel="Item name" />
          </Field>
          <Field label="Category">
            <Select value={category} onChange={setCategory} options={CANTEEN_CATEGORIES} />
          </Field>
          <Field label="Price each (₹)" required>
            <Input value={price} onChange={setPrice} type="number" srLabel="Price in rupees" />
          </Field>
          <Field label="Quantity">
            <Input value={qty} onChange={setQty} type="number" srLabel="Quantity" />
          </Field>
        </FormGrid>
        <div className="mt-5">
          <Button variant="secondary" onClick={addLine} disabled={!name.trim() || price.trim() === ''}>
            Add to the receipt
          </Button>
        </div>
      </div>

      <Table
        head={[
          'Item', 'Category',
          { label: 'Qty', align: 'right' },
          { label: 'Each', align: 'right' },
          { label: 'Line', align: 'right' },
          '',
        ]}
        empty={lines.length === 0}
        emptyLabel="Nothing on the receipt yet."
      >
        {lines.map((l) => (
          <tr key={l.key}>
            <Td className="font-medium">{l.itemName}</Td>
            <Td>{l.category}</Td>
            <Td className="text-right tabular-nums">{l.quantity}</Td>
            <Td className="text-right tabular-nums">{inr(l.unitPaise)}</Td>
            <Td className="text-right tabular-nums">{inr(draftLineTotal(l).total)}</Td>
            <Td>
              <Button
                size="sm"
                variant="ghost"
                tone="danger"
                onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))}
              >
                Remove
              </Button>
            </Td>
          </tr>
        ))}
      </Table>

      <div className="p-5">
        <FormGrid>
          <Field label="How is it being paid?" required
            hint="Cash, or charged to the child's fee account. There is no wallet or card: the campus wallet feature has no payment gateway behind it.">
            <Select
              value={mode}
              onChange={(v) => setMode(v as 'cash' | 'account')}
              options={[
                { value: 'cash', label: 'Cash into the drawer' },
                { value: 'account', label: "Charge the child's fee account" },
              ]}
            />
          </Field>
          <Field label="Who is buying?" required={mode === 'account'}
            hint={mode === 'account' ? 'A charge needs a child to charge.' : 'Or type a name for a staff purchase.'}>
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
                <Button key={st.id} size="sm" variant="outline" onClick={() => { setStudent(st); setSearch('') }}>
                  {st.full_name} · {st.class_name ?? '—'}
                </Button>
              ))}
            </div>
          )
        )}

        {!student && mode === 'cash' && (
          <div className="mt-5">
            <Field label="Or a name for the receipt" hint="A teacher buying lunch is not on the roll.">
              <Input value={buyer} onChange={setBuyer} srLabel="Buyer's name" />
            </Field>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-4">
          <span className="text-lg font-semibold tabular-nums">{inr(totals.total)}</span>
          <Button disabled={disabled || !ready || ring.isPending} onClick={() => ring.mutate()}>
            {ring.isPending ? 'Taking…' : mode === 'cash' ? 'Take the cash' : 'Charge the account'}
          </Button>
        </div>
        <FormNotice error={ring.error} />
      </div>
    </Card>
  )
}

/* The cash-up.

   Expected is shown before the count is typed, deliberately. A cashier who is
   handed the number after counting will find the number; one who sees it first
   and counts anyway is doing the check the feature exists for. */
function CashUp({ session, disabled }: { session: TillSession; disabled: boolean }) {
  const qc = useQueryClient()
  const [counted, setCounted] = useState('')
  const [paidOut, setPaidOut] = useState('')
  const [reason, setReason] = useState('')

  const paidOutPaise = paidOut.trim() === '' ? 0 : toPaise(paidOut)
  const expected = expectedCash(session, paidOutPaise)
  const countedPaise = counted.trim() === '' ? null : toPaise(counted)
  const variance = countedPaise === null ? null : countedPaise - expected
  const outside = variance !== null && Math.abs(variance) > session.variance_tolerance_paise

  const close = useMutation({
    mutationFn: () =>
      api.post<{ variance_paise: number }>(`${collectionsBase}/sessions/${session.id}/close`, {
        counted_cash_paise: countedPaise,
        paid_out_paise: paidOutPaise,
        variance_reason: reason,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [collectionsKey] })
      setCounted('')
      setPaidOut('')
      setReason('')
    },
  })

  return (
    <Card>
      <CardHeader
        title="Cash up"
        description="Count the drawer, then close. The expected figure is frozen on the session at close, so a later refund cannot restate tonight's variance."
      />
      <div className="p-5">
        <CellGrid cols={4}>
          <Stat label="Opening float" value={inr(session.opening_float_paise)} />
          <Stat label="Cash taken" value={inr(session.cash_sales_paise)}
            hint={`${session.sale_count} sales`} />
          <Stat label="Refunded" value={inr(session.cash_returns_paise)}
            hint={`${session.return_count} returns`} />
          <Stat label="Expected in the drawer" value={inr(expected)}
            hint="Charged-to-account sales are not in here" />
        </CellGrid>

        <div className="mt-5">
          <FormGrid>
            <Field label="Counted (₹)" required hint="What is physically in the drawer.">
              <Input value={counted} onChange={setCounted} type="number" srLabel="Counted cash in rupees" />
            </Field>
            <Field label="Paid out (₹)" hint="Change fetched, a supplier paid at the door. Not a refund.">
              <Input value={paidOut} onChange={setPaidOut} type="number" srLabel="Paid out in rupees" />
            </Field>
            <Field
              label="What happened?"
              required={outside}
              wide
              hint={outside
                ? 'Outside the school’s tolerance, so this is required.'
                : 'Optional while the difference is small.'}
            >
              <Input value={reason} onChange={setReason} srLabel="Reason for the variance" />
            </Field>
          </FormGrid>
        </div>

        {variance !== null && (
          <div className="mt-5 flex items-center gap-3">
            <span className="text-sm">Variance</span>
            <VarianceBadge paise={variance} tolerance={session.variance_tolerance_paise} />
          </div>
        )}

        <div className="mt-5">
          <ConfirmButton
            confirmLabel="Close the till"
            question="Closing freezes the expected figure and the variance. It cannot be reopened."
            disabled={disabled || close.isPending || countedPaise === null || (outside && !reason.trim())}
            onConfirm={() => close.mutate()}
          >
            {close.isPending ? 'Closing…' : 'Cash up and close'}
          </ConfirmButton>
        </div>
        <FormNotice error={close.error} ok={close.isSuccess ? 'Cashed up.' : undefined} />
      </div>
    </Card>
  )
}

/* The variance report.

   Only the drawers that disagreed by more than the tolerance, ordered by how
   badly. A report that listed every session with a variance column would put
   the fifty-rupee shortfalls from this morning above the five-thousand-rupee
   one from Tuesday, and the one that matters would never be looked at. */
export function VariancePanel({ kind = 'canteen' as const }: { kind?: 'canteen' | 'store' }) {
  const report = useVarianceReport(kind)
  return (
    <Card>
      <CardHeader
        title="Tills that did not reconcile"
        description="Only the drawers outside the school’s tolerance, worst first. A till that balanced is not here."
        action={
          report.data ? (
            <span className="text-sm tabular-nums">
              Short {inr(report.data.total_short_paise)} · Over {inr(report.data.total_over_paise)}
            </span>
          ) : undefined
        }
      />
      {report.error ? (
        <div className="p-5"><ErrorState error={report.error} /></div>
      ) : report.isLoading ? (
        <div className="p-5"><Loading label="Reading the cash-ups…" /></div>
      ) : (
        <Table
          head={[
            'Counter', 'Held by', 'Closed',
            { label: 'Expected', align: 'right' },
            { label: 'Counted', align: 'right' },
            { label: 'Variance', align: 'right' },
            'Reason given',
          ]}
          empty={(report.data?.items ?? []).length === 0}
          emptyLabel="Every drawer reconciled inside tolerance."
        >
          {(report.data?.items ?? []).map((v) => (
            <tr key={v.session_id}>
              <Td className="font-medium">{v.terminal_name}</Td>
              <Td>{v.opened_by}</Td>
              <Td>{new Date(v.closed_at).toLocaleDateString('en-IN')}</Td>
              <Td className="text-right tabular-nums">{inr(v.expected_cash_paise)}</Td>
              <Td className="text-right tabular-nums">{inr(v.counted_cash_paise)}</Td>
              <Td className="text-right tabular-nums">
                <VarianceBadge
                  paise={v.variance_paise}
                  tolerance={report.data?.variance_tolerance_paise ?? 0}
                />
              </Td>
              <Td>{v.variance_reason ?? '—'}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}
