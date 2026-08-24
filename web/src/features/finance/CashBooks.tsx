import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, Wallet, ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Field, FormGrid, Input, PrintButton, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { inr, rupees, side, ledgerBase, type Voucher, type CashbookAccount } from './ledger-lib'

/* The daybook and the cashbook.

   The daybook answers one question — what happened on the ninth — and it has
   to answer it completely, so it lists every voucher type rather than only the
   receipts a fee module would show.

   The cashbook is kept per account rather than as one running total. The
   closing cash register a school signs at the end of the day is per drawer;
   merging the tin, the counter and two bank accounts into a single figure
   produces a number that matches nothing anybody can count. */

interface Daybook {
  on: string
  items: Voucher[]
  vouchers: number
  total_paise: number
}

interface Cashbook {
  from: string
  to: string
  accounts: CashbookAccount[]
  totals: {
    opening_paise: number
    in_paise: number
    out_paise: number
    closing_paise: number
  }
}

const today = () => new Date().toISOString().slice(0, 10)
const monthStart = () => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10)
}

export default function CashBooks() {
  const [on, setOn] = useState(today())
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())

  const daybook = useQuery({
    queryKey: ['ledgers', 'daybook', on],
    queryFn: () => api.get<Daybook>(`${ledgerBase}/daybook?on=${on}`),
  })
  const cashbook = useQuery({
    queryKey: ['ledgers', 'cashbook', from, to],
    queryFn: () => api.get<Cashbook>(`${ledgerBase}/cashbook?from=${from}&to=${to}`),
  })

  if (cashbook.isLoading) return <Loading label="Adding up the drawers…" />
  if (cashbook.error) return <ErrorState error={cashbook.error} />

  const c = cashbook.data
  const d = daybook.data

  return (
    <>
      <PageHead
        eyebrow="Accounts"
        title="Daybook and cashbook"
        description="Every voucher for a day, and the movement through each cash and bank account with its closing balance."
        width="wide"
        actions={<PrintButton label="Print" />}
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Opening" value={inr(c?.totals.opening_paise ?? 0)} icon={Wallet}
            period={`as at ${from}`} />
          <Stat label="Received" value={inr(c?.totals.in_paise ?? 0)} icon={ArrowDownLeft} />
          <Stat label="Paid out" value={inr(c?.totals.out_paise ?? 0)} icon={ArrowUpRight} />
          <Stat label="Closing" value={inr(c?.totals.closing_paise ?? 0)}
            period={`as at ${to}`}
            hint="What the ledger says every drawer and account holds between them" />
        </CellGrid>

        <Card>
          <CardHeader title="Period" />
          <div className="p-5">
            <FormGrid>
              <Field label="From"><Input type="date" value={from} onChange={setFrom} /></Field>
              <Field label="To"><Input type="date" value={to} onChange={setTo} /></Field>
            </FormGrid>
          </div>
        </Card>

        {(c?.accounts ?? []).map((a) => (
          <Card key={a.account_id}>
            <CardHeader
              title={`${a.code} — ${a.name}`}
              description={`Opening ${rupees(a.opening_paise)}, received ${rupees(a.in_paise)}, paid ${rupees(a.out_paise)}.`}
              action={
                <Badge tone={a.closing_paise < 0 ? 'danger' : 'success'}>
                  closing {rupees(a.closing_paise)}
                </Badge>
              }
            />
            {a.entries.length === 0 ? (
              <EmptyState title="No movement in this period"
                body={`The balance stands at ${rupees(a.closing_paise)}.`} />
            ) : (
              <Table head={['Date', 'Voucher', 'Particulars', 'Contra',
                { label: 'In', align: 'right' }, { label: 'Out', align: 'right' },
                { label: 'Balance', align: 'right' }]}
                empty={false}>
                {a.entries.map((e, i) => (
                  <tr key={i}>
                    <Td className="text-muted-foreground">{e.date}</Td>
                    <Td className="tabular-nums">{e.voucher_no}</Td>
                    <Td>{e.narration}</Td>
                    <Td className="text-[13px] text-muted-foreground">{e.contra}</Td>
                    <Td className="text-right tabular-nums">{side(e.in_paise)}</Td>
                    <Td className="text-right tabular-nums">{side(e.out_paise)}</Td>
                    <Td className="text-right font-medium tabular-nums">{rupees(e.balance_paise)}</Td>
                  </tr>
                ))}
                <tr className="font-medium">
                  <Td colSpan={4} className="text-right text-muted-foreground">Closing</Td>
                  <Td className="text-right tabular-nums">{rupees(a.in_paise)}</Td>
                  <Td className="text-right tabular-nums">{rupees(a.out_paise)}</Td>
                  <Td className="text-right tabular-nums">{rupees(a.closing_paise)}</Td>
                </tr>
              </Table>
            )}
          </Card>
        ))}

        <Card>
          <CardHeader
            title="Daybook"
            description="Everything written on one day, in the order it was entered. The first thing an inspector asks for."
            action={<div className="w-44"><Input type="date" value={on} onChange={setOn} /></div>}
          />
          {daybook.isLoading ? (
            <Loading />
          ) : daybook.error ? (
            /* A failed query is not an empty day.
          
               Without this branch the fetch fell through to the empty state and
               the screen told an inspector "Nothing was written on <date>" — a
               statement about the books, made because a request failed. */
            <ErrorState error={daybook.error} />
          ) : (d?.items ?? []).length === 0 ? (
            <EmptyState title={`Nothing was written on ${on}`}
              body="Choose another date, or post a voucher." />
          ) : (
            <Table head={['Voucher', 'Kind', 'Narration', 'Accounts',
              { label: 'Value', align: 'right' }, 'Posted by']}
              empty={false}>
              {(d?.items ?? []).map((v) => (
                <tr key={v.id}>
                  <Td className="font-medium tabular-nums">{v.voucher_no}</Td>
                  <Td><Badge tone="neutral">{v.voucher_type}</Badge></Td>
                  <Td>{v.narration}</Td>
                  <Td className="text-[13px] text-muted-foreground">{v.accounts}</Td>
                  <Td className="text-right tabular-nums">{rupees(v.amount_paise)}</Td>
                  <Td className="text-muted-foreground">{v.posted_by ?? '—'}</Td>
                </tr>
              ))}
              <tr className="font-medium">
                <Td colSpan={4} className="text-right text-muted-foreground">
                  {d?.vouchers} voucher{d?.vouchers === 1 ? '' : 's'}
                </Td>
                <Td className="text-right tabular-nums">{rupees(d?.total_paise ?? 0)}</Td>
                <Td />
              </tr>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Why the drawers are listed separately" />
          <div className="p-5 text-[14px] leading-relaxed text-muted-foreground">
            <BookOpen className="mb-2 h-4 w-4" aria-hidden />
            The closing balance a school signs at the end of the day belongs to a
            particular drawer. A single merged total cannot be counted against
            anything, so each cash and bank account carries its own opening,
            movement and closing figure — and the sum of them is shown above
            only as a summary.
          </div>
        </Card>
      </PageBody>
    </>
  )
}
