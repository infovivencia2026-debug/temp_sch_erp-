import { Fragment, useId, type ReactNode } from 'react'
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
/* Is this string safe to set as a tracked, uppercased micro-label?

   The label treatment -- monospace, uppercase, 0.22em of letter-spacing -- is
   what gives the card its engineered look, and it is a Latin-script idea.
   Telugu is caseless, so `text-transform: uppercase` does nothing at all, and
   letter-spacing is actively destructive: it pulls apart the conjunct clusters
   that Telugu builds its consonants from, turning readable words into loose
   glyphs. The monospace stacks in this product carry no Telugu coverage
   either, so the browser would fall back mid-string and the label would come
   out in two different faces.

   So the treatment is applied only where it is correct. Anything with a
   character outside Latin-1 keeps proportional type at a size chosen to match
   optically -- which is the same label, set properly for its script. */
const LATIN_ONLY = /^[ -ɏ‐-›]*$/
const isLatin = (s: string) => LATIN_ONLY.test(s)

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
          {/* THE MICRO-LABEL. Monospace, uppercase, widely tracked and dim --
              the quiet voice that the figure below is loud against. The whole
              card reads as measured because these two are set as far apart as
              they can be: 0.22em of tracking here, negative tracking there.
              Set at 0.92em of the supporting size, because a tracked
              uppercase run occupies noticeably more width than the same
              string set proportionally and would otherwise truncate first. */}
          {sub && (
            <p
              className={cn(
                'mt-1 truncate opacity-55 text-[length:var(--card-sub,10px)]',
                isLatin(sub)
                  ? 'font-medium uppercase leading-none tracking-[0.22em] [font-family:var(--bento-mono)] [font-size:0.92em]'
                  : 'font-medium leading-tight',
              )}
            >
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
            /* THE FIGURE, thinned.

               It was semibold, which is the weight a heading takes -- and a
               heading is what it looked like. A large number set light with
               the letters pulled together reads as a measurement instead: the
               thin stroke is what makes the size feel like precision rather
               than emphasis.

               350 rather than the 300 of a display setting, because this
               clamps down to 26px on a one-by-one cell and a true light at
               that size on a dark ground goes thin enough to shimmer. Inter is
               a variable font here, so 350 is a real weight and not a
               synthesised one. */
            'truncate pb-[0.06em] tracking-[-0.035em] tabular-nums [font-weight:350]',
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
            className="inline-flex max-w-full items-center gap-1.5 rounded-[3px] border
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
/* SQUARE CORNERS THROUGHOUT, and it is not a style preference.

   Every measure in here is a length the reader compares against another
   length. A 3px radius on a track 5 to 10 pixels tall rounds a meaningful
   fraction of that length into a curve, and the eye reads the curve as part of
   the bar -- so two values that differ by a few percent draw as though they
   differ by more, and the shortest bar in any set rounds into a dot that says
   nothing about its own size. Rectangles are comparable; lozenges are not.

   The strokes are hairlines -- 1.4 and non-scaling -- for the matching reason.
   A 2.5 stroke that scales with the cell is a rope on a 2x2 board and covers
   the very wiggles it is drawn to show. */
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
/** The last point's coordinates, for the terminal dot.

    Mirrors svgPath's arithmetic exactly rather than re-deriving it, because two
    expressions that are meant to agree about where a line ends will not stay
    in agreement through the next edit to either. */
function lastPoint(points: number[], h = 150, w = 400) {
  const lo = Math.min(...points)
  const hi = Math.max(...points)
  const range = hi - lo || 1
  const v = points[points.length - 1]
  return { x: w, y: h - 5 - ((v - lo) / range) * (h - 20) }
}
/** Trend. An open path, nothing under it.

    THREE CHANGES that together make this read as an instrument rather than a
    sketch. The stroke is 1.4 rather than 2.5, and non-scaling, so it is a
    drawn hairline at every cell size instead of a rope that thickens as the
    card grows. A baseline sits under it, because a line with nothing beneath
    it floats and the eye has no datum to read height against. And the final
    point carries a filled dot: the value everybody actually wants off a trend
    is the latest one, and until now it was the end of a stroke like any
    other.

    The baseline is drawn at the foot of the viewBox rather than at zero. This
    series is scaled to its own min and max -- svgPath does that deliberately,
    so a flat-ish series still shows its shape -- which means zero is usually
    off the bottom of the picture. A rule labelled as an axis where zero is not
    would be a lie; this one is a floor, and reads as one. */
export function Line({ points, srLabel }: { points: number[]; srLabel: string }) {
  if (points.length < 2 || !hasSignal(points)) return null
  const end = lastPoint(points)
  return (
    <svg viewBox="0 0 400 150" preserveAspectRatio="none" className="h-full w-full"
         role="img" aria-label={srLabel}>
      <line x1="0" y1="149" x2="400" y2="149" stroke={ink(22)} strokeWidth={1}
            vectorEffect="non-scaling-stroke" />
      <path d={svgPath(points)} fill="none" stroke={MARK} strokeWidth={1.4}
            strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {/* preserveAspectRatio="none" stretches the viewBox, so a circle would
          come out an ellipse -- wide on a 2x1, tall on a 1x2. The dot is drawn
          as a rect sized in the stretched space it lands in, which is the only
          way to get a square mark out of a non-uniform scale without a second
          SVG. */}
      <rect x={end.x - 8} y={end.y - 3} width={8} height={6} fill={MARK} />
    </svg>
  )
}
/** Magnitude and trend: the same line with the ground filled beneath it. */
export function Area({ points, srLabel }: { points: number[]; srLabel: string }) {
  /* The gradient id must be UNIQUE PER INSTANCE, and getting this wrong is
     subtle enough to be worth the paragraph.

     A fixed id looked like sharing one definition between every Area on the
     board. It is not sharing: each instance emits its own <defs> with the same
     literal id into one document, and `url(#id)` resolves by getElementById --
     the FIRST match in document order. So every Area on the board was filled
     from the first Area's gradient. That would be invisible if the stops were
     a fixed colour, but they are `currentColor`, which in SVG resolves against
     the <stop>'s own inherited colour rather than against the path referencing
     it. Cards on this board have different ink -- black on a pale domain tint,
     white on a dark one -- so the second Area on a differently-inked card was
     washed in the first card's ink, and on an inverted cell that is a pale
     smear on a dark ground.

     useId is React's answer for exactly this: stable across the server and
     client renders of the same element, unique per instance. */
  const gradientID = `bento-area-${useId().replace(/:/g, '')}`
  if (points.length < 2 || !hasSignal(points)) return null
  const d = svgPath(points)
  return (
    <svg viewBox="0 0 400 150" preserveAspectRatio="none" className="h-full w-full"
         role="img" aria-label={srLabel}>
      {/* A flat wash under a line says "there is area here" and nothing more.
          A gradient that fades to nothing at the floor says where the mass
          is, and it is what stops the fill competing with the stroke for
          attention -- the stroke is the reading, the fill is its weight. */}
      <defs>
        <linearGradient id={gradientID} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="0" y1="149" x2="400" y2="149" stroke={ink(22)} strokeWidth={1}
            vectorEffect="non-scaling-stroke" />
      <path d={`${d} L 400 150 L 0 150 Z`} fill={`url(#${gradientID})`} stroke="none" />
      <path d={d} fill="none" stroke={MARK} strokeWidth={1.4}
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
    /* Square tops and a hairline floor.

       The rounded cap was 3px of radius on a bar that is often 4px wide, which
       rounds most of the mark away and makes a short bar read as a dot. Square
       also lets adjacent bars form a silhouette the eye can follow across the
       series, which is the whole point of putting them next to each other.

       The gap is 2px rather than 4: bars are a distribution, and a distribution
       reads as one shape with gaps in it, not as a row of separate objects. */
    <div
      className="flex h-full items-end gap-[2px] border-b"
      style={{ borderColor: ink(22) }}
      role="img"
      aria-label={srLabel}
    >
      {values.map((v, i) => (
        <span key={i} className="min-w-0 flex-1"
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
    /* ONE grid for every row, not one grid per row.
       Each row was its own three-column grid, so minmax(38px, auto) resolved
       against that row's OWN label: "Documents pending" made a 111px column
       and "Offered" a 43px one, which moved where each track started and how
       long it ran. Two bars both at 50% rendered 236px and 270px. Equal
       values drawn unequal is the one thing a bar chart must not do, and it
       is what made this read as ragged rather than as data.
       A single grid resolves the label column once, against the widest label,
       so every track begins at the same x and runs the same length. */
    <div
      className="grid h-full min-h-0 grid-cols-[minmax(38px,auto)_minmax(0,1fr)_auto]
                 content-end items-center gap-x-1.5 gap-y-0.5"
      style={{ gridTemplateRows: `repeat(${shown.length}, minmax(0, 1fr))` }}
      role="img"
      aria-label={srLabel}
    >
      {shown.map((it) => (
        <Fragment key={it.label}>
          {/* Same micro-label treatment as the card's own, and gated the same
              way -- a Telugu subject name here would be pulled apart by the
              tracking exactly as it would in the header. */}
          <span
            className={cn(
              'truncate text-[length:min(9px,var(--card-note,9px))] leading-none opacity-70',
              isLatin(it.label)
                ? 'font-medium uppercase tracking-[0.12em] [font-family:var(--bento-mono)]'
                : 'font-medium',
            )}
          >
            {it.label}
          </span>
          {/* Square. A 3px radius on a 5px-tall track rounds the ends into
              lozenges, and two lozenges of different lengths are harder to
              compare than two rectangles -- the eye reads the curve as part of
              the length. Thinner too: at 10px this was a bar chart competing
              with the figure above it, and it is meant to be a measure. */}
          <span className="h-[min(6px,100%)] overflow-hidden" style={{ background: TRACK }}>
            <span className="block h-full"
                  style={{ width: `${Math.min(100, (it.value / hi) * 100)}%`, background: MARK }} />
          </span>
          <b className="text-[length:min(10px,var(--card-note,10px))] leading-none
                        tabular-nums [font-weight:500]">{fmt(it.value)}</b>
          </Fragment>
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
          {/* Thinner, and cut square at both ends.

              An 11-unit stroke on a 42 radius is a quarter of the ring's own
              width -- a doughnut, not a dial. At 6 it reads as an arc drawn
              round the number, which is what leaves the number the loudest
              thing in the cell.

              The round cap went with it, and for a reason beyond taste: a
              round cap adds half the stroke width past the true end of the
              arc, so 2% drew as roughly 6% and 0.5% still drew a visible
              lozenge. A butt cap ends where the value ends. */}
          <circle cx="50" cy="50" r="44" fill="none" stroke={TRACK} strokeWidth={6} />
          {pct > 0 && (
            <circle
              cx="50" cy="50" r="44" fill="none"
              stroke={MARK} strokeWidth={6} strokeLinecap="butt"
              pathLength={100}
              strokeDasharray={`${pct} ${100 - pct}`}
            />
          )}
        </svg>
        <span className="relative text-[15px] tabular-nums tracking-[-0.03em] [font-weight:350]">
          {pct}
          <span className="ml-[1px] align-baseline text-[0.55em] opacity-60
                           [font-family:var(--bento-mono)]">%</span>
        </span>
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
        // Square, for the same reason as Bars: a rounded cap eats most of a
        // 4px-wide column and turns the shortest period into a dot.
        <span key={i} className="flex min-w-0 flex-1 flex-col overflow-hidden"
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
        <span key={i} className="min-w-0 flex-1"
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
    /* One grid, for the same reason as Rows: a grid PER ROW sizes its label
       column against that row's own label, so the tracks start and end in
       different places and two equal values draw as unequal bars. */
    <div
      className="grid h-full grid-cols-[minmax(34px,auto)_minmax(0,1fr)_auto]
                 content-center items-center gap-x-1.5 gap-y-2"
      role="img"
      aria-label={srLabel}
    >
      {rows.map((r) => (
        <Fragment key={r.label}>
          <span className="truncate text-[8px] font-medium uppercase tracking-[0.06em] opacity-70">
            {r.label}
          </span>
          <span className="h-2.5 overflow-hidden" style={{ background: TRACK }}>
            <span className="block h-full"
                  style={{ width: `${(r.value / hi) * 100}%`, background: MARK }} />
          </span>
          <b className="text-[9px] font-bold tabular-nums">{fmt(r.value)}</b>
        </Fragment>
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
      <span className="relative block h-2.5 overflow-hidden" style={{ background: TRACK }}>
        <span className="block h-full" style={{ width: `${pct}%`, background: MARK }} />
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
            <span className="block h-full"
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
        <span className="absolute top-1/2 h-[14px] w-[2px] -translate-x-1/2 -translate-y-1/2"
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
            <span key={j} className="h-1 w-3" style={{ background: MARK }} />
          ))}
        </div>
      ))}
    </div>
  )
}