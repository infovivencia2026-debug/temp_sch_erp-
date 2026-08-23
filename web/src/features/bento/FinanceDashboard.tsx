import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { cn, formatPaise } from '@/lib/utils'
import { useWidgetSize } from '@/lib/widget-size'
import {
  BentoError,
  BentoLoading,
  BentoPage,
  Cell,
  type CellSpan,
  Cue,
  useFeatureHref,
} from './bento-kit'
import {
  CardShell,
  Compare,
  Distribution,
  Gauge,
  Rows,
  Scale,
} from './bento-cards'
import { Widget, WidgetLayer } from './WidgetLayer'

/* THE FINANCE PAGE, IN THE EDITORIAL CARD LANGUAGE.

   Every cell on this board is `CardShell` — header, figure, drawing — with
   the drawing in the row that takes ALL the remaining height, and every
   drawing is one of the twelve in `bento-cards.tsx`. See
   docs/BENTO_CARD_PATTERNS.md: that file is the contract, this is an
   application of it. Nothing here names a colour; every mark is
   `currentColor`, which is what keeps the anchor's inverted ink legible.

   The same two endpoints as `web/src/features/finance/Dashboard.tsx` —
   /finance/dashboard and /finance/invoices?overdue=true — and no others.

   ─── WHAT THIS RESPONSE ACTUALLY CARRIES ─────────────────────────────────

   Read from internal/api/role_backoffice.go, not from the interface below.

   `today_paise`   receipts dated today.
   `month_paise`   receipts inside the resolved range, whatever range it is.
   `outstanding_paise`  sum(net - paid) over EVERY unpaid invoice of EVERY
                   year. A level, as of today, not a period figure.
   `overdue_paise` the same sum with one extra predicate — `due_on < today`.
   `range`         the resolved from/to and its label.
   plus four counts, and the overdue invoice list, capped at 300 rows.

   ─── WHAT IT DOES NOT CARRY ──────────────────────────────────────────────

   THERE IS NO BILLED TOTAL AND NO TARGET. Not on this handler, not anywhere
   in this product's finance data. So there is no "target progress" and no
   "% collected" anywhere on this board.

   This card used to headline a percentage against
   `expected = month_paise + outstanding_paise` — a period's RECEIPTS added to
   an all-years BALANCE, captioned "of X billed" when nobody had computed a
   billed total. That derivation is gone and nothing below reintroduces it.

   THERE IS NO TIME SERIES. One figure for today, one for the range, and no
   day-by-day breakdown of either — so no `Line`, no `Area`, no `Stack` and no
   `Bars` of days appears on this page. The two real time axes this response
   does have are drawn instead: where today sits inside the resolved range
   (`Scale`), and how far past its due date each overdue invoice is
   (`Distribution` / `Rows`).

   ─── THE PROPORTIONS THAT ARE REAL ───────────────────────────────────────

   1. `overdue_paise / outstanding_paise`. Both are the same
      `sum(net - paid)` over the same rows at the same instant, one with an
      extra predicate on the due date. A strict subset of the same measure —
      the ONE honest denominator on this response, and the only `Gauge` here.

   2. AGEING from `due_on`, out of the overdue list. Exact while the list is
      short; the list is capped at 300 rows server-side, and when it comes
      back full the cell prints how much of the overdue money the bands
      actually cover.

   3. `today_paise` within `month_paise`, but ONLY when today is inside the
      resolved range — the guard is built from LOCAL calendar parts, never
      `toISOString`, which is UTC and moves the check a day east of Greenwich.

   ─── SIZES ───────────────────────────────────────────────────────────────

   Every cell reads `useWidgetSize` and each size draws strictly more than the
   one below it. `wide` and `tall` are tested separately, never multiplied
   into an area: 2x1 has the width a labelled row needs and no height for four
   of them, 1x2 has the reverse. */

const CAP = 300

interface FinanceKPIs {
  today_paise: number
  month_paise: number
  outstanding_paise: number
  overdue_paise: number
  defaulters: number
  invoices: number
  unreconciled: number
  refunds_pending: number
  range: { period: string; from: string; to: string; label: string }
  as_of_now: string[]
}
interface InvoiceRow {
  id: string
  invoice_no: string
  student_name: string
  admission_no: string
  issued_on: string
  due_on?: string
  net_paise: number
  paid_paise: number
  due_paise: number
  status: string
}

type CellStatus = 'loading' | 'error' | 'ready'

const DAY_MS = 86_400_000

/** A `YYYY-MM-DD` from the server as LOCAL midnight.

    Not `Date.parse`, which reads a bare date as UTC: subtracting a UTC
    midnight from a local one puts the difference out by the offset and rounds
    a day the wrong way for half the world. */
function localMidnight(iso: string | undefined): number | null {
  if (!iso) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isFinite(d.getTime()) ? d.getTime() : null
}

/** Local midnight today, for the same reason. */
function todayMidnight(): number {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Whole days between two local midnights. Rounded rather than floored so a
    daylight-saving boundary does not shift an invoice into the next bucket. */
const daysBetween = (from: number, to: number) => Math.round((to - from) / DAY_MS)

/** "01 Aug", built from the local midnight above rather than `new Date(iso)`,
    which would be the UTC instant and can print yesterday. */
function shortDate(iso: string): string {
  const ms = localMidnight(iso)
  if (ms === null) return '—'
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' }).format(new Date(ms))
}

/** The four standard receivable buckets, in days past due. `?overdue=true` is
    `due_on IS NOT NULL AND due_on < CURRENT_DATE` server-side, so every row is
    at least one day past due and there is no "not yet due" bucket — that money
    is the complement on the KPI response, not in this list. */
const BUCKET_MAX = [30, 60, 90, Infinity]

interface Ageing {
  paise: number[]
  count: number[]
  /** What the listed rows add up to. Equal to `overdue_paise` while the list
      is short; less than it once the server's cap has bitten. */
  listedPaise: number
  listedCount: number
  oldestDays: number
  largest: InvoiceRow | null
  /** The listed rows, largest first, with their age. */
  ranked: { id: string; who: string; paise: number; days: number }[]
}

/** The buckets, in paise AND in invoices, from rows the API already returned.

    A row without a readable due date is skipped rather than bucketed: it
    cannot occur under the endpoint's own predicate, and if it ever did,
    guessing an age for it would put real money in a bucket it does not belong
    to. */
function ageing(items: InvoiceRow[]): Ageing {
  const now = todayMidnight()
  const paise = [0, 0, 0, 0]
  const count = [0, 0, 0, 0]
  const ranked: Ageing['ranked'] = []
  let listedPaise = 0
  let oldestDays = 0
  let largest: InvoiceRow | null = null

  for (const i of items) {
    const due = localMidnight(i.due_on)
    if (due === null) continue
    const days = daysBetween(due, now)
    const b = BUCKET_MAX.findIndex((max) => days <= max)
    const at = b === -1 ? BUCKET_MAX.length - 1 : b
    paise[at] += i.due_paise
    count[at] += 1
    listedPaise += i.due_paise
    if (days > oldestDays) oldestDays = days
    if (!largest || i.due_paise > largest.due_paise) largest = i
    ranked.push({ id: i.id, who: i.admission_no || i.invoice_no, paise: i.due_paise, days })
  }
  ranked.sort((a, b) => b.paise - a.paise || a.days - b.days)
  return { paise, count, listedPaise, listedCount: ranked.length, oldestDays, largest, ranked }
}

/** Where today sits inside the resolved range, or null when it is outside it.

    THE GUARD THE WHOLE `today` CELL HANGS ON. Built from local calendar parts
    on both sides: the range is the school's own day, and a UTC comparison
    would call an evening in Kolkata "yesterday" and quietly drop the one
    honest comparison on that card. */
function positionInRange(range: FinanceKPIs['range']): { day: number; span: number } | null {
  const from = localMidnight(range?.from)
  const to = localMidnight(range?.to)
  if (from === null || to === null) return null
  const now = todayMidnight()
  if (now < from || now > to) return null
  return { day: daysBetween(from, now) + 1, span: daysBetween(from, to) + 1 }
}

// --- the shell ----------------------------------------------------------

/** A cell: the kit's ground and cue wrapped around the pattern file's shell.

    THE HEIGHT BUDGET IS THE WHOLE DESIGN OF THIS FUNCTION. A one-row cell is
    172px, and a 38px figure, a second header line and a 34px pill leave the
    drawing row about fifteen pixels — which IS the "label, number, empty
    space" this board was rebuilt to stop being. So on a one-row cell the
    figure is set to 26px through `--bento-fig` (the shell reads that token),
    the second header line is dropped, and the cue is the compact pill. The
    drawing row gets the difference, which is most of it.

    At 1x1 there is no cue at all: 232 usable pixels do not hold a pill and a
    drawing, and the drawing is the thing that was missing. */
function Card({
  span, dark, title, sub, glyph, value, change, to, cue, children,
}: {
  span: CellSpan
  dark?: boolean
  title: string
  sub?: string
  glyph?: ReactNode
  value: ReactNode
  change?: ReactNode
  to?: string
  cue?: string
  children?: ReactNode
}) {
  const { w, h } = useWidgetSize()
  const tall = h >= 2
  const room = w >= 2 || tall
  return (
    <Cell
      span={span}
      dark={dark}
      className={tall ? undefined : '[--bento-fig:26px]'}
    >
      <CardShell
        className="min-h-0 flex-1"
        title={title}
        sub={tall ? sub : undefined}
        glyph={glyph}
        value={value}
        change={change}
      >
        {children}
      </CardShell>
      {room && to && cue && (
        <div className={cn('shrink-0', tall ? 'mt-2' : 'mt-1.5 [&_a]:px-2.5 [&_a]:py-1 [&_a]:text-[11px]')}>
          <Cue to={to} label={cue} dark={dark} />
        </div>
      )}
    </Cell>
  )
}

/** The gauge, kept square by its HEIGHT rather than by its width.

    `Gauge` is a circle at 78% of its container's width. In a row-one cell the
    container is five times wider than it is tall, so the circle is drawn
    taller than the card and clipped through the middle. Wrapping it in a box
    whose width comes from the row's height makes the circle fit whatever room
    the row actually has, at every size, with no branch. */
function GaugeBox({ value, total, srLabel }: { value: number; total: number; srLabel: string }) {
  return (
    <div className="grid h-full min-h-0 place-items-center">
      <div className="grid aspect-square h-full max-h-full place-items-center">
        <Gauge value={value} total={total} srLabel={srLabel} />
      </div>
    </div>
  )
}

/** Two drawings sharing the row. `min-h-0`/`min-w-0` on both halves is what
    keeps a drawing that wants to be `h-full` from pushing the card open. */
function Split({ row, children }: { row?: boolean; children: ReactNode }) {
  return (
    <div className={cn('flex h-full min-h-0 min-w-0 gap-3', row ? 'flex-row' : 'flex-col')}>
      {children}
    </div>
  )
}
function Part({ grow = 1, children }: { grow?: number; children: ReactNode }) {
  return (
    <div className="min-h-0 min-w-0 overflow-hidden" style={{ flex: `${grow} 1 0%` }}>
      {children}
    </div>
  )
}

/** A caption above a drawing, at the sizes with room for one. */
function Head({ children }: { children: ReactNode }) {
  return (
    <p className="mb-1 truncate text-[8.5px] font-semibold uppercase leading-none tracking-[0.1em] opacity-55">
      {children}
    </p>
  )
}

/** A titled drawing that keeps the title out of the drawing's own height. */
function Titled({ head, children }: { head: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <Head>{head}</Head>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}

/** A short sentence in the drawing row — the state a drawing must not be
    drawn in. Never a zero: "we could not ask" and "there is none" are
    different sentences and are printed as different sentences. */
function Say({ children }: { children: ReactNode }) {
  return <p className="text-[10px] leading-snug opacity-70">{children}</p>
}

// --- the cells ----------------------------------------------------------

/** THE ANCHOR — what came in, what is still owed, and how old the rest is.

    figure  receipts in the resolved range.
    1x1     `Compare` — not yet due against overdue. One scale, two labelled
            tracks, both money, and their sum is `outstanding_paise` exactly.
    2x1     + `Distribution` of the four ageing buckets beside it: the width a
            curve needs, which four labelled rails cannot have here.
    1x2     + the buckets as `Rows` instead — the height four labelled rails
            do have, and each prints its own money.
    2x2     + `Scale`: where today sits in the resolved range, the only
            elapsed-time axis this response carries for the figure.

    NO PROGRESS FIGURE. There is no billed total and no target on this
    handler, so the receipts figure is stated and no relationship is claimed
    between it and the balance below it. */
function CollectionCell({
  span, k, rows, ageStatus, href,
}: {
  span: CellSpan
  k: FinanceKPIs
  rows: InvoiceRow[]
  ageStatus: CellStatus
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2
  const roomy = wide && tall

  const notYetDue = Math.max(0, k.outstanding_paise - k.overdue_paise)
  const overduePct = k.outstanding_paise > 0
    ? Math.round((k.overdue_paise / k.outstanding_paise) * 100)
    : 0

  const a = ageing(rows)
  const pos = positionInRange(k.range)
  const capped = rows.length >= CAP
  const bandLabels = [
    t('bento.finance.age_1'), t('bento.finance.age_2'),
    t('bento.finance.age_3'), t('bento.finance.age_4'),
  ]

  const split = (
    <Compare
      rows={[
        { label: t('bento.finance.not_yet_due'), value: notYetDue },
        { label: t('bento.finance.overdue'), value: k.overdue_paise },
      ]}
      formatValue={formatPaise}
      srLabel={t('bento.finance.decomp_sr')}
    />
  )

  /* The ageing, in whatever state the invoice list is in. The receipts and
     the balance above it are KPI figures and stay true whatever the list did,
     so a failed list narrows this section rather than the card. */
  const ageingPart = (shape: 'rows' | 'dist') => {
    if (ageStatus === 'error') return <Say>{t('bento.finance.ageing_failed')}</Say>
    if (ageStatus === 'loading') return <Say>{t('bento.finance.ageing_loading')}</Say>
    if (a.listedCount === 0) return <Say>{t('bento.finance.ageing_none')}</Say>
    return (
      <Titled head={t('bento.finance.ageing')}>
        {shape === 'rows' ? (
          <Rows
            items={bandLabels.map((label, i) => ({ label, value: a.paise[i] }))}
            formatValue={formatPaise}
            srLabel={t('bento.finance.ageing_sr')}
          />
        ) : (
          <Distribution values={a.paise} srLabel={t('bento.finance.ageing_sr')} />
        )}
      </Titled>
    )
  }

  let drawing: ReactNode = split
  if (roomy) {
    drawing = (
      <Split>
        <Part grow={2}>
          <Split row>
            <Part>{split}</Part>
            <Part>{ageingPart('rows')}</Part>
          </Split>
        </Part>
        {pos && (
          <Part grow={1}>
            <Titled
              head={t('bento.finance.today_position', {
                day: pos.day, span: pos.span, label: k.range.label,
              })}
            >
              <Scale
                value={pos.day}
                min={1}
                max={pos.span}
                srLabel={t('bento.finance.period_track_sr', {
                  label: k.range.label,
                  from: shortDate(k.range.from),
                  to: shortDate(k.range.to),
                })}
              />
            </Titled>
          </Part>
        )}
      </Split>
    )
  } else if (wide) {
    drawing = (
      <Split row>
        <Part>{split}</Part>
        <Part>{ageingPart('dist')}</Part>
      </Split>
    )
  } else if (tall) {
    drawing = (
      <Split>
        <Part>{split}</Part>
        <Part grow={2}>{ageingPart('rows')}</Part>
      </Split>
    )
  }

  const change = [
    t('bento.finance.outstanding_split', {
      outstanding: formatPaise(k.outstanding_paise), pct: overduePct,
    }),
    roomy && ageStatus === 'ready' && capped
      ? t('bento.finance.ageing_capped', {
          covered: formatPaise(a.listedPaise), total: formatPaise(k.overdue_paise),
        })
      : '',
  ].filter(Boolean).join(' ')

  return (
    <Card
      span={span}
      dark
      title={t('bento.finance.collected_in', { label: k.range.label })}
      sub={roomy ? t('bento.finance.no_target_sub') : undefined}
      glyph="₹"
      value={formatPaise(k.month_paise)}
      change={change}
      to={href}
      cue={t('bento.finance.cue_overdue')}
    >
      {drawing}
    </Card>
  )
}

/** COLLECTED TODAY.

    1x1  `Scale` — which day of the resolved range today is.
    2x1  `Compare` — today against the rest of the range's receipts. One
         decomposition of one total, not two figures side by side.
    1x2  `Scale` over `Compare`.
    2x2  `Scale` over `Rows`: today, the mean per elapsed day, and the range
         total — one unit, three real figures off this response.

    EVERY ONE OF THOSE COMPARISONS IS GUARDED. `month_paise` is the resolved
    range's total, and today's receipts are part of it only when today is
    inside that range. When the range is last month the cell keeps the figure
    and drops every comparison, saying which it did — no drawing at all rather
    than a drawing against a denominator today is not inside. */
function TodayCell({ span, k, href }: { span: CellSpan; k: FinanceKPIs; href?: string }) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2
  const roomy = wide && tall

  const pos = positionInRange(k.range)
  const rest = pos ? Math.max(0, k.month_paise - k.today_paise) : 0
  /* The mean per ELAPSED day, not per day of the range. Payments cannot be
     dated in the future, so the range total covers exactly `pos.day` days and
     dividing by the whole span would understate every day of a range that is
     still running. Money divided by a count of days is still money. */
  const perDay = pos && pos.day > 0 ? Math.round(k.month_paise / pos.day) : 0

  const scaleOnly = pos ? (
    <Scale
      value={pos.day}
      min={1}
      max={pos.span}
      srLabel={t('bento.finance.period_track_sr', {
        label: k.range.label, from: shortDate(k.range.from), to: shortDate(k.range.to),
      })}
    />
  ) : null

  const scale = pos ? (
    <Titled head={t('bento.finance.today_position', {
      day: pos.day, span: pos.span, label: k.range.label,
    })}>
      {scaleOnly}
    </Titled>
  ) : null

  const compare = pos && k.month_paise > 0 ? (
    <Compare
      rows={[
        { label: t('bento.finance.today_part'), value: k.today_paise },
        { label: t('bento.finance.period_part'), value: rest },
      ]}
      formatValue={formatPaise}
      srLabel={t('bento.finance.today_sr', { label: k.range.label })}
    />
  ) : null

  const ranked = pos ? (
    <Rows
      items={[
        { label: t('bento.finance.today_part'), value: k.today_paise },
        { label: t('bento.finance.per_day_short'), value: perDay },
        { label: k.range.label, value: k.month_paise },
      ]}
      formatValue={formatPaise}
      srLabel={t('bento.finance.today_rows_sr', { label: k.range.label })}
    />
  ) : null

  let drawing: ReactNode
  if (!pos) {
    drawing = <Say>{t('bento.finance.today_outside', { label: k.range.label })}</Say>
  } else if (roomy) {
    drawing = (
      <Split>
        <Part>{scale}</Part>
        <Part grow={2}>{ranked}</Part>
      </Split>
    )
  } else if (wide) {
    drawing = compare ?? scaleOnly
  } else if (tall) {
    drawing = (
      <Split>
        <Part>{scale}</Part>
        <Part grow={2}>{compare}</Part>
      </Split>
    )
  } else {
    drawing = scaleOnly
  }

  const change = !pos
    ? t('bento.finance.today_day_none', { label: k.range.label })
    : roomy
      ? t('bento.finance.per_day', { amount: formatPaise(perDay), label: k.range.label })
      : wide
        ? t('bento.finance.today_of_period', {
            amount: formatPaise(k.month_paise), label: k.range.label,
          })
        : t('bento.finance.today_day_of', { day: pos.day, span: pos.span })

  return (
    <Card
      span={span}
      title={t('bento.finance.today')}
      sub={k.range.label}
      glyph="₹"
      value={formatPaise(k.today_paise)}
      change={change}
      to={href}
      cue={t('bento.finance.cue_collect')}
    >
      {drawing}
    </Card>
  )
}

/** WHAT IS STILL OWED.

    THE ONE REAL DENOMINATOR ON THIS RESPONSE. `overdue_paise` is the same
    `sum(net - paid)` as `outstanding_paise` with one extra predicate on the
    due date, so the overdue money is a strict part of the outstanding money
    and both are levels as of today. That is the only `Gauge` on this board.

    1x1  `Gauge` — the overdue share.
    2x1  + `Distribution` of the four ageing buckets beside it.
    1x2  + the buckets as `Rows`, each printing its own money.
    2x2  + the largest listed invoices as a dense ranked `Rows`, one row per
         invoice with the admission number and what is still due on it.

    The bands and the ranking come from the overdue list, which the server
    caps at 300 rows; where that cap can change what is being read, the cell
    says what the figure covers. The balance and the gauge come from the KPI
    response and are right whatever the list did. */
function OutstandingCell({
  span, k, rows, ageStatus, href,
}: {
  span: CellSpan
  k: FinanceKPIs
  rows: InvoiceRow[]
  ageStatus: CellStatus
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2
  const roomy = wide && tall

  const a = ageing(rows)
  const capped = rows.length >= CAP
  const bandLabels = [
    t('bento.finance.age_1'), t('bento.finance.age_2'),
    t('bento.finance.age_3'), t('bento.finance.age_4'),
  ]

  const gauge = (
    <GaugeBox
      value={k.overdue_paise}
      total={k.outstanding_paise}
      srLabel={t('bento.finance.overdue_sr')}
    />
  )

  const bands = (shape: 'rows' | 'dist') => {
    if (ageStatus === 'error') return <Say>{t('bento.finance.ageing_failed')}</Say>
    if (ageStatus === 'loading') return <Say>{t('bento.finance.ageing_loading')}</Say>
    if (a.listedCount === 0) return <Say>{t('bento.finance.ageing_none')}</Say>
    return (
      <Titled head={t('bento.finance.ageing')}>
        {shape === 'rows' ? (
          <Rows
            items={bandLabels.map((label, i) => ({ label, value: a.paise[i] }))}
            formatValue={formatPaise}
            srLabel={t('bento.finance.ageing_sr')}
          />
        ) : (
          <Distribution values={a.paise} srLabel={t('bento.finance.ageing_sr')} />
        )}
      </Titled>
    )
  }

  /* THE RANKED LIST IS LARGEST FIRST, AND SAYS SO. The list arrives
     newest-issued first, which is not the order anybody chases in; cutting it
     in that order would keep the recent small ones and drop the old large
     ones, which is the one truncation that changes the answer. `a.ranked` is
     already sorted by amount.

     Six rows, not forty-eight: a `Rows` is a label, a track and a printed
     rupee figure, and forty-eight of those in 150 pixels is three pixels a
     row. How many of how many is printed above them. */
  const TOP = 6
  const top = a.ranked.slice(0, TOP)
  const ranked = ageStatus === 'ready' && top.length > 0 ? (
    <Titled head={t('bento.finance.ranked_title', { n: top.length, total: a.listedCount })}>
      <Rows
        items={top.map((i) => ({ label: i.who, value: i.paise }))}
        formatValue={formatPaise}
        srLabel={t('bento.finance.ranked_sr', { n: top.length })}
      />
    </Titled>
  ) : null

  let drawing: ReactNode = gauge
  if (roomy) {
    drawing = (
      <Split>
        <Part>
          <Split row>
            <Part>{gauge}</Part>
            <Part grow={2}>{bands('rows')}</Part>
          </Split>
        </Part>
        {ranked && <Part grow={1}>{ranked}</Part>}
      </Split>
    )
  } else if (wide) {
    drawing = (
      <Split row>
        <Part>{gauge}</Part>
        <Part grow={2}>{bands('dist')}</Part>
      </Split>
    )
  } else if (tall) {
    drawing = (
      <Split>
        <Part>{gauge}</Part>
        <Part grow={1}>{bands('rows')}</Part>
      </Split>
    )
  }

  let change = t('bento.finance.overdue_note', { amount: formatPaise(k.overdue_paise) })
  if (ageStatus === 'error') {
    change = t('bento.finance.overdue_ageing_failed', { amount: formatPaise(k.overdue_paise) })
  } else if (ageStatus === 'loading') {
    change = t('bento.finance.overdue_note_loading', { amount: formatPaise(k.overdue_paise) })
  } else if (a.listedCount > 0) {
    const parts = [change, t('bento.finance.oldest_overdue', { days: a.oldestDays })]
    if (capped && tall) {
      parts.push(t('bento.finance.ageing_capped', {
        covered: formatPaise(a.listedPaise), total: formatPaise(k.overdue_paise),
      }))
    }
    change = parts.join(' ')
  }

  return (
    <Card
      span={span}
      title={t('bento.finance.outstanding')}
      sub={t('bento.finance.as_of_today')}
      glyph="₹"
      value={formatPaise(k.outstanding_paise)}
      change={change}
      to={href}
      cue={t('bento.finance.cue_ledger')}
    >
      {drawing}
    </Card>
  )
}

/** THE FOUR OPEN-ITEM COUNTS.

    NO DENOMINATOR EXISTS FOR ANY OF THEM. There is no student population to
    put the defaulters over, no payment total to put the unreconciled over, no
    refund total to put the pending ones over, and the invoice count is every
    invoice ever raised with no comparable subset in the same payload. So none
    of them draws a gauge, a meter or a share.

    What they draw is the COUNT ITSELF, as `Density` — one dot per open item,
    up to a ceiling the caption names. A dot grid of nineteen refunds is a
    picture of nineteen things, not of nineteen out of anything, which is
    exactly what these figures are. Above the ceiling the grid would be a
    picture of the ceiling, so the caption says how many of how many are drawn.

    The room a bigger cell has is spent on the grid getting wider — more dots
    drawn before the ceiling bites — and on the caption becoming a sentence.
    Hierarchy, not an invented chart. */
const DOT_CAP = { small: 60, wide: 120, roomy: 240 }

function CountCell({
  span, title, sub, value, note, href, cue,
}: {
  span: CellSpan
  title: string
  sub: string
  value: number
  note: string
  href?: string
  cue: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2
  const roomy = wide && tall

  const ceiling = roomy ? DOT_CAP.roomy : wide || tall ? DOT_CAP.wide : DOT_CAP.small
  const n = Math.max(0, Math.floor(value))
  const shown = Math.min(n, ceiling)

  /* Was a dot per unit, capped — up to sixty identical marks that restated the
     figure printed above them and nothing else. The note is a real sentence
     about this number and it was already being fetched; it earns the row. */
  const drawing = n === 0 ? (
    <Say>{t('bento.finance.count_none')}</Say>
  ) : (
    <div className="flex h-full min-h-0 flex-col justify-end gap-1">
      {shown < n && (wide || tall) && (
        <Head>{t('bento.finance.dots_capped', { shown, total: n })}</Head>
      )}
      <Say>{note}</Say>
    </div>
  )

  return (
    <Card
      span={span}
      title={title}
      sub={sub}
      glyph="•"
      value={n}
      change={roomy ? `${note}. ${t('bento.finance.no_share')}` : note}
      to={href}
      cue={cue}
    >
      {drawing}
    </Card>
  )
}

export default function BentoFinanceDashboard() {
  const t = useT()

  const kpis = useQuery({
    queryKey: ['bento-finance-dashboard'],
    queryFn: () => api.get<FinanceKPIs>('/api/v1/finance/dashboard'),
  })
  const overdue = useQuery({
    queryKey: ['finance-invoices-overdue'],
    queryFn: () => api.get<List<InvoiceRow>>('/api/v1/finance/invoices?overdue=true'),
  })

  const collectHref = useFeatureHref('finance.collections.collect_payment')
  const receiptsHref = useFeatureHref('finance.collections.receipts')
  const defaultersHref = useFeatureHref('finance.student_dues.defaulters_reminders')
  const ledgerHref = useFeatureHref('finance.student_dues.student_ledger')
  const reconciliationHref = useFeatureHref('finance.reconciliation.reconciliation')
  const refundsHref = useFeatureHref('finance.concessions_refunds.refunds')
  const invoicesHref = useFeatureHref('finance.fee_structure.demand_invoice_generation')

  if (kpis.isLoading) return <BentoLoading message={t('bento.finance.loading')} />
  // Never a zero that is really a failed fetch. On a finance dashboard that is
  // the most expensive kind of wrong.
  if (kpis.error) return <BentoError message={t('bento.finance.failed')} />

  const k = kpis.data!
  const rows = overdue.data?.items ?? []
  // The invoice list's three states, kept apart wherever it is drawn: a cell
  // that turned a failed fetch into an empty chart would be saying "nothing is
  // overdue", which is the one sentence on this page nobody may guess at.
  const ageStatus: CellStatus = overdue.error ? 'error' : overdue.isLoading ? 'loading' : 'ready'

  return (
    <BentoPage eyebrow={t('bento.finance.eyebrow')} title={t('bento.finance.title')}>
      <WidgetLayer dashboard="finance">
      {/* THE ANCHOR — dark, and the only dark cell on the page. */}
      <Widget id="collection" label={t('bento.finance.anchor_label')} size="large" index={0}>
        {(span) => (
          <CollectionCell span={span} k={k} rows={rows} ageStatus={ageStatus} href={defaultersHref} />
        )}
      </Widget>

      <Widget id="today" label={t('bento.finance.today')} size="small" index={1}>
        {(span) => <TodayCell span={span} k={k} href={collectHref ?? receiptsHref} />}
      </Widget>

      <Widget id="outstanding" label={t('bento.finance.outstanding')} size="small" index={2}>
        {(span) => (
          <OutstandingCell span={span} k={k} rows={rows} ageStatus={ageStatus} href={ledgerHref} />
        )}
      </Widget>

      <Widget id="defaulters" label={t('bento.finance.defaulters')} size="small" index={3}>
        {(span) => (
          <CountCell
            span={span}
            title={t('bento.finance.defaulters')}
            sub={t('bento.finance.as_of_today')}
            value={k.defaulters}
            note={t('bento.finance.defaulters_note')}
            href={defaultersHref}
            cue={t('bento.finance.cue_defaulters')}
          />
        )}
      </Widget>

      <Widget id="unreconciled" label={t('bento.finance.unreconciled')} size="small" index={4}>
        {(span) => (
          <CountCell
            span={span}
            title={t('bento.finance.unreconciled')}
            sub={t('bento.finance.as_of_today')}
            value={k.unreconciled}
            note={t('bento.finance.unreconciled_note')}
            href={reconciliationHref}
            cue={t('bento.finance.cue_reconcile')}
          />
        )}
      </Widget>

      <Widget id="refunds" label={t('bento.finance.refunds')} size="small" index={5}>
        {(span) => (
          <CountCell
            span={span}
            title={t('bento.finance.refunds')}
            sub={t('bento.finance.as_of_today')}
            value={k.refunds_pending}
            note={t('bento.finance.refunds_note')}
            href={refundsHref}
            cue={t('bento.finance.cue_refunds')}
          />
        )}
      </Widget>

      <Widget id="invoices" label={t('bento.finance.invoices')} size="small" index={6}>
        {(span) => (
          <CountCell
            span={span}
            title={t('bento.finance.invoices')}
            sub={t('bento.finance.all_time')}
            value={k.invoices}
            note={t('bento.finance.invoices_note')}
            href={invoicesHref}
            cue={t('bento.finance.cue_invoices')}
          />
        )}
      </Widget>
      </WidgetLayer>
    </BentoPage>
  )
}

export {
  CollectionCell as __CollectionCell,
  TodayCell as __TodayCell,
  OutstandingCell as __OutstandingCell,
  CountCell as __CountCell,
}
