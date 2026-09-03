import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Lock, LockOpen, ScrollText, TrendingUp } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  ConfirmButton, FormNotice, SkeletonTable, ErrorState,
} from '@/components/ui'
import { inr, rupees, ledgerBase, type AccountingYear } from './ledger-lib'

/* Signing the books.

   Closing a year writes every income and expenditure account back to nil with
   a dated voucher, puts the difference into the corpus, and then seals the
   year: the database refuses any entry dated inside it from that moment, and
   refuses to reopen it. There is no undo, so the result the close will compute
   is shown before the button is pressed rather than after.

   A correction to a signed year goes where it goes in real accounting — a
   dated entry in the current year, visible as the correction it is. */

export default function YearClosing() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['ledgers', 'years'],
    queryFn: () => api.get<List<AccountingYear>>(`${ledgerBase}/years`),
  })
  const close = useMutation({
    mutationFn: (fy: number) =>
      api.post(`${ledgerBase}/years/close`, { fy_start_year: fy, confirm: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ledgers'] }),
  })

  if (q.isLoading) return <SkeletonTable columns={9} label="Reading the years…" />
  if (q.error) return <ErrorState error={q.error} />

  const years = q.data?.items ?? []
  const open = years.filter((y) => y.status === 'open')
  const closed = years.filter((y) => y.status === 'closed')
  const ready = open.filter((y) => y.can_close)
  const current = open[0]

  return (
    <>
      <PageHead
        eyebrow="Accounts"
        title="Financial year closing"
        description="What each year earned, what a close would put into the corpus, and which years are already signed. Closing cannot be undone."
        width="wide"
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Years open" value={open.length} icon={LockOpen} />
          <Stat label="Years closed" value={closed.length} icon={Lock}
            hint="Sealed: no entry dated inside them will be accepted" />
          <Stat label="Ready to close" value={ready.length} icon={ScrollText}
            delta={ready.length
              ? { value: 'A year can be signed now', positive: true }
              : undefined} />
          <Stat label="Current year result"
            value={current ? inr(current.live_surplus_paise) : '—'} icon={TrendingUp}
            delta={current
              ? current.live_surplus_paise >= 0
                ? { value: 'Surplus so far', positive: true }
                : { value: 'Deficit so far', positive: false }
              : undefined}
            period={current?.fy_label} />
        </CellGrid>

        <FormNotice error={close.error}
          ok={close.isSuccess ? 'The year is closed. Its entries can no longer be changed.' : undefined} />

        <Card>
          <CardHeader
            title="The years"
            description="The surplus shown for an open year is what a close would compute if it ran now — income less expenditure, with any closing voucher left out. For a closed year it is the figure frozen at the moment of signing, not a number that moves when somebody corrects a later year."
          />
          <Table head={['Year', 'Status', 'Vouchers',
            { label: 'Income', align: 'right' }, { label: 'Expenditure', align: 'right' },
            { label: 'Surplus', align: 'right' }, 'Closed', 'Voucher', '']}
            empty={years.length === 0} emptyLabel="No accounting years on record.">
            {years.map((y) => {
              const surplus = y.status === 'closed' ? (y.surplus_paise ?? 0) : y.live_surplus_paise
              return (
                <tr key={y.fy_start_year}>
                  <Td className="font-medium tabular-nums">{y.fy_label}</Td>
                  <Td>
                    <Badge tone={y.status === 'closed' ? 'info' : 'success'}>{y.status}</Badge>
                  </Td>
                  <Td className="tabular-nums text-muted-foreground">{y.vouchers || '—'}</Td>
                  <Td className="text-right tabular-nums text-muted-foreground">
                    {y.status === 'closed' ? '—' : rupees(y.live_income_paise)}
                  </Td>
                  <Td className="text-right tabular-nums text-muted-foreground">
                    {y.status === 'closed' ? '—' : rupees(y.live_expense_paise)}
                  </Td>
                  <Td className={`text-right font-medium tabular-nums ${surplus < 0 ? 'text-destructive' : ''}`}>
                    {rupees(Math.abs(surplus))}
                    <div className="text-[12px] font-normal text-muted-foreground">
                      {surplus < 0 ? 'deficit' : 'surplus'}
                    </div>
                  </Td>
                  <Td className="text-muted-foreground">
                    {y.closed_on ?? '—'}
                    {y.closed_by && <div className="text-[12px]">{y.closed_by}</div>}
                  </Td>
                  <Td className="tabular-nums text-muted-foreground">
                    {y.closing_voucher_no ?? '—'}
                  </Td>
                  <Td>
                    {y.status === 'open' && (
                      y.can_close ? (
                        <ConfirmButton
                          confirmLabel="Close the year"
                          variant="primary"
                          question={`Close ${y.fy_label} and put ${rupees(Math.abs(surplus))} into the corpus? This cannot be undone — no entry dated in ${y.fy_label} will be accepted afterwards.`}
                          disabled={close.isPending}
                          onConfirm={() => close.mutate(y.fy_start_year)}>
                          Close {y.fy_label}
                        </ConfirmButton>
                      ) : (
                        <span className="text-[13px] text-muted-foreground">{y.blocker}</span>
                      )
                    )}
                  </Td>
                </tr>
              )
            })}
          </Table>
        </Card>

        <Card>
          <CardHeader title="What closing does"
            description="Stated plainly, because it is irreversible and the person pressing the button should not have to take it on trust." />
          <div className="space-y-3 p-5 text-[14px] leading-relaxed text-secondary-foreground">
            <p>
              <span className="font-medium">One.</span> Every income and expenditure account
              carrying a balance for the year is written back to nil by a closing voucher dated
              the thirty-first of March.
            </p>
            <p>
              <span className="font-medium">Two.</span> The difference — the surplus or the
              deficit — is posted to the corpus, where it stays.
            </p>
            <p>
              <span className="font-medium">Three.</span> The year is marked closed. From that
              moment the database refuses any entry dated inside it, refuses to amend one, and
              refuses to reopen the year. There is no override in the application because there
              is none in the schema either.
            </p>
            <p className="text-muted-foreground">
              Years must be closed in order. Closing a later year first would strand the earlier
              year's result outside the corpus, so the screen will not offer it.
            </p>
          </div>
        </Card>
      </PageBody>
    </>
  )
}
