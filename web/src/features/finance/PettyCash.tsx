import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Coins, ShieldCheck, ReceiptText } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Field, FormGrid, FormNotice, Input, Select, Textarea,
  SkeletonTable, ErrorState,
} from '@/components/ui'
import {
  inr, rupees, toPaise, useAccounts, accountOptions, ledgerBase,
  type PettyVoucher,
} from './ledger-lib'

/* The petty cash tin.

   Two controls, and only two, because that is all a tin has: a slip exists for
   every rupee, and anything above the school's limit was signed by somebody
   other than the person spending it. The balance shown is what the ledger
   says should be in the drawer — the point of the figure is that somebody can
   count the drawer and disagree with it.

   A slip posts nothing until it is decided. Approving it moves the money out
   of the tin and into an expense head; refusing it requires a reason, because
   a claim refused without one is a claim that comes back next week. */

interface PettyTopUp {
  id: string; topup_date: string; amount_paise: number; from: string
  reference_no?: string | null; note?: string | null; by?: string | null
  journal_voucher_no?: string | null
}
interface PettyCount {
  id: string; counted_on: string; book_paise: number; counted_paise: number
  variance_paise: number; variance_reason?: string | null; by?: string | null
}
interface PettyResponse {
  items: PettyVoucher[]
  limit_paise: number
  balance_paise: number
  /* The float: how much the tin is meant to hold, who holds it, and how much
     to put in to bring it back to full. Zero float means "not set". */
  float_paise: number
  custodian?: string | null
  replenish_paise: number
  topups: PettyTopUp[]
  counts: PettyCount[]
}

export default function PettyCash() {
  const q = useQuery({
    queryKey: ['ledgers', 'petty-cash'],
    queryFn: () => api.get<PettyResponse>(`${ledgerBase}/petty-cash`),
  })

  if (q.isLoading) return <SkeletonTable columns={4} label="Opening the tin…" />
  if (q.error) return <ErrorState error={q.error} />

  const rows = q.data?.items ?? []
  const pending = rows.filter((v) => v.status === 'pending')
  const needSecond = pending.filter((v) => v.needs_approval)
  const spent = rows.filter((v) => v.status === 'approved').reduce((s, v) => s + v.amount_paise, 0)
  const noReceipt = rows.filter((v) => v.status === 'approved' && !v.has_receipt)

  return (
    <>
      <PageHead
        eyebrow="Accounts"
        title="Petty cash vouchers"
        description="The small slips, the limit above which a second signature is needed, and what the ledger says is left in the tin."
        width="wide"
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="In the tin" value={inr(q.data?.balance_paise ?? 0)} icon={Coins}
            hint="What the ledger says. Count the drawer and see if it agrees." />
          <Stat label="Awaiting a decision" value={pending.length} icon={ReceiptText}
            delta={needSecond.length
              ? { value: `${needSecond.length} above the limit`, positive: false }
              : undefined} />
          <Stat label="Float" value={(q.data?.float_paise ?? 0) > 0 ? inr(q.data!.float_paise) : 'Not set'}
            hint={(q.data?.replenish_paise ?? 0) > 0
              ? `Top up ${inr(q.data!.replenish_paise)} to bring the tin back to full`
              : (q.data?.float_paise ?? 0) > 0 ? 'The tin is at or above its float'
              : `${inr(spent)} paid out across all approved slips`}
            delta={(q.data?.replenish_paise ?? 0) > 0
              ? { value: `${inr(q.data!.replenish_paise)} below float`, positive: false }
              : undefined} />
          <Stat label="Limit" value={inr(q.data?.limit_paise ?? 0)} icon={ShieldCheck}
            hint="Above this a slip needs a second signature, from somebody other than who raised it" />
        </CellGrid>

        {noReceipt.length > 0 && (
          <Card>
            <CardHeader title="Approved without a receipt"
              description="Cash paid out against a slip with no paper behind it. This is the first thing an auditor samples." />
            <Table head={['Voucher', 'Payee', 'For', { label: 'Amount', align: 'right' }]}
              empty={false}>
              {noReceipt.map((v) => (
                <tr key={v.id}>
                  <Td className="font-medium tabular-nums">{v.voucher_no}</Td>
                  <Td>{v.payee}</Td>
                  <Td className="text-muted-foreground">{v.particulars}</Td>
                  <Td className="text-right tabular-nums">{rupees(v.amount_paise)}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        {q.data && <ManageFloat data={q.data} />}

        <RaiseVoucher limit={q.data?.limit_paise ?? 0} />

        <Card>
          <CardHeader title="The voucher book"
            description="Numbered gaplessly within the financial year. A cash book with a hole in its numbering is a cash book somebody has to explain." />
          <Table head={['Voucher', 'Date', 'Payee', 'For', 'Head',
            { label: 'Amount', align: 'right' }, 'Status', '']}
            empty={rows.length === 0} emptyLabel="No petty cash vouchers raised yet.">
            {rows.map((v) => <VoucherRow key={v.id} voucher={v} />)}
          </Table>
        </Card>
      </PageBody>
    </>
  )
}

function VoucherRow({ voucher }: { voucher: PettyVoucher }) {
  const qc = useQueryClient()
  const [refusing, setRefusing] = useState(false)
  const [reason, setReason] = useState('')

  const decide = useMutation({
    mutationFn: (v: { approve: boolean; reason?: string }) =>
      api.post(`${ledgerBase}/petty-cash/${voucher.id}/decide`, v),
    onSuccess: () => {
      setRefusing(false)
      qc.invalidateQueries({ queryKey: ['ledgers'] })
    },
  })

  return (
    <>
      <tr>
        <Td className="font-medium tabular-nums">
          {voucher.voucher_no}
          {voucher.journal_voucher_no && (
            <div className="text-[12px] font-normal text-muted-foreground">
              {voucher.journal_voucher_no}
            </div>
          )}
        </Td>
        <Td className="text-muted-foreground">{voucher.voucher_date}</Td>
        <Td>{voucher.payee}</Td>
        <Td className="text-muted-foreground">
          {voucher.particulars}
          {voucher.rejected_reason && (
            <div className="text-[12px] text-destructive">{voucher.rejected_reason}</div>
          )}
        </Td>
        <Td className="text-[13px] text-muted-foreground">
          {voucher.expense_code} {voucher.expense_name}
        </Td>
        <Td className="text-right tabular-nums">
          {rupees(voucher.amount_paise)}
          {voucher.needs_approval && voucher.status === 'pending' && (
            <div className="text-[12px] text-warning">above the limit</div>
          )}
        </Td>
        <Td>
          <Badge tone={voucher.status === 'approved' ? 'success'
            : voucher.status === 'rejected' ? 'danger' : 'warning'}>
            {voucher.status}
          </Badge>
          {voucher.approved_by && (
            <div className="text-[12px] text-muted-foreground">{voucher.approved_by}</div>
          )}
        </Td>
        <Td>
          {voucher.status === 'pending' && (
            <div className="flex gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => setRefusing(!refusing)}>
                Refuse
              </Button>
              {/* Approving pays cash out of the box, and refusing already asks
                  for a reason — so approving was the one irreversible half of
                  this pair that took a single click. */}
              <ConfirmButton
                size="sm"
                disabled={decide.isPending}
                confirmLabel="Approve"
                question="Approve this voucher? It records the cash as paid out."
                onConfirm={() => decide.mutate({ approve: true })}
              >
                Approve
              </ConfirmButton>
            </div>
          )}
        </Td>
      </tr>
      {decide.error && <tr><Td colSpan={8}><FormNotice error={decide.error} /></Td></tr>}
      {refusing && (
        <tr>
          <Td colSpan={8}>
            <div className="flex flex-wrap items-end gap-3 py-2">
              <div className="min-w-[320px] flex-1">
                <Field label="Why is the claim refused?" required>
                  <Input value={reason} onChange={setReason}
                    placeholder="No receipt attached; resubmit with the bill" />
                </Field>
              </div>
              <Button disabled={!reason || decide.isPending} tone="danger"
                onClick={() => decide.mutate({ approve: false, reason })}>
                Refuse the claim
              </Button>
            </div>
          </Td>
        </tr>
      )}
    </>
  )
}

/* The float: money into the tin, the drawer counted against the book, and how
   much the tin is meant to hold. The three things an imprest system does that
   a voucher register alone cannot. Each is one short form, and each writes a
   row somebody can point at later — a top-up is a posted journal, a count is
   a dated figure with its variance frozen. */
function ManageFloat({ data }: { data: PettyResponse }) {
  const qc = useQueryClient()
  const done = () => qc.invalidateQueries({ queryKey: ['ledgers'] })

  const [amount, setAmount] = useState('')
  const [from, setFrom] = useState<'bank' | 'cash'>('bank')
  const [ref, setRef] = useState('')
  const [note, setNote] = useState('')
  const topUp = useMutation({
    mutationFn: () => api.post<{ balance_paise: number }>(`${ledgerBase}/petty-cash/topup`, {
      amount_paise: toPaise(amount), from, reference_no: ref || undefined, note: note || undefined,
    }),
    onSuccess: () => { setAmount(''); setRef(''); setNote(''); done() },
  })

  const [counted, setCounted] = useState('')
  const [why, setWhy] = useState('')
  const countedPaise = counted === '' ? null : toPaise(counted)
  const differs = countedPaise !== null && countedPaise !== data.balance_paise
  const count = useMutation({
    mutationFn: () => api.post<{ variance_paise: number }>(`${ledgerBase}/petty-cash/count`, {
      counted_paise: countedPaise, variance_reason: why || undefined,
    }),
    onSuccess: () => { setCounted(''); setWhy(''); done() },
  })

  const [floatAmt, setFloatAmt] = useState(data.float_paise ? rupees(data.float_paise).replace(/[^\d.]/g, '') : '')
  const setFloat = useMutation({
    mutationFn: () => api.put(`${ledgerBase}/petty-cash/float`, { float_paise: toPaise(floatAmt) }),
    onSuccess: done,
  })

  return (
    <>
      <Card>
        <CardHeader title="The float"
          description={data.custodian
            ? `Held by ${data.custodian}. Put money in, count the drawer, or change how much the tin should hold.`
            : 'Put money in, count the drawer, or set how much the tin should hold.'} />
        <div className="grid gap-6 p-5 lg:grid-cols-3">
          <div className="space-y-3">
            <div className="text-[13px] font-semibold">Top up the tin</div>
            <Field label="Amount (₹)" required
              hint={data.replenish_paise > 0 ? `${inr(data.replenish_paise)} brings it back to the float` : undefined}>
              <Input type="number" value={amount} onChange={setAmount} />
            </Field>
            <Field label="Taken from" required>
              <Select value={from} onChange={(v) => setFrom(v as 'bank' | 'cash')}
                options={[{ value: 'bank', label: 'Bank account' }, { value: 'cash', label: 'Main cash' }]} />
            </Field>
            <Field label={from === 'bank' ? 'Cheque / withdrawal reference' : 'Reference'} required={from === 'bank'}>
              <Input value={ref} onChange={setRef} />
            </Field>
            <Field label="Note"><Input value={note} onChange={setNote} /></Field>
            <FormNotice error={topUp.error} />
            <Button onClick={() => topUp.mutate()}
              disabled={toPaise(amount) <= 0 || (from === 'bank' && !ref) || topUp.isPending}>
              Put {toPaise(amount) > 0 ? inr(toPaise(amount)) : 'money'} in the tin
            </Button>
          </div>

          <div className="space-y-3">
            <div className="text-[13px] font-semibold">Count the drawer</div>
            <Field label="Cash actually in the drawer (₹)" required
              hint={`The book says ${inr(data.balance_paise)}`}>
              <Input type="number" value={counted} onChange={setCounted} />
            </Field>
            {differs && (
              <Field label={`Why is it ${inr(Math.abs(countedPaise! - data.balance_paise))} ${countedPaise! > data.balance_paise ? 'over' : 'short'}?`} required>
                <Input value={why} onChange={setWhy} placeholder="Slip for the auto fare not raised yet" />
              </Field>
            )}
            <FormNotice error={count.error} />
            <Button variant="secondary" onClick={() => count.mutate()}
              disabled={countedPaise === null || (differs && !why) || count.isPending}>
              Record the count
            </Button>
          </div>

          <div className="space-y-3">
            <div className="text-[13px] font-semibold">How much the tin should hold</div>
            <Field label="Float (₹)" hint="Replenish-to-float is this minus what the book says is in the tin.">
              <Input type="number" value={floatAmt} onChange={setFloatAmt} />
            </Field>
            <FormNotice error={setFloat.error} ok={setFloat.isSuccess ? 'Float saved.' : undefined} />
            <Button variant="secondary" onClick={() => setFloat.mutate()}
              disabled={floatAmt === '' || setFloat.isPending}>
              Save the float
            </Button>
          </div>
        </div>
      </Card>

      {(data.topups.length > 0 || data.counts.length > 0) && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Money put in" description="Each one is a posted journal voucher." />
            <Table head={['Date', 'From', { label: 'Amount', align: 'right' }, 'Reference', 'By']}
              empty={data.topups.length === 0} emptyLabel="No top-ups yet.">
              {data.topups.map((t) => (
                <tr key={t.id}>
                  <Td className="text-muted-foreground">{t.topup_date}</Td>
                  <Td className="text-[13px]">{t.from}
                    {t.journal_voucher_no && <div className="text-[12px] text-muted-foreground">{t.journal_voucher_no}</div>}
                  </Td>
                  <Td className="text-right tabular-nums">{rupees(t.amount_paise)}</Td>
                  <Td className="text-muted-foreground">{t.reference_no || t.note || '-'}</Td>
                  <Td className="text-muted-foreground">{t.by || '-'}</Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card>
            <CardHeader title="Drawer counts" description="What was in the drawer against what the book said, on the day." />
            <Table head={['Date', { label: 'Book', align: 'right' }, { label: 'Counted', align: 'right' }, 'Variance', 'By']}
              empty={data.counts.length === 0} emptyLabel="The drawer has not been counted yet.">
              {data.counts.map((c) => (
                <tr key={c.id}>
                  <Td className="text-muted-foreground">{c.counted_on}</Td>
                  <Td className="text-right tabular-nums">{rupees(c.book_paise)}</Td>
                  <Td className="text-right tabular-nums">{rupees(c.counted_paise)}</Td>
                  <Td>
                    <Badge tone={c.variance_paise === 0 ? 'success' : 'danger'}>
                      {c.variance_paise === 0 ? 'agrees' : `${c.variance_paise > 0 ? '+' : '−'}${rupees(Math.abs(c.variance_paise))}`}
                    </Badge>
                    {c.variance_reason && <div className="text-[12px] text-muted-foreground">{c.variance_reason}</div>}
                  </Td>
                  <Td className="text-muted-foreground">{c.by || '-'}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      )}
    </>
  )
}

function RaiseVoucher({ limit }: { limit: number }) {
  const qc = useQueryClient()
  const accounts = useAccounts()
  const [payee, setPayee] = useState('')
  const [particulars, setParticulars] = useState('')
  const [amount, setAmount] = useState('')
  const [head, setHead] = useState('')
  const [date, setDate] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post(`${ledgerBase}/petty-cash`, {
        payee, particulars, amount_paise: toPaise(amount),
        expense_account_id: head, voucher_date: date || undefined,
      }),
    onSuccess: () => {
      setPayee(''); setParticulars(''); setAmount('')
      qc.invalidateQueries({ queryKey: ['ledgers'] })
    },
  })

  const over = toPaise(amount) > limit && limit > 0

  return (
    <Card>
      <CardHeader title="Raise a slip"
        description="Nothing leaves the tin until somebody decides. The slip records what was spent and on whose word." />
      <div className="space-y-5 p-5">
        <FormGrid>
          <Field label="Paid to" required><Input value={payee} onChange={setPayee} placeholder="Ramesh (peon)" /></Field>
          <Field label="Amount (₹)" required
            hint={over ? `Above the ${rupees(limit)} limit, this will need a second signature` : undefined}>
            <Input type="number" value={amount} onChange={setAmount} />
          </Field>
          <Field label="Expense head" required>
            <Select value={head} onChange={setHead} placeholder="Choose a head"
              options={accountOptions(accounts.data?.items, 'expense')} />
          </Field>
          <Field label="Date"><Input type="date" value={date} onChange={setDate} /></Field>
          <Field label="What it was for" required wide>
            <Textarea value={particulars} onChange={setParticulars} rows={2}
              placeholder="Auto fare to the DEO office with the affiliation file" />
          </Field>
        </FormGrid>
        <FormNotice error={save.error} ok={save.isSuccess ? 'Slip raised.' : undefined} />
        <Button onClick={() => save.mutate()}
          disabled={!payee || !particulars || !amount || !head || save.isPending}>
          Raise the slip
        </Button>
      </div>
    </Card>
  )
}
