import { Suspense, lazy, useState } from 'react'
import { PickerMenu } from '@/components/PickerMenu'

const AttendanceTrendChart = lazy(() => import('./AttendanceTrendChart'))
import { useQuery } from '@tanstack/react-query'
import { GraduationCap, Users, Wallet, ClipboardCheck } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Loading, SkeletonTiles, ErrorState,
  RangePicker, rangeQuery, useRange, type RangeOption, type ActiveRange,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'
import SetupProgress from './SetupProgress'
import { useCan } from '@/lib/session'

interface TrendPoint { date: string; present: number; absent: number; total: number; pct: number }

export default function PrincipalDashboard() {
  // Fee collection and arrears are for whoever answers for the money.
  const canSeeMoney = useCan()('finance.fees.read')
  const [range, setRange] = useRange()
  const [sectionId, setSectionId] = useState('')
  const [staffKind, setStaffKind] = useState<'all' | 'teaching' | 'non_teaching'>('all')
  const presets = useQuery({
    queryKey: ['date-ranges'],
    queryFn: () => api.get<{ items: RangeOption[] }>('/api/v1/date-ranges'),
  })

  const kpis = useQuery({
    queryKey: ['principal-dashboard', rangeQuery(range)],
    queryFn: () =>
      api.call('GET /principal/dashboard', { query: Object.fromEntries(new URLSearchParams(rangeQuery(range))) }),
    // A custom range is incomplete until both ends are chosen; asking in
    // between would flash a number for a window nobody selected.
    enabled: range.period !== 'custom' || (!!range.from && !!range.to),
  })
  const trend = useQuery({
    queryKey: ['attendance-trend'],
    queryFn: () => api.get<List<TrendPoint>>('/api/v1/principal/attendance-trend'),
  })

  if (kpis.isLoading && !kpis.data) return <SkeletonTiles count={3} />
  if (kpis.error) return <ErrorState error={kpis.error} />
  const k = kpis.data!
  const picked = sectionId ? k.students_by_section?.find((x) => x.section_id === sectionId) : undefined
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
        <CellGrid cols={4}>
          <Stat label="Students" icon={GraduationCap} period={asOf}
            value={picked ? picked.students : k.students}
            hint={picked ? picked.label : `${k.sections} sections`}
            control={(k.students_by_section?.length ?? 0) > 0 ? (
              <PickerMenu
                ariaLabel="Section"
                value={sectionId}
                onChange={setSectionId}
                className="h-7 max-w-[9rem] px-2 text-[12px]"
                options={[{ value: '', label: 'All' }, ...k.students_by_section!.map((sec) => ({ value: sec.section_id, label: sec.label }))]}
              />
            ) : undefined} />
          <Stat label="Staff" icon={Users} period={asOf}
            value={staffKind === 'teaching' ? (k.staff_teaching ?? 0) : staffKind === 'non_teaching' ? (k.staff_non_teaching ?? 0) : k.staff}
            hint={staffKind === 'all' && k.staff_teaching !== undefined ? `${k.staff_teaching} teaching · ${k.staff_non_teaching ?? 0} non-teaching` : undefined}
            control={k.staff_teaching !== undefined ? (
              <PickerMenu
                ariaLabel="Staff type"
                value={staffKind}
                onChange={setStaffKind}
                className="h-7 px-2 text-[12px]"
                options={[{ value: 'all', label: 'All' }, { value: 'teaching', label: 'Teaching' }, { value: 'non_teaching', label: 'Non-teaching' }] as const}
              />
            ) : undefined} />
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
            value={k.attendance_marked_today > 0 ? `${k.attendance_today_pct}%` : '-'}
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
        {/* Early warnings and the morning brief are retired (owner, 2026-10-03). */}

        <Card>
          <CardHeader title="At a glance" description="Waiting on a decision" />
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

        <HomeStats />

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
              /* The chart library is ~100KB compressed; it loads when there is a
                 chart to draw, into a placeholder the chart's own size, so the
                 home's figures never wait for it and nothing moves when it lands. */
              <Suspense fallback={<div className="skeleton h-full w-full rounded-lg" aria-hidden />}>
                <AttendanceTrendChart items={trend.data.items} />
              </Suspense>
            )}
          </div>
        </Card>
        {/* Last on the page: it arrives after the figures, and above them it
            pushed every card down as it appeared. */}
        <SetupProgress />
      </PageBody>
    </>
  )
}

/* STATS (owner's dashboard design, 2026-11-09): plain, like a report. Fees by
   month, this month's attendance class by class, students by stage. */
interface HomeStatsData { fees: { month: string; rupees: number }[]; classes: { name: string; percent: number }[]; stages: { name: string; students: number }[] }
function HomeStats() {
  const q = useQuery({ queryKey: ['home-stats'], queryFn: () => api.get<HomeStatsData>('/api/v1/home/stats'), staleTime: 5 * 60_000 })
  if (!q.data) return null
  const { fees, classes, stages } = q.data
  const fmax = Math.max(1, ...fees.map((f) => f.rupees))
  const total = stages.reduce((a, s) => a + s.students, 0)
  const lakh = (r: number) => (r >= 100000 ? `${(r / 100000).toFixed(1)}L` : r >= 1000 ? `${Math.round(r / 1000)}k` : String(r))
  const mon = (m: string) => new Date(m + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'short' })
  return (
    <section className="home-stats grid gap-4 lg:grid-cols-[1.3fr_1fr_1fr]">
      <Card>
        <CardHeader title="Fees collected by month" description="Receipts banked, ₹" />
        <div className="flex h-44 items-end gap-3 border-b px-5 pb-0 pt-2">
          {fees.map((f, i) => (
            <div key={f.month} className="group flex h-full flex-1 flex-col items-center justify-end gap-1.5" title={`${mon(f.month)}: ${formatPaise(f.rupees * 100)}`}>
              <span className="text-[11.5px] font-semibold tabular-nums">{lakh(f.rupees)}</span>
              <i className={'block w-full max-w-[26px] rounded-t transition-colors ' + (i === fees.length - 1 ? 'bg-primary' : 'bg-primary/25 group-hover:bg-primary')}
                style={{ height: `${Math.max(2, (f.rupees / fmax) * 100)}%` }} />
            </div>
          ))}
        </div>
        <div className="flex gap-3 px-5 pb-4 pt-2">{fees.map((f) => <span key={f.month} className="flex-1 text-center text-[11.5px] text-muted-foreground">{mon(f.month)}</span>)}</div>
      </Card>
      <Card>
        <CardHeader title="Attendance by class" description="This month" />
        <div className="flex flex-col gap-3 px-5 pb-5">
          {classes.length === 0 && <p className="text-[13px] text-muted-foreground">No attendance marked this month yet.</p>}
          {classes.map((c) => (
            <div key={c.name} className="grid grid-cols-[72px_1fr_40px] items-center gap-2.5 text-[13px]">
              <span className="truncate text-muted-foreground">{c.name}</span>
              <span className="h-1.5 overflow-hidden rounded bg-muted"><i className="block h-full rounded bg-primary" style={{ width: `${c.percent}%` }} /></span>
              <b className="text-right font-semibold tabular-nums">{c.percent}%</b>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <CardHeader title="Students by stage" description="On the roll this year" />
        <table className="mx-5 mb-4 w-[calc(100%-2.5rem)] text-[13.5px]">
          <tbody>
            {stages.map((s) => (
              <tr key={s.name} className="border-b">
                <td className="py-2.5">{s.name}</td>
                <td className="w-14 py-2.5 text-right text-[12px] text-muted-foreground tabular-nums">{total ? Math.round((s.students / total) * 100) : 0}%</td>
                <td className="w-14 py-2.5 text-right font-semibold tabular-nums">{s.students}</td>
              </tr>
            ))}
            <tr><td className="py-2.5 font-bold">Total</td><td /><td className="py-2.5 text-right font-bold tabular-nums">{total}</td></tr>
          </tbody>
        </table>
      </Card>
    </section>
  )
}
