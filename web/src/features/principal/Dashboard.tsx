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
import { useCan } from '@/lib/session'

interface PrincipalKPIs {
  students: number; staff: number; sections: number
  /* Today's register, and the range's. The first pair is CURRENT_DATE however
     the picker moves — the same day the attention panel counts unmarked
     sections for. The second is the range and is absent, not zero, when no
     register was marked in it. */
  attendance_today_pct: number; attendance_marked_today: number
  attendance_range_pct?: number; attendance_range_marked?: number
  collected_paise: number; outstanding_paise: number; defaulters: number
  pending_leave: number; open_applications: number; unassigned_subjects: number
  range: { period: string; from: string; to: string; label: string }
  as_of_now: string[]
}
interface TrendPoint { date: string; present: number; absent: number; total: number; pct: number }

export default function PrincipalDashboard() {
  // Fee collection and arrears are for whoever answers for the money.
  const canSeeMoney = useCan()('finance.fees.read')
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
          {/* TODAY, and said so.
            *
            * This tile carried the range's attendance under the word "today"
            * — 96% and 1,612 marked, from the month behind it, on a morning
            * nobody had marked a register. The setup checklist beside it was
            * meanwhile counting eight sections unmarked today, and both were
            * right about different days. The headline is today; the range
            * figure keeps its own sentence, and is absent rather than nought
            * when the range holds no register at all. */}
          <Stat
            label="Attendance today"
            value={k.attendance_marked_today > 0 ? `${k.attendance_today_pct}%` : '—'}
            icon={ClipboardCheck}
            hint={
              k.attendance_marked_today > 0
                ? `${k.attendance_marked_today} marked today`
                : 'No register marked today'
            }
            delta={
              k.attendance_range_marked
                ? {
                    value: `${k.attendance_range_pct}% over ${k.range?.label ?? 'the range'}`,
                    positive: (k.attendance_range_pct ?? 0) >= 90,
                  }
                : undefined
            }
            period={asOf}
          />
          {/* Money, only for whoever is answerable for it.
           *
           * What the school collected and what it is owed is a governance
           * number, not a general one. It was shown to anybody who reached
           * this dashboard, which after the role fix is the principal — but
           * the tile should not depend on which workspace somebody landed in.
           * A head of department has no more business with the school's
           * arrears than a teacher does.
           *
           * THE TWO WORDS THAT WERE THE SAME WORD.
           *
           * `collected_paise` is receipts banked inside the range, whatever
           * year's bill they settle and whether or not they have been applied
           * to one. The fee overview's "Collected" is money applied to THIS
           * YEAR'S bills. Under one label, a month's receipts (₹45,04,625)
           * sat above a year's applied collection (₹44,97,125) and a month
           * appeared to beat its own year.
           *
           * `outstanding_paise` is every unpaid invoice of every year — the
           * arrears the school is actually owed — and is larger than the fee
           * overview's outstanding by the debt carried in from earlier years.
           * Both are true; neither is "outstanding" unqualified. */}
          {canSeeMoney && (
            <Stat
              label="Receipts banked"
              value={formatPaise(k.collected_paise)}
              icon={Wallet}
              hint="Whatever year's bill they settle"
              delta={{
                value: `${formatPaise(k.outstanding_paise)} unpaid, all years, as of today`,
                positive: false,
              }}
              period={k.range?.label}
            />
          )}
        </CellGrid>

        <Card>
          <CardHeader title="Needs attention" description="Items waiting on a decision" />
          <CellGrid cols={4}>
            <Stat label="Pending approvals" value={k.pending_leave} hint="Leave requests" period={asOf} />
            {canSeeMoney && (
              <Stat period={asOf} label="Fee defaulters" value={k.defaulters} hint="Past due date" />
            )}
            {/* Not the funnel's "Applications received", which counts every
                application ever raised, and not the attention panel's, which
                is narrower still — only the ones waiting on a decision. The
                hint says which of the three this is. */}
            <Stat period={asOf} label="Open applications" value={k.open_applications}
              hint="Not accepted, rejected or withdrawn" />
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
