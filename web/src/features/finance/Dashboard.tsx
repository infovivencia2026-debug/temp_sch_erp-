import { useQuery } from '@tanstack/react-query'
import { Wallet, AlertTriangle, Receipt, RefreshCcw } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, SkeletonTable, SkeletonTiles, ErrorState,
  RangePicker, rangeQuery, useRange, type RangeOption, type ActiveRange,
} from '@/components/ui'
import { formatPaise, formatDate } from '@/lib/utils'

interface FinanceKPIs {
  today_paise: number; month_paise: number; outstanding_paise: number
  overdue_paise: number; defaulters: number; invoices: number
  unreconciled: number; refunds_pending: number
  range: { period: string; from: string; to: string; label: string }
  as_of_now: string[]
}
interface InvoiceRow {
  id: string; invoice_no: string; student_name: string; admission_no: string
  issued_on: string; due_on?: string
  net_paise: number; paid_paise: number; due_paise: number; status: string
}

const TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  paid: 'success', partial: 'warning', overdue: 'danger',
  unpaid: 'neutral', cancelled: 'neutral',
}

export default function FinanceDashboard() {
  const [range, setRange] = useRange()
  const presets = useQuery({
    queryKey: ['date-ranges'],
    queryFn: () => api.get<{ items: RangeOption[] }>('/api/v1/date-ranges'),
  })
  const kpis = useQuery({
    queryKey: ['finance-dashboard', rangeQuery(range)],
    queryFn: () => api.get<FinanceKPIs>(`/api/v1/finance/dashboard?${rangeQuery(range)}`),
    enabled: range.period !== 'custom' || (!!range.from && !!range.to),
  })
  const overdue = useQuery({
    queryKey: ['finance-invoices-overdue'],
    queryFn: () => api.get<List<InvoiceRow>>('/api/v1/finance/invoices?overdue=true'),
  })

  if (kpis.isLoading) return <SkeletonTiles count={7} />
  if (kpis.error) return <ErrorState error={kpis.error} />
  const k = kpis.data!
  // Balances and open-item counts are true now, not for the chosen period.
  const asOf = 'as of today'

  return (
    <>
      <PageHead
        eyebrow="Dashboard"
        title="Finance overview"
        description="Collection, outstanding, defaulters and unreconciled gateway payments."
        actions={
          <RangePicker
            value={range}
            onChange={setRange as (r: ActiveRange) => void}
            options={presets.data?.items ?? []}
            label={k.range?.label}
          />
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          {/* The till figure stays today's whatever the range: a cashier
              balancing the drawer at 4pm needs that number, not the period's. */}
          <Stat label="Collected today" value={formatPaise(k.today_paise)} icon={Wallet}
            period="today, for the drawer" />
          <Stat label="Collected" value={formatPaise(k.month_paise)} icon={Receipt}
            period={k.range?.label} />
          <Stat
            label="Outstanding"
            value={formatPaise(k.outstanding_paise)}
            icon={AlertTriangle}
            delta={{ value: `${formatPaise(k.overdue_paise)} overdue`, positive: false }}
            period={asOf}
          />
          <Stat label="Defaulters" value={k.defaulters} hint="Past due date" period={asOf} />
        </CellGrid>

        <Card>
          <CardHeader title="Needs attention" />
          <CellGrid cols={3}>
            <Stat label="Invoices" value={k.invoices} hint="All time" period={asOf} />
            <Stat label="Unreconciled" value={k.unreconciled} icon={RefreshCcw}
              hint="Gateway payments" period={asOf} />
            <Stat label="Refunds pending" value={k.refunds_pending} period={asOf} />
          </CellGrid>
        </Card>

        <Card>
          <CardHeader title="Overdue invoices" description="Past the due date and not settled" />
          {overdue.isLoading ? (
            <SkeletonTable columns={8} />
          ) : overdue.error ? (
            <ErrorState error={overdue.error} />
          ) : (
            <Table
              head={['Invoice', 'Student', 'Issued', 'Due', 'Amount', 'Paid', 'Balance', 'Status']}
              empty={!overdue.data?.items.length}
              emptyLabel="Nothing overdue."
            >
              {(overdue.data?.items ?? []).map((i) => (
                <tr key={i.id}>
                  <Td className="font-mono text-[12px]">{i.invoice_no}</Td>
                  <Td className="font-medium">
                    {i.student_name}
                    <div className="font-mono text-[12px] text-muted-foreground">{i.admission_no}</div>
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(i.issued_on)}</Td>
                  <Td className="text-muted-foreground">{formatDate(i.due_on)}</Td>
                  <Td>{formatPaise(i.net_paise)}</Td>
                  <Td>{formatPaise(i.paid_paise)}</Td>
                  <Td className="font-medium">{formatPaise(i.due_paise)}</Td>
                  <Td><Badge tone={TONE[i.status] ?? 'neutral'}>{i.status}</Badge></Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
