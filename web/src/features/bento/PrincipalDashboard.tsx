import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { WidgetLayer, Widget } from './WidgetLayer'
import { useLayout } from '@/lib/widgets'
import { formatPaise } from '@/lib/utils'
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
interface SetupStatus {
  completed: number
  total: number
  blocking_remaining: number
  ready: boolean
}
interface ShortageRow { pct: number }
interface WorkloadRow { weekly_periods: number }
interface SubstitutionBoard {
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
interface CoverageRow { behind: boolean }
interface PaperRow { status: 'draft' | 'submitted' | 'approved' | 'changes_needed' }
interface ModerationRow { moderated_at: string | null }
interface GrievanceRow { status: string; resolved_at?: string; overdue_hours?: number }
interface CalendarEntry { name: string; starts_on: string; kind: string }
interface ExamRow { name: string; starts_on?: string; is_published: boolean }
interface PerformanceSummary {
  summary: { candidates: number; passed: number; pass_rate?: number; at_risk: number; papers: number }
}
interface ThreadRow { unread: number }
interface MyPayView {
  payslips: { period_month: number; period_year: number; net_paise: number }[]
  leave_balances: { leave_type: string; remaining: string }[]
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
  const behind = coverageRows.filter((c) => c.behind).length
  const paperRows = papers.data?.items ?? []
  const papersWaiting = paperRows.filter((p) => p.status === 'submitted').length
  const moderationRows = moderation.data?.items ?? []
  const unmoderated = moderationRows.filter((m) => !m.moderated_at).length
  const grievanceRows = grievances.data?.items ?? []
  const grievancesOpen = grievanceRows.filter((g) => !g.resolved_at)
  const grievancesOverdue = grievancesOpen.filter((g) => (g.overdue_hours ?? 0) > 0).length
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
  const unread = (threads.data?.items ?? []).reduce((n, t2) => n + t2.unread, 0)
  const payslip = myPay.data?.payslips[0]
  const balances = myPay.data?.leave_balances ?? []
  const leaveLeft = balances.reduce((n, b) => n + Number(b.remaining || 0), 0)
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

            {/* The actions. The same Cue every other cell carries, checked
                against the catalogue first: a button leading somewhere this
                account cannot open is worse than a shorter row of buttons. */}
            {attendanceHref && (
              <Cue to={attendanceHref} label={t('bento.principal.cue_attendance')} />
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
              {t('bento.principal.collected_label')}
            </p>
            <p
              className="mt-2 font-extrabold leading-[0.95] tracking-[-0.035em] tabular-nums
                         text-[length:var(--bento-fig,clamp(26px,3.6vh,40px))]"
            >
              {formatPaise(k.collected_paise)}
            </p>
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
          <SourceCell
            span={span}
            domain="operations"
            status={stateOf(setup)}
            label={t('bento.principal.setup')}
            value={setupData ? `${setupData.completed}/${setupData.total}` : 0}
            shape={
              setupData ? (
                <Meter
                  value={setupData.completed}
                  total={setupData.total}
                  tone="success"
                  srLabel={t('bento.principal.setup_sr')}
                />
              ) : undefined
            }
            note={t('bento.principal.setup_note', { count: setupData?.blocking_remaining ?? 0 })}
            to={setupHref}
            cue={t('bento.principal.cue_setup')}
          />
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
          <SourceCell
            span={span}
            domain="academics"
            status={stateOf(cover)}
            label={t('bento.principal.cover')}
            value={coverSummary?.uncovered ?? 0}
            accent={(coverSummary?.uncovered ?? 0) > 0 ? 'pink' : undefined}
            shape={
              coverSummary && coverSummary.periods > 0 ? (
                <Meter
                  value={coverSummary.covered}
                  total={coverSummary.periods}
                  tone="success"
                  srLabel={t('bento.principal.cover_sr')}
                />
              ) : undefined
            }
            note={t('bento.principal.cover_note', {
              covered: coverSummary?.covered ?? 0,
              periods: coverSummary?.periods ?? 0,
            })}
            to={substitutionsHref}
            cue={t('bento.principal.cue_cover')}
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
          <SourceCell
            span={span}
            domain="academics"
            status={stateOf(coverage)}
            label={t('bento.principal.syllabus')}
            value={behind}
            accent={behind > 0 ? 'orange' : undefined}
            shape={
              coverageRows.length > 0 ? (
                <Meter
                  value={behind}
                  total={coverageRows.length}
                  tone="warning"
                  srLabel={t('bento.principal.syllabus_sr')}
                />
              ) : undefined
            }
            note={t('bento.principal.syllabus_note', { count: coverageRows.length })}
            to={syllabusHref}
            cue={t('bento.principal.cue_syllabus')}
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
          <SourceCell
            span={span}
            domain="reports"
            status={stateOf(moderation)}
            label={t('bento.principal.moderation')}
            value={unmoderated}
            shape={
              moderationRows.length > 0 ? (
                <Meter
                  value={moderationRows.length - unmoderated}
                  total={moderationRows.length}
                  tone="success"
                  srLabel={t('bento.principal.moderation_sr')}
                />
              ) : undefined
            }
            note={t('bento.principal.moderation_note', { count: moderationRows.length })}
            to={moderationHref}
            cue={t('bento.principal.cue_moderation')}
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
          <SourceCell
            span={span}
            domain="communication"
            status={stateOf(grievances)}
            label={t('bento.principal.grievances')}
            value={grievancesOpen.length}
            note={t('bento.principal.grievances_note', { count: grievanceRows.length })}
            to={grievancesHref}
            cue={t('bento.principal.cue_grievances')}
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
          <SourceCell
            span={span}
            domain="communication"
            status={stateOf(grievances)}
            label={t('bento.principal.grievances_late')}
            value={grievancesOverdue}
            accent={grievancesOverdue > 0 ? 'pink' : undefined}
            shape={
              grievancesOpen.length > 0 ? (
                <Meter
                  value={grievancesOverdue}
                  total={grievancesOpen.length}
                  tone="destructive"
                  srLabel={t('bento.principal.grievances_late_sr')}
                />
              ) : undefined
            }
            note={t('bento.principal.grievances_late_note', { count: grievancesOpen.length })}
            to={grievancesHref}
            cue={t('bento.principal.cue_grievances')}
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
          <SourceCell
            span={span}
            domain="success"
            status={stateOf(performance)}
            label={t('bento.principal.pass_rate')}
            value={perf?.pass_rate != null ? `${Math.round(perf.pass_rate)}%` : '—'}
            shape={
              perf && perf.candidates > 0 ? (
                <Meter
                  value={perf.passed}
                  total={perf.candidates}
                  tone="success"
                  srLabel={t('bento.principal.pass_rate_sr')}
                />
              ) : undefined
            }
            note={t('bento.principal.pass_rate_note', { count: perf?.candidates ?? 0 })}
            to={performanceHref}
            cue={t('bento.principal.cue_performance')}
          />
        )}
      </Widget>

      <Widget id="at-risk" label={t('bento.principal.at_risk')} size="small" index={39} optional>
        {(span) => (
          <SourceCell
            span={span}
            domain="students"
            status={stateOf(performance)}
            label={t('bento.principal.at_risk')}
            value={perf?.at_risk ?? 0}
            accent={(perf?.at_risk ?? 0) > 0 ? 'orange' : undefined}
            note={t('bento.principal.at_risk_note', { count: perf?.candidates ?? 0 })}
            to={academicPerformanceHref}
            cue={t('bento.principal.cue_at_risk')}
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
          <SourceCell
            span={span}
            domain="finance"
            status={stateOf(myPay)}
            label={t('bento.principal.my_pay')}
            value={payslip ? formatPaise(payslip.net_paise) : '—'}
            note={
              payslip
                ? t('bento.principal.my_pay_note', {
                    month: payslip.period_month,
                    year: payslip.period_year,
                  })
                : t('bento.principal.my_pay_none')
            }
            to={myPayHref}
            cue={t('bento.principal.cue_my_pay')}
          />
        )}
      </Widget>

      <Widget id="my-leave" label={t('bento.principal.my_leave')} size="small" index={42} optional>
        {(span) => (
          <SourceCell
            span={span}
            domain="staff"
            status={stateOf(myPay)}
            label={t('bento.principal.my_leave')}
            value={leaveLeft}
            note={t('bento.principal.my_leave_note', { count: balances.length })}
            to={myLeaveHref}
            cue={t('bento.principal.cue_my_leave')}
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
