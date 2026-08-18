import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { TrendingDown, Wallet, Layers } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import {
  inr, rupees, toPaise, fyOptions, currentFY, useAccounts, useLedgerSettings,
  accountOptions, ledgerBase, type ExpenseHead,
} from './ledger-lib'

/* What the school spent, by head.

   Every figure here comes from the ledger rather than from a separate expense
   table, which is why it can be relied on to agree with the income and
   expenditure account. The three source columns exist because "we spent four
   lakh on stationery" is a different conversation from "four lakh of it came
   through approved bills and forty-five thousand out of the tin".

   The form posts a full double-entry voucher. An expense recorded outside the
   ledger is an expense that never reaches a statement. */

export default function Expenses() {
  const [fy, setFy] = useState(String(currentFY()))
  const q = useQuery({
    queryKey: ['ledgers', 'expenses', fy],
    queryFn: () => api.get<List<ExpenseHead>>(`${ledgerBase}/expenses?fy=${fy}`),
  })

  if (q.isLoading) return <Loading label="Adding up the spending…" />
  if (q.error) return <ErrorState error={q.error} />

  const rows = q.data?.items ?? []
  const total = rows.reduce((s, r) => s + r.paise, 0)
  const fromBills = rows.reduce((s, r) => s + r.from_bills_paise, 0)
  const fromTin = rows.reduce((s, r) => s + r.from_petty_cash_paise, 0)
  const biggest = rows[0]

  return (
    <>
      <PageHead
        eyebrow="Accounts"
        title="Expenses"
        description="Every head the school spent against this year, and where each charge came from. Drawn from the ledger, so it agrees with the income and expenditure account by construction."
        width="wide"
        actions={<div className="w-44"><Select value={fy} onChange={setFy} options={fyOptions()} /></div>}
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Spent" value={inr(total)} icon={TrendingDown} period={`financial year ${fy}`} />
          <Stat label="Through vendor bills" value={inr(fromBills)} icon={Layers}
            hint="Accrued when the bill was approved" />
          <Stat label="Out of the tin" value={inr(fromTin)} icon={Wallet}
            hint="Petty cash slips approved and posted" />
          <Stat label="Largest head" value={biggest ? biggest.name : '—'}
            hint={biggest ? inr(biggest.paise) : undefined} />
        </CellGrid>

        <RecordExpense />

        <Card>
          <CardHeader title="By head"
            description="Ordered by what was actually spent. Closing vouchers are excluded, so a closed year still shows what it cost to run rather than the nil balance the close left behind." />
          {rows.length === 0 ? (
            <EmptyState title="Nothing spent yet this year"
              body="Approve a vendor bill, pass a petty cash slip, or record a direct payment below." />
          ) : (
            <Table head={['Code', 'Head', 'Group', 'Vouchers',
              { label: 'Bills', align: 'right' }, { label: 'Petty cash', align: 'right' },
              { label: 'Other', align: 'right' }, { label: 'Total', align: 'right' },
              { label: 'Share', align: 'right' }]}
              empty={false}>
              {rows.map((r) => (
                <tr key={r.account_id}>
                  <Td className="tabular-nums text-muted-foreground">{r.code}</Td>
                  <Td className="font-medium">{r.name}</Td>
                  <Td className="text-muted-foreground">{r.group}</Td>
                  <Td className="tabular-nums text-muted-foreground">{r.vouchers}</Td>
                  <Td className="text-right tabular-nums text-muted-foreground">
                    {r.from_bills_paise ? rupees(r.from_bills_paise) : '—'}
                  </Td>
                  <Td className="text-right tabular-nums text-muted-foreground">
                    {r.from_petty_cash_paise ? rupees(r.from_petty_cash_paise) : '—'}
                  </Td>
                  <Td className="text-right tabular-nums text-muted-foreground">
                    {r.from_other_paise ? rupees(r.from_other_paise) : '—'}
                  </Td>
                  <Td className="text-right font-medium tabular-nums">{rupees(r.paise)}</Td>
                  <Td className="text-right tabular-nums text-muted-foreground">
                    {total ? `${Math.round((r.paise * 100) / total)}%` : '—'}
                  </Td>
                </tr>
              ))}
              <tr className="font-medium">
                <Td colSpan={7} className="text-right text-muted-foreground">Total</Td>
                <Td className="text-right tabular-nums">{rupees(total)}</Td>
                <Td />
              </tr>
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}

function RecordExpense() {
  const qc = useQueryClient()
  const accounts = useAccounts()
  const settings = useLedgerSettings()
  const [head, setHead] = useState('')
  const [from, setFrom] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState('')
  const [narration, setNarration] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post<{ voucher_no: string }>(`${ledgerBase}/expenses`, {
        expense_account_id: head,
        paid_from_account_id: from || undefined,
        amount_paise: toPaise(amount),
        spent_on: date || undefined,
        narration,
      }),
    onSuccess: () => {
      setAmount(''); setNarration('')
      qc.invalidateQueries({ queryKey: ['ledgers'] })
    },
  })

  const cashAccounts = (accounts.data?.items ?? [])
    .filter((a) => a.is_cash && !a.is_group)
    .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))

  return (
    <Card>
      <CardHeader title="Record a direct payment"
        description="The plumber paid at the gate, the courier charge, the sweets for a prize day — money that never became a bill. It posts a full voucher: the expense head is debited and the cash or bank account credited." />
      <div className="space-y-5 p-5">
        <FormGrid>
          <Field label="Expense head" required>
            <Select value={head} onChange={setHead} placeholder="Choose a head"
              options={accountOptions(accounts.data?.items, 'expense')} />
          </Field>
          <Field label="Paid from"
            hint={settings.data?.cash_account_id ? 'Defaults to cash in hand' : undefined}>
            <Select value={from} onChange={setFrom} placeholder="Cash in hand" options={cashAccounts} />
          </Field>
          <Field label="Amount (₹)" required><Input type="number" value={amount} onChange={setAmount} /></Field>
          <Field label="Date"><Input type="date" value={date} onChange={setDate} /></Field>
          <Field label="What it was for" required wide>
            <Textarea value={narration} onChange={setNarration} rows={2}
              placeholder="Emergency plumbing repair, girls' washroom, block C" />
          </Field>
        </FormGrid>
        <FormNotice error={save.error}
          ok={save.isSuccess ? `Posted as ${save.data?.voucher_no}.` : undefined} />
        <Button onClick={() => save.mutate()}
          disabled={!head || !amount || !narration || save.isPending}>
          Record the payment
        </Button>
      </div>
    </Card>
  )
}
