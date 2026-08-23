import { useWidgetSize } from '@/lib/widget-size'
import { cn } from '@/lib/utils'

/* SIX MORE DRAWINGS FOR THE BENTO CELLS.

   A companion to `bento-kit.tsx`, written to the same rules and deliberately
   kept in its own file: the kit is the vocabulary four dashboards already
   import, and adding to it is how a shared component acquires a second owner.
   Nothing here is imported by the kit; nothing here edits it.

   THE RULES THESE KEEP, WHICH ARE THE KIT'S RULES.

   1. Not one hex. Every colour is a Bento token or a `color-mix` on one, so
      the mode branch stays CSS's job and a domain-tinted cell — where `Cell`
      has repointed `--bento-muted` at that card's own ink — gets art in its
      own tint rather than a grey dropped onto a saturated ground.

   2. Colour is never the only channel. A heat cell also carries its value in
      `title` and in the label the screen reader is given; a segment also
      carries its share as a printed number; a quadrant point also carries its
      position, which is the actual claim. `srLabel` is required everywhere and
      is *stated*, not summarised away.

   3. They hide rather than shrink. `useWidgetSize` is read directly rather
      than `useDetail`, because `detailFor` collapses 2x1 and 1x2 into one
      answer and the difference between them is the whole question here —
      almost all of these need WIDTH. Below the room they need they return
      null, and the cell is simply a cell.

   4. No data draws nothing. An empty array renders null, never a confident
      zero: a ring at 0%, a bar of one flat segment and an empty heat strip all
      look like measurements, and "we have no rows for this" is not a
      measurement. A denominator of zero is the same refusal `Meter` makes.

   5. No animation, at any motion preference. There is nothing to reduce. */

// --- shared weights -----------------------------------------------------

/* The same three weights the art family uses, for the same reason: faint
   enough that the figure printed over them still wins the eye, distinct
   enough from each other that the drawing reads. These are drawings a reader
   is meant to *read* rather than background texture, so the marked weight is a
   little stronger than the art family's and the strongest state reaches all
   the way to the card's own ink. */
const VIZ_LINE = 'color-mix(in srgb, var(--bento-muted) 38%, transparent)'
const VIZ_TRACK = 'color-mix(in srgb, var(--bento-muted) 12%, transparent)'
const VIZ_STRONG = 'var(--bento-ink)'

/** Does this cell have room for a drawing that needs `minW` columns and
    `minH` rows? Below it the caller returns null. Deliberately duplicated from
    the kit's `useArtRoom` rather than exported across files: it is four lines,
    and the kit is not this file's dependency. */
function useRoom(minW: number, minH = 1): boolean {
  const { w, h } = useWidgetSize()
  return w >= minW && h >= minH
}

/** One place that decides how a share is written, so six drawings do not
    develop six opinions about rounding. */
function pctText(part: number, whole: number): string {
  if (whole <= 0) return '0%'
  const p = (part / whole) * 100
  return `${p >= 9.95 || p === 0 ? Math.round(p) : p.toFixed(1)}%`
}

// --- 1. Ring ------------------------------------------------------------

/** A PROPORTION, AS AN ARC. The one shape that says "of a whole" without
    needing a second mark to compare against: the gap is as legible as the
    fill, which is what a bar in a narrow cell stops being.

    Drawn from `value` over `total` and from nothing else. A ring with an
    invented denominator is the lie `Meter` already refuses to tell, so a
    `total` of zero draws nothing rather than an empty circle that reads as
    0% of something real.

    The percentage is printed in the middle. That is not decoration: an arc
    read off by eye is worth about a quarter turn of precision, and the two
    figures under it are what somebody actually quotes.

    `preserveAspectRatio` is left at its default here, alone among these six —
    a circle stretched to a 264x172 cell is an ellipse, and an ellipse's arc
    length no longer tracks its angle, so the drawing would misreport the
    number it exists to report.

    Fits 1x1: it is the most compact of the six, and the small cell is the one
    it is for. */
export function Ring({
  value,
  total,
  srLabel,
  className,
}: {
  value: number
  total: number
  srLabel: string
  className?: string
}) {
  if (total <= 0) return null

  const v = Math.min(Math.max(value, 0), total)
  const frac = v / total
  /* 38 rather than 48: `vectorEffect="non-scaling-stroke"` keeps the stroke at
     9 screen pixels however the viewBox is scaled, so at a small cell those
     pixels are a large share of the box and a ring drawn out to the edge has
     its top and bottom cut off by the card. Measured at 264x172 before the
     inset was widened. */
  const r = 38
  const circumference = 2 * Math.PI * r
  const drawn = circumference * frac
  /* At 100% the dash pattern's two round caps meet at twelve o'clock and
     overlap into a visible notch — the one place a completed ring looks
     broken. A full ring is drawn as a plain circle with no dash at all. */
  const complete = frac >= 1

  return (
    <div
      role="img"
      aria-label={`${srLabel}: ${v} of ${total}, ${pctText(v, total)}`}
      className={cn('flex h-full w-full items-center justify-center', className)}
    >
      {/* Square, and capped.

          Given a 2x2 the ring would otherwise inflate to 316px across while
          the figure inside it stayed 15px — a hoop with a speck in the middle,
          where the drawing has grown but the thing it is drawn around has not.
          A dial is legible at about the size of a coin and gains nothing past
          it, so the box stops and centres. */}
      <div className="relative aspect-square h-full max-h-[132px] min-h-[64px]">
        <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false" className="h-full w-full">
        {/* The whole. */}
          <circle
            cx={50}
            cy={50}
            r={r}
            fill="none"
            stroke={VIZ_TRACK}
            strokeWidth={9}
            vectorEffect="non-scaling-stroke"
          />
          {/* The part. Started at twelve o'clock and drawn clockwise, because
              that is the direction every dial a reader has ever met turns. */}
          <circle
            cx={50}
            cy={50}
            r={r}
            fill="none"
            stroke={VIZ_STRONG}
            strokeWidth={9}
            strokeLinecap={complete ? 'butt' : 'round'}
            strokeDasharray={complete ? undefined : `${drawn} ${circumference}`}
            transform="rotate(-90 50 50)"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {/* HTML rather than <text>, so the type keeps the card's own font
            stack and its own size instead of being scaled by the viewBox. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span
            className="text-[16px] font-semibold leading-none tabular-nums"
            style={{ color: 'var(--bento-ink)' }}
          >
            {pctText(v, total)}
          </span>
          <span
            className="mt-1 text-[10.5px] leading-none tabular-nums"
            style={{ color: 'var(--bento-muted)' }}
          >
            {v}/{total}
          </span>
        </div>
      </div>
    </div>
  )
}

// --- 2. SegmentBar ------------------------------------------------------

/** A COMPOSITION, AS ONE BAR. Because the claim is "these parts make up that
    whole", and a bar whose total width is the whole makes the claim
    structurally — the reader cannot misread the shares as independent
    quantities the way they can from four separate bars.

    The total is the sum of what was passed, never a figure supplied
    separately: a segmented bar with a gap at the end is a bar with an
    unlabelled fifth category, and no dashboard has ever meant that.

    Segments are separated by the card's own ground rather than by a border, so
    the divisions read at any width. Shade descends across the segments in
    order, which is a ranking cue and not the meaning: every segment also
    prints its own share in the legend, so a reader who cannot tell two greys
    apart still has both numbers.

    Zero-valued segments are dropped from the bar — a zero-width slice is a
    rendering fault with a tooltip — but stay in the legend at 0, because "none
    of this category" is a finding.

    Fits 1x1; the legend goes one-per-line below two columns and wraps inline
    above. */
export function SegmentBar({
  segments,
  srLabel,
  className,
}: {
  segments: { label: string; value: number }[]
  srLabel: string
  className?: string
}) {
  const { w } = useWidgetSize()
  const usable = segments.filter((s) => Number.isFinite(s.value) && s.value >= 0)
  const total = usable.reduce((a, s) => a + s.value, 0)
  if (usable.length === 0 || total <= 0) return null

  const drawn = usable.filter((s) => s.value > 0)
  const wide = w >= 2

  return (
    <div
      role="img"
      aria-label={`${srLabel}: ${usable
        .map((s) => `${s.label} ${s.value}, ${pctText(s.value, total)}`)
        .join('; ')}. Total ${total}.`}
      className={cn('flex w-full flex-col gap-2', className)}
    >
      <div className="flex h-2.5 w-full overflow-hidden rounded-full" style={{ gap: '1.5px' }}>
        {drawn.map((s, i) => (
          <div
            key={`${s.label}-${i}`}
            title={`${s.label}: ${s.value} (${pctText(s.value, total)})`}
            style={{
              width: `${(s.value / total) * 100}%`,
              // Strongest first, floored well above the ground so the last
              // segment of a long series is still a segment.
              background: `color-mix(in srgb, var(--bento-ink) ${Math.round(
                88 - Math.min(i, 5) * 14,
              )}%, transparent)`,
            }}
          />
        ))}
      </div>
      <ul
        className={cn(
          'm-0 list-none p-0 text-[11px] leading-tight tabular-nums',
          wide ? 'flex flex-wrap gap-x-3 gap-y-1' : 'flex flex-col gap-1',
        )}
        aria-hidden="true"
      >
        {usable.map((s, i) => (
          <li key={`${s.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
            <span
              className="h-2 w-2 shrink-0 rounded-[1px]"
              style={{
                background: `color-mix(in srgb, var(--bento-ink) ${Math.round(
                  88 - Math.min(i, 5) * 14,
                )}%, transparent)`,
              }}
            />
            <span className="truncate" style={{ color: 'var(--bento-muted)' }}>
              {s.label}
            </span>
            <span className="ml-auto shrink-0 font-semibold" style={{ color: 'var(--bento-ink)' }}>
              {s.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// --- 3. AgeBands --------------------------------------------------------

/** AGEING, AS ORDERED BANDS. Deliberately NOT a segmented bar, even though the
    data would fit one: ageing buckets have an order and a direction — money
    gets worse as it moves right — and stacking them into one bar throws that
    away. Separate bands, in the order given, top to bottom, each one's length
    its own count against the largest bucket.

    Scaled to the largest band rather than to the total, because the question
    a reader brings is "which bucket is the problem", and against a total the
    small buckets are all hairlines.

    Bands past the first are drawn progressively stronger, so the oldest debt
    is the darkest mark on the card. That is the one place shade carries
    meaning here, and it is redundant with both the order and the printed
    count.

    An all-zero set draws nothing: four empty rails labelled 0 look like a
    chart that failed to load, and "nothing is overdue" belongs in a sentence.

    Fits 1x1 at up to four bands. */
export function AgeBands({
  bands,
  srLabel,
  className,
}: {
  bands: { label: string; value: number }[]
  srLabel: string
  className?: string
}) {
  const { w } = useWidgetSize()
  const usable = bands.filter((b) => Number.isFinite(b.value) && b.value >= 0)
  const max = usable.reduce((a, b) => Math.max(a, b.value), 0)
  if (usable.length === 0 || max <= 0) return null

  const wide = w >= 2

  return (
    <div
      role="img"
      aria-label={`${srLabel}: ${usable.map((b) => `${b.label}, ${b.value}`).join('; ')}.`}
      className={cn('flex w-full flex-col gap-1.5', className)}
    >
      {usable.map((b, i) => (
        <div key={`${b.label}-${i}`} className="flex items-center gap-2">
          <span
            className={cn(
              'shrink-0 text-[10.5px] leading-none tabular-nums',
              wide ? 'w-14' : 'w-11',
            )}
            style={{ color: 'var(--bento-muted)' }}
          >
            {b.label}
          </span>
          <div
            className="h-2 min-w-0 flex-1 overflow-hidden rounded-[var(--bento-radius-sm)]"
            style={{ background: VIZ_TRACK }}
          >
            <div
              className="h-full rounded-[var(--bento-radius-sm)]"
              style={{
                // A floor, so a band with one item in it is a visible mark and
                // not an empty rail indistinguishable from a zero.
                width: b.value === 0 ? '0%' : `${Math.max(3, (b.value / max) * 100)}%`,
                background: `color-mix(in srgb, var(--bento-ink) ${Math.round(
                  38 + Math.min(i, 4) * 15,
                )}%, transparent)`,
              }}
            />
          </div>
          <span
            className="w-9 shrink-0 text-right text-[11px] font-semibold leading-none tabular-nums"
            style={{ color: 'var(--bento-ink)' }}
          >
            {b.value}
          </span>
        </div>
      ))}
    </div>
  )
}

// --- 4. HeatStrip -------------------------------------------------------

/** A SERIES, AS INTENSITY. One row of cells, one cell per period, shaded by
    its own value within the observed range. The kit already has `Sparkline`
    for the shape of a series; this is for the series where the shape is not
    the point and the question is "which of these were the heavy ones".

    Shade is a weak channel and is not asked to work alone: every cell carries
    its value in `title`, the whole series is stated in the label the screen
    reader gets, and the observed low and high are printed as endpoints under
    the strip so a shade can be converted back into a number.

    A null cell is an OUTLINE, not a pale fill. "No data for this period" and
    "a low value this period" are different facts, and a ramp that renders them
    both as light grey merges them — which is the same distinction
    `CalendarDensityArt` draws, drawn the same way.

    A flat series — every observed value identical — is drawn at one uniform
    weight rather than at the ramp's floor, because within-range shading of a
    range of zero is meaningless and a strip that reads as "all lowest" would
    be false.

    Needs 2x1. Thirty cells across a 1x1 are five pixels wide with a gap, which
    is a bar code. */
export function HeatStrip({
  cells,
  srLabel,
  formatValue,
  className,
}: {
  cells: (number | null)[]
  srLabel: string
  /** How a cell's value is spoken and titled. Defaults to the bare number. */
  formatValue?: (v: number) => string
  className?: string
}) {
  const room = useRoom(2)
  const present = cells.filter((c): c is number => c !== null && Number.isFinite(c))
  if (!room || cells.length === 0 || present.length === 0) return null

  const fmt = formatValue ?? ((v: number) => String(v))
  const lo = Math.min(...present)
  const hi = Math.max(...present)
  const range = hi - lo
  const flat = range === 0

  return (
    <div className={cn('flex w-full flex-col gap-1.5', className)}>
      <div
        role="img"
        aria-label={`${srLabel}: ${cells
          .map((c) => (c === null ? 'no data' : fmt(c)))
          .join(', ')}.`}
        className="flex h-6 w-full items-stretch gap-[2px]"
      >
        {cells.map((c, i) =>
          c === null || !Number.isFinite(c) ? (
            <div
              key={i}
              title="No data"
              className="min-w-0 flex-1 rounded-[2px]"
              style={{ border: `1px solid ${VIZ_LINE}` }}
            />
          ) : (
            <div
              key={i}
              title={fmt(c)}
              className="min-w-0 flex-1 rounded-[2px]"
              style={{
                // 22% floor: the coolest observed cell must still read as a
                // cell that was measured, not as an absent one.
                background: `color-mix(in srgb, var(--bento-ink) ${Math.round(
                  flat ? 55 : 22 + ((c - lo) / range) * 63,
                )}%, transparent)`,
              }}
            />
          ),
        )}
      </div>
      {/* The key back to numbers. Without it the strip is colour-only. */}
      <div
        className="flex items-baseline justify-between text-[10px] leading-none tabular-nums"
        style={{ color: 'var(--bento-muted)' }}
        aria-hidden="true"
      >
        <span>{fmt(lo)}</span>
        <span>{fmt(hi)}</span>
      </div>
    </div>
  )
}

// --- 5. Timeline --------------------------------------------------------

/** EVENTS, ALONG TIME. Positioned by their date within a stated window, so the
    gaps between marks are real gaps — which is the entire reason not to draw
    this as a list.

    THE WINDOW IS PASSED IN, NOT INFERRED. Deriving it from the first and last
    event makes the drawing lie in the most damaging direction: three exams in
    one week and nothing else would fill the axis edge to edge and read as a
    term evenly covered. The caller knows the term; the caller says so.

    EVENTS SHARING A DATE STACK. Two exams on the same morning are two events,
    and a drawing that overplots them into one mark has quietly lost one. Marks
    at the same x are dodged upward in the order given, and the axis is given
    the height to hold the deepest stack. Past what fits, the overflow is
    counted in the label rather than dropped silently.

    Labels are printed only when there is room for all of them without
    collision — a partly labelled timeline reads as though the unlabelled marks
    are a lesser kind of event. Otherwise every mark keeps its `title` and the
    whole series is stated for a screen reader.

    Needs 2x1. A month compressed into 264px puts consecutive days two pixels
    apart. */
export function Timeline({
  events,
  from,
  to,
  srLabel,
  className,
}: {
  events: { label: string; date: string | number | Date }[]
  /** The start of the window drawn. Inclusive. */
  from: string | number | Date
  /** The end of the window drawn. Inclusive. */
  to: string | number | Date
  srLabel: string
  className?: string
}) {
  const { w, h } = useWidgetSize()
  const room = w >= 2

  const t0 = new Date(from).getTime()
  const t1 = new Date(to).getTime()
  const span = t1 - t0

  // A window of zero or negative length cannot position anything; a reversed
  // pair is a caller bug and a drawing is the wrong place to guess at the fix.
  if (!room || events.length === 0 || !Number.isFinite(t0) || !Number.isFinite(t1) || span <= 0) {
    return null
  }

  const placed = events
    .map((e) => ({ label: e.label, t: new Date(e.date).getTime() }))
    .filter((e) => Number.isFinite(e.t) && e.t >= t0 && e.t <= t1)
    .sort((a, b) => a.t - b.t)

  if (placed.length === 0) return null

  /* The stack. Events are dodged by their position on the axis rather than by
     exact date equality: two events a day apart in a term-long window land on
     the same pixel and overplot just as completely as two on the same day. */
  const tiers = h >= 2 ? 4 : 2
  const lanes: number[] = []
  const marks = placed.map((e) => {
    const x = ((e.t - t0) / span) * 100
    // Occupied lanes whose last mark is within a mark's width of this one.
    let lane = 0
    while (lane < tiers && lanes[lane] !== undefined && x - lanes[lane] < 4) lane++
    const seated = lane < tiers
    if (seated) lanes[lane] = x
    return { ...e, x, lane: seated ? lane : -1 }
  })

  const hidden = marks.filter((m) => m.lane < 0).length
  const seatedMarks = marks.filter((m) => m.lane >= 0)
  // Labels only when they all fit: roughly 68px of type per label against the
  // cell's own width, which is 264px per column less the card's padding.
  const labelled = w >= 3 && seatedMarks.length <= (w - 1) * 2 && hidden === 0
  const laneStep = h >= 2 ? 14 : 11
  const stackHeight = laneStep * tiers

  const dateText = (t: number) =>
    new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

  return (
    <div
      role="img"
      aria-label={`${srLabel}, ${dateText(t0)} to ${dateText(t1)}: ${placed
        .map((e) => `${e.label} on ${dateText(e.t)}`)
        .join('; ')}.`}
      className={cn('flex w-full flex-col gap-1', className)}
    >
      <div className="relative w-full" style={{ height: `${stackHeight + 10}px` }}>
        {/* The axis. The one piece of pure geometry here, so the one place
            `preserveAspectRatio="none"` belongs. */}
        <svg
          viewBox="0 0 100 2"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
          className="absolute inset-x-0 bottom-0 h-[2px] w-full"
        >
          <line
            x1={0}
            y1={1}
            x2={100}
            y2={1}
            stroke={VIZ_LINE}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {seatedMarks.map((m, i) => (
          <div
            key={`${m.label}-${i}`}
            title={`${m.label} — ${dateText(m.t)}`}
            className="absolute"
            style={{
              left: `${m.x}%`,
              bottom: `${m.lane * laneStep}px`,
              transform: 'translateX(-50%)',
            }}
          >
            {/* A stem down to the axis, so a dodged mark still reads as
                belonging to its own point in time rather than floating. */}
            <span
              className="absolute left-1/2 w-px"
              style={{
                bottom: `-${m.lane * laneStep}px`,
                height: `${m.lane * laneStep + 4}px`,
                background: VIZ_LINE,
              }}
              aria-hidden="true"
            />
            <span
              className="relative block h-[7px] w-[7px] rotate-45 rounded-[1px]"
              style={{ background: VIZ_STRONG }}
              aria-hidden="true"
            />
          </div>
        ))}
        {labelled &&
          seatedMarks.map((m, i) => (
            <span
              key={`label-${m.label}-${i}`}
              className="absolute whitespace-nowrap text-[10px] leading-none"
              style={{
                left: `${m.x}%`,
                bottom: `${m.lane * laneStep + 10}px`,
                transform: 'translateX(-50%)',
                color: 'var(--bento-muted)',
              }}
              aria-hidden="true"
            >
              {m.label}
            </span>
          ))}
      </div>
      <div
        className="flex items-baseline justify-between text-[10px] leading-none tabular-nums"
        style={{ color: 'var(--bento-muted)' }}
        aria-hidden="true"
      >
        <span>{dateText(t0)}</span>
        {hidden > 0 && <span>+{hidden} more</span>}
        <span>{dateText(t1)}</span>
      </div>
    </div>
  )
}

// --- 6. Quadrant --------------------------------------------------------

/** Faint enough to sit under the marks without competing with them, and still
    a token rather than a grey. */
const VIZ_LINE_TEXT = 'color-mix(in srgb, var(--bento-muted) 72%, transparent)'

/** Where each region's name goes and what it says. A table rather than four
    copies of the same span, so a wording change happens once. */
const REGIONS = [
  { at: 'left-1.5 top-1.5', text: (x: string, y: string) => `high ${y} \u00b7 low ${x}` },
  { at: 'right-1.5 top-1.5 text-right', text: (_x: string, _y: string) => 'high both' },
  { at: 'bottom-1.5 left-1.5', text: (_x: string, _y: string) => 'low both' },
  { at: 'bottom-1.5 right-1.5 text-right', text: (x: string, y: string) => `high ${x} \u00b7 low ${y}` },
] as const

/** TWO MEASURES AT ONCE, AS A FIELD. Because the finding is a *combination* —
    high absence and low marks is a different student from high absence alone —
    and no arrangement of bars puts a reader in front of that.

    The four regions are labelled, faintly, in the corners. They are the axes
    restated, not a fifth data series: the dividing lines sit at the midpoint
    of each observed range, so "top right" means "high on both, relative to
    these points", which is what the reader will read into it anyway. That is
    stated in the screen-reader label rather than left implied.

    Points are square marks at one weight. Density is the finding, and a ramp
    over a scatter reads as a third variable nobody supplied.

    A single point draws nothing: one mark cannot establish the ranges the
    dividing lines are drawn from, so the quadrants it appears to sit in are an
    artefact of having one point.

    Needs 2x2. At 2x1 the vertical axis is 172px less two rows of labels, and
    every point lands in a 60px band. */
export function Quadrant({
  points,
  xLabel,
  yLabel,
  srLabel,
  className,
}: {
  points: { x: number; y: number; label: string }[]
  /** What the horizontal axis measures, low end to high end. */
  xLabel: string
  /** What the vertical axis measures, low end to high end. */
  yLabel: string
  srLabel: string
  className?: string
}) {
  const room = useRoom(2, 2)
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  if (!room || usable.length < 2) return null

  const xs = usable.map((p) => p.x)
  const ys = usable.map((p) => p.y)
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const y0 = Math.min(...ys)
  const y1 = Math.max(...ys)
  // A degenerate axis — every point on the same x — is drawn as a single
  // column down the middle rather than divided by zero into the corner.
  const xr = x1 - x0
  const yr = y1 - y0
  const px = (v: number) => (xr === 0 ? 50 : 6 + ((v - x0) / xr) * 88)
  const py = (v: number) => (yr === 0 ? 50 : 94 - ((v - y0) / yr) * 88)

  const inQuad = (p: { x: number; y: number }) =>
    `${p.y >= (y0 + y1) / 2 ? 'high' : 'low'} ${yLabel}, ${
      p.x >= (x0 + x1) / 2 ? 'high' : 'low'
    } ${xLabel}`

  return (
    <div
      role="img"
      aria-label={`${srLabel}. Horizontal axis ${xLabel}, vertical axis ${yLabel}, each divided at the midpoint of the observed range. ${usable
        .map((p) => `${p.label}: ${inQuad(p)}`)
        .join('; ')}.`}
      className={cn('flex h-full w-full min-h-[132px] flex-col gap-1', className)}
    >
      <div className="relative min-h-0 w-full flex-1">
        {/* The cross and the frame. Geometry only, so stretched to the cell
            with non-scaling strokes. */}
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
          className="absolute inset-0 h-full w-full"
        >
          <rect
            x={0.5}
            y={0.5}
            width={99}
            height={99}
            fill="none"
            stroke={VIZ_LINE}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1={50}
            y1={0}
            x2={50}
            y2={100}
            stroke={VIZ_LINE}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1={0}
            y1={50}
            x2={100}
            y2={50}
            stroke={VIZ_LINE}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {/* The four regions, named in their own corners. Named as the
            COMBINATION rather than as "Q1..Q4", because the combination is the
            finding and a reader should not have to decode a key to reach it. */}
        {REGIONS.map((r) => (
          <span
            key={r.at}
            className={cn(
              'pointer-events-none absolute max-w-[46%] truncate text-[9.5px] leading-none',
              r.at,
            )}
            style={{ color: VIZ_LINE_TEXT }}
            aria-hidden="true"
          >
            {r.text(xLabel, yLabel)}
          </span>
        ))}
        {usable.map((p, i) => (
          <span
            key={`${p.label}-${i}`}
            title={`${p.label} — ${inQuad(p)}`}
            className="absolute h-[5px] w-[5px] rounded-[1px]"
            style={{
              left: `${px(p.x)}%`,
              top: `${py(p.y)}%`,
              transform: 'translate(-50%, -50%)',
              background: VIZ_STRONG,
            }}
            aria-hidden="true"
          />
        ))}
      </div>
      {/* The axes named once, under the field, rather than twice inside it. */}
      <div
        className="flex shrink-0 items-baseline justify-between gap-2 text-[10px] leading-[13px]"
        style={{ color: 'var(--bento-muted)' }}
        aria-hidden="true"
      >
        <span className="truncate">↑ {yLabel}</span>
        <span className="truncate">{xLabel} →</span>
      </div>
    </div>
  )
}
