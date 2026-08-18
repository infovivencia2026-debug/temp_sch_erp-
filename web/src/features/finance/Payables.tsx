import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, ReceiptText, AlarmClock, Banknote } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState,
} from '@/components/ui'
import {
  inr, rupees, toPaise, useAccounts, accountOptions, ledgerBase,
  type Vendor, type VendorBill,
} from './ledger-lib'

/* Vendors and what the school owes them.

   A bill is recorded as a draft and posts nothing. Approving it is what makes
   it a liability — Dr the expense head, Cr sundry creditors — because the
   expense belongs to the year the goods arrived, not the year somebody got
   round to paying. Posting on payment instead would move expenditure between
   years at the convenience of the cash flow.

   What has been paid is summed from the payment history rather than stored, so
   the outstanding figure on this screen and the receipts in the file can never
   disagree in front of the vendor. */

const BUCKET_TONE: Record<string, 'neutral' | 'warning' | 'danger' | 'success'> = {
  'not due': 'neutral', '0-30': 'neutral', '31-60': 'warning',
  '61-90': 'warning', '90+': 'danger', '—': 'success',
}

export default function Payables() {
  const vendors = useQuery({
    queryKey: ['ledgers', 'vendors'],
    queryFn: () => api.get<List<Vendor>>(`${ledgerBase}/vendors`),
  })
  const bills = useQuery({
    queryKey: ['ledgers', 'bills'],
    queryFn: () => api.get<List<VendorBill>>(`${ledgerBase}/bills`),
  })

  if (vendors.isLoading) return <Loading label="Reading the creditor ledger…" />
  if (vendors.error) return <ErrorState error={vendors.error} />

  const vs = vendors.data?.items ?? []
  const bs = bills.data?.items ?? []
  const owed = vs.reduce((s, v) => s + v.outstanding_paise, 0)
  const overdue = vs.reduce((s, v) => s + v.overdue_paise, 0)
  const drafts = bs.filter((b) => b.status === 'draft')

  return (
    <>
      <PageHead
        eyebrow="Accounts"
        title="Vendors and accounts payable"
        description="The creditor directory, the bills against it, and what is overdue. A bill becomes a liability when it is approved, not when it is paid."
        width="wide"
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Owed to vendors" value={inr(owed)} icon={Banknote} />
          <Stat label="Overdue" value={inr(overdue)} icon={AlarmClock}
            delta={overdue
              ? { value: 'Past the agreed terms', positive: false }
              : { value: 'Nothing past its date', positive: true }} />
          <Stat label="Awaiting approval" value={drafts.length} icon={ReceiptText}
            hint="Bills recorded but not yet accepted as a liability" />
          <Stat label="Vendors" value={vs.filter((v) => v.is_active).length} icon={Building2} />
        </CellGrid>

        <NewBill vendors={vs} />
        <NewVendor />

        <Card>
          <CardHeader title="Bills"
            description="Ageing runs from the due date, which falls back to the vendor's agreed terms when a bill carries none. Approve a bill before paying it — the database refuses payment against a draft." />
          <Table head={['Bill', 'Vendor', 'Head', 'Due', { label: 'Total', align: 'right' },
            { label: 'Paid', align: 'right' }, { label: 'Outstanding', align: 'right' },
            'State', 'Age', '']}
            empty={bs.length === 0} emptyLabel="No bills recorded yet.">
            {bs.map((b) => <BillRow key={b.id} bill={b} />)}
          </Table>
        </Card>

        <Card>
          <CardHeader title="Vendor directory"
            description="A GSTIN is stored uppercase because a lower case one fails the return it was collected for, and nobody finds out until the filing is rejected." />
          <Table head={['Code', 'Vendor', 'GSTIN', 'Terms', 'Bills',
            { label: 'Billed', align: 'right' }, { label: 'Outstanding', align: 'right' },
            { label: 'Overdue', align: 'right' }]}
            empty={vs.length === 0} emptyLabel="No vendors on file.">
            {vs.map((v) => (
              <tr key={v.id}>
                <Td className="tabular-nums text-muted-foreground">{v.code}</Td>
                <Td className="font-medium">
                  {v.name}
                  {v.category && (
                    <div className="text-[12px] font-normal text-muted-foreground">{v.category}</div>
                  )}
                </Td>
                <Td className="text-[13px] tabular-nums text-muted-foreground">{v.gstin ?? '—'}</Td>
                <Td className="text-muted-foreground">{v.payment_terms_days} days</Td>
                <Td className="tabular-nums text-muted-foreground">{v.bills || '—'}</Td>
                <Td className="text-right tabular-nums">{rupees(v.billed_paise)}</Td>
                <Td className="text-right tabular-nums">{rupees(v.outstanding_paise)}</Td>
                <Td className={`text-right tabular-nums ${v.overdue_paise ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {v.overdue_paise ? rupees(v.overdue_paise) : '—'}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </PageBody>
    </>
  )
}

function BillRow({ bill }: { bill: VendorBill }) {
  const qc = useQueryClient()
  const [paying, setPaying] = useState(false)
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState('neft')
  const [ref, setRef] = useState('')
  const [tds, setTds] = useState('')
  const invalidate = () => qc.invalidateQueries({ queryKey: ['ledgers'] })

  const approve = useMutation({
    mutationFn: () => api.post(`${ledgerBase}/bills/${bill.id}/approve`),
    onSuccess: invalidate,
  })
  const pay = useMutation({
    mutationFn: () =>
      api.post(`${ledgerBase}/bills/${bill.id}/pay`, {
        amount_paise: toPaise(amount),
        mode,
        reference_no: ref || undefined,
        tds_paise: toPaise(tds) || undefined,
      }),
    onSuccess: () => { setPaying(false); setAmount(''); setTds(''); invalidate() },
  })

  return (
    <>
      <tr>
        <Td className="font-medium">
          {bill.bill_no}
          <div className="text-[12px] font-normal text-muted-foreground">{bill.bill_date}</div>
        </Td>
        <Td>{bill.vendor_name}</Td>
        <Td className="text-[13px] text-muted-foreground">{bill.expense_code} {bill.expense_name}</Td>
        <Td className="text-muted-foreground">{bill.due_on ?? '—'}</Td>
        <Td className="text-right tabular-nums">{rupees(bill.total_paise)}</Td>
        <Td className="text-right tabular-nums text-muted-foreground">{rupees(bill.paid_paise)}</Td>
        <Td className="text-right font-medium tabular-nums">{rupees(bill.outstanding_paise)}</Td>
        <Td>
          <Badge tone={bill.payment_state === 'paid' ? 'success'
            : bill.payment_state === 'draft' ? 'neutral'
              : bill.payment_state === 'part paid' ? 'info' : 'warning'}>
            {bill.payment_state}
          </Badge>
          {bill.voucher_no && (
            <div className="text-[12px] text-muted-foreground">{bill.voucher_no}</div>
          )}
        </Td>
        <Td>
          <Badge tone={BUCKET_TONE[bill.bucket] ?? 'neutral'}>{bill.bucket}</Badge>
        </Td>
        <Td>
          <div className="flex gap-1.5">
            {bill.status === 'draft' && (
              <ConfirmButton confirmLabel="Approve" variant="primary"
                question="Accept this bill as a liability and post it to the ledger?"
                disabled={approve.isPending}
                onConfirm={() => approve.mutate()}>
                Approve
              </ConfirmButton>
            )}
            {bill.status === 'approved' && bill.outstanding_paise > 0 && (
              <Button size="sm" variant="secondary" onClick={() => setPaying(!paying)}>
                {paying ? 'Cancel' : 'Pay'}
              </Button>
            )}
          </div>
        </Td>
      </tr>
      {(approve.error || pay.error) && (
        <tr><Td colSpan={10}><FormNotice error={approve.error ?? pay.error} /></Td></tr>
      )}
      {paying && (
        <tr>
          <Td colSpan={10}>
            <div className="space-y-4 py-2">
              <FormGrid>
                <Field label="Amount (₹)" required
                  hint={`${rupees(bill.outstanding_paise)} outstanding — the database refuses an overpayment`}>
                  <Input type="number" value={amount} onChange={setAmount} />
                </Field>
                <Field label="Mode">
                  <Select value={mode} onChange={setMode} options={[
                    { value: 'neft', label: 'NEFT' }, { value: 'rtgs', label: 'RTGS' },
                    { value: 'cheque', label: 'Cheque' }, { value: 'dd', label: 'Demand draft' },
                    { value: 'upi', label: 'UPI' }, { value: 'cash', label: 'Cash' },
                  ]} />
                </Field>
                <Field label="Reference"
                  hint={mode === 'cheque' || mode === 'dd' ? 'Required: the instrument number' : 'Transaction reference'}>
                  <Input value={ref} onChange={setRef} placeholder="NEFT9931" />
                </Field>
                <Field label="TDS withheld (₹)"
                  hint="Credited to TDS payable, not to the vendor. Their account is relieved of the gross.">
                  <Input type="number" value={tds} onChange={setTds} />
                </Field>
              </FormGrid>
              <Button onClick={() => pay.mutate()} disabled={!amount || pay.isPending}>
                Pay the vendor
              </Button>
            </div>
          </Td>
        </tr>
      )}
    </>
  )
}

function NewBill({ vendors }: { vendors: Vendor[] }) {
  const qc = useQueryClient()
  const accounts = useAccounts()
  const [vendorId, setVendorId] = useState('')
  const [billNo, setBillNo] = useState('')
  const [billDate, setBillDate] = useState('')
  const [dueOn, setDueOn] = useState('')
  const [head, setHead] = useState('')
  const [taxable, setTaxable] = useState('')
  const [tax, setTax] = useState('')
  const [narration, setNarration] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post(`${ledgerBase}/bills`, {
        vendor_id: vendorId, bill_no: billNo,
        bill_date: billDate || undefined, due_on: dueOn || undefined,
        expense_account_id: head,
        taxable_paise: toPaise(taxable), tax_paise: toPaise(tax),
        narration: narration || undefined,
      }),
    onSuccess: () => {
      setBillNo(''); setTaxable(''); setTax(''); setNarration('')
      qc.invalidateQueries({ queryKey: ['ledgers'] })
    },
  })

  return (
    <Card>
      <CardHeader title="Record a bill"
        description="Recorded as a draft: nothing reaches the ledger until it is approved. The bill number is required because a vendor billing the same number twice is the duplicate-payment control an auditor tests first." />
      <div className="space-y-5 p-5">
        <FormGrid>
          <Field label="Vendor" required>
            <Select value={vendorId} onChange={setVendorId} placeholder="Choose a vendor"
              options={vendors.filter((v) => v.is_active).map((v) => ({ value: v.id, label: `${v.name} (${v.code})` }))} />
          </Field>
          <Field label="Bill number" required>
            <Input value={billNo} onChange={setBillNo} placeholder="SLS/2026/117" />
          </Field>
          <Field label="Bill date"><Input type="date" value={billDate} onChange={setBillDate} /></Field>
          <Field label="Due on" hint="Left blank, the vendor's agreed terms decide it">
            <Input type="date" value={dueOn} onChange={setDueOn} />
          </Field>
          <Field label="Expense head" required
            hint="A bill entered now and classified later is a bill classified never">
            <Select value={head} onChange={setHead} placeholder="Choose a head"
              options={accountOptions(accounts.data?.items, 'expense', 'asset')} />
          </Field>
          <Field label="Taxable amount (₹)" required>
            <Input type="number" value={taxable} onChange={setTaxable} />
          </Field>
          <Field label="Tax (₹)" hint="GST charged on the bill; kept separate for the return">
            <Input type="number" value={tax} onChange={setTax} />
          </Field>
          <Field label="What it was for" wide>
            <Textarea value={narration} onChange={setNarration} rows={2}
              placeholder="Exam answer booklets, 5000 sheets" />
          </Field>
        </FormGrid>
        <FormNotice error={save.error} ok={save.isSuccess ? 'Bill recorded as a draft.' : undefined} />
        <Button onClick={() => save.mutate()}
          disabled={!vendorId || !billNo || !head || !taxable || save.isPending}>
          Record the bill
        </Button>
      </div>
    </Card>
  )
}

function NewVendor() {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [contact, setContact] = useState('')
  const [phone, setPhone] = useState('')
  const [gstin, setGstin] = useState('')
  const [pan, setPan] = useState('')
  const [category, setCategory] = useState('')
  const [terms, setTerms] = useState('30')

  const save = useMutation({
    mutationFn: () =>
      api.post(`${ledgerBase}/vendors`, {
        name, contact_person: contact || undefined, phone: phone || undefined,
        gstin: gstin || undefined, pan: pan || undefined,
        category: category || undefined, payment_terms_days: Number(terms || 30),
      }),
    onSuccess: () => {
      setName(''); setContact(''); setPhone(''); setGstin(''); setPan('')
      qc.invalidateQueries({ queryKey: ['ledgers'] })
    },
  })

  return (
    <Card>
      <CardHeader title="Add a vendor"
        description="A code is allocated in sequence if you do not supply one, inside the transaction, so the directory never has two vendors sharing a number." />
      <div className="space-y-5 p-5">
        <FormGrid>
          <Field label="Name" required><Input value={name} onChange={setName} placeholder="Sri Lakshmi Stationers" /></Field>
          <Field label="Contact person"><Input value={contact} onChange={setContact} /></Field>
          <Field label="Phone"><Input value={phone} onChange={setPhone} placeholder="9848012345" /></Field>
          <Field label="Category"><Input value={category} onChange={setCategory} placeholder="stationery" /></Field>
          <Field label="GSTIN" hint="Fifteen characters, state code first">
            <Input value={gstin} onChange={setGstin} placeholder="36AABCS1429B1ZP" />
          </Field>
          <Field label="PAN"><Input value={pan} onChange={setPan} placeholder="AABCS1429B" /></Field>
          <Field label="Payment terms (days)" hint="What the ageing report ages against">
            <Input type="number" value={terms} onChange={setTerms} />
          </Field>
        </FormGrid>
        <FormNotice error={save.error} ok={save.isSuccess ? 'Vendor added.' : undefined} />
        <Button onClick={() => save.mutate()} disabled={!name || save.isPending}>Add the vendor</Button>
      </div>
    </Card>
  )
}
