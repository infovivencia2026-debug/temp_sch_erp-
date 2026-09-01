import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { cn, formatPaise } from '@/lib/utils'
import { BentoError, BentoLoading, useFeatureHref, type CellSpan } from './bento-kit'
import { Area, Compare, Gauge, Line, Rows } from './bento-cards'
import {
  Facts, IN_SCHOOL, Part, PersonaCard, PersonaPage, Say, Split, Titled,
  byMonth, byStatus, byWeekday, cut, runs, useShape, weeklyRate, type RegisterDay,
} from './persona-kit'
import { Widget } from './WidgetLayer'

/* THE CHILD'S WEEK, IN THE EDITORIAL CARD LANGUAGE.

   Five cells, every one `PersonaCard` around `CardShell` — header, figure,
   drawing, the drawing taking every pixel the figure did not — and every
   drawing one of the twelve in `bento-cards.tsx`.
   docs/BENTO_CARD_PATTERNS.md is the contract. Nothing here names a colour.

   ─────────────────────────────────────────────────────────────────────────
   WHICH CHILD. Read this before changing anything on this screen.
   ─────────────────────────────────────────────────────────────────────────
   A guardian may have more than one child, and this repository has shipped the
   wrong-sibling bug repeatedly — a counselling message that reached the wrong
   family, a hall-ticket code for the wrong sibling, a goal with no name on it.
   Two resolvers exist and mean opposite things by a missing `student_id`:
   `familyChildren` answers for every child the caller owns, `whichChild`
   silently answers for the eldest. So a dashboard that omits the id does not
   show "the family" — it shows one child, unlabelled, which is the worst of
   the three possibilities, because it is the one nobody can see is wrong.

   Two rules follow, and both are load-bearing:

     1. `student_id` is sent EXPLICITLY on every request this screen makes.
        Never omitted, never left to the resolver's default. That now includes
        `/portal/fees`, whose handler is `whichChild` — the resolver that
        answers for the eldest in silence.
     2. Every cell carries `who` — the child's name and form — and it is the
        card header's own second line, so it is part of the shell rather than a
        sentence somebody can forget. IT IS NEVER DROPPED BY SIZE. A cell too
        small to name its subject is a cell that must not be drawn.

   ─── WHERE THE FIGURES COME FROM ─────────────────────────────────────────

   Read from internal/api/role_scoped.go and internal/api/portal_family.go.

     /portal/students    the children, with class, section and roll.
     /portal/summary     the attendance counts, the homework and the balance.
     /portal/attendance  ONE ROW PER MARKED DAY for 120 days, with its status.
                         The only real SERIES on the board: the trend, the
                         weekday spread and the monthly counts are all drawn
                         from it, and each one's denominator is that window's
                         own marked days.
     /portal/fees        every non-cancelled invoice with `net_paise` and
                         `paid_paise`. This is the only REAL DENOMINATOR the
                         money has — billed — and it is why the fees ring is
                         allowed to exist. `outstanding_paise` on its own is a
                         count with no whole, and a ring drawn against an
                         invented total is the thing this product has had to
                         remove four times.

   THE LEDGER AND THE REGISTER DEGRADE, THEY DO NOT GATE. If either fails the
   cells drawn from it say so; neither ever falls back to a confident zero.

   LEFT OUT ON PURPOSE: the "needs attention" reminders, which are their own
   screen with their own query — a cell links to that screen rather than
   inlining a second copy of it.

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
  /** On the handler and not previously declared here: how this guardian is
      related to this child. Shown on the switcher when a family has more than
      one, because two children with the same surname are told apart by more
      than the order the query returned them in. */
  relation?: string
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
}
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

function daysUntil(iso: string) {
  return Math.round(
    (new Date(iso + 'T00:00:00').getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000,
  )
}

export default function ParentWeek() {
  const t = useT()
  const [selected, setSelected] = useState<string | null>(null)

  const toAttendance = useFeatureHref('parent.attendance.attendance')
  const toFees = useFeatureHref('parent.fees.fees_payments')
  const toHomework = useFeatureHref('parent.academics.homework_academics')

  const children = useQuery({
    queryKey: ['portal-students'],
    queryFn: () => api.get<List<PortalChild>>('/api/v1/portal/students'),
  })

  const kids = children.data?.items ?? []
  const activeId = selected ?? kids[0]?.student_id ?? null
  const child = kids.find((c) => c.student_id === activeId)

  const summary = useQuery({
    queryKey: ['portal-summary', activeId],
    /* Named explicitly. The endpoint resolves the eldest when the id is
       absent, so omitting it makes the switcher change nothing and prints one
       child's balance under another child's name. */
    queryFn: () => api.get<PortalSummary>(`/api/v1/portal/summary?student_id=${activeId}`),
    enabled: !!activeId,
  })
  const attendance = useQuery({
    queryKey: ['portal-attendance', activeId],
    queryFn: () => api.get<List<RegisterDay>>(`/api/v1/portal/attendance?student_id=${activeId}`),
    enabled: !!activeId,
  })
  const ledger = useQuery({
    queryKey: ['portal-fees', activeId],
    // `whichChild` again: without the id this is the eldest's bill under the
    // selected child's name.
    queryFn: () => api.get<FamilyFees>(`/api/v1/portal/fees?student_id=${activeId}`),
    enabled: !!activeId,
  })

  if (children.isLoading) return <BentoLoading message={t('bento.parent_week.loading')} />
  if (children.error) return <BentoError message={t('bento.parent_week.failed_children')} />

  /** "Grade 6-A · Roll 2" — blank parts drop out rather than leaving stray
   *  separators, because a child admitted last week has no roll number yet. */
  const form = (c?: PortalChild) =>
    !c
      ? ''
      : [
          c.class_name ? `${c.class_name}${c.section_name ? `-${c.section_name}` : ''}` : null,
          c.roll_no ? t('bento.common.roll', { roll: c.roll_no }) : null,
        ]
          .filter(Boolean)
          .join(' · ')

  if (!kids.length) {
    return (
      <PersonaPage eyebrow={t('bento.parent_week.eyebrow')} title={t('bento.parent_week.title')}>
        <div className="rounded-[14px] border bg-card p-5 text-[13.5px] text-muted-foreground sm:col-span-2">
          {t('bento.parent_week.no_link')}
        </div>
      </PersonaPage>
    )
  }

  /* The switcher. Rendered only when there is genuinely something to pick — a
     parent of one asked which child they meant is a portal built for somebody
     else — and every child is a button rather than a dropdown, so the whole
     set is visible without opening anything and the selected one is visible
     without reading it. */
  const switcher =
    kids.length > 1 ? (
      <div
        role="group"
        aria-label={t('bento.parent_week.switcher_sr')}
        className="flex flex-wrap gap-1.5"
      >
        {kids.map((c) => (
          <button
            key={c.student_id}
            type="button"
            aria-pressed={c.student_id === activeId}
            onClick={() => setSelected(c.student_id)}
            className={cn(
              'rounded-md border px-3 py-1.5 text-[13px] font-medium',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              c.student_id === activeId
                ? 'border-primary bg-primary text-primary-foreground'
                : 'bg-card text-card-foreground',
            )}
          >
            {c.full_name}
            {c.relation ? <span className="opacity-70"> · {c.relation}</span> : null}
          </button>
        ))}
      </div>
    ) : undefined

  /* `arrange` is off for the loading and error bodies: those render no
     <Widget> at all, so an arranger toolbar above them would offer to edit a
     board with nothing on it. */
  const header = (body: ReactNode, arrange = false) => (
    <PersonaPage
      eyebrow={t('bento.parent_week.eyebrow')}
      title={child?.full_name ?? t('bento.parent_week.title')}
      /* A guardian of two is told, in words, that what follows is one child of
         several — not the household's figures. A guardian of one gets the
         child's form instead, which is what the office asks for on the
         telephone. */
      description={
        kids.length > 1
          ? t('bento.parent_week.one_of_many', {
              name: child?.full_name ?? '',
              form: form(child),
              count: kids.length,
            })
          : form(child) || undefined
      }
      actions={switcher}
      dashboard={arrange ? 'parent_week' : undefined}
    >
      {body}
    </PersonaPage>
  )

  if (summary.isLoading || attendance.isLoading || ledger.isLoading) {
    return header(
      <div className="sm:col-span-2">
        <BentoLoading message={t('bento.parent_week.loading_child', { name: child?.full_name ?? '' })} />
      </div>,
    )
  }
  /* Never an empty state from a failure: "nothing owed" read off a 500 is a
     sentence a parent will act on by not paying. */
  if (summary.error || !summary.data) {
    return header(
      <div className="sm:col-span-2">
        <BentoError message={t('bento.parent_week.failed_child', { name: child?.full_name ?? '' })} />
      </div>,
    )
  }

  const s = summary.data
  /* `null` is "could not be read", which is not the same fact as "nothing is
     there" and must never be drawn as one. */
  const days: RegisterDay[] | null = attendance.error ? null : (attendance.data?.items ?? [])
  const fees: FamilyFees | null = ledger.error ? null : (ledger.data ?? null)

  /* WHO. This string goes on every cell below, without exception. `s.full_name`
     rather than the switcher's copy of the name deliberately: it is the name
     the summary endpoint answered with, so a cell can only ever be labelled
     with the child the figures in it are actually about. If the two ever
     disagreed, this is the one that is right. */
  const who = form(child) ? `${s.full_name} · ${form(child)}` : s.full_name

  return header(
    <>
      <Widget id="week" label={t('bento.parent_week.week_label')} size="large" index={0}>
        {(span) => <WeekCell span={span} who={who} s={s} days={days} to={toAttendance} />}
      </Widget>

      <Widget id="fees" label={t('bento.parent_week.fees_label')} size="small" index={1}>
        {(span) => <FeesCell span={span} who={who} s={s} fees={fees} to={toFees} />}
      </Widget>

      <Widget id="homework" label={t('bento.parent_week.homework_label')} size="small" index={2}>
        {(span) => <HomeworkCell span={span} who={who} s={s} to={toHomework} />}
      </Widget>

      <Widget id="absent" label={t('bento.parent_week.absent_label')} size="small" index={3}>
        {(span) => <AbsentCell span={span} who={who} s={s} days={days} to={toAttendance} />}
      </Widget>

      <Widget id="present" label={t('bento.parent_week.present_label')} size="small" index={4}>
        {(span) => <PresentCell span={span} who={who} s={s} days={days} to={toAttendance} />}
      </Widget>
    </>,
    true,
  )
}

/* ─── THE ANCHOR: attendance this year ────────────────────────────────────

   The register is a real series — one row per marked day, 120 days of them —
   so this cell is a TREND, and every point's denominator is that week's own
   marked days. A week the school marked nothing is left out rather than drawn
   as a collapse to nought, because nought would mean the child missed it.

   1x1  `Line` — the weekly rate, the shape only.
   2x1  `Area` — the same series with the ground under it, over more weeks,
        which is what the width buys.
   1x2  `Line`, and under it the real counts.
   2x2  `Area`, and beside it the FULL status breakdown of the register —
        present, late, absent, half day, leave — a partition whose parts sum
        back to the days marked. */
export function WeekCell({
  span, who, s, days, to,
}: {
  span: CellSpan
  who: string
  s: PortalSummary
  days: RegisterDay[] | null
  to?: string
}) {
  const t = useT()
  const { wide, tall } = useShape()

  const weeks = days ? weeklyRate(days, wide ? 16 : 8) : []
  const points = weeks.map((w) => w.pct)
  const statuses = days ? byStatus(days) : []
  const run = days ? runs(days) : { current: 0, longest: 0 }

  const facts = cut(
    [
      { label: t('bento.parent_week.fact_marked'), value: String(s.total_days) },
      { label: t('bento.parent_week.fact_present'), value: String(s.present_days) },
      { label: t('bento.parent_week.fact_absent'), value: String(s.absent_days) },
      weeks.length ? { label: t('bento.parent_week.fact_weeks'), value: String(weeks.length) } : null,
      days ? { label: t('bento.parent_week.fact_run'), value: String(run.current) } : null,
    ].filter((f): f is { label: string; value: string } => f !== null),
    tall ? 5 : 3,
  )

  const sr = t('bento.parent_week.trend_sr', { name: s.full_name, weeks: weeks.length })
  /* Said once. The note under the figure already carries this exact sentence
     when there is no register -- see the same fix on the days-absent and
     days-present cards. */
  const trend =
    days === null ? (
      <Say>{t('bento.parent_week.register_unread', { name: s.full_name })}</Say>
    ) : points.length < 2 ? (
      days.length === 0 ? null : <Say>{t('bento.parent_week.too_short')}</Say>
    ) : wide ? (
      <Area points={points} srLabel={sr} />
    ) : (
      <Line points={points} srLabel={sr} />
    )

  let drawing: ReactNode = trend
  if (wide && tall) {
    drawing = (
      <Split row>
        <Part grow={3}><Titled head={t('bento.parent_week.head_trend')}>{trend}</Titled></Part>
        <Part grow={2}>
          {statuses.length ? (
            <Titled head={t('bento.parent_week.head_statuses')}>
              <Rows items={cut(statuses, 5)} srLabel={t('bento.parent_week.statuses_sr', { name: s.full_name })} />
            </Titled>
          ) : (
            <Facts items={facts} srLabel={t('bento.parent_week.facts_sr', { name: s.full_name })} />
          )}
        </Part>
      </Split>
    )
  } else if (tall) {
    drawing = (
      <Split>
        <Part grow={3}><Titled head={t('bento.parent_week.head_trend')}>{trend}</Titled></Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.parent_week.facts_sr', { name: s.full_name })} /></Part>
      </Split>
    )
  } else if (wide) {
    drawing = <Titled head={t('bento.parent_week.head_trend')}>{trend}</Titled>
  }

  return (
    <PersonaCard
      span={span}
      title={t('bento.parent_week.week_label')}
      who={who}
      glyph="◷"
      value={s.total_days > 0 ? `${s.attendance_pct}%` : '—'}
      change={
        s.total_days > 0
          ? t('bento.parent_week.week_note', {
              name: s.full_name, present: s.present_days, total: s.total_days,
            })
          : t('bento.parent_week.no_register', { name: s.full_name })
      }
      to={to}
      cueLabel={t('bento.parent_week.week_cue')}
    >
      {drawing}
    </PersonaCard>
  )
}

/* ─── FEES — the one coloured cell ─────────────────────────────────────────

   The figure a parent came to act on, so it takes the single coloured ground
   on the page.

   BILLED IS A REAL WHOLE and it is the only one the money has: every
   non-cancelled invoice arrives with its own `net_paise` and `paid_paise`. If
   the ledger cannot be read, no ring is drawn — the outstanding figure alone
   has no denominator, and nothing here invents one.

   1x1  `Compare` — paid against still due, two tracks on one scale. Not a
        ring: `Gauge` is sized off the drawing row's WIDTH and a one-row cell
        would cut the bottom third of it off.
   2x1  the same, and the figures beside them.
   1x2  the height buys the ring: paid out of billed.
   2x2  the ring, and beside it the unpaid invoices ranked by what is left on
        each — one unit down the whole column.

   Money is paise throughout and only ever rendered through `formatPaise`. */
export function FeesCell({
  span, who, s, fees, to,
}: {
  span: CellSpan
  who: string
  s: PortalSummary
  fees: FamilyFees | null
  to?: string
}) {
  const t = useT()
  const { wide, tall } = useShape()

  const invoices = fees?.invoices ?? []
  const billed = invoices.reduce((a, i) => a + i.net_paise, 0)
  const paid = invoices.reduce((a, i) => a + i.paid_paise, 0)
  const due = fees ? fees.outstanding_paise : s.outstanding_paise
  const unpaid = invoices
    .filter((i) => i.due_paise > 0)
    .sort((a, b) => b.due_paise - a.due_paise)
    .map((i) => ({ label: i.invoice_no, value: i.due_paise }))
  const overdue = invoices.filter((i) => i.days_overdue > 0 && i.due_paise > 0).length

  const facts = cut(
    [
      fees ? { label: t('bento.parent_week.fact_billed'), value: formatPaise(billed) } : null,
      fees ? { label: t('bento.parent_week.fact_paid'), value: formatPaise(paid) } : null,
      { label: t('bento.parent_week.fact_owed'), value: formatPaise(due) },
      fees ? { label: t('bento.parent_week.fact_invoices'), value: `${unpaid.length}/${invoices.length}` } : null,
      fees && overdue > 0 ? { label: t('bento.parent_week.fact_overdue'), value: String(overdue) } : null,
    ].filter((f): f is { label: string; value: string } => f !== null),
    tall ? 5 : 3,
  )

  const sr = t('bento.parent_week.fees_sr', {
    name: s.full_name, paid: formatPaise(paid), billed: formatPaise(billed),
  })
  const tracks = billed > 0 ? (
    <Compare
      rows={[
        { label: t('bento.parent_week.track_paid'), value: paid },
        { label: t('bento.parent_week.track_due'), value: Math.max(0, billed - paid) },
      ]}
      formatValue={formatPaise}
      srLabel={sr}
    />
  ) : null
  const ring = billed > 0 ? <Gauge value={paid} total={billed} srLabel={sr} /> : null
  const noWhole = (
    <Say>
      {fees
        ? t('bento.parent_week.no_invoices', { name: s.full_name })
        : t('bento.parent_week.ledger_unread', { name: s.full_name })}
    </Say>
  )

  let drawing: ReactNode = tracks ?? noWhole
  if (wide && tall) {
    drawing = ring ? (
      <Split row>
        <Part grow={2}>{ring}</Part>
        <Part grow={3}>
          {unpaid.length ? (
            <Titled head={t('bento.parent_week.head_unpaid')}>
              <Rows items={cut(unpaid, 5)} formatValue={formatPaise} srLabel={t('bento.parent_week.unpaid_sr', { count: unpaid.length })} />
            </Titled>
          ) : (
            <Facts items={facts} srLabel={t('bento.parent_week.facts_sr', { name: s.full_name })} />
          )}
        </Part>
      </Split>
    ) : (
      <Split>
        <Part>{noWhole}</Part>
        <Part><Facts items={facts} srLabel={t('bento.parent_week.facts_sr', { name: s.full_name })} /></Part>
      </Split>
    )
  } else if (wide) {
    drawing = (
      <Split row>
        <Part grow={3}>{tracks ?? noWhole}</Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.parent_week.facts_sr', { name: s.full_name })} /></Part>
      </Split>
    )
  } else if (tall) {
    drawing = (
      <Split>
        <Part grow={3}>{ring ?? noWhole}</Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.parent_week.facts_sr', { name: s.full_name })} /></Part>
      </Split>
    )
  }

  return (
    <PersonaCard
      span={span}
      ground="finance"
      title={t('bento.parent_week.fees_label')}
      who={who}
      glyph="₹"
      value={formatPaise(due)}
      change={
        due > 0
          ? t('bento.parent_week.fees_owed', { name: s.full_name })
          : t('bento.parent_week.fees_settled', { name: s.full_name })
      }
      to={to}
      cueLabel={t('bento.parent_week.fees_cue')}
    >
      {drawing}
    </PersonaCard>
  )
}

/* ─── HOMEWORK DUE ────────────────────────────────────────────────────────

   NO DENOMINATOR EXISTS FOR THIS ONE and none is invented. The handler counts
   published homework still owed; there is no "set this term" in the response
   for it to be a share of, so there is no ring, no track and no percentage on
   this card at any size. What the count wants beside it is the other real
   figures — how soon, and which piece — which is what `Facts` draws.

   1x1  the count, the soonest date.
   2x1  + which piece it is.
   1x2  + how many days out it is, from the local calendar.
   2x2  + the next exam, the only other dated thing this payload carries. */
export function HomeworkCell({
  span, who, s, to,
}: {
  span: CellSpan
  who: string
  s: PortalSummary
  to?: string
}) {
  const t = useT()
  const { wide, tall } = useShape()
  const hwDays = s.next_homework_due ? daysUntil(s.next_homework_due) : undefined

  const all = [
    { label: t('bento.parent_week.fact_due'), value: String(s.homework_due) },
    s.next_homework_due ? { label: t('bento.parent_week.fact_soonest'), value: s.next_homework_due } : null,
    s.next_homework_title ? { label: t('bento.parent_week.fact_piece'), value: s.next_homework_title } : null,
    hwDays !== undefined
      ? {
          label: t('bento.parent_week.fact_in_days'),
          value: hwDays < 0
            ? t('bento.parent_week.days_late', { days: -hwDays })
            : t('bento.parent_week.days_out', { days: hwDays }),
        }
      : null,
    s.next_exam ? { label: t('bento.parent_week.fact_exam'), value: s.next_exam } : null,
  ].filter((f): f is { label: string; value: string } => f !== null)

  const lines = wide && tall ? 5 : tall ? 4 : wide ? 3 : 2

  return (
    <PersonaCard
      span={span}
      title={t('bento.parent_week.homework_label')}
      who={who}
      glyph="✎"
      value={s.homework_due}
      change={
        s.homework_due === 0
          ? t('bento.parent_week.homework_none', { name: s.full_name })
          : hwDays === undefined
            ? undefined
            : hwDays < 0
              ? t('bento.parent_week.homework_overdue', { days: -hwDays })
              : hwDays === 0
                ? t('bento.parent_week.homework_today')
                : t('bento.parent_week.homework_days', { days: hwDays })
      }
      to={to}
      cueLabel={t('bento.parent_week.homework_cue')}
    >
      {s.homework_due === 0 && all.length <= 1 ? (
        <Say>{t('bento.parent_week.homework_none', { name: s.full_name })}</Say>
      ) : (
        <Facts
          items={cut(all, lines)}
          srLabel={t('bento.parent_week.homework_sr', { name: s.full_name, count: s.homework_due })}
        />
      )}
    </PersonaCard>
  )
}

/* ─── DAYS ABSENT — the shape of the absence ──────────────────────────────

   Not a second proportion. The register makes it possible to ask WHEN the days
   were missed, which is the question a parent can act on, and neither drawing
   here needs a whole to be true: both are counts of real days.

   1x1  `Rows` — days missed by WEEKDAY. Only the weekdays the register
        actually uses are drawn; a school that never marks a Saturday should
        not be shown an empty Saturday.
   2x1  the same, and the counts beside them.
   1x2  the weekday spread, and under it the partition of the missed days by
        status — absent, late, half day, leave — which sums back to the figure.
   2x2  all three at once. */
export function AbsentCell({
  span, who, s, days, to,
}: {
  span: CellSpan
  who: string
  s: PortalSummary
  days: RegisterDay[] | null
  to?: string
}) {
  const t = useT()
  const { wide, tall } = useShape()

  const missed = days ? byWeekday(days, (d) => !IN_SCHOOL.has(d.status)) : []
  const missedTotal = missed.reduce((a, r) => a + r.value, 0)
  const kinds = days ? byStatus(days.filter((d) => !IN_SCHOOL.has(d.status))) : []
  const worst = missed.slice().sort((a, b) => b.value - a.value)[0]

  const facts = cut(
    [
      { label: t('bento.parent_week.fact_absent'), value: String(s.absent_days) },
      { label: t('bento.parent_week.fact_marked'), value: String(s.total_days) },
      days ? { label: t('bento.parent_week.fact_missed'), value: String(missedTotal) } : null,
      worst && worst.value > 0 ? { label: t('bento.parent_week.fact_worst_day'), value: `${worst.label} · ${worst.value}` } : null,
    ].filter((f): f is { label: string; value: string } => f !== null),
    tall ? 4 : 3,
  )

  /* Said once, not twice.

     The note under the figure already reads "No days have been marked for
     Vivaan Rao yet." when the register is empty -- and the body said exactly
     the same sentence again, four lines below it, in the same card. Two
     identical sentences stacked in one small box does not read as thorough, it
     reads as a bug, which is what it was.

     The note keeps it, because it sits with the figure it explains. The body
     stands empty, which is the honest shape of a card about a register nobody
     has marked. */
  const spread =
    days === null ? (
      <Say>{t('bento.parent_week.register_unread', { name: s.full_name })}</Say>
    ) : missedTotal === 0 ? (
      days.length === 0 ? null : (
        <Say>{t('bento.parent_week.never_missed', { name: s.full_name })}</Say>
      )
    ) : (
      <Titled head={t('bento.parent_week.head_weekday')}>
        <Rows
          items={missed}
          srLabel={t('bento.parent_week.weekday_sr', { name: s.full_name, count: missedTotal })}
        />
      </Titled>
    )

  const byKind = kinds.length ? (
    <Titled head={t('bento.parent_week.head_kinds')}>
      <Rows items={cut(kinds, 4)} srLabel={t('bento.parent_week.kinds_sr', { name: s.full_name })} />
    </Titled>
  ) : (
    <Facts items={facts} srLabel={t('bento.parent_week.facts_sr', { name: s.full_name })} />
  )

  let drawing: ReactNode = spread
  if (wide && tall) {
    drawing = (
      <Split row>
        <Part grow={3}>{spread}</Part>
        <Part grow={2}>
          <Split>
            <Part grow={3}>{byKind}</Part>
            <Part grow={2}><Facts items={cut(facts, 2)} srLabel={t('bento.parent_week.facts_sr', { name: s.full_name })} /></Part>
          </Split>
        </Part>
      </Split>
    )
  } else if (wide) {
    drawing = (
      <Split row>
        <Part grow={3}>{spread}</Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.parent_week.facts_sr', { name: s.full_name })} /></Part>
      </Split>
    )
  } else if (tall) {
    drawing = (
      <Split>
        <Part grow={3}>{spread}</Part>
        <Part grow={2}>{byKind}</Part>
      </Split>
    )
  }

  return (
    <PersonaCard
      span={span}
      title={t('bento.parent_week.absent_label')}
      who={who}
      glyph="○"
      value={s.absent_days}
      change={
        s.total_days > 0
          ? t('bento.parent_week.absent_note', { name: s.full_name, total: s.total_days })
          : t('bento.parent_week.no_register', { name: s.full_name })
      }
      to={to}
      cueLabel={t('bento.parent_week.absent_cue')}
    >
      {drawing}
    </PersonaCard>
  )
}

/* ─── DAYS PRESENT — the proportion ───────────────────────────────────────

   The one cell on this board that is a share, and its denominator is real:
   `total_days` is the days the register carries, counted by the handler in the
   same query as `present_days`.

   1x1  `Compare` — in school against everything else, two tracks on one scale.
   2x1  the same, and the counts beside them.
   1x2  the height buys the ring, over the counts.
   2x2  the ring, and beside it the days present MONTH BY MONTH — a real count
        per month off the register, months the school marked nothing left off
        the axis rather than drawn as nought.

   No cue of its own beyond the register, which is where all three attendance
   cells already point. */
export function PresentCell({
  span, who, s, days, to,
}: {
  span: CellSpan
  who: string
  s: PortalSummary
  days: RegisterDay[] | null
  to?: string
}) {
  const t = useT()
  const { wide, tall } = useShape()

  const other = Math.max(0, s.total_days - s.present_days)
  const months = days ? byMonth(days, (d) => IN_SCHOOL.has(d.status), tall ? 6 : 4) : []
  const run = days ? runs(days) : { current: 0, longest: 0 }

  const facts = cut(
    [
      { label: t('bento.parent_week.fact_present'), value: String(s.present_days) },
      { label: t('bento.parent_week.fact_marked'), value: String(s.total_days) },
      days ? { label: t('bento.parent_week.fact_run'), value: String(run.current) } : null,
      days ? { label: t('bento.parent_week.fact_longest'), value: String(run.longest) } : null,
    ].filter((f): f is { label: string; value: string } => f !== null),
    tall ? 4 : 3,
  )

  const sr = t('bento.parent_week.absent_sr', {
    name: s.full_name, present: s.present_days, total: s.total_days,
  })
  const tracks = (
    <Compare
      rows={[
        { label: t('bento.parent_week.track_in'), value: s.present_days },
        { label: t('bento.parent_week.track_out'), value: other },
      ]}
      srLabel={sr}
    />
  )
  const ring = <Gauge value={s.present_days} total={s.total_days} srLabel={sr} />

  let drawing: ReactNode = tracks
  if (wide && tall) {
    drawing = (
      <Split row>
        <Part grow={2}>{ring}</Part>
        <Part grow={3}>
          {months.length ? (
            <Titled head={t('bento.parent_week.head_months')}>
              <Rows items={months} srLabel={t('bento.parent_week.months_sr', { name: s.full_name })} />
            </Titled>
          ) : (
            <Facts items={facts} srLabel={t('bento.parent_week.facts_sr', { name: s.full_name })} />
          )}
        </Part>
      </Split>
    )
  } else if (wide) {
    drawing = (
      <Split row>
        <Part grow={3}>{tracks}</Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.parent_week.facts_sr', { name: s.full_name })} /></Part>
      </Split>
    )
  } else if (tall) {
    drawing = (
      <Split>
        <Part grow={3}>{ring}</Part>
        <Part grow={2}><Facts items={facts} srLabel={t('bento.parent_week.facts_sr', { name: s.full_name })} /></Part>
      </Split>
    )
  }

  return (
    <PersonaCard
      span={span}
      title={t('bento.parent_week.present_label')}
      who={who}
      glyph="●"
      value={s.present_days}
      change={
        s.total_days > 0
          ? t('bento.parent_week.present_note', { name: s.full_name })
          : t('bento.parent_week.no_register', { name: s.full_name })
      }
      to={to}
      cueLabel={t('bento.parent_week.week_cue')}
    >
      {/* Empty rather than an echo: `change` above already carries this exact
          sentence when there is no register. See the note on `spread` in the
          days-absent card. */}
      {s.total_days > 0 ? drawing : null}
    </PersonaCard>
  )
}
