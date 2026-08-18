import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader,
  Table, Td, Badge, Loading, ErrorState, PrintButton,
  RangePicker, rangeQuery, useRange, type RangeOption,
} from '@/components/ui'
import { CsvButton, pct, goodPct, zeroIsGood } from './shared'

/**
 * Department reports — the same departments, bounded by a period and built to
 * be printed.
 *
 * Department academics is the standing picture; this is the return a head of
 * department signs for a term. Everything is therefore range-bound: a figure
 * that quietly includes last year is worse than no figure, because it will be
 * copied into a form and defended.
 */

interface ReportRow {
  department_id: string; name: string; teachers: number
  staff_attendance_pct?: number; staff_absent_days: number; leave_days_taken?: number
  periods_scheduled: number
  lessons_delivered: number; lessons_not_delivered: number
  marks_entered: number; marks_outstanding: number
  pending_leave_requests: number
}

const URL = '/api/v1/rollups/departments/reports'

export default function DepartmentReports() {
  const [range, setRange] = useRange()
  const presets = useQuery({
    queryKey: ['date-ranges'],
    queryFn: () => api.get<{ items: RangeOption[] }>('/api/v1/date-ranges'),
  })
  const { data, isLoading, error } = useQuery({
    queryKey: ['rollup-dept-reports', rangeQuery(range)],
    queryFn: () => api.get<List<ReportRow>>(`${URL}?${rangeQuery(range)}`),
  })

  const rows = data?.items ?? []
  const backlog = rows.reduce((a, r) => a + r.marks_outstanding + r.lessons_not_delivered, 0)

  return (
    <>
      <PageHead
        eyebrow="Analysis"
        title="Department reports"
        description="Attendance, workload, results and backlogs per department, for the period shown."
        actions={
          <div className="flex gap-2">
            <CsvButton href={`${URL}?${rangeQuery(range)}`} />
            <PrintButton />
          </div>
        }
      />
      <PageBody>
        <div className="no-print">
          <RangePicker
            value={range}
            onChange={setRange}
            options={presets.data?.items ?? []}
          />
        </div>

        <Card>
          <CardHeader
            title="Department returns"
            description={
              backlog > 0
                ? `${backlog} items outstanding across all departments — undelivered lessons and unentered marks.`
                : 'Nothing outstanding across the departments shown.'
            }
          />
          {isLoading ? (
            <Loading />
          ) : error ? (
            <ErrorState error={error} />
          ) : (
            <Table
              head={[
                'Department', 'Staff', 'Attendance', 'Absent days', 'Leave days',
                'Periods/wk', 'Lessons done', 'Lessons pending',
                'Marks entered', 'Marks outstanding', 'Leave to decide',
              ]}
              empty={!rows.length}
              emptyLabel="No department is assigned to you, or none has activity in this period."
            >
              {rows.map((d) => (
                <tr key={d.department_id}>
                  <Td className="font-medium">{d.name}</Td>
                  <Td>{d.teachers}</Td>
                  <Td>
                    <Badge tone={goodPct(d.staff_attendance_pct)}>
                      {pct(d.staff_attendance_pct)}
                    </Badge>
                  </Td>
                  <Td>{d.staff_absent_days}</Td>
                  <Td>{d.leave_days_taken ?? '—'}</Td>
                  <Td>{d.periods_scheduled}</Td>
                  <Td>{d.lessons_delivered}</Td>
                  <Td>
                    <Badge tone={zeroIsGood(d.lessons_not_delivered)}>
                      {d.lessons_not_delivered}
                    </Badge>
                  </Td>
                  <Td>{d.marks_entered}</Td>
                  <Td>
                    <Badge tone={zeroIsGood(d.marks_outstanding)}>{d.marks_outstanding}</Badge>
                  </Td>
                  <Td>
                    {d.pending_leave_requests > 0 ? (
                      <Badge tone="warning">{d.pending_leave_requests}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
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
