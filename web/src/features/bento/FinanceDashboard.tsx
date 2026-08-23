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
  CellError,
  type CellSpan,
  Cue,
  Meter,
  ReservoirArt,
  StatCell,
  useFeatureHref,
} from './bento-kit'
import { Widget, WidgetLayer } from './WidgetLayer'

/* THE FINANCE PAGE, IN THE BENTO LANGUAGE.

   The same two endpoints as `web/src/features/finance/Dashboard.tsx` —
   /finance/dashboard and /finance/invoices?overdue=true — and no others. No
   handler was added for this screen and none was needed.

   ─── WHAT THIS RESPONSE ACTUALLY CARRIES ─────────────────────────────────

   `today_paise`   receipts dated today.
   `month_paise`   receipts inside the resolved range, whatever range it is.
   `outstanding_paise`  sum(net - paid) over EVERY unpaid invoice of EVERY
                   year. A level, as of today, not a period figure.
   `overdue_paise` the same sum with one extra predicate — `due_on < today`.
   `range`         the resolved from/to and its label.
   plus four counts, and the overdue invoice list, capped at 300 rows.

   ─── WHAT IT DOES NOT CARRY, AND WHAT THAT COSTS ─────────────────────────

   THERE IS NO BILLED TOTAL AND NO TARGET. Not on this handler, not anywhere
   in this product's finance data. So the spec's "received/target relation"
   and "target progress" have no source and are not drawn; the cell says so in
   a sentence rather than leaving a hole a future reader fills with a guess.

   This card used to headline a percentage against
   `expected = month_paise + outstanding_paise` — a period's RECEIPTS added to
   an all-years BALANCE, captioned "of X billed" when nobody had computed a
   billed total. That derivation is gone and nothing below reintroduces it.

   THERE IS NO TIME SERIES. One figure for today, one for the range, and no
   day-by-day breakdown of either, so there is no trend line, no
   period-over-period change and no daily distribution anywhere on this page.
   The MOVEMENT the mental model asks of the taller cells is drawn from the
   two real time axes this response does have: where today sits inside the
   resolved range, and how far past its due date each overdue invoice is.

   ─── WHAT IS REAL, AND IS THEREFORE WHERE THE DENSITY COMES FROM ─────────

   1. `outstanding = not-yet-due + overdue`. Both terms are the same
      `sum(net - paid)` over the same rows at the same instant, one with an
      extra predicate on the due date, so the complement is exact and is not
      affected by the 300-row cap on the list. This is the one financial
      DECOMPOSITION on the page that is beyond argument, and it is drawn as
      proportional blocks on the anchor.

   2. AGEING from `due_on`. The overdue list carries a due date and an
      outstanding amount per row, so the four standard receivable buckets are
      that list summed by how far past due each row is. Exact while the list
      is short; the list is capped at 300 rows server-side, and when it comes
      back full the cell prints how much of the overdue money the bands
      actually cover instead of implying they cover all of it.

   3. `today_paise / month_paise`, but ONLY when today is inside the resolved
      range. Both are the same sum over the same predicate — one for
      CURRENT_DATE, one for the range — so today's receipts are genuinely part
      of the period's total when today is in it and genuinely are not when the
      range is last month. The guard is built from local calendar parts, never
      `toISOString`, which is UTC and moves the check a day east of Greenwich.

   4. Where today sits in the range, as a day number out of the range's span,
      and the mean per elapsed day. Payments cannot be dated in the future, so
      the range total covers exactly the elapsed part of it and that mean is a
      real average rather than a projection.

   ─── WHAT EACH SIZE DRAWS ────────────────────────────────────────────────

   Three cells read `useWidgetSize` and change SHAPE with the room; `wide` and
   `tall` are tested separately, never multiplied into an area, because 2x1
   and 1x2 are different cells — one has the width a labelled row of blocks
   needs and no height for four of them, the other has the reverse.

   The other four draw the same thing at every size, deliberately, for the
   reason given where they are declared. */

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

// --- the drawing vocabulary this file uses ------------------------------

/* Same rule as the kit and as bento-viz, restated here because these
   drawings are this page's and live in this file: EVERY MARK IS AN ACCENT
   MIXED INTO `currentColor`, never an accent on its own and never a hex.
   `currentColor` is the ink the cell already resolved for its own ground —
   `--bento-ink` on a plain card, `--bento-bg` on the inverted anchor — so a
   mark built on it is a hue cast over an ink that already read. A drawing
   that named `--bento-ink` directly would be ink on ink, and the anchor of
   this very board is an inverted cell. */
type Hue = 'mint' | 'purple' | 'pink' | 'orange'
const mark = (h: Hue) => `color-mix(in srgb, var(--bento-${h}) 55%, currentColor)`
const wash = (h: Hue, pct: number) => `color-mix(in srgb, ${mark(h)} ${pct}%, transparent)`
const TRACK = 'color-mix(in srgb, currentColor 12%, transparent)'
/** Quiet text. `--bento-muted` alone is a grey measured against a light card
    and is a smear on the inverted one, so it is pulled toward whatever ink
    the cell resolved. */
const QUIET = 'color-mix(in srgb, var(--bento-muted) 70%, currentColor)'
/** THE AGEING RAMP. Orange at the newest overdue through pink at the oldest:
    everything in these buckets is already late, so the ramp runs from caution
    to alarm rather than starting at "fine". It is never the only channel —
    the buckets are in order, and every one prints its own amount. */
const aged = (f: number) =>
  `color-mix(in srgb, ${mark('pink')} ${Math.round(Math.min(1, Math.max(0, f)) * 100)}%, ${mark('orange')})`

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
    daylight-saving boundary — an hour short or long inside the interval —
    does not shift an invoice into the next bucket. */
const daysBetween = (from: number, to: number) => Math.round((to - from) / DAY_MS)

/** "01 Aug". Built from the local midnight above rather than
    `new Date(iso)`, which would be the UTC instant and can print yesterday. */
function shortDate(iso: string): string {
  const ms = localMidnight(iso)
  if (ms === null) return '—'
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' }).format(new Date(ms))
}

/** The four standard receivable buckets, in days past due. `?overdue=true` is
    `due_on IS NOT NULL AND due_on < CURRENT_DATE` server-side, so every row
    is at least one day past due and there is no bucket for "not yet due" —
    that money is the complement on the KPI response, not in this list. */
const BUCKET_MAX = [30, 60, 90, Infinity]

interface Ageing {
  paise: number[]
  count: number[]
  /** What the listed rows add up to. Equal to `overdue_paise` while the list
      is short; less than it once the server's cap has bitten. */
  listedPaise: number
  listedCount: number
  oldestDays: number
  /** The single largest listed invoice, which is the one somebody chases
      first. */
  largest: InvoiceRow | null
  /** The listed rows, largest first, with their age. */
  ranked: { id: string; who: string; paise: number; days: number }[]
}

/** The buckets, in paise AND in invoices, from rows the API already returned.

    A row without a readable due date is skipped rather than bucketed: it
    cannot occur under the endpoint's own predicate, and if it ever did,
    guessing an age for it would put real money in a bucket it does not
    belong to. */
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
    ranked.push({
      id: i.id,
      who: i.admission_no || i.invoice_no,
      paise: i.due_paise,
      days,
    })
  }
  ranked.sort((a, b) => b.paise - a.paise || a.days - b.days)
  return {
    paise,
    count,
    listedPaise,
    listedCount: ranked.length,
    oldestDays,
    largest,
    ranked,
  }
}

/** Where today sits inside the resolved range, or null when it is outside it.

    THE GUARD THE WHOLE `today` CELL HANGS ON. Built from local calendar parts
    on both sides: the range is the school's own day, and a UTC comparison
    would call an evening in Kolkata "yesterday" and quietly drop the one
    honest comparison on that card. */
function positionInRange(range: FinanceKPIs['range']): { day: number; span: number; frac: number } | null {
  const from = localMidnight(range?.from)
  const to = localMidnight(range?.to)
  if (from === null || to === null) return null
  const now = todayMidnight()
  if (now < from || now > to) return null
  const span = daysBetween(from, to) + 1
  const day = daysBetween(from, now) + 1
  return { day, span, frac: span <= 1 ? 1 : (day - 1) / (span - 1) }
}

// --- the drawings ------------------------------------------------------

/** Two drawings in one slot, spaced. */
function Stack({ children, gap = 'gap-2.5' }: { children: ReactNode; gap?: string }) {
  return <div className={cn('flex min-w-0 flex-col', gap)}>{children}</div>
}

/** PROPORTIONAL BLOCKS. The composition claim made structurally: the whole
    bar is the whole, so the parts cannot be misread as independent
    quantities the way they can from two separate bars.

    The total is the sum of what was passed and never a figure supplied
    separately — a block row with a gap at the end is a row with an unlabelled
    extra category, which no dashboard has ever meant.

    Each part carries its name and its amount directly beneath, in the same
    order as the blocks, so the row reads with every colour removed. */
function Blocks({
  parts,
  srLabel,
  labels = true,
  height = 'h-3',
}: {
  parts: { key: string; label: string; paise: number; hue: Hue }[]
  srLabel: string
  labels?: boolean
  height?: string
}) {
  const usable = parts.filter((p) => Number.isFinite(p.paise) && p.paise >= 0)
  const total = usable.reduce((a, p) => a + p.paise, 0)
  // No data draws nothing. A single flat block labelled ₹0 is a measurement
  // that was never taken wearing the clothes of one that was.
  if (usable.length === 0 || total <= 0) return null

  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <div
        role="img"
        aria-label={`${srLabel}: ${usable
          .map((p) => `${p.label}, ${formatPaise(p.paise)}, ${Math.round((p.paise / total) * 100)} percent`)
          .join('; ')}. Total ${formatPaise(total)}.`}
        className={cn('flex w-full items-stretch gap-[3px]', height)}
      >
        {usable
          .filter((p) => p.paise > 0)
          .map((p) => (
            <div
              key={p.key}
              title={`${p.label}: ${formatPaise(p.paise)}`}
              className="rounded-full"
              style={{
                width: `${(p.paise / total) * 100}%`,
                minWidth: '6px',
                background: `linear-gradient(90deg, ${wash(p.hue, 72)}, ${mark(p.hue)})`,
                boxShadow: `inset 0 -1.5px 0 ${wash(p.hue, 28)}`,
              }}
            />
          ))}
      </div>
      {labels && (
        <ul
          aria-hidden="true"
          className="m-0 flex list-none flex-wrap gap-x-3 gap-y-0.5 p-0 text-[10.5px] leading-tight tabular-nums"
        >
          {usable.map((p) => (
            <li key={p.key} className="flex min-w-0 items-center gap-1.5">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: mark(p.hue) }}
              />
              <span className="truncate" style={{ color: QUIET }}>
                {p.label}
              </span>
              <span className="shrink-0 font-semibold">{formatPaise(p.paise)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** AGEING, AS ORDERED RAILS. Not a stacked bar, though the data would fit
    one: these buckets have a direction — money gets worse as it moves down
    the list — and stacking them into a single bar throws that away.

    Each rail is its own bucket against the largest bucket, because the
    question a bursar brings is "which bucket is the problem"; against the
    total the small buckets are all hairlines.

    Money is printed by `formatPaise` on every row. This is why the kit's
    `AgeBands` is not used here: its value column is a fixed 3.5rem, which is
    a count's width, and a rupee figure that does not fit it either clips or
    pushes the rail out of the card. */
function MoneyBands({
  bands,
  srLabel,
  counts = true,
}: {
  bands: { label: string; paise: number; count: number }[]
  srLabel: string
  counts?: boolean
}) {
  const max = bands.reduce((a, b) => Math.max(a, b.paise), 0)
  if (bands.length === 0 || max <= 0) return null
  const last = Math.max(1, bands.length - 1)

  return (
    <div
      role="img"
      aria-label={`${srLabel}: ${bands
        .map((b) => `${b.label}, ${formatPaise(b.paise)} across ${b.count} invoices`)
        .join('; ')}.`}
      className="flex w-full min-w-0 flex-col gap-1.5"
    >
      {bands.map((b, i) => (
        <div key={b.label} className="flex min-w-0 items-center gap-2">
          <span
            className="w-[3.1rem] shrink-0 text-[10px] leading-none tabular-nums"
            style={{ color: QUIET }}
          >
            {b.label}
          </span>
          <div
            className="h-[9px] min-w-0 flex-1 overflow-hidden rounded-full"
            style={{ background: TRACK }}
          >
            {/* A floor, so a bucket holding one small invoice is a visible
                mark rather than an empty rail indistinguishable from zero. */}
            <div
              className="h-full rounded-full"
              style={{
                width: b.paise <= 0 ? '0%' : `${Math.max(4, (b.paise / max) * 100)}%`,
                background: aged(i / last),
              }}
            />
          </div>
          <span className="shrink-0 text-right text-[10.5px] font-semibold leading-none tabular-nums">
            {formatPaise(b.paise)}
          </span>
          {counts && (
            <span
              className="w-5 shrink-0 text-right text-[9.5px] leading-none tabular-nums"
              style={{ color: QUIET }}
            >
              {b.count}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

/** THE RANKED FIELD. Forty-eight invoices as forty-eight tiles, largest
    first, reading left to right and top to bottom.

    DELIBERATELY NOT A BAR CHART. Forty-eight bars sorted by length is a
    ranking drawn once and then repeated forty-eight times: the second half of
    it is a taper, and the amounts — the thing somebody chasing money actually
    needs — end up as axis furniture. A field spends the same pixels on
    forty-eight PRINTED AMOUNTS instead, and gets the ranking for free from
    reading order.

    Two facts per tile, on two channels each:
      · the amount — printed, and in the tile's title
      · how far past due — the rule along the tile's foot, whose LENGTH is the
        age against the oldest listed, plus the tile's tint. Length is the
        channel; the tint restates it, and the exact day count is in the title
        and in the label the screen reader is given.

    Needs 2x2. At any smaller size the tiles are narrower than a rupee figure
    and the field would be a mosaic of clipped numbers. */
function RankedField({
  items,
  srLabel,
  cols,
}: {
  items: Ageing['ranked']
  srLabel: string
  cols: number
}) {
  if (items.length === 0) return null
  const oldest = items.reduce((a, i) => Math.max(a, i.days), 0)

  return (
    <div
      role="img"
      aria-label={`${srLabel}: ${items
        .map((i) => `${i.who}, ${formatPaise(i.paise)}, ${i.days} days past due`)
        .join('; ')}.`}
      className="grid w-full min-w-0 gap-[3px]"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {items.map((i) => {
        const f = oldest > 0 ? i.days / oldest : 0
        return (
          <div
            key={i.id}
            title={`${i.who}: ${formatPaise(i.paise)}, ${i.days} days past due`}
            className="relative overflow-hidden rounded-[3px] px-[3px] pb-[4px] pt-[2px]"
            style={{ background: wash(f >= 0.5 ? 'pink' : 'orange', 16) }}
          >
            <span className="block truncate text-[9px] font-semibold leading-[11px] tabular-nums">
              {formatPaise(i.paise)}
            </span>
            <span
              aria-hidden="true"
              className="absolute inset-x-0 bottom-0 h-[2px]"
              style={{ background: TRACK }}
            />
            <span
              aria-hidden="true"
              className="absolute bottom-0 left-0 h-[2px]"
              style={{ width: `${Math.max(5, f * 100)}%`, background: aged(f) }}
            />
          </div>
        )
      })}
    </div>
  )
}

/** WHERE TODAY SITS IN THE RANGE. A real axis with two real ends: the range
    the server resolved, printed at both ends, with today marked in it.

    This is the only time axis on the page that is not an ageing, and it is
    the honest answer to "movement" on a response that carries no series: not
    how collection has moved, but how much of the period it has had to move
    in. */
function PeriodTrack({
  from,
  to,
  frac,
  srLabel,
}: {
  from: string
  to: string
  frac: number
  srLabel: string
}) {
  const pct = Math.min(100, Math.max(0, frac * 100))
  return (
    <div className="flex w-full min-w-0 flex-col gap-1">
      <div
        role="img"
        aria-label={srLabel}
        className="relative h-[9px] w-full overflow-hidden rounded-full"
        style={{ background: TRACK }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${pct}%`, background: wash('purple', 55) }}
        />
        {/* The now mark. Inset from both edges so a range that begins or ends
            today still shows a mark inside the rail rather than half of one
            hanging off it. */}
        <div
          className="absolute inset-y-0 w-[3px] rounded-full"
          style={{ left: `calc(${pct}% - ${pct / 100} * 3px)`, background: mark('purple') }}
        />
      </div>
      <div
        aria-hidden="true"
        className="flex items-baseline justify-between text-[9.5px] leading-none tabular-nums"
        style={{ color: QUIET }}
      >
        <span>{shortDate(from)}</span>
        <span>{shortDate(to)}</span>
      </div>
    </div>
  )
}

// --- the three cells that change shape ---------------------------------

/** THE ANCHOR: what came in, what is still owed, and how old the rest is.

    1x1  SIGNAL. The range's receipts, then the balance as two blocks —
         not yet due against overdue — with the overdue share in a sentence.
    2x1  SIGNAL + STRUCTURE. The same, and beside it the four ageing buckets
         as labelled rails: width is exactly what a label, a rail and a rupee
         figure need on one line.
    1x2  SIGNAL + MOVEMENT. The same figure, the decomposition with its
         labels, where today sits in the range, and the ageing stacked.
    2x2  All of it, over the reservoir, plus the two facts a bursar acts on —
         the oldest debt and the largest single invoice — and the sentence
         that says why there is no progress figure here.

    THE ONE REAL PROPORTION IS OVERDUE AGAINST OUTSTANDING: the same
    `sum(net - paid)` with one extra predicate on the due date, both levels as
    of today. That is what the vessel fills to and what the blocks split. The
    receipts figure above it is stated, labelled for what it is, and no
    relationship is claimed between the two. */
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

  const bands = [
    { label: t('bento.finance.age_1'), paise: a.paise[0], count: a.count[0] },
    { label: t('bento.finance.age_2'), paise: a.paise[1], count: a.count[1] },
    { label: t('bento.finance.age_3'), paise: a.paise[2], count: a.count[2] },
    { label: t('bento.finance.age_4'), paise: a.paise[3], count: a.count[3] },
  ]

  /* The ageing block, in whatever state the invoice list is in. The receipts
     and the balance above it are KPI figures and stay true whatever the list
     did, so a failed list narrows this section rather than the card. */
  const ageingBlock = (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-[10px] font-semibold uppercase leading-none tracking-[0.1em] opacity-70">
        {t('bento.finance.ageing')}
      </p>
      {ageStatus === 'error' ? (
        <CellError dark message={t('bento.finance.ageing_failed')} />
      ) : ageStatus === 'loading' ? (
        <p className="text-[11.5px] opacity-70">{t('bento.finance.ageing_loading')}</p>
      ) : a.listedCount === 0 ? (
        <p className="text-[12px]">{t('bento.finance.ageing_none')}</p>
      ) : (
        <>
          <MoneyBands bands={bands} srLabel={t('bento.finance.ageing_sr')} />
          <p className="text-[10px] leading-snug opacity-70">
            {capped
              ? t('bento.finance.ageing_capped', {
                  covered: formatPaise(a.listedPaise),
                  total: formatPaise(k.overdue_paise),
                })
              : t('bento.finance.ageing_count', { count: a.listedCount })}
          </p>
        </>
      )}
    </div>
  )

  return (
    <Cell
      span={span}
      dark
      /* The vessel is everything still owed; the waterline is the part of it
         already past its due date. Same measure, same instant, one extra
         predicate — the reservoir is the block row at full-card scale, not a
         second claim. */
      art={roomy ? (
        <ReservoirArt
          fill={k.outstanding_paise > 0 ? k.overdue_paise / k.outstanding_paise : 0}
        />
      ) : undefined}
    >
      <div className={cn('flex min-h-0 min-w-0 gap-4', wide && !tall ? 'flex-row' : 'flex-col')}>
        {/* THE SIGNAL. Present at every size, and the only thing present at
            the smallest. */}
        <div className={cn('flex min-w-0 flex-col', wide && !tall ? 'w-[46%] shrink-0' : 'w-full')}>
          <p className="text-[11px] leading-tight opacity-80">
            {t('bento.finance.collected_in', { label: k.range.label })}
          </p>
          <p
            className={cn(
              'font-semibold leading-none tracking-[-0.02em] tabular-nums',
              roomy ? 'mt-2.5 text-[40px]' : 'mt-1.5 text-[26px]',
            )}
          >
            {formatPaise(k.month_paise)}
          </p>

          {/* THE DECOMPOSITION. Outstanding is exactly its two parts, and the
              blocks are the only place on this board that says so. Labels are
              dropped at 1x1, where the sentence beneath carries both figures
              and there is no room for a second copy of them. */}
          <div className="mt-2.5">
            <Blocks
              parts={[
                {
                  key: 'due',
                  label: t('bento.finance.not_yet_due'),
                  paise: notYetDue,
                  hue: 'purple',
                },
                {
                  key: 'overdue',
                  label: t('bento.finance.overdue'),
                  paise: k.overdue_paise,
                  hue: 'pink',
                },
              ]}
              labels={wide || tall}
              height={roomy ? 'h-3' : 'h-2.5'}
              srLabel={t('bento.finance.decomp_sr')}
            />
          </div>
          <p className="mt-1.5 text-[11px] leading-snug opacity-80">
            {t('bento.finance.outstanding_split', {
              outstanding: formatPaise(k.outstanding_paise),
              pct: overduePct,
            })}
          </p>

          {/* MOVEMENT, where there is height for it: how much of the range
              the figure above has had to arrive in. */}
          {tall && pos && (
            <div className="mt-3">
              <PeriodTrack
                from={k.range.from}
                to={k.range.to}
                frac={pos.frac}
                srLabel={t('bento.finance.period_track_sr', {
                  label: k.range.label,
                  from: shortDate(k.range.from),
                  to: shortDate(k.range.to),
                })}
              />
              <p className="mt-1 text-[10.5px] opacity-70">
                {t('bento.finance.today_position', {
                  day: pos.day,
                  span: pos.span,
                  label: k.range.label,
                })}
              </p>
            </div>
          )}
        </div>

        {/* STRUCTURE. The ageing needs a heading, four rails and four rupee
            figures; at one column and one row there is no honest way to fit
            them, so they are not drawn small — they are not drawn. */}
        {(wide || tall) && (
          <div
            className={cn(
              'flex min-w-0 flex-1 flex-col gap-2',
              wide && !tall ? 'border-l border-background/20 pl-4' : 'border-t border-background/20 pt-3',
            )}
          >
            {ageingBlock}

            {/* EXPLANATION, at the one size with room to be told something
                rather than shown it. */}
            {roomy && (
              <div className="mt-auto flex flex-col gap-1 pt-1">
                {ageStatus === 'ready' && a.largest && (
                  <p className="text-[10.5px] leading-snug opacity-80">
                    {t('bento.finance.worst_two', {
                      days: a.oldestDays,
                      amount: formatPaise(a.largest.due_paise),
                      who: a.largest.admission_no || a.largest.invoice_no,
                    })}
                  </p>
                )}
                <p className="text-[10px] leading-snug opacity-60">
                  {t('bento.finance.no_target')}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {href && <Cue dark to={href} label={t('bento.finance.cue_overdue')} />}
    </Cell>
  )
}

/** COLLECTED TODAY.

    1x1  SIGNAL. The drawer figure, which is what a cashier came for, and
         which day of the range it is.
    1x2  SIGNAL + MOVEMENT. The same, then the range as a real axis with
         today marked in it, and today measured against the mean day so far.
    2x1  SIGNAL + STRUCTURE. Today and the rest of the range as proportional
         blocks — one decomposition of the range's receipts, not two figures
         side by side — with the mean day beneath.
    2x2  All three, plus the sentence saying why there is no daily
         distribution: there is no per-day series on this response to draw
         one from.

    EVERY ONE OF THOSE COMPARISONS IS GUARDED. `month_paise` is the resolved
    range's total, and today's receipts are part of it only when today is
    inside that range. When the range is last month the cell keeps the figure
    and drops every comparison, saying which it did. */
function TodayCell({
  span, k, href,
}: {
  span: CellSpan
  k: FinanceKPIs
  href?: string
}) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2
  const bigger = wide || tall

  const pos = positionInRange(k.range)
  const inRange = pos !== null
  const rest = inRange ? Math.max(0, k.month_paise - k.today_paise) : 0
  /* The mean per ELAPSED day, not per day of the range. Payments cannot be
     dated in the future, so the range total covers exactly `pos.day` days and
     dividing by the whole span would understate every day of a range that is
     still running. Money divided by a count of days is still money. */
  const perDay = pos && pos.day > 0 ? Math.round(k.month_paise / pos.day) : 0

  const track = pos ? (
    <div>
      <PeriodTrack
        from={k.range.from}
        to={k.range.to}
        frac={pos.frac}
        srLabel={t('bento.finance.period_track_sr', {
          label: k.range.label,
          from: shortDate(k.range.from),
          to: shortDate(k.range.to),
        })}
      />
      <p className="mt-1 text-[10.5px] leading-snug text-[var(--bento-muted)]">
        {t('bento.finance.today_position', { day: pos.day, span: pos.span, label: k.range.label })}
      </p>
    </div>
  ) : null

  const blocks = pos && k.month_paise > 0 ? (
    <div>
      <Blocks
        parts={[
          { key: 'today', label: t('bento.finance.today_part'), paise: k.today_paise, hue: 'mint' },
          { key: 'rest', label: t('bento.finance.period_part'), paise: rest, hue: 'purple' },
        ]}
        srLabel={t('bento.finance.today_sr', { label: k.range.label })}
      />
      <p className="mt-1 text-[10.5px] leading-snug text-[var(--bento-muted)]">
        {t('bento.finance.per_day', { amount: formatPaise(perDay), label: k.range.label })}
      </p>
    </div>
  ) : null

  let shape: ReactNode
  if (inRange) {
    if (wide && tall) shape = <Stack>{blocks}{track}</Stack>
    else if (wide) shape = blocks
    else if (tall) shape = track
    else if (k.month_paise > 0) {
      // 1x1 keeps the one bar that fits: today against the range it is part
      // of, with no legend, and the note beneath names the denominator.
      shape = (
        <Meter
          value={k.today_paise}
          total={k.month_paise}
          tone="success"
          srLabel={t('bento.finance.today_sr', { label: k.range.label })}
        />
      )
    }
  }

  let note: string
  if (!inRange) {
    note = t('bento.finance.today_outside', { label: k.range.label })
  } else if (wide && tall) {
    note = t('bento.finance.no_daily_series')
  } else if (bigger) {
    note = t('bento.finance.today_of_period', {
      amount: formatPaise(k.month_paise),
      label: k.range.label,
    })
  } else {
    note = t('bento.finance.today_day_of', { day: pos!.day, span: pos!.span })
  }

  return (
    <StatCell
      span={span}
      label={t('bento.finance.today')}
      value={formatPaise(k.today_paise)}
      shape={shape}
      note={note}
      to={href}
      cue={t('bento.finance.cue_collect')}
    />
  )
}

/** WHAT IS STILL OWED.

    The rail has the one denominator on this response that is beyond argument:
    `overdue_paise` is the same `sum(net - paid)` as `outstanding_paise` with
    one extra predicate on the due date, so the overdue money is a strict part
    of the outstanding money and both are levels as of today.

    1x1  SIGNAL. The balance, the overdue share of it, and how old the worst
         of it is.
    1x2  SIGNAL + MOVEMENT. The four ageing buckets in money and in invoices —
         the movement of debt through time, which is the only movement this
         response has for this figure.
    2x1  SIGNAL + STRUCTURE. The buckets, and how concentrated the listed
         overdue is in its largest ten.
    2x2  All of it, and the forty-eight largest as a ranked field.

    The bands, the concentration and the field all come from the overdue list,
    which the server caps at 300 rows; where that cap can change what is being
    read, the cell says what the figure covers. The balance and the rail come
    from the KPI response and are right whatever the list did. */
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

  const rail = (
    <Meter
      value={k.overdue_paise}
      total={k.outstanding_paise}
      tone="destructive"
      srLabel={t('bento.finance.overdue_sr')}
    />
  )

  const bands = (
    <MoneyBands
      bands={[
        { label: t('bento.finance.age_1'), paise: a.paise[0], count: a.count[0] },
        { label: t('bento.finance.age_2'), paise: a.paise[1], count: a.count[1] },
        { label: t('bento.finance.age_3'), paise: a.paise[2], count: a.count[2] },
        { label: t('bento.finance.age_4'), paise: a.paise[3], count: a.count[3] },
      ]}
      srLabel={t('bento.finance.ageing_sr')}
    />
  )

  /* CONCENTRATION, within what the list returned and said to be within it.
     Ten of three hundred carrying half the money is the finding; ten of
     twelve carrying half of it is not, so the count it is out of is printed
     beside it rather than left to be assumed. */
  const topTen = a.ranked.slice(0, 10)
  const topTenPaise = topTen.reduce((s, i) => s + i.paise, 0)
  const topTenPct = a.listedPaise > 0 ? Math.round((topTenPaise / a.listedPaise) * 100) : 0

  /* THE FIELD IS THE LARGEST FORTY-EIGHT, AND SAYS SO. The list arrives
     newest-issued first, which is not the order anybody chases in; cutting it
     at forty-eight in that order would keep the recent small ones and drop
     the old large ones, which is the one truncation that changes the answer.
     `a.ranked` is already sorted by amount. */
  const field = a.ranked.slice(0, 48)

  let shape: ReactNode = rail
  if (ageStatus === 'ready' && a.listedCount > 0) {
    if (roomy) {
      shape = (
        <Stack gap="gap-2">
          {rail}
          {bands}
          <div className="flex flex-col gap-1">
            <p className="text-[10px] font-semibold uppercase leading-none tracking-[0.1em] text-[var(--bento-muted)]">
              {t('bento.finance.ranked_title', { n: field.length })}
            </p>
            <RankedField
              items={field}
              cols={8}
              srLabel={t('bento.finance.ranked_sr', { n: field.length })}
            />
          </div>
        </Stack>
      )
    } else if (tall) {
      shape = <Stack>{rail}{bands}</Stack>
    } else if (wide) {
      shape = <Stack>{rail}{bands}</Stack>
    }
  }

  // The overdue amount is a KPI figure and stays true when the invoice list
  // failed; the sentence changes to say the drawing below is missing rather
  // than empty. A failed fetch is never an empty chart on this page.
  let note = t('bento.finance.overdue_note', { amount: formatPaise(k.overdue_paise) })
  if (ageStatus === 'error') {
    note = t('bento.finance.overdue_ageing_failed', { amount: formatPaise(k.overdue_paise) })
  } else if (ageStatus === 'loading') {
    note = t('bento.finance.overdue_note_loading', { amount: formatPaise(k.overdue_paise) })
  } else if (a.listedCount > 0) {
    const parts: string[] = [note]
    parts.push(t('bento.finance.oldest_overdue', { days: a.oldestDays }))
    if (wide) {
      parts.push(t('bento.finance.concentration', {
        n: topTen.length,
        pct: topTenPct,
        listed: a.listedCount,
      }))
    }
    // Both truncations are stated where they apply: the field is the 48
    // largest of what arrived, and what arrived may itself be the server's
    // first 300. A cut series that does not say it was cut understates the
    // size of the problem.
    if (roomy && a.listedCount > field.length) {
      parts.push(t('bento.finance.ranked_of', { shown: field.length, total: a.listedCount }))
    }
    if (capped && (wide || tall)) {
      parts.push(t('bento.finance.ageing_capped', {
        covered: formatPaise(a.listedPaise),
        total: formatPaise(k.overdue_paise),
      }))
    }
    note = parts.join(' ')
  }

  return (
    <StatCell
      span={span}
      label={t('bento.finance.outstanding')}
      value={formatPaise(k.outstanding_paise)}
      shape={shape}
      note={note}
      to={href}
      cue={t('bento.finance.cue_ledger')}
    />
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
          <CollectionCell
            span={span}
            k={k}
            rows={rows}
            ageStatus={ageStatus}
            href={defaultersHref}
          />
        )}
      </Widget>

      <Widget id="today" label={t('bento.finance.today')} size="small" index={1}>
        {(span) => <TodayCell span={span} k={k} href={collectHref ?? receiptsHref} />}
      </Widget>

      <Widget id="outstanding" label={t('bento.finance.outstanding')} size="small" index={2}>
        {(span) => (
          <OutstandingCell
            span={span}
            k={k}
            rows={rows}
            ageStatus={ageStatus}
            href={ledgerHref}
          />
        )}
      </Widget>

      {/* FLAT AT EVERY SIZE, ON PURPOSE.

          Four counts with nothing behind them on this response. There is no
          student population to put the defaulters over, no payment total to
          put the unreconciled over, no refund total to put the pending ones
          over, and the invoice count is every invoice ever raised with no
          comparable subset in the same payload — the overdue list is capped
          at 300, so any share built from it would contradict the server's own
          uncapped figure. Each of these draws one number at 1x1 and the same
          number at 2x2. */}
      <Widget id="defaulters" label={t('bento.finance.defaulters')} size="small" index={3}>
        {(span) => (
      <StatCell
        span={span}
        label={t('bento.finance.defaulters')}
        value={k.defaulters}
        note={t('bento.finance.defaulters_note')}
        to={defaultersHref}
        cue={t('bento.finance.cue_defaulters')}
      />
        )}
      </Widget>

      <Widget id="unreconciled" label={t('bento.finance.unreconciled')} size="small" index={4}>
        {(span) => (
      <StatCell
        span={span}
        label={t('bento.finance.unreconciled')}
        value={k.unreconciled}
        note={t('bento.finance.unreconciled_note')}
        to={reconciliationHref}
        cue={t('bento.finance.cue_reconcile')}
      />
        )}
      </Widget>

      <Widget id="refunds" label={t('bento.finance.refunds')} size="small" index={5}>
        {(span) => (
      <StatCell
        span={span}
        label={t('bento.finance.refunds')}
        value={k.refunds_pending}
        note={t('bento.finance.refunds_note')}
        to={refundsHref}
        cue={t('bento.finance.cue_refunds')}
      />
        )}
      </Widget>

      <Widget id="invoices" label={t('bento.finance.invoices')} size="small" index={6}>
        {(span) => (
      <StatCell
        span={span}
        label={t('bento.finance.invoices')}
        value={k.invoices}
        note={t('bento.finance.invoices_note')}
        to={invoicesHref}
        cue={t('bento.finance.cue_invoices')}
      />
        )}
      </Widget>
      </WidgetLayer>
    </BentoPage>
  )
}

export { CollectionCell as __CollectionCell, TodayCell as __TodayCell, OutstandingCell as __OutstandingCell }
