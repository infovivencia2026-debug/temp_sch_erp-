import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { formatPaise } from '@/lib/utils'
import {
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
  const points = (trend.data?.items ?? []).map((p) => p.pct)

  return (
    <BentoPage eyebrow={t('bento.principal.eyebrow')} title={t('bento.principal.title')}>
      {/* THE ANCHOR — 2x2, dark, and the only dark cell on the page. */}
      <Cell span="anchor" dark>
        <p className="text-[12.5px] opacity-80">{t('bento.principal.anchor_label')}</p>

        <div className="mt-4">
          <p className="text-[48px] font-semibold leading-none tabular-nums">
            {k.attendance_today_pct}%
          </p>
          <p className="mt-1.5 text-[12.5px] opacity-80">
            {t('bento.principal.attendance_marked', { count: k.attendance_marked_today })}
          </p>
          {trend.error ? (
            <div className="mt-3">
              <CellError dark message={t('bento.principal.trend_failed')} />
            </div>
          ) : points.length > 1 ? (
            <>
              <Sparkline
                points={points}
                srLabel={t('bento.principal.trend_sr')}
                className="mt-3 opacity-90"
              />
              <p className="mt-1 text-[11.5px] opacity-70">{t('bento.principal.trend_caption')}</p>
            </>
          ) : null}
        </div>

        <div className="mt-6 border-t border-background/20 pt-4">
          <p className="text-[12.5px] opacity-80">{t('bento.principal.collected_label')}</p>
          <p className="mt-1.5 text-[28px] font-semibold leading-none tabular-nums">
            {formatPaise(k.collected_paise)}
          </p>
          {/* Drawn in currentColor, not in --success: on this near-black ground
              the semantic tokens are the wrong side of their own contrast
              measurement, and the figure beside the bar carries the meaning
              anyway. */}
          <div
            role="progressbar"
            aria-label={t('bento.principal.collected_sr')}
            aria-valuenow={collectedPct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-background/25"
          >
            <div
              className="h-full rounded-full bg-background"
              style={{ width: `${collectedPct}%` }}
            />
          </div>
          <p className="mt-2 text-[12px] opacity-80">
            {t('bento.principal.collected_of_billed', {
              pct: collectedPct,
              billed: formatPaise(billed),
            })}
          </p>
        </div>

        {attendanceHref && (
          <Cue dark to={attendanceHref} label={t('bento.principal.cue_attendance')} />
        )}
      </Cell>

      <StatCell
        label={t('bento.principal.outstanding')}
        value={formatPaise(k.outstanding_paise)}
        shape={
          <Meter
            value={k.outstanding_paise}
            total={billed}
            tone="warning"
            srLabel={t('bento.principal.outstanding_sr')}
          />
        }
        note={t('bento.principal.of_billed', { billed: formatPaise(billed) })}
        to={feesHref}
        cue={t('bento.principal.cue_fees')}
      />

      <StatCell
        label={t('bento.principal.defaulters')}
        value={k.defaulters}
        shape={
          <Meter
            value={k.defaulters}
            total={k.students}
            tone="destructive"
            srLabel={t('bento.principal.defaulters_sr')}
          />
        }
        note={t('bento.principal.of_students', { count: k.students })}
        to={defaultersHref}
        cue={t('bento.principal.cue_defaulters')}
      />

      <StatCell
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

      <StatCell
        label={t('bento.principal.applications')}
        value={k.open_applications}
        note={t('bento.principal.applications_note')}
        to={applicationsHref}
        cue={t('bento.principal.cue_applications')}
      />

      <StatCell
        label={t('bento.principal.unassigned')}
        value={k.unassigned_subjects}
        note={t('bento.principal.unassigned_note')}
        to={subjectsHref}
        cue={t('bento.principal.cue_unassigned')}
      />
    </BentoPage>
  )
}
