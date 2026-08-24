import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Phone } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Select, Loading, ErrorState, ExportButton, useSort,
} from '@/components/ui'
import { formatPaise, formatDate } from '@/lib/utils'

interface Defaulter {
  student_id: string; admission_no: string; full_name: string
  class_name?: string; section_name?: string
  guardian_name?: string; phone?: string
  balance_paise: number; oldest_due?: string; days_overdue: number; bucket: string
}

const BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const
const TONE: Record<string, 'neutral' | 'warning' | 'danger'> = {
  '0-30': 'neutral', '31-60': 'warning', '61-90': 'danger', '90+': 'danger',
}

/** Aging report. The guardian's phone is on every row because the only useful
    next action from this screen is to call them. */
export default function Defaulters() {
  const [bucket, setBucket] = useState('')

  const { data, isLoading, error } = useQuery({
    queryKey: ['defaulters'],
    queryFn: () => api.get<List<Defaulter>>('/api/v1/fees/defaulters'),
  })

  const all = data?.items ?? []
  const rows = bucket ? all.filter((d) => d.bucket === bucket) : all
  /* Biggest balance first by default.

     A defaulter list read in admission-number order is a list nobody works
     down; the money is the reason the screen exists. */
  const sort = useSort<Defaulter>(
    rows,
    (d, k) => (d as unknown as Record<string, string | number | undefined>)[k],
    { key: 'balance_paise', dir: 'desc' },
  )
  const totals = BUCKETS.map((b) => ({
    bucket: b,
    count: all.filter((d) => d.bucket === b).length,
    amount: all.filter((d) => d.bucket === b).reduce((a, d) => a + d.balance_paise, 0),
  }))

  return (
    <>
      <PageHead
        eyebrow="Fee Workspace"
        title="Defaulters & aging"
        description="Balances past their due date, bucketed by age, with the guardian to contact. Not the same figure as the fee overview's outstanding, which is this year's bills whether due yet or not."
        actions={
          <>
            <ExportButton report="defaulters" />
            <Select
              value={bucket}
              onChange={setBucket}
              placeholder="All buckets"
              options={BUCKETS.map((b) => ({ value: b, label: `${b} days` }))}
            />
          </>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          {totals.map((t) => (
            <Stat
              key={t.bucket}
              label={`${t.bucket} days`}
              value={formatPaise(t.amount)}
              hint={`${t.count} student${t.count === 1 ? '' : 's'}`}
            />
          ))}
        </CellGrid>

        {/* "Overdue", not "outstanding". This list is invoices past their due
            date and nothing else; the fee overview's outstanding is this
            year's bills whether due or not, and the executive dashboard's is
            every unpaid invoice of every year. Calling all three "outstanding"
            is what made one screen say ₹6,66,625 while another said ₹6,32,875
            about what looked like the same money. */}
        <Card>
          <CardHeader
            title="Overdue accounts"
            description={`${rows.length} of ${all.length} · ${formatPaise(rows.reduce((a, d) => a + d.balance_paise, 0))} overdue`}
          />
          {isLoading ? (
            <Loading />
          ) : error ? (
            <ErrorState error={error} />
          ) : (
            <Table
              head={[
                { label: 'Admission no.', key: 'admission_no' },
                { label: 'Student', key: 'full_name' },
                { label: 'Class', key: 'class_name' },
                'Guardian',
                { label: 'Oldest due', key: 'oldest_due' },
                { label: 'Overdue', key: 'days_overdue' },
                { label: 'Balance', key: 'balance_paise' },
                { label: 'Age', key: 'days_overdue' },
              ]}
              sort={sort}
              empty={!rows.length}
              emptyLabel="No overdue balances."
            >
              {sort.sorted.map((d) => (
                <tr key={d.student_id}>
                  <Td className="font-mono text-[12px]">{d.admission_no}</Td>
                  <Td className="font-medium">{d.full_name}</Td>
                  <Td>{d.class_name ? `${d.class_name}-${d.section_name}` : '—'}</Td>
                  <Td>
                    {d.guardian_name ?? '—'}
                    {d.phone && (
                      <a href={`tel:${d.phone}`} className="ml-2 inline-flex items-center gap-1 text-[12px] text-primary">
                        <Phone className="h-3 w-3" />{d.phone}
                      </a>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(d.oldest_due)}</Td>
                  <Td>{d.days_overdue}d</Td>
                  <Td className="font-medium">{formatPaise(d.balance_paise)}</Td>
                  <Td><Badge tone={TONE[d.bucket]}>{d.bucket}</Badge></Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
