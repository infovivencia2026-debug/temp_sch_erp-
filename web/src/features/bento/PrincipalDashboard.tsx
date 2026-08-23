import type { CSSProperties, ReactNode } from 'react'
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
import { AgeBands, HeatStrip, Ring, SegmentBar } from './bento-viz'

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

/* THE FIGURE, at the size the board's own width token has already chosen.

   --bento-fig is set per column count in index.css, so a cell that reads it
   grows with its width for free; the clamp here is only the value used when a
   cell is rendered outside a widget. */
const FIG_CLASS =
  'font-extrabold leading-[0.95] tracking-[-0.035em] tabular-nums ' +
  'text-[length:var(--bento-fig,clamp(26px,3.6vh,40px))]'

const LABEL_CLASS =
  'bento-label text-[10px] font-semibold uppercase leading-tight tracking-[0.14em] ' +
  'text-[var(--bento-muted)]'

/** The whisper above the figure. One copy of the markup three cells were
    repeating verbatim. */
function CellLabel({ children }: { children: ReactNode }) {
  return <p className={LABEL_CLASS}>{children}</p>
}

/* A SENTENCE AT ONE COLUMN.

   The stylesheet drops `.bento-note` at one column, which is right for a 1x1 —
   there is no room under a figure in a 172px card — and wrong for a 1x2, which
   has a whole second row of height and nothing in it. The rule cannot tell the
   two apart because it only sees the width.

   The cells below can, so they re-assert the display for the shapes that have
   the height. `-webkit-box` rather than `block` because these paragraphs are
   line-clamped, and the clamp IS a display mode: overriding it with `block`
   would put the sentence back and take the clamp away, which is how a card
   overflows. */
const UNSHED: CSSProperties = { display: '-webkit-box' }

/* SEVERITY, IN WORDS AND ON A LADDER.

   Colour is never the only channel. The card is tinted pink for critical and
   orange for warning, so wherever that tint is drawn the word is drawn beside
   the figure too — at every size, including the 1x1, where it costs one short
   token of width and buys the reading for anyone who does not see the tint.

   `info` gets the word as well even though it is untinted, because the reading
   should not go silent on the one level that is not an alarm — "For
   information" is an answer to "how serious", and its absence was not. */
const SEVERITY_WORD = {
  critical: 'bento.principal.sev_critical',
  warning: 'bento.principal.sev_warning',
  info: 'bento.principal.sev_info',
} as const satisfies Record<AttentionSeverity, string>

/* The same three levels as one short token each, for the ladder. "For
   information" is a sentence fragment and reads as one; three rungs of a scale
   have to be three words of the same weight or the scale looks lopsided. */
const SEVERITY_RUNG = {
  critical: 'bento.principal.sev_rung_critical',
  warning: 'bento.principal.sev_rung_warning',
  info: 'bento.principal.sev_rung_info',
} as const satisfies Record<AttentionSeverity, string>

/* What each level MEANS — the engine's own definitions, transcribed from the
   `Severity` constants in internal/api/attention.go rather than invented here.
   This is the one piece of real explanation the payload's vocabulary supports,
   and it is what the full card spends its second row of height on. */
const SEVERITY_MEANING = {
  critical: 'bento.principal.sev_def_critical',
  warning: 'bento.principal.sev_def_warning',
  info: 'bento.principal.sev_def_info',
} as const satisfies Record<AttentionSeverity, string>

const SEVERITY_ORDER = ['critical', 'warning', 'info'] as const

/* THE ONE PLACE COLOUR IS MIXED IN THIS CELL.

   No hex and no bare token: every mark below is a bento accent mixed into
   `currentColor`, which is the ink the cell has already resolved for its own
   ground — near-black on a plain card, the card's own ink on a domain tint,
   the background colour on an inverted one. So a rung is a HUE CAST over an
   ink that already reads, and it cannot lose its ground the way a fixed colour
   can. 55% is the mix `bento-kit` measured its 3:1 floor at; the track is
   neutral for the same reason, being a fraction of whatever ink resolved. */
const SEVERITY_MARK: Record<AttentionSeverity, string> = {
  critical: 'color-mix(in srgb, var(--bento-pink) 55%, currentColor)',
  warning: 'color-mix(in srgb, var(--bento-orange) 55%, currentColor)',
  info: 'color-mix(in srgb, var(--bento-purple) 55%, currentColor)',
}
const SEVERITY_TRACK = 'color-mix(in srgb, currentColor 14%, transparent)'

/* THE FIGURE, capped by how long it is.

   `--bento-fig` is the board's own per-width figure size and is right for a
   count: four digits at 40px fit a 264px card with room to spare. A rupee
   figure is not four digits — `₹12,34,56,789` is thirteen glyphs, and at 40px
   that is 190px of tabular numerals past the edge of a 1x1. So the token is
   kept, and a ceiling is put over it by string length: the cell still grows
   with the board, and it can no longer grow off the card. */
function figureSize(text: string): string {
  const fig = 'var(--bento-fig,clamp(26px,3.6vh,40px))'
  const n = text.length
  if (n <= 5) return fig
  if (n <= 9) return `min(${fig},32px)`
  if (n <= 12) return `min(${fig},26px)`
  return `min(${fig},20px)`
}

const FIG_BASE = 'font-extrabold leading-[0.95] tracking-[-0.035em] tabular-nums whitespace-nowrap'

/* THE SEVERITY LADDER — three rungs, because the engine has exactly three.

   This is the one proportional drawing on the card that needs no denominator
   from the server, because the denominator is the vocabulary itself:
   `Severity` is a closed set of three, so "where on the scale is this" is a
   fact about the item and not an estimate of one. The rung the item sits on is
   drawn in that level's hue and named; the other two are named too, at track
   weight, so the scale is legible as a scale rather than as one lit dot.

   `level` is undefined when the panel reported nothing for this probe. The
   ladder then shows all three rungs unlit, which is the honest picture: no
   level was assigned, as opposed to the lowest one being assigned. */
function SeverityLadder({
  level,
  labels,
  showLabels,
}: {
  level?: AttentionSeverity
  labels: Record<AttentionSeverity, string>
  showLabels: boolean
}) {
  return (
    <div aria-hidden="true" className="flex w-full items-start gap-1">
      {SEVERITY_ORDER.map((rung) => {
        const lit = rung === level
        return (
          <div key={rung} className="min-w-0 flex-1">
            <div
              className="h-[5px] rounded-full"
              style={{ background: lit ? SEVERITY_MARK[rung] : SEVERITY_TRACK }}
            />
            {showLabels && (
              <p
                className="mt-1 truncate text-[8.5px] font-semibold uppercase leading-none tracking-[0.1em]"
                style={{
                  color: lit ? SEVERITY_MARK[rung] : 'var(--bento-muted)',
                  opacity: lit ? 1 : 0.6,
                }}
              >
                {labels[rung]}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* The same ladder given a column of its own, one rung per row with the meaning
   printed beside it. Only the 2x2 has the height for it, and it is what that
   size buys: not a bigger number, but the answer to "how serious is that,
   exactly" in the engine's own terms. */
function SeverityScale({
  level,
  labels,
  meanings,
  heading,
}: {
  level?: AttentionSeverity
  labels: Record<AttentionSeverity, string>
  meanings: Record<AttentionSeverity, string>
  heading: string
}) {
  return (
    <div aria-hidden="true" className="flex min-h-0 min-w-0 flex-1 flex-col justify-between gap-2">
      <p className="text-[9px] font-semibold uppercase leading-none tracking-[0.14em] text-[var(--bento-muted)]">
        {heading}
      </p>
      {SEVERITY_ORDER.map((rung) => {
        const lit = rung === level
        return (
          <div key={rung} className="flex min-w-0 gap-2">
            <span
              className="mt-[3px] h-[26px] w-[3px] shrink-0 rounded-full"
              style={{ background: lit ? SEVERITY_MARK[rung] : SEVERITY_TRACK }}
            />
            <div className="min-w-0">
              <p
                className="text-[9.5px] font-semibold uppercase leading-none tracking-[0.1em]"
                style={{
                  color: lit ? SEVERITY_MARK[rung] : 'var(--bento-muted)',
                  opacity: lit ? 1 : 0.65,
                }}
              >
                {labels[rung]}
              </p>
              <p
                className="mt-0.5 line-clamp-2 text-[10px] leading-tight text-[var(--bento-muted)]"
                style={{ opacity: lit ? 1 : 0.6 }}
              >
                {meanings[rung]}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** A named number, small. Two of these are the whole of what a money item's
    count and amount can honestly say about each other. */
function MicroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[8.5px] font-semibold uppercase leading-none tracking-[0.12em] text-[var(--bento-muted)]">
        {label}
      </p>
      <p className="mt-1 truncate text-[12px] font-semibold leading-none tabular-nums">{value}</p>
    </div>
  )
}

/* ONE CELL, ONE GRAMMAR, FIFTEEN WIDGETS.

   The card answers four questions in a fixed order, and every size answers all
   four — the larger ones answer them at greater length, never in a different
   order and never with a different vocabulary:

     what happened   the label, then the figure
     how serious     the severity word, then the ladder it sits on
     why             the server's headline sentence, then its detail sentence
     what to do      the action verb the probe declared, then the way there

   THREE STATES, KEPT APART ON PURPOSE. A failed fetch draws an error, never a
   nought: on this board a zero reads as "nothing is wrong here", and that is
   the most expensive thing a dashboard can say untruthfully. A fetch still in
   flight draws a dash for the same reason. Only a response that arrived draws
   a number.

   AND A FOURTH THING A ZERO IS NOT. The engine drops every probe whose count
   is zero AND every probe the caller lacks the permission for, and the two
   look identical on the wire — an absent key. So this cell never says "all
   clear". It says what it can defend: nothing was REPORTED, with the reason it
   might not have been printed alongside it wherever there is room, and read
   out in full to a screen reader at every size. A calm zero also takes no
   severity: the ladder shows three unlit rungs, which is "no level assigned",
   not "the lowest level".

   WHAT THE PAYLOAD DOES NOT CONTAIN, and is therefore not drawn. Each item is
   `{key, severity, count, headline, detail, action, href, amount_paise}` — one
   scalar count, one optional amount, two sentences. There is no series, no
   denominator, no ageing and no category breakdown, so there is no trend line,
   no percentage, no ageing rail and no composition bar anywhere below. The
   spec asks for those at 2x1 and 2x2; the honesty rule outranks the spec's
   density, so the larger sizes spend their room on MORE OF WHAT ARRIVED — the
   full headline, the detail, the severity scale in words, and the arithmetic
   between the count and the amount, which is the one relationship the payload
   really does support.

   WHAT EACH SIZE ADDS, strictly cumulative:

     1x1   label · figure · severity word · three-rung ladder · action verb
     1x2   + the headline sentence, + the count/average pair on a money item,
           + the rungs named
     2x1   the same content, laid out in two columns so the sentence gets the
           width it wants rather than four wrapped lines
     2x2   + the detail sentence, + the severity scale spelled out with the
           engine's own definition of each level, + the destination named
           beside the action verb

   THE READING NEVER CHANGES WITH THE SIZE. Every visible sentence is
   `aria-hidden` and one `sr-only` line carries the whole reading — severity,
   headline, count, amount, average, detail and next step — at all four shapes.
   The small card hides text from the eye; it does not take the meaning away
   from a screen reader. */
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
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2
  const full = wide && tall
  const roomy = wide || tall

  const rungs = {
    critical: t(SEVERITY_RUNG.critical),
    warning: t(SEVERITY_RUNG.warning),
    info: t(SEVERITY_RUNG.info),
  }

  if (status === 'error') {
    return (
      <Cell span={span}>
        <CellLabel>{label}</CellLabel>
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

  // The money item leads with the amount: ₹15,52,900 is read faster than 44,
  // and it is the figure the decision is actually made on.
  const amount = money && item?.amount_paise ? item.amount_paise : undefined
  const figure = amount !== undefined ? formatPaise(amount) : String(item?.count ?? 0)

  const headline = item ? item.headline : t('bento.principal.attention_clear')
  const detail = item?.detail
  /* The count and the amount, said about each other. Division by a count the
     same query returned is arithmetic, not a derived denominator: ₹15,52,900
     across 44 students really is ₹35,293 each, and that figure changes what a
     bursar does about it. It is only ever drawn where BOTH numbers arrived. */
  const perItem =
    amount !== undefined && item && item.count > 0
      ? formatPaise(Math.round(amount / item.count))
      : undefined
  const countText = item ? t('bento.principal.attention_count', { count: item.count }) : undefined

  const severity = item?.severity
  const severityWord = severity
    ? t(SEVERITY_WORD[severity])
    : t('bento.principal.attention_no_level')
  const action = item?.action

  /* One reading, identical at every shape, and it says the thing the card
     cannot fit as well as the things it can. */
  const srText = [
    label,
    severityWord,
    headline,
    amount !== undefined ? countText : undefined,
    perItem ? t('bento.principal.attention_each', { amount: perItem }) : undefined,
    detail,
    action ? t('bento.principal.attention_next', { action }) : undefined,
    item ? undefined : t('bento.principal.attention_clear_note'),
  ]
    .filter(Boolean)
    .join('. ')

  /* The figure and the word for how serious it is: the two things every size
     starts with, and the only two a 1x1 gives a whole line to. */
  const figureBlock = (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <p className={FIG_BASE} style={{ fontSize: figureSize(figure) }}>
        {figure}
      </p>
      <span
        aria-hidden="true"
        className="rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase
                   leading-none tracking-[0.1em]"
        style={{
          borderColor: severity ? SEVERITY_MARK[severity] : SEVERITY_TRACK,
          color: severity ? SEVERITY_MARK[severity] : 'var(--bento-muted)',
        }}
      >
        {severityWord}
      </span>
    </div>
  )

  /* A money item's other half. Two named numbers rather than one, because the
     count is the population the amount was summed over and the average is what
     the two of them mean together. */
  const stats =
    roomy && amount !== undefined && item ? (
      <div aria-hidden="true" className="mt-2 flex gap-4">
        <MicroStat label={t('bento.principal.attention_stat_flagged')} value={String(item.count)} />
        {perItem && (
          <MicroStat label={t('bento.principal.attention_stat_each')} value={perItem} />
        )}
      </div>
    ) : null

  const headlineText = (
    <p
      aria-hidden="true"
      className={cn(
        'text-[11px] leading-snug text-[var(--bento-muted)] [overflow-wrap:anywhere]',
        full ? 'line-clamp-3' : wide ? 'line-clamp-2' : 'line-clamp-3',
      )}
    >
      {headline}
    </p>
  )

  const detailText =
    full && (detail || !item) ? (
      <p
        aria-hidden="true"
        className="mt-1 line-clamp-2 text-[11px] leading-snug text-[var(--bento-muted)]
                   opacity-80 [overflow-wrap:anywhere]"
      >
        {detail ?? t('bento.principal.attention_clear_note')}
      </p>
    ) : null

  /* What to do about it. The probe declares a verb — "Arrange substitute",
     "Retry or reconcile" — and until now the card threw it away and showed
     only where the cue went. It is the fourth question the card exists to
     answer, so it is printed at every size, and at the full size the
     destination is named beside it. */
  const nextStep = action ? (
    <p
      aria-hidden="true"
      className="mt-2 truncate text-[10.5px] leading-none"
      title={action}
    >
      <span className="font-semibold uppercase tracking-[0.12em] text-[var(--bento-muted)] text-[8.5px]">
        {t('bento.principal.attention_next_label')}
      </span>{' '}
      <span className="font-semibold">{action}</span>
      {full && <span className="text-[var(--bento-muted)]">{` · ${cue}`}</span>}
    </p>
  ) : null

  return (
    <Cell span={span} accent={item ? ATTENTION_ACCENT[item.severity] : undefined}>
      <CellLabel>{label}</CellLabel>

      {/* Two columns where there is width, one where there is not. The split is
          the same at 2x1 and 2x2 so the eye learns one place to look for the
          figure and one for the words; the right column is what grows. */}
      <div className={cn('mt-1.5 flex min-h-0 flex-1 gap-3', wide ? 'flex-row' : 'flex-col')}>
        <div className={cn('flex min-w-0 flex-col', wide ? (full ? 'w-[52%]' : 'w-[42%]') : '')}>
          {figureBlock}
          {stats}
          {full && <div className="mt-2">{headlineText}</div>}
          {full && detailText}
        </div>

        <div className={cn('flex min-w-0 flex-col', wide ? 'flex-1' : '')}>
          {roomy && !full && <div className={wide ? '' : 'mt-2'}>{headlineText}</div>}
          {full ? (
            <SeverityScale
              level={severity}
              labels={rungs}
              meanings={{
                critical: t(SEVERITY_MEANING.critical),
                warning: t(SEVERITY_MEANING.warning),
                info: t(SEVERITY_MEANING.info),
              }}
              heading={t('bento.principal.attention_scale')}
            />
          ) : (
            <div className="mt-auto pt-2">
              <SeverityLadder level={severity} labels={rungs} showLabels={roomy} />
            </div>
          )}
        </div>
      </div>

      {nextStep}

      <span className="sr-only">{srText}</span>

      {to && <Cue to={to} label={cue} />}
    </Cell>
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
  /* The rest of what `/syllabus/coverage` already sends. Optional here only
     because they are `omitempty` on the wire — a class-subject nobody has
     taught yet has no `last_taught`, and that absence is itself a reading. */
  teacher?: string
  /** `YYYY-MM-DD`, absent when no unit of this subject has been delivered. */
  last_taught?: string
  plans_waiting?: number
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
  /* The rest of the richest payload on this board. Every one of these is
     already in `listMarkModeration`'s SELECT; they are typed optional only
     because a caller that mocks this row need not carry them.

     `highest_pct` and `lowest_pct` are the same decimals-as-strings as
     `average_pct` and are null on the same rows. `max_marks` and `pass_marks`
     are `numeric` as text, and together they are the only honest source of
     the pass threshold this cell draws — a paper's pass mark over its own
     maximum, per paper. */
  exam_name?: string
  max_marks?: string | null
  pass_marks?: string | null
  highest_pct?: string | null
  lowest_pct?: string | null
  adjustment?: string | null
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

/** A SUPPORTING FIGURE WITH ITS OWN NAME ATTACHED TO IT.

    The unit of density on a cell whose endpoint returned one number. A fact is
    a figure and the word for it, side by side — hierarchy, not a chart — and
    every one of them below is either a scalar that arrived in the same
    response or a ratio of two of them. None of them is a share of an invented
    whole, which is the thing a bar would have to claim. */
type Fact = { key: string; value: string; label: string }

/** THE FACTS, IN THE SHAPE THE ROOM HAS.

    `row` at one row of height, where the width is what there is; `stacked` in
    the tall narrow cell, where each fact gets its own line and the label sits
    out at the right margin so the figures line up in a column; `grid` at 2x2,
    which is the only shape with room for four.

    Deliberately not `.bento-note` and not `.bento-shape`: those two classes
    are shed by the stylesheet at one column and one row respectively, and a
    fact is the thing that must survive at 1x1 — it is what stops the smallest
    cell being a number on a field of nothing. */
function FactField({ facts, mode }: { facts: Fact[]; mode: 'row' | 'stacked' | 'grid' }) {
  if (facts.length === 0) return null
  return (
    <div
      className={cn(
        'mt-2 min-w-0',
        mode === 'row' && 'flex flex-wrap items-baseline gap-x-3.5 gap-y-1',
        mode === 'stacked' && 'flex flex-col gap-1',
        mode === 'grid' && 'grid grid-cols-2 gap-x-3.5 gap-y-1.5',
      )}
    >
      {facts.map((f) => (
        <div
          key={f.key}
          className={cn(
            'flex min-w-0 items-baseline gap-1.5',
            mode === 'stacked' && 'justify-between',
          )}
        >
          <span className="shrink-0 text-[13px] font-bold leading-none tabular-nums">
            {f.value}
          </span>
          <span
            className="truncate text-[9.5px] font-semibold uppercase leading-none
                       tracking-[0.09em] text-[var(--bento-muted)]"
          >
            {f.label}
          </span>
        </div>
      ))}
    </div>
  )
}

/** WHERE THE FIGURE CAME FROM, in four or five words.

    The `SourceCell` spec asks the smallest shape for a source indicator, and
    the honest one on this board is the period: a flow is true for the range
    that was asked for and a level is true now, and the two are not the same
    claim. It is text, so the dot beside it carries nothing on its own. */
function Provenance({ children }: { children: ReactNode }) {
  return (
    <p
      className="mt-1.5 flex items-center gap-1.5 text-[9.5px] font-semibold uppercase
                 leading-none tracking-[0.12em] text-[var(--bento-muted)]"
    >
      <span
        aria-hidden="true"
        className="inline-block h-[3px] w-[3px] shrink-0 rounded-full bg-current opacity-70"
      />
      <span className="truncate">{children}</span>
    </p>
  )
}

/** A STATE, IN A WORD, beside the figure.

    The same pill `AttentionCell` puts a severity in, for the flat cells whose
    one number has a state and no second number: nought pending is a different
    card from forty pending, and the word says which without a hue having to. */
function StateTag({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="rounded-full border border-[var(--bento-line)] px-1.5 py-0.5 text-[9px]
                 font-semibold uppercase leading-none tracking-[0.1em] text-[var(--bento-muted)]"
    >
      {children}
    </span>
  )
}

/** A COUNT, DRAWN AS ITSELF — one mark per thing counted.

    The one drawing a lone scalar can honestly carry. There is no base, no
    total and no proportion in it: forty marks are forty leave requests, and
    the reading is the length of the run. That is a unary encoding of a number
    the endpoint really returned, which is the opposite of a bar against a
    denominator nobody sent.

    Above `TALLY_MAX` the marks stop being countable and start being a smear,
    so nothing is drawn rather than a field that misreports its own length by
    being cut. Nothing at 1x1 either: the smallest card is spending its height
    on the figure and the facts. */
const TALLY_MAX = 40
function TallyField({
  n,
  accent,
  srLabel,
}: {
  n: number
  accent: 'orange' | 'pink' | 'purple'
  srLabel: string
}) {
  const { w, h } = useWidgetSize()
  if (n <= 0 || n > TALLY_MAX || (w < 2 && h < 2)) return null
  return (
    <div role="img" aria-label={srLabel} className="mt-2.5 flex flex-wrap items-end gap-[3px]">
      {Array.from({ length: n }, (_, i) => (
        <span
          key={i}
          className="inline-block h-2.5 w-[3px] rounded-[1.5px]"
          style={{ background: `color-mix(in srgb, var(--bento-${accent}) 55%, currentColor)` }}
        />
      ))}
    </div>
  )
}

/* One feature cell, with the same three states the attention cells keep apart
   and for the same reason: a fetch that failed must not be able to render as a
   nought, because a nought here reads as "nothing to do".

   WHAT IT DRAWS AT EACH SHAPE.

   Ten of the cells that come through here are scalars: a figure and a sentence
   about it, with no series and no population behind them. The extra room does
   NOT buy a chart with an invented base. It buys more of what arrived — the
   supporting figures counted out of the same response, the sentence that says
   what the number is, and the period it is true for.

     1x1  the label, the figure, its state where it has one, ONE supporting
          fact, and the source line. Signal, plus where the signal came from.
     2x1  the figure with up to three facts along the row beside it, the flat
          drawing where the cell has one, and the sentence. Width is what a
          row of facts and a sentence both want.
     1x2  the figure, the facts stacked one per line with their labels out at
          the right margin, the drawing that needs height, and the sentence
          under it.
     2x2  all of it: the facts as a two-by-two grid, the drawing, the sentence
          and the source line.

   THE TEN CELLS THAT ALREADY DISPATCH KEEP THEIR DRAWING. `SyllabusCell` and
   its nine siblings compute a `shape` from their own data for the shapes that
   can hold one, and pass it here. At one column a cell that is spending its
   height on that drawing has no room for a sentence underneath it as well, so
   the sentence stays shed there — exactly as the stylesheet had it — and
   appears at 1x2 only for the cells with no drawing to compete with. Nothing
   any of those ten renders changes: `facts`, `flat`, `provenance`, `tag` and
   `art` are all absent for them, and absent they render byte for byte what
   they rendered before.

   THE SENTENCE IS NEVER LOST TO A SCREEN READER. Where it is shed for want of
   room it is still read: the visible copy is `aria-hidden` and an `sr-only`
   copy is always present, so the reading is the same at all four shapes. */
function SourceCell({
  span,
  label,
  value,
  note,
  shape,
  flat,
  facts,
  provenance,
  tag,
  art,
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
  /** A drawing that must survive at one row of height. `shape` is dropped by
      the stylesheet at `[data-h='1']`, which is right for a meter and wrong
      for a tally: the tally is the cell's only drawing and 2x1 is a shape it
      fits. So it goes in its own slot rather than fighting a rule that exists
      for a good reason. */
  flat?: ReactNode
  /** Supporting figures, most important first. The cell shows as many as the
      room holds and no more; the rest are simply not drawn, because a fact
      that has been squeezed to three characters is not a fact. */
  facts?: Fact[]
  provenance?: string
  tag?: string
  /** The process behind the figure, passed straight through to `Cell`. */
  art?: ReactNode
  accent?: 'pink' | 'orange'
  domain?: string
  to?: string
  cue: string
  status: 'loading' | 'error' | 'ready'
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2

  if (status === 'error') {
    return (
      <Cell span={span} domain={domain}>
        <CellLabel>{label}</CellLabel>
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

  const showNote = Boolean(note) && (wide || (tall && !shape))
  /* How many facts fit, by shape rather than by area — 2x1 and 1x2 hold the
     same number and lay them out differently, and the 1x1 holds one. */
  const limit = wide && tall ? 4 : wide ? 3 : tall ? 3 : 1
  const shown = (facts ?? []).slice(0, limit)
  const mode = wide && tall ? 'grid' : tall ? 'stacked' : 'row'
  /* A 2x1 carrying facts and a drawing has already spent its height; the
     sentence gets the line that is left rather than three that are not. Cells
     with neither keep the three lines they have always had. */
  const dense = shown.length > 0 || Boolean(flat)

  return (
    <Cell span={span} accent={accent} domain={domain} art={art}>
      <CellLabel>{label}</CellLabel>
      <div className="mt-2 flex flex-wrap items-center gap-2.5">
        <p className={FIG_CLASS}>{value}</p>
        {tag && <StateTag>{tag}</StateTag>}
      </div>
      {shown.length > 0 && <FactField facts={shown} mode={mode} />}
      {flat}
      {/* Rendered whatever the shape, and shed by the stylesheet at one row of
          height, which is where a meter has nowhere to go. Unchanged. */}
      {shape && <div className="bento-shape mt-3">{shape}</div>}
      {showNote && (
        <p
          aria-hidden="true"
          style={wide ? undefined : UNSHED}
          className={cn(
            'bento-note mt-1.5 text-[11px] leading-snug text-[var(--bento-muted)]',
            dense && wide && !tall ? 'line-clamp-1' : 'line-clamp-3',
          )}
        >
          {note}
        </p>
      )}
      {note && <span className="sr-only">{note}</span>}
      {provenance && <Provenance>{provenance}</Provenance>}
      {tag && <span className="sr-only">{tag}</span>}
      {to && cue && <Cue to={to} label={cue} />}
    </Cell>
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

/* ─── DISTANCE, AND DISTRIBUTION ─────────────────────────────────────────

   The two cells below are the board's only two instruments, in the sense the
   spec means: the reading is a SHAPE rather than a number with a bar under it.

   SYLLABUS IS A DISTANCE. Not "41% done" on a progress bar — a progress bar
   answers "how far along" and the head's question is "how far behind", which
   is a different quantity and needs two marks and the space between them. So
   every rail below carries an EXPECTED mark, an ACTUAL mark, the band between
   them, and the direction printed as a word or an arrow.

   MODERATION IS A DISTRIBUTION. Not a bar chart of counts — a field of marks
   on a 0-100 axis, with the mean, the median, the pass threshold and the
   outliers drawn on the same axis, so the shape of the marking is the reading:
   spread out, bunched up, pushed high, or one paper sitting where no other
   paper sits.

   WHAT IS DERIVED HERE, AND WHAT IS NOT.

   The one quantity below that does not arrive in a response is EXPECTED
   SYLLABUS COVERAGE, and it is not derived from the data — it is the
   calendar. `internal/api/syllabus.go` computes how far through the June-April
   year today is and uses it to decide `behind`, but does not put it on the
   wire; `yearElapsedPct` restates that same definition so the judgement the
   endpoint already made can be DRAWN rather than only counted. Nothing is
   divided by it and no denominator comes from it.

   Everything else is off the wire. `units` is the real per-row denominator for
   syllabus, and `entered` is the real per-paper one for marks. Where a spec
   line asks for something neither endpoint carries — a trajectory over time
   for coverage, per-student mark density — it is left out rather than
   simulated, and the notes below say which. */

/** An accent mixed into whatever ink the cell resolved for its own ground.

    The same ladder `bento-kit` measured — 55% for a mark, and a wash for a
    band a mark sits on — restated here because those helpers are private to
    that file and this file may not edit it. No hex, and nothing that assumes
    a light card: a cell can be light, domain-tinted or inverted. */
const hueMark = (a: 'mint' | 'orange' | 'purple' | 'pink') =>
  `color-mix(in srgb, var(--bento-${a}) 55%, currentColor)`
const hueWash = (a: 'mint' | 'orange' | 'purple' | 'pink', pct: number) =>
  `color-mix(in srgb, ${hueMark(a)} ${pct}%, transparent)`
/** The neutral rail, and the neutral hairline: fractions of the cell's own
    ink, so they are visible on every ground. */
const RAIL = 'color-mix(in srgb, currentColor 14%, transparent)'
const HAIR = 'color-mix(in srgb, currentColor 40%, transparent)'

const clampPct = (n: number) => Math.max(0, Math.min(100, n))
const median = (xs: number[]) => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
/** The quartile a box plot uses, by the same nearest-rank rule for both ends
    so the fence below is symmetric. */
const quantile = (sorted: number[], q: number) => {
  if (sorted.length === 0) return null
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/* ── SYLLABUS: THE DISTANCE INSTRUMENT ─────────────────────────────────── */

/** How far through the academic year today is, on the same definition
    `internal/api/syllabus.go` uses to decide whether a class-subject is
    `behind`: the year runs from 1 June and is 334 days long, May being
    holiday.

    THIS IS THE CALENDAR, NOT A DERIVED FIGURE. The endpoint has already made
    the judgement — `behind` is `percent < 75 && elapsed > 75` — and simply
    does not send the elapsed number along with it. Without it there are no
    two marks to put a distance between, and the cell falls back to being the
    progress bar the spec says it must not be. It is never used as a
    denominator. */
function yearElapsedPct(now: Date): number {
  const y = now.getMonth() >= 5 ? now.getFullYear() : now.getFullYear() - 1
  const days = (now.getTime() - new Date(y, 5, 1).getTime()) / 86_400_000
  return clampPct(Math.round((days / 334) * 100))
}

/** The distance itself: expected, actual, and the band between them.

    THREE CHANNELS, NOT ONE. The expected mark is a triangle above the rail,
    the actual mark is a solid bar through it, and the band between them is
    tinted — orange when the actual sits short of expected, mint when it is
    past it. Take the colour away and the two marks are still different shapes
    with a visible distance between them, which is the whole reading. */
function GapRail({
  expected,
  actual,
  srLabel,
  lg = false,
}: {
  expected: number
  actual: number
  srLabel: string
  lg?: boolean
}) {
  const e = clampPct(expected)
  const a = clampPct(actual)
  const lo = Math.min(e, a)
  const span = Math.abs(e - a)
  const behind = a < e
  const h = lg ? 20 : 16
  const bar = lg ? 9 : 7
  const top = h - bar - (lg ? 2 : 1)
  return (
    <div role="img" aria-label={srLabel} className="relative w-full shrink-0" style={{ height: h }}>
      <div
        aria-hidden="true"
        className="absolute inset-x-0 rounded-full"
        style={{ top, height: bar, background: RAIL }}
      />
      <div
        aria-hidden="true"
        className="absolute rounded-full"
        style={{
          top,
          height: bar,
          left: `${lo}%`,
          width: `${span}%`,
          background: hueMark(behind ? 'orange' : 'mint'),
        }}
      />
      {/* Expected: a caret standing on the rail. */}
      <div
        aria-hidden="true"
        className="absolute"
        style={{
          top: 0,
          left: `${e}%`,
          transform: 'translateX(-50%)',
          width: 0,
          height: 0,
          borderLeft: '4px solid transparent',
          borderRight: '4px solid transparent',
          borderTop: `${lg ? 6 : 5}px solid currentColor`,
        }}
      />
      {/* Actual: a solid bar through the rail, taller than it. */}
      <div
        aria-hidden="true"
        className="absolute rounded-[1.5px]"
        style={{
          top: top - 2,
          height: bar + 4,
          width: 3,
          left: `${a}%`,
          transform: 'translateX(-50%)',
          background: 'currentColor',
        }}
      />
    </div>
  )
}

/** The direction, as a glyph and a number. Never colour alone. */
function GapFigure({ points, className }: { points: number; className?: string }) {
  const behind = points > 0
  return (
    <span className={cn('tabular-nums', className)}>
      <span aria-hidden="true">{behind ? '▼' : points < 0 ? '▲' : '·'}</span>
      {' '}
      {Math.abs(Math.round(points))}
    </span>
  )
}

/** One class-subject, ranked by how far short of expected it is. */
function LagRow({
  label,
  expected,
  actual,
  worst,
  srLabel,
}: {
  label: string
  expected: number
  actual: number
  worst?: boolean
  srLabel: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          'w-[84px] shrink-0 truncate text-[10.5px] leading-tight',
          worst ? 'font-bold' : 'font-medium',
        )}
        title={label}
      >
        {label}
      </span>
      <div className="min-w-0 flex-1">
        <GapRail expected={expected} actual={actual} srLabel={srLabel} />
      </div>
      <GapFigure
        points={expected - actual}
        className={cn('w-[34px] shrink-0 text-right text-[10.5px]', worst && 'font-bold')}
      />
    </div>
  )
}

/** Subject x class, one square per pairing, filled from the bottom by how far
    short of expected that pairing is.

    THE FILL IS THE READING and the tint only agrees with it: an empty square
    is on schedule, a full one is a subject nobody has taught. A pairing the
    response does not carry is drawn as an outline, so a hole in the grid is
    visibly a hole rather than a good result. */
function GapMatrix({
  subjects,
  classes,
  cell,
  expected,
  srLabel,
}: {
  subjects: string[]
  classes: string[]
  cell: (subject: string, cls: string) => number | null
  expected: number
  srLabel: string
}) {
  return (
    <div role="img" aria-label={srLabel} className="min-w-0">
      <div
        className="grid gap-[3px]"
        style={{ gridTemplateColumns: `52px repeat(${classes.length}, minmax(0, 1fr))` }}
      >
        <span aria-hidden="true" />
        {classes.map((c) => (
          <span
            key={c}
            aria-hidden="true"
            className="overflow-hidden text-center text-[8px] font-semibold uppercase leading-none tracking-tight"
            style={{ color: HAIR }}
            title={c}
          >
            {c}
          </span>
        ))}
        {/* A flat array of squares rather than one fragment per row: the grid
            places its own children, so a wrapper element per row would break
            the column alignment the matrix is entirely made of. */}
        {subjects.flatMap((s) => [
          <span
            key={`row-${s}`}
            aria-hidden="true"
            className="truncate pr-1 text-[9px] font-medium leading-none"
            title={s}
          >
            {s}
          </span>,
          ...classes.map((c) => {
              const pct = cell(s, c)
              if (pct === null) {
                return (
                  <span
                    key={`${s}-${c}`}
                    aria-hidden="true"
                    className="h-[13px] rounded-[2px] border border-dashed"
                    style={{ borderColor: RAIL }}
                    title={`${c} ${s}: not offered`}
                  />
                )
              }
              const short = Math.max(0, expected - pct)
              const fill = expected > 0 ? Math.min(100, (short / expected) * 100) : 0
              return (
                <span
                  key={`${s}-${c}`}
                  aria-hidden="true"
                  className="relative block h-[13px] overflow-hidden rounded-[2px]"
                  style={{ background: RAIL }}
                  title={`${c} ${s}: ${Math.round(pct)}% delivered, ${Math.round(expected)}% expected`}
                >
                  <span
                    className="absolute inset-x-0 bottom-0"
                    style={{
                      height: `${fill}%`,
                      background: fill > 0 ? hueMark('orange') : hueMark('mint'),
                    }}
                  />
                </span>
              )
          }),
        ])}
      </div>
    </div>
  )
}

/** Syllabus coverage, drawn as the distance between where the year is and
    where the teaching is.

    1x1  SIGNAL. How many class-subjects are short, the school's own delivered
         share, and one rail carrying both marks and the gap between them.
    1x2  + MOVEMENT. The rail at full size with both marks named, the lag in
         points and in units, how many subjects and classes contribute, and
         when those subjects were last taught — which is the only movement
         this endpoint carries. There is no coverage history on the wire, so
         no trajectory is drawn.
    2x1  + STRUCTURE. The dense per-class-subject field: one rail each for the
         six furthest behind, expected and actual marked on every one, the
         worst in bold.
    2x2  + EXPLANATION. The school rail, the subject x class matrix, the lag
         ranking, the largest lagging subject, and the units still to teach.

    NOT DRAWN, AND WHY. "Change" and "recent movement" at 1x1 and 2x2 want a
    previous coverage reading; `/syllabus/coverage` returns today's state only
    and keeps no history, so nothing stands in for them. */
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

  /* Where the year is. The same definition the endpoint judges `behind` by. */
  const expected = yearElapsedPct(new Date())

  const behind = rows.filter((c) => c.behind).length
  /* The school's own delivered share, over the units the response itself
     counted. Both sides of this fraction arrived in the same payload. */
  const units = rows.reduce((n, c) => n + (Number.isFinite(c.units) ? c.units : 0), 0)
  const delivered = rows.reduce((n, c) => n + (Number.isFinite(c.delivered) ? c.delivered : 0), 0)
  const actual = units > 0 ? (delivered / units) * 100 : 0
  const lag = expected - actual
  /* Units still to teach to stand where the calendar stands. A count of
     units, over the units the rows carry — not a period, and not a guess. */
  const unitsShort = Math.max(0, Math.round((expected / 100) * units) - delivered)

  const ranked = [...rows]
    .filter((c) => Number.isFinite(c.percent))
    .sort((a, b) => a.percent - b.percent || a.class_name.localeCompare(b.class_name))
  const worstSubject = (() => {
    const m = new Map<string, { short: number; n: number }>()
    for (const c of rows) {
      if (!Number.isFinite(c.percent)) continue
      const cur = m.get(c.subject) ?? { short: 0, n: 0 }
      cur.short += Math.max(0, expected - c.percent)
      cur.n += 1
      m.set(c.subject, cur)
    }
    let best: { subject: string; avg: number } | null = null
    for (const [subject, v] of m) {
      const avg = v.short / v.n
      if (!best || avg > best.avg) best = { subject, avg }
    }
    return best
  })()
  const subjectsBehind = new Set(rows.filter((c) => c.behind).map((c) => c.subject)).size
  const classesBehind = new Set(rows.filter((c) => c.behind).map((c) => c.class_name)).size

  /* When those subjects were last taught: the only time this response
     carries. Days, bucketed the way a queue is read. */
  const staleDays = rows
    .map((c) => {
      if (!c.last_taught) return null
      const d = Date.parse(`${c.last_taught}T00:00:00`)
      if (!Number.isFinite(d)) return null
      return Math.max(0, Math.round((Date.now() - d) / 86_400_000))
    })
    .filter((d): d is number => d !== null)
  const neverTaught = rows.filter((c) => !c.last_taught).length

  if (status !== 'ready') {
    return (
      <SourceCell
        span={span}
        domain="academics"
        status={status}
        label={t('bento.principal.syllabus')}
        value={behind}
        cue={t('bento.principal.cue_syllabus')}
        to={href}
      />
    )
  }

  const railSr = t('bento.principal.syllabus_gap_sr', {
    expected: Math.round(expected),
    actual: Math.round(actual),
  })

  if (rows.length === 0) {
    return (
      <Cell span={span} domain="academics">
        <CellLabel>{t('bento.principal.syllabus')}</CellLabel>
        <p className="mt-2 text-[12.5px] font-medium leading-snug">
          {t('bento.principal.syllabus_empty')}
        </p>
        {href && <Cue to={href} label={t('bento.principal.cue_syllabus')} />}
      </Cell>
    )
  }

  const head = (
    <div className="flex min-w-0 items-baseline gap-2">
      <p className={FIG_CLASS}>{behind}</p>
      <span className="min-w-0 truncate text-[10.5px] font-semibold uppercase tracking-[0.08em]">
        {behind > 0
          ? t('bento.principal.syllabus_behind_of', { total: rows.length })
          : t('bento.principal.syllabus_on_track')}
      </span>
    </div>
  )

  const legend = (
    <p className="text-[10.5px] leading-tight tabular-nums" style={{ color: HAIR }}>
      {t('bento.principal.syllabus_legend', {
        expected: Math.round(expected),
        actual: Math.round(actual),
      })}
    </p>
  )

  /* 1x1 — the signal and one rail. */
  if (!wide && !tall) {
    return (
      <Cell span={span} domain="academics">
        <CellLabel>{t('bento.principal.syllabus')}</CellLabel>
        {head}
        <div className="mt-2">
          <GapRail expected={expected} actual={actual} srLabel={railSr} />
        </div>
        <p className="mt-0.5 text-[10px] leading-tight tabular-nums">
          <GapFigure points={lag} className="font-bold" />{' '}
          {t('bento.principal.syllabus_points_behind')}
        </p>
        {href && <Cue to={href} label={t('bento.principal.cue_syllabus')} />}
      </Cell>
    )
  }

  /* 1x2 — the signal, the distance at full size, and what is behind it. */
  if (!wide && tall) {
    return (
      <Cell span={span} domain="academics">
        <CellLabel>{t('bento.principal.syllabus')}</CellLabel>
        {head}
        <div className="mt-2.5">
          <GapRail expected={expected} actual={actual} srLabel={railSr} lg />
        </div>
        <div className="mt-1">{legend}</div>
        <p className="mt-2 text-[11px] font-semibold leading-tight tabular-nums">
          <GapFigure points={lag} /> {t('bento.principal.syllabus_points_behind')}
        </p>
        <p className="text-[10.5px] leading-snug tabular-nums" style={{ color: HAIR }}>
          {t('bento.principal.syllabus_units_short', { units: unitsShort, total: units })}
        </p>
        <p className="mt-1.5 text-[10.5px] leading-snug tabular-nums">
          {t('bento.principal.syllabus_contributors', {
            subjects: subjectsBehind,
            classes: classesBehind,
          })}
        </p>
        <div className="mt-1.5">
          <p className="text-[9.5px] font-semibold uppercase tracking-[0.1em]" style={{ color: HAIR }}>
            {t('bento.principal.syllabus_last_taught')}
          </p>
          <div className="mt-1">
            <AgeBands
              bands={bandCounts(staleDays, DAY_BANDS)}
              srLabel={t('bento.principal.syllabus_stale_sr')}
            />
          </div>
          {neverTaught > 0 && (
            <p className="mt-1 text-[10px] leading-tight tabular-nums" style={{ color: HAIR }}>
              {t('bento.principal.syllabus_never', { count: neverTaught })}
            </p>
          )}
        </div>
        {href && <Cue to={href} label={t('bento.principal.cue_syllabus')} />}
      </Cell>
    )
  }

  /* 2x1 — the signal beside the per-class-subject field. */
  if (wide && !tall) {
    const shown = ranked.slice(0, 4)
    return (
      <Cell span={span} domain="academics">
        <CellLabel>{t('bento.principal.syllabus')}</CellLabel>
        <div className="mt-1 flex min-h-0 flex-1 gap-3">
          <div className="flex w-[132px] shrink-0 flex-col">
            {head}
            <div className="mt-1.5">
              <GapRail expected={expected} actual={actual} srLabel={railSr} />
            </div>
            {legend}
            <p className="mt-0.5 text-[10px] font-semibold leading-tight tabular-nums">
              <GapFigure points={lag} /> {t('bento.principal.syllabus_points_behind')}
            </p>
          </div>
          <div className="flex min-w-0 flex-1 flex-col justify-start gap-[3px]">
            {shown.map((c, i) => (
              <LagRow
                key={`${c.class_name}-${c.subject}-${i}`}
                label={`${c.class_name} · ${c.subject}`}
                expected={expected}
                actual={c.percent}
                worst={i === 0 && c.percent < expected}
                srLabel={t('bento.principal.syllabus_row_sr', {
                  label: `${c.class_name} ${c.subject}`,
                  expected: Math.round(expected),
                  actual: Math.round(c.percent),
                })}
              />
            ))}
            {rows.length > shown.length && (
              <p className="text-[9.5px] leading-tight tabular-nums" style={{ color: HAIR }}>
                {t('bento.principal.syllabus_ranked', { shown: shown.length, total: rows.length })}
              </p>
            )}
          </div>
        </div>
        {href && <Cue to={href} label={t('bento.principal.cue_syllabus')} />}
      </Cell>
    )
  }

  /* 2x2 — the whole instrument: distance, matrix, ranking, explanation. */
  const MATRIX_CLASSES = 9
  const MATRIX_SUBJECTS = 7
  const shortOf = (c: CoverageRow) => Math.max(0, expected - c.percent)
  const rankBy = <K extends string>(key: (c: CoverageRow) => K, take: number) => {
    const m = new Map<K, number>()
    for (const c of rows) m.set(key(c), (m.get(key(c)) ?? 0) + shortOf(c))
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .slice(0, take)
      .map(([k]) => k)
  }
  const mClasses = rankBy((c) => c.class_name, MATRIX_CLASSES).sort((a, b) => a.localeCompare(b))
  const mSubjects = rankBy((c) => c.subject, MATRIX_SUBJECTS)
  const byPair = new Map(rows.map((c) => [`${c.subject} ${c.class_name}`, c.percent]))
  const allClasses = new Set(rows.map((c) => c.class_name)).size
  const allSubjects = new Set(rows.map((c) => c.subject)).size
  const ranking = ranked.slice(0, 4)

  return (
    <Cell span={span} domain="academics">
      <CellLabel>{t('bento.principal.syllabus')}</CellLabel>
      <div className="mt-1 flex min-h-0 flex-1 gap-3.5">
        <div className="flex w-[178px] shrink-0 flex-col">
          {head}
          <div className="mt-2">
            <GapRail expected={expected} actual={actual} srLabel={railSr} lg />
          </div>
          <div className="mt-1">{legend}</div>
          <p className="mt-1.5 text-[11px] font-semibold leading-tight tabular-nums">
            <GapFigure points={lag} /> {t('bento.principal.syllabus_points_behind')}
          </p>
          <p className="text-[10.5px] leading-snug tabular-nums" style={{ color: HAIR }}>
            {t('bento.principal.syllabus_units_short', { units: unitsShort, total: units })}
          </p>
          {worstSubject && (
            <p className="mt-1.5 text-[10.5px] leading-snug">
              {t('bento.principal.syllabus_worst_subject', {
                subject: worstSubject.subject,
                points: Math.round(worstSubject.avg),
              })}
            </p>
          )}
          <div className="mt-2 flex flex-col gap-[3px]">
            <p
              className="text-[9.5px] font-semibold uppercase tracking-[0.1em]"
              style={{ color: HAIR }}
            >
              {t('bento.principal.syllabus_ranking')}
            </p>
            {ranking.map((c, i) => (
              <LagRow
                key={`${c.class_name}-${c.subject}-${i}`}
                label={`${c.class_name} · ${c.subject}`}
                expected={expected}
                actual={c.percent}
                worst={i === 0 && c.percent < expected}
                srLabel={t('bento.principal.syllabus_row_sr', {
                  label: `${c.class_name} ${c.subject}`,
                  expected: Math.round(expected),
                  actual: Math.round(c.percent),
                })}
              />
            ))}
          </div>
          {href && <Cue to={href} label={t('bento.principal.cue_syllabus')} />}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <p
            className="text-[9.5px] font-semibold uppercase tracking-[0.1em]"
            style={{ color: HAIR }}
          >
            {t('bento.principal.syllabus_matrix')}
          </p>
          <div className="mt-1.5 min-w-0">
            <GapMatrix
              subjects={mSubjects}
              classes={mClasses}
              expected={expected}
              cell={(s, c) => byPair.get(`${s} ${c}`) ?? null}
              srLabel={t('bento.principal.syllabus_matrix_sr', {
                subjects: mSubjects.length,
                classes: mClasses.length,
                expected: Math.round(expected),
              })}
            />
          </div>
          <p className="mt-1.5 text-[9.5px] leading-snug tabular-nums" style={{ color: HAIR }}>
            {t('bento.principal.syllabus_matrix_note', {
              subjects: mSubjects.length,
              allSubjects,
              classes: mClasses.length,
              allClasses,
            })}
          </p>
          <p className="mt-auto text-[9.5px] leading-snug" style={{ color: HAIR }}>
            {t('bento.principal.syllabus_no_history')}
          </p>
        </div>
      </div>
    </Cell>
  )
}

/* ── MODERATION: THE DISTRIBUTION INSTRUMENT ───────────────────────────── */

/** What `/exams/moderation` says about one paper, once the decimals-as-strings
    have been turned into numbers and the nulls have been kept as nulls.

    A PAPER WITH NO AVERAGE IS NOT A PAPER AT ZERO. `average_pct` is null when
    a paper has no marks in it, and a null is dropped from every drawing below
    rather than plotted at the bottom of the axis. */
interface Paper {
  label: string
  avg: number
  low: number | null
  high: number | null
  pass: number | null
  entered: number
  failing: number
  moderated: boolean
  subject: string
}

const numOr = (s: string | null | undefined) => {
  if (s == null) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** A field of marks on a 0-100 axis: one dot per paper at its average, stacked
    where papers land in the same place, so a column of dots IS the density.

    PER-PAPER, NOT PER-STUDENT. `/exams/moderation` counts in the database and
    returns each paper's average, highest and lowest; the individual marks are
    not on the wire. So one dot is one paper, the whisker under the field is
    the range those papers cover, and the axis is labelled to say so — a dot
    per student would be a drawing of data this screen does not have.

    FILLED MEANS STILL IN THE QUEUE. Moderated papers are hollow. That is the
    same distinction the figure above the field counts, drawn as a shape rather
    than a second colour. */
function MarkField({
  papers,
  mean,
  med,
  pass,
  height,
  detail,
  srLabel,
}: {
  papers: Paper[]
  mean: number | null
  med: number | null
  pass: { lo: number; hi: number } | null
  height: number
  detail: boolean
  srLabel: string
}) {
  const dot = 6
  const gap = 1.5
  const step = detail ? 2.5 : 5
  const rowsMax = Math.max(1, Math.floor(height / (dot + gap)))
  const stacks = new Map<number, Paper[]>()
  for (const p of [...papers].sort((a, b) => a.avg - b.avg)) {
    const k = Math.round(clampPct(p.avg) / step)
    const cur = stacks.get(k) ?? []
    cur.push(p)
    stacks.set(k, cur)
  }
  const lows = papers.map((p) => p.low).filter((v): v is number => v !== null)
  const highs = papers.map((p) => p.high).filter((v): v is number => v !== null)
  const bLo = lows.length > 0 ? Math.min(...lows) : null
  const bHi = highs.length > 0 ? Math.max(...highs) : null

  return (
    <div role="img" aria-label={srLabel} className="min-w-0">
      <div className="relative w-full" style={{ height }}>
        {/* The pass threshold, as a zone when papers disagree about it. */}
        {pass && (
          <div
            aria-hidden="true"
            className="absolute inset-y-0"
            style={{
              left: `${clampPct(pass.lo)}%`,
              width: `${Math.max(0.6, clampPct(pass.hi) - clampPct(pass.lo))}%`,
              background: hueWash('pink', 22),
              borderLeft: `1px dashed ${hueMark('pink')}`,
            }}
          />
        )}
        {/* The median, as a hairline the eye can measure the field against. */}
        {med !== null && (
          <div
            aria-hidden="true"
            className="absolute inset-y-0 w-px"
            style={{ left: `${clampPct(med)}%`, background: HAIR }}
          />
        )}
        {[...stacks.entries()].flatMap(([k, list]) => {
          const shown = list.slice(0, rowsMax)
          const extra = list.length - shown.length
          return [
            ...shown.map((p, i) => (
              <span
                  key={`${k}-${p.label}-${i}`}
                  aria-hidden="true"
                  title={`${p.label}: average ${p.avg.toFixed(1)}%${
                    p.low !== null && p.high !== null
                      ? `, ${p.low.toFixed(0)}–${p.high.toFixed(0)}%`
                      : ''
                  }`}
                  className="absolute rounded-full"
                  style={{
                    width: dot,
                    height: dot,
                    left: `${clampPct(k * step)}%`,
                    bottom: i * (dot + gap),
                    transform: 'translateX(-50%)',
                    background: p.moderated ? 'transparent' : hueMark('purple'),
                    border: p.moderated ? `1.5px solid ${hueMark('purple')}` : 'none',
                  }}
                />
            )),
            extra > 0 ? (
              <span
                key={`${k}-more`}
                aria-hidden="true"
                title={`${extra} more papers here`}
                className="absolute text-[8px] font-bold leading-none"
                style={{
                  left: `${clampPct(k * step)}%`,
                  bottom: rowsMax * (dot + gap),
                  transform: 'translateX(-50%)',
                }}
              >
                +{extra}
              </span>
            ) : null,
          ]
        })}
      </div>
      {/* The bounds the papers actually cover, under the field. */}
      <div className="relative mt-0.5 h-[7px] w-full">
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-[3px] h-px"
          style={{ background: RAIL }}
        />
        {bLo !== null && bHi !== null && (
          <div
            aria-hidden="true"
            className="absolute top-[2px] h-[3px] rounded-full"
            style={{
              left: `${clampPct(bLo)}%`,
              width: `${Math.max(0.5, clampPct(bHi) - clampPct(bLo))}%`,
              background: HAIR,
            }}
          />
        )}
        {mean !== null && (
          <div
            aria-hidden="true"
            title={`mean ${mean.toFixed(1)}%`}
            className="absolute top-0"
            style={{
              left: `${clampPct(mean)}%`,
              transform: 'translateX(-50%)',
              width: 0,
              height: 0,
              borderLeft: '4px solid transparent',
              borderRight: '4px solid transparent',
              borderBottom: '6px solid currentColor',
            }}
          />
        )}
      </div>
      {detail && (
        <div
          className="mt-0.5 flex justify-between text-[9px] leading-none tabular-nums"
          style={{ color: HAIR }}
        >
          <span>{bLo !== null ? `${Math.round(bLo)}%` : '0%'}</span>
          <span>{bHi !== null ? `${Math.round(bHi)}%` : '100%'}</span>
        </div>
      )}
    </div>
  )
}

/** One subject's papers as a range: lowest mark to highest, with the mean on
    it. The 2x2's answer to "is this one subject or the whole cohort". */
function SubjectRange({
  label,
  lo,
  hi,
  mean,
  caption,
  srLabel,
}: {
  label: string
  lo: number
  hi: number
  mean: number
  caption: string
  srLabel: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-[62px] shrink-0 truncate text-[10px] font-medium leading-tight" title={label}>
        {label}
      </span>
      <div role="img" aria-label={srLabel} className="relative h-[11px] min-w-0 flex-1">
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-[5px] h-[3px] rounded-full"
          style={{ background: RAIL }}
        />
        <div
          aria-hidden="true"
          className="absolute top-[5px] h-[3px] rounded-full"
          style={{
            left: `${clampPct(lo)}%`,
            width: `${Math.max(0.5, clampPct(hi) - clampPct(lo))}%`,
            background: hueMark('purple'),
          }}
        />
        <div
          aria-hidden="true"
          className="absolute top-[1px] h-[11px] w-[2px] rounded-full"
          style={{ left: `${clampPct(mean)}%`, transform: 'translateX(-50%)', background: 'currentColor' }}
        />
      </div>
      <span className="w-[52px] shrink-0 text-right text-[9.5px] leading-tight tabular-nums" style={{ color: HAIR }}>
        {caption}
      </span>
    </div>
  )
}

/** Mark moderation, drawn as a distribution.

    1x1  SIGNAL. Papers still in the queue, the share reviewed, the shape of
         the marking in one word, and a tiny density field.
    1x2  + MOVEMENT through the distribution: the field at full height with
         the pass threshold and the median on it, and mean, median and
         threshold printed.
    2x1  + STRUCTURE. The density across the full width at fine resolution,
         the range the papers cover, the outliers named.
    2x2  + EXPLANATION. The same field, the per-subject ranges, the share of
         candidates below pass, the narrowest and the most deviant paper, and
         the verdict spelled out with the figures it was made from.

    ONE DOT IS ONE PAPER. The spec asks for individual mark density; the
    endpoint counts in SQL and returns per-paper aggregates, so per-student
    density cannot be drawn from it and is not faked. What is drawn — a paper
    at its average, with the range it covers under the field — is the honest
    form of the same question. */
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
  const reviewed = rows.length - unmoderated
  const reviewedPct = rows.length > 0 ? Math.round((reviewed / rows.length) * 100) : 0

  const papers: Paper[] = rows.flatMap((m) => {
    const avg = numOr(m.average_pct)
    if (avg === null) return []
    const max = numOr(m.max_marks ?? null)
    const passMarks = numOr(m.pass_marks ?? null)
    return [
      {
        label: `${m.class} ${m.subject}`,
        subject: m.subject,
        avg,
        low: numOr(m.lowest_pct ?? null),
        high: numOr(m.highest_pct ?? null),
        pass: max !== null && max > 0 && passMarks !== null ? (passMarks / max) * 100 : null,
        entered: Number.isFinite(m.entered) ? m.entered : 0,
        failing: Number.isFinite(m.failing) ? m.failing : 0,
        moderated: Boolean(m.moderated_at),
      },
    ]
  })
  const noAverage = rows.length - papers.length

  const avgs = papers.map((p) => p.avg)
  const sorted = [...avgs].sort((a, b) => a - b)
  const med = median(avgs)
  /* The mean every candidate counts once in: each paper's average weighted by
     the candidates who sat it, both figures from the same row. */
  const entered = papers.reduce((n, p) => n + p.entered, 0)
  const mean =
    entered > 0 ? papers.reduce((n, p) => n + p.avg * p.entered, 0) / entered : median(avgs)
  const failing = papers.reduce((n, p) => n + p.failing, 0)
  const failPct = entered > 0 ? (failing / entered) * 100 : null

  const passes = papers.map((p) => p.pass).filter((v): v is number => v !== null)
  const pass =
    passes.length > 0 ? { lo: Math.min(...passes), hi: Math.max(...passes) } : null

  /* Outliers by the fence a box plot uses — 1.5 interquartile ranges outside
     the quartiles — which needs no threshold anybody had to invent. Below four
     papers there are no quartiles worth the name and nothing is claimed. */
  const q1 = sorted.length >= 4 ? quantile(sorted, 0.25) : null
  const q3 = sorted.length >= 4 ? quantile(sorted, 0.75) : null
  const iqr = q1 !== null && q3 !== null ? q3 - q1 : null
  const fence =
    q1 !== null && q3 !== null && iqr !== null ? { lo: q1 - 1.5 * iqr, hi: q3 + 1.5 * iqr } : null
  const outliers = fence ? papers.filter((p) => p.avg < fence.lo || p.avg > fence.hi) : []

  /* How wide each paper's own marks are spread — the compression reading. */
  const spreads = papers
    .filter((p) => p.low !== null && p.high !== null)
    .map((p) => ({ p, spread: (p.high as number) - (p.low as number) }))
    .sort((a, b) => a.spread - b.spread)
  const medSpread = median(spreads.map((s) => s.spread))

  const deviant =
    med !== null && papers.length > 0
      ? papers.reduce((best, p) =>
          Math.abs(p.avg - med) > Math.abs(best.avg - med) ? p : best,
        )
      : null

  /* The verdict, and the figures it was made from — which are printed beside
     it at every size that has room, so the word never stands alone. */
  const shapeKey: 'anomalous' | 'compressed' | 'inflated' | 'normal' =
    outliers.length > 0
      ? 'anomalous'
      : medSpread !== null && medSpread < 25
        ? 'compressed'
        : mean !== null && mean >= 75 && failPct !== null && failPct <= 5
          ? 'inflated'
          : 'normal'
  const shapeWord = t(
    ({
      anomalous: 'bento.principal.moderation_shape_anomalous',
      compressed: 'bento.principal.moderation_shape_compressed',
      inflated: 'bento.principal.moderation_shape_inflated',
      normal: 'bento.principal.moderation_shape_normal',
    } as const)[shapeKey],
  )

  if (status !== 'ready') {
    return (
      <SourceCell
        span={span}
        domain="reports"
        status={status}
        label={t('bento.principal.moderation')}
        value={unmoderated}
        cue={t('bento.principal.cue_moderation')}
        to={href}
      />
    )
  }

  if (rows.length === 0) {
    return (
      <Cell span={span} domain="reports">
        <CellLabel>{t('bento.principal.moderation')}</CellLabel>
        <p className="mt-2 text-[12.5px] font-medium leading-snug">
          {t('bento.principal.moderation_empty')}
        </p>
        {href && <Cue to={href} label={t('bento.principal.cue_moderation')} />}
      </Cell>
    )
  }

  const fieldSr = t('bento.principal.moderation_field_sr', {
    count: papers.length,
    mean: mean !== null ? Math.round(mean) : 0,
    median: med !== null ? Math.round(med) : 0,
  })

  const head = (
    <div className="flex min-w-0 items-baseline gap-2">
      <p className={FIG_CLASS}>{unmoderated}</p>
      <span className="min-w-0 truncate text-[10.5px] font-semibold uppercase tracking-[0.08em]">
        {t('bento.principal.moderation_reviewed', { pct: reviewedPct })}
      </span>
    </div>
  )

  const stats = (
    <p className="text-[10.5px] leading-tight tabular-nums">
      {t('bento.principal.moderation_stats', {
        mean: mean !== null ? Math.round(mean) : 0,
        median: med !== null ? Math.round(med) : 0,
        pass:
          pass === null
            ? '—'
            : pass.lo === pass.hi
              ? `${Math.round(pass.lo)}%`
              : `${Math.round(pass.lo)}–${Math.round(pass.hi)}%`,
      })}
    </p>
  )

  const legend = (
    <p className="text-[9.5px] leading-tight" style={{ color: HAIR }}>
      {t('bento.principal.moderation_legend')}
    </p>
  )

  /* No paper carries an average yet: a distribution of nothing is not drawn. */
  const noField = papers.length === 0

  /* 1x1 — the count, the share reviewed, the verdict, one small field. */
  if (!wide && !tall) {
    return (
      <Cell span={span} domain="reports">
        <CellLabel>{t('bento.principal.moderation')}</CellLabel>
        {head}
        <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]">{shapeWord}</p>
        <div className="mt-1">
          {noField ? (
            <p className="text-[10px] leading-tight" style={{ color: HAIR }}>
              {t('bento.principal.moderation_no_marks')}
            </p>
          ) : (
            <MarkField
              papers={papers}
              mean={mean}
              med={med}
              pass={pass}
              height={22}
              detail={false}
              srLabel={fieldSr}
            />
          )}
        </div>
        {href && <Cue to={href} label={t('bento.principal.cue_moderation')} />}
      </Cell>
    )
  }

  /* 1x2 — the distribution given height, with its reference marks named. */
  if (!wide && tall) {
    return (
      <Cell span={span} domain="reports">
        <CellLabel>{t('bento.principal.moderation')}</CellLabel>
        {head}
        <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]">{shapeWord}</p>
        <div className="mt-2">
          {noField ? (
            <p className="text-[10.5px] leading-snug" style={{ color: HAIR }}>
              {t('bento.principal.moderation_no_marks')}
            </p>
          ) : (
            <MarkField
              papers={papers}
              mean={mean}
              med={med}
              pass={pass}
              height={60}
              detail
              srLabel={fieldSr}
            />
          )}
        </div>
        <div className="mt-1.5">{stats}</div>
        {legend}
        <p className="mt-1.5 text-[10.5px] leading-snug tabular-nums">
          {failPct !== null
            ? t('bento.principal.moderation_below_pass', {
                pct: Math.round(failPct),
                entered,
              })
            : t('bento.principal.moderation_no_marks')}
        </p>
        {noAverage > 0 && (
          <p className="text-[9.5px] leading-snug tabular-nums" style={{ color: HAIR }}>
            {t('bento.principal.moderation_no_average', { count: noAverage })}
          </p>
        )}
        {href && <Cue to={href} label={t('bento.principal.cue_moderation')} />}
      </Cell>
    )
  }

  const outlierLine =
    outliers.length === 0
      ? t('bento.principal.moderation_no_outliers')
      : t('bento.principal.moderation_outliers', {
          count: outliers.length,
          total: papers.length,
          worst: outliers
            .slice()
            .sort((a, b) => Math.abs(b.avg - (med ?? 0)) - Math.abs(a.avg - (med ?? 0)))[0].label,
          value: Math.round(
            outliers
              .slice()
              .sort((a, b) => Math.abs(b.avg - (med ?? 0)) - Math.abs(a.avg - (med ?? 0)))[0].avg,
          ),
        })

  /* 2x1 — the density across the full width, with its bounds and outliers. */
  if (wide && !tall) {
    return (
      <Cell span={span} domain="reports">
        <CellLabel>{t('bento.principal.moderation')}</CellLabel>
        <div className="mt-1 flex min-h-0 flex-1 gap-3">
          <div className="flex w-[124px] shrink-0 flex-col">
            {head}
            <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]">
              {shapeWord}
            </p>
            {stats}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            {noField ? (
              <p className="text-[10.5px] leading-snug" style={{ color: HAIR }}>
                {t('bento.principal.moderation_no_marks')}
              </p>
            ) : (
              <MarkField
                papers={papers}
                mean={mean}
                med={med}
                pass={pass}
                height={52}
                detail
                srLabel={fieldSr}
              />
            )}
            <p className="mt-0.5 text-[9.5px] leading-snug tabular-nums">{outlierLine}</p>
            {legend}
          </div>
        </div>
        {href && <Cue to={href} label={t('bento.principal.cue_moderation')} />}
      </Cell>
    )
  }

  /* 2x2 — the distribution, subject by subject, with the verdict explained. */
  const bySubject = (() => {
    const m = new Map<string, Paper[]>()
    for (const p of papers) m.set(p.subject, [...(m.get(p.subject) ?? []), p])
    return [...m.entries()]
      .map(([subject, list]) => {
        const e = list.reduce((n, x) => n + x.entered, 0)
        const lows = list.map((x) => x.low).filter((v): v is number => v !== null)
        const highs = list.map((x) => x.high).filter((v): v is number => v !== null)
        return {
          subject,
          papers: list.length,
          entered: e,
          mean: e > 0 ? list.reduce((n, x) => n + x.avg * x.entered, 0) / e : list[0].avg,
          lo: lows.length > 0 ? Math.min(...lows) : Math.min(...list.map((x) => x.avg)),
          hi: highs.length > 0 ? Math.max(...highs) : Math.max(...list.map((x) => x.avg)),
        }
      })
      .sort((a, b) => b.mean - a.mean)
  })()
  const SUBJECT_ROWS = 6
  const subjectShown = bySubject.slice(0, SUBJECT_ROWS)

  return (
    <Cell span={span} domain="reports">
      <CellLabel>{t('bento.principal.moderation')}</CellLabel>
      <div className="mt-1 flex min-h-0 flex-1 gap-3.5">
        <div className="flex w-[184px] shrink-0 flex-col">
          {head}
          <p className="mt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]">
            {shapeWord}
          </p>
          <div className="mt-2">
            {noField ? (
              <p className="text-[10.5px] leading-snug" style={{ color: HAIR }}>
                {t('bento.principal.moderation_no_marks')}
              </p>
            ) : (
              <MarkField
                papers={papers}
                mean={mean}
                med={med}
                pass={pass}
                height={54}
                detail
                srLabel={fieldSr}
              />
            )}
          </div>
          <div className="mt-1.5">{stats}</div>
          {legend}
          <p className="mt-1 text-[10px] leading-snug tabular-nums">
            {failPct !== null
              ? t('bento.principal.moderation_below_pass', { pct: Math.round(failPct), entered })
              : t('bento.principal.moderation_no_marks')}
          </p>
          {href && <Cue to={href} label={t('bento.principal.cue_moderation')} />}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <p
            className="text-[9.5px] font-semibold uppercase tracking-[0.1em]"
            style={{ color: HAIR }}
          >
            {t('bento.principal.moderation_subjects')}
          </p>
          <div className="mt-1 flex flex-col gap-[3px]">
            {subjectShown.map((s) => (
              <SubjectRange
                key={s.subject}
                label={s.subject}
                lo={s.lo}
                hi={s.hi}
                mean={s.mean}
                caption={`${Math.round(s.lo)}–${Math.round(s.hi)}`}
                srLabel={t('bento.principal.moderation_subject_sr', {
                  subject: s.subject,
                  lo: Math.round(s.lo),
                  hi: Math.round(s.hi),
                  mean: Math.round(s.mean),
                  papers: s.papers,
                })}
              />
            ))}
          </div>
          {bySubject.length > subjectShown.length && (
            <p className="mt-0.5 text-[9.5px] leading-tight tabular-nums" style={{ color: HAIR }}>
              {t('bento.principal.moderation_subjects_capped', {
                shown: subjectShown.length,
                total: bySubject.length,
              })}
            </p>
          )}
          <p className="mt-1.5 text-[9.5px] leading-snug tabular-nums">{outlierLine}</p>
          {spreads.length > 0 && medSpread !== null && (
            <p className="text-[9.5px] leading-snug tabular-nums" style={{ color: HAIR }}>
              {t('bento.principal.moderation_spread', {
                median: Math.round(medSpread),
                narrowest: Math.round(spreads[0].spread),
                paper: spreads[0].p.label,
              })}
            </p>
          )}
          {deviant !== null && med !== null && (
            <p className="text-[9.5px] leading-snug tabular-nums" style={{ color: HAIR }}>
              {t('bento.principal.moderation_deviation', {
                paper: deviant.label,
                points: Math.round(Math.abs(deviant.avg - med)),
              })}
            </p>
          )}
          <p className="mt-auto text-[9.5px] leading-snug" style={{ color: HAIR }}>
            {t('bento.principal.moderation_per_paper')}
          </p>
        </div>
      </div>
    </Cell>
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

/* ─── TWO INSTRUMENTS: THE SETUP FIELD AND THE COVER BOARD ───────────────

   Both cells below draw their own body rather than handing a `shape` to
   `SourceCell`, and that is not a style preference. `bento-theme.css` sheds
   `.bento-shape` at one row of height, so anything passed through that slot is
   invisible at 1x1 AND at 2x1 — and 2x1 is exactly where the spec asks these
   two for their structure (the setup steps grouped by domain, the cover
   periods as temporal lanes). A drawing that the stylesheet hides is not a
   drawing. So these two keep the label, the figure and the cue that every
   other cell has, and lay out everything between them themselves.

   COLOUR IS ALWAYS A CAST OVER THE CELL'S OWN INK, never a named colour and
   never a hex: `inkOf` mixes a bento token into `currentColor` at the 55% the
   kit measured its floor at, and every fill is that same mark washed toward
   transparent. A cell that turns out to be light, domain-tinted or inverted
   therefore keeps its marks.

   AND COLOUR IS NEVER THE ONLY CHANNEL. Every state carries a glyph and, at
   every size, a word: in the row itself where there is room for one, in the
   `title` of the mark, and in the `srLabel` of the field it belongs to. */

/** The mark: a bento hue cast over the ink this cell resolved for itself. A
    null hue is the neutral weight, for the state that means "nothing has
    happened here yet". */
type Hue = 'mint' | 'purple' | 'pink' | 'orange'
const inkOf = (hue: Hue | null) =>
  hue ? `color-mix(in srgb, var(--bento-${hue}) 55%, currentColor)` : 'currentColor'
/** The same mark, washed back to sit UNDER something — a fill behind a glyph,
    a chip behind a label. Decoration; the glyph and the word on top carry the
    reading. */
const washOf = (hue: Hue | null, pct: number) =>
  `color-mix(in srgb, ${inkOf(hue)} ${pct}%, transparent)`
/** Geometry: an axis, a track, a boundary. Never a series. */
const RULE = 'color-mix(in srgb, currentColor 14%, transparent)'

/** The error and loading faces both cells share with every other cell on this
    board: a fetch that failed draws an error and never a nought, and a fetch
    in flight draws a dash. */
function InstrumentError({
  span, domain, label,
}: {
  span: CellSpan
  domain: string
  label: string
}) {
  const t = useT()
  return (
    <Cell span={span} domain={domain}>
      <CellLabel>{label}</CellLabel>
      <div className="mt-4">
        <CellError message={t('bento.principal.source_failed')} />
      </div>
    </Cell>
  )
}

// --- the setup checklist ------------------------------------------------

/** What a step is, beyond the four fields the shared interface names.
    `/setup/status` returns `count` and `detail` on every step as well; both
    are optional here so that a response without them draws one field fewer
    rather than the word "undefined". */
type SetupStepDetail = SetupStep & { count?: number; detail?: string }

/** The four states the spec asks for, all four derived from fields the
    handler actually returns:

      done      `done` is true.
      active    the first step that is not done, blocking ones first — the
                "current blocking step" the 1x1 is asked for.
      blocked   not done, `blocking` true, and not the active one: a hard
                requirement waiting behind the one in hand.
      pending   not done and not blocking. Real work, but nothing stops the
                school running while it is outstanding. */
type StepState = 'done' | 'active' | 'blocked' | 'pending'

const STEP_HUE: Record<StepState, Hue | null> = {
  done: 'mint',
  active: 'purple',
  blocked: 'pink',
  pending: null,
}
const STEP_GLYPH: Record<StepState, string> = {
  done: '✓',
  active: '▸',
  blocked: '!',
  pending: '·',
}
const STEP_WORD = {
  done: 'bento.principal.setup_state_done',
  active: 'bento.principal.setup_state_active',
  blocked: 'bento.principal.setup_state_blocked',
  pending: 'bento.principal.setup_state_pending',
} as const satisfies Record<StepState, string>

/** The five domains the spec names for the 2x1. */
type SetupDomain = 'admin' | 'academic' | 'staff' | 'finance' | 'system'

/* WHICH DOMAIN EACH SETUP STEP BELONGS TO — HAND-WRITTEN, AND HERE IS WHY.

   `/setup/status` does not carry a domain. `key` is the step's own name
   ('class_subjects', 'fee_structures', 'udise'), not a domain, and no other
   field in the response encodes one: the handler builds a flat list of
   fifteen. The spec's five groups therefore have to be a mapping this file
   owns, so it is written out once, in full, in one table — rather than being
   inferred from prefixes, which would put a step in the wrong group the first
   time somebody renames a key.

   NOTHING IS DERIVED FROM THIS BUT THE GROUPING. Every count drawn per group
   is a count of the steps the response actually returned in that group, so a
   key this table has never seen still lands somewhere and is still counted:
   it falls to 'system', which is where an unclassified piece of school
   configuration belongs, rather than being dropped from a denominator. */
const SETUP_DOMAIN: Record<string, SetupDomain> = {
  // The school's own identity, its site, and the children on the roll.
  profile: 'admin',
  campus: 'admin',
  students: 'admin',
  // The year, what is taught in it, and how it is examined and graded.
  academic_year: 'academic',
  classes: 'academic',
  sections: 'academic',
  subjects: 'academic',
  class_subjects: 'academic',
  periods: 'academic',
  grading: 'academic',
  exams: 'academic',
  // The people who teach and run it.
  staff: 'staff',
  // Money.
  fee_heads: 'finance',
  fee_structures: 'finance',
  // Statutory registration.
  udise: 'system',
}
const SETUP_DOMAINS: readonly SetupDomain[] = ['admin', 'academic', 'staff', 'finance', 'system']
const DOMAIN_WORD = {
  admin: 'bento.principal.setup_dom_admin',
  academic: 'bento.principal.setup_dom_academic',
  staff: 'bento.principal.setup_dom_staff',
  finance: 'bento.principal.setup_dom_finance',
  system: 'bento.principal.setup_dom_system',
} as const satisfies Record<SetupDomain, string>

/** One step, as a small square: the state's glyph on the state's own wash.
    Never colour alone — the glyph differs per state, and the `title` names the
    step and says its state in words. */
function StepMark({ state, title, px }: { state: StepState; title: string; px: number }) {
  const hue = STEP_HUE[state]
  return (
    <span
      title={title}
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-[3px] font-bold leading-none"
      style={{
        height: `${px}px`,
        width: `${px}px`,
        fontSize: `${Math.max(7, Math.round(px * 0.62))}px`,
        background: washOf(hue, state === 'pending' ? 10 : 22),
        boxShadow: `inset 0 0 0 1px ${washOf(hue, state === 'pending' ? 26 : 55)}`,
        color: inkOf(hue),
      }}
    >
      {STEP_GLYPH[state]}
    </span>
  )
}

/** The setup checklist, drawn to fit.

    1x1  done over total, the percentage, all fifteen steps as a field of
         states, and the step that is blocking now.
    1x2  the same signal over the fifteen steps THEMSELVES, in the handler's
         own order, each with its state in words and the count it has already
         got (17 sections, 240 students) where it has one.
    2x1  the fifteen grouped into the five domains, each group with its own
         real denominator, its own rail and its own steps.
    2x2  all of it: the signal, the five groups, the full named field in two
         columns, and what is left to do underneath.

    NOTHING HERE DIVIDES BY A NUMBER THAT DID NOT ARRIVE. Every denominator is
    either `total` from the response or the number of steps the response put
    in that group. */
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
  const label = t('bento.principal.setup')

  if (status === 'error') return <InstrumentError span={span} domain="operations" label={label} />
  if (status === 'loading') {
    return (
      <StatCell
        span={span}
        domain="operations"
        label={label}
        value={t('bento.principal.source_pending')}
        note={t('bento.principal.source_loading')}
      />
    )
  }

  const steps = (data?.steps ?? []) as SetupStepDetail[]
  const total = data?.total ?? steps.length
  const done = data?.completed ?? steps.filter((s) => s.done).length
  const pct = total > 0 ? Math.round((done / total) * 100) : null

  /* The active step: the first outstanding blocker, or — with no blockers
     left — simply the first thing still to do. Order is the handler's, which
     is the order a school is meant to work through. */
  const firstBlocking = steps.findIndex((s) => !s.done && s.blocking)
  const firstOpen = steps.findIndex((s) => !s.done)
  const activeIdx = firstBlocking >= 0 ? firstBlocking : firstOpen
  const stateOfStep = (s: SetupStepDetail, i: number): StepState =>
    s.done ? 'done' : i === activeIdx ? 'active' : s.blocking ? 'blocked' : 'pending'
  const states = steps.map(stateOfStep)
  const next = activeIdx >= 0 ? steps[activeIdx] : undefined
  const blocking = data?.blocking_remaining ?? 0

  const titleOf = (s: SetupStepDetail, i: number) =>
    `${s.label} — ${t(STEP_WORD[states[i]])}${s.count ? ` (${s.count})` : ''}`
  const listOf = (st: StepState) =>
    steps.filter((_, i) => states[i] === st).map((s) => s.label).join(', ') || '—'
  const fieldSr = t('bento.principal.setup_field_sr2', {
    total,
    done: listOf('done'),
    blocked: [...(next ? [next.label] : []), ...steps.filter((_, i) => states[i] === 'blocked').map((s) => s.label)].join(', ') || '—',
    pending: listOf('pending'),
  })

  const groups = SETUP_DOMAINS.map((domain) => {
    const members = steps
      .map((s, i) => ({ step: s, state: states[i], i }))
      .filter((x) => (SETUP_DOMAIN[x.step.key] ?? 'system') === domain)
    return { domain, members, done: members.filter((m) => m.step.done).length }
  }).filter((g) => g.members.length > 0)

  /* The sentence under the figure, which says what the number means rather
     than repeating it: what is blocking, or that nothing is. */
  const statusLine = blocking > 0
    ? t('bento.principal.setup_blocking_count', { count: blocking })
    : data?.ready
      ? t('bento.principal.setup_ready')
      : t('bento.principal.setup_optional_left', { count: total - done })

  const header = (
    <>
      <CellLabel>{label}</CellLabel>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <p className={FIG_CLASS}>{total > 0 ? `${done}/${total}` : '—'}</p>
        {pct !== null && (
          <span className="text-[12px] font-semibold tabular-nums" style={{ color: inkOf('mint') }}>
            {t('bento.principal.setup_pct', { pct })}
          </span>
        )}
        <span className="truncate text-[11px] leading-tight text-[var(--bento-muted)]">
          {statusLine}
        </span>
      </div>
    </>
  )

  /** The fifteen as a wrapped field of marks. The 1x1's whole structure. */
  const strip = steps.length > 0 && (
    <div role="img" aria-label={fieldSr} className="flex flex-wrap gap-[2px]">
      {steps.map((s, i) => (
        <StepMark key={s.key} state={states[i]} title={titleOf(s, i)} px={wide && tall ? 13 : 12} />
      ))}
    </div>
  )

  /** One named row per step: the mark, the step, and either the count it has
      already got or the word for its state. */
  const rows = (cols: 1 | 2) => (
    <div
      role="img"
      aria-label={fieldSr}
      className={cn('grid gap-x-3', cols === 2 ? 'grid-cols-2 gap-y-[3px]' : 'grid-cols-1 gap-y-[2px]')}
    >
      {steps.map((s, i) => (
        <div key={s.key} className="flex min-w-0 items-center gap-1.5">
          <StepMark state={states[i]} title={titleOf(s, i)} px={11} />
          <span
            className="min-w-0 flex-1 truncate text-[10.5px] leading-tight"
            style={{ opacity: states[i] === 'pending' ? 0.75 : 1 }}
          >
            {s.label}
          </span>
          <span className="shrink-0 text-[9.5px] leading-tight tabular-nums text-[var(--bento-muted)]">
            {s.done && s.count ? s.count : t(STEP_WORD[states[i]])}
          </span>
        </div>
      ))}
    </div>
  )

  /** The five domains, each with the steps it owns and a rail over its own
      real denominator. */
  const groupGrid = (
    <div className="grid grid-cols-5 gap-x-2">
      {groups.map((g) => (
        <div
          key={g.domain}
          role="img"
          aria-label={t('bento.principal.setup_group_sr', {
            domain: t(DOMAIN_WORD[g.domain]),
            done: g.done,
            total: g.members.length,
          })}
          className="min-w-0"
        >
          <div className="flex items-baseline justify-between gap-1">
            <span className="truncate text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--bento-muted)]">
              {t(DOMAIN_WORD[g.domain])}
            </span>
            <span className="shrink-0 text-[10px] font-semibold tabular-nums">
              {g.done}/{g.members.length}
            </span>
          </div>
          <div
            aria-hidden="true"
            className="mt-1 h-[4px] w-full overflow-hidden rounded-full"
            style={{ background: RULE }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${(g.done / g.members.length) * 100}%`,
                background: `linear-gradient(90deg, ${inkOf('mint')}, ${washOf('mint', 70)})`,
              }}
            />
          </div>
          <div className="mt-1 flex flex-wrap gap-[2px]">
            {g.members.map((m) => (
              <StepMark
                key={m.step.key}
                state={m.state}
                title={titleOf(m.step, m.i)}
                px={9}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )

  /** The states, in words, next to the marks that carry them. Four tokens; it
      is what makes the field readable without colour. */
  const legend = (
    <div aria-hidden="true" className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {(['done', 'active', 'blocked', 'pending'] as StepState[]).map((st) => (
        <span key={st} className="flex items-center gap-1 text-[9.5px] leading-none text-[var(--bento-muted)]">
          <StepMark state={st} title={t(STEP_WORD[st])} px={9} />
          {t(STEP_WORD[st])}
        </span>
      ))}
    </div>
  )

  let body: ReactNode
  if (wide && tall) {
    body = (
      <div className="mt-2 flex min-h-0 flex-col gap-2">
        {groupGrid}
        {rows(2)}
        {legend}
      </div>
    )
  } else if (tall) {
    body = <div className="mt-2 flex min-h-0 flex-col gap-1.5">{rows(1)}</div>
  } else if (wide) {
    body = <div className="mt-2">{groupGrid}</div>
  } else {
    body = (
      <div className="mt-2 flex min-h-0 flex-col gap-1.5">
        {strip}
        <p className="truncate text-[10.5px] leading-tight">
          {next
            ? t('bento.principal.setup_next', { label: next.label })
            : t('bento.principal.setup_next_none')}
        </p>
      </div>
    )
  }

  return (
    <Cell span={span} domain="operations">
      {header}
      {body}
      <span className="sr-only">{fieldSr}</span>
      {href && <Cue to={href} label={t('bento.principal.cue_setup')} />}
    </Cell>
  )
}

// --- today's cover ------------------------------------------------------

/** One period an absence left behind, with the fields the substitution board
    returns beyond the four the shared interface names. `section`,
    `absent_teacher` and `candidates` are all in the handler's SELECT; they are
    optional here only so the parent's narrower type still assigns. */
type CoverPeriod = CoverSlot & {
  section?: string
  absent_teacher?: string
  reason?: string
  candidates?: unknown[]
}

/** The three states of a period the board reports, and they are three and not
    two on purpose: a period nobody has covered YET and a period nobody COULD
    cover are the same red on a summary and two entirely different mornings. */
type CoverState = 'covered' | 'open' | 'stuck'

const COVER_HUE: Record<CoverState, Hue> = {
  covered: 'mint',
  open: 'orange',
  stuck: 'pink',
}
const COVER_GLYPH: Record<CoverState, string> = { covered: '✓', open: '○', stuck: '✕' }
const COVER_WORD = {
  covered: 'bento.principal.cover_covered',
  open: 'bento.principal.cover_open',
  stuck: 'bento.principal.cover_stuck',
} as const satisfies Record<CoverState, string>

/* THE CLOCK, AND THE TRAP THIS CELL HAS ALREADY FALLEN INTO ONCE.

   `starts_at` off the substitution board is `to_char(p.starts_at,'HH24:MI')` —
   a bare wall-clock time, '09:15', with no date on it. `new Date('09:15')` is
   not a time at all: it is Invalid Date in every browser, and the variants
   that do parse land the period in 1970, where every period of the day sits on
   the same instant and the axis collapses to a point.

   So no Date is built from it anywhere below. A period's position is its
   MINUTE OF THE DAY, an integer, and every axis here is an interval of
   minutes. The board's own `on_date` is what says which day those minutes
   belong to, and it is used for exactly one thing: deciding whether the now
   marker may be drawn at all. */
const HHMM = /^(\d{1,2}):(\d{2})/
function minuteOfDay(clock: string | undefined): number | null {
  const m = HHMM.exec(clock ?? '')
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 23 || mm > 59) return null
  return hh * 60 + mm
}
const clockText = (mins: number) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(Math.round(mins) % 60).padStart(2, '0')}`

/** Today, as the school's own calendar day rather than as UTC.

    `toISOString().slice(0,10)` is the UTC date, and between midnight and
    05:30 in India that is yesterday. The now marker is a claim about where the
    school is in its own day, so it is the local date that decides whether the
    board being drawn is today's. */
function localDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Today's cover, drawn to fit — an operational instrument, on the board's own
    clock times.

    1x1  uncovered count, the state in a word, coverage against the periods the
         absences left, and the day as a compact strip with a mark per period
         and the now line on it.
    1x2  the real time axis, vertically: every period in clock order beside the
         axis it sits on, its state in words, start and end of the day printed,
         the now marker where the board is today's.
    2x1  the day's axis across the top, then the periods as temporal lanes —
         time, period, class and section, state, and who is covering it.
    2x2  the full coverage field: one lane per class-section, real clock times
         across the top, a boundary rule at every period start, all three
         states, the absent teacher and the cover, and the now marker.

    THE DENOMINATOR IS THE ENDPOINT'S OWN. `summary.periods` is the number of
    periods today's absences left behind — not the school's timetable, which
    this response does not carry — and every proportion below is against that.
    With no absences it is zero, and a zero denominator draws no percentage and
    no bar: it draws the sentence that says nobody needed covering. */
function CoverCell({
  span, summary, slots, onDate, status, href,
}: {
  span: CellSpan
  summary?: SubstitutionBoard['summary']
  slots: CoverPeriod[]
  onDate: string
  status: CellStatus
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2
  const label = t('bento.principal.cover')

  if (status === 'error') return <InstrumentError span={span} domain="academics" label={label} />
  if (status === 'loading') {
    return (
      <StatCell
        span={span}
        domain="academics"
        label={label}
        value={t('bento.principal.source_pending')}
        note={t('bento.principal.source_loading')}
      />
    )
  }

  const periods = summary?.periods ?? slots.length
  const covered = summary?.covered ?? slots.filter((s) => s.covered_by).length
  const uncovered = summary?.uncovered ?? periods - covered
  const stuck = summary?.no_candidate ?? 0
  const pct = periods > 0 ? Math.round((covered / periods) * 100) : null

  /* Per period, the same rule the handler counts by: covered if somebody is
     on it, stuck if nobody is free for it, open otherwise. */
  const stateOfSlot = (s: CoverPeriod): CoverState =>
    s.covered_by ? 'covered' : Array.isArray(s.candidates) && s.candidates.length === 0 ? 'stuck' : 'open'

  const marked = slots
    .map((s) => ({ slot: s, at: minuteOfDay(s.starts_at), state: stateOfSlot(s) }))
    .sort(
      (a, b) =>
        (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER) ||
        a.slot.period_sequence - b.slot.period_sequence,
    )
  const timed = marked.filter((m) => m.at !== null) as { slot: CoverPeriod; at: number; state: CoverState }[]

  const first = timed.length > 0 ? timed[0].at : null
  const last = timed.length > 0 ? timed[timed.length - 1].at : null
  /* A day with one period in it has a window of zero width. Rather than
     dividing by nothing, the axis is opened to half an hour either side of
     that single time — the mark still sits on its own real clock time, and the
     times printed at the ends are the period's, not the padding's. */
  const pad = first !== null && last !== null ? Math.max(10, (last - first) * 0.06) : 0
  const axisFrom = first !== null ? first - pad : 0
  const axisTo = last !== null ? last + pad : 0
  const axisSpan = axisTo - axisFrom
  const xOf = (at: number) => (axisSpan > 0 ? ((at - axisFrom) / axisSpan) * 100 : 50)

  /* The now marker is drawn only when the board being read IS today's. On any
     other date a line labelled "now" is a claim about a day that is not the
     one on the screen. */
  const now = new Date()
  const isToday = onDate === localDay(now)
  const nowMins = now.getHours() * 60 + now.getMinutes()
  const showNow = isToday && axisSpan > 0 && nowMins >= axisFrom && nowMins <= axisTo

  const dayLine =
    first === null || last === null
      ? null
      : first === last
        ? t('bento.principal.cover_day_one', { at: clockText(first) })
        : t('bento.principal.cover_day', { from: clockText(first), to: clockText(last) })

  const stateWord = (st: CoverState) => t(COVER_WORD[st])
  const coverOf = (s: CoverPeriod) => s.covered_by ?? t('bento.principal.cover_no_cover')
  const classOf = (s: CoverPeriod) => `${s.class_name}${s.section ? `-${s.section}` : ''}`
  const titleOf = (m: { slot: CoverPeriod; at: number | null; state: CoverState }) =>
    `${m.at !== null ? `${clockText(m.at)} · ` : ''}${m.slot.period} · ${classOf(m.slot)} ${
      m.slot.subject
    } — ${stateWord(m.state)}${m.slot.covered_by ? `: ${m.slot.covered_by}` : ''}${
      m.slot.absent_teacher ? ` (${t('bento.principal.cover_for', { teacher: m.slot.absent_teacher })})` : ''
    }`

  const fieldSr = t('bento.principal.cover_axis_sr', {
    periods,
    covered,
    open: Math.max(0, uncovered - stuck),
    stuck,
    list: marked.map((m) => titleOf(m)).join('; ') || '—',
  })

  const statusWord =
    periods === 0
      ? t('bento.principal.cover_nothing')
      : uncovered === 0
        ? t('bento.principal.cover_all_covered')
        : stuck > 0
          ? t('bento.principal.cover_stuck_count', { count: stuck })
          : t('bento.principal.cover_open_count', { count: uncovered })

  const header = (
    <>
      <CellLabel>{label}</CellLabel>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <p className={FIG_CLASS}>{uncovered}</p>
        <span
          className="text-[12px] font-semibold leading-tight"
          style={{ color: inkOf(uncovered > 0 ? (stuck > 0 ? 'pink' : 'orange') : 'mint') }}
        >
          {statusWord}
        </span>
        <span className="truncate text-[11px] leading-tight text-[var(--bento-muted)]">
          {periods > 0
            ? t('bento.principal.cover_of_periods', { covered, periods, pct: pct ?? 0 })
            : t('bento.principal.cover_away', { count: summary?.absent_teachers ?? 0 })}
        </span>
      </div>
    </>
  )

  /** The three states as one bar over the endpoint's own denominator, with the
      counts printed beside the words. This is the field's legend as well as
      its summary — the hues here are the hues the marks below use. */
  const stateBar = periods > 0 && (
    <div>
      <div aria-hidden="true" className="flex h-[9px] w-full items-stretch gap-[3px]">
        {([
          ['covered', covered],
          ['open', Math.max(0, uncovered - stuck)],
          ['stuck', stuck],
        ] as [CoverState, number][])
          .filter(([, v]) => v > 0)
          .map(([st, v]) => (
            <div
              key={st}
              title={`${stateWord(st)}: ${v}`}
              className="rounded-full"
              style={{
                width: `${(v / periods) * 100}%`,
                minWidth: '5px',
                background: `linear-gradient(90deg, ${inkOf(COVER_HUE[st])}, ${washOf(COVER_HUE[st], 62)})`,
              }}
            />
          ))}
      </div>
      <div aria-hidden="true" className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        {(['covered', 'open', 'stuck'] as CoverState[]).map((st) => {
          const v = st === 'covered' ? covered : st === 'stuck' ? stuck : Math.max(0, uncovered - stuck)
          return (
            <span key={st} className="flex items-center gap-1 text-[10px] leading-none">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: inkOf(COVER_HUE[st]) }}
              />
              <span className="text-[var(--bento-muted)]">{stateWord(st)}</span>
              <span className="font-semibold tabular-nums">{v}</span>
            </span>
          )
        })}
      </div>
    </div>
  )

  /** The day as one horizontal axis: a mark per period at its own clock time,
      a boundary at each, the now line where it belongs. */
  const dayAxis = (height: number, withTimes: boolean) =>
    timed.length > 0 && (
      <div role="img" aria-label={fieldSr}>
        <div className="relative w-full" style={{ height: `${height}px` }}>
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 rounded-full"
            style={{ background: RULE }}
          />
          {timed.map((m, i) => (
            <span
              key={`${m.slot.timetable_entry_id}-${i}`}
              title={titleOf(m)}
              aria-hidden="true"
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                left: `${xOf(m.at)}%`,
                height: `${height - 2}px`,
                width: '4px',
                background: inkOf(COVER_HUE[m.state]),
              }}
            />
          ))}
          {showNow && (
            <span
              aria-hidden="true"
              title={t('bento.principal.cover_now', { time: clockText(nowMins) })}
              className="absolute inset-y-0 w-[1.5px] -translate-x-1/2"
              style={{ left: `${xOf(nowMins)}%`, background: inkOf('purple') }}
            />
          )}
        </div>
        {withTimes && dayLine && (
          <div className="mt-0.5 flex items-baseline justify-between text-[9px] leading-none tabular-nums text-[var(--bento-muted)]">
            <span>{first !== null ? clockText(first) : ''}</span>
            {showNow && (
              <span style={{ color: inkOf('purple') }}>
                {t('bento.principal.cover_now', { time: clockText(nowMins) })}
              </span>
            )}
            <span>{last !== null ? clockText(last) : ''}</span>
          </div>
        )}
      </div>
    )

  /** Nothing to cover is a finding, not an empty cell. */
  const calm = (
    <p className="mt-2 text-[11px] leading-snug">
      {t('bento.principal.cover_none_needed', { count: summary?.absent_teachers ?? 0 })}
    </p>
  )

  let body: ReactNode

  if (wide && tall) {
    /* THE FULL FIELD. One lane per class-section, the clock across the top,
       a boundary rule at every period start.

       A PERIOD IS DRAWN AS A TICK AT ITS START TIME, WITH ITS LABEL BESIDE IT,
       AND NOT AS A BLOCK SPANNING A DURATION. The board returns `starts_at`
       and nothing else — no end time and no length — so a rectangle whose
       width was a duration would be a width nobody measured. The tick is the
       datum; the chip next to it is its label. */
    const lanesAll = [...new Map(timed.map((m) => [classOf(m.slot), m])).keys()]
    const shownLanes = lanesAll.slice(0, 6)
    const laneRows = shownLanes.map((name) => ({
      name,
      items: timed.filter((m) => classOf(m.slot) === name),
    }))
    const boundaries = [...new Set(timed.map((m) => m.at))].sort((a, b) => a - b)
    const labelEvery = Math.ceil(boundaries.length / 7)

    body = (
      <div className="mt-2 flex min-h-0 flex-col gap-2">
        {stateBar}
        {timed.length > 0 ? (
          <div role="img" aria-label={fieldSr} className="flex min-w-0 flex-col">
            {/* The clock, and the period it belongs to, above the field. */}
            <div className="flex items-end">
              <span className="w-[54px] shrink-0" />
              <div className="relative h-[13px] flex-1">
                {boundaries.map((b, i) =>
                  i % labelEvery === 0 ? (
                    <span
                      key={b}
                      aria-hidden="true"
                      className="absolute bottom-0 -translate-x-1/2 text-[8.5px] leading-none tabular-nums text-[var(--bento-muted)]"
                      style={{ left: `${xOf(b)}%` }}
                    >
                      {clockText(b)}
                    </span>
                  ) : null,
                )}
                {showNow && (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0 -translate-x-1/2 text-[8.5px] font-semibold leading-none"
                    style={{ left: `${xOf(nowMins)}%`, color: inkOf('purple') }}
                  >
                    {t('bento.principal.cover_now', { time: clockText(nowMins) })}
                  </span>
                )}
              </div>
            </div>
            {laneRows.map((lane) => (
              <div key={lane.name} className="flex items-center">
                <span className="w-[54px] shrink-0 truncate pr-1 text-[9.5px] font-semibold leading-none">
                  {lane.name}
                </span>
                <div className="relative h-[24px] flex-1">
                  {/* The period boundaries, behind everything: real starts, so
                      a lane's gaps are the school's gaps. */}
                  {boundaries.map((b) => (
                    <span
                      key={b}
                      aria-hidden="true"
                      className="absolute inset-y-0 w-px"
                      style={{ left: `${xOf(b)}%`, background: RULE }}
                    />
                  ))}
                  {showNow && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-0 w-[1.5px] -translate-x-1/2"
                      style={{ left: `${xOf(nowMins)}%`, background: washOf('purple', 70) }}
                    />
                  )}
                  {lane.items.map((m, i) => (
                    <span
                      key={`${m.slot.timetable_entry_id}-${i}`}
                      title={titleOf(m)}
                      aria-hidden="true"
                      className="absolute top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-[4px] py-[2px] pl-[3px] pr-1.5"
                      style={{
                        left: `${xOf(m.at)}%`,
                        maxWidth: '112px',
                        background: washOf(COVER_HUE[m.state], 18),
                        boxShadow: `inset 0 0 0 1px ${washOf(COVER_HUE[m.state], 55)}`,
                      }}
                    >
                      <span
                        className="text-[9px] font-bold leading-none"
                        style={{ color: inkOf(COVER_HUE[m.state]) }}
                      >
                        {COVER_GLYPH[m.state]}
                      </span>
                      <span className="truncate text-[9px] leading-none">
                        {m.slot.subject} · {m.slot.covered_by ?? stateWord(m.state)}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          calm
        )}
        {timed.length > 0 && (
          <p className="text-[10px] leading-tight text-[var(--bento-muted)]">
            {lanesAll.length > shownLanes.length
              ? t('bento.principal.cover_more_classes', {
                  count: lanesAll.length - shownLanes.length,
                  day: dayLine ?? '',
                })
              : dayLine}
            {isToday ? '' : ` · ${t('bento.principal.cover_not_today', { date: onDate })}`}
          </p>
        )}
      </div>
    )
  } else if (tall) {
    /* THE AXIS, VERTICALLY. A narrow cell cannot hold a horizontal clock and
       a legible label at the same time, so the axis runs down the left edge
       with each period's mark at its own proportional height, and the reading
       runs beside it. */
    const shown = marked.slice(0, 11)
    body = (
      <div className="mt-2 flex min-h-0 flex-col gap-1">
        {periods === 0 ? (
          calm
        ) : (
          <>
            <div className="flex items-baseline justify-between text-[9.5px] leading-none tabular-nums text-[var(--bento-muted)]">
              <span>{dayLine}</span>
              {showNow && (
                <span style={{ color: inkOf('purple') }}>
                  {t('bento.principal.cover_now', { time: clockText(nowMins) })}
                </span>
              )}
            </div>
            <div role="img" aria-label={fieldSr} className="flex min-h-0 flex-1 gap-2">
              <div className="relative w-[8px] shrink-0">
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 rounded-full"
                  style={{ background: RULE }}
                />
                {timed.map((m, i) => (
                  <span
                    key={`${m.slot.timetable_entry_id}-${i}`}
                    aria-hidden="true"
                    title={titleOf(m)}
                    className="absolute left-1/2 h-[6px] w-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full"
                    style={{ top: `${xOf(m.at)}%`, background: inkOf(COVER_HUE[m.state]) }}
                  />
                ))}
                {showNow && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-[-3px] h-[1.5px] -translate-y-1/2"
                    style={{ top: `${xOf(nowMins)}%`, background: inkOf('purple') }}
                  />
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                {shown.map((m, i) => (
                  <div key={`${m.slot.timetable_entry_id}-${i}`} className="flex min-w-0 items-center gap-1.5">
                    <span className="w-[30px] shrink-0 text-[9.5px] leading-none tabular-nums text-[var(--bento-muted)]">
                      {m.at !== null ? clockText(m.at) : m.slot.period}
                    </span>
                    <span
                      aria-hidden="true"
                      className="h-[9px] w-[9px] shrink-0 rounded-full text-center text-[7px] font-bold leading-[9px]"
                      style={{
                        background: washOf(COVER_HUE[m.state], 20),
                        boxShadow: `inset 0 0 0 1px ${washOf(COVER_HUE[m.state], 55)}`,
                        color: inkOf(COVER_HUE[m.state]),
                      }}
                    >
                      {COVER_GLYPH[m.state]}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[10px] leading-none">
                      {classOf(m.slot)} {m.slot.subject}
                    </span>
                    <span
                      className="shrink-0 text-[9px] leading-none"
                      style={{ color: inkOf(COVER_HUE[m.state]) }}
                    >
                      {stateWord(m.state)}
                    </span>
                  </div>
                ))}
                {marked.length > shown.length && (
                  <span className="text-[9.5px] leading-none text-[var(--bento-muted)]">
                    {t('bento.principal.cover_more', { count: marked.length - shown.length })}
                  </span>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    )
  } else if (wide) {
    /* TEMPORAL LANES. The day's axis across the top, then one lane per period
       carrying the five things the morning is arranged from: the time, the
       period, the class and section, the state in a word, and who is on it. */
    const shown = marked.slice(0, 4)
    body = (
      <div className="mt-1.5 flex min-h-0 flex-col gap-1">
        {periods === 0 ? (
          calm
        ) : (
          <>
            {dayAxis(10, false)}
            <div className="flex min-w-0 flex-col gap-[2px]">
              <div
                aria-hidden="true"
                className="flex items-center gap-2 text-[8.5px] uppercase leading-none tracking-[0.08em] text-[var(--bento-muted)]"
              >
                <span className="w-[32px] shrink-0">{t('bento.principal.cover_h_time')}</span>
                <span className="w-[26px] shrink-0">{t('bento.principal.cover_h_period')}</span>
                <span className="min-w-0 flex-1">{t('bento.principal.cover_h_class')}</span>
                <span className="w-[58px] shrink-0">{t('bento.principal.cover_h_state')}</span>
                <span className="w-[84px] shrink-0">{t('bento.principal.cover_h_cover')}</span>
              </div>
              {shown.map((m, i) => (
                <div
                  key={`${m.slot.timetable_entry_id}-${i}`}
                  title={titleOf(m)}
                  className="flex min-w-0 items-center gap-2 rounded-[3px] py-[1px] pl-1 pr-1"
                  style={{ background: washOf(COVER_HUE[m.state], m.state === 'covered' ? 8 : 14) }}
                >
                  <span className="w-[32px] shrink-0 text-[10px] leading-none tabular-nums">
                    {m.at !== null ? clockText(m.at) : '—'}
                  </span>
                  <span className="w-[26px] shrink-0 truncate text-[10px] leading-none text-[var(--bento-muted)]">
                    {m.slot.period}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[10px] leading-none">
                    {classOf(m.slot)} · {m.slot.subject}
                  </span>
                  <span
                    className="w-[58px] shrink-0 truncate text-[10px] font-semibold leading-none"
                    style={{ color: inkOf(COVER_HUE[m.state]) }}
                  >
                    {stateWord(m.state)}
                  </span>
                  <span className="w-[84px] shrink-0 truncate text-[10px] leading-none text-[var(--bento-muted)]">
                    {coverOf(m.slot)}
                  </span>
                </div>
              ))}
              {marked.length > shown.length && (
                <span className="text-[9.5px] leading-none text-[var(--bento-muted)]">
                  {t('bento.principal.cover_more', { count: marked.length - shown.length })}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    )
  } else {
    body = (
      <div className="mt-2 flex min-h-0 flex-col gap-1">
        {periods === 0 ? calm : dayAxis(12, true)}
      </div>
    )
  }

  return (
    <Cell span={span} domain="academics">
      {header}
      {body}
      <span className="sr-only">{fieldSr}</span>
      {href && <Cue to={href} label={t('bento.principal.cue_cover')} />}
    </Cell>
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

/** Attendance, drawn to fit.

    1x1  SIGNAL. The figure, the change against the earlier half of the same
         thirty days, whether today is above or below its own median, and a
         ten-day trace with the median rule under it.
    1x2  SIGNAL + MOVEMENT. The full thirty-day trajectory given real height,
         with the median rule, the middle-half band, the current endpoint and
         the best and worst day marked and named.
    2x1  SIGNAL + STRUCTURE. The figure and its trace on the left; on the
         right the median by weekday as compact bands, best and worst marked.
    2x2  All four. The large figure, the trajectory with band and markers, the
         weekday structure AND the per-day present/absent composition, with the
         high, the low, the median and the coverage of the window spelled out.

    Every comparison here is the school against its own month: there is no
    stored attendance target, and one invented to give the card something to
    say would be the fourth fabricated denominator this product has had to
    remove. Under two days there is no median worth the name and no rule is
    drawn. */
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
  /* The daily percentages on their own. The richer per-day shape lives in
     `series`; `PulseCell` reads the bare numbers for its trace. */
  const points = series.map((d) => d.pct)
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
  /* THE SUPPORTING FIGURES FOR THE FLAT CELLS.

     Every one of these is a scalar off `/principal/dashboard` or a ratio of
     two of them, and both halves of every ratio are counts of the same school
     taken at the same instant — students over sections is the average section,
     students over staff is the teaching load. Neither is a share of a whole,
     because there is no whole in this response to be a share of: the handler
     returns fifteen numbers and not one distribution.

     WHAT IS NOT HERE, and is not here on purpose. No enrolment history, no
     grade distribution, no staff type or department split, no approval-type
     or application-stage breakdown, and no previous-period value for anything.
     The spec asks for each of those "if available"; none of them is in the
     response, so none of them is drawn and none is derived from two figures
     that measure different things. */
  const perSection = k.sections > 0 ? Math.round(k.students / k.sections) : 0
  /* Arrears carried in from earlier years, and the only way to get it: the Go
     comment defines `outstanding_paise` as every unpaid invoice of every year
     and `outstanding_year_paise` as this year's rows alone, so the difference
     is exactly the older debt. Drawn only when the year trio is populated —
     without it the subtraction is a number minus nought, which is not a fact
     about earlier years. */
  const arrears = yearly ? k.outstanding_paise - k.outstanding_year_paise : 0
  /* A level is true now; a flow is true for the range that was asked for. The
     source line under each figure says which, because "collected" without a
     period is the sentence that puts a wrong number in a meeting. */
  const asOfNow = t('bento.principal.prov_as_of_now')



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
          <SourceCell
            span={span}
            status="ready"
            domain="finance"
            label={t(yearly ? 'bento.principal.outstanding' : 'bento.principal.outstanding_plain')}
            value={formatPaise(outstanding)}
            art={<BlockedFlowArt moved={movedShare} />}
            /* Meter, share and the "this year" wording only when there is a
               year to measure against. Without one this drew a bar and a
               sentence about a total that was zero, and the facts below drop
               to the one that survives without a base: how many students the
               arrears are spread across. */
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
            facts={
              yearly
                ? [
                    { key: 'pct', value: `${outstandingPct}%`, label: t('bento.principal.fact_of_billed') },
                    { key: 'billed', value: formatPaise(billed), label: t('bento.principal.fact_billed') },
                    { key: 'def', value: String(k.defaulters), label: t('bento.principal.fact_defaulters') },
                    ...(arrears > 0
                      ? [{ key: 'arrears', value: formatPaise(arrears), label: t('bento.principal.fact_earlier_years') }]
                      : []),
                  ]
                : [{ key: 'def', value: String(k.defaulters), label: t('bento.principal.fact_defaulters') }]
            }
            provenance={asOfNow}
            note={
              yearly
                ? t('bento.principal.of_billed', { billed: formatPaise(billed) })
                : t('bento.principal.outstanding_note_plain')
            }
            to={feesHref}
            cue={t('bento.principal.cue_fees')}
          />
        )}
      </Widget>

      {/* A warning, so orange — the hue this palette reserves for one. */}
      <Widget id="defaulters" label={t('bento.principal.defaulters')} size="small" index={4}>
        {(span) => (
          <SourceCell
            span={span}
            status="ready"
            domain="staff"
            label={t('bento.principal.defaulters')}
            value={k.defaulters}
            art={<RiskGridArt total={k.students} flagged={k.defaulters} />}
            /* The one real denominator on this board. A defaulter is a
               DISTINCT student with an invoice past its due date, and the roll
               is the count of active students — the same population, in the
               same response, at the same instant. */
            shape={
              <Meter
                value={k.defaulters}
                total={k.students}
                tone="warning"
                srLabel={t('bento.principal.defaulters_sr')}
              />
            }
            facts={[
              { key: 'pct', value: `${defaultersPct}%`, label: t('bento.principal.fact_of_roll') },
              { key: 'roll', value: String(k.students), label: t('bento.principal.fact_on_roll') },
            ]}
            provenance={asOfNow}
            note={t('bento.principal.defaulters_note')}
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
          /* Hand-written until now, and so the one money cell that could not
             shed, could not draw an error and could not say which period its
             figure covered. It goes through `SourceCell` like the rest; the
             id, the size and the index are untouched, because those are
             persisted in somebody's saved layout. */
          <SourceCell
            span={span}
            status="ready"
            domain="finance"
            label={t(yearly ? 'bento.principal.collected_label' : 'bento.principal.collected_plain')}
            value={formatPaise(collected)}
            shape={
              yearly ? (
                <Meter
                  value={collected}
                  total={billed}
                  srLabel={t('bento.principal.collected_sr')}
                />
              ) : undefined
            }
            facts={
              yearly
                ? [
                    { key: 'pct', value: `${collectedPct}%`, label: t('bento.principal.fact_of_billed') },
                    { key: 'billed', value: formatPaise(billed), label: t('bento.principal.fact_billed') },
                  ]
                : []
            }
            /* The whole reason this cell needs a source line. With a year to
               scope to, the figure is money applied to this year's bills — a
               level. Without one it falls back to receipts banked inside the
               range that was asked for — a flow, and meaningless unless the
               range is named. */
            provenance={yearly ? t('bento.principal.prov_this_year') : k.range.label}
            note={
              yearly
                ? t('bento.principal.collected_of_billed', {
                    pct: collectedPct,
                    billed: formatPaise(billed),
                  })
                : t('bento.principal.collected_note_plain')
            }
            to={feesHref}
            cue={t('bento.principal.cue_fees')}
          />
        )}
      </Widget>

      {/* No badge and no accent. Four hues, one meaning each, and the roll is
          not one of those meanings — a tint here would only make the two that
          do mean something harder to find. */}
      <Widget id="students" label={t('bento.principal.students')} size="medium" index={3}>
        {(span) => (
          <SourceCell
            span={span}
            status="ready"
            domain="operations"
            label={t('bento.principal.students')}
            value={k.students}
            art={<PopulationArt count={k.students} />}
            /* NO RING AND NO RAIL. The roll has no denominator in this
               response and `sections` is not one — a section is not a student.
               What the extra room buys is the shape of the school beside the
               size of it: how many sections the roll is spread over, how big
               the average one comes out, and how many adults there are per
               child. Four figures, four names, no proportion. */
            facts={[
              { key: 'sections', value: String(k.sections), label: t('bento.principal.fact_sections') },
              ...(perSection > 0
                ? [{ key: 'per', value: String(perSection), label: t('bento.principal.fact_per_section') }]
                : []),
              { key: 'staff', value: String(k.staff), label: t('bento.principal.fact_staff') },
              ...(loadPerTeacher > 0
                ? [{ key: 'load', value: String(loadPerTeacher), label: t('bento.principal.fact_per_teacher') }]
                : []),
            ]}
            provenance={asOfNow}
            note={t('bento.principal.students_note')}
            to={studentsHref}
            cue={t('bento.principal.cue_students')}
          />
        )}
      </Widget>

      <Widget id="staff" label={t('bento.principal.staff')} size="small" index={8} optional>
        {(span) => (
          <SourceCell
            span={span}
            status="ready"
            domain="reports"
            label={t('bento.principal.staff')}
            value={k.staff}
            art={<NetworkArt nodes={k.staff} degree={loadPerTeacher} />}
            /* The response carries no staff type and no department, so there
               is no composition to draw and none is invented. The load is the
               roll over the head count — two figures from the same row — and
               the sections are what those people have to cover. */
            facts={[
              ...(loadPerTeacher > 0
                ? [{ key: 'load', value: String(loadPerTeacher), label: t('bento.principal.fact_students_each') }]
                : []),
              { key: 'sections', value: String(k.sections), label: t('bento.principal.fact_sections') },
              { key: 'roll', value: String(k.students), label: t('bento.principal.fact_on_roll') },
            ]}
            provenance={asOfNow}
            note={t('bento.principal.staff_note')}
            to={staffHref}
            cue={t('bento.principal.cue_staff')}
          />
        )}
      </Widget>

      <Widget id="approvals" label={t('bento.principal.approvals')} size="small" index={7}>
        {(span) => (
          <SourceCell
            span={span}
            status="ready"
            domain="staff"
            label={t('bento.principal.approvals')}
            value={k.pending_leave}
            /* The emptiest cell on the board, and it stays honest about why.
               The response carries a count of pending leave requests and
               nothing else — no age, no type, no previous value — so there is
               no queue ageing and no type split here however much room the
               cell is given. What it gets instead is the count drawn as
               itself, one tick per request, which claims nothing beyond the
               number already printed above it. */
            tag={t(k.pending_leave > 0 ? 'bento.principal.tag_waiting' : 'bento.principal.tag_clear')}
            flat={
              <TallyField
                n={k.pending_leave}
                accent="orange"
                srLabel={t('bento.principal.approvals_tally_sr', { count: k.pending_leave })}
              />
            }
            provenance={asOfNow}
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
          <SourceCell
            span={span}
            status="ready"
            domain="admissions"
            label={t('bento.principal.applications')}
            value={k.open_applications}
            art={<FunnelArt count={k.open_applications} />}
            /* NO STAGE COMPOSITION. The handler counts applications whose
               status is not accepted, rejected or withdrawn — one number, with
               the stages collapsed inside it — so a funnel with three
               segments would be three invented figures. The funnel behind the
               card draws its walls as process and only the mouth from data,
               and the tally in front draws the count as itself. */
            tag={t(k.open_applications > 0 ? 'bento.principal.tag_undecided' : 'bento.principal.tag_clear')}
            flat={
              <TallyField
                n={k.open_applications}
                accent="orange"
                srLabel={t('bento.principal.applications_tally_sr', { count: k.open_applications })}
              />
            }
            provenance={asOfNow}
            note={t('bento.principal.applications_note')}
            to={applicationsHref}
            cue={t('bento.principal.cue_applications')}
          />
        )}
      </Widget>

      <Widget id="unassigned" label={t('bento.principal.unassigned')} size="medium" index={6}>
        {(span) => (
          <SourceCell
            span={span}
            status="ready"
            domain="communication"
            label={t('bento.principal.unassigned')}
            value={k.unassigned_subjects}
            /* NO SHARE OF THE TIMETABLE. The response counts the class-subjects
               with nobody timetabled and does NOT return how many
               class-subjects there are, so "12 of what" has no answer here and
               no rail is drawn. The count is drawn as itself, and the staff and
               sections beside it are the two figures a head reaches for next —
               named as what they are, not divided into anything. */
            tag={t(
              k.unassigned_subjects > 0
                ? 'bento.principal.needs_attention'
                : 'bento.principal.tag_all_covered',
            )}
            flat={
              <TallyField
                n={k.unassigned_subjects}
                accent="orange"
                srLabel={t('bento.principal.unassigned_tally_sr', { count: k.unassigned_subjects })}
              />
            }
            facts={[
              { key: 'staff', value: String(k.staff), label: t('bento.principal.fact_staff') },
              { key: 'sections', value: String(k.sections), label: t('bento.principal.fact_sections') },
            ]}
            provenance={asOfNow}
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
