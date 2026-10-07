import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Input, Button, Field, FormGrid,
  Loading, ErrorState, FormNotice, TAB_BAR, tabClass,
} from '@/components/ui'
import { formatPaise, formatDate, cn } from '@/lib/utils'

/* The fixed finance reports. Seven sheets an accountant asks for by name;
   each is one request and one table, nothing to configure. */

type Tab = 'cheques' | 'bank' | 'outstanding' | 'plan' | 'monthwise' | 'bank_details' | 'card'
const TABS: { key: Tab; label: string }[] = [
  { key: 'cheques', label: 'Cheque deposits' },
  { key: 'bank', label: 'Bank pay-in slip' },
  { key: 'outstanding', label: 'Outstanding as at' },
  { key: 'plan', label: 'Fee plan details' },
  { key: 'monthwise', label: 'Month-wise' },
  { key: 'bank_details', label: 'Parent bank details' },
  { key: 'card', label: 'Card charges' },
]

const today = () => new Date().toISOString().slice(0, 10)
const thisMonth = () => today().slice(0, 7)
const monthsAgo = (n: number) => { const d = new Date(); d.setMonth(d.getMonth() - n); return d.toISOString().slice(0, 10) }

export default function FixedReports() {
  const [tab, setTab] = useState<Tab>('cheques')
  return (
    <>
      <PageHead eyebrow="Banking & Reports" title="Fixed reports" />
      <PageBody>
        <div className={cn(TAB_BAR, 'mb-4')}>
          {TABS.map((t) => (
            <button key={t.key} type="button" className={tabClass(tab === t.key)} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>
        {tab === 'cheques' && <ChequeDeposits />}
        {tab === 'bank' && <BankSubmission />}
        {tab === 'outstanding' && <OutstandingAsAt />}
        {tab === 'plan' && <FeePlanDetails />}
        {tab === 'monthwise' && <MonthWise />}
        {tab === 'bank_details' && <ParentBankDetails />}
        {tab === 'card' && <CardCharges />}
      </PageBody>
    </>
  )
}

const STAGE: Record<string, string> = { held: 'Held (post-dated)', due: 'Due to bank', banked: 'Banked', cleared: 'Cleared', bounced: 'Bounced' }

function ChequeDeposits() {
  interface Row { id: string; receipt_no: string; mode: string; cheque_no: string; bank_name: string; cheque_date: string; amount_paise: number; student_name: string; admission_no: string; class_name: string; stage: string }
  const q = useQuery({
    queryKey: ['fixed-reports', 'cheques'],
    queryFn: () => api.get<{ items: Row[]; totals: Record<string, { count: number; amount_paise: number }> }>('/api/v1/finance/reports/cheque-deposits'),
  })
  const [stage, setStage] = useState('')
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorState error={q.error} />
  const totals = q.data?.totals ?? {}
  const rows = (q.data?.items ?? []).filter((r) => !stage || r.stage === stage)
  return (
    <div className="space-y-4">
      <CellGrid cols={4}>
        {(['held', 'due', 'banked', 'bounced'] as const).map((k) => (
          <Stat key={k} label={STAGE[k]} value={formatPaise(totals[k]?.amount_paise ?? 0)} hint={`${totals[k]?.count ?? 0} instruments`}
            onClick={() => setStage(stage === k ? '' : k)} active={stage === k} />
        ))}
      </CellGrid>
      <Card>
        <CardHeader title={stage ? STAGE[stage] : 'Every cheque and DD'} />
        <Table head={['Student', 'Class', 'Receipt', 'Cheque / DD', 'Bank', 'Dated', { label: 'Amount', align: 'right' }, 'Stage']} empty={!rows.length} emptyLabel="No cheques or DDs taken.">
          {rows.map((r) => (
            <tr key={r.id}>
              <Td className="font-medium">{r.student_name}<span className="block font-mono text-[11.5px] font-normal text-muted-foreground">{r.admission_no}</span></Td>
              <Td className="text-muted-foreground">{r.class_name || '-'}</Td>
              <Td className="font-mono text-[12.5px]">{r.receipt_no}</Td>
              <Td className="font-mono text-[12.5px]">{r.mode.toUpperCase()} {r.cheque_no || '-'}</Td>
              <Td className="text-muted-foreground">{r.bank_name || '-'}</Td>
              <Td className="text-muted-foreground">{formatDate(r.cheque_date)}</Td>
              <Td className="text-right tabular-nums font-medium">{formatPaise(r.amount_paise)}</Td>
              <Td>{STAGE[r.stage] ?? r.stage}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  )
}

function BankSubmission() {
  interface Line { receipt_no: string; mode: string; cheque_no: string; cheque_date: string; amount_paise: number; student_name: string; admission_no: string }
  interface Group { bank_name: string; count: number; amount_paise: number; lines: Line[] }
  const [on, setOn] = useState(today())
  const q = useQuery({
    queryKey: ['fixed-reports', 'bank-submission', on],
    queryFn: () => api.get<{ on: string; cash_paise: number; instruments: Group[]; instrument_count: number; instrument_paise: number; total_paise: number }>(`/api/v1/finance/reports/bank-submission?on=${on}`),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(on),
  })
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3 p-5">
          <Field label="Day"><Input type="date" value={on} onChange={setOn} /></Field>
        </div>
      </Card>
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} />}
      {q.data && (
        <>
          <CellGrid cols={3}>
            <Stat label="Cash" value={formatPaise(q.data.cash_paise)} />
            <Stat label="Cheques and DDs" value={formatPaise(q.data.instrument_paise)} hint={`${q.data.instrument_count} instruments`} />
            <Stat label="Total to bank" value={formatPaise(q.data.total_paise)} />
          </CellGrid>
          {q.data.instruments.map((g) => (
            <Card key={g.bank_name}>
              <CardHeader title={g.bank_name} description={`${g.count} · ${formatPaise(g.amount_paise)}`} />
              <Table head={['Receipt', 'Instrument', 'Dated', 'Student', { label: 'Amount', align: 'right' }]}>
                {g.lines.map((l) => (
                  <tr key={l.receipt_no}>
                    <Td className="font-mono text-[12.5px]">{l.receipt_no}</Td>
                    <Td className="font-mono text-[12.5px]">{l.mode.toUpperCase()} {l.cheque_no || '-'}</Td>
                    <Td className="text-muted-foreground">{l.cheque_date ? formatDate(l.cheque_date) : '-'}</Td>
                    <Td>{l.student_name} <span className="font-mono text-[11.5px] text-muted-foreground">{l.admission_no}</span></Td>
                    <Td className="text-right tabular-nums font-medium">{formatPaise(l.amount_paise)}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          ))}
          {!q.data.instruments.length && q.data.cash_paise === 0 && (
            <Card><p className="p-6 text-center text-[13.5px] text-muted-foreground">Nothing was taken in cash, cheque or DD on {formatDate(on)}.</p></Card>
          )}
        </>
      )}
    </div>
  )
}

function OutstandingAsAt() {
  interface Cls { class_name: string; students: number; billed_paise: number; paid_paise: number; outstanding_paise: number }
  interface Row { student_id: string; student_name: string; admission_no: string; class_name: string; billed_paise: number; paid_paise: number; outstanding_paise: number }
  const [month, setMonth] = useState(thisMonth())
  const [open, setOpen] = useState('')
  const q = useQuery({
    queryKey: ['fixed-reports', 'outstanding', month],
    queryFn: () => api.get<{ month: string; as_at: string; classes: Cls[]; items: Row[]; total_outstanding_paise: number }>(`/api/v1/finance/reports/outstanding-as-at?month=${month}`),
    enabled: /^\d{4}-\d{2}$/.test(month),
  })
  const rows = (q.data?.items ?? []).filter((r) => !open || r.class_name === open)
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3 p-5">
          <Field label="As at the end of"><Input type="month" value={month} onChange={setMonth} /></Field>
          {q.data && <p className="pb-2 text-[13.5px] text-muted-foreground">Billed and paid up to {formatDate(q.data.as_at)}. Later payments do not change this figure.</p>}
        </div>
      </Card>
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} />}
      {q.data && (
        <>
          <Card>
            <CardHeader title="By class" description={`Outstanding ${formatPaise(q.data.total_outstanding_paise)}`} />
            <Table head={['Class', { label: 'Students', align: 'right' }, { label: 'Billed', align: 'right' }, { label: 'Paid', align: 'right' }, { label: 'Outstanding', align: 'right' }]} empty={!q.data.classes.length} emptyLabel="Nothing had been billed by then.">
              {q.data.classes.map((c) => (
                <tr key={c.class_name} className={cn('cursor-pointer', open === c.class_name && 'bg-surface-hover')} onClick={() => setOpen(open === c.class_name ? '' : c.class_name)}>
                  <Td className="font-medium">{c.class_name}</Td>
                  <Td className="text-right tabular-nums">{c.students}</Td>
                  <Td className="text-right tabular-nums">{formatPaise(c.billed_paise)}</Td>
                  <Td className="text-right tabular-nums">{formatPaise(c.paid_paise)}</Td>
                  <Td className="text-right tabular-nums font-medium">{formatPaise(c.outstanding_paise)}</Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card>
            <CardHeader title={open ? `Who owes in ${open}` : 'Who owes'} />
            <Table head={['Student', 'Class', { label: 'Billed', align: 'right' }, { label: 'Paid', align: 'right' }, { label: 'Outstanding', align: 'right' }]} empty={!rows.length} emptyLabel="Nobody owed anything as at that date.">
              {rows.map((r) => (
                <tr key={r.student_id}>
                  <Td className="font-medium">{r.student_name}<span className="block font-mono text-[11.5px] font-normal text-muted-foreground">{r.admission_no}</span></Td>
                  <Td className="text-muted-foreground">{r.class_name}</Td>
                  <Td className="text-right tabular-nums">{formatPaise(r.billed_paise)}</Td>
                  <Td className="text-right tabular-nums">{formatPaise(r.paid_paise)}</Td>
                  <Td className="text-right tabular-nums font-medium">{formatPaise(r.outstanding_paise)}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </div>
  )
}

function FeePlanDetails() {
  interface Row { student_id: string; student_name: string; admission_no: string; class_name: string; fee_head: string; amount_paise: number; discount_paise: number; net_paise: number; instalments: number }
  const [find, setFind] = useState('')
  const q = useQuery({
    queryKey: ['fixed-reports', 'fee-plan'],
    queryFn: () => api.get<{ year: { id: string; name: string } | null; items: Row[] }>('/api/v1/finance/reports/fee-plan-details'),
  })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorState error={q.error} />
  const needle = find.trim().toLowerCase()
  const rows = (q.data?.items ?? []).filter((r) => !needle || r.student_name.toLowerCase().includes(needle) || r.admission_no.toLowerCase().includes(needle) || r.class_name.toLowerCase().includes(needle))
  return (
    <Card>
      <CardHeader title={q.data?.year ? `Fee plan, ${q.data.year.name}` : 'Fee plan'} action={<Input className="w-56" value={find} onChange={setFind} placeholder="Find a child or class" />} />
      <Table head={['Student', 'Class', 'Fee head', { label: 'Instalments', align: 'right' }, { label: 'Amount', align: 'right' }, { label: 'Concession', align: 'right' }, { label: 'Payable', align: 'right' }]} empty={!rows.length} emptyLabel="Nothing billed this year.">
        {rows.map((r) => (
          <tr key={r.student_id + r.fee_head}>
            <Td className="font-medium">{r.student_name}<span className="block font-mono text-[11.5px] font-normal text-muted-foreground">{r.admission_no}</span></Td>
            <Td className="text-muted-foreground">{r.class_name || '-'}</Td>
            <Td>{r.fee_head}</Td>
            <Td className="text-right tabular-nums">{r.instalments}</Td>
            <Td className="text-right tabular-nums">{formatPaise(r.amount_paise)}</Td>
            <Td className="text-right tabular-nums">{r.discount_paise ? formatPaise(r.discount_paise) : '-'}</Td>
            <Td className="text-right tabular-nums font-medium">{formatPaise(r.net_paise)}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`

function MonthWise() {
  interface Row { month: string; invoices: number; gross_paise: number; concession_paise: number; billed_paise: number; receipts: number; collected_paise: number; outstanding_paise: number }
  const [from, setFrom] = useState(monthsAgo(11))
  const [to, setTo] = useState(today())
  const q = useQuery({
    queryKey: ['fixed-reports', 'monthwise', from, to],
    queryFn: () => api.get<{ opening_outstanding_paise: number; items: Row[] }>(`/api/v1/finance/reports/monthwise?from=${from}&to=${to}`),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to),
  })
  const items = q.data?.items ?? []
  const sum = (k: keyof Row) => items.reduce((a, r) => a + Number(r[k]), 0)
  return (
    <div className="space-y-4">
      <Card>
        <div className="p-5">
          <FormGrid>
            <Field label="From"><Input type="date" value={from} onChange={setFrom} /></Field>
            <Field label="To"><Input type="date" value={to} onChange={setTo} /></Field>
          </FormGrid>
        </div>
      </Card>
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} />}
      {q.data && (
        <Card>
          <CardHeader title="Month by month" description={`Opening outstanding ${formatPaise(q.data.opening_outstanding_paise)}`} />
          <Table head={['Month', { label: 'Invoices', align: 'right' }, { label: 'Gross', align: 'right' }, { label: 'Concession', align: 'right' }, { label: 'Billed', align: 'right' }, { label: 'Receipts', align: 'right' }, { label: 'Collected', align: 'right' }, { label: 'Outstanding', align: 'right' }]} empty={!items.length}>
            {items.map((r) => (
              <tr key={r.month}>
                <Td className="font-medium">{monthLabel(r.month)}</Td>
                <Td className="text-right tabular-nums">{r.invoices}</Td>
                <Td className="text-right tabular-nums">{formatPaise(r.gross_paise)}</Td>
                <Td className="text-right tabular-nums">{formatPaise(r.concession_paise)}</Td>
                <Td className="text-right tabular-nums">{formatPaise(r.billed_paise)}</Td>
                <Td className="text-right tabular-nums">{r.receipts}</Td>
                <Td className="text-right tabular-nums">{formatPaise(r.collected_paise)}</Td>
                <Td className="text-right tabular-nums font-medium">{formatPaise(r.outstanding_paise)}</Td>
              </tr>
            ))}
            {items.length > 0 && (
              <tr className="font-medium">
                <Td>Total</Td>
                <Td className="text-right tabular-nums">{sum('invoices')}</Td>
                <Td className="text-right tabular-nums">{formatPaise(sum('gross_paise'))}</Td>
                <Td className="text-right tabular-nums">{formatPaise(sum('concession_paise'))}</Td>
                <Td className="text-right tabular-nums">{formatPaise(sum('billed_paise'))}</Td>
                <Td className="text-right tabular-nums">{sum('receipts')}</Td>
                <Td className="text-right tabular-nums">{formatPaise(sum('collected_paise'))}</Td>
                <Td className="text-right tabular-nums">{formatPaise(items[items.length - 1].outstanding_paise)}</Td>
              </tr>
            )}
          </Table>
        </Card>
      )}
    </div>
  )
}

function ParentBankDetails() {
  interface Row { id: string; student_name: string; admission_no: string; class_name: string; account_holder_name: string; relationship: string; bank_name: string; branch: string; account_number: string; ifsc: string; account_type: string; is_primary: boolean; is_aadhaar_seeded: boolean; dbt_consent_on: string | null; verified: boolean }
  const q = useQuery({ queryKey: ['fixed-reports', 'bank-details'], queryFn: () => api.get<{ items: Row[] }>('/api/v1/finance/reports/parent-bank-details') })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorState error={q.error} />
  const rows = q.data?.items ?? []
  return (
    <Card>
      <CardHeader title="Bank accounts on file" description="Account numbers are masked here. The full number is only on the payout file." />
      <Table head={['Student', 'Class', 'Account holder', 'Bank', 'Account', 'IFSC', 'Verified']} empty={!rows.length} emptyLabel="No family has a bank account on file. They are added on Match bank records.">
        {rows.map((r) => (
          <tr key={r.id}>
            <Td className="font-medium">{r.student_name}<span className="block font-mono text-[11.5px] font-normal text-muted-foreground">{r.admission_no}</span></Td>
            <Td className="text-muted-foreground">{r.class_name || '-'}</Td>
            <Td>{r.account_holder_name}{r.relationship && <span className="block text-[11.5px] text-muted-foreground">{r.relationship}{r.is_primary ? ' · primary' : ''}</span>}</Td>
            <Td className="text-muted-foreground">{r.bank_name}{r.branch ? `, ${r.branch}` : ''}</Td>
            <Td className="font-mono text-[12.5px]">{r.account_number}{r.is_aadhaar_seeded && <span className="block font-sans text-[11.5px] text-muted-foreground">Aadhaar seeded</span>}</Td>
            <Td className="font-mono text-[12.5px]">{r.ifsc}</Td>
            <Td className="text-muted-foreground">{r.verified ? 'Yes' : 'No'}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

function CardCharges() {
  interface Row { mode: string; receipts: number; amount_paise: number; rate_bp: number; charge_paise: number }
  const qc = useQueryClient()
  const [from, setFrom] = useState(monthsAgo(1))
  const [to, setTo] = useState(today())
  const [rate, setRate] = useState('')
  const q = useQuery({
    queryKey: ['fixed-reports', 'card', from, to],
    queryFn: () => api.get<{ rate_bp: number; items: Row[]; charge_paise: number }>(`/api/v1/finance/reports/card-charges?from=${from}&to=${to}`),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to),
  })
  const save = useMutation({
    mutationFn: (bp: number) => api.put('/api/v1/finance/reports/card-charges/settings', { rate_bp: bp }),
    onSuccess: () => { setRate(''); qc.invalidateQueries({ queryKey: ['fixed-reports', 'card'] }) },
  })
  const pct = (bp: number) => `${(bp / 100).toFixed(2)}%`
  const MODE: Record<string, string> = { card: 'Card machine', upi: 'UPI', netbanking: 'Net banking' }
  return (
    <div className="space-y-4">
      <Card>
        <div className="p-5">
          <FormGrid>
            <Field label="From"><Input type="date" value={from} onChange={setFrom} /></Field>
            <Field label="To"><Input type="date" value={to} onChange={setTo} /></Field>
            <Field label="Card rate the bank charges" hint={q.data ? `Now ${pct(q.data.rate_bp)}. Enter a percentage, such as 1.5.` : 'Enter a percentage, such as 1.5.'}>
              <div className="flex gap-2">
                <Input className="w-28" value={rate} onChange={setRate} placeholder="1.5" />
                <Button variant="secondary" disabled={!rate.trim() || save.isPending || !Number.isFinite(Number(rate))} onClick={() => save.mutate(Math.round(Number(rate) * 100))}>Save</Button>
              </div>
            </Field>
          </FormGrid>
          <FormNotice error={save.error} />
        </div>
      </Card>
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} />}
      {q.data && (
        <Card>
          <CardHeader title="What card swipes cost" description={`${formatPaise(q.data.charge_paise)} over the period`} />
          <Table head={['Mode', { label: 'Receipts', align: 'right' }, { label: 'Collected', align: 'right' }, { label: 'Rate', align: 'right' }, { label: 'Charge', align: 'right' }]} empty={!q.data.items.length} emptyLabel="No card, UPI or net banking receipts in this period.">
            {q.data.items.map((r) => (
              <tr key={r.mode}>
                <Td className="font-medium">{MODE[r.mode] ?? r.mode}</Td>
                <Td className="text-right tabular-nums">{r.receipts}</Td>
                <Td className="text-right tabular-nums">{formatPaise(r.amount_paise)}</Td>
                <Td className="text-right tabular-nums">{r.rate_bp ? pct(r.rate_bp) : '-'}</Td>
                <Td className="text-right tabular-nums font-medium">{r.charge_paise ? formatPaise(r.charge_paise) : '-'}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  )
}
