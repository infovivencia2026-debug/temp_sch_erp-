import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { WidgetLayer, Widget } from './WidgetLayer'
import { useLayout } from '@/lib/widgets'
import { cn, formatPaise } from '@/lib/utils'
import { useWidgetSize } from '@/lib/widget-size'
import {
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
import { AgeBands, HeatStrip, Quadrant, Ring, SegmentBar, Timeline } from './bento-viz'

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
  /* The year-consistent triple. `collected_paise` is receipts banked inside the
     requested range whatever year's invoice they settle, and
     `outstanding_paise` is arrears of EVERY year — so the two cannot be added,
     and neither belongs under a caption that says "this year". */
  billed_paise: number
  collected_year_paise: number
  outstanding_year_paise: number
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

/* THE FEATURE WIDGETS.

   The attention table above answers "what needs me". These answer the other
   half of the question the head asked for — "let me put any of my screens on
   the board" — one cell per principal feature that has a real figure behind
   it. The rule they are held to is the rule the rest of this file is held to:
   the figure is one an existing screen already prints, off an endpoint that
   already exists, and where a feature has no such figure it has no cell here
   rather than an invented one.

   THEY DO NOT FETCH UNTIL THEY ARE PLACED. Fifteen attention cells share one
   request, so fetching for all of them costs nothing whether or not anybody
   added them. These are seventeen different endpoints, and a board that
   fired seventeen requests to render eight cells nobody asked for would be
   paying for the tray. `useLayout` already knows what somebody placed — the
   arrange layer reads the same store — so each query is gated on its own
   widget being on the board. An `optional` widget is on exactly when it has
   been placed. */
interface SetupStep {
  key: string
  label: string
  done: boolean
  blocking: boolean
}
interface SetupStatus {
  completed: number
  total: number
  blocking_remaining: number
  ready: boolean
  /* The fifteen steps themselves. Optional in the type only because the
     endpoint's shape is not this file's to guarantee; a response without them
     draws the ring and the rail and no field, rather than fifteen empty
     marks. */
  steps?: SetupStep[]
}
interface ShortageRow { pct: number }
interface WorkloadRow { weekly_periods: number }
/* One period an absence left behind. Only the fields this board draws are
   named; the substitution screen's own type is the full one. `starts_at` is
   `HH:MM` on the requested date, not a timestamp. */
interface CoverSlot {
  timetable_entry_id: string
  period: string
  period_sequence: number
  starts_at: string
  class_name: string
  subject: string
  covered_by?: string
}
interface SubstitutionBoard {
  items?: CoverSlot[]
  summary: { absent_teachers: number; periods: number; covered: number; uncovered: number; no_candidate: number }
}
interface TimetableOverview {
  summary: {
    sections: number
    sections_without_timetable: number
    required_periods: number
    live_periods: number
    live_unstaffed: number
    draft_periods: number
    open_drafts: number
  }
}
interface CoverageRow {
  class_name: string
  subject: string
  units: number
  delivered: number
  /** Whole percent, as the endpoint computes it. */
  percent: number
  behind: boolean
}
interface PaperRow { status: 'draft' | 'submitted' | 'approved' | 'changes_needed' }
interface ModerationRow {
  class: string
  subject: string
  entered: number
  absent: number
  failing: number
  /** A decimal on the wire, and null for a paper with no marks in it. */
  average_pct: string | null
  moderated_at: string | null
}
interface GrievanceRow {
  status: string
  category: string
  priority: string
  department?: string
  open_days: number
  resolved_at?: string
  overdue_hours?: number
}
interface CalendarEntry { name: string; starts_on: string; kind: string }
interface ExamRow { name: string; starts_on?: string; is_published: boolean }
interface SubjectPerformance {
  subject: string
  class_name: string
  entered: number
  average_percent?: number
  below_pass: number
  pass_rate?: number
}
interface PerformanceSummary {
  summary: { candidates: number; passed: number; pass_rate?: number; at_risk: number; papers: number }
  /* Every paper, uncut. The response's `at_risk` array is capped at fifty
     while `summary.at_risk` is not, so no drawing on this board is built from
     it — see `PassRateCell`. */
  by_subject?: SubjectPerformance[]
}
interface ThreadRow { unread: number }
interface Payslip {
  period_month: number
  period_year: number
  /** Paise, `bigint` on the wire. Never divided into a float for display. */
  gross_paise: number
  deduction_paise: number
  net_paise: number
}
interface LeaveBalance {
  leave_type: string
  entitled: string
  used: string
  remaining: string
}
interface MyPayView {
  /** Newest first, at most twenty-four. */
  payslips: Payslip[]
  leave_balances: LeaveBalance[]
}

/* One feature cell, with the same three states the attention cells keep apart
   and for the same reason: a fetch that failed must not be able to render as a
   nought, because a nought here reads as "nothing to do". */
function SourceCell({
  span,
  label,
  value,
  note,
  shape,
  accent,
  domain,
  to,
  cue,
  status,
}: {
  span: CellSpan
  label: string
  value: string | number
  note?: string
  shape?: ReactNode
  accent?: 'pink' | 'orange'
  domain?: string
  to?: string
  cue: string
  status: 'loading' | 'error' | 'ready'
}) {
  const t = useT()

  if (status === 'error') {
    return (
      <Cell span={span} domain={domain}>
        <p
          className="bento-label text-[10px] font-semibold uppercase leading-tight tracking-[0.14em]
                     text-[var(--bento-muted)]"
        >
          {label}
        </p>
        <div className="mt-4">
          <CellError message={t('bento.principal.source_failed')} />
        </div>
      </Cell>
    )
  }

  if (status === 'loading') {
    return (
      <StatCell
        span={span}
        domain={domain}
        label={label}
        value={t('bento.principal.source_pending')}
        note={t('bento.principal.source_loading')}
      />
    )
  }

  return (
    <StatCell
      span={span}
      domain={domain}
      label={label}
      value={value}
      accent={accent}
      shape={shape}
      note={note}
      to={to}
      cue={cue}
    />
  )
}

/* ─── THE SIZE-AWARE FEATURE CELLS ────────────────────────────────────────

   Eight of the cells below used to draw the same picture at every shape: a
   figure, one rail and a sentence, whether they had been given one column or
   four. The room was real; the drawing ignored it.

   Each component here reads `useWidgetSize` and switches on the SHAPE, the
   way `PulseCell` above does — `wide` and `tall` tested separately and never
   multiplied together, because 2x1 and 1x2 are not the same cell. One has the
   width for a strip and no height for a legend; the other has the reverse.

   THE RULES, which are the rules the figures themselves are held to:

   A PROPORTION NEEDS A REAL TOTAL. Every ring and every rail below divides by
   a number that arrived in the same response — `summary.candidates`,
   `rows.length`, `entitled`. Where a response carries no population, the
   extra room buys a DISTRIBUTION instead, which needs no whole to be true.

   NOTHING IS PADDED. A cell that has nothing more to say at 2x2 than it had
   at 2x1 draws the same thing twice. That is an honest answer, not a gap.

   THE THREE STATES STAY APART. Every one of these still renders through
   `SourceCell`, so a failed fetch draws an error and a fetch in flight draws
   a dash — a drawing can never appear in the place of a request that did not
   come back. */

type CellStatus = 'loading' | 'error' | 'ready'

/** Counts into fixed buckets, low to high, each bucket open above the one
    before it. `AgeBands` prints these labels under the bars, so they are held
    to six characters — a longer one collides with its neighbour at one
    column. */
function bandCounts(
  values: number[],
  edges: readonly { label: string; max: number }[],
): { label: string; value: number }[] {
  return edges.map((e, i) => ({
    label: e.label,
    value: values.filter((v) => v <= e.max && (i === 0 || v > edges[i - 1].max)).length,
  }))
}

/** Percent buckets, for the several responses that carry a percent per row
    and no population to divide by. Quarters, because a percent read off a
    dashboard is quoted to about that precision anyway. */
const PCT_BANDS = [
  { label: '0-25', max: 25 },
  { label: '26-50', max: 50 },
  { label: '51-75', max: 75 },
  { label: '76-100', max: Infinity },
] as const

/** Days-open buckets, in the shape a queue is actually read: today, this
    week, this month, older than that. */
const DAY_BANDS = [
  { label: '0-1', max: 1 },
  { label: '2-7', max: 7 },
  { label: '8-30', max: 30 },
  { label: '31+', max: Infinity },
] as const

/** How many cells a strip may carry before it stops being a chart. Past this
    the strip is cut and the cell's own sentence says it was cut — a silently
    truncated series is a lie about the size of the problem. */
const STRIP_MAX = 48

/** At most this many named slices before the tail is gathered up. Six greys
    is the point past which the legend is longer than the bar. */
const SEGMENT_MAX = 5

/** Two drawings in the one `shape` slot, spaced. */
function Stack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2.5">{children}</div>
}

/** Frequencies by a string key, commonest first, with the tail gathered into
    one named remainder rather than dropped. */
function topCounts<T>(
  rows: T[],
  key: (r: T) => string | undefined | null,
  otherLabel: string,
): { label: string; value: number }[] {
  const m = new Map<string, number>()
  for (const r of rows) {
    const k = key(r)
    if (!k) continue
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  const all = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (all.length <= SEGMENT_MAX) return all.map(([label, value]) => ({ label, value }))
  const head = all.slice(0, SEGMENT_MAX).map(([label, value]) => ({ label, value }))
  const rest = all.slice(SEGMENT_MAX).reduce((n, [, v]) => n + v, 0)
  return [...head, { label: otherLabel, value: rest }]
}

/** A field of small marks, one per thing, wrapped.

    For the two cells whose extra room is best spent showing the ITEMS rather
    than a summary of them: fifteen setup steps, or today's periods. Shape and
    a glyph carry the state, never the fill alone — a filled square is done, an
    outline is not, and an outline with an exclamation is not done AND
    blocking. Each mark keeps its own `title`; the series is stated once for a
    screen reader and the marks themselves are hidden from it, because fifteen
    announced squares is not a reading of anything. */
function DotField({
  items,
  srLabel,
}: {
  items: { key: string; title: string; filled: boolean; flag?: boolean }[]
  srLabel: string
}) {
  if (items.length === 0) return null
  return (
    <div role="img" aria-label={srLabel} className="flex flex-wrap gap-1">
      {items.map((it) => (
        <span
          key={it.key}
          title={it.title}
          aria-hidden="true"
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded-[3px] text-[9px] font-bold leading-none',
            it.filled
              ? 'bg-[var(--bento-ink)] text-[var(--bento-card)]'
              : 'border border-[var(--bento-line)] text-[var(--bento-muted)]',
          )}
        >
          {it.filled ? '✓' : it.flag ? '!' : ''}
        </span>
      ))}
    </div>
  )
}

/** One rail per named thing, each with its own real denominator printed. The
    long form of a `Meter`, for the tall narrow cell that has the height for a
    list and not the width for a chart. */
function RailList({
  rows,
}: {
  rows: { key: string; label: string; value: number; total: number; caption: string; srLabel: string }[]
}) {
  if (rows.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.key}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[11px] font-medium leading-snug">{r.label}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--bento-muted)]">
              {r.caption}
            </span>
          </div>
          <div className="mt-1">
            <Meter value={r.value} total={r.total} tone="success" srLabel={r.srLabel} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Syllabus coverage, drawn to fit.

    1x1  how many class-subjects are behind. A count, nothing else.
    2x1  the same over a rail against every class-subject in the response.
    1x2  the rail, then how the percentages are spread across the four
         quarters — which is the thing a count of "behind" hides: twelve
         subjects at 74% is a different school from twelve at 20%.
    2x2  the rail over the class-by-subject strip itself, one cell per pairing
         in the order the endpoint returned them. */
function SyllabusCell({
  span, rows, status, href,
}: {
  span: CellSpan
  rows: CoverageRow[]
  status: CellStatus
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2

  const behind = rows.filter((c) => c.behind).length
  const percents = rows.map((c) => c.percent).filter((p) => Number.isFinite(p))
  const shown = rows.slice(0, STRIP_MAX)

  const rail =
    rows.length > 0 ? (
      <Meter
        value={behind}
        total={rows.length}
        tone="warning"
        srLabel={t('bento.principal.syllabus_sr')}
      />
    ) : null

  let shape: ReactNode = null
  if (wide && tall) {
    shape = (
      <Stack>
        {rail}
        <HeatStrip
          cells={shown.map((c) => (Number.isFinite(c.percent) ? c.percent : null))}
          srLabel={t('bento.principal.syllabus_strip_sr', { count: shown.length })}
          formatValue={(v) => `${Math.round(v)}%`}
        />
      </Stack>
    )
  } else if (tall) {
    shape = (
      <Stack>
        {rail}
        <AgeBands
          bands={bandCounts(percents, PCT_BANDS)}
          srLabel={t('bento.principal.syllabus_bands_sr')}
        />
      </Stack>
    )
  } else if (wide) {
    shape = rail
  }

  return (
    <SourceCell
      span={span}
      domain="academics"
      status={status}
      label={t('bento.principal.syllabus')}
      value={behind}
      accent={behind > 0 ? 'orange' : undefined}
      shape={shape ?? undefined}
      note={
        wide && tall && rows.length > shown.length
          ? t('bento.principal.strip_capped', { shown: shown.length, total: rows.length })
          : t('bento.principal.syllabus_note', { count: rows.length })
      }
      to={href}
      cue={t('bento.principal.cue_syllabus')}
    />
  )
}

/** Mark moderation, drawn to fit.

    1x1  how many marked papers nobody has moderated yet.
    2x1  the same over the moderated share of every paper in the response.
    1x2  the rail, then how the papers' averages are spread — an unmoderated
         paper averaging 38% and one averaging 88% are the same count and
         very different problems.
    2x2  the rail over average against failures, paper by paper. The two
         numbers a moderator is actually weighing, and the outliers are the
         whole finding. */
function ModerationCell({
  span, rows, status, href,
}: {
  span: CellSpan
  rows: ModerationRow[]
  status: CellStatus
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2

  const unmoderated = rows.filter((m) => !m.moderated_at).length
  // `average_pct` arrives as a string, and as null for a paper with no marks
  // in it yet. Neither becomes a zero: a paper with no average is left out of
  // the drawing rather than plotted at the bottom of it.
  const avgOf = (m: ModerationRow) => {
    if (m.average_pct == null) return null
    const n = Number(m.average_pct)
    return Number.isFinite(n) ? n : null
  }
  const averages = rows.map(avgOf).filter((v): v is number => v !== null)

  const rail =
    rows.length > 0 ? (
      <Meter
        value={rows.length - unmoderated}
        total={rows.length}
        tone="success"
        srLabel={t('bento.principal.moderation_sr')}
      />
    ) : null

  let shape: ReactNode = null
  if (wide && tall) {
    const points = rows
      .map((m) => ({ x: avgOf(m), y: m.failing, label: `${m.class} ${m.subject}` }))
      .filter((p): p is { x: number; y: number; label: string } =>
        p.x !== null && Number.isFinite(p.y),
      )
    shape = (
      <Stack>
        {rail}
        <Quadrant
          points={points}
          xLabel={t('bento.principal.moderation_x')}
          yLabel={t('bento.principal.moderation_y')}
          srLabel={t('bento.principal.moderation_quadrant_sr')}
        />
      </Stack>
    )
  } else if (tall) {
    shape = (
      <Stack>
        {rail}
        <AgeBands
          bands={bandCounts(averages, PCT_BANDS)}
          srLabel={t('bento.principal.moderation_bands_sr')}
        />
      </Stack>
    )
  } else if (wide) {
    shape = rail
  }

  return (
    <SourceCell
      span={span}
      domain="reports"
      status={status}
      label={t('bento.principal.moderation')}
      value={unmoderated}
      shape={shape ?? undefined}
      note={t('bento.principal.moderation_note', { count: rows.length })}
      to={href}
      cue={t('bento.principal.cue_moderation')}
    />
  )
}

/** Board pass rate, drawn to fit.

    1x1  the rate.
    2x1  the rate over passed against candidates — the response's own
         population, not the length of any list.
    1x2  the rail, then how the per-paper pass rates are spread.
    2x2  the rail over the papers themselves, one cell each.

    THE TRUNCATION TRAP. `/exams/board/performance` returns at most fifty
    at-risk students while `summary.at_risk` counts all of them, so no drawing
    on this cell or the next is built from that list. Every figure and every
    mark here comes from `summary` or from `by_subject`, neither of which is
    cut. */
function PassRateCell({
  span, summary, subjects, status, href,
}: {
  span: CellSpan
  summary?: PerformanceSummary['summary']
  subjects: SubjectPerformance[]
  status: CellStatus
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2

  const rates = subjects
    .map((s) => s.pass_rate)
    .filter((v): v is number => v != null && Number.isFinite(v))
  const shown = subjects.slice(0, STRIP_MAX)

  const rail =
    summary && summary.candidates > 0 ? (
      <Meter
        value={summary.passed}
        total={summary.candidates}
        tone="success"
        srLabel={t('bento.principal.pass_rate_sr')}
      />
    ) : null

  let shape: ReactNode = null
  if (wide && tall) {
    shape = (
      <Stack>
        {rail}
        <HeatStrip
          cells={shown.map((s) => (s.pass_rate != null && Number.isFinite(s.pass_rate) ? s.pass_rate : null))}
          srLabel={t('bento.principal.pass_rate_strip_sr', { count: shown.length })}
          formatValue={(v) => `${Math.round(v)}%`}
        />
      </Stack>
    )
  } else if (tall) {
    shape = (
      <Stack>
        {rail}
        <AgeBands
          bands={bandCounts(rates, PCT_BANDS)}
          srLabel={t('bento.principal.pass_rate_bands_sr')}
        />
      </Stack>
    )
  } else if (wide) {
    shape = rail
  }

  return (
    <SourceCell
      span={span}
      domain="success"
      status={status}
      label={t('bento.principal.pass_rate')}
      value={summary?.pass_rate != null ? `${Math.round(summary.pass_rate)}%` : '—'}
      shape={shape ?? undefined}
      note={
        wide && tall && subjects.length > shown.length
          ? t('bento.principal.strip_capped', { shown: shown.length, total: subjects.length })
          : t('bento.principal.pass_rate_note', { count: summary?.candidates ?? 0 })
      }
      to={href}
      cue={t('bento.principal.cue_performance')}
    />
  )
}

/** Students at risk, drawn to fit.

    1x1  the count.
    2x1  the count over candidates, both off `summary`.
    1x2  the rail, then the spread of the papers' own averages.
    2x2  the rail over how many sat below the pass mark, paper by paper —
         where the risk is concentrated, which the single count cannot say.

    Nothing here reads the `at_risk` array: see `PassRateCell` for why. */
function AtRiskCell({
  span, summary, subjects, status, href,
}: {
  span: CellSpan
  summary?: PerformanceSummary['summary']
  subjects: SubjectPerformance[]
  status: CellStatus
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2

  const atRisk = summary?.at_risk ?? 0
  const averages = subjects
    .map((s) => s.average_percent)
    .filter((v): v is number => v != null && Number.isFinite(v))
  const shown = subjects.slice(0, STRIP_MAX)

  const rail =
    summary && summary.candidates > 0 ? (
      <Meter
        value={atRisk}
        total={summary.candidates}
        tone="warning"
        srLabel={t('bento.principal.at_risk_sr')}
      />
    ) : null

  let shape: ReactNode = null
  if (wide && tall) {
    shape = (
      <Stack>
        {rail}
        <HeatStrip
          cells={shown.map((s) => (Number.isFinite(s.below_pass) ? s.below_pass : null))}
          srLabel={t('bento.principal.at_risk_strip_sr', { count: shown.length })}
        />
      </Stack>
    )
  } else if (tall) {
    shape = (
      <Stack>
        {rail}
        <AgeBands
          bands={bandCounts(averages, PCT_BANDS)}
          srLabel={t('bento.principal.at_risk_bands_sr')}
        />
      </Stack>
    )
  } else if (wide) {
    shape = rail
  }

  return (
    <SourceCell
      span={span}
      domain="students"
      status={status}
      label={t('bento.principal.at_risk')}
      value={atRisk}
      accent={atRisk > 0 ? 'orange' : undefined}
      shape={shape ?? undefined}
      note={
        wide && tall && subjects.length > shown.length
          ? t('bento.principal.strip_capped', { shown: shown.length, total: subjects.length })
          : t('bento.principal.at_risk_note', { count: summary?.candidates ?? 0 })
      }
      to={href}
      cue={t('bento.principal.cue_at_risk')}
    />
  )
}

/** The open grievance queue, drawn to fit.

    THERE IS NO POPULATION HERE, so there is no rail at any size: the queue is
    every ticket ever raised and "open as a share of all time" is not a
    number anybody wants. What the room buys instead is composition and age,
    both of which are true without a denominator.

    1x1  how many are open.
    2x1  what they are about, as shares of the open queue.
    1x2  how long they have been open.
    2x2  both, plus which department owns which category. */
function GrievancesOpenCell({
  span, open, queued, status, href,
}: {
  span: CellSpan
  open: GrievanceRow[]
  queued: number
  status: CellStatus
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2

  const other = t('bento.principal.other_slice')
  const byCategory = topCounts(open, (g) => g.category, other)
  const ages = (
    <AgeBands
      bands={bandCounts(open.map((g) => g.open_days), DAY_BANDS)}
      srLabel={t('bento.principal.grievances_age_sr')}
    />
  )
  const categories = (
    <SegmentBar
      segments={byCategory}
      srLabel={t('bento.principal.grievances_cat_sr')}
    />
  )

  /* Department against category, as one strip of counts. Only the pairings
     that actually occur are drawn — a grid of mostly-zero cells reads as a
     school with a problem in every department. */
  const pairs: { label: string; value: number }[] = []
  const seen = new Map<string, number>()
  for (const g of open) {
    const key = `${g.department ?? t('bento.principal.no_department')} · ${g.category}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  for (const [label, value] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
    pairs.push({ label, value })
  }
  const shownPairs = pairs.slice(0, STRIP_MAX)

  let shape: ReactNode = null
  if (wide && tall) {
    shape = (
      <Stack>
        {categories}
        <HeatStrip
          cells={shownPairs.map((p) => p.value)}
          srLabel={t('bento.principal.grievances_dept_sr', {
            pairs: shownPairs.map((p) => `${p.label} ${p.value}`).join(', '),
          })}
        />
      </Stack>
    )
  } else if (tall) {
    shape = ages
  } else if (wide) {
    shape = categories
  }

  return (
    <SourceCell
      span={span}
      domain="communication"
      status={status}
      label={t('bento.principal.grievances')}
      value={open.length}
      shape={shape ?? undefined}
      note={t('bento.principal.grievances_note', { count: queued })}
      to={href}
      cue={t('bento.principal.cue_grievances')}
    />
  )
}

/** The overdue slice of that queue, drawn to fit.

    This one DOES have a denominator — the open queue itself, which is in the
    same response — so the rail is real.

    1x1  how many are past their deadline.
    2x1  the same over the open queue.
    1x2  the rail, then how long the overdue ones have been open.
    2x2  the rail, then which departments they are sitting in. */
function GrievancesOverdueCell({
  span, open, status, href,
}: {
  span: CellSpan
  open: GrievanceRow[]
  status: CellStatus
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2

  const late = open.filter((g) => (g.overdue_hours ?? 0) > 0)

  const rail =
    open.length > 0 ? (
      <Meter
        value={late.length}
        total={open.length}
        tone="destructive"
        srLabel={t('bento.principal.grievances_late_sr')}
      />
    ) : null

  let shape: ReactNode = null
  if (wide && tall) {
    shape = (
      <Stack>
        {rail}
        <SegmentBar
          segments={topCounts(late, (g) => g.department, t('bento.principal.no_department'))}
          srLabel={t('bento.principal.grievances_late_dept_sr')}
        />
      </Stack>
    )
  } else if (tall) {
    shape = (
      <Stack>
        {rail}
        <AgeBands
          bands={bandCounts(late.map((g) => g.open_days), DAY_BANDS)}
          srLabel={t('bento.principal.grievances_late_age_sr')}
        />
      </Stack>
    )
  } else if (wide) {
    shape = rail
  }

  return (
    <SourceCell
      span={span}
      domain="communication"
      status={status}
      label={t('bento.principal.grievances_late')}
      value={late.length}
      accent={late.length > 0 ? 'pink' : undefined}
      shape={shape ?? undefined}
      note={t('bento.principal.grievances_late_note', { count: open.length })}
      to={href}
      cue={t('bento.principal.cue_grievances')}
    />
  )
}

/** My leave, drawn to fit.

    The one cell on this board with a denominator somebody actually signed:
    `entitled` is what the school granted, and `remaining` is what is left of
    it. Both come off `/me/pay` as strings and are read as numbers here.

    1x1  the ring — days left as a share of days granted.
    2x1  the same as a rail, which reads faster in a wide short cell.
    1x2  one rail per leave type, each against its own entitlement, because
         eleven days left means nothing until you know which eleven.
    2x2  the ring over the per-type rails. */
function MyLeaveCell({
  span, balances, status, href,
}: {
  span: CellSpan
  balances: LeaveBalance[]
  status: CellStatus
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2

  const num = (v: string | number | undefined) => {
    const n = Number(v ?? 0)
    return Number.isFinite(n) ? n : 0
  }
  const remaining = balances.reduce((n, b) => n + num(b.remaining), 0)
  const entitled = balances.reduce((n, b) => n + num(b.entitled), 0)

  const ring = (
    <Ring value={remaining} total={entitled} srLabel={t('bento.principal.my_leave_sr')} />
  )
  const rail =
    entitled > 0 ? (
      <Meter
        value={remaining}
        total={entitled}
        tone="success"
        srLabel={t('bento.principal.my_leave_sr')}
      />
    ) : null
  const perType = (
    <RailList
      rows={balances
        .filter((b) => num(b.entitled) > 0)
        .map((b) => ({
          key: b.leave_type,
          label: b.leave_type,
          value: num(b.remaining),
          total: num(b.entitled),
          caption: `${num(b.remaining)}/${num(b.entitled)}`,
          srLabel: t('bento.principal.my_leave_type_sr', { type: b.leave_type }),
        }))}
    />
  )

  let shape: ReactNode
  if (wide && tall) shape = <Stack>{ring}{perType}</Stack>
  else if (tall) shape = perType
  else if (wide) shape = rail
  else shape = ring

  return (
    <SourceCell
      span={span}
      domain="staff"
      status={status}
      label={t('bento.principal.my_leave')}
      value={remaining}
      shape={shape ?? undefined}
      note={t('bento.principal.my_leave_note', { count: balances.length })}
      to={href}
      cue={t('bento.principal.cue_my_leave')}
    />
  )
}

/** My pay, drawn to fit.

    Paise are `bigint` on the wire and are never divided into a float for
    display — `formatPaise` prints every figure below. The sparkline plots the
    raw paise, which is a position on a chart and not a printed number.

    1x1  the last net figure.
    2x1  up to two years of net pay as a line: the one thing a payslip cannot
         tell you is whether it is normal.
    1x2  where the last gross went — what was paid and what was withheld,
         which sum to gross exactly because the response says they do.
    2x2  both. */
function MyPayCell({
  span, payslips, status, href,
}: {
  span: CellSpan
  payslips: Payslip[]
  status: CellStatus
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2

  // Oldest first, so the line reads left to right in time. The response's own
  // order is newest first, which would draw the trend backwards.
  const chrono = [...payslips].sort(
    (a, b) => a.period_year - b.period_year || a.period_month - b.period_month,
  )
  const latest = payslips[0]

  const line =
    chrono.length > 1 ? (
      <Sparkline
        points={chrono.map((p) => Number(p.net_paise))}
        srLabel={t('bento.principal.my_pay_trend_sr', { count: chrono.length })}
      />
    ) : null
  const split = latest ? (
    <SegmentBar
      segments={[
        { label: t('bento.principal.my_pay_net'), value: Number(latest.net_paise) },
        { label: t('bento.principal.my_pay_deducted'), value: Number(latest.deduction_paise) },
      ]}
      srLabel={t('bento.principal.my_pay_split_sr', {
        gross: formatPaise(Number(latest.gross_paise)),
        deduction: formatPaise(Number(latest.deduction_paise)),
      })}
    />
  ) : null

  let shape: ReactNode = null
  if (wide && tall) shape = <Stack>{line}{split}</Stack>
  else if (tall) shape = split
  else if (wide) shape = line

  const note = latest
    ? tall
      ? t('bento.principal.my_pay_gross_note', {
          gross: formatPaise(Number(latest.gross_paise)),
          month: latest.period_month,
          year: latest.period_year,
        })
      : t('bento.principal.my_pay_note', { month: latest.period_month, year: latest.period_year })
    : t('bento.principal.my_pay_none')

  return (
    <SourceCell
      span={span}
      domain="finance"
      status={status}
      label={t('bento.principal.my_pay')}
      value={latest ? formatPaise(Number(latest.net_paise)) : '—'}
      shape={shape ?? undefined}
      note={note}
      to={href}
      cue={t('bento.principal.cue_my_pay')}
    />
  )
}

/** The setup checklist, drawn to fit.

    1x1  the ring: steps done over steps there are.
    2x1  the same as a rail.
    1x2  the rail over the fifteen steps themselves, each one's own mark, the
         blocking ones that are still outstanding flagged.
    2x2  the ring over that field. */
function SetupCell({
  span, data, status, href,
}: {
  span: CellSpan
  data?: SetupStatus
  status: CellStatus
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2

  const steps = data?.steps ?? []
  const ring = data ? (
    <Ring value={data.completed} total={data.total} srLabel={t('bento.principal.setup_sr')} />
  ) : null
  const rail = data ? (
    <Meter
      value={data.completed}
      total={data.total}
      tone="success"
      srLabel={t('bento.principal.setup_sr')}
    />
  ) : null
  const field = (
    <DotField
      items={steps.map((s) => ({
        key: s.key,
        title: s.blocking && !s.done ? `${s.label} — ${t('bento.principal.setup_blocking')}` : s.label,
        filled: s.done,
        flag: s.blocking,
      }))}
      srLabel={t('bento.principal.setup_field_sr', {
        done: steps.filter((s) => s.done).map((s) => s.label).join(', ') || '—',
        todo: steps.filter((s) => !s.done).map((s) => s.label).join(', ') || '—',
      })}
    />
  )

  let shape: ReactNode
  if (wide && tall) shape = <Stack>{ring}{field}</Stack>
  else if (tall) shape = <Stack>{rail}{field}</Stack>
  else if (wide) shape = rail
  else shape = ring

  return (
    <SourceCell
      span={span}
      domain="operations"
      status={status}
      label={t('bento.principal.setup')}
      value={data ? `${data.completed}/${data.total}` : 0}
      shape={shape ?? undefined}
      note={t('bento.principal.setup_note', { count: data?.blocking_remaining ?? 0 })}
      to={href}
      cue={t('bento.principal.cue_setup')}
    />
  )
}

/** Today's cover, drawn to fit.

    The three-way split is the finding this cell exists for: a period nobody
    covered and a period nobody COULD cover are the same red on a summary and
    two different mornings for whoever has to fix them.

    1x1  how many periods are uncovered.
    2x1  covered, uncovered, and uncoverable as shares of the periods the
         absences left — the endpoint's own `summary.periods`.
    1x2  the covered rail over today's periods themselves, in sequence, the
         uncovered ones marked.
    2x2  the split over when in the day the uncovered periods fall, on the
         real clock times the board returned. */
function CoverCell({
  span, summary, slots, onDate, status, href,
}: {
  span: CellSpan
  summary?: SubstitutionBoard['summary']
  slots: CoverSlot[]
  onDate: string
  status: CellStatus
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2

  const uncovered = summary?.uncovered ?? 0
  const noCandidate = summary?.no_candidate ?? 0
  /* `uncovered` already contains `no_candidate`, so the two are not added:
     the middle slice is the difference, clamped, and the three then sum to
     `periods` exactly as the response reports them. */
  const openWithCandidates = Math.max(0, uncovered - noCandidate)

  const split = summary ? (
    <SegmentBar
      segments={[
        { label: t('bento.principal.cover_covered'), value: summary.covered },
        { label: t('bento.principal.cover_open'), value: openWithCandidates },
        { label: t('bento.principal.cover_stuck'), value: noCandidate },
      ]}
      srLabel={t('bento.principal.cover_split_sr')}
    />
  ) : null
  const rail =
    summary && summary.periods > 0 ? (
      <Meter
        value={summary.covered}
        total={summary.periods}
        tone="success"
        srLabel={t('bento.principal.cover_sr')}
      />
    ) : null

  const ordered = [...slots].sort((a, b) => a.period_sequence - b.period_sequence)
  const field = (
    <DotField
      items={ordered.map((s, i) => ({
        key: `${s.timetable_entry_id}-${i}`,
        title: `${s.period} · ${s.class_name} ${s.subject} — ${
          s.covered_by ?? t('bento.principal.cover_open')
        }`,
        filled: Boolean(s.covered_by),
        flag: !s.covered_by,
      }))}
      srLabel={t('bento.principal.cover_field_sr', { count: ordered.length })}
    />
  )

  /* The clock times are `HH:MM` on the board's own date; they are joined back
     onto that date rather than parsed alone, which would land every period in
     1970 and collapse the window. */
  const stamped = ordered
    .filter((s) => !s.covered_by && /^\d{2}:\d{2}$/.test(s.starts_at))
    .map((s) => ({ label: `${s.class_name} ${s.subject}`, date: `${onDate}T${s.starts_at}:00` }))
  const dayFrom = ordered.find((s) => /^\d{2}:\d{2}$/.test(s.starts_at))?.starts_at
  const dayTo = [...ordered].reverse().find((s) => /^\d{2}:\d{2}$/.test(s.starts_at))?.starts_at

  let shape: ReactNode = null
  if (wide && tall) {
    shape = (
      <Stack>
        {split}
        {dayFrom && dayTo && dayFrom !== dayTo ? (
          <Timeline
            events={stamped}
            from={`${onDate}T${dayFrom}:00`}
            to={`${onDate}T${dayTo}:00`}
            srLabel={t('bento.principal.cover_timeline_sr', { count: stamped.length })}
          />
        ) : null}
      </Stack>
    )
  } else if (tall) {
    shape = <Stack>{rail}{field}</Stack>
  } else if (wide) {
    shape = split
  }

  return (
    <SourceCell
      span={span}
      domain="academics"
      status={status}
      label={t('bento.principal.cover')}
      value={uncovered}
      accent={uncovered > 0 ? 'pink' : undefined}
      shape={shape ?? undefined}
      note={t('bento.principal.cover_note', {
        covered: summary?.covered ?? 0,
        periods: summary?.periods ?? 0,
      })}
      to={href}
      cue={t('bento.principal.cue_cover')}
    />
  )
}

/** Attendance, drawn to fit.

    1x1  the figure, and whether today sits above or below its own 30-day
         median. A trend line at this width is a squiggle, not a chart.
    2x1  the figure and the line: width is exactly what a sparkline needs.
    1x2  the figure and the line stacked, with the supporting sentence back.
    2x2  all of that over the month-of-days calendar.

    The median comparison is computed from the series this cell already holds.
    It is a real statement about a real number, not a target invented to give
    the card something to say. Under two points there is no median worth the
    name and the mark is not drawn. */
function PulseCell({
  span, pct, marked, points, days, trendError, href,
}: {
  span: CellSpan
  pct: number
  marked: number
  points: number[]
  days: (number | null)[]
  trendError: boolean
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()

  const sorted = [...points].sort((a, b) => a - b)
  const median = sorted.length > 1
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : null
  const above = median === null ? null : pct >= median

  const wide = w >= 2
  const tall = h >= 2
  const showLine = (wide || tall) && !trendError && points.length > 1

  return (
    <Cell
      span={span}
      domain="students"
      /* The calendar earns its keep only at the full 2x2; below that it is
         texture rather than information. Empty when the trend query failed,
         because a grid of unmarked days is a statement about the school and
         not about the request. */
      art={wide && tall && days.length > 0 ? <CalendarDensityArt slots={days} /> : undefined}
    >
      <p
        className="bento-label text-[10px] font-semibold uppercase leading-tight tracking-[0.14em]
                   text-[var(--bento-muted)]"
      >
        {t('bento.principal.anchor_label')}
      </p>

      <div className="mt-2 flex items-baseline gap-2">
        <p
          className="font-extrabold leading-[0.95] tracking-[-0.035em] tabular-nums
                     text-[length:var(--bento-fig,clamp(26px,3.6vh,40px))]"
        >
          {pct}%
        </p>
        {/* The small cell's entire chart. A glyph as well as a position, so
            colour is not the only channel, and the reading is spelled out
            rather than left to the shape. */}
        {above !== null && !showLine && (
          <span className="text-[12px] font-semibold leading-none text-[var(--bento-muted)]">
            <span aria-hidden="true">{above ? '\u25b2' : '\u25bc'}</span>
            <span className="sr-only">
              {t(above ? 'bento.principal.above_median' : 'bento.principal.below_median')}
            </span>
          </span>
        )}
      </div>

      {(wide || tall) && (
        <p className="bento-note mt-1.5 text-[11px] leading-snug text-[var(--bento-muted)]">
          {t('bento.principal.attendance_marked', { count: marked })}
        </p>
      )}

      {trendError && (wide || tall) ? (
        <div className="mt-3">
          <CellError message={t('bento.principal.trend_failed')} />
        </div>
      ) : showLine ? (
        <div className="bento-shape mt-3">
          <Sparkline points={points} srLabel={t('bento.principal.trend_sr')} />
        </div>
      ) : null}

      {href && <Cue to={href} label={t('bento.principal.cue_attendance')} />}
    </Cell>
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

  /* The feature widgets' data. One query each, none of them asked for until
     its own cell is on the board. `useLayout` is the same store the arrange
     layer reads; an optional widget is on exactly when it has been placed. */
  const { layout } = useLayout('principal')
  const placed = (id: string) => layout.placed.some((p) => p.id === id)

  const setup = useQuery({
    queryKey: ['setup-status', null],
    queryFn: () => api.get<SetupStatus>('/api/v1/setup/status'),
    enabled: placed('setup-progress'),
  })
  // 75 is the endpoint's own default — the board eligibility line most Indian
  // boards use — and the label says so rather than leaving the reader to guess
  // what "short" means.
  const shortage = useQuery({
    queryKey: ['attendance-shortage', 75],
    queryFn: () => api.get<List<ShortageRow>>('/api/v1/principal/attendance-shortage?threshold=75'),
    enabled: placed('attendance-shortage'),
  })
  const workload = useQuery({
    queryKey: ['staff-workload'],
    queryFn: () => api.get<List<WorkloadRow>>('/api/v1/principal/staff-workload'),
    enabled: placed('staff-unallocated'),
  })
  /* Today's cover. The date is built the way the substitution board itself
     builds it, so the two share a cache entry rather than asking twice for the
     same day. */
  const coverDate = new Date().toISOString().slice(0, 10)
  const cover = useQuery({
    queryKey: ['substitution-board', coverDate],
    queryFn: () =>
      api.get<SubstitutionBoard>(
        `/api/v1/academics/admin/substitution-board?on_date=${coverDate}`,
      ),
    enabled: placed('cover-uncovered'),
  })
  const timetable = useQuery({
    queryKey: ['master-timetable', 'overview'],
    queryFn: () => api.get<TimetableOverview>('/api/v1/master-timetable/overview'),
    enabled: placed('timetable-sections') || placed('timetable-unstaffed'),
  })
  const coverage = useQuery({
    queryKey: ['syllabus-coverage'],
    queryFn: () => api.get<List<CoverageRow>>('/api/v1/syllabus/coverage'),
    enabled: placed('syllabus-behind'),
  })
  const plans = useQuery({
    queryKey: ['lesson-plans', 'submitted'],
    queryFn: () => api.get<List<unknown>>('/api/v1/syllabus/lesson-plans?status=submitted'),
    enabled: placed('lesson-plans'),
  })
  const papers = useQuery({
    queryKey: ['question-papers'],
    queryFn: () => api.get<{ items: PaperRow[] }>('/api/v1/exams/question-papers'),
    enabled: placed('question-papers'),
  })
  const moderation = useQuery({
    queryKey: ['mark-moderation'],
    queryFn: () => api.get<{ items: ModerationRow[] }>('/api/v1/exams/moderation'),
    enabled: placed('mark-moderation'),
  })
  /* The whole queue, unfiltered, and the two figures counted here rather than
     asked for twice: the server's own filters would need one request for the
     open ones and another for the overdue ones, and the overdue ones are a
     subset of what the first request already returned. */
  const grievances = useQuery({
    queryKey: ['comms', 'grievances', 'list', '', '', false],
    queryFn: () => api.get<List<GrievanceRow>>('/api/v1/comms/grievances/?status=&category=&overdue='),
    enabled: placed('grievances-open') || placed('grievances-overdue'),
  })
  const calendar = useQuery({
    queryKey: ['admin-calendar', ''],
    queryFn: () => api.get<{ items: CalendarEntry[] }>('/api/v1/academics/admin/calendar'),
    enabled: placed('calendar-next'),
  })
  const exams = useQuery({
    queryKey: ['exams-list'],
    queryFn: () => api.get<List<ExamRow>>('/api/v1/exams/list'),
    enabled: placed('exams-upcoming'),
  })
  /* Unfiltered, which is what the performance screen itself opens on: every
     exam of the year, not one. The note says so, because a pass rate with no
     stated population is the kind of number somebody quotes in a meeting. */
  const performance = useQuery({
    queryKey: ['board-performance', '', ''],
    queryFn: () => api.get<PerformanceSummary>('/api/v1/exams/board/performance'),
    enabled: placed('pass-rate') || placed('at-risk'),
  })
  const threads = useQuery({
    queryKey: ['staff-threads'],
    queryFn: () => api.get<List<ThreadRow>>('/api/v1/staff-messages/threads'),
    enabled: placed('staff-messages'),
  })
  const myPay = useQuery({
    queryKey: ['my-pay'],
    queryFn: () => api.get<MyPayView>('/api/v1/me/pay'),
    enabled: placed('my-pay') || placed('my-leave'),
  })
  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<{ id: string }>>('/api/v1/academics/classes'),
    enabled: placed('classes'),
  })

  // Every cue is checked against the catalogue before it is drawn: a link to a
  // screen this account cannot open is worse than no link.
  const attendanceHref = useFeatureHref('institution_admin.standard.attendance_overview')
  const feesHref = useFeatureHref('institution_admin.standard.fee_collection')
  const defaultersHref = useFeatureHref('institution_admin.fees.fee_default')
  /* Both of these used to name catalogue keys that do not exist —
     `students.enrollment_lifecycle` and `directory_workload.faculty_directory`.
     `useFeatureHref` answers `undefined` for a key it cannot find, and a cell
     with no href renders no cue, so the two cells sat there with no way out of
     them and nothing said so. These are the real keys nearest what each cell
     is counting. */
  const studentsHref = useFeatureHref('institution_admin.students.student_360')
  const staffHref = useFeatureHref('institution_admin.staff.leaves_subs')
  const applicationsHref = useFeatureHref('institution_admin.admissions.admissions_pipeline')
  const subjectsHref = useFeatureHref('institution_admin.academics.teacher_assignment')
  const approvalsHref = useFeatureHref('institution_admin.approvals.approvals')
  // Three more destinations the attention cells need and the KPI cells did
  // not. Same rule: the catalogue decides, and an unusable feature simply
  // leaves that cell without a cue rather than offering a door that is locked.
  const leavesHref = useFeatureHref(ATTENTION_TARGETS.staff)
  const paymentsHref = useFeatureHref(ATTENTION_TARGETS.payments)
  const resultsHref = useFeatureHref(ATTENTION_TARGETS.marks)

  /* The feature widgets' destinations. Same rule again: the catalogue decides,
     and a feature this account cannot open leaves its cell without a cue
     rather than offering a locked door. */
  const setupHref = useFeatureHref('institution_admin.getting_started.school_setup')
  const auditHref = useFeatureHref('institution_admin.academics.attendance_audit')
  const substitutionsHref = useFeatureHref('institution_admin.academics.substitutions')
  const timetableHref = useFeatureHref('institution_admin.academics.master_timetable')
  const syllabusHref = useFeatureHref('institution_admin.academics.syllabus_progress')
  const lessonPlansHref = useFeatureHref('institution_admin.academics.lesson_plans')
  const questionPapersHref = useFeatureHref('institution_admin.exams.question_paper_approval')
  const moderationHref = useFeatureHref('institution_admin.exams.mark_moderation')
  const grievancesHref = useFeatureHref('institution_admin.communication.grievances')
  const calendarHref = useFeatureHref('institution_admin.academics.school_calendar')
  const examsHref = useFeatureHref('institution_admin.examinations.exams_papers')
  const performanceHref = useFeatureHref('institution_admin.examinations.performance_overview')
  const academicPerformanceHref = useFeatureHref('institution_admin.students.academic_performance')
  const messagesHref = useFeatureHref('institution_admin.communication.messages')
  const myPayHref = useFeatureHref('institution_admin.my_profile.my_pay')
  const myLeaveHref = useFeatureHref('institution_admin.my_profile.leave_self_service')
  const classSetupHref = useFeatureHref('institution_admin.academics.class_setup')

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
  /* Billed comes from the handler, which returns it for exactly this reason.
     It used to be derived as collected + outstanding — a period flow added to
     an all-years level, which the Go comment at role_principal.go:28-40
     explicitly warns against. Every figure below is drawn against a base the
     backend said was wrong, under a caption that says "this year". */
  /* Prefer the year trio, fall back to the unqualified measures.

     The trio is scoped to `academic_year_id = (the current year)`, and on a
     school whose invoices were never tied to an academic year every one of the
     three comes back 0 — COALESCEd, so it looks like a real zero rather than a
     missing answer. This board showed a school with 270 invoices ₹0 collected
     for exactly that reason.

     So: if there IS a billed figure for the year, use the year trio and say
     "this year", because that is the honest framing and the only one with a
     real denominator. If there is not, fall back to the measures that are
     always populated — receipts banked in the range, and arrears of every
     year — drop the "this year" wording, and draw NO rail, because neither has
     a denominator and the old code invented one by adding them together. */
  const yearly = k.billed_paise > 0
  const billed = k.billed_paise
  const collected = yearly ? k.collected_year_paise : k.collected_paise
  const outstanding = yearly ? k.outstanding_year_paise : k.outstanding_paise
  const collectedPct = yearly ? Math.round((k.collected_year_paise / billed) * 100) : 0
  const outstandingPct = yearly ? Math.round((k.outstanding_year_paise / billed) * 100) : 0
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
  const movedShare = yearly ? k.collected_year_paise / billed : 0
  const loadPerTeacher = k.staff > 0 ? Math.round(k.students / k.staff) : 0



  /* The feature widgets' figures. Each one is counted off the response it came
     in, and each denominator is a number in that same response — never one
     this file decided would be reasonable. */
  const stateOf = (q: { error: unknown; data: unknown }): 'loading' | 'error' | 'ready' =>
    q.error ? 'error' : q.data === undefined ? 'loading' : 'ready'

  const setupData = setup.data
  const shortageRows = shortage.data?.items ?? []
  // The endpoint returns at most a hundred. A hundred is therefore a floor,
  // not a count, and the cell says so rather than printing 100 as though the
  // hundred-and-first child did not exist.
  const shortageCapped = shortageRows.length >= 100
  const workloadRows = workload.data?.items ?? []
  const unallocated = workloadRows.filter((s) => s.weekly_periods === 0).length
  const coverSummary = cover.data?.summary
  const ttSummary = timetable.data?.summary
  const coverageRows = coverage.data?.items ?? []
  const paperRows = papers.data?.items ?? []
  const papersWaiting = paperRows.filter((p) => p.status === 'submitted').length
  const moderationRows = moderation.data?.items ?? []
  const grievanceRows = grievances.data?.items ?? []
  const grievancesOpen = grievanceRows.filter((g) => !g.resolved_at)
  /* The year's calendar, forward of today. The comparison is on the ISO string
     rather than through `new Date`, for the reason the bar labels are sliced
     rather than parsed: a Date would move the school's dates by a day for
     anyone whose browser is not in India. */
  const todayISO = coverDate
  const upcoming = (calendar.data?.items ?? [])
    .filter((e) => e.starts_on >= todayISO)
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on))
  const nextEntry = upcoming[0]
  const examRows = exams.data?.items ?? []
  const examsUpcoming = examRows.filter((e) => e.starts_on && e.starts_on >= todayISO).length
  const perf = performance.data?.summary
  const bySubject = performance.data?.by_subject ?? []
  const unread = (threads.data?.items ?? []).reduce((n, t2) => n + t2.unread, 0)
  const balances = myPay.data?.leave_balances ?? []
  const classCount = classes.data?.items.length ?? 0

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
      {/* The reference implementation of shape dispatch.

          `detailFor` collapses on AREA, so 2x1 and 1x2 get the same answer —
          and they are not the same cell: one has width for a trend line and no
          height, the other the reverse. A cell that should change DRAWING
          rather than shed parts reads `useWidgetSize` and switches on the
          shape itself. */}
      <Widget id="pulse" label={t('bento.principal.anchor_label')} size="large" index={0}>
        {(span) => (
          <PulseCell
            span={span}
            pct={k.attendance_today_pct}
            marked={k.attendance_marked_today}
            points={points}
            days={days}
            trendError={Boolean(trend.error)}
            href={attendanceHref}
          />
        )}
      </Widget>

      {/* Money out — pink, and pink is used for nothing else on this page. */}
      <Widget id="outstanding" label={t('bento.principal.outstanding')} size="small" index={2}>
        {(span) => (
          <StatCell
            span={span}
            domain="finance"
            label={t(yearly ? 'bento.principal.outstanding' : 'bento.principal.outstanding_plain')}
            value={formatPaise(outstanding)}
            badge={yearly ? t('bento.principal.pct_of_billed', { pct: outstandingPct }) : undefined}
            art={<BlockedFlowArt moved={movedShare} />}
            /* Meter and note only when there is a year to measure against.
               Without one this drew a bar and a sentence about a total that
               was zero. */
            shape={
              yearly ? (
                <Meter
                  value={outstanding}
                  total={billed}
                  tone="destructive"
                  srLabel={t('bento.principal.outstanding_sr')}
                />
              ) : undefined
            }
            note={yearly ? t('bento.principal.of_billed', { billed: formatPaise(billed) }) : undefined}
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
      {/* Money in. This cell drew BARS of the attendance series — the same
          figures the anchor already sparklines — while the collected total had
          no cell of its own and was riding along inside the anchor, which is
          how one card ended up carrying two unrelated stats. The subject moves
          here; the id does not, because ids are persisted in saved layouts and
          renaming one silently drops somebody's arrangement. */}
      <Widget id="trend" label={t('bento.principal.collected_label')} size="medium" index={1}>
        {(span) => (
          <Cell span={span} domain="finance">
            <p
              className="bento-label text-[10px] font-semibold uppercase leading-tight tracking-[0.14em]
                         text-[var(--bento-muted)]"
            >
              {t(yearly ? 'bento.principal.collected_label' : 'bento.principal.collected_plain')}
            </p>
            <p
              className="mt-2 font-extrabold leading-[0.95] tracking-[-0.035em] tabular-nums
                         text-[length:var(--bento-fig,clamp(26px,3.6vh,40px))]"
            >
              {formatPaise(collected)}
            </p>
            {yearly && (
              <>
                <div className="mt-3">
                  <Meter
                    value={collected}
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
              </>
            )}
            {feesHref && <Cue to={feesHref} label={t('bento.principal.cue_fees')} />}
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

      {/* THE FEATURE CELLS — every principal screen that has a real figure
          behind it, as a cell somebody can add. All `optional`, all 1x1, and
          all numbered after the attention block so that adding them renumbers
          nothing anybody has already arranged. */}

      <Widget id="setup-progress" label={t('bento.principal.setup')} size="small" index={24} optional>
        {(span) => (
          <SetupCell span={span} data={setupData} status={stateOf(setup)} href={setupHref} />
        )}
      </Widget>

      <Widget
        id="attendance-shortage"
        label={t('bento.principal.shortage')}
        size="small"
        index={25}
        optional
      >
        {(span) => (
          <SourceCell
            span={span}
            domain="attendance"
            status={stateOf(shortage)}
            label={t('bento.principal.shortage')}
            value={shortageCapped ? '100+' : shortageRows.length}
            accent={shortageRows.length > 0 ? 'orange' : undefined}
            note={t('bento.principal.shortage_note')}
            to={auditHref}
            cue={t('bento.principal.cue_shortage')}
          />
        )}
      </Widget>

      <Widget
        id="staff-unallocated"
        label={t('bento.principal.unallocated')}
        size="small"
        index={26}
        optional
      >
        {(span) => (
          <SourceCell
            span={span}
            domain="staff"
            status={stateOf(workload)}
            label={t('bento.principal.unallocated')}
            value={unallocated}
            shape={
              workloadRows.length > 0 ? (
                <Meter
                  value={unallocated}
                  total={workloadRows.length}
                  tone="warning"
                  srLabel={t('bento.principal.unallocated_sr')}
                />
              ) : undefined
            }
            note={t('bento.principal.unallocated_note', { count: workloadRows.length })}
            to={subjectsHref}
            cue={t('bento.principal.cue_unassigned')}
          />
        )}
      </Widget>

      <Widget id="cover-uncovered" label={t('bento.principal.cover')} size="small" index={27} optional>
        {(span) => (
          <CoverCell
            span={span}
            summary={coverSummary}
            slots={cover.data?.items ?? []}
            onDate={coverDate}
            status={stateOf(cover)}
            href={substitutionsHref}
          />
        )}
      </Widget>

      <Widget
        id="timetable-sections"
        label={t('bento.principal.tt_sections')}
        size="small"
        index={28}
        optional
      >
        {(span) => (
          <SourceCell
            span={span}
            domain="academics"
            status={stateOf(timetable)}
            label={t('bento.principal.tt_sections')}
            value={ttSummary?.sections_without_timetable ?? 0}
            accent={(ttSummary?.sections_without_timetable ?? 0) > 0 ? 'orange' : undefined}
            shape={
              ttSummary && ttSummary.sections > 0 ? (
                <Meter
                  value={ttSummary.sections_without_timetable}
                  total={ttSummary.sections}
                  tone="warning"
                  srLabel={t('bento.principal.tt_sections_sr')}
                />
              ) : undefined
            }
            note={t('bento.principal.tt_sections_note', { count: ttSummary?.sections ?? 0 })}
            to={timetableHref}
            cue={t('bento.principal.cue_timetable')}
          />
        )}
      </Widget>

      <Widget
        id="timetable-unstaffed"
        label={t('bento.principal.tt_unstaffed')}
        size="small"
        index={29}
        optional
      >
        {(span) => (
          <SourceCell
            span={span}
            domain="academics"
            status={stateOf(timetable)}
            label={t('bento.principal.tt_unstaffed')}
            value={ttSummary?.live_unstaffed ?? 0}
            accent={(ttSummary?.live_unstaffed ?? 0) > 0 ? 'orange' : undefined}
            shape={
              ttSummary && ttSummary.live_periods > 0 ? (
                <Meter
                  value={ttSummary.live_unstaffed}
                  total={ttSummary.live_periods}
                  tone="warning"
                  srLabel={t('bento.principal.tt_unstaffed_sr')}
                />
              ) : undefined
            }
            note={t('bento.principal.tt_unstaffed_note', { count: ttSummary?.live_periods ?? 0 })}
            to={timetableHref}
            cue={t('bento.principal.cue_timetable')}
          />
        )}
      </Widget>

      <Widget
        id="syllabus-behind"
        label={t('bento.principal.syllabus')}
        size="small"
        index={30}
        optional
      >
        {(span) => (
          <SyllabusCell
            span={span}
            rows={coverageRows}
            status={stateOf(coverage)}
            href={syllabusHref}
          />
        )}
      </Widget>

      <Widget id="lesson-plans" label={t('bento.principal.plans')} size="small" index={31} optional>
        {(span) => (
          <SourceCell
            span={span}
            domain="academics"
            status={stateOf(plans)}
            label={t('bento.principal.plans')}
            value={plans.data?.items.length ?? 0}
            note={t('bento.principal.plans_note')}
            to={lessonPlansHref}
            cue={t('bento.principal.cue_plans')}
          />
        )}
      </Widget>

      <Widget
        id="question-papers"
        label={t('bento.principal.papers')}
        size="small"
        index={32}
        optional
      >
        {(span) => (
          <SourceCell
            span={span}
            domain="reports"
            status={stateOf(papers)}
            label={t('bento.principal.papers')}
            value={papersWaiting}
            accent={papersWaiting > 0 ? 'orange' : undefined}
            note={t('bento.principal.papers_note', { count: paperRows.length })}
            to={questionPapersHref}
            cue={t('bento.principal.cue_papers')}
          />
        )}
      </Widget>

      <Widget
        id="mark-moderation"
        label={t('bento.principal.moderation')}
        size="small"
        index={33}
        optional
      >
        {(span) => (
          <ModerationCell
            span={span}
            rows={moderationRows}
            status={stateOf(moderation)}
            href={moderationHref}
          />
        )}
      </Widget>

      <Widget
        id="grievances-open"
        label={t('bento.principal.grievances')}
        size="small"
        index={34}
        optional
      >
        {(span) => (
          <GrievancesOpenCell
            span={span}
            open={grievancesOpen}
            queued={grievanceRows.length}
            status={stateOf(grievances)}
            href={grievancesHref}
          />
        )}
      </Widget>

      <Widget
        id="grievances-overdue"
        label={t('bento.principal.grievances_late')}
        size="small"
        index={35}
        optional
      >
        {(span) => (
          <GrievancesOverdueCell
            span={span}
            open={grievancesOpen}
            status={stateOf(grievances)}
            href={grievancesHref}
          />
        )}
      </Widget>

      <Widget
        id="calendar-next"
        label={t('bento.principal.calendar')}
        size="small"
        index={36}
        optional
      >
        {(span) => (
          <SourceCell
            span={span}
            domain="operations"
            status={stateOf(calendar)}
            label={t('bento.principal.calendar')}
            value={upcoming.length}
            note={
              nextEntry
                ? t('bento.principal.calendar_next', {
                    name: nextEntry.name,
                    date: nextEntry.starts_on,
                  })
                : t('bento.principal.calendar_none')
            }
            to={calendarHref}
            cue={t('bento.principal.cue_calendar')}
          />
        )}
      </Widget>

      <Widget id="exams-upcoming" label={t('bento.principal.exams')} size="small" index={37} optional>
        {(span) => (
          <SourceCell
            span={span}
            domain="reports"
            status={stateOf(exams)}
            label={t('bento.principal.exams')}
            value={examsUpcoming}
            note={t('bento.principal.exams_note', { count: examRows.length })}
            to={examsHref}
            cue={t('bento.principal.cue_exams')}
          />
        )}
      </Widget>

      <Widget id="pass-rate" label={t('bento.principal.pass_rate')} size="small" index={38} optional>
        {(span) => (
          <PassRateCell
            span={span}
            summary={perf}
            subjects={bySubject}
            status={stateOf(performance)}
            href={performanceHref}
          />
        )}
      </Widget>

      <Widget id="at-risk" label={t('bento.principal.at_risk')} size="small" index={39} optional>
        {(span) => (
          <AtRiskCell
            span={span}
            summary={perf}
            subjects={bySubject}
            status={stateOf(performance)}
            href={academicPerformanceHref}
          />
        )}
      </Widget>

      <Widget
        id="staff-messages"
        label={t('bento.principal.messages')}
        size="small"
        index={40}
        optional
      >
        {(span) => (
          <SourceCell
            span={span}
            domain="communication"
            status={stateOf(threads)}
            label={t('bento.principal.messages')}
            value={unread}
            note={t('bento.principal.messages_note', { count: threads.data?.items.length ?? 0 })}
            to={messagesHref}
            cue={t('bento.principal.cue_messages')}
          />
        )}
      </Widget>

      <Widget id="my-pay" label={t('bento.principal.my_pay')} size="small" index={41} optional>
        {(span) => (
          <MyPayCell
            span={span}
            payslips={myPay.data?.payslips ?? []}
            status={stateOf(myPay)}
            href={myPayHref}
          />
        )}
      </Widget>

      <Widget id="my-leave" label={t('bento.principal.my_leave')} size="small" index={42} optional>
        {(span) => (
          <MyLeaveCell
            span={span}
            balances={balances}
            status={stateOf(myPay)}
            href={myLeaveHref}
          />
        )}
      </Widget>

      <Widget id="classes" label={t('bento.principal.classes')} size="small" index={43} optional>
        {(span) => (
          <SourceCell
            span={span}
            domain="operations"
            status={stateOf(classes)}
            label={t('bento.principal.classes')}
            value={classCount}
            note={t('bento.principal.classes_note', { count: k.sections })}
            to={classSetupHref}
            cue={t('bento.principal.cue_classes')}
          />
        )}
      </Widget>
      </WidgetLayer>
    </BentoPage>
  )
}
