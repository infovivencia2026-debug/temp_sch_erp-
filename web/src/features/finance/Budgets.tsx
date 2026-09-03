import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Target, TrendingUp, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Field, FormGrid, FormNotice, Input, Select,
  SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import {
  inr, rupees, toPaise, fyOptions, currentFY, useAccounts, accountOptions,
  ledgerBase, type BudgetView,
} from './ledger-lib'

/* What was allowed against what was spent.

   The actuals come from the ledger, not from a parallel tally kept beside it.
   A budget report that disagrees with the income and expenditure account is a
   budget report nobody trusts twice, and the only way to guarantee they agree
   is to compute both from the same vouchers.

   A revision is kept beside the original rather than overwriting it. "We
   approved eight lakh and spent eleven" is a different sentence from "we
   revised to eleven and spent eleven", and a board asks which one happened. */

const STATE_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  'within budget': 'success',
  'at the limit': 'warning',
  overspent: 'danger',
  unbudgeted: 'neutral',
}

export default function Budgets() {
  const [fy, setFy] = useState(String(currentFY()))
  const q = useQuery({
    queryKey: ['ledgers', 'budgets', fy],
    queryFn: () => api.get<BudgetView>(`${ledgerBase}/budgets?fy=${fy}`),
  })

  if (q.isLoading) return <SkeletonTable columns={9} label="Reading the budget…" />
  if (q.error) return <ErrorState error={q.error} />

  const b = q.data
  const lines = b?.items ?? []
  const over = lines.filter((l) => l.state === 'overspent')
  const near = lines.filter((l) => l.state === 'at the limit')
  const used = b && b.allocated_paise
    ? Math.round((b.actual_paise * 100) / b.allocated_paise)
    : 0

  return (
    <>
      <PageHead
        eyebrow="Accounts"
        title="Budget and variance"
        description="What each head was allowed and what it has actually cost, taken from the ledger so the two can never drift apart."
        width="wide"
        actions={<div className="w-44"><Select value={fy} onChange={setFy} options={fyOptions()} /></div>}
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Allocated" value={inr(b?.allocated_paise ?? 0)} icon={Target}
            period={b?.fy_label} />
          <Stat label="Spent" value={inr(b?.actual_paise ?? 0)} icon={TrendingUp}
            hint={`${used}% of the budget in force`} />
          <Stat label="Left" value={inr(b?.variance_paise ?? 0)}
            delta={(b?.variance_paise ?? 0) < 0
              ? { value: 'Over the budget overall', positive: false }
              : { value: 'Within the budget overall', positive: true }} />
          <Stat label="Heads overspent" value={over.length} icon={AlertTriangle}
            delta={near.length ? { value: `${near.length} more at the limit`, positive: false } : undefined} />
        </CellGrid>

        <SetLine fy={fy} />

        <Card>
          <CardHeader
            title={b?.budget_id ? `${b.name} — ${b.fy_label}` : `Budget — ${fy}`}
            description="The budget in force is the revision where there is one and the original otherwise. Both are shown, because a board reading a variance needs to know which figure it was measured against."
            action={b?.status ? <Badge tone={b.status === 'approved' ? 'success' : 'neutral'}>{b.status}</Badge> : undefined}
          />
          {lines.length === 0 ? (
            <EmptyState title="No budget lines for this year"
              body="Set an allocation against an expense head above and it appears here with its actual spend." />
          ) : (
            <Table head={['Code', 'Head', 'Department',
              { label: 'Allocated', align: 'right' }, { label: 'Revised', align: 'right' },
              { label: 'Actual', align: 'right' }, { label: 'Variance', align: 'right' },
              'Used', 'State']}
              empty={false}>
              {lines.map((l) => (
                <tr key={l.id}>
                  <Td className="tabular-nums text-muted-foreground">{l.code}</Td>
                  <Td className="font-medium">{l.name}</Td>
                  <Td className="text-muted-foreground">{l.department ?? 'school-wide'}</Td>
                  <Td className="text-right tabular-nums">{rupees(l.allocated_paise)}</Td>
                  <Td className="text-right tabular-nums text-muted-foreground">
                    {l.revised_paise != null ? rupees(l.revised_paise) : '—'}
                  </Td>
                  <Td className="text-right tabular-nums">{rupees(l.actual_paise)}</Td>
                  <Td className={`text-right font-medium tabular-nums ${l.variance_paise < 0 ? 'text-destructive' : ''}`}>
                    {rupees(l.variance_paise)}
                  </Td>
                  <Td className="tabular-nums">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                        <div
                          className={l.used_percent > 100 ? 'h-full bg-destructive' : 'h-full bg-primary'}
                          style={{ width: `${Math.min(100, l.used_percent)}%` }}
                        />
                      </div>
                      <span className="text-[13px] text-muted-foreground">{l.used_percent}%</span>
                    </div>
                  </Td>
                  <Td><Badge tone={STATE_TONE[l.state] ?? 'neutral'}>{l.state}</Badge></Td>
                </tr>
              ))}
              <tr className="font-medium">
                <Td colSpan={3} className="text-right text-muted-foreground">Total</Td>
                <Td className="text-right tabular-nums">{rupees(b?.allocated_paise ?? 0)}</Td>
                <Td />
                <Td className="text-right tabular-nums">{rupees(b?.actual_paise ?? 0)}</Td>
                <Td className="text-right tabular-nums">{rupees(b?.variance_paise ?? 0)}</Td>
                <Td colSpan={2} />
              </tr>
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}

function SetLine({ fy }: { fy: string }) {
  const qc = useQueryClient()
  const accounts = useAccounts()
  const [account, setAccount] = useState('')
  const [allocated, setAllocated] = useState('')
  const [revised, setRevised] = useState('')
  const [notes, setNotes] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post(`${ledgerBase}/budgets/lines`, {
        fy_start_year: Number(fy),
        account_id: account,
        allocated_paise: toPaise(allocated),
        revised_paise: revised ? toPaise(revised) : undefined,
        notes: notes || undefined,
      }),
    onSuccess: () => {
      setAllocated(''); setRevised(''); setNotes('')
      qc.invalidateQueries({ queryKey: ['ledgers'] })
    },
  })

  return (
    <Card>
      <CardHeader title="Set an allocation"
        description="Saving the same head twice amends the line rather than adding a second one, so a budget cannot quietly hold two figures for the same account." />
      <div className="space-y-5 p-5">
        <FormGrid>
          <Field label="Head" required>
            <Select value={account} onChange={setAccount} placeholder="Choose a head"
              options={accountOptions(accounts.data?.items, 'expense', 'income')} />
          </Field>
          <Field label="Allocated (₹)" required>
            <Input type="number" value={allocated} onChange={setAllocated} />
          </Field>
          <Field label="Revised (₹)" hint="A mid-year revision, kept beside the original rather than replacing it">
            <Input type="number" value={revised} onChange={setRevised} />
          </Field>
          <Field label="Note"><Input value={notes} onChange={setNotes} /></Field>
        </FormGrid>
        <FormNotice error={save.error} ok={save.isSuccess ? 'Allocation saved.' : undefined} />
        <Button onClick={() => save.mutate()} disabled={!account || !allocated || save.isPending}>
          Save the allocation
        </Button>
      </div>
    </Card>
  )
}
