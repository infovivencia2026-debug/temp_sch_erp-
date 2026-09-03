import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, ApiError, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { formatPaise } from '@/lib/utils'
import { BentoError, BentoLoading, useFeatureHref, type CellSpan } from './bento-kit'
import { Area, Bars, Compare, Gauge, Line, Rows, Scale } from './bento-cards'
import {
  Facts, IN_SCHOOL, Part, PersonaCard, PersonaPage, Say, Split, Titled,
  byStatus, byWeekday, cut, hhmm, lengthOf, mins, runs, useNowMinutes, useShape,
  weeklyRate, type RegisterDay,
} from './persona-kit'
import { Widget } from './WidgetLayer'

/* THE STUDENT'S DAY, IN THE EDITORIAL CARD LANGUAGE.

   Five cells, every one `PersonaCard` around `CardShell` — header, figure,
   drawing, the drawing taking every pixel the figure did not — and every
   drawing one of the twelve in `bento-cards.tsx`.
   docs/BENTO_CARD_PATTERNS.md is the contract. Nothing here names a colour.

   SCOPE. A student's resolved scope is one record, so no `student_id` is sent
   on any request: a student asked which of themselves they meant is a portal
   built for somebody else, and every one of these endpoints answers for the
   caller's own record when the parameter is absent.

   ─── WHERE THE FIGURES COME FROM ─────────────────────────────────────────

   Read from internal/api/role_scoped.go and internal/api/portal_family.go.

     /portal/students    the record. Also carries `relation`, unused here.
     /portal/summary     the day's periods (both bell times, teacher, room),
                         the attendance counts, the homework and the balance.
     /portal/attendance  ONE ROW PER MARKED DAY for the last 120 days, with its
                         status. This is the only real SERIES on the board and
                         it is what the trend and the weekday spread are drawn
                         from. It was not read before; no handler was added,
                         and it is the same endpoint the student's own register
                         screen already reads.
     /portal/fees        the invoices and receipts. It carries `net_paise` and
                         `paid_paise` per invoice, which is the only REAL
                         DENOMINATOR the money on this board has: billed. The
                         summary's `outstanding_paise` alone is a count with no
                         whole, and a ring drawn against an invented total
                         would be the fifth fabricated denominator this product
                         has had to remove.

   THE TWO EXTRA QUERIES DEGRADE, THEY DO NOT GATE. If the register or the
   ledger fails, the cells that draw from it say so and the rest of the board
   is still true — but neither ever falls back to a confident zero.

   WHAT EACH SIZE ADDS is a ladder, branched on the real WIDTH and HEIGHT and
   never on area: a wide cell buys marks along a row, a tall one buys rows, and
   a cell that folded the two into an area would draw the same thing at 2x1 and
   1x2. */

interface PortalChild {
  student_id: string
  admission_no: string
  full_name: string
  class_name?: string
  section_name?: string
  roll_no?: number
  relation?: string
}
interface TodayPeriod {
  period: string
  starts_at?: string
  ends_at?: string
  subject: string
  teacher?: string
  room?: string
}
interface PortalSummary {
  student_id: string
  full_name: string
  attendance_pct: number
  present_days: number
  total_days: number
  absent_days: number
  homework_due: number
  next_homework_due?: string
  next_homework_title?: string
  outstanding_paise: number
  next_exam?: string
  today: TodayPeriod[]
}
/** Every field portal_family.go puts on an invoice. */
interface FamilyInvoice {
  invoice_no: string
  instalment_no?: number
  issued_on: string
  due_on?: string
  net_paise: number
  paid_paise: number
  due_paise: number
  fine_paise: number
  status: string
  days_overdue: number
}
interface FamilyFees {
  student_id: string
  student_name: string
  outstanding_paise: number
  invoices: FamilyInvoice[]
  receipts: { receipt_no: string; paid_on: string; amount_paise: number; mode: string; status: string }[]
}

/** Days from today to a yyyy-mm-dd. Negative is overdue. */
function daysUntil(iso: string) {
  return Math.round(
    (new Date(iso + 'T00:00:00').getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000,
  )
}

export default function StudentDay() {
  const t = useT()
  const now = useNowMinutes()

  // The cues, resolved against the catalogue rather than hard-coded, so a cell
  // never offers a screen this account cannot open.
  const toTimetable = useFeatureHref('student.timetable.timetable')
  const toAttendance = useFeatureHref('student.attendance.attendance')
  const toHomework = useFeatureHref('student.homework.homework_assignments')
  const toFees = useFeatureHref('student.fees.fees')

  const children = useQuery({
    queryKey: ['portal-students'],
    queryFn: () => api.get<List<PortalChild>>('/api/v1/portal/students'),
  })
  const summary = useQuery({
    queryKey: ['portal-summary', 'self'],
    queryFn: () => api.get<PortalSummary>('/api/v1/portal/summary'),
  })
  const register = useQuery({
    queryKey: ['portal-attendance', 'self'],
    queryFn: () => api.get<List<RegisterDay>>('/api/v1/portal/attendance'),
  })
  const ledger = useQuery({
    queryKey: ['portal-fees', 'self'],
    queryFn: () => api.get<FamilyFees>('/api/v1/portal/fees'),
  })

  if (children.isLoading || summary.isLoading || register.isLoading || ledger.isLoading) {
    return <BentoLoading message={t('bento.student_day.loading')} />
  }
  /* A failed query is an error, never an empty state. "Nothing due today" read
     off a 500 is a sentence a child will act on by not doing the homework.

     Only the two the whole board rests on gate it. The register and the ledger
     degrade per cell instead — losing the trend is not a reason to hide the
     timetable. */
  /* Not found is not a failure. The login exists and no student record is
     tied to it yet, which is the office's to fix — say that, rather than
     "did not load", which sends a child to reload a page that will never
     change. */
  if (summary.error instanceof ApiError && summary.error.status === 404) {
    return <BentoError message={t('bento.student_day.no_record')} />
  }
  if (children.error || summary.error || !summary.data) {
    return <BentoError message={t('bento.student_day.failed')} />
  }

  const me = children.data?.items[0]
  const s = summary.data
  /* `null` is "the register could not be read", which is not the same fact as
     "no day has been marked" and must never be drawn as one. */
  const days: RegisterDay[] | null = register.error ? null : (register.data?.items ?? [])
  const fees: FamilyFees | null = ledger.error ? null : (ledger.data ?? null)

  const form = [
    me?.class_name ? `${me.class_name}${me.section_name ? `-${me.section_name}` : ''}` : null,
    me?.roll_no ? t('bento.common.roll', { roll: me.roll_no }) : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const periods = s.today
  const idxNow = periods.findIndex((p) => {
    const a = hhmm(p.starts_at)
    const b = hhmm(p.ends_at)
    return a !== null && b !== null && now >= a && now < b
  })
  const idxNext = periods.findIndex((p) => {
    const a = hhmm(p.starts_at)
    return a !== null && a > now
  })

  return (
    <PersonaPage
      eyebrow={t('bento.student_day.eyebrow')}
      title={s.full_name}
      description={form || undefined}
      dashboard="student_day"
    >
      <Widget id="now" label={t('bento.student_day.now_label')} size="large" index={0}>
        {(span) => (
          <NowCell span={span} periods={periods} now={now} idxNow={idxNow} idxNext={idxNext} to={toTimetable} />
        )}
      </Widget>

      <Widget id="attendance" label={t('bento.student_day.attendance')} size="small" index={1}>
        {(span) => <AttendanceCell span={span} s={s} days={days} to={toAttendance} />}
      </Widget>

      <Widget id="homework" label={t('bento.student_day.homework')} size="small" index={2}>
        {(span) => <HomeworkCell span={span} s={s} to={toHomework} />}
      </Widget>

      <Widget id="fees" label={t('bento.student_day.fees')} size="small" index={3}>
        {(span) => <FeesCell span={span} s={s} fees={fees} to={toFees} />}
      </Widget>

      <Widget id="absent" label={t('bento.student_day.absent')} size="small" index={4}>
        {(span) => <AbsentCell span={span} s={s} days={days} to={toAttendance} />}
      </Widget>
    </PersonaPage>
  )
}

/** 525 → "08:45". */
function fmtMin(n: number): string {
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
}

/* ─── THE ANCHOR: which lesson is now ─────────────────────────────────────

   The figure is the SUBJECT, because "what have I got now" is the question a
   child opens this page to answer, and the drawing is where in the day that
   lesson sits.

   1x1  `Scale` — now, between the first bell and the last. A real range: both
        ends came off the timetable.
   2x1  `Bars` — one bar per period, its height the period's real LENGTH, the
        current one filled. The width buys a mark per period.
   1x2  `Scale`, and under it the day's real figures.
   2x2  `Bars` and the figures together.

   A period missing either bell has no length and is left out of the drawing
   rather than assigned the school's usual one — that would be a number this
   response never carried. */
export function NowCell({
  span, periods, now, idxNow, idxNext, to,
}: {
  span: CellSpan
  periods: TodayPeriod[]
  now: number
  idxNow: number
  idxNext: number
  to?: string
}) {
  const t = useT()
  const { wide, tall } = useShape()

  const current = idxNow >= 0 ? periods[idxNow] : undefined
  const next = idxNext >= 0 ? periods[idxNext] : undefined
  const finished = periods.length > 0 && !current && !next
  const focus = current ?? next

  const timed = periods
    .map((p, i) => ({ p, i, len: lengthOf(p.starts_at, p.ends_at) }))
    .filter((x): x is { p: TodayPeriod; i: number; len: number } => x.len !== null)
  const starts = periods.map((p) => hhmm(p.starts_at)).filter((n): n is number => n !== null)
  const ends = periods.map((p) => hhmm(p.ends_at)).filter((n): n is number => n !== null)
  const first = starts.length ? Math.min(...starts) : null
  const last = ends.length ? Math.max(...ends) : null
  const taught = timed.reduce((a, x) => a + x.len, 0)

  const value = periods.length === 0
    ? t('bento.student_day.no_lessons')
    : finished
      ? t('bento.student_day.finished')
      : focus!.subject
  const change = periods.length === 0
    ? t('bento.student_day.no_lessons_note')
    : finished
      ? t('bento.student_day.finished_note', { count: periods.length })
      : [
          current
            ? t('bento.student_day.until', { period: current.period, ends: current.ends_at ?? '—' })
            : t('bento.student_day.starts', { period: next!.period, at: next!.starts_at ?? '—' }),
          focus!.room ?? '',
          current
            ? next
              ? t('bento.student_day.then', { subject: next.subject, at: next.starts_at ?? '—' })
              : t('bento.student_day.last_lesson')
            : t('bento.student_day.not_started'),
        ].filter(Boolean).join(' · ')

  const facts = cut(
    [
      first !== null ? { label: t('bento.student_day.fact_first'), value: fmtMin(first) } : null,
      last !== null ? { label: t('bento.student_day.fact_last'), value: fmtMin(last) } : null,
      { label: t('bento.student_day.fact_lessons'), value: String(periods.length) },
      timed.length ? { label: t('bento.student_day.fact_taught'), value: mins(taught) } : null,
      focus?.teacher ? { label: t('bento.student_day.fact_teacher'), value: focus.teacher } : null,
    ].filter((f): f is { label: string; value: string } => f !== null),
    tall ? 5 : 3,
  )

  const rail =
    first !== null && last !== null && last > first ? (
      <Scale
        value={now} min={first} max={last}
        srLabel={t('bento.student_day.rail_sr', { first: fmtMin(first), last: fmtMin(last) })}
      />
    ) : (
      <Say>{t('bento.student_day.no_bells')}</Say>
    )

  const bars = timed.length ? (
    <Bars
      values={timed.map((x) => x.len)}
      activeIndex={idxNow >= 0 ? timed.findIndex((x) => x.i === idxNow) : undefined}
      srLabel={t('bento.student_day.bars_sr', { count: timed.length, total: mins(taught) })}
    />
  ) : (
    <Say>{t('bento.student_day.no_bells')}</Say>
  )

  let drawing: ReactNode = rail
  if (wide && tall) {
    drawing = (
      <Split>
        <Part grow={3}><Titled head={t('bento.student_day.head_day')}>{bars}</Titled></Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.student_day.facts_sr')} /></Part>
      </Split>
    )
  } else if (wide) {
    drawing = <Titled head={t('bento.student_day.head_day')}>{bars}</Titled>
  } else if (tall) {
    drawing = (
      <Split>
        <Part grow={2}><Titled head={t('bento.student_day.head_now')}>{rail}</Titled></Part>
        <Part grow={3}><Facts items={facts} srLabel={t('bento.student_day.facts_sr')} /></Part>
      </Split>
    )
  }

  return (
    <PersonaCard
      span={span}
      title={current ? t('bento.student_day.now_label') : t('bento.student_day.next_label')}
      glyph="◷"
      value={value}
      change={change}
      to={to}
      cueLabel={t('bento.student_day.now_cue')}
    >
      {periods.length === 0 ? <Say>{t('bento.student_day.no_lessons_note')}</Say> : drawing}
    </PersonaCard>
  )
}

/* ─── ATTENDANCE — the one coloured cell ───────────────────────────────────

   A proportion whose shape is the point, and every denominator is real:
   `total_days` is the days the register actually carries, counted by the
   handler in the same query as `present_days` and `absent_days`.

   1x1  `Rows` — present, absent, and everything else, which is a partition of
        `total_days` whose parts sum back to it. Not a ring: `Gauge` is sized
        off the drawing row's WIDTH, and on a one-row cell the bottom third of
        it is cut off by the cell's own overflow.
   2x1  the same, and the figures beside them.
   1x2  the height buys the ring, over the partition.
   2x2  the ring, and beside it the FULL status breakdown from the register —
        late, half day and leave separated out rather than lumped into
        "everything else" — with the figures under it. */
export function AttendanceCell({
  span, s, days, to,
}: {
  span: CellSpan
  s: PortalSummary
  days: RegisterDay[] | null
  to?: string
}) {
  const t = useT()
  const { wide, tall } = useShape()

  const other = Math.max(0, s.total_days - s.present_days - s.absent_days)
  const split = [
    { label: t('bento.student_day.track_present'), value: s.present_days },
    { label: t('bento.student_day.track_absent'), value: s.absent_days },
    ...(other > 0 ? [{ label: t('bento.student_day.track_other'), value: other }] : []),
  ]
  const detailed = days ? byStatus(days) : []

  const facts = cut(
    [
      { label: t('bento.student_day.fact_marked'), value: String(s.total_days) },
      { label: t('bento.student_day.fact_present'), value: String(s.present_days) },
      { label: t('bento.student_day.fact_absent'), value: String(s.absent_days) },
      other > 0 ? { label: t('bento.student_day.fact_other'), value: String(other) } : null,
    ].filter((f): f is { label: string; value: string } => f !== null),
    tall ? 4 : 3,
  )

  const sr = t('bento.student_day.absent_sr', { present: s.present_days, total: s.total_days })
  const partition = <Rows items={split} srLabel={sr} />
  const ring = <Gauge value={s.present_days} total={s.total_days} srLabel={sr} />

  let drawing: ReactNode = partition
  if (wide && tall) {
    drawing = (
      <Split row>
        <Part grow={2}>{ring}</Part>
        <Part grow={3}>
          <Split>
            <Part grow={3}>
              {detailed.length ? (
                <Titled head={t('bento.student_day.head_statuses')}>
                  <Rows items={cut(detailed, 5)} srLabel={t('bento.student_day.statuses_sr')} />
                </Titled>
              ) : days ? (
                <Say>{t('bento.student_day.no_register')}</Say>
              ) : (
                <Say>{t('bento.student_day.register_unread')}</Say>
              )}
            </Part>
            <Part grow={2}><Facts items={cut(facts, 3)} srLabel={t('bento.student_day.facts_sr')} /></Part>
          </Split>
        </Part>
      </Split>
    )
  } else if (wide) {
    drawing = (
      <Split row>
        <Part grow={3}>{partition}</Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.student_day.facts_sr')} /></Part>
      </Split>
    )
  } else if (tall) {
    drawing = (
      <Split>
        <Part grow={3}>{ring}</Part>
        <Part grow={2}>{partition}</Part>
      </Split>
    )
  }

  return (
    <PersonaCard
      span={span}
      ground="attendance"
      title={t('bento.student_day.attendance')}
      glyph="◎"
      value={s.total_days > 0 ? `${s.attendance_pct}%` : '—'}
      change={
        s.total_days > 0
          ? t('bento.student_day.attendance_note', { present: s.present_days, total: s.total_days })
          : t('bento.student_day.no_register')
      }
      to={to}
      cueLabel={t('bento.student_day.attendance_cue')}
    >
      {s.total_days > 0 ? drawing : <Say>{t('bento.student_day.no_register')}</Say>}
    </PersonaCard>
  )
}

/* ─── HOMEWORK DUE ────────────────────────────────────────────────────────

   NO DENOMINATOR EXISTS FOR THIS ONE, and none is invented. The handler counts
   published homework still owed and nothing else: there is no "set this term"
   in the response for it to be a share of, so there is no ring, no track and
   no percentage on this card at any size. What the count actually wants beside
   it is the other real figures — how soon, and which piece — which is what
   `Facts` draws.

   1x1  the count, the soonest date.
   2x1  + which piece it is.
   1x2  + how many days out it is, from the local calendar.
   2x2  + the next exam, which is the only other dated thing this payload
        carries about work owed. */
export function HomeworkCell({ span, s, to }: { span: CellSpan; s: PortalSummary; to?: string }) {
  const t = useT()
  const { wide, tall } = useShape()
  const hwDays = s.next_homework_due ? daysUntil(s.next_homework_due) : undefined

  const note =
    s.homework_due === 0
      ? t('bento.student_day.homework_none')
      : hwDays === undefined
        ? undefined
        : hwDays < 0
          ? t('bento.student_day.homework_overdue', { days: -hwDays })
          : hwDays === 0
            ? t('bento.student_day.homework_today')
            : t('bento.student_day.homework_days', { days: hwDays })

  const all = [
    { label: t('bento.student_day.fact_due'), value: String(s.homework_due) },
    s.next_homework_due ? { label: t('bento.student_day.fact_soonest'), value: s.next_homework_due } : null,
    s.next_homework_title ? { label: t('bento.student_day.fact_piece'), value: s.next_homework_title } : null,
    hwDays !== undefined
      ? { label: t('bento.student_day.fact_in_days'), value: hwDays < 0 ? t('bento.student_day.days_late', { days: -hwDays }) : t('bento.student_day.days_out', { days: hwDays }) }
      : null,
    s.next_exam ? { label: t('bento.student_day.fact_exam'), value: s.next_exam } : null,
  ].filter((f): f is { label: string; value: string } => f !== null)

  const lines = wide && tall ? 5 : tall ? 4 : wide ? 3 : 2

  return (
    <PersonaCard
      span={span}
      title={t('bento.student_day.homework')}
      glyph="✎"
      value={s.homework_due}
      change={note}
      to={to}
      cueLabel={t('bento.student_day.homework_cue')}
    >
      {s.homework_due === 0 && all.length <= 1 ? (
        <Say>{t('bento.student_day.homework_none')}</Say>
      ) : (
        <Facts items={cut(all, lines)} srLabel={t('bento.student_day.homework_sr', { count: s.homework_due })} />
      )}
    </PersonaCard>
  )
}

/* ─── FEES ────────────────────────────────────────────────────────────────

   The only real whole the money on this board has is BILLED, and it exists:
   `/portal/fees` returns every non-cancelled invoice with its own `net_paise`
   and `paid_paise`. So the ring here divides by a number that arrived in the
   response, and if the ledger cannot be read the ring is not drawn at all —
   the outstanding figure alone has no denominator and nothing pretends
   otherwise.

   1x1  `Compare` — paid against still due, two tracks on one scale.
   2x1  the same, and the figures beside them.
   1x2  the height buys the ring: paid out of billed.
   2x2  the ring, and beside it the unpaid invoices ranked by what is left on
        each — one unit down the whole column.

   Money is paise throughout and is only ever rendered through `formatPaise`. */
export function FeesCell({
  span, s, fees, to,
}: {
  span: CellSpan
  s: PortalSummary
  fees: FamilyFees | null
  to?: string
}) {
  const t = useT()
  const { wide, tall } = useShape()

  const invoices = fees?.invoices ?? []
  const billed = invoices.reduce((a, i) => a + i.net_paise, 0)
  const paid = invoices.reduce((a, i) => a + i.paid_paise, 0)
  /* The ledger's own total when it answered, the summary's otherwise. They are
     the same computation over the same table; using the ledger's keeps the
     figure and the drawing beneath it consistent to the paisa. */
  const due = fees ? fees.outstanding_paise : s.outstanding_paise
  const unpaid = invoices
    .filter((i) => i.due_paise > 0)
    .sort((a, b) => b.due_paise - a.due_paise)
    .map((i) => ({ label: i.invoice_no, value: i.due_paise }))
  const overdue = invoices.filter((i) => i.days_overdue > 0 && i.due_paise > 0).length

  const facts = cut(
    [
      fees ? { label: t('bento.student_day.fact_billed'), value: formatPaise(billed) } : null,
      fees ? { label: t('bento.student_day.fact_paid'), value: formatPaise(paid) } : null,
      { label: t('bento.student_day.fact_owed'), value: formatPaise(due) },
      fees ? { label: t('bento.student_day.fact_invoices'), value: `${unpaid.length}/${invoices.length}` } : null,
      fees && overdue > 0 ? { label: t('bento.student_day.fact_overdue'), value: String(overdue) } : null,
    ].filter((f): f is { label: string; value: string } => f !== null),
    tall ? 5 : 3,
  )

  const sr = t('bento.student_day.fees_sr', { paid: formatPaise(paid), billed: formatPaise(billed) })
  const tracks = billed > 0 ? (
    <Compare
      rows={[
        { label: t('bento.student_day.track_paid'), value: paid },
        { label: t('bento.student_day.track_due'), value: Math.max(0, billed - paid) },
      ]}
      formatValue={formatPaise}
      srLabel={sr}
    />
  ) : null
  const ring = billed > 0 ? <Gauge value={paid} total={billed} srLabel={sr} /> : null

  const noWhole = <Say>{fees ? t('bento.student_day.no_invoices') : t('bento.student_day.ledger_unread')}</Say>

  let drawing: ReactNode = tracks ?? noWhole
  if (wide && tall) {
    drawing = ring ? (
      <Split row>
        <Part grow={2}>{ring}</Part>
        <Part grow={3}>
          {unpaid.length ? (
            <Titled head={t('bento.student_day.head_unpaid')}>
              <Rows items={cut(unpaid, 5)} formatValue={formatPaise} srLabel={t('bento.student_day.unpaid_sr', { count: unpaid.length })} />
            </Titled>
          ) : (
            <Facts items={facts} srLabel={t('bento.student_day.facts_sr')} />
          )}
        </Part>
      </Split>
    ) : (
      <Split><Part>{noWhole}</Part><Part><Facts items={facts} srLabel={t('bento.student_day.facts_sr')} /></Part></Split>
    )
  } else if (wide) {
    drawing = (
      <Split row>
        <Part grow={3}>{tracks ?? noWhole}</Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.student_day.facts_sr')} /></Part>
      </Split>
    )
  } else if (tall) {
    drawing = (
      <Split>
        <Part grow={3}>{ring ?? noWhole}</Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.student_day.facts_sr')} /></Part>
      </Split>
    )
  }

  return (
    <PersonaCard
      span={span}
      title={t('bento.student_day.fees')}
      glyph="₹"
      value={formatPaise(due)}
      change={due > 0 ? t('bento.student_day.fees_owed') : t('bento.student_day.fees_settled')}
      to={to}
      cueLabel={t('bento.student_day.fees_cue')}
    >
      {drawing}
    </PersonaCard>
  )
}

/* ─── DAYS ABSENT — the register as a series ──────────────────────────────

   `/portal/attendance` returns one row per marked day for 120 days, which is
   the only real series on this board. So this cell is the TREND and the
   attendance cell above is the PROPORTION: two different readings of the
   register rather than the same reading twice.

   1x1  `Line` — the share of each week's own marked days spent in school. The
        denominator is per week and real: the days that week's register carries.
        A week with nothing marked is left out, not drawn as a collapse to nil.
   2x1  `Area` — the same series with the ground under it, and more weeks,
        which is what the width buys.
   1x2  `Line`, and under it the runs and the counts.
   2x2  `Area`, and beside it which WEEKDAY the absences fall on — a real
        per-category split with real variation, and no whole needed to be true. */
export function AbsentCell({
  span, s, days, to,
}: {
  span: CellSpan
  s: PortalSummary
  days: RegisterDay[] | null
  to?: string
}) {
  const t = useT()
  const { wide, tall } = useShape()

  const weeks = days ? weeklyRate(days, wide ? 16 : 8) : []
  const points = weeks.map((w) => w.pct)
  const run = days ? runs(days) : { current: 0, longest: 0 }
  const missed = days ? byWeekday(days, (d) => !IN_SCHOOL.has(d.status)) : []
  const missedTotal = missed.reduce((a, r) => a + r.value, 0)

  const facts = cut(
    [
      { label: t('bento.student_day.fact_absent'), value: String(s.absent_days) },
      { label: t('bento.student_day.fact_marked'), value: String(s.total_days) },
      days ? { label: t('bento.student_day.fact_run'), value: String(run.current) } : null,
      days ? { label: t('bento.student_day.fact_longest'), value: String(run.longest) } : null,
      weeks.length ? { label: t('bento.student_day.fact_weeks'), value: String(weeks.length) } : null,
    ].filter((f): f is { label: string; value: string } => f !== null),
    tall ? 5 : 3,
  )

  const sr = t('bento.student_day.trend_sr', { weeks: weeks.length })
  const trend =
    days === null ? (
      <Say>{t('bento.student_day.register_unread')}</Say>
    ) : points.length < 2 ? (
      <Say>{t('bento.student_day.too_short')}</Say>
    ) : wide ? (
      <Area points={points} srLabel={sr} />
    ) : (
      <Line points={points} srLabel={sr} />
    )

  let drawing: ReactNode = trend
  if (wide && tall) {
    drawing = (
      <Split row>
        <Part grow={3}><Titled head={t('bento.student_day.head_trend')}>{trend}</Titled></Part>
        <Part grow={2}>
          {missed.length ? (
            <Titled head={t('bento.student_day.head_weekday')}>
              <Rows items={missed} srLabel={t('bento.student_day.weekday_sr', { count: missedTotal })} />
            </Titled>
          ) : (
            <Facts items={facts} srLabel={t('bento.student_day.facts_sr')} />
          )}
        </Part>
      </Split>
    )
  } else if (tall) {
    drawing = (
      <Split>
        <Part grow={3}><Titled head={t('bento.student_day.head_trend')}>{trend}</Titled></Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.student_day.facts_sr')} /></Part>
      </Split>
    )
  } else if (wide) {
    drawing = <Titled head={t('bento.student_day.head_trend')}>{trend}</Titled>
  }

  return (
    <PersonaCard
      span={span}
      title={t('bento.student_day.absent')}
      glyph="○"
      value={s.absent_days}
      change={
        s.total_days > 0
          ? t('bento.student_day.absent_note', { total: s.total_days })
          : t('bento.student_day.no_register')
      }
      to={to}
      cueLabel={t('bento.student_day.absent_cue')}
    >
      {drawing}
    </PersonaCard>
  )
}
