import { useQuery } from '@tanstack/react-query'
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid,
} from 'recharts'
import { GraduationCap, Users, Wallet, ClipboardCheck } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Loading, ErrorState,
  RangePicker, rangeQuery, useRange, type RangeOption, type ActiveRange,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'
import SetupProgress from './SetupProgress'

interface PrincipalKPIs {
  students: number; staff: number; sections: number
  attendance_today_pct: number; attendance_marked_today: number
  collected_paise: number; outstanding_paise: number; defaulters: number
  pending_leave: number; open_applications: number; unassigned_subjects: number
  range: { period: string; from: string; to: string; label: string }
  as_of_now: string[]
}
interface TrendPoint { date: string; present: number; absent: number; total: number; pct: number }

export default function PrincipalDashboard() {
  const [range, setRange] = useRange()
  const presets = useQuery({
    queryKey: ['date-ranges'],
    queryFn: () => api.get<{ items: RangeOption[] }>('/api/v1/date-ranges'),
  })

  const kpis = useQuery({
    queryKey: ['principal-dashboard', rangeQuery(range)],
    queryFn: () =>
      api.get<PrincipalKPIs>(`/api/v1/principal/dashboard?${rangeQuery(range)}`),
    // A custom range is incomplete until both ends are chosen; asking in
    // between would flash a number for a window nobody selected.
    enabled: range.period !== 'custom' || (!!range.from && !!range.to),
  })
  const trend = useQuery({
    queryKey: ['attendance-trend'],
    queryFn: () => api.get<List<TrendPoint>>('/api/v1/principal/attendance-trend'),
  })

  if (kpis.isLoading) return <Loading />
  if (kpis.error) return <ErrorState error={kpis.error} />
  const k = kpis.data!
  // Levels are true now whatever the range; saying so on the card stops a
  // balance being read as a period figure.
  const asOf = 'as of today'

  return (
    <>
      <PageHead
        eyebrow="Dashboard"
        title="Executive overview"
        description="Students, staff, attendance, fee collection and what needs attention."
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
        {/* Before the numbers, not after them. A school that has not finished
            setting up is looking at zeroes, and the explanation has to arrive
            first or the dashboard reads as broken. */}
        <SetupProgress />
        <CellGrid cols={4}>
          <Stat label="Students" value={k.students} icon={GraduationCap}
            hint={`${k.sections} sections`} period={asOf} />
          <Stat label="Staff" value={k.staff} icon={Users} period={asOf} />
          <Stat
            label="Attendance"
            value={`${k.attendance_today_pct}%`}
            icon={ClipboardCheck}
            hint={`${k.attendance_marked_today} marked`}
            period={k.range?.label}
          />
          <Stat
            label="Collected"
            value={formatPaise(k.collected_paise)}
            icon={Wallet}
            delta={{ value: `${formatPaise(k.outstanding_paise)} outstanding now`, positive: false }}
            period={k.range?.label}
          />
        </CellGrid>

        <Card>
          <CardHeader title="Needs attention" description="Items waiting on a decision" />
          <CellGrid cols={4}>
            <Stat label="Pending approvals" value={k.pending_leave} hint="Leave requests" period={asOf} />
            <Stat period={asOf} label="Fee defaulters" value={k.defaulters} hint="Past due date" />
            <Stat period={asOf} label="Open applications" value={k.open_applications} hint="Not yet decided" />
            <Stat period={asOf} label="Unassigned subjects" value={k.unassigned_subjects} hint="No teacher timetabled" />
          </CellGrid>
        </Card>

        <Card>
          <CardHeader title="Attendance, last 30 days" description="Percentage present or late" />
          <div className="h-64 p-4">
            {trend.isLoading ? (
              <Loading />
            ) : !trend.data?.items.length ? (
              <p className="grid h-full place-items-center text-[14px] text-muted-foreground">
                No attendance recorded in the last 30 days.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend.data.items} margin={{ top: 4, right: 8, bottom: 4, left: -22 }}>
                  <defs>
                    <linearGradient id="att" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <Tooltip
                    contentStyle={{
                      background: 'hsl(var(--popover))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 8, fontSize: 12,
                    }}
                  />
                  <Area
                    type="monotone" dataKey="pct" name="Present %"
                    stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#att)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
      </PageBody>
    </>
  )
}
