import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, Building2, IndianRupee, Users } from 'lucide-react'
import { api, setActingInstitution } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Loading, ErrorState, EmptyState,
  RangePicker, rangeQuery, useRange, type RangeOption, type ActiveRange,
} from '@/components/ui'
import { cn, formatPaise } from '@/lib/utils'

/* Every campus, side by side.

   A trust running six campuses had no screen that showed six campuses: the
   principal's dashboard is scoped to one school by design, so the person above
   them read six of those in six tabs and added the numbers up by hand.

   Deliberately aggregate. A card carries counts and money, never a child's
   name — someone who needs a name uses "Open" to enter that school properly,
   where the audit trail records that they did. */

interface CampusCard {
  institution_id: string
  school: string
  campus: string
  district?: string
  students: number
  staff: number
  attendance_pct?: number
  marked_today: number
  collected_paise: number
  outstanding_paise: number
  defaulters: number
}
interface Alert {
  severity: 'high' | 'medium' | 'low'
  kind: string
  school?: string
  message: string
}
interface Dashboard {
  range: { label: string }
  schools: number
  campuses: number
  students: number
  staff: number
  collected_paise: number
  outstanding_paise: number
  enquiries: number
  applications: number
  offered: number
  enrolled: number
  campuses_detail: CampusCard[]
  alerts: Alert[]
  attendance_trend: { date: string; percent: number; marked: number }[]
}

const SEVERITY: Record<string, 'danger' | 'warning' | 'neutral'> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
}

export default function PlatformDashboard() {
  const qc = useQueryClient()
  const [range, setRange] = useRange()
  const presets = useQuery({
    queryKey: ['date-ranges'],
    queryFn: () => api.get<{ items: RangeOption[] }>('/api/v1/date-ranges'),
  })

  const { data, isLoading, error } = useQuery({
    queryKey: ['platform-dashboard', rangeQuery(range)],
    queryFn: () => api.get<Dashboard>(`/api/v1/admin/platform-dashboard?${rangeQuery(range)}`),
  })

  if (isLoading) return <Loading label="Adding up every campus…" />
  if (error) return <ErrorState error={error} />
  const d = data!

  // Conversion is the number a trust actually manages the funnel by.
  const conversion = d.applications > 0 ? Math.round((d.enrolled / d.applications) * 100) : 0

  return (
    <>
      <PageHead
        eyebrow="Platform"
        title="All campuses"
        description="Every school on this installation, in one place."
        actions={
          <RangePicker
            value={range}
            onChange={setRange as (r: ActiveRange) => void}
            options={presets.data?.items ?? []}
            label={data?.range?.label}
          />
        }
        width="wide"
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Students" value={d.students} icon={Users}
            hint={`${d.schools} schools · ${d.campuses} campuses`} />
          <Stat label="Staff" value={d.staff} />
          <Stat label="Collected" value={formatPaise(d.collected_paise)}
            icon={IndianRupee} period={d.range.label} />
          {/* A balance is true now, not over a period. Saying so on the card
              stops anyone reporting it as a period figure. */}
          <Stat label="Outstanding" value={formatPaise(d.outstanding_paise)}
            period="as of today"
            delta={d.outstanding_paise > 0 ? { value: 'Owed to the group', positive: false } : undefined} />
        </CellGrid>

        {d.alerts.length > 0 && (
          <Card>
            <CardHeader
              title="Needs attention"
              description="Recomputed each time this opens, so an alert disappears when the thing it describes is fixed"
              action={<AlertTriangle className="h-4 w-4 text-muted-foreground" />}
            />
            <ul className="divide-y">
              {d.alerts.map((a, i) => (
                <li key={i} className="flex items-start gap-3 px-5 py-3">
                  <Badge tone={SEVERITY[a.severity]}>{a.severity}</Badge>
                  <div className="min-w-0">
                    <p className="text-[14px]">{a.message}</p>
                    {a.school && (
                      <p className="mt-0.5 text-[13px] text-muted-foreground">{a.school}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Admission funnel"
            description={`Across every school · ${d.range.label}`}
          />
          <div className="grid gap-px bg-border sm:grid-cols-4">
            {[
              { label: 'Enquiries', value: d.enquiries },
              { label: 'Applications', value: d.applications },
              { label: 'Offered', value: d.offered },
              { label: 'Enrolled', value: d.enrolled },
            ].map((step, i) => (
              <div key={step.label} className="bg-card px-5 py-4">
                <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                  {step.label}
                  {i < 3 && <ArrowRight className="h-3 w-3" />}
                </p>
                <p className="mt-1 text-[24px] font-semibold tabular-nums">{step.value}</p>
              </div>
            ))}
          </div>
          <p className="border-t px-5 py-3 text-[13px] text-muted-foreground">
            {conversion}% of applications became enrolments.
          </p>
        </Card>

        <Card>
          <CardHeader title="Campuses" description={`${d.campuses_detail.length} across the group`} />
          {d.campuses_detail.length === 0 ? (
            <EmptyState title="No campuses yet" />
          ) : (
            <Table
              head={['Campus', 'Students', 'Staff', 'Attendance today', 'Collected', 'Outstanding', '']}
            >
              {d.campuses_detail.map((c) => (
                <tr key={c.institution_id + c.campus}>
                  <Td className="font-medium">
                    {c.school}
                    <span className="block text-[12px] font-normal text-muted-foreground">
                      {c.campus}
                      {c.district && ` · ${c.district}`}
                    </span>
                  </Td>
                  <Td className="tabular-nums">{c.students}</Td>
                  <Td className="tabular-nums">{c.staff}</Td>
                  <Td>
                    {/* Null and zero are different emergencies: "nobody came"
                        versus "nobody has taken the register". */}
                    {c.attendance_pct == null ? (
                      <span className="text-muted-foreground">
                        {c.students > 0 ? 'not marked' : '—'}
                      </span>
                    ) : (
                      <span
                        className={cn(
                          'tabular-nums',
                          c.attendance_pct < 75 && 'text-destructive',
                        )}
                      >
                        {c.attendance_pct}%
                        <span className="ml-1.5 text-[12px] text-muted-foreground">
                          of {c.marked_today}
                        </span>
                      </span>
                    )}
                  </Td>
                  <Td className="tabular-nums">{formatPaise(c.collected_paise)}</Td>
                  <Td className="tabular-nums">
                    {formatPaise(c.outstanding_paise)}
                    {c.defaulters > 0 && (
                      <span className="ml-1.5 text-[12px] text-muted-foreground">
                        {c.defaulters} owing
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Button
                      size="sm"
                      variant="secondary"
                      title="Work inside this school"
                      onClick={() => {
                        setActingInstitution(c.institution_id)
                        qc.invalidateQueries()
                      }}
                    >
                      <Building2 className="h-3.5 w-3.5" />
                      Open
                    </Button>
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
