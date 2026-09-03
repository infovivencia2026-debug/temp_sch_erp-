import { useQuery } from '@tanstack/react-query'
import { IndianRupee } from 'lucide-react'
import { api } from '@/lib/api'
import { formatPaise } from '@/lib/utils'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Reload,
  SkeletonTiles, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'

/* The next three months of fees, as arithmetic.

   What falls due in each month, times the share of the last twelve months'
   demand the school has actually collected. The rate is on every row so the
   multiplication can be checked; the backlog — already overdue — sits beside
   the outlook and is not folded into it, because money that did not come when
   it was due is not predictable by the month it was due in. */

interface Month { month: string; due_paise: number; expected_paise: number }

interface School {
  institution_id: string
  school: string
  rate_pct: number | null
  basis_paise: number
  backlog_paise: number
  months: Month[]
  due_paise: number
  expected_paise: number
}

interface Resp {
  as_of: string
  months: string[]
  schools: School[]
  total: School
  method: string
}

const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleString('en-IN', { month: 'short', year: '2-digit' })
}

export default function CashOutlook() {
  const q = useQuery({
    queryKey: ['cash-outlook'],
    queryFn: () => api.get<Resp>('/api/v1/admin/signals/cash-flow'),
  })
  const d = q.data
  const rows = d?.schools ?? []
  const months = d?.months ?? []

  return (
    <>
      <PageHead
        eyebrow="Signals"
        title="Cash outlook"
        actions={<Reload onClick={() => q.refetch()} busy={q.isFetching} />}
      />
      <PageBody>
        {q.isLoading ? (
          <SkeletonTiles count={4} />
        ) : d ? (
          <CellGrid cols={4}>
            <Stat label="Falling due" value={formatPaise(d.total.due_paise)} icon={IndianRupee} period="Next three months" />
            <Stat label="Expected" value={formatPaise(d.total.expected_paise)} hint={d.total.rate_pct != null ? `At ${d.total.rate_pct}% recovery` : 'No history yet'} period="Next three months" />
            <Stat label="Already overdue" value={formatPaise(d.total.backlog_paise)} hint="Not in the outlook" />
            <Stat label="Twelve-month demand" value={formatPaise(d.total.basis_paise)} hint="The basis for the rate" />
          </CellGrid>
        ) : null}

        <Card>
          <CardHeader title="By school" />
          {d && <p className="border-b px-5 py-3 text-[13px] text-muted-foreground">{d.method}</p>}
          {q.isLoading ? (
            <SkeletonTable columns={6} />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : rows.length === 0 ? (
            <EmptyState title="No active schools" />
          ) : (
            <Table
              head={[
                'School',
                { label: 'Rate', align: 'right' },
                ...months.map((m) => ({ label: monthLabel(m), align: 'right' as const })),
                { label: 'Expected', align: 'right' },
                { label: 'Overdue', align: 'right' },
              ]}
            >
              {rows.map((r) => (
                <tr key={r.institution_id}>
                  <Td className="font-medium">{r.school}</Td>
                  <Td className="text-right tabular-nums">{r.rate_pct != null ? `${r.rate_pct}%` : '—'}</Td>
                  {r.months.map((m) => (
                    <Td key={m.month} className="text-right tabular-nums">
                      {formatPaise(m.expected_paise)}
                      <span className="block text-[12px] text-muted-foreground">of {formatPaise(m.due_paise)}</span>
                    </Td>
                  ))}
                  <Td className="text-right tabular-nums font-medium">{formatPaise(r.expected_paise)}</Td>
                  <Td className="text-right tabular-nums">{formatPaise(r.backlog_paise)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
