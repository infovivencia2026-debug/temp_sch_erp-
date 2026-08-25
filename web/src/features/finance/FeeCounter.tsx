import { useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Printer, Banknote } from 'lucide-react'
import { api, type Page, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Select, Input, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatPaise, formatDate, cn } from '@/lib/utils'
import { useToast } from '@/components/Toast'

/* The fee counter. A cashier does exactly four things here: find the student,
   read what they owe, take the money, hand over a printed receipt. Everything
   else on the screen is in service of not getting those four wrong. */

interface Due {
  invoice_id: string; invoice_no: string; issued_on: string; due_on?: string
  net_paise: number; paid_paise: number; balance_paise: number
  fine_paise: number; status: string; days_overdue: number
}
interface LedgerEntry {
  date: string; kind: string; reference: string; description: string
  debit_paise: number; credit_paise: number; status: string; mode?: string
}
interface Ledger {
  student_id: string; admission_no: string; full_name: string
  class_name?: string; section_name?: string
  charged_paise: number; paid_paise: number; balance_paise: number; pending_paise: number
  concessions: { kind: string; percent?: string; amount_paise?: number; reason?: string; fee_head?: string }[]
  dues: Due[]
  entries: LedgerEntry[]
}
interface Receipt {
  receipt_no: string; amount_paise: number; amount_words: string
  mode: string; paid_on: string; student_name: string; admission_no: string
  institution: string; class_name?: string; section_name?: string
  collected_by?: string; financial_year: string; reference_no?: string
  lines: { invoice_no: string; amount_paise: number; particulars: string }[]
}

const MODES = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'neft', label: 'NEFT / IMPS' },
  { value: 'netbanking', label: 'Net banking' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'dd', label: 'Demand draft' },
]

export default function FeeCounter() {
  const toast = useToast()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [studentId, setStudentId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState('cash')
  const [reference, setReference] = useState('')
  const [bank, setBank] = useState('')
  const [chequeDate, setChequeDate] = useState('')
  const [receipt, setReceipt] = useState<Receipt | null>(null)

  const results = useQuery({
    queryKey: ['fee-search', search],
    queryFn: () => api.get<Page<Student>>(`/api/v1/students?q=${encodeURIComponent(search)}&limit=15`),
    enabled: search.trim().length >= 2,
    placeholderData: keepPreviousData,
  })

  const ledger = useQuery({
    queryKey: ['fee-ledger', studentId],
    queryFn: () => api.get<Ledger>(`/api/v1/fees/students/${studentId}/ledger`),
    enabled: !!studentId,
  })

  const collect = useMutation({
    mutationFn: () =>
      api.post<{ payment_id: string; receipt_no: string }>('/api/v1/fees/payments', {
        student_id: studentId,
        // Rupees in the box, paise on the wire — the API never sees a decimal.
        amount_paise: Math.round(parseFloat(amount || '0') * 100),
        mode,
        reference_no: reference || undefined,
        bank_name: bank || undefined,
        cheque_date: chequeDate || undefined,
        invoice_ids: selected.size ? [...selected] : undefined,
      }),
    onSuccess: async (res) => {
      const r = await api.get<Receipt>(`/api/v1/fees/receipts/${res.payment_id}`)
      setReceipt(r)
      // Named, not "Saved": the cashier reads this number back across the
      // counter, and an unconfirmed payment is the one that gets taken twice.
      toast.ok(`Receipt ${res.receipt_no} issued`)
      setAmount(''); setReference(''); setBank(''); setChequeDate(''); setSelected(new Set())
      qc.invalidateQueries({ queryKey: ['fee-ledger', studentId] })
      qc.invalidateQueries({ queryKey: ['finance-dashboard'] })
    },
  })

  const l = ledger.data
  const dues = l?.dues ?? []
  const selectedTotal = dues
    .filter((d) => selected.has(d.invoice_id))
    .reduce((a, d) => a + d.balance_paise, 0)

  const toggle = (id: string) => {
    const next = new Set(selected)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelected(next)
    const total = dues.filter((d) => next.has(d.invoice_id)).reduce((a, d) => a + d.balance_paise, 0)
    if (total > 0) setAmount((total / 100).toFixed(2))
  }

  const isCheque = mode === 'cheque' || mode === 'dd'
  const amountPaise = Math.round(parseFloat(amount || '0') * 100)
  /* Why the button is dead, not merely that it is.

     Three separate conditions disabled Collect and the clerk was told none of
     them. At a fee counter that is a queue forming while somebody clicks a grey
     button — and the likeliest cause is a cheque with no number typed, which
     nothing on screen mentioned. */
  const blocker = !studentId
    ? 'Find a student first.'
    : amountPaise <= 0
      ? 'Enter an amount to collect.'
      : isCheque && reference.trim() === ''
        ? 'A cheque needs its number before it can be collected.'
        : ''
  const canCollect = blocker === ''

  return (
    <>
      <PageHead
        eyebrow="Fee Workspace"
        title="Fee counter"
        description="Search a student, collect payment against outstanding invoices, and issue a numbered receipt."
      />
      <PageBody>
        {receipt && <ReceiptView receipt={receipt} onClose={() => setReceipt(null)} />}

        <Card>
          <CardHeader
            title="Find student"
            description="Search by name or admission number"
            action={
              <Input value={search} onChange={setSearch} placeholder="Name or admission no." />
            }
          />
          {search.trim().length >= 2 && (
            results.isLoading ? <Loading /> : (
              <Table head={['Admission no.', 'Name', 'Class', '']} empty={!results.data?.items.length}
                emptyLabel="No student matches that search.">
                {(results.data?.items ?? []).map((s) => (
                  <tr key={s.id} className={cn(s.id === studentId && 'bg-accent')}>
                    <Td className="font-mono text-[12px]">{s.admission_no}</Td>
                    <Td className="font-medium">{s.full_name}</Td>
                    <Td>{s.class_name ? `${s.class_name}-${s.section_name}` : '—'}</Td>
                    <Td>
                      <Button size="sm" variant={s.id === studentId ? 'ink' : 'outline'}
                        onClick={() => { setStudentId(s.id); setSelected(new Set()); setAmount('') }}>
                        {s.id === studentId ? 'Selected' : 'Select'}
                      </Button>
                    </Td>
                  </tr>
                ))}
              </Table>
            )
          )}
        </Card>

        {!studentId ? (
          <EmptyState title="No student selected" body="Search above to open a student's fee account." />
        ) : ledger.isLoading ? (
          <Loading />
        ) : ledger.error ? (
          <ErrorState error={ledger.error} />
        ) : l ? (
          <>
            <CellGrid cols={4}>
              <Stat label="Total charged" value={formatPaise(l.charged_paise)} />
              <Stat label="Collected" value={formatPaise(l.paid_paise)} />
              <Stat
                label="Balance"
                value={formatPaise(l.balance_paise)}
                delta={{ value: l.balance_paise > 0 ? 'Payable' : 'Settled', positive: l.balance_paise <= 0 }}
              />
              <Stat
                label="Cheques held"
                value={formatPaise(l.pending_paise)}
                hint={l.pending_paise ? 'Not yet cleared' : 'None'}
              />
            </CellGrid>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <Card>
                <CardHeader
                  title={`${l.full_name} · ${l.admission_no}`}
                  description={
                    l.class_name
                      ? `${l.class_name}-${l.section_name} · ${dues.length} outstanding invoice${dues.length === 1 ? '' : 's'}`
                      : `${dues.length} outstanding`
                  }
                />
                <Table
                  head={['', 'Invoice', 'Due', 'Amount', 'Paid', 'Balance', 'Status']}
                  empty={!dues.length}
                  emptyLabel="Nothing outstanding — the account is settled."
                >
                  {dues.map((d) => (
                    <tr key={d.invoice_id}>
                      <Td>
                        <input
                          type="checkbox"
                          checked={selected.has(d.invoice_id)}
                          onChange={() => toggle(d.invoice_id)}
                          aria-label={`Select ${d.invoice_no}`}
                        />
                      </Td>
                      <Td className="font-mono text-[12px]">{d.invoice_no}</Td>
                      <Td className="text-muted-foreground">
                        {formatDate(d.due_on)}
                        {d.days_overdue > 0 && (
                          <Badge tone="danger">{d.days_overdue}d late</Badge>
                        )}
                      </Td>
                      <Td>{formatPaise(d.net_paise)}</Td>
                      <Td>{formatPaise(d.paid_paise)}</Td>
                      <Td className="font-medium">{formatPaise(d.balance_paise)}</Td>
                      <Td><Badge tone={d.status === 'overdue' ? 'danger' : 'warning'}>{d.status}</Badge></Td>
                    </tr>
                  ))}
                </Table>
                {selected.size > 0 && (
                  <p className="border-t px-5 py-2.5 text-[13px] text-muted-foreground">
                    {selected.size} invoice{selected.size === 1 ? '' : 's'} selected ·{' '}
                    <span className="font-medium text-foreground">{formatPaise(selectedTotal)}</span>
                  </p>
                )}
              </Card>

              <Card>
                <CardHeader title="Collect payment" description="Issues a numbered receipt" />
                <form
                  className="space-y-3 p-5"
                  onSubmit={(e) => { e.preventDefault(); collect.mutate() }}
                >
                  <label className="block">
                    <span className="text-[13px] text-muted-foreground">Amount (₹)</span>
                    <Input value={amount} onChange={setAmount} placeholder="0.00" className="mt-1 w-full" />
                  </label>

                  <label className="block">
                    <span className="text-[13px] text-muted-foreground">Mode</span>
                    <div className="mt-1">
                      <Select value={mode} onChange={setMode} options={MODES} />
                    </div>
                  </label>

                  {isCheque && (
                    <>
                      <label className="block">
                        <span className="text-[13px] text-muted-foreground">Instrument number</span>
                        <Input value={reference} onChange={setReference} placeholder="Cheque / DD no." className="mt-1 w-full" />
                      </label>
                      <label className="block">
                        <span className="text-[13px] text-muted-foreground">Bank</span>
                        <Input value={bank} onChange={setBank} placeholder="Bank name" className="mt-1 w-full" />
                      </label>
                      <label className="block">
                        <span className="text-[13px] text-muted-foreground">Instrument date</span>
                        <input
                          type="date"
                          value={chequeDate}
                          onChange={(e) => setChequeDate(e.target.value)}
                          className="field mt-1 w-full"
                        />
                        <span className="mt-1 block text-[12px] text-muted-foreground">
                          A future date is held as a post-dated cheque and is not counted as collected.
                        </span>
                      </label>
                    </>
                  )}

                  {collect.isError && (
                    <p className="text-[13px] text-destructive">
                      {collect.error instanceof Error ? collect.error.message : 'Collection failed'}
                    </p>
                  )}

                  {blocker && (
                    <p id="collect-blocker" className="text-[12.5px] text-muted-foreground">{blocker}</p>
                  )}
                  <Button
                    type="submit"
                    disabled={!canCollect || collect.isPending}
                    aria-describedby={blocker ? 'collect-blocker' : undefined}
                    title={blocker || undefined}
                  >
                    <Banknote className="h-4 w-4" />
                    {collect.isPending ? 'Collecting…' : `Collect ${amountPaise ? formatPaise(amountPaise) : ''}`}
                  </Button>
                </form>
              </Card>
            </div>

            <Card>
              <CardHeader title="Account history" description="Every charge, payment and refund" />
              <Table head={['Date', 'Particulars', 'Reference', 'Debit', 'Credit', 'Status']}
                empty={!l.entries.length}>
                {l.entries.map((e, i) => (
                  <tr key={`${e.reference}-${i}`}>
                    <Td className="text-muted-foreground">{formatDate(e.date)}</Td>
                    <Td>{e.description}</Td>
                    <Td className="font-mono text-[12px]">{e.reference}</Td>
                    <Td>{e.debit_paise ? formatPaise(e.debit_paise) : '—'}</Td>
                    <Td>{e.credit_paise ? formatPaise(e.credit_paise) : '—'}</Td>
                    <Td>
                      <Badge tone={
                        e.status === 'paid' || e.status === 'success' ? 'success'
                        : e.status === 'bounced' ? 'danger'
                        : e.status === 'pending' ? 'warning' : 'neutral'
                      }>
                        {e.status}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </>
        ) : null}
      </PageBody>
    </>
  )
}

/** The printable receipt. `print:` utilities strip the app chrome so the
    browser's own print dialog produces something a parent can keep. */
function ReceiptView({ receipt, onClose }: { receipt: Receipt; onClose: () => void }) {
  return (
    <Card className="border-success/40 print:border-0">
      <CardHeader
        title="Payment received"
        description={`Receipt ${receipt.receipt_no}`}
        action={
          <div className="flex gap-2 no-print">
            <Button variant="secondary" onClick={() => window.print()}>
              <Printer className="h-4 w-4" /> Print
            </Button>
            <Button variant="ghost" onClick={onClose}>Close</Button>
          </div>
        }
      />
      <div className="p-6 text-[14px]">
        <div className="mb-5 text-center">
          <p className="text-[15px] font-semibold">{receipt.institution}</p>
          <p className="text-[13px] text-muted-foreground">
            Fee receipt · {receipt.financial_year}
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-x-8 gap-y-1.5">
          <Row k="Receipt no." v={receipt.receipt_no} mono />
          <Row k="Date" v={formatDate(receipt.paid_on)} />
          <Row k="Student" v={receipt.student_name} />
          <Row k="Admission no." v={receipt.admission_no} mono />
          <Row k="Class" v={receipt.class_name ? `${receipt.class_name}-${receipt.section_name}` : '—'} />
          <Row k="Mode" v={receipt.mode.toUpperCase()} />
          {receipt.reference_no && <Row k="Instrument" v={receipt.reference_no} mono />}
          {receipt.collected_by && <Row k="Received by" v={receipt.collected_by} />}
        </dl>

        {receipt.lines.length > 0 && (
          <table className="mt-5 w-full text-[13px]">
            <thead>
              <tr className="border-b">
                <th className="py-1.5 text-left font-medium text-muted-foreground">Particulars</th>
                <th className="py-1.5 text-left font-medium text-muted-foreground">Invoice</th>
                <th className="py-1.5 text-right font-medium text-muted-foreground">Amount</th>
              </tr>
            </thead>
            <tbody>
              {receipt.lines.map((line) => (
                <tr key={line.invoice_no}>
                  <td className="py-1.5">{line.particulars}</td>
                  <td className="py-1.5 font-mono text-[12px]">{line.invoice_no}</td>
                  <td className="py-1.5 text-right">{formatPaise(line.amount_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="mt-5 border-t pt-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] text-muted-foreground">Total received</span>
            <span className="text-[20px] font-medium">{formatPaise(receipt.amount_paise)}</span>
          </div>
          {/* Amount in words is a tamper check, and Indian receipts are
              expected to carry it. */}
          <p className="mt-1 text-[13px] italic text-muted-foreground">{receipt.amount_words}</p>
        </div>

        <p className="mt-6 text-[12px] text-muted-foreground">
          This is a computer-generated receipt. Cheques and drafts are subject to realisation.
        </p>
      </div>
    </Card>
  )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={cn('text-right font-medium', mono && 'font-mono text-[12px]')}>{v}</dd>
    </>
  )
}
