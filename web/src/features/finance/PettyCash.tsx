import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Coins, ShieldCheck, ReceiptText } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState,
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

interface PettyResponse {
  items: PettyVoucher[]
  limit_paise: number
  balance_paise: number
}

export default function PettyCash() {
  const q = useQuery({
    queryKey: ['ledgers', 'petty-cash'],
    queryFn: () => api.get<PettyResponse>(`${ledgerBase}/petty-cash`),
  })

  if (q.isLoading) return <Loading label="Opening the tin…" />
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
          <Stat label="Paid out" value={inr(spent)} period="all vouchers approved" />
          <Stat label="Limit" value={inr(q.data?.limit_paise ?? 0)} icon={ShieldCheck}
            hint="Above this a slip needs a second signature" />
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
              <Button size="sm" disabled={decide.isPending}
                onClick={() => decide.mutate({ approve: true })}>
                Approve
              </Button>
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
            hint={over ? `Above the ${rupees(limit)} limit — this will need a second signature` : undefined}>
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
