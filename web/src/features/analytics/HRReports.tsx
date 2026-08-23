import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Loading, ErrorState, PrintButton,
  RangePicker, rangeQuery, useRange, type RangeOption, rangeLabel,
} from '@/components/ui'
import { CsvButton, pct, goodPct } from './shared'

/**
 * HR reports — headcount, movement, attendance and what has to be renewed.
 *
 * The renewals table is worth a word. There is no contract-end column on the
 * employee record and nothing in the schema carries one, so rather than
 * inventing a field that would sit empty, this reads the dated records the
 * school already keeps: the end of a deputation, the last working day once
 * notice is served, and the validity of the medical, police and qualification
 * papers an inspection asks for. Anything already lapsed shows a negative
 * count and sorts first, because a lapsed police verification is more urgent
 * than one expiring next month.
 */

interface HeadcountRow {
  department: string; total: number; teaching: number; non_teaching: number
  permanent: number; contract: number; probation: number; part_time: number
  female: number; male: number
  avg_experience_years?: number; post_graduate_or_above: number
}
interface MovementRow { month: string; joiners: number; leavers: number; net: number }
interface AttendanceRow {
  employee_code: string; full_name: string; department?: string
  days_marked: number; days_present: number; days_absent: number
  days_late: number; days_leave: number
  attendance_pct?: number; leave_taken?: number; leave_entitled?: number
  weekly_periods: number
}
interface WorkloadRow { band: string; teachers: number; share_pct?: number }
interface ExpiryRow {
  employee_code: string; full_name: string; department?: string
  kind: string; detail: string; expires_on: string; days_left: number
}

const HEADCOUNT = '/api/v1/rollups/hr/headcount'
const MOVEMENT = '/api/v1/rollups/hr/movement'
const ATTENDANCE = '/api/v1/rollups/hr/attendance'
const WORKLOAD = '/api/v1/rollups/hr/workload'
const EXPIRIES = '/api/v1/rollups/hr/expiries'

export default function HRReports() {
  const [range, setRange] = useRange()
  const q = rangeQuery(range)

  const presets = useQuery({
    queryKey: ['date-ranges'],
    queryFn: () => api.get<{ items: RangeOption[] }>('/api/v1/date-ranges'),
  })
  const headcount = useQuery({
    queryKey: ['rollup-hr-headcount'],
    queryFn: () => api.get<List<HeadcountRow>>(HEADCOUNT),
  })
  const movement = useQuery({
    queryKey: ['rollup-hr-movement', q],
    queryFn: () => api.get<List<MovementRow>>(`${MOVEMENT}?${q}`),
  })
  const attendance = useQuery({
    queryKey: ['rollup-hr-attendance', q],
    queryFn: () => api.get<List<AttendanceRow>>(`${ATTENDANCE}?${q}`),
  })
  const workload = useQuery({
    queryKey: ['rollup-hr-workload'],
    queryFn: () => api.get<List<WorkloadRow>>(WORKLOAD),
  })
  const expiries = useQuery({
    queryKey: ['rollup-hr-expiries'],
    queryFn: () => api.get<List<ExpiryRow>>(EXPIRIES),
  })

  const hc = headcount.data?.items ?? []
  const total = hc.reduce((a, r) => a + r.total, 0)
  const teaching = hc.reduce((a, r) => a + r.teaching, 0)
  const joiners = (movement.data?.items ?? []).reduce((a, r) => a + r.joiners, 0)
  const leavers = (movement.data?.items ?? []).reduce((a, r) => a + r.leavers, 0)
  const lapsed = (expiries.data?.items ?? []).filter((e) => e.days_left < 0).length

  return (
    <>
      <PageHead
        eyebrow="Reports"
        title="Staff analytics & reports"
        description="Monthly summaries of staff numbers, who joined and left, attendance and leave, how teaching load is spread, and the papers coming up for renewal."
        actions={<PrintButton />}
      />
      <PageBody>
        <div className="no-print">
          <RangePicker value={range} onChange={setRange} options={presets.data?.items ?? []} />
        </div>

        <CellGrid cols={4}>
          <Stat label="Total active staff" value={total} hint={`${teaching} teaching`} period="As of now" />
          {/* The raw period key — "this_month" — was reaching the screen when no
              label was set, which is a database word shown to a principal. */}
          <Stat label="New hires" value={joiners} period={rangeLabel(range)} />
          <Stat label="Exits" value={leavers} period={rangeLabel(range)} />
          <Stat
            label="Expired documents"
            value={lapsed}
            hint="Already past their validity date"
            period="As of now"
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Establishment"
            description="By department. Teaching and non-teaching follow the school's own designation categories."
            action={<CsvButton href={HEADCOUNT} />}
          />
          {headcount.isLoading ? (
            <Loading />
          ) : headcount.error ? (
            <ErrorState error={headcount.error} />
          ) : (
            <Table
              head={[
                'Department', 'Total', 'Teaching', 'Non-teaching', 'Permanent',
                'Contract', 'Probation', 'Part-time', 'Women', 'Avg experience', 'PG+',
              ]}
              empty={!hc.length}
            >
              {hc.map((h) => (
                <tr key={h.department}>
                  <Td className="font-medium">{h.department}</Td>
                  <Td>{h.total}</Td>
                  <Td>{h.teaching}</Td>
                  <Td>{h.non_teaching}</Td>
                  <Td>{h.permanent}</Td>
                  <Td>{h.contract}</Td>
                  <Td>{h.probation}</Td>
                  <Td>{h.part_time}</Td>
                  <Td>{h.female}</Td>
                  <Td>{h.avg_experience_years ?? '—'}</Td>
                  <Td>{h.post_graduate_or_above}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Joiners and leavers"
              description="Month by month over the period shown."
              action={<CsvButton href={`${MOVEMENT}?${q}`} />}
            />
            {movement.isLoading ? (
              <Loading />
            ) : movement.error ? (
              <ErrorState error={movement.error} />
            ) : (
              <Table
                head={['Month', 'Joiners', 'Leavers', 'Net']}
                empty={!movement.data?.items.length}
              >
                {(movement.data?.items ?? []).map((m) => (
                  <tr key={m.month}>
                    <Td className="font-medium">{m.month}</Td>
                    <Td>{m.joiners}</Td>
                    <Td>{m.leavers}</Td>
                    <Td>
                      <Badge tone={m.net > 0 ? 'success' : m.net < 0 ? 'danger' : 'neutral'}>
                        {m.net > 0 ? `+${m.net}` : m.net}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Teaching load distribution"
              description="Whether the load is evenly spread — who carries it is on Staff allocation."
              action={<CsvButton href={WORKLOAD} />}
            />
            {workload.isLoading ? (
              <Loading />
            ) : workload.error ? (
              <ErrorState error={workload.error} />
            ) : (
              <Table
                head={['Weekly load', 'Teachers', 'Share']}
                empty={!workload.data?.items.length}
              >
                {(workload.data?.items ?? []).map((wl) => (
                  <tr key={wl.band}>
                    <Td className="font-medium">{wl.band}</Td>
                    <Td>{wl.teachers}</Td>
                    <Td>{pct(wl.share_pct)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Attendance and leave"
            description="Week-offs and holidays are excluded from the denominator, so the percentage means what it says."
            action={<CsvButton href={`${ATTENDANCE}?${q}`} />}
          />
          {attendance.isLoading ? (
            <Loading />
          ) : attendance.error ? (
            <ErrorState error={attendance.error} />
          ) : (
            <Table
              head={[
                'Code', 'Name', 'Department', 'Marked', 'Absent', 'Late',
                'On leave', 'Attendance', 'Leave used', 'Periods/wk',
              ]}
              empty={!attendance.data?.items.length}
            >
              {(attendance.data?.items ?? []).map((a) => (
                <tr key={a.employee_code}>
                  <Td className="font-mono text-[12px]">{a.employee_code}</Td>
                  <Td className="font-medium">{a.full_name}</Td>
                  <Td className="text-muted-foreground">{a.department ?? '—'}</Td>
                  <Td>{a.days_marked}</Td>
                  <Td>{a.days_absent}</Td>
                  <Td>{a.days_late}</Td>
                  <Td>{a.days_leave}</Td>
                  <Td>
                    <Badge tone={goodPct(a.attendance_pct)}>{pct(a.attendance_pct)}</Badge>
                  </Td>
                  <Td>
                    {a.leave_entitled
                      ? `${a.leave_taken ?? 0} / ${a.leave_entitled}`
                      : (a.leave_taken ?? '—')}
                  </Td>
                  <Td>{a.weekly_periods}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Renewals falling due"
            description="Deputation ends, notice served, and the validity of medical, verification and qualification records. Lapsed items first."
            action={<CsvButton href={EXPIRIES} />}
          />
          {expiries.isLoading ? (
            <Loading />
          ) : expiries.error ? (
            <ErrorState error={expiries.error} />
          ) : (
            <Table
              head={['Code', 'Name', 'Department', 'Renewal', 'Detail', 'Expires', 'Days left']}
              empty={!expiries.data?.items.length}
              emptyLabel="Nothing falls due in the next ninety days."
            >
              {(expiries.data?.items ?? []).map((e, i) => (
                <tr key={`${e.employee_code}-${e.kind}-${e.expires_on}-${i}`}>
                  <Td className="font-mono text-[12px]">{e.employee_code}</Td>
                  <Td className="font-medium">{e.full_name}</Td>
                  <Td className="text-muted-foreground">{e.department ?? '—'}</Td>
                  <Td>{e.kind}</Td>
                  <Td className="text-muted-foreground">{e.detail}</Td>
                  <Td>{e.expires_on}</Td>
                  <Td>
                    <Badge tone={e.days_left < 0 ? 'danger' : e.days_left <= 30 ? 'warning' : 'neutral'}>
                      {e.days_left < 0 ? `${-e.days_left} days overdue` : `${e.days_left} days`}
                    </Badge>
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
