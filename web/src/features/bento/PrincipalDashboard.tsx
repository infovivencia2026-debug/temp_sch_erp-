import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { WidgetLayer, Widget } from './WidgetLayer'
import { formatPaise } from '@/lib/utils'
import {
  Bars,
  BentoError,
  BentoLoading,
  BentoPage,
  BlockedFlowArt,
  CalendarDensityArt,
  calendarSlots,
  Cell,
  CellError,
  type CellSpan,
  Cue,
  FunnelArt,
  Meter,
  NetworkArt,
  PopulationArt,
  RiskGridArt,
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

/* THE ATTENTION WIDGETS.

   Fifteen cells, one endpoint. `GET /api/v1/attention` already answers "what
   needs me" for whoever is asking — the server runs each probe under the
   caller's own scope and drops the ones their permissions do not cover — so
   every cell below is a re-presentation of a line the product already
   computes, fetched once and read fifteen times. Fifteen cells each holding
   their own useQuery would be fifteen identical requests for one payload.

   A probe with nothing to report is not in the response at all: the engine
   drops zero-count items so the classic panel does not fill with reassurance.
   A widget is not a panel line, though — a person put it on their board on
   purpose, and one that vanished on the days it had nothing to say would give
   them a dashboard whose shape changed daily. So an absent probe renders as a
   calm zero, which is the answer to the question they asked.

   Colour carries the severity the server assigned and nothing else: critical
   is pink, warning is orange, and everything else — info, and every calm zero
   — is an untinted card. Three states, because the engine has three. */
type AttentionSeverity = 'critical' | 'warning' | 'info'

interface AttentionItem {
  key: string
  severity: AttentionSeverity
  count: number
  headline: string
  detail?: string
  action: string
  href?: string
  amount_paise?: number
}

interface AttentionResponse {
  items: AttentionItem[]
}

/* Severity to accent. `info` is deliberately absent rather than mapped to a
   fourth hue: this palette has four accents carrying one meaning each, and a
   third alarm colour would only make the two real ones harder to find. */
const ATTENTION_ACCENT: Partial<Record<AttentionSeverity, 'pink' | 'orange'>> = {
  critical: 'pink',
  warning: 'orange',
}

/* Where each probe's detail already lives, as a catalogue key rather than the
   abstract target the API returns. The engine says "fees" and leaves the route
   to the client because seventeen navigation trees keep fees in seventeen
   places; on this board there is one tree, so the destination is named exactly
   and checked against the catalogue before the cue is drawn. */
const ATTENTION_TARGETS = {
  attendance: 'institution_admin.standard.attendance_overview',
  approvals: 'institution_admin.approvals.approvals',
  staff: 'institution_admin.staff.leaves_subs',
  fees: 'institution_admin.standard.fee_collection',
  payments: 'institution_admin.fees.fee_dashboard',
  admissions: 'institution_admin.admissions.admissions_pipeline',
  marks: 'institution_admin.examinations.exams_results',
  students: 'institution_admin.students.enrollment_lifecycle',
} as const

type AttentionTarget = keyof typeof ATTENTION_TARGETS

/* The declaration list. `id` is the key a saved layout is stored against, so
   these are fixed forever: renaming one drops that cell out of every board
   somebody has already arranged. `probe` is the server's key; `money` marks a
   figure a bursar reads faster as rupees than as a row count. */
/* `as const` rather than an explicit element type, so `slot` and `target` stay
   literal: the catalogue key is built as `bento.principal.attn_${slot}`, and a
   `string` there would widen it out of `MessageKey` and lose the compile-time
   check that every one of these strings actually exists in en.ts. */
const ATTENTION_WIDGETS = [
  { id: 'attn-fees-overdue', probe: 'fees.overdue', target: 'fees', slot: 'fees_overdue', money: true },
  { id: 'attn-payments-failed', probe: 'payments.failed', target: 'payments', slot: 'payments_failed', money: false },
  { id: 'attn-payments-bounced', probe: 'payments.bounced', target: 'payments', slot: 'payments_bounced', money: false },
  { id: 'attn-fees-concessions', probe: 'fees.concessions_pending', target: 'approvals', slot: 'fees_concessions', money: false },
  { id: 'attn-attendance-unmarked', probe: 'attendance.unmarked', target: 'attendance', slot: 'attendance_unmarked', money: false },
  { id: 'attn-attendance-absent', probe: 'attendance.absent_today', target: 'attendance', slot: 'attendance_absent', money: false },
  { id: 'attn-attendance-corrections', probe: 'attendance.corrections', target: 'approvals', slot: 'attendance_corrections', money: false },
  { id: 'attn-staff-absent', probe: 'staff.absent_today', target: 'staff', slot: 'staff_absent', money: false },
  { id: 'attn-admissions-applications', probe: 'admissions.applications', target: 'admissions', slot: 'admissions_applications', money: false },
  { id: 'attn-admissions-documents', probe: 'admissions.documents', target: 'admissions', slot: 'admissions_documents', money: false },
  { id: 'attn-admissions-followups', probe: 'admissions.followups', target: 'admissions', slot: 'admissions_followups', money: false },
  { id: 'attn-leave-pending', probe: 'leave.pending', target: 'approvals', slot: 'leave_pending', money: false },
  { id: 'attn-marks-pending', probe: 'marks.pending', target: 'marks', slot: 'marks_pending', money: false },
  { id: 'attn-reportcards-unpublished', probe: 'reportcards.unpublished', target: 'marks', slot: 'reportcards_unpublished', money: false },
  { id: 'attn-certificates-requested', probe: 'certificates.requested', target: 'students', slot: 'certificates_requested', money: false },
] as const satisfies readonly {
  id: string
  probe: string
  target: AttentionTarget
  slot: string
  money?: boolean
}[]

/* One cell.

   The three states are kept apart on purpose. A failed fetch draws an error,
   never a nought: on this board a zero reads as "nothing is wrong here", and
   that is the most expensive thing a dashboard can say untruthfully. A fetch
   still in flight draws a dash for the same reason. Only a response that
   arrived draws a number. */
function AttentionCell({
  span,
  label,
  cue,
  to,
  item,
  money,
  status,
}: {
  span: CellSpan
  label: string
  cue: string
  to?: string
  item?: AttentionItem
  money?: boolean
  status: 'loading' | 'error' | 'ready'
}) {
  const t = useT()

  if (status === 'error') {
    return (
      <Cell span={span}>
        <p
          className="bento-label text-[10px] font-semibold uppercase leading-tight tracking-[0.14em]
                     text-[var(--bento-muted)]"
        >
          {label}
        </p>
        <div className="mt-4">
          <CellError message={t('bento.principal.attention_failed')} />
        </div>
      </Cell>
    )
  }

  if (status === 'loading') {
    return (
      <StatCell
        span={span}
        label={label}
        value={t('bento.principal.attention_pending')}
        note={t('bento.principal.attention_loading')}
      />
    )
  }

  // The money item leads with the amount: ₹15.53L is read faster than 44, and
  // it is the figure the decision is actually made on.
  const value = money && item?.amount_paise ? formatPaise(item.amount_paise) : (item?.count ?? 0)

  return (
    <StatCell
      span={span}
      label={label}
      value={value}
      accent={item ? ATTENTION_ACCENT[item.severity] : undefined}
      note={item ? item.headline : t('bento.principal.attention_clear')}
      to={to}
      cue={cue}
    />
  )
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
  /* One request behind fifteen cells. The query key is the panel's own, so a
     board and the classic attention panel share a single cached response
     rather than racing for the same rows. */
  const attention = useQuery({
    queryKey: ['attention', 'bento-principal'],
    queryFn: () => api.get<AttentionResponse>('/api/v1/attention'),
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
  // Three more destinations the attention cells need and the KPI cells did
  // not. Same rule: the catalogue decides, and an unusable feature simply
  // leaves that cell without a cue rather than offering a door that is locked.
  const leavesHref = useFeatureHref(ATTENTION_TARGETS.staff)
  const paymentsHref = useFeatureHref(ATTENTION_TARGETS.payments)
  const resultsHref = useFeatureHref(ATTENTION_TARGETS.marks)

  const attentionHrefs: Record<AttentionTarget, string | undefined> = {
    attendance: attendanceHref,
    approvals: approvalsHref,
    staff: leavesHref,
    fees: feesHref,
    payments: paymentsHref,
    admissions: applicationsHref,
    marks: resultsHref,
    students: studentsHref,
  }

  const attentionItems = new Map(
    (attention.data?.items ?? []).map((i) => [i.key, i] as const),
  )
  const attentionStatus: 'loading' | 'error' | 'ready' = attention.error
    ? 'error'
    : attention.isLoading
      ? 'loading'
      : 'ready'

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
  /* THE ART LAYER'S INPUTS.

     Every one of these is a figure already printed on the card it is drawn
     behind — a background layer is still a claim about the school, and a
     drawing whose proportion disagrees with the number above it is worse than
     no drawing. The trend-derived one is guarded on the trend query as well:
     a failed fetch must not become a confident picture of an unmarked month.
     `moved` is the collected share, which is where the flow stopped; the
     length past the barrier is the outstanding share the card names. */
  const days = trend.error ? [] : calendarSlots(series)
  const movedShare = billed > 0 ? k.collected_paise / billed : 0
  const loadPerTeacher = k.staff > 0 ? Math.round(k.students / k.staff) : 0

  const bars = series.slice(-10).map((p) => ({
    label: p.date.slice(8, 10),
    value: p.pct,
    title: t('bento.principal.bar_title', { date: p.date, pct: p.pct }),
  }))

  return (
    <BentoPage eyebrow={t('bento.principal.eyebrow')} title={t('bento.principal.title')}>
      <WidgetLayer dashboard="principal">
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
      <Widget id="pulse" label={t('bento.principal.anchor_label')} size="large" index={0}>
        {(span) => (
          <Cell
            span={span}
            domain="students"
            /* The month of days behind the day's percentage. Empty — and so
               not drawn at all — when the trend query failed, because a grid
               of unmarked days is a statement about the school and not about
               the request. */
            art={days.length > 0 ? <CalendarDensityArt slots={days} /> : undefined}
          >
            {/* Every class here is the one StatCell uses. This cell was the
                board's one exception: the mint gradient, a 72px figure against
                everyone else's clamp, a hand-rolled divider and its own pill
                component. Two rows could not hold that stack, so the board's
                `overflow: hidden` cut the bottom off it — and it read as a
                different kind of object from the fourteen cells around it.
                It is a 2x2 now, not a genre. */}
            <p
              className="bento-label text-[10px] font-semibold uppercase leading-tight tracking-[0.14em]
                         text-[var(--bento-muted)]"
            >
              {t('bento.principal.anchor_label')}
            </p>

            <p
              className="mt-2 font-extrabold leading-[0.95] tracking-[-0.035em] tabular-nums
                         text-[length:var(--bento-fig,clamp(26px,3.6vh,40px))]"
            >
              {k.attendance_today_pct}%
            </p>
            <p className="bento-note mt-1.5 text-[11px] leading-snug text-[var(--bento-muted)]">
              {t('bento.principal.attendance_marked', { count: k.attendance_marked_today })}
            </p>

            {trend.error ? (
              <div className="mt-3">
                <CellError message={t('bento.principal.trend_failed')} />
              </div>
            ) : points.length > 1 ? (
              <div className="bento-shape mt-3">
                <Sparkline points={points} srLabel={t('bento.principal.trend_sr')} />
              </div>
            ) : null}

            <div className="mt-4 border-t border-[var(--bento-line)] pt-4">
              <p
                className="bento-label text-[10px] font-semibold uppercase leading-tight tracking-[0.14em]
                           text-[var(--bento-muted)]"
              >
                {t('bento.principal.collected_label')}
              </p>
              <p
                className="mt-2 font-extrabold leading-[0.95] tracking-[-0.035em] tabular-nums
                           text-[length:var(--bento-fig,clamp(26px,3.6vh,40px))]"
              >
                {formatPaise(k.collected_paise)}
              </p>
              {/* The same Meter the rest of the board uses, rather than a bar
                  built here out of the anchor's own ink. The sentence under it
                  still states the share in words, so colour is never the only
                  channel carrying it. */}
              <div className="mt-3">
                <Meter
                  value={k.collected_paise}
                  total={billed}
                  srLabel={t('bento.principal.collected_sr')}
                />
              </div>
              <p className="bento-note mt-1.5 text-[11px] leading-snug text-[var(--bento-muted)]">
                {t('bento.principal.collected_of_billed', {
                  pct: collectedPct,
                  billed: formatPaise(billed),
                })}
              </p>
            </div>

            {/* The actions. The same Cue every other cell carries, checked
                against the catalogue first: a button leading somewhere this
                account cannot open is worse than a shorter row of buttons. */}
            {(attendanceHref || feesHref) && (
              <div className="mt-auto flex flex-wrap gap-2 pt-4">
                {attendanceHref && (
                  <Cue to={attendanceHref} label={t('bento.principal.cue_attendance')} />
                )}
                {feesHref && <Cue to={feesHref} label={t('bento.principal.cue_fees')} />}
              </div>
            )}
          </Cell>
        )}
      </Widget>

      {/* Money out — pink, and pink is used for nothing else on this page. */}
      <Widget id="outstanding" label={t('bento.principal.outstanding')} size="small" index={2}>
        {(span) => (
          <StatCell
            span={span}
            domain="finance"
            label={t('bento.principal.outstanding')}
            value={formatPaise(k.outstanding_paise)}
            badge={t('bento.principal.pct_of_billed', { pct: outstandingPct })}
            art={<BlockedFlowArt moved={movedShare} />}
       
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
        )}
      </Widget>

      {/* A warning, so orange — the hue this palette reserves for one. */}
      <Widget id="defaulters" label={t('bento.principal.defaulters')} size="small" index={4}>
        {(span) => (
          <StatCell
            span={span}
            domain="staff"
            label={t('bento.principal.defaulters')}
            value={k.defaulters}
            badge={t('bento.principal.pct_of_students', { pct: defaultersPct })}
            art={<RiskGridArt total={k.students} flagged={k.defaulters} />}
       
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
        )}
      </Widget>

      {/* The bar chart: plain divs, the most recent school day in purple,
          every other day in the muted card tone. Ten rectangles do not justify
          a charting runtime on every page load. */}
      <Widget id="trend" label={t('bento.principal.trend_label')} size="medium" index={1}>
        {(span) => (
          <Cell span={span} domain="academics">
            <p className="text-[12.5px] text-[var(--bento-ink)] opacity-70">{t('bento.principal.bars_label')}</p>
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
        )}
      </Widget>

      {/* No badge and no accent. Four hues, one meaning each, and the roll is
          not one of those meanings — a tint here would only make the two that
          do mean something harder to find. */}
      <Widget id="students" label={t('bento.principal.students')} size="medium" index={3}>
        {(span) => (
          <StatCell
            domain="operations"
            span={span}
            label={t('bento.principal.students')}
            value={k.students}
            art={<PopulationArt count={k.students} />}
       
            note={t('bento.principal.sections', { count: k.sections })}
            to={studentsHref}
            cue={t('bento.principal.cue_students')}
          />
        )}
      </Widget>

      <Widget id="staff" label={t('bento.principal.staff')} size="small" index={8} optional>
        {(span) => (
          <StatCell
            span={span}
            domain="reports"
            label={t('bento.principal.staff')}
            value={k.staff}
            art={<NetworkArt nodes={k.staff} degree={loadPerTeacher} />}
       
            note={t('bento.principal.as_of_today')}
            to={staffHref}
            cue={t('bento.principal.cue_staff')}
          />
        )}
      </Widget>

      <Widget id="approvals" label={t('bento.principal.approvals')} size="small" index={7}>
        {(span) => (
          <StatCell
            span={span}
            domain="staff"
            label={t('bento.principal.approvals')}
            value={k.pending_leave}
       
            note={t('bento.principal.approvals_note')}
            to={approvalsHref}
            cue={t('bento.principal.cue_approvals')}
          />
        )}
      </Widget>

      {/* The last two run wide so the four-column grid closes flush. The
          packing is: anchor 2x2 with outstanding and defaulters beside it and
          the bar chart under those, then students wide with staff and
          approvals, then these two — sixteen slots, four rows, no hole left at
          the bottom right. Below `lg` every wide cell is simply full width. */}
      <Widget id="applications" label={t('bento.principal.applications')} size="medium" index={5}>
        {(span) => (
          <StatCell
            span={span}
            domain="admissions"
            label={t('bento.principal.applications')}
            value={k.open_applications}
            art={<FunnelArt count={k.open_applications} />}
       
            note={t('bento.principal.applications_note')}
            to={applicationsHref}
            cue={t('bento.principal.cue_applications')}
          />
        )}
      </Widget>

      <Widget id="unassigned" label={t('bento.principal.unassigned')} size="medium" index={6}>
        {(span) => (
          <StatCell
            span={span}
            domain="communication"
            label={t('bento.principal.unassigned')}
            value={k.unassigned_subjects}
            badge={k.unassigned_subjects > 0 ? t('bento.principal.needs_attention') : undefined}
       
            note={t('bento.principal.unassigned_note')}
            to={subjectsHref}
            cue={t('bento.principal.cue_unassigned')}
          />
        )}
      </Widget>
      {/* The fifteen attention cells, declared from one table rather than
          fifteen near-identical blocks — the only thing that differs between
          them is which probe they read and where they point, and writing that
          out fifteen times invites the fifteenth to drift from the first.

          All of them are 1x1 by default: a figure, a label, a sentence and a
          way out is exactly what fits a 1x1, and a person who wants one bigger
          resizes it. The indices continue the KPI cells above so a board
          added to later does not renumber what somebody already arranged. */}
      {ATTENTION_WIDGETS.map((w, i) => (
        <Widget
          key={w.id}
          id={w.id}
          label={t(`bento.principal.attn_${w.slot}`)}
          size="small"
          optional
          index={9 + i}
        >
          {(span) => (
            <AttentionCell
              span={span}
              label={t(`bento.principal.attn_${w.slot}`)}
              cue={t(`bento.principal.attn_cue_${w.target}`)}
              to={attentionHrefs[w.target]}
              item={attentionItems.get(w.probe)}
              money={w.money}
              status={attentionStatus}
            />
          )}
        </Widget>
      ))}
      </WidgetLayer>
    </BentoPage>
  )
}
