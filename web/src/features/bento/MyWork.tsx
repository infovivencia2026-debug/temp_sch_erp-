import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useWidgetSize } from '@/lib/widget-size'
import { WidgetLayer, Widget } from './WidgetLayer'
import { type CellSpan } from './bento-kit'
import { AgeBands, SegmentBar } from './bento-viz'

/* MY WORK, AS THREE INSTRUMENTS.

   Reads `/api/v1/teaching/my-work` — the same endpoint the classic screen
   reads. No new endpoint and no second implementation of the data.

   ─── WHAT THE HANDLER ACTUALLY RETURNS ───────────────────────────────────

   Read from internal/api/faculty_work.go rather than from the TS interface
   below, because the interface is a description and the handler is the fact.
   Five kinds, and they are not five of the same thing:

     kind           rows        `count` is…              `due`      `overdue` is…
     submissions    0 or 1      submissions to mark      none       one waited >3 days
     marks          0..10       marks MISSING on a paper  exam end   exam ended
     substitution   0..10       always 1                 the date   the date is today
     leave          all pending always 1                 none       still undecided
     announcement   0 or 1      notices to acknowledge    none       ALWAYS false

   THREE CONSEQUENCES, AND EVERY DECISION IN THIS FILE FOLLOWS FROM THEM.

   1. THE COUNTS ARE IN DIFFERENT UNITS. Eleven missing marks, one cover
      lesson and four notices are not eleven, one and four of anything.
      Composition BY KIND is honest — it partitions the printed total, and the
      segments sum back to it. A "largest queue" RANKING ACROSS KINDS is not:
      it would put a number of marks next to a number of lessons and declare a
      winner. The spec asks for "largest queue" at 2x2, so this file draws the
      one ranking that is real — the largest single MARKS paper, against the
      other marks papers, in one unit — and says on the card that that is what
      it is. Nothing else in this response has two comparable rows to rank.

   2. THERE IS NO PRIORITY FIELD. The spec asks for priority at 2x2 on both
      cells. `workItem` has kind, title, detail, count, due, overdue, link and
      nothing else. Per the honesty rule it is left out and the 2x2 overdue
      cell says so rather than inventing a severity ladder out of the kind.

   3. THERE IS NO HISTORY. No previous period, no series, nothing to draw a
      change or a trend from. The spec's "+ change" on the 2x1 outstanding
      cell is therefore not drawn; the added width carries the late split per
      kind instead, which is structure this response really has.

   THE LIST IS CAPPED. Marks and cover are each `LIMIT 10` server-side. When a
   kind comes back at exactly ten rows the cell says the figures are a floor
   rather than a total, because ten is also what "exactly ten" looks like.

   NO FABRICATED DENOMINATORS. Every share drawn here divides one part of this
   response by another part of this response — never by a population the
   response does not carry. */

/** The catalogue lookup, as `useT` hands it over. */
type Translate = ReturnType<typeof useT>

interface WorkItem {
  kind: string
  title: string
  detail: string
  count: number
  due?: string
  overdue: boolean
}
interface MyWorkView {
  items: WorkItem[]
  outstanding: number
  sections: number
}

/** What the server lists at a time, for the two kinds it caps. Ten rows back
    means ten rows shown, not ten rows existing. */
const SERVER_PAGE = 10
const CAPPED_KINDS = ['marks', 'substitution']

/** The kinds the handler scopes by SECTION rather than by account. Used only
    to partition the rows on the list, never to divide anything. */
const SECTION_KINDS = ['submissions', 'marks', 'substitution']

/** Quiet ink for a label, on whichever ground the cell turned out to have.
    `currentColor` rather than a grey token for the same reason bento-viz uses
    it: the outstanding cell is inverted, and a grey measured against the light
    card is mud on it. */
const QUIET = 'color-mix(in srgb, currentColor 62%, transparent)'

/** The five kinds the handler emits, in words. An unknown kind falls through
    to its own key rather than to a blank: a new probe added server-side
    should look unlabelled, not look like nothing. */
function kindLabel(t: Translate, kind: string): string {
  switch (kind) {
    case 'submissions': return t('bento.my_work.kind_submissions')
    case 'marks': return t('bento.my_work.kind_marks')
    case 'substitution': return t('bento.my_work.kind_substitution')
    case 'leave': return t('bento.my_work.kind_leave')
    case 'announcement': return t('bento.my_work.kind_announcement')
    default: return kind
  }
}

/** Frequencies by kind, in first-seen order rather than by size, so a bar does
    not reshuffle itself between two visits to the same board. */
function byKind(
  items: WorkItem[],
  weight: (i: WorkItem) => number,
  label: (kind: string) => string,
): { label: string; value: number }[] {
  const order: string[] = []
  const m = new Map<string, number>()
  for (const i of items) {
    if (!m.has(i.kind)) order.push(i.kind)
    m.set(i.kind, (m.get(i.kind) ?? 0) + weight(i))
  }
  return order.map((k) => ({ label: label(k), value: m.get(k) ?? 0 }))
}

/* Days between today and a due date, from the LOCAL calendar rather than from
   a UTC timestamp: `due` is a school day and not an instant, and a date parsed
   at midnight UTC lands on the previous evening east of Greenwich — which
   would move work due today into the late band. */
const DAY_MS = 86_400_000
function localMidnight(): number {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
}
/** Positive = falls due in that many days. Negative = that many days late. */
function daysOut(due: string | undefined, midnight: number): number | null {
  if (!due) return null
  const ms = Date.parse(`${due}T00:00:00`)
  if (!Number.isFinite(ms)) return null
  return Math.round((ms - midnight) / DAY_MS)
}

// --- the shell ----------------------------------------------------------

/** One small direct-labelled figure. The unit of hierarchy on these cards:
    a number and the word for it, side by side, at a size that reads as
    supporting rather than as a second headline. */
function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 text-[11.5px] leading-none">
      <span className="shrink-0 font-semibold tabular-nums">{value}</span>
      <span className="truncate" style={{ color: QUIET }}>{label}</span>
    </span>
  )
}

/** One cell.

    Two layouts, chosen from the room rather than from a prop, because the
    difference between 2x1 and 1x2 is the whole question these cells answer.
    At 2x1 the figure takes a narrow left column and the drawing takes the
    width it needed in the first place; everywhere else the cell is a column
    with the figure high and the drawing under it. */
function Cell({
  label,
  value,
  span,
  dark,
  foot,
  shape,
  note,
}: {
  label: string
  value: string | number
  /* Widened to CellSpan because the arranger can hand this cell any of the
     four spans; a narrower union would reject 'wide' and 'full'. */
  span?: CellSpan
  /* Dark ground for the one figure that matters most; light for everything
     read as text. Both use existing tokens — a raw hex here would undo the
     contrast work already done on this palette. */
  dark?: boolean
  /** The supporting figures that sit under the headline number. */
  foot?: ReactNode
  /** The drawing, if this cell has the room and the data for one. */
  shape?: ReactNode
  /** The sentence that says what the drawing divides by. */
  note?: string
}) {
  const { w, h } = useWidgetSize()
  const beside = w >= 2 && h < 2
  const anchor = w >= 2 && h >= 2

  const head = (
    <>
      <p className="text-[12.5px] leading-none" style={{ color: QUIET }}>{label}</p>
      <p
        className={cn(
          'mt-3 tabular-nums font-semibold',
          anchor ? 'text-[46px] leading-none' : 'text-[32px] leading-none',
        )}
      >
        {value}
      </p>
      {foot && <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">{foot}</div>}
    </>
  )
  const body = (
    <>
      {shape}
      {note && (
        <p className="text-[10.5px] leading-snug" style={{ color: QUIET }}>{note}</p>
      )}
    </>
  )

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-[14px] border p-5',
        /* Every span, not just the one this file happened to use.

           Widening the prop's TYPE without widening this ternary is the worse
           of the two bugs: 'wide' and 'full' type-check, the arranger offers
           them, and the card silently stays 1x1. */
        span === 'anchor'
          ? 'sm:col-span-2 sm:row-span-2'
          : span === 'wide'
            ? 'sm:col-span-2'
            : span === 'full'
              ? 'sm:col-span-2 lg:col-span-4'
              : span === 'tall'
                ? 'sm:row-span-2'
                : '',
        dark ? 'bg-foreground text-background' : 'bg-card text-card-foreground',
      )}
    >
      {beside ? (
        <div className="flex h-full min-h-0 min-w-0 gap-5">
          <div className="flex w-[36%] max-w-[180px] shrink-0 flex-col justify-center">{head}</div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-center gap-2">{body}</div>
        </div>
      ) : (
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          {head}
          {!shape && !note ? (
            <div className="flex-1" />
          ) : (
            <div className="mt-3 flex min-h-0 flex-1 flex-col justify-end gap-2.5">{body}</div>
          )}
        </div>
      )}
    </div>
  )
}

/** A DENSE MATRIX, of counts by two keys.

    Rows are kinds, columns are age bands, every cell prints its own count.
    Shade is a third channel on a fact the number already carries, so a reader
    who cannot separate two washes has lost nothing; an empty cell is a middot
    rather than a 0, because "no rows here" and "zero of something measured"
    look the same written as 0 and are not the same.

    Local rather than borrowed: `HeatStrip` is one row and this is a field.
    Every colour is `currentColor`, so it takes the inverted cell's ink as
    readily as the light card's. */
function CountGrid({
  cols,
  rows,
  srLabel,
}: {
  cols: string[]
  rows: { label: string; cells: number[] }[]
  srLabel: string
}) {
  if (rows.length === 0 || cols.length === 0) return null
  const max = rows.reduce((a, r) => Math.max(a, ...r.cells), 0)
  if (max <= 0) return null

  return (
    <div
      role="img"
      aria-label={`${srLabel}: ${rows
        .map((r) => `${r.label} — ${r.cells.map((v, i) => `${cols[i]} ${v}`).join(', ')}`)
        .join('; ')}.`}
      className="w-full text-[10.5px] leading-none tabular-nums"
    >
      <div className="flex gap-[3px]">
        <span className="w-[52px] shrink-0" />
        {cols.map((c) => (
          <span key={c} className="min-w-0 flex-1 truncate text-center" style={{ color: QUIET }}>
            {c}
          </span>
        ))}
      </div>
      {rows.map((r) => (
        <div key={r.label} className="mt-[3px] flex items-center gap-[3px]">
          <span className="w-[52px] shrink-0 truncate" style={{ color: QUIET }}>{r.label}</span>
          {r.cells.map((v, i) => (
            <span
              key={`${r.label}-${i}`}
              title={`${r.label}, ${cols[i]}: ${v}`}
              className="min-w-0 flex-1 rounded-[3px] py-[4px] text-center font-semibold"
              style={
                v > 0
                  ? {
                      background: `color-mix(in srgb, currentColor ${
                        8 + Math.round((v / max) * 24)
                      }%, transparent)`,
                    }
                  : { color: QUIET }
              }
            >
              {v > 0 ? v : '·'}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

/** A named row with a figure beside it — the honest alternative to a chart
    when there is exactly one comparable thing to say. Used for the largest
    marks queue and for the oldest late items. */
function Ranked({
  head,
  rows,
  empty,
}: {
  head: string
  rows: { title: string; value: string }[]
  empty?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.06em]" style={{ color: QUIET }}>
        {head}
      </p>
      {rows.length === 0 ? (
        <p className="text-[11px] leading-snug" style={{ color: QUIET }}>{empty}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {rows.map((r, i) => (
            <li key={`${r.title}-${i}`} className="flex min-w-0 items-baseline gap-2 text-[11.5px] leading-tight">
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
              <span className="shrink-0 font-semibold tabular-nums">{r.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// --- the three cells ----------------------------------------------------

/** EVERYTHING OUTSTANDING — work queue composition, on the inverted ground.

    1x1  the figure, how much of it is late, how many kinds it spans.
    1x2  + the composition by kind. The segments are the SAME counts the figure
         is summed from, so the bar adds up to the number above it.
    2x1  + the late split per kind beside the figure. Not "+ change": this
         response carries no previous period and none is invented.
    2x2  + when the dated work falls due, and the largest single marks queue —
         the one ranking in this payload that compares like with like. */
function OutstandingCell({ span, data }: { span: CellSpan; data: MyWorkView }) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2
  const anchor = wide && tall

  /* Counted exactly as the handler counts `outstanding`: every item's count,
     except a leave request already decided. Any other rule here would draw a
     bar that does not sum to the figure above it. */
  const queue = data.items.filter((i) => i.kind !== 'leave' || i.overdue)
  const segments = byKind(queue, (i) => i.count, (k) => kindLabel(t, k))
  const lateUnits = queue.filter((i) => i.overdue).reduce((a, i) => a + i.count, 0)

  /* A kind is at the server's page size, so its figures are a floor. */
  const capped = CAPPED_KINDS.filter(
    (k) => data.items.filter((i) => i.kind === k).length >= SERVER_PAGE,
  ).map((k) => kindLabel(t, k))

  const midnight = localMidnight()
  const dated = queue
    .map((i) => daysOut(i.due, midnight))
    .filter((d): d is number => d !== null)

  const composition =
    segments.length > 0 ? (
      <SegmentBar segments={segments} srLabel={t('bento.my_work.kinds_sr')} />
    ) : (
      <p className="text-[11.5px] leading-snug">{t('bento.my_work.empty_queue')}</p>
    )

  /* The late split, per kind, as printed numbers. The extra WIDTH of a 2x1 is
     spent on structure the response really has, rather than on a change this
     endpoint cannot report. */
  const lateByKind = byKind(
    queue.filter((i) => i.overdue),
    (i) => i.count,
    (k) => kindLabel(t, k),
  ).filter((s) => s.value > 0)
  const lateRow =
    lateByKind.length > 0 ? (
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[10px] font-medium uppercase tracking-[0.06em]" style={{ color: QUIET }}>
          {t('bento.my_work.late_head')}
        </span>
        {lateByKind.map((s) => (
          <Stat key={s.label} label={s.label} value={s.value} />
        ))}
      </div>
    ) : (
      <p className="text-[11px] leading-snug" style={{ color: QUIET }}>
        {t('bento.my_work.none_late')}
      </p>
    )

  /* THE ONLY HONEST RANKING IN THIS PAYLOAD. Marks rows all count the same
     thing — marks missing on one paper — so the biggest of them is a real
     largest queue. Cover rows are all 1, and submissions, leave and notices
     are one row each in a unit of their own, so there is nothing else here to
     rank without comparing unlike things. */
  const biggestMarks = data.items
    .filter((i) => i.kind === 'marks')
    .reduce<WorkItem | null>((best, i) => (best === null || i.count > best.count ? i : best), null)

  const dueBands = (
    <AgeBands
      bands={[
        { label: t('bento.my_work.due_late'), value: dated.filter((d) => d < 0).length },
        { label: t('bento.my_work.due_today'), value: dated.filter((d) => d === 0).length },
        { label: t('bento.my_work.due_week'), value: dated.filter((d) => d >= 1 && d <= 7).length },
        { label: t('bento.my_work.due_later'), value: dated.filter((d) => d > 7).length },
      ]}
      srLabel={t('bento.my_work.due_sr')}
    />
  )

  let shape: ReactNode = null
  if (anchor) {
    shape = (
      <div className="flex min-h-0 flex-col gap-3">
        {composition}
        <div className="flex min-w-0 gap-5">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <p className="text-[10px] font-medium uppercase tracking-[0.06em]" style={{ color: QUIET }}>
              {t('bento.my_work.due_head')}
            </p>
            {dated.length > 0 ? (
              dueBands
            ) : (
              <p className="text-[11px] leading-snug" style={{ color: QUIET }}>
                {t('bento.my_work.no_dates_at_all')}
              </p>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <Ranked
              head={t('bento.my_work.largest_head')}
              empty={t('bento.my_work.largest_none')}
              rows={
                biggestMarks
                  ? [
                      {
                        title: biggestMarks.title,
                        value: t('bento.my_work.largest_unit', { count: biggestMarks.count }),
                      },
                    ]
                  : []
              }
            />
          </div>
        </div>
      </div>
    )
  } else if (wide) {
    shape = (
      <div className="flex min-w-0 flex-col gap-2.5">
        {composition}
        {lateRow}
      </div>
    )
  } else if (tall) {
    shape = composition
  }

  const note = anchor
    ? [
        t('bento.my_work.units_note'),
        t('bento.my_work.dated_note', { dated: dated.length, count: queue.length }),
        capped.length > 0 ? t('bento.my_work.cap_note', { kinds: capped.join(', ') }) : '',
      ]
        .filter(Boolean)
        .join(' ')
    : wide || tall
      ? capped.length > 0
        ? t('bento.my_work.cap_note', { kinds: capped.join(', ') })
        : t('bento.my_work.kinds_note')
      : undefined

  return (
    <Cell
      span={span}
      dark
      label={t('bento.my_work.outstanding')}
      value={data.outstanding}
      foot={
        <>
          <Stat label={t('bento.my_work.late_units')} value={lateUnits} />
          <Stat label={t('bento.my_work.kinds_count')} value={segments.length} />
        </>
      }
      shape={shape ?? undefined}
      note={note}
    />
  )
}

/** WHAT IS LATE — queue ageing.

    An item's age is days since its due date, and only marks and cover carry
    one. A late submission and an undecided leave request are flagged with no
    date at all, so they are counted, kept out of every band, and named as
    undated on the card. That is the whole reason the matrix has a "no date"
    column instead of a tidier four.

    1x1  the count, and the oldest age there is one for.
    1x2  + the ageing rail: today, 1-7, 8-30, 30+ days late.
    2x1  + age x kind as a dense matrix, beside the figure.
    2x2  + the oldest individual items, named. Not "+ priority": the handler
         carries no priority field, and the card says so rather than deriving
         one from the kind. */
function OverdueCell({ span, data }: { span: CellSpan; data: MyWorkView }) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2
  const anchor = wide && tall

  const items = data.items
  const late = items.filter((i) => i.overdue)
  const midnight = localMidnight()

  /** Days late, for the late rows that carry a date. Cover flagged late is due
      today, which is nought days late and not a missing measurement. */
  const aged = late
    .map((i) => ({ item: i, days: daysOut(i.due, midnight) }))
    .filter((a): a is { item: WorkItem; days: number } => a.days !== null)
    .map((a) => ({ item: a.item, days: Math.max(0, -a.days) }))
  const undated = late.length - aged.length
  const oldest = aged.reduce((a, x) => Math.max(a, x.days), -1)

  const BANDS: { label: string; hit: (d: number) => boolean }[] = [
    { label: t('bento.my_work.age_today'), hit: (d) => d === 0 },
    { label: t('bento.my_work.age_week'), hit: (d) => d >= 1 && d <= 7 },
    { label: t('bento.my_work.age_month'), hit: (d) => d >= 8 && d <= 30 },
    { label: t('bento.my_work.age_old'), hit: (d) => d > 30 },
  ]

  const rail = (
    <AgeBands
      bands={BANDS.map((b) => ({
        label: b.label,
        value: aged.filter((a) => b.hit(a.days)).length,
      }))}
      srLabel={t('bento.my_work.age_sr')}
    />
  )

  /* Age x kind. The kinds are the ones that actually have a late row, in the
     order the handler emitted them, so the matrix is never padded out with
     empty rows to look fuller than the data is. */
  const lateKinds: string[] = []
  for (const i of late) if (!lateKinds.includes(i.kind)) lateKinds.push(i.kind)
  const grid = (
    <CountGrid
      cols={[...BANDS.map((b) => b.label), t('bento.my_work.age_undated')]}
      rows={lateKinds.map((k) => ({
        label: kindLabel(t, k),
        cells: [
          ...BANDS.map(
            (b) => aged.filter((a) => a.item.kind === k && b.hit(a.days)).length,
          ),
          late.filter((i) => i.kind === k && daysOut(i.due, midnight) === null).length,
        ],
      }))}
      srLabel={t('bento.my_work.grid_sr')}
    />
  )

  const oldestRows = [...aged]
    .sort((a, b) => b.days - a.days)
    .slice(0, 3)
    .map((a) => ({
      title: a.item.title,
      value: t('bento.my_work.days_late', { days: a.days }),
    }))

  const nothingLate = (
    <p className="text-[11.5px] leading-snug">{t('bento.my_work.none_late_list')}</p>
  )

  let shape: ReactNode = null
  if (late.length === 0) {
    if (wide || tall) shape = nothingLate
  } else if (anchor) {
    shape = (
      <div className="flex min-h-0 flex-col gap-3">
        {grid ?? rail}
        <Ranked
          head={t('bento.my_work.oldest_head')}
          rows={oldestRows}
          empty={t('bento.my_work.no_dated_late')}
        />
      </div>
    )
  } else if (wide) {
    shape = grid ?? rail
  } else if (tall) {
    shape = rail ?? nothingLate
  }

  const note = anchor
    ? [
        t('bento.my_work.no_priority'),
        undated > 0 ? t('bento.my_work.undated_note', { n: undated }) : '',
      ]
        .filter(Boolean)
        .join(' ')
    : wide || tall
      ? t('bento.my_work.of_items_note', { count: items.length })
      : undefined

  return (
    <Cell
      span={span}
      label={t('bento.my_work.overdue')}
      value={late.length}
      foot={
        <>
          <Stat
            label={t('bento.my_work.oldest')}
            value={oldest >= 0 ? t('bento.my_work.days_late', { days: oldest }) : '—'}
          />
          <Stat label={t('bento.my_work.of_listed')} value={items.length} />
        </>
      }
      shape={shape ?? undefined}
      note={note}
    />
  )
}

/** SECTIONS — one number, made dense by HIERARCHY rather than by a chart.

    `sections` is the count of sections this teacher is scoped to. This
    response carries no population to put it over, no history and no per
    section rows, so there is no drawing to make from it that would not have an
    invented base. What it does carry is the LIST that number governs, and
    where each row on that list came from: the handler scopes submissions,
    marks and cover by section, and leave and notices by account.

    So the larger sizes add real, directly-labelled counts of rows — not a bar
    of `sections` against something it was never measured against.

    1x1  the figure and what it governs.
    1x2  + the list split: section-scoped rows against account-scoped rows.
    2x1  the split beside the figure.
    2x2  + every kind on the list with its own row count. */
function SectionsCell({ span, data }: { span: CellSpan; data: MyWorkView }) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2
  const anchor = wide && tall

  const items = data.items
  const scoped = items.filter((i) => SECTION_KINDS.includes(i.kind)).length
  const own = items.length - scoped
  const perKind = byKind(items, () => 1, (k) => kindLabel(t, k))

  const split = (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.06em]" style={{ color: QUIET }}>
        {t('bento.my_work.rows_head')}
      </p>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Stat label={t('bento.my_work.scope_section')} value={scoped} />
        <Stat label={t('bento.my_work.scope_own')} value={own} />
      </div>
    </div>
  )

  let shape: ReactNode = null
  if (anchor) {
    shape = (
      <div className="flex min-w-0 flex-col gap-3">
        {split}
        {perKind.length > 0 && (
          <Ranked
            head={t('bento.my_work.rows_by_kind')}
            rows={perKind.map((s) => ({ title: s.label, value: String(s.value) }))}
          />
        )}
      </div>
    )
  } else if (wide || tall) {
    shape = split
  }

  const note = anchor
    ? t('bento.my_work.sections_note')
    : wide || tall
      ? t('bento.my_work.sections_caption')
      : undefined

  return (
    <Cell
      span={span}
      label={t('bento.my_work.sections')}
      value={data.sections}
      foot={
        !wide && !tall ? (
          <span className="text-[11px] leading-snug" style={{ color: QUIET }}>
            {t('bento.my_work.sections_caption')}
          </span>
        ) : undefined
      }
      shape={shape ?? undefined}
      note={note}
    />
  )
}

export default function BentoMyWork() {
  const t = useT()
  const { data, isLoading, error } = useQuery({
    queryKey: ['my-work'],
    queryFn: () => api.get<MyWorkView>('/api/v1/teaching/my-work'),
  })

  if (isLoading) return <div className="p-6 text-[13.5px] text-muted-foreground">{t('bento.my_work.loading')}</div>
  // A failed query renders an error, never an empty state that reads as a
  // fact: "0 outstanding" and "we could not ask" are not the same sentence.
  if (error) {
    return (
      <div className="p-6">
        <p className="rounded-[14px] border border-destructive/40 bg-card p-5 text-[13.5px] text-destructive">
          {t('bento.my_work.failed')}
        </p>
      </div>
    )
  }

  const d = data!

  return (
    <div className="p-6 sm:p-7">
      <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {t('bento.my_work.eyebrow')}
      </p>
      <h1 className="mt-1 text-[22px] font-semibold">{t('bento.my_work.title')}</h1>

      {/* Four columns, 20px gaps, one 2x2 anchor. The ids, sizes and indexes
          are the board's tiling and are not touched. */}
      <WidgetLayer dashboard="mywork">
      <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Widget id="outstanding" label={t('bento.my_work.outstanding')} size="large" index={0}>
          {(span) => <OutstandingCell span={span} data={d} />}
        </Widget>
        <Widget id="overdue" label={t('bento.my_work.overdue')} size="small" index={1}>
          {(span) => <OverdueCell span={span} data={d} />}
        </Widget>
        {/* Flat in the endpoint, not flat on the card: the number is one
            figure, and the sizes above 1x1 spend their room on the rows it
            governs rather than on a chart with an invented base. */}
        <Widget id="sections" label={t('bento.my_work.sections')} size="small" index={2}>
          {(span) => <SectionsCell span={span} data={d} />}
        </Widget>
      </div>
      </WidgetLayer>
    </div>
  )
}

export { OutstandingCell, OverdueCell, SectionsCell }
export type { MyWorkView }
