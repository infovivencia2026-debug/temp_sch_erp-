import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Loading, ErrorState, PrintButton, Select,
  RangePicker, rangeQuery, useRange, type RangeOption, rangeLabel,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'
import { CsvButton } from './shared'

/**
 * Fee collection summaries — the day book an accountant prints and signs.
 *
 * The tie-out card is the point of this screen. Receipts and allocations never
 * match by accident — money can be taken in advance and left unapplied — so
 * the difference is stated rather than left for somebody to find. Write-offs,
 * refunds, uncleared instruments and bounced cheques are each shown with their
 * amount, so the exclusions can be checked instead of trusted.
 */

interface DayRow {
  bucket: string; receipts: number
  cash_paise: number; cheque_paise: number; online_paise: number
  card_paise: number; adjustment_paise: number; total_paise: number
}
interface HeadRow { fee_head: string; amount_paise: number }
interface CollectorRow {
  collector: string; receipts: number; cash_paise: number; other_paise: number
  total_paise: number; first_receipt?: string; last_receipt?: string
}
interface TieOut {
  receipts_paise: number; allocated_paise: number; unallocated_paise: number
  adjustments_paise: number; refunds_paise: number; pending_instruments_paise: number
  bounced_paise: number; failed_count: number; receipts_without_number: number
  note: string
}

const BASE = '/api/v1/rollups/fees/collections'

export default function CollectionSummaries() {
  const [range, setRange] = useRange()
  const [group, setGroup] = useState('day')
  const q = rangeQuery(range)

  const presets = useQuery({
    queryKey: ['date-ranges'],
    queryFn: () => api.get<{ items: RangeOption[] }>('/api/v1/date-ranges'),
  })
  const daily = useQuery({
    queryKey: ['rollup-collections', q, group],
    queryFn: () => api.get<List<DayRow>>(`${BASE}?${q}&group=${group}`),
  })
  const heads = useQuery({
    queryKey: ['rollup-collections-head', q],
    queryFn: () => api.get<List<HeadRow>>(`${BASE}/by-head?${q}`),
  })
  const collectors = useQuery({
    queryKey: ['rollup-collections-collector', q],
    queryFn: () => api.get<List<CollectorRow>>(`${BASE}/by-collector?${q}`),
  })
  const tie = useQuery({
    queryKey: ['rollup-collections-tieout', q],
    queryFn: () => api.get<TieOut>(`${BASE}/tie-out?${q}`),
  })

  const rows = daily.data?.items ?? []
  const total = rows.reduce((a, r) => a + r.total_paise, 0)
  const receipts = rows.reduce((a, r) => a + r.receipts, 0)
  const cash = rows.reduce((a, r) => a + r.cash_paise, 0)

  return (
    <>
      <PageHead
        eyebrow="Standard reports"
        title="Fee collection summaries"
        description="Collections by day, mode, fee head and collector, with the control totals an auditor ties out."
        actions={
          <div className="flex gap-2">
            <CsvButton href={`${BASE}?${q}&group=${group}`} label="Export day book" />
            <PrintButton />
          </div>
        }
      />
      <PageBody>
        <div className="no-print flex flex-wrap items-center gap-3">
          <RangePicker value={range} onChange={setRange} options={presets.data?.items ?? []} />
          <Select
            value={group}
            onChange={setGroup}
            options={[
              { value: 'day', label: 'By day' },
              { value: 'month', label: 'By month' },
            ]}
          />
        </div>

        <CellGrid cols={4}>
          <Stat label="Collected" value={formatPaise(total)} period={rangeLabel(range)} />
          <Stat label="Receipts" value={receipts} period={rangeLabel(range)} />
          <Stat label="Cash" value={formatPaise(cash)} hint="To be counted and banked" />
          <Stat
            label="Unapplied advances"
            value={tie.data ? formatPaise(tie.data.unallocated_paise) : '—'}
            hint="Taken but not yet against an invoice"
          />
        </CellGrid>

        <Card>
          <CardHeader title="Day book" description="Split by the columns a cash book carries. Write-offs are shown apart and excluded from the total." />
          {daily.isLoading ? (
            <Loading />
          ) : daily.error ? (
            <ErrorState error={daily.error} />
          ) : (
            <Table
              head={[
                'Period', 'Receipts',
                { label: 'Cash', align: 'right' },
                { label: 'Cheque/DD', align: 'right' },
                { label: 'Online', align: 'right' },
                { label: 'Card', align: 'right' },
                { label: 'Write-offs', align: 'right' },
                { label: 'Collected', align: 'right' },
              ]}
              empty={!rows.length}
            >
              {rows.map((r) => (
                <tr key={r.bucket}>
                  <Td className="font-medium">{r.bucket}</Td>
                  <Td>{r.receipts}</Td>
                  <Td className="text-right">{formatPaise(r.cash_paise)}</Td>
                  <Td className="text-right">{formatPaise(r.cheque_paise)}</Td>
                  <Td className="text-right">{formatPaise(r.online_paise)}</Td>
                  <Td className="text-right">{formatPaise(r.card_paise)}</Td>
                  <Td className="text-right text-muted-foreground">
                    {formatPaise(r.adjustment_paise)}
                  </Td>
                  <Td className="text-right font-medium">{formatPaise(r.total_paise)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="By fee head"
              description="Apportioned: a receipt pays an invoice, not a head, so each allocation is split across that invoice's lines."
              action={<CsvButton href={`${BASE}/by-head?${q}`} />}
            />
            {heads.isLoading ? (
              <Loading />
            ) : heads.error ? (
              <ErrorState error={heads.error} />
            ) : (
              <Table
                head={['Fee head', { label: 'Collected', align: 'right' }]}
                empty={!heads.data?.items.length}
              >
                {(heads.data?.items ?? []).map((h) => (
                  <tr key={h.fee_head}>
                    <Td className="font-medium">{h.fee_head}</Td>
                    <Td className="text-right">{formatPaise(h.amount_paise)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader
              title="By collector"
              description="Cash is split out because it is what gets counted into a bag at the end of the day."
              action={<CsvButton href={`${BASE}/by-collector?${q}`} />}
            />
            {collectors.isLoading ? (
              <Loading />
            ) : collectors.error ? (
              <ErrorState error={collectors.error} />
            ) : (
              <Table
                head={[
                  'Collected by', 'Receipts',
                  { label: 'Cash', align: 'right' },
                  { label: 'Total', align: 'right' },
                  'Receipt range',
                ]}
                empty={!collectors.data?.items.length}
              >
                {(collectors.data?.items ?? []).map((c) => (
                  <tr key={c.collector}>
                    <Td className="font-medium">{c.collector}</Td>
                    <Td>{c.receipts}</Td>
                    <Td className="text-right">{formatPaise(c.cash_paise)}</Td>
                    <Td className="text-right font-medium">{formatPaise(c.total_paise)}</Td>
                    <Td className="font-mono text-[12px] text-muted-foreground">
                      {c.first_receipt ? `${c.first_receipt} – ${c.last_receipt}` : '—'}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>

        <Card>
          <CardHeader title="Control totals" description="What an auditor checks the day book against." />
          {tie.isLoading ? (
            <Loading />
          ) : tie.error ? (
            <ErrorState error={tie.error} />
          ) : tie.data ? (
            <>
              <CellGrid cols={4}>
                <Stat label="Receipts" value={formatPaise(tie.data.receipts_paise)} />
                <Stat label="Applied to invoices" value={formatPaise(tie.data.allocated_paise)} />
                <Stat
                  label="Unapplied"
                  value={formatPaise(tie.data.unallocated_paise)}
                  hint="Advances"
                />
                <Stat label="Write-offs" value={formatPaise(tie.data.adjustments_paise)} />
                <Stat label="Refunds paid" value={formatPaise(tie.data.refunds_paise)} />
                <Stat
                  label="Instruments uncleared"
                  value={formatPaise(tie.data.pending_instruments_paise)}
                />
                <Stat label="Bounced" value={formatPaise(tie.data.bounced_paise)} />
                <Stat
                  label="Receipts without a number"
                  value={tie.data.receipts_without_number}
                  hint={`${tie.data.failed_count} failed payments`}
                />
              </CellGrid>
              <p className="px-5 pb-4 text-[13px] text-muted-foreground">{tie.data.note}</p>
            </>
          ) : null}
        </Card>
      </PageBody>
    </>
  )
}
