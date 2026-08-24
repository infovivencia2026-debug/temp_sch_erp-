import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useWidgetSize } from '@/lib/widget-size'

/* The editorial card vocabulary — see docs/BENTO_CARD_PATTERNS.md.

   Twelve drawings, one card shell, and a single colour rule: every mark is
   `currentColor`. The cell has already resolved its own ink — black on a pale
   tint, white on a dark one — so a drawing that inherits is correct on all
   twelve domain grounds, both default themes and all four shipped palettes
   without a branch anywhere in here. Nothing in this file names a colour.

   Tracks, grounds and the quiet end of a ramp are that same ink at low alpha,
   which is why they stay legible when the ink flips.

   `big` from the reference is deliberately not built: it is the figure at a
   larger size, and the figure already has a row of its own. Every drawing here
   has to add something the number does not. */

/** Ink at a given strength. The only colour expression in this file. */
const ink = (pct: number) => `color-mix(in srgb, currentColor ${pct}%, transparent)`

/** A finite number, or the fallback. Guards every drawing against NaN and
    Infinity, which arrive whenever an API field is null and something does
    arithmetic on it. Unguarded, `Math.max(0, Math.min(100, Math.round(NaN)))`
    is NaN — a clamp does not clamp a non-number — and that reached the DOM as
    the literal string "NaN%". */
const num = (v: unknown, fallback = 0) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/** Does this series carry any signal at all? An all-zero series is not a small
    series: `Math.max(...values) || 1` turns it into a denominator of 1, and the
    per-mark minimum heights then draw a visible mark for every zero — a month
    with no activity reading as a month of small activity. */
const hasSignal = (values: number[]) =>
  values.some((v) => Number.isFinite(v) && v !== 0)

const MARK = ink(88)
const TRACK = ink(10)
const QUIET = ink(38)

/* ── the shell ─────────────────────────────────────────────────────────── */

/** The three-row card: header, figure, drawing.

    The drawing row is `minmax(0,1fr)` so it takes whatever is left rather than
    a fixed height — that is what stops a large cell being a small cell with
    dead space under it. `min-h-0` on the row is load-bearing: without it a
    grid child refuses to shrink below its content and the drawing pushes the
    card out of shape. */
export function CardShell({
  title, sub, action, value, change, children, className,
}: {
  title: string
  sub?: string
  /** Accepted and ignored: the decorative corner glyph is no longer drawn.
      Kept so the twenty-odd call sites do not all have to change at once. */
  glyph?: ReactNode
  /** The thing this card opens. Sits at the foot of the card, on the left. */
  action?: { label: string; onActivate?: () => void }
  value: ReactNode
  change?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    /* FOUR rows: header, figure, drawing, action.

       The action was in the top-right corner. It is at the foot of the card
       now, on the left, and it has a row of its own rather than sitting over
       the drawing — text and buttons never overlap the stats, and a button
       floating on top of a chart is exactly that.

       The drawing row is still the only fraction, so it keeps taking whatever
       height is left; the action row is `auto` and costs only what it needs. */
    <div
      className={cn(
        /* The drawing row has a FLOOR now. Adding the action row left it 28px on a
           one-row cell — measured — and a two-line breakdown needs 31, so every
           mini-chart on the board was sliced by `overflow: hidden` into the
           half-rendered ghosts that look worse than no chart at all. The floor
           is container-relative so it grows with the cell, and it is well under
           what a 1x1 can spare: 33 + 57 + 46 + 26 = 162 of 185. */
        /* The drawing yields, not the button. A control has to be readable at
           every size, and the figure has to be legible — so on a short cell the
           chart is what shrinks. Its floor is 30px: enough for two compressed
           rows, and below that a drawing is a ghost anyway and says less than
           the sentence it displaced. */
        'grid h-full min-h-0 grid-rows-[auto_auto_minmax(clamp(30px,22cqh,220px),1fr)_auto]',
        className,
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-bold leading-tight text-[length:var(--card-title,13px)]">
            {title}
          </p>
          {sub && (
            <p className="mt-0.5 truncate font-medium uppercase tracking-[0.08em] opacity-60
                          text-[length:var(--card-sub,10px)]">
              {sub}
            </p>
          )}
        </div>
        {/* The corner glyph is gone. It was one character — %, Rs, #, !, +, / —
            that named the card's domain, which the title already does, and it
            linked nowhere. `/` and `+` meant nothing at all. The prop stays in
            the signature so no caller breaks; it simply is not drawn. */}
      </div>

      <div className="mt-1.5 min-w-0">
        {/* A placeholder is not a figure. When there is no number the cell
            passes an em dash, and at the figure's own size that renders as a
            wide white bar — which reads as a broken chart rather than as "no
            data". It is set down to the supporting size and muted, so the
            sentence beneath it becomes the thing you read. */}
        <p
          className={cn(
            'truncate pb-[0.06em] font-semibold tracking-[-0.05em] tabular-nums',
            value === '—'
              ? 'leading-tight opacity-45 text-[length:var(--card-change,13px)]'
              : 'leading-[0.95] text-[length:var(--card-fig,30px)]',
          )}
        >
          {value}
        </p>
        {/* Two lines, not an ellipsis. This is the sentence that carries the
            reading — "12% of billed, owed by 30 students" — and truncating it
            cut the half that says who. */}
        {change && (
          <p className="mt-1 line-clamp-2 leading-tight opacity-65
                        text-[length:var(--card-change,11px)]">
            {change}
          </p>
        )}
      </div>

      <div className="mt-1.5 min-h-0 min-w-0 overflow-hidden">{children}</div>

      {action && (
        <div className="mt-1.5 flex min-w-0 shrink-0 justify-start">
          {/* A real control, sized to be pressed. It was the smallest text on
              the card at 11px in a 2px-padded chip — a footnote wearing a
              border. */}
          <span
            className="inline-flex max-w-full items-center gap-1.5 rounded-[10px] border
                       px-3.5 py-[0.6em] font-semibold text-[length:var(--card-action,15px)]"
            style={{ borderColor: ink(34), background: ink(8) }}
          >
            <span className="truncate">{action.label}</span>
            <span aria-hidden="true" className="opacity-70">↗</span>
          </span>
        </div>
      )}
    </div>
  )
}

/* ── drawings ──────────────────────────────────────────────────────────── */

function svgPath(points: number[], h = 150, w = 400) {
  const lo = Math.min(...points)
  const hi = Math.max(...points)
  const range = hi - lo || 1
  return points
    .map((v, i) => {
      const x = (i * w) / (points.length - 1 || 1)
      const y = h - 5 - ((v - lo) / range) * (h - 20)
      return `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}

/** Trend. An open path, nothing under it. */
export function Line({ points, srLabel }: { points: number[]; srLabel: string }) {
  if (points.length < 2 || !hasSignal(points)) return null
  return (
    <svg viewBox="0 0 400 150" preserveAspectRatio="none" className="h-full w-full"
         role="img" aria-label={srLabel}>
      <path d={svgPath(points)} fill="none" stroke={MARK} strokeWidth={2.5}
            strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** Magnitude and trend: the same line with the ground filled beneath it. */
export function Area({ points, srLabel }: { points: number[]; srLabel: string }) {
  if (points.length < 2 || !hasSignal(points)) return null
  const d = svgPath(points)
  return (
    <svg viewBox="0 0 400 150" preserveAspectRatio="none" className="h-full w-full"
         role="img" aria-label={srLabel}>
      <path d={`${d} L 400 150 L 0 150 Z`} fill={ink(14)} stroke="none" />
      <path d={d} fill="none" stroke={MARK} strokeWidth={2.5}
            strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** Period comparison. Bottom-aligned, rounded tops. */
export function Bars({ values, activeIndex, srLabel }: {
  values: number[]; activeIndex?: number; srLabel: string
}) {
  if (!values.length || !hasSignal(values)) return null
  const hi = Math.max(...values) || 1
  return (
    <div className="flex h-full items-end gap-1" role="img" aria-label={srLabel}>
      {values.map((v, i) => (
        <span key={i} className="min-w-0 flex-1 rounded-t-[3px]"
              style={{
                height: `${Math.max(3, (v / hi) * 100)}%`,
                background: activeIndex === undefined || i === activeIndex ? MARK : QUIET,
              }} />
      ))}
    </div>
  )
}

/** Ranked composition: label, track, figure. The bars share one scale. */
export function Rows({ items, srLabel, formatValue }: {
  items: { label: string; value: number }[]
  srLabel: string
  formatValue?: (n: number) => string
}) {
  const { h } = useWidgetSize()
  if (!items.length || !hasSignal(items.map((i) => i.value))) return null
  /* FEWER ROWS ON A SHORT CELL, not all of them squeezed.

     Four rows in a one-row cell gave each about seven pixels: the labels
     collided with their own values and the whole thing read as a smear. A
     drawing that cannot be read is not a smaller drawing, it is a worse one —
     so a short cell shows the top two and a tall one shows five. The rows are
     already ranked, so what survives is what matters most, and the tail is
     gathered by the caller rather than silently dropped here. */
  const room = h >= 2 ? 5 : 2
  const shown = items.slice(0, room)
  const hi = Math.max(...items.map((i) => i.value)) || 1
  const fmt = formatValue ?? ((n: number) => String(n))
  return (
    /* The rows SHARE the height rather than each taking a fixed 12px and the
       first one falling off the top. Three fixed rows need ~54px and the
       drawing row can be 46, so the top row was silently cut — which is the
       white rule that appeared to slice through the card's own sentence.
       `flex-1 min-h-0` on each row makes them compress evenly instead. */
    <div className="flex h-full min-h-0 flex-col justify-end gap-0.5" role="img" aria-label={srLabel}>
      {shown.map((it) => (
        <div key={it.label}
             className="grid min-h-0 flex-1 grid-cols-[minmax(38px,auto)_minmax(0,1fr)_auto]
                        items-center gap-1.5">
          <span className="truncate text-[length:min(9px,var(--card-note,9px))] font-medium
                           uppercase leading-none tracking-[0.05em] opacity-70">
            {it.label}
          </span>
          <span className="h-[min(10px,100%)] overflow-hidden rounded-[3px]"
                style={{ background: TRACK }}>
            <span className="block h-full rounded-[3px]"
                  style={{ width: `${Math.min(100, (it.value / hi) * 100)}%`, background: MARK }} />
          </span>
          <b className="text-[length:min(10px,var(--card-note,10px))] font-bold leading-none
                        tabular-nums">{fmt(it.value)}</b>
        </div>
      ))}
    </div>
  )
}

/** One proportion, as a stroked arc. Needs a real total.

    Drawn as an SVG stroke rather than a conic-gradient with a disc punched out
    of the middle. The punched version had to paint that disc SOME colour, and
    it painted `--bento-card` — correct on a paper cell and wrong on every
    other one. On a domain-tinted card it showed a paper-coloured hole; on an
    inverted cell a pale disc on a dark ground. A stroke has no hole to fill,
    so the ground shows through whatever the ground happens to be.

    The arc opens at twelve o'clock and runs clockwise. `pathLength` is set to
    100 so the dash array is literally the percentage — no circumference
    arithmetic to get wrong when the radius changes. */
export function Gauge({ value, total, srLabel }: { value: number; total: number; srLabel: string }) {
  const t = num(total)
  if (t <= 0) return null
  const pct = Math.max(0, Math.min(100, Math.round((num(value) / t) * 100)))
  return (
    <div className="grid h-full place-items-center" role="img" aria-label={srLabel}>
      {/* Sized by the row's HEIGHT, not its width. A drawing row on a 1x1 is
          about 69px tall while the card is 264px wide, so a ring measured
          against the width overflowed the row and had its bottom sliced off by
          the cell's `overflow: hidden`. `h-full` with a square aspect makes the
          height the binding constraint, which is the one that is short. */}
      <div className="relative grid aspect-square h-full max-h-[104px] place-items-center">
        <svg viewBox="0 0 100 100" className="absolute inset-0 size-full -rotate-90">
          <circle cx="50" cy="50" r="42" fill="none" stroke={TRACK} strokeWidth={11} />
          {pct > 0 && (
            <circle
              cx="50" cy="50" r="42" fill="none"
              stroke={MARK} strokeWidth={11} strokeLinecap="round"
              pathLength={100}
              strokeDasharray={`${pct} ${100 - pct}`}
            />
          )}
        </svg>
        <span className="relative text-[13px] font-semibold tabular-nums">{pct}%</span>
      </div>
    </div>
  )
}

/** Composition over periods: columns split into segments. */
export function Stack({ columns, srLabel }: {
  columns: { total: number; parts: number[] }[]; srLabel: string
}) {
  if (!columns.length || !hasSignal(columns.map((c) => c.total))) return null
  const hi = Math.max(...columns.map((c) => c.total)) || 1
  return (
    <div className="flex h-full items-end gap-1.5" role="img" aria-label={srLabel}>
      {columns.map((c, i) => (
        <span key={i} className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-t-[3px]"
              style={{ height: `${Math.max(4, (c.total / hi) * 100)}%` }}>
          {c.parts.map((p, j) => (
            <span key={j} style={{
              height: `${(p / (c.total || 1)) * 100}%`,
              background: ink(88 - j * 26),
            }} />
          ))}
        </span>
      ))}
    </div>
  )
}

/** Spread. Bars whose heights describe a curve rather than a ranking. */
export function Distribution({ values, srLabel }: { values: number[]; srLabel: string }) {
  if (!values.length || !hasSignal(values)) return null
  const hi = Math.max(...values) || 1
  return (
    <div className="flex h-full items-end gap-1" role="img" aria-label={srLabel}>
      {values.map((v, i) => (
        <span key={i} className="min-w-0 flex-1 rounded-t-[3px]"
              style={{ height: `${Math.max(3, (v / hi) * 100)}%`, background: MARK }} />
      ))}
    </div>
  )
}

/** Two labelled tracks against one scale — plan over actual. */
export function Compare({ rows, srLabel, formatValue }: {
  rows: { label: string; value: number }[]
  srLabel: string
  formatValue?: (n: number) => string
}) {
  if (rows.length < 2 || !hasSignal(rows.map((r) => r.value))) return null
  const hi = Math.max(...rows.map((r) => r.value)) || 1
  const fmt = formatValue ?? ((n: number) => String(n))
  return (
    <div className="flex h-full flex-col justify-center gap-2" role="img" aria-label={srLabel}>
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[minmax(34px,auto)_minmax(0,1fr)_auto] items-center gap-1.5">
          <span className="truncate text-[8px] font-medium uppercase tracking-[0.06em] opacity-70">
            {r.label}
          </span>
          <span className="h-3.5 overflow-hidden rounded-[3px]" style={{ background: TRACK }}>
            <span className="block h-full rounded-[3px]"
                  style={{ width: `${(r.value / hi) * 100}%`, background: MARK }} />
          </span>
          <b className="text-[9px] font-bold tabular-nums">{fmt(r.value)}</b>
        </div>
      ))}
    </div>
  )
}

/** A part inside its whole: one track, not two bars.

    Collected is a SUBSET of billed, and Compare drew them as two independent
    tracks against a shared maximum. That is arithmetically honest and visually
    useless: at 87.7% collected the two bars differ by an eighth of their length,
    so a principal sees two near-identical lines and learns nothing the two
    numbers beside them had not already said.

    A part of a whole is one bar. The fill is what came in, the remainder is what
    has not — and the remainder is the thing somebody is actually looking for,
    because it is the money still outside the building. It is drawn, labelled and
    given its own figure rather than left as the absence of ink. */
export function PartOf({ part, whole, partLabel, wholeLabel, gapLabel, formatValue, srLabel }: {
  part: number
  whole: number
  partLabel: string
  wholeLabel: string
  gapLabel: string
  formatValue?: (n: number) => string
  srLabel: string
}) {
  const w = num(whole)
  if (w <= 0) return null
  const p = Math.max(0, Math.min(num(part), w))
  const pct = Math.round((p / w) * 100)
  const fmt = formatValue ?? ((n: number) => String(n))
  const gap = w - p

  return (
    <div className="flex h-full flex-col justify-center gap-1.5" role="img" aria-label={srLabel}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[8px] font-medium uppercase tracking-[0.06em] opacity-70">
          {partLabel}
        </span>
        <b className="text-[9px] font-bold tabular-nums">{fmt(p)}</b>
      </div>

      <span className="relative block h-3.5 overflow-hidden rounded-[3px]" style={{ background: TRACK }}>
        <span className="block h-full rounded-[3px]" style={{ width: `${pct}%`, background: MARK }} />
      </span>

      {/* The shortfall, named. Without this the empty end of the track is just
          empty, and the one number a principal came for is the one nobody
          printed. */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[8px] font-medium uppercase tracking-[0.06em] opacity-70">
          {gap > 0 ? gapLabel : wholeLabel}
        </span>
        <b className="text-[9px] font-bold tabular-nums opacity-80">
          {gap > 0 ? fmt(gap) : fmt(w)}
        </b>
      </div>
    </div>
  )
}

/** Facts: the numbers around the headline figure, set as a list.

    This replaces the dot field, and replacing it with another PICTURE was the
    wrong instinct. Nearly every cell that used it passed
    `Array.from({length: n}, () => 1)` — every mark identical — so the drawing
    had no variation in it and could only restate the count already printed
    above. Dots, blocks and a segmented rail were all faithful renderings of
    nothing, which is why each one in turn read as uninformative.

    A cell whose data is one number does not have a chart in it. What it has is
    context: the figures beside the headline that say what the number is made
    of, or what it is a part of. Those are real, they are already fetched, and
    set as a list they fill the row with something worth reading.

    Right-aligned values on a tabular figure so a column of them lines up. */
export function Facts({ items, srLabel }: {
  items: { label: string; value: string }[]
  srLabel: string
}) {
  if (!items.length) return null
  return (
    /* The rows SHARE the row's height rather than stacking at the bottom of
       it. Pinned to the end, one fact left the whole drawing row empty above
       it — the dead space this component exists to remove. `flex-1` on each
       line means one fact fills the row and four split it. */
    <dl className="flex h-full flex-col gap-1" role="img" aria-label={srLabel}>
      {items.map((f) => (
        <div key={f.label}
             className="flex flex-1 items-center justify-between gap-2 border-t pt-1"
             style={{ borderColor: TRACK }}>
          <dt className="truncate text-[8.5px] font-medium uppercase tracking-[0.07em] opacity-65">
            {f.label}
          </dt>
          <dd className="shrink-0 text-[11px] font-bold tabular-nums">{f.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Pipeline. Bars narrowing downward, each labelled beside its own bar.

    The label sits OUTSIDE the bar. Inside, it had to be drawn in the cell's
    background colour to read against the fill, and the only token available
    for that was `--bento-card` — paper. Correct on a paper cell, wrong on a
    domain-tinted one and wrong on an inverted one, which is the same mistake
    the punched gauge made. Outside the bar the label is ordinary ink and needs
    to know nothing about the ground. */
export function Funnel({ stages, srLabel, formatValue }: {
  stages: { label: string; value: number }[]
  srLabel: string
  formatValue?: (n: number) => string
}) {
  if (!stages.length || !hasSignal(stages.map((s) => s.value))) return null
  const hi = Math.max(...stages.map((s) => s.value)) || 1
  const fmt = formatValue ?? ((n: number) => String(n))
  return (
    <div className="flex h-full flex-col justify-end gap-1" role="img" aria-label={srLabel}>
      {stages.map((s) => (
        <div key={s.label} className="flex items-center gap-1.5">
          <span className="h-3 min-w-0 flex-1">
            <span className="block h-full rounded-[3px]"
                  style={{ width: `${Math.max(6, (s.value / hi) * 100)}%`, background: MARK }} />
          </span>
          <b className="shrink-0 text-[9px] font-bold tabular-nums">{fmt(s.value)}</b>
        </div>
      ))}
    </div>
  )
}

/** One value placed in its range: a hairline with a single dot on it. */
export function Scale({ value, min, max, srLabel }: {
  value: number; min: number; max: number; srLabel: string
}) {
  const lo = num(min), hi = num(max)
  if (hi <= lo || !Number.isFinite(value)) return null
  const pct = Math.max(0, Math.min(100, ((value - lo) / (hi - lo)) * 100))
  return (
    <div className="flex h-full items-center" role="img" aria-label={srLabel}>
      <span className="relative block h-px w-full" style={{ background: ink(45) }}>
        <span className="absolute top-1/2 size-[10px] -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ left: `${pct}%`, background: MARK }} />
      </span>
    </div>
  )
}

/** Movement between states: short dashes, each row indented from the last. */
export function Flow({ rows, srLabel }: { rows: number[]; srLabel: string }) {
  if (!rows.length) return null
  return (
    <div className="flex h-full flex-col justify-center gap-2" role="img" aria-label={srLabel}>
      {rows.map((n, i) => (
        /* Capped. This built one span per unit with no ceiling, so a paise
           amount handed to it by mistake threw `RangeError: Invalid array
           length` and took the whole dashboard down with it — and well short
           of throwing, 100k rendered 100k DOM nodes. */
        <div key={i} className="flex gap-1" style={{ paddingLeft: `${i * 16}px` }}>
          {Array.from({ length: Math.min(24, Math.max(0, Math.floor(num(n)))) }, (_, j) => (
            <span key={j} className="h-1.5 w-3 rounded-full" style={{ background: MARK }} />
          ))}
        </div>
      ))}
    </div>
  )
}
