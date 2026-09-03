import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  SkeletonTiles, ErrorState, EmptyState, RangePicker, useRange, rangeQuery, type RangeOption,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'

/* THE BOARD'S ONE SHEET.

   A trustee asks where the money is going, across every campus, a few times a
   year. Not today's drawer, not the unreconciled gateway queue — those are the
   desk's questions. This is the period, every campus in a row, four figures
   each, and a total. Nothing on it is a control. */

interface CampusMoney {
  campus_id: string | null
  campus: string
  collected_paise: number
  outstanding_paise: number
  overdue_paise: number
  payroll_paise: number
  students: number
  staff: number
}
interface BoardMoney { campuses: CampusMoney[]; total: CampusMoney }

export default function BoardMoney() {
  const [range, setRange] = useRange()
  const presets = useQuery({
    queryKey: ['date-ranges'],
    queryFn: () => api.get<{ items: RangeOption[] }>('/api/v1/date-ranges'),
  })
  const q = useQuery({
    queryKey: ['board', 'money', rangeQuery(range)],
    queryFn: () => api.get<BoardMoney>(`/api/v1/board/money?${rangeQuery(range)}`),
  })

  return (
    <>
      <PageHead
        eyebrow="Board"
        title="Where the money goes"
        description="Every campus for the period: what came in, what is still owed, what went out in salaries, and who that was for."
        actions={<RangePicker value={range} onChange={setRange} options={presets.data?.items ?? []} />}
      />
      <PageBody>
        {q.isLoading ? (
          <SkeletonTiles count={4} label="Adding up every campus…" />
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : (
          <>
            <CellGrid>
              <Stat label="Collected" value={formatPaise(q.data!.total.collected_paise)} hint="In the period, every campus" />
              <Stat label="Still owed" value={formatPaise(q.data!.total.outstanding_paise)} hint={`${formatPaise(q.data!.total.overdue_paise)} past due`} />
              <Stat label="Salaries paid" value={formatPaise(q.data!.total.payroll_paise)} hint="Payroll runs in the period" />
              <Stat label="People" value={`${q.data!.total.students.toLocaleString('en-IN')} · ${q.data!.total.staff}`} hint="Students · staff" />
            </CellGrid>

            <Card>
              <CardHeader title="By campus" />
              {q.data!.campuses.length === 0 ? (
                <EmptyState title="No campus yet" body="Campuses appear here as soon as the school has one." />
              ) : (
                <Table head={['Campus', 'Collected', 'Still owed', 'Past due', 'Salaries', 'Students', 'Staff']}>
                  {q.data!.campuses.map((c) => (
                    <tr key={c.campus_id ?? 'none'}>
                      <Td className="font-medium">{c.campus}</Td>
                      <Td>{formatPaise(c.collected_paise)}</Td>
                      <Td>{formatPaise(c.outstanding_paise)}</Td>
                      <Td className={c.overdue_paise > 0 ? 'text-destructive' : ''}>{formatPaise(c.overdue_paise)}</Td>
                      <Td>{formatPaise(c.payroll_paise)}</Td>
                      <Td>{c.students.toLocaleString('en-IN')}</Td>
                      <Td>{c.staff}</Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
