import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Reload,
  SkeletonTiles, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'

/* Dropout risk, as rules.

   The catalogue calls this an engine. It is three rules a school already
   applies — attendance under the board's 75% floor, a fee more than a month
   late, the last exam below pass — counted per school, with "at risk" meaning
   two of the three. Every threshold is on the response and printed here, so
   nobody reads a number they cannot check. No names: those are read inside
   the school, where the audit trail records who looked. */

interface School {
  institution_id: string
  school: string
  students: number
  attendance: number
  fees: number
  marks: number
  at_risk: number
  all_three: number
  coverage: number
}

interface Resp {
  as_of: string
  thresholds: {
    attendance_below_pct: number
    attendance_min_days: number
    window_days: number
    fees_overdue_days: number
    signals_for_at_risk: number
  }
  schools: School[]
  total: School
  method: string
}

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((100 * n) / of)}%` : '—')

export default function DropoutRisk() {
  const q = useQuery({
    queryKey: ['dropout-risk'],
    queryFn: () => api.get<Resp>('/api/v1/admin/signals/dropout-risk'),
  })
  const d = q.data
  const rows = d?.schools ?? []
  const t = d?.thresholds

  return (
    <>
      <PageHead
        eyebrow="Signals"
        title="Dropout risk"
        actions={<Reload onClick={() => q.refetch()} busy={q.isFetching} />}
      />
      <PageBody>
        {q.isLoading ? (
          <SkeletonTiles count={4} />
        ) : d ? (
          <CellGrid cols={4}>
            <Stat label="At risk" value={d.total.at_risk} icon={AlertTriangle} hint={`${pct(d.total.at_risk, d.total.students)} of ${d.total.students}`} />
            <Stat label="Attendance" value={d.total.attendance} hint={`Under ${t?.attendance_below_pct}% in ${t?.window_days} days`} />
            <Stat label="Fees" value={d.total.fees} hint={`Over ${t?.fees_overdue_days} days late`} />
            <Stat label="Marks" value={d.total.marks} hint="Last exam below pass" />
          </CellGrid>
        ) : null}

        <Card>
          <CardHeader title="By school" />
          {d && <p className="border-b px-5 py-3 text-[13px] text-muted-foreground">{d.method}</p>}
          {q.isLoading ? (
            <SkeletonTable columns={7} />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : rows.length === 0 ? (
            <EmptyState title="No active schools" />
          ) : (
            <Table head={['School', { label: 'Students', align: 'right' }, { label: 'Attendance', align: 'right' }, { label: 'Fees', align: 'right' }, { label: 'Marks', align: 'right' }, { label: 'At risk', align: 'right' }, 'Register taken']}>
              {rows.map((r) => (
                <tr key={r.institution_id}>
                  <Td className="font-medium">{r.school}</Td>
                  <Td className="text-right tabular-nums">{r.students}</Td>
                  <Td className="text-right tabular-nums">{r.attendance}</Td>
                  <Td className="text-right tabular-nums">{r.fees}</Td>
                  <Td className="text-right tabular-nums">{r.marks}</Td>
                  <Td className="text-right tabular-nums">
                    {r.at_risk > 0 ? <Badge tone="warning">{r.at_risk}</Badge> : '0'}
                    {r.all_three > 0 && <span className="ml-1 text-[12px] text-muted-foreground">({r.all_three} all three)</span>}
                  </Td>
                  <Td>
                    {r.students > 0 && r.coverage < r.students / 2 ? (
                      <span className="text-warning">{pct(r.coverage, r.students)} of children</span>
                    ) : (
                      <span className="text-muted-foreground">{pct(r.coverage, r.students)}</span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
