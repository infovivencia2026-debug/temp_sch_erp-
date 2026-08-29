import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useWidgetSize } from '@/lib/widget-size'
import { WidgetLayer, Widget } from './WidgetLayer'
import { type CellSpan } from './bento-kit'
import { CardShell, Compare, Facts, Distribution, Rows, Nil } from './bento-cards'

/* MY WORK, IN THE EDITORIAL CARD LANGUAGE.

   Three cells, each one `CardShell` — header, figure, drawing — with the
   drawing in the row that takes ALL the remaining height, and every drawing
   one of the twelve in `bento-cards.tsx`. docs/BENTO_CARD_PATTERNS.md is the
   contract. Nothing here names a colour: every mark is `currentColor`, which
   is the only reason the same drawings read on the inverted anchor and on the
   paper cards beside it.

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

   THREE CONSEQUENCES, AND EVERY DRAWING BELOW FOLLOWS FROM THEM.

   1. THE COUNTS ARE IN DIFFERENT UNITS. Eleven missing marks, one cover
      lesson and four notices are not eleven, one and four of anything.
      COMPOSITION by kind is honest — it partitions the printed total and the
      parts sum back to it, which is what the `Rows` on the outstanding cell
      is captioned as and what its note says out loud. A ranking that declared
      a winner across those kinds would not be, so nothing here calls one:
      the only rankings drawn are WITHIN one unit — marks papers against marks
      papers, late ITEMS against late items, days late against days late.

   2. THERE IS NO PRIORITY FIELD. `workItem` has kind, title, detail, count,
      due, overdue, link and nothing else, so no severity ladder is derived
      from the kind and the overdue cell says so.

   3. THERE IS NO HISTORY. No previous period, no series — so no `Line`, no
      `Area` and no change figure anywhere on this board.

   THE LIST IS CAPPED SERVER-SIDE. Marks and cover are each `LIMIT 10` in
   faculty_work.go. When a kind comes back at exactly ten rows the cell prints
   that its figures are a floor, because ten is also what "exactly ten" looks
   like.

   NO FABRICATED DENOMINATORS. Nothing on this board is drawn as a share of a
   population this response does not carry — which is why the sections cell
   draws a `Density` of the sections themselves and not a gauge. */

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

/** Frequencies by kind, in first-seen order rather than by size, so a row does
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

/** One cell: the board's ground around the pattern file's shell.

    The ground stays on tokens — `bg-foreground text-background` for the one
    inverted cell, `bg-card text-card-foreground` for the rest — and every
    drawing inside inherits that resolved ink through `currentColor`.

    THE HEIGHT BUDGET. A one-row cell is 172px, and a 38px figure plus a
    second header line leaves the drawing row about thirty pixels. So on a
    one-row cell the figure is set to 26px through `--bento-fig` — the token
    the shell's figure reads — and the second header line is dropped. The
    drawing row gets the difference. */
function Card({
  span, dark, title, sub, glyph, value, change, children,
}: {
  span?: CellSpan
  dark?: boolean
  title: string
  sub?: string
  glyph?: ReactNode
  value: ReactNode
  change?: ReactNode
  children?: ReactNode
}) {
  const { h } = useWidgetSize()
  const tall = h >= 2
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-[14px] border p-4',
        tall ? '' : '[--bento-fig:26px]',
        /* Every span, not just the one this file happened to use. Widening
           the prop's TYPE without widening this ternary is the worse of the
           two bugs: 'wide' and 'full' type-check, the arranger offers them,
           and the card silently stays 1x1. */
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

/** A titled drawing that keeps the title out of the drawing's own height. */
function Titled({ head, children }: { head: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <p className="mb-1 truncate text-[length:var(--card-sub,8.5px)] font-normal uppercase leading-none tracking-[0.04em] opacity-55">
        {head}
      </p>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}

/** A sentence in the drawing row — the state a drawing must not be drawn in.
    "Nothing is late" is a fact; an empty chart is not a way of saying it. */
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

// --- the three cells ----------------------------------------------------

/** EVERYTHING OUTSTANDING — the queue, on the inverted ground.

    figure  the handler's own `outstanding`: every item's count, less leave
            already decided.
    1x1     `Rows` — the composition by kind. Each row prints its own count
            and the parts sum to the figure above them.
    2x1     + `Distribution` of when the dated work falls due, beside it.
    1x2     the same two, stacked, with the composition given the height for
            all five kinds.
    2x2     + `Rows` of the marks papers against each other — the one ranking
            in this payload that compares like with like, every row a count of
            marks missing on one paper.

    THE COMPOSITION IS A COMPOSITION, NOT A LEAGUE TABLE. The counts are in
    different units across kinds, so the rows are captioned as parts of the
    figure and the note says which unit each part is in. */
function OutstandingCell({ span, data }: { span: CellSpan; data: MyWorkView }) {
  const t = useT()
  const { w, h } = useWidgetSize()
  const wide = w >= 2
  const tall = h >= 2
  const anchor = wide && tall

  /* Counted exactly as the handler counts `outstanding`: every item's count,
     except a leave request already decided. Any other rule here would draw
     parts that do not sum to the figure above them. */
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

  // Three rows is what a 1x1's drawing row holds; the taller cards hold all
  // five. Cut by size rather than drawn at three pixels a row.
  const composition = segments.length === 0 ? (
    <Say>{t('bento.my_work.empty_queue')}</Say>
  ) : (
    <Titled head={t('bento.my_work.by_kind_head')}>
      <Rows
        items={anchor || tall ? segments : segments.slice(0, 3)}
        srLabel={t('bento.my_work.kinds_sr')}
      />
    </Titled>
  )

  const dueBands = dated.length === 0 ? (
    <Say>{t('bento.my_work.no_dates_at_all')}</Say>
  ) : (
    <Titled head={t('bento.my_work.due_head')}>
      <Distribution
        values={[
          dated.filter((d) => d < 0).length,
          dated.filter((d) => d === 0).length,
          dated.filter((d) => d >= 1 && d <= 7).length,
          dated.filter((d) => d > 7).length,
        ]}
        srLabel={t('bento.my_work.due_sr')}
      />
    </Titled>
  )

  /* THE ONLY HONEST RANKING IN THIS PAYLOAD. Marks rows all count the same
     thing — marks missing on one paper — so the biggest of them is a real
     largest queue. Cover rows are all 1, and submissions, leave and notices
     are one row each in a unit of their own, so there is nothing else here to
     rank without comparing unlike things. */
  const marks = data.items
    .filter((i) => i.kind === 'marks')
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 4)
    .map((i) => ({ label: i.title, value: i.count }))

  let drawing: ReactNode = composition
  if (anchor) {
    drawing = (
      <Split>
        <Part grow={2}>
          <Split row>
            <Part>{composition}</Part>
            <Part>{dueBands}</Part>
          </Split>
        </Part>
        <Part grow={2}>
          {marks.length > 0 ? (
            <Titled head={t('bento.my_work.largest_head')}>
              <Rows items={marks} srLabel={t('bento.my_work.marks_sr')} />
            </Titled>
          ) : (
            <Say>{t('bento.my_work.largest_none')}</Say>
          )}
        </Part>
      </Split>
    )
  } else if (wide) {
    drawing = (
      <Split row>
        <Part grow={2}>{composition}</Part>
        <Part>{dueBands}</Part>
      </Split>
    )
  } else if (tall) {
    drawing = (
      <Split>
        <Part grow={2}>{composition}</Part>
        <Part>{dueBands}</Part>
      </Split>
    )
  }

  const change = [
    t('bento.my_work.late_of', { late: lateUnits, kinds: segments.length }),
    anchor ? t('bento.my_work.units_note') : '',
    anchor ? t('bento.my_work.dated_note', { dated: dated.length, count: queue.length }) : '',
    (wide || tall) && capped.length > 0
      ? t('bento.my_work.cap_note', { kinds: capped.join(', ') })
      : '',
  ].filter(Boolean).join(' ')

  return (
    <Card
      span={span}
      dark
      title={t('bento.my_work.outstanding')}
      sub={t('bento.my_work.on_you')}
      glyph="•"
      value={data.outstanding}
      change={change}
    >
      {drawing}
    </Card>
  )
}

/** WHAT IS LATE — the ageing of the queue.

    An item's age is days since its due date, and only marks and cover carry
    one. A late submission and an undecided leave request are flagged with no
    date at all, so they are counted, kept out of every band, and named as
    undated on the card.

    figure  late ROWS, which is one unit however many units their counts are.
    1x1     `Distribution` — the age curve: today, 1-7d, 8-30d, 30d+.
    2x1     + `Rows` of late rows by kind beside it. Rows, not counts: one
            late paper and one late cover lesson are two late things, and that
            is a comparison that holds.
    1x2     the same two, stacked.
    2x2     + `Rows` of the oldest individual items, in days late — again one
            unit down the whole column. */
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

  const BANDS: ((d: number) => boolean)[] = [
    (d) => d === 0,
    (d) => d >= 1 && d <= 7,
    (d) => d >= 8 && d <= 30,
    (d) => d > 30,
  ]

  const curve = aged.length === 0 ? (
    <Say>{late.length === 0 ? t('bento.my_work.none_late_list') : t('bento.my_work.no_dated_late')}</Say>
  ) : (
    <Titled head={t('bento.my_work.age_head')}>
      <Distribution
        values={BANDS.map((hit) => aged.filter((a) => hit(a.days)).length)}
        srLabel={t('bento.my_work.age_sr')}
      />
    </Titled>
  )

  // Late ROWS per kind. Rows are comparable to rows; the `count` fields are
  // not comparable to each other, so they are not what is summed here.
  const perKind = byKind(late, () => 1, (k) => kindLabel(t, k))
  const kinds = perKind.length === 0 ? (
    <Say>{t('bento.my_work.none_late_list')}</Say>
  ) : (
    <Titled head={t('bento.my_work.late_rows_head')}>
      <Rows items={perKind} srLabel={t('bento.my_work.late_kind_sr')} />
    </Titled>
  )

  const oldestRows = [...aged]
    .sort((a, b) => b.days - a.days)
    .slice(0, 4)
    .map((a) => ({ label: a.item.title, value: a.days }))

  let drawing: ReactNode = curve
  if (anchor) {
    drawing = (
      <Split>
        <Part>
          <Split row>
            <Part>{curve}</Part>
            <Part>{kinds}</Part>
          </Split>
        </Part>
        <Part>
          {oldestRows.length > 0 ? (
            <Titled head={t('bento.my_work.oldest_head')}>
              <Rows
                items={oldestRows}
                formatValue={(n) => t('bento.my_work.days_late', { days: n })}
                srLabel={t('bento.my_work.oldest_sr')}
              />
            </Titled>
          ) : (
            <Say>{t('bento.my_work.no_dated_late')}</Say>
          )}
        </Part>
      </Split>
    )
  } else if (wide) {
    drawing = (
      <Split row>
        <Part>{curve}</Part>
        <Part>{kinds}</Part>
      </Split>
    )
  } else if (tall) {
    drawing = (
      <Split>
        <Part>{curve}</Part>
        <Part>{kinds}</Part>
      </Split>
    )
  }

  const change = [
    oldest >= 0
      ? t('bento.my_work.oldest_of', { days: oldest, count: items.length })
      : t('bento.my_work.of_items_note', { count: items.length }),
    undated > 0 && (wide || tall) ? t('bento.my_work.undated_note', { n: undated }) : '',
    anchor ? t('bento.my_work.no_priority') : '',
  ].filter(Boolean).join(' ')

  return (
    <Card
      span={span}
      title={t('bento.my_work.overdue')}
      sub={t('bento.my_work.late_rows_sub')}
      glyph="!"
      value={late.length}
      change={change}
    >
      {drawing}
    </Card>
  )
}

/** SECTIONS — one number, made dense by HIERARCHY rather than by an invented
    chart.

    `sections` is the count of sections this teacher is scoped to. This
    response carries no population to put it over, no history and no per
    section rows, so nothing here is drawn as a share of anything.

    figure  the count.
    1x1     `Density` — one dot per section. A picture of the count itself,
            with no denominator anywhere in it.
    2x1     + `Rows` of the work list by kind, counted in ROWS — one unit down
            the column, and the list this number governs.
    1x2     the same two, stacked.
    2x2     + `Compare`: rows the handler scoped by section against rows it
            scoped by account. Two tracks, one unit, both real. */
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
  const n = Math.max(0, Math.floor(data.sections))

  const dots = n === 0 ? (
    <Say>{t('bento.my_work.no_sections')}</Say>
  ) : (
    /* Was a dot per section — sixty identical marks that said nothing the
       figure above had not. These three numbers are already in hand and
       actually divide the work up. */
    <Facts
      srLabel={t('bento.my_work.sections_sr', { count: n })}
      items={[
        { label: t('bento.my_work.fact_sections'), value: String(n) },
        { label: t('bento.my_work.fact_scoped'), value: String(scoped) },
        { label: t('bento.my_work.fact_own'), value: String(own) },
      ]}
    />
  )

  const rowsByKind = perKind.length === 0 ? (
    <Say>{t('bento.my_work.empty_queue')}</Say>
  ) : (
    <Titled head={t('bento.my_work.rows_by_kind')}>
      <Rows items={perKind} srLabel={t('bento.my_work.rows_kind_sr')} />
    </Titled>
  )

  const scopeSplit = items.length === 0 ? null : (
    <Titled head={t('bento.my_work.rows_head')}>
      <Compare
        rows={[
          { label: t('bento.my_work.scope_section'), value: scoped },
          { label: t('bento.my_work.scope_own'), value: own },
        ]}
        srLabel={t('bento.my_work.scope_sr')}
      />
    </Titled>
  )

  let drawing: ReactNode = dots
  if (anchor) {
    drawing = (
      <Split>
        <Part>
          <Split row>
            <Part>{dots}</Part>
            <Part grow={2}>{rowsByKind}</Part>
          </Split>
        </Part>
        {scopeSplit && <Part>{scopeSplit}</Part>}
      </Split>
    )
  } else if (wide) {
    drawing = (
      <Split row>
        <Part>{dots}</Part>
        <Part grow={2}>{rowsByKind}</Part>
      </Split>
    )
  } else if (tall) {
    drawing = (
      <Split>
        <Part>{dots}</Part>
        <Part grow={2}>{rowsByKind}</Part>
      </Split>
    )
  }

  const change = [
    t('bento.my_work.sections_caption'),
    anchor ? t('bento.my_work.sections_note') : '',
  ].filter(Boolean).join(' ')

  return (
    <Card
      span={span}
      title={t('bento.my_work.sections')}
      sub={t('bento.my_work.scoped_to')}
      glyph="•"
      value={n}
      change={change}
    >
      {drawing}
    </Card>
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
      <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-5">
        <Widget id="outstanding" label={t('bento.my_work.outstanding')} size="large" index={0}>
          {(span) => <OutstandingCell span={span} data={d} />}
        </Widget>
        <Widget id="overdue" label={t('bento.my_work.overdue')} size="small" index={1}>
          {(span) => <OverdueCell span={span} data={d} />}
        </Widget>
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
