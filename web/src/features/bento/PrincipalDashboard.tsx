import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { formatPaise } from '@/lib/utils'
import {
  AnchorAction,
  Bars,
  BentoError,
  BentoLoading,
  BentoPage,
  Cell,
  CellError,
  Cue,
  Meter,
  Sparkline,
  StatCell,
  useFeatureHref,
} from './bento-kit'

/* THE HEAD'S PAGE, IN THE BENTO LANGUAGE.

   Same two endpoints as `web/src/features/principal/Dashboard.tsx` —
   /principal/dashboard and /principal/attendance-trend — and no others. This
   is a re-layout of figures the product already fetches, not a new view of the
   data: every number below is one the classic screen prints today, and
   anything this account may not see the API still refuses. `resolveScope`
   decides on the server; nothing here widens a query to fill a prettier cell.

   THE ANCHOR is the two numbers a head opens this page for — attendance today,
   and fee collection against what was billed — on the one dark cell, because
   its content is a shape (the thirty-day attendance line, the collection bar)
   and bright data on a dark ground is what the eye reaches first. Everything
   else is a light 1x1: text is read faster on light.

   WHAT "AGAINST TARGET" MEANS HERE, EXACTLY. There is no stored attendance
   target and no stored collection target in this product, and inventing one
   would put a number on the page that no one in the school agreed to. So the
   comparison drawn is the one the data actually supports: attendance today
   against the thirty-day line it sits on, and collection against everything
   billed — collected plus what is still outstanding, both figures straight off
   the same response. The labels say which. */

interface PrincipalKPIs {
  students: number
  staff: number
  sections: number
  attendance_today_pct: number
  attendance_marked_today: number
  collected_paise: number
  outstanding_paise: number
  defaulters: number
  pending_leave: number
  open_applications: number
  unassigned_subjects: number
  range: { period: string; from: string; to: string; label: string }
  as_of_now: string[]
}
interface TrendPoint {
  date: string
  present: number
  absent: number
  total: number
  pct: number
}

export default function BentoPrincipalDashboard() {
  const t = useT()

  const kpis = useQuery({
    queryKey: ['bento-principal-dashboard'],
    queryFn: () => api.get<PrincipalKPIs>('/api/v1/principal/dashboard'),
  })
  const trend = useQuery({
    queryKey: ['attendance-trend'],
    queryFn: () => api.get<List<TrendPoint>>('/api/v1/principal/attendance-trend'),
  })

  // Every cue is checked against the catalogue before it is drawn: a link to a
  // screen this account cannot open is worse than no link.
  const attendanceHref = useFeatureHref('institution_admin.standard.attendance_overview')
  const feesHref = useFeatureHref('institution_admin.standard.fee_collection')
  const defaultersHref = useFeatureHref('institution_admin.fees.fee_default')
  const studentsHref = useFeatureHref('institution_admin.students.enrollment_lifecycle')
  const staffHref = useFeatureHref('institution_admin.directory_workload.faculty_directory')
  const applicationsHref = useFeatureHref('institution_admin.admissions.admissions_pipeline')
  const subjectsHref = useFeatureHref('institution_admin.academics.teacher_assignment')
  const approvalsHref = useFeatureHref('institution_admin.approvals.approvals')

  if (kpis.isLoading) return <BentoLoading message={t('bento.principal.loading')} />
  // A failed query is an error. A dashboard of zeroes that is really a failed
  // fetch reads as a fact about the school, and somebody acts on it.
  if (kpis.error) return <BentoError message={t('bento.principal.failed')} />

  const k = kpis.data!
  const billed = k.collected_paise + k.outstanding_paise
  const collectedPct = billed > 0 ? Math.round((k.collected_paise / billed) * 100) : 0
  const outstandingPct = billed > 0 ? Math.round((k.outstanding_paise / billed) * 100) : 0
  const defaultersPct = k.students > 0 ? Math.round((k.defaulters / k.students) * 100) : 0

  const series = trend.data?.items ?? []
  const points = series.map((p) => p.pct)
  // The last ten school days, as bars. Sliced from the same thirty-day
  // response the sparkline draws — no second request, and no day invented to
  // square the row off: if the school has only six days of marks, six bars are
  // drawn. The label is the day of the month taken off the ISO string rather
  // than through `new Date`, which would shift the date across a timezone for
  // anyone whose browser is not in India.
  const bars = series.slice(-10).map((p) => ({
    label: p.date.slice(8, 10),
    value: p.pct,
    title: t('bento.principal.bar_title', { date: p.date, pct: p.pct }),
  }))

  return (
    <BentoPage eyebrow={t('bento.principal.eyebrow')} title={t('bento.principal.title')}>
      {/* THE ANCHOR — 2x2, the mint gradient, the largest number on the page,
          its two actions along the bottom edge.

          `--bento-anchor-from`/`-to` with `--bento-anchor-ink` on top is the
          one pairing in this palette that is NOT redefined for light mode:
          dark ink on mint measures 14.24:1, so the gradient the design was
          drawn with survives the relighting the four pastels needed. That is
          also why it replaced the inverted cell that used to be here. The
          inverted cell was right to draw in currentColor rather than in
          `--success` — a token measured against a light card sinks into a
          near-black ground — but it meant the head's headline figure changed
          polarity with the theme. This one does not. */}
      <Cell span="anchor" tone="anchor">
        <p className="text-[12.5px] font-medium opacity-75">
          {t('bento.principal.anchor_label')}
        </p>

        <div className="mt-5">
          <p className="text-[72px] font-semibold leading-[0.9] tracking-[-0.03em] tabular-nums">
            {k.attendance_today_pct}%
          </p>
          <p className="mt-2 text-[12.5px] opacity-75">
            {t('bento.principal.attendance_marked', { count: k.attendance_marked_today })}
          </p>
          {trend.error ? (
            <div className="mt-3">
              <CellError tone="anchor" message={t('bento.principal.trend_failed')} />
            </div>
          ) : points.length > 1 ? (
            <>
              <Sparkline
                points={points}
                srLabel={t('bento.principal.trend_sr')}
                className="mt-4 opacity-70"
              />
              <p className="mt-1 text-[11.5px] opacity-70">{t('bento.principal.trend_caption')}</p>
            </>
          ) : null}
        </div>

        <div
          className="mt-6 border-t pt-5"
          style={{ borderColor: 'color-mix(in srgb, var(--bento-anchor-ink) 15%, transparent)' }}
        >
          <p className="text-[12.5px] opacity-75">{t('bento.principal.collected_label')}</p>
          <p className="mt-1.5 text-[30px] font-semibold leading-none tracking-[-0.02em] tabular-nums">
            {formatPaise(k.collected_paise)}
          </p>
          {/* Track and fill are both the anchor's own ink, one mixed down. No
              accent is reached for: all four pastels were measured against the
              card, and the mint gradient is not that ground. The sentence
              under the bar states the share in words regardless, so colour is
              never the only channel carrying it. */}
          <div
            role="progressbar"
            aria-label={t('bento.principal.collected_sr')}
            aria-valuenow={collectedPct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-3.5 h-2 w-full overflow-hidden rounded-full"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--bento-anchor-ink) 18%, transparent)',
            }}
          >
            <div
              className="h-full rounded-full bg-[var(--bento-anchor-ink)]"
              style={{ width: `${collectedPct}%` }}
            />
          </div>
          <p className="mt-2.5 text-[12px] opacity-75">
            {t('bento.principal.collected_of_billed', {
              pct: collectedPct,
              billed: formatPaise(billed),
            })}
          </p>
        </div>

        {/* The actions along the bottom edge. Each is checked against the
            catalogue first: a pill leading somewhere this account cannot open
            is worse than a shorter row of pills. */}
        {(attendanceHref || feesHref) && (
          <div className="mt-auto flex flex-wrap gap-2.5 pt-6">
            {attendanceHref && (
              <AnchorAction to={attendanceHref} label={t('bento.principal.cue_attendance')} />
            )}
            {feesHref && <AnchorAction to={feesHref} label={t('bento.principal.cue_fees')} />}
          </div>
        )}
      </Cell>

      {/* Money out — pink, and pink is used for nothing else on this page. */}
      <StatCell
        label={t('bento.principal.outstanding')}
        value={formatPaise(k.outstanding_paise)}
        badge={t('bento.principal.pct_of_billed', { pct: outstandingPct })}
        accent="pink"
        shape={
          <Meter
            value={k.outstanding_paise}
            total={billed}
            tone="destructive"
            srLabel={t('bento.principal.outstanding_sr')}
          />
        }
        note={t('bento.principal.of_billed', { billed: formatPaise(billed) })}
        to={feesHref}
        cue={t('bento.principal.cue_fees')}
      />

      {/* A warning, so orange — the hue this palette reserves for one. */}
      <StatCell
        label={t('bento.principal.defaulters')}
        value={k.defaulters}
        badge={t('bento.principal.pct_of_students', { pct: defaultersPct })}
        accent="orange"
        shape={
          <Meter
            value={k.defaulters}
            total={k.students}
            tone="warning"
            srLabel={t('bento.principal.defaulters_sr')}
          />
        }
        note={t('bento.principal.of_students', { count: k.students })}
        to={defaultersHref}
        cue={t('bento.principal.cue_defaulters')}
      />

      {/* The bar chart: plain divs, the most recent school day in purple,
          every other day in the muted card tone. Ten rectangles do not justify
          a charting runtime on every page load. */}
      <Cell span="wide">
        <p className="text-[12.5px] text-[var(--bento-muted)]">{t('bento.principal.bars_label')}</p>
        {trend.error ? (
          <div className="mt-4">
            <CellError message={t('bento.principal.trend_failed')} />
          </div>
        ) : bars.length > 1 ? (
          <div className="mt-5">
            <Bars
              items={bars}
              activeIndex={bars.length - 1}
              srLabel={t('bento.principal.bars_sr', {
                count: bars.length,
                low: Math.min(...bars.map((b) => b.value)),
                high: Math.max(...bars.map((b) => b.value)),
              })}
            />
          </div>
        ) : (
          <p className="mt-4 text-[12px] text-[var(--bento-muted)]">
            {t('bento.principal.bars_none')}
          </p>
        )}
        {attendanceHref && <Cue to={attendanceHref} label={t('bento.principal.cue_attendance')} />}
      </Cell>

      {/* No badge and no accent. Four hues, one meaning each, and the roll is
          not one of those meanings — a tint here would only make the two that
          do mean something harder to find. */}
      <StatCell
        span="wide"
        label={t('bento.principal.students')}
        value={k.students}
        note={t('bento.principal.sections', { count: k.sections })}
        to={studentsHref}
        cue={t('bento.principal.cue_students')}
      />

      <StatCell
        label={t('bento.principal.staff')}
        value={k.staff}
        note={t('bento.principal.as_of_today')}
        to={staffHref}
        cue={t('bento.principal.cue_staff')}
      />

      <StatCell
        label={t('bento.principal.approvals')}
        value={k.pending_leave}
        note={t('bento.principal.approvals_note')}
        to={approvalsHref}
        cue={t('bento.principal.cue_approvals')}
      />

      {/* The last two run wide so the four-column grid closes flush. The
          packing is: anchor 2x2 with outstanding and defaulters beside it and
          the bar chart under those, then students wide with staff and
          approvals, then these two — sixteen slots, four rows, no hole left at
          the bottom right. Below `lg` every wide cell is simply full width. */}
      <StatCell
        span="wide"
        label={t('bento.principal.applications')}
        value={k.open_applications}
        note={t('bento.principal.applications_note')}
        to={applicationsHref}
        cue={t('bento.principal.cue_applications')}
      />

      <StatCell
        span="wide"
        label={t('bento.principal.unassigned')}
        value={k.unassigned_subjects}
        badge={k.unassigned_subjects > 0 ? t('bento.principal.needs_attention') : undefined}
        accent="orange"
        note={t('bento.principal.unassigned_note')}
        to={subjectsHref}
        cue={t('bento.principal.cue_unassigned')}
      />
    </BentoPage>
  )
}
