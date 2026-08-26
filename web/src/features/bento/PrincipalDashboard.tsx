import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT, type MessageKey } from '@/lib/i18n'
import { WidgetLayer, Widget } from './WidgetLayer'
import { useLayout } from '@/lib/widgets'
import { cn, formatPaise } from '@/lib/utils'
import { useWidgetSize } from '@/lib/widget-size'
import {
  BentoError,
  BentoLoading,
  BentoPage,
  calendarSlots,
  Cell,
  CellError,
  type CellSpan,
  Cue,
  Meter,
  NetworkArt,
  StatCell,
  useFeatureHref,
} from './bento-kit'
import {
  Area,
  Area as CardArea,
  Bars as CardBars,
  CardShell,
  Compare,
  Compare as CardCompare,
  PartOf as CardPartOf,
  Distribution,
  Gauge,
  Gauge as CardGauge,
  Line,
  Line as CardLine,
  Facts,
  Funnel,
  Rows,
  Rows as CardRows,
  Scale,
  Stack as StackCols,
  Nil
} from './bento-cards'

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
  /* How many invoice rows the year trio above was summed over. ALWAYS sent,
     because zero is the answer rather than the absence of one: on a database
     where no invoice carries an academic year all three of billed, collected
     and outstanding for the year come back 0, and a cell reading "₹0 billed"
     under a caption that says "this year" is a confident lie. This is the tell
     that separates "no year data" from "nothing was billed", and it is what
     `yearly` below is decided on. */
  year_invoice_count: number

  /* THE BREAKDOWNS.

     Each is cut from exactly the rows its headline scalar is cut from, so the
     parts add back to the whole and a cell can draw a proportion without this
     file inventing the bottom half of one.

     EVERY ONE IS OPTIONAL, and an absent field is NOT a zero. The handler
     omits each when there is nothing to say — no class-subject offered, no
     leave pending, nothing outstanding — and a cell that reads an absent
     field must draw the no-denominator form it drew before these existed. A
     zero that looks real is the bug the omit-when-absent contract exists to
     prevent, and this product has already removed four fabricated
     denominators. */

  /* Every class-subject pairing, of which `unassigned_subjects` is the part
     nobody is timetabled to teach. Omitted when it is zero: a school that has
     offered no subject has no denominator, and "9 of 0" is worse than "9". */
  class_subjects_total?: number
  /* `open_applications` split by the status column itself, ordered along the
     admission stages and summing exactly to it. */
  open_applications_by_status?: AppStatusCount[]
  /* `pending_leave` split by type and by who asked. Students appear here:
     `subject_kind` is carried precisely so student leave is not presented as
     staff leave. */
  pending_leave_by_type?: PendingLeaveGroup[]
  /* `students` distributed over the class each is enrolled in, the
     not-yet-enrolled in their own bucket so it sums to the roll. `class_name`
     is NOT unique — a tenant can run two classes called "Grade 6" on
     different campuses — so nothing below keys on it. */
  students_by_class?: ClassRollGroup[]
  /* `outstanding_paise` aged by how long each unpaid invoice has been due; the
     six buckets add back to it. Null when nothing is outstanding at all. */
  outstanding_ageing?: OutstandingAgeing | null
  range: { period: string; from: string; to: string; label: string }
  as_of_now: string[]
}
interface AppStatusCount {
  status: string
  applications: number
}
interface PendingLeaveGroup {
  leave_type: string
  /* 'staff' or 'student'. Both kinds sit in the same table and both are
     counted by `pending_leave`, so this is read rather than assumed. */
  subject_kind: string
  /* Absent for student leave and for staff with no department on file — which
     are different facts, and neither is the string "None". */
  department?: string | null
  requests: number
  /* Working days asked for. A float: the half-day flag is already priced in. */
  days: number
}
interface ClassRollGroup {
  /* Null for the not-yet-enrolled bucket, which is a real group of children
     rather than a class. The stable identity of a row all the same — two
     classes may share a name, so this is what tells them apart. */
  class_id?: string | null
  class_name: string
  students: number
}
interface OutstandingAgeing {
  not_due_paise: number
  days_0_30_paise: number
  days_31_60_paise: number
  days_61_90_paise: number
  days_90_plus_paise: number
  /* Unpaid invoices with no due date. They cannot be aged and they are not
     zero, so they keep their own bucket rather than leaving the six short of
     the outstanding figure. */
  undated_paise: number
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
  'text-[length:min(var(--card-fig,clamp(26px,3.6vh,40px)),15cqw)]'

const LABEL_CLASS =
  'bento-label text-[length:var(--card-sub,10px)] font-semibold uppercase leading-tight tracking-[0.14em] ' +
  'text-[var(--bento-muted)]'

/** The whisper above the figure. One copy of the markup three cells were
    repeating verbatim. */
/** Bucket a list of numbers into labelled bands, for `Rows`.

    Bands are given in ascending order with an inclusive `max`; anything above
    the last band's max falls into that last band, so the buckets always cover
    the whole range and a value cannot be silently dropped. Empty bands are
    kept: "none in this band" is a real reading, and dropping them would make
    the gaps in a distribution invisible. */
function bandCounts(values: number[], bands: { label: string; max: number }[]) {
  return bands.map((b, i) => {
    const lo = i === 0 ? -Infinity : bands[i - 1].max
    const last = i === bands.length - 1
    return {
      label: b.label,
      value: values.filter((v) => v > lo && (last || v <= b.max)).length,
    }
  })
}

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

   `--card-fig` is the cell's own figure size — a fraction of its height — and
   is right for a count: four digits fit a 264px card with room to spare. A
   rupee figure is not four digits: `₹12,34,56,789` is thirteen glyphs, and at
   the full figure size that is a line and a half past the edge of a 1x1. So
   the token is kept and a ceiling is put over it by string length.

   THE CEILINGS ARE IN CONTAINER UNITS, NOT PIXELS. A fixed px ceiling was the
   whole bug this rewrite is about: it pinned a 2x2's figure to a 1x1's size.
   `cqw` is the dimension a long numeral actually runs out of, and `cqh` the
   one the rest of the card is competing for, so the ceilings are stated in
   both and every one of them grows with the cell. At 264px wide they land on
   the sizes this card shipped with; at 544 they are twice that. */
function figureSize(text: string): string {
  const fig = 'var(--card-fig,clamp(26px,3.6vh,40px))'
  const n = text.length
  if (n <= 5) return `min(${fig}, 15cqw)`
  if (n <= 9) return `min(${fig}, 12cqw, 18.6cqh)`
  if (n <= 12) return `min(${fig}, 9.8cqw, 15cqh)`
  return `min(${fig}, 7.6cqw, 11.6cqh)`
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
                className="mt-1 truncate text-[length:var(--card-note,8.5px)] font-semibold uppercase leading-none tracking-[0.1em]"
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
      <p className="text-[length:var(--card-sub,9px)] font-semibold uppercase leading-none tracking-[0.14em] text-[var(--bento-muted)]">
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
                className="text-[length:var(--card-note,9.5px)] font-semibold uppercase leading-none tracking-[0.1em]"
                style={{
                  color: lit ? SEVERITY_MARK[rung] : 'var(--bento-muted)',
                  opacity: lit ? 1 : 0.65,
                }}
              >
                {labels[rung]}
              </p>
              <p
                className="mt-0.5 line-clamp-2 text-[length:var(--card-note,10px)] leading-tight text-[var(--bento-muted)]"
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
    count and amount can honestly say about each other.

    Both sizes are the card's own tokens under a ceiling. Measured at 2x2:
    unceilinged, the pair grew tall enough to push the sentence beneath them
    down onto the drawing, and text over the drawing is the one thing this
    card may not do. */
function MicroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[length:min(var(--card-sub,8.5px),12px)] font-semibold uppercase leading-none tracking-[0.12em] text-[var(--bento-muted)]">
        {label}
      </p>
      <p className="mt-1 truncate text-[length:min(var(--card-change,12px),16px)] font-semibold leading-none tabular-nums">{value}</p>
    </div>
  )
}

/* THE COUNT, DRAWN AS THE THINGS IT COUNTS.

   The payload is a scalar, so there is no series to plot and no whole to take
   a share of. There are exactly two pictures a lone count supports, and both
   are drawn from the number already printed above them:

   A DOT PER THING. Up to `DOT_MAX` the count is drawn as itself — twelve marks
   are twelve registers, and the reading is the size of the field rather than
   the numeral. Nothing is claimed that the figure did not already claim; the
   drawing only makes it countable at a glance. Past `DOT_MAX` the marks stop
   being countable and start being a texture, so they are not drawn.

   A PLACE IN THE DAY'S RANGE. Above that, the one honest range this screen
   has is the response itself: fifteen probes ran, several came back, and the
   largest count among them is a real number that arrived in the same payload.
   So the dot is placed between none and that peak, and the caption NAMES the
   peak — this is not "43% of something", it is "this queue, against the
   biggest queue flagged right now". Drawn only when a bigger peer exists;
   against a range of one the dot would sit at the end of the line and say
   nothing.

   Neither is drawn for a calm zero. Nought things is not a field of no dots
   that could be mistaken for a drawing that failed. */

function AttentionDraw({
  count,
  peak,
  peakLabel,
  peakStart,
  peakEnd,
}: {
  count: number
  peak?: number
  wide: boolean
  dotsLabel: string
  peakLabel: string
  peakStart: string
  peakEnd: string
}) {
  if (count <= 0) return null
  if (!peak || peak <= count) return null
  /* The ends are labelled ON the line rather than in a sentence under it: a
     caption long enough to say what the far end is, is long enough to be
     ellipsised at one column, and a range whose end has been cut off is a
     percentage again. */
  return (
    <div className="flex h-full min-h-0 flex-col justify-end gap-1.5 pb-1">
      <div className="h-2.5 shrink-0">
        <Scale value={count} min={0} max={peak} srLabel={peakLabel} />
      </div>
      <div
        aria-hidden="true"
        className="flex items-baseline justify-between gap-2 text-[length:min(var(--card-note,8px),12px)] font-semibold
                   uppercase leading-none tracking-[0.1em] text-[var(--bento-muted)]"
      >
        <span>{peakStart}</span>
        <span className="truncate">{peakEnd}</span>
      </div>
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
  peak,
  status,
}: {
  span: CellSpan
  label: string
  cue: string
  to?: string
  item?: AttentionItem
  money?: boolean
  /** The largest count among the probes that DID come back, so a queue can be
      placed against the day's own biggest queue rather than an invented base.
      Undefined until the response arrives. */
  peak?: number
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
        className="rounded-full border px-1.5 py-0.5 text-[length:var(--card-sub,9px)] font-semibold uppercase
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

  /* The drawing. Never at 1x1 — that card is spending every pixel it has on
     the figure, the severity word and the way out — and never for a calm zero,
     which has no count to draw. */
  const drawing =
    roomy && item && item.count > 0 ? (
      <AttentionDraw
        count={item.count}
        peak={peak}
        wide={wide}
        dotsLabel={t('bento.principal.attention_dots', { count: item.count })}
        peakLabel={t('bento.principal.attention_peak', { count: peak ?? 0 })}
        peakStart={t('bento.principal.attention_peak_start')}
        peakEnd={t('bento.principal.attention_peak_end', { count: peak ?? 0 })}
      />
    ) : null

  const headlineText = (
    <p
      aria-hidden="true"
      className={cn(
        'text-[length:min(var(--card-change,11px),15px)] leading-snug text-[var(--bento-muted)] [overflow-wrap:anywhere]',
        full ? 'line-clamp-3' : wide ? 'line-clamp-2' : 'line-clamp-3',
      )}
    >
      {headline}
    </p>
  )

  /* The second sentence, wherever there is a second row of height for it. The
     1x2 has as much room as the 2x2 and was shedding it for no reason other
     than being narrow. */
  const detailText =
    (full || tall) && (detail || !item) ? (
      <p
        aria-hidden="true"
        className="mt-1 line-clamp-2 text-[length:min(var(--card-change,11px),15px)] leading-snug text-[var(--bento-muted)]
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
      className="mt-2 truncate text-[length:var(--card-action,10.5px)] leading-none"
      title={action}
    >
      <span className="font-semibold uppercase tracking-[0.12em] text-[var(--bento-muted)] text-[length:var(--card-sub,8.5px)]">
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
          {/* At 2x2 the drawing takes the room the sentences did not, in the
              same column as the figure it is a picture OF. */}
          {full && drawing && (
            <div className="mt-2 min-h-0 flex-1 overflow-hidden">{drawing}</div>
          )}
        </div>

        {/* `flex-1 min-h-0` in BOTH directions. Wide, it is the column that
            grows; tall, it is the row — and without it the drawing inside had
            only its own content height to work with, which squashed a dot grid
            into one clipped line and left the slack sitting under the ladder
            instead of inside the picture. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {roomy && !full && <div className={wide ? '' : 'mt-2'}>{headlineText}</div>}
          {tall && !wide && detailText}
          {/* At 2x1 and 1x2 the drawing sits between the sentence and the
              ladder, and it is what takes up the slack — the ladder stays
              pinned to the bottom edge either way. */}
          {!full && drawing && (
            <div className="mt-2 min-h-0 flex-1 overflow-hidden">{drawing}</div>
          )}
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
            <div className={cn('pt-2', drawing ? '' : 'mt-auto')}>
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
/** One plan in the reviewer's queue. `waiting_days` is what `listLessonPlans`
    sorts the queue by and the only per-row figure this board draws from it —
    everything else in `planRow2` is a name, and a name is not a quantity. */
interface PlanRow { waiting_days: number }
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
          <span className="shrink-0 text-[length:var(--card-note,13px)] font-bold leading-none tabular-nums">
            {f.value}
          </span>
          <span
            className="truncate text-[length:var(--card-note,9.5px)] font-semibold uppercase leading-none
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
      className="mt-1.5 flex items-center gap-1.5 text-[length:var(--card-sub,9.5px)] font-semibold uppercase
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
      className="rounded-full border border-[var(--bento-line)] px-1.5 py-0.5 text-[length:var(--card-sub,9px)]
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
  draw,
  drawNeedsHeight,
  empty,
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
  /** A DRAWING BUILT FROM THE ROWS THE RESPONSE ACTUALLY CARRIED.

      Ten cells here fetch a list and print `.length`. Several of those lists
      have real per-row data in them — how many days a plan has waited, what
      status a paper is in, which day a calendar entry falls on, how many
      unread messages one conversation holds — and throwing it away is what
      left the extra room empty. This slot is where it goes back.

      NOT A PLACE FOR A DERIVED BASE. Everything passed here is a count of rows
      that arrived, bucketed by a field that arrived. Where the list is only
      ids, nothing is passed and the cell keeps its facts and its sentence.

      Never drawn at 1x1: that card is the figure and one fact, and it always
      was. */
  draw?: ReactNode
  /** True for a drawing made of fixed-height rows (`Rows`), which needs the
      tall shapes; false for one that scales to whatever box it is given
      (`Density`, `Distribution`), which a 2x1 can hold as well. */
  drawNeedsHeight?: boolean
  /** WHAT THE DRAWING SLOT SAYS WHEN THE LIST CAME BACK EMPTY.

      Every `draw` above is passed as `rows.length > 0 ? <…> : undefined`, so
      on a school with none of that kind the slot is simply absent and the
      room it would have taken is the empty space this board was rebuilt to
      stop having. This is the cell's own sentence about having nothing of
      that kind — "No child is below the line", not a nought and not a chart
      of no rows. Drawn only where a drawing would have been: never at 1x1,
      which spends its height on the figure and one fact. */
  empty?: string
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

  /* A 2x1 that has both a drawing and a sentence has room for one of them.
     The drawing wins, because the sentence is fixed copy this file wrote and
     the drawing is the response; the sentence is still read out, from the
     `sr-only` copy that is rendered whatever the shape. */
  const showNote = Boolean(note) && (wide || (tall && !shape)) && !(draw && wide && !tall)
  /* How many facts fit, by shape rather than by area — 2x1 and 1x2 hold the
     same number and lay them out differently, and the 1x1 holds one. */
  const limit = wide && tall ? 4 : wide ? 3 : tall ? 3 : 1
  const shown = (facts ?? []).slice(0, limit)
  const mode = wide && tall ? 'grid' : tall ? 'stacked' : 'row'
  /* A 2x1 carrying facts and a drawing has already spent its height; the
     sentence gets the line that is left rather than three that are not. Cells
     with neither keep the three lines they have always had. */
  const dense = shown.length > 0 || Boolean(flat)
  /* A row-shaped drawing needs the height; an elastic one takes whatever box
     it is handed. Neither is offered a 1x1. Where the response carried no
     rows to draw, the same slot takes the cell's own sentence about that —
     `empty` is only consulted when there is no `draw` at all, so a 2x1 that
     is merely too short for a `Rows` still shows its facts and its note
     rather than being told the school has nothing. */
  const drawn = draw
    ? (tall || (wide && !drawNeedsHeight) ? draw : null)
    : empty && (wide || tall)
      ? <Say>{empty}</Say>
      : null

  return (
    <Cell span={span} accent={accent} domain={domain} art={art}>
      <CellLabel>{label}</CellLabel>
      <div className="mt-2 flex flex-wrap items-center gap-2.5">
        <p className={FIG_CLASS}>{value}</p>
        {tag && <StateTag>{tag}</StateTag>}
      </div>
      {shown.length > 0 && <FactField facts={shown} mode={mode} />}
      {flat}
      {/* `flex-1` and `min-h-0` together: the drawing takes the room that is
          left over and is allowed to be shorter than its content wants, which
          is what stops it pushing the sentence and the cue off the card. */}
      {drawn && (
        <div
          className={cn(
            'mt-2 flex-1 overflow-hidden',
            /* At one row the drawing has to be given a floor or the row above
               it takes everything and leaves a two-pixel smear that reads as a
               rendering fault. 22px is four bars of Distribution and two rows
               of a dot grid — small, and still a picture. */
            tall ? 'min-h-0' : 'min-h-[22px]',
          )}
        >
          {drawn}
        </div>
      )}
      {/* Rendered whatever the shape, and shed by the stylesheet at one row of
          height, which is where a meter has nowhere to go. Unchanged. */}
      {shape && <div className="bento-shape mt-3">{shape}</div>}
      {showNote && (
        <p
          aria-hidden="true"
          style={wide ? undefined : UNSHED}
          className={cn(
            'bento-note mt-1.5 text-[length:var(--card-note,11px)] leading-snug text-[var(--bento-muted)]',
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


/** How many cells a strip may carry before it stops being a chart. Past this
    the strip is cut and the cell's own sentence says it was cut — a silently
    truncated series is a lie about the size of the problem. */
const STRIP_MAX = 48

/** What `/comms/grievances/` will return and no more — the handler's own
    `LIMIT 300`. A response of exactly this length is a cut queue, and the two
    grievance cells say so rather than printing a total that is really a cap. */
const GRIEVANCE_LIMIT = 300

/** At most this many named slices before the tail is gathered up. Six greys
    is the point past which the legend is longer than the bar. */
const SEGMENT_MAX = 5


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

/** The same gathering, for a breakdown that arrives ALREADY summed.

    `topCounts` counts rows; these breakdowns come off the server with the
    counting done, so adding them up again by row would be counting the wrong
    thing. The tail past `SEGMENT_MAX` is gathered into one named remainder
    rather than dropped, for the same reason. */
function topSums<T>(
  rows: T[],
  key: (r: T) => string | undefined | null,
  value: (r: T) => number,
  otherLabel: string,
  max = SEGMENT_MAX,
): { label: string; value: number }[] {
  const m = new Map<string, number>()
  for (const r of rows) {
    const k = key(r)
    if (!k) continue
    m.set(k, (m.get(k) ?? 0) + Math.max(0, value(r)))
  }
  const all = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (all.length <= max) return all.map(([label, value]) => ({ label, value }))
  const head = all.slice(0, max).map(([label, value]) => ({ label, value }))
  const rest = all.slice(max).reduce((n, [, v]) => n + v, 0)
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

const clampPct = (n: number) => Math.max(0, Math.min(100, n))

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


/* ─── THE CARD SHELL, ON THIS BOARD ──────────────────────────────────────

   The ten cells below are the richest on the page: their endpoints already
   return one row per class-subject, per paper, per ticket, per period. They
   were drawing a label, a number and a lot of nothing. Each one now renders
   through `CardShell` — header, figure, drawing, the drawing taking every
   pixel the figure did not — and every drawing is one of the twelve.

   NOTHING HERE NAMES A COLOUR. The drawings are `currentColor`; the cell
   resolved its own ink before they were mounted.

   NO PROPORTION WITHOUT A REAL TOTAL. Every `Gauge` below divides by a number
   that arrived in the same payload — `summary.candidates`, `rows.length`,
   `steps.length`. Where a response carries no population — the grievance
   queue is every ticket ever raised — the room buys a `Distribution`, which
   needs no whole to be true. */

/** The card, plus the way out. `Cell` resolves the ground and the ink;
    `CardShell` lays the three rows on it; `Cue` keeps the bottom edge.

    `--bento-card` is re-pointed at a domain cell's own ground because
    `Gauge` punches its centre with that token: left at the plain card tone it
    would draw a pale disc in the middle of a tinted card. */
function FeatureCard({
  span, domain, accent, title, sub, glyph, value, change, href, cue, children,
}: {
  span: CellSpan
  domain?: string
  accent?: 'pink' | 'orange'
  title: string
  sub?: string
  glyph?: ReactNode
  value: ReactNode
  change?: ReactNode
  href?: string
  cue: string
  children?: ReactNode
}) {
  const style = domain
    ? ({ ['--bento-card' as string]: `var(--dom-${domain}-soft, var(--dom-${domain}))` } as CSSProperties)
    : undefined
  return (
    <Cell span={span} domain={domain} accent={accent}>
      {/* min-h-0 on BOTH the wrapper and the shell.

          Without it on the shell, a flex item refuses to shrink below its
          content's intrinsic height — so a long sentence or a tall drawing
          made this wrapper taller than the space the cue had left it, and the
          card's own contents were laid out over the button rather than above
          it. The cue is a sibling here, not a fourth row of the shell, so
          nothing else was keeping them apart. */}
      <div className="flex min-h-0 flex-1 flex-col" style={style}>
        <CardShell
          className="min-h-0 flex-1"
          title={title}
          sub={sub}
          glyph={glyph}
          value={value}
          change={change}
        >
          {children}
        </CardShell>
      </div>
      {href && <Cue to={href} label={cue} />}
    </Cell>
  )
}

/** The two faces that are not a reading: a request in flight, and one that
    did not come back. Neither ever draws a confident zero. */
function PendingCard({
  span, domain, label, status,
}: {
  span: CellSpan
  domain: string
  label: string
  status: 'loading' | 'error'
}) {
  const t = useT()
  if (status === 'error') return <InstrumentError span={span} domain={domain} label={label} />
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

/** Two drawings sharing the drawing row, half each. */
function Pair({ top, bottom }: { top: ReactNode; bottom: ReactNode }) {
  return (
    <div className="grid h-full min-h-0 grid-rows-2 gap-1.5">
      <div className="min-h-0 min-w-0">{top}</div>
      <div className="min-h-0 min-w-0">{bottom}</div>
    </div>
  )
}

/** Two drawings side by side. `lead` gives the left one only what it needs —
    for a ring beside a ranking. */
function Split({ left, right, lead }: { left: ReactNode; right: ReactNode; lead?: boolean }) {
  return (
    <div
      className={cn(
        'grid h-full min-h-0 gap-2.5',
        lead ? 'grid-cols-[auto_minmax(0,1fr)]' : 'grid-cols-2',
      )}
    >
      <div className="min-h-0 min-w-0">{left}</div>
      <div className="min-h-0 min-w-0">{right}</div>
    </div>
  )
}

/** A square as tall as the row it is in.

    `Gauge` sizes itself off its own WIDTH, which is right in a tall cell and
    wrong in a short one — a 104px ring in a 40px row is clipped by the card.
    A definite height plus a 1:1 ratio makes the width follow the height, so
    the ring fits whatever row it lands in. */
function Fit({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto h-full" style={{ aspectRatio: '1 / 1' }}>
      {children}
    </div>
  )
}

/** A SENTENCE IN THE DRAWING ROW — the one thing that row may hold that is
    not a picture.

    Every drawing in `bento-cards.tsx` returns null on empty data, which is
    correct of the drawing and fatal for the cell: the row is `minmax(0,1fr)`
    of whatever is left, so a null drawing is not a smaller card, it is the
    same card with a hole in it. That hole IS the empty cell this whole effort
    set out to remove.

    So a cell with nothing to draw says so, in words, and never with a zero and
    never with a chart of no rows. `items-end` puts the sentence on the same
    baseline `Facts` and `Rows` sit on, so a board of mixed cells still reads
    as one row of type. Clamped at three lines: the drawing row on a 1x1 is
    about 69px and four lines of this size is 56 plus the leading. */
function Say({ children }: { children: ReactNode }) {
  /* The sentence AND an empty measure, not the sentence alone.

     Every drawing returns null when its data has no signal, so a cell at zero
     used to be a short line of text floating in a large empty rectangle —
     which reads as a card that failed to load rather than as a queue that is
     clear. `Nil` puts an empty track under the sentence: it says the cell is a
     measure, that the measure is genuinely at nought, and it shows the shape
     the card will take tomorrow when there is something in it.

     One change here fixes every zero state on this board, which is why it is
     done at Say rather than at each of the call sites. */
  return <Nil>{children}</Nil>
}

/** The halves of a two-part drawing row that are REALLY there.

    `<Pair top={<Rows items={[]} />} …>` is not an empty half — it is an
    element that renders nothing, and React cannot be asked which. So the
    caller passes `condition && drawing`, the falsy ones are dropped here, and
    a row that has lost a half gives the whole height to the half that is
    left rather than drawing it at half size over a gap. With neither half
    left the caller falls to the next rung of its own ladder. */
function stack(...parts: (ReactNode | false | null | undefined)[]): ReactNode | null {
  const real = parts.filter(Boolean) as ReactNode[]
  if (real.length === 0) return null
  if (real.length === 1) return real[0]
  return <Pair top={real[0]} bottom={real[1]} />
}

/** The same rule, side by side. `lead` gives the left one only what it needs,
    for a ring beside a ranking. */
function beside(lead: boolean, ...parts: (ReactNode | false | null | undefined)[]): ReactNode | null {
  const real = parts.filter(Boolean) as ReactNode[]
  if (real.length === 0) return null
  if (real.length === 1) return real[0]
  return <Split lead={lead} left={real[0]} right={real[1]} />
}

/** Counts into equal buckets across a stated range — the input `Distribution`
    wants. A spread, not a ranking, and it needs no denominator: the bars are
    counts of rows the response actually carried. */
function histogram(values: number[], bins: number, lo: number, hi: number): number[] {
  if (values.length === 0 || bins < 1) return []
  const span = hi - lo
  const out = new Array<number>(bins).fill(0)
  for (const v of values) {
    const i = span > 0 ? Math.min(bins - 1, Math.max(0, Math.floor(((v - lo) / span) * bins))) : 0
    out[i] += 1
  }
  return out
}

/** A figure that is a money string rather than a count. Paise are printed by
    `formatPaise` and never divided; this only stops a nine-character rupee
    figure from being truncated at the card's own figure size. */
function Money({ children }: { children: ReactNode }) {
  return <span className="text-[length:min(var(--card-fig,32px),9cqw,15cqh)]">{children}</span>
}

const pctText = (n: number) => `${Math.round(n)}%`

/** Syllabus coverage, on the card.

    THE DENOMINATOR IS `units`, which arrives on every row: `percent` is that
    row's own delivered share of its own units, and the school figure is the
    sum of `delivered` over the sum of `units` — both off the same payload.
    `yearElapsedPct` is the CALENDAR, not a denominator: it says where the year
    is so the lag can be printed, and nothing is divided by it.

    1x1  the spread of delivered percentages across every class-subject.
    2x1  the three furthest behind, named, each against its own units.
    1x2  the spread, and the three furthest behind under it.
    2x2  the four furthest behind, and the full-resolution spread. */
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
  const label = t('bento.principal.syllabus')
  const cue = t('bento.principal.cue_syllabus')

  if (status !== 'ready') {
    return <PendingCard span={span} domain="academics" label={label} status={status} />
  }

  const expected = yearElapsedPct(new Date())
  const behind = rows.filter((c) => c.behind).length
  const units = rows.reduce((n, c) => n + (Number.isFinite(c.units) ? c.units : 0), 0)
  const delivered = rows.reduce((n, c) => n + (Number.isFinite(c.delivered) ? c.delivered : 0), 0)
  const actual = units > 0 ? (delivered / units) * 100 : 0
  const lag = Math.round(expected - actual)
  const unitsShort = Math.max(0, Math.round((expected / 100) * units) - delivered)

  if (rows.length === 0) {
    return (
      <FeatureCard
        span={span}
        domain="academics"
        title={label}
        sub={t('bento.principal.syllabus_sub')}
        value="—"
        change={t('bento.principal.syllabus_empty')}
        href={href}
        cue={cue}
      >
        <Say>{t('bento.principal.syllabus_empty')}</Say>
      </FeatureCard>
    )
  }

  const percents = rows.map((c) => c.percent).filter((p) => Number.isFinite(p))
  const ranked = [...rows]
    .filter((c) => Number.isFinite(c.percent))
    .sort((a, b) => a.percent - b.percent || a.class_name.localeCompare(b.class_name))
  const lagged = (n: number) =>
    ranked.slice(0, n).map((c) => ({
      label: `${c.class_name} ${c.subject}`,
      value: Math.round(c.percent),
    }))

  const spread = (bins: number) => (
    <Distribution
      values={histogram(percents, bins, 0, 100)}
      srLabel={t('bento.principal.syllabus_dist_sr', { count: percents.length })}
    />
  )
  const worst = (n: number) => (
    <Rows
      items={lagged(n)}
      formatValue={pctText}
      srLabel={t('bento.principal.syllabus_lag_sr', { count: Math.min(n, ranked.length) })}
    />
  )
  /* Rows arrived, but not one of them carried a readable percent — every
     `percent` off the wire was null or NaN. There is no spread and no ranking
     in that, and both drawings above would render nothing. What DID arrive is
     the count of class-subjects, how many are flagged behind, and the units
     against the units delivered, all three summed off the same rows. */
  const has = percents.length > 0
  const facts = (
    <Facts
      srLabel={t('bento.principal.syllabus_facts_sr', {
        rows: rows.length, behind, delivered, units,
      })}
      items={[
        { label: t('bento.principal.fact_class_subjects'), value: String(rows.length) },
        { label: t('bento.principal.fact_behind'), value: String(behind) },
        { label: t('bento.principal.fact_units_done'), value: `${delivered}/${units}` },
      ]}
    />
  )

  const drawing =
    (wide && tall
      ? stack(has && worst(4), has && spread(24))
      : tall
        ? stack(has && spread(12), has && worst(3))
        : wide
          ? has && worst(3)
          : has && spread(10)) ?? facts

  return (
    <FeatureCard
      span={span}
      domain="academics"
      title={label}
      sub={t('bento.principal.syllabus_sub')}
      value={behind}
      change={
        behind > 0
          ? t('bento.principal.syllabus_change', {
              total: rows.length,
              lag: Math.abs(lag),
              short: unitsShort,
              units,
            })
          : t('bento.principal.syllabus_level', { delivered, units })
      }
      href={href}
      cue={cue}
    >
      {drawing}
    </FeatureCard>
  )
}

/* ── MODERATION: THE DISTRIBUTION INSTRUMENT ───────────────────────────── */


const numOr = (s: string | null | undefined) => {
  if (s == null) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}


/** Mark moderation, on the card.

    THE DENOMINATOR IS `rows.length` — every marked paper the response
    carried, and the moderated share is counted against it. `average_pct` is a
    nullable string on the wire: a paper with no marks in it has no average,
    and it is dropped from the spread rather than plotted at zero.

    1x1  the spread of paper averages, 0 to 100.
    2x1  the three weakest papers, named, each at its own average.
    1x2  the spread, and the three weakest under it.
    2x2  the four weakest, and the spread at full resolution. */
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
  const label = t('bento.principal.moderation')
  const cue = t('bento.principal.cue_moderation')

  if (status !== 'ready') {
    return <PendingCard span={span} domain="reports" label={label} status={status} />
  }

  const unmoderated = rows.filter((m) => !m.moderated_at).length
  const reviewed = rows.length - unmoderated

  if (rows.length === 0) {
    return (
      <FeatureCard
        span={span}
        domain="reports"
        title={label}
        sub={t('bento.principal.moderation_sub')}
        value="—"
        change={t('bento.principal.moderation_empty')}
        href={href}
        cue={cue}
      >
        <Say>{t('bento.principal.moderation_empty')}</Say>
      </FeatureCard>
    )
  }

  const papers = rows.flatMap((m) => {
    const avg = numOr(m.average_pct)
    return avg === null ? [] : [{ label: `${m.class} ${m.subject}`, avg }]
  })
  const avgs = papers.map((p) => p.avg)
  const ranked = [...papers].sort((a, b) => a.avg - b.avg || a.label.localeCompare(b.label))
  const weakest = (n: number) =>
    ranked.slice(0, n).map((p) => ({ label: p.label, value: Math.round(p.avg) }))

  const spread = (bins: number) => (
    <Distribution
      values={histogram(avgs, bins, 0, 100)}
      srLabel={t('bento.principal.moderation_dist_sr', { count: papers.length })}
    />
  )
  const worst = (n: number) => (
    <Rows
      items={weakest(n)}
      formatValue={pctText}
      srLabel={t('bento.principal.moderation_low_sr', { count: Math.min(n, ranked.length) })}
    />
  )
  /* Papers arrived and not one of them carries an average yet — `average_pct`
     is nullable on the wire and a paper with no marks in it has none. Neither
     drawing has anything to draw, so the row takes the three counts that are
     true whatever the averages did. */
  const has = papers.length > 0
  const facts = (
    <Facts
      srLabel={t('bento.principal.moderation_facts_sr', {
        total: rows.length, unmoderated, reviewed,
      })}
      items={[
        { label: t('bento.principal.fact_papers'), value: String(rows.length) },
        { label: t('bento.principal.fact_to_moderate'), value: String(unmoderated) },
        { label: t('bento.principal.fact_reviewed'), value: String(reviewed) },
      ]}
    />
  )

  const drawing =
    (wide && tall
      ? stack(has && worst(4), has && spread(24))
      : tall
        ? stack(has && spread(12), has && worst(3))
        : wide
          ? has && worst(3)
          : has && spread(10)) ?? facts

  return (
    <FeatureCard
      span={span}
      domain="reports"
      title={label}
      sub={t('bento.principal.moderation_sub')}
      value={unmoderated}
      change={t('bento.principal.moderation_change', {
        reviewed,
        total: rows.length,
        papers: papers.length,
      })}
      href={href}
      cue={cue}
    >
      {drawing}
    </FeatureCard>
  )
}

/** Board pass rate, on the card.

    THE ONE HONEST GAUGE ON THIS BOARD. `summary.candidates` is every
    candidate with marks and `summary.passed` is how many of them passed —
    both counted by the handler over the same set, neither truncated. The ring
    divides one by the other and nothing else.

    THE TRUNCATION TRAP, AND HOW IT IS AVOIDED. `/exams/board/performance`
    truncates `at_risk[]` to fifty rows in Go while `summary.at_risk` counts
    every one of them. Nothing on this cell or the next reads that array: the
    figure comes from `summary` and the marks come from `by_subject`, which the
    handler does not cut.

    1x1  the ring: passed of candidates.
    2x1  the three papers with the lowest pass rate, named.
    1x2  the ring, and the spread of pass rates across papers.
    2x2  the ring beside the four weakest papers, and the spread under both. */
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
  const label = t('bento.principal.pass_rate')
  const cue = t('bento.principal.cue_performance')

  if (status !== 'ready') {
    return <PendingCard span={span} domain="success" label={label} status={status} />
  }

  const candidates = summary?.candidates ?? 0
  const passed = summary?.passed ?? 0
  const rate = summary?.pass_rate

  const rates = subjects
    .map((s) => s.pass_rate)
    .filter((v): v is number => v != null && Number.isFinite(v))
  const ranked = subjects
    .filter((s) => s.pass_rate != null && Number.isFinite(s.pass_rate))
    .sort((a, b) => (a.pass_rate as number) - (b.pass_rate as number))
  const weakest = (n: number) =>
    ranked.slice(0, n).map((s) => ({
      label: `${s.class_name} ${s.subject}`,
      value: Math.round(s.pass_rate as number),
    }))

  const ring =
    candidates > 0 ? (
      <Fit>
        <Gauge
          value={passed}
          total={candidates}
          srLabel={t('bento.principal.pass_rate_gauge_sr', { total: candidates })}
        />
      </Fit>
    ) : null
  const spread = (bins: number) => (
    <Distribution
      values={histogram(rates, bins, 0, 100)}
      srLabel={t('bento.principal.pass_rate_dist_sr', { count: rates.length })}
    />
  )
  const worst = (n: number) => (
    <Rows
      items={weakest(n)}
      formatValue={pctText}
      srLabel={t('bento.principal.pass_rate_low_sr', { count: Math.min(n, ranked.length) })}
    />
  )

  /* `summary` counted everybody and `by_subject` came back empty — the two
     halves of this response fail independently. With candidates but no papers
     the ring is all there is; with neither, the row says nothing was entered
     rather than drawing a nought against a nought. */
  const has = rates.length > 0
  const facts =
    candidates > 0 ? (
      <Facts
        srLabel={t('bento.principal.pass_rate_facts_sr', { passed, total: candidates })}
        items={[
          { label: t('bento.principal.fact_candidates'), value: String(candidates) },
          { label: t('bento.principal.fact_passed'), value: String(passed) },
          { label: t('bento.principal.fact_at_risk'), value: String(summary?.at_risk ?? 0) },
        ]}
      />
    ) : (
      <Say>{t('bento.principal.pass_rate_none')}</Say>
    )

  const drawing =
    (wide && tall
      ? stack(beside(true, ring, has && worst(4)), has && spread(24))
      : tall
        ? stack(ring, has && spread(12))
        : wide
          ? has && worst(3)
          : ring) ?? facts

  return (
    <FeatureCard
      span={span}
      domain="success"
      title={label}
      sub={t('bento.principal.pass_rate_sub')}
      value={rate != null ? `${Math.round(rate)}%` : '—'}
      change={
        candidates > 0
          ? t('bento.principal.pass_rate_change', { passed, total: candidates })
          : t('bento.principal.pass_rate_none')
      }
      href={href}
      cue={cue}
    >
      {drawing}
    </FeatureCard>
  )
}

/** Students at risk, on the card.

    The figure is `summary.at_risk`, which counts every one of them. The
    drawings are `by_subject`, which is not cut either — `below_pass` is a
    real count of candidates under the pass mark in that paper. The fifty-row
    `at_risk[]` array is read nowhere here: see `PassRateCell`.

    1x1  how many sat below pass in each paper — one bar per paper.
    2x1  the three papers holding the most of them, named.
    1x2  the ring — at risk of candidates — over the same per-paper spread.
    2x2  the ring beside the four worst papers, and the spread under both. */
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
  const label = t('bento.principal.at_risk')
  const cue = t('bento.principal.cue_at_risk')

  if (status !== 'ready') {
    return <PendingCard span={span} domain="students" label={label} status={status} />
  }

  const atRisk = summary?.at_risk ?? 0
  const candidates = summary?.candidates ?? 0

  const below = subjects
    .map((s) => (Number.isFinite(s.below_pass) ? s.below_pass : 0))
    .slice(0, STRIP_MAX)
  const ranked = [...subjects]
    .filter((s) => Number.isFinite(s.below_pass) && s.below_pass > 0)
    .sort((a, b) => b.below_pass - a.below_pass)
  const worstOf = (n: number) =>
    ranked.slice(0, n).map((s) => ({
      label: `${s.class_name} ${s.subject}`,
      value: s.below_pass,
    }))

  const ring =
    candidates > 0 ? (
      <Fit>
        <Gauge
          value={atRisk}
          total={candidates}
          srLabel={t('bento.principal.at_risk_gauge_sr', { total: candidates })}
        />
      </Fit>
    ) : null
  const perPaper = (
    <Distribution
      values={below}
      srLabel={t('bento.principal.at_risk_dist_sr', { count: below.length })}
    />
  )
  const worst = (n: number) => (
    <Rows
      items={worstOf(n)}
      srLabel={t('bento.principal.at_risk_low_sr', { count: Math.min(n, ranked.length) })}
    />
  )

  /* A bar of height zero in every column is a picture of nothing, so the
     per-paper spread is drawn only where at least one paper really has
     candidates under the pass mark. */
  const has = below.some((v) => v > 0)
  const facts =
    candidates > 0 ? (
      <Facts
        srLabel={t('bento.principal.at_risk_facts_sr', { count: atRisk, total: candidates })}
        items={[
          { label: t('bento.principal.fact_candidates'), value: String(candidates) },
          { label: t('bento.principal.fact_at_risk'), value: String(atRisk) },
          { label: t('bento.principal.fact_papers'), value: String(subjects.length) },
        ]}
      />
    ) : (
      <Say>{t('bento.principal.pass_rate_none')}</Say>
    )

  const drawing =
    (wide && tall
      ? stack(beside(true, ring, has && worst(4)), has && perPaper)
      : tall
        ? stack(ring, has && perPaper)
        : wide
          ? has && worst(3)
          : (has && perPaper) || ring) ?? facts

  return (
    <FeatureCard
      span={span}
      domain="students"
      accent={atRisk > 0 ? 'orange' : undefined}
      title={label}
      sub={t('bento.principal.at_risk_sub')}
      value={atRisk}
      change={
        candidates > 0
          ? t('bento.principal.at_risk_change', { total: candidates })
          : t('bento.principal.pass_rate_none')
      }
      href={href}
      cue={cue}
    >
      {drawing}
    </FeatureCard>
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


/** The setup checklist, on the card.

    FIFTEEN STEPS IS A POPULATION, so `Density` draws it literally: one dot per
    step, weighted by what state that step is in — done, the one in hand, a
    blocker waiting behind it, or optional work. And fifteen is a real total,
    so the ring may divide by it.

    1x1  the fifteen steps as a field.
    2x1  the field beside what is still to do, area by area.
    1x2  the ring on the real fifteen, over the field.
    2x2  the ring beside the areas, and the field at full width. */
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
  const cue = t('bento.principal.cue_setup')

  if (status !== 'ready') {
    return <PendingCard span={span} domain="operations" label={label} status={status} />
  }

  const steps = (data?.steps ?? []) as SetupStepDetail[]
  const total = data?.total ?? steps.length
  const done = data?.completed ?? steps.filter((s) => s.done).length
  const blocking = data?.blocking_remaining ?? 0

  if (steps.length === 0 && total === 0) {
    return (
      <FeatureCard
        span={span}
        domain="operations"
        title={label}
        sub={t('bento.principal.setup_sub')}
        value="—"
        change={t('bento.principal.source_failed')}
        href={href}
        cue={cue}
      >
        <Say>{t('bento.principal.source_failed')}</Say>
      </FeatureCard>
    )
  }

  /* The step in hand: the first outstanding blocker, or with none left simply
     the first thing still to do. The handler's order is the order a school is
     meant to work through it. */

  const groups = SETUP_DOMAINS.map((domain) => {
    const members = steps.filter((s) => (SETUP_DOMAIN[s.key] ?? 'system') === domain)
    return {
      domain,
      left: members.filter((s) => !s.done).length,
      done: members.filter((s) => s.done).length,
      n: members.length,
    }
  }).filter((g) => g.n > 0)
  const anyLeft = groups.some((g) => g.left > 0)
  const areas = (n: number) =>
    [...groups]
      .sort((a, b) => (anyLeft ? b.left - a.left : b.done - a.done))
      .slice(0, n)
      .map((g) => ({ label: t(DOMAIN_WORD[g.domain]), value: anyLeft ? g.left : g.done }))

  const statusLine =
    blocking > 0
      ? t('bento.principal.setup_blocking_count', { count: blocking })
      : data?.ready
        ? t('bento.principal.setup_ready')
        : t('bento.principal.setup_optional_left', { count: Math.max(0, total - done) })

  /* Steps DONE per area on a school that has started, and steps LEFT on one
     that has not: five tracks all at nought is a picture of nothing, and the
     steps left are the same fifteen rows counted the other way round. Both
     are counts of steps the response returned. */
  const field = (_columns: number) => (
    <Rows
      items={groups.map((g) => ({
        label: t(`bento.principal.setup_dom_${g.domain}`),
        value: done > 0 ? g.done : g.left,
      }))}
      srLabel={t('bento.principal.setup_density_sr', {
        total: steps.length, done, left: Math.max(0, steps.length - done),
      })}
    />
  )
  const ring =
    total > 0 ? (
      <Fit>
        <Gauge
          value={done}
          total={total}
          srLabel={t('bento.principal.setup_gauge_sr', { total })}
        />
      </Fit>
    ) : null
  const byArea = (n: number) => (
    <Rows
      items={areas(n)}
      srLabel={
        anyLeft
          ? t('bento.principal.setup_rows_left_sr')
          : t('bento.principal.setup_rows_done_sr')
      }
    />
  )

  /* The steps are a Go literal fifteen long, so `groups` is only ever empty
     if the shape of that response changes under us. It is guarded anyway: a
     cell that draws nothing is the failure this file is here to stop. */
  const has = groups.length > 0
  const facts = (
    <Facts
      srLabel={t('bento.principal.setup_facts_sr', { done, total, blocking })}
      items={[
        { label: t('bento.principal.fact_steps_done'), value: `${done}/${total}` },
        { label: t('bento.principal.fact_blocking'), value: String(blocking) },
        { label: t('bento.principal.fact_left'), value: String(Math.max(0, total - done)) },
      ]}
    />
  )

  const drawing =
    (wide && tall
      ? stack(beside(true, ring, has && byArea(5)), has && field(15))
      : tall
        ? stack(ring, has && field(5))
        : wide
          ? beside(false, has && field(5), has && byArea(3))
          : has && field(5)) ?? facts

  return (
    <FeatureCard
      span={span}
      domain="operations"
      title={label}
      sub={t('bento.principal.setup_sub')}
      value={total > 0 ? `${done}/${total}` : '—'}
      change={statusLine}
      href={href}
      cue={cue}
    >
      {drawing}
    </FeatureCard>
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


/** Today's cover, on the card.

    THE HH:MM TRAP. `starts_at` off the substitution board is
    `to_char(p.starts_at,'HH24:MI')` — a bare wall-clock time with no date on
    it. `new Date('09:15')` is Invalid Date in every browser, and the variants
    that do parse land every period of the day on the same instant in 1970. So
    no `Date` is built from it here: a period's position is its MINUTE OF THE
    DAY, an integer, and the day the distribution belongs to is the board's own
    `on_date`, which is what the axis is labelled with.

    THE DENOMINATOR IS `summary.periods` — the periods today's absences left
    behind, counted by the handler. With nobody away it is zero, and a zero
    denominator draws no proportion: it draws the sentence that says so.

    1x1  the three states, ranked and counted.
    2x1  the states beside the shape of the day.
    1x2  the day, and the states under it.
    2x2  the states beside the classes losing the most periods, over the day. */
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
  const cue = t('bento.principal.cue_cover')

  if (status !== 'ready') {
    return <PendingCard span={span} domain="academics" label={label} status={status} />
  }

  const periods = summary?.periods ?? slots.length
  const covered = summary?.covered ?? slots.filter((s) => s.covered_by).length
  const uncovered = summary?.uncovered ?? Math.max(0, periods - covered)
  const stuck = summary?.no_candidate ?? 0
  const open = Math.max(0, uncovered - stuck)

  if (periods === 0) {
    /* The sentence was printed TWICE — once as the card's own change line and
       again as the drawing — so a day with no cover to arrange showed "No
       cover needed today." above "No cover needed today.". The value was an em
       dash on top of that, which the shell renders muted at the supporting
       size, so the cell had three ways of saying nothing and no figure at all.

       Zero periods IS the figure. It is printed as a nought like every other
       count on this board, the sentence is said once, and the drawing is the
       empty measure — which is what the reader needs to recognise this card
       tomorrow when it is not empty. */
    return (
      <FeatureCard
        span={span}
        domain="academics"
        title={label}
        sub={t('bento.principal.cover_sub')}
        value={0}
        change={t('bento.principal.cover_none_needed')}
        href={href}
        cue={cue}
      >
        <Nil />
      </FeatureCard>
    )
  }


  /* Minutes of the day, never dates. A day with one period in it has a window
     of zero width, so the axis is opened to the hour either side of it. */
  const mins = slots
    .map((s) => minuteOfDay(s.starts_at))
    .filter((m): m is number => m !== null)
  const lo = mins.length > 0 ? Math.floor(Math.min(...mins) / 60) * 60 : 0
  const hiRaw = mins.length > 0 ? Math.ceil(Math.max(...mins) / 60) * 60 : 0
  const hi = hiRaw > lo ? hiRaw : lo + 60

  const states = [
    { label: t('bento.principal.cover_covered'), value: covered },
    { label: t('bento.principal.cover_open'), value: open },
    { label: t('bento.principal.cover_stuck'), value: stuck },
  ]
  const byState = (
    <Rows items={states} srLabel={t('bento.principal.cover_states_sr', { covered, open, stuck })} />
  )
  const day = (bins: number) => (
    <Distribution
      values={histogram(mins, bins, lo, hi)}
      srLabel={t('bento.principal.cover_day_sr', {
        from: clockText(lo),
        to: clockText(hi),
        date: onDate,
      })}
    />
  )
  const uncoveredClasses = topCounts(
    slots.filter((s) => !s.covered_by),
    (s) => s.class_name,
    t('bento.principal.other_slice'),
  ).slice(0, 4)
  const byClass = (
    <Rows items={uncoveredClasses} srLabel={t('bento.principal.cover_class_sr')} />
  )
  /* `summary.periods` can be non-zero while the rows carry no readable clock
     — the summary is counted in SQL and the times are formatted per row — so
     the day is drawn only where minutes were actually parsed, and the classes
     only where a period is still uncovered. The three states are counted off
     the summary and always have one to show. */
  const hasDay = mins.length > 0
  const hasClasses = uncoveredClasses.length > 0

  const drawing =
    (wide && tall
      ? stack(beside(false, byState, hasClasses && byClass), hasDay && day(18))
      : tall
        ? stack(hasDay && day(10), byState)
        : wide
          ? beside(false, byState, hasDay && day(12))
          : byState) ?? byState

  return (
    <FeatureCard
      span={span}
      domain="academics"
      accent={uncovered > 0 ? (stuck > 0 ? 'pink' : 'orange') : undefined}
      title={label}
      sub={t('bento.principal.cover_sub')}
      value={uncovered}
      change={t('bento.principal.cover_change', {
        covered,
        periods,
        away: summary?.absent_teachers ?? 0,
      })}
      href={href}
      cue={cue}
    >
      {drawing}
    </FeatureCard>
  )
}

/** My leave, on the card.

    THE DENOMINATOR SOMEBODY SIGNED. `entitled` is what the school granted per
    leave type and `remaining` is what is left of it — both off `/me/pay`, both
    strings on the wire and read as numbers here. The primary reading is the
    per-type composition, not a ring: eleven days left means nothing until you
    know which eleven.

    1x1  left against taken, on one scale.
    2x1  days left, type by type.
    1x2  left against taken, over the per-type ranking.
    2x2  the per-type ranking at full height, over left against taken. */
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
  const label = t('bento.principal.my_leave')
  const cue = t('bento.principal.cue_my_leave')

  if (status !== 'ready') {
    return <PendingCard span={span} domain="staff" label={label} status={status} />
  }

  const num = (v: string | number | undefined) => {
    const n = Number(v ?? 0)
    return Number.isFinite(n) ? n : 0
  }
  const granted = balances.filter((b) => num(b.entitled) > 0)
  const remaining = balances.reduce((n, b) => n + num(b.remaining), 0)
  const entitled = balances.reduce((n, b) => n + num(b.entitled), 0)
  const taken = Math.max(0, entitled - remaining)

  if (granted.length === 0) {
    return (
      <FeatureCard
        span={span}
        domain="staff"
        title={label}
        sub={t('bento.principal.my_leave_sub')}
        value="—"
        change={t('bento.principal.my_leave_none')}
        href={href}
        cue={cue}
      >
        <Say>{t('bento.principal.my_leave_none')}</Say>
      </FeatureCard>
    )
  }

  const split = (
    <Compare
      rows={[
        { label: t('bento.principal.my_leave_left'), value: remaining },
        { label: t('bento.principal.my_leave_taken'), value: taken },
      ]}
      srLabel={t('bento.principal.my_leave_compare_sr', { entitled })}
    />
  )
  const perType = (n: number) => (
    <Rows
      items={[...granted]
        .sort((a, b) => num(b.remaining) - num(a.remaining))
        .slice(0, n)
        .map((b) => ({ label: b.leave_type, value: num(b.remaining) }))}
      srLabel={t('bento.principal.my_leave_rows_sr', { count: granted.length })}
    />
  )

  const drawing =
    wide && tall ? (
      <Pair top={perType(4)} bottom={split} />
    ) : tall ? (
      <Pair top={split} bottom={perType(3)} />
    ) : wide ? (
      perType(3)
    ) : (
      split
    )

  return (
    <FeatureCard
      span={span}
      domain="staff"
      title={label}
      sub={t('bento.principal.my_leave_sub')}
      value={remaining}
      change={t('bento.principal.my_leave_change', { entitled, types: granted.length })}
      href={href}
      cue={cue}
    >
      {drawing}
    </FeatureCard>
  )
}

/** My pay, on the card.

    THE POINT IS HOW GROSS BECAME NET. Paise are `bigint` on the wire and are
    never turned into a float for display: every figure printed here goes
    through `formatPaise`, and the numbers handed to a drawing are positions on
    a chart, not printed money.

    `/me/pay` returns at most twenty-four payslips, newest first; they are put
    back in date order so the line reads left to right in time.

    1x1  net pay, month by month.
    2x1  each month's gross split into what was paid and what was withheld.
    1x2  the net trend, over the last payslip's gross, net and deductions.
    2x2  the split across every month, over the same three figures. */
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
  const label = t('bento.principal.my_pay')
  const cue = t('bento.principal.cue_my_pay')

  if (status !== 'ready') {
    return <PendingCard span={span} domain="finance" label={label} status={status} />
  }

  const chrono = [...payslips].sort(
    (a, b) => a.period_year - b.period_year || a.period_month - b.period_month,
  )
  const latest = payslips[0]

  if (!latest) {
    return (
      <FeatureCard
        span={span}
        domain="finance"
        title={label}
        sub={t('bento.principal.my_pay_sub')}
        value="—"
        change={t('bento.principal.my_pay_none')}
        href={href}
        cue={cue}
      >
        <Say>{t('bento.principal.my_pay_none')}</Say>
      </FeatureCard>
    )
  }

  const nets = chrono.map((p) => Number(p.net_paise))
  const trend = (
    <Line points={nets} srLabel={t('bento.principal.my_pay_line_sr', { count: nets.length })} />
  )
  const wave = (
    <Area points={nets} srLabel={t('bento.principal.my_pay_line_sr', { count: nets.length })} />
  )
  const columns = chrono.map((p) => ({
    total: Number(p.gross_paise),
    parts: [Number(p.net_paise), Number(p.deduction_paise)],
  }))
  const stacked = (
    <StackCols
      columns={columns}
      srLabel={t('bento.principal.my_pay_stack_sr', { count: columns.length })}
    />
  )
  const split = (
    <Compare
      rows={[
        { label: t('bento.principal.my_pay_gross'), value: Number(latest.gross_paise) },
        { label: t('bento.principal.my_pay_net'), value: Number(latest.net_paise) },
        { label: t('bento.principal.my_pay_deducted'), value: Number(latest.deduction_paise) },
      ]}
      formatValue={(n) => formatPaise(n)}
      srLabel={t('bento.principal.my_pay_split_sr', {
        gross: formatPaise(Number(latest.gross_paise)),
        deduction: formatPaise(Number(latest.deduction_paise)),
      })}
    />
  )

  /* ONE PAYSLIP IS NOT A TREND. `Line` and `Area` need two points and draw
     nothing with one, which is the ordinary case for somebody paid for the
     first time this month. The month's own split — gross, net, deducted — is
     three real figures off that one payslip, so it takes the row instead. */
  const series = nets.length >= 2

  const drawing =
    (wide && tall
      ? stack(stacked, split)
      : tall
        ? stack(series && wave, split)
        : wide
          ? stacked
          : (series && trend) || split) ?? split

  return (
    <FeatureCard
      span={span}
      domain="finance"
      title={label}
      sub={t('bento.principal.my_pay_sub')}
      value={<Money>{formatPaise(Number(latest.net_paise))}</Money>}
      change={t('bento.principal.my_pay_change', {
        month: latest.period_month,
        year: latest.period_year,
        gross: formatPaise(Number(latest.gross_paise)),
      })}
      href={href}
      cue={cue}
    >
      {drawing}
    </FeatureCard>
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
/* ─── THE EIGHT KPI CARDS, IN THE CARD VOCABULARY ─────────────────────────

   docs/BENTO_CARD_PATTERNS.md is the contract these eight now keep: a cell is
   a header, a figure, and a drawing that takes ALL the height left over. The
   old shape here was a label, a number and a sentence, with the drawing either
   absent or hiding BEHIND the text as an `art` layer — which is why every one
   of them read as mostly empty space.

   The drawing now sits in its own row of `CardShell`, never behind the words,
   and every mark in it is `currentColor`: nothing below names a colour, so a
   card is correct on paper, on any of the twelve domain grounds and inverted,
   in both modes and all four palettes, without a branch.

   WHAT EACH SIZE ADDS, and it is a ladder rather than four variations:
   1x1 the signal, 1x2 the same signal with the figures that make it up, 2x1
   the structure the width buys, 2x2 both at once.

   WHERE THE RING MAY AND MAY NOT GO. `Gauge` is an aspect-square ring sized
   off the drawing row's WIDTH, and on a one-row cell that row is about 70px
   tall — the ring is drawn 104px across and the bottom third of it is cut off
   by the cell's own `overflow: hidden`. So a ring is only ever drawn where
   there are two rows of height. On one row the same proportion is drawn as
   `Compare` or `Rows`, which is two or three tracks against a shared scale and
   reads at any height a track fits in.

   AND WHAT IS STILL NOT DRAWN. Four of these have no denominator anywhere in
   `/principal/dashboard` — the roll, open applications, unassigned subjects
   and pending approvals are counts with no whole in the response to be a share
   of. They get a UNIT GRID: one dot per unit, the unit stated in the line
   under the figure and in the screen-reader label. A bigger cell buys a
   smaller unit, not an invented total. `sections` is not a denominator for
   students, `staff` is not one for unassigned subjects, and a funnel drawn
   from a single undecided-application count would be three made-up numbers. */

/** How many dots a drawing of this shape can hold without the grid overflowing
    its row. Rows are the binding constraint: the row is `minmax(0,1fr)` of
    whatever is left, roughly 70px on a one-row cell and 240px on two. */
function gridCapacity(w: number, h: number) {
  const columns = w >= 2 ? 20 : 10
  const rows = h >= 2 ? 12 : 4
  return { columns, rows, capacity: columns * rows }
}

/** The column count that makes a given number of dots a BLOCK rather than a
    stripe.

    At capacity this returns the full column count and the grid is solid. Below
    it — seven leave requests in a cell with room for two hundred and forty
    dots — laying them across twenty columns draws one thin line adrift in an
    empty row. Shaping to the cell's own aspect keeps a small count square, so
    a quantity still reads as a quantity. */

/** A count drawn as itself: one dot per unit, and the unit is whatever the
    room allows. Under capacity every dot is one thing; over it the unit grows
    and the last dot is drawn part-weight so the remainder is not rounded away.
    Returns `unit` so the caller can say what a dot means — a unit chart whose
    unit is unstated is a decoration. */
function unitGrid(count: number, capacity: number): { cells: number[]; unit: number } {
  if (!Number.isFinite(count) || count <= 0) return { cells: [], unit: 1 }
  if (count <= capacity) return { cells: Array.from({ length: count }, () => 1), unit: 1 }
  const unit = Math.ceil(count / capacity)
  const full = Math.floor(count / unit)
  const rest = (count - full * unit) / unit
  const cells = Array.from({ length: full }, () => 1)
  if (rest > 0.001) cells.push(Math.max(0.25, rest))
  return { cells, unit }
}

/** Two drawings in one drawing row, stacked on a tall cell and side by side on
    a wide one — the ring and the figures it was computed from. Only used at
    1x2 and 2x2, where there is room for both without either being squeezed
    below the size it reads at. */
function PairAside({ ring, detail, side }: { ring: ReactNode; detail: ReactNode; side: boolean }) {
  return side ? (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,116px)_minmax(0,1fr)] items-center gap-3">
      <div className="h-full min-h-0">{ring}</div>
      <div className="h-full min-h-0">{detail}</div>
    </div>
  ) : (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-2">
      <div className="min-h-0">{ring}</div>
      {detail}
    </div>
  )
}

/** The card frame: the ground and the link on the outside, the three-row shell
    on the inside.

    The whole card is the link rather than a pill along the bottom edge. The
    contract's cell is three rows and nothing else, and a fourth row for an
    action is exactly the 30px the drawing was short of at 1x1 — so the
    affordance becomes the card itself, which is bigger, needs no room, and
    still reaches the same screen. Cards with no reachable feature simply are
    not links; nothing renders a locked door. */
function CardCell({
  span, domain, status, title, sub, glyph, value, change, to, cueLabel, children,
}: {
  span: CellSpan
  domain?: string
  status: CellStatus
  title: string
  sub?: string
  glyph?: ReactNode
  value: ReactNode
  change?: ReactNode
  to?: string
  cueLabel: string
  children?: ReactNode
}) {
  const t = useT()
  /* A failed fetch is never a confident zero and never a drawing. The figure
     becomes a dash — there is no number — and the drawing row carries the
     error, which is the one thing that row is allowed to say that is not
     data. */
  const body =
    status === 'error' ? (
      <CardShell title={title} sub={sub} glyph={glyph} action={cueLabel ? { label: cueLabel } : undefined} value="—" className="h-full">
        <CellError message={t('bento.principal.source_failed')} />
      </CardShell>
    ) : status === 'loading' ? (
      <CardShell
        title={title}
        sub={sub}
        glyph={glyph} action={cueLabel ? { label: cueLabel } : undefined}
        value="—"
        change={t('bento.principal.source_loading')}
        className="h-full"
      />
    ) : (
      <CardShell title={title} sub={sub} glyph={glyph} action={cueLabel ? { label: cueLabel } : undefined} value={value} change={change} className="h-full">
        {children}
      </CardShell>
    )

  return (
    <Cell span={span} domain={domain}>
      {to ? (
        <Link
          to={to}
          aria-label={cueLabel}
          className="block min-h-0 flex-1 rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-current"
        >
          {body}
        </Link>
      ) : (
        <div className="min-h-0 flex-1">{body}</div>
      )}
    </Cell>
  )
}

/* ── attendance ─────────────────────────────────────────────────────────── */

/** Attendance today, on the thirty-day line it sits on.

    The only cell on this board with a real series behind it, so it is the only
    one that draws a trend. 1x1 takes the last ten days, which is the shape of
    the week and a half a line can still be read at that width; 1x2 has the
    height for the area under all thirty, which is the magnitude as well as the
    direction; 2x1 has the width for the full line; 2x2 stops smoothing and
    draws the month a day at a time, with today's bar marked.

    The bars are drawn against the best day of the month rather than against
    100%, which is what `Bars` does with any series — so the row reads as
    "today against the month's range", not as a share of a register. The figure
    above it is the percentage itself. */
export function PulseCard({
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
  const wide = w >= 2
  const tall = h >= 2
  const marked28 = days.filter((d) => d !== null) as number[]

  /* A LINE NEEDS TWO DAYS AND A SCHOOL THAT HAS NEVER MARKED A REGISTER HAS
     NONE. `/principal/attendance-trend` answers `{"items":[]}` on that school
     — a real empty list, not a failure — and every one of the four drawings
     below renders nothing from it. So the row falls to the two figures the
     KPI response carried about TODAY, which is the same reading at lower
     resolution; and with no register marked at all it says so in words.

     `attendance_today_pct` is COALESCEd to 0 in the handler, so a nought
     percent and a morning nobody marked are the same number on the wire.
     `attendance_marked_today` is the tell, and it is what the fallback tests
     — never the percentage. */
  const series = points.length >= 2
  const fallback =
    marked > 0 ? (
      <Facts
        srLabel={t('bento.principal.card_pulse_facts_sr', { pct, count: marked })}
        items={[
          { label: t('bento.principal.fact_marked_today'), value: String(marked) },
          { label: t('bento.principal.fact_present'), value: `${pct}%` },
        ]}
      />
    ) : (
      <Say>{t('bento.principal.card_pulse_empty')}</Say>
    )

  const drawing = trendError ? (
    <CellError message={t('bento.principal.trend_failed')} />
  ) : wide && tall && marked28.length > 0 ? (
    <CardBars
      values={marked28}
      activeIndex={marked28.length - 1}
      srLabel={t('bento.principal.card_pulse_month_sr', { days: marked28.length })}
    />
  ) : tall && series ? (
    <CardArea points={points} srLabel={t('bento.principal.trend_sr')} />
  ) : wide && series ? (
    <CardLine points={points} srLabel={t('bento.principal.trend_sr')} />
  ) : series ? (
    <CardLine points={points.slice(-10)} srLabel={t('bento.principal.card_pulse_short_sr')} />
  ) : (
    fallback
  )

  return (
    <CardCell
      span={span}
      domain="students"
      status="ready"
      title={t('bento.principal.card_pulse_title')}
      sub={t('bento.principal.card_pulse_sub')}
      glyph="%"
      /* `attendance_today_pct` is COALESCEd to 0 on the wire, so a morning
         nobody marked and a morning everybody was absent are the same number.
         `marked` is the tell — it is what the fallback below already tests —
         so the headline follows it rather than printing a confident 0%. */
      value={marked > 0 ? `${pct}%` : '—'}
      change={
        marked > 0
          ? t('bento.principal.attendance_marked', { count: marked })
          : t('bento.principal.card_pulse_empty')
      }
      to={href}
      cueLabel={t('bento.principal.cue_attendance')}
    >
      {drawing}
    </CardCell>
  )
}

/* ── money ──────────────────────────────────────────────────────────────── */

/** Collected against what was billed.

    `billed_paise` is the real denominator and it comes off the handler; it is
    never derived as collected + outstanding, which is the fabricated total
    this product has already removed once. When the school's invoices carry no
    academic year the trio is all zero, there IS no total, and the cell falls
    back to drawing the two money figures against each other on a shared scale
    — the longer bar is the larger sum and neither is claimed to be a share of
    anything. */
export function CollectedCard({
  span, yearly, billed, collected, outstanding, collectedPct, rangeLabel, href,
}: {
  span: CellSpan
  yearly: boolean
  billed: number
  collected: number
  outstanding: number
  collectedPct: number
  rangeLabel: string
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2
  const money = (n: number) => formatPaise(n)

  const pair = (
    <CardPartOf
      part={collected}
      whole={billed}
      partLabel={t('bento.principal.card_in')}
      wholeLabel={t('bento.principal.card_billed')}
      gapLabel={t('bento.principal.card_due')}
      formatValue={money}
      srLabel={t('bento.principal.collected_sr')}
    />
  )
  const three = (
    <CardRows
      items={[
        { label: t('bento.principal.card_billed'), value: billed },
        { label: t('bento.principal.card_in'), value: collected },
        { label: t('bento.principal.card_due'), value: outstanding },
      ]}
      formatValue={money}
      srLabel={t('bento.principal.card_money_three_sr')}
    />
  )
  const ring = <CardGauge value={collected} total={billed} srLabel={t('bento.principal.collected_sr')} />

  /* Every money field on this handler is `COALESCE(sum(…),0)`, so nought
     collected and nought owed is what a school with no invoice at all looks
     like. Two tracks of zero length under two ₹0.00 labels is a drawing of
     that nothing; the sentence is not. */
  const drawing = !yearly ? (
    collected > 0 || outstanding > 0 ? (
      <CardRows
        items={[
          { label: t('bento.principal.card_in'), value: collected },
          { label: t('bento.principal.card_due'), value: outstanding },
        ]}
        formatValue={money}
        srLabel={t('bento.principal.card_money_pair_sr')}
      />
    ) : (
      <Say>{t('bento.principal.card_money_empty')}</Say>
    )
  ) : tall ? (
    <PairAside ring={ring} detail={wide ? three : pair} side={wide} />
  ) : wide ? (
    three
  ) : (
    pair
  )

  return (
    <CardCell
      span={span}
      domain="finance"
      status="ready"
      title={t(yearly ? 'bento.principal.collected_label' : 'bento.principal.collected_plain')}
      sub={yearly ? t('bento.principal.prov_this_year') : rangeLabel}
      glyph="₹"
      value={money(collected)}
      change={
        yearly
          ? t('bento.principal.card_of_billed', { pct: collectedPct, billed: money(billed) })
          : t('bento.principal.card_range_receipts')
      }
      to={href}
      cueLabel={t('bento.principal.cue_fees')}
    >
      {drawing}
    </CardCell>
  )
}

/** Arrears.

    The split into this year and earlier years is the one composition the
    response supports: `outstanding_paise` is every unpaid invoice of every
    year and `outstanding_year_paise` is this year's rows alone, so the
    difference is exactly the debt carried in.

    Without the year trio there is no total and no split. The cell then draws
    the one thing that is still a fact — the students the arrears are spread
    across, one dot per student — rather than a bar against a number this file
    made up. */
export function OutstandingCard({
  span, yearly, billed, outstanding, outstandingYear, arrears, outstandingPct, defaulters,
  ageing, yearInvoices, href,
}: {
  span: CellSpan
  yearly: boolean
  billed: number
  outstanding: number
  outstandingYear: number
  arrears: number
  outstandingPct: number
  defaulters: number
  ageing?: OutstandingAgeing | null
  /* How many invoices the year trio was summed over. Zero is why the year
     figures read nought, and the line under the figure says so instead of
     implying the school billed nothing. */
  yearInvoices: number
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2
  const money = (n: number) => formatPaise(n)

  const pair = (
    <CardCompare
      rows={[
        { label: t('bento.principal.card_billed'), value: billed },
        { label: t('bento.principal.card_due'), value: outstanding },
      ]}
      formatValue={money}
      srLabel={t('bento.principal.outstanding_sr')}
    />
  )
  const split = (
    <CardRows
      items={[
        { label: t('bento.principal.card_billed'), value: billed },
        { label: t('bento.principal.card_due'), value: outstanding },
        { label: t('bento.principal.card_this_year'), value: outstandingYear },
        { label: t('bento.principal.card_earlier'), value: Math.max(0, arrears) },
      ]}
      formatValue={money}
      srLabel={t('bento.principal.card_arrears_split_sr')}
    />
  )
  const ring = <CardGauge value={outstanding} total={billed} srLabel={t('bento.principal.outstanding_sr')} />

  /* THE AGEING, when the response carries it.

     The six buckets are cut from the same unpaid invoices as the figure above
     and add back to it exactly, which is why the not-yet-due and the undated
     are buckets rather than omissions: drop either and the drawing quietly
     stops summing to the number it sits under. They are drawn in age order,
     never sorted by size — a ranking of ages is not an ageing.

     Money throughout, so `formatPaise` and never a division. The buckets are
     paise and are handed to the drawings as the paise they are; only the
     printed value is formatted.

     Null when nothing is outstanding at all, and null is not six zeroes: the
     cell then draws exactly what it drew before this field existed. */
  const buckets = ageing
    ? [
        { label: t('bento.principal.age_not_due'), value: ageing.not_due_paise },
        { label: t('bento.principal.age_0_30'), value: ageing.days_0_30_paise },
        { label: t('bento.principal.age_31_60'), value: ageing.days_31_60_paise },
        { label: t('bento.principal.age_61_90'), value: ageing.days_61_90_paise },
        { label: t('bento.principal.age_90_plus'), value: ageing.days_90_plus_paise },
        { label: t('bento.principal.age_undated'), value: ageing.undated_paise },
      ]
    : []
  /* The buckets a screen reader is told about are the ones with money in them.
     Reading six labels of which five are "₹0" is a worse answer than reading
     the one that is the arrears. */
  const agedList = buckets
    .filter((b) => b.value > 0)
    .map((b) => `${b.label} ${money(b.value)}`)
    .join(', ')
  /* The total named here is the buckets' OWN sum, not the figure above them.
     The two are the same number when the card is showing arrears of every
     year, and they are NOT when it is showing this year's share: the ageing
     is cut from every unpaid invoice there is, which is the larger
     population. Naming the headline as the total would have the drawing claim
     to be a split of something it does not split. */
  const agedTotal = buckets.reduce((n, b) => n + b.value, 0)
  const agedSr = t('bento.principal.card_ageing_sr', {
    total: money(agedTotal), detail: agedList,
  })
  /* Six labelled tracks need six rows of height; one row has space for three.
     So height gets the labelled ageing and a single row gets its SHAPE — six
     bars in age order, the tall one being where the debt actually sits. */
  const agedRows = buckets.length > 0 && (
    <CardRows items={buckets} formatValue={money} srLabel={agedSr} />
  )
  const agedShape = buckets.length > 0 && (
    <Distribution values={buckets.map((b) => b.value)} srLabel={agedSr} />
  )
  const aged = ageing
    ? tall
      ? yearly
        ? <PairAside ring={ring} detail={agedRows} side={wide} />
        : agedRows || null
      : agedShape || null
    : null

  const { capacity } = gridCapacity(w, h)
  const owed = unitGrid(defaulters, capacity)

  const drawing = aged ?? (!yearly ? (
    outstanding > 0 || defaulters > 0 ? (
      <Facts
        srLabel={t('bento.principal.card_owed_by_sr', { count: defaulters, unit: owed.unit })}
        items={[
          { label: t('bento.principal.fact_flagged'), value: String(defaulters) },
          { label: t('bento.principal.card_due'), value: money(outstanding) },
        ]}
      />
    ) : (
      <Say>{t('bento.principal.card_money_empty')}</Say>
    )
  ) : tall ? (
    <PairAside ring={ring} detail={wide ? split : pair} side={wide} />
  ) : wide ? (
    split
  ) : (
    pair
  ))

  return (
    <CardCell
      span={span}
      domain="finance"
      status="ready"
      title={t(yearly ? 'bento.principal.outstanding' : 'bento.principal.outstanding_plain')}
      sub={t('bento.principal.prov_as_of_now')}
      glyph="₹"
      value={money(outstanding)}
      change={
        yearly
          ? t('bento.principal.card_of_billed_due', { pct: outstandingPct, count: defaulters })
          : yearInvoices === 0
            ? t('bento.principal.card_due_no_year', { count: defaulters })
            : t('bento.principal.card_due_plain', { count: defaulters })
      }
      to={href}
      cueLabel={t('bento.principal.cue_fees')}
    >
      {drawing}
    </CardCell>
  )
}

/* ── counts with no whole ───────────────────────────────────────────────── */

/** The roll, drawn as the classes it is spread over.

    STILL NO GAUGE AND NO RAIL. There is no denominator for the roll:
    `sections` is a count of rooms, not of children, and dividing by it would
    put a percentage on the card that means nothing. What the response DOES
    carry is the roll's composition — `students_by_class`, which sums to the
    figure above it — so the drawing row shows the SHAPE of the school: one bar
    per class, in class order, tallest where the school is fullest.

    CLASS NAMES ARE NOT UNIQUE. A tenant runs two classes called "Grade 6" on
    two campuses, and `Rows` keys each track on its label — so a ranking taken
    straight off the names would collide two real classes into one React key
    and draw the school wrong. Rows are therefore identified by `class_id`,
    which is the only stable identity in the response, and a name that repeats
    is numbered so the head can see there are two of them. The `Distribution`
    keys by position and never touches a name at all.

    Without the breakdown the cell is exactly what it was: the figures around
    the roll, set as facts. */
export function StudentsCard({
  span, students, staff, sections, perSection, loadPerTeacher, classes, href,
}: {
  span: CellSpan
  students: number
  staff: number
  sections: number
  perSection: number
  loadPerTeacher: number
  classes?: ClassRollGroup[]
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2

  /* Deduplicated on `class_id`, never on the name, and an empty class has no
     bar to draw. A repeated name is numbered on its second appearance and
     after — the two Grade 6s are two classes, and one row reading "Grade 6"
     twice would be a worse answer than one reading "Grade 6 (2)". */
  const seen = new Set<string>()
  const names = new Map<string, number>()
  const roll: { key: string; label: string; value: number }[] = []
  for (const c of classes ?? []) {
    const key = c.class_id ?? `unenrolled:${c.class_name}`
    if (seen.has(key) || c.students <= 0) continue
    seen.add(key)
    const n = (names.get(c.class_name) ?? 0) + 1
    names.set(c.class_name, n)
    roll.push({
      key,
      label: n > 1 ? t('bento.principal.card_class_repeat', { name: c.class_name, n }) : c.class_name,
      value: c.students,
    })
  }
  const biggest = roll.reduce(
    (best, c) => (c.value > best.value ? c : best),
    roll[0] ?? { key: '', label: '', value: 0 },
  )
  const rollSr = t('bento.principal.card_roll_classes_sr', {
    count: students, classes: roll.length, name: biggest.label, largest: biggest.value,
  })
  /* Two classes make a spread; one makes a single bar filling the row, which
     says nothing the figure above has not already said. The strip is cut at
     the same ceiling every strip on this board is cut at. */
  const spread =
    roll.length >= 2 ? (
      <Distribution values={roll.slice(0, STRIP_MAX).map((c) => c.value)} srLabel={rollSr} />
    ) : null
  /* The ranking, with the tail past what the cell can hold gathered into one
     named remainder — so the tracks still add up to the roll above them. */
  const ranked =
    roll.length > 0 ? (
      <Rows
        items={topSums(roll, (c) => c.label, (c) => c.value,
          t('bento.principal.card_other_classes'), tall ? 5 : 3)}
        srLabel={rollSr}
      />
    ) : null

  /* The fallback, for a response with no per-class breakdown in it: the
     figures around the roll, exactly as this cell drew them before the
     breakdown existed. A school with no children, no sections and no staff
     has no figures either, and three rows of nought is not the answer to
     "how big is the school". */
  const figures = students > 0 || sections > 0 || staff > 0
  const facts = (
    <Facts
      srLabel={t('bento.principal.card_roll_sr', { count: students, unit: 1 })}
      items={[
        { label: t('bento.principal.fact_sections'), value: String(sections) },
        { label: t('bento.principal.fact_per_section'), value: String(perSection) },
        { label: t('bento.principal.fact_staff'), value: String(staff) },
      ]}
    />
  )

  return (
    <CardCell
      span={span}
      domain="operations"
      status="ready"
      title={t('bento.principal.students')}
      sub={t('bento.principal.prov_as_of_now')}
      glyph="#"
      value={students}
      change={
        roll.length > 0
          ? t('bento.principal.card_roll_classes', { classes: roll.length, sections, staff })
          : wide && perSection > 0 && loadPerTeacher > 0
            ? t('bento.principal.card_roll_wide', {
                sections, per: perSection, staff, load: loadPerTeacher,
              })
            : t('bento.principal.card_roll', { sections, staff })
      }
      to={href}
      cueLabel={t('bento.principal.cue_students')}
    >
      {/* Height buys the spread AND the ranking — the shape of the school
          over the classes that make it — while one row has space for the
          named tracks alone. Width adds nothing here: a track reads at any
          width and the binding constraint is how many of them fit. With no
          breakdown in the response the cell falls back to what it drew before
          there was one. */}
      {(tall ? stack(spread, ranked) : (ranked ?? (figures ? facts : null))) ?? (
        <Say>{t('bento.principal.card_roll_empty')}</Say>
      )}
    </CardCell>
  )
}

/** Defaulters against the roll — the one honest proportion on this board.

    A defaulter is a DISTINCT student with an invoice past its due date and the
    roll is the count of active students: the same population, in the same
    response, at the same instant. So this cell may have a ring, wherever there
    is height for one.

    The wide shapes draw the roll itself with the flagged share marked in it,
    which is the same ratio drawn as people rather than as an arc — and a head
    reading "sixty-three" gets a sense of how much of the school that is. */
export function DefaultersCard({
  span, defaulters, students, defaultersPct, href,
}: {
  span: CellSpan
  defaulters: number
  students: number
  defaultersPct: number
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2
  const { capacity } = gridCapacity(w, h)

  const pair = (
    <CardCompare
      rows={[
        { label: t('bento.principal.card_roll_label'), value: students },
        { label: t('bento.principal.card_arrears_label'), value: defaulters },
      ]}
      srLabel={t('bento.principal.defaulters_sr')}
    />
  )

  const unit = Math.max(1, Math.ceil(students / capacity))
  const grid = (
    <Rows
      items={[
        { label: t('bento.principal.fact_flagged'), value: defaulters },
        { label: t('bento.principal.fact_clear'), value: Math.max(0, students - defaulters) },
      ]}
      srLabel={t('bento.principal.card_defaulters_grid_sr', {
        flagged: defaulters, roll: students, unit,
      })}
    />
  )
  const ring = <CardGauge value={defaulters} total={students} srLabel={t('bento.principal.defaulters_sr')} />

  /* No roll, no proportion, and nothing to draw a proportion OF. The ring
     divides by the roll and the two tracks are the roll against the flagged
     part of it, so with nought children every one of them is a picture of
     nought — which is the sentence's job, not a drawing's. */
  const drawing =
    students <= 0 ? <Say>{t('bento.principal.card_roll_empty')}</Say>
      : tall ? <PairAside ring={ring} detail={wide ? grid : pair} side={wide} />
      : wide ? grid
      : pair

  return (
    <CardCell
      span={span}
      domain="staff"
      status="ready"
      title={t('bento.principal.defaulters')}
      sub={t('bento.principal.prov_as_of_now')}
      glyph="!"
      value={defaulters}
      change={t('bento.principal.card_of_roll', { pct: defaultersPct, roll: students })}
      to={href}
      cueLabel={t('bento.principal.cue_defaulters')}
    >
      {drawing}
    </CardCell>
  )
}

/** A scalar and a sentence — the shape a cell takes when it has NO breakdown.

    Three cells share this: undecided applications, class-subjects with nobody
    timetabled, and leave requests waiting on a decision. Each is a single
    `count(*)` in `getPrincipalDashboard`, and each now has a companion
    breakdown in the same response — but every one of those is omitted when
    there is nothing to break down, and this is what the cell falls back to
    then. Not a proportion of nought, not an empty funnel: the count, and the
    line that says what it counts.

    `drawing` is that breakdown when it came. Absent, the row holds the
    sentence and nothing else, which is exactly what these cells drew before
    the breakdowns shipped. */
export function CountCard({
  span, domain, title, count, glyph, empty, note, to, cueLabel, change, drawing,
}: {
  span: CellSpan
  domain: string
  title: string
  count: number
  glyph: ReactNode
  empty: string
  note: string
  srKey: MessageKey
  to?: string
  cueLabel: string
  change?: ReactNode
  drawing?: ReactNode
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const { capacity } = gridCapacity(w, h)
  const { unit } = unitGrid(count, capacity)

  return (
    <CardCell
      span={span}
      domain={domain}
      status="ready"
      title={title}
      sub={t('bento.principal.prov_as_of_now')}
      glyph={glyph}
      value={count}
      change={change}
      /* The sentence lives in the DRAWING ROW, not here. It used to be in
         both: `change` under the figure and a `Say` below it, so every one of
         these cells printed "Nothing waiting" or "Every subject has a teacher"
         twice. And where the count was positive the row held a `Facts` line
         reading `title: count` — the title from the header and the figure from
         the row above it, a third copy of things already on the card.

         This cell has one number and one sentence. Saying each once, with the
         sentence given the row to fill, is the whole of it. */
      to={to}
      cueLabel={cueLabel}
    >
      {drawing ?? (
        <Say>{count > 0 ? (unit > 1 ? t('bento.principal.card_unit', { unit, note }) : note) : empty}</Say>
      )}
    </CardCell>
  )
}

/** Class-subjects with nobody timetabled, as a share of the subjects offered.

    `class_subjects_total` is the denominator this cell went without: every
    class-subject pairing, of which the figure above is the untaught part. So
    "9 of 140" at last, and a ring wherever there is height for one — the same
    rule the defaulters cell follows, and for the same reason: both halves are
    counted off the same rows of the same table at the same instant.

    ABSENT IS NOT ZERO. A school that has offered no subject at all has the
    field omitted, and "9 of 0" is worse than "9" — the cell falls straight
    back to the count and its sentence. The denominator is also checked to be
    at least the count before it is used: a total smaller than its own part is
    not a total, and dividing by it would print a share above 100%. */
export function UnassignedCard({
  span, count, total, to, cueLabel,
}: {
  span: CellSpan
  count: number
  total?: number
  to?: string
  cueLabel: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2

  const denom = typeof total === 'number' && total > 0 && total >= count ? total : undefined
  const covered = Math.max(0, (denom ?? 0) - count)
  const sr = t('bento.principal.card_unassigned_of_sr', { count, total: denom ?? 0, covered })
  const rows = [
    { label: t('bento.principal.fact_unassigned'), value: count },
    { label: t('bento.principal.fact_covered'), value: covered },
  ]
  /* Nothing untaught is not a proportion worth drawing — it is the good news
     the sentence already carries, and a ring at 0% is a picture of nought. */
  const drawing =
    denom === undefined || count === 0 ? undefined : tall ? (
      <PairAside
        ring={<CardGauge value={count} total={denom} srLabel={sr} />}
        detail={wide ? <CardRows items={rows} srLabel={sr} /> : <CardCompare rows={rows} srLabel={sr} />}
        side={wide}
      />
    ) : wide ? (
      <CardRows items={rows} srLabel={sr} />
    ) : (
      <CardCompare rows={rows} srLabel={sr} />
    )

  return (
    <CountCard
      span={span}
      domain="communication"
      title={t('bento.principal.unassigned')}
      count={count}
      glyph="/"
      note={t('bento.principal.unassigned_note')}
      empty={t('bento.principal.card_all_covered')}
      srKey="bento.principal.card_unassigned_sr"
      change={denom !== undefined && count > 0
        ? t('bento.principal.card_unassigned_of', { count, total: denom })
        : undefined}
      drawing={drawing}
      to={to}
      cueLabel={cueLabel}
    />
  )
}

/* The admission stages in the words the status column uses. A status this
   table does not know is printed as itself with the underscores taken out,
   rather than dropped: an unknown stage is still applications waiting, and a
   funnel that silently omits one no longer sums to the figure above it. */
const APP_STAGE: Record<string, MessageKey> = {
  draft: 'bento.principal.app_stage_draft',
  submitted: 'bento.principal.app_stage_submitted',
  under_review: 'bento.principal.app_stage_under_review',
  documents_pending: 'bento.principal.app_stage_documents_pending',
  test_scheduled: 'bento.principal.app_stage_test_scheduled',
  interviewed: 'bento.principal.app_stage_interviewed',
  waitlisted: 'bento.principal.app_stage_waitlisted',
  offered: 'bento.principal.app_stage_offered',
}

/** Undecided applications, along the stages they are stuck at.

    A REAL funnel, and the first one this cell has been allowed: the response
    now carries `open_applications_by_status`, ordered along the admission
    stages by the query itself and summing exactly to the figure above. The
    order is the server's and is never re-sorted by size — a funnel sorted by
    count is not a funnel.

    A FUNNEL ONLY WHERE THE WHOLE PIPELINE FITS. Its bars are as tall as a
    track and the drawing row on a one-row cell is about seventy pixels, so
    four of the eight stages would fit there — and a funnel with half its
    stages cut off is not a picture of a pipeline, it is a picture of the top
    of one. Worse, `Funnel` draws no labels (they cannot be set inside the bar
    without naming a colour), so the four that survived would be four unnamed
    bars. One row therefore gets the RANKING instead: the fullest stages, each
    one named, with the rest gathered into a remainder so the tracks still add
    up to the figure above them. Height gets the funnel, in the server's stage
    order, whole.

    With the field absent — every application decided, or a school that takes
    none — there are no stages, and the cell is the count and its sentence. */
export function ApplicationsCard({
  span, count, stages, to, cueLabel,
}: {
  span: CellSpan
  count: number
  stages?: AppStatusCount[]
  to?: string
  cueLabel: string
}) {
  const t = useT()
  const { h } = useWidgetSize()
  const tall = h >= 2

  const all = (stages ?? [])
    .filter((s) => s.applications > 0)
    .map((s) => ({
      label: APP_STAGE[s.status] ? t(APP_STAGE[s.status]) : s.status.replace(/_/g, ' '),
      value: s.applications,
    }))
  const fullest = all.reduce(
    (best, s) => (s.value > best.value ? s : best),
    all[0] ?? { label: '', value: 0 },
  )
  const ranked = topSums(all, (s) => s.label, (s) => s.value, t('bento.principal.other_slice'), 3)
  const shown = tall ? all : ranked
  const sr = t('bento.principal.card_applications_stages_sr', {
    count,
    stages: all.length,
    detail: shown.map((s) => `${s.label} ${s.value}`).join(', '),
  })

  const drawing =
    all.length === 0 ? undefined : tall ? (
      <Funnel stages={all} srLabel={sr} />
    ) : (
      <Rows items={ranked} srLabel={sr} />
    )

  return (
    <CountCard
      span={span}
      domain="admissions"
      title={t('bento.principal.applications')}
      count={count}
      glyph="+"
      note={t('bento.principal.applications_note')}
      empty={t('bento.principal.card_queue_clear')}
      srKey="bento.principal.card_applications_sr"
      change={
        all.length === 0
          ? undefined
          : t('bento.principal.card_applications_stage_line', {
              stages: all.length, name: fullest.label, at: fullest.value,
            })
      }
      drawing={drawing}
      to={to}
      cueLabel={cueLabel}
    />
  )
}

/** Leave waiting on a decision: what kind, and whose.

    `pending_leave_by_type` sums to the figure above, students included — which
    is why `subject_kind` is read rather than assumed. Staff leave and student
    leave are different decisions and this cell never presents one as the
    other: they are separate tracks, named apart.

    Height decides how many kinds are named before the tail is gathered up;
    the staff and student totals and the working days asked for go in the line
    under the figure, which is where a number that is not a proportion belongs.

    Absent — nothing pending — is the empty queue, and it says so in words. */
export function ApprovalsCard({
  span, count, groups, to, cueLabel,
}: {
  span: CellSpan
  count: number
  groups?: PendingLeaveGroup[]
  to?: string
  cueLabel: string
}) {
  const t = useT()
  const { h } = useWidgetSize()
  const tall = h >= 2
  const rows = groups ?? []

  /* THE ROW IS THE TYPE AND THE KIND TOGETHER — "Casual · staff", "Sick ·
     students". Grouping on the type alone would fold a child's sick leave in
     with a teacher's and hand the head one number to approve two different
     things with. Ranked, with the tail past what the cell can hold gathered
     into one named remainder rather than dropped: the ranking still adds up
     to the figure above it. A track is twelve pixels and a one-row drawing is
     about seventy, so three rows there and five where there is height. */
  const kindOf = (r: PendingLeaveGroup) =>
    t(r.subject_kind === 'student'
      ? 'bento.principal.leave_kind_student'
      : 'bento.principal.leave_kind_staff')
  const byType = topSums(
    rows,
    (r) => t('bento.principal.card_leave_row', { type: r.leave_type, kind: kindOf(r) }),
    (r) => r.requests,
    t('bento.principal.card_other_leave'),
    tall ? 5 : 3,
  )

  /* Days asked for, and the staff/student split, summed off the same rows —
     the line under the figure, where they need no track of their own. A float
     for the days: the half-day flag is already priced into that column, so it
     is printed at one decimal and only where it is not whole. */
  const days = rows.reduce((n, r) => n + (Number.isFinite(r.days) ? r.days : 0), 0)
  const staffReqs = rows
    .filter((r) => r.subject_kind !== 'student')
    .reduce((n, r) => n + r.requests, 0)
  const studentReqs = rows
    .filter((r) => r.subject_kind === 'student')
    .reduce((n, r) => n + r.requests, 0)
  const daysText = days % 1 === 0 ? String(days) : days.toFixed(1)

  const drawing =
    byType.length > 0 ? (
      <Rows
        items={byType}
        srLabel={t('bento.principal.card_approvals_split_sr', {
          count,
          staff: staffReqs,
          students: studentReqs,
          days: daysText,
          detail: byType.map((i) => `${i.label} ${i.value}`).join(', '),
        })}
      />
    ) : undefined

  return (
    <CountCard
      span={span}
      domain="staff"
      title={t('bento.principal.approvals')}
      count={count}
      glyph="!"
      note={t('bento.principal.approvals_note')}
      empty={t('bento.principal.card_queue_clear')}
      srKey="bento.principal.card_approvals_sr"
      change={
        rows.length > 0
          ? t('bento.principal.card_approvals_line', {
              staff: staffReqs, students: studentReqs, days: daysText,
            })
          : undefined
      }
      drawing={drawing}
      to={to}
      cueLabel={cueLabel}
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
    queryFn: () => api.get<List<PlanRow>>('/api/v1/syllabus/lesson-plans?status=submitted'),
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
  /* The biggest queue flagged in this response. A real number, off the same
     payload, and the only range on this screen that was not invented — see
     `AttentionDraw`. Undefined when nothing came back, so no cell can place
     itself against a peak that does not exist. */
  const attentionPeak = (attention.data?.items ?? []).reduce(
    (m, i) => Math.max(m, i.count),
    0,
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
  /* `year_invoice_count` is the tell, and it is always sent. Zero says the
     trio had nothing to sum — no invoice carries an academic year — which is
     a different fact from a school that billed nothing, and the two print
     identically as ₹0. Both conditions are required: no rows means no year
     data, and no money means no denominator to divide by. */
  const yearly = k.year_invoice_count > 0 && k.billed_paise > 0
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
  /* THE PER-ROW FIGURES THESE TEN CELLS WERE THROWING AWAY.

     Each list below arrived in full and was reduced to its own length. Every
     derivation here is a count of rows that came back, bucketed by a field
     that came back on those same rows — no ratio of two responses, no total
     this file decided was reasonable, and nothing drawn for a list whose rows
     carry no quantity at all. */
  const planRows = plans.data?.items ?? []
  const planWaits = planRows.map((r) => r.waiting_days)
  const longestWait = planWaits.length > 0 ? Math.max(...planWaits) : 0
  const paperRows = papers.data?.items ?? []
  const papersWaiting = paperRows.filter((p) => p.status === 'submitted').length
  const paperStatusCounts = (st: PaperRow['status']) =>
    paperRows.filter((p) => p.status === st).length
  const shortagePcts = shortageRows.map((r) => r.pct)
  const lowestPct = shortagePcts.length > 0 ? Math.min(...shortagePcts) : 0
  const workloadPeriods = workloadRows.map((r) => r.weekly_periods)
  const threadRows = threads.data?.items ?? []
  /* The busiest conversations first. Only the ones with something unread —
     a column of height zero for a thread that is fully read is not a reading,
     and thirty of them beside four real bars is a chart of nothing. */
  const unreadPerThread = threadRows
    .map((r) => r.unread)
    .filter((n) => n > 0)
    .sort((a, b) => b - a)
    .slice(0, 28)
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
  /* The next thirty days as thirty marks, one lit where something is on the
     calendar. Built off the ISO strings for the same reason the filter above
     is — a Date would move the school's dates by a day outside India. `daysOut`
     is a difference between two midnight-anchored UTC dates, so it is a whole
     number of days and not a duration. */
  const CALENDAR_DAYS = 30
  const dayMs = 86_400_000
  const todayMs = Date.parse(`${todayISO}T00:00:00Z`)
  const daysAway = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - todayMs) / dayMs)
  const nextInDays = nextEntry ? daysAway(nextEntry.starts_on) : undefined
  const busyDays = new Set(
    upcoming.map((e) => daysAway(e.starts_on)).filter((d) => d >= 0 && d < CALENDAR_DAYS),
  )
  const calendarSoon = busyDays.size
  const examRows = exams.data?.items ?? []
  const examsUpcoming = examRows.filter((e) => e.starts_on && e.starts_on >= todayISO).length
  const examsSat = examRows.filter((e) => e.starts_on && e.starts_on < todayISO).length
  const examsUndated = examRows.filter((e) => !e.starts_on).length
  const examsPublished = examRows.filter((e) => e.is_published).length
  const perf = performance.data?.summary
  const bySubject = performance.data?.by_subject ?? []
  const unread = threadRows.reduce((n, t2) => n + t2.unread, 0)
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
          <PulseCard
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
          <OutstandingCard
            span={span}
            yearly={yearly}
            billed={billed}
            outstanding={outstanding}
            outstandingYear={k.outstanding_year_paise}
            arrears={arrears}
            outstandingPct={outstandingPct}
            defaulters={k.defaulters}
            /* The six ageing buckets, or null when nothing is outstanding.
               Null is not six zeroes and the card treats it as neither. */
            ageing={k.outstanding_ageing}
            yearInvoices={k.year_invoice_count}
            href={feesHref}
          />
        )}
      </Widget>

      {/* A warning, so orange — the hue this palette reserves for one. */}
      <Widget id="defaulters" label={t('bento.principal.defaulters')} size="small" index={4}>
        {(span) => (
          <DefaultersCard
            span={span}
            defaulters={k.defaulters}
            students={k.students}
            defaultersPct={defaultersPct}
            href={defaultersHref}
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
          <CollectedCard
            span={span}
            yearly={yearly}
            billed={billed}
            collected={collected}
            outstanding={outstanding}
            collectedPct={collectedPct}
            rangeLabel={k.range.label}
            href={feesHref}
          />
        )}
      </Widget>

      {/* No badge and no accent. Four hues, one meaning each, and the roll is
          not one of those meanings — a tint here would only make the two that
          do mean something harder to find. */}
      <Widget id="students" label={t('bento.principal.students')} size="medium" index={3}>
        {(span) => (
          <StudentsCard
            span={span}
            students={k.students}
            staff={k.staff}
            sections={k.sections}
            perSection={perSection}
            loadPerTeacher={loadPerTeacher}
            /* The roll's own composition — it sums to `students`, so the
               drawing and the figure above it cannot disagree. */
            classes={k.students_by_class}
            href={studentsHref}
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
          <ApprovalsCard
            span={span}
            count={k.pending_leave}
            /* Omitted when nothing is pending; the card then says so in words
               rather than drawing an empty ranking. */
            groups={k.pending_leave_by_type}
            to={approvalsHref}
            cueLabel={t('bento.principal.cue_approvals')}
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
          <ApplicationsCard
            span={span}
            count={k.open_applications}
            /* The stages, in the server's admission order. They sum to the
               count beside them; absent, there is no funnel to draw. */
            stages={k.open_applications_by_status}
            to={applicationsHref}
            cueLabel={t('bento.principal.cue_applications')}
          />
        )}
      </Widget>

      <Widget id="unassigned" label={t('bento.principal.unassigned')} size="medium" index={6}>
        {(span) => (
          <UnassignedCard
            span={span}
            count={k.unassigned_subjects}
            /* Every class-subject offered. Omitted when the school offers
               none, and the card refuses to divide by a number that is not
               there rather than printing "9 of 0". */
            total={k.class_subjects_total}
            to={subjectsHref}
            cueLabel={t('bento.principal.cue_unassigned')}
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
              peak={attentionPeak > 0 ? attentionPeak : undefined}
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
            /* The response carries a percent per child and no population to
               divide it by, so there is no share to draw — but there IS a
               spread, and how far below the line they are is the question the
               count on its own cannot answer. Five bands, each one a count of
               rows that arrived. */
            facts={
              shortagePcts.length > 0
                ? [
                    { key: 'low', value: `${lowestPct}%`, label: t('bento.principal.fact_lowest') },
                    {
                      key: 'u60',
                      value: String(shortagePcts.filter((v) => v < 60).length),
                      label: t('bento.principal.fact_under_60'),
                    },
                  ]
                : undefined
            }
            drawNeedsHeight
            draw={
              shortagePcts.length > 0 ? (
                <Rows
                  items={bandCounts(shortagePcts, [
                    { label: t('bento.principal.band_lt50'), max: 49 },
                    { label: t('bento.principal.band_50'), max: 59 },
                    { label: t('bento.principal.band_60'), max: 64 },
                    { label: t('bento.principal.band_65'), max: 69 },
                    { label: t('bento.principal.band_70'), max: 75 },
                  ])}
                  srLabel={t('bento.principal.shortage_bands_sr')}
                />
              ) : undefined
            }
            empty={t('bento.principal.shortage_empty')}
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
            /* The rail above is the share with nothing timetabled, against a
               real roll. The drawing beside it is the other half of the same
               response: what the rest of the staff are actually carrying,
               counted into weekly-period bands. */
            drawNeedsHeight
            draw={
              workloadPeriods.length > 0 ? (
                <Rows
                  items={bandCounts(workloadPeriods, [
                    { label: t('bento.principal.band_none'), max: 0 },
                    { label: t('bento.principal.band_1_10'), max: 10 },
                    { label: t('bento.principal.band_11_20'), max: 20 },
                    { label: t('bento.principal.band_21_30'), max: 30 },
                    { label: t('bento.principal.band_31_up'), max: Number.MAX_SAFE_INTEGER },
                  ])}
                  srLabel={t('bento.principal.workload_bands_sr')}
                />
              ) : undefined
            }
            empty={t('bento.principal.unallocated_empty')}
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
            /* One mark per section, the ones without a timetable drawn at
               full weight. Both numbers are in `summary`, so the grid has
               exactly as many marks as the school has sections — it is the
               same fact as the rail, made countable. Past 144 the marks are a
               texture rather than a count, and the rail says it alone. */
            draw={
              ttSummary && ttSummary.sections > 0 && ttSummary.sections <= 144 ? (
                <Rows
                  items={[
                    { label: t('bento.principal.fact_flagged'),
                      value: ttSummary.sections_without_timetable },
                    { label: t('bento.principal.fact_clear'),
                      value: Math.max(0, ttSummary.sections - ttSummary.sections_without_timetable) },
                  ]}
                  srLabel={t('bento.principal.tt_sections_grid_sr', {
                    count: ttSummary.sections_without_timetable,
                    total: ttSummary.sections,
                  })}
                />
              ) : undefined
            }
            empty={t('bento.principal.tt_empty')}
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
            /* Two counts off one summary, sharing one scale, both named. The
               week's live periods really do split into staffed and not, so
               this is a composition and not a proportion of an invented
               whole. */
            drawNeedsHeight
            draw={
              ttSummary && ttSummary.live_periods > 0 ? (
                <Rows
                  items={[
                    {
                      label: t('bento.principal.band_no_teacher'),
                      value: ttSummary.live_unstaffed,
                    },
                    {
                      label: t('bento.principal.band_staffed'),
                      value: ttSummary.live_periods - ttSummary.live_unstaffed,
                    },
                  ]}
                  srLabel={t('bento.principal.tt_unstaffed_split_sr')}
                />
              ) : undefined
            }
            empty={t('bento.principal.tt_empty')}
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
            value={planRows.length}
            accent={longestWait >= 7 ? 'orange' : undefined}
            /* `waiting_days` is the field the queue is sorted by on the server
               and the cell threw it away. A review queue is not a number, it
               is an age — five plans submitted this morning and five submitted
               a fortnight ago are the same figure and not the same problem. */
            facts={
              planRows.length > 0
                ? [
                    {
                      key: 'oldest',
                      value: t('bento.principal.days_short', { count: longestWait }),
                      label: t('bento.principal.fact_longest_wait'),
                    },
                    {
                      key: 'week',
                      value: String(planWaits.filter((d) => d > 7).length),
                      label: t('bento.principal.fact_over_a_week'),
                    },
                  ]
                : undefined
            }
            drawNeedsHeight
            draw={
              planWaits.length > 0 ? (
                <Rows
                  items={bandCounts(planWaits, [
                    { label: t('bento.principal.band_today'), max: 0 },
                    { label: t('bento.principal.band_1_2d'), max: 2 },
                    { label: t('bento.principal.band_3_7d'), max: 7 },
                    { label: t('bento.principal.band_8_14d'), max: 14 },
                    { label: t('bento.principal.band_15d_up'), max: Number.MAX_SAFE_INTEGER },
                  ])}
                  srLabel={t('bento.principal.plans_bands_sr')}
                />
              ) : undefined
            }
            empty={t('bento.principal.plans_empty')}
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
            /* Every paper carries its own status, and the four statuses are a
               closed set that adds up to the list that arrived. So the queue
               can be drawn as what it is made of rather than as its length —
               with no denominator borrowed from anywhere, because the total
               IS the response. */
            facts={
              paperRows.length > 0
                ? [
                    {
                      key: 'changes',
                      value: String(paperStatusCounts('changes_needed')),
                      label: t('bento.principal.fact_changes_needed'),
                    },
                    {
                      key: 'approved',
                      value: String(paperStatusCounts('approved')),
                      label: t('bento.principal.fact_approved'),
                    },
                  ]
                : undefined
            }
            drawNeedsHeight
            draw={
              paperRows.length > 0 ? (
                <Rows
                  items={[
                    { label: t('bento.principal.band_submitted'), value: papersWaiting },
                    { label: t('bento.principal.band_changes'), value: paperStatusCounts('changes_needed') },
                    { label: t('bento.principal.band_draft'), value: paperStatusCounts('draft') },
                    { label: t('bento.principal.band_approved'), value: paperStatusCounts('approved') },
                  ]}
                  srLabel={t('bento.principal.papers_status_sr')}
                />
              ) : undefined
            }
            empty={t('bento.principal.papers_empty')}
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
            queued={grievanceRows.length}
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
            /* Every entry carries the day it falls on, and the cell printed
               only how many there were. Thirty marks are the next thirty days
               and the lit ones have something on them — a real calendar, at
               the size of a postage stamp, with no proportion in it. */
            facts={
              upcoming.length > 0
                ? [
                    ...(nextInDays !== undefined
                      ? [
                          {
                            key: 'away',
                            value: t('bento.principal.days_short', { count: nextInDays }),
                            label: t('bento.principal.fact_days_away'),
                          },
                        ]
                      : []),
                    { key: 'soon', value: String(calendarSoon), label: t('bento.principal.fact_in_30_days') },
                  ]
                : undefined
            }
            /* The slot was empty. Every entry carries the day it falls on
               and `daysAway` is a whole number of days off the ISO strings,
               so the next few dates ARE a ranking in one unit — no
               denominator anywhere in it, and the tracks are days rather
               than a share of a month. */
            drawNeedsHeight
            draw={
              upcoming.length > 0 ? (
                <Rows
                  items={upcoming.slice(0, 4).map((e) => ({
                    label: e.name,
                    value: Math.max(0, daysAway(e.starts_on)),
                  }))}
                  formatValue={(d) => t('bento.principal.days_short', { count: d })}
                  srLabel={t('bento.principal.calendar_rows_sr', { count: upcoming.length })}
                />
              ) : undefined
            }
            empty={t('bento.principal.calendar_none')}
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
            /* The list splits three ways on `starts_on` alone — ahead of
               today, already sat, and never dated — and those three are the
               whole response, so they share one scale honestly. `is_published`
               is a fourth fact about the same rows and is named, not drawn:
               it cuts across all three and would not be a segment of them. */
            facts={
              examRows.length > 0
                ? [
                    { key: 'pub', value: String(examsPublished), label: t('bento.principal.fact_published') },
                    ...(examsUndated > 0
                      ? [{ key: 'undated', value: String(examsUndated), label: t('bento.principal.fact_undated') }]
                      : []),
                  ]
                : undefined
            }
            drawNeedsHeight
            draw={
              examRows.length > 0 ? (
                <Rows
                  items={[
                    { label: t('bento.principal.band_ahead'), value: examsUpcoming },
                    { label: t('bento.principal.band_sat'), value: examsSat },
                    { label: t('bento.principal.band_undated'), value: examsUndated },
                  ]}
                  srLabel={t('bento.principal.exams_split_sr')}
                />
              ) : undefined
            }
            empty={t('bento.principal.exams_empty')}
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
            accent={unread > 0 ? 'orange' : undefined}
            /* The endpoint returns the unread count PER conversation and the
               cell summed them and dropped the rest. One column per
               conversation with something waiting, busiest first, says whether
               forty unread is one long argument or forty people — which is the
               difference between an evening's work and a minute's. */
            facts={
              unreadPerThread.length > 0
                ? [
                    { key: 'busiest', value: String(unreadPerThread[0]), label: t('bento.principal.fact_busiest') },
                    {
                      key: 'convs',
                      value: String(threadRows.filter((r) => r.unread > 0).length),
                      label: t('bento.principal.fact_with_unread'),
                    },
                  ]
                : undefined
            }
            draw={
              unreadPerThread.length > 0 ? (
                <Distribution
                  values={unreadPerThread}
                  srLabel={t('bento.principal.messages_spread_sr', { count: unreadPerThread.length })}
                />
              ) : undefined
            }
            empty={t('bento.principal.messages_empty')}
            note={t('bento.principal.messages_note', { count: threadRows.length })}
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
            /* NO DRAWING, AND NOT FOR WANT OF ROOM. `/academics/classes`
               returns names and ids; there is no quantity on a row to bucket,
               rank or count off, so there is nothing here that a picture could
               be a picture of. What the extra room buys instead is the two
               figures beside it that DID arrive, on the KPI response, and the
               average of the two. */
            facts={[
              { key: 'sections', value: String(k.sections), label: t('bento.principal.fact_sections') },
              ...(classCount > 0
                ? [
                    {
                      key: 'each',
                      value: String(Math.round(k.sections / classCount)),
                      label: t('bento.principal.fact_sections_each'),
                    },
                  ]
                : []),
              { key: 'roll', value: String(k.students), label: t('bento.principal.fact_on_roll') },
            ]}
            empty={classCount > 0 ? undefined : t('bento.principal.classes_empty')}
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

/** Open grievances, on the card.

    NO DENOMINATOR EXISTS HERE, SO NO PROPORTION IS DRAWN. The queue is every
    ticket ever raised — there is no population an open ticket is a share of —
    so there is no `Gauge` on this cell at any size. What the response does
    carry is one row per ticket with its age, its category and its department,
    and a spread needs no whole to be true.

    THE 300-ROW CAP. `/comms/grievances/` ends `LIMIT 300`. When the response
    comes back full the queue is longer than what is drawn, and the card says
    so rather than letting a cut series read as the size of the problem. */
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
  const label = t('bento.principal.grievances')
  const cue = t('bento.principal.cue_grievances')

  if (status !== 'ready') {
    return <PendingCard span={span} domain="communication" label={label} status={status} />
  }

  if (open.length === 0) {
    return (
      <FeatureCard
        span={span}
        domain="communication"
        title={label}
        sub={t('bento.principal.grievances_sub')}
        value="—"
        change={t('bento.principal.grievances_none')}
        href={href}
        cue={cue}
      >
        <Say>{t('bento.principal.grievances_none')}</Say>
      </FeatureCard>
    )
  }

  const days = open.map((g) => (Number.isFinite(g.open_days) ? g.open_days : 0))
  const oldest = Math.max(1, ...days)
  const other = t('bento.principal.other_slice')
  const ages = (bins: number) => (
    <Distribution
      values={histogram(days, bins, 0, oldest)}
      srLabel={t('bento.principal.grievances_days_sr', { count: open.length, oldest })}
    />
  )
  const byCategory = (n: number) => (
    <Rows
      items={topCounts(open, (g) => g.category, other).slice(0, n)}
      srLabel={t('bento.principal.grievances_cat_rows_sr')}
    />
  )
  const byDepartment = (n: number) => (
    <Rows
      items={topCounts(open, (g) => g.department, t('bento.principal.no_department')).slice(0, n)}
      srLabel={t('bento.principal.grievances_dept_rows_sr')}
    />
  )

  const drawing =
    wide && tall ? (
      <Pair top={<Split left={byCategory(4)} right={byDepartment(4)} />} bottom={ages(18)} />
    ) : tall ? (
      <Pair top={ages(10)} bottom={byCategory(3)} />
    ) : wide ? (
      byCategory(3)
    ) : (
      ages(10)
    )

  return (
    <FeatureCard
      span={span}
      domain="communication"
      title={label}
      sub={t('bento.principal.grievances_sub')}
      value={open.length}
      change={
        queued >= GRIEVANCE_LIMIT
          ? t('bento.principal.grievances_capped', { count: GRIEVANCE_LIMIT })
          : t('bento.principal.grievances_change', { count: queued, oldest })
      }
      href={href}
      cue={cue}
    >
      {drawing}
    </FeatureCard>
  )
}

/** Grievances past their deadline, on the card.

    `open.length` IS a real denominator for this one figure — every open ticket
    either is or is not past its own `resolve_due_at`, and both sides of that
    comparison arrived in the same payload. It is still a comparison of two
    counts rather than a ring, because the set it counts over is itself cut at
    three hundred, and the card says so when the cap is reached. */
function GrievancesOverdueCell({
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
  const label = t('bento.principal.grievances_late')
  const cue = t('bento.principal.cue_grievances')

  if (status !== 'ready') {
    return <PendingCard span={span} domain="communication" label={label} status={status} />
  }

  const late = open.filter((g) => (g.overdue_hours ?? 0) > 0)

  if (open.length === 0) {
    return (
      <FeatureCard
        span={span}
        domain="communication"
        title={label}
        sub={t('bento.principal.grv_late_sub')}
        value="—"
        change={t('bento.principal.grv_none_open')}
        href={href}
        cue={cue}
      >
        <Say>{t('bento.principal.grv_none_open')}</Say>
      </FeatureCard>
    )
  }

  const hours = late.map((g) => g.overdue_hours ?? 0)
  const worst = Math.max(1, ...hours)
  const against = (
    <Compare
      rows={[
        { label: t('bento.principal.grv_state_open'), value: open.length },
        { label: t('bento.principal.grv_past_due'), value: late.length },
      ]}
      srLabel={t('bento.principal.grv_late_compare_sr', { late: late.length, open: open.length })}
    />
  )
  const spread = (bins: number) => (
    <Distribution
      values={histogram(hours, bins, 0, worst)}
      srLabel={t('bento.principal.grv_late_hours_sr', { count: late.length, worst: Math.round(worst) })}
    />
  )
  const byDepartment = (n: number) => (
    <Rows
      items={topCounts(late, (g) => g.department, t('bento.principal.no_department')).slice(0, n)}
      srLabel={t('bento.principal.grv_late_dept_rows_sr')}
    />
  )

  /* Tickets are open and not one of them is past its deadline — the good
     case, and the one where the ageing spread has no rows. The comparison of
     the two counts is still true and still worth the row: it is what says
     nought of nine are late. */
  const has = late.length > 0

  const drawing =
    (wide && tall
      ? stack(beside(false, against, has && byDepartment(4)), has && spread(18))
      : tall
        ? stack(against, has && spread(10))
        : wide
          ? against
          : (has && spread(10)) || against) ?? against

  return (
    <FeatureCard
      span={span}
      domain="communication"
      accent={late.length > 0 ? 'pink' : undefined}
      title={label}
      sub={t('bento.principal.grv_late_sub')}
      value={late.length}
      change={
        queued >= GRIEVANCE_LIMIT
          ? t('bento.principal.grv_late_capped', { open: open.length, count: GRIEVANCE_LIMIT })
          : t('bento.principal.grv_late_change', { count: open.length })
      }
      href={href}
      cue={cue}
    >
      {drawing}
    </FeatureCard>
  )
}

/* THE PROBE SEAM.

   The size-aware cells above are mounted by this file and by nothing else in
   the product, which is also why a blank drawing row in one of them could sit
   on the board unseen. These aliases let a headless probe mount each cell at
   all four shapes twice over — once with the response its handler really
   returns for a working school, once with the empty response the same handler
   returns for a school that has none of that kind — and read what the drawing
   row actually contains. Same convention `FinanceDashboard.tsx` already uses,
   and nothing in the running product imports them. */
export {
  SyllabusCell as __SyllabusCell,
  ModerationCell as __ModerationCell,
  PassRateCell as __PassRateCell,
  AtRiskCell as __AtRiskCell,
  SetupCell as __SetupCell,
  CoverCell as __CoverCell,
  MyLeaveCell as __MyLeaveCell,
  MyPayCell as __MyPayCell,
  GrievancesOpenCell as __GrievancesOpenCell,
  GrievancesOverdueCell as __GrievancesOverdueCell,
  SourceCell as __SourceCell,
  AttentionCell as __AttentionCell,
}
